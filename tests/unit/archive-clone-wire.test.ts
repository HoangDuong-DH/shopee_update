import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PreparedDocument } from '../../packages/domain/src/prepared-batch.js';
import type { CloneIntent } from '../../packages/domain/src/archive-clone.js';
import { planArchiveCloneWire } from '../../packages/shopee/src/archive-clone-wire.js';
import type { PreparedWireContext } from '../../packages/shopee/src/prepared-wire.js';

function fixture() {
  const cover = { importId: randomUUID(), sha256: 'a'.repeat(64), mime: 'image/png', width: 100, height: 100 };
  const gallery = { importId: randomUUID(), sha256: 'b'.repeat(64), mime: 'image/png', width: 300, height: 400 };
  const document: PreparedDocument = {
    sourceKey: '', title: 'Exact source listing',
    description: [{ type: 'text', text: 'Exact description' }],
    cover, gallery: [gallery],
    tierNames: ['Scent'],
    models: [{ sku: 'SKU-ONE', tierIndex: [0], optionLabels: ['Floral'],
      originalPrice: '123456', stock: 17 }],
    categoryId: '700', brandId: '9', attributes: { '10': ['20'] },
    logistics: [{ channelId: '55', enabled: true }],
    weightGrams: 100, publication: 'unlisted',
  };
  const logistics = [{ logistic_id: 55, enabled: true, is_free: false, size_id: 0,
    logistic_name: 'Source channel', include_pickup: false }];
  const rawItem = {
    item_id: 123, item_name: document.title, item_sku: '',
    condition: 'NEW', pre_order: { is_pre_order: false },
    brand: { original_brand_name: 'Source brand' },
    compatibility_info: {}, item_dangerous: 0, purchase_limit_info: { min_purchase_limit: 1 },
    size_chart: '', size_chart_id: 0, tag: { kit: false }, is_fulfillment_by_shopee: false,
  };
  const intent = {
    archiveId: 'archive', sourceShopId: '555', sourceItemId: '123',
    sourceObservationHash: 'f'.repeat(64), targetShopId: '777',
    targetConnectionId: 'connection', targetConnectionRevision: 3,
    publication: 'UNLIST', sourceFacts: {
      sourceItemId: '123', observationHash: 'f'.repeat(64), rawItem,
      modelProjection: [{ modelSku: 'SKU-ONE' }], media: [],
    },
    attributeList: [{ attribute_id: 10, attribute_value_list: [{ value_id: 20 }] }],
    shippingSource: logistics, videoSource: [],
  } as unknown as CloneIntent;
  const context: PreparedWireContext = {
    images: [
      { importId: cover.importId, sha256: cover.sha256, role: 'cover', imageId: 'cover-id' },
      { importId: gallery.importId, sha256: gallery.sha256, role: 'gallery', imageId: 'gallery-id' },
    ],
    sourceContract: {
      tierNames: ['Scent'], optionLabelsBySku: { 'SKU-ONE': ['Floral'] },
      originalPriceBySku: { 'SKU-ONE': '123456' },
      approvedMediaSha256: [cover.sha256, gallery.sha256],
      approvedMediaSequenceByRole: { cover: [cover.sha256], gallery: [gallery.sha256] },
    },
    brandName: 'Source brand', condition: 'NEW', preOrder: { is_pre_order: false },
    attributeList: intent.attributeList, stockLocationBySku: { 'SKU-ONE': null },
    capabilities: { gallery34: true, extendedDescription: true },
    channelInfoById: { '55': { fee_type: 'SIZE_INPUT', enabled: true, mask_channel_id: 0 } },
    limits: {
      price_limit: { min_limit: 1, max_limit: 999999 }, stock_limit: { min_limit: 0, max_limit: 999 },
      item_name_length_limit: { min_limit: 1, max_limit: 200 },
      item_image_count_limit: { min_limit: 1, max_limit: 9 },
      item_description_length_limit: { min_limit: 1, max_limit: 3000 },
      tier_variation_name_length_limit: { min_limit: 1, max_limit: 100 },
      tier_variation_option_length_limit: { min_limit: 1, max_limit: 100 },
      gtin_limit: { gtin_validation_rule: 'Optional' },
      size_chart_limit: { size_chart_mandatory: false },
    },
  };
  const scope = { environment: 'production' as const, partnerId: '2010476', shopId: '777',
    connectionId: 'connection', connectionRevision: 3 };
  return { intent, document, context, scope };
}
describe('archive clone wire planning', () => {
  it('keeps a blank source parent SKU and exact source logistics flags in a scoped dry-run', () => {
    const result = planArchiveCloneWire(fixture());
    expect(result.kind, result.kind === 'blocked' ? JSON.stringify(result.issues) : '').toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.steps[0]!.payload.item_sku).toBe('');
    expect(result.steps[0]!.payload.item_status).toBe('UNLIST');
    expect(result.steps[0]!.payload.logistic_info).toEqual([
      { logistic_id: 55, enabled: true, is_free: false, size_id: 0 },
    ]);
    expect(result.steps[1]!.payload.model[0].model_sku).toBe('SKU-ONE');
    expect(result.readbackObligations).toContain('shipping_fee:target_generated');
    expect(result.readbackObligations).toContain('rawItem.purchase_limit_info');
  });
  it('scopes fingerprints to the target shop and connection revision', () => {
    const a = fixture(), b = fixture();
    const first = planArchiveCloneWire(a);
    b.intent.targetShopId = '778'; b.scope.shopId = '778';
    const second = planArchiveCloneWire(b);
    expect(first.kind).toBe('ready'); expect(second.kind).toBe('ready');
    if (first.kind === 'ready' && second.kind === 'ready')
      expect(first.steps[0]!.fingerprint).not.toBe(second.steps[0]!.fingerprint);
    const revision = fixture();
    revision.intent.targetConnectionRevision = 4; revision.scope.connectionRevision = 4;
    const revised = planArchiveCloneWire(revision);
    expect(revised.kind).toBe('ready');
    if (first.kind === 'ready' && revised.kind === 'ready') {
      expect(revised.steps[0]!.fingerprint).toBe(first.steps[0]!.fingerprint);
      expect(revised.steps[0]!.intentFingerprint).not.toBe(first.steps[0]!.intentFingerprint);
    }
    b.scope.connectionRevision = 4;
    const mismatch = planArchiveCloneWire(b);
    expect(mismatch.kind).toBe('blocked');
    if (mismatch.kind === 'blocked')
      expect(mismatch.issues.map((x) => x.code)).toContain('ARCHIVE_CLONE_TARGET_SCOPE_MISMATCH');
  });
  it('accepts a source-verified one-pixel 3:4 resize and blank dimensions, never a square gallery', () => {
    const v = fixture();
    v.document.gallery[0]!.width = 1023;
    v.document.gallery[0]!.height = 1365;
    (v.intent.sourceFacts.rawItem as any).image = { image_ratio: '3:4' };
    v.context.channelInfoById!['55']!.item_max_dimension = {
      unit: 'UNKNOWN', height: 0, width: 0, length: 0, dimension_sum: 6000,
    };
    v.context.channelInfoById!['55']!.volume_limit = { max_volume: 6000 };
    const rounded = planArchiveCloneWire(v);
    expect(rounded.kind, rounded.kind === 'blocked' ? JSON.stringify(rounded.issues) : '').toBe('ready');
    for (const [width, height] of [[991, 1320], [839, 1120]]) {
      v.document.gallery[0]!.width = width; v.document.gallery[0]!.height = height;
      const slightlyRounded = planArchiveCloneWire(v);
      expect(slightlyRounded.kind, slightlyRounded.kind === 'blocked' ? JSON.stringify(slightlyRounded.issues) : '').toBe('ready');
    }
    v.document.gallery[0]!.height = 1365;
    v.document.gallery[0]!.width = 1365;
    const square = planArchiveCloneWire(v);
    expect(square.kind).toBe('blocked');
    if (square.kind === 'blocked')
      expect(square.issues.map((x) => x.code)).toContain('PREPARED_WIRE_MEDIA_RATIO');
    v.document.gallery[0]!.width = 1023;
    v.document.dimensionCm = { length: 10, width: 10, height: 10 };
    const positive = planArchiveCloneWire(v);
    expect(positive.kind).toBe('blocked');
    if (positive.kind === 'blocked')
      expect(positive.issues.map((x) => x.code)).toContain('PREPARED_WIRE_LOGISTICS_UNIT_UNVERIFIED');
  });
  it('preserves distinct custom attribute values with repeated value_id zero', () => {
    const v = fixture();
    v.document.attributes = { '10': ['0', '0'] };
    v.intent.attributeList = [{ attribute_id: 10, attribute_value_list: [
      { value_id: 0, original_value_name: 'Cotton' },
      { value_id: 0, original_value_name: 'Linen' },
    ] }];
    v.context.attributeList = v.intent.attributeList;
    const good = planArchiveCloneWire(v);
    expect(good.kind, good.kind === 'blocked' ? JSON.stringify(good.issues) : '').toBe('ready');
    if (good.kind === 'ready') expect(good.steps[0]!.payload.attribute_list)
      .toEqual(v.intent.attributeList);
    v.context.attributeList = [{ attribute_id: 10, attribute_value_list: [
      { value_id: 0, original_value_name: 'Cotton' },
      { value_id: 0, original_value_name: 'Cotton' },
    ] }];
    v.intent.attributeList = v.context.attributeList;
    const duplicate = planArchiveCloneWire(v);
    expect(duplicate.kind).toBe('blocked');
    if (duplicate.kind === 'blocked')
      expect(duplicate.issues.map((x) => x.code)).toContain('PREPARED_WIRE_ATTRIBUTE_INVALID');
    v.document.attributes = { '10': ['20', '20'] };
    const nonzero = planArchiveCloneWire(v);
    expect(nonzero.kind).toBe('blocked');
  });
  it('attaches one processed target video by source SHA and blocks a cross-shop receipt', () => {
    const v = fixture();
    const sourceSha256 = 'c'.repeat(64);
    v.intent.videoSource = [{ video_id: 'source-id' }];
    v.intent.sourceFacts.media.push({ role: 'video', sha256: sourceSha256 } as any);
    const binding = {
      targetShopId: v.scope.shopId, connectionId: v.scope.connectionId,
      connectionRevision: v.scope.connectionRevision, sourceSha256,
      uploadId: 'target-upload-id', status: 'SUCCEEDED' as const,
      journalKey: 'video-target-receipt', receiptHash: 'd'.repeat(64),
      videoInfo: { duration: 15, video_url_list: [{ video_url_region: 'VN', video_url: 'https://target.example/video' }],
        thumbnail_url_list: [{ image_url_region: 'VN', image_url: 'https://target.example/thumb' }] },
    };
    const missing = planArchiveCloneWire({ ...v, videoCreateFieldVerified: true });
    expect(missing.kind).toBe('blocked');
    if (missing.kind === 'blocked')
      expect(missing.issues.map((x) => x.code)).toContain('ARCHIVE_CLONE_VIDEO_RECEIPT_UNVERIFIED');
    const wrong = planArchiveCloneWire({ ...v, videoCreateFieldVerified: true,
      videoBinding: { ...binding, targetShopId: '999' } });
    expect(wrong.kind).toBe('blocked');
    const pilot = planArchiveCloneWire({ ...v, videoCreateFieldDocumentedPilot: true, videoBinding: binding });
    expect(pilot.kind).toBe('ready');
    if (pilot.kind === 'ready') expect(pilot.steps[0]!.payload.video_upload_id).toEqual(['target-upload-id']);
    const ready = planArchiveCloneWire({ ...v, videoCreateFieldVerified: true, videoBinding: binding });
    expect(ready.kind, ready.kind === 'blocked' ? JSON.stringify(ready.issues) : '').toBe('ready');
    if (ready.kind !== 'ready') return;
    expect(ready.steps[0]!.payload.video_upload_id).toEqual(['target-upload-id']);
    expect(ready.readbackObligations).toContain('video_info:target_uploaded_source_sha');
  });
  it('blocks source video, unverified fields and fabricated logistics', () => {
    const v = fixture();
    v.intent.videoSource = [{ video_id: 'source-id' }];
    v.intent.sourceFacts.media.push({ role: 'video' } as any);
    (v.intent.sourceFacts.rawItem as any).purchase_limit_info = { min_purchase_limit: 2 };
    (v.intent.shippingSource as any)[0].is_free = true;
    const result = planArchiveCloneWire(v);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      const codes = result.issues.map((x) => x.code);
      expect(codes).toContain('ARCHIVE_CLONE_VIDEO_CREATE_WIRE_UNVERIFIED');
      expect(codes).toContain('ARCHIVE_CLONE_SOURCE_FIELD_UNMAPPED');
    }
  });
});
