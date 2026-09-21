import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { BlobStore, Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import type { ListingDraft } from '../../packages/domain/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { importNext } from '../../apps/worker/src/imports.js';
import type { ProductInput } from '../../apps/api/src/product-service.js';
import { fact } from '../helpers/fixtures.js';

const database = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '5442')
  throw new Error('Editor preservation regression requires local PostgreSQL on 5442.');
const schema = 'test_editor_preserve_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const repo = new Repository(pool);
const headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
let app: Awaited<ReturnType<typeof createApp>>, blobRoot: string, input: ProductInput;
let baseline: ListingDraft;
const transport = vi
  .spyOn(globalThis, 'fetch')
  .mockRejectedValue(new Error('No external network in editor preservation regression'));
const call = (options: any) => app.getHttpAdapter().getInstance().inject(options);
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  blobRoot = await mkdtemp(join(tmpdir(), 'shopee-editor-preserve-'));
  const blobs = new BlobStore(blobRoot);
  app = await createApp(repo, blobs, ['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('Nguồn QA');
  sheet.addRow(['SKU', 'TÊN SẢN PHẨM', 'GIÁ GỐC', 'NGÀNH HÀNG']);
  sheet.addRow(['QA-UNCHANGED', 'Tên từ bảng nguồn', 12345, 'Tên ngành QA không phải category ID']);
  const files: [string, Buffer][] = [
    ['source.xlsx', Buffer.from(await book.xlsx.writeBuffer())],
    [
      'cover.png',
      await sharp({ create: { width: 120, height: 120, channels: 3, background: '#987654' } })
        .png()
        .toBuffer(),
    ],
  ];
  const ids: string[] = [];
  for (const [filename, bytes] of files) {
    const result = await call({
      method: 'POST',
      url: '/v1/imports',
      headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': filename },
      payload: bytes,
    });
    expect(result.statusCode).toBe(202);
    ids.push(result.json().id);
    expect(await importNext(repo, blobs)).toBe(true);
  }
  const imported = (await call({ method: 'GET', url: '/v1/imports/' + ids[0] })).json();
  input = {
    productKey: 'qa-preserve-editor',
    expectedRevision: 0,
    title: 'Tiêu đề ban đầu',
    headline: 'Câu mở đầu nguyên bản',
    body: 'Phần thân giữ nguyên.',
    coverId: ids[1],
    galleryIds: [ids[1]],
    descriptionImageIds: [ids[1]],
    tierNames: ['Quy cách'],
    variants: [
      { importId: ids[0], rowKey: imported.body.rows[0].key, optionLabels: [' Gói  12 cái '] },
    ],
  };
});
afterAll(async () => {
  transport.mockRestore();
  await app?.close();
  await pool.end();
  if (!/^test_editor_preserve_[a-f0-9]+$/.test(schema))
    throw new Error('Unsafe isolated schema cleanup');
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  const root = resolve(blobRoot);
  if (root.startsWith(resolve(tmpdir()) + sep) && root.includes('shopee-editor-preserve-'))
    await rm(root, { recursive: true, force: true });
});
it('new drafts keep unknown metadata unset rather than inventing category IDs from workbook names', async () => {
  const created = await call({ method: 'POST', url: '/v1/products', headers, payload: input });
  expect(created.statusCode).toBe(201);
  const draft = created.json() as ListingDraft;
  expect(draft.categoryId).toBeUndefined();
  expect(draft.brandId).toBeUndefined();
  expect(draft.attributes).toEqual({});
  expect(draft.logistics).toEqual({});
  baseline = {
    ...draft,
    revision: 2,
    sourceListingId: {
      value: '27783655611',
      confirmed: false,
      sources: [
        {
          kind: 'product_file',
          fileSha256: 'a'.repeat(64),
          locator: 'Nguồn QA.xlsx · 01 VINA TUOI!C58',
          observedAt: '2026-09-16T00:00:00.000Z',
        },
      ],
    },
    categoryId: fact('990001'),
    brandId: fact('990002'),
    attributes: { fixture_material: fact({ value: 'QA PP', values: ['One', ' Two '] }) },
    logistics: { fixture_shipping: fact({ enabled: true, channelId: '991001', weight: '0.137' }) },
    videoKeys: ['qa-existing-video'],
    sizeChartKey: 'qa-existing-size-chart',
    identifiers: { gtin: fact('0000123456789') },
    compliance: { fixture_document: fact({ reference: 'QA evidence', valid: false }) },
    fulfillment: { handlingDays: fact(3) },
    publication: fact('unlisted'),
    assets: [
      ...draft.assets,
      { ...draft.assets[0], key: 'qa-existing-video', mime: 'video/mp4' },
      { ...draft.assets[0], key: 'qa-existing-size-chart' },
    ],
    issues: [
      {
        code: 'SOURCE_LISTING_SHOP_UNVERIFIED',
        severity: 'block',
        field: 'sourceListingId',
        message: 'Source listing ownership is still unverified.',
        sources: draft.title.sources,
      },
      {
        code: 'QA_CATEGORY_NEEDS_REVIEW',
        severity: 'warn',
        field: 'category',
        message: 'Existing category decision still requires its own review.',
        sources: draft.title.sources,
      },
      {
        code: 'QA_NESTED_ATTRIBUTE_BLOCKER',
        severity: 'block',
        field: 'attributes.fixture_material',
        message: 'An unexposed nested attribute issue remains unresolved.',
        sources: draft.title.sources,
      },
      {
        code: 'QA_NESTED_LOGISTICS_BLOCKER',
        severity: 'block',
        field: 'logistics.fixture_shipping.weight',
        message: 'An unexposed shipping issue remains unresolved.',
        sources: draft.title.sources,
      },
      {
        code: 'QA_VIDEO_ARRAY_BLOCKER',
        severity: 'block',
        field: 'video[0]',
        message: 'An unexposed video issue remains unresolved.',
        sources: draft.title.sources,
      },
    ],
  };
  await repo.saveProduct(baseline, 1);
});
it('a normal editor title edit retains every unexposed metadata field and its asset references in PostgreSQL', async () => {
  const edited = await call({
    method: 'POST',
    url: '/v1/products',
    headers,
    payload: {
      ...input,
      sourceListingId: baseline.sourceListingId!.value,
      expectedRevision: 2,
      title: 'Tiêu đề đã đổi đúng yêu cầu',
    },
  });
  expect(edited.statusCode).toBe(201);
  const result = (
    await call({ method: 'GET', url: '/v1/products/' + input.productKey })
  ).json() as ListingDraft;
  expect(result.revision).toBe(3);
  expect(result.title.value).toBe('Tiêu đề đã đổi đúng yêu cầu');
  for (const field of [
    'categoryId',
    'brandId',
    'attributes',
    'logistics',
    'videoKeys',
    'sizeChartKey',
    'identifiers',
    'compliance',
    'fulfillment',
    'publication',
    'sourceListingId',
  ] as const)
    expect(result[field], 'Unexposed field ' + field).toEqual(baseline[field]);
  expect(result.assets).toEqual(baseline.assets);
  expect(result.description).toEqual(baseline.description);
  expect(result.galleryKeys).toEqual(baseline.galleryKeys);
  expect(result.variants).toEqual(baseline.variants);
  expect(result.sourceSelection?.sourceListingId).toBe(baseline.sourceListingId!.value);
  expect(result.sourceListingId?.confirmed).toBe(false);
  for (const issue of baseline.issues) expect(result.issues).toContainEqual(issue);
  expect(await repo.getProduct(input.productKey!, 2)).toEqual(baseline);
  expect(transport).not.toHaveBeenCalled();
});
it('stale editor revisions cannot overwrite metadata or create another revision', async () => {
  const before = await repo.getProduct(input.productKey!);
  const stale = await call({
    method: 'POST',
    url: '/v1/products',
    headers,
    payload: { ...input, expectedRevision: 2, title: 'Stale title must not save' },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('PRODUCT_REVISION_CONFLICT');
  expect(await repo.getProduct(input.productKey!)).toEqual(before);
  expect(
    (
      await pool.query('SELECT count(*) FROM product_revisions WHERE product_key=$1', [
        input.productKey,
      ])
    ).rows[0].count,
  ).toBe('3');
});
it('omitting the source listing ID on a later content edit retains its original evidence and unresolved ownership issue', async () => {
  const edited = await call({
    method: 'POST',
    url: '/v1/products',
    headers,
    payload: { ...input, expectedRevision: 3, body: 'Phần nội dung được sửa riêng.' },
  });
  expect(edited.statusCode).toBe(201);
  const result = edited.json() as ListingDraft;
  expect(result.sourceListingId).toEqual(baseline.sourceListingId);
  expect(result.sourceSelection?.sourceListingId).toBe(baseline.sourceListingId!.value);
  expect(result.issues).toContainEqual(
    baseline.issues.find((issue) => issue.code === 'SOURCE_LISTING_SHOP_UNVERIFIED'),
  );
  expect(transport).not.toHaveBeenCalled();
});
