import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { SecretBox, signRequest } from '../../packages/shopee/src/index.js';
import { connectProductionPilot, productionConnectionTarget } from '../../apps/api/src/production-connection-service.js';

const schema = 'test_prod_connection_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
const repo = new Repository(pool);
const encryptionKey = 'ab'.repeat(32), box = new SecretBox(encryptionKey);
const scope = 'production:2010476:1423724897';
const input = {
  partnerId: '2010476', shopId: '1423724897', expectedRevision: 0,
  partnerKey: 'fixture-live-private-key', accessToken: 'fixture-live-private-token',
  refreshToken: 'fixture-live-private-refresh',
};
const shopReply = (patch: Record<string, unknown> = {}) => new Response(JSON.stringify({
  error: '', shop_name: 'VUA TINH DAU fixture', region: 'VN', status: 'NORMAL',
  request_id: 'fixture-shop-read', expire_time: Math.floor(Date.now() / 1000) + 3600,
  ...patch,
}));
const saved = async () => (await pool.query("SELECT * FROM connections WHERE environment='production'")).rows;

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await pool.query(`INSERT INTO connections(id,environment,partner_id,shop_id,name)
    VALUES($1,'sandbox','1232297','227418363','Protected sandbox fixture')`, [randomUUID()]);
});
beforeEach(async () => {
  await pool.query('DELETE FROM connection_checks');
  await pool.query("DELETE FROM connections WHERE environment='production'");
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

it('only returns a declared target; reading it creates nothing and exposes no secrets', async () => {
  const target = await productionConnectionTarget(repo);
  expect(target).toMatchObject({ shopId: input.shopId, partnerId: input.partnerId,
    connectionRevision: 0, connectionId: null, productionWrites: false });
  expect(await saved()).toEqual([]);
});

it('calls only signed production GET, stores scoped ciphertext and no product jobs', async () => {
  const sandboxBefore = (await pool.query("SELECT * FROM connections WHERE environment='sandbox'")).rows;
  const transport = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(raw));
    expect(url.origin).toBe('https://partner.shopeemobile.com');
    expect(url.pathname).toBe('/api/v2/shop/get_shop_info');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(url.searchParams.get('shop_id')).toBe('1423724897');
    expect(url.searchParams.get('partner_id')).toBe('2010476');
    expect(url.searchParams.get('sign')).toBe(signRequest({
      ...input, path: url.pathname, timestamp: Number(url.searchParams.get('timestamp')),
    }));
    return shopReply();
  });
  const result = await connectProductionPilot(repo, input, { encryptionKey, transport });
  expect(result).toMatchObject({ kind: 'success', connectionRevision: 1, productionWrites: false,
    automaticRefreshReady: true, tokenExpiryKnown: false });
  expect(transport).toHaveBeenCalledTimes(1);
  const [row] = await saved();
  expect(box.open(row.partner_key_ciphertext, scope)).toEqual({ partnerKey: input.partnerKey });
  expect(box.open(row.token_ciphertext, scope)).toEqual({ accessToken: input.accessToken, refreshToken: input.refreshToken });
  expect(JSON.stringify(row)).not.toContain('private');
  expect(JSON.stringify(result)).not.toContain('private');
  expect(JSON.stringify(await productionConnectionTarget(repo))).not.toContain('private');
  expect(row.capabilities.map((c: any) => c.name)).toEqual(['shop.read']);
  expect((await pool.query('SELECT count(*) FROM jobs')).rows[0].count).toBe('0');
  expect((await pool.query('SELECT count(*) FROM outbox')).rows[0].count).toBe('0');
  expect((await pool.query("SELECT * FROM connections WHERE environment='sandbox'")).rows).toEqual(sandboxBefore);
  expect(JSON.stringify((await pool.query('SELECT * FROM connection_checks')).rows)).not.toContain('private');
});

it.each([
  { shopId: '227418363' }, { partnerId: '1232297' },
  { environment: 'sandbox' }, { expectedRevision: -1 }, { partnerKey: '', accessToken: 'short' },
])('rejects invalid scope/input before calling transport: %j', async (patch) => {
  const transport = vi.fn(async () => shopReply());
  await expect(connectProductionPilot(repo, { ...input, ...patch }, { encryptionKey, transport })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  expect(await saved()).toEqual([]);
});

it('requires a key for a first connection', async () => {
  const transport = vi.fn(async () => shopReply());
  await expect(connectProductionPilot(repo, { ...input, partnerKey: '' }, { encryptionKey, transport }))
    .rejects.toThrow('PRODUCTION_CONNECTION_KEY_REQUIRED');
  expect(transport).not.toHaveBeenCalled();
});

it.each(['error_partner_key_expired', 'invalid_acceess_token', 'shop_no_linked', 'secret-from-upstream'])
('never stores a rejected connection or arbitrary upstream secrets: %s', async (code) => {
  const result = await connectProductionPilot(repo, input, { encryptionKey,
    transport: async () => shopReply({ error: code, message: input.accessToken }),
  });
  expect(result.kind).toBe('rejected');
  expect(JSON.stringify(result)).not.toContain(input.accessToken);
  expect(JSON.stringify(result)).not.toContain('secret-from-upstream');
  expect(await saved()).toEqual([]);
});

it('transport timeout does not create a connection', async () => {
  const result = await connectProductionPilot(repo, input, { encryptionKey,
    transport: async () => { throw new Error(input.partnerKey); },
  });
  expect(result).toEqual({ kind: 'unknown', reason: 'transport' });
  expect(await saved()).toEqual([]);
});

it.each([{ region: 'SG' }, { status: 'BANNED' }, { expire_time: 1 }])
('rejects wrong region/status/expired authorization: %j', async (patch) => {
  await expect(connectProductionPilot(repo, input, { encryptionKey,
    transport: async () => shopReply(patch),
  })).rejects.toThrow(/^PRODUCTION_CONNECTION_/);
  expect(await saved()).toEqual([]);
});

it('two concurrent initial saves cannot overwrite each other', async () => {
  let arrived = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const transport = async () => { if (++arrived === 2) release(); await barrier; return shopReply(); };
  const results = await Promise.allSettled([
    connectProductionPilot(repo, input, { encryptionKey, transport }),
    connectProductionPilot(repo, { ...input, accessToken: 'second-private-token' }, { encryptionKey, transport }),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect(await saved()).toHaveLength(1);
  expect((await pool.query('SELECT count(*) FROM connection_checks')).rows[0].count).toBe('1');
});

it('renews via CAS, preserves saved key/refresh and rejects stale revision before HTTP', async () => {
  await connectProductionPilot(repo, input, { encryptionKey, transport: async () => shopReply() });
  const transport = vi.fn(async () => shopReply());
  await expect(connectProductionPilot(repo, input, { encryptionKey, transport }))
    .rejects.toThrow('PRODUCTION_CONNECTION_REVISION_CONFLICT');
  expect(transport).not.toHaveBeenCalled();
  await connectProductionPilot(repo, { ...input, expectedRevision: 1,
    partnerKey: '', refreshToken: '', accessToken: 'renewed-private-token',
  }, { encryptionKey, transport });
  const [row] = await saved();
  expect(row.revision).toBe(2);
  expect(box.open(row.token_ciphertext, scope)).toEqual({ accessToken: 'renewed-private-token', refreshToken: input.refreshToken });
});
