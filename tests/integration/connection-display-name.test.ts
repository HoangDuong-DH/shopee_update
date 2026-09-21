import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, BlobStore, Repository, migrate } from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { WorkbenchService } from '../../apps/api/src/workbench-service.js';

const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
const headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
let root: string, app: Awaited<ReturnType<typeof createApp>>;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), 'shopee-name-test-'));
  app = await createApp(repo, new BlobStore(root), ['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (root && root.startsWith(join(tmpdir(), 'shopee-name-test-')))
    await rm(root, { recursive: true, force: true });
});
const call = (options: any) => app.getHttpAdapter().getInstance().inject(options);
async function connection() {
  const connectionId = randomUUID();
  await pool.query(
    `INSERT INTO connections(id,environment,partner_id,shop_id,name,region,revision,capability_revision,state,token_ciphertext,partner_key_ciphertext)
    VALUES($1,'sandbox','1232297',$2,'Official Test Shop','VN',7,3,'connected','private-token-ciphertext','private-key-ciphertext')`,
    [connectionId, String(Date.now()) + String(Math.floor(Math.random() * 1e6))],
  );
  return connectionId;
}
function rename(id: string, displayName: string | null, expectedNameRevision: number) {
  return call({
    method: 'PATCH',
    url: `/v1/connections/${id}/display-name`,
    headers,
    payload: { displayName, expectedNameRevision },
  });
}

it('exposes the official name and alias revision without secret fields', async () => {
  const id = await connection();
  const response = await call({ method: 'GET', url: '/v1/shops' });
  expect(response.statusCode).toBe(200);
  expect(response.json().find((s: any) => s.id === id)).toMatchObject({
    name: 'Official Test Shop',
    officialName: 'Official Test Shop',
    displayName: null,
    nameRevision: 0,
  });
  expect(response.payload).not.toContain('ciphertext');
});

it('changes only the local alias and serves it to shops and workbench without touching connection revision', async () => {
  const id = await connection();
  const before = (await pool.query('SELECT * FROM connections WHERE id=$1', [id])).rows[0];
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Unexpected external request');
  });
  try {
    const response = await rename(id, 'Shop thử nghiệm VN', 0);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id,
      name: 'Shop thử nghiệm VN',
      officialName: 'Official Test Shop',
      displayName: 'Shop thử nghiệm VN',
      nameRevision: 1,
      scope: { connectionRevision: 7, capabilityRevision: 3 },
    });
    expect(response.payload).not.toContain('ciphertext');
    const after = (await pool.query('SELECT * FROM connections WHERE id=$1', [id])).rows[0];
    expect({ ...after, display_name: null, name_revision: 0 }).toEqual(before);
    const shops = (await call({ method: 'GET', url: '/v1/shops' })).json();
    expect(shops.find((s: any) => s.id === id).name).toBe('Shop thử nghiệm VN');
    expect((await new WorkbenchService(repo).shops()).find((s) => s.id === id)?.name).toBe(
      'Shop thử nghiệm VN',
    );
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});

it('requires the current name revision and allows clearing the alias', async () => {
  const id = await connection();
  expect((await rename(id, 'Alias A', 0)).statusCode).toBe(200);
  const stale = await rename(id, 'Alias stale', 0);
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('CONNECTION_NAME_REVISION_CONFLICT');
  const restored = await rename(id, null, 1);
  expect(restored.statusCode).toBe(200);
  expect(restored.json()).toMatchObject({
    name: 'Official Test Shop',
    displayName: null,
    nameRevision: 2,
  });
});

it('allows only one competing alias update from the same revision', async () => {
  const id = await connection();
  const results = await Promise.all([rename(id, 'Alias A', 0), rename(id, 'Alias B', 0)]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const row = (await pool.query('SELECT name_revision FROM connections WHERE id=$1', [id])).rows[0];
  expect(row.name_revision).toBe(1);
});

it('returns an existing normalized alias on a lost-response replay without bumping either revision', async () => {
  const id = await connection();
  expect((await rename(id, 'Alias A', 0)).json().nameRevision).toBe(1);
  const replay = await rename(id, '  Alias A  ', 0);
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toMatchObject({
    displayName: 'Alias A',
    nameRevision: 1,
    scope: { connectionRevision: 7 },
  });
  expect((await rename(id, 'Alias A', 1)).json().nameRevision).toBe(1);
  expect((await rename(id, null, 1)).json().nameRevision).toBe(2);
  expect((await rename(id, null, 1)).json().nameRevision).toBe(2);
});

it('validates names, strict payload and unknown targets', async () => {
  const id = await connection();
  for (const displayName of [' ', 'x'.repeat(121), 'line\nbreak', '\nAlias', 'Alias\t'])
    expect((await rename(id, displayName, 0)).statusCode).toBe(400);
  expect((await rename(randomUUID(), 'Alias', 0)).statusCode).toBe(404);
  expect(
    (
      await call({
        method: 'PATCH',
        url: `/v1/connections/${id}/display-name`,
        headers,
        payload: { displayName: 'Alias', expectedNameRevision: 0, shop_id: 1 },
      })
    ).statusCode,
  ).toBe(400);
  expect((await rename(id, '  Alias  ', 0)).json().name).toBe('Alias');
});

it('rejects cross-origin alias writes with no name change', async () => {
  const id = await connection();
  const response = await call({
    method: 'PATCH',
    url: `/v1/connections/${id}/display-name`,
    headers: { ...headers, origin: 'https://other.invalid' },
    payload: { displayName: 'Other', expectedNameRevision: 0 },
  });
  expect(response.statusCode).toBe(403);
  expect((await pool.query('SELECT name FROM connections WHERE id=$1', [id])).rows[0].name).toBe(
    'Official Test Shop',
  );
});
