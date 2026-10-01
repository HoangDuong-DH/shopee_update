import type { Pool } from 'pg';
import type { ShopCredentials } from '../../../packages/shopee/src/shop-info.js';
import type { ProductionPilotCloneScope } from '../../../packages/shopee/src/production-pilot-transport.js';
import { uploadApprovedArchiveImage, type ApprovedCloneMediaPreflight } from './archive-clone-media-runner.js';
import { ShopListingMediaTransferJournal } from './shop-listing-media-transfer.js';
import type { CloneCoordinatorInput, CloneCoordinatorResult } from './archive-clone-coordinator.js';
import { ArchiveCloneCoordinator } from './archive-clone-coordinator.js';
import type { ArchiveCloneQcRechecker } from './archive-clone-qc-recheck.js';

export type ArchiveCloneBatchJob = Omit<CloneCoordinatorInput, 'mode' | 'pilot'>;
export type ArchiveCloneBatchRow = {
  sourceItemId: string; targetShopId: string; result: CloneCoordinatorResult;
  skippedExisting?: boolean;
};
export type ArchiveCloneBatchReport = {
  total: number; ready: number; held: number; rows: ArchiveCloneBatchRow[];
};

/** Bounded read-only preflight. Duplicate pairs and video are held before I/O. */
export class ArchiveCloneBatchInspector {
  constructor(private readonly coordinator: ArchiveCloneCoordinator) {}
  async inspect(jobs: ArchiveCloneBatchJob[], concurrency = 4): Promise<ArchiveCloneBatchReport> {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4)
      throw new Error('ARCHIVE_CLONE_BATCH_CONCURRENCY_INVALID');
    const identities = jobs.map((job) => `${job.manifest.archiveId}:${job.sourceItemId}:${job.scope.shopId}`);
    if (new Set(identities).size !== jobs.length)
      throw new Error('ARCHIVE_CLONE_BATCH_DUPLICATE_TARGET');
    if (jobs.some((job) => job.manifest.items.find((item) =>
      item.sourceItemId === job.sourceItemId)?.media.some((asset) => asset.role === 'video')))
      throw new Error('ARCHIVE_CLONE_BATCH_VIDEO_REQUIRES_SEPARATE_LANE');
    const rows = new Array<ArchiveCloneBatchRow>(jobs.length);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const index = next++;
        const job = jobs[index]!;
        const result = await this.coordinator.executeOne({ ...job, mode: 'inspect' });
        rows[index] = { sourceItemId: job.sourceItemId, targetShopId: job.scope.shopId, result };
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
    return { total: rows.length, ready: rows.filter((row) => row.result.kind === 'ready').length,
      held: rows.filter((row) => row.result.kind === 'held').length, rows };
  }
}

export type ArchiveCloneMediaJob = {
  approval: ApprovedCloneMediaPreflight;
  cloneScope: ProductionPilotCloneScope;
  credentials: ShopCredentials;
  assets: { role: 'cover' | 'gallery' | 'description' | `variation-${number}`;
    ordinal: number; sha256: string; blobPath: string }[];
};
export type ArchiveCloneBatchCandidate = {
  manifest: ArchiveCloneBatchJob['manifest']; sourceItemId: string; targetShopId: string; targetPartnerId: string;
};
export type ArchiveCloneBatchCheckpoint = {
  sourceItemId: string; targetShopId: string;
  phase: 'preflight' | 'media' | 'inspect' | 'execute';
  kind: 'ready' | 'held' | 'verified'; detail?: string;
};
export type ArchiveCloneBatchRunnerDependencies = {
  pool: Pool;
  coordinator: ArchiveCloneCoordinator;
  mediaJournal: ShopListingMediaTransferJournal;
  /** Must read current source, full target inventory, metadata and connection. */
  prepare: (candidate: ArchiveCloneBatchCandidate) => Promise<
    { kind: 'ready'; media: ArchiveCloneMediaJob } |
    { kind: 'held'; reasons: string[]; classification?: 'source' | 'systemic' }>;
  /** Build exact choices/context from persisted media ACK receipts. */
  buildInput: (candidate: ArchiveCloneBatchCandidate,
    uploads: { role: string; ordinal: number; sha256: string; imageId: string; transferId: string }[])
    => Promise<ArchiveCloneBatchJob>;
  checkpoint: (row: ArchiveCloneBatchCheckpoint) => Promise<void>;
  /** Test seam; the default uses journaled Shopee image upload. */
  uploadImage?: typeof uploadApprovedArchiveImage;
  /** Optional read-only, append-only QC recheck after a proven propagation mismatch. */
  qcRechecker?: Pick<ArchiveCloneQcRechecker, 'recheckOne'>;
};

/** Serial writer. Each pair has fresh preflight, media receipt, inspect, journal,
 * and independent two-GET QC. A held pair stops the run without replay. */
export class ArchiveCloneBatchRunner {
  constructor(private readonly deps: ArchiveCloneBatchRunnerDependencies) {}

  private async pilotVerified(pilot: { intentId: string; targetItemId: string;
    archiveId: string; sourceItemId: string; targetShopId: string; targetPartnerId: string }) {
    const row = (await this.deps.pool.query(`SELECT i.state,i.target_item_id,i.archive_id,i.source_item_id,i.target_shop_id,i.target_partner_id,
      q.result AS initial_result,
      (SELECT r.result FROM shop_listing_clone_qc_rechecks r WHERE r.intent_id=i.id
        ORDER BY r.attempt_no DESC LIMIT 1) AS latest_recheck
      FROM shop_listing_clone_intents i
      LEFT JOIN shop_listing_clone_qc q ON q.intent_id=i.id
      WHERE i.id=$1`, [pilot.intentId])).rows[0];
    return row?.state === 'verified' && row.target_item_id === pilot.targetItemId &&
      row.archive_id === pilot.archiveId && row.source_item_id === pilot.sourceItemId &&
      row.target_shop_id === pilot.targetShopId && row.target_partner_id === pilot.targetPartnerId &&
      (row.initial_result === 'verified' || row.latest_recheck === 'verified');
  }

  async run(candidates: ArchiveCloneBatchCandidate[], pilot: {
    intentId: string; targetItemId: string; archiveId: string;
    sourceItemId: string; targetShopId: string; targetPartnerId: string;
  }, maxItems = 1, reviewedHeldIntentIds: readonly string[] = []): Promise<ArchiveCloneBatchRow[]> {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 32)
      throw new Error('ARCHIVE_CLONE_BATCH_LIMIT_INVALID');
    const selected = candidates.slice(0, maxItems);
    const identities = selected.map((job) => `${job.manifest.archiveId}:${job.sourceItemId}:${job.targetPartnerId}:${job.targetShopId}`);
    if (new Set(identities).size !== selected.length)
      throw new Error('ARCHIVE_CLONE_BATCH_DUPLICATE_TARGET');
    if (selected.some(candidate => candidate.targetShopId !== pilot.targetShopId ||
        candidate.targetPartnerId !== pilot.targetPartnerId ||
        candidate.manifest.archiveId !== pilot.archiveId))
      throw new Error('ARCHIVE_CLONE_BATCH_PILOT_SCOPE_MISMATCH');
    if (!await this.pilotVerified(pilot))
      throw new Error('ARCHIVE_CLONE_BATCH_PILOT_NOT_VERIFIED');
    const rows: ArchiveCloneBatchRow[] = [];
    for (const candidate of selected) {
      const existing = (await this.deps.pool.query(
        'SELECT id,state,target_item_id FROM shop_listing_clone_intents ' +
        'WHERE archive_id=$1 AND source_item_id=$2 AND target_partner_id=$3 AND target_shop_id=$4',
        [candidate.manifest.archiveId,candidate.sourceItemId,candidate.targetPartnerId,candidate.targetShopId])).rows[0];
      if (existing) {
        const result: CloneCoordinatorResult = existing.state === 'verified' && existing.target_item_id
          ? { kind: 'verified', targetItemId: existing.target_item_id, intentId: existing.id }
          : { kind: 'held', reasons: ['INTENT_ALREADY_' + String(existing.state)],
              ...(existing.target_item_id ? { targetItemId: existing.target_item_id } : {}) };
        await this.deps.checkpoint({ sourceItemId: candidate.sourceItemId,
          targetShopId: candidate.targetShopId, phase: 'preflight',
          kind: result.kind === 'verified' ? 'verified' : 'held',
          detail: 'EXISTING_INTENT_' + String(existing.state) });
        rows.push({ sourceItemId: candidate.sourceItemId, targetShopId: candidate.targetShopId,
          result, skippedExisting: true });
        if (existing.state !== 'verified' &&
            !(existing.state === 'held' && reviewedHeldIntentIds.includes(existing.id))) break;
        continue;
      }
      const source = candidate.manifest.items.find((item) => item.sourceItemId === candidate.sourceItemId);
      if (!source || candidate.manifest.sourceShopId === candidate.targetShopId ||
          source.media.some((media) => media.role === 'video'))
        throw new Error('ARCHIVE_CLONE_BATCH_SOURCE_OR_VIDEO_INVALID');
      let reviewed: Awaited<ReturnType<ArchiveCloneBatchRunnerDependencies['prepare']>>;
      try { reviewed = await this.deps.prepare(candidate); }
      catch {
        await this.deps.checkpoint({ sourceItemId: candidate.sourceItemId,
          targetShopId: candidate.targetShopId, phase: 'preflight', kind: 'held',
          detail: 'PREFLIGHT_EXCEPTION' });
        rows.push({ sourceItemId: candidate.sourceItemId, targetShopId: candidate.targetShopId,
          result: { kind: 'held', reasons: ['PREFLIGHT_EXCEPTION'] } });
        break;
      }
      if (reviewed.kind === 'held') {
        await this.deps.checkpoint({ sourceItemId: candidate.sourceItemId,
          targetShopId: candidate.targetShopId, phase: 'preflight', kind: 'held',
          detail: reviewed.reasons.join(',') });
        rows.push({ sourceItemId: candidate.sourceItemId, targetShopId: candidate.targetShopId,
          result: { kind: 'held', reasons: reviewed.reasons } });
        if (reviewed.classification === 'source') continue;
        break;
      }
      const { approval, cloneScope, credentials, assets } = reviewed.media;
      const sourceImages = source.media.filter((asset) =>
        ['cover', 'gallery', 'description', 'variation-0'].includes(asset.role));
      const key = (role: string, ordinal: number, sha: string) => `${role}:${ordinal}:${sha}`;
      const expected = new Set(sourceImages.map((asset) => key(asset.role, asset.ordinal, asset.sha256)));
      const supplied = new Set(assets.map((asset) => key(asset.role, asset.ordinal, asset.sha256)));
      if (approval.archiveId !== candidate.manifest.archiveId ||
          approval.sourceShopId !== candidate.manifest.sourceShopId ||
          approval.sourceItemId !== candidate.sourceItemId ||
          approval.sourceObservationHash !== source.observationHash ||
          approval.targetShopId !== candidate.targetShopId ||
          approval.targetPartnerId !== candidate.targetPartnerId ||
          cloneScope.targetShopId !== candidate.targetShopId ||
          credentials.shopId !== candidate.targetShopId || credentials.partnerId !== candidate.targetPartnerId ||
          assets.length !== expected.size || supplied.size !== expected.size ||
          [...expected].some((identity) => !supplied.has(identity)))
        throw new Error('ARCHIVE_CLONE_BATCH_MEDIA_SCOPE_MISMATCH');
      await this.deps.checkpoint({ sourceItemId: candidate.sourceItemId,
        targetShopId: candidate.targetShopId, phase: 'preflight', kind: 'ready' });
      const uploads: { role: string; ordinal: number; sha256: string; imageId: string; transferId: string }[] = [];
      let blocked: string | undefined;
      const uploader = this.deps.uploadImage ?? uploadApprovedArchiveImage;
      // Bounded to three same-item image requests; every promise settles before create.
      // If one outcome is unknown, journal receipts for its peers remain reusable.
      for (let offset = 0; offset < assets.length; offset += 3) {
        const chunk = assets.slice(offset, offset + 3);
        const outcomes = await Promise.allSettled(chunk.map(asset => uploader({
          pool: this.deps.pool, journal: this.deps.mediaJournal,
          cloneScope, approval, credentials, media: asset,
        })));
        for (let index = 0; index < outcomes.length; index++) {
          const outcome = outcomes[index]!;
          const asset = chunk[index]!;
          if (outcome.status === 'rejected') {
            blocked = 'MEDIA_TRANSFER_EXCEPTION_RECONCILE';
            continue;
          }
          if (outcome.value.kind === 'held') {
            blocked = outcome.value.reason;
            continue;
          }
          uploads.push({ role: asset.role, ordinal: asset.ordinal, sha256: asset.sha256,
            imageId: outcome.value.remoteMediaId, transferId: outcome.value.transferId });
        }
        if (blocked) break;
      }
      if (blocked) {
        await this.deps.checkpoint({ sourceItemId: candidate.sourceItemId,
          targetShopId: candidate.targetShopId, phase: 'media', kind: 'held', detail: blocked });
        rows.push({ sourceItemId: candidate.sourceItemId, targetShopId: candidate.targetShopId,
          result: { kind: 'held', reasons: [blocked] } });
        break;
      }
      await this.deps.checkpoint({ sourceItemId: candidate.sourceItemId,
        targetShopId: candidate.targetShopId, phase: 'media', kind: 'ready' });
      let input: ArchiveCloneBatchJob;
      try { input = await this.deps.buildInput(candidate, uploads); }
      catch {
        await this.deps.checkpoint({ sourceItemId: candidate.sourceItemId,
          targetShopId: candidate.targetShopId, phase: 'inspect', kind: 'held',
          detail: 'INPUT_BUILD_EXCEPTION' });
        rows.push({ sourceItemId: candidate.sourceItemId, targetShopId: candidate.targetShopId,
          result: { kind: 'held', reasons: ['INPUT_BUILD_EXCEPTION'] } });
        break;
      }
      if (input.manifest.archiveId !== candidate.manifest.archiveId ||
          input.sourceItemId !== candidate.sourceItemId ||
          input.scope.shopId !== candidate.targetShopId ||
          input.scope.partnerId !== candidate.targetPartnerId ||
          input.target.shopId !== candidate.targetShopId)
        throw new Error('ARCHIVE_CLONE_BATCH_INPUT_SCOPE_MISMATCH');
      let inspected: CloneCoordinatorResult;
      try { inspected = await this.deps.coordinator.executeOne({ ...input, mode: 'inspect' }); }
      catch { inspected = { kind: 'held', reasons: ['INSPECT_EXCEPTION'] }; }
      if (inspected.kind !== 'ready') {
        await this.deps.checkpoint({ sourceItemId: candidate.sourceItemId,
          targetShopId: candidate.targetShopId, phase: 'inspect', kind: 'held',
          detail: inspected.kind === 'held' ? inspected.reasons.join(',') : 'UNEXPECTED_RESULT' });
        rows.push({ sourceItemId: candidate.sourceItemId, targetShopId: candidate.targetShopId,
          result: inspected });
        break;
      }
      await this.deps.checkpoint({ sourceItemId: candidate.sourceItemId,
        targetShopId: candidate.targetShopId, phase: 'inspect', kind: 'ready' });
      let result: CloneCoordinatorResult;
      try { result = await this.deps.coordinator.executeOne({ ...input, mode: 'pilot',
        pilot: { sourceItemId: candidate.sourceItemId, targetShopId: candidate.targetShopId } }); }
      catch { result = { kind: 'held', reasons: ['EXECUTION_EXCEPTION_RECONCILE'] }; }
      if (result.kind === 'held' && result.reasons.length === 1 &&
          result.reasons[0] === 'QC_MISMATCH' && result.targetItemId &&
          this.deps.qcRechecker) {
        const targetItemId = result.targetItemId;
        const matches = (await this.deps.pool.query(
          'SELECT i.id,q.comparator_result FROM shop_listing_clone_intents i ' +
          'JOIN shop_listing_clone_qc q ON q.intent_id=i.id ' +
          'WHERE i.archive_id=$1 AND i.source_item_id=$2 AND i.target_partner_id=$3 ' +
          'AND i.target_shop_id=$4 AND i.target_item_id=$5 AND i.state=$6 AND q.result=$7',
          [candidate.manifest.archiveId,candidate.sourceItemId,candidate.targetPartnerId,
           candidate.targetShopId,targetItemId,'held','mismatch'])).rows;
        const paths = matches.length === 1 ? matches[0]?.comparator_result?.mismatchedPaths : null;
        const transient = Array.isArray(paths) && paths.length > 0 &&
          paths.every((path: unknown) => typeof path === 'string' &&
            (path === 'readbacks.itemStable' || path === 'readbacks.modelsStable' ||
             path === 'item.promotion_image.image_id_list' ||
             /^models\.[0-9]+\.(saleable_stock|seller_stock)$/.test(path)));
        if (transient) {
          for (const delayMs of [3000,7000]) {
            await new Promise<void>(resolve => setTimeout(resolve, delayMs));
            try {
              result = await this.deps.qcRechecker.recheckOne(
                { ...input, mode: 'pilot',
                  pilot: { sourceItemId: candidate.sourceItemId,
                    targetShopId: candidate.targetShopId } },
                matches[0].id, targetItemId);
            } catch {
              result = { kind: 'held', reasons: ['QC_RECHECK_EXCEPTION_RECONCILE'], targetItemId };
            }
            if (result.kind === 'verified' ||
                result.kind !== 'held' ||
                result.reasons.length !== 1 ||
                result.reasons[0] !== 'QC_MISMATCH') break;
          }
        }
      }
      await this.deps.checkpoint({ sourceItemId: candidate.sourceItemId,
        targetShopId: candidate.targetShopId, phase: 'execute',
        kind: result.kind === 'verified' ? 'verified' : 'held',
        ...(result.kind === 'held' ? { detail: result.reasons.join(',') } : {}) });
      rows.push({ sourceItemId: candidate.sourceItemId,
        targetShopId: candidate.targetShopId, result });
      if (result.kind !== 'verified') break;
    }
    return rows;
  }
}
