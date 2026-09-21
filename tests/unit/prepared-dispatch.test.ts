import { expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { readPreparedDispatch } from '../../apps/api/src/prepared-source.js';
async function book(rows: unknown[][], header = ['THƯ MỤC', 'SHOP ID', 'BẢNG GIÁ']) {
  const x = new ExcelJS.Workbook();
  x.addWorksheet('Điều phối listing').addRows([header, ...rows]);
  return Buffer.from(await x.xlsx.writeBuffer());
}
it('keeps explicit category IDs and a cell locator instead of inferring a category from a name', async () => {
  const parsed = await readPreparedDispatch(
    await book(
      [['QA A', '910000001', 'QA Bắc', '910001']],
      ['THƯ MỤC', 'SHOP ID', 'BẢNG GIÁ', 'MÃ NGÀNH'],
    ),
    'dispatch.xlsx',
  );
  expect(parsed.rows[0]!.fields['MA NGANH']).toBe('910001');
  expect(parsed.rows[0]!.source.locator).toContain('Điều phối listing!2');
  expect(parsed.source.fileSha256).toMatch(/^[a-f0-9]{64}$/);
});
it('rejects duplicate column identities instead of choosing the last column', async () => {
  await expect(
    readPreparedDispatch(
      await book([['QA A', '1', '2']], ['THƯ MỤC', 'SHOP ID', 'SHOP ID']),
      'x.xlsx',
    ),
  ).rejects.toThrow('PREPARED_DUPLICATE_HEADER');
});
it('retains zero and blanks distinctly; never synthesizes a stock instruction', async () => {
  const p = await readPreparedDispatch(
    await book(
      [
        ['QA A', '1', 'QA Bắc', 0],
        ['QA B', '2', 'QA Nam', null],
      ],
      ['THƯ MỤC', 'SHOP ID', 'BẢNG GIÁ', 'TỒN BÁN'],
    ),
    'x.xlsx',
  );
  expect(p.rows[0]!.fields['TON BAN']).toBe(0);
  expect(p.rows[1]!.fields['TON BAN']).toBeNull();
});
it('reuses persisted observation time so identical imported bytes keep the same provenance', async () => {
  const bytes = await book([['QA A', '1', 'QA Bắc']]);
  const observedAt = '2026-09-14T00:00:00.000Z';
  const first = await readPreparedDispatch(bytes, 'x.xlsx', observedAt);
  const replay = await readPreparedDispatch(bytes, 'x.xlsx', observedAt);
  expect(replay.rows).toEqual(first.rows);
  expect(replay.source.observedAt).toBe(observedAt);
});
it('rejects cached formula values rather than treating stale calculations as supplied stock', async () => {
  await expect(
    readPreparedDispatch(await book([['QA A', '1', { formula: '1+1', result: 2 }]]), 'x.xlsx'),
  ).rejects.toThrow('PREPARED_FORMULA_REQUIRES_VALUES');
});
