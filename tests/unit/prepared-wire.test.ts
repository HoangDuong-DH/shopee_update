import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PreparedDocument, PreparedRemote } from '../../packages/domain/src/index.js';
import {
  PREPARED_CREATED_ITEM_ID,
  bindPreparedWireItem,
  inspectPreparedWireAcknowledgement,
  normalizePreparedWireSnapshot,
  planPreparedWireCreate,
  planPreparedWireUpdate,
  preparedWireMediaRequirements,
  type PreparedWireContext,
} from '../../packages/shopee/src/prepared-wire.js';

function fixture(tiers = 1) {
  const media = {
    importId: randomUUID(),
    sha256: 'a'.repeat(64),
    width: 900,
    height: 1200,
    mime: 'image/png',
  };
  const cover = { ...media, importId: randomUUID(), width: 1200 };
  const image = { ...cover, importId: randomUUID() };
  const document: PreparedDocument = {
    sourceKey: 'SOURCE',
    title: 'Sourced exact title',
    description: [{ type: 'text', text: 'Exact\n\ntext' }],
    cover,
    gallery: [media],
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
    categoryId: '700',
    brandId: '9',
    attributes: { '10': ['20'] },
    logistics: [{ channelId: '55', enabled: true }],
    weightGrams: 100,
    dimensionCm: { length: 10, width: 8, height: 4 },
    publication: 'unlisted',
  };
  const context: PreparedWireContext = {
    images: [
      { ...cover, role: 'cover', imageId: 'cover-id' },
      { ...media, role: 'gallery', imageId: 'gallery-id' },
      { ...image, role: 'variation', imageId: 'option-id' },
    ],
    brandName: 'Sourced brand',
    condition: 'NEW',
    preOrder: { is_pre_order: false },
    attributeList: [{ attribute_id: 10, attribute_value_list: [{ value_id: 20 }] }],
    stockLocationBySku: Object.fromEntries(document.models.map((m) => [m.sku, null])),
    capabilities: { gallery34: true, extendedDescription: true },
    channelInfoById: { '55': { fee_type: 'SIZE_INPUT', enabled: true, mask_channel_id: 0 } },
    promotionSnapshot: {
      error: '',
      response: { success_list: [{ item_id: 1234, promotion: [] }], failure_list: [] },
    },
    limits: {
      price_limit: { min_limit: 1, max_limit: 999999 },
      stock_limit: { min_limit: 0, max_limit: 999 },
      item_name_length_limit: { min_limit: 1, max_limit: 200 },
      item_image_count_limit: { min_limit: 1, max_limit: 9 },
      item_description_length_limit: { min_limit: 1, max_limit: 3000 },
      tier_variation_name_length_limit: { min_limit: 1, max_limit: 100 },
      tier_variation_option_length_limit: { min_limit: 1, max_limit: 100 },
      gtin_limit: { gtin_validation_rule: 'Optional' },
      size_chart_limit: { size_chart_mandatory: false },
    },
  };
  const remote: PreparedRemote = {
    itemId: '1234',
    document: structuredClone(document),
    modelBindings: document.models.map((m, i) => ({
      sku: m.sku,
      modelId: tiers ? String(50 + i) : '0',
      tierIndex: m.tierIndex,
    })),
    extra: {},
  };
  context.baseline = {
    item: {
      item_id: 1234,
      item_name: document.title,
      item_sku: tiers ? 'SOURCE' : 'SKU-0',
      has_model: tiers > 0,
      has_promotion: false,
      image: { image_id_list: ['gallery-id'], image_ratio: '3:4' },
      promotion_image: { image_id_list: ['cover-id'] },
      logistic_info: [{ logistic_id: 55, enabled: true, is_free: false }],
      price_info: [{ currency: 'VND', original_price: 10000, current_price: 10000 }],
      stock_info_v2: {
        seller_stock: [{ stock: 5 }],
        shopee_stock: [],
        summary_info: { total_reserved_stock: 0, total_available_stock: 5 },
      },
    },
    models: {
      model: tiers
        ? document.models.map((m, i) => ({
            model_id: 50 + i,
            model_sku: m.sku,
            tier_index: m.tierIndex,
            has_promotion: false,
            price_info: [
              {
                currency: 'VND',
                original_price: Number(m.originalPrice),
                current_price: Number(m.originalPrice),
              },
            ],
            stock_info_v2: {
              seller_stock: [{ stock: m.stock }],
              shopee_stock: [],
              summary_info: { total_reserved_stock: 0, total_available_stock: m.stock },
            },
            protected: { keep: [] },
          }))
        : [],
      tier_variation: document.tierNames.map((name, tier) => ({
        name,
        option_list: [...new Set(document.models.map((m) => m.optionLabels[tier]!))].map(
          (option) => ({ option, ...(tier === 0 ? { image: { image_id: 'option-id' } } : {}) }),
        ),
      })),
      standardise_tier_variation: document.tierNames.map((variation_name, tier) => ({
        variation_id: 0,
        variation_name,
        variation_option_list: [...new Set(document.models.map((m) => m.optionLabels[tier]!))].map(
          (variation_option_name) => ({
            variation_option_id: 0,
            variation_option_name,
            ...(tier === 0 ? { image_id: 'option-id' } : {}),
          }),
        ),
      })),
    },
  };
  return { document, context, remote };
}
function ready(plan: ReturnType<typeof planPreparedWireCreate>) {
  expect(plan.kind).toBe('ready');
  if (plan.kind !== 'ready') throw new Error(JSON.stringify(plan));
  return plan;
}
it.each(['CHƯA CÓ SKU', 'chua_co_sku', '  '])(
  'produces no wire steps for missing model SKU %j, including a directly supplied document',
  (sku) => {
    const { document, context } = fixture();
    document.models[0]!.sku = sku;
    context.stockLocationBySku[sku] = null;
    const before = structuredClone(document);
    const plan = planPreparedWireCreate(document, context);
    expect(plan).toEqual({
      kind: 'blocked',
      issues: [{ code: 'PREPARED_WIRE_MISSING_VARIANT_SKU', field: 'models.0.sku' }],
    });
    expect(document).toEqual(before);
  },
);
describe('prepared source to Shopee wire codec', () => {
  it('blocks a fulfillment channel ID even if the shop enables it', () => {
    const { document, context } = fixture();
    context.channelInfoById!['55']!.mask_channel_id = 5001;
    expect(planPreparedWireCreate(document, context)).toEqual({
      kind: 'blocked',
      issues: [{ code: 'PREPARED_WIRE_CHANNEL_NOT_PRODUCT_SELECTABLE', field: '55' }],
    });
  });
  it.each([0, 1, 2])(
    'plans %i tiers without changing SKU, integer original price or content',
    (tiers) => {
      const { document, context } = fixture(tiers);
      const plan = ready(planPreparedWireCreate(document, context));
      expect(plan.steps).toHaveLength(tiers ? 2 : 1);
      expect(plan.steps[0]!.payload).toMatchObject({
        item_name: document.title,
        item_status: 'UNLIST',
        original_price: 10000,
        description: document.description[0]!.type === 'text' ? document.description[0]!.text : '',
        image: { image_ratio: '3:4', image_id_list: ['gallery-id'] },
        promotion_images: { image_id_list: ['cover-id'] },
      });
      expect(plan.steps[0]!.payload.item_sku).toBe(tiers ? 'SOURCE' : 'SKU-0');
      if (tiers) {
        expect(plan.steps[1]!.payload.item_id).toBe(PREPARED_CREATED_ITEM_ID);
        expect(plan.steps[1]!.minDelayAfterCreateMs).toBe(5000);
        expect(bindPreparedWireItem(plan.steps[1]!, '1234').payload.item_id).toBe(1234);
      }
    },
  );
  it('blocks conflicting two-tier images rather than dropping per-SKU source images', () => {
    const { document, context } = fixture(2);
    document.models[1]!.image = document.gallery[0];
    expect(planPreparedWireCreate(document, context)).toMatchObject({
      kind: 'blocked',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'PREPARED_WIRE_OPTION_IMAGE_CONFLICT' }),
      ]),
    });
  });
  it('requires role-specific image resolution and preserves description blocks exactly', () => {
    const { document, context } = fixture();
    document.description.push(
      { type: 'image', image: document.gallery[0]! },
      { type: 'text', text: '\nEnd' },
    );
    expect(
      preparedWireMediaRequirements(document).some(
        (r) => r.role === 'description' && r.scene === 'desc',
      ),
    ).toBe(true);
    expect(planPreparedWireCreate(document, context).kind).toBe('blocked');
    context.images.push({ ...document.gallery[0]!, role: 'description', imageId: 'desc-id' });
    context.limits.extended_description_limit = {
      description_text_length_min: 1,
      description_text_length_max: 3000,
      description_image_num_min: 0,
      description_image_num_max: 9,
      description_image_width_min: 100,
      description_image_height_min: 100,
      description_image_aspect_ratio_min: 0.1,
      description_image_aspect_ratio_max: 10,
    };
    const plan = ready(planPreparedWireCreate(document, context));
    expect(plan.steps[0]!.payload.description_info).toEqual({
      extended_description: {
        field_list: [
          { field_type: 'text', text: 'Exact\n\ntext' },
          { field_type: 'image', image_info: { image_id: 'desc-id' } },
          { field_type: 'text', text: '\nEnd' },
        ],
      },
    });
  });
  it('uses plain text and skips description media when the shop does not support it', () => {
    const { document, context } = fixture();
    document.description.push(
      { type: 'image', image: document.gallery[0]! },
      { type: 'text', text: '\nEnd' },
    );
    context.capabilities.extendedDescription = false;
    context.descriptionMode = 'plain_fallback';
    const requirements = preparedWireMediaRequirements(document, { includeDescription: false });
    expect(requirements.some((entry) => entry.role === 'description')).toBe(false);
    const payload = ready(planPreparedWireCreate(document, context)).steps[0]!.payload;
    expect(payload.description_type).toBe('normal');
    expect(payload.description).toBe('Exact\n\ntext\nEnd');
    expect(payload.description_info).toBeUndefined();
  });
  it('rejects unsafe price and missing required business choices', () => {
    const { document, context } = fixture();
    document.models[0]!.originalPrice = '9007199254740992';
    expect(planPreparedWireCreate(document, context).kind).toBe('blocked');
    document.models[0]!.originalPrice = '10000';
    delete context.brandName;
    expect(planPreparedWireCreate(document, context).kind).toBe('blocked');
  });
  it('targets only selected model price and refuses hidden changes to unselected content', () => {
    const { remote, context } = fixture();
    const expected = structuredClone(remote);
    expected.document.models[1]!.originalPrice = '22222';
    const plan = ready(planPreparedWireUpdate(remote, expected, ['price'], ['SKU-1'], context));
    expect(plan.steps[0]!.payload).toEqual({
      item_id: 1234,
      price_list: [{ model_id: 51, original_price: 22222 }],
    });
    expected.document.title = 'Not selected';
    expect(planPreparedWireUpdate(remote, expected, ['price'], ['SKU-1'], context).kind).toBe(
      'blocked',
    );
  });
  it.each(['title', 'description', 'cover', 'gallery', 'attributes', 'logistics'] as const)(
    'serializes only the selected %s item group',
    (field) => {
      const { remote, context } = fixture();
      const expected = structuredClone(remote);
      if (field === 'title') expected.document.title = 'New exact title';
      if (field === 'description')
        expected.document.description = [{ type: 'text', text: 'New\n\nexact description' }];
      if (field === 'attributes') {
        expected.document.attributes = { '10': ['21'] };
        context.attributeList = [{ attribute_id: 10, attribute_value_list: [{ value_id: 21 }] }];
      }
      if (field === 'logistics') {
        expected.document.weightGrams = 200;
        expected.document.dimensionCm.length = 20;
      }
      if (field === 'cover' || field === 'gallery') {
        const media = structuredClone(
          field === 'cover' ? remote.document.cover : remote.document.gallery[0]!,
        );
        media.importId = randomUUID();
        context.images.push({ ...media, role: field, imageId: 'new-id' });
        if (field === 'cover') expected.document.cover = media;
        else expected.document.gallery = [media];
      }
      const plan = ready(planPreparedWireUpdate(remote, expected, [field], [], context));
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]!.path).toBe('/api/v2/product/update_item');
      const expectedPayload =
        field === 'title'
          ? { item_name: 'New exact title' }
          : field === 'description'
            ? { description_type: 'normal', description: 'New\n\nexact description' }
            : field === 'cover'
              ? { promotion_images: { image_id_list: ['new-id'] } }
              : field === 'gallery'
                ? {
                    image: { image_ratio: '3:4', image_id_list: ['new-id'] },
                    promotion_images: { image_id_list: ['cover-id'] },
                  }
                : field === 'attributes'
                  ? {
                      attribute_list: [
                        { attribute_id: 10, attribute_value_list: [{ value_id: 21 }] },
                      ],
                    }
                  : {
                      weight: 0.2,
                      dimension: { package_length: 20, package_width: 8, package_height: 4 },
                      logistic_info: [{ logistic_id: 55, enabled: true, is_free: false }],
                    };
      expect(plan.steps[0]!.payload).toEqual({ item_id: 1234, ...expectedPayload });
    },
  );
  it('preserves the new cover when gallery follows a selected cover update', () => {
    const { remote, context } = fixture();
    const expected = structuredClone(remote);
    expected.document.cover.importId = randomUUID();
    context.images.push({ ...expected.document.cover, role: 'cover', imageId: 'changed-cover' });
    const plan = ready(planPreparedWireUpdate(remote, expected, ['cover', 'gallery'], [], context));
    expect(plan.steps[1]!.payload.promotion_images.image_id_list).toEqual(['changed-cover']);
  });
  it('updates one seller stock location, enforces reservation, and does not touch another model', () => {
    const { remote, context } = fixture();
    const expected = structuredClone(remote);
    expected.document.models[1]!.stock = 9;
    context.stockLocationBySku['SKU-1'] = 'VN-WH';
    (context.baseline!.models.model[1]!.stock_info_v2 as any).seller_stock[0].location_id = 'VN-WH';
    const step = ready(planPreparedWireUpdate(remote, expected, ['stock'], ['SKU-1'], context))
      .steps[0]!;
    expect(step.payload).toEqual({
      item_id: 1234,
      stock_list: [{ model_id: 51, seller_stock: [{ stock: 9, location_id: 'VN-WH' }] }],
    });
    expect(
      inspectPreparedWireAcknowledgement(step, {
        error: '',
        request_id: 'req',
        response: {
          success_list: [{ model_id: 51, stock: 9, location_id: 'VN-WH' }],
          failure_list: [],
        },
      }).success,
    ).toBe(true);
    (context.baseline!.models.model[1]!.stock_info_v2 as any).summary_info.total_reserved_stock =
      10;
    expect(planPreparedWireUpdate(remote, expected, ['stock'], ['SKU-1'], context).kind).toBe(
      'blocked',
    );
  });
  it('uses model zero for an untiered stock update without inventing a variant', () => {
    const { remote, context } = fixture(0);
    const expected = structuredClone(remote);
    expected.document.models[0]!.stock = 8;
    expect(
      ready(planPreparedWireUpdate(remote, expected, ['stock'], ['SKU-0'], context)).steps[0]!
        .payload,
    ).toEqual({ item_id: 1234, stock_list: [{ model_id: 0, seller_stock: [{ stock: 8 }] }] });
  });
  it('updates first-tier images through update_tier_variation and preserves full option/model identities', () => {
    const { remote, context } = fixture();
    const expected = structuredClone(remote);
    expected.document.models[1]!.image = {
      ...expected.document.models[1]!.image!,
      importId: randomUUID(),
    };
    context.images.push({
      ...expected.document.models[1]!.image!,
      role: 'variation',
      imageId: 'new-option',
    });
    const step = ready(
      planPreparedWireUpdate(remote, expected, ['variationImages'], ['SKU-1'], context),
    ).steps[0]!;
    expect(step.path).toBe('/api/v2/product/update_tier_variation');
    expect(step.payload.model_list).toEqual([
      { model_id: 50, tier_index: [0] },
      { model_id: 51, tier_index: [1] },
    ]);
    expect(step.payload.standardise_tier_variation[0].variation_option_list).toEqual([
      { variation_option_id: 0, variation_option_name: '0', image_id: 'option-id' },
      { variation_option_id: 0, variation_option_name: '1', image_id: 'new-option' },
    ]);
  });
  it('blocks custom attribute IDs, unsafe dimensions, missing GTIN and logistics fee choices', () => {
    for (const change of [
      (d: PreparedDocument, c: PreparedWireContext) => {
        d.attributes = { '10': ['0'] };
      },
      (d: PreparedDocument) => {
        d.dimensionCm.width = 1.5;
      },
      (_d: PreparedDocument, c: PreparedWireContext) => {
        c.limits.gtin_limit.gtin_validation_rule = 'Mandatory';
      },
      (_d: PreparedDocument, c: PreparedWireContext) => {
        c.channelInfoById!['55']!.fee_type = 'CUSTOM_PRICE';
        delete c.baseline;
      },
    ]) {
      const { document, context } = fixture();
      change(document, context);
      expect(planPreparedWireCreate(document, context).kind).toBe('blocked');
    }
  });
  it('blocks promotion ambiguity and changed owner model bindings before price or stock', () => {
    const { remote, context } = fixture();
    const expected = structuredClone(remote);
    expected.document.models[1]!.originalPrice = '22222';
    context.baseline!.item.has_promotion = true;
    expect(planPreparedWireUpdate(remote, expected, ['price'], ['SKU-1'], context).kind).toBe(
      'blocked',
    );
    context.baseline!.item.has_promotion = false;
    context.baseline!.models.model[1]!.model_sku = 'WRONG';
    expect(planPreparedWireUpdate(remote, expected, ['price'], ['SKU-1'], context).kind).toBe(
      'blocked',
    );
  });
  it('does not infer price permission from false ongoing flags when upcoming detail is missing or present', () => {
    for (const detail of [
      undefined,
      { error: '', response: { success_list: [{ item_id: 1234 }] } },
      {
        error: '',
        response: {
          success_list: [{ item_id: 1234, promotion: [{ promotion_type: 'Flash Sale' }] }],
        },
      },
    ]) {
      const { remote, context } = fixture();
      context.promotionSnapshot = detail;
      const expected = structuredClone(remote);
      expected.document.models[0]!.originalPrice = '12345';
      expect(planPreparedWireUpdate(remote, expected, ['price'], ['SKU-0'], context)).toMatchObject(
        {
          kind: 'blocked',
          issues: [expect.objectContaining({ code: 'PREPARED_WIRE_PROMOTION_UNRESOLVED' })],
        },
      );
    }
  });
  it('requires complete acknowledgement coverage and exact acknowledged price', () => {
    const { remote, context } = fixture();
    const expected = structuredClone(remote);
    expected.document.models[1]!.originalPrice = '22222';
    const step = ready(planPreparedWireUpdate(remote, expected, ['price'], ['SKU-1'], context))
      .steps[0]!;
    expect(
      inspectPreparedWireAcknowledgement(step, {
        error: '',
        request_id: 'req',
        response: { success_list: [], failure_list: [] },
      }).success,
    ).toBe(false);
    expect(
      inspectPreparedWireAcknowledgement(step, {
        error: '',
        request_id: 'req',
        response: { success_list: [{ model_id: 51, original_price: 22222 }], failure_list: [] },
      }).success,
    ).toBe(true);
  });
  it('preserves resolved quantitative attribute names and units and rejects mismatched resolution', () => {
    const { document, context } = fixture();
    context.attributeList = [
      {
        attribute_id: 10,
        attribute_value_list: [{ value_id: 20, original_value_name: '100', value_unit: 'g' }],
      },
    ];
    expect(
      ready(planPreparedWireCreate(document, context)).steps[0]!.payload.attribute_list,
    ).toEqual(context.attributeList);
    context.attributeList[0]!.attribute_value_list[0]!.value_id = 21;
    expect(planPreparedWireCreate(document, context).kind).toBe('blocked');
  });
  it('keeps partial model outcomes and rejects missing, duplicate or foreign acknowledgement coverage', () => {
    const { remote, context } = fixture();
    const expected = structuredClone(remote);
    expected.document.models.forEach((m) => {
      m.stock += 1;
    });
    const step = ready(
      planPreparedWireUpdate(remote, expected, ['stock'], ['SKU-0', 'SKU-1'], context),
    ).steps[0]!;
    const partial = inspectPreparedWireAcknowledgement(step, {
      error: '',
      request_id: 'req',
      response: {
        success_list: [{ model_id: 50, stock: 6 }],
        failure_list: [{ model_id: 51, failed_reason: 'reserved' }],
      },
    });
    expect(partial).toMatchObject({
      success: false,
      kind: 'rejected',
      successModelIds: ['50'],
      failureModelIds: ['51'],
    });
    for (const list of [
      [{ model_id: 50, stock: 6 }],
      [
        { model_id: 50, stock: 6 },
        { model_id: 50, stock: 6 },
      ],
      [
        { model_id: 50, stock: 6 },
        { model_id: 99, stock: 7 },
      ],
    ])
      expect(
        inspectPreparedWireAcknowledgement(step, {
          error: '',
          request_id: 'req',
          response: { success_list: list, failure_list: [] },
        }).success,
      ).toBe(false);
    expect(inspectPreparedWireAcknowledgement(step, { error: '', request_id: 'req' }).success).toBe(
      false,
    );
  });
  it('does not acknowledge tier initialization without all source SKUs and tier bindings', () => {
    const { document, context } = fixture();
    const init = bindPreparedWireItem(
      ready(planPreparedWireCreate(document, context)).steps[1]!,
      '1234',
    );
    expect(
      inspectPreparedWireAcknowledgement(init, {
        error: '',
        request_id: 'req',
        response: { item_id: 1234 },
      }).success,
    ).toBe(false);
    expect(
      inspectPreparedWireAcknowledgement(init, {
        error: '',
        request_id: 'req',
        response: {
          item_id: 1234,
          model: [
            { model_id: 50, model_sku: 'SKU-0', tier_index: [0] },
            { model_id: 51, model_sku: 'SKU-1', tier_index: [1] },
          ],
        },
      }).success,
    ).toBe(true);
  });
  it('retains unknown protected fields and array/object distinctions in readback normalization', () => {
    const raw = {
      item: {
        item_id: 1234,
        has_model: false,
        update_time: 1,
        create_time: 1,
        image: { image_id_list: ['x'], image_url_list: ['url'] },
        protected: [],
      },
      models: { model: [], tier_variation: [] },
    };
    const before = normalizePreparedWireSnapshot(raw);
    const afterRaw = structuredClone(raw);
    afterRaw.item.update_time = 2;
    expect(normalizePreparedWireSnapshot(afterRaw)).toEqual(before);
    (afterRaw.item as any).protected = {};
    expect(normalizePreparedWireSnapshot(afterRaw)).not.toEqual(before);
    afterRaw.item.create_time = 2;
    expect(normalizePreparedWireSnapshot(afterRaw)).not.toEqual(before);
  });
});
