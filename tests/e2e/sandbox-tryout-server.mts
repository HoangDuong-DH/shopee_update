import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import { createApp } from '../../apps/api/src/app.js';
import { VariationPlatform, variationRawFixture } from '../fixtures/variation-platform.js';
const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString || !['127.0.0.1', 'localhost'].includes(new URL(connectionString).hostname))
  throw new Error('ISOLATED_LOCAL_DATABASE_REQUIRED');
const schema = 'e2e_tryout_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
const pool = new Pool({
  connectionString,
  options: '-c search_path=' + schema,
  connectionTimeoutMillis: 5000,
});
const key = '83'.repeat(32),
  connectionId = randomUUID(),
  trialId = randomUUID();
const trialItemId = 'b53c59ec-fec6-4554-a770-c5db3a660907';
let app: Awaited<ReturnType<typeof createApp>> | undefined,
  ui: ViteDevServer | undefined,
  created = false,
  closing = false;
let platform: VariationPlatform,
  writes: any[] = [],
  fault = false;
function resetPlatform() {
  const raw = variationRawFixture(0);
  raw.item.item_id = 803935036;
  raw.item.item_sku = 'SBX-BULK-UI-TRYOUT-001';
  platform = new VariationPlatform(raw);
  writes = [];
  fault = false;
}
resetPlatform();
const transport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== 'openplatform.sandbox.test-stable.shopee.sg')
    throw new Error('FIXTURE_HOST_MISMATCH');
  if (url.pathname.endsWith('/get_item_limit'))
    return new Response(
      JSON.stringify({
        error: '',
        request_id: 'fixture-ui-limits',
        response: {
          item_name_length_limit: { min_limit: 1, max_limit: 200 },
          stock_limit: { min_limit: 0, max_limit: 1000 },
        },
      }),
    );
  if (init?.method !== 'POST') return platform.fetch(input, init);
  const body = JSON.parse(String(init.body));
  writes.push({ path: url.pathname, body });
  let result: Response;
  if (url.pathname.endsWith('/update_stock')) {
    if (
      body.item_id !== 803935036 ||
      body.stock_list.length !== 1 ||
      body.stock_list[0].model_id !== 0 ||
      body.stock_list[0].seller_stock[0].location_id !== 'QA-W1'
    )
      throw new Error('FIXTURE_STOCK_SCOPE');
    const value = body.stock_list[0].seller_stock[0].stock;
    platform.state.item.stock_info_v2.seller_stock[0].stock = value;
    platform.state.item.stock_info_v2.summary_info.total_available_stock = value;
    result = new Response(
      JSON.stringify({
        error: '',
        request_id: 'fixture-stock',
        response: { success_list: [{ model_id: 0, stock: value }], failure_list: [] },
      }),
    );
  } else result = await platform.fetch(input, init);
  if (fault) platform.state.item.weight = '0.7';
  return result;
};
const reportRoot = '.local/acceptance-20260914/ui-live-readiness';
async function close(code = 0) {
  if (closing) return;
  closing = true;
  try {
    await ui?.close();
    await app?.close();
    await pool.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await mkdir(reportRoot, { recursive: true });
    await writeFile(
      reportRoot + '/browser-server-cleanup.json',
      JSON.stringify({ schema, schemaRemoved: true, externalCalls: 0, code }, null, 2),
    );
    process.exit(code);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
process.on('message', (message) => {
  if (message === 'stop') void close();
});
process.on('disconnect', () => void close());
setTimeout(() => void close(2), 180000).unref();
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await migrate(pool);
  const repo = new Repository(pool),
    box = new SecretBox(key),
    owner = 'sandbox:1232297:227418363';
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,revision,capability_revision,partner_key_ciphertext,token_ciphertext) VALUES($1,'sandbox','1232297','227418363','Shop kiểm thử giao diện','connected',1,1,$2,$3)",
    [
      connectionId,
      box.seal({ partnerKey: 'fixture-only' }, owner),
      box.seal({ accessToken: 'fixture-only-token' }, owner),
    ],
  );
  await pool.query(
    "INSERT INTO sandbox_create_trials(id,trial_key,connection_id,connection_revision,fingerprint,manifest,evidence) VALUES($1,'SBX-BULK-UI-TRYOUT',$2,1,'fixture',$3,$4)",
    [trialId, connectionId, {}, { isolated: true }],
  );
  await pool.query(
    "INSERT INTO sandbox_create_trial_items(id,trial_id,connection_id,source_key,position,intent,state,stage,item_id) VALUES($1,$2,$3,$4,0,$5,'verified','done','803935036')",
    [
      trialItemId,
      trialId,
      connectionId,
      platform.state.item.item_sku,
      {
        create: {
          item_sku: platform.state.item.item_sku,
          category_id: 301378,
          image: platform.state.item.image,
        },
      },
    ],
  );
  await mkdir(reportRoot, { recursive: true });
  const files = await mkdtemp(resolve(reportRoot + '/browser-data-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('EXTERNAL_NETWORK_FORBIDDEN');
    return originalFetch(input, init);
  };
  const origins: string[] = [];
  app = await createApp(repo, new BlobStore(files), origins, {
    trialTransport: transport,
    trialEncryptionKey: key,
    trialPause: async () => {},
  });
  app
    .getHttpAdapter()
    .getInstance()
    .get('/__fixture/state', async () => ({ writes, current: platform.read() }));
  app
    .getHttpAdapter()
    .getInstance()
    .post('/__fixture/expire', async () => {
      await pool.query(
        "UPDATE sandbox_field_trials SET created_at=now()-interval '1 hour' WHERE state='prepared'",
      );
      return { expired: true };
    });
  app
    .getHttpAdapter()
    .getInstance()
    .post('/__fixture/reset', async (request: any) => {
      await pool.query('DELETE FROM sandbox_field_trials');
      resetPlatform();
      fault = request.body?.fault === true;
      return { reset: true };
    });
  await app.listen(0, '127.0.0.1');
  const apiAddress = app.getHttpServer().address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('API_PORT_REQUIRED');
  const proxy = 'http://127.0.0.1:' + apiAddress.port;
  ui = await createServer({
    configFile: false,
    root: resolve('apps/web'),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: { '/v1': proxy, '/health': proxy, '/__fixture': proxy },
    },
    resolve: { alias: { '@shopee/domain': resolve('packages/domain/src/index.ts') } },
  });
  await ui.listen();
  const address = ui.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('UI_PORT_REQUIRED');
  const url = 'http://127.0.0.1:' + address.port;
  origins.push(url);
  process.send?.({ ready: true, url });
} catch (error) {
  console.error(error);
  await close(1);
}
