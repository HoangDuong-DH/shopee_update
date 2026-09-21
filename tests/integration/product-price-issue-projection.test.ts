import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { WorkbookImport } from '@shopee/domain';
import { BlobStore, Pool, Repository, migrate } from '@shopee/persistence';
import { createApp } from '../../apps/api/src/app.js';
import { assembleProduct } from '../../apps/api/src/product-service.js';
import { importNext } from '../../apps/worker/src/imports.js';

const database = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.port !== '5442')
  throw Error('Price projection tests require isolated local PostgreSQL.');
const schema = 'test_price_projection_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const repo = new Repository(pool);
let root: string, blobs: BlobStore, app: Awaited<ReturnType<typeof createApp>>;
const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No network allowed'));
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), 'shopee-price-projection-'));
  blobs = new BlobStore(root);
  app = await createApp(repo, blobs, ['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  outbound.mockRestore();
  if (
    root &&
    resolve(root).startsWith(resolve(tmpdir()) + sep) &&
    root.includes('shopee-price-projection-')
  )
    await rm(root, { recursive: true, force: true });
});

it.each([false, true])(
  'GET projects only resolved profile warnings, same-scope duplicate=%s',
  async (duplicate) => {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet('Giá');
    sheet.addRow(['SKU', 'TÊN SẢN PHẨM', 'SHOP THƯỜNG', null, 'SHOP MALL']);
    sheet.addRow([null, null, 'GIÁ GỐC', 'GIÁ BÁN', 'GIÁ GỐC', 'GIÁ BÁN']);
    sheet.mergeCells('A1:A2');
    sheet.mergeCells('B1:B2');
    sheet.mergeCells('C1:D1');
    sheet.mergeCells('E1:F1');
    sheet.addRow(['SOURCE-A', 'Source product', 100, 80, 120, 90]);
    if (duplicate) sheet.addRow(['SOURCE-A', 'Ambiguous second row', 100, 80, 121, 90]);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const imported = await repo.createImport({
      sha256: await blobs.put(bytes),
      filename: 'prices.xlsx',
      kind: 'xlsx',
      bytes: bytes.length,
    });
    expect(await importNext(repo, blobs)).toBe(true);
    const rawImport = (await repo.getImport(imported.id))!;
    const rows = (rawImport.body as WorkbookImport).rows;
    const selected = rows.find((row) => row.priceProfile === 'SHOP MALL')!;
    const draft = await assembleProduct(repo, {
      expectedRevision: 0,
      title: 'Exact source title',
      headline: '',
      body: 'Exact body',
      galleryIds: [],
      descriptionImageIds: [],
      tierNames: [],
      variants: [{ importId: imported.id, rowKey: selected.key, optionLabels: [] }],
    });
    // Simulate a historical revision that retained the raw parser warning before this projection.
    draft.issues = [
      ...draft.issues.filter((i) => i.code !== 'DUPLICATE_SKU'),
      ...structuredClone(selected.issues),
    ];
    const historical = await repo.saveProduct(draft, 0);
    const http = app.getHttpAdapter().getInstance();
    const detail = await http.inject({ method: 'GET', url: '/v1/products/' + draft.productKey });
    const list = await http.inject({ method: 'GET', url: '/v1/products' });
    const context = await http.inject({
      method: 'GET',
      url: '/v1/production-preparations/context',
    });
    expect(detail.statusCode).toBe(200);
    expect(list.statusCode).toBe(200);
    expect(context.statusCode).toBe(200);
    expect(
      context
        .json()
        .products.find((p: any) => p.productKey === draft.productKey)
        .issues.some((i: any) => i.code === 'DUPLICATE_SKU'),
    ).toBe(duplicate);
    for (const view of [
      detail.json(),
      list.json().find((p: any) => p.productKey === draft.productKey),
    ]) {
      expect(view.issues.some((i: any) => i.code === 'DUPLICATE_SKU')).toBe(duplicate);
      const {archived,archivedAt,...sourceView}=view;
      if(archived !== undefined)expect({archived,archivedAt}).toEqual({archived:false,archivedAt:null});
      expect({ ...sourceView, issues: historical.issues }).toEqual(historical);
    }
    expect(await repo.getProduct(draft.productKey)).toEqual(historical);
    expect(await repo.getImport(imported.id)).toEqual(rawImport);
    expect(outbound).not.toHaveBeenCalled();
  },
);
