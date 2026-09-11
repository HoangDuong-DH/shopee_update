import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { BlobStore, Repository, migrate } from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { importNext } from '../../apps/worker/src/imports.js';
const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL }),
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},public`,
  });
let root: string, blobs: BlobStore, app: Awaited<ReturnType<typeof createApp>>;
const repo = new Repository(pool),
  headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), 'shopee-import-test-'));
  blobs = new BlobStore(root);
  app = await createApp(repo, blobs, ['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (root && root.startsWith(join(tmpdir(), 'shopee-import-test-')))
    await rm(root, { recursive: true, force: true });
});
const call = (options: any) => app.getHttpAdapter().getInstance().inject(options);
it('verifies a sandbox connection without returning or storing plaintext credentials', async () => {
  const connectionId = randomUUID();
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name) VALUES($1,'sandbox','123','456','Fixture')",
    [connectionId],
  );
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  const transport = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          error: '',
          request_id: 'fixture-request',
          shop_name: 'Test shop',
          region: 'VN',
          status: 'NORMAL',
        }),
      ),
    );
  try {
    const result = await call({
      method: 'POST',
      url: '/v1/connections/sandbox',
      headers,
      payload: {
        connectionId,
        expectedRevision: 1,
        partnerKey: 'private-partner-key',
        accessToken: 'private-access-token',
      },
    });
    expect(result.json().kind).toBe('success');
    expect(result.payload).not.toContain('private-');
    const listing = await call({ method: 'GET', url: '/v1/shops' });
    expect(listing.payload).not.toContain('private-');
    expect(listing.payload).not.toContain('ciphertext');
    const stored = (await pool.query('SELECT * FROM connections WHERE id=$1', [connectionId]))
      .rows[0];
    expect(JSON.stringify(stored)).not.toContain('private-');
    expect(stored.revision).toBe(2);
    const stale = await call({
      method: 'POST',
      url: '/v1/connections/sandbox',
      headers,
      payload: {
        connectionId,
        expectedRevision: 1,
        partnerKey: 'private-partner-key',
        accessToken: 'private-access-token',
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    transport.mockRestore();
    vi.unstubAllEnvs();
  }
});
it('rejects a production connection in the sandbox setup path before any external request', async () => {
  const connectionId = randomUUID();
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name) VALUES($1,'production','123','456','Production fixture')",
    [connectionId],
  );
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  const transport = vi.spyOn(globalThis, 'fetch');
  try {
    const result = await call({
      method: 'POST',
      url: '/v1/connections/sandbox',
      headers,
      payload: {
        connectionId,
        expectedRevision: 1,
        partnerKey: 'private-partner-key',
        accessToken: 'private-access-token',
      },
    });
    expect(result.statusCode).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
    vi.unstubAllEnvs();
  }
});
it('rejects cross-origin mutation before saving data', async () => {
  const r = await call({
    method: 'POST',
    url: '/v1/products',
    headers: { ...headers, origin: 'https://foreign.example' },
    payload: {},
  });
  expect(r.statusCode).toBe(403);
  expect(await repo.listProducts()).toEqual([]);
});
it('imports original files through HTTP, processes them, saves and restores a source-backed draft', async () => {
  const book = new ExcelJS.Workbook(),
    s = book.addWorksheet('Bảng');
  s.addRow(['SKU', 'TÊN SẢN PHẨM', 'GIÁ GỐC', 'GIÁ BÁN']);
  s.addRow(['001', 'CB 100 Cái Trắng', 137998, 68999]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const file = await call({
    method: 'POST',
    url: '/v1/imports',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent('Giá.xlsx'),
    },
    payload: bytes,
  });
  expect(file.statusCode).toBe(202);
  const image = await sharp({ create: { width: 12, height: 16, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  const img = await call({
    method: 'POST',
    url: '/v1/imports',
    headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': 'g1.png' },
    payload: image,
  });
  expect(img.statusCode).toBe(202);
  await importNext(repo, blobs);
  await importNext(repo, blobs);
  const source = (await call({ method: 'GET', url: '/v1/imports/' + file.json().id })).json();
  expect(source.status).toBe('ready');
  const payload = {
    expectedRevision: 0,
    title: 'Nguồn có sẵn',
    headline: 'Câu đầu',
    body: 'Dòng một\n\nDòng hai',
    coverId: img.json().id,
    galleryIds: [img.json().id],
    descriptionImageIds: [img.json().id],
    tierNames: ['Loại'],
    variants: [
      {
        importId: file.json().id,
        rowKey: source.body.rows[0].key,
        optionLabels: ['CB 100 Cái Trắng'],
        imageId: img.json().id,
      },
    ],
  };
  const saved = await call({ method: 'POST', url: '/v1/products', headers, payload });
  expect(saved.statusCode).toBe(201);
  const restored = (
    await call({ method: 'GET', url: '/v1/products/' + saved.json().productKey })
  ).json();
  expect(restored.variants[0].originalPrice.value).toBe('137998');
  expect(restored.variants[0].promotionTarget.value).toBe('68999');
  expect(restored.description[2].text).toBe('\n\nDòng một\n\nDòng hai');
  const media = await call({ method: 'GET', url: '/v1/media/' + img.json().id });
  expect(media.rawPayload.equals(image)).toBe(true);
});
