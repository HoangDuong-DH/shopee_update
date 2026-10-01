import { createHash } from 'node:crypto';
import { canonicalJson, type PreparedDocument } from '@shopee/domain';
import type { Repository } from '@shopee/persistence';
import { currentProductionScope, productionOwner } from './production-scope.js';
import type { ProductionPilotPreparedInput } from './production-pilot-runner.js';

type Evidence = ProductionPilotPreparedInput['capabilityEvidence'];
type Probe = NonNullable<ProductionPilotPreparedInput['capabilityProbe']>;
export type IntendedCapabilitySource = { sourceIdentity: string; sourceRevision: number; document: PreparedDocument };
export function requiredProductionCapabilities(document: PreparedDocument): Probe['capabilities'] {
  return ['gallery34', ...(document.description.some(block => block.type === 'image') ? ['extendedDescription' as const] : [])];
}
/** This only nominates a candidate. The runner still verifies its journal, raw reads and connection. */
export async function findProductionCapabilityProof(repo: Repository, document: PreparedDocument): Promise<string | undefined> {
  const extended = requiredProductionCapabilities(document).includes('extendedDescription');
  const result = await repo.pool.query(`SELECT o.id FROM production_pilot_operations o
    JOIN production_pilot_verifications v ON v.operation_id=o.id
    JOIN connections c ON c.id=o.connection_id
    WHERE o.owner_key=$1 AND o.state='verified' AND c.environment=$2 AND c.partner_id=$3 AND c.shop_id=$4
      AND jsonb_array_length(CASE WHEN jsonb_typeof(o.source_payload->'document'->'gallery')='array'
        THEN o.source_payload->'document'->'gallery' ELSE '[]'::jsonb END)>0
    ORDER BY CASE WHEN $5::boolean AND NOT (COALESCE(o.source_payload->>'descriptionFallbackPolicy','')='plain_text_when_unsupported'
      AND COALESCE(o.source_payload->'capabilityEvidence'->'extendedDescription'->>'state','')='unsupported') AND EXISTS(SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(o.source_payload->'document'->'description')='array'
        THEN o.source_payload->'document'->'description' ELSE '[]'::jsonb END) b WHERE b->>'type'='image')
      THEN 0 WHEN $5::boolean THEN 1 ELSE 0 END, o.created_at DESC LIMIT 1`,
    [productionOwner(), currentProductionScope().environment, currentProductionScope().partnerId, currentProductionScope().shopId, extended]);
  return result.rows[0]?.id;
}
export function unknownProductionCapabilityEvidence(connectionRevision: number, reference: string): Evidence {
  const observation = { state: 'unknown' as const, observedAt: new Date().toISOString(), references: [reference] };
  return { ...currentProductionScope(), connectionRevision, gallery34: structuredClone(observation), extendedDescription: structuredClone(observation) };
}
/** Server-derived permission for this intended hidden document only; never a support claim. */
export function intendedHiddenCapabilityProbe(input: {
  hidden: boolean; batchId: string; manifestSha256: string; authorizationReference: string;
  source: IntendedCapabilitySource; evidence: Evidence;
}): Probe | undefined {
  const unknown = requiredProductionCapabilities(input.source.document).filter(key => input.evidence[key].state === 'unknown');
  if (!unknown.length) return undefined;
  if (!input.hidden || !input.authorizationReference.trim() || !/^[a-f0-9]{64}$/.test(input.manifestSha256)
    || input.source.document.publication !== 'unlisted') throw Error('PRODUCTION_BATCH_CAPABILITY_PROBE_FORBIDDEN');
  const binding = { scope: currentProductionScope(), batchId: input.batchId, manifestSha256: input.manifestSha256,
    authorizationReference: input.authorizationReference, sourceIdentity: input.source.sourceIdentity,
    sourceRevision: input.source.sourceRevision, document: input.source.document };
  return { sourceIdentity: input.source.sourceIdentity, sourceRevision: input.source.sourceRevision,
    authorizationReference: 'intended-hidden:' + createHash('sha256').update(canonicalJson(binding)).digest('hex'), capabilities: unknown };
}

