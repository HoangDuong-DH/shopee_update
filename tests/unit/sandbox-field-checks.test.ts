import { expect, it } from 'vitest';
import {
  checkFieldReadback,
  fieldSnapshotFingerprint,
  validateFieldBaseline,
} from '../../apps/api/src/sandbox-field-checks.js';

const snapshot = () => ({
  item: {
    item_id: 900,
    item_sku: 'SBX-BULK-X',
    item_name: 'SANDBOX QA source',
    item_status: 'UNLIST',
    has_model: true,
    category_id: 301378,
    description_type: 'normal',
    description: 'SANDBOX ONLY original',
    image: { image_ratio: '1:1', image_id_list: ['a', 'b'] },
    promotion_image: { image_id_list: ['a'] },
    attribute_list: [{ attribute_id: 2, attribute_value_list: [{ value_id: 3 }] }],
    weight: '0.2',
    update_time: 10,
  },
  models: {
    model: [1, 2].map((n) => ({
      model_id: n,
      model_sku: `SBX-BULK-X-M${n}`,
      tier_index: [n - 1],
      price_info: [
        {
          currency: 'VND',
          original_price: 1000,
          current_price: 1000,
          inflated_price_of_current_price: 1000,
          inflated_price_of_original_price: 1000,
        },
      ],
      promotion_id: 0,
      has_promotion: false,
      stock_info_v2: {
        seller_stock: [{ stock: 5, location_id: 'VNZ', if_saleable: true }],
        shopee_stock: [],
        summary_info: { total_available_stock: 5, total_reserved_stock: 0 },
        advance_stock: { sellable_advance_stock: 0, in_transit_advance_stock: 0 },
      },
    })),
    tier_variation: [{ name: 'Màu', option_list: [{ option: ' A ' }, { option: 'B' }] }],
  },
});
it('checks a requested title and catches an unrelated change even when title matches', () => {
  const before = snapshot(),
    after = snapshot(),
    op = { kind: 'title' as const, value: 'SANDBOX QA new' };
  after.item.item_name = op.value;
  after.item.update_time++;
  expect(checkFieldReadback(before, after, op).verified).toBe(true);
  after.item.weight = '0.3';
  expect(checkFieldReadback(before, after, op)).toMatchObject({
    verified: false,
    selectedMatch: true,
    unchanged: false,
  });
});
it('compares selected SKU price and protects currency, other SKU price and all stock', () => {
  const before = snapshot(),
    after = snapshot(),
    op = { kind: 'price' as const, value: [{ model_id: 1, original_price: 1200 }] };
  Object.assign(after.models.model[0]!.price_info[0]!, {
    original_price: 1200,
    current_price: 1200,
    inflated_price_of_current_price: 1200,
    inflated_price_of_original_price: 1200,
  });
  expect(checkFieldReadback(before, after, op).verified).toBe(true);
  after.models.model[1]!.price_info[0]!.original_price = 1300;
  expect(checkFieldReadback(before, after, op).unchanged).toBe(false);
});
it('treats stock zero as an explicit change and does not excuse changes on other SKUs', () => {
  const before = snapshot(),
    after = snapshot(),
    op = {
      kind: 'stock' as const,
      value: [{ model_id: 1, seller_stock: [{ stock: 0, location_id: 'VNZ' }] }],
    };
  after.models.model[0]!.stock_info_v2.seller_stock[0]!.stock = 0;
  after.models.model[0]!.stock_info_v2.summary_info.total_available_stock = 0;
  expect(checkFieldReadback(before, after, op).verified).toBe(true);
  after.models.model[1]!.stock_info_v2.seller_stock[0]!.stock = 4;
  expect(checkFieldReadback(before, after, op).verified).toBe(false);
});
it('blocks unknown model IDs, promotion prices and ambiguous stock locations', () => {
  const before = snapshot();
  expect(() =>
    validateFieldBaseline(before, {
      kind: 'price',
      value: [{ model_id: 999, original_price: 1200 }],
    }),
  ).toThrow();
  before.models.model[0]!.has_promotion = true;
  expect(() =>
    validateFieldBaseline(before, {
      kind: 'price',
      value: [{ model_id: 1, original_price: 1200 }],
    }),
  ).toThrow();
  expect(() =>
    validateFieldBaseline(before, {
      kind: 'stock',
      value: [{ model_id: 1, seller_stock: [{ stock: 2, location_id: 'OTHER' }] }],
    }),
  ).toThrow();
});
it('ignores known response ordering and URLs but keeps source option order and unknown fields', () => {
  const a = snapshot(),
    b = snapshot();
  b.models.model.reverse();
  expect(fieldSnapshotFingerprint(a)).toBe(fieldSnapshotFingerprint(b));
  b.models.tier_variation[0]!.option_list.reverse();
  expect(fieldSnapshotFingerprint(a)).not.toBe(fieldSnapshotFingerprint(b));
});
it('gallery changes must preserve the separate cover exactly; remapped cover is unresolved', () => {
  const a = snapshot(),
    b = snapshot();
  a.item.image.image_ratio = '3:4';
  b.item.image.image_ratio = '3:4';
  b.item.image.image_id_list = ['b', 'a'];
  const op = {
    kind: 'gallery' as const,
    value: { image_id_list: ['b', 'a'], image_ratio: '3:4' as const },
    preserveCover: ['a'],
  };
  expect(checkFieldReadback(a, b, op).verified).toBe(true);
  b.item.promotion_image.image_id_list = ['remapped'];
  expect(checkFieldReadback(a, b, op).verified).toBe(false);
});

it.each([
  { before: [], after: {} },
  { before: {}, after: [] },
])('rejects a protected empty array/object shape change: %j', ({ before, after }) => {
  const original = snapshot(),
    observed = snapshot();
  (original.item as any).unrecognized_metadata = { values: before };
  (observed.item as any).unrecognized_metadata = { values: after };
  observed.item.item_name = 'SANDBOX QA updated';
  const result = checkFieldReadback(original, observed, {
    kind: 'title',
    value: observed.item.item_name,
  });
  expect(result.beforeFingerprint).not.toBe(result.afterFingerprint);
  expect(result).toMatchObject({ verified: false, selectedMatch: true, unchanged: false });
  expect(result.unselectedChangedPaths).toContain('item.unrecognized_metadata.values');
});
