import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { assertLocalIntegrationDatabase } from '../helpers/integration-database.js';

const database = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/invalid');
if (process.env.INTERNAL_ISOLATED_MODE !== '1') throw Error('OPERATIONS_TEST_REQUIRES_ISOLATED_DATABASE');
assertLocalIntegrationDatabase(database);
const schema = 'operations_overview_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const repo = new Repository(pool);
let root: string, app: Awaited<ReturnType<typeof createApp>>;
const selected = { environment: 'production', partnerId: '987654', shopId: '9001001' };
const other = { environment: 'production', partnerId: '987654', shopId: '9001002' };
const selectedId = randomUUID(), otherId = randomUUID();
const selectedPreparation = randomUUID(), otherPreparation = randomUUID();
const call = (query = '') => app.inject({ method: 'GET', url: '/v1/operations/overview' + query });

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), 'shopee-operations-overview-'));
  app = await createApp(repo, new BlobStore(root), ['http://127.0.0.1:5273']);
  await app.getHttpAdapter().getInstance().ready();
  await pool.query(`INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at,
    token_ciphertext,partner_key_ciphertext,health_checked_at,refresh_status)
    VALUES($1,'production',$3,$4,'Selected shop','connected',now()+interval '1 hour',
      'never-expose-token','never-expose-key',$6,'healthy'),
    ($2,'production',$3,$5,'Other shop','connected',now()-interval '1 minute',
      'other-private-token','other-private-key',now()-interval '2 days','reauth_required')`,
  [selectedId, otherId, selected.partnerId, selected.shopId, other.shopId, new Date(Date.now() - 60000)]);
  await pool.query(`INSERT INTO products(product_key,latest_revision) VALUES('active',2),('archived',1);
    INSERT INTO product_revisions(product_key,revision,body) VALUES
      ('active',1,'{}'),('active',2,'{}'),('archived',1,'{}');
    INSERT INTO local_resource_archives(kind,resource_id,archived_at) VALUES('product','archived',now())`);
  const selectedOrder = randomUUID(), otherOrder = randomUUID();
  await pool.query(`INSERT INTO work_orders(id,latest_revision,target_key) VALUES($1,1,'selected'),($2,1,'other')`,
    [selectedOrder, otherOrder]);
  await pool.query(`INSERT INTO work_order_revisions(order_id,revision,product_key,source_revision,connection_id,config)
    VALUES($1,1,'active',1,$3,'{}'),($2,1,'archived',1,$4,'{}')`,
  [selectedOrder, otherOrder, selectedId, otherId]);
  for (const [id, scope, blocked] of [[selectedPreparation, selected, false], [otherPreparation, other, true]] as const) {
    await pool.query(`INSERT INTO production_source_preparations(id,request_hash,request,body,fingerprint,registration)
      VALUES($1,$2,'{}',$3,$2,$4)`, [id, 'a'.repeat(64),
      { scope, entries: [{ kind: blocked ? 'blocked' : 'ready' }] }, blocked ? null : { batches: [] }]);
  }
  await pool.query(`INSERT INTO production_preparation_executions(preparation_id,fingerprint,body)
    VALUES($1,$3,'{"state":"completed"}'),($2,$3,'{"state":"paused"}')`,
  [selectedPreparation, otherPreparation, 'a'.repeat(64)]);
  await pool.query(`INSERT INTO source_files(id,sha256,filename,kind,bytes,status,lease_until) VALUES
    ($1,$4,'waiting.xlsx','xlsx',10,'queued',NULL),($2,$5,'late.docx','docx',10,'running',now()-interval '1 minute'),
    ($3,$6,'failed.png','image',10,'failed',NULL)`,
  [randomUUID(), randomUUID(), randomUUID(), '1'.repeat(64), '2'.repeat(64), '3'.repeat(64)]);
  await pool.query("INSERT INTO worker_heartbeats(id) VALUES('overview-fixture-worker')");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (root?.startsWith(join(tmpdir(), 'shopee-operations-overview-')))
    await rm(root, { recursive: true, force: true });
});

it('exposes actual local runtime flags without treating them as authorization to execute', async () => {
  const response = await call();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    observedAt: expect.any(String), scope: null,
    runtime: { productionWorkflowEnabled: false, productionWritesConfigured: false,
      connectionMaintenanceEnabled: false, isolatedMode: true, executionReadiness: 'not_assessed', executor: 'api_coordinator' },
    database: { state: 'available', data: { schemaReady: true } },
    worker: { state: 'available', data: { state: 'online', freshnessSeconds: 15 } },
  });
});

it('filters shop work and public connection metadata while keeping source counts explicitly workspace-wide', async () => {
  const response = await call('?environment=production&partnerId=987654&shopId=9001001');
  expect(response.statusCode, response.body).toBe(200);
  const data = response.json();
  expect(data.scope).toEqual(selected);
  expect(data.connections.data).toMatchObject({ total: 1, truncated: false,
    items: [{ id: selectedId, scope: selected, name: 'Selected shop', tokenState: 'valid', health: { state: 'fresh' } }] });
  expect(data.counts).toMatchObject({
    imports: { data: { total: 3, queued: 1, running: 1, ready: 0, failed: 1, expiredLeases: 1 } },
    drafts: { data: { active: 1, archived: 1 } },
    workOrders: { data: { total: 1, unassigned: 0, sourceChanged: 1 } },
    batches: { data: { preparations: 1, registered: 1, held: 0, executionRunning: 0, executionPaused: 0,
      completed: 1, operationsUnknown: 0, operationsSent: 0, waitingQc: 0, basis: 'database_preparations_and_journal' } },
  });
  expect(data.counts.sourceScope).toBe('workspace');
  expect(data.counts.workScope).toBe('selected_shop');
  expect(response.body).not.toContain(otherId);
  expect(response.body).not.toContain('ciphertext');
  expect(response.body).not.toContain('never-expose-');
  expect(response.body).not.toContain('other-private-');
  expect(data.blockers.find((b: any) => b.code === 'WORK_ORDER_SOURCE_CHANGED')).toMatchObject({
    count: 1, route: { page: 'workbench', apiPath: '/v1/workbench' }, scope: selected,
  });
});

it('shows expired tokens and old health observations without polling Shopee or changing stored data', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('NETWORK_FORBIDDEN'); });
  const before = (await pool.query('SELECT id,revision,expires_at,refresh_status,health_checked_at FROM connections ORDER BY id')).rows;
  const response = await call();
  expect(response.statusCode).toBe(200);
  const data = response.json();
  expect(data.status).toBe('degraded');
  expect(data.connections.data.items.find((c: any) => c.id === otherId)).toMatchObject({
    tokenState: 'expired', refreshState: 'reauth_required', health: { state: 'stale' },
  });
  expect(data.blockers.find((b: any) => b.connectionId === otherId && b.code === 'CONNECTION_TOKEN_EXPIRED'))
    .toMatchObject({ severity: 'block', scope: other, route: { page: 'shops', apiPath: '/v1/shops' } });
  expect((await pool.query('SELECT id,revision,expires_at,refresh_status,health_checked_at FROM connections ORDER BY id')).rows).toEqual(before);
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
});

it('preserves unknown counts and a repair action when one database source is unavailable', async () => {
  await pool.query('ALTER TABLE source_files RENAME TO source_files_offline');
  try {
    const response = await call();
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json();
    expect(data.status).toBe('degraded');
    expect(data.counts.imports).toMatchObject({ state: 'unavailable', data: null, code: 'OPERATIONS_IMPORTS_UNAVAILABLE' });
    expect(data.counts.drafts).toMatchObject({ state: 'available', data: { active: 1, archived: 1 } });
    expect(data.blockers.find((b: any) => b.code === 'OPERATIONS_IMPORTS_UNAVAILABLE'))
      .toMatchObject({ severity: 'block', nextAction: expect.any(String), route: { page: 'guide' } });
    expect(response.body).not.toContain('source_files_offline');
  } finally { await pool.query('ALTER TABLE source_files_offline RENAME TO source_files'); }
});

it('rejects incomplete scopes before reading a different shop', async () => {
  expect((await call('?shopId=9001001')).statusCode).toBe(400);
  expect((await call('?environment=production&partnerId=987654&shopId=0')).statusCode).toBe(400);
});

it('keeps a recent failed health check visible instead of treating freshness as a healthy connection', async () => {
  await pool.query("UPDATE connections SET refresh_status='waiting',health_checked_at=$2 WHERE id=$1", [selectedId, new Date(Date.now() - 60000)]);
  try {
    const response = await call('?environment=production&partnerId=987654&shopId=9001001');
    const data = response.json();
    expect(data.connections.data.items[0].health).toMatchObject({ state: 'fresh', outcome: 'attention' });
    expect(data.blockers.find((b: any) => b.connectionId === selectedId && b.code === 'CONNECTION_CHECK_NEEDS_ATTENTION'))
      .toMatchObject({ severity: 'attention', scope: selected, route: { page: 'shops' } });
    expect(data.status).toBe('degraded');
  } finally { await pool.query("UPDATE connections SET refresh_status='healthy' WHERE id=$1", [selectedId]); }
});

it('discloses omitted actions when the bounded connection summary has more issues than it can display', async () => {
  const ids = (await pool.query(`INSERT INTO connections(id,environment,partner_id,shop_id,name)
    SELECT gen_random_uuid(),'sandbox','777777',(8000000+n)::text,'Bounded fixture'
    FROM generate_series(1,101) n RETURNING id`)).rows.map(r => r.id);
  try {
    const response = await call(), data = response.json();
    expect(data.connections.data).toMatchObject({ total: 103, truncated: true });
    expect(data.connections.data.items).toHaveLength(100);
    expect(data.blockers).toHaveLength(100);
    expect(data.blockers.at(-1)).toMatchObject({ code: 'OPERATIONS_BLOCKERS_TRUNCATED', severity: 'attention' });
  } finally { await pool.query('DELETE FROM connections WHERE id=ANY($1::uuid[])', [ids]); }
});
