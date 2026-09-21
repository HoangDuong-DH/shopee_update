import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { parse } from 'dotenv';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { importNext } from '../../apps/worker/src/imports.js';
import { businessShopFixtures } from '../fixtures/business-batch-fixtures.js';
import { BusinessPlatform } from '../fixtures/business-platform.js';
import { PreparedExecutionService } from '../../apps/api/src/prepared-execution.js';

// Real API, real PostgreSQL, real import worker. No precomputed import bodies or browser routes.
const connectionString =
  process.env.TEST_DATABASE_URL ?? parse(await readFile('.env', 'utf8')).DATABASE_URL;
const database = new URL(connectionString);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '5442')
  throw new Error('Bulk folder acceptance requires local PostgreSQL on 5442.');
const schema = 'e2e_prepared_business_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10000 });
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  connectionTimeoutMillis: 5000,
  query_timeout: 10000,
});
const allowedRoot = resolve('.local/acceptance-20260914/business-batch');
const evidenceRoot = resolve(process.env.PREPARED_BUSINESS_EVIDENCE_ROOT ?? '');
if (!evidenceRoot.startsWith(allowedRoot + sep))
  throw new Error('Evidence root is outside the isolated acceptance directory.');
const blobRoot = join(evidenceRoot, 'isolated-blobs');
await mkdir(blobRoot, { recursive: true });
const repo = new Repository(pool),
  blobs = new BlobStore(blobRoot);
const gateway = new BusinessPlatform();
const execution = new PreparedExecutionService(repo, gateway);
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let working = false,
  closing = false,
  processed = 0;
const workerErrors: string[] = [];
const forbiddenFetches: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    forbiddenFetches.push(url.origin);
    throw new Error('Outbound network is forbidden in the bulk folder acceptance fixture.');
  }
  return originalFetch(input, init);
};
async function snapshot() {
  const records = await repo.listImports();
  const files = await Promise.all(
    records.map(async (record) => ({
      id: record.id,
      filename: record.filename,
      kind: record.kind,
      status: record.status,
      sha256: record.sha256,
      storedBlobSha256: createHash('sha256')
        .update(await blobs.read(record.sha256))
        .digest('hex'),
      bytes: record.bytes,
    })),
  );
  const batches = (
    await pool.query(
      'SELECT b.id, r.revision, r.state FROM input_batches b JOIN input_batch_revisions r ON r.batch_id=b.id AND r.revision=b.latest_revision ORDER BY b.created_at',
    )
  ).rows;
  const counts: Record<string, number> = {};
  for (const table of [
    'products',
    'product_revisions',
    'work_orders',
    'jobs',
    'connections',
    'prepared_execution_jobs',
    'prepared_execution_bindings',
    'prepared_execution_batches',
  ])
    counts[table] = Number(
      (await pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count,
    );
  return {
    schema,
    processed,
    workerErrors,
    forbiddenFetches,
    files,
    batches,
    counts,
    syntheticShopProfiles: businessShopFixtures,
    platform: gateway.snapshot(),
    products: (
      await pool.query(
        'SELECT r.body FROM products p JOIN product_revisions r ON r.product_key=p.product_key AND r.revision=p.latest_revision ORDER BY p.product_key',
      )
    ).rows.map((row) => row.body),
    workOrders: (await pool.query('SELECT * FROM work_orders')).rows,
  };
}
async function close() {
  if (closing) return;
  closing = true;
  if (timer) clearInterval(timer);
  const deadline = Date.now() + 15000;
  while (working && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
  await ui?.close();
  await app?.close();
  await writeFile(
    join(evidenceRoot, 'database-before-cleanup.json'),
    JSON.stringify(await snapshot(), null, 2),
  );
  await pool.end();
  if (!/^e2e_prepared_business_[a-f0-9]+$/.test(schema)) throw new Error('Unsafe schema cleanup');
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  const absent =
    (
      await admin.query(
        'SELECT schema_name FROM information_schema.schemata WHERE schema_name=$1',
        [schema],
      )
    ).rowCount === 0;
  await admin.end();
  if (!resolve(blobRoot).startsWith(evidenceRoot + sep)) throw new Error('Unsafe blob cleanup');
  await rm(blobRoot, { recursive: true, force: true });
  await writeFile(
    join(evidenceRoot, 'cleanup.json'),
    JSON.stringify(
      {
        schema,
        isolatedSchemaRemoved: absent,
        isolatedBlobDirectoryRemoved: true,
        mainSchemaTouched: false,
      },
      null,
      2,
    ),
  );
}
process.on('message', (message: any) => {
  if (message === 'stop') void close().then(() => process.exit(0));
  if (message?.command === 'snapshot')
    void snapshot().then((result) =>
      process.send?.({ snapshot: result, requestId: message.requestId }),
    );
  if (message?.command === 'fault') {
    gateway.faults.push(message.fault);
    process.send?.({ requestId: message.requestId, ok: true });
  }
});
process.on('SIGTERM', () => void close().then(() => process.exit(0)));
process.on('disconnect', () => void close().then(() => process.exit(0)));
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  for (const shop of businessShopFixtures)
    await pool.query(
      "INSERT INTO connections(id,environment,partner_id,shop_id,name,state) VALUES($1,'sandbox',$2,$3,$4,'connected')",
      [randomUUID(), shop.ownerId, shop.shopId, shop.name],
    );
  const origins: string[] = [];
  app = await createApp(repo, blobs, origins, { preparedGateway: gateway });
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
      .then((claimed) => {
        if (claimed) processed++;
      })
      .then(() => execution.runOnce())
      .catch((error) => {
        workerErrors.push(error instanceof Error ? error.message : 'Unknown isolated worker error');
      })
      .finally(() => {
        working = false;
      });
  }, 10);
  process.send?.({ ready: true, baseURL, schema });
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.message : 'Fixture startup failed' });
  await close();
  process.exitCode = 1;
}
