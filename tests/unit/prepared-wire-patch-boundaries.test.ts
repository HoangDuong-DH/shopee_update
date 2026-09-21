import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  PreparedDocument,
  PreparedField,
  PreparedMedia,
  PreparedRemote,
} from '../../packages/domain/src/index.js';
import {
  inspectPreparedWireAcknowledgement,
  planPreparedWireUpdate,
  type PreparedWireContext,
  type PreparedWirePlan,
} from '../../packages/shopee/src/prepared-wire.js';
import { checkPreparedWireUpdate } from '../../packages/shopee/src/prepared-wire-qc.js';

// Independent source + readback fixture: named red/blue, S/L combinations and nonsequential IDs.
// Desired raw outcomes below are constructed from business assertions, never echoed from a request.
function fixture(tiers = 2) {
  const media = (square: boolean): PreparedMedia => ({
    importId: randomUUID(),
    sha256: 'a'.repeat(64),
    width: square ? 1200 : 900,
    height: 1200,
    mime: 'image/png',
  });
  const cover = media(true),
    gallery = media(false),
    red = media(true),
    blue = media(true);
  const document: PreparedDocument = {
    sourceKey: 'PATCH-REVIEW',
    title: 'Đúng nguồn – bìa và phân loại',
    description: [{ type: 'text', text: 'Giữ nguyên\n\nnội dung.' }],
    cover,
    gallery: [gallery],
    categoryId: '700',
    brandId: '9',
    attributes: {},
    logistics: [{ channelId: '55', enabled: true }],
    weightGrams: 120,
    dimensionCm: { length: 12, width: 8, height: 4 },
    publication: 'unlisted',
    tierNames: ['Màu', 'Cỡ'].slice(0, tiers),
    models: Array.from({ length: tiers ? 2 ** tiers : 1 }, (_, i) => ({
      sku: `SOURCE-SKU-${i}`,
      tierIndex: tiers === 2 ? [Math.floor(i / 2), i % 2] : tiers ? [i] : [],
      optionLabels:
        tiers === 2
          ? [['Đỏ', 'Xanh'][Math.floor(i / 2)]!, ['S', 'L'][i % 2]!]
          : tiers
            ? [['Đỏ', 'Xanh'][i]!]
            : [],
      originalPrice: String(10000 + i * 1000),
      stock: 7 + i,
      ...(tiers ? { image: (tiers === 2 ? Math.floor(i / 2) : i) === 0 ? red : blue } : {}),
    })),
  };
  const ids = [71, 54, 88, 63];
  const remote: PreparedRemote = {
    itemId: '1234',
    document,
    modelBindings: document.models.map((m, i) => ({
      sku: m.sku,
      modelId: tiers ? String(ids[i]) : '0',
      tierIndex: [...m.tierIndex],
    })),
    extra: { sourceBoundary: { keep: [] } },
  };
  const price = (p: string) => [
    {
      currency: 'VND',
      original_price: Number(p),
      current_price: Number(p),
      inflated_price_of_original_price: Number(p),
      inflated_price_of_current_price: Number(p),
    },
  ];
  const stock = (n: number) => ({
    seller_stock: [{ stock: n }],
    shopee_stock: [],
    summary_info: { total_reserved_stock: 0, total_available_stock: n },
  });
  const context: PreparedWireContext = {
    images: [
      { ...cover, role: 'cover', imageId: 'cover-square' },
      { ...gallery, role: 'gallery', imageId: 'gallery-portrait' },
      { ...red, role: 'variation', imageId: 'red-square' },
      { ...blue, role: 'variation', imageId: 'blue-square' },
    ],
    stockLocationBySku: Object.fromEntries(document.models.map((m) => [m.sku, null])),
    capabilities: { gallery34: true, extendedDescription: true },
    limits: {
      price_limit: { min_limit: 1000, max_limit: 100000 },
      item_image_count_limit: { min_limit: 1, max_limit: 9 },
      item_name_length_limit: { min_limit: 1, max_limit: 200 },
      item_description_length_limit: { min_limit: 1, max_limit: 3000 },
    },
    promotionSnapshot: {
      error: '',
      response: { success_list: [{ item_id: 1234, promotion: [] }], failure_list: [] },
    },
    baseline: {
      item: {
        item_id: 1234,
        item_sku: tiers ? document.sourceKey : document.models[0]!.sku,
        item_name: document.title,
        has_model: tiers > 0,
        has_promotion: false,
        image: { image_id_list: ['gallery-portrait'], image_ratio: '3:4' },
        promotion_image: { image_id_list: ['cover-square'], image_ratio: '1:1' },
        description_type: 'normal',
        description: 'Giữ nguyên\n\nnội dung.',
        unknown: { exact: [] },
        ...(tiers ? {} : { price_info: price('10000'), stock_info_v2: stock(7) }),
      },
      models: {
        model: tiers
          ? document.models
              .map((m, i) => ({
                model_id: ids[i],
                model_sku: m.sku,
                tier_index: m.tierIndex,
                price_info: price(m.originalPrice),
                stock_info_v2: stock(m.stock),
                has_promotion: false,
                promotion_id: 0,
                unknown: { exact: [] },
              }))
              .reverse()
          : [],
        tier_variation: document.tierNames.map((name, t) => ({
          name,
          option_list: (t === 0 ? ['Đỏ', 'Xanh'] : ['S', 'L']).map((option, i) => ({
            option,
            ...(t === 0 ? { image: { image_id: i === 0 ? 'red-square' : 'blue-square' } } : {}),
          })),
        })),
        standardise_tier_variation: document.tierNames.map((variation_name, t) => ({
          variation_id: 0,
          variation_name,
          variation_option_list: (t === 0 ? ['Đỏ', 'Xanh'] : ['S', 'L']).map(
            (variation_option_name, i) => ({
              variation_option_id: 0,
              variation_option_name,
              ...(t === 0 ? { image_id: i === 0 ? 'red-square' : 'blue-square' } : {}),
            }),
          ),
        })),
      },
    },
  };
  const expected = structuredClone(remote);
  const plan = (fields: PreparedField[], selected: string[] = []) =>
    planPreparedWireUpdate(remote, expected, fields, selected, context);
  const addImage = (
    role: 'cover' | 'gallery' | 'variation',
    imageId: string,
    square = role !== 'gallery',
  ) => {
    const image = media(square);
    context.images.push({ ...image, role, imageId });
    return image;
  };
  return { remote, expected, context, plan, addImage };
}
function ready(plan: PreparedWirePlan) {
  expect(plan.kind, JSON.stringify(plan)).toBe('ready');
  if (plan.kind !== 'ready') throw new Error('blocked');
  return plan;
}
const sku = (i: number) => `SOURCE-SKU-${i}`;

describe('prepared patch boundary matrix', () => {
  it.each([
    ['cover', 'gallery'],
    ['gallery', 'cover'],
  ] as PreparedField[][])('preserves the correct intermediate cover for order %j', (...args) => {
    const fields = args as PreparedField[];
    const f = fixture();
    f.expected.document.cover = f.addImage('cover', 'new-cover');
    f.expected.document.gallery = [f.addImage('gallery', 'new-gallery')];
    const plan = ready(f.plan(fields));
    const after = structuredClone(f.context.baseline!);
    (after.item.promotion_image as any).image_id_list = ['new-cover'];
    (after.item.image as any).image_id_list = ['new-gallery'];
    expect(checkPreparedWireUpdate(f.context.baseline!, after, plan.steps).verified).toBe(true);
    const galleryStep = plan.steps.find((s) => s.group === 'gallery')!;
    expect(galleryStep.payload.promotion_images.image_id_list).toEqual([
      fields[0] === 'cover' ? 'new-cover' : 'cover-square',
    ]);
  });
  it.each(['cover', 'gallery'] as const)(
    'rejects %s media resolved only under another role',
    (group) => {
      const f = fixture();
      const wrong = f.addImage(group === 'cover' ? 'variation' : 'cover', 'wrong-role');
      if (group === 'cover') f.expected.document.cover = wrong;
      else f.expected.document.gallery = [wrong];
      expect(f.plan([group]).kind).toBe('blocked');
    },
  );
  it.each(['cover', 'gallery'] as const)(
    'rejects %s media with the wrong source ratio',
    (group) => {
      const f = fixture();
      const wrong = f.addImage(group, 'wrong-ratio', group === 'gallery');
      if (group === 'cover') f.expected.document.cover = wrong;
      else f.expected.document.gallery = [wrong];
      expect(f.plan([group]).kind).toBe('blocked');
    },
  );
  it('does not infer separate cover support for a 1:1 baseline', () => {
    const f = fixture();
    (f.context.baseline!.item.image as any).image_ratio = '1:1';
    f.expected.document.cover = f.addImage('cover', 'new-cover');
    expect(f.plan(['cover']).kind).toBe('blocked');
  });
  it('blocks planning a portrait transition even when it explicitly requests the old square cover', () => {
    const f = fixture();
    const before = f.context.baseline!;
    (before.item.image as any).image_ratio = '1:1';
    (before.item.image as any).image_id_list = ['cover-square', 'old-square'];
    f.expected.document.gallery = [f.addImage('gallery', 'new-portrait')];
    expect(f.plan(['gallery'])).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'PREPARED_WIRE_COVER_BASELINE_REQUIRED', field: 'promotion_image' }],
    });
  });
  it('rejects saved live portrait-transition evidence that replaced the notebook cover with the first gallery card', () => {
    const live = JSON.parse(
      readFileSync(
        'tests/fixtures/prepared-wire-portrait-cover-live.json',
        'utf8',
      ),
    );
    expect(live.before.item.image.image_ratio).toBe('1:1');
    expect(live.after.item.image.image_ratio).toBe('3:4');
    expect(live.steps[0].payload.promotion_images.image_id_list).toEqual(
      live.before.item.promotion_image.image_id_list,
    );
    expect(live.after.item.promotion_image.image_id_list).not.toEqual(
      live.before.item.promotion_image.image_id_list,
    );
    expect(live.provenance.beforePixelSha256).not.toBe(live.provenance.afterPixelSha256);
    expect(checkPreparedWireUpdate(live.before, live.after, live.steps)).toEqual({
      verified: false,
      mismatchedPaths: ['item.promotion_image.image_id_list.0'],
    });
  });
  it('blocks a portrait transition when the old cover does not match the first square image', () => {
    const f = fixture();
    (f.context.baseline!.item.image as any).image_ratio = '1:1';
    f.expected.document.gallery = [f.addImage('gallery', 'new-portrait')];
    expect(f.plan(['gallery']).kind).toBe('blocked');
  });
  it('requires an explicit preserved cover in transition QC and rejects the reverse transition', () => {
    const f = fixture(),
      before = f.context.baseline!,
      after = structuredClone(before);
    (before.item.image as any).image_ratio = '1:1';
    (before.item.image as any).image_id_list = ['cover-square'];
    (after.item.image as any).image_id_list = ['new-portrait'];
    const step = {
      method: 'POST' as const,
      path: '/api/v2/product/update_item' as const,
      group: 'gallery' as const,
      payload: { item_id: 1234, image: { image_id_list: ['new-portrait'], image_ratio: '3:4' } },
    };
    expect(checkPreparedWireUpdate(before, after, [step]).verified).toBe(false);
    const reverse = {
      ...step,
      payload: {
        item_id: 1234,
        image: { image_id_list: ['cover-square'], image_ratio: '1:1' },
        promotion_images: { image_id_list: ['cover-square'] },
      },
    };
    expect(checkPreparedWireUpdate(after, before, [reverse]).verified).toBe(false);
  });
  it('protects a cover even if Shopee returns a visually equivalent replacement ID', () => {
    const f = fixture();
    f.expected.document.gallery = [f.addImage('gallery', 'new-gallery')];
    const plan = ready(f.plan(['gallery']));
    const after = structuredClone(f.context.baseline!);
    (after.item.image as any).image_id_list = ['new-gallery'];
    (after.item.promotion_image as any).image_id_list = ['alias-cover'];
    expect(checkPreparedWireUpdate(f.context.baseline!, after, plan.steps).verified).toBe(false);
  });
  it('rejects conflicting per-SKU image updates inside one shared first-tier option', () => {
    const f = fixture();
    f.expected.document.models[0]!.image = f.addImage('variation', 'new-red');
    expect(f.plan(['variationImages'], [sku(0)]).kind).toBe('blocked');
  });
  it('updates all selected SKUs sharing the red option and preserves the blue option', () => {
    const f = fixture(),
      replacement = f.addImage('variation', 'new-red');
    f.expected.document.models[0]!.image = replacement;
    f.expected.document.models[1]!.image = replacement;
    const plan = ready(f.plan(['variationImages'], [sku(0), sku(1)]));
    const after = structuredClone(f.context.baseline!);
    (after.models.tier_variation[0] as any).option_list[0].image.image_id = 'new-red';
    (after.models.standardise_tier_variation as any[])[0]!.variation_option_list[0].image_id =
      'new-red';
    expect(checkPreparedWireUpdate(f.context.baseline!, after, plan.steps).verified).toBe(true);
    (after.models.standardise_tier_variation as any[])[0]!.variation_option_list[1].image_id =
      'changed-blue';
    expect(checkPreparedWireUpdate(f.context.baseline!, after, plan.steps).verified).toBe(false);
  });
  it('supports unchanged standard variation_group_id while changing images', () => {
    const f = fixture(1);
    (f.context.baseline!.models.standardise_tier_variation as any[])[0]!.variation_group_id = 42;
    f.expected.document.models[0]!.image = f.addImage('variation', 'new-red');
    const plan = ready(f.plan(['variationImages'], [sku(0)]));
    const after = structuredClone(f.context.baseline!);
    (after.models.tier_variation[0] as any).option_list[0].image.image_id = 'new-red';
    (after.models.standardise_tier_variation as any[])[0]!.variation_option_list[0].image_id =
      'new-red';
    expect(checkPreparedWireUpdate(f.context.baseline!, after, plan.steps).verified).toBe(true);
    plan.steps[0]!.payload.standardise_tier_variation[0].variation_group_id = 43;
    (after.models.standardise_tier_variation as any[])[0]!.variation_group_id = 43;
    expect(checkPreparedWireUpdate(f.context.baseline!, after, plan.steps).verified).toBe(false);
    delete plan.steps[0]!.payload.standardise_tier_variation[0].variation_group_id;
    (after.models.standardise_tier_variation as any[])[0]!.variation_group_id = 42;
    expect(checkPreparedWireUpdate(f.context.baseline!, after, plan.steps).verified).toBe(false);
  });
  it.each([
    'rename-tier',
    'rename-option',
    'reorder-tiers',
    'reorder-models',
    'add-tier',
    'remove-tier',
    'add-sku',
    'remove-sku',
    'rename-sku',
  ] as const)(
    'blocks unsupported structure mutation %s instead of disguising it as image changes',
    (change) => {
      const f = fixture(),
        d = f.expected.document;
      if (change === 'rename-tier') d.tierNames[0] = 'Other';
      if (change === 'rename-option') d.models[0]!.optionLabels[0] = 'Other';
      if (change === 'reorder-tiers') d.tierNames.reverse();
      if (change === 'reorder-models') d.models.reverse();
      if (change === 'add-tier') d.tierNames.push('Extra');
      if (change === 'remove-tier') d.tierNames.pop();
      if (change === 'add-sku') d.models.push({ ...structuredClone(d.models[0]!), sku: 'ADDED' });
      if (change === 'remove-sku') d.models.pop();
      if (change === 'rename-sku') d.models[0]!.sku = 'RENAMED';
      expect(f.plan(['variationImages'], [sku(0)]).kind).toBe('blocked');
    },
  );
  it('blocks variation writes when raw readback contains an unbound extra model', () => {
    const f = fixture();
    // Local source/bindings know red-S, red-L, blue-S. Raw remote also contains blue-L.
    // Both sources have valid 2x2 option definitions; only the remote model coverage differs.
    f.remote.document.models.pop();
    f.expected.document.models.pop();
    f.remote.modelBindings.pop();
    f.expected.modelBindings.pop();
    const replacement = f.addImage('variation', 'new-red');
    f.expected.document.models[0]!.image = replacement;
    f.expected.document.models[1]!.image = replacement;
    expect(f.plan(['variationImages'], [sku(0), sku(1)]).kind).toBe('blocked');
  });
  it.each(['0', '-1', '12.5', '1e4', '9007199254740992', '999', '100001'])(
    'blocks invalid/out-of-metadata VN original price %s',
    (value) => {
      const f = fixture();
      f.expected.document.models[0]!.originalPrice = value;
      expect(f.plan(['price'], [sku(0)]).kind).toBe('blocked');
    },
  );
  it.each(['1000', '100000'])(
    'accepts exact reported price boundary %s without rounding or promotion math',
    (value) => {
      const f = fixture();
      f.expected.document.models[0]!.originalPrice = value;
      const plan = ready(f.plan(['price'], [sku(0)]));
      expect(plan.steps[0]!.payload.price_list).toEqual([
        { model_id: 71, original_price: Number(value) },
      ]);
    },
  );
  it.each([
    'missing',
    'upcoming',
    'ongoing',
    'wrong-item',
    'partial-detail',
    'omitted-promotion',
    'item-flag',
    'model-flag',
  ] as const)('blocks ambiguous price promotion evidence: %s', (kind) => {
    const f = fixture();
    f.expected.document.models[0]!.originalPrice = '15000';
    const p = f.context.promotionSnapshot as any;
    if (kind === 'missing') delete f.context.promotionSnapshot;
    if (kind === 'upcoming' || kind === 'ongoing')
      p.response.success_list[0].promotion.push({
        promotion_type: 'Discount',
        start_time: kind === 'upcoming' ? 9999999999 : 1,
      });
    if (kind === 'wrong-item') p.response.success_list[0].item_id = 9999;
    if (kind === 'partial-detail')
      p.response.failure_list.push({ item_id: 1234, failed_reason: 'unavailable' });
    if (kind === 'omitted-promotion') delete p.response.success_list[0].promotion;
    if (kind === 'item-flag') f.context.baseline!.item.has_promotion = true;
    if (kind === 'model-flag')
      f.context.baseline!.models.model.find((m) => m.model_id === 71)!.has_promotion = true;
    expect(f.plan(['price'], [sku(0)]).kind).toBe('blocked');
  });
  it('does not apply a wholesale ratio limit as an unrelated inter-SKU price ratio', () => {
    const f = fixture();
    f.context.limits.wholesale_price_threshold_percentage = { min_limit: 30, max_limit: 100 };
    f.expected.document.models[0]!.originalPrice = '100000';
    expect(f.plan(['price'], [sku(0)]).kind).toBe('ready');
  });
  it('blocks price changes that violate a present wholesale ratio constraint', () => {
    const f = fixture(0);
    f.context.baseline!.item.wholesales = [{ min_count: 2, max_count: 10, unit_price: 8000 }];
    f.context.limits.wholesale_price_threshold_percentage = { min_limit: 30, max_limit: 100 };
    f.expected.document.models[0]!.originalPrice = '50000';
    expect(f.plan(['price'], [sku(0)]).kind).toBe('blocked');
    delete f.context.limits.wholesale_price_threshold_percentage;
    expect(f.plan(['price'], [sku(0)])).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'PREPARED_WIRE_WHOLESALE_PRICE_UNSUPPORTED', field: 'wholesales' }],
    });
    f.context.baseline!.item.wholesales = [];
    expect(f.plan(['price'], [sku(0)]).kind).toBe('ready');
  });
  it('ignores an undocumented singular wholesale key on the readback', () => {
    const f = fixture(0);
    f.context.baseline!.item.wholesale = [{ min_count: 2, max_count: 10, unit_price: 8000 }];
    f.expected.document.models[0]!.originalPrice = '50000';
    expect(f.plan(['price'], [sku(0)]).kind).toBe('ready');
  });
  it('preserves partial price failure identities and never treats incomplete acknowledgement as verified', () => {
    const f = fixture();
    f.expected.document.models[0]!.originalPrice = '15000';
    f.expected.document.models[2]!.originalPrice = '16000';
    const step = ready(f.plan(['price'], [sku(0), sku(2)])).steps[0]!;
    const ack = inspectPreparedWireAcknowledgement(step, {
      error: '',
      request_id: 'review',
      response: {
        success_list: [{ model_id: 71, original_price: 15000 }],
        failure_list: [{ model_id: 88, failed_reason: 'promotion lock' }],
      },
    });
    expect(ack).toMatchObject({
      success: false,
      kind: 'rejected',
      successModelIds: ['71'],
      failureModelIds: ['88'],
    });
    const after = structuredClone(f.context.baseline!),
      model = after.models.model.find((m) => m.model_id === 71)! as any;
    for (const field of [
      'original_price',
      'current_price',
      'inflated_price_of_original_price',
      'inflated_price_of_current_price',
    ])
      model.price_info[0][field] = 15000;
    expect(checkPreparedWireUpdate(f.context.baseline!, after, [step]).verified).toBe(false);
  });
  it('protects unknown raw fields in unselected models despite correct selected price values', () => {
    const f = fixture();
    f.expected.document.models[0]!.originalPrice = '15000';
    const plan = ready(f.plan(['price'], [sku(0)])),
      after = structuredClone(f.context.baseline!);
    const selected = after.models.model.find((m) => m.model_id === 71)! as any;
    for (const field of [
      'original_price',
      'current_price',
      'inflated_price_of_original_price',
      'inflated_price_of_current_price',
    ])
      selected.price_info[0][field] = 15000;
    expect(checkPreparedWireUpdate(f.context.baseline!, after, plan.steps).verified).toBe(true);
    (after.models.model.find((m) => m.model_id === 88)!.unknown as any).exact = {};
    expect(checkPreparedWireUpdate(f.context.baseline!, after, plan.steps).verified).toBe(false);
  });
});
