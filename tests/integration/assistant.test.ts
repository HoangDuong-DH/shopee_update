import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { AssistantService } from '../../apps/api/src/assistant-service.js';
import { BlobStore, Repository, migrate } from '../../packages/persistence/src/index.js';
import { makePlan } from '../../packages/domain/src/plans.js';
import { fixtureDraft, fixtureScope } from '../helpers/fixtures.js';
import { createApp } from '../../apps/api/src/app.js';

const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
let app: Awaited<ReturnType<typeof createApp>>, plan: ReturnType<typeof makePlan>;
const headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
const source = {
  id: 'open-platform:guide:test',
  title: 'Fixture product guide',
  url: 'https://open.shopee.com/developer-guide/209',
  kind: 'guide',
  corpus: 'open-platform' as const,
  sourceUpdatedAt: '2025-09-19',
  capturedAt: '2026-09-08',
  sha256: 'a'.repeat(64),
};
// Only the filesystem KB boundary uses a fixture; HTTP, scope checks and PostgreSQL remain real.
const knowledge = {
  search: async () => ({ hits: [{ ...source, excerpt: 'Fixture reference text' }], issues: [] }),
  readDocument: async () => ({
    source,
    text: 'Reference only. No business fact is supplied here.',
  }),
};
const call = (method: string, url: string, payload?: unknown) =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({ method: method as 'GET' | 'POST', url, headers, payload: payload as object });
const input = () => ({
  requestId: randomUUID(),
  planId: plan.id,
  revision: plan.revision,
  fingerprint: plan.fingerprint,
  query: 'product attributes',
});
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,revision,capability_revision,state,token_ciphertext) VALUES($1,'sandbox','123','456','Fixture',1,1,'connected','do-not-return-this-secret')",
    [randomUUID()],
  );
  await repo.saveProduct(fixtureDraft(), 0);
  plan = makePlan({
    revision: 1,
    scope: fixtureScope,
    productKey: 'test',
    sourceRevision: 1,
    operation: 'create',
    fieldMask: ['title'],
    desired: fixtureDraft(),
    stocks: [],
    issues: [],
  });
  await repo.savePlan(plan);
  app = await createApp(
    repo,
    new BlobStore('.local/unused-assistant-fixture'),
    ['http://localhost:5173'],
    { knowledge },
  );
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
it('persists a scoped source-backed review and exposes no completion claim about publishing or QC', async () => {
  const request = input();
  const response = await call('POST', '/v1/assistant/reviews', request);
  expect(response.statusCode).toBe(201);
  const result = response.json();
  expect(result.state).toBe('completed');
  expect(result.result.mode).toBe('deterministic_review');
  expect(result.result.inspection.listingExecution).toBe('not_verified');
  expect(result.result.inspection.qc).toBe('not_verified');
  expect(result.result.sources).toEqual([source]);
  expect(result.result.sources[0].capturedAt).toBe('2026-09-08');
  expect(result.events.filter((e: { phase: string }) => e.phase === 'completed')).toHaveLength(3);
  expect(response.payload).not.toContain('do-not-return-this-secret');
  expect((await call('GET', '/v1/assistant/reviews/' + result.id)).json()).toEqual(result);
  const duplicate = (await call('POST', '/v1/assistant/reviews', request)).json();
  expect(duplicate.id).toBe(result.id);
  expect(
    (
      await pool.query('SELECT count(*)::int AS n FROM assistant_reviews WHERE request_id=$1', [
        request.requestId,
      ])
    ).rows[0].n,
  ).toBe(1);
  expect((await pool.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  expect((await repo.getProduct('test'))?.title.value).toBe('Supplied title');
});
it('rejects scope overrides and request-id reuse for changed intent', async () => {
  const request = input();
  await call('POST', '/v1/assistant/reviews', request);
  expect(
    (await call('POST', '/v1/assistant/reviews', { ...request, shopId: '999' })).statusCode,
  ).toBe(400);
  expect(
    (await call('POST', '/v1/assistant/reviews', { ...request, query: 'different' })).statusCode,
  ).toBe(409);
});
it('rejects a mismatched fingerprint before using source material', async () => {
  expect(
    (await call('POST', '/v1/assistant/reviews', { ...input(), fingerprint: '0'.repeat(64) }))
      .statusCode,
  ).toBe(409);
});
it('the review deadline also bounds its final validation and late completion cannot be published', async () => {
  const original = repo.getPlan.bind(repo);
  let reads = 0;
  const stalled = vi
    .spyOn(repo, 'getPlan')
    .mockImplementation((...args) => (++reads === 5 ? new Promise(() => {}) : original(...args)));
  try {
    const service = new AssistantService(repo, knowledge, { timeoutMs: 500 });
    const outcome = await Promise.race([
      service.review({ ...input(), query: '' }).then(
        () => 'unexpected completion',
        (e) => (e as Error).message,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);
    expect(outcome).toBe('DEADLINE_EXCEEDED');
    expect(reads).toBe(5);
    await expect
      .poll(async () => (await service.list()).some((r) => r.state === 'interrupted'), {
        timeout: 1500,
      })
      .toBe(true);
  } finally {
    stalled.mockRestore();
  }
});
it('a real database row lock cannot turn an expired review into completed after release', async () => {
  const request = { ...input(), query: '' };
  const holder = await pool.connect();
  const original = repo.getPlan.bind(repo);
  let reads = 0;
  let locked = false;
  const intercept = vi.spyOn(repo, 'getPlan').mockImplementation(async (...args) => {
    if (++reads === 5) {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM assistant_reviews WHERE request_id=$1 FOR UPDATE', [
        request.requestId,
      ]);
      locked = true;
    }
    return original(...args);
  });
  try {
    const service = new AssistantService(repo, knowledge, { timeoutMs: 2000 });
    const outcome = await service.review(request).catch((e) => (e as Error).message);
    expect(outcome).toBe('DEADLINE_EXCEEDED');
    expect(locked).toBe(true);
    await holder.query('COMMIT');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const row = (
      await pool.query('SELECT state FROM assistant_reviews WHERE request_id=$1', [
        request.requestId,
      ])
    ).rows[0];
    expect(row.state).not.toBe('completed');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    intercept.mockRestore();
  }
});
it('connection or capability changes make the old plan need a new review', async () => {
  await pool.query('UPDATE connections SET capability_revision=2');
  try {
    expect((await call('POST', '/v1/assistant/reviews', input())).statusCode).toBe(409);
  } finally {
    await pool.query('UPDATE connections SET capability_revision=1');
  }
});
it('a newer product revision prevents interpreting an older plan as current', async () => {
  await repo.saveProduct(
    {
      ...fixtureDraft(),
      revision: 2,
      title: { ...fixtureDraft().title, value: 'Updated by operator' },
    },
    1,
  );
  expect((await call('POST', '/v1/assistant/reviews', input())).statusCode).toBe(409);
});
