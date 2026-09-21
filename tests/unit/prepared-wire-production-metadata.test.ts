import { describe, expect, it } from 'vitest';
import type { PreparedDocument } from '../../packages/domain/src/index.js';
import {
  planPreparedWireCreate,
  type PreparedWireContext,
} from '../../packages/shopee/src/prepared-wire.js';

// Pure codec fixtures, no network, secrets, real listing text or production capability claim.
// Shape/limits: category101128 get_item_limit and channel5001 read on 2026-09-15;
// request e3e3e7f35b7e4da1298cb9759e01cd00. Docs: Creating product211 (2025-09-19),
// add_item (2026-09-01), get_channel_list (2026-05-22). Array rules remain supported.
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
    sourceKey: 'PURE-CODEC-FIXTURE',
    title: 'Prepared room fragrance fixture',
    description: [{ type: 'text', text: 'Original content and spacing. '.repeat(5) }],
    cover,
    gallery: [gallery],
    tierNames: [],
    models: [
      { sku: 'FIXTURE-SKU', tierIndex: [], optionLabels: [], originalPrice: '235998', stock: 100 },
    ],
    categoryId: '101128',
    brandId: '1252097',
    attributes: {},
    logistics: [{ channelId: '5001', enabled: true }],
    weightGrams: 500,
    dimensionCm: { length: 12, width: 12, height: 28 },
    publication: 'unlisted',
  };
  const context: PreparedWireContext = {
    images: [
      { ...cover, role: 'cover', imageId: 'fixture-cover' },
      { ...gallery, role: 'gallery', imageId: 'fixture-gallery' },
    ],
    brandName: 'VINA TƯƠI',
    condition: 'NEW',
    preOrder: { is_pre_order: false, days_to_ship: 2 },
    stockLocationBySku: { 'FIXTURE-SKU': null },
    capabilities: { gallery34: true, extendedDescription: false },
    channelInfoById: {
      '5001': {
        logistics_channel_id: 5001,
        logistics_channel_name: 'Nhanh',
        enabled: true,
        fee_type: 'SIZE_INPUT',
        force_enable: false,
        mask_channel_id: 0,
        support_pause: false,
        compulsory_channel: false,
        weight_limit: { item_min_weight: 0, item_max_weight: 10 },
        item_max_dimension: { length: 200, width: 200, height: 200, unit: 'cm', dimension_sum: 0 },
        volume_limit: { item_min_volume: 0, item_max_volume: 0 },
      },
    },
    limits: {
      price_limit: { min_limit: 1000, max_limit: 120000000 },
      stock_limit: { min_limit: 0, max_limit: 10000000 },
      item_name_length_limit: { min_limit: 20, max_limit: 120 },
      item_image_count_limit: { min_limit: 1, max_limit: 9 },
      item_description_length_limit: { min_limit: 100, max_limit: 5000 },
      gtin_limit: { gtin_validation_rule: 'Optional' },
      size_chart_limit: { size_chart_mandatory: false },
    },
  };
  return { document, context };
}
function createPayload(document: PreparedDocument, context: PreparedWireContext) {
  const result = planPreparedWireCreate(document, context);
  expect(result.kind, JSON.stringify(result)).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected ready plan');
  return result.steps[0]!.payload;
}
function blocked(document: PreparedDocument, context: PreparedWireContext, code: string) {
  expect(planPreparedWireCreate(document, context)).toMatchObject({
    kind: 'blocked',
    issues: expect.arrayContaining([expect.objectContaining({ code })]),
  });
}

describe('official custom attribute values', () => {
  it('keeps value_id0 custom text and quantitative unit without trimming or source rewriting', () => {
    const { document, context } = fixture();
    document.attributes = { '100025': ['0'], '100248': ['0'] };
    context.attributeList = [
      {
        attribute_id: 100025,
        attribute_value_list: [{ value_id: 0, original_value_name: '  Ngọc Lan Tây  ' }],
      },
      {
        attribute_id: 100248,
        attribute_value_list: [{ value_id: 0, original_value_name: '5', value_unit: 'L' }],
      },
    ];
    const before = JSON.stringify({ document, context });
    expect(createPayload(document, context).attribute_list).toEqual([
      {
        attribute_id: 100025,
        attribute_value_list: [{ value_id: 0, original_value_name: '  Ngọc Lan Tây  ' }],
      },
      {
        attribute_id: 100248,
        attribute_value_list: [{ value_id: 0, original_value_name: '5', value_unit: 'L' }],
      },
    ]);
    expect(JSON.stringify({ document, context })).toBe(before);
  });
  it.each([undefined, '', '   '])('rejects custom0 without substantive source text: %s', (name) => {
    const { document, context } = fixture();
    document.attributes = { '100025': ['0'] };
    context.attributeList = [
      {
        attribute_id: 100025,
        attribute_value_list: [
          { value_id: 0, ...(name === undefined ? {} : { original_value_name: name }) },
        ],
      },
    ];
    expect(planPreparedWireCreate(document, context).kind).toBe('blocked');
  });
  it('does not permit a resolved custom0 to replace a different source-selected value', () => {
    const { document, context } = fixture();
    document.attributes = { '100025': ['871'] };
    context.attributeList = [
      {
        attribute_id: 100025,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Other scent' }],
      },
    ];
    blocked(document, context, 'PREPARED_WIRE_ATTRIBUTE_SELECTION_MISMATCH');
  });
  it('still rejects duplicate source identity0 instead of ambiguously merging custom values', () => {
    const { document, context } = fixture();
    document.attributes = { '100025': ['0', '0'] };
    context.attributeList = [
      {
        attribute_id: 100025,
        attribute_value_list: [
          { value_id: 0, original_value_name: 'Scent A' },
          { value_id: 0, original_value_name: 'Scent B' },
        ],
      },
    ];
    blocked(document, context, 'PREPARED_WIRE_ATTRIBUTE_INVALID');
  });
});

describe('live object and documented array channel relation rules', () => {
  it.each(['object', 'array'])('accepts empty %s rule and preserves original metadata', (shape) => {
    const { document, context } = fixture();
    const rule = {
      related_enabled_channels: [],
      related_disabled_channels: [],
      related_dependent_block_channels: [],
    };
    context.channelInfoById!['5001']!.channel_relation_rules = shape === 'array' ? [rule] : rule;
    const before = JSON.stringify(context);
    expect(createPayload(document, context).logistic_info).toEqual([
      { logistic_id: 5001, enabled: true },
    ]);
    expect(JSON.stringify(context)).toBe(before);
  });
  it.each(['object', 'array'])(
    'does not silently enable an unselected dependent channel in %s rules',
    (shape) => {
      const { document, context } = fixture();
      const rule = {
        related_enabled_channels: [50053],
        related_disabled_channels: [],
        related_dependent_block_channels: [],
      };
      context.channelInfoById!['5001']!.channel_relation_rules = shape === 'array' ? [rule] : rule;
      blocked(document, context, 'PREPARED_WIRE_LOGISTICS_RELATED_CHANNEL_REQUIRED');
    },
  );
  it('rejects an enabled source channel that conflicts with related_disabled_channels', () => {
    const { document, context } = fixture();
    context.channelInfoById!['5001']!.channel_relation_rules = {
      related_enabled_channels: [],
      related_disabled_channels: [5001],
      related_dependent_block_channels: [],
    };
    blocked(document, context, 'PREPARED_WIRE_LOGISTICS_RELATED_CHANNEL_MUST_BE_DISABLED');
  });
  it('does not disable a parent while one of its dependent channels remains enabled', () => {
    const { document, context } = fixture();
    document.logistics.push({ channelId: '50053', enabled: false });
    context.channelInfoById!['50053'] = {
      fee_type: 'SIZE_INPUT',
      enabled: true,
      channel_relation_rules: {
        related_enabled_channels: [],
        related_disabled_channels: [],
        related_dependent_block_channels: [5001],
      },
    };
    blocked(document, context, 'PREPARED_WIRE_LOGISTICS_DEPENDENT_CHANNEL_MUST_BE_DISABLED');
  });
  it.each([
    null,
    'invalid',
    [null],
    { related_enabled_channels: '50053' },
    { related_enabled_channels: [0] },
    { related_enabled_channels: ['50053'] },
    { related_enabled_channels: [50053, 50053] },
    { new_rule: [50053] },
  ])('keeps malformed/unknown channel rules blocked: %j', (rule) => {
    const { document, context } = fixture();
    context.channelInfoById!['5001']!.channel_relation_rules = rule;
    blocked(document, context, 'PREPARED_WIRE_LOGISTICS_RELATION_UNVERIFIED');
  });
});

describe('category with both size chart mechanisms unsupported', () => {
  it('allows explicit both-false support without inventing a size_chart_mandatory property', () => {
    const { document, context } = fixture();
    context.limits.size_chart_limit = {
      support_image_size_chart: false,
      support_template_size_chart: false,
    };
    const before = JSON.stringify(context.limits);
    const payload = createPayload(document, context);
    expect(payload).not.toHaveProperty('size_chart_info');
    expect(context.limits.size_chart_limit).not.toHaveProperty('size_chart_mandatory');
    expect(JSON.stringify(context.limits)).toBe(before);
  });
  it.each([
    undefined,
    null,
    {},
    { support_image_size_chart: false },
    { support_template_size_chart: false },
    { support_image_size_chart: false, support_template_size_chart: true },
    { support_image_size_chart: false, support_template_size_chart: 'false' },
    {
      support_image_size_chart: false,
      support_template_size_chart: false,
      size_chart_mandatory: true,
    },
    {
      support_image_size_chart: false,
      support_template_size_chart: false,
      size_chart_mandatory: null,
    },
  ])('keeps missing, conflicting or mandatory chart evidence blocked: %j', (limit) => {
    const { document, context } = fixture();
    context.limits.size_chart_limit = limit;
    blocked(document, context, 'PREPARED_WIRE_SIZE_CHART_UNVERIFIED');
  });
  it('accepts combined real metadata shapes without treating them as media capability proof', () => {
    const { document, context } = fixture();
    context.limits.size_chart_limit = {
      support_image_size_chart: false,
      support_template_size_chart: false,
    };
    context.channelInfoById!['5001']!.channel_relation_rules = {
      related_enabled_channels: [],
      related_disabled_channels: [],
      related_dependent_block_channels: [],
    };
    document.attributes = { '100025': ['0'] };
    context.attributeList = [
      {
        attribute_id: 100025,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Ngọc Lan Tây' }],
      },
    ];
    expect(createPayload(document, context).seller_stock).toEqual([{ stock: 100 }]);
    context.capabilities.gallery34 = false;
    blocked(document, context, 'PREPARED_WIRE_CAPABILITY_UNVERIFIED');
  });
});
