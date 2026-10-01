import type { CloneCoordinatorDependencies, CloneCoordinatorInput, CloneCoordinatorResult } from './archive-clone-coordinator.js';

const fresh = (stamp: string, maxMs: number) => {
  const age = Date.now() - Date.parse(stamp);
  return Number.isFinite(age) && age >= 0 && age <= maxMs;
};

/** Read Shopee twice again and append a QC attempt for an already-created item.
 * There is no transport write capability in this class. The journal enforces
 * acknowledged create/init steps and an initial mismatching QC record. */
export class ArchiveCloneQcRechecker {
  constructor(private readonly deps: Pick<CloneCoordinatorDependencies,
    'journal' | 'readImageEvidence' | 'readVideoReceipt' | 'readQcEvidence'>) {}

  async recheckOne(input: CloneCoordinatorInput, intentId: string,
    targetItemId: string): Promise<CloneCoordinatorResult> {
    const blocked = (reason: string): CloneCoordinatorResult =>
      ({ kind: 'held', reasons: [reason], targetItemId });
    if (!/^[0-9]+$/.test(targetItemId) || !intentId ||
        input.mode !== 'pilot' ||
        input.pilot?.sourceItemId !== input.sourceItemId ||
        input.pilot?.targetShopId !== input.scope.shopId ||
        input.scope.shopId !== input.target.shopId ||
        input.scope.connectionId !== input.target.connectionId ||
        input.scope.connectionRevision !== input.target.connectionRevision)
      return blocked('QC_RECHECK_SCOPE_INVALID');
    const item = input.manifest.items.find(row => row.sourceItemId === input.sourceItemId);
    if (!item) return blocked('QC_RECHECK_SOURCE_MISSING');
    const prior = await this.deps.journal.get(intentId);
    if (!prior || prior.intent.state !== 'held' ||
        prior.intent.target_item_id !== targetItemId ||
        prior.intent.archive_id !== input.manifest.archiveId ||
        prior.intent.source_item_id !== input.sourceItemId ||
        prior.intent.source_evidence_id !== input.sourceEvidenceId ||
        prior.intent.policy_hash !== input.policyHash ||
        prior.intent.target_connection_id !== input.scope.connectionId ||
        prior.intent.target_connection_revision !== input.scope.connectionRevision ||
        prior.intent.target_partner_id !== input.scope.partnerId ||
        prior.intent.target_shop_id !== input.scope.shopId ||
        prior.qc?.result !== 'mismatch')
      return blocked('QC_RECHECK_INTENT_NOT_ELIGIBLE');
    const media = await this.deps.readImageEvidence(input.manifest.archiveId,
      input.sourceItemId, input.scope);
    if (!media.complete || media.shopId !== input.scope.shopId ||
        media.connectionRevision !== input.scope.connectionRevision ||
        !fresh(media.observedAt, 15 * 60_000))
      return blocked('QC_RECHECK_MEDIA_UNVERIFIED');
    const sourceVideo = item.media.find(asset => asset.role === 'video');
    const videoBinding = sourceVideo ? await this.deps.readVideoReceipt?.(
      input.manifest.archiveId, input.sourceItemId, sourceVideo.sha256, input.scope) : undefined;
    if (sourceVideo && !videoBinding) return blocked('QC_RECHECK_VIDEO_UNVERIFIED');
    const evidence = await this.deps.readQcEvidence({ itemId: targetItemId,
      scope: input.scope, sourceItemId: input.sourceItemId,
      archiveId: input.manifest.archiveId, media, videoBinding });
    if (evidence.manifest.archiveId !== input.manifest.archiveId ||
        evidence.sourceItemId !== input.sourceItemId ||
        evidence.sourceObservationHash !== item.observationHash ||
        evidence.targetShopId !== input.scope.shopId ||
        evidence.readbacks.length !== 2 ||
        evidence.readbacks.some(readback => readback.shopId !== input.scope.shopId ||
          String(readback.item.item_id) !== targetItemId ||
          !fresh(readback.observedAt, 5 * 60_000)))
      return blocked('QC_RECHECK_EVIDENCE_INVALID');
    const result = await this.deps.journal.recordQcRecheck(intentId,
      { targetItemId, evidence });
    return result.result === 'verified'
      ? { kind: 'verified', targetItemId, intentId }
      : blocked('QC_MISMATCH');
  }
}
