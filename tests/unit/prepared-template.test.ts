import 'reflect-metadata';
import ExcelJS from 'exceljs';
import { expect, it, vi } from 'vitest';
import { readKini } from '@shopee/domain';
import { BlobStore, Repository } from '@shopee/persistence';
import { createApp } from '../../apps/api/src/app.js';
import { readPreparedDispatch } from '../../apps/api/src/prepared-source.js';
import { createPreparedDispatchTemplate } from '../../apps/api/src/prepared-template.js';
import {
  businessCoordinationHeaders,
  businessPriceHeaders,
} from '../fixtures/business-batch-fixtures.js';

it('downloads a blank workbook with exact dispatch and price parser headers, no invented source rows', async () => {
  const bytes = await createPreparedDispatchTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  expect(workbook.getWorksheet('Điều phối listing')!.getRow(1).values).toEqual([
    undefined,
    ...businessCoordinationHeaders,
  ]);
  expect(workbook.getWorksheet('Bảng giá')!.getRow(1).values).toEqual([
    undefined,
    ...businessPriceHeaders,
  ]);
  const dispatch = await readPreparedDispatch(bytes, 'mau-dieu-phoi-listing.xlsx');
  expect(dispatch.rows).toEqual([]);
  expect(dispatch.sheets.get('Bảng giá')).toEqual([]);
  const prices = await readKini(bytes, 'mau-dieu-phoi-listing.xlsx');
  expect(prices.rows).toEqual([]);
  expect(prices.sheets.map((s) => s.name)).toContain('Điều phối listing');
});

it('roundtrips an explicitly filled source, retaining SKU zeros, exact option text, zero stock and original price', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await createPreparedDispatchTemplate()) as unknown as ExcelJS.Buffer);
  workbook
    .getWorksheet('Điều phối listing')!
    .addRow([
      'Bộ A',
      '0000123',
      'Bảng giá',
      '123',
      '0',
      '456',
      '789',
      '5001',
      650,
      10,
      12,
      20,
      'bai.docx',
      'bia.png',
      '["g1.png","g2.png"]',
      '[]',
      'Mùi hương',
      '',
    ]);
  workbook
    .getWorksheet('Bảng giá')!
    .addRow([
      '00123',
      'Sản phẩm có sẵn',
      '',
      '',
      '137998',
      '68999',
      '650',
      'Bộ A',
      0,
      '  Sả Chanh  ',
      '',
      'sa-chanh.png',
    ]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const dispatch = await readPreparedDispatch(bytes, 'nguon-da-dien.xlsx');
  expect(dispatch.rows[0]!.fields['SHOP ID']).toBe('0000123');
  const row = dispatch.sheets.get('Bảng giá')![0]!;
  expect(row.fields.SKU).toBe('00123');
  expect(row.fields['TON BAN']).toBe(0);
  expect(row.fields['PHAN LOAI 1']).toBe('  Sả Chanh  ');
  const prices = await readKini(bytes, 'nguon-da-dien.xlsx');
  expect(prices.rows).toHaveLength(1);
  expect(prices.rows[0]!.originalPrice?.value).toBe('137998');
  expect(prices.rows[0]!.promotionTarget?.value).toBe('68999');
  expect(prices.rows[0]!.originalPrice?.sources[0]?.locator).toContain('E2');
});

it('explains current parser constraints without executable examples or fabricated category/attribute defaults', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await createPreparedDispatchTemplate()) as unknown as ExcelJS.Buffer);
  const text = JSON.stringify(workbook.getWorksheet('Hướng dẫn')!.getSheetValues());
  expect(text).toContain('sandbox');
  expect(text).toContain('một thuộc tính');
  expect(text).toContain('không tự áp giá Mall');
  expect(text).toContain('TỒN BÁN');
  expect(text).toContain('TIÊU ĐỀ');
  expect(text).toContain('BÀI MÔ TẢ ĐĂNG BÁN');
  for (const sheet of workbook.worksheets)
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        expect(
          typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value,
        ).toBe(false);
      }),
    );
});

it('serves template as a real XLSX without querying data, running a job or calling Shopee', async () => {
  const query = vi.fn(() => {
    throw new Error('unexpected DB access');
  });
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('unexpected network');
  });
  const app = await createApp(
    new Repository({ query } as any),
    new BlobStore('.local/template-test-no-write'),
    [],
  );
  try {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/v1/prepared-batches/template' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers['content-disposition']).toContain('mau-dieu-phoi-listing.xlsx');
    expect((await readPreparedDispatch(response.rawPayload, 'mau.xlsx')).rows).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    await app.close();
    network.mockRestore();
  }
});
