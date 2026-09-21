import ExcelJS from 'exceljs';
import { expect, it } from 'vitest';
import { readKini } from '../../packages/domain/src/source/kini.js';

function dorisFixture() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Doris');
  sheet.addRow([
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'SHOP THƯỜNG',
    null,
    'SHOP THƯỜNG',
    null,
    'SHOP MALL',
  ]);
  sheet.mergeCells('K1:L1');
  sheet.mergeCells('M1:N1');
  sheet.mergeCells('O1:P1');
  sheet.addRow([
    null,
    'TÊN SẢN PHẨM',
    'BRAND',
    'NGÀNH\nHÀNG',
    'SKU',
    'LINK\nẢNH',
    null,
    'ĐƠN VỊ\nTÍNH THEO VAT',
    'CÂN NẶNG THỰC (G)',
    'CÂN NẶNG KHAI BÁO (G)',
    'GIÁ GỐC',
    'GIÁ BÁN',
    'GIÁ GỐC ĐẶC BIỆT',
    'GIÁ BÁN ĐẶC BIỆT',
    'GIÁ GỐC',
    'GIÁ BÁN',
  ]);
  sheet.addRow([
    null,
    'Tinh dầu nguyên văn  100ml',
    'VINA TƯƠI',
    'Tinh dầu',
    'VT001',
    'https://example.com/original.png',
    null,
    'Chai',
    220,
    250,
    198000,
    99000,
    178000,
    89000,
    218000,
    109000,
  ]);
  return { book, sheet };
}

it('keeps ordinary, special and Mall prices distinct with original source headers', async () => {
  const { book } = dorisFixture();
  const parsed = await readKini(new Uint8Array(await book.xlsx.writeBuffer()), 'Doris.xlsx');
  expect(
    parsed.rows.map((r) => [
      r.priceProfile,
      r.originalPrice?.value,
      r.promotionTarget?.value,
      r.block,
    ]),
  ).toEqual([
    ['SHOP THƯỜNG', '198000', '99000', '1:11'],
    ['SHOP THƯỜNG · GIÁ ĐẶC BIỆT', '178000', '89000', '1:13'],
    ['SHOP MALL', '218000', '109000', '1:15'],
  ]);
  const special = parsed.rows[1];
  expect(special.originalPrice?.sources[0].locator).toBe('Doris!M3');
  expect(special.promotionTarget?.sources[0].locator).toBe('Doris!N3');
  expect(special.sourceHeaders?.originalPrice?.value).toBe('GIÁ GỐC ĐẶC BIỆT');
  expect(special.sourceHeaders?.originalPrice?.sources[0].locator).toBe('Doris!M2');
  expect(special.unitOfMeasure?.value).toBe('Chai');
  expect(special.unitOfMeasure?.sources[0].locator).toBe('Doris!H3');
  expect(special.sourceHeaders?.unitOfMeasure?.value).toBe('ĐƠN VỊ\nTÍNH THEO VAT');
  expect(special.name.value).toBe('Tinh dầu nguyên văn  100ml');
  expect(parsed.rows.every((r) => !r.issues.some((i) => i.severity === 'block'))).toBe(true);
});

it('retains hidden price columns with an explicit warning rather than silently losing the profile', async () => {
  const { book, sheet } = dorisFixture();
  for (const column of ['K', 'L', 'M', 'N']) sheet.getColumn(column).hidden = true;
  const parsed = await readKini(new Uint8Array(await book.xlsx.writeBuffer()));
  expect(parsed.rows).toHaveLength(3);
  expect(parsed.sheets[0].hiddenColumns).toEqual(['K', 'L', 'M', 'N']);
  expect(parsed.rows[0].hiddenPriceColumns).toEqual(['K', 'L']);
  expect(parsed.rows[1].hiddenPriceColumns).toEqual(['M', 'N']);
  expect(
    parsed.rows[0].issues.some((i) => i.code === 'HIDDEN_PRICE_COLUMNS' && i.severity === 'warn'),
  ).toBe(true);
  expect(parsed.rows[2].issues.some((i) => i.code === 'HIDDEN_PRICE_COLUMNS')).toBe(false);
});

it.each(['hidden', 'veryHidden'] as const)(
  'retains %s sheets while blocking their rows for explicit review',
  async (state) => {
    const { book, sheet } = dorisFixture();
    sheet.state = state;
    const parsed = await readKini(new Uint8Array(await book.xlsx.writeBuffer()));
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.sheets[0].visibility).toBe(state);
    expect(
      parsed.rows.every(
        (r) =>
          r.sheetVisibility === state &&
          r.issues.some((i) => i.code === 'HIDDEN_SOURCE_SHEET' && i.severity === 'block'),
      ),
    ).toBe(true);
    expect(parsed.rows[1].originalPrice?.value).toBe('178000');
  },
);

it('reads saved special-price formula results and never falls back when a cached value is absent', async () => {
  const { book, sheet } = dorisFixture();
  sheet.getCell('M3').value = { formula: '_xlfn.DUMMYFUNCTION("GOOGLEFINANCE")', result: 177998 };
  sheet.getCell('N3').value = { formula: 'M3/2', result: 88999 };
  sheet.addRow([
    null,
    'Other',
    'VINA TƯƠI',
    'Tinh dầu',
    'VT002',
    null,
    null,
    'Chai',
    220,
    250,
    198000,
    99000,
    { formula: 'K4-20000' },
    89000,
    218000,
    109000,
  ]);
  const parsed = await readKini(new Uint8Array(await book.xlsx.writeBuffer()));
  const specials = parsed.rows.filter((r) => r.priceProfile?.includes('ĐẶC BIỆT'));
  expect(specials).toHaveLength(2);
  expect(specials[0].originalPrice?.value).toBe('177998');
  expect(specials[1].originalPrice).toBeUndefined();
  expect(
    specials[1].issues.some((i) => i.code === 'MISSING_ORIGINAL_PRICE' && i.severity === 'block'),
  ).toBe(true);
});

it('does not guess a missing price-profile parent in a sheet with ambiguous duplicate price columns', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Ambiguous');
  sheet.addRow(['SKU', 'TÊN SẢN PHẨM', '3 SHOP DHC', null, null, null]);
  sheet.addRow([null, null, 'GIÁ GỐC', 'GIÁ BÁN', 'GIÁ GỐC', 'GIÁ BÁN']);
  sheet.mergeCells('A1:A2');
  sheet.mergeCells('B1:B2');
  sheet.mergeCells('C1:D1');
  sheet.mergeCells('E1:F1');
  sheet.addRow(['DHC1', 'DHC', 100000, 50000, 120000, 60000]);
  const parsed = await readKini(new Uint8Array(await book.xlsx.writeBuffer()));
  expect(parsed.rows).toHaveLength(1);
  expect(parsed.rows[0].originalPrice).toBeUndefined();
  expect(
    parsed.rows[0].issues.some((i) => i.code === 'AMBIGUOUS_HEADER' && i.severity === 'block'),
  ).toBe(true);
});

it('does not pair a special promotional target with an ordinary original price', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Mixed');
  sheet.addRow(['SKU', 'TÊN SẢN PHẨM', 'GIÁ GỐC', 'GIÁ BÁN ĐẶC BIỆT']);
  sheet.addRow(['A', 'A', 100000, 50000]);
  const parsed = await readKini(new Uint8Array(await book.xlsx.writeBuffer()));
  expect(parsed.rows[0].originalPrice?.value).toBe('100000');
  expect(parsed.rows[0].promotionTarget).toBeUndefined();
  expect(
    parsed.rows[0].issues.some(
      (i) => i.code === 'PRICE_PROFILE_MISMATCH' && i.severity === 'block',
    ),
  ).toBe(true);
});
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
