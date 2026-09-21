import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import sharp from 'sharp';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { ImageQcService } from '../../apps/api/src/image-qc-service.js';
const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const database = new URL(connectionString!);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '5442')
  throw new Error('LOCAL_TEST_DATABASE_REQUIRED');
const schema = 'e2e_image_qc_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString }),
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
await admin.query(`CREATE SCHEMA ${schema}`);
await migrate(pool);
await mkdir('.local/e2e-image-qc', { recursive: true });
const root = await mkdtemp(resolve('.local/e2e-image-qc/run-')),
  blobs = new BlobStore(root),
  repo = new Repository(pool);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (!['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('EXTERNAL_NETWORK_FORBIDDEN');
  return originalFetch(input, init);
};
const source = await sharp({
  create: { width: 500, height: 500, channels: 3, background: '#768f86' },
})
  .png()
  .toBuffer();
const output = await sharp(source).jpeg({ quality: 70 }).toBuffer();
const service = new ImageQcService(repo, blobs);
const row = await service.prepare({
  id: randomUUID(),
  binding: {
    environment: 'sandbox',
    partnerId: '1232297',
    shopId: '227418363',
    itemId: '990001',
    operationId: randomUUID(),
    role: 'cover',
    position: 0,
    sourceAssetId: 'qa-source',
    outputImageId: 'qa-output',
  },
  source,
  output,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
if (row.state !== 'review_required') throw new Error('EXPECTED_REVIEW_FIXTURE');
const origins: string[] = [];
const app = await createApp(repo, blobs, origins);
await app.listen(0, '127.0.0.1');
const apiAddress = app.getHttpServer().address();
if (!apiAddress || typeof apiAddress === 'string') throw new Error('API_PORT_REQUIRED');
const ui = await createServer({
  configFile: false,
  root: resolve('apps/web'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 0,
    proxy: {
      '/v1': `http://127.0.0.1:${apiAddress.port}`,
      '/health': `http://127.0.0.1:${apiAddress.port}`,
    },
  },
  resolve: { alias: { '@shopee/domain': resolve('packages/domain/src/index.ts') } },
});
await ui.listen();
const address = ui.httpServer!.address();
if (!address || typeof address === 'string') throw new Error('UI_PORT_REQUIRED');
origins.push(`http://127.0.0.1:${address.port}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await ui.close();
  await app.close();
  await pool.end();
  if (!/^e2e_image_qc_[a-f0-9]+$/.test(schema)) throw new Error('SCHEMA_GUARD');
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
process.on('message', (message) => {
  if (message === 'stop') void close().then(() => process.exit(0));
});
process.on('disconnect', () => void close().then(() => process.exit(0)));
process.send?.({ ready: true, url: `http://127.0.0.1:${address.port}`, id: row.id });
