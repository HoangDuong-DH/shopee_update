import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { Pool, Repository, migrate } from '@shopee/persistence';
import { SecretBox } from '@shopee/gateway';
import { refreshProductionPilotConnection } from '../../apps/api/src/production-refresh-service.js';
const schema = 'test_refresh_' + randomUUID().replaceAll('-', ''),
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},public`,
  }),
  repo = new Repository(pool);
const owner = 'production:2010476:1423724897',
  encryptionKey = 'a1'.repeat(32),
  box = new SecretBox(encryptionKey),
  connectionId = randomUUID();
let receiptRoot: string;
const tokens = {
  access_token: 'fixture-new-access-secret',
  refresh_token: 'fixture-new-refresh-secret',
};
const reply = (patch = {}) =>
  new Response(
    JSON.stringify({
      error: '',
      partner_id: 2010476,
      shop_id: 1423724897,
      ...tokens,
      expire_in: 14400,
      request_id: 'refresh-receipt',
      ...patch,
    }),
  );
const getReply = () =>
  new Response(
    JSON.stringify({
      error: '',
      shop_name: 'Fixture shop',
      region: 'VN',
      status: 'NORMAL',
      request_id: 'shop-read-receipt',
    }),
  );
const transport = () =>
  vi.fn(async (raw: RequestInfo | URL) =>
    new URL(String(raw)).pathname === '/api/v2/auth/access_token/get' ? reply() : getReply(),
  );
const current = async () =>
  (await pool.query('SELECT * FROM connections WHERE id=$1', [connectionId])).rows[0];
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query('TRUNCATE production_pilot_operations,connections CASCADE');
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,revision,token_ciphertext,partner_key_ciphertext,expires_at) VALUES($1,'production','2010476','1423724897','Existing name','connected',1,$2,$3,now()-interval '1 minute')",
    [
      connectionId,
      box.seal({ accessToken: 'fixture-old-access', refreshToken: 'fixture-old-refresh' }, owner),
      box.seal({ partnerKey: 'fixture-partner-secret' }, owner),
    ],
  );
  receiptRoot = await mkdtemp(resolve('.local/refresh-test-'));
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
const call = (fetcher: typeof fetch, mode: 'refresh' | 'recover' = 'refresh') =>
  refreshProductionPilotConnection(repo, {
    expectedRevision: 1,
    mode,
    receiptRoot,
    encryptionKey,
    transport: fetcher,
  });
it('refreshes an expired saved token once, seals the receipt, verifies shop and stores CAS revision/TTL without touching OAuth attempts', async () => {
  const fetcher = transport(),
    started = Date.now(),
    result = await call(fetcher);
  expect(result.kind).toBe('success');
  expect(result.connectionRevision).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const row = await current();
  expect(row.name).toBe('Existing name');
  expect(row.revision).toBe(2);
  expect(box.open(row.token_ciphertext, owner)).toEqual({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  });
  expect(new Date(row.expires_at).getTime()).toBeLessThanOrEqual(started + 14400000 + 1000);
  expect(
    (await pool.query('SELECT count(*) FROM production_authorization_attempts')).rows[0].count,
  ).toBe('0');
  const saved = await readFile(result.receiptPath!, 'utf8');
  expect(saved).not.toContain(tokens.access_token);
  expect(saved).not.toContain(tokens.refresh_token);
  expect(JSON.stringify(result)).not.toContain('secret');
  const replay = vi.fn();
  expect((await call(replay, 'recover')).kind).toBe('already_saved');
  expect(replay).not.toHaveBeenCalled();
});
it('stores rotated credentials before a failed shop read, then recovers without issuing another refresh', async () => {
  const first = vi.fn(async (raw: RequestInfo | URL) =>
    new URL(String(raw)).pathname === '/api/v2/auth/access_token/get'
      ? reply()
      : new Response(JSON.stringify({ error: 'invalid_acceess_token' })),
  );
  expect((await call(first)).kind).toBe('unknown');
  expect((await current()).revision).toBe(1);
  const recover = vi.fn(async (raw: RequestInfo | URL) => {
    expect(new URL(String(raw)).pathname).toBe('/api/v2/shop/get_shop_info');
    return getReply();
  });
  expect((await call(recover, 'recover')).kind).toBe('success');
  expect(recover).toHaveBeenCalledTimes(1);
});
it('marks a transport timeout as unknown and never automatically sends the single-use refresh token again', async () => {
  const lost = vi.fn(async () => {
    throw Error('signed url secret');
  });
  expect((await call(lost)).kind).toBe('unknown');
  expect(lost).toHaveBeenCalledTimes(1);
  const again = vi.fn();
  await expect(call(again)).rejects.toThrow('PRODUCTION_REFRESH_ALREADY_ATTEMPTED');
  expect(again).not.toHaveBeenCalled();
  await expect(call(again, 'recover')).rejects.toThrow('PRODUCTION_REFRESH_RECEIPT_UNAVAILABLE');
});
it('fails closed before network when a production operation has been sent', async () => {
  await pool.query(
    "INSERT INTO production_pilot_operations(id,owner_key,connection_id,connection_revision,source_identity,source_revision,source_payload,source_fingerprint,expected_projection,state) VALUES($1,$2,$3,1,'fixture',1,'{}',$4,'{}','sent')",
    [randomUUID(), owner, connectionId, '1'.repeat(64)],
  );
  const fetcher = vi.fn();
  await expect(call(fetcher)).rejects.toThrow('PRODUCTION_REFRESH_WRITER_ACTIVE');
  expect(fetcher).not.toHaveBeenCalled();
});

it('permits refresh past an unsent reservation without a lane or steps and preserves that reservation',async()=>{
  const op=randomUUID();
  await pool.query("INSERT INTO production_pilot_operations(id,owner_key,connection_id,connection_revision,source_identity,source_revision,source_payload,source_fingerprint,expected_projection,state) VALUES($1,$2,$3,1,'unsent',1,'{}',$4,'{}','authorized')",[op,owner,connectionId,'1'.repeat(64)]);
  const before=(await pool.query('SELECT * FROM production_pilot_operations WHERE id=$1',[op])).rows[0];
  expect((await call(transport())).kind).toBe('success');
  expect((await pool.query('SELECT * FROM production_pilot_operations WHERE id=$1',[op])).rows[0]).toEqual(before);
});

it('serializes competing refresh commands for one connection revision so only one token rotation can be sent', async () => {
  const fetcher = transport();
  const results = await Promise.allSettled([call(fetcher), call(fetcher)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(
    fetcher.mock.calls.filter(
      ([raw]) => new URL(String(raw)).pathname === '/api/v2/auth/access_token/get',
    ),
  ).toHaveLength(1);
  expect((await current()).revision).toBe(2);
});

it('recovers an acknowledged token response after the connection transaction rolls back, without rotating twice', async () => {
  await pool.query(
    "CREATE FUNCTION fixture_refresh_save_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture save failure'; END $$",
  );
  await pool.query(
    'CREATE TRIGGER fixture_refresh_save_failure BEFORE INSERT ON connection_checks FOR EACH ROW EXECUTE FUNCTION fixture_refresh_save_failure()',
  );
  try {
    await expect(call(transport())).rejects.toThrow('fixture save failure');
    expect((await current()).revision).toBe(1);
  } finally {
    await pool.query('DROP TRIGGER fixture_refresh_save_failure ON connection_checks');
    await pool.query('DROP FUNCTION fixture_refresh_save_failure()');
  }
  const recover = vi.fn(async (raw: RequestInfo | URL) => {
    expect(new URL(String(raw)).pathname).toBe('/api/v2/shop/get_shop_info');
    return getReply();
  });
  expect((await call(recover, 'recover')).kind).toBe('success');
  expect(recover).toHaveBeenCalledTimes(1);
});

it('does not confuse an acknowledged operation row with a fully acknowledged lane when steps are missing', async () => {
  const op = randomUUID();
  await pool.query(
    "INSERT INTO production_pilot_operations(id,owner_key,connection_id,connection_revision,source_identity,source_revision,source_payload,source_fingerprint,expected_projection,state,item_id) VALUES($1,$2,$3,1,'incomplete',1,$4,$5,'{}','acknowledged','123')",
    [
      op,
      owner,
      connectionId,
      {
        document: {
          cover: { importId: 'cover', sha256: 'a'.repeat(64) },
          gallery: [],
          description: [],
          models: [],
          tierNames: [],
        },
      },
      '1'.repeat(64),
    ],
  );
  await pool.query('INSERT INTO production_pilot_lanes(owner_key,operation_id) VALUES($1,$2)', [
    owner,
    op,
  ]);
  const fetcher = vi.fn();
  await expect(call(fetcher)).rejects.toThrow('PRODUCTION_REFRESH_WRITER_ACTIVE');
  expect(fetcher).not.toHaveBeenCalled();
});
it('allows token refresh for a lane whose entire create is acknowledged, preserving that lane and every old receipt', async () => {
  const op = randomUUID(),
    doc = {
      cover: { importId: 'cover', sha256: 'a'.repeat(64) },
      gallery: [],
      description: [],
      models: [],
      tierNames: [],
    };
  await pool.query(
    "INSERT INTO production_pilot_operations(id,owner_key,connection_id,connection_revision,source_identity,source_revision,source_payload,source_fingerprint,expected_projection,state,item_id) VALUES($1,$2,$3,1,'fixture',1,$4,$5,'{}','acknowledged','123')",
    [op, owner, connectionId, { document: doc }, '1'.repeat(64)],
  );
  for (const [index, key] of ['media-0', 'create'].entries())
    await pool.query(
      "INSERT INTO production_pilot_steps(id,operation_id,step_key,ordinal,kind,path,payload,media,fingerprint,authorized_revision,state,receipt,outcome_fingerprint,sent_at) VALUES($1,$2,$3,$4,$5,$6,'{}',$7,$8,1,'acknowledged','{}',$8,now())",
      [
        randomUUID(),
        op,
        key,
        index + 1,
        index ? 'create' : 'media',
        index ? '/api/v2/product/add_item' : '/api/v2/media_space/upload_image',
        index ? null : {},
        '2'.repeat(64),
      ],
    );
  await pool.query('INSERT INTO production_pilot_lanes(owner_key,operation_id) VALUES($1,$2)', [
    owner,
    op,
  ]);
  const before = (await pool.query('SELECT * FROM production_pilot_steps')).rows;
  expect((await call(transport())).kind).toBe('success');
  expect(
    (await pool.query('SELECT operation_id FROM production_pilot_lanes')).rows[0].operation_id,
  ).toBe(op);
  expect((await pool.query('SELECT * FROM production_pilot_steps')).rows).toEqual(before);
});
