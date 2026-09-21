import { describe, expect, it } from 'vitest';
import type { PreparedDocument } from '../../packages/domain/src/prepared-batch.js';
import { assessPreparedMetadata } from '../../packages/shopee/src/prepared-metadata.js';

const envelope = (response: unknown) => ({ error: '', request_id: 'metadata-fixture', response });
const media = {
  importId: 'asset',
  sha256: 'a'.repeat(64),
  width: 750,
  height: 1000,
  mime: 'image/png',
};
function input() {
  const document: PreparedDocument = {
    sourceKey: 'fixture-source',
    title: 'Prepared product',
    description: [{ type: 'text', text: 'Prepared description' }],
    cover: { ...media, width: 1000 },
    gallery: [media],
    tierNames: ['Colour'],
    models: [
      { sku: 'A', optionLabels: ['White'], tierIndex: [0], originalPrice: '12000', stock: 0 },
    ],
    categoryId: '100',
    brandId: '55',
    attributes: { '7': ['70'] },
    logistics: [{ channelId: '90', enabled: true }],
    weightGrams: 100,
    dimensionCm: { length: 10, width: 10, height: 10 },
    publication: 'unlisted',
  };
  return {
    document,
    source: { condition: 'NEW', preOrder: { isPreOrder: false, daysToShip: 2 } },
    metadata: {
      itemLimit: envelope({
        price_limit: { min_limit: 1000, max_limit: 500000 },
        stock_limit: { min_limit: 0, max_limit: 999 },
        item_name_length_limit: { min_limit: 5, max_limit: 60 },
        item_image_count_limit: { min_limit: 1, max_limit: 6 },
        item_description_length_limit: { min_limit: 5, max_limit: 2000 },
        tier_variation_name_length_limit: { min_limit: 1, max_limit: 20 },
        tier_variation_option_length_limit: { min_limit: 1, max_limit: 30 },
        dts_limit: {
          non_pre_order_days_to_ship: 2,
          days_to_ship_limit: { min_limit: 3, max_limit: 15 },
        },
        gtin_limit: { gtin_validation_rule: 'Optional' },
        size_chart_limit: { size_chart_mandatory: false },
      }),
      brandPages: [
        envelope({
          brand_list: [
            { brand_id: 55, original_brand_name: 'Lamy', display_brand_name: 'LAMY display' },
          ],
          has_next_page: false,
        }),
      ],
      attributeTree: envelope({
        list: [
          {
            category_id: 100,
            attribute_tree: [
              {
                attribute_id: 7,
                mandatory: true,
                name: 'Colour',
                attribute_info: { input_type: 1, max_value_count: 1, input_validation_type: 0, format_type: 1 },
                attribute_value_list: [{ value_id: 70, name: 'White', value_unit: '' }],
              },
            ],
          },
        ],
      }),
    },
    evidence: {
      images34: {
        state: 'allowed' as const,
        reference: 'fixture-capability-read',
        observedAt: '2026-09-14T00:00:00Z',
      },
    },
  };
}
const codes = (value: ReturnType<typeof assessPreparedMetadata>) =>
  value.issues.map((issue) => issue.code);

describe('prepared metadata compatibility — pure raw API fixtures, no Shopee calls', () => {
  it('resolves exact brand and attribute wire values without mutating supplied listing or manufacturing model limits', () => {
    const value = input(),
      before = structuredClone(value);
    const result = assessPreparedMetadata(value);
    expect(result.compatible).toBe(true);
    expect(result.resolved.brand).toEqual({ brand_id: 55, original_brand_name: 'Lamy' });
    expect(result.resolved.attributes).toEqual([
      {
        attribute_id: 7,
        attribute_value_list: [{ value_id: 70, original_value_name: 'White', value_unit: '' }],
      },
    ]);
    expect(result.resolved.limits).not.toHaveProperty('maxModels');
    expect(value).toEqual(before);
  });
  it('does not use examples as limits when raw price limits are absent or reversed', () => {
    const value = input();
    delete (value.metadata.itemLimit.response as any).price_limit;
    expect(codes(assessPreparedMetadata(value))).toContain('METADATA_LIMIT_MISSING');
    (value.metadata.itemLimit.response as any).price_limit = { min_limit: 500, max_limit: 5 };
    expect(codes(assessPreparedMetadata(value))).toContain('METADATA_LIMIT_INVALID');
  });
  it('rejects a resolved preset when current input semantics or validation constraints no longer permit it', () => {
    const value=input(), info=(value.metadata.attributeTree.response as any).list[0].attribute_tree[0].attribute_info;
    info.input_type=3;
    expect(codes(assessPreparedMetadata(value))).toContain('ATTRIBUTE_VALUE_CHANGED');
    info.input_type=1; delete info.input_validation_type;
    expect(codes(assessPreparedMetadata(value))).toContain('ATTRIBUTE_CONSTRAINT_UNVERIFIED');
  });
  it('validates actual title/price/stock limits including explicit zero', () => {
    const value = input();
    value.document.title = 'x';
    value.document.models[0]!.originalPrice = '900';
    value.document.models[0]!.stock = 1000;
    const result = assessPreparedMetadata(value);
    expect(
      result.issues
        .filter((issue) => issue.code === 'SOURCE_OUTSIDE_LIMIT')
        .map((issue) => issue.path),
    ).toEqual(expect.arrayContaining(['title', 'models.0.originalPrice', 'models.0.stock']));
  });
  it('requires explicit source condition/preorder without misrepresenting these as mandatory VN API parameters', () => {
    const value = input();
    const result = assessPreparedMetadata({ ...value, source: undefined });
    expect(result.requirements.map((requirement) => requirement.field)).toEqual(
      expect.arrayContaining(['condition', 'preOrder']),
    );
    expect(
      result.requirements.every((requirement) => requirement.reason === 'source_semantics'),
    ).toBe(true);
  });
  it('resolves exact original brand name, rejects source name contradiction and incomplete pagination', () => {
    const value = input();
    expect(
      codes(
        assessPreparedMetadata({
          ...value,
          source: { ...value.source, brandName: 'LAMY display' },
        }),
      ),
    ).toContain('SOURCE_BRAND_NAME_MISMATCH');
    (value.metadata.brandPages[0]!.response as any).has_next_page = true;
    expect(codes(assessPreparedMetadata(value))).toContain('METADATA_BRAND_PAGES_INCOMPLETE');
  });
  it('requires explicit GTIN per SKU for Flexible and never supplies 00 by default', () => {
    const value = input();
    (value.metadata.itemLimit.response as any).gtin_limit.gtin_validation_rule = 'Flexible';
    const missing = assessPreparedMetadata(value);
    expect(missing.requirements).toContainEqual({ field: 'gtinBySku.A', reason: 'api_required' });
    expect(
      assessPreparedMetadata({ ...value, source: { ...value.source, gtinBySku: { A: '00' } } })
        .compatible,
    ).toBe(true);
    (value.metadata.itemLimit.response as any).gtin_limit.gtin_validation_rule = 'Mandatory';
    expect(
      codes(
        assessPreparedMetadata({ ...value, source: { ...value.source, gtinBySku: { A: '00' } } }),
      ),
    ).toContain('SOURCE_GTIN_INVALID');
    expect(
      assessPreparedMetadata({
        ...value,
        source: { ...value.source, gtinBySku: { A: '4006381333931' } },
      }).compatible,
    ).toBe(true);
  });
  it('keeps conflicting top-level and response GTIN rules blocked', () => {
    const value = input();
    (value.metadata.itemLimit as any).gtin_limit = { gtin_validation_rule: 'Mandatory' };
    expect(codes(assessPreparedMetadata(value))).toContain('METADATA_GTIN_CONFLICT');
  });
  it('requires mandatory child only for selected parent value and rejects an inactive child', () => {
    const value = input();
    const child = {
      attribute_id: 8,
      mandatory: true,
      name: 'Material',
      attribute_info: { input_type: 1, max_value_count: 1, input_validation_type: 0, format_type: 1 },
      attribute_value_list: [{ value_id: 80, name: 'Cotton' }],
    };
    const tree = (value.metadata.attributeTree.response as any).list[0].attribute_tree;
    tree[0].attribute_value_list[0].child_attribute_list = [child];
    expect(codes(assessPreparedMetadata(value))).toContain('SOURCE_ATTRIBUTE_REQUIRED');
    value.document.attributes['8'] = ['80'];
    expect(assessPreparedMetadata(value).compatible).toBe(true);
    tree[0].attribute_value_list.push({ value_id: 71, name: 'Black' });
    value.document.attributes['7'] = ['71'];
    expect(codes(assessPreparedMetadata(value))).toContain('SOURCE_ATTRIBUTE_INACTIVE_OR_UNKNOWN');
  });
  it('does not guess custom values, numeric names, duplicate IDs or units', () => {
    const value = input();
    value.document.attributes['7'] = ['custom'];
    expect(codes(assessPreparedMetadata(value))).toContain('SOURCE_ATTRIBUTE_VALUE_UNRESOLVED');
    const values = (value.metadata.attributeTree.response as any).list[0].attribute_tree[0]
      .attribute_value_list;
    values.push({ value_id: 71, name: '70' });
    value.document.attributes['7'] = ['70'];
    expect(codes(assessPreparedMetadata(value))).toContain('SOURCE_ATTRIBUTE_VALUE_AMBIGUOUS');
  });
  it('keeps ratio whitelist unknown separate from supported and never crops', () => {
    const value = input();
    expect(codes(assessPreparedMetadata({ ...value, evidence: undefined }))).toContain(
      'CAPABILITY_IMAGES_34_UNKNOWN',
    );
    expect(
      codes(
        assessPreparedMetadata({
          ...value,
          evidence: { images34: { ...value.evidence.images34, state: 'denied' } },
        }),
      ),
    ).toContain('CAPABILITY_IMAGES_34_DENIED');
  });
  it('uses extended text/image limits rather than normal description limit and requires evidence', () => {
    const value = input();
    value.document.description.push({ type: 'image', image: media });
    const raw = value.metadata.itemLimit.response as any;
    raw.item_description_length_limit.max_limit = 5;
    raw.extended_description_limit = {
      description_text_length_min: 0,
      description_text_length_max: 100,
      description_image_num_min: 0,
      description_image_num_max: 2,
      description_image_width_min: 400,
      description_image_height_min: 400,
      description_image_aspect_ratio_min: 0.5,
      description_image_aspect_ratio_max: 2,
    };
    expect(codes(assessPreparedMetadata(value))).toContain(
      'CAPABILITY_EXTENDED_DESCRIPTION_UNKNOWN',
    );
    const withEvidence = {
      ...value,
      evidence: { ...value.evidence, extendedDescription: value.evidence.images34 },
    };
    expect(assessPreparedMetadata(withEvidence).compatible).toBe(true);
    raw.extended_description_limit.description_image_num_max = 0;
    expect(codes(assessPreparedMetadata(withEvidence))).toContain('SOURCE_OUTSIDE_LIMIT');
  });
  it('rejects API errors and malformed category results without consuming sample data as successful response', () => {
    const value = input();
    value.metadata.itemLimit = {
      error: 'product.error_server',
      request_id: 'metadata-fixture',
      response: undefined,
    };
    expect(codes(assessPreparedMetadata(value))).toContain('METADATA_API_ERROR');
    value.metadata.itemLimit = input().metadata.itemLimit;
    (value.metadata.attributeTree.response as any).list.push(
      structuredClone((value.metadata.attributeTree.response as any).list[0]),
    );
    expect(codes(assessPreparedMetadata(value))).toContain('METADATA_CATEGORY_AMBIGUOUS');
  });
  it('keeps searchable attribute values unresolved until their exact API value is supplied', () => {
    const value = input();
    const node = (value.metadata.attributeTree.response as any).list[0].attribute_tree[0];
    node.attribute_info.support_search_value = true;
    node.attribute_value_list = [];
    expect(codes(assessPreparedMetadata(value))).toContain('METADATA_ATTRIBUTE_SEARCH_REQUIRED');
    node.attribute_value_list = [{ value_id: 70, name: 'White' }];
    expect(assessPreparedMetadata(value).compatible).toBe(true);
  });
  it('uses the single-input cardinality defined by metadata enum when max_value_count is omitted', () => {
    const value = input();
    const info = (value.metadata.attributeTree.response as any).list[0].attribute_tree[0]
      .attribute_info;
    info.input_type = 2;
    delete info.max_value_count;
    expect(assessPreparedMetadata(value).compatible).toBe(true);
    info.input_type = 5;
    expect(codes(assessPreparedMetadata(value))).toContain('METADATA_ATTRIBUTE_CONSTRAINT_UNKNOWN');
  });
  it('does not infer size chart optional from two false support flags in a real response shape', () => {
    const value = input();
    (value.metadata.itemLimit.response as any).size_chart_limit = {
      support_image_size_chart: false,
      support_template_size_chart: false,
    };
    expect(codes(assessPreparedMetadata(value))).toContain(
      'METADATA_SIZE_CHART_REQUIREMENT_UNKNOWN',
    );
  });
});
