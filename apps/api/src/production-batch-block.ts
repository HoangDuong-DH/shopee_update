type ChildState = {
  state: string; busy?: boolean; interrupted?: boolean;
  blockingWork?: { blocksExecution?: boolean };
  listings?: { state: string; currentSource?: string; sourceKey?: string; operationId?: string | null }[];
  lastResult?: { mode?: string; code?: string; listings?: { sourceKey?: string; state?: string; code?: string; operationId?: string; failureScope?: string }[] } | null;
};

// Only errors established from the selected source against successfully read metadata.
// Transport, incomplete metadata, inventory and connection errors are deliberately absent.
export function sourcePreflightFailure(code: string): boolean {
  return [
    'MANDATORY_ATTRIBUTE_MISSING', 'ATTRIBUTE_COUNT_INVALID', 'CUSTOM_ATTRIBUTE_UNVERIFIED',
    'ATTRIBUTE_VALUE_CHANGED', 'ATTRIBUTE_UNIT_CHANGED', 'ATTRIBUTE_DATE_READBACK_UNSUPPORTED',
    'BRAND_REVALIDATION_REQUIRED', 'DUPLICATE_LISTING_OR_SKU',
  ].some(value => code === 'PRODUCTION_PILOT_' + value);
}

/** Only positively identified source/QC holds are local. Unknown writes,
 * connection failures and unrecognized states stop dispatch for this shop. */
export function independentBatchHold(child: ChildState): boolean {
  if(child.busy || child.interrupted || child.blockingWork?.blocksExecution) return false;
  if(!child.listings?.length) return false;
  if(child.lastResult?.code) return false;
  const blocked = child.lastResult?.listings?.filter(result => result.state === 'blocked') ?? [];
  const localBlock = (result: typeof blocked[number]) => !result.operationId &&
    (result.code === 'PASS1_PLAN_BLOCKED' ||
      result.failureScope === 'source_preflight' && sourcePreflightFailure(result.code ?? '') ||
      ['PRODUCTION_BATCH_SOURCE_CHANGED','PRODUCTION_BATCH_SOURCE_ARCHIVED'].includes(result.code ?? '')) &&
    child.listings!.some(listing => listing.sourceKey && listing.sourceKey === result.sourceKey &&
      listing.state === 'not_sent' && !listing.operationId);
  // A prior local failure must never hide a later shop-wide failure in the same run.
  if(blocked.some(result => !localBlock(result))) return false;
  const localPlanBlocked = child.lastResult?.mode === 'execute' && blocked.some(localBlock);
  return child.listings.every(listing => [
    'not_sent','authorized_not_started','excluded','published','created_unlisted',
    'created_hidden_image_qc_deferred','created_readback_pending',
  ].includes(listing.state)) && (
    child.state === 'held' || Boolean(localPlanBlocked) || child.listings.some(listing =>
      listing.state === 'created_readback_pending' ||
      (listing.state === 'not_sent' && ['source_changed','archived','missing'].includes(listing.currentSource ?? '')))
  );
}
