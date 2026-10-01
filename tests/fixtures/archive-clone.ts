import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { ArchiveItem, ArchiveManifest, ArchiveMedia, Dimension, StockSnapshot } from '../../packages/domain/src/archive-clone.js';

/** Synthetic unit source, authored here. No shop export, supplied SKU, downloaded media,
 * production approval or private KB is read. Hashes bind actual generated fixture bytes. */
const observedAt = '2026-10-01T00:00:00Z';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Price = { original_price: number; current_price: number; currency: 'VND'; inflated_price_of_original_price: number; inflated_price_of_current_price: number };
type Stock = StockSnapshot & { summary_info: { total_available_stock: number; total_reserved_stock: number }; seller_stock: { stock: number; if_saleable: boolean; location_id: string }[] };
type Model = { model_id: number; model_sku: string; model_name: string; tier_index: number[]; price_info: Price[]; stock_info_v2: Stock;
  weight: string; dimension: Dimension; gtin_code: string; pre_order: { is_pre_order: boolean; days_to_ship: number }; model_status: 'NORMAL';
  has_promotion: boolean; promotion_id: number; is_fulfillment_by_shopee: boolean };
type Tier = { name: string; option_list: { option: string; image?: { image_id: string } }[] };
type Models = { model: Model[]; tier_variation: Tier[]; standardise_tier_variation: { variation_name: string; variation_option_list: { variation_option_name: string; image_id?: string }[] }[] };
type RawItem = {
  item_id: number; item_name: string; item_sku: string; item_status: 'NORMAL'; category_id: number; brand: { brand_id: number; original_brand_name: string };
  has_model: boolean; has_promotion: boolean; promotion_id?: number; create_time: number; update_time: number; deboost: boolean; authorised_brand_id: number;
  condition: 'NEW'; pre_order: { is_pre_order: boolean; days_to_ship: number }; gtin_code: string; tag: string[]; compatibility_info: unknown[];
  item_dangerous: number; purchase_limit_info: { purchase_limit: number }; size_chart_id: number; size_chart: string; is_fulfillment_by_shopee: boolean;
  weight: string; dimension: Dimension; price_info: Price[]; stock_info_v2: Stock;
  attribute_list: { attribute_id: number; attribute_value_list: { value_id: number; original_value_name: string; value_unit?: string }[] }[];
  logistic_info: { logistic_id: number; logistic_name: string; enabled: boolean; is_free: boolean; size_id: number; include_pickup: boolean; estimated_shipping_fee: number }[];
  promotion_image: { image_id_list: string[]; image_ratio: string }; image: { image_id_list: string[]; image_ratio: string };
  description_type: 'extended'; description_info: { extended_description: { field_list: ({ field_type: 'text'; text: string } | { field_type: 'image'; image_info: { image_id: string } })[] } };
  video_info: { video_url: string; thumbnail_url: string; duration: number } | never[];
};
export type SyntheticArchiveItem = Omit<ArchiveItem, 'rawItem' | 'rawModels'> & { rawItem: RawItem; rawModels: Models | null };
export type SyntheticArchiveManifest = Omit<ArchiveManifest, 'items'> & { items: SyntheticArchiveItem[] };

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, checksum]);
}
function png(rgb: number): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, (rgb >>> 16) & 255, (rgb >>> 8) & 255, rgb & 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const modelRows = {
  1: [{ sku: 'FIXTURE-ONE-A', tier: [0], price: 12000, stock: 10 }, { sku: 'FIXTURE-ONE-B', tier: [1], price: 15000, stock: 0 }],
  2: [{ sku: 'FIXTURE-TWO-A1', tier: [0, 0], price: 21000, stock: 7 }, { sku: 'FIXTURE-TWO-A2', tier: [0, 1], price: 22000, stock: 8 },
    { sku: 'FIXTURE-TWO-B1', tier: [1, 0], price: 23000, stock: 9 }, { sku: 'FIXTURE-TWO-B2', tier: [1, 1], price: 24000, stock: 10 }],
};
const price = (original: number, promotion: boolean): Price[] => [{ original_price: original, current_price: promotion ? original - 1000 : original,
  currency: 'VND', inflated_price_of_original_price: original, inflated_price_of_current_price: promotion ? original - 1000 : original }];
const stock = (available: number): Stock => ({ summary_info: { total_available_stock: available, total_reserved_stock: 2 },
  seller_stock: [{ stock: available + 3, if_saleable: true, location_id: 'FIXTURE-SOURCE-WAREHOUSE' }] });

export function syntheticArchiveItem(tiers: 0 | 1 | 2): SyntheticArchiveItem {
  const sourceItemId = String(7101 + tiers), parentSku = 'FIXTURE-PARENT-' + tiers, promotion = tiers === 0;
  const dimension = tiers === 1 ? { package_length: 10, package_width: 8, package_height: 12 } : { package_length: 0, package_width: 0, package_height: 0 };
  const media: ArchiveMedia[] = [];
  let color = 0x101010 + tiers * 0x200000;
  const mediaRow = (role: string, ordinal: number, mime = 'image/png') => {
    const sourceMediaId = `fixture-${sourceItemId}-${role}-${ordinal}`;
    // Image bytes are valid one-pixel PNGs; the video token is deliberately unit-only.
    const bytes = mime === 'image/png' ? png(color += 0x000f21) : Buffer.from('synthetic unit-only video token: ' + sourceMediaId);
    const row: ArchiveMedia = { role, ordinal, sha256: sha256(bytes), sourceMediaId, sourceUrl: 'https://archive-fixture.invalid/source/' + sourceMediaId, mime };
    media.push(row); return row;
  };
  const cover = mediaRow('cover', 0), gallery = [mediaRow('gallery', 0), mediaRow('gallery', 1)], description = mediaRow('description', 1);
  const variation = tiers ? [mediaRow('variation-0', 0), mediaRow('variation-0', 1)] : [];
  const video = tiers === 0 ? mediaRow('video', 0, 'video/mp4') : undefined, thumb = video ? mediaRow('video-thumbnail', 0) : undefined;
  const tierProjection: ArchiveItem['tierProjection'] = tiers ? [{ tierIndex: 0, name: 'Mẫu thử', options: [{ optionIndex: 0, label: 'Nhãn A' }, { optionIndex: 1, label: 'Nhãn B' }] },
    ...(tiers === 2 ? [{ tierIndex: 1, name: 'Bộ thử', options: [{ optionIndex: 0, label: 'Chọn 1' }, { optionIndex: 1, label: 'Chọn 2' }] }] : [])] : [];
  const rawModels: Models | null = tiers ? {
    tier_variation: tierProjection.map((tier, index) => ({ name: tier.name, option_list: tier.options.map(option => ({ option: option.label,
      ...(index === 0 ? { image: { image_id: variation[option.optionIndex]!.sourceMediaId! } } : {}) })) })),
    standardise_tier_variation: tierProjection.map((tier, index) => ({ variation_name: tier.name, variation_option_list: tier.options.map(option => ({ variation_option_name: option.label,
      ...(index === 0 ? { image_id: variation[option.optionIndex]!.sourceMediaId! } : {}) })) })),
    model: modelRows[tiers].map((row, index) => ({ model_id: 8100 + tiers * 10 + index, model_sku: row.sku, tier_index: [...row.tier],
      model_name: row.tier.map((choice, tier) => tierProjection[tier]!.options[choice]!.label).join(' / '), price_info: price(row.price, promotion), stock_info_v2: stock(row.stock),
      weight: '0.35', dimension: { ...dimension }, gtin_code: index ? '' : '1234567890123', pre_order: { is_pre_order: false, days_to_ship: 2 },
      model_status: 'NORMAL', has_promotion: promotion, promotion_id: promotion ? 501 : 0, is_fulfillment_by_shopee: false })),
  } : null;
  const title = `Synthetic archive fixture · ${tiers} tầng`;
  const field_list: RawItem['description_info']['extended_description']['field_list'] = [{ field_type: 'text', text: ' Văn bản nguồn thử\nnguyên văn. ' },
    { field_type: 'image', image_info: { image_id: description.sourceMediaId! } }, { field_type: 'text', text: '\nPhần cuối nguồn thử.' }];
  const rawItem: RawItem = {
    item_id: Number(sourceItemId), item_name: title, item_sku: parentSku, item_status: 'NORMAL', category_id: 100001, brand: { brand_id: 0, original_brand_name: 'Synthetic No Brand' },
    has_model: !!tiers, has_promotion: promotion, ...(promotion ? { promotion_id: 501 } : {}), create_time: 100, update_time: 200, deboost: false, authorised_brand_id: 0,
    condition: 'NEW', pre_order: { is_pre_order: false, days_to_ship: 2 }, gtin_code: '', tag: [], compatibility_info: [], item_dangerous: 0,
    purchase_limit_info: { purchase_limit: 0 }, size_chart_id: 0, size_chart: '', is_fulfillment_by_shopee: false,
    weight: '0.35', dimension: { ...dimension }, price_info: price(18000, promotion), stock_info_v2: stock(12),
    attribute_list: [{ attribute_id: 100, attribute_value_list: [{ value_id: 0, original_value_name: 'Nguyên văn nguồn thử', value_unit: 'ml' }] },
      { attribute_id: 200, attribute_value_list: [{ value_id: 2, original_value_name: 'Nhãn giá trị thử' }, { value_id: 1, original_value_name: 'Nhãn thử khác' }] }],
    logistic_info: [{ logistic_id: 101, logistic_name: 'Kênh thử A', enabled: true, is_free: true, size_id: 1, include_pickup: true, estimated_shipping_fee: 12000 },
      { logistic_id: 102, logistic_name: 'Kênh thử B', enabled: false, is_free: false, size_id: 2, include_pickup: false, estimated_shipping_fee: 14000 }],
    promotion_image: { image_id_list: [cover.sourceMediaId!], image_ratio: '1:1' }, image: { image_id_list: gallery.map(m => m.sourceMediaId!), image_ratio: '3:4' },
    description_type: 'extended', description_info: { extended_description: { field_list } },
    video_info: video ? { video_url: video.sourceUrl!, thumbnail_url: thumb!.sourceUrl!, duration: 10 } : [],
  };
  return { sourceItemId, observationHash: sha256(JSON.stringify({ rawItem, rawModels })), observedAt, title, sourceItemSku: parentSku,
    categoryId: rawItem.category_id, brandId: rawItem.brand.brand_id, tierProjection,
    modelProjection: rawModels?.model.map(model => ({ sourceModelId: String(model.model_id), modelSku: model.model_sku, tierIndex: [...model.tier_index],
      selections: model.tier_index.map((choice, tier) => tierProjection[tier]!.options[choice]!.label), priceInfo: structuredClone(model.price_info), stockInfoV2: structuredClone(model.stock_info_v2),
      weight: model.weight, dimension: { ...model.dimension }, gtinCode: model.gtin_code, preOrder: model.pre_order, hasPromotion: model.has_promotion, promotionId: model.promotion_id })) ?? [],
    parentPriceInfo: structuredClone(rawItem.price_info), parentStockInfoV2: structuredClone(rawItem.stock_info_v2), parentWeight: rawItem.weight, parentDimension: { ...dimension },
    descriptionBlocks: field_list.map((block, blockIndex) => block.field_type === 'text' ? { blockIndex, field_type: 'text', text: block.text } : { blockIndex, field_type: 'image', sha256: description.sha256 }),
    media, ...(promotion ? { promotionSnapshot: { kind: 'synthetic_fixture_campaign', sourceItemId, promotionId: 501 } } : {}), rawItem, rawModels };
}
export function syntheticArchiveManifest(): SyntheticArchiveManifest {
  const items = ([0, 1, 2] as const).map(syntheticArchiveItem);
  return { archiveId: 'synthetic-unit-archive:' + sha256(JSON.stringify(items)), sourceShopId: 'fixture-source-shop', items };
}

export function syntheticVideoDocumentation() {
  const bytes = Buffer.from('Synthetic unit documentation fixture; not Shopee authority.\nid: "api:v2.product.add_item:en"\n| video_upload_id | string[] | False |\nOnly accept one video_upload_id.\n');
  return { bytes, sha256: sha256(bytes) };
}
