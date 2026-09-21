import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { workspaceResetState } from './workspace-reset-state.js';
import { canonicalJson } from '@shopee/domain';
import { localArchiveLock, type BlobStore, type Repository } from '@shopee/persistence';
import {
  loadProductionBatchSource,
  readProductionBatchManifest,
  productionBatchPass1Root,
  productionPublicationMode,
  productionImageQcPolicy,
} from './production-batch-source.js';
import {
  runPass1ProductionBatch,
  checkCreate,
  allAcknowledged,
  isUndispatchedReservation,
  checkVerification,
  type DeferredRecoveryProof,
} from './production-batch-runner.js';
import { productionPilotWriteFingerprint } from '../../../packages/shopee/src/production-pilot-transport.js';
import { assertDeferredImageVerification } from './production-pilot-image-deferral.js';
import { ProductionExecutionPolicyService } from './production-execution-policy.js';
import { currentProductionSource, readProductionBatchExclusions, writeProductionBatchExclusion } from './production-batch-lifecycle.js';

const owner = 'production:2010476:1423724897';
const uuid = z.string().uuid(),
  sha = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const registration = z
  .object({
    version: z.literal(1),
    batchId: uuid,
    manifestPath: z.string().min(1),
    expectedSha256: sha,
    executionEnabled: z.boolean().default(true),
    holdReason: z.string().min(1).max(2000).optional(),
  })
  .strict();
const runInput = z
  .object({
    mode: z.enum(['inspect', 'execute', 'reconcile', 'publish']),
    sourceKey: z.string().min(1).max(4000).optional(),
    expectedStatusFingerprint: sha,
  })
  .strict();
type Options = {
  root?: string;
  load?: typeof loadProductionBatchSource;
  run?: typeof runPass1ProductionBatch;
  enabled?: boolean;
};
function deferredRecoveryProof(sourceKey: string, receipt: any): DeferredRecoveryProof {
  return {
    sourceKey,
    operationId: receipt.operation_id,
    operationRevision: receipt.operation_revision,
    itemId: receipt.item_id,
    sourceFingerprint: receipt.source_fingerprint,
    receiptFingerprint: fingerprint(receipt),
  };
}
function fail(code: string): never {
  throw Error('PRODUCTION_BATCH_' + code);
}
async function files(path: string) {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function safeCode(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return /^(PASS1|PRODUCTION_BATCH|PRODUCTION_PILOT)_[A-Z_]+$/.test(code)
    ? code
    : 'PRODUCTION_BATCH_REQUEST_FAILED';
}

/** Trusted local registration only: never exposed as an HTTP endpoint or browser path input. */
export async function registerProductionBatch(
  input: {
    manifestPath: string;
    expectedSha256: string;
    executionEnabled?: boolean;
    holdReason?: string;
  },
  options: Pick<Options, 'root' | 'load'> = {},
) {
  const loaded = await (options.load ?? loadProductionBatchSource)(
    input.manifestPath,
    input.expectedSha256,
  );
  const value = registration.parse({
    version: 1,
    batchId: loaded.value.batchId,
    manifestPath: loaded.manifestPath,
    expectedSha256: loaded.sha256,
    executionEnabled: input.executionEnabled ?? true,
    ...(input.holdReason ? { holdReason: input.holdReason } : {}),
  });
  const directory = resolve(options.root ?? productionBatchPass1Root, 'web-registry'),
    path = resolve(directory, value.batchId + '.json');
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!same(registration.parse(JSON.parse(await readFile(path, 'utf8'))), value))
      fail('REGISTRATION_CONFLICT');
  }
  return { batchId: value.batchId, manifestSha256: value.expectedSha256 };
}
export class ProductionBatchService {
  private readonly active = new Set<string>();
  private accepting = false;
  private listingRequest?: ReturnType<ProductionBatchService['listFresh']>;
  constructor(
    private readonly repo: Repository,
    private readonly blobs: BlobStore,
    private readonly options: Options = {},
  ) {}
  private get root() {
    return this.options.root ?? productionBatchPass1Root;
  }
  private get enabled() {
    return this.options.enabled ?? process.env.PRODUCTION_PILOT_ENABLED === '1';
  }
  private lockKey(batchId: string) {
    return 'production-batch-coordinator:' + owner + ':' + batchId;
  }
  private async acquireCoordinator(batchId: string,withLifecycleLock=false) {
    if (this.repo.pool.options?.max !== undefined && this.repo.pool.options.max < 2)
      fail('POOL_CAPACITY_REQUIRED');
    const client = await this.repo.pool.connect(),
      keys = ['production-batch-coordinator:' + owner, this.lockKey(batchId)],
      held: string[] = [];
    let lifecycleLocked=false;
    try {
      for (const key of keys) {
        const result = await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended(current_schema()||':'||$1,0)) AS locked",
          [key],
        );
        if (result.rows[0]?.locked !== true) fail('IN_PROGRESS');
        held.push(key);
      }
      if(withLifecycleLock){await client.query('SELECT pg_advisory_lock(hashtextextended(current_schema() || chr(58) || $1,0))',[localArchiveLock]);lifecycleLocked=true;}
      return async () => {
        try {
          if(lifecycleLocked)await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema() || chr(58) || $1,0))',[localArchiveLock]);
          for (const key of held.reverse())
            await client.query(
              "SELECT pg_advisory_unlock(hashtextextended(current_schema()||':'||$1,0))",
              [key],
            );
        } finally {
          client.release();
        }
      };
    } catch (error) {
      try {
        if(lifecycleLocked)await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema() || chr(58) || $1,0))',[localArchiveLock]);
        for (const key of held.reverse())
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended(current_schema()||':'||$1,0))",
            [key],
          );
      } finally {
        client.release();
      }
      throw error;
    }
  }
  private async coordinatorAlive(batchId: string) {
    if (this.active.has(batchId)) return true;
    const client = await this.repo.pool.connect();
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended(current_schema()||':'||$1,0)) AS locked",
        [this.lockKey(batchId)],
      );
      if (result.rows[0]?.locked !== true) return true;
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended(current_schema()||':'||$1,0))",
        [this.lockKey(batchId)],
      );
      return false;
    } finally {
      client.release();
    }
  }
  private async load(batchId: string, verifySourceBytes = true) {
    uuid.parse(batchId);
    let saved;
    try {
      saved = registration.parse(
        JSON.parse(await readFile(resolve(this.root, 'web-registry', batchId + '.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('NOT_REGISTERED');
      throw error;
    }
    if (saved.batchId !== batchId) fail('REGISTRATION_CONFLICT');
    const source = await (
      this.options.load ??
      (verifySourceBytes ? loadProductionBatchSource : readProductionBatchManifest)
    )(saved.manifestPath, saved.expectedSha256);
    if (source.value.batchId !== batchId || source.sha256 !== saved.expectedSha256)
      fail('MANIFEST_CHANGED');
    return { saved, source };
  }
  list() {
    if(this.listingRequest)return this.listingRequest;
    this.listingRequest=this.listFresh().finally(()=>{this.listingRequest=undefined;});
    return this.listingRequest;
  }
  private async listFresh() {
    const hidden = new Set((await workspaceResetState())?.hiddenBatchIds ?? []);
    const ids = (await files(resolve(this.root, 'web-registry'))).sort()
      .filter(entry => entry.endsWith('.json') && uuid.safeParse(entry.replace(/\.json$/, '')).success)
      .map(entry => entry.replace(/\.json$/, '')).filter(id => !hidden.has(id));
    const read = async (id: string) => {
      try {
        return await this.status(id);
      } catch (error) {
        return {
          batchId: id,
          state: 'unavailable' as const,
          code: safeCode(error),
          listings: [],
          canExecute: false,
        };
      }
    };
    // Bound concurrent reads; leave pool capacity for the operator and worker.
    const width = (this.repo.pool.options?.max ?? 10) >= 6 ? 2 : 1;
    const batches: Awaited<ReturnType<typeof read>>[] = new Array(ids.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(width, ids.length) }, async () => {
      while (cursor < ids.length) { const index = cursor++; batches[index] = await read(ids[index]!); }
    }));
    return { batches };
  }
  async status(batchId: string) {
    return (await this.inspectStatus(batchId)).status;
  }
  private async inspectStatus(batchId: string, callerOwnsLock = false) {
    const { source, saved } = await this.load(batchId, false),
      manifest = source.value;
    const executionPolicy=manifest.version===2 ? await new ProductionExecutionPolicyService(this.repo).getForBatch(batchId,source.sha256) : null;
    const rows = (
      await this.repo.pool.query(
        `SELECT to_jsonb(o) AS operation,
    jsonb_build_object('id',connection.id,'environment',connection.environment,'partner_id',connection.partner_id,'shop_id',connection.shop_id,'revision',connection.revision,'state',connection.state) AS current_connection,
    to_jsonb(v) AS verification,to_jsonb(d) AS deferred_image_verification,to_jsonb(p) AS publication,to_jsonb(pv) AS publication_verification,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('state',s.state,'step_key',s.step_key) ORDER BY s.ordinal) FROM production_pilot_steps s WHERE s.operation_id=o.id),'[]'::jsonb) AS steps
    FROM production_pilot_operations o LEFT JOIN connections connection ON connection.id=o.connection_id
    LEFT JOIN production_pilot_verifications v ON v.operation_id=o.id
    LEFT JOIN production_pilot_deferred_image_verifications d ON d.operation_id=o.id
    LEFT JOIN production_pilot_publications p ON p.create_operation_id=o.id
    LEFT JOIN production_pilot_publication_verifications pv ON pv.operation_id=p.id
    WHERE o.owner_key=$1 AND o.source_identity=ANY($2::text[]) ORDER BY o.created_at,o.id`,
        [owner, manifest.listings.map((s) => s.sourceIdentity)],
      )
    ).rows;
    const laneRows = (await this.repo.pool.query(
      `SELECT lane.operation_id,o.item_id,o.state,o.source_identity,
       production_pilot_can_wait_for_qc(o.id) AS can_wait_for_qc,
       o.source_payload->'document'->>'title' AS title,
       o.source_payload->'batchAuthorization'->>'batchId' AS batch_id
       FROM production_pilot_lanes lane JOIN production_pilot_operations o ON o.id=lane.operation_id
       WHERE lane.owner_key=$1 AND o.owner_key=$1`, [owner],
    )).rows;
    const lane = laneRows.find(row => uuid.safeParse(row.operation_id).success);
    const blockingLane = lane && !rows.some(row => row.operation?.id === lane.operation_id) ? lane : null;
    let blockingWork: {operationId:string;itemId:string|null;title:string;batchId?:string;sourceKey?:string;state:'awaiting_reconciliation';blocksExecution:boolean} | undefined;
    if (blockingLane) {
      const linkedBatch = uuid.safeParse(blockingLane.batch_id);
      blockingWork = {
        operationId:blockingLane.operation_id,itemId:blockingLane.item_id ?? null,
        blocksExecution:blockingLane.can_wait_for_qc!==true,
        title:typeof blockingLane.title==='string' && blockingLane.title.trim() ? blockingLane.title : 'Listing đang chờ đối chiếu',
        ...(linkedBatch.success ? {batchId:linkedBatch.data} : {}),state:'awaiting_reconciliation',
      };
      if (linkedBatch.success) {
        try {
          const blockingSource = (await this.load(linkedBatch.data,false)).source.value.listings.find(s=>s.sourceIdentity===blockingLane.source_identity);
          if (blockingSource) blockingWork.sourceKey=blockingSource.sourceKey;
        } catch { /* Keep the blocker visible even if its local manifest is unavailable. */ }
      }
    }
    const batchProof = {
      batchId,
      manifestSha256: source.sha256,
      authorizationReference: manifest.authorizationReference,
      ...(productionImageQcPolicy(manifest)==='defer_image_qc' ? {publicationMode:'hidden_for_review' as const,imageQcPolicy:'defer_image_qc' as const} : {}),
      sources: manifest.listings.map((s) => ({
        sourceIdentity: s.sourceIdentity,
        sourceRevision: s.sourceRevision,
        documentSha256: fingerprint(s.document),
      })),
    };
    const operationProofs: {
      sourceKey: string;
      operationId: string;
      sourceFingerprint: string;
      verificationId: string;
      verificationFingerprint: string;
    }[] = [];
    // Core-only receipts may recover hidden creation, never authorize publication.
    const deferredOperationProofs: DeferredRecoveryProof[] = [];
    const exclusions=await readProductionBatchExclusions(this.root,source);
    const currentSources=await Promise.all(manifest.listings.map(listing=>currentProductionSource(this.repo,listing)));
    const listings = manifest.listings.map((sourceListing,index) => {
      const selected = rows.filter(
        (r) => r.operation.source_identity === sourceListing.sourceIdentity,
      );
      const entry = selected[0],
        op = entry?.operation;
      const excluded=exclusions.some(receipt=>receipt.sourceKey===sourceListing.sourceKey);
      if(excluded && selected.length)fail('EXCLUSION_INVALID');
      let state = 'not_sent';
      if (op) {
        state = 'needs_review';
        try {
          if (selected.length !== 1) fail('SOURCE_HISTORY_REQUIRES_REVIEW');
          const connection = entry.current_connection;
          if (
            !connection ||
            connection.environment !== 'production' ||
            connection.partner_id !== '2010476' ||
            connection.shop_id !== '1423724897' ||
            connection.state !== 'connected'
          )
            fail('CONNECTION_REQUIRED');
          checkCreate(entry, sourceListing, source, batchProof, connection.id, connection.revision);
          if (isUndispatchedReservation(entry)) state = 'authorized_not_started';
          else if (['sent', 'unknown', 'rejected'].includes(op.state)) state = op.state;
          else {
            allAcknowledged(entry, sourceListing);
            state = 'created_readback_pending';
            if(op.state==='acknowledged' && (executionPolicy || productionImageQcPolicy(manifest)==='defer_image_qc') && entry.deferred_image_verification) {
              if(entry.publication)fail('PUBLICATION_RECONCILIATION_REQUIRED');
              assertDeferredImageVerification(entry.deferred_image_verification,op,executionPolicy ?? undefined);
              deferredOperationProofs.push(deferredRecoveryProof(sourceListing.sourceKey, entry.deferred_image_verification));
              state='created_hidden_image_qc_deferred';
            }
            if (op.state === 'verified') {
              checkVerification(
                entry.verification,
                op.id,
                op.revision,
                op.item_id,
                'created_unlisted',
                op.expected_projection,
              );
              operationProofs.push({
                sourceKey: sourceListing.sourceKey,
                operationId: op.id,
                sourceFingerprint: op.source_fingerprint,
                verificationId: entry.verification.id,
                verificationFingerprint: entry.verification.evidence_fingerprint,
              });
              if (entry.deferred_image_verification) {
                const receipt = entry.deferred_image_verification;
                // Full verification advances the acknowledged operation by exactly one revision.
                // Retain the old core receipt as historical recovery proof, independently of full QC.
                if (receipt.operation_revision !== op.revision - 1) fail('RECOVERY_INVALID');
                assertDeferredImageVerification(receipt, {
                  ...op, state: 'acknowledged', revision: receipt.operation_revision,
                }, executionPolicy ?? undefined);
                deferredOperationProofs.push(deferredRecoveryProof(sourceListing.sourceKey, receipt));
              }
              state = 'created_unlisted';
              const pub = entry.publication;
              if (pub) {
                state = 'needs_review';
                if (
                  pub.owner_key !== owner ||
                  pub.create_operation_id !== op.id ||
                  pub.source_fingerprint !== op.source_fingerprint ||
                  pub.create_verification_id !== entry.verification.id ||
                  pub.item_id !== op.item_id ||
                  pub.source_identity !== sourceListing.sourceIdentity ||
                  pub.source_revision !== sourceListing.sourceRevision ||
                  pub.connection_id !== op.connection_id ||
                  !Number.isSafeInteger(pub.connection_revision) ||
                  pub.connection_revision < op.connection_revision ||
                  pub.connection_revision > connection.revision ||
                  pub.path !== '/api/v2/product/unlist_item' ||
                  !same(pub.payload, {
                    item_list: [{ item_id: Number(pub.item_id), unlist: false }],
                  }) ||
                  pub.fingerprint !== productionPilotWriteFingerprint(pub.path, pub.payload) ||
                  !pub.receipt ||
                  pub.outcome_fingerprint !== fingerprint(pub.receipt) ||
                  !same(pub.expected_projection, op.expected_projection)
                )
                  fail('PUBLICATION_RECONCILIATION_REQUIRED');
                if (pub.state === 'verified') {
                  checkVerification(
                    entry.publication_verification,
                    pub.id,
                    pub.revision,
                    pub.item_id,
                    'published',
                    { ...op.expected_projection, status: 'NORMAL' },
                  );
                  state = 'published';
                } else if (pub.state === 'acknowledged') state = 'publication_readback_pending';
                else if (['sent', 'unknown', 'rejected'].includes(pub.state)) state = pub.state;
              }
            }
          }
        } catch {
          state = 'needs_review';
        }
      }
      return {
        sourceKey: sourceListing.sourceKey,
        title: sourceListing.document.title,
        modelCount: sourceListing.document.models.length,
        state,
        excluded,
        ...currentSources[index]!,
        ...(op ? { operationId: op.id, itemId: op.item_id } : {}),
        acknowledgedSteps: entry?.steps.filter((s: any) => s.state === 'acknowledged').length ?? 0,
        totalSteps: entry?.steps.length ?? 0,
      };
    });
    const directory = resolve(this.root, 'web-jobs', batchId),
      names = await files(directory),
      pending: string[] = [],
      results: any[] = [],
      records = new Map<string, any>();
    for (const name of names.filter(
      (n) => n.endsWith('.request.json') || n.endsWith('.claim.json'),
    )) {
      const record = JSON.parse(await readFile(resolve(directory, name), 'utf8'));
      if (
        !uuid.safeParse(record.requestId).success ||
        record.batchId !== batchId ||
        !['inspect', 'execute', 'reconcile', 'publish'].includes(record.mode) ||
        record.manifestSha256 !== source.sha256
      )
        fail('JOURNAL_INVALID');
      const prior = records.get(record.requestId);
        if (prior && !same(prior, record)) fail('JOURNAL_INVALID');
      records.set(record.requestId, record);
    }
    const recoveredRequestIds = new Set<string>(),
      recoveries: any[] = [];
    for (const name of names.filter((n) => n.endsWith('.recovery.json'))) {
      const recovery = JSON.parse(await readFile(resolve(directory, name), 'utf8'));
      const request = records.get(recovery.requestId),
        resultName = recovery.requestId + '.result.json';
      if (
        ![1, 2].includes(recovery.version) ||
        recovery.batchId !== batchId ||
        recovery.manifestSha256 !== source.sha256 ||
        name !== recovery.requestId + '.recovery.json' ||
        request?.mode !== 'reconcile' ||
        !Array.isArray(recovery.originalRequests) ||
        !recovery.originalRequests.length ||
        !Array.isArray(recovery.operationProofs) ||
        (recovery.version === 2 && !Array.isArray(recovery.deferredOperationProofs)) ||
        !names.includes(resultName)
      )
        fail('RECOVERY_INVALID');
      const result = JSON.parse(await readFile(resolve(directory, resultName), 'utf8'));
      if (
        result.requestId !== recovery.requestId ||
        result.mode !== 'reconcile' ||
        result.stopped !== false ||
        recovery.resultFingerprint !== fingerprint(result)
      )
        fail('RECOVERY_INVALID');
      const seen = new Set<string>();
      for (const original of recovery.originalRequests) {
        const old = records.get(original.requestId);
        if (
          !old ||
          old.mode === 'inspect' ||
          old.requestId === recovery.requestId ||
          seen.has(old.requestId) ||
          original.fingerprint !== fingerprint(old)
        )
          fail('RECOVERY_INVALID');
        seen.add(old.requestId);
        const affected = manifest.listings.filter(
          (s) => !old.sourceKey || s.sourceKey === old.sourceKey,
        );
        if (
          !affected.length ||
          affected.some((s) => {
            const proof = operationProofs.find((p) => p.sourceKey === s.sourceKey);
            if (proof && recovery.operationProofs.some((saved: any) => same(proof, saved))) return false;
            const deferred = recovery.version === 2 && old.mode !== 'publish'
              ? deferredOperationProofs.find((p) => p.sourceKey === s.sourceKey) : undefined;
            return !deferred || !recovery.deferredOperationProofs.some((saved: any) => same(deferred, saved));
          })
        )
          fail('RECOVERY_INVALID');
        recoveredRequestIds.add(old.requestId);
      }
      recoveries.push(recovery);
    }
    const hasUnfinished = [...records.keys()].some(
      (id) => !names.includes(id + '.result.json') && !recoveredRequestIds.has(id),
    );
    const alive = !callerOwnsLock && hasUnfinished ? await this.coordinatorAlive(batchId) : false;
    let interruptedInspection = false;
    for (const [id, record] of records) {
      if (!names.includes(id + '.result.json') && !recoveredRequestIds.has(id)) {
        // A previous GET-only inspection can never have dispatched a write. Keep its record visible,
        // but it need not prevent an explicit new action after this process restarts.
        if (record.mode === 'inspect' && !alive) interruptedInspection = true;
        else pending.push(id);
      } else if (names.includes(id + '.result.json'))
        results.push(JSON.parse(await readFile(resolve(directory, id + '.result.json'), 'utf8')));
    }
    results.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
    const lastResult = results.at(-1) ?? null,
      busy = pending.length > 0 && alive,
      interrupted = pending.length > 0 && !alive;
    const publicationMode = executionPolicy?.publicationMode ?? productionPublicationMode(manifest), hidden = publicationMode === 'hidden_for_review';
    const complete = (state:string) => state === 'published' || (hidden && ['created_unlisted','created_hidden_image_qc_deferred'].includes(state));
    const createdVerifiedCount = operationProofs.length;
    const hiddenVerifiedCount = listings.filter(s=>s.state==='created_unlisted').length;
    const completedCount = listings.filter(s=>complete(s.state)).length;
    const excludedCount=listings.filter(s=>s.excluded).length;
    const remaining=listings.filter(s=>!s.excluded);
    const eligible=(s:typeof listings[number])=>!s.excluded && !complete(s.state) && (!['not_sent','authorized_not_started'].includes(s.state)||s.currentSource==='current');
    const canExecute=this.enabled && saved.executionEnabled && !busy && !interrupted && !blockingWork?.blocksExecution &&
      !(hidden && remaining.some(s=>s.state==='publication_readback_pending')) && remaining.some(eligible) &&
      remaining.every(s=>['not_sent','authorized_not_started','published','created_readback_pending','created_unlisted','created_hidden_image_qc_deferred','publication_readback_pending'].includes(s.state));
    const statusFingerprint = fingerprint({
      manifest: source.sha256,
      executionEnabled: saved.executionEnabled,
      holdReason: saved.holdReason ?? null,
      rows,
      pending,
      records: [...records.values()],
      results,
      recoveries,
      blockingLane,
      exclusions,
      currentSources,
      ...(executionPolicy ? {executionPolicyFingerprint:executionPolicy.fingerprint} : {}),
    });
    return {
      records,
      operationProofs,
      deferredOperationProofs,
      orphanRequestIds: interrupted ? [...pending] : [],
      status: {
        batchId,
        manifestSha256: source.sha256,
        shopName: 'vuatinhdau.vn',
        partnerId: '2010476',
        shopId: '1423724897',
        publicationMode,
        imageQcPolicy:executionPolicy?.imageQcPolicy ?? productionImageQcPolicy(manifest),
        ...(executionPolicy ? {executionPolicyId:executionPolicy.id,executionPolicyFingerprint:executionPolicy.fingerprint} : {}),
        imageQcPendingCount:listings.filter(s=>s.state==='created_hidden_image_qc_deferred').length,
        completionTarget: hidden ? 'created_hidden' as const : 'published' as const,
        state: excludedCount>0 && remaining.every(s=>complete(s.state)) && !busy && !interrupted
          ? 'completed_with_exclusions'
          : !saved.executionEnabled
          ? 'held'
          : busy
            ? 'running'
            : interrupted
              ? 'needs_review'
              : remaining.every((s) => complete(s.state))
                ? (excludedCount ? 'completed_with_exclusions' : 'completed')
                : remaining.some(s=>(['not_sent','authorized_not_started'].includes(s.state) && s.currentSource!=='current') || ['needs_review','rejected','unknown','sent'].includes(s.state))
                  ? 'needs_review'
                  : 'ready',
        statusFingerprint,
        listings: listings.map(s=>({...s,canExecute:canExecute && eligible(s),canExclude:!s.excluded && !s.operationId && !busy && !interrupted,imageQcStatus:s.state==='created_hidden_image_qc_deferred'?'deferred':(['created_unlisted','published'].includes(s.state)?'verified':'required'),canPublish:!s.excluded && hidden && this.enabled && saved.executionEnabled && !busy && !interrupted && s.state==='created_unlisted'})),
        createdVerifiedCount,
        hiddenVerifiedCount,
        completedCount,
        excludedCount,
        publishedCount: listings.filter((s) => s.state === 'published').length,
        remainingCount: listings.length - completedCount - excludedCount,
        busy,
        ...(blockingWork ? {blockingWork} : {}),
        interrupted,
        interruptedInspection,
        recoveredRequestIds: [...recoveredRequestIds],
        canReconcile:
          this.enabled &&
          saved.executionEnabled &&
          !busy &&
          (interrupted || listings.some((s) => s.operationId && s.state!=='authorized_not_started' && (!complete(s.state)||s.state==='created_hidden_image_qc_deferred'))),
        acceptedStatusFingerprints: [
          ...new Set([...records.values()].map((record) => record.expectedStatusFingerprint)),
        ],
        enabled: this.enabled,
        executionEnabled: saved.executionEnabled,
        ...(saved.holdReason ? { holdReason: saved.holdReason } : {}),
        canExecute,
        lastResult,
      },
    };
  }
  async exclude(batchId:string,raw:unknown) {
    uuid.parse(batchId);
    const input=z.object({sourceKey:z.string().min(1).max(4000),expectedStatusFingerprint:sha}).strict().parse(raw);
    if(this.accepting || this.active.has(batchId))fail('IN_PROGRESS');
    this.accepting=true;
    let release:(()=>Promise<void>)|undefined;
    try {
      release=await this.acquireCoordinator(batchId,true);
      const {source}=await this.load(batchId,false);
      const current=(await this.inspectStatus(batchId,true)).status;
      if(current.statusFingerprint!==input.expectedStatusFingerprint)fail('STATUS_CHANGED');
      const selected=current.listings.find(s=>s.sourceKey===input.sourceKey);
      if(!selected?.canExclude || current.busy || current.interrupted)fail('EXCLUSION_NOT_ALLOWED');
      await writeProductionBatchExclusion(this.root,source,source.value.listings.find(s=>s.sourceKey===input.sourceKey)!,input.expectedStatusFingerprint);
      return (await this.inspectStatus(batchId,true)).status;
    } finally {
      this.accepting=false;if(release)await release();
    }
  }
  async publish(batchId:string,raw:unknown) {
    const input=z.object({sourceKey:z.string().min(1).max(4000),expectedStatusFingerprint:sha}).strict().parse(raw);
    return this.start(batchId,{...input,mode:'publish'});
  }
  async start(batchId: string, raw: unknown) {
    const input = runInput.parse(raw);
    uuid.parse(batchId);
    if(input.mode==='execute' && this.repo.pool.options?.max!==undefined && this.repo.pool.options.max<3)fail('POOL_CAPACITY_REQUIRED');
    if (this.accepting || this.active.has(batchId)) fail('IN_PROGRESS');
    this.accepting = true;
    let release: (() => Promise<void>) | undefined,
      dispatched = false;
    try {
      release = await this.acquireCoordinator(batchId);
      const { saved, source } = await this.load(batchId),
        assessed = await this.inspectStatus(batchId, true),
        current = assessed.status;
      if (current.busy) fail('IN_PROGRESS');
      if (current.statusFingerprint !== input.expectedStatusFingerprint) fail('STATUS_CHANGED');
      if (!this.enabled) fail('EXECUTION_DISABLED');
      if (input.mode !== 'inspect' && !saved.executionEnabled) fail('EXECUTION_HELD');
      if (current.interrupted && input.mode !== 'reconcile') fail('RECONCILIATION_REQUIRED');
      if (current.interrupted && input.sourceKey) fail('RECOVERY_REQUIRES_FULL_BATCH');
      if (input.sourceKey && !source.value.listings.some((s) => s.sourceKey === input.sourceKey))
        fail('SOURCE_NOT_ALLOWED');
      if(input.mode==='execute') {
        const selected=current.listings.filter(s=>!s.excluded && (!input.sourceKey||s.sourceKey===input.sourceKey));
        if(!selected.length)fail('SOURCE_NOT_ALLOWED');
        if(input.sourceKey || !current.canExecute){
          if(selected.some(s=>['not_sent','authorized_not_started'].includes(s.state)&&s.currentSource==='archived'))fail('SOURCE_ARCHIVED');
          if(selected.some(s=>['not_sent','authorized_not_started'].includes(s.state)&&s.currentSource==='source_changed'))fail('SOURCE_CHANGED');
        }
      }
      if (input.mode === 'execute' && !current.canExecute) fail('RECONCILIATION_REQUIRED');
      if (input.mode === 'publish' && (!input.sourceKey || !current.listings.some(s=>s.sourceKey===input.sourceKey && s.canPublish)))
        fail('PUBLICATION_NOT_READY');
      const selected = input.mode === 'publish' ? source.value.listings.find(s=>s.sourceKey===input.sourceKey)! : undefined;
      const verified = input.mode === 'publish' ? assessed.operationProofs.find(p=>p.sourceKey===input.sourceKey) : undefined;
      if(input.mode === 'publish' && !verified) fail('PUBLICATION_NOT_READY');
      // This is an operator action for one exact QC-verified create, distinct from
      // creation authorization and immutable before dispatching any publication.
      const publicationIntent = selected && verified ? {
        sourceIdentity:selected.sourceIdentity,sourceRevision:selected.sourceRevision,
        operationId:verified.operationId,itemId:current.listings.find(s=>s.sourceKey===input.sourceKey)!.itemId,
        sourceFingerprint:verified.sourceFingerprint,createVerificationId:verified.verificationId,
        createVerificationFingerprint:verified.verificationFingerprint,
      } : undefined;
      const directory = resolve(this.root, 'web-jobs', batchId),
        requestId = randomUUID();
      await mkdir(directory, { recursive: true });
      // A durable claim prevents the same displayed state from dispatching twice, including across processes.
      const claim = fingerprint({ batchId, status: current.statusFingerprint });
      const accepted = {
        version: 1,
        requestId,
        batchId,
        manifestSha256: saved.expectedSha256,
        ...input,
        ...(publicationIntent ? {publicationIntent} : {}),
        ...(current.executionPolicyId ? {executionPolicyId:current.executionPolicyId,executionPolicyFingerprint:current.executionPolicyFingerprint} : {}),
        acceptedAt: new Date().toISOString(),
      };
      try {
        await writeFile(resolve(directory, claim + '.claim.json'), JSON.stringify(accepted), {
          flag: 'wx',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('STATUS_CHANGED');
        throw error;
      }
      await writeFile(resolve(directory, requestId + '.request.json'), JSON.stringify(accepted), {
        flag: 'wx',
      });
      this.active.add(batchId);
      const heldRelease = release;
      const originalOrphans = assessed.orphanRequestIds.map((id) => assessed.records.get(id));
      const deferredRecoveryProofs = input.mode === 'reconcile' ? assessed.deferredOperationProofs.filter(proof =>
        current.listings.some(listing => listing.sourceKey === proof.sourceKey && listing.state === 'created_hidden_image_qc_deferred') &&
        originalOrphans.some(original => original.mode !== 'publish' && (!original.sourceKey || original.sourceKey === proof.sourceKey)) &&
        !originalOrphans.some(original => original.mode === 'publish' && (!original.sourceKey || original.sourceKey === proof.sourceKey)),
      ) : [];
      const running = this.perform(
        batchId,
        requestId,
        {
          mode: input.mode,
          manifestPath: saved.manifestPath,
          expectedSha256: saved.expectedSha256,
          ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
        },
        originalOrphans,
        deferredRecoveryProofs,
      ).finally(heldRelease);
      dispatched = true;
      void running.catch(() => undefined);
      return { requestId, batchId, state: 'accepted' };
    } finally {
      this.accepting = false;
      if (!dispatched && release) await release();
    }
  }
  private async perform(
    batchId: string,
    requestId: string,
    args: Parameters<typeof runPass1ProductionBatch>[0],
    originalOrphans: any[] = [],
    deferredRecoveryProofs: DeferredRecoveryProof[] = [],
  ) {
    try {
      let result;
      try {
        const raw = await (this.options.run ?? runPass1ProductionBatch)(args, {
          repo: this.repo,
          blobs: this.blobs,
          lifecycleRoot:this.root,
          ...(deferredRecoveryProofs.length ? {deferredRecoveryProofs} : {}),
        });
        result = {
          stopped: raw.stopped,
          listings: raw.listings.map((s) => ({
            sourceKey: s.sourceKey,
            state: s.state,
            ...(s.operationId ? { operationId: s.operationId } : {}),
            ...(s.itemId ? { itemId: s.itemId } : {}),
            ...(s.code ? { code: s.code } : {}),
          })),
        };
      } catch (error) {
        result = { stopped: true, listings: [], code: safeCode(error) };
      }
      const savedResult = {
        requestId,
        finishedAt: new Date().toISOString(),
        mode: args.mode,
        ...result,
      };
      await writeFile(
        resolve(this.root, 'web-jobs', batchId, requestId + '.result.json'),
        JSON.stringify(savedResult),
        { flag: 'wx' },
      );
      if (args.mode === 'reconcile' && originalOrphans.length && result.stopped === false) {
        const latest = await this.inspectStatus(batchId, true),
          affected = new Set<string>();
        for (const original of originalOrphans)
          for (const listing of latest.status.listings)
            if (!original.sourceKey || original.sourceKey === listing.sourceKey)
              affected.add(listing.sourceKey);
        const safe = [...affected].every(
          (key) => {
            const state = latest.status.listings.find((s) => s.sourceKey === key)?.state;
            if (['created_unlisted', 'published'].includes(state ?? '') && latest.operationProofs.some((p) => p.sourceKey === key)) return true;
            return state === 'created_hidden_image_qc_deferred' &&
              latest.deferredOperationProofs.some((p) => p.sourceKey === key) &&
              !originalOrphans.some((o) => o.mode === 'publish' && (!o.sourceKey || o.sourceKey === key));
          },
        );
        if (safe && affected.size) {
          const deferredProofs = latest.deferredOperationProofs.filter((p) => affected.has(p.sourceKey) &&
            latest.status.listings.some((s) => s.sourceKey === p.sourceKey && s.state === 'created_hidden_image_qc_deferred'));
          const recovery = {
            version: deferredProofs.length ? 2 : 1,
            requestId,
            batchId,
            manifestSha256: args.expectedSha256,
            observedAt: new Date().toISOString(),
            originalRequests: originalOrphans.map((original) => ({
              requestId: original.requestId,
              fingerprint: fingerprint(original),
            })),
            resultFingerprint: fingerprint(savedResult),
            operationProofs: latest.operationProofs.filter((p) => affected.has(p.sourceKey)),
            ...(deferredProofs.length ? {deferredOperationProofs: deferredProofs} : {}),
          };
          await writeFile(
            resolve(this.root, 'web-jobs', batchId, requestId + '.recovery.json'),
            JSON.stringify(recovery, null, 2),
            { flag: 'wx' },
          );
        }
      }
    } catch {
      /* Unrecorded completion remains pending; a restart cannot silently replay it. */
    } finally {
      this.active.delete(batchId);
    }
  }
}
