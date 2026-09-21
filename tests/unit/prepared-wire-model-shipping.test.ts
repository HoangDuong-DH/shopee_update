import { describe, expect, it } from 'vitest';
import {
  preparedWeightKilograms,
  validatePreparedModelShipping,
  type PreparedDocument,
  type PreparedRemote,
} from '../../packages/domain/src/index.js';
import {
  planPreparedWireCreate,
  planPreparedWireUpdate,
  type PreparedWireContext,
} from '../../packages/shopee/src/prepared-wire.js';

// Pure fixtures using the documented model.weight/model.dimension contract, not live API evidence.
// init_tier_variation (2025-09-12), announcement908 (2024-06-05).
function fixture() {
  const cover = {
    importId: '00000000-0000-4000-8000-000000000001',
    sha256: 'a'.repeat(64),
    width: 1200,
    height: 1200,
    mime: 'image/png',
  };
  const gallery = { ...cover, importId: '00000000-0000-4000-8000-000000000002', width: 900 };
  const document: PreparedDocument = {
    sourceKey: 'MODEL-SHIPPING-FIXTURE',
    title: 'Original prepared title',
    description: [{ type: 'text', text: 'Original prepared content' }],
    cover,
    gallery: [gallery],
    tierNames: ['Dung tích'],
    models: [322.3, 130.9, 503.8].map((weightGrams, index) => ({
      sku: 'FIXTURE-' + index,
      tierIndex: [index],
      optionLabels: [['300ml', '100ml', '500ml'][index]!],
      originalPrice: '10000',
      stock: 100,
      weightGrams,
      dimensionCm: { length: 12, width: 12, height: 28 },
    })),
    categoryId: '101128',
    brandId: '1252097',
    attributes: {},
    logistics: [{ channelId: '5001', enabled: true }],
    weightGrams: 503.8,
    dimensionCm: { length: 12, width: 12, height: 28 },
    publication: 'unlisted',
  };
  const context: PreparedWireContext = {
    images: [
      { ...cover, role: 'cover', imageId: 'fixture-cover' },
      { ...gallery, role: 'gallery', imageId: 'fixture-gallery' },
    ],
    brandName: 'Fixture',
    condition: 'NEW',
    preOrder: { is_pre_order: false },
    stockLocationBySku: Object.fromEntries(document.models.map((m) => [m.sku, null])),
    capabilities: { gallery34: true, extendedDescription: false },
    channelInfoById: {
      '5001': {
        fee_type: 'SIZE_INPUT',
        mask_channel_id: 0,
        enabled: true,
        weight_limit: { item_max_weight: 10 },
        item_max_dimension: { length: 200, width: 200, height: 200, unit: 'cm' },
      },
    },
    limits: {
      price_limit: { min_limit: 1, max_limit: 120000000 },
      stock_limit: { min_limit: 0, max_limit: 10000000 },
      item_name_length_limit: { min_limit: 1, max_limit: 120 },
      item_image_count_limit: { min_limit: 1, max_limit: 9 },
      item_description_length_limit: { min_limit: 1, max_limit: 5000 },
      tier_variation_name_length_limit: { min_limit: 1, max_limit: 14 },
      tier_variation_option_length_limit: { min_limit: 1, max_limit: 20 },
      gtin_limit: { gtin_validation_rule: 'Optional' },
      size_chart_limit: { size_chart_mandatory: false },
    },
  };
  return { document, context };
}
function ready(document: PreparedDocument, context: PreparedWireContext) {
  const plan = planPreparedWireCreate(document, context);
  expect(plan.kind, JSON.stringify(plan)).toBe('ready');
  if (plan.kind !== 'ready') throw new Error('Expected ready');
  return plan;
}

describe('source-preserving model shipping', () => {
  it('encodes each SKU exact grams in kg and its dimensions without rounding or reordering', () => {
    const { document, context } = fixture();
    const before = JSON.stringify({ document, context });
    const plan = ready(document, context);
    expect(
      plan.steps[1]!.payload.model.map((m: any) => ({
        sku: m.model_sku,
        weight: m.weight,
        dimension: m.dimension,
      })),
    ).toEqual([
      {
        sku: 'FIXTURE-0',
        weight: 0.3223,
        dimension: { package_length: 12, package_width: 12, package_height: 28 },
      },
      {
        sku: 'FIXTURE-1',
        weight: 0.1309,
        dimension: { package_length: 12, package_width: 12, package_height: 28 },
      },
      {
        sku: 'FIXTURE-2',
        weight: 0.5038,
        dimension: { package_length: 12, package_width: 12, package_height: 28 },
      },
    ]);
    expect(plan.steps[0]!.payload.weight).toBe(0.5038);
    expect(JSON.stringify({ document, context })).toBe(before);
  });
  it('encodes the supplied 5225g as 5.225kg for each 5L SKU', () => {
    const { document, context } = fixture();
    for (const m of document.models) {
      m.weightGrams = 5225;
      m.dimensionCm = { length: 25, width: 20, height: 35 };
    }
    expect(
      ready(document, context).steps[1]!.payload.model.every((m: any) => m.weight === 5.225),
    ).toBe(true);
  });
  it('preserves omitted model shipping as API inheritance and weight-only overrides', () => {
    const { document, context } = fixture();
    delete document.models[0]!.weightGrams;
    delete document.models[0]!.dimensionCm;
    delete document.models[1]!.dimensionCm;
    const models = ready(document, context).steps[1]!.payload.model;
    expect(models[0]).not.toHaveProperty('weight');
    expect(models[0]).not.toHaveProperty('dimension');
    expect(models[1].weight).toBe(0.1309);
    expect(models[1]).not.toHaveProperty('dimension');
  });
  it.each([0, -1, NaN, Infinity, '322.3', null])(
    'blocks malformed model weight %j before create',
    (weight) => {
      const { document, context } = fixture();
      (document.models[0] as any).weightGrams = weight;
      expect(planPreparedWireCreate(document, context).kind).toBe('blocked');
      expect(() => validatePreparedModelShipping(document.models[0]!)).toThrow();
    },
  );
  it('requires explicit model weight when dimensions are supplied', () => {
    const { document, context } = fixture();
    delete document.models[0]!.weightGrams;
    expect(planPreparedWireCreate(document, context).kind).toBe('blocked');
    expect(() => validatePreparedModelShipping(document.models[0]!)).toThrow();
  });
  it.each([
    { length: 1, width: 2 },
    { length: 1.5, width: 2, height: 3 },
    { length: 1, width: 0, height: 3 },
    { length: 1, width: 2, height: 3, unit: 'inches' },
  ])('blocks incomplete or unsupported model dimensions %j', (dimensions) => {
    const { document, context } = fixture();
    (document.models[0] as any).dimensionCm = dimensions;
    expect(planPreparedWireCreate(document, context).kind).toBe('blocked');
    expect(() => validatePreparedModelShipping(document.models[0]!)).toThrow();
  });
  it('checks model weight against the selected channel even when the item weight passes', () => {
    const { document, context } = fixture();
    document.models[0]!.weightGrams = 10001;
    expect(planPreparedWireCreate(document, context)).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'PREPARED_WIRE_LOGISTICS_WEIGHT_LIMIT' }],
    });
  });
  it('checks model dimensions against the selected channel even when item dimensions pass', () => {
    const { document, context } = fixture();
    document.models[0]!.dimensionCm!.height = 201;
    expect(planPreparedWireCreate(document, context)).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'PREPARED_WIRE_LOGISTICS_DIMENSION_LIMIT' }],
    });
  });
  it('does not silently drop model-only shipping on an untiered item', () => {
    const { document, context } = fixture();
    document.tierNames = [];
    document.models = [{ ...document.models[0]!, tierIndex: [], optionLabels: [] }];
    expect(planPreparedWireCreate(document, context).kind).toBe('blocked');
  });
  it('domain validation preserves original values and omission without coercion', () => {
    const original = { weightGrams: 322.3, dimensionCm: { length: 12, width: 12, height: 28 } };
    expect(validatePreparedModelShipping(original)).toEqual(original);
    expect(validatePreparedModelShipping({})).toEqual({});
  });
  it.each([
    [322.3, 0.3223],
    [130.9, 0.1309],
    [503.8, 0.5038],
    [5225, 5.225],
    [0.00001, 0.00000001],
    [1000000000000000000000, 1000000000000000000],
  ])('converts decimal source %s g to %s kg without platform quantization', (grams, kilograms) => {
    expect(preparedWeightKilograms(grams!)).toBe(kilograms);
  });
  it('blocks item-level logistics overwrite of explicit model shipping while permitting a title patch', () => {
    const { document, context } = fixture();
    const baseline: PreparedRemote = {
      itemId: '1234',
      document,
      extra: {},
      modelBindings: document.models.map((m, i) => ({
        sku: m.sku,
        modelId: String(2000 + i),
        tierIndex: m.tierIndex,
      })),
    };
    context.baseline = {
      item: { item_id: 1234, has_model: true },
      models: {
        model: document.models.map((m, i) => ({
          model_id: 2000 + i,
          model_sku: m.sku,
          tier_index: m.tierIndex,
        })),
        tier_variation: [
          {
            name: 'Dung tích',
            option_list: document.models.map((m) => ({ option: m.optionLabels[0] })),
          },
        ],
      },
    };
    const expected = structuredClone(baseline);
    expected.document.weightGrams = 600;
    expect(planPreparedWireUpdate(baseline, expected, ['logistics'], [], context)).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'PREPARED_WIRE_MODEL_SHIPPING_UPDATE_UNSUPPORTED' }],
    });
    const title = structuredClone(baseline);
    title.document.title = 'Changed prepared title';
    expect(planPreparedWireUpdate(baseline, title, ['title'], [], context).kind).toBe('ready');
  });
});
