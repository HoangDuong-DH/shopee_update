import ExcelJS from 'exceljs';
import { expect, it } from 'vitest';
import { readKini } from '../../packages/domain/src/source/kini.js';
it('blocks numeric prices outside the safe integer range instead of certifying rounded values', async () => {
  const b = new ExcelJS.Workbook(),
    s = b.addWorksheet('Unsafe');
  s.addRow(['SKU', 'TÊN SẢN PHẨM', 'GIÁ GỐC']);
  s.addRow(['A', 'A', 9007199254740992]);
  const r = await readKini(new Uint8Array(await b.xlsx.writeBuffer()));
  expect(r.rows[0].originalPrice).toBeUndefined();
  expect(r.rows[0].issues.some((i) => i.code === 'MONEY_FORMAT_REQUIRED')).toBe(true);
});
it('separates side-by-side catalog blocks without losing either SKU source', async () => {
  const b = new ExcelJS.Workbook(),
    s = b.addWorksheet('Two');
  s.addRow(['TÊN SẢN PHẨM', 'SKU', 'GIÁ GỐC', 'TÊN SẢN PHẨM', 'SKU', 'GIÁ GỐC']);
  s.addRow(['One', 'A', 100, 'Two', 'B', 200]);
  const r = await readKini(new Uint8Array(await b.xlsx.writeBuffer()));
  expect(r.rows.map((x) => [x.sku.value, x.originalPrice?.value])).toEqual([
    ['A', '100'],
    ['B', '200'],
  ]);
});
it('preserves separate Mall and ordinary prices under merged two-level headers', async () => {
  const b = new ExcelJS.Workbook(),
    s = b.addWorksheet('HIPP');
  s.addRow(['TÊN SẢN PHẨM', 'SKU', 'SHOP THƯỜNG', null, 'SHOP MALL']);
  s.addRow([null, null, 'GIÁ GỐC', 'GIÁ BÁN', 'GIÁ GỐC', 'GIÁ BÁN']);
  s.mergeCells('A1:A2');
  s.mergeCells('B1:B2');
  s.mergeCells('C1:D1');
  s.mergeCells('E1:F1');
  s.addRow(['One', 'A', 100, 80, 120, 90]);
  const r = await readKini(new Uint8Array(await b.xlsx.writeBuffer()));
  expect(
    r.rows.map((x) => [x.priceProfile, x.originalPrice?.value, x.promotionTarget?.value]),
  ).toEqual([
    ['SHOP THƯỜNG', '100', '80'],
    ['SHOP MALL', '120', '90'],
  ]);
  expect(r.rows[0].originalPrice?.sources[0].locator).toBe('HIPP!C3');
});
it('maps moved columns by block headers and preserves SKU and variant name text', async () => {
  const book = new ExcelJS.Workbook();
  const a = book.addWorksheet('Bảng A');
  a.addRow(['SKU', 'GIÁ BÁN', 'TÊN SẢN PHẨM', 'GIÁ\nGỐC']);
  a.addRow(['001A', 68999, 'CB 100 Cái Trắng', 137998]);
  a.addRow([]);
  a.addRow(['TÊN SẢN PHẨM', 'SKU', 'GIÁ GỐC', 'GIÁ BÁN']);
  a.addRow(['Đen  300 cái', 'B', 401998, 200999]);
  const parsed = await readKini(new Uint8Array(await book.xlsx.writeBuffer()), 'input.xlsx');
  expect(
    parsed.rows.map((r) => [
      r.sku.value,
      r.name.value,
      r.originalPrice?.value,
      r.promotionTarget?.value,
    ]),
  ).toEqual([
    ['001A', 'CB 100 Cái Trắng', '137998', '68999'],
    ['B', 'Đen  300 cái', '401998', '200999'],
  ]);
  expect(parsed.rows[1].originalPrice?.sources[0].locator).toBe('Bảng A!C5');
});
it('retains rows with missing formula results and blocks that price rather than turning it into zero', async () => {
  const book = new ExcelJS.Workbook();
  const a = book.addWorksheet('A');
  a.addRow(['SKU', 'TÊN SẢN PHẨM', 'GIÁ GỐC']);
  a.addRow(['A', 'A', { formula: '1+1' }]);
  const parsed = await readKini(new Uint8Array(await book.xlsx.writeBuffer()), 'input.xlsx');
  expect(parsed.rows).toHaveLength(1);
  expect(parsed.rows[0].originalPrice).toBeUndefined();
  expect(
    parsed.rows[0].issues.some((i) => i.severity === 'block' && i.field === 'originalPrice'),
  ).toBe(true);
});
it('keeps duplicate SKUs visible with their distinct source locations', async () => {
  const book = new ExcelJS.Workbook();
  const a = book.addWorksheet('A');
  a.addRow(['SKU', 'TÊN SẢN PHẨM', 'GIÁ GỐC']);
  a.addRow(['A', 'One', 100]);
  a.addRow(['A', 'Two', 200]);
  const parsed = await readKini(new Uint8Array(await book.xlsx.writeBuffer()), 'input.xlsx');
  expect(parsed.rows).toHaveLength(2);
  expect(parsed.rows.every((r) => r.issues.some((i) => i.code === 'DUPLICATE_SKU'))).toBe(true);
});
