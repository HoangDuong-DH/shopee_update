import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';
import { canonicalJson } from '@shopee/domain';
import { BlobStore, Repository } from '@shopee/persistence';
import { ProductionPilotRunner } from './production-pilot-runner.js';
import { assertDeferredImageVerification } from './production-pilot-image-deferral.js';
import { ProductionExecutionPolicyService, assertExecutionPolicySource } from './production-execution-policy.js';
import {
  collectProductionBatchInput,
  loadProductionBatchSource,
  productionBatchPass1Root,
  productionPublicationMode,
  productionImageQcPolicy,
} from './production-batch-source.js';
import { productionPilotScope, productionPilotSourceRoot } from './production-pilot-source.js';
import { productionPilotImageService } from './production-pilot-image-service.js';
import { productionPilotWeightReviewFileLookup } from './production-pilot-weight-review.js';
import { ProductionPilotReadSession } from './production-pilot-read-session.js';
import { assertCurrentProductionSource, currentProductionSource, lockProductionSourceSelection, readProductionBatchExclusions } from './production-batch-lifecycle.js';
import {
  planPreparedWireCreate,
  preparedWireMediaRequirements,
} from '../../../packages/shopee/src/prepared-wire.js';
import { productionPilotWriteFingerprint } from '../../../packages/shopee/src/production-pilot-transport.js';

const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const owner = 'production:2010476:1423724897';
// Read-only evidence from the completed pilot. This identity is never added to write allowlists.
const capabilityOperationId = 'ec195c1c-b2e1-44d9-a866-e14a39988a9b';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const argumentSchema = z
  .object({
    mode: z.enum(['inspect', 'execute', 'reconcile', 'publish']).default('inspect'),
    manifestPath: z.string().min(1),
    expectedSha256: sha,
    sourceKey: z.string().min(1).optional(),
  })
  .strict();
export type Pass1BatchArguments = z.input<typeof argumentSchema>;
export function parsePass1Arguments(args: readonly string[]) {
  const names: Record<string, string> = {
    '--manifest': 'manifestPath',
    '--sha': 'expectedSha256',
    '--mode': 'mode',
    '--source-key': 'sourceKey',
  };
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!,
      equals = token.indexOf('='),
      flag = equals < 0 ? token : token.slice(0, equals),
      key = names[flag];
    if (!key || Object.hasOwn(values, key)) throw Error('PASS1_ARGUMENTS_INVALID');
    const value = equals < 0 ? args[++index] : token.slice(equals + 1);
    if (!value || value.startsWith('--')) throw Error('PASS1_ARGUMENTS_INVALID');
    values[key] = value;
  }
  return argumentSchema.parse(values);
}
type Loaded = Awaited<ReturnType<typeof loadProductionBatchSource>>;
type Listing = Loaded['value']['listings'][number];
type RunnerOptions = ConstructorParameters<typeof ProductionPilotRunner>[1];
export type DeferredRecoveryProof = {
  sourceKey: string;
  operationId: string;
  operationRevision: number;
  itemId: string;
  sourceFingerprint: string;
  receiptFingerprint: string;
};
type Dependencies = {
  repo: Repository;
  blobs: BlobStore;
  load?: typeof loadProductionBatchSource;
  collect?: typeof collectProductionBatchInput;
  createRunner?: (repo: Repository, options: RunnerOptions) => ProductionPilotRunner;
  /** Private tests may isolate files; there is no CLI/HTTP parameter for an output path. */
  outputRoot?: string;
  lifecycleRoot?: string;
  lockSource?:typeof lockProductionSourceSelection;
  /** Server-assessed orphan scope only; never a CLI/HTTP argument or ordinary QC retry. */
  deferredRecoveryProofs?: readonly DeferredRecoveryProof[];
  inspectPlan?: (
    input: Awaited<ReturnType<typeof collectProductionBatchInput>>['input'],
  ) => unknown;
};
function fail(code: string): never {
  throw Error('PASS1_' + code);
}
const errorCode = (error: unknown) =>
  error instanceof Error &&
  /^(?:PASS1|PRODUCTION_BATCH|PRODUCTION_PILOT)_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'PASS1_REVIEW_REQUIRED';
const checkpointSchema = z
  .object({
    version: z.literal(1),
    batchId: z.string().uuid(),
    manifestSha256: sha,
    sourceIdentity: z.string().min(1),
    sourceRevision: z.number().int().positive(),
    operationId: z.string().uuid(),
    sourceFingerprint: sha,
  })
  .strict();
export function checkCreate(
  view: any,
  source: Listing,
  loaded: Loaded,
  authorization: unknown,
  connectionId: string,
  connectionRevision: number,
) {
  const op = view.operation,
    payload = op?.source_payload;
  if (
    !op ||
    op.owner_key !== owner ||
    op.source_identity !== source.sourceIdentity ||
    op.source_revision !== source.sourceRevision ||
    op.connection_id !== connectionId ||
    !Number.isSafeInteger(op.connection_revision) ||
    op.connection_revision < 1 ||
    op.connection_revision > connectionRevision ||
    !payload ||
    payload.sourceIdentity !== source.sourceIdentity ||
    payload.sourceRevision !== source.sourceRevision ||
    payload.connectionId !== op.connection_id ||
    payload.connectionRevision !== op.connection_revision ||
    !same(payload.document, source.document) ||
    !same(payload.assets, loaded.value.assets) ||
    !same(payload.batchAuthorization, authorization) ||
    !same(payload.context?.attributeList, source.proposedAttributeList) ||
    payload.context?.brandName !== source.brandName ||
    payload.context?.condition !== source.condition ||
    !same(payload.context?.preOrder, source.preOrder) ||
    !same(payload.context?.stockLocationBySku, source.stockLocation.writeLocationBySku) ||
    !same(
      payload.stockLocationEvidence?.expectedLocationBySku,
      source.stockLocation.expectedLocationBySku,
    ) ||
    payload.metadata?.environment !== 'production' ||
    payload.metadata?.partnerId !== '2010476' ||
    payload.metadata?.shopId !== '1423724897' ||
    op.source_fingerprint !==
      fingerprint({
        scope: productionPilotScope,
        sourceIdentity: source.sourceIdentity,
        sourceRevision: source.sourceRevision,
        sourcePayload: payload,
        expectedProjection: op.expected_projection,
      })
  )
    fail('SOURCE_OPERATION_MISMATCH');
}
export function allAcknowledged(view: any, source: Listing) {
  const keys = [
    ...preparedWireMediaRequirements(source.document).map((_, index) => 'media-' + index),
    'create',
    ...(source.document.tierNames.length ? ['variations'] : []),
  ];
  if (
    !['acknowledged', 'verified'].includes(view.operation.state) ||
    !view.operation.item_id ||
    !Array.isArray(view.steps) ||
    view.steps.length !== keys.length ||
    !keys.every(
      (key) =>
        view.steps.filter((step: any) => step.step_key === key && step.state === 'acknowledged')
          .length === 1,
    )
  )
    fail('ALL_ACK_REQUIRED_NO_REPLAY');
}
/** A reservation is retryable only before any durable dispatch intent exists. */
export function isUndispatchedReservation(view: any): boolean {
  return view?.operation?.state === 'authorized' && view.operation.revision === 1 &&
    view.operation.item_id === null && Array.isArray(view.steps) && view.steps.length === 0 &&
    !view.verification && !view.deferredImageVerification && !view.deferred_image_verification &&
    !view.publication && !view.publication_verification;
}
export function checkVerification(
  verification: any,
  id: string,
  revision: number,
  itemId: string,
  phase: string,
  projection: unknown,
) {
  if (
    !verification ||
    verification.operation_id !== id ||
    verification.operation_revision !== revision - 1 ||
    verification.item_id !== itemId ||
    verification.phase !== phase ||
    (phase === 'created_unlisted' &&
      verification.expected_fingerprint !== fingerprint(projection)) ||
    !Array.isArray(verification.readbacks) ||
    verification.readbacks.length !== 2 ||
    verification.evidence_fingerprint !== fingerprint(verification.readbacks) ||
    !(
      Date.parse(verification.readbacks[0]?.observedAt) <
      Date.parse(verification.readbacks[1]?.observedAt)
    ) ||
    new Set(verification.readbacks.flatMap((read: any) => read.requestIds ?? [])).size !==
      verification.readbacks.flatMap((read: any) => read.requestIds ?? []).length ||
    verification.readbacks.some(
      (read: any) =>
        read.shopId !== '1423724897' ||
        read.partnerId !== '2010476' ||
        read.itemId !== itemId ||
        !Array.isArray(read.requestIds) ||
        !read.requestIds.length ||
        !read.requestIds.every((id: unknown) => typeof id === 'string' && id.length > 0) ||
        read.rawSha256 !== fingerprint(read.raw) ||
        read.projectionSha256 !== fingerprint(read.projection) ||
        !same(read.projection, projection),
    )
  )
    fail('VERIFICATION_PROOF_REQUIRED');
}
function inspect(input: Awaited<ReturnType<typeof collectProductionBatchInput>>['input']) {
  const context = structuredClone(input.context);
  context.images = preparedWireMediaRequirements(input.document).map((requirement, index) => ({
    importId: requirement.media.importId,
    sha256: requirement.media.sha256,
    role: requirement.role,
    imageId: 'LOCAL_ONLY_INSPECTION_' + index,
  }));
  // These placeholders validate source/metadata limits only. They are never uploaded or sent.
  return planPreparedWireCreate(input.document, context);
}

/** Shared coordinator for the local CLI and a future narrow HTTP entry. Default is GET-only.
 * execute may create/publish authorized sources; reconcile only reads existing ACK operations. */
export async function runPass1ProductionBatch(
  raw: Pass1BatchArguments,
  dependencies: Dependencies,
) {
  const args = argumentSchema.parse(raw),
    load = dependencies.load ?? loadProductionBatchSource;
  const collect = dependencies.collect ?? collectProductionBatchInput;
  const loaded = await load(args.manifestPath, args.expectedSha256);
  if (loaded.sha256 !== args.expectedSha256) fail('MANIFEST_CHANGED');
  const policyService=new ProductionExecutionPolicyService(dependencies.repo);
  const executionPolicy=loaded.value.version===2 ? await policyService.getForBatch(loaded.value.batchId,loaded.sha256) : null;
  const hidden = !!executionPolicy || productionPublicationMode(loaded.value) === 'hidden_for_review';
  const deferImages = hidden && productionImageQcPolicy(loaded.value)==='defer_image_qc';
  if (args.mode === 'publish' && !args.sourceKey) fail('PUBLICATION_SOURCE_REQUIRED');
  if (args.mode === 'publish' && !hidden) fail('PUBLICATION_MODE_INVALID');
  const selected = loaded.value.listings.filter(
    (source) => !args.sourceKey || source.sourceKey === args.sourceKey,
  );
  if (!selected.length || (args.sourceKey && selected.length !== 1)) fail('SOURCE_NOT_SELECTED');
  const authorization = {
    batchId: loaded.value.batchId,
    manifestSha256: loaded.sha256,
    authorizationReference: loaded.value.authorizationReference,
    ...(deferImages ? {publicationMode:'hidden_for_review' as const,imageQcPolicy:'defer_image_qc' as const} : {}),
    sources: loaded.value.listings.map((source) => ({
      sourceIdentity: source.sourceIdentity,
      sourceRevision: source.sourceRevision,
      documentSha256: fingerprint(source.document),
    })),
  };
  const readSession = new ProductionPilotReadSession({
    batchId: loaded.value.batchId,
    manifestSha256: loaded.sha256,
  });
  const outputRoot = dependencies.outputRoot ?? productionBatchPass1Root;
  const lifecycleRoot=dependencies.lifecycleRoot ?? outputRoot;
  const runId = randomUUID(),
    evidenceDirectory = resolve(outputRoot, 'runs', loaded.value.batchId, runId);
  await mkdir(evidenceDirectory, { recursive: true });
  const checkpointRoot = resolve(outputRoot, 'checkpoints', loaded.value.batchId, loaded.sha256);
  const save = async (phase: string, value: unknown) =>
    writeFile(
      resolve(evidenceDirectory, phase + '-' + randomUUID() + '.json'),
      JSON.stringify(value, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
  const result = {
    mode: args.mode,
    batchId: loaded.value.batchId,
    manifestSha256: loaded.sha256,
    runId,
    evidenceDirectory,
    stopped: false,
    listings: [] as {
      sourceKey: string;
      state: string;
      operationId?: string;
      itemId?: string;
      code?: string;
    }[],
  };
  const recheckSource = async () => {
    const current = await load(args.manifestPath, args.expectedSha256);
    if (current.sha256 !== loaded.sha256 || !same(current.value, loaded.value))
      fail('MANIFEST_CHANGED');
    if(loaded.value.version===2 && !same(await policyService.getForBatch(loaded.value.batchId,loaded.sha256),executionPolicy))fail('EXECUTION_POLICY_CHANGED');
  };
  for (const source of selected) {
    let releaseSource:(()=>Promise<void>)|undefined;
    try {
      await recheckSource();
      const excluded=(await readProductionBatchExclusions(lifecycleRoot,loaded)).some(receipt=>receipt.sourceKey===source.sourceKey);
      if(excluded) {
        const existing=await dependencies.repo.pool.query('SELECT id FROM production_pilot_operations WHERE owner_key=$1 AND source_identity=$2',[owner,source.sourceIdentity]);
        if(existing.rows.length)fail('EXCLUSION_INVALID');
        if(args.mode==='publish')fail('SOURCE_NOT_SELECTED');
        result.listings.push({sourceKey:source.sourceKey,state:'excluded'});
        continue;
      }
      const scopedPolicy=executionPolicy?.batches.some(b=>b.batchId===loaded.value.batchId && b.sources.some(s=>s.sourceIdentity===source.sourceIdentity)) ? executionPolicy : undefined;
      const sourceDefers=deferImages || !!scopedPolicy;
      const runner = (
        dependencies.createRunner ?? ((repo, options) => new ProductionPilotRunner(repo, options))
      )(dependencies.repo, {
        allowedSources: [
          { sourceIdentity: source.sourceIdentity, sourceRevision: source.sourceRevision },
        ],
        ...{ batchAuthorization: authorization },
        deferImageQc: sourceDefers && args.mode==='execute',
        ...(scopedPolicy ? {executionPolicy:scopedPolicy} : {}),
        ...{ capabilityProofOperationIds: [capabilityOperationId] },
        assetRoot: productionBatchPass1Root,
        evidenceRoot: resolve(productionBatchPass1Root, 'wire-evidence', loaded.value.batchId),
        coverImageQc: productionPilotImageService(
          dependencies.repo,
          dependencies.blobs,
          productionBatchPass1Root,
        ),
        weightReview: {
          findReview: productionPilotWeightReviewFileLookup(productionBatchPass1Root),
        },
        readbackDelaysMs: [1000, 3000, 7000, 15000],
      });
      const connections = (
        await dependencies.repo.pool.query(
          `SELECT id,revision,state,expires_at FROM connections
        WHERE environment='production' AND partner_id=$1 AND shop_id=$2`,
          ['2010476', '1423724897'],
        )
      ).rows;
      const connection = connections[0];
      if (
        connections.length !== 1 ||
        connection.state !== 'connected' ||
        new Date(connection.expires_at).getTime() <= Date.now()
      )
        fail('CONNECTION_REQUIRED');
      const rows = (
        await dependencies.repo.pool.query(
          `SELECT id,source_revision,EXISTS(SELECT 1 FROM production_pilot_publications p WHERE p.create_operation_id=o.id) AS has_publication
           FROM production_pilot_operations o WHERE owner_key=$1 AND source_identity=$2 ORDER BY source_revision`,
          [owner, source.sourceIdentity],
        )
      ).rows;
      if (rows.length > 1 || (rows.length && rows[0].source_revision !== source.sourceRevision))
        fail('SOURCE_HISTORY_REQUIRES_REVIEW');
      const checkpointPath = resolve(
        checkpointRoot,
        fingerprint({
          sourceIdentity: source.sourceIdentity,
          sourceRevision: source.sourceRevision,
        }) + '.json',
      );
      let view = rows.length ? await runner.journal.get(rows[0].id) : null;
      if(scopedPolicy)assertExecutionPolicySource(scopedPolicy,{batchId:loaded.value.batchId,manifestSha256:loaded.sha256,sourceIdentity:source.sourceIdentity,sourceRevision:source.sourceRevision,documentSha256:fingerprint(source.document),
        ...(view ? {operationId:view.operation.id,itemId:view.operation.item_id,sourceFingerprint:view.operation.source_fingerprint} : {})});
      let publication =
        view?.operation.state === 'verified'
          ? await runner.publications.getForCreate(view.operation.id)
          : null;
      if (args.mode === 'publish' && view?.operation.state !== 'verified')
        fail('PUBLICATION_REQUIRES_VERIFIED_CREATE');
      let undispatched = false;
      if (view) {
        checkCreate(view, source, loaded, authorization, connection.id, connection.revision);
        let checkpoint;
        try {
          checkpoint = checkpointSchema.parse(JSON.parse(await readFile(checkpointPath, 'utf8')));
        } catch {
          fail('CHECKPOINT_REQUIRED');
        }
        if (
          !same(checkpoint, {
            version: 1,
            batchId: loaded.value.batchId,
            manifestSha256: loaded.sha256,
            sourceIdentity: source.sourceIdentity,
            sourceRevision: source.sourceRevision,
            operationId: view.operation.id,
            sourceFingerprint: view.operation.source_fingerprint,
          })
        )
          fail('CHECKPOINT_MISMATCH');
        undispatched = isUndispatchedReservation(view);
        if (undispatched && rows[0]?.has_publication) fail('PUBLICATION_RECONCILIATION_REQUIRED');
        if (undispatched && args.mode === 'reconcile') {
          // There is no remote write to reconcile. In particular, a read-only action
          // must never turn an old shop-busy reservation into its first upload/create.
          result.listings.push({sourceKey:source.sourceKey,state:'authorized_not_started',operationId:view.operation.id});
          continue;
        }
        if (!undispatched) allAcknowledged(view, source);
        if (view.operation.state === 'verified')
          checkVerification(
            view.verification,
            view.operation.id,
            view.operation.revision,
            view.operation.item_id,
            'created_unlisted',
            view.operation.expected_projection,
          );
        if (publication) {
          const pub = publication.operation;
          if (
            view.operation.state !== 'verified' ||
            pub.owner_key !== owner ||
            pub.create_operation_id !== view.operation.id ||
            pub.source_fingerprint !== view.operation.source_fingerprint ||
            pub.create_verification_id !== view.verification?.id ||
            pub.item_id !== view.operation.item_id ||
            pub.source_identity !== source.sourceIdentity ||
            pub.source_revision !== source.sourceRevision ||
            pub.connection_id !== view.operation.connection_id ||
            !Number.isSafeInteger(pub.connection_revision) ||
            pub.connection_revision < view.operation.connection_revision ||
            pub.connection_revision > connection.revision ||
            pub.path !== '/api/v2/product/unlist_item' ||
            !same(pub.payload, { item_list: [{ item_id: Number(pub.item_id), unlist: false }] }) ||
            pub.fingerprint !== productionPilotWriteFingerprint(pub.path, pub.payload) ||
            !pub.receipt ||
            pub.outcome_fingerprint !== fingerprint(pub.receipt) ||
            !same(pub.expected_projection, view.operation.expected_projection) ||
            !['acknowledged', 'verified'].includes(pub.state)
          )
            fail('PUBLICATION_RECONCILIATION_REQUIRED');
          if (pub.state === 'verified') {
            checkVerification(
              publication.verification,
              pub.id,
              pub.revision,
              pub.item_id,
              'published',
              { ...view.operation.expected_projection, status: 'NORMAL' },
            );
            result.listings.push({
              sourceKey: source.sourceKey,
              state: 'published',
              operationId: view.operation.id,
              itemId: view.operation.item_id,
            });
            continue; // No runner.run/publish or metadata calls on completed items.
          }
        }
      } else if (args.mode === 'reconcile') {
        result.listings.push({ sourceKey: source.sourceKey, state: 'not_sent' });
        continue;
      } else {
        try {
          await readFile(checkpointPath);
          fail('CHECKPOINT_WITHOUT_OPERATION');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if(args.mode==='execute' && (!view || undispatched)) {
        const current=await currentProductionSource(dependencies.repo,source);
        if(current.currentSource!=='current') {
          const code=current.currentSource==='archived'?'PRODUCTION_BATCH_SOURCE_ARCHIVED':'PRODUCTION_BATCH_SOURCE_CHANGED';
          result.listings.push({sourceKey:source.sourceKey,state:'blocked',code});result.stopped=true;
          if(args.sourceKey)break;
          continue;
        }
        releaseSource=await (dependencies.lockSource ?? lockProductionSourceSelection)(dependencies.repo,source);
        if((await readProductionBatchExclusions(lifecycleRoot,loaded)).some(receipt=>receipt.sourceKey===source.sourceKey)) {
          if(view)fail('EXCLUSION_INVALID');
          result.listings.push({sourceKey:source.sourceKey,state:'excluded'});
          continue;
        }
      }
      const recoveryProof = args.mode === 'reconcile'
        ? dependencies.deferredRecoveryProofs?.find(proof => proof.sourceKey === source.sourceKey)
        : undefined;
      // Only an exact receipt assessed for a non-publication orphan may skip full QC here.
      // Ordinary reconcile still performs full image QC and gains no deferral permission.
      if (recoveryProof && (!view?.deferredImageVerification || !same(recoveryProof, {
        sourceKey: source.sourceKey,
        operationId: view.operation.id,
        operationRevision: view.operation.revision,
        itemId: view.operation.item_id,
        sourceFingerprint: view.operation.source_fingerprint,
        receiptFingerprint: fingerprint(view.deferredImageVerification),
      }))) fail('DEFERRED_RECOVERY_PROOF_CHANGED');
      if(sourceDefers && view?.deferredImageVerification && view.operation.state!=='verified' && (args.mode==='execute' || recoveryProof)) {
        // getForCreate requires a fully verified create. This existence read also rejects
        // contradictory publication history while the create is only acknowledged.
        const published = await dependencies.repo.pool.query(
          'SELECT id FROM production_pilot_publications WHERE create_operation_id=$1', [view.operation.id],
        );
        if(publication || published.rows.length) fail('PUBLICATION_RECONCILIATION_REQUIRED');
        assertDeferredImageVerification(view.deferredImageVerification,view.operation,scopedPolicy);
        result.listings.push({sourceKey:source.sourceKey,state:'created_hidden_image_qc_deferred',operationId:view.operation.id,itemId:view.operation.item_id});
        continue;
      }
      if (hidden && view?.operation.state === 'verified' && !publication && args.mode !== 'publish' && args.mode !== 'inspect') {
        result.listings.push({sourceKey:source.sourceKey,state:'created_unlisted',operationId:view.operation.id,itemId:view.operation.item_id});
        continue;
      }
      if (hidden && publication && args.mode === 'execute') fail('PUBLICATION_RECONCILIATION_REQUIRED');
      const capability = await runner.capabilityEvidenceFromVerified(
        capabilityOperationId,
        connection.revision,
        new Date().toISOString(),
        [resolve(productionPilotSourceRoot, 'wire-evidence', capabilityOperationId)],
      );
      const preflight = await collect(
        dependencies.repo,
        {
          manifestPath: args.manifestPath,
          expectedSha256: args.expectedSha256,
          sourceKey: source.sourceKey,
        },
        {
          priorCapabilityEvidence: capability,
          readSession,
          purpose: view && !undispatched ? 'existing_readback' : 'create',
          ...(view && !undispatched ? { trustedExistingOperation: {
            operationId: view.operation.id, itemId: view.operation.item_id,
            sourceIdentity: source.sourceIdentity, sourceRevision: source.sourceRevision,
            sourceFingerprint: view.operation.source_fingerprint,
          } } : {}),
          // Existing operation reconciliation may see its own SKU; creation retains duplicate blocking.
          allowExistingListings: Boolean(view) && !undispatched,
        },
      );
      if (preflight.sourceReceiptSha256 !== loaded.sha256) fail('MANIFEST_CHANGED');
      await recheckSource();
      if (args.mode === 'inspect') {
        const plan: any = (dependencies.inspectPlan ?? inspect)(preflight.input);
        await save('inspection', {
          sourceKey: source.sourceKey,
          localOnlyImageBindings: true,
          plan,
          existingOperationId: view?.operation.id,
        });
        result.listings.push({
          sourceKey: source.sourceKey,
          state: plan.kind === 'ready' ? 'inspected' : 'blocked',
          ...(plan.kind !== 'ready' && typeof plan.issues?.[0]?.code === 'string'
            ? { code: plan.issues[0].code }
            : {}),
          ...(view ? { operationId: view.operation.id } : {}),
        });
        if (plan.kind !== 'ready') {
          result.stopped = true;
        }
        // Inspection has no reservations or writes. Return all source-local exceptions
        // in one pass instead of making an operator discover them one listing at a time.
        continue;
      }
      if(args.mode==='execute' && (!view || undispatched))await assertCurrentProductionSource(dependencies.repo,source);
      if (view && undispatched && args.mode === 'execute') {
        await runner.renewUndispatched(view.operation.id, view.operation.source_fingerprint, preflight.input);
      }
      if (!view) {
        const prepared = await runner.prepare(preflight.input);
        if (prepared.kind !== 'ready') {
          await save('plan-blocked', prepared);
          fail('PLAN_BLOCKED');
        }
        view = await runner.journal.get(prepared.operationId);
        checkCreate(view, source, loaded, authorization, connection.id, connection.revision);
        await mkdir(checkpointRoot, { recursive: true });
        await writeFile(
          checkpointPath,
          JSON.stringify(
            {
              version: 1,
              batchId: loaded.value.batchId,
              manifestSha256: loaded.sha256,
              sourceIdentity: source.sourceIdentity,
              sourceRevision: source.sourceRevision,
              operationId: view.operation.id,
              sourceFingerprint: view.operation.source_fingerprint,
            },
            null,
            2,
          ),
          { flag: 'wx', mode: 0o600 },
        );
      }
      await recheckSource();
      if(args.mode==='execute' && (undispatched || isUndispatchedReservation(view)))await assertCurrentProductionSource(dependencies.repo,source);
      if (undispatched) {
        const current = await runner.journal.get(view.operation.id);
        checkCreate(current, source, loaded, authorization, connection.id, connection.revision);
        if (!isUndispatchedReservation(current) || current.operation.source_fingerprint !== view.operation.source_fingerprint)
          fail('RECONCILIATION_REQUIRED');
        // Reuse the immutable reservation. The append-only fresh preflight receipt
        // binds its current connection/deadline; journal still enforces every CAS permit.
      }
      const created = await runner.run(view.operation.id);
      await save('create-result', { sourceKey: source.sourceKey, ...created });
      if(created.state==='hidden_image_qc_deferred' && sourceDefers && args.mode==='execute') {
        result.listings.push({sourceKey:source.sourceKey,...created,state:'created_hidden_image_qc_deferred'});
        continue;
      }
      if (created.state !== 'verified') {
        result.listings.push({ sourceKey: source.sourceKey, ...created });
        result.stopped = true;
        if (created.state==='unresolved' && await runner.journal.waitForQc(view.operation.id)) continue;
        break;
      }
      if ((hidden && args.mode !== 'publish' && !publication) || (args.mode === 'reconcile' && !publication)) {
        result.listings.push({
          sourceKey: source.sourceKey,
          state: 'created_unlisted',
          operationId: created.operationId,
          itemId: created.itemId,
        });
        continue;
      }
      await recheckSource();
      const publicationPreflight = await collect(
        dependencies.repo,
        {
          manifestPath: args.manifestPath,
          expectedSha256: args.expectedSha256,
          sourceKey: source.sourceKey,
        },
        { priorCapabilityEvidence: capability, allowExistingListings: true,
          readSession, purpose: 'publish', trustedExistingOperation: {
            operationId: created.operationId, itemId: created.itemId!,
            sourceIdentity: source.sourceIdentity, sourceRevision: source.sourceRevision,
            sourceFingerprint: view.operation.source_fingerprint,
          },
        },
      );
      if (publicationPreflight.sourceReceiptSha256 !== loaded.sha256) fail('MANIFEST_CHANGED');
      await recheckSource();
      const published = await runner.publish(
        created.operationId,
        publicationPreflight.input.metadata,
      );
      await save('publish-result', { sourceKey: source.sourceKey, ...published });
      result.listings.push({ sourceKey: source.sourceKey, ...published });
      if (published.state !== 'published') {
        result.stopped = true;
        break;
      }
    } catch (error) {
      const code = errorCode(error);
      result.stopped = true;
      result.listings.push({ sourceKey: source.sourceKey, state: 'blocked', code });
      await save('stopped', { sourceKey: source.sourceKey, code });
      break;
    } finally {
      if(releaseSource)await releaseSource();
    }
  }
  await save('summary', result);
  return result;
}
