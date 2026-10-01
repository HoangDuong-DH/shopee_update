import type { PreparedDocument, PreparedMedia, PreparedModel, PreparedDescription } from './prepared-batch.js';

export type ArchiveManifest = { archiveId: string; sourceShopId: string; items: ArchiveItem[] };
export type ArchiveMedia = { role: string; ordinal: number; sha256: string; sourceMediaId?: string | null; sourceUrl?: string; mime: string };
export type ArchiveItem = {
  sourceItemId: string; observationHash: string; observedAt: string; title: string; sourceItemSku: string;
  categoryId: number; brandId: number;
  tierProjection: { tierIndex: number; name: string; options: { optionIndex: number; label: string }[] }[];
  modelProjection: { sourceModelId: string; modelSku: string; tierIndex: number[]; selections: string[];
    priceInfo: { original_price: number; current_price: number; currency: string }[];
    stockInfoV2: StockSnapshot; weight: string | number; dimension: Dimension;
    gtinCode?: string; preOrder?: unknown; hasPromotion?: boolean; promotionId?: number }[];
  parentPriceInfo: { original_price: number; current_price: number; currency: string }[] | null;
  parentStockInfoV2: StockSnapshot | null; parentWeight: string | number; parentDimension: Dimension;
  descriptionBlocks: { blockIndex: number; field_type: 'text' | 'image'; text?: string; sha256?: string }[];
  media: ArchiveMedia[]; promotionSnapshot?: unknown; rawItem: Record<string, any>; rawModels: Record<string, any> | null;
};
export type StockSnapshot = { summary_info?: { total_available_stock: number }; seller_stock?: unknown[]; [key: string]: unknown };
export type Dimension = { package_length: number; package_width: number; package_height: number };
export type TargetChoices = {
  shopId: string; connectionId: string; connectionRevision: number;
  category?: { targetId: string; sourceCategoryId: number; verified: true };
  brand?: { targetId: string; sourceBrandId: number; verified: true };
  attributes?: { targetCategoryId: string; verified: true; values: Record<string, {
    value_id: number; original_value_name?: string; value_unit?: string }[]> };
  logistics?: { targetShopId: string; verified: true; sourceDetailsReviewed: true;
    channels: { channelId: string; enabled: boolean }[] };
  stock?: { targetShopId: string; verified: true; locationBySku: Record<string, string> };
  promotion?: { mode: 'original_price_without_campaign'; sourcePromotionReviewed: true };
  video?: { mode: 'preserve'; sourceVideoReviewed: true };
  dimensions?: { mode: 'omit_source_zero' | 'preserve_positive'; targetRuleVerified: true };
  media: { role: 'cover' | 'gallery' | 'description' | 'variation'; sourceSha256: string; prepared: PreparedMedia }[];
};
export type CloneIssue = { code: string; field: string };
export type CloneIntent = {
  key: string; archiveId: string; sourceShopId: string; sourceItemId: string;
  sourceObservationHash: string; sourceObservedAt: string; targetShopId: string;
  targetConnectionId: string; targetConnectionRevision: number; publication: 'UNLIST';
  sourceFacts: ArchiveItem;
  stockProvenance: { sku: string; quantity: number; observedAt: string; sourceStock: StockSnapshot; targetLocationId: string }[];
  attributeList: { attribute_id: number; attribute_value_list: {
    value_id: number; original_value_name?: string; value_unit?: string }[] }[];
  shippingSource: unknown; videoSource: unknown; promotionSource: unknown;
  fieldStatus: Record<string, 'prepared' | 'target_specific' | 'source_only' | 'requires_writer_mapping'>;
  writerRequirements: string[];
  promotionException: 'SOURCE_CAMPAIGN_NOT_RECREATED';
};
export type CloneConversion =
  | { kind: 'blocked'; issues: CloneIssue[] }
  | { kind: 'prepared'; intent: CloneIntent; document: PreparedDocument };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const numericId = (v: unknown) => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v);

/** Pure conversion. A prepared result is a source review artifact, never writer authorization. */
export function convertArchiveClone(manifest: ArchiveManifest, sourceItemId: string, target: TargetChoices): CloneConversion {
  const issues: CloneIssue[] = [];
  const check = (ok: unknown, code: string, field: string) => { if (!ok) issues.push({ code, field }); };
  const item = manifest.items.find((i) => i.sourceItemId === sourceItemId);
  if (!item) return { kind: 'blocked', issues: [{ code: 'SOURCE_ITEM_MISSING', field: 'sourceItemId' }] };
  check(!!manifest.archiveId && !!manifest.sourceShopId && !!item.observationHash && !!item.observedAt,
    'SOURCE_PROVENANCE_MISSING', 'manifest');
  check(!!target.shopId && !!target.connectionId && Number.isInteger(target.connectionRevision) && target.connectionRevision > 0,
    'TARGET_SCOPE_MISSING', 'target');
  check(target.category?.verified === true && target.category.sourceCategoryId === item.categoryId &&
    numericId(target.category.targetId), 'TARGET_CATEGORY_UNVERIFIED', 'category');
  check(target.brand?.verified === true && target.brand.sourceBrandId === item.brandId &&
    numericId(target.brand.targetId), 'TARGET_BRAND_UNVERIFIED', 'brand');
  check(target.logistics?.verified === true && target.logistics.targetShopId === target.shopId &&
    target.logistics.sourceDetailsReviewed === true, 'TARGET_LOGISTICS_UNVERIFIED', 'logistics');
  check(target.stock?.verified === true && target.stock.targetShopId === target.shopId,
    'TARGET_WAREHOUSE_UNVERIFIED', 'stock');
  check(target.promotion?.mode === 'original_price_without_campaign' &&
    target.promotion.sourcePromotionReviewed === true, 'PROMOTION_DECISION_MISSING', 'promotion');
  check(target.dimensions?.targetRuleVerified === true, 'DIMENSION_RULE_UNVERIFIED', 'dimensions');
  const videos = item.media.filter((m) => m.role === 'video');
  if (videos.length) check(target.video?.mode === 'preserve' && target.video.sourceVideoReviewed === true,
    'VIDEO_DECISION_MISSING', 'video');

  check(String(item.rawItem.item_id) === item.sourceItemId && item.rawItem.item_name === item.title &&
    item.rawItem.item_sku === item.sourceItemSku && item.rawItem.category_id === item.categoryId &&
    item.rawItem.brand?.brand_id === item.brandId,
    'SOURCE_RAW_ITEM_MISMATCH', 'rawItem');
  const rawModels = new Map((item.rawModels?.model ?? []).map((m: any) => [String(m.model_id), m]));
  check(rawModels.size === item.modelProjection.length, 'SOURCE_RAW_MODEL_COUNT_MISMATCH', 'rawModels');
  for (const model of item.modelProjection) {
    const raw = rawModels.get(model.sourceModelId) as any;
    check(!!raw && raw.model_sku === model.modelSku && same(raw.tier_index, model.tierIndex) &&
      same(raw.price_info, model.priceInfo) && same(raw.stock_info_v2, model.stockInfoV2),
      'SOURCE_RAW_MODEL_MISMATCH', `rawModels.${model.sourceModelId}`);
  }  const tiers = item.tierProjection;
  check(tiers.length <= 2 && tiers.every((tier, i) => tier.tierIndex === i &&
    tier.options.every((option, j) => option.optionIndex === j && !!option.label)),
    'SOURCE_TIER_INVALID', 'tierProjection');
  const rows = tiers.length ? item.modelProjection : [{
    sourceModelId: '', modelSku: item.sourceItemSku, tierIndex: [], selections: [],
    priceInfo: item.parentPriceInfo ?? [], stockInfoV2: item.parentStockInfoV2 as StockSnapshot,
    weight: item.parentWeight, dimension: item.parentDimension,
  }];
  check(tiers.length ? rows.length > 0 : item.modelProjection.length === 0,
    'SOURCE_MODEL_COUNT_INVALID', 'modelProjection');
  check(new Set(rows.map((r) => r.modelSku)).size === rows.length, 'SOURCE_SKU_DUPLICATE', 'modelProjection');
  const stockProvenance: CloneIntent['stockProvenance'] = [];
  const models: PreparedModel[] = rows.map((row, index) => {
    const field = `models.${index}`;
    check(typeof row.modelSku === 'string' && !!row.modelSku.trim(), 'SOURCE_SKU_MISSING', `${field}.sku`);
    check(row.tierIndex.length === tiers.length && row.selections.length === tiers.length &&
      row.tierIndex.every((optionIndex, tierIndex) => tiers[tierIndex]?.options[optionIndex]?.label === row.selections[tierIndex]),
      'SOURCE_MODEL_MAPPING_INVALID', `${field}.tierIndex`);
    const price = row.priceInfo?.[0];
    check(row.priceInfo?.length === 1 && price?.currency === 'VND' &&
      Number.isSafeInteger(price.original_price) && price.original_price > 0,
      'SOURCE_PRICE_INVALID', `${field}.priceInfo`);
    const quantity = row.stockInfoV2?.summary_info?.total_available_stock;
    check(Number.isSafeInteger(quantity) && quantity! >= 0, 'SOURCE_SALEABLE_STOCK_MISSING', `${field}.stockInfoV2`);
    const location = target.stock?.locationBySku?.[row.modelSku];
    check(typeof location === 'string' && !!location.trim(), 'TARGET_STOCK_LOCATION_MISSING', `${field}.location`);
    if (Number.isSafeInteger(quantity) && quantity! >= 0 && location) stockProvenance.push({
      sku: row.modelSku, quantity: quantity!, observedAt: item.observedAt,
      sourceStock: clone(row.stockInfoV2), targetLocationId: location,
    });
    const weight = Number(row.weight);
    check(Number.isFinite(weight) && weight > 0, 'SOURCE_WEIGHT_INVALID', `${field}.weight`);
    const dimension = row.dimension;
    const dims = [dimension?.package_length, dimension?.package_width, dimension?.package_height];
    check(dims.every((v) => Number.isFinite(v) && v! >= 0), 'SOURCE_DIMENSION_INVALID', `${field}.dimension`);
    const zero = dims.every((v) => v === 0);
    const positive = dims.every((v) => v! > 0);
    check(zero || positive, 'SOURCE_DIMENSION_PARTIAL', `${field}.dimension`);
    check(target.dimensions?.mode === (zero ? 'omit_source_zero' : 'preserve_positive'),
      'TARGET_DIMENSION_DECISION_MISMATCH', `${field}.dimension`);
    return {
      sku: row.modelSku, tierIndex: [...row.tierIndex], optionLabels: [...row.selections],
      originalPrice: String(price?.original_price ?? ''), stock: quantity ?? -1,
      ...(tiers.length && Number.isFinite(weight) ? { weightGrams: weight * 1000 } : {}),
      ...(tiers.length && positive ? { dimensionCm: {
        length: dimension.package_length, width: dimension.package_width, height: dimension.package_height,
      } } : {}),
    };
  });

  const sourceAttributes = (item.rawItem.attribute_list ?? []) as { attribute_id: number; attribute_value_list: {
    value_id: number; original_value_name?: string; value_unit?: string }[] }[];
  check(target.attributes?.verified === true && target.attributes.targetCategoryId === target.category?.targetId,
    'TARGET_ATTRIBUTES_UNVERIFIED', 'attributes');
  const attributes: Record<string, string[]> = {};
  const attributeList: CloneIntent['attributeList'] = [];
  for (const source of sourceAttributes) {
    const values = target.attributes?.values[String(source.attribute_id)];
    check(!!values && same(values, source.attribute_value_list),
      'TARGET_ATTRIBUTE_VALUE_MISMATCH', `attributes.${source.attribute_id}`);
    if (values) {
      attributes[String(source.attribute_id)] = values.map((v) => String(v.value_id));
      attributeList.push({ attribute_id: source.attribute_id, attribute_value_list: clone(values) });
    }
  }
  check(Object.keys(target.attributes?.values ?? {}).length === sourceAttributes.length,
    'TARGET_ATTRIBUTE_SET_MISMATCH', 'attributes');
  const sourceChannels = (item.rawItem.logistic_info ?? []) as { logistic_id: number; enabled: boolean }[];
  const channels = target.logistics?.channels ?? [];
  check(same(channels.map((c) => [c.channelId, c.enabled]).sort(),
    sourceChannels.map((c) => [String(c.logistic_id), c.enabled]).sort()),
    'TARGET_LOGISTICS_CHANNEL_MISMATCH', 'logistics.channels');

  const asset = (role: TargetChoices['media'][number]['role'], sha: string, field: string) => {
    const found = target.media.filter((m) => m.role === role && m.sourceSha256 === sha);
    check(found.length === 1 && found[0]?.prepared.sha256 === sha &&
      !!found[0]?.prepared.importId && found[0]?.prepared.width > 0 && found[0]?.prepared.height > 0,
      'MEDIA_ASSET_UNVERIFIED', field);
    return found[0]?.prepared;
  };
  const ordered = (role: string) => item.media.filter((m) => m.role === role).sort((a, b) => a.ordinal - b.ordinal);
  const covers = ordered('cover');
  check(covers.length === 1, 'SOURCE_COVER_INVALID', 'media.cover');
  check(same(covers.map((m) => m.sourceMediaId), item.rawItem.promotion_image?.image_id_list ?? []),
    'SOURCE_COVER_ROLE_MISMATCH', 'media.cover');
  check(same(ordered('gallery').map((m) => m.sourceMediaId), item.rawItem.image?.image_id_list ?? []),
    'SOURCE_GALLERY_ROLE_MISMATCH', 'media.gallery');  const cover = covers[0] && asset('cover', covers[0].sha256, 'media.cover');
  const gallery = ordered('gallery').map((m, i) => asset('gallery', m.sha256, `media.gallery.${i}`));
  const descMedia = ordered('description');
  const blocks = [...item.descriptionBlocks].sort((a, b) => a.blockIndex - b.blockIndex);
  check(blocks.every((b, i) => b.blockIndex === i), 'SOURCE_DESCRIPTION_SEQUENCE_INVALID', 'descriptionBlocks');
  const description: PreparedDescription[] = [];
  blocks.forEach((block, i) => {
    if (block.field_type === 'text') { description.push({ type: 'text', text: block.text ?? '' }); return; }
    const source = descMedia.find((m) => m.sha256 === block.sha256);
    check(!!source, 'SOURCE_DESCRIPTION_MEDIA_MISSING', `descriptionBlocks.${i}`);
    const image = source && asset('description', source.sha256, `descriptionBlocks.${i}`);
    if (image) description.push({ type: 'image', image });
  });
  check(description.filter((b) => b.type === 'image').length === descMedia.length,
    'SOURCE_DESCRIPTION_MEDIA_COUNT_MISMATCH', 'descriptionBlocks');
  const variation = ordered('variation-0');
  if (tiers.length) {
    check(same(variation.map((m) => m.sourceMediaId),
      (item.rawModels?.tier_variation?.[0]?.option_list ?? []).map((o: any) => o.image?.image_id).filter(Boolean)),
      'SOURCE_VARIATION_ROLE_MISMATCH', 'media.variation-0');
    check(variation.length === 0 || variation.length === tiers[0]!.options.length,
      'SOURCE_VARIATION_IMAGE_COUNT_MISMATCH', 'media.variation-0');
    for (const [index, source] of variation.entries()) {
      const image = asset('variation', source.sha256, `media.variation-0.${index}`);
      if (image) for (const model of models) if (model.tierIndex[0] === index) model.image = image;
    }
  } else check(variation.length === 0, 'SOURCE_UNTIERED_VARIATION_IMAGE', 'media.variation-0');
  check(target.media.length === covers.length + gallery.length + descMedia.length + variation.length,
    'TARGET_MEDIA_SET_MISMATCH', 'media');

  const weight = Number(item.parentWeight);
  check(Number.isFinite(weight) && weight > 0, 'SOURCE_PARENT_WEIGHT_INVALID', 'parentWeight');
  const dimension = item.parentDimension;
  const dims = [dimension?.package_length, dimension?.package_width, dimension?.package_height];
  check(dims.every((v) => Number.isFinite(v) && v! >= 0), 'SOURCE_PARENT_DIMENSION_INVALID', 'parentDimension');
  const zero = dims.every((v) => v === 0);
  check(zero || dims.every((v) => v! > 0), 'SOURCE_PARENT_DIMENSION_PARTIAL', 'parentDimension');
  check(target.dimensions?.mode === (zero ? 'omit_source_zero' : 'preserve_positive'),
    'TARGET_PARENT_DIMENSION_DECISION_MISMATCH', 'parentDimension');
  if (issues.length) return { kind: 'blocked', issues };
  const document: PreparedDocument = {
    sourceKey: item.sourceItemSku, title: item.title,
    description, cover: cover!, gallery: gallery as PreparedMedia[],
    tierNames: tiers.map((t) => t.name), models,
    categoryId: target.category!.targetId, brandId: target.brand!.targetId, attributes,
    logistics: clone(channels), weightGrams: weight * 1000,
    ...(zero ? {} : { dimensionCm: {
      length: dimension.package_length, width: dimension.package_width, height: dimension.package_height,
    } }), publication: 'unlisted',
  };
  return { kind: 'prepared', document, intent: {
    key: `${manifest.archiveId}:${sourceItemId}:${target.shopId}`,
    archiveId: manifest.archiveId, sourceShopId: manifest.sourceShopId,
    sourceItemId, sourceObservationHash: item.observationHash, sourceObservedAt: item.observedAt,
    targetShopId: target.shopId, targetConnectionId: target.connectionId,
    targetConnectionRevision: target.connectionRevision, publication: 'UNLIST',
    sourceFacts: clone(item), stockProvenance, attributeList,
    shippingSource: clone(item.rawItem.logistic_info ?? []),
    videoSource: clone(item.rawItem.video_info ?? []),
    promotionSource: clone(item.promotionSnapshot ?? null),
    fieldStatus: Object.fromEntries(Object.keys(item.rawItem).map((field) => [
      field,
      (['item_name', 'item_sku', 'description_info', 'description_type', 'image', 'promotion_image',
        'weight', 'item_status']
        .includes(field) ? 'prepared' :
        ['item_id', 'create_time', 'update_time', 'deboost', 'authorised_brand_id', 'has_promotion']
          .includes(field) ? 'source_only' :
        ['category_id', 'brand', 'logistic_info', 'size_chart_id', 'is_fulfillment_by_shopee'].includes(field) ? 'target_specific' :
        'requires_writer_mapping') as CloneIntent['fieldStatus'][string],
    ])),
    writerRequirements: ['target_media_upload', 'rich_description', 'shipping_detail_parity',
      ...(videos.length ? ['video_upload_and_readback'] : []),
      ...(item.sourceItemSku ? [] : ['blank_parent_sku_wire_support']), 'source_contract_and_full_readback'],
    promotionException: 'SOURCE_CAMPAIGN_NOT_RECREATED',
  } };
}







