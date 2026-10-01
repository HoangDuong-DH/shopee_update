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
import { assertListingPriceMappingReceipt } from '../../apps/api/src/listing-price-mapping.js';
import { importNext } from '../../apps/worker/src/imports.js';

const database = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
const localDatabase = ['localhost', '127.0.0.1'].includes(database.hostname);
const legacyTestDatabase = process.env.INTERNAL_ISOLATED_MODE !== '1' && localDatabase && database.port === '5442';
const internalTestDatabase = process.env.INTERNAL_ISOLATED_MODE === '1' && localDatabase && database.protocol === 'postgres:'
  && database.port === '5443' && database.pathname === '/shopee_internal_test' && database.username === 'shopee_internal'
  && !database.search && !database.hash;
if (!legacyTestDatabase && !internalTestDatabase)
  throw Error('Mapping tests require isolated local PostgreSQL.');
const schema = 'test_price_mapping_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const repo = new Repository(pool);
const headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
let root: string, blobs: BlobStore, app: Awaited<ReturnType<typeof createApp>>;
const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No network allowed'));
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), 'shopee-price-mapping-'));
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
  if (root && resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('shopee-price-mapping-'))
    await rm(root, { recursive: true, force: true });
});

async function source(duplicate = false) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Giá');
  book.creator = randomUUID();
  sheet.addRow(['SKU', 'TÊN SẢN PHẨM', 'SHOP THƯỜNG', null, 'SHOP MALL']);
  sheet.addRow([null, null, 'GIÁ GỐC', 'GIÁ BÁN', 'GIÁ GỐC', 'GIÁ BÁN']);
  sheet.mergeCells('A1:A2'); sheet.mergeCells('B1:B2');
  sheet.mergeCells('C1:D1'); sheet.mergeCells('E1:F1');
  sheet.addRow(['SOURCE-A', 'Xịt phòng Sả Chanh 100ml', null, null, 120000, 99000]);
  if (duplicate) sheet.addRow(['SOURCE-A', 'Xịt xe Sả Chanh 100ml', null, null, 130000, 99000]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const imported = await repo.createImport({ sha256: await blobs.put(bytes), filename: 'price.xlsx', kind: 'xlsx', bytes: bytes.length });
  expect(await importNext(repo, blobs)).toBe(true);
  const row = ((await repo.getImport(imported.id))!.body as WorkbookImport).rows.find(r => r.priceProfile === 'SHOP MALL')!;
  const draft = await assembleProduct(repo, {
    expectedRevision: 0, title: 'Listing Sả Chanh', headline: '', body: 'Nội dung nguồn',
    galleryIds: [], descriptionImageIds: [], tierNames: ['Mùi'],
    variants: [{ importId: imported.id, rowKey: row.key, optionLabels: ['Sả Chanh'] }],
  });
  await repo.saveProduct(draft, 0);
  return draft;
}

it('requires an explicit, immutable exact-cell receipt and invalidates it on revision change', async () => {
  const draft = await source();
  const http = app.getHttpAdapter().getInstance();
  const path = '/v1/products/' + draft.productKey;
  const reviewResponse = await http.inject({ method: 'GET', url: path + '/price-mapping-review' });
  expect(reviewResponse.statusCode).toBe(200);
  const review = reviewResponse.json();
  expect(review.issues).toEqual([]);
  expect(review.confirmed).toBe(false);
  expect(review.rows).toEqual([expect.objectContaining({
    sku: 'SOURCE-A', sourceName: 'Xịt phòng Sả Chanh 100ml',
    sheetName: 'Giá', skuCell: 'A3', priceCell: 'E3', originalPrice: '120000',
  })]);
  await expect(assertListingPriceMappingReceipt(repo, draft, review.rows)).rejects.toThrow('PRODUCTION_PRICE_MAPPING_CONFIRMATION_REQUIRED');
  const confirmed = await http.inject({ method: 'POST', url: path + '/confirm-price-mapping',
    headers, payload: { expectedRevision: draft.revision, expectedFingerprint: review.fingerprint } });
  expect(confirmed.statusCode).toBe(201);
  expect(confirmed.json().rowCount).toBe(1);
  expect(await repo.getProduct(draft.productKey)).toEqual(draft);
  await expect(pool.query('UPDATE listing_price_mapping_rows SET original_price=\'1\' WHERE receipt_id=$1', [confirmed.json().receiptId]))
    .rejects.toThrow('IMMUTABLE_REVISION');
  expect((await http.inject({ method: 'GET', url: path + '/price-mapping-review' })).json().confirmed).toBe(true);
  await expect(assertListingPriceMappingReceipt(repo, draft, review.rows)).resolves.toBeUndefined();
  await expect(assertListingPriceMappingReceipt(repo, draft, [{ ...review.rows[0], originalPrice: '1' }]))
    .rejects.toThrow('PRODUCTION_PRICE_MAPPING_MISMATCH');
  const changed = structuredClone(draft);
  changed.revision = 2;
  changed.title.value = 'Listing Sả Chanh bản sửa';
  await repo.saveProduct(changed, 1);
  await expect(assertListingPriceMappingReceipt(repo, changed, review.rows)).rejects.toThrow('PRODUCTION_PRICE_MAPPING_CONFIRMATION_REQUIRED');
  const wrong = await http.inject({ method: 'POST', url: path + '/confirm-price-mapping',
    headers, payload: { expectedRevision: draft.revision, expectedFingerprint: review.fingerprint } });
  expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
  expect(outbound).not.toHaveBeenCalled();
});

it('blocks duplicate SKU rows and reports the issue for the operator', async () => {
  const draft = await source(true);
  const http = app.getHttpAdapter().getInstance();
  const path = '/v1/products/' + draft.productKey;
  const review = (await http.inject({ method: 'GET', url: path + '/price-mapping-review' })).json();
  expect(review.issues.some((item: any) => item.code === 'MAPPING_DUPLICATE_PRICE_SKU')).toBe(true);
  const response = await http.inject({ method: 'POST', url: path + '/confirm-price-mapping',
    headers, payload: { expectedRevision: draft.revision, expectedFingerprint: review.fingerprint } });
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  expect((await pool.query('SELECT count(*)::int AS n FROM listing_price_mapping_receipts')).rows[0].n).toBe(1);
  expect(outbound).not.toHaveBeenCalled();
});

it('reports a changed draft price instead of confirming an invented value', async () => {
  const original = await source();
  const changed = structuredClone(original);
  changed.revision = 2;
  changed.variants[0]!.originalPrice.value = '121000';
  changed.sourceSelection!.mappingConfirmation = undefined;
  await repo.saveProduct(changed, 1);
  const http = app.getHttpAdapter().getInstance();
  const path = '/v1/products/' + changed.productKey;
  const review = (await http.inject({ method: 'GET', url: path + '/price-mapping-review' })).json();
  expect(review.issues.some((item: any) => item.code === 'MAPPING_PRICE_VALUE_MISMATCH')).toBe(true);
  const response = await http.inject({ method: 'POST', url: path + '/confirm-price-mapping',
    headers, payload: { expectedRevision: 2, expectedFingerprint: review.fingerprint } });
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  expect((await pool.query('SELECT count(*)::int AS n FROM listing_price_mapping_receipts WHERE product_key=$1', [changed.productKey])).rows[0].n).toBe(0);
  expect(outbound).not.toHaveBeenCalled();
});
