import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate, Repository } from '../../packages/persistence/src/index.js';
import { makePlan } from '../../packages/domain/src/index.js';
import { fact, fixtureDraft, fixtureScope } from '../helpers/fixtures.js';
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

function membershipDraft() {
  const draft = { ...fixtureDraft(), productKey: randomUUID() };
  draft.tierNames = ['Màu sắc', 'Quy cách'];
  draft.variants = [
    { ...draft.variants[0], sku: fact(' SKU A '), optionLabels: ['Trắng', '100 cái'] },
    {
      ...draft.variants[0],
      key: 'variant-b',
      sku: fact('SKU B'),
      optionLabels: ['Đen', '300 cái'],
    },
  ];
  return draft;
}

it.each([
  [
    'adding an unrelated SKU',
    (d: ReturnType<typeof membershipDraft>) => {
      d.variants.push({ ...d.variants[0], key: 'outside', sku: fact('UNRELATED') });
    },
  ],
  [
    'removing a SKU',
    (d: ReturnType<typeof membershipDraft>) => {
      d.variants.pop();
    },
  ],
  [
    'replacing a SKU',
    (d: ReturnType<typeof membershipDraft>) => {
      d.variants[0].sku = fact('OTHER');
    },
  ],
  [
    'reordering the same SKUs',
    (d: ReturnType<typeof membershipDraft>) => {
      d.variants.reverse();
    },
  ],
  [
    'normalizing literal SKU whitespace',
    (d: ReturnType<typeof membershipDraft>) => {
      d.variants[0].sku = fact('SKU A');
    },
  ],
  [
    'renaming a tier',
    (d: ReturnType<typeof membershipDraft>) => {
      d.tierNames[0] = 'Loại';
    },
  ],
  [
    'removing a tier',
    (d: ReturnType<typeof membershipDraft>) => {
      d.tierNames.pop();
      d.variants.forEach((v) => v.optionLabels.pop());
    },
  ],
  [
    'adding a tier',
    (d: ReturnType<typeof membershipDraft>) => {
      d.tierNames.push('Đóng gói');
      d.variants.forEach((v) => v.optionLabels.push('Hộp'));
    },
  ],
  [
    'renaming an option',
    (d: ReturnType<typeof membershipDraft>) => {
      d.variants[0].optionLabels[0] = 'Trắng mới';
    },
  ],
  [
    'reordering option labels',
    (d: ReturnType<typeof membershipDraft>) => {
      d.variants[0].optionLabels.reverse();
    },
  ],
] as const)('locks existing listing structure when %s', async (_name, change) => {
  const original = membershipDraft();
  await repo.saveProduct(original, 0);
  const changed = structuredClone(original);
  changed.revision = 2;
  change(changed);

  await expect(repo.saveProduct(changed, 1)).rejects.toThrow('PRODUCT_MEMBERSHIP_LOCKED');
  expect(await repo.getProduct(original.productKey)).toEqual(original);
  expect(await repo.getProduct(original.productKey, 2)).toBeNull();
  expect(
    (
      await pool.query('SELECT latest_revision FROM products WHERE product_key=$1', [
        original.productKey,
      ])
    ).rows[0].latest_revision,
  ).toBe(1);
});

it('allows refreshed source rows, prices, images and content while preserving the prepared structure', async () => {
  const original = membershipDraft();
  await repo.saveProduct(original, 0);
  const changed = structuredClone(original);
  changed.revision = 2;
  changed.title = fact('Explicitly supplied revised title');
  changed.description = [{ type: 'text', text: 'Explicitly supplied revised content' }];
  changed.coverKey = 'revised-cover';
  changed.galleryKeys = ['revised-gallery'];
  changed.variants[0].key = 'refreshed-source-row';
  changed.variants[0].sku.sources[0].locator = 'new-workbook-row';
  changed.variants[0].originalPrice = fact('150');
  changed.variants[0].imageKey = 'revised-variant-image';

  await expect(repo.saveProduct(changed, 1)).resolves.toEqual(changed);
  expect(await repo.getProduct(original.productKey)).toEqual(changed);
  expect(await repo.getProduct(original.productKey, 1)).toEqual(original);
});

it('retains revision conflicts before evaluating a membership change', async () => {
  const original = membershipDraft();
  await repo.saveProduct(original, 0);
  const changed = structuredClone(original);
  changed.variants.pop();
  await expect(repo.saveProduct({ ...changed, revision: 2 }, 0)).rejects.toThrow(
    'PRODUCT_REVISION_CONFLICT',
  );
  await expect(repo.saveProduct({ ...changed, revision: 3 }, 2)).rejects.toThrow(
    'PRODUCT_REVISION_CONFLICT',
  );
  expect(await repo.getProduct(original.productKey)).toEqual(original);
});
