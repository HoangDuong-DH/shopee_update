import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { SecretBox, signRequest } from '../../packages/shopee/src/index.js';
import { connectSandbox } from '../../apps/api/src/connection-service.js';
const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool),
  encryptionKey = 'cd'.repeat(32),
  box = new SecretBox(encryptionKey);
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function connection(stored = true, refresh = true, environment = 'sandbox') {
  const id = randomUUID(),
    shopId = String(Date.now()) + String(Math.floor(Math.random() * 100000)),
    scope = `${environment}:123:${shopId}`;
  await pool.query(
    'INSERT INTO connections(id,environment,partner_id,shop_id,name,revision,token_ciphertext,partner_key_ciphertext) VALUES($1,$2,$3,$4,$5,1,$6,$7)',
    [
      id,
      environment,
      '123',
      shopId,
      'Fixture',
      stored
        ? box.seal(
            {
              accessToken: 'old-private-token',
              ...(refresh ? { refreshToken: 'saved-private-refresh' } : {}),
            },
            scope,
          )
        : null,
      stored ? box.seal({ partnerKey: 'saved-private-key' }, scope) : null,
    ],
  );
  return { id, shopId, scope };
}
function success() {
  return new Response(
    JSON.stringify({
      error: '',
      shop_name: 'Fixture verified',
      region: 'VN',
      status: 'NORMAL',
      request_id: 'fixture-renewal',
    }),
  );
}
const stored = async (id: string) =>
  (await pool.query('SELECT * FROM connections WHERE id=$1', [id])).rows[0];

it('requires a key on first connect before sending any request', async () => {
  const c = await connection(false),
    transport = vi.fn(async () => success());
  await expect(
    connectSandbox(
      repo,
      { connectionId: c.id, expectedRevision: 1, accessToken: 'new-private-token' },
      { transport, encryptionKey },
    ),
  ).rejects.toThrow('SANDBOX_PARTNER_KEY_REQUIRED');
  expect(transport).not.toHaveBeenCalled();
  expect((await stored(c.id)).revision).toBe(1);
});
it('reuses an existing scoped key and preserves refresh when omitted or blank without exposing secrets', async () => {
  const c = await connection();
  const transport = vi.fn(async (raw: RequestInfo | URL) => {
    const url = new URL(String(raw));
    expect(url.searchParams.get('sign')).toBe(
      signRequest({
        partnerId: '123',
        shopId: c.shopId,
        accessToken: 'new-private-token',
        partnerKey: 'saved-private-key',
        path: '/api/v2/shop/get_shop_info',
        timestamp: Number(url.searchParams.get('timestamp')),
      }),
    );
    return success();
  }) as typeof fetch;
  const result = await connectSandbox(
    repo,
    {
      connectionId: c.id,
      expectedRevision: 1,
      partnerKey: '',
      accessToken: 'new-private-token',
      refreshToken: ' ',
    },
    { transport, encryptionKey },
  );
  expect(result.kind).toBe('success');
  expect(JSON.stringify(result)).not.toContain('private');
  const saved = await stored(c.id);
  expect(box.open(saved.token_ciphertext, c.scope)).toEqual({
    accessToken: 'new-private-token',
    refreshToken: 'saved-private-refresh',
  });
  expect(box.open(saved.partner_key_ciphertext, c.scope)).toEqual({
    partnerKey: 'saved-private-key',
  });
  expect(saved.token_ciphertext).not.toContain('private');
  const events = (
    await pool.query('SELECT result FROM connection_checks WHERE connection_id=$1', [c.id])
  ).rows;
  expect(JSON.stringify(events)).not.toContain('private');
});
it('allows explicit key replacement and new refresh or no previous refresh', async () => {
  const c = await connection(true, false);
  await connectSandbox(
    repo,
    {
      connectionId: c.id,
      expectedRevision: 1,
      partnerKey: 'replacement-private-key',
      accessToken: 'new-private-token',
      refreshToken: 'new-private-refresh',
    },
    { transport: async () => success(), encryptionKey },
  );
  const saved = await stored(c.id);
  expect(box.open(saved.partner_key_ciphertext, c.scope)).toEqual({
    partnerKey: 'replacement-private-key',
  });
  expect(box.open(saved.token_ciphertext, c.scope)).toEqual({
    accessToken: 'new-private-token',
    refreshToken: 'new-private-refresh',
  });
});
it('does not save failed authentication or an unknown transport outcome', async () => {
  const c = await connection(),
    before = await stored(c.id);
  const input = { connectionId: c.id, expectedRevision: 1, accessToken: 'rejected-private-token' };
  expect(
    (
      await connectSandbox(repo, input, {
        transport: async () =>
          new Response(
            JSON.stringify({ error: 'invalid_acceess_token', message: 'rejected-private-token' }),
            { status: 403 },
          ),
        encryptionKey,
      })
    ).kind,
  ).toBe('rejected');
  expect(
    (
      await connectSandbox(repo, input, {
        transport: async () => {
          throw new Error('private transport detail');
        },
        encryptionKey,
      })
    ).kind,
  ).toBe('unknown');
  const after = await stored(c.id);
  expect(after.revision).toBe(before.revision);
  expect(after.token_ciphertext).toBe(before.token_ciphertext);
  expect(after.partner_key_ciphertext).toBe(before.partner_key_ciphertext);
  expect(
    (await pool.query('SELECT count(*) FROM connection_checks WHERE connection_id=$1', [c.id]))
      .rows[0].count,
  ).toBe('0');
});
it('enforces CAS before and after the read so a slower renewal cannot overwrite a newer connection', async () => {
  const c = await connection(),
    before = await stored(c.id),
    transport = vi.fn(async () => success());
  await expect(
    connectSandbox(
      repo,
      { connectionId: c.id, expectedRevision: 2, accessToken: 'new-private-token' },
      { transport, encryptionKey },
    ),
  ).rejects.toThrow('PRODUCT_REVISION_CONFLICT');
  expect(transport).not.toHaveBeenCalled();
  await expect(
    connectSandbox(
      repo,
      { connectionId: c.id, expectedRevision: 1, accessToken: 'new-private-token' },
      {
        transport: async () => {
          await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [c.id]);
          return success();
        },
        encryptionKey,
      },
    ),
  ).rejects.toThrow('PRODUCT_REVISION_CONFLICT');
  expect((await stored(c.id)).token_ciphertext).toBe(before.token_ciphertext);
});
it('rejects another environment and ciphertext from a different scope before reading', async () => {
  const production = await connection(true, true, 'production'),
    c = await connection(),
    transport = vi.fn(async () => success());
  await expect(
    connectSandbox(
      repo,
      { connectionId: production.id, expectedRevision: 1, accessToken: 'new-private-token' },
      { transport, encryptionKey },
    ),
  ).rejects.toThrow('INVALID_SANDBOX_CONNECTION');
  await pool.query('UPDATE connections SET partner_key_ciphertext=$2 WHERE id=$1', [
    c.id,
    (await stored(production.id)).partner_key_ciphertext,
  ]);
  await expect(
    connectSandbox(
      repo,
      { connectionId: c.id, expectedRevision: 1, accessToken: 'new-private-token' },
      { transport, encryptionKey },
    ),
  ).rejects.toThrow('SANDBOX_SAVED_CREDENTIAL_INVALID');
  expect(transport).not.toHaveBeenCalled();
});
