import { describe, expect, it } from 'vitest';
import {
  planVariationMutation,
  variationBaselineFingerprint,
  checkVariationMutationStage,
  inspectVariationMutationAcknowledgement,
  variationMutationSchema,
  type VariationMutationIntent,
  type VariationMutationContext,
} from '../../packages/shopee/src/variation-mutations.js';
import type { FieldSnapshot } from '../../packages/shopee/src/field-client.js';

function fixture(tiers = 1) {
  const names = ['Color', 'Size'].slice(0, tiers),
    options = [
      ['Red', 'Blue'],
      ['S', 'L'],
    ].slice(0, tiers);
  const stock = (n: number) => ({
    seller_stock: [{ stock: n, location_id: '' }],
    shopee_stock: [],
    summary_info: { total_reserved_stock: 0, total_available_stock: n },
    advance_stock: { sellable_advance_stock: 0, in_transit_advance_stock: 0 },
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
  const models = Array.from({ length: tiers ? 2 ** tiers : 0 }, (_, i) => ({
    model_id: 500 + i,
    model_sku: `SKU-${i}`,
    tier_index: tiers === 2 ? [Math.floor(i / 2), i % 2] : [i],
    model_name:
      tiers === 2 ? `${options[0]![Math.floor(i / 2)]},${options[1]![i % 2]}` : options[0]![i],
    price_info: price(10000 + i * 1000),
    stock_info_v2: stock(10 + i),
    has_promotion: false,
    promotion_id: 0,
    weight: '0.1',
    dimension: { package_length: 10, package_width: 8, package_height: 4 },
    pre_order: { is_pre_order: false, days_to_ship: 2 },
    model_status: 'MODEL_NORMAL',
    is_fulfillment_by_shopee: false,
    unknown: { keep: [] },
  }));
  const baseline: FieldSnapshot = {
    item: {
      item_id: 1234,
      item_sku: 'SBX-VARIATION-REVIEW',
      item_name: 'SANDBOX QA variation review',
      item_status: 'UNLIST',
      has_model: tiers > 0,
      has_promotion: false,
      weight: '0.1',
      dimension: { package_length: 10, package_width: 8, package_height: 4 },
      pre_order: { is_pre_order: false, days_to_ship: 2 },
      image: { image_ratio: '3:4', image_id_list: ['gallery'] },
      promotion_image: { image_ratio: '1:1', image_id_list: ['cover'] },
      create_time: 1,
      update_time: 2,
      unknown: { keep: [] },
      ...(tiers
        ? {}
        : { price_info: price(10000), stock_info_v2: stock(10), is_fulfillment_by_shopee: false }),
    },
    models: {
      model: models,
      tier_variation: names.map((name, t) => ({
        name,
        option_list: options[t]!.map((option, i) => ({
          option,
          ...(t === 0 ? { image: { image_id: `color-${i}` } } : {}),
        })),
      })),
      standardise_tier_variation: names.map((variation_name, t) => ({
        variation_id: 0,
        variation_group_id: 0,
        variation_name,
        variation_option_list: options[t]!.map((variation_option_name, i) => ({
          variation_option_id: 0,
          variation_option_name,
          ...(t === 0 ? { image_id: `color-${i}` } : {}),
        })),
      })),
    },
  };
  const intent: VariationMutationIntent = {
    version: 1,
    itemId: '1234',
    baselineFingerprint: variationBaselineFingerprint(baseline),
    source: {
      key: 'prepared-variation-review',
      digest: 'a'.repeat(64),
      refs: ['source:worksheet:row:1'],
    },
    tiers: names.map((name, t) => ({
      name,
      options: options[t]!.map((name, previousIndex) => ({ name, previousIndex })),
    })),
    retained: models.map((m) => ({ modelId: String(m.model_id), tierIndex: [...m.tier_index] })),
    removedModelIds: [],
    added: [],
  };
  const context: VariationMutationContext = {
    baseline,
    scope: { environment: 'sandbox', partnerId: '1232297', shopId: '227418363' },
    promotionSnapshot: {
      error: '',
      response: { success_list: [{ item_id: 1234, promotion: [] }], failure_list: [] },
    },
    allowedLocationIds: [null],
    resolvedImageIds: ['green-image', 'new-image'],
    maxVariationPriceRatio: { value: 5, source: 'fixture-metadata' },
    itemLimits: {
      price_limit: { min_limit: 1000, max_limit: 100000 },
      stock_limit: { min_limit: 0, max_limit: 999 },
      tier_variation_name_length_limit: { min_limit: 1, max_limit: 30 },
      tier_variation_option_length_limit: { min_limit: 1, max_limit: 30 },
      gtin_limit: { gtin_validation_rule: 'Optional' },
    },
  };
  return {
    baseline,
    intent,
    context,
    refresh() {
      intent.baselineFingerprint = variationBaselineFingerprint(baseline);
    },
  };
}
function ready(f: ReturnType<typeof fixture>) {
  const plan = planVariationMutation(f.intent, f.context);
  expect(plan.kind, JSON.stringify(plan)).toBe('ready');
  if (plan.kind !== 'ready') throw new Error('blocked');
  return plan;
}
describe('source-backed variation mutation planning and raw QC', () => {
  it('renames an option and tier while preserving every model ID/SKU/price/stock/extra', () => {
    const f = fixture();
    f.intent.tiers[0]!.name = 'Shade';
    f.intent.tiers[0]!.options[0]!.name = 'Dark red';
    const plan = ready(f),
      after = structuredClone(f.baseline);
    (after.models.tier_variation[0] as any).name = 'Shade';
    (after.models.tier_variation[0] as any).option_list[0].option = 'Dark red';
    (after.models.standardise_tier_variation as any[])[0]!.variation_name = 'Shade';
    (
      after.models.standardise_tier_variation as any[]
    )[0]!.variation_option_list[0].variation_option_name = 'Dark red';
    after.models.model[0]!.model_name = 'Dark red';
    expect(plan.steps[0]!.path).toBe('/api/v2/product/update_tier_variation');
    expect(checkVariationMutationStage(plan, 0, f.baseline, after).verified).toBe(true);
    (after.models.model[1]!.unknown as any).keep = {};
    expect(checkVariationMutationStage(plan, 0, f.baseline, after).verified).toBe(false);
  });
  it('reorders options with explicit prior identity and moves indices without changing model IDs', () => {
    const f = fixture();
    f.intent.tiers[0]!.options.reverse();
    f.intent.retained.forEach((m) => {
      m.tierIndex[0] = 1 - m.tierIndex[0]!;
    });
    const plan = ready(f),
      after = structuredClone(f.baseline);
    (after.models.tier_variation[0] as any).option_list.reverse();
    (after.models.standardise_tier_variation as any[])[0]!.variation_option_list.reverse();
    after.models.model.forEach((m) => {
      (m.tier_index as number[])[0] = 1 - (m.tier_index as number[])[0]!;
    });
    expect(checkVariationMutationStage(plan, 0, f.baseline, after).verified).toBe(true);
  });
  it('separates inserting an option from adding its sourced model, with a baseline fingerprint at both stages', () => {
    const f = fixture();
    f.intent.tiers[0]!.options.splice(1, 0, {
      previousIndex: null,
      name: 'Green',
      imageId: 'green-image',
    });
    f.intent.retained[1]!.tierIndex = [2];
    f.intent.added = [
      { sku: 'NEW-GREEN', tierIndex: [1], originalPrice: 14000, stock: 8, locationId: null },
    ];
    const plan = ready(f);
    expect(plan.steps.map((s) => s.path)).toEqual([
      '/api/v2/product/update_tier_variation',
      '/api/v2/product/add_model',
    ]);
    expect(plan.steps.every((s) => s.expectedBeforeFingerprint.length === 64)).toBe(true);
    expect(plan.steps[1]!.payload.model_list).toEqual([
      {
        model_sku: 'NEW-GREEN',
        tier_index: [1],
        original_price: 14000,
        seller_stock: [{ stock: 8 }],
      },
    ]);
    const stale = structuredClone(f.baseline);
    stale.item.item_name = 'External drift';
    expect(checkVariationMutationStage(plan, 0, stale, f.baseline).verified).toBe(false);
  });
  it('deletes an option only when every removed model is explicitly declared', () => {
    const f = fixture();
    f.intent.tiers[0]!.options.pop();
    f.intent.retained.pop();
    expect(planVariationMutation(f.intent, f.context).kind).toBe('blocked');
    f.intent.removedModelIds = ['501'];
    const plan = ready(f),
      after = structuredClone(f.baseline);
    (after.models.tier_variation[0] as any).option_list.pop();
    (after.models.standardise_tier_variation as any[])[0]!.variation_option_list.pop();
    after.models.model.pop();
    expect(checkVariationMutationStage(plan, 0, f.baseline, after).verified).toBe(true);
  });
  it('uses delete_model to remove one explicit 2-tier combination without removing either option', () => {
    const f = fixture(2);
    f.intent.retained.pop();
    f.intent.removedModelIds = ['503'];
    const plan = ready(f);
    expect(plan.steps[0]!.path).toBe('/api/v2/product/delete_model');
    expect(plan.steps[0]!.payload).toEqual({ item_id: 1234, model_id: 503 });
    const after = structuredClone(f.baseline);
    after.models.model.pop();
    expect(checkVariationMutationStage(plan, 0, f.baseline, after).verified).toBe(true);
  });
  it.each([
    'missing-decision',
    'duplicate-position',
    'foreign-remove',
    'wrong-kept-option',
    'reserved',
    'promotion',
    'missing-promotion',
    'price-decimal',
  ] as const)('blocks unsafe intent %s before dispatch', (fault) => {
    const f = fixture();
    f.intent.tiers[0]!.name = 'Shade';
    if (fault === 'missing-decision') f.intent.retained.pop();
    if (fault === 'duplicate-position') f.intent.retained[1]!.tierIndex = [0];
    if (fault === 'foreign-remove') f.intent.removedModelIds = ['999'];
    if (fault === 'wrong-kept-option') f.intent.retained[0]!.tierIndex = [1];
    if (fault === 'reserved') {
      (f.baseline.models.model[0]!.stock_info_v2 as any).summary_info.total_reserved_stock = 1;
      f.refresh();
    }
    if (fault === 'promotion') {
      f.baseline.item.has_promotion = true;
      f.refresh();
    }
    if (fault === 'missing-promotion') {
      f.context.promotionSnapshot = undefined;
      f.intent.tiers[0]!.options.pop();
      f.intent.retained.pop();
      f.intent.removedModelIds = ['501'];
    }
    if (fault === 'price-decimal')
      f.intent.added.push({
        sku: 'NEW',
        tierIndex: [0],
        originalPrice: 1000.5,
        stock: 1,
        locationId: null,
      });
    expect(planVariationMutation(f.intent, f.context).kind).toBe('blocked');
  });
  it('requires complete source/model replacement authorization when changing tier count', () => {
    const f = fixture();
    f.intent.tiers.push({ name: 'Size', options: [{ previousIndex: null, name: 'S' }] });
    expect(planVariationMutation(f.intent, f.context).kind).toBe('blocked');
    f.intent.replaceAllModels = true;
    f.intent.retained = [];
    f.intent.removedModelIds = ['500', '501'];
    f.intent.tiers[0]!.options.forEach((o) => {
      o.previousIndex = null;
      o.imageId = 'new-image';
    });
    f.intent.added = [
      { sku: 'RESET-RED', tierIndex: [0, 0], originalPrice: 12000, stock: 4, locationId: null },
      { sku: 'RESET-BLUE', tierIndex: [1, 0], originalPrice: 14000, stock: 6, locationId: null },
    ];
    expect(ready(f).steps[0]!.path).toBe('/api/v2/product/init_tier_variation');
  });
  it('supports explicit zero-tier replacement with new sourced tiered models and never reuses default ID zero', () => {
    const f = fixture(0);
    f.intent.replaceAllModels = true;
    f.intent.removedModelIds = ['0'];
    f.intent.tiers = [
      { name: 'Color', options: [{ previousIndex: null, name: 'Red', imageId: 'new-image' }] },
    ];
    f.intent.added = [
      { sku: 'RESET-RED', tierIndex: [0], originalPrice: 12000, stock: 4, locationId: null },
    ];
    const plan = ready(f);
    expect(plan.steps[0]!.payload.model[0]).toEqual({
      model_sku: 'RESET-RED',
      tier_index: [0],
      original_price: 12000,
      seller_stock: [{ stock: 4 }],
    });
  });
  it('rejects partial add-model receipts and binds exact source SKUs independently of response order', () => {
    const f = fixture(2);
    f.intent.replaceAllModels = true;
    f.intent.removedModelIds = ['500', '501', '502', '503'];
    f.intent.retained = [];
    f.intent.tiers = [
      {
        name: 'Color',
        options: [
          { previousIndex: null, name: 'Red', imageId: 'new-image' },
          { previousIndex: null, name: 'Blue', imageId: 'new-image' },
        ],
      },
    ];
    f.intent.added = [
      { sku: 'A', tierIndex: [0], originalPrice: 12000, stock: 4, locationId: null },
      { sku: 'B', tierIndex: [1], originalPrice: 13000, stock: 5, locationId: null },
    ];
    const plan = ready(f),
      row = (sku: string, model_id: number, i: number) => ({
        model_sku: sku,
        model_id,
        tier_index: [i],
        price_info: [{ original_price: 12000 + i * 1000 }],
        seller_stock: [{ stock: 4 + i }],
      });
    expect(
      inspectVariationMutationAcknowledgement(plan.steps[0]!, {
        error: '',
        request_id: 'r',
        response: { item_id: 1234, model: [row('A', 901, 0)] },
      }).success,
    ).toBe(false);
    expect(
      inspectVariationMutationAcknowledgement(plan.steps[0]!, {
        error: '',
        request_id: 'r',
        response: { item_id: 1234, model: [row('B', 902, 1), row('A', 901, 0)] },
      }).success,
    ).toBe(true);
  });
  it('rejects unknown source keys instead of silently accepting a SKU rename', () => {
    const f = fixture();
    expect(variationMutationSchema.safeParse({ ...f.intent, renameSku: 'OTHER' }).success).toBe(
      false,
    );
  });
  it('accepts pure keeper rename with explicit false promotion flags without inventing a missing array', () => {
    const f = fixture();
    f.intent.tiers[0]!.name = 'Shade';
    f.context.promotionSnapshot = { error: '', response: { success_list: [{ item_id: 1234 }] } };
    const plan = ready(f);
    expect(
      inspectVariationMutationAcknowledgement(plan.steps[0]!, { error: '', request_id: 'ack-only' })
        .success,
    ).toBe(true);
    f.context.promotionSnapshot = undefined;
    expect(ready(f).steps).toHaveLength(1);
  });
  it.each([1, 2])(
    'explicitly collapses %i tiers with source price/stock and independently verifies item-level transfer',
    (count) => {
      const f = fixture(count);
      f.baseline.item.is_fulfillment_by_shopee = false;
      f.refresh();
      f.intent.replaceAllModels = true;
      f.intent.removedModelIds = f.intent.retained.map((m) => m.modelId);
      f.intent.retained = [];
      f.intent.tiers = [];
      f.intent.added = [
        {
          sku: 'SBX-VARIATION-REVIEW',
          tierIndex: [],
          originalPrice: 24000,
          stock: 6,
          locationId: null,
        },
      ];
      const plan = ready(f);
      expect(plan.steps[0]!.payload.tier_variation).toEqual([]);
      expect(plan.steps[0]!.payload.standardise_tier_variation).toEqual([]);
      const after = structuredClone(f.baseline);
      after.item.has_model = false;
      after.models = { model: [], tier_variation: [], standardise_tier_variation: [] };
      after.item.price_info = [{ currency: 'VND', original_price: 24000, current_price: 24000 }];
      after.item.stock_info_v2 = {
        seller_stock: [{ stock: 6, location_id: '' }],
        shopee_stock: [],
        summary_info: { total_reserved_stock: 0, total_available_stock: 6 },
      };
      expect(checkVariationMutationStage(plan, 0, f.baseline, after)).toEqual({
        verified: true,
        mismatchedPaths: [],
        addedModelBindings: [{ sku: 'SBX-VARIATION-REVIEW', modelId: '0', tierIndex: [] }],
      });
      (after.item.stock_info_v2 as any).seller_stock[0].stock = 7;
      expect(checkVariationMutationStage(plan, 0, f.baseline, after).verified).toBe(false);
    },
  );
  it('blocks collapse with an unsupported implicit parent SKU rewrite', () => {
    const f = fixture();
    f.intent.replaceAllModels = true;
    f.intent.removedModelIds = ['500', '501'];
    f.intent.retained = [];
    f.intent.tiers = [];
    f.intent.added = [
      { sku: 'NEW-PARENT-SKU', tierIndex: [], originalPrice: 12000, stock: 4, locationId: null },
    ];
    expect(planVariationMutation(f.intent, f.context)).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'SKU_TRANSFER_UNVERIFIED' }],
    });
  });
  it('verifies exact new model source fields and kept records after append, never adopting a partial response', () => {
    const f = fixture();
    f.intent.tiers[0]!.options.push({ name: 'Green', previousIndex: null, imageId: 'green-image' });
    f.intent.added = [
      { sku: 'NEW-GREEN', tierIndex: [2], originalPrice: 14000, stock: 8, locationId: null },
    ];
    const plan = ready(f);
    const beforeAdd = structuredClone(f.baseline);
    (beforeAdd.models.tier_variation[0] as any).option_list.push({
      option: 'Green',
      image: { image_id: 'green-image' },
    });
    (beforeAdd.models.standardise_tier_variation as any[])[0].variation_option_list.push({
      variation_option_id: 0,
      variation_option_name: 'Green',
      image_id: 'green-image',
    });
    expect(checkVariationMutationStage(plan, 0, f.baseline, beforeAdd).verified).toBe(true);
    const after = structuredClone(beforeAdd),
      newModel: any = structuredClone(f.baseline.models.model[0]);
    Object.assign(newModel, {
      model_id: 900,
      model_sku: 'NEW-GREEN',
      model_name: 'Green',
      tier_index: [2],
      price_info: [{ currency: 'VND', original_price: 14000, current_price: 14000 }],
      stock_info_v2: {
        seller_stock: [{ stock: 8 }],
        shopee_stock: [],
        summary_info: { total_reserved_stock: 0, total_available_stock: 8 },
      },
    });
    after.models.model.push(newModel);
    expect(checkVariationMutationStage(plan, 1, beforeAdd, after).verified).toBe(true);
    for (const bad of [
      'partial',
      'duplicate-id',
      'wrong-price',
      'wrong-stock',
      'wrong-image',
      'unknown-drift',
      'wrong-shipping',
      'unavailable',
    ] as const) {
      const wrong = structuredClone(after);
      const added: any = wrong.models.model[2];
      if (bad === 'partial') wrong.models.model.pop();
      if (bad === 'duplicate-id') added.model_id = 500;
      if (bad === 'wrong-price') added.price_info[0].original_price = 14001;
      if (bad === 'wrong-stock') added.stock_info_v2.seller_stock[0].stock = 9;
      if (bad === 'wrong-image')
        (wrong.item.promotion_image as any).image_id_list = ['different-cover'];
      if (bad === 'unknown-drift') (wrong.models.model[0]!.unknown as any).keep = {};
      if (bad === 'wrong-shipping') added.weight = '1';
      if (bad === 'unavailable') added.model_status = 'MODEL_UNAVAILABLE';
      expect(checkVariationMutationStage(plan, 1, beforeAdd, wrong).verified, bad).toBe(false);
    }
  });
  it('rejects mutated stage payload even when readback looks correct', () => {
    const f = fixture();
    f.intent.tiers[0]!.name = 'Shade';
    const plan = ready(f);
    plan.steps[0]!.payload.weight = 10;
    expect(checkVariationMutationStage(plan, 0, f.baseline, f.baseline)).toMatchObject({
      verified: false,
      mismatchedPaths: ['plan.fingerprint'],
    });
  });
  it('canonicalizes only the known empty default standardized-tier representation', () => {
    const f = fixture(0),
      absent = structuredClone(f.baseline);
    delete absent.models.standardise_tier_variation;
    expect(variationBaselineFingerprint(f.baseline)).toBe(variationBaselineFingerprint(absent));
    absent.models.standardise_tier_variation = [{}];
    expect(() => variationBaselineFingerprint(absent)).toThrow();
    const missingFlag = structuredClone(f.baseline);
    delete missingFlag.item.has_model;
    expect(() => variationBaselineFingerprint(missingFlag)).toThrow();
    const wrong = structuredClone(f.baseline);
    wrong.models.unrecognized = [];
    expect(variationBaselineFingerprint(wrong)).not.toBe(variationBaselineFingerprint(f.baseline));
  });
});
