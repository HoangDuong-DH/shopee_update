import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, type SandboxSnapshot } from '@shopee/domain';
import { Repository, transaction, lockSandboxMutationLane } from '@shopee/persistence';
import {
  normalizeProductSnapshot,
  productFingerprint,
  snapshotContent,
} from '../../../packages/shopee/src/product-client.js';
import { normalizePreparedWireSnapshot } from '../../../packages/shopee/src/prepared-wire.js';
import type { FieldSnapshot } from '../../../packages/shopee/src/field-client.js';
import type { ImageQcService } from './image-qc-service.js';
import type { ImageQcBinding } from '../../../packages/shopee/src/image-qc.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    coverCaseId: z.string().uuid().optional(),
  })
  .strict();
export type LegacyRecoveryRequest = z.infer<typeof requestSchema>;
export type LegacyRecoveryObservation = {
  raw: FieldSnapshot;
  observedAt: string;
  requestIds: string[];
  cover?: {
    sourceImageId: string;
    outputImageId: string;
    sourceSha256: string;
    outputSha256: string;
  };
};
export type LegacyRecoveryResult = {
  id: string;
  runId: string;
  runRevision: number;
  verified: boolean;
  basis: 'historical_projection_and_fresh_raw_stability';
  code: string;
  mismatchedPaths: string[];
  runContentHash: string;
  observations: LegacyRecoveryObservation[];
  rawFingerprints: string[];
  connection: {
    id: string;
    revision: number;
    capabilityRevision: number;
    environment: 'sandbox';
    partnerId: '1232297';
    shopId: '227418363';
  };
  image?: {
    caseId: string;
    fingerprint: string;
    binding: ImageQcBinding;
    verificationBasis: string;
    sourceSha256: string;
    outputSha256: string;
    expiresAt: string;
  };
};
function fail(code: string): never {
  throw new Error('RECOVERY_' + code);
}
function requireThat(value: unknown, code: string): asserts value {
  if (!value) fail(code);
}
function difference(expected: any, actual: any, path = ''): string[] {
  if (same(expected, actual)) return [];
  if (
    Array.isArray(expected) !== Array.isArray(actual) ||
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object'
  )
    return [path || '$'];
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap((k) =>
    k in expected && k in actual
      ? difference(expected[k], actual[k], path ? `${path}.${k}` : k)
      : [path ? `${path}.${k}` : k],
  );
}
function content(snapshot: SandboxSnapshot) {
  requireThat(
    snapshot &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      snapshot.itemId === '803934364' &&
      Array.isArray(snapshot.models) &&
      snapshot.models.length === 6 &&
      new Set(snapshot.models.map((m) => m.modelId)).size === 6 &&
      Array.isArray(snapshot.coverImageIds) &&
      snapshot.coverImageIds.length === 1 &&
      typeof snapshot.coverImageIds[0] === 'string' &&
      snapshot.coverImageIds[0].length > 0 &&
      snapshot.protectedFields &&
      !Array.isArray(snapshot.protectedFields),
    'SNAPSHOT_INVALID',
  );
  const body = snapshotContent(snapshot);
  requireThat(snapshot.fingerprint === productFingerprint(body), 'SNAPSHOT_FINGERPRINT_INVALID');
  return body;
}
function unselected(snapshot: SandboxSnapshot, fields: string[]) {
  const body = structuredClone(content(snapshot));
  if (fields.includes('title')) delete (body as any).title;
  if (fields.includes('description')) {
    delete (body as any).description;
    delete (body as any).descriptionType;
  }
  if (fields.includes('gallery')) delete (body as any).gallery;
  return body;
}
/** Appends evidence about current state. Never rewrites the original unknown run or sends a mutation.
 * The historical decoder omitted fields, so this deliberately does not claim historical full-raw QC. */
export class LegacyListingRecoveryService {
  constructor(
    readonly repo: Repository,
    readonly images: ImageQcService,
    readonly options: {
      observe: (target: {
        runId: string;
        connectionId: string;
        itemId: string;
        baselineCoverImageId: string;
      }) => Promise<LegacyRecoveryObservation>;
      now?: () => Date;
      requestTimeoutMs?: number;
    },
  ) {
    requireThat(
      options.requestTimeoutMs === undefined ||
        (Number.isSafeInteger(options.requestTimeoutMs) &&
          options.requestTimeoutMs > 0 &&
          options.requestTimeoutMs <= 60000),
      'TIMEOUT_INVALID',
    );
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private async observe(target: Parameters<typeof this.options.observe>[0]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.options.observe(target),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('RECOVERY_READ_TIMEOUT')),
            this.options.requestTimeoutMs ?? 30000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async row(runId: string) {
    const r = (
      await this.repo.pool.query(
        'SELECT to_jsonb(r) AS snapshot FROM sandbox_listing_runs r WHERE id=$1',
        [runId],
      )
    ).rows[0];
    if (!r) fail('RUN_NOT_FOUND');
    return r.snapshot as Record<string, any>;
  }
  private validConnection(c: any, connectionId: string) {
    requireThat(
      c?.id === connectionId &&
        c.environment === 'sandbox' &&
        c.partner_id === '1232297' &&
        c.shop_id === '227418363',
      'SCOPE_FORBIDDEN',
    );
    requireThat(
      c.state === 'connected' && (!c.expires_at || Date.parse(c.expires_at) > this.now().getTime()),
      'AUTH_REQUIRED',
    );
  }
  async get(id: string): Promise<LegacyRecoveryResult> {
    const r = (
      await this.repo.pool.query('SELECT result FROM sandbox_listing_reconciliations WHERE id=$1', [
        z.string().uuid().parse(id),
      ])
    ).rows[0];
    if (!r) fail('NOT_FOUND');
    return r.result;
  }
  async reconcile(raw: LegacyRecoveryRequest): Promise<LegacyRecoveryResult> {
    const request = requestSchema.parse(raw);
    const previous = (
      await this.repo.pool.query(
        'SELECT request,result FROM sandbox_listing_reconciliations WHERE id=$1',
        [request.id],
      )
    ).rows[0];
    if (previous) {
      requireThat(same(previous.request, request), 'REQUEST_CONFLICT');
      return previous.result;
    }
    const run = await this.row(request.runId),
      runHash = hash(run);
    requireThat(run.revision === request.expectedRevision, 'RUN_CHANGED');
    requireThat(run.item_id === '803934364' && run.product_key === 'lamy-5d', 'SCOPE_FORBIDDEN');
    requireThat(run.state === 'unknown' && run.body?.phase === 'done', 'STATE_UNSUPPORTED');
    requireThat(
      (
        await this.repo.pool.query(
          "SELECT 1 FROM sandbox_listing_run_events WHERE run_id=$1 AND code='WRITE_ACKNOWLEDGED' AND revision<=$2",
          [run.id, run.revision],
        )
      ).rowCount,
      'ACK_REQUIRED',
    );
    requireThat(
      Array.isArray(run.body?.result?.requestIds) && run.body.result.requestIds.length > 0,
      'ACK_REQUIRED',
    );
    const fields = z
      .array(z.enum(['title', 'description', 'gallery']))
      .min(1)
      .parse(run.body.fieldMask);
    requireThat(
      new Set(fields).size === fields.length && same(fields, run.intent?.input?.fieldMask),
      'INTENT_INVALID',
    );
    const baseline = run.body.baseline as SandboxSnapshot,
      expected = run.body.expected as SandboxSnapshot;
    content(baseline);
    content(expected);
    requireThat(
      same(unselected(baseline, fields), unselected(expected, fields)),
      'EXPECTED_PRESERVATION_INVALID',
    );
    const connection = (
      await this.repo.pool.query(
        'SELECT id,environment,partner_id,shop_id,state,revision,capability_revision,expires_at FROM connections WHERE id=$1',
        [run.connection_id],
      )
    ).rows[0];
    this.validConnection(connection, run.connection_id);
    const observations: LegacyRecoveryObservation[] = [],
      projections: SandboxSnapshot[] = [],
      fingerprints: string[] = [];
    const paths: string[] = [];
    for (let index = 0; index < 2; index++) {
      const startedAt = this.now().getTime();
      const observation = structuredClone(
        await this.observe({
          runId: run.id,
          connectionId: run.connection_id,
          itemId: run.item_id,
          baselineCoverImageId: baseline.coverImageIds[0]!,
        }),
      );
      requireThat(
        Number.isFinite(Date.parse(observation.observedAt)) &&
          Date.parse(observation.observedAt) >= startedAt - 1000 &&
          Date.parse(observation.observedAt) <= this.now().getTime() + 1000 &&
          this.now().getTime() - Date.parse(observation.observedAt) <= 60000,
        'STALE_OBSERVATION',
      );
      requireThat(
        Array.isArray(observation.requestIds) &&
          observation.requestIds.length >= 2 &&
          observation.requestIds.every((v) => typeof v === 'string' && v.length > 0),
        'READ_RECEIPT_REQUIRED',
      );
      const normalized = normalizePreparedWireSnapshot(observation.raw);
      requireThat(
        String(normalized.item.item_id) === run.item_id && normalized.item.has_model === true,
        'READBACK_SCOPE_INVALID',
      );
      observations.push(observation);
      fingerprints.push(hash(normalized));
      const projection = normalizeProductSnapshot(
        observation.raw.item,
        observation.raw.models,
        run.item_id,
        observation.requestIds,
      );
      projections.push(projection);
    }
    if (fingerprints[0] !== fingerprints[1]) paths.push('fresh_raw_stability');
    const result: LegacyRecoveryResult = {
      id: request.id,
      runId: run.id,
      runRevision: run.revision,
      verified: false,
      basis: 'historical_projection_and_fresh_raw_stability',
      code: 'CURRENT_STATE_UNRESOLVED',
      mismatchedPaths: [],
      runContentHash: runHash,
      observations,
      rawFingerprints: fingerprints,
      connection: {
        id: connection.id,
        revision: connection.revision,
        capabilityRevision: connection.capability_revision,
        environment: 'sandbox',
        partnerId: '1232297',
        shopId: '227418363',
      },
    };
    const expectedContent = content(expected);
    for (const projection of projections)
      paths.push(...difference(expectedContent, content(projection)));
    if (paths.length && request.coverCaseId) {
      try {
        const sourceId = baseline.coverImageIds[0]!,
          outputId = projections[0]!.coverImageIds[0]!;
        const proofs = observations.map((o) => o.cover);
        requireThat(
          proofs.every(
            (p) =>
              p &&
              p.sourceImageId === sourceId &&
              p.outputImageId === outputId &&
              sha.safeParse(p.sourceSha256).success &&
              sha.safeParse(p.outputSha256).success,
          ) && same(proofs[0], proofs[1]),
          'COVER_OBSERVATION_CHANGED',
        );
        const proof = proofs[0]!;
        const binding: ImageQcBinding = {
          environment: 'sandbox',
          partnerId: '1232297',
          shopId: '227418363',
          itemId: run.item_id,
          operationId: run.id,
          role: 'cover',
          position: 0,
          sourceAssetId: sourceId,
          outputImageId: outputId,
        };
        const entry = await this.images.check({
          id: request.coverCaseId,
          binding,
          sourceSha256: proof.sourceSha256,
          outputSha256: proof.outputSha256,
        });
        requireThat(
          entry.result.state === 'verified' && entry.result.verificationBasis,
          'IMAGE_NOT_VERIFIED',
        );
        const adjustedPaths = fingerprints[0] === fingerprints[1] ? [] : ['fresh_raw_stability'];
        for (const original of projections) {
          requireThat(
            original.coverImageIds.length === 1 && original.coverImageIds[0] === outputId,
            'COVER_SLOT_CHANGED',
          );
          const projected = structuredClone(original),
            item = projected.protectedFields.item as any;
          requireThat(
            item?.promotion_image?.image_id_list?.length === 1 &&
              item.promotion_image.image_id_list[0] === outputId,
            'COVER_SLOT_CHANGED',
          );
          projected.coverImageIds = [sourceId];
          item.promotion_image.image_id_list = [sourceId];
          projected.fingerprint = productFingerprint(snapshotContent(projected));
          adjustedPaths.push(...difference(expectedContent, content(projected)));
        }
        paths.splice(0, paths.length, ...adjustedPaths);
        result.image = {
          caseId: entry.id,
          fingerprint: entry.fingerprint,
          binding,
          verificationBasis: entry.result.verificationBasis,
          sourceSha256: proof.sourceSha256,
          outputSha256: proof.outputSha256,
          expiresAt: entry.expiresAt,
        };
      } catch (error) {
        paths.push(
          error instanceof Error && /^(RECOVERY|IMAGE_QC)_/.test(error.message)
            ? error.message
            : 'image_proof_unresolved',
        );
      }
    }
    result.mismatchedPaths = [...new Set(paths)];
    result.verified = result.mismatchedPaths.length === 0;
    result.code = result.verified
      ? 'CURRENT_STATE_RECONCILED_HISTORY_UNCHANGED'
      : 'CURRENT_STATE_UNRESOLVED';
    return transaction(this.repo.pool, async (c) => {
      await lockSandboxMutationLane(c, 'sandbox:1232297:227418363');
      const replay = (
        await c.query('SELECT request,result FROM sandbox_listing_reconciliations WHERE id=$1', [
          request.id,
        ])
      ).rows[0];
      if (replay) {
        requireThat(same(replay.request, request), 'REQUEST_CONFLICT');
        return replay.result;
      }
      const current = (
        await c.query(
          'SELECT to_jsonb(r) AS snapshot FROM sandbox_listing_runs r WHERE id=$1 FOR UPDATE',
          [run.id],
        )
      ).rows[0]?.snapshot;
      requireThat(current && same(current, run) && hash(current) === runHash, 'RUN_CHANGED');
      const currentConnection = (
        await c.query(
          'SELECT id,environment,partner_id,shop_id,state,revision,capability_revision,expires_at FROM connections WHERE id=$1 FOR SHARE',
          [run.connection_id],
        )
      ).rows[0];
      this.validConnection(currentConnection, run.connection_id);
      requireThat(
        currentConnection.revision === connection.revision &&
          currentConnection.capability_revision === connection.capability_revision,
        'CONNECTION_CHANGED',
      );
      requireThat(
        observations.every((o) => this.now().getTime() - Date.parse(o.observedAt) <= 60000),
        'STALE_OBSERVATION',
      );
      if (result.image) {
        const image = (
          await c.query('SELECT fingerprint,expires_at FROM image_qc_cases WHERE id=$1', [
            result.image.caseId,
          ])
        ).rows[0];
        requireThat(
          image?.fingerprint === result.image.fingerprint &&
            new Date(image.expires_at).getTime() > this.now().getTime(),
          'IMAGE_PROOF_EXPIRED',
        );
      }
      await c.query(
        'INSERT INTO sandbox_listing_reconciliations(id,run_id,run_revision,run_input_fingerprint,run_content_hash,run_snapshot,request,verified,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          request.id,
          run.id,
          run.revision,
          run.input_fingerprint,
          runHash,
          run,
          request,
          result.verified,
          result,
          this.now(),
        ],
      );
      return result;
    });
  }
}
