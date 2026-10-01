import { canonicalJson } from '@shopee/domain';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ShopCredentials } from '../../../packages/shopee/src/shop-info.js';
import type { ArchiveManifest, TargetChoices } from '../../../packages/domain/src/archive-clone.js';
import { convertArchiveClone } from '../../../packages/domain/src/archive-clone.js';
import { compareCurrentArchiveSource, type CurrentArchiveSource } from './archive-clone-current-source.js';
import {
  bindPreparedWireItem, inspectPreparedWireAcknowledgement, preparedWireMediaRequirements,
  type PreparedWireContext, type ResolvedPreparedImage,
} from '../../../packages/shopee/src/prepared-wire.js';
import {
  planArchiveCloneWire, type ArchiveCloneWireScope, type ArchiveCloneVideoBinding,
} from '../../../packages/shopee/src/archive-clone-wire.js';
import {
  ProductionPilotTransport, productionPilotWriteFingerprint,
  type ProductionPilotMutationIntent,
} from '../../../packages/shopee/src/production-pilot-transport.js';
import type { ShopListingCloneJournal } from './shop-listing-clone-journal.js';
import type { CloneQcInput } from '../../../packages/domain/src/archive-clone-qc.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const videoAddItemDocument = 'knowledge-base/shopee-open-platform/documents/api/en/v2.product.add_item.md';
const pinnedVideoAddItemSha256 = '2f66e33928a76f35bfdd71d9e16b95553da15c513794fe1c6f9b5933ab53e8d6';
export async function documentedVideoPilotAllowed(declaredSha256: string | undefined): Promise<boolean> {
  if (declaredSha256 !== pinnedVideoAddItemSha256) return false;
  try {
    const bytes = await readFile(resolve(process.cwd(), videoAddItemDocument));
    if (createHash('sha256').update(bytes).digest('hex') !== pinnedVideoAddItemSha256) return false;
    const document = bytes.toString('utf8');
    return document.includes('id: "api:v2.product.add_item:en"') &&
      document.includes('| video_upload_id | string[] | False |') &&
      document.includes('Only accept one video_upload_id.');
  } catch { return false; }
}
const fresh = (observedAt: string, now: number, maxAgeMs: number) => {
  const age = now - Date.parse(observedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const numericItem = (value: unknown): value is number | string =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export type CloneTargetInventory = {
  shopId: string; observedAt: string; complete: true;
  overlappingSkus: string[]; exactTitleItemIds: string[];
  requestIds: string[];
};
export type CloneTargetEvidence = {
  shopId: string; connectionRevision: number; observedAt: string;
  categoryVerified: boolean; brandVerified: boolean; attributesVerified: boolean;
  logisticsVerified: boolean; stockLocationVerified: boolean;
  /** Target-specific positive proof from a verified capability probe; absent blocks video. */
  videoCreateFieldEvidence?: { shopId: string; connectionRevision: number; observedAt: string;
    field: 'video_upload_id'; verified: true; requestIds: string[] };
  requestIds: string[];
};
export type CloneImageEvidence = {
  shopId: string; connectionRevision: number; observedAt: string;
  complete: boolean; images: ResolvedPreparedImage[];
  receiptIds: string[];
};
export type CloneConnection = {
  shopId: string; partnerId: string; connectionId: string; revision: number;
  state: 'connected' | 'disconnected'; expiresAt: string; credentials: ShopCredentials;
};
export type CloneCoordinatorDependencies = {
  journal: ShopListingCloneJournal;
  readCurrentSource: (shopId: string, itemId: string) => Promise<CurrentArchiveSource>;
  readTargetInventory: (shopId: string, skus: string[], title: string) => Promise<CloneTargetInventory>;
  readTargetEvidence: (shopId: string, categoryId: string) => Promise<CloneTargetEvidence>;
  readImageEvidence: (archiveId: string, sourceItemId: string,
    scope: ArchiveCloneWireScope) => Promise<CloneImageEvidence>;
  readConnection: (connectionId: string) => Promise<CloneConnection>;
  /** Must call readSucceededArchiveVideoReceipt against DB/CAS, not synthesize a binding. */
  readVideoReceipt?: (archiveId: string, sourceItemId: string, sourceSha256: string,
    scope: ArchiveCloneWireScope) => Promise<ArchiveCloneVideoBinding | undefined>;
  /** Must perform two independent raw GET sets and supply media/target mapping proofs. */
  readQcEvidence: (input: { itemId: string; scope: ArchiveCloneWireScope;
    sourceItemId: string; archiveId: string; media: CloneImageEvidence;
    videoBinding?: ArchiveCloneVideoBinding }) =>
    Promise<CloneQcInput>;
  makeTransport: (credentials: ShopCredentials,
    options: ConstructorParameters<typeof ProductionPilotTransport>[1]) => Pick<ProductionPilotTransport, 'write'>;
  now?: () => number;
};

export type CloneCoordinatorInput = {
  manifest: ArchiveManifest;
  sourceItemId: string;
  target: TargetChoices;
  scope: ArchiveCloneWireScope;
  policyHash: string;
  /** Exact seller_knowledge_observations ID backing this archived source item. */
  sourceEvidenceId: string;
  /** A write is possible only for this exact one-item, one-shop pilot. */
  mode: 'inspect' | 'pilot';
  pilot?: { sourceItemId: string; targetShopId: string;
    /** Explicit one-pair video pilot opt-in; pinned documentation, not a verified shop capability. */
    videoAddItemDocumentSha256?: string };
  context: Omit<PreparedWireContext, 'images'>;
};
export type CloneCoordinatorResult =
  | { kind: 'held'; reasons: string[]; targetItemId?: string }
  | { kind: 'ready'; plannedStepCount: number; scope: ArchiveCloneWireScope }
  | { kind: 'verified'; targetItemId: string; intentId: string };

const held = (...reasons: string[]): CloneCoordinatorResult => ({ kind: 'held', reasons });

/** One-item coordinator. No route or scheduler invokes it; a caller must explicitly choose
 * pilot mode and supply fresh readers, persisted media receipts and a durable journal. */
export class ArchiveCloneCoordinator {
  constructor(private readonly deps: CloneCoordinatorDependencies) {}
  async executeOne(input: CloneCoordinatorInput): Promise<CloneCoordinatorResult> {
    let now = this.deps.now?.() ?? Date.now();
    if (!/^[a-f0-9]{64}$/.test(input.policyHash)) return held('POLICY_HASH_MISSING');
    if (input.mode === 'pilot' && (!input.pilot ||
      input.pilot.sourceItemId !== input.sourceItemId ||
      input.pilot.targetShopId !== input.scope.shopId))
      return held('PILOT_SCOPE_REQUIRED');
    if (input.scope.shopId !== input.target.shopId ||
      input.scope.connectionId !== input.target.connectionId ||
      input.scope.connectionRevision !== input.target.connectionRevision)
      return held('TARGET_SCOPE_MISMATCH');
    const item = input.manifest.items.find((row) => row.sourceItemId === input.sourceItemId);
    if (!item) return held('SOURCE_ITEM_MISSING');
    const conversion = convertArchiveClone(input.manifest, input.sourceItemId, input.target);
    if (conversion.kind === 'blocked')
      return held(...conversion.issues.map((problem) => problem.code + ':' + problem.field));
const sourceVideo = item.media.filter((asset) => asset.role === 'video');
    if (sourceVideo.length > 1) return held('SOURCE_VIDEO_COUNT_UNSUPPORTED');
    const [source, inventory, metadata, media, connection, videoBinding] = await Promise.all([
      this.deps.readCurrentSource(input.manifest.sourceShopId, item.sourceItemId),
      this.deps.readTargetInventory(input.scope.shopId,
        conversion.document.models.map((model) => model.sku), conversion.document.title),
      this.deps.readTargetEvidence(input.scope.shopId, conversion.document.categoryId),
      this.deps.readImageEvidence(input.manifest.archiveId, item.sourceItemId, input.scope),
      this.deps.readConnection(input.scope.connectionId),
      sourceVideo.length ? this.deps.readVideoReceipt?.(
        input.manifest.archiveId, item.sourceItemId, sourceVideo[0]!.sha256, input.scope) : undefined,
    ]);
    now = this.deps.now?.() ?? Date.now();
    const reasons: string[] = [];
    if (!fresh(source.observedAt, now, 15 * 60_000))
      reasons.push('SOURCE_READ_STALE');
    const current = compareCurrentArchiveSource(item, source, input.manifest.sourceShopId);
    if (!current.equal) reasons.push(...current.changedPaths.map((path) => 'SOURCE_CHANGED:' + path));
    if (inventory.shopId !== input.scope.shopId || inventory.complete !== true ||
      !fresh(inventory.observedAt, now, 5 * 60_000) || inventory.requestIds.length < 1)
      reasons.push('TARGET_INVENTORY_UNVERIFIED');
    if (inventory.overlappingSkus.length || inventory.exactTitleItemIds.length)
      reasons.push('TARGET_DUPLICATE');
    if (metadata.shopId !== input.scope.shopId ||
      metadata.connectionRevision !== input.scope.connectionRevision ||
      !fresh(metadata.observedAt, now, 15 * 60_000) || metadata.requestIds.length < 1 ||
      !metadata.categoryVerified || !metadata.brandVerified || !metadata.attributesVerified ||
      !metadata.logisticsVerified || !metadata.stockLocationVerified)
      reasons.push('TARGET_METADATA_UNVERIFIED');
    if (connection.shopId !== input.scope.shopId ||
      connection.partnerId !== input.scope.partnerId ||
      connection.connectionId !== input.scope.connectionId ||
      connection.revision !== input.scope.connectionRevision ||
      connection.state !== 'connected' ||
      (!Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= now + 60_000) ||
      connection.credentials.shopId !== input.scope.shopId ||
      connection.credentials.partnerId !== input.scope.partnerId)
      reasons.push('TARGET_CONNECTION_UNAVAILABLE');
    const requirements = preparedWireMediaRequirements(conversion.document);
    if (media.shopId !== input.scope.shopId ||
      media.connectionRevision !== input.scope.connectionRevision ||
      !fresh(media.observedAt, now, 15 * 60_000) || media.complete !== true ||
      media.receiptIds.length < requirements.length ||
      requirements.some(({ media: sourceAsset, role }) =>
        media.images.filter((image) => image.importId === sourceAsset.importId &&
          image.sha256 === sourceAsset.sha256 && image.role === role).length !== 1))
      reasons.push('TARGET_MEDIA_RECEIPT_UNVERIFIED');
    const videoCapability = metadata.videoCreateFieldEvidence;
    const videoCapabilityVerified = !!videoCapability &&
      videoCapability.shopId === input.scope.shopId &&
      videoCapability.connectionRevision === input.scope.connectionRevision &&
      videoCapability.field === 'video_upload_id' && videoCapability.verified === true &&
      fresh(videoCapability.observedAt, now, 15 * 60_000) &&
      videoCapability.requestIds.length > 0;
    const videoPilotDocumented = sourceVideo.length > 0 && input.mode === 'pilot' &&
      !!input.pilot && await documentedVideoPilotAllowed(input.pilot.videoAddItemDocumentSha256);
    if (sourceVideo.length && (!(videoCapabilityVerified || videoPilotDocumented) || !videoBinding ||
      videoBinding.sourceSha256 !== sourceVideo[0]!.sha256 ||
      videoBinding.targetShopId !== input.scope.shopId ||
      videoBinding.connectionId !== input.scope.connectionId ||
      videoBinding.connectionRevision !== input.scope.connectionRevision))
      reasons.push('TARGET_VIDEO_RECEIPT_OR_CAPABILITY_UNVERIFIED');
    if (reasons.length) return held(...reasons);

    const plan = planArchiveCloneWire({
      intent: conversion.intent, document: conversion.document,
      context: { ...input.context, images: media.images }, scope: input.scope,
      videoCreateFieldVerified: videoCapabilityVerified,
      videoCreateFieldDocumentedPilot: videoPilotDocumented, videoBinding,
    });
    if (plan.kind === 'blocked')
      return held(...plan.issues.map((problem) => problem.code + ':' + problem.field));
    if (input.mode === 'inspect')
      return { kind: 'ready', plannedStepCount: plan.steps.length, scope: plan.scope };

    const evidenceId = input.sourceEvidenceId;
    if (!evidenceId) return held('SOURCE_EVIDENCE_ID_MISSING');
    const intentRow = await this.deps.journal.reserve({
      archiveId: input.manifest.archiveId, sourceItemId: item.sourceItemId,
      sourceEvidenceId: evidenceId, sourceHash: item.observationHash,
      policyHash: input.policyHash, plannedPayloadHash: plan.steps[0]!.fingerprint,
      targetConnectionId: input.scope.connectionId,
      targetConnectionRevision: input.scope.connectionRevision,
      targetPartnerId: input.scope.partnerId, targetShopId: input.scope.shopId,
    });
    const previous = await this.deps.journal.get(intentRow.id);
    if (intentRow.state !== 'reserved' || previous?.steps?.length)
      return held('INTENT_ALREADY_STARTED');
    let targetItemId: string | undefined;
    let createAcknowledgedAt: number | undefined;
    for (const [index, original] of plan.steps.entries()) {
      const step = index === 0 ? original : bindPreparedWireItem(original, targetItemId!);
      if (index > 0 && createAcknowledgedAt !== undefined &&
          Number.isSafeInteger(step.minDelayAfterCreateMs) && step.minDelayAfterCreateMs! > 0) {
        const remaining = createAcknowledgedAt + step.minDelayAfterCreateMs! - Date.now();
        if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      }
      const fingerprint = index === 0 ? original.fingerprint :
        productionPilotWriteFingerprint(step.path, step.payload, {
          environment: input.scope.environment, partnerId: input.scope.partnerId,
          shopId: input.scope.shopId,
        });
      const connectionNow = await this.deps.readConnection(input.scope.connectionId);
      if (connectionNow.revision !== input.scope.connectionRevision ||
        connectionNow.state !== 'connected' || connectionNow.shopId !== input.scope.shopId)
        return held('TARGET_CONNECTION_CHANGED');
      const kind = index === 0 ? 'create' : 'init_variation';
      const row = await this.deps.journal.authorizeStep(intentRow.id, {
        stepKey: kind, ordinal: index + 1, kind, requestHash: fingerprint,
      });
      const transport = this.deps.makeTransport(connectionNow.credentials, {
        cloneScope: plan.cloneTransportScope,
        authorizeMutation: async (permit: Readonly<ProductionPilotMutationIntent>) => {
          if (permit.operationId !== intentRow.id || permit.stepId !== row.id ||
            permit.path !== step.path || permit.fingerprint !== fingerprint ||
            !same(permit.cloneScope, plan.cloneTransportScope)) return false;
          await this.deps.journal.markSent(row.id);
          return true;
        },
      });
      const response = await transport.write(step.path, step.payload,
        { operationId: intentRow.id, stepId: row.id });
      const ack = response.kind === 'success'
        ? inspectPreparedWireAcknowledgement(step, response.envelope)
        : { kind: response.kind, createdItemId: undefined };
      const outcome = response.kind === 'success' ? ack.kind : response.kind;
      const receipt = { kind: response.kind, requestId: response.requestId ?? null,
        code: response.kind === 'success' ? null : response.code ?? null,
        envelope: response.envelope ?? null };
      if (outcome !== 'acknowledged') {
        await this.deps.journal.recordOutcome(row.id,
          outcome === 'rejected' ? 'rejected' : 'unknown', receipt);
        return held(outcome === 'rejected' ? 'SHOPEE_REJECTED' : 'SHOPEE_OUTCOME_UNKNOWN');
      }
      if (kind === 'create') {
        const id = ack.createdItemId;
        if (!numericItem(id)) {
          await this.deps.journal.recordOutcome(row.id, 'unknown', receipt);
          return held('CREATE_ITEM_ID_UNVERIFIED');
        }
        targetItemId = String(id);
        createAcknowledgedAt = Date.now();
      }
      await this.deps.journal.recordOutcome(row.id, 'acknowledged', receipt,
        kind === 'create' ? targetItemId : undefined);
    }
    if (!targetItemId) return held('TARGET_ITEM_ID_MISSING');
    const qc = await this.deps.readQcEvidence({
      itemId: targetItemId, scope: input.scope, sourceItemId: item.sourceItemId,
      archiveId: input.manifest.archiveId, media, videoBinding,
    });
    if (qc.manifest.archiveId !== input.manifest.archiveId ||
      qc.sourceItemId !== item.sourceItemId ||
      qc.sourceObservationHash !== item.observationHash ||
      qc.targetShopId !== input.scope.shopId ||
      qc.readbacks.some((readback) => readback.shopId !== input.scope.shopId ||
        String(readback.item.item_id) !== targetItemId ||
        !fresh(readback.observedAt, Date.now(), 5 * 60_000)))
      return { kind: 'held', reasons: ['QC_EVIDENCE_INVALID'], targetItemId };
    const result = await this.deps.journal.recordQc(intentRow.id,
      { targetItemId, evidence: qc });
    if (result.result !== 'verified')
      return { kind: 'held', reasons: ['QC_MISMATCH'], targetItemId };
    return { kind: 'verified', targetItemId, intentId: intentRow.id };
  }
}
