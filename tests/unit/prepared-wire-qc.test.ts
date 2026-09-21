import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PreparedDocument } from '../../packages/domain/src/index.js';
import type {
  FieldSnapshot,
  PreparedWireContext,
  PreparedWireStep,
} from '../../packages/shopee/src/index.js';
import {
  checkPreparedWireCreate,
  checkPreparedWireCreateWithoutImages,
  checkPreparedWireUpdate,
} from '../../packages/shopee/src/prepared-wire-qc.js';

function fixture(tiers = 1) {
  const image = {
    importId: randomUUID(),
    sha256: 'a'.repeat(64),
    width: 1200,
    height: 1200,
    mime: 'image/png',
  };
  const gallery = { ...image, importId: randomUUID(), width: 900 };
  const description = { ...gallery, importId: randomUUID() };
  const document: PreparedDocument = {
    sourceKey: 'PARENT',
    title: 'Exact source title',
    description: [
      { type: 'text', text: 'Head\n\n' },
      { type: 'image', image: description },
      { type: 'text', text: '\n\nTail' },
    ],
    cover: image,
    gallery: [gallery],
    categoryId: '700',
    brandId: '9',
    attributes: { '10': ['20'] },
    logistics: [{ channelId: '55', enabled: true }],
    weightGrams: 100,
    dimensionCm: { length: 10, width: 8, height: 4 },
    publication: 'unlisted',
    tierNames: ['Màu', 'Cỡ'].slice(0, tiers),
    models: Array.from({ length: tiers ? 2 ** tiers : 1 }, (_, i) => ({
      sku: 'SKU-' + i,
      tierIndex: tiers === 2 ? [Math.floor(i / 2), i % 2] : tiers ? [i] : [],
      optionLabels:
        tiers === 2 ? [String(Math.floor(i / 2)), String(i % 2)] : tiers ? [String(i)] : [],
      originalPrice: String(10000 + i),
      stock: 5 + i,
      ...(tiers ? { image } : {}),
    })),
  };
  const context: PreparedWireContext = {
    images: [
      { ...image, role: 'cover', imageId: 'cover-id' },
      { ...image, role: 'variation', imageId: 'tier-id' },
      { ...gallery, role: 'gallery', imageId: 'gallery-id' },
      { ...description, role: 'description', imageId: 'desc-id' },
    ],
    brandName: 'Brand',
    condition: 'NEW',
    preOrder: { is_pre_order: false },
    stockLocationBySku: Object.fromEntries(document.models.map((m) => [m.sku, null])),
    limits: {},
    capabilities: { gallery34: true, extendedDescription: true },
    attributeList: [
      {
        attribute_id: 10,
        attribute_value_list: [{ value_id: 20, original_value_name: 'Cotton', value_unit: '' }],
      },
    ],
  };
  const stock = (n: number) => ({
    seller_stock: [{ stock: n, location_id: '', if_saleable: true }],
    shopee_stock: [],
    summary_info: { total_reserved_stock: 0, total_available_stock: n },
  });
  const price = (n: number) => [
    {
      currency: 'VND',
      original_price: n,
      current_price: n,
      inflated_price_of_original_price: n,
      inflated_price_of_current_price: n,
    },
  ];
  const raw: FieldSnapshot = {
    item: {
      item_id: 1234,
      item_name: document.title,
      item_sku: tiers ? 'PARENT' : 'SKU-0',
      item_status: 'UNLIST',
      category_id: 700,
      brand: { brand_id: 9, original_brand_name: 'Brand' },
      condition: 'NEW',
      pre_order: { is_pre_order: false, days_to_ship: 2 },
      weight: '0.100',
      dimension: { package_length: 10, package_width: 8, package_height: 4 },
      attribute_list: [
        {
          attribute_id: 10,
          original_attribute_name: 'Material',
          is_mandatory: true,
          attribute_value_list: [{ value_id: 20, original_value_name: 'Cotton', value_unit: '' }],
        },
      ],
      logistic_info: [
        {
          logistic_id: 55,
          enabled: true,
          is_free: false,
          logistic_name: 'Channel',
          estimated_shipping_fee: 1,
        },
      ],
      has_model: tiers > 0,
      has_promotion: false,
      create_time: 1,
      update_time: 1,
      protected: { list: [] },
      image: { image_id_list: ['gallery-id'], image_ratio: '3:4', image_url_list: ['url'] },
      promotion_image: {
        image_id_list: ['cover-id'],
        image_ratio: '1:1',
        image_url_list: ['cover-url'],
      },
      description_type: 'extended',
      description_info: {
        extended_description: {
          field_list: [
            { field_type: 'text', text: 'Head\n\n' },
            { field_type: 'image', image_info: { image_id: 'desc-id', image_url: 'desc-url' } },
            { field_type: 'text', text: '\n\nTail' },
          ],
        },
      },
      ...(tiers ? {} : { price_info: price(10000), stock_info_v2: stock(5) }),
    },
    models: {
      tier_variation: document.tierNames.map((name, tier) => ({
        name,
        option_list: [...new Set(document.models.map((m) => m.optionLabels[tier]!))].map(
          (option) => ({
            option,
            ...(tier === 0 ? { image: { image_id: 'tier-id', image_url: 'tier-url' } } : {}),
          }),
        ),
      })),
      standardise_tier_variation: document.tierNames.map((variation_name, tier) => ({
        variation_id: 0,
        variation_name,
        variation_option_list: [...new Set(document.models.map((m) => m.optionLabels[tier]!))].map(
          (variation_option_name) => ({
            variation_option_id: 0,
            variation_option_name,
            ...(tier === 0 ? { image_id: 'tier-id', image_url: 'tier-url' } : {}),
          }),
        ),
      })),
      model: tiers
        ? document.models
            .map((m, i) => ({
              model_id: 50 + i,
              model_sku: m.sku,
              tier_index: m.tierIndex,
              has_promotion: false,
              promotion_id: 0,
              price_info: price(Number(m.originalPrice)),
              stock_info_v2: stock(m.stock),
              protected: { array: [] },
            }))
            .reverse()
        : [],
    },
  };
  return { document, context, raw };
}
it('keeps image deferral separate from full QC and does not let many image differences hide a later price mismatch',()=>{
  const {document,context,raw}=fixture(1);
  const imageBlock=document.description.find(b=>b.type==='image')!;
  document.description=Array.from({length:250},()=>structuredClone(imageBlock));
  (raw.item as any).description_info.extended_description.field_list=Array.from({length:250},()=>({field_type:'image',image_info:{image_id:'unreviewed-output'}}));
  expect(checkPreparedWireCreate(document,context,raw).verified).toBe(false);
  expect(checkPreparedWireCreateWithoutImages(document,context,raw)).toEqual({coreVerified:true,mismatchedPaths:[]});
  (raw.models as any).model[0].price_info[0].original_price++;
  const result=checkPreparedWireCreateWithoutImages(document,context,raw);
  expect(result.coreVerified).toBe(false);expect(result.mismatchedPaths.some(p=>p.includes('price'))).toBe(true);
});
const step = (
  group: PreparedWireStep['group'],
  payload: Record<string, any>,
  path: PreparedWireStep['path'] = '/api/v2/product/update_item',
): PreparedWireStep => ({ group, method: 'POST', path, payload: { item_id: 1234, ...payload } });
describe('independent raw Shopee readback QC', () => {
  it.each([0, 1, 2])(
    'checks a %i-tier create directly from raw fields in arbitrary model order',
    (tiers) => {
      const { document, context, raw } = fixture(tiers);
      expect(checkPreparedWireCreate(document, context, raw)).toEqual({
        verified: true,
        mismatchedPaths: [],
      });
    },
  );
  it.each([
    'title',
    'category',
    'brand',
    'attribute',
    'condition',
    'preorder',
    'cover',
    'gallery',
    'description',
    'price',
    'stock',
    'sku',
    'tier',
  ])('does not verify a create when sourced %s changes', (field) => {
    const { document, context, raw } = fixture();
    const item = raw.item as any,
      model = raw.models.model[0] as any;
    if (field === 'title') item.item_name += ' changed';
    if (field === 'category') item.category_id = 701;
    if (field === 'brand') item.brand.original_brand_name = 'Other';
    if (field === 'attribute') item.attribute_list[0].attribute_value_list[0].value_id = 21;
    if (field === 'condition') item.condition = 'USED';
    if (field === 'preorder') item.pre_order.is_pre_order = true;
    if (field === 'cover') item.promotion_image.image_id_list[0] = 'aliased-cover';
    if (field === 'gallery') item.image.image_id_list = [];
    if (field === 'description')
      item.description_info.extended_description.field_list[0].text = 'Other';
    if (field === 'price') model.price_info[0].original_price++;
    if (field === 'stock') model.stock_info_v2.seller_stock[0].stock++;
    if (field === 'sku') model.model_sku = 'Other';
    if (field === 'tier') (raw.models.tier_variation[0] as any).option_list[0].option = 'Other';
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(false);
  });
  it('verifies selected title but rejects an unselected array-to-object drift and creation time change', () => {
    const { raw } = fixture();
    const after = structuredClone(raw);
    after.item.item_name = 'New title';
    after.item.update_time = 9;
    const steps = [step('title', { item_name: 'New title' })];
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(true);
    (after.models.model[0] as any).protected.array = {};
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(false);
    const another = structuredClone(raw);
    another.item.item_name = 'New title';
    another.item.create_time = 99;
    expect(checkPreparedWireUpdate(raw, another, steps).verified).toBe(false);
  });
  it('detects a changed cover ID during gallery update and keeps all other raw fields', () => {
    const { raw } = fixture();
    const after = structuredClone(raw);
    (after.item.image as any).image_id_list = ['new-gallery'];
    const steps = [
      step('gallery', {
        image: { image_ratio: '3:4', image_id_list: ['new-gallery'] },
        promotion_images: { image_id_list: ['cover-id'] },
      }),
    ];
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(true);
    (after.item.promotion_image as any).image_id_list = ['shopee-changed-id'];
    expect(checkPreparedWireUpdate(raw, after, steps)).toMatchObject({
      verified: false,
      mismatchedPaths: expect.arrayContaining(['item.promotion_image.image_id_list.0']),
    });
  });
  it('checks a selected cover and description without discarding protected nested fields', () => {
    const { raw } = fixture();
    const after = structuredClone(raw);
    (after.item.promotion_image as any).image_id_list = ['new-cover'];
    (after.item.description_info as any).extended_description.field_list[0].text = 'New\n\n';
    const steps = [
      step('cover', { promotion_images: { image_id_list: ['new-cover'] } }),
      step('description', {
        description_type: 'extended',
        description_info: {
          extended_description: {
            field_list: [
              { field_type: 'text', text: 'New\n\n' },
              { field_type: 'image', image_info: { image_id: 'desc-id' } },
              { field_type: 'text', text: '\n\nTail' },
            ],
          },
        },
      }),
    ];
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(true);
    after.item.extra = { injected: true };
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(false);
  });
  it('matches selected model IDs rather than array position and rejects partial price updates', () => {
    const { raw } = fixture();
    const after = structuredClone(raw);
    const priceStep = step(
      'price',
      { price_list: [{ model_id: 50, original_price: 20000 }] },
      '/api/v2/product/update_price',
    );
    const model = after.models.model.find((m) => m.model_id === 50) as any;
    for (const key of [
      'original_price',
      'current_price',
      'inflated_price_of_original_price',
      'inflated_price_of_current_price',
    ])
      model.price_info[0][key] = 20000;
    after.models.model.reverse();
    expect(checkPreparedWireUpdate(raw, after, [priceStep]).verified).toBe(true);
    priceStep.payload.price_list.push({ model_id: 51, original_price: 21000 });
    expect(checkPreparedWireUpdate(raw, after, [priceStep]).verified).toBe(false);
    (raw.models.model[0] as any).has_promotion = true;
    expect(checkPreparedWireUpdate(raw, after, [priceStep]).verified).toBe(false);
  });
  it('checks stock plus its available summary and refuses reserved-stock inference', () => {
    const { raw } = fixture();
    const after = structuredClone(raw);
    const model = after.models.model.find((m) => m.model_id === 50) as any;
    model.stock_info_v2.seller_stock[0].stock = 8;
    model.stock_info_v2.summary_info.total_available_stock = 8;
    const steps = [
      step(
        'stock',
        { stock_list: [{ model_id: 50, seller_stock: [{ stock: 8 }] }] },
        '/api/v2/product/update_stock',
      ),
    ];
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(true);
    model.stock_info_v2.summary_info.total_available_stock = 7;
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(false);
    (
      raw.models.model.find((m) => m.model_id === 50) as any
    ).stock_info_v2.summary_info.total_reserved_stock = 1;
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(false);
  });
  it('checks untiered model zero price/stock while protecting its true item SKU', () => {
    const { raw } = fixture(0);
    const after = structuredClone(raw);
    (after.item.stock_info_v2 as any).seller_stock[0].stock = 9;
    (after.item.stock_info_v2 as any).summary_info.total_available_stock = 9;
    const steps = [
      step(
        'stock',
        { stock_list: [{ model_id: 0, seller_stock: [{ stock: 9 }] }] },
        '/api/v2/product/update_stock',
      ),
    ];
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(true);
    after.item.item_sku = 'PARENT';
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(false);
  });
  it('never verifies unsupported paths or unknown extra request keys', () => {
    const { raw } = fixture();
    expect(
      checkPreparedWireUpdate(raw, raw, [step('create', {}, '/api/v2/product/add_item')]).verified,
    ).toBe(false);
    expect(
      checkPreparedWireUpdate(raw, raw, [
        step('title', { item_name: raw.item.item_name, invented_key: true }),
      ]).verified,
    ).toBe(false);
  });
  it('checks zero advance stock objects and refuses any nonzero or unknown allocation', () => {
    const { document, context, raw } = fixture();
    for (const m of raw.models.model as any[])
      m.stock_info_v2.advance_stock = { sellable_advance_stock: 0, in_transit_advance_stock: 0 };
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(true);
    (raw.models.model[0] as any).stock_info_v2.advance_stock.sellable_advance_stock = 1;
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(false);
    (raw.models.model[0] as any).stock_info_v2.advance_stock = {
      sellable_advance_stock: 0,
      in_transit_advance_stock: 0,
      unknown_allocation: 2,
    };
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(false);
  });
  it('accepts returned disabled logistics metadata but rejects an extra enabled channel at create', () => {
    const { document, context, raw } = fixture();
    (raw.item.logistic_info as any[]).push({
      logistic_id: 99,
      enabled: false,
      logistic_name: 'Other',
    });
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(true);
    (raw.item.logistic_info as any[])[1]!.enabled = true;
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(false);
  });
  it('checks inherited per-model shipping fields when returned at create', () => {
    const { document, context, raw } = fixture();
    const model = raw.models.model[0] as any;
    model.weight = raw.item.weight;
    model.dimension = structuredClone(raw.item.dimension);
    model.pre_order = structuredClone(raw.item.pre_order);
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(true);
    model.dimension.package_width++;
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(false);
  });
  it('checks variation image effects in both response representations and keeps model bindings', () => {
    const { raw } = fixture(2);
    const after = structuredClone(raw);
    const standard = structuredClone(raw.models.standardise_tier_variation) as any[];
    for (const tier of standard)
      for (const option of tier.variation_option_list) delete option.image_url;
    standard[0]!.variation_option_list[0]!.image_id = 'new-first-option';
    (after.models.standardise_tier_variation as any[])[0]!.variation_option_list[0]!.image_id =
      'new-first-option';
    (after.models.tier_variation as any[])[0]!.option_list[0]!.image.image_id = 'new-first-option';
    const steps = [
      step(
        'variationImages',
        {
          standardise_tier_variation: standard,
          model_list: raw.models.model.map((m) => ({
            model_id: m.model_id,
            tier_index: m.tier_index,
          })),
        },
        '/api/v2/product/update_tier_variation',
      ),
    ];
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(true);
    (after.models.tier_variation as any[])[0]!.option_list[1]!.image.image_id =
      'unselected-changed';
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(false);
  });
  it('supports known attribute values while retaining names and category metadata', () => {
    const { raw } = fixture();
    const after = structuredClone(raw);
    (after.item.attribute_list as any[])[0]!.attribute_value_list[0]!.value_unit = 'cm';
    const steps = [
      step('attributes', {
        attribute_list: [
          {
            attribute_id: 10,
            attribute_value_list: [
              { value_id: 20, original_value_name: 'Cotton', value_unit: 'cm' },
            ],
          },
        ],
      }),
    ];
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(true);
    (after.item.attribute_list as any[])[0]!.is_mandatory = false;
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(false);
    steps[0]!.payload.attribute_list[0].attribute_value_list[0].value_id = 22;
    expect(checkPreparedWireUpdate(raw, after, steps).mismatchedPaths).toContain(
      'unsupported.attribute_list.new_value',
    );
  });
  it('checks selected weight, dimensions and channels without discarding shipping fee changes', () => {
    const { raw } = fixture();
    for (const model of raw.models.model) {
      model.weight = raw.item.weight;
      model.dimension = structuredClone(raw.item.dimension);
    }
    const after = structuredClone(raw);
    after.item.weight = '0.2';
    (after.item.dimension as any).package_width = 9;
    (after.item.logistic_info as any[])[0]!.enabled = false;
    for (const model of after.models.model) {
      model.weight = after.item.weight;
      model.dimension = structuredClone(after.item.dimension);
    }
    const steps = [
      step('logistics', {
        weight: 0.2,
        dimension: { package_length: 10, package_width: 9, package_height: 4 },
        logistic_info: [{ logistic_id: 55, enabled: false, is_free: false }],
      }),
    ];
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(true);
    (after.item.logistic_info as any[])[0]!.estimated_shipping_fee = 2;
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(false);
  });
  it('does not verify shipping when dependent model shipping evidence is missing', () => {
    const { raw } = fixture();
    const after = structuredClone(raw);
    after.item.weight = '0.2';
    expect(checkPreparedWireUpdate(raw, after, [step('logistics', { weight: 0.2 })]).verified).toBe(
      false,
    );
  });
  it('checks normal description exact text and does not guess cross-type fallback cleanup', () => {
    const { document, context, raw } = fixture();
    document.description = [
      { type: 'text', text: 'A\n\n' },
      { type: 'text', text: 'B' },
    ];
    raw.item.description_type = 'normal';
    raw.item.description = 'A\n\nB';
    delete raw.item.description_info;
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(true);
    const after = structuredClone(raw);
    after.item.description = 'New';
    expect(
      checkPreparedWireUpdate(raw, after, [
        step('description', { description_type: 'normal', description: 'New' }),
      ]).verified,
    ).toBe(true);
    expect(
      checkPreparedWireUpdate(raw, after, [
        step('description', {
          description_type: 'extended',
          description_info: { extended_description: { field_list: [] } },
        }),
      ]).verified,
    ).toBe(false);
  });
  it('protects nonselected price and stock models separately', () => {
    const { raw } = fixture();
    const after = structuredClone(raw);
    (after.models.model.find((m) => m.model_id === 50) as any).stock_info_v2.seller_stock[0].stock =
      9;
    (
      after.models.model.find((m) => m.model_id === 50) as any
    ).stock_info_v2.summary_info.total_available_stock = 9;
    (after.models.model.find((m) => m.model_id === 51) as any).stock_info_v2.summary_info
      .total_available_stock--;
    expect(
      checkPreparedWireUpdate(raw, after, [
        step(
          'stock',
          { stock_list: [{ model_id: 50, seller_stock: [{ stock: 9 }] }] },
          '/api/v2/product/update_stock',
        ),
      ]).verified,
    ).toBe(false);
  });
  it('rejects extra standardised tiers and model state changes at create', () => {
    const { document, context, raw } = fixture();
    (raw.models.standardise_tier_variation as any[]).push({
      variation_name: 'Extra',
      variation_option_list: [],
    });
    expect(checkPreparedWireCreate(document, context, raw).verified).toBe(false);
  });
  it('rejects payload groups disguised as title requests', () => {
    const { raw } = fixture();
    const after = structuredClone(raw);
    after.item.item_name = 'New';
    after.item.weight = '0.2';
    expect(
      checkPreparedWireUpdate(raw, after, [step('title', { item_name: 'New', weight: 0.2 })])
        .verified,
    ).toBe(false);
  });
  it('requires documented shipping overwrites on every returned model and preserves other channels', () => {
    const { raw } = fixture();
    for (const model of raw.models.model as any[]) {
      model.weight = '0.3';
      model.dimension = { package_length: 6, package_width: 6, package_height: 6 };
    }
    (raw.item.logistic_info as any[]).push({ logistic_id: 99, enabled: false, size_id: 0 });
    const after = structuredClone(raw);
    after.item.weight = '0.2';
    after.item.dimension = { package_length: 10, package_width: 9, package_height: 4 };
    for (const model of after.models.model as any[]) {
      model.weight = '0.2';
      model.dimension = structuredClone(after.item.dimension);
    }
    const steps = [
      step('logistics', {
        weight: 0.2,
        dimension: { package_length: 10, package_width: 9, package_height: 4 },
        logistic_info: [{ logistic_id: 55, enabled: true }],
      }),
    ];
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(true);
    (after.models.model[0] as any).weight = '0.3';
    expect(checkPreparedWireUpdate(raw, after, steps).verified).toBe(false);
  });
});
