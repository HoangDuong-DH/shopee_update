import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Pool,
  Repository,
  migrate,
  BlobStore,
  SandboxCreateTrialStore,
} from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { SecretBox } from '../../packages/shopee/src/index.js';
import { SandboxFieldTrialService } from '../../apps/api/src/sandbox-field-trial-service.js';
const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool),
  connectionId = randomUUID(),
  trialId = randomUUID(),
  trialItemId = randomUUID(),
  key = '73'.repeat(32);
let app: Awaited<ReturnType<typeof createApp>>, blobsPath: string;
let remote: any,
  writes = 0,
  ackLost = false,
  tamper = false,
  reads = 0,
  driftAtClaim = false,
  promotionReads = 0;
let promotionResponse: any;
let promotionUnavailable = false;
const transport: typeof fetch = async (raw, init) => {
  const url = new URL(String(raw));
  expect(url.origin).toBe('https://openplatform.sandbox.test-stable.shopee.sg');
  const success = (response: any) =>
    new Response(JSON.stringify({ error: '', request_id: 'field-fixture', response }));
  if (url.pathname.endsWith('get_item_base_info')) {
    reads++;
    if (driftAtClaim && reads === 3) remote.weight = '0.9';
    return success({ item_list: [remote] });
  }
  if (url.pathname.endsWith('get_model_list'))
    return success({
      model: [{ model_id: 10, model_sku: 'SBX-BULK-UNEXPECTED', tier_index: [0] }],
      tier_variation: [{ name: 'Unexpected', option_list: [{ option: 'A' }] }],
    });
  if (url.pathname.endsWith('get_item_limit'))
    return success({
      price_limit: { min_limit: 100, max_limit: 999999 },
      stock_limit: { min_limit: 0, max_limit: 999 },
      item_name_length_limit: { min_limit: 5, max_limit: 120 },
      item_description_length_limit: { min_limit: 5, max_limit: 3000 },
      item_image_count_limit: { min_limit: 1, max_limit: 8 },
    });
  if (url.pathname.endsWith('get_item_promotion')) {
    promotionReads++;
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.searchParams.get('item_id_list')).toBe('900');
    if (promotionUnavailable) throw new Error('read unavailable');
    return success(promotionResponse);
  }
  const body = JSON.parse(String(init?.body));
  writes++;
  if (url.pathname.endsWith('update_item')) {
    if (body.item_name !== undefined) remote.item_name = body.item_name;
    if (body.description !== undefined) remote.description = body.description;
    if (tamper) remote.weight = '0.8';
    if (ackLost) throw new Error('lost fixture response');
    return success({ item_id: 900 });
  }
  if (url.pathname.endsWith('update_stock')) {
    remote.stock_info_v2.seller_stock[0].stock = body.stock_list[0].seller_stock[0].stock;
    remote.stock_info_v2.summary_info.total_available_stock =
      body.stock_list[0].seller_stock[0].stock;
    return success({
      success_list: [{ model_id: 0, stock: body.stock_list[0].seller_stock[0].stock }],
      failure_list: [],
    });
  }
  throw new Error('Unexpected fixture API');
};
const service = () =>
  new SandboxFieldTrialService(repo, { transport, encryptionKey: key, pause: async () => {} });
const prepare = (operation: any = { kind: 'title', value: 'SANDBOX QA changed' }) =>
  service().prepare({ id: randomUUID(), trialItemId, connectionRevision: 1, operation });
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const box = new SecretBox(key);
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,revision,token_ciphertext,partner_key_ciphertext) VALUES($1,'sandbox','1232297','227418363','fixture','connected',1,$2,$3)",
    [
      connectionId,
      box.seal({ accessToken: 'fixture-token' }, 'sandbox:1232297:227418363'),
      box.seal({ partnerKey: 'fixture-key' }, 'sandbox:1232297:227418363'),
    ],
  );
  await pool.query(
    "INSERT INTO sandbox_create_trials(id,trial_key,connection_id,connection_revision,fingerprint,manifest,evidence) VALUES($1,'SBX-BULK-FIELD',$2,1,'fixture','{}','{}')",
    [trialId, connectionId],
  );
  await pool.query(
    "INSERT INTO sandbox_create_trial_items(id,trial_id,connection_id,source_key,position,intent,state,stage,item_id) VALUES($1,$2,$3,'SBX-BULK-FIELD-001',0,$4,'verified','done','900')",
    [
      trialItemId,
      trialId,
      connectionId,
      {
        create: {
          item_sku: 'SBX-BULK-FIELD-001',
          category_id: 301378,
          image: { image_id_list: ['a', 'b'] },
        },
      },
    ],
  );
  blobsPath = await mkdtemp(join(tmpdir(), 'shopee-field-'));
  app = await createApp(repo, new BlobStore(blobsPath), ['http://localhost:5173'], {
    trialTransport: transport,
    trialEncryptionKey: key,
    trialPause: async () => {},
  });
});
beforeEach(async () => {
  await pool.query('DELETE FROM sandbox_field_trials');
  writes = 0;
  ackLost = false;
  tamper = false;
  reads = 0;
  driftAtClaim = false;
  promotionReads = 0;
  promotionUnavailable = false;
  promotionResponse = { success_list: [{ item_id: 900, promotion: [] }], failure_list: [] };
  await pool.query("UPDATE connections SET revision=1,state='connected' WHERE id=$1", [
    connectionId,
  ]);
  remote = {
    item_id: 900,
    item_sku: 'SBX-BULK-FIELD-001',
    item_name: 'SANDBOX QA original',
    item_status: 'UNLIST',
    category_id: 301378,
    has_model: false,
    description_type: 'normal',
    description: 'SANDBOX ONLY original content',
    image: { image_id_list: ['a', 'b'], image_ratio: '1:1' },
    promotion_image: { image_id_list: ['a'] },
    weight: '0.2',
    attribute_list: [{ attribute_id: 1, attribute_value_list: [{ value_id: 2 }] }],
    has_promotion: false,
    price_info: [{ currency: 'VND', original_price: 1200, current_price: 1200 }],
    stock_info_v2: {
      seller_stock: [{ stock: 8, location_id: 'VNZ', if_saleable: true }],
      shopee_stock: [],
      summary_info: { total_available_stock: 8, total_reserved_stock: 0 },
    },
  };
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (blobsPath) await rm(blobsPath, { recursive: true, force: true });
});
it('prepares, writes exactly the title and independently verifies all other returned fields', async () => {
  const run = await prepare();
  expect(writes).toBe(0);
  const done = await service().execute({ id: run.id, fingerprint: run.fingerprint });
  expect(done.state).toBe('verified');
  expect(done.result.check.unchanged).toBe(true);
  expect(writes).toBe(1);
});
it('cancels an unsent prepared draft without requiring a usable token or permitting later execution', async () => {
  const draft = await prepare();
  await pool.query("UPDATE connections SET revision=2,state='disconnected' WHERE id=$1", [
    connectionId,
  ]);
  const canceled = await service().cancel({ id: draft.id, fingerprint: draft.fingerprint });
  expect(canceled).toMatchObject({
    state: 'blocked',
    result: { code: 'DRAFT_CANCELLED', mutationSent: false },
  });
  expect(await service().execute({ id: draft.id, fingerprint: draft.fingerprint })).toMatchObject({
    state: 'blocked',
  });
  expect(writes).toBe(0);
});
it('does not let cancellation clear an unknown in-flight outcome', async () => {
  const draft = await prepare();
  await pool.query("UPDATE sandbox_field_trials SET state='unknown',result=$2 WHERE id=$1", [
    draft.id,
    { code: 'WRITE_INTENT_RECORDED' },
  ]);
  const canceled = await service().cancel({ id: draft.id, fingerprint: draft.fingerprint });
  expect(canceled).toMatchObject({ state: 'unknown', result: { code: 'WRITE_INTENT_RECORDED' } });
  expect(writes).toBe(0);
});
it('rejects a stale cancellation fingerprint and preserves the prepared draft', async () => {
  const draft = await prepare();
  await expect(service().cancel({ id: draft.id, fingerprint: '0'.repeat(64) })).rejects.toThrow(
    'FIELD_INTENT_CONFLICT',
  );
  expect(await service().get(draft.id)).toMatchObject({ state: 'prepared' });
});
it('a lost mutation response is resolved by readback, not another write', async () => {
  const run = await prepare();
  ackLost = true;
  const done = await service().execute({ id: run.id, fingerprint: run.fingerprint });
  expect(done.state).toBe('verified');
  expect(done.result.acknowledgement.kind).toBe('unknown');
  expect(writes).toBe(1);
});
it('stock replay after a simulated order does not replenish even across service restart', async () => {
  const run = await prepare({
    kind: 'stock',
    value: [{ model_id: 0, seller_stock: [{ stock: 20, location_id: 'VNZ' }] }],
  });
  expect((await service().execute({ id: run.id, fingerprint: run.fingerprint })).state).toBe(
    'verified',
  );
  remote.stock_info_v2.seller_stock[0].stock = 19;
  remote.stock_info_v2.summary_info.total_available_stock = 19;
  await service().execute({ id: run.id, fingerprint: run.fingerprint });
  expect(writes).toBe(1);
  expect(remote.stock_info_v2.seller_stock[0].stock).toBe(19);
});
it('leaves an unselected side effect unresolved and never repeats it', async () => {
  const run = await prepare();
  tamper = true;
  const done = await service().execute({ id: run.id, fingerprint: run.fingerprint });
  expect(done.state).toBe('unknown');
  expect(done.result.check.unselectedChangedPaths).toContain('item.weight');
  await service().execute({ id: run.id, fingerprint: run.fingerprint });
  expect(writes).toBe(1);
});
it('blocks source/shop drift between preparation and execution without mutation', async () => {
  const run = await prepare();
  remote.description = 'external edit';
  expect((await service().execute({ id: run.id, fingerprint: run.fingerprint })).state).toBe(
    'blocked',
  );
  expect(writes).toBe(0);
});
it('rejects a changed connection revision and unbound target', async () => {
  const run = await prepare();
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  await expect(service().execute({ id: run.id, fingerprint: run.fingerprint })).rejects.toThrow(
    'FIELD_CONNECTION_CHANGED',
  );
  await expect(
    service().prepare({
      id: randomUUID(),
      trialItemId: randomUUID(),
      connectionRevision: 2,
      operation: { kind: 'title', value: 'SANDBOX QA title' },
    }),
  ).rejects.toThrow('FIELD_TARGET_NOT_ALLOWED');
  expect(writes).toBe(0);
});
it('reusing a preparation ID with changed input is rejected', async () => {
  const run = await prepare();
  await expect(
    service().prepare({
      ...run.input,
      operation: { kind: 'title', value: 'SANDBOX QA different' },
    }),
  ).rejects.toThrow('FIELD_INTENT_CONFLICT');
});
it('an incomplete prior intent holds the shop lane for a different request', async () => {
  const a = await prepare(),
    b = await prepare({
      kind: 'description',
      value: { description_type: 'normal', description: 'SANDBOX ONLY changed content' },
    });
  await pool.query("UPDATE sandbox_field_trials SET state='unknown',started_at=now() WHERE id=$1", [
    a.id,
  ]);
  await expect(service().execute({ id: b.id, fingerprint: b.fingerprint })).rejects.toThrow(
    'FIELD_SHOP_BUSY',
  );
  expect(writes).toBe(0);
});
it('rereads after claiming the shop lane and blocks a change since the earlier read', async () => {
  const run = await prepare();
  driftAtClaim = true;
  expect((await service().execute({ id: run.id, fingerprint: run.fingerprint })).state).toBe(
    'blocked',
  );
  expect(writes).toBe(0);
});
it('refuses a model structure which was not in the verified create source', async () => {
  remote.has_model = true;
  await expect(prepare()).rejects.toThrow('FIELD_MODEL_BINDING_CHANGED');
  expect(writes).toBe(0);
});
it('an unknown field mutation also blocks the create worker lane', async () => {
  const run = await prepare();
  await pool.query("UPDATE sandbox_field_trials SET state='unknown' WHERE id=$1", [run.id]);
  const queued = randomUUID();
  await pool.query(
    "INSERT INTO sandbox_create_trial_items(id,trial_id,connection_id,source_key,position,intent,state,stage) VALUES($1,$2,$3,'SBX-BULK-FIELD-QUEUED',1,'{}','queued','queued')",
    [queued, trialId, connectionId],
  );
  try {
    expect(await new SandboxCreateTrialStore(pool).claim('fixture-worker')).toBeNull();
    expect(
      (await pool.query('SELECT state FROM sandbox_create_trial_items WHERE id=$1', [queued]))
        .rows[0].state,
    ).toBe('queued');
    expect(writes).toBe(0);
  } finally {
    await pool.query('DELETE FROM sandbox_create_trial_items WHERE id=$1', [queued]);
  }
});
it('HTTP prepare/execute/get records receipts with no keys; rejecting malformed input causes no write', async () => {
  const server = app.getHttpAdapter().getInstance(),
    headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
  const invalid = await server.inject({
    method: 'POST',
    url: '/v1/sandbox-field-trials/prepare',
    headers,
    payload: { itemId: '803934364' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(writes).toBe(0);
  const prepared = await server.inject({
    method: 'POST',
    url: '/v1/sandbox-field-trials/prepare',
    headers,
    payload: {
      id: randomUUID(),
      trialItemId,
      connectionRevision: 1,
      operation: { kind: 'title', value: 'SANDBOX QA via HTTP' },
    },
  });
  expect(prepared.statusCode).toBe(201);
  const run = prepared.json();
  const done = await server.inject({
    method: 'POST',
    url: '/v1/sandbox-field-trials/execute',
    headers,
    payload: { id: run.id, fingerprint: run.fingerprint },
  });
  expect(done.statusCode).toBe(201);
  expect(done.json().state).toBe('verified');
  const read = await server.inject({ method: 'GET', url: '/v1/sandbox-field-trials/' + run.id });
  expect(read.json().state).toBe('verified');
  expect(read.body).not.toMatch(/fixture-token|fixture-key|access_token|partner_key|ciphertext/);
  expect(writes).toBe(1);
});

it('HTTP inspection retains contradictory promotion signals and upcoming evidence without writes or guard relaxation', async () => {
  const before = (
    await pool.query('SELECT * FROM sandbox_create_trial_items WHERE id=$1', [trialItemId])
  ).rows[0];
  remote.has_promotion = true;
  remote.promotion_id = 0;
  const promotion = [
    { promotion_staging: 'ongoing', promotion_id: '18446744073709551615', model_id: 0 },
    {
      promotion_staging: 'upcoming',
      promotion_id: '2',
      model_id: 0,
      custom_metadata: { retained: true },
    },
  ];
  promotionResponse = { success_list: [{ item_id: 900, promotion }], failure_list: [] };
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: '/v1/sandbox-field-trials/inspect',
      headers: { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' },
      payload: { trialItemId, connectionRevision: 1 },
    });
  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({
    diagnosticOnly: true,
    mutationSent: false,
    itemId: '900',
    trialItemId,
    snapshot: { kind: 'success', data: { item: { has_promotion: true, promotion_id: 0 } } },
    promotions: { kind: 'success', data: { promotionFieldPresent: true, item: { promotion } } },
  });
  expect(reads).toBe(1);
  expect(promotionReads).toBe(1);
  expect(writes).toBe(0);
  expect((await pool.query('SELECT count(*) FROM sandbox_field_trials')).rows[0].count).toBe('0');
  expect(
    (await pool.query('SELECT * FROM sandbox_create_trial_items WHERE id=$1', [trialItemId]))
      .rows[0],
  ).toEqual(before);
  await expect(
    prepare({ kind: 'price', value: [{ model_id: 0, original_price: 1300 }] }),
  ).rejects.toThrow('FIELD_PROMOTION_REQUIRES_REVIEW');
  expect(writes).toBe(0);
});

it('inspection preserves missing detail and read failure as diagnostic uncertainty without creating a receipt', async () => {
  promotionResponse = { success_list: [{ item_id: 900 }] };
  const missing = await service().inspect({ trialItemId, connectionRevision: 1 });
  expect(missing.promotions).toMatchObject({
    kind: 'success',
    data: { promotionFieldPresent: false, item: { item_id: '900' } },
  });
  promotionUnavailable = true;
  const unavailable = await service().inspect({ trialItemId, connectionRevision: 1 });
  expect(unavailable.promotions).toMatchObject({ kind: 'unknown', reason: 'transport' });
  expect(writes).toBe(0);
  expect((await pool.query('SELECT count(*) FROM sandbox_field_trials')).rows[0].count).toBe('0');
});

it('inspection redacts credential reflections from snapshots and promotion metadata', async () => {
  remote.fixture_note = 'reflected fixture-token and fixture-key';
  promotionResponse = {
    success_list: [
      {
        item_id: 900,
        promotion: [
          {
            promotion_staging: 'upcoming',
            note: 'fixture-token',
            nested: { 'fixture-key': 'fixture-key' },
          },
        ],
      },
    ],
  };
  const result = await service().inspect({ trialItemId, connectionRevision: 1 });
  expect(JSON.stringify(result)).not.toMatch(/fixture-token|fixture-key/);
  expect(result.snapshot).toMatchObject({
    kind: 'success',
    data: { item: { fixture_note: 'reflected [redacted] and [redacted]' } },
  });
  expect(writes).toBe(0);
});

it('inspection enforces header, exact binding and connection revision before any promotion read', async () => {
  const unauthorized = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: '/v1/sandbox-field-trials/inspect',
      payload: { trialItemId, connectionRevision: 1 },
    });
  expect(unauthorized.statusCode).toBe(403);
  await expect(service().inspect({ trialItemId, connectionRevision: 2 })).rejects.toThrow(
    'FIELD_CONNECTION_CHANGED',
  );
  await expect(
    service().inspect({ trialItemId: randomUUID(), connectionRevision: 1 }),
  ).rejects.toThrow('FIELD_TARGET_NOT_ALLOWED');
  expect(reads).toBe(0);
  expect(promotionReads).toBe(0);
  remote.item_sku = 'wrong SKU';
  await expect(service().inspect({ trialItemId, connectionRevision: 1 })).rejects.toThrow(
    'FIELD_REMOTE_TARGET_CHANGED',
  );
  expect(promotionReads).toBe(0);
  expect(writes).toBe(0);
});
