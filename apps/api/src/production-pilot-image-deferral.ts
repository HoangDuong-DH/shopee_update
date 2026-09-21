import { createHash } from 'node:crypto';
import { canonicalJson } from '@shopee/domain';
import type { FieldSnapshot } from '../../../packages/shopee/src/field-client.js';
import { assertExecutionPolicySource, type ExecutionPolicyReceipt } from './production-execution-policy.js';
const fp=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Exclude media identity only. Description text/order, models and every business field remain. */
export function coreProjectionWithoutImages(projection:Record<string,any>) {
  const core=structuredClone(projection);delete core.cover;delete core.gallery;
  for(const block of core.description ?? [])if(block.type==='image')delete block.image;
  for(const model of core.models ?? [])delete model.image;
  return core;
}
export function stableCoreSnapshot(raw:FieldSnapshot) {
  const core=structuredClone(raw) as any;delete core.item.image;delete core.item.promotion_image;
  for(const block of core.item.description_info?.extended_description?.field_list ?? [])if(block.field_type==='image')delete block.image_info;
  for(const tier of core.models.tier_variation ?? [])for(const option of tier.option_list ?? [])delete option.image;
  for(const tier of core.models.standardise_tier_variation ?? [])for(const option of tier.variation_option_list ?? []){delete option.image_id;delete option.image_url;}
  return core as FieldSnapshot;
}
export function assertDeferredImageVerification(receipt:any,operation:any,policy?:ExecutionPolicyReceipt) {
  const authorization=operation.source_payload?.batchAuthorization;
  if(policy) {
    assertExecutionPolicySource(policy,{batchId:authorization?.batchId,manifestSha256:authorization?.manifestSha256,
      sourceIdentity:operation.source_identity,sourceRevision:operation.source_revision,documentSha256:fp(operation.source_payload?.document),
      operationId:operation.id,itemId:operation.item_id,sourceFingerprint:operation.source_fingerprint});
    if(receipt?.execution_policy_id!==policy.id)throw Error('PRODUCTION_PILOT_DEFERRED_IMAGE_PROOF_INVALID');
  }
  const projection=coreProjectionWithoutImages(operation.expected_projection);
  const reads=receipt?.readbacks;
  if((!policy && (authorization?.publicationMode!=='hidden_for_review'||authorization.imageQcPolicy!=='defer_image_qc'||receipt?.execution_policy_id))||
    operation.state!=='acknowledged'||receipt?.operation_id!==operation.id||receipt.operation_revision!==operation.revision||
    receipt.item_id!==operation.item_id||receipt.source_fingerprint!==operation.source_fingerprint||
    receipt.basis!=='image_qc_deferred_by_operator'||receipt.expected_core_fingerprint!==fp(projection)||
    !Array.isArray(reads)||reads.length!==2||receipt.evidence_fingerprint!==fp(reads)||
    !(Date.parse(reads[0]?.observedAt)<Date.parse(reads[1]?.observedAt))||
    new Set(reads.flatMap((r:any)=>r.requestIds ?? [])).size!==reads.flatMap((r:any)=>r.requestIds ?? []).length||
    reads.some((r:any)=>r.shopId!=='1423724897'||r.partnerId!=='2010476'||r.itemId!==operation.item_id||
      !Array.isArray(r.requestIds)||!r.requestIds.length||r.rawSha256!==fp(r.raw)||r.projectionSha256!==fp(r.projection)||
      canonicalJson(r.projection)!==canonicalJson(projection)))throw Error('PRODUCTION_PILOT_DEFERRED_IMAGE_PROOF_INVALID');
}
