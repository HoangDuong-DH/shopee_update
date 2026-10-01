import { createHash } from 'node:crypto';
import { canonicalJson, type PreparedDocument } from '@shopee/domain';
import type { CloneIntent } from '../../domain/src/archive-clone.js';
import { planPreparedWireCreate, type PreparedWireContext, type PreparedWireIssue, type PreparedWireStep } from './prepared-wire.js';
import { productionPilotWriteFingerprint, type ProductionPilotTransportScope, type ProductionPilotCloneScope } from './production-pilot-transport.js';

export type ArchiveCloneWireScope = ProductionPilotTransportScope & {
  connectionId: string;
  connectionRevision: number;
};
export type ArchiveCloneVideoBinding = {
  targetShopId: string;
  connectionId: string;
  connectionRevision: number;
  sourceSha256: string;
  uploadId: string;
  status: 'SUCCEEDED';
  journalKey: string;
  receiptHash: string;
  videoInfo: { duration: number;
    video_url_list: { video_url: string; video_url_region?: string }[];
    thumbnail_url_list: { image_url: string; image_url_region?: string }[] };
};
export type ArchiveCloneWireInput = {
  intent: CloneIntent;
  document: PreparedDocument;
  context: PreparedWireContext;
  scope: ArchiveCloneWireScope;
  /** Capability must be separately confirmed for the target shop. */
  videoCreateFieldVerified?: boolean;
  /** Pinned Shopee add_item documentation authorizes only a single journaled pilot, not a batch. */
  videoCreateFieldDocumentedPilot?: boolean;
  videoBinding?: ArchiveCloneVideoBinding;
};
export type ArchiveCloneWirePlan =
  | { kind: 'blocked'; issues: PreparedWireIssue[] }
  | {
      kind: 'ready';
      scope: ArchiveCloneWireScope;
      cloneTransportScope: ProductionPilotCloneScope;
      sourceObservationHash: string;
      steps: (PreparedWireStep & { fingerprint: string; intentFingerprint: string })[];
      readbackObligations: string[];
    };

const issue = (code: string, field: string): PreparedWireIssue => ({
  code: 'ARCHIVE_CLONE_' + code, field,
});
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const validId = (v: unknown) =>
  typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v) && Number.isSafeInteger(Number(v));

/** Pure, target-scoped plan. Never sends a request or grants a mutation permit. */
export function planArchiveCloneWire(input: ArchiveCloneWireInput): ArchiveCloneWirePlan {
  const { intent, document, context, scope, videoBinding } = input;
  const issues: PreparedWireIssue[] = [];
  const check = (ok: unknown, code: string, field: string) => {
    if (!ok) issues.push(issue(code, field));
  };
  check(scope.environment === 'production' && validId(scope.partnerId) &&
    validId(scope.shopId) && scope.shopId === intent.targetShopId &&
    scope.connectionId === intent.targetConnectionId &&
    Number.isSafeInteger(scope.connectionRevision) && scope.connectionRevision > 0 &&
    scope.connectionRevision === intent.targetConnectionRevision,
    'TARGET_SCOPE_MISMATCH', 'scope');
  check(!!intent.archiveId && validId(intent.sourceShopId) && validId(intent.sourceItemId) &&
    /^[a-f0-9]{64}$/.test(intent.sourceObservationHash) &&
    intent.sourceFacts.observationHash === intent.sourceObservationHash &&
    String(intent.sourceFacts.rawItem.item_id) === intent.sourceItemId,
    'SOURCE_PROVENANCE_MISMATCH', 'intent');
  check(intent.publication === 'UNLIST' && document.publication === 'unlisted',
    'PUBLICATION_MISMATCH', 'publication');
  check(context.sourceContract !== undefined, 'SOURCE_CONTRACT_REQUIRED', 'context.sourceContract');
  const source = intent.sourceFacts.rawItem;
  check(source.item_name === document.title && source.item_sku === document.sourceKey,
    'SOURCE_ITEM_MISMATCH', 'document.title/sourceKey');
  check(source.condition === context.condition, 'CONDITION_MISMATCH', 'condition');
  check(same(source.pre_order, context.preOrder), 'PREORDER_MISMATCH', 'preOrder');
  check(source.brand?.original_brand_name === context.brandName,
    'BRAND_NAME_MISMATCH', 'brandName');
  check(same(intent.attributeList, context.attributeList),
    'ATTRIBUTE_DETAIL_MISMATCH', 'attributeList');
  check(context.descriptionMode !== 'plain_fallback',
    'DESCRIPTION_LOSS_FORBIDDEN', 'descriptionMode');
  check(!context.baseline, 'TARGET_BASELINE_FORBIDDEN', 'context.baseline');
  if (!document.tierNames.length && !document.sourceKey)
    issues.push(issue('UNTIERED_SKU_MISSING', 'document.sourceKey'));
  for (const model of document.models) {
    const gtin = intent.sourceFacts.modelProjection.find((m: CloneIntent['sourceFacts']['modelProjection'][number]) => m.modelSku === model.sku)?.gtinCode ??
      (!document.tierNames.length ? source.gtin_code : undefined);
    if (typeof gtin === 'string' && gtin.trim())
      check(context.gtinBySku?.[model.sku] === gtin, 'GTIN_MISMATCH', 'models.' + model.sku + '.gtin');
    else if (context.gtinBySku?.[model.sku])
      issues.push(issue('GTIN_NOT_IN_SOURCE', 'models.' + model.sku + '.gtin'));
  }

  const channels = intent.shippingSource;
  if (!Array.isArray(channels) || channels.length !== document.logistics.length)
    issues.push(issue('LOGISTICS_SOURCE_INVALID', 'shippingSource'));
  const sourceChannels: Record<string, unknown>[] = Array.isArray(channels) ? channels : [];
  for (const [index, row] of sourceChannels.entries()) {
    if (!object(row)) {
      issues.push(issue('LOGISTICS_SOURCE_INVALID', 'shippingSource.' + index));
      continue;
    }
    const choice = document.logistics[index];
    check(choice?.channelId === String(row.logistic_id) && choice.enabled === row.enabled &&
      typeof row.enabled === 'boolean' && typeof row.is_free === 'boolean' &&
      Number.isSafeInteger(row.size_id) && Number(row.size_id) >= 0,
      'LOGISTICS_SOURCE_MISMATCH', 'shippingSource.' + index);
    if (Object.hasOwn(row, 'shipping_fee'))
      check(typeof row.shipping_fee === 'number' && Number.isFinite(row.shipping_fee) &&
        row.shipping_fee >= 0, 'LOGISTICS_FEE_INVALID', 'shippingSource.' + index);
    for (const key of Object.keys(row))
      if (!['logistic_id', 'enabled', 'is_free', 'size_id', 'shipping_fee',
        'logistic_name', 'include_pickup'].includes(key))
        issues.push(issue('LOGISTICS_FIELD_UNMAPPED', 'shippingSource.' + index + '.' + key));
  }

  const sourceVideos = intent.sourceFacts.media.filter((media) => media.role === 'video');
  if (sourceVideos.length > 1) issues.push(issue('VIDEO_COUNT_UNSUPPORTED', 'media.video'));
  if (sourceVideos.length) {
    const sourceVideo = sourceVideos[0]!;
    check(input.videoCreateFieldVerified === true || input.videoCreateFieldDocumentedPilot === true,
      'VIDEO_CREATE_WIRE_UNVERIFIED', 'videoCreateFieldVerified');
    check(!!videoBinding && videoBinding.targetShopId === scope.shopId &&
      videoBinding.connectionId === scope.connectionId &&
      videoBinding.connectionRevision === scope.connectionRevision &&
      videoBinding.sourceSha256 === sourceVideo.sha256 &&
      videoBinding.status === 'SUCCEEDED' &&
      /^[A-Za-z0-9_-]{1,512}$/.test(videoBinding.uploadId) &&
      /^[a-f0-9]{64}$/.test(videoBinding.receiptHash) &&
      !!videoBinding.journalKey &&
      Number.isFinite(videoBinding.videoInfo?.duration) &&
      Array.isArray(videoBinding.videoInfo?.video_url_list) &&
      videoBinding.videoInfo.video_url_list.length > 0 &&
      videoBinding.videoInfo.video_url_list.every((entry) =>
        object(entry) && typeof entry.video_url === 'string' && entry.video_url.length > 0) &&
      Array.isArray(videoBinding.videoInfo?.thumbnail_url_list) &&
      videoBinding.videoInfo.thumbnail_url_list.length > 0 &&
      videoBinding.videoInfo.thumbnail_url_list.every((entry) =>
        object(entry) && typeof entry.image_url === 'string' && entry.image_url.length > 0),
      'VIDEO_RECEIPT_UNVERIFIED', 'videoBinding');
  } else if (videoBinding)
    issues.push(issue('VIDEO_NOT_IN_SOURCE', 'videoBinding'));

  const defaultOnly: Record<string, unknown> = {
    compatibility_info: {}, item_dangerous: 0, purchase_limit_info: { min_purchase_limit: 1 },
    size_chart: '', size_chart_id: 0, tag: { kit: false }, is_fulfillment_by_shopee: false,
  };
  const readbackObligations: string[] = sourceVideos.length ?
    ['video_info:target_uploaded_source_sha'] : [];
  for (const [field, expected] of Object.entries(defaultOnly)) {
    if (!Object.hasOwn(source, field)) continue;
    if (!same(source[field], expected)) issues.push(issue('SOURCE_FIELD_UNMAPPED', 'rawItem.' + field));
    else readbackObligations.push('rawItem.' + field);
  }
  if (source.has_promotion || intent.sourceFacts.promotionSnapshot)
    readbackObligations.push('promotion:source_campaign_not_recreated');
  if (sourceChannels.some((row) => object(row) && !Object.hasOwn(row, 'shipping_fee')))
    readbackObligations.push('shipping_fee:target_generated');
  for (const row of sourceChannels)
    if (object(row) && (Object.hasOwn(row, 'logistic_name') || Object.hasOwn(row, 'include_pickup')))
      readbackObligations.push('logistics_channel_metadata:' + String(row.logistic_id));
  if (issues.length) return { kind: 'blocked', issues };

  // The source parent SKU may intentionally be blank when sellable identity lives on models.
  // A surrogate exists only inside the legacy pure planner and never reaches add_item.
  const planningDocument = document.sourceKey ? document :
    { ...document, sourceKey: 'ARCHIVE-' + intent.sourceItemId };
  const planningContext: PreparedWireContext = {
    ...context,
    ...(source.image?.image_ratio === '3:4' && context.sourceContract ? {
      sourceContract: { ...context.sourceContract, galleryRatio: '3:4' as const },
    } : {}),
    baseline: { item: { logistic_info: sourceChannels }, models: { model: [], tier_variation: [] } } as unknown as PreparedWireContext['baseline'],
  };
  const planned = planPreparedWireCreate(planningDocument, planningContext);
  if (planned.kind === 'blocked') return planned;
  const steps = planned.steps.map((original, stepIndex) => {
    const payload = original.group === 'create'
      ? { ...original.payload, item_sku: document.sourceKey,
          ...(videoBinding ? { video_upload_id: [videoBinding.uploadId] } : {}) } : original.payload;
    const fingerprint = productionPilotWriteFingerprint(original.path, payload, {
      environment: scope.environment, partnerId: scope.partnerId, shopId: scope.shopId,
    });
    const intentFingerprint = createHash('sha256').update(canonicalJson({
      archiveId: intent.archiveId, sourceItemId: intent.sourceItemId,
      sourceObservationHash: intent.sourceObservationHash, scope, stepIndex, fingerprint,
    })).digest('hex');
    return { ...original, payload, fingerprint, intentFingerprint };
  });
  const created = steps[0]?.payload;
  const expectedShipping = sourceChannels.map((row) => ({
    logistic_id: row.logistic_id, enabled: row.enabled, is_free: row.is_free,
    size_id: row.size_id,
    ...(Object.hasOwn(row, 'shipping_fee') ? { shipping_fee: row.shipping_fee } : {}),
  }));
  if (!created || created.item_status !== 'UNLIST' ||
    created.item_sku !== document.sourceKey ||
    !same(created.logistic_info, expectedShipping))
    return { kind: 'blocked', issues: [issue('PAYLOAD_PARITY_FAILED', 'add_item')] };
  const cloneTransportScope: ProductionPilotCloneScope = {
    archiveId: intent.archiveId, sourceShopId: intent.sourceShopId,
    sourceItemId: intent.sourceItemId, sourceObservationHash: intent.sourceObservationHash,
    sourceHasVariations: document.tierNames.length > 0, targetShopId: scope.shopId,
    connectionId: scope.connectionId, connectionRevision: scope.connectionRevision,
  };
  return { kind: 'ready', scope, cloneTransportScope,
    sourceObservationHash: intent.sourceObservationHash,
    steps, readbackObligations: [...new Set(readbackObligations)] };
}
