import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@shopee/domain';

const source = z.object({
  sourceIdentity: z.string().min(1).max(200), sourceRevision: z.number().int().positive(),
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const schema = z.object({
  batchId: z.string().uuid(), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  authorizationReference: z.string().min(1).max(4000), sources: z.array(source).min(1).max(4),
  publicationMode:z.literal('hidden_for_review').optional(),
  imageQcPolicy:z.literal('defer_image_qc').optional(),
}).strict().refine(v=>v.imageQcPolicy===undefined ? v.publicationMode===undefined : v.publicationMode==='hidden_for_review');
export type ProductionPilotBatchAuthorization = z.infer<typeof schema>;
type Source = { sourceIdentity: string; sourceRevision: number };
function fail(code: string): never { throw new Error('PRODUCTION_PILOT_' + code); }
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Trusted server input derived from a hash-verified manifest, never a browser request.
 * One immutable source revision per identity in this bounded, at-most-four-source batch.
 * Later source changes require a separately designed explicit supersession flow. */
export function parseProductionPilotBatchAuthorization(
  raw: ProductionPilotBatchAuthorization | undefined,
  allowed: readonly Source[],
): ProductionPilotBatchAuthorization | undefined {
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail('BATCH_AUTHORIZATION_INVALID');
  const proof = parsed.data;
  if (new Set(proof.sources.map(entry => entry.sourceIdentity)).size !== proof.sources.length ||
    allowed.some(entry => !proof.sources.some(candidate => candidate.sourceIdentity === entry.sourceIdentity &&
      candidate.sourceRevision === entry.sourceRevision))) fail('SOURCE_ALLOWLIST_INVALID');
  proof.sources.forEach(Object.freeze); Object.freeze(proof.sources); Object.freeze(proof);
  return proof;
}

export function assertProductionPilotBatchBinding(
  authorization: ProductionPilotBatchAuthorization | undefined,
  row: { source_identity: string; source_revision: number; source_payload: Record<string, unknown> },
) {
  const stored = row.source_payload.batchAuthorization;
  if (authorization === undefined) {
    if (Object.hasOwn(row.source_payload, 'batchAuthorization')) fail('BATCH_AUTHORIZATION_CHANGED');
    return;
  }
  if (canonicalJson(stored ?? null) !== canonicalJson(authorization)) fail('BATCH_AUTHORIZATION_CHANGED');
  const source = authorization.sources.find(candidate => candidate.sourceIdentity === row.source_identity &&
    candidate.sourceRevision === row.source_revision);
  if (!source || !row.source_payload.document || digest(row.source_payload.document) !== source.documentSha256)
    fail('BATCH_DOCUMENT_CHANGED');
}

export function bindProductionPilotBatchAuthorization(
  authorization: ProductionPilotBatchAuthorization | undefined,
  source: Source,
  payload: Record<string, unknown>,
) {
  if (authorization) {
    if (Object.hasOwn(payload, 'batchAuthorization') && canonicalJson(payload.batchAuthorization) !== canonicalJson(authorization))
      fail('BATCH_AUTHORIZATION_CHANGED');
    payload.batchAuthorization = structuredClone(authorization);
  }
  assertProductionPilotBatchBinding(authorization, {
    source_identity: source.sourceIdentity, source_revision: source.sourceRevision, source_payload: payload,
  });
}
