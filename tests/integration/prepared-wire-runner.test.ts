import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import { PreparedWireRunner } from '../../apps/api/src/prepared-wire-runner.js';
import type { PreparedWirePlan } from '../../packages/shopee/src/prepared-wire.js';
const schema = 'test_wire_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema}`,
});
const repo = new Repository(pool),
  connectionId = randomUUID();
const key = Buffer.alloc(32, 29).toString('hex');
const scope = {
  environment: 'sandbox' as const,
  partnerId: '1232297',
  shopId: '227418363',
  connectionRevision: 1,
  capabilityRevision: 1,
};
let calls: string[], failPath: string | undefined, clock: number, runner: PreparedWireRunner;
const plan: Extract<PreparedWirePlan, { kind: 'ready' }> = {
  kind: 'ready' as const,
  operation: 'create' as const,
  steps: [
    {
      path: '/api/v2/product/add_item',
      method: 'POST' as const,
      payload: { item_name: 'SANDBOX QA journal', item_sku: 'WIRE-QA', item_status: 'UNLIST' },
      group: 'create' as const,
    },
    {
      path: '/api/v2/product/init_tier_variation',
      method: 'POST' as const,
      payload: { item_id: '$created_item_id', model: [{ model_sku: 'A', tier_index: [0] }] },
      group: 'variations' as const,
      minDelayAfterCreateMs: 5000,
    },
  ],
};
const transport: typeof fetch = async (input) => {
  const url = new URL(String(input));
  calls.push(url.pathname);
  if (url.pathname === failPath) throw new Error('dropped');
  const response = url.pathname.endsWith('/add_item')
    ? { item_id: 90001 }
    : url.pathname.endsWith('/init_tier_variation')
      ? { item_id: 90001, model: [{ model_id: 91001, model_sku: 'A', tier_index: [0] }] }
      : {};
  return new Response(
    JSON.stringify({ error: '', request_id: 'fixture-' + calls.length, response }),
  );
};
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const box = new SecretBox(key),
    owner = 'sandbox:1232297:227418363';
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,revision,capability_revision,state,partner_key_ciphertext,token_ciphertext) VALUES($1,$2,$3,$4,'Fixture',1,1,'connected',$5,$6)",
    [
      connectionId,
      'sandbox',
      '1232297',
      '227418363',
      box.seal({ partnerKey: 'fixture-key' }, owner),
      box.seal({ accessToken: 'fixture-token' }, owner),
    ],
  );
});
beforeEach(async () => {
  await pool.query('TRUNCATE prepared_wire_operations CASCADE');
  calls = [];
  failPath = undefined;
  clock = Date.now();
  runner = new PreparedWireRunner(repo, {
    allowedShops: [{ partnerId: scope.partnerId, shopId: scope.shopId }],
    encryptionKey: key,
    transport,
    now: () => new Date(clock),
    pause: async (ms) => {
      clock += ms;
    },
  });
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function prepare() {
  return runner.prepare({
    id: randomUUID(),
    connectionId,
    scope,
    sourceKey: 'WIRE-QA',
    sourceFingerprint: 'a'.repeat(64),
    plan,
  });
}
it('journals each request before dispatch, binds actual item and enforces add/init delay', async () => {
  const initial = clock,
    job = await prepare(),
    result = await runner.run(job.id);
  expect(result.state).toBe('acknowledged');
  expect(result.itemId).toBe('90001');
  expect(clock - initial).toBeGreaterThanOrEqual(5000);
  expect(result.steps.map((s: any) => s.state)).toEqual(['acknowledged', 'acknowledged']);
  expect(result.steps[1].payload.item_id).toBe(90001);
  expect(calls).toHaveLength(2);
  await runner.run(job.id);
  expect(calls).toHaveLength(2);
});
it('never resends an ambiguous create, even with a fresh runner', async () => {
  failPath = '/api/v2/product/add_item';
  const job = await prepare();
  expect((await runner.run(job.id)).state).toBe('unknown');
  failPath = undefined;
  await runner.run(job.id);
  expect(calls).toHaveLength(1);
  expect((await runner.get(job.id)).steps[0].state).toBe('unknown');
});
it('persists created identity before a failed init and never creates a second listing', async () => {
  failPath = '/api/v2/product/init_tier_variation';
  const job = await prepare();
  const result = await runner.run(job.id);
  expect(result.state).toBe('unknown');
  expect(result.itemId).toBe('90001');
  failPath = undefined;
  await runner.run(job.id);
  expect(calls.filter((p) => p.endsWith('/add_item'))).toHaveLength(1);
  expect(calls).toHaveLength(2);
});
it('rejects changed source under the same intent ID and mismatched connection scope', async () => {
  const job = await prepare();
  await expect(runner.prepare({ ...job.input, sourceFingerprint: 'b'.repeat(64) })).rejects.toThrow(
    'PREPARED_WIRE_INTENT_CONFLICT',
  );
  await expect(
    runner.prepare({ ...job.input, id: randomUUID(), scope: { ...scope, shopId: '999' } }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
it('blocks mixed-target update plans before any dispatch', async () => {
  const job = await prepare();
  await expect(
    runner.prepare({
      ...job.input,
      id: randomUUID(),
      plan: {
        kind: 'ready',
        operation: 'update',
        steps: [
          {
            path: '/api/v2/product/update_item',
            method: 'POST',
            group: 'title',
            payload: { item_id: 90001, item_name: 'one' },
          },
          {
            path: '/api/v2/product/update_item',
            method: 'POST',
            group: 'description',
            payload: { item_id: 90002, description: 'other' },
          },
        ],
      },
    }),
  ).rejects.toThrow('PREPARED_WIRE_PLAN_INVALID');
  expect(calls).toHaveLength(0);
});
it('a persisted pre-dispatch crash resumes only the never-sent stage, after the delay', async () => {
  const job = await prepare();
  await pool.query(
    "UPDATE prepared_wire_operations SET state='running',item_id='90001',claim_id=$2,lease_until=$3 WHERE id=$1",
    [job.id, randomUUID(), new Date(clock - 1)],
  );
  await pool.query(
    "INSERT INTO prepared_wire_steps(operation_id,ordinal,path,payload,fingerprint,state,sent_at,acknowledged_at) VALUES($1,0,$2,$3,$4,'acknowledged',$5,$5)",
    [job.id, plan.steps[0]!.path, plan.steps[0]!.payload, 'a'.repeat(64), new Date(clock)],
  );
  const result = await runner.run(job.id);
  expect(result.state).toBe('acknowledged');
  expect(calls).toEqual(['/api/v2/product/init_tier_variation']);
});
it('a persisted sent-stage crash is quarantined after lease expiry with no replay', async () => {
  const job = await prepare();
  await pool.query(
    "UPDATE prepared_wire_operations SET state='running',claim_id=$2,lease_until=$3 WHERE id=$1",
    [job.id, randomUUID(), new Date(clock - 1)],
  );
  await pool.query(
    "INSERT INTO prepared_wire_steps(operation_id,ordinal,path,payload,fingerprint,state,sent_at) VALUES($1,0,$2,$3,$4,'sent',$5)",
    [job.id, plan.steps[0]!.path, plan.steps[0]!.payload, 'a'.repeat(64), new Date(clock)],
  );
  expect((await runner.run(job.id)).state).toBe('unknown');
  expect(calls).toHaveLength(0);
});
it('an unknown operation blocks other operations for the same owner', async () => {
  const first = await prepare();
  failPath = '/api/v2/product/add_item';
  await runner.run(first.id);
  failPath = undefined;
  const second = await runner.prepare({
    ...first.input,
    id: randomUUID(),
    sourceKey: 'SECOND',
    sourceFingerprint: 'c'.repeat(64),
  });
  expect((await runner.run(second.id)).state).toBe('prepared');
  expect(calls).toHaveLength(1);
});
it('rejects stale connection before a new mutation and journals no unissued request', async () => {
  const job = await prepare();
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  try {
    expect((await runner.run(job.id)).state).toBe('blocked');
    expect(calls).toHaveLength(0);
    expect((await runner.get(job.id)).steps).toHaveLength(0);
  } finally {
    await pool.query('UPDATE connections SET revision=1 WHERE id=$1', [connectionId]);
  }
});
it('renewing credentials never grants a second create for the same source', async () => {
  const job = await prepare();
  await runner.run(job.id);
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  try {
    const replay = await runner.prepare({
      ...job.input,
      id: randomUUID(),
      scope: { ...scope, connectionRevision: 2 },
    });
    expect(replay.id).toBe(job.id);
    expect(replay.steps.map((s: any) => s.state)).toEqual(['acknowledged', 'acknowledged']);
    await runner.run(replay.id);
    expect(calls).toHaveLength(2);
    await expect(
      runner.prepare({
        ...job.input,
        id: randomUUID(),
        sourceFingerprint: 'f'.repeat(64),
        scope: { ...scope, connectionRevision: 2 },
      }),
    ).rejects.toThrow('PREPARED_WIRE_CREATE_SOURCE_EXISTS');
  } finally {
    await pool.query('UPDATE connections SET revision=1 WHERE id=$1', [connectionId]);
  }
});
