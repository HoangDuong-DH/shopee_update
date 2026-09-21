import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { canonicalJson } from '../../packages/domain/src/index.js';
import { Pool, migrate, storeSourceCatalog } from '../../packages/persistence/src/index.js';
import { buildSourceCatalog } from '../../apps/api/src/source-catalog-build.js';
import { qaWorkbook, qaCanva, qaFolder } from '../fixtures/source-catalog.js';
import {
  attachSourceCatalogEvidence,
  listSourceCatalogEvidence,
  type SourceCatalogEvidenceBody,
} from '../../packages/persistence/src/source-catalog-evidence.js';
const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '5442')
  throw Error('LOCAL_TEST_DATABASE_REQUIRED');
const schema = 'test_catalog_evidence_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: url.href }),
  pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}` });
const snapshot = buildSourceCatalog(qaWorkbook(), qaCanva(), qaFolder);
const sha = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const body = (): SourceCatalogEvidenceBody => ({
  schemaVersion: 'source-catalog-evidence/v1',
  catalogId: snapshot.catalog.id,
  importFingerprint: snapshot.catalog.importFingerprint,
  snapshotChecksum: sha(snapshot),
  publishable: false,
  originalAssetsExported: false,
  counts: {
    listings: snapshot.listings.length,
    designs: snapshot.designs.length,
    pages: snapshot.pages.length,
  },
  files: [
    {
      role: 'catalog_snapshot',
      path: '.local/fixture/catalog-snapshot.json',
      sha256: 'a'.repeat(64),
      bytes: 2,
    },
  ],
  designs: snapshot.designs.map((d) => ({
    designId: d.id,
    sourceFile: {
      role: 'canva_design_pages',
      path: '.local/fixture/' + d.id + '.json',
      sha256: 'a'.repeat(64),
      bytes: 2,
    },
    metadataSha256: 'b'.repeat(64),
    expectedPageCount: d.pageCount,
    currentPageCount: d.pageCount,
    observedAt: '2026-09-14T09:00:00Z',
    metadataUpdatedAt: d.updatedAt,
  })),
  observation: {
    sourceSnapshotAtomic: false,
    from: '2026-09-14T08:00:00Z',
    to: '2026-09-14T09:00:00Z',
  },
});
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await storeSourceCatalog(pool, snapshot);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
it('appends evidence idempotently while keeping the catalog row unchanged', async () => {
  const before = (
    await pool.query('SELECT * FROM source_catalogs WHERE id=$1', [snapshot.catalog.id])
  ).rows;
  const input = { catalogId: snapshot.catalog.id, body: body() };
  const first = await attachSourceCatalogEvidence(pool, input),
    second = await attachSourceCatalogEvidence(pool, input);
  expect(first.inserted).toBe(true);
  expect(second).toEqual({ ...first, inserted: false });
  expect((await listSourceCatalogEvidence(pool, snapshot.catalog.id)).length).toBe(1);
  expect(
    (await pool.query('SELECT * FROM source_catalogs WHERE id=$1', [snapshot.catalog.id])).rows,
  ).toEqual(before);
});
it('rejects another snapshot or catalog without adding an attachment', async () => {
  await expect(
    attachSourceCatalogEvidence(pool, {
      catalogId: snapshot.catalog.id,
      body: { ...body(), snapshotChecksum: 'b'.repeat(64) },
    }),
  ).rejects.toThrow('CATALOG_EVIDENCE_SNAPSHOT_CHANGED');
  await expect(
    attachSourceCatalogEvidence(pool, { catalogId: randomUUID(), body: body() }),
  ).rejects.toThrow('CATALOG_EVIDENCE_SCOPE_CHANGED');
});
it('rejects absolute or escaping evidence paths and an executable claim', async () => {
  for (const path of [
    'C:/secret/file.json',
    '../outside.json',
    '.local/../outside.json',
    'https://example.test/file',
  ])
    await expect(
      attachSourceCatalogEvidence(pool, {
        catalogId: snapshot.catalog.id,
        body: { ...body(), files: [{ ...body().files[0]!, path }] },
      }),
    ).rejects.toThrow('CATALOG_EVIDENCE_INPUT_INVALID');
  await expect(
    attachSourceCatalogEvidence(pool, {
      catalogId: snapshot.catalog.id,
      body: { ...body(), publishable: true } as any,
    }),
  ).rejects.toThrow('CATALOG_EVIDENCE_INPUT_INVALID');
});
it('prevents changing or deleting appended evidence', async () => {
  await expect(
    pool.query('UPDATE source_catalog_evidence SET body=$1 WHERE catalog_id=$2', [
      {},
      snapshot.catalog.id,
    ]),
  ).rejects.toThrow('CATALOG_EVIDENCE_IMMUTABLE');
  await expect(
    pool.query('DELETE FROM source_catalog_evidence WHERE catalog_id=$1', [snapshot.catalog.id]),
  ).rejects.toThrow('CATALOG_EVIDENCE_IMMUTABLE');
});
