import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { BulkProductEditService } from '../../apps/api/src/bulk-product-edit-service.js';
import { bulkProductEditInput } from '../../packages/domain/src/bulk-product-edit.js';
import { fact, fixtureDraft } from '../helpers/fixtures.js';

// This destructive-schema test is intentionally unavailable against the operating database.
const target = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/invalid');
if (process.env.INTERNAL_ISOLATED_MODE !== '1' || target.hostname !== '127.0.0.1' || target.port !== '5443'
  || target.pathname !== '/shopee_internal_test' || target.username !== 'shopee_internal')
  throw Error('BULK_EDIT_TEST_REQUIRES_ISOLATED_DATABASE');
const schema = 'bulk_edit_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
const repo = new Repository(pool), service = new BulkProductEditService(repo);
let created = false;
beforeAll(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
afterAll(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function createDraft() {
  const draft = fixtureDraft(); draft.productKey = randomUUID();
  draft.variants = ['100ml', '280ml', '500ml'].map((label, index) => ({ key: `row-${index}`, sku: fact(`REAL-${index}`),
    optionLabels: [label], originalPrice: fact(`${(index + 1) * 10000}`) }));
  draft.sourceSelection = { title: draft.title.value, headline: 'H', body: 'B', galleryIds: [], descriptionImageIds: [], tierNames: [...draft.tierNames],
    variants: draft.variants.map(variant => ({ importId: randomUUID(), rowKey: variant.key, optionLabels: variant.optionLabels })) };
  return repo.saveProduct(draft, 0);
}
async function command() {
  const drafts = await Promise.all([createDraft(), createDraft()]);
  const input = bulkProductEditInput.parse({ operationId: randomUUID(), entries: drafts.map(draft => ({ productKey: draft.productKey, expectedRevision: draft.revision })),
    removeVolumesMl: [280], sortVolumeDescending: true });
  const preview = await service.preview(input);
  return { drafts, request: { input, expectedDigest: preview.digest } };
}

it('concurrent exact applies commit one immutable revision per product and replay safely', async () => {
  const { drafts, request } = await command();
  const results = await Promise.all([service.apply(request), service.apply(request)]);
  expect(results.map(result => result.recovered).sort()).toEqual([false, true]);
  for (const before of drafts) {
    const current = await repo.getProduct(before.productKey);
    expect(current?.revision).toBe(2);
    expect(current?.variants.map(variant => variant.optionLabels)).toEqual([['500ml'], ['100ml']]);
    expect(current?.sourceSelection?.variants.map(variant => variant.rowKey)).toEqual(['row-2', 'row-0']);
    expect(current?.variants[0]?.sku).toEqual(before.variants[2]?.sku);
    expect(await repo.getProduct(before.productKey, 1)).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS count FROM product_revisions WHERE product_key=$1', [before.productKey])).rows[0].count).toBe(2);
  }
});

it('a changed second source rejects the whole apply without changing the first source', async () => {
  const { drafts, request } = await command(), second = drafts[1]!;
  await repo.saveProduct({ ...second, revision: 2, title: fact('Edited by another operator') }, 1);
  await expect(service.apply(request)).rejects.toThrow('PRODUCT_REVISION_CONFLICT');
  expect((await repo.getProduct(drafts[0]!.productKey))?.revision).toBe(1);
  expect((await repo.getProduct(second.productKey))?.title.value).toBe('Edited by another operator');
});

it('an actual PostgreSQL insert failure rolls back the earlier product update and revision insert', async () => {
  const { drafts, request } = await command();
  await pool.query(`ALTER TABLE product_revisions ADD CONSTRAINT bulk_injected_failure CHECK (NOT (product_key='${drafts[1]!.productKey}' AND revision=2)) NOT VALID`);
  try {
    await expect(service.apply(request)).rejects.toThrow('bulk_injected_failure');
    for (const before of drafts) {
      expect(await repo.getProduct(before.productKey)).toEqual(before);
      expect(await repo.getProduct(before.productKey, 2)).toBeNull();
    }
  } finally { await pool.query('ALTER TABLE product_revisions DROP CONSTRAINT bulk_injected_failure'); }
});
