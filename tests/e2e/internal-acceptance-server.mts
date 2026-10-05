import { assertAcceptanceDatabase } from '../fixtures/acceptance-database.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import type { createApp as AppFactory } from '../../apps/api/src/app.js';
import type { createInternalConnectedShop } from '../fixtures/internal-connected-shop.js';
await assertAcceptanceDatabase();
const projectRoot = process.cwd(), schema = 'internal_browser_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
await mkdir(resolve('.local/internal-acceptance-20260923'), { recursive: true });
const root = await mkdtemp(resolve('.local/internal-acceptance-20260923/browser-'));
// Scope default receipt/manifest directories to this one fixture process as well as its DB.
process.chdir(root);
const repo = new Repository(pool), blobs = new BlobStore(root), errors: string[] = [];
const workspaceMode = process.env.WORKSPACE_BROWSER_ACCEPTANCE === '1';
const failures = new Set<'status' | 'shops' | 'draft-count'>();
const rawQuery = pool.query.bind(pool);
pool.query = ((...args: any[]) => {
  const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
  if ((failures.has('status') && text.includes('FROM worker_heartbeats WHERE'))
    || (failures.has('shops') && text.includes('FROM connections ORDER BY environment,COALESCE(display_name,name),id'))
    || (failures.has('draft-count') && text.includes('AS active') && text.includes('FROM products p')))
    return Promise.reject(Error('WORKSPACE_FIXTURE_RESOURCE_UNAVAILABLE'));
  return (rawQuery as any)(...args);
}) as typeof pool.query;
let workspaceFixture: any = null;
let app: Awaited<ReturnType<typeof AppFactory>>, ui: Awaited<ReturnType<typeof createServer>>, working = false, closing = false, timer: ReturnType<typeof setInterval>;
let connected: Awaited<ReturnType<typeof createInternalConnectedShop>>;
const workerId = 'internal-browser-' + randomUUID();
let lastHeartbeat = 0;
async function snapshot() {
  return { schema, root, products: await repo.listProducts(), imports: await repo.listImports(),
    batches: (await pool.query('SELECT b.id,r.revision,r.state FROM input_batches b JOIN input_batch_revisions r ON r.batch_id=b.id AND r.revision=b.latest_revision')).rows,
    operations: (await pool.query('SELECT id,source_identity,source_revision,state,item_id,source_payload FROM production_pilot_operations ORDER BY created_at')).rows,
    deferredImageReceipts: (await pool.query('SELECT operation_id,basis,readbacks FROM production_pilot_deferred_image_verifications')).rows,
    preparations: (await pool.query('SELECT id,body FROM production_source_preparations')).rows,
    preparationRuns: (await pool.query('SELECT preparation_id,body FROM production_preparation_executions')).rows,
    fixtureCalls: connected?.platform.calls.slice(connected.baselineCalls) ?? [],
    fixtureItems: connected?.platform.snapshot().items ?? [],
    workspaceFixture, errors, actualShopeeRequests: 0 };
}
async function seedWorkspaceFixture() {
  const { fixtureDraft } = await import('../helpers/fixtures.js');
  const first = (await pool.query("SELECT id FROM connections WHERE environment='production' AND partner_id=$1 AND shop_id=$2", [connected.scope.partnerId, connected.scope.shopId])).rows[0];
  await pool.query("UPDATE connections SET display_name='Cửa hàng thử A',health_checked_at=now(),refresh_status='healthy' WHERE id=$1", [first.id]);
  const secondId = randomUUID(), sandboxId = randomUUID();
  const firstScope = { environment: 'production', ...connected.scope };
  const secondScope = { environment: 'production', partnerId: '987654', shopId: '9002002' };
  const sandboxScope = { environment: 'sandbox', partnerId: '987654', shopId: '9002003' };
  // These saved metadata rows are synthetic; this workflow does not read their upstream accounts.
  await pool.query(`INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at,health_checked_at,refresh_status)
    VALUES($1,'production',$3,$4,'Cửa hàng thử B','connected',now()+interval '1 hour',now(),'healthy'),
    ($2,'sandbox',$3,$5,'Shop thử nghiệm QA','disconnected',NULL,NULL,'idle')`,
    [secondId, sandboxId, secondScope.partnerId, secondScope.shopId, sandboxScope.shopId]);
  const draft = fixtureDraft();
  draft.productKey = 'workspace-browser-source';
  draft.title.value = 'Bộ nguồn QA từ file';
  draft.variants[0]!.sku.value = 'WORKSPACE-QA-100';
  draft.variants[0]!.originalPrice.value = '12000';
  const imageBytes = await readFile(resolve(root, 'existing-shop-assets/cover.png'));
  const imageSha = await blobs.put(imageBytes);
  const image = await repo.createImport({ sha256: imageSha, filename: 'bia-workspace-qa.png', kind: 'image', bytes: imageBytes.length });
  const asset = { key: image.id, sha256: imageSha, bytes: imageBytes.length, mime: 'image/png', width: 900, height: 900,
    source: { kind: 'product_file' as const, fileSha256: imageSha, locator: 'bia-workspace-qa.png', observedAt: new Date().toISOString() } };
  await repo.finishImport(image.id, asset);
  draft.coverKey = image.id; draft.galleryKeys = [image.id]; draft.assets = [asset];
  await repo.saveProduct(draft, 0);
  const preparationIds: Record<string, string[]> = {};
  for (const [scope, held] of [[firstScope, 1], [secondScope, 2]] as const) {
    preparationIds[scope.shopId] = [];
    for (let index = 0; index < held; index++) {
      const id = randomUUID(); preparationIds[scope.shopId]!.push(id);
      await pool.query(`INSERT INTO production_source_preparations(id,request_hash,request,body,fingerprint)
        VALUES($1,$2,'{}',$3,$2)`, [id, 'a'.repeat(64), { scope, entries: [{
          kind: 'blocked', productKey: draft.productKey, sourceRevision: 1,
          title: `Nguồn QA shop ${scope.shopId} cần bổ sung`,
          issues: [{ code: 'QA_MISSING_SOURCE', message: 'Dữ liệu thử còn thiếu nguồn.', severity: 'block', sources: [] }],
        }] }]);
    }
  }
  const archiveId = randomUUID(), evidenceId = randomUUID(), itemId = '9003001';
  const body = { connectionId: first.id, scope: firstScope, itemId, issues: [],
    rawItem: { item_id: Number(itemId), item_status: 'UNLIST', item_name: 'Xịt mũ bảo hiểm QA lưu trữ', has_promotion: false,
      item_sku: 'ARCHIVE-QA-100', image: { image_id_list: [] }, video_info: [] },
    rawModels: { tier_variation: [{ name: 'Dung tích' }], model: [{ model_sku: 'ARCHIVE-QA-100' }] } };
  const contentHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  await pool.query(`INSERT INTO seller_knowledge_observations(id,connection_id,kind,subject_key,content_hash,scope,body,observed_at)
    VALUES($1,$2,'listing',$3,$4,$5,$6,now())`, [evidenceId, first.id, itemId, contentHash, firstScope, body]);
  await pool.query(`INSERT INTO shop_listing_archives(id,connection_id,source_shop_id,name,selection,completed_at,item_count)
    VALUES($1,$2,$3,'Kho nguồn QA đã lưu','{}',now(),1)`, [archiveId, first.id, firstScope.shopId]);
  await pool.query(`INSERT INTO shop_listing_archive_items(archive_id,item_id,evidence_id,content_hash,item_status,title,brand_id,model_count,gallery_count,video_count)
    VALUES($1,$2,$3,$4,'UNLIST','Xịt mũ bảo hiểm QA lưu trữ','990001',1,0,0)`, [archiveId, itemId, evidenceId, contentHash]);
  return { shops: [
    { id: first.id, name: 'Cửa hàng thử A', scope: firstScope },
    { id: secondId, name: 'Cửa hàng thử B', scope: secondScope },
    { id: sandboxId, name: 'Shop thử nghiệm QA', scope: sandboxScope },
  ], preparationIds, archiveId, archiveItemId: itemId, archiveContentHash: contentHash, productKey: draft.productKey };
}
async function workspaceControl(message: any) {
  if (!workspaceMode || !workspaceFixture) throw Error('WORKSPACE_FIXTURE_CONTROL_DISABLED');
  if (message.action === 'reset') {
    failures.clear();
    await pool.query("UPDATE connections SET state='connected',refresh_status='healthy',health_checked_at=now() WHERE id=$1", [workspaceFixture.shops[1].id]);
  } else if (message.action === 'fail-resource') {
    if (!['status', 'shops', 'draft-count'].includes(message.resource)) throw Error('WORKSPACE_FIXTURE_RESOURCE_INVALID');
    if (message.enabled) failures.add(message.resource); else failures.delete(message.resource);
  } else if (message.action === 'second-shop-unknown') {
    await pool.query("UPDATE connections SET state='refresh_unknown',refresh_status='unknown' WHERE id=$1", [workspaceFixture.shops[1].id]);
  } else throw Error('WORKSPACE_FIXTURE_ACTION_INVALID');
}
async function close() {
  if (closing) return; closing = true; clearInterval(timer);
  failures.clear();
  while (working) await new Promise(done => setTimeout(done, 10));
  await ui?.close(); await app?.close();
  await writeFile(resolve(root, 'database-evidence.json'), JSON.stringify(await snapshot(), null, 2));
  await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
}
process.on('message', (message: any) => {
  if (message === 'stop') void close().then(() => process.exit(0));
  if (message?.command === 'snapshot') void snapshot().then(value => process.send?.({ requestId: message.requestId, snapshot: value }));
  if (message?.command === 'workspace-control') void workspaceControl(message).then(
    () => process.send?.({ requestId: message.requestId, controlled: true }),
    error => process.send?.({ requestId: message.requestId, error: error.message }));
});
process.on('disconnect', () => void close().then(() => process.exit(0)));
try {
  await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
  const { createInternalConnectedShop } = await import('../fixtures/internal-connected-shop.js');
  connected = await createInternalConnectedShop(repo, root, process.env.APP_ENCRYPTION_KEY!, projectRoot);
  if (workspaceMode) workspaceFixture = await seedWorkspaceFixture();
  const localFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://partner.shopeemobile.com') return connected.transport(input, init);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('FIXTURE_OUTBOUND_NETWORK_BLOCKED');
    return localFetch(input, init);
  };
  // The real execution graph is enabled only inside this externally blocked, isolated process.
  process.env.PRODUCTION_PILOT_ENABLED = '1';
  const { createApp } = await import('../../apps/api/src/app.js');
  const { importNext } = await import('../../apps/worker/src/imports.js');
  const origins: string[] = []; app = await createApp(repo, blobs, origins); await app.listen(0, '127.0.0.1');
  if (workspaceMode) process.env.API_PORT = new URL(await app.getUrl()).port;
  ui = await createServer({ configFile: false, root: resolve(projectRoot, 'apps/web'), plugins: [react()],
    server: { host: '127.0.0.1', port: 0, proxy: { '/v1': await app.getUrl(), '/health': await app.getUrl() } } });
  await ui.listen(); const address = ui.httpServer!.address();
  if (!address || typeof address === 'string') throw Error('UI_UNAVAILABLE');
  if (workspaceMode) process.env.WEB_PORT = String(address.port);
  const baseURL = `http://127.0.0.1:${address.port}`; origins.push(baseURL);
  timer = setInterval(() => {
    if (working || closing) return; working = true;
    void (async () => {
      if (Date.now() - lastHeartbeat > 5000) {
        await pool.query('INSERT INTO worker_heartbeats(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET updated_at=now()', [workerId]);
        lastHeartbeat = Date.now();
      }
      await importNext(repo, blobs);
    })().catch(error => errors.push(error.message)).finally(() => { working = false; });
  }, 10);
  process.send?.({ ready: true, baseURL, root, apiURL: await app.getUrl(), workspaceFixture, fixture: { scope: connected.scope, profile: connected.profile,
    category: connected.category, referenceItemId: connected.referenceItemId, prerequisiteOperationIds: connected.operationIds } });
} catch (error) { process.send?.({ error: error instanceof Error ? error.message : 'START_FAILED' }); await close(); process.exitCode = 1; }
