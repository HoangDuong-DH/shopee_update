import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { AssistantService } from '../../apps/api/src/assistant-service.js';
import { BlobStore, Repository, migrate } from '../../packages/persistence/src/index.js';
import { makePlan } from '../../packages/domain/src/plans.js';
import { fixtureDraft, fixtureScope } from '../helpers/fixtures.js';
import { createApp } from '../../apps/api/src/app.js';
import { Deadline } from '../../packages/agent-runtime/src/budget.js';

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
  expect(result.result.corridor.mode).toBe('inspect');
  expect(result.result.corridor.canWriteShopee).toBe(false);
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
it.each([0, 600])(
  'the review deadline bounds final validation and rejects late completion after %i ms of setup delay',
  async (setupDelay) => {
    const original = repo.getPlan.bind(repo);
    const realSetTimeout = globalThis.setTimeout;
    let enterFinalValidation!: () => void;
    const finalValidationEntered = new Promise<void>((resolve) => {
      enterFinalValidation = resolve;
    });
    let releaseFinalValidation!: () => void;
    const finalValidationReleased = new Promise<void>((resolve) => {
      releaseFinalValidation = resolve;
    });
    let lateRead: ReturnType<typeof repo.getPlan> | undefined;
    let reads = 0;
    // PostgreSQL setup is real I/O. Hold only the test's monotonic clock/timers
    // until the final-validation boundary; unrelated setup latency must not make
    // this test expire at an earlier read and miss the behavior under test.
    const monotonicClock = vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stalled = vi.spyOn(repo, 'getPlan').mockImplementation(async (...args) => {
      const read = ++reads;
      if (read === 5) {
        lateRead = finalValidationReleased.then(() => original(...args));
        enterFinalValidation();
        return lateRead;
      }
      const result = await original(...args);
      if (read === 4 && setupDelay)
        await new Promise((resolve) => realSetTimeout(resolve, setupDelay));
      return result;
    });
    const service = new AssistantService(repo, knowledge, { timeoutMs: 500 });
    const complete = vi.spyOn(
      service as unknown as {
        complete(id: string, result: unknown, deadline: Deadline): Promise<void>;
      },
      'complete',
    );
    try {
      const request = { ...input(), query: '' };
      let settled = false;
      const outcome = service
        .review(request)
        .then(
          () => 'unexpected completion',
          (e) => (e as Error).message,
        )
        .then((value) => {
          settled = true;
          return value;
        });
      await finalValidationEntered;
      expect(reads).toBe(5);
      const reviewId = (
        await pool.query('SELECT id FROM assistant_reviews WHERE request_id=$1', [
          request.requestId,
        ])
      ).rows[0].id as string;
      monotonicClock.mockReturnValue(499);
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      monotonicClock.mockReturnValue(500);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe('DEADLINE_EXCEEDED');
      // Actually finish the previously stalled read after expiry. No terminal
      // write may start, even though the read eventually returns a valid plan.
      releaseFinalValidation();
      expect((await lateRead)?.id).toBe(plan.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(complete).not.toHaveBeenCalled();
      expect(
        (
          await pool.query('SELECT state,result,finished_at FROM assistant_reviews WHERE id=$1', [
            reviewId,
          ])
        ).rows[0],
      ).toEqual({ state: 'running', result: null, finished_at: null });
      vi.useRealTimers();
      monotonicClock.mockRestore();
      await expect
        .poll(async () => (await service.get(reviewId)).state, {
          timeout: 1500,
        })
        .toBe('interrupted');
    } finally {
      releaseFinalValidation();
      complete.mockRestore();
      stalled.mockRestore();
      vi.useRealTimers();
      monotonicClock.mockRestore();
    }
  },
);
it('a real database row lock cannot turn an expired review into completed after release', async () => {
  const reviewId = randomUUID();
  await pool.query(
    "INSERT INTO assistant_reviews(id,request_id,request_hash,plan_id,plan_revision,scope,query,state,deadline_at) VALUES($1,$2,$3,$4,$5,$6,'','running',clock_timestamp()+interval '30 seconds')",
    [reviewId, randomUUID(), 'a'.repeat(64), plan.id, plan.revision, plan.scope],
  );
  const holder = await pool.connect();
  const completionPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},public`,
    max: 1,
  });
  let holding = false;
  try {
    // Complete setup before starting the deadline: a slow harness or fifth getPlan
    // must not prevent this test from ever acquiring its intended PostgreSQL lock.
    await completionPool.query('SELECT 1');
    await holder.query('BEGIN');
    holding = true;
    const locked = await holder.query('SELECT id FROM assistant_reviews WHERE id=$1 FOR UPDATE', [
      reviewId,
    ]);
    expect(locked.rowCount).toBe(1);
    const service = new AssistantService(new Repository(completionPool), knowledge);
    // Focused test boundary to the real transaction implementation; HTTP review
    // coverage remains in the other tests. The generous persisted row deadline
    // isolates the shorter execution deadline from an incidental SQL expiry.
    const completion = service as unknown as {
      complete(id: string, result: unknown, deadline: Deadline): Promise<void>;
    };
    await expect(
      completion.complete(reviewId, { marker: 'must-not-be-published' }, new Deadline(100)),
    ).rejects.toThrow('DEADLINE_EXCEEDED');
    await holder.query('COMMIT');
    holding = false;
    // With max:1 this read is queued after the completion transaction releases
    // its connection, so a late SQL update cannot race the assertion below.
    const row = (
      await completionPool.query(
        'SELECT state,result,finished_at FROM assistant_reviews WHERE id=$1',
        [reviewId],
      )
    ).rows[0];
    expect(row).toEqual({ state: 'running', result: null, finished_at: null });
  } finally {
    if (holding) await holder.query('ROLLBACK');
    holder.release();
    await completionPool.end();
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
