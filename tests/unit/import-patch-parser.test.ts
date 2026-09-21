import ExcelJS from 'exceljs';
import { expect, it } from 'vitest';
import { readPatchWorkbook } from '../../packages/domain/src/source/patch-workbook.js';

async function parse(rows: unknown[][]) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Cập nhật');
  rows.forEach((row) => sheet.addRow(row));
  return readPatchWorkbook(Buffer.from(await book.xlsx.writeBuffer()), 'update.xlsx');
}
it('reads a price-only file without requiring product name or a full listing', async () => {
  const result = await parse([
    ['SKU', 'GIÁ GỐC'],
    ['001-A ', 120000],
  ]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].sku).toBe('001-A ');
  expect(result.rows[0].values.price?.value).toBe('120000');
  expect(result.rows[0].values.price?.sources[0].locator).toBe('Cập nhật!B2');
  expect(result.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
});
it('preserves explicit stock zero and omits blank cells without requiring price', async () => {
  const result = await parse([
    ['SKU', 'TỒN ĐĂNG BÁN'],
    ['A', 0],
    ['B', null],
    ['C', 30],
  ]);
  expect(result.rows.map((row) => row.values.stock?.value)).toEqual([0, undefined, 30]);
});
it('distinguishes a cached formula from a formula with no cache or an Excel error', async () => {
  const result = await parse([
    ['SKU', 'GIÁ GỐC', 'TỒN ĐĂNG BÁN'],
    ['A', { formula: '1+1', result: 2 }, { formula: '2+2' }],
    ['B', { error: '#VALUE!' }, 0],
  ]);
  expect(result.rows[0].values.price?.value).toBe('2');
  expect(result.rows[0].issues.map((issue) => issue.code)).toContain(
    'PATCH_FORMULA_CACHE_REQUIRED',
  );
  expect(result.rows[1].issues.map((issue) => issue.code)).toContain('PATCH_CELL_ERROR');
  expect(result.rows[1].values.stock?.value).toBe(0);
});
it('blocks duplicate SKU and ambiguous columns without choosing the last value', async () => {
  const result = await parse([
    ['SKU', 'GIÁ GỐC', 'GIÁ GỐC'],
    ['A', 100, 200],
    ['A', 300, 400],
  ]);
  expect(result.blocks[0].issues.map((issue) => issue.code)).toContain('PATCH_AMBIGUOUS_COLUMN');
  expect(result.rows.every((row) => row.values.price === undefined)).toBe(true);
  expect(
    result.rows.every((row) => row.issues.some((issue) => issue.code === 'PATCH_DUPLICATE_SKU')),
  ).toBe(true);
});
it('exposes separate price profiles and retains unsupported column diagnostics', async () => {
  const result = await parse([
    ['', 'Mall', 'Mall', 'Thường', 'Thường', ''],
    ['SKU', 'GIÁ GỐC', 'GIÁ BÁN', 'GIÁ GỐC', 'GIÁ BÁN', 'CHỨNG TỪ'],
    ['A', 100, 80, 90, 70, 'certificate'],
  ]);
  expect(result.blocks.map((block) => block.priceProfile)).toEqual(['Mall', 'Thường']);
  expect(result.rows.map((row) => row.values.price?.value)).toEqual(['100', '90']);
  expect(result.issues.some((issue) => issue.code === 'PATCH_UNSUPPORTED_COLUMN')).toBe(true);
  expect(result.rows[0].values.promotionTarget?.value).toBe('80');
});
it('blocks numeric SKU, fractional stock and ambiguous money; unrelated rows remain readable', async () => {
  const result = await parse([
    ['SKU', 'GIÁ GỐC', 'TỒN ĐĂNG BÁN'],
    [123, '1.000', 1.2],
    ['B', 5000, 4],
  ]);
  expect(result.rows[0].issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(['PATCH_SKU_NOT_TEXT', 'PATCH_INVALID_PRICE', 'PATCH_INVALID_STOCK']),
  );
  expect(result.rows[1].values.price?.value).toBe('5000');
  expect(result.rows[1].issues).toEqual([]);
});
it('reports a row missing SKU when price or stock is present, but ignores a fully blank row', async () => {
  const result = await parse([
    ['SKU', 'GIÁ GỐC', 'TỒN ĐĂNG BÁN'],
    [null, 200, null],
    [null, null, 0],
    [null, null, null],
  ]);
  expect(result.issues.filter((issue) => issue.code === 'PATCH_SKU_REQUIRED')).toHaveLength(2);
});
it('scopes price and stock columns to their explicitly headed shop profiles', async () => {
  const result = await parse([
    ['', 'Mall', 'Mall', 'Thường', 'Thường'],
    ['SKU', 'GIÁ GỐC', 'TỒN ĐĂNG BÁN', 'GIÁ GỐC', 'TỒN ĐĂNG BÁN'],
    ['A', 100, 10, 200, 20],
  ]);
  expect(result.rows.map((row) => [row.values.price?.value, row.values.stock?.value])).toEqual([
    ['100', 10],
    ['200', 20],
  ]);
});
it('does not treat literal SKU as a header when its update values are numeric', async () => {
  const result = await parse([
    ['SKU', 'TỒN ĐĂNG BÁN'],
    ['SKU', 0],
  ]);
  expect(result.rows[0]).toMatchObject({ sku: 'SKU', values: { stock: { value: 0 } } });
});
it('blocks duplicate SKU columns and cached formula errors without guessing', async () => {
  const result = await parse([
    ['SKU', 'SKU', 'GIÁ GỐC'],
    ['A', 'B', 100],
  ]);
  expect(
    result.blocks[0].issues.some(
      (issue) => issue.code === 'PATCH_AMBIGUOUS_COLUMN' && issue.field === 'sku',
    ),
  ).toBe(true);
  expect(result.rows).toEqual([]);
  const errors = await parse([
    ['SKU', 'TỒN ĐĂNG BÁN'],
    ['A', { formula: '1/0', result: { error: '#DIV/0!' } }],
    ['B', { formula: '1-1', result: 0 }],
  ]);
  expect(errors.rows[0].issues.some((issue) => issue.code === 'PATCH_CELL_ERROR')).toBe(true);
  expect(errors.rows[1].values.stock?.value).toBe(0);
});
it('does not copy a stock column from one price profile into another', async () => {
  const result = await parse([
    ['', 'Mall', 'Mall', 'Thường'],
    ['SKU', 'GIÁ GỐC', 'TỒN ĐĂNG BÁN', 'GIÁ GỐC'],
    ['A', 100, 10, 200],
  ]);
  expect(result.rows.map((row) => row.values.stock?.value)).toEqual([10, undefined]);
  expect(result.blocks[1].fields).not.toContain('stock');
});
it('reports unsupported headers even when no supported change field is present', async () => {
  const result = await parse([
    ['SKU', 'THƯƠNG HIỆU', 'CHỨNG TỪ'],
    ['A', 'Brand', 'Certificate'],
  ]);
  expect(
    result.issues
      .filter((issue) => issue.code === 'PATCH_UNSUPPORTED_COLUMN')
      .map((issue) => issue.field),
  ).toEqual(['THƯƠNG HIỆU', 'CHỨNG TỪ']);
});
it('keeps unlabeled stock outside a shop profile until its column scope is confirmed', async () => {
  const result = await parse([
    ['', 'Mall', '', 'Thường'],
    ['SKU', 'GIÁ GỐC', 'TỒN ĐĂNG BÁN', 'GIÁ GỐC'],
    ['A', 100, 10, 200],
  ]);
  expect(result.rows.every((row) => row.values.stock === undefined)).toBe(true);
  expect(result.issues.some((issue) => issue.code === 'PATCH_COLUMN_SCOPE_REQUIRED')).toBe(true);
});
it('reports a stock parent label that conflicts with the physical profile range', async () => {
  const result = await parse([
    ['', 'Mall', 'Thường', 'Mall'],
    ['SKU', 'GIÁ GỐC', 'GIÁ GỐC', 'TỒN ĐĂNG BÁN'],
    ['A', 100, 200, 7],
  ]);
  expect(result.rows.every((row) => row.values.stock === undefined)).toBe(true);
  expect(result.issues.some((issue) => issue.code === 'PATCH_COLUMN_SCOPE_REQUIRED')).toBe(true);
});
