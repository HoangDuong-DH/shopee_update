import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate, Repository } from '../../packages/persistence/src/index.js';
import { makePlan } from '../../packages/domain/src/index.js';
import { fixtureDraft, fixtureScope } from '../helpers/fixtures.js';
const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function savedPlan() {
  const draft = { ...fixtureDraft(), productKey: randomUUID() };
  await repo.saveProduct(draft, 0);
  const plan = makePlan({
    revision: 1,
    scope: fixtureScope,
    productKey: draft.productKey,
    sourceRevision: 1,
    operation: 'create',
    fieldMask: ['title'],
    desired: draft,
    stocks: [],
    issues: [],
  });
  await repo.savePlan(plan);
  return plan;
}
it('reports not ready when a required migration is missing', async () => {
  await repo.probe();
  const removed = await pool.query(
    "DELETE FROM schema_migrations WHERE name='002_connection_checks.sql' RETURNING *",
  );
  try {
    await expect(repo.probe()).rejects.toThrow('MIGRATIONS_NOT_READY');
  } finally {
    const r = removed.rows[0];
    await pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
      r.name,
      r.checksum,
    ]);
  }
});
it('submits two concurrent requests as one durable job and one outbox entry', async () => {
  const p = await savedPlan();
  const [a, b] = await Promise.all([
    repo.submitPlan(p.id, 1, p.fingerprint),
    repo.submitPlan(p.id, 1, p.fingerprint),
  ]);
  expect(a.jobId).toBe(b.jobId);
  expect((await pool.query('SELECT * FROM outbox WHERE job_id=$1', [a.jobId])).rowCount).toBe(1);
  const restarted = new Repository(pool);
  expect((await restarted.getJob(a.jobId))?.state).toBe('queued');
});
it('rejects stale fingerprint and product revision without modifying submitted plans', async () => {
  const p = await savedPlan();
  await expect(repo.submitPlan(p.id, 1, 'stale')).rejects.toThrow('PLAN_CONFLICT');
  await repo.saveProduct(
    { ...p.desired, revision: 2, title: { ...p.desired.title, value: 'Changed' } },
    1,
  );
  await expect(repo.submitPlan(p.id, 1, p.fingerprint)).rejects.toThrow('SOURCE_REVISION_CHANGED');
  expect((await repo.getPlan(p.id, 1))?.desired.title.value).toBe('Supplied title');
  await expect(
    pool.query('UPDATE product_revisions SET body=body WHERE product_key=$1', [p.productKey]),
  ).rejects.toThrow('IMMUTABLE_REVISION');
});
it('rolls back submission if outbox insert fails', async () => {
  const p = await savedPlan();
  await pool.query(
    "ALTER TABLE outbox ADD CONSTRAINT reject_outbox CHECK (topic <> 'job.ready') NOT VALID",
  );
  try {
    await expect(repo.submitPlan(p.id, 1, p.fingerprint)).rejects.toThrow();
    expect((await pool.query('SELECT * FROM jobs WHERE plan_id=$1', [p.id])).rowCount).toBe(0);
  } finally {
    await pool.query('ALTER TABLE outbox DROP CONSTRAINT reject_outbox');
  }
});
it('uses compare-and-swap to reject lost product edits', async () => {
  const d = { ...fixtureDraft(), productKey: randomUUID() };
  await repo.saveProduct(d, 0);
  const updates = await Promise.allSettled([
    repo.saveProduct({ ...d, revision: 2 }, 1),
    repo.saveProduct({ ...d, revision: 2 }, 1),
  ]);
  expect(updates.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});
