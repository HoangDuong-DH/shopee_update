import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import {
  prepareProductionAuthorization,
  finishProductionAuthorization,
  productionAuthorizationStatus,
} from '../../apps/api/src/production-authorization-service.js';

const schema = 'test_oauth_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
let app: Awaited<ReturnType<typeof createApp>>;
const encryptionKey = 'cd'.repeat(32);
const input = {
  partnerId: '2010476',
  shopId: '1423724897',
  expectedRevision: 0,
  partnerKey: 'fixture-new-live-key',
};
const options = { encryptionKey };
const tokenReply = (patch = {}) =>
  new Response(
    JSON.stringify({
      error: '',
      access_token: 'fixture-access-token',
      refresh_token: 'fixture-refresh-token',
      expire_in: 14400,
      shop_id_list: [1423724897],
      ...patch,
    }),
  );
const shopReply = () =>
  new Response(
    JSON.stringify({
      error: '',
      shop_name: 'VUATINHDAU fixture',
      region: 'VN',
      status: 'NORMAL',
      request_id: 'fixture-shop-read',
    }),
  );
const exchange = vi.fn(async (url: RequestInfo | URL) =>
  String(url).includes('/auth/token/get') ? tokenReply() : shopReply(),
);
const query = (prepared: any, patch = {}) => ({
  state: new URL(prepared.authorizationUrl).searchParams.get('state'),
  code: 'fixture-once-only-code',
  shop_id: '1423724897',
  ...patch,
});
it('does not consume a code whose attempt expires while waiting for the connection lock', async () => {
  const p = await prepareProductionAuthorization(repo, input, options);
  const lock = await pool.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['connection-enrollment:production:2010476:1423724897']);
  const pending = finishProductionAuthorization(repo, query(p), p.browserSecret, { ...options, transport: exchange });
  try {
    await vi.waitFor(async () => {
      const result = await pool.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted");
      expect(Number(result.rows[0].count)).toBeGreaterThan(0);
    });
    await pool.query("UPDATE production_authorization_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [p.attemptId]);
  } finally { await lock.query('COMMIT'); lock.release(); }
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(exchange).not.toHaveBeenCalled();
});
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  app = await createApp(repo, new BlobStore('.local/oauth-test-unused'), ['http://127.0.0.1:5173']);
  await app.getHttpAdapter().getInstance().ready();
});
beforeEach(async () => {
  await pool.query('DELETE FROM production_authorization_attempts');
  await pool.query('DELETE FROM connection_checks');
  await pool.query('DELETE FROM connections');
  exchange.mockClear();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

it('prepares a fixed shop authorization with encrypted key, hashed state and no API calls', async () => {
  const p = await prepareProductionAuthorization(repo, input, options);
  const url = new URL(p.authorizationUrl);
  expect(url.origin + url.pathname).toBe('https://open.shopee.com/auth');
  expect(url.searchParams.get('partner_id')).toBe('2010476');
  expect(url.searchParams.get('redirect_uri')).toBe(
    'http://127.0.0.1:4310/v1/connections/production-pilot/callback',
  );
  expect(url.searchParams.get('state')).toHaveLength(64);
  const row = (await pool.query('SELECT * FROM production_authorization_attempts')).rows[0];
  expect(JSON.stringify(row)).not.toContain(input.partnerKey);
  expect(JSON.stringify(row)).not.toContain(p.browserSecret);
  expect(JSON.stringify(row)).not.toContain(url.searchParams.get('state'));
  expect((await productionAuthorizationStatus(repo, p.attemptId, p.browserSecret)).status).toBe(
    'pending',
  );
  expect((await pool.query('SELECT count(*) FROM connections')).rows[0].count).toBe('0');
});
it.each([{ shopId: '227418363' }, { partnerId: '1115815' }, { redirectUri: 'https://evil.test' }])(
  'rejects scope/redirect overrides before prepare',
  async (patch) => {
    await expect(
      prepareProductionAuthorization(repo, { ...input, ...patch }, options),
    ).rejects.toThrow();
  },
);
it('exchanges one code then verifies exact shop; atomically stores expiry and final receipt', async () => {
  const p = await prepareProductionAuthorization(repo, input, options);
  const result = await finishProductionAuthorization(repo, query(p), p.browserSecret, {
    ...options,
    transport: exchange,
  });
  expect(result.status).toBe('verified');
  expect(exchange).toHaveBeenCalledTimes(2);
  const row = (await pool.query('SELECT * FROM connections')).rows[0];
  expect(row.shop_id).toBe('1423724897');
  expect(row.environment).toBe('production');
  expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 14000 * 1000);
  expect(row.capabilities.map((c: any) => c.name)).toEqual(['shop.read']);
  const attempt = (await pool.query('SELECT * FROM production_authorization_attempts')).rows[0];
  expect(attempt.status).toBe('verified');
  expect(attempt.key_ciphertext).toBeNull();
  expect(attempt.connection_id).toBe(row.id);
  expect(JSON.stringify(result)).not.toMatch(/fixture-access|fixture-refresh|fixture-once/);
  expect((await pool.query('SELECT count(*) FROM jobs')).rows[0].count).toBe('0');
  expect((await pool.query('SELECT count(*) FROM outbox')).rows[0].count).toBe('0');
});
it.each(['wrong-state', 'wrong-browser', 'wrong-shop', 'both-account-ids', 'missing-code'])(
  'blocks %s before token HTTP',
  async (mode) => {
    const p = await prepareProductionAuthorization(repo, input, options);
    const q: any = query(p);
    if (mode === 'wrong-state') q.state = 'ab'.repeat(32);
    if (mode === 'wrong-shop') q.shop_id = '227418363';
    if (mode === 'both-account-ids') q.main_account_id = '123';
    if (mode === 'missing-code') delete q.code;
    await expect(
      finishProductionAuthorization(
        repo,
        q,
        mode === 'wrong-browser' ? 'ac'.repeat(32) : p.browserSecret,
        { ...options, transport: exchange },
      ),
    ).rejects.toThrow();
    expect(exchange).not.toHaveBeenCalled();
  },
);
it('refuses expired state, removes staged key and sends no request', async () => {
  const p = await prepareProductionAuthorization(repo, input, options);
  await pool.query(
    "UPDATE production_authorization_attempts SET expires_at=now()-interval '1 second'",
  );
  await expect(
    finishProductionAuthorization(repo, query(p), p.browserSecret, {
      ...options,
      transport: exchange,
    }),
  ).rejects.toThrow();
  expect(exchange).not.toHaveBeenCalled();
  const s = await productionAuthorizationStatus(repo, p.attemptId, p.browserSecret);
  expect(s.status).toBe('expired');
  expect(
    (await pool.query('SELECT key_ciphertext FROM production_authorization_attempts')).rows[0]
      .key_ciphertext,
  ).toBeNull();
});
it('concurrent callback and replay exchange only once', async () => {
  const p = await prepareProductionAuthorization(repo, input, options);
  await Promise.allSettled(
    [1, 2].map(() =>
      finishProductionAuthorization(repo, query(p), p.browserSecret, {
        ...options,
        transport: exchange,
      }),
    ),
  );
  await finishProductionAuthorization(repo, query(p), p.browserSecret, {
    ...options,
    transport: exchange,
  });
  expect(exchange).toHaveBeenCalledTimes(2);
  expect((await productionAuthorizationStatus(repo, p.attemptId, p.browserSecret)).status).toBe(
    'verified',
  );
});
it('does not retry a code when exchange outcome is unknown', async () => {
  const p = await prepareProductionAuthorization(repo, input, options);
  const transport = vi.fn(async () => {
    throw new Error('do not echo secret-code');
  });
  expect(
    (
      await finishProductionAuthorization(repo, query(p), p.browserSecret, {
        ...options,
        transport,
      })
    ).status,
  ).toBe('unknown');
  await finishProductionAuthorization(repo, query(p), p.browserSecret, { ...options, transport });
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each([{ ids: [227418363] }])(
  'rejects unexpected main-account grants %j without shop read',
  async ({ ids }) => {
    const p = await prepareProductionAuthorization(repo, input, options);
    const transport = vi.fn(async () => tokenReply({ shop_id_list: ids }));
    const q = query(p, { shop_id: undefined, main_account_id: '123456' });
    expect(
      (await finishProductionAuthorization(repo, q, p.browserSecret, { ...options, transport }))
        .status,
    ).toBe('rejected');
    expect(transport).toHaveBeenCalledTimes(1);
  },
);
it('accepts main account authorizing only target shop', async () => {
  const p = await prepareProductionAuthorization(repo, input, options);
  const q = query(p, { shop_id: undefined, main_account_id: '123456' });
  expect(
    (
      await finishProductionAuthorization(repo, q, p.browserSecret, {
        ...options,
        transport: exchange,
      })
    ).status,
  ).toBe('verified');
});
it('HTTP enrollment sets HttpOnly cookie, strips internal secret, validates origin, redirects callback without secrets', async () => {
  const call = (o: any) => app.getHttpAdapter().getInstance().inject(o);
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(exchange);
  try {
    const route = '/v1/connections/production-pilot/authorize';
    expect((await call({ method: 'POST', url: route, payload: input })).statusCode).toBe(403);
    expect(
      (
        await call({
          method: 'POST',
          url: route,
          headers: { origin: 'https://evil.test', 'x-app-client': 'internal-workspace' },
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    const response = await call({
      method: 'POST',
      url: route,
      headers: { origin: 'http://127.0.0.1:5173', 'x-app-client': 'internal-workspace' },
      payload: input,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(response.payload).not.toMatch(/fixture-new-live-key|browserSecret/);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    const prepared = response.json();
    const url =
      '/v1/connections/production-pilot/callback?' + new URLSearchParams(query(prepared) as any);
    const wrongCookie = await call({ method: 'GET', url });
    expect(wrongCookie.statusCode).toBe(400);
    expect(network).not.toHaveBeenCalled();
    expect(wrongCookie.payload).not.toContain('fixture-once');
    const callback = await call({ method: 'GET', url, headers: { cookie } });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe(
      '/v1/connections/production-pilot/authorization-result/' + prepared.attemptId,
    );
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
    const page = await call({ method: 'GET', url: callback.headers.location, headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.payload).toContain('Đã kết nối');
    expect(page.payload).not.toMatch(
      /fixture-access|fixture-refresh|fixture-once|fixture-new-live/,
    );
    expect(network).toHaveBeenCalledTimes(2);
    const poll = await call({
      method: 'GET',
      url: '/v1/connections/production-pilot/authorization/' + prepared.attemptId,
      headers: { cookie },
    });
    expect(poll.json().status).toBe('verified');
  } finally {
    network.mockRestore();
  }
});
it('connection revision changed before callback does not consume code', async () => {
  const p = await prepareProductionAuthorization(repo, input, options);
  await pool.query(
    `INSERT INTO connections(id,environment,partner_id,shop_id,name,revision)
    VALUES($1,'production','2010476','1423724897','newer-connection',1)`,
    [randomUUID()],
  );
  expect(
    (
      await finishProductionAuthorization(repo, query(p), p.browserSecret, {
        ...options,
        transport: exchange,
      })
    ).status,
  ).toBe('rejected');
  expect(exchange).not.toHaveBeenCalled();
});
it('second preparation retires previous browser session and staged key', async () => {
  const a = await prepareProductionAuthorization(repo, input, options);
  const b = await prepareProductionAuthorization(repo, input, options);
  expect((await productionAuthorizationStatus(repo, a.attemptId, a.browserSecret)).status).toBe(
    'expired',
  );
  expect((await productionAuthorizationStatus(repo, b.attemptId, b.browserSecret)).status).toBe(
    'pending',
  );
  await expect(productionAuthorizationStatus(repo, a.attemptId, b.browserSecret)).rejects.toThrow();
});
