import { describe, expect, it } from 'vitest';
import type { CatalogRow } from '../../packages/domain/src/contracts.js';
import { resolveListingInput, type ListingInput } from '../../apps/web/src/listing-input.js';

const fact = (value: string) => ({ value, confirmed: true, sources: [] });
const row = (sku: string, overrides: Partial<CatalogRow> = {}): CatalogRow => ({
  key: sku + '-row',
  sheet: 'Nguồn',
  row: 3,
  headerRow: 1,
  sku: fact(sku),
  name: fact('Tên từ bảng giá, không phải nhãn phân loại'),
  originalPrice: fact('137998'),
  promotionTarget: fact('68999'),
  issues: [],
  ...overrides,
});
const input = (overrides: Partial<ListingInput> = {}): ListingInput => ({
  productKey: 'listing-da-chuan-bi',
  importId: 'file-1',
  sheet: 'Nguồn',
  priceProfile: null,
  tierCount: 1,
  tierNames: ['Phân loại đã chuẩn bị'],
  membership: 'A\tTrắng  100 cái',
  ...overrides,
});

describe('prepared listing membership', () => {
  it('keeps supplied membership order and exact labels instead of deriving them from catalog names', () => {
    const result = resolveListingInput(
      input({ membership: 'B\t Đen  300 cái \r\nA\tTrắng  100 cái\r\n' }),
      [row('A'), row('B')],
    );
    expect(result.issues).toEqual([]);
    expect(result.seed?.variants).toEqual([
      { importId: 'file-1', rowKey: 'B-row', optionLabels: [' Đen  300 cái '] },
      { importId: 'file-1', rowKey: 'A-row', optionLabels: ['Trắng  100 cái'] },
    ]);
    expect(result.seed?.tierNames).toEqual(['Phân loại đã chuẩn bị']);
    expect(result.seed?.productKey).toBe('listing-da-chuan-bi');
    expect(result.seed?.expectedRevision).toBe(0);
    expect(result.seed?.title).toBe('');
  });

  it('uses only the explicitly selected sheet and price profile', () => {
    const rows = [
      row('A', { key: 'ordinary', priceProfile: 'THƯỜNG' }),
      row('A', { key: 'mall', priceProfile: 'MALL' }),
      row('A', { key: 'elsewhere', sheet: 'Khác', priceProfile: 'MALL' }),
    ];
    const result = resolveListingInput(input({ priceProfile: 'MALL' }), rows);
    expect(result.issues).toEqual([]);
    expect(result.seed?.variants[0].rowKey).toBe('mall');
    expect(resolveListingInput(input({ priceProfile: undefined }), rows).seed).toBeUndefined();
    expect(resolveListingInput(input({ sheet: '' }), rows).seed).toBeUndefined();
  });

  it('blocks duplicate and ambiguous SKU rows without choosing a first occurrence', () => {
    expect(
      resolveListingInput(input({ membership: 'A\tTrắng\nA\tĐen' }), [row('A')]).issues.map(
        (x) => x.code,
      ),
    ).toContain('DUPLICATE_SKU');
    const ambiguous = resolveListingInput(input(), [
      row('A'),
      row('A', { key: 'another', row: 8 }),
    ]);
    expect(ambiguous.seed).toBeUndefined();
    expect(ambiguous.issues.map((x) => x.code)).toContain('AMBIGUOUS_SKU');
  });

  it('does not trim or case-normalize SKU values into a match', () => {
    for (const sku of ['a', ' A', 'A ']) {
      const result = resolveListingInput(input({ membership: sku + '\tTrắng' }), [row('A')]);
      expect(result.seed).toBeUndefined();
      expect(result.issues.map((x) => x.code)).toContain('SKU_NOT_FOUND');
    }
  });

  it('requires the exact label count and rejects missing labels', () => {
    for (const membership of ['A', 'A\t', 'A\t   ', 'A\tTrắng\t100']) {
      expect(resolveListingInput(input({ membership }), [row('A')]).seed).toBeUndefined();
    }
    expect(
      resolveListingInput(input({ tierNames: [''] }), [row('A')]).issues.map((x) => x.code),
    ).toContain('TIER_NAME_REQUIRED');
  });

  it('supports a zero-tier listing with exactly one explicit SKU', () => {
    const result = resolveListingInput(input({ tierCount: 0, tierNames: [], membership: 'A' }), [
      row('A'),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.seed?.variants[0].optionLabels).toEqual([]);
    expect(result.seed?.tierNames).toEqual([]);
    expect(
      resolveListingInput(input({ tierCount: 0, tierNames: [], membership: 'A\nB' }), [
        row('A'),
        row('B'),
      ]).issues.map((x) => x.code),
    ).toContain('UNTIERED_SINGLE_SKU');
  });

  it('keeps only supplied two-tier combinations without Cartesian expansion', () => {
    const result = resolveListingInput(
      input({
        tierCount: 2,
        tierNames: ['Màu sắc', ' Quy cách '],
        membership: 'B\tĐen\t300 cái\nA\tTrắng\t100 cái',
      }),
      [row('A'), row('B'), row('C')],
    );
    expect(result.issues).toEqual([]);
    expect(result.seed?.variants).toHaveLength(2);
    expect(result.seed?.variants.map((x) => x.optionLabels)).toEqual([
      ['Đen', '300 cái'],
      ['Trắng', '100 cái'],
    ]);
    expect(result.seed?.tierNames).toEqual(['Màu sắc', ' Quy cách ']);
  });

  it('blocks duplicate variation combinations', () => {
    const result = resolveListingInput(input({ membership: 'A\tTrắng\nB\tTrắng' }), [
      row('A'),
      row('B'),
    ]);
    expect(result.seed).toBeUndefined();
    expect(result.issues.map((x) => x.code)).toContain('DUPLICATE_OPTIONS');
  });

  it('blocks incomplete or unresolved price sources but keeps warnings visible', () => {
    expect(
      resolveListingInput(input(), [row('A', { originalPrice: undefined })]).issues.map(
        (x) => x.code,
      ),
    ).toContain('PRICE_REQUIRED');
    expect(
      resolveListingInput(input(), [
        row('A', {
          issues: [
            {
              code: 'SOURCE_AMBIGUOUS',
              severity: 'block',
              field: 'price',
              message: 'Có hai cột giá chưa phân biệt',
              sources: [],
            },
          ],
        }),
      ]).seed,
    ).toBeUndefined();
    const warning = resolveListingInput(input(), [
      row('A', {
        issues: [
          { code: 'NOTE', severity: 'warn', field: 'name', message: 'Lưu ý nguồn', sources: [] },
        ],
      }),
    ]);
    expect(warning.seed).toBeDefined();
    expect(warning.rows[0].row.issues).toHaveLength(1);
  });

  it('requires a stable local identifier and a nonempty membership', () => {
    for (const productKey of ['', '   '])
      expect(resolveListingInput(input({ productKey }), [row('A')]).seed).toBeUndefined();
    expect(
      resolveListingInput(input({ membership: '\n\r\n' }), [row('A')]).issues.map((x) => x.code),
    ).toContain('MEMBERSHIP_REQUIRED');
  });

  it('rejects noncanonical source prices that the domain cannot accept', () => {
    for (const value of ['00137998', '137.998', '-1', '0']) {
      expect(
        resolveListingInput(input(), [row('A', { originalPrice: fact(value) })]).seed,
      ).toBeUndefined();
    }
  });
});
