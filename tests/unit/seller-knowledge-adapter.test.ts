import { describe, expect, it } from 'vitest';
import {
  normalizeSellerCategory,
  normalizeSellerObservation,
} from '../../apps/api/src/seller-knowledge-adapter.js';

const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' };
describe('seller knowledge wire adapter', () => {
  it('preserves custom text fields and category limits from current raw metadata', () => {
    const output = normalizeSellerCategory({
      scope,
      categoryId: '101127',
      observedAt: '2026-09-16T02:20:00Z',
      expiresAt: '2026-09-16T02:35:00Z',
      attributeTree: [
        {
          attribute_id: 102560,
          name: 'country of origins',
          mandatory: false,
          attribute_info: { input_type: 3, input_validation_type: 0, format_type: 1 },
        },
        {
          attribute_id: 100025,
          name: 'Scent',
          multi_lang: [{ language: 'vn', value: 'Mùi Hương' }],
          mandatory: false,
          attribute_info: {
            input_type: 5,
            input_validation_type: 2,
            format_type: 1,
            max_value_count: 5,
          },
          attribute_value_list: [{ value_id: 871, name: 'Lavender' }],
        },
      ],
    });
    expect(output.attributes[0]).toMatchObject({ attributeId: 102560, inputType: 3, values: [] });
    expect(output.attributes[1]).toMatchObject({
      name: 'Mùi Hương',
      inputType: 5,
      maxValueCount: 5,
    });
    expect(output.scope).toEqual(scope);
  });
  it('rejects missing metadata shape instead of inventing attribute constraints', () => {
    expect(() =>
      normalizeSellerCategory({
        scope,
        categoryId: '101127',
        observedAt: '2026-09-16T02:20:00Z',
        attributeTree: [{ attribute_id: 1, name: 'Unknown', mandatory: false }],
      }),
    ).toThrow('SELLER_KNOWLEDGE_METADATA_INVALID');
  });
  it('keeps canonical option names distinct from Vietnamese display labels and flattens conditional children', () => {
    const child = {
      attribute_id: 2,
      name: 'Child',
      mandatory: true,
      attribute_info: { input_type: 3, input_validation_type: 0, format_type: 1 },
    };
    const output = normalizeSellerCategory({
      scope,
      categoryId: '1',
      observedAt: '2026-09-16T02:20:00Z',
      attributeTree: [
        {
          attribute_id: 1,
          name: 'Scent',
          mandatory: false,
          attribute_info: { input_type: 1, input_validation_type: 2, format_type: 1 },
          attribute_value_list: [
            {
              value_id: 871,
              name: 'Lavender',
              multi_lang: [{ language: 'vn', value: 'Oải hương' }],
              child_attribute_list: [child],
            },
          ],
        },
      ],
    });
    expect(output.attributes[0]!.values[0]).toMatchObject({
      name: 'Lavender',
      displayName: 'Oải hương',
    });
    expect(output.attributes[1]).toMatchObject({
      attributeId: 2,
      mandatory: true,
      dependsOn: [{ attributeId: 1, valueId: 871 }],
    });
  });
  it('rejects missing brand instead of normalizing it to No Brand', () => {
    const raw = {
      evidenceId: 'p',
      scope,
      itemId: '1',
      title: 'A',
      categoryId: '1',
      modelSkus: [],
      observedAt: '2026-09-16T02:20:00Z',
      attributes: [],
    };
    for (const brandId of [null, undefined, ''])
      expect(() => normalizeSellerObservation({ ...raw, brandId })).toThrow(
        'SELLER_KNOWLEDGE_OBSERVATION_INVALID',
      );
    expect(normalizeSellerObservation({ ...raw, brandId: 0 }).brandId).toBe(0);
  });
  it('preserves source evidence identity and values without granting reuse approval', () => {
    const output = normalizeSellerObservation({
      evidenceId: 'proof-a',
      scope,
      itemId: '1',
      title: 'Nguồn tham khảo',
      categoryId: '101127',
      brandId: '1252097',
      modelSkus: ['sku A', 'sku B'],
      observedAt: '2026-09-16T02:20:00Z',
      itemStatus: 'NORMAL',
      attributes: [
        {
          attribute_id: 101067,
          attribute_value_list: [
            { value_id: 0, original_value_name: 'Công ty mẫu', value_unit: '' },
          ],
        },
      ],
    });
    expect(output.attributes[0]).toEqual({
      attributeId: 101067,
      values: [{ valueId: 0, originalValueName: 'Công ty mẫu', valueUnit: '' }],
    });
    expect(output.modelSkus).toEqual(['sku A', 'sku B']);
    expect(output.approvedForReuse).toBe(false);
  });
  it('uses item SKU for a single-SKU listing only when no model SKUs exist', () => {
    const output = normalizeSellerObservation({
      evidenceId: 'p',
      scope,
      itemId: '1',
      title: 'Một chai',
      categoryId: '1',
      brandId: '0',
      itemSku: 'SKU-single',
      modelSkus: [],
      observedAt: '2026-09-16T02:20:00Z',
      itemStatus: 'NORMAL',
      attributes: [],
    });
    expect(output.modelSkus).toEqual(['SKU-single']);
  });
});
