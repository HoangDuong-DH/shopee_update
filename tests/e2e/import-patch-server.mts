import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { parse } from 'dotenv';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import sharp from 'sharp';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { inspectAssets } from '../../packages/domain/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { WorkbenchService } from '../../apps/api/src/workbench-service.js';
import { importNext } from '../../apps/worker/src/imports.js';
import { fixtureDraft, fact } from '../helpers/fixtures.js';

// A private schema and blob directory; no app worker, credentials, or Shopee calls.
const connectionString =
  process.env.TEST_DATABASE_URL ?? parse(await readFile('.env', 'utf8')).DATABASE_URL;
const database = new URL(connectionString);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '5442')
  throw new Error('Browser fixture requires the local development database on 5442.');
const schema = 'e2e_import_patch_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10000 });
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  connectionTimeoutMillis: 5000,
  query_timeout: 10000,
});
const root = resolve('.local/e2e-import-patch');
await mkdir(root, { recursive: true });
const blobRoot = await mkdtemp(join(root, 'isolated-'));
const blobs = new BlobStore(blobRoot),
  repo = new Repository(pool);
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let working = false,
  closing = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!['127.0.0.1', 'localhost'].includes(new URL(value).hostname))
    throw new Error('Outbound network is forbidden in the import-patch browser fixture.');
  return originalFetch(input, init);
};

async function close() {
  if (closing) return;
  closing = true;
  if (timer) clearInterval(timer);
  const deadline = Date.now() + 12000;
  while (working && Date.now() < deadline) await new Promise((done) => setTimeout(done, 30));
  await ui?.close();
  await app?.close();
  await pool.end();
  if (!/^e2e_import_patch_[a-f0-9]+$/.test(schema)) throw new Error('Unsafe schema cleanup');
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  if (!resolve(blobRoot).startsWith(root + sep)) throw new Error('Unsafe fixture cleanup');
  await rm(blobRoot, { recursive: true, force: true });
}
process.on('message', (message) => {
  if (message === 'stop') void close().then(() => process.exit(0));
});
process.on('SIGTERM', () => void close().then(() => process.exit(0)));
process.on('disconnect', () => void close().then(() => process.exit(0)));

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const oldBytes = await sharp({
    create: { width: 100, height: 100, channels: 3, background: '#527067' },
  })
    .png()
    .toBuffer();
  const oldHash = await blobs.put(oldBytes);
  const oldFile = await repo.createImport({
    sha256: oldHash,
    filename: 'bia-cu.png',
    kind: 'image',
    bytes: oldBytes.length,
  });
  const oldAsset = (await inspectAssets([{ key: oldFile.id, bytes: oldBytes }]))[0];
  await repo.finishImport(oldFile.id, oldAsset);
  const source = {
    ...fixtureDraft(),
    productKey: 'browser-patch-prepared',
    title: fact('Bộ mẫu nhập cập nhật'),
    description: [{ type: 'text' as const, text: 'Mô tả ban đầu.\nGiữ nguyên chữ.' }],
    coverKey: oldFile.id,
    galleryKeys: [oldFile.id],
    assets: [oldAsset],
    variants: ['A', 'B', 'C'].map((sku, index) => ({
      key: 'variant-' + sku,
      sku: fact(sku),
      optionLabels: [sku],
      originalPrice: fact(String(10000 + index * 1000)),
    })),
  };
  await repo.saveProduct(source, 0);
  const connectionId = randomUUID();
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state) VALUES($1,'sandbox','123','456','Shop QA nội bộ','connected')",
    [connectionId],
  );
  await new WorkbenchService(repo).save({
    id: randomUUID(),
    expectedRevision: 0,
    config: {
      productKey: source.productKey,
      sourceRevision: 1,
      connectionId,
      operation: 'update',
      itemId: '900001',
      fieldMask: [],
      stocks: { A: 10, B: 20, C: 30 },
    },
  });
  const large = {
    ...source,
    productKey: 'browser-patch-80',
    title: fact('Bộ 80 SKU đối chiếu'),
    variants: Array.from({ length: 80 }, (_, index) => ({
      key: 'large-' + index,
      sku: fact('QA' + String(index + 1).padStart(3, '0')),
      optionLabels: [String(index + 1)],
      originalPrice: fact('10000'),
    })),
  };
  await repo.saveProduct(large, 0);
  const secondSource = {
    ...source,
    productKey: 'browser-patch-second-shop',
    title: fact('Bộ mẫu shop thứ hai'),
  };
  await repo.saveProduct(secondSource, 0);
  const secondConnection = randomUUID();
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state) VALUES($1,'production','999','888','Shop QA thứ hai','connected')",
    [secondConnection],
  );
  await new WorkbenchService(repo).save({
    id: randomUUID(),
    expectedRevision: 0,
    config: {
      productKey: secondSource.productKey,
      sourceRevision: 1,
      connectionId: secondConnection,
      operation: 'update',
      itemId: '900003',
      fieldMask: [],
      stocks: {},
    },
  });
  await new WorkbenchService(repo).save({
    id: randomUUID(),
    expectedRevision: 0,
    config: {
      productKey: large.productKey,
      sourceRevision: 1,
      connectionId,
      operation: 'update',
      itemId: '900080',
      fieldMask: [],
      stocks: {},
    },
  });
  const origins: string[] = [];
  app = await createApp(repo, blobs, origins);
  await app.listen(0, '127.0.0.1');
  const apiUrl = await app.getUrl();
  ui = await createServer({
    configFile: false,
    root: resolve('apps/web'),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      proxy: { '/v1': apiUrl, '/health': apiUrl },
    },
  });
  await ui.listen();
  const address = ui.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Fixture UI port unavailable');
  const baseURL = `http://127.0.0.1:${address.port}`;
  origins.push(baseURL);
  timer = setInterval(() => {
    if (working || closing) return;
    working = true;
    void importNext(repo, blobs)
      .catch(() => {
        process.send?.({ workerError: 'The isolated import worker failed.' });
      })
      .finally(() => {
        working = false;
      });
  }, 100);
  process.send?.({ ready: true, baseURL, schema });
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.message : 'Fixture startup failed' });
  await close();
  process.exitCode = 1;
}
