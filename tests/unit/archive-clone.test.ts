import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { convertArchiveClone, type ArchiveItem, type TargetChoices } from '../../packages/domain/src/archive-clone.js';
import { syntheticArchiveManifest } from '../fixtures/archive-clone.js';

const manifest = syntheticArchiveManifest();

function choices(item: ArchiveItem): TargetChoices {
  const rows = item.tierProjection.length ? item.modelProjection : [{ modelSku: item.sourceItemSku }];
  const attributes = Object.fromEntries((item.rawItem.attribute_list ?? []).map((a: any) =>
    [String(a.attribute_id), a.attribute_value_list.map((v: any) => ({
      value_id: v.value_id, original_value_name: v.original_value_name, value_unit: v.value_unit,
    }))]));
  // Keep only properties present in the source, including custom original names.
  const values = Object.fromEntries((item.rawItem.attribute_list ?? []).map((a: any) =>
    [String(a.attribute_id), JSON.parse(JSON.stringify(a.attribute_value_list))]));
  const media = item.media.filter((m) => ['cover', 'gallery', 'description', 'variation-0'].includes(m.role))
    .map((m) => ({
      role: (m.role === 'variation-0' ? 'variation' : m.role) as 'cover' | 'gallery' | 'description' | 'variation',
      sourceSha256: m.sha256,
      prepared: {
        importId: randomUUID(), sha256: m.sha256, mime: m.mime,
        width: m.role === 'gallery' ? 300 : 400, height: 400,
      },
    }));
  return {
    shopId: '98765', connectionId: 'target-connection', connectionRevision: 1,
    category: { targetId: String(item.categoryId), sourceCategoryId: item.categoryId, verified: true },
    brand: { targetId: String(item.brandId), sourceBrandId: item.brandId, verified: true },
    attributes: { targetCategoryId: String(item.categoryId), verified: true, values },
    logistics: {
      targetShopId: '98765', verified: true, sourceDetailsReviewed: true,
      channels: item.rawItem.logistic_info.map((c: any) => ({
        channelId: String(c.logistic_id), enabled: c.enabled,
      })),
    },
    stock: { targetShopId: '98765', verified: true,
      locationBySku: Object.fromEntries(rows.map((r) => [r.modelSku, 'TARGET-WAREHOUSE'])) },
    promotion: { mode: 'original_price_without_campaign', sourcePromotionReviewed: true },
    video: { mode: 'preserve', sourceVideoReviewed: true },
    dimensions: { mode: item.parentDimension.package_length === 0 ? 'omit_source_zero' : 'preserve_positive', targetRuleVerified: true },
    media,
  };
}

describe('archive clone converter', () => {
  for (const tierCount of [0, 1, 2]) {
    it(`preserves a synthetic ${tierCount}-tier snapshot and source facts`, () => {
      const item = manifest.items.find((i) => i.tierProjection.length === tierCount)!;
      const result = convertArchiveClone(manifest, item.sourceItemId, choices(item));
      expect(result.kind, JSON.stringify(result.kind === 'blocked' ? result.issues : [])).toBe('prepared');
      if (result.kind !== 'prepared') return;
      expect(result.document.title).toBe(item.title);
      expect(result.document.tierNames).toEqual(item.tierProjection.map((t) => t.name));
      expect(result.document.models.map((m) => m.tierIndex)).toEqual(
        tierCount ? item.modelProjection.map((m) => m.tierIndex) : [[]]);
      expect(result.document.description.map((b) => b.type)).toEqual(
        item.descriptionBlocks.map((b) => b.field_type));
      expect(result.document.gallery.map((m) => m.sha256)).toEqual(
        item.media.filter((m) => m.role === 'gallery').sort((a, b) => a.ordinal - b.ordinal).map((m) => m.sha256));
      expect(result.intent.shippingSource).toEqual(item.rawItem.logistic_info);
      expect(result.intent.sourceFacts.rawItem).toEqual(item.rawItem);
      expect(result.intent.publication).toBe('UNLIST');
      expect(result.intent.stockProvenance.map((s) => s.quantity)).toEqual(
        tierCount ? item.modelProjection.map((m) => m.stockInfoV2.summary_info?.total_available_stock)
          : [item.parentStockInfoV2?.summary_info?.total_available_stock]);
      expect(result.intent.stockProvenance.every((s) => s.targetLocationId === 'TARGET-WAREHOUSE')).toBe(true);
      expect(result.document.models.map((m) => m.originalPrice)).toEqual(
        (tierCount ? item.modelProjection.map((m) => m.priceInfo) : [item.parentPriceInfo])
          .map((prices) => String(prices?.[0]?.original_price)));
      expect(result.intent.promotionException).toBe('SOURCE_CAMPAIGN_NOT_RECREATED');
      expect(result.document.sourceKey).toBe(item.sourceItemSku);
      expect(Object.keys(result.intent.fieldStatus).sort()).toEqual(Object.keys(item.rawItem).sort());
      if (item.parentDimension.package_length === 0) expect(result.document.dimensionCm).toBeUndefined();
      if (!item.sourceItemSku) expect(result.intent.writerRequirements).toContain('blank_parent_sku_wire_support');
      if (item.media.some((m) => m.role === 'video'))
        expect(result.intent.writerRequirements).toContain('video_upload_and_readback');
    });
  }

  it('prepares every archived item with explicit shop decisions', () => {
    for (const item of manifest.items) {
      const result = convertArchiveClone(manifest, item.sourceItemId, choices(item));
      expect(result.kind, item.sourceItemId + ':' + JSON.stringify(result.kind === 'blocked' ? result.issues : [])).toBe('prepared');
    }
  });
  it('fails closed on absent target decisions and missing image-role evidence', () => {
    const item = manifest.items[0]!;
    const target = choices(item);
    delete target.category;
    target.media = target.media.filter((m) => m.role !== 'description');
    const result = convertArchiveClone(manifest, item.sourceItemId, target);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.issues.map((i) => i.code)).toContain('TARGET_CATEGORY_UNVERIFIED');
      expect(result.issues.map((i) => i.code)).toContain('MEDIA_ASSET_UNVERIFIED');
    }
  });

  it('blocks a projection that no longer matches the raw Shopee response', () => {
    const item = structuredClone(manifest.items.find((i) => i.tierProjection.length === 2)!);
    item.modelProjection[0]!.modelSku = 'WRONG-SKU';
    const result = convertArchiveClone({ ...manifest, items: [item] }, item.sourceItemId, choices(item));
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.issues.map((i) => i.code)).toContain('SOURCE_RAW_MODEL_MISMATCH');
  });
  it('does not substitute seller stock or source warehouse for target saleable stock', () => {
    const item = manifest.items.find((i) =>
      i.modelProjection.some((m) => m.stockInfoV2.seller_stock?.some((s: any) =>
        s.stock !== m.stockInfoV2.summary_info?.total_available_stock)))!;
    const target = choices(item);
    const result = convertArchiveClone(manifest, item.sourceItemId, target);
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;
    expect(result.document.models[0]!.stock).toBe(
      item.modelProjection[0]!.stockInfoV2.summary_info!.total_available_stock);
    expect(result.intent.stockProvenance[0]!.targetLocationId).toBe('TARGET-WAREHOUSE');
    expect(result.intent.stockProvenance[0]!.sourceStock).toEqual(item.modelProjection[0]!.stockInfoV2);
  });
});


