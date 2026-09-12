import { expect, it } from 'vitest';
import { validateTrialMetadata } from '../../apps/api/src/sandbox-trial-preflight.js';

const item = () => ({
  sourceKey: 'SBX-BULK-TEST-001',
  create: {
    item_sku: 'SBX-BULK-TEST-001',
    item_name: 'SANDBOX QA Notebook 001',
    description: 'Synthetic fixture only, no commercial product.',
    category_id: 301378,
    item_status: 'UNLIST',
    original_price: 20000,
    seller_stock: [{ stock: 3 }],
    brand: { brand_id: 0, original_brand_name: 'No Brand' },
    attribute_list: [{ attribute_id: 200134, attribute_value_list: [{ value_id: 101205 }] }],
    weight: 0.2,
    dimension: { package_length: 21, package_width: 15, package_height: 2 },
    image: { image_ratio: '1:1', image_id_list: ['synthetic-image'] },
    logistic_info: [{ logistic_id: 51022, enabled: true, is_free: false }],
  },
});
const metadata = () => ({
  category: { category_id: 301378, has_children: false },
  attributes: {
    list: [
      {
        category_id: 301378,
        attribute_tree: [
          {
            attribute_id: 200134,
            mandatory: true,
            attribute_info: { input_type: 4, max_value_count: 5 },
            attribute_value_list: [{ value_id: 101205 }],
          },
        ],
      },
    ],
  },
  brands: { is_mandatory: false, brand_list: [] },
  channels: {
    logistics_channel_list: [
      {
        logistics_channel_id: 51022,
        enabled: true,
        mask_channel_id: 0,
        fee_type: 'SIZE_INPUT',
        weight_limit: { item_min_weight: 0.01, item_max_weight: 30 },
      },
    ],
  },
  limits: {
    price_limit: { min_limit: 1000, max_limit: 999999 },
    stock_limit: { min_limit: 0, max_limit: 10000 },
    item_name_length_limit: { min_limit: 10, max_limit: 120 },
    item_description_length_limit: { min_limit: 10, max_limit: 3000 },
    item_image_count_limit: { min_limit: 1, max_limit: 9 },
    item_count_limit: { max_limit: 1000 },
    gtin_limit: { gtin_validation_rule: 'Optional' },
  },
  existing: [],
});
it('accepts an explicit synthetic fixture only when live metadata matches', () => {
  expect(validateTrialMetadata([item()], metadata())).toEqual([]);
});
it('blocks missing metadata instead of interpreting missing limits as unlimited', () => {
  const m = metadata();
  delete (m.limits as any).price_limit;
  expect(validateTrialMetadata([item()], m)).toContain('LIMIT_UNVERIFIED:price_limit');
});
it('detects existing SKU and capacity without changing the source', () => {
  const m = metadata();
  (m.existing as any[]).push({ item_sku: 'SBX-BULK-TEST-001' });
  m.limits.item_count_limit.max_limit = 1;
  expect(validateTrialMetadata([item()], m)).toEqual(
    expect.arrayContaining(['EXISTING_SOURCE_SKU:SBX-BULK-TEST-001', 'ITEM_COUNT_LIMIT']),
  );
});
it('checks mandatory children only beneath the selected value', () => {
  const m = metadata();
  const a = m.attributes.list[0].attribute_tree[0];
  (a.attribute_value_list[0] as any).child_attribute_list = [
    { attribute_id: 222, mandatory: true, attribute_value_list: [] },
  ];
  expect(validateTrialMetadata([item()], m)).toContain('ATTRIBUTE_REQUIRED:222');
});
it('blocks fulfilment-only channels and compulsory/related-channel omissions', () => {
  const m = metadata();
  m.channels.logistics_channel_list[0].mask_channel_id = 123;
  expect(validateTrialMetadata([item()], m)).toContain('CHANNEL_NOT_ELIGIBLE:51022');
  m.channels.logistics_channel_list[0].mask_channel_id = 0;
  (m.channels.logistics_channel_list[0] as any).channel_relation_rules = [
    { related_enabled_channels: [99] },
  ];
  expect(validateTrialMetadata([item()], m)).toContain('RELATED_CHANNEL_MISSING:99');
});
it('rejects out-of-range variant prices and GTIN requirements without rewriting prices', () => {
  const i: any = item();
  i.tiers = {
    standardise_tier_variation: [],
    model: [{ original_price: 1, seller_stock: [{ stock: 3 }] }],
  };
  const m = metadata();
  m.limits.gtin_limit.gtin_validation_rule = 'Mandatory';
  expect(validateTrialMetadata([i], m)).toEqual(
    expect.arrayContaining([
      'PRICE_OUT_OF_RANGE:SBX-BULK-TEST-001',
      'GTIN_REQUIRED:SBX-BULK-TEST-001',
    ]),
  );
  expect(i.tiers.model[0].original_price).toBe(1);
});

it.each(['object', 'array'])(
  'reads %s relation rules without dropping enabled or disabled requirements',
  (shape) => {
    const m = metadata(),
      source = item();
    const rule = {
      related_enabled_channels: [99],
      related_disabled_channels: [51022],
      related_dependent_block_channels: [],
    };
    (m.channels.logistics_channel_list[0] as any).channel_relation_rules =
      shape === 'array' ? [rule] : rule;
    const before = JSON.stringify({ m, source });
    expect(validateTrialMetadata([source], m)).toEqual(
      expect.arrayContaining([
        'RELATED_CHANNEL_MISSING:99',
        'RELATED_CHANNEL_MUST_BE_DISABLED:51022',
      ]),
    );
    expect(JSON.stringify({ m, source })).toBe(before);
  },
);

it.each(['object', 'array'])(
  'accepts satisfied %s relation rules and explicitly disabled related channels',
  (shape) => {
    const m = metadata(),
      source = item();
    source.create.logistic_info.push({ logistic_id: 99, enabled: false, is_free: false });
    const rule = {
      related_enabled_channels: [51022],
      related_disabled_channels: [99],
      related_dependent_block_channels: [100],
    };
    (m.channels.logistics_channel_list[0] as any).channel_relation_rules =
      shape === 'array' ? [rule] : rule;
    expect(validateTrialMetadata([source], m)).toEqual([]);
  },
);

it.each(
  [
    { related_enabled_channels: [null] },
    { related_enabled_channels: '99' },
    { related_disabled_channels: { channel: 99 } },
    { related_dependent_block_channels: [-1] },
    { future_rule: [99] },
    [null],
    ['unknown-rule'],
    'unknown-rule',
  ].map((rule) => ({ rule })),
)('blocks malformed or unsupported nonempty relation rules $rule', ({ rule }) => {
  const m = metadata();
  (m.channels.logistics_channel_list[0] as any).channel_relation_rules = rule;
  expect(validateTrialMetadata([item()], m)).toContain('CHANNEL_RELATION_RULE_UNVERIFIED:51022');
});

it('accepts live empty relation object and UNKNOWN dimension units only for explicit zero limits', () => {
  const m = metadata();
  Object.assign(m.channels.logistics_channel_list[0], {
    channel_relation_rules: {
      related_enabled_channels: [],
      related_disabled_channels: [],
      related_dependent_block_channels: [],
    },
    item_max_dimension: { height: 0, width: 0, length: 0, dimension_sum: 0, unit: 'UNKNOWN' },
  });
  expect(validateTrialMetadata([item()], m)).toEqual([]);
});

it.each(['height', 'width', 'length', 'dimension_sum'])(
  'requires a known dimension unit if %s imposes a positive limit',
  (field) => {
    const m = metadata();
    (m.channels.logistics_channel_list[0] as any).item_max_dimension = {
      height: 0,
      width: 0,
      length: 0,
      dimension_sum: 0,
      unit: 'UNKNOWN',
      [field]: 60,
    };
    expect(validateTrialMetadata([item()], m)).toContain('CHANNEL_DIMENSION_UNIT_UNVERIFIED:51022');
  },
);

it('continues blocking nonzero volume limits without a documented unit', () => {
  const m = metadata();
  (m.channels.logistics_channel_list[0] as any).volume_limit = {
    item_max_volume: 99999,
    item_min_volume: 0,
  };
  expect(validateTrialMetadata([item()], m)).toContain('CHANNEL_VOLUME_UNIT_UNVERIFIED:51022');
});
