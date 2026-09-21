import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  BlobStore,
  Pool,
  Repository,
  migrate,
  storeSourceCatalog,
  getSourceCatalog,
  getCatalogListing,
  queryCatalogListings,
  listSourceCatalogs,
  type CatalogSnapshot,
} from '../../packages/persistence/src/index.js';
import { buildSourceCatalog } from '../../apps/api/src/source-catalog-build.js';
import { createApp } from '../../apps/api/src/app.js';
import {
  qaAfter,
  qaBefore,
  qaCanva,
  qaFolder,
  qaOriginal,
  qaTitle,
  qaVariants,
  qaWarning,
  qaWorkbook,
} from '../fixtures/source-catalog.js';

const database = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.port !== '5442')
  throw new Error('Source catalog tests require isolated local PG 5442');
const schema = 'test_source_catalog_' + randomUUID().replaceAll('-', '');
const directory = resolve('.local/input-catalog/vina-tuoi-20260914/source-catalog-tests', schema);
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const repo = new Repository(pool);
const outbound = vi
  .spyOn(globalThis, 'fetch')
  .mockRejectedValue(new Error('Source catalog tests forbid external network'));
let app: Awaited<ReturnType<typeof createApp>>, first: CatalogSnapshot, second: CatalogSnapshot;
let businessTables: string[] = [],
  businessBefore: Record<string, string> = {};
const receipts: object[] = [];
const snapshot = (seed = 'a') => buildSourceCatalog(qaWorkbook(seed), qaCanva(), qaFolder);
const call = (input: any) => app.getHttpAdapter().getInstance().inject(input);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function businessHashes() {
  const result: Record<string, string> = {};
  for (const table of businessTables) {
    if (!/^[a-z_0-9]+$/.test(table)) throw new Error('Unsafe test table identifier');
    const rows = await pool.query(
      `SELECT COALESCE(jsonb_agg(t ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM ${table} t`,
    );
    result[table] = hash(rows.rows[0].data);
  }
  return result;
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await mkdir(directory, { recursive: true });
  app = await createApp(repo, new BlobStore(directory), ['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
  expect((await pool.query('SHOW search_path')).rows[0].search_path).toBe(schema);
  const tables = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename NOT LIKE 'source_catalog%' ORDER BY tablename",
  );
  businessTables = tables.rows.map((r) => r.tablename);
  businessBefore = await businessHashes();
  await pool.query(
    "CREATE FUNCTION reject_business_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SOURCE_CATALOG_BUSINESS_WRITE_FORBIDDEN'; END; $$",
  );
  for (const table of businessTables)
    await pool.query(
      `CREATE TRIGGER source_catalog_no_business_write BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_business_write()`,
    );
  first = snapshot();
  second = snapshot('b');
  second.listings[0].title = 'QA catalog thứ hai, biệt lập';
  await storeSourceCatalog(pool, first);
  await storeSourceCatalog(pool, second);
});

afterAll(async () => {
  await app?.close();
  const businessAfter = await businessHashes();
  expect(businessAfter).toEqual(businessBefore);
  const tables = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'source_catalog%' ORDER BY tablename",
  );
  const stored: Record<string, unknown> = {};
  for (const row of tables.rows)
    stored[row.tablename] = (await pool.query(`SELECT * FROM ${row.tablename}`)).rows;
  const requests = outbound.mock.calls.length;
  outbound.mockRestore();
  await pool.end();
  if (!/^test_source_catalog_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe cleanup schema');
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await writeFile(
    join(directory, 'evidence.json'),
    JSON.stringify(
      {
        mode: 'private-pg-source-catalog',
        schema,
        schemaRemoved: true,
        externalRequests: requests,
        businessTablesProtectedByRejectTrigger: businessTables,
        businessBefore,
        businessAfter,
        receipts,
        stored,
      },
      null,
      2,
    ),
  );
  expect(requests).toBe(0);
});

it('persists exact text versions and warnings with no confirmed operational fields after reload', async () => {
  const row = await getCatalogListing(pool, first.catalog.id, 'row-1');
  expect(row?.title).toBe(qaTitle);
  expect(row?.contents.map((v) => v.value)).toEqual([qaOriginal, qaBefore, qaAfter]);
  expect(row?.variations.map((v) => v.value)).toEqual([qaVariants]);
  expect(row?.reviewNotes.map((n) => n.value)).toContain(qaWarning);
  expect(row).toMatchObject({
    itemId: '970000001',
    shopBinding: null,
    priceSource: null,
    stockSource: null,
    attributeReference: null,
    status: 'needs_review',
  });
  expect(row?.titleSource).toMatchObject({ cell: 'D4', sheet: 'QA ALPHA & nguồn' });
  const missing = await getCatalogListing(pool, first.catalog.id, 'row-2');
  expect(missing?.itemId).toBeNull();
  expect(missing?.issues.map((i) => i.code)).toContain('missing_item_id');
  receipts.push({ check: 'exact-source-reloaded', row });
});

it('stores repeated page IDs only within their design scope and candidates only as suggested', async () => {
  const pages = await pool.query(
    'SELECT design_id,page_id FROM source_catalog_pages WHERE catalog_id=$1 AND page_id=$2 ORDER BY design_id',
    [first.catalog.id, 'shared-page-id'],
  );
  expect(pages.rows.map((r) => r.design_id)).toEqual(['QA_ALPHA_NEW', 'QA_ALPHA_OLD', 'QA_BETA']);
  const row = await getCatalogListing(pool, first.catalog.id, 'row-1');
  expect(row?.designCandidates.map((c) => [c.id, c.status])).toEqual([
    ['QA_ALPHA_NEW', 'suggested'],
    ['QA_ALPHA_OLD', 'suggested'],
  ]);
  expect(
    (await getCatalogListing(pool, first.catalog.id, 'row-3'))?.designCandidates.map((c) => c.id),
  ).toEqual(['QA_BETA']);
});

it('scopes identical listing keys and design IDs to the requested catalog', async () => {
  expect((await getCatalogListing(pool, first.catalog.id, 'row-1'))?.title).toBe(qaTitle);
  expect((await getCatalogListing(pool, second.catalog.id, 'row-1'))?.title).toBe(
    'QA catalog thứ hai, biệt lập',
  );
  expect(await getCatalogListing(pool, randomUUID(), 'row-1')).toBeNull();
  expect(await getCatalogListing(pool, first.catalog.id, 'row-999')).toBeNull();
});

it('idempotently reuses exact import including concurrent requests without duplicating children', async () => {
  const outcomes = await Promise.all([
    storeSourceCatalog(pool, first),
    storeSourceCatalog(pool, structuredClone(first)),
  ]);
  expect(outcomes).toEqual([
    { id: first.catalog.id, inserted: false },
    { id: first.catalog.id, inserted: false },
  ]);
  expect(
    Number(
      (
        await pool.query('SELECT count(*) FROM source_catalog_listings WHERE catalog_id=$1', [
          first.catalog.id,
        ])
      ).rows[0].count,
    ),
  ).toBe(4);
  const fresh = snapshot('c');
  const concurrent = await Promise.all([
    storeSourceCatalog(pool, fresh),
    storeSourceCatalog(pool, structuredClone(fresh)),
  ]);
  expect(concurrent.filter((r) => r.inserted)).toHaveLength(1);
  receipts.push({ check: 'concurrent-import', concurrent });
});

it('refuses changed snapshot under an existing fingerprint and preserves the previous original', async () => {
  const changed = structuredClone(first);
  changed.listings[0].contents[2].value = 'QA substituted source after hashing';
  await expect(storeSourceCatalog(pool, changed)).rejects.toThrow(/CATALOG_FINGERPRINT_CONFLICT/);
  expect((await getCatalogListing(pool, first.catalog.id, 'row-1'))?.contents[2].value).toBe(
    qaAfter,
  );
});

it('treats a later observation of identical source bytes as an idempotent import without rewriting receivedAt', async () => {
  const reread = qaWorkbook();
  reread.source.observedAt = '2026-09-15T09:00:00.000Z';
  const repeated = buildSourceCatalog(reread, qaCanva(), qaFolder);
  expect(repeated.catalog.importFingerprint).toBe(first.catalog.importFingerprint);
  await expect(storeSourceCatalog(pool, repeated)).resolves.toEqual({
    id: first.catalog.id,
    inserted: false,
  });
  expect((await getSourceCatalog(pool, first.catalog.id))?.receivedAt).toBe(
    '2026-09-14T09:00:00.000Z',
  );
});

it('rolls back catalog/files/designs/pages/listings when a late candidate FK fails', async () => {
  const failing = snapshot('d');
  failing.listings[0].designCandidates[0].id = 'QA_NOT_STORED';
  await expect(storeSourceCatalog(pool, failing)).rejects.toThrow();
  for (const table of [
    'source_catalog_files',
    'source_catalog_designs',
    'source_catalog_pages',
    'source_catalog_listings',
    'source_catalog_candidates',
  ])
    expect(
      Number(
        (
          await pool.query(`SELECT count(*) FROM ${table} WHERE catalog_id=$1`, [
            failing.catalog.id,
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
  expect(await getSourceCatalog(pool, failing.catalog.id)).toBeNull();
  receipts.push({ check: 'late-fk-rollback', catalogId: failing.catalog.id });
});

it.each(['shopBinding', 'priceSource', 'stockSource', 'attributeReference'] as const)(
  'rejects attempted promotion of source candidates into %s',
  async (field) => {
    const unsafe = snapshot('e');
    (unsafe.listings[0] as any)[field] = { injected: 'not-approved' };
    await expect(storeSourceCatalog(pool, unsafe)).rejects.toThrow(/CATALOG_INVALID_SNAPSHOT/);
    expect(await getSourceCatalog(pool, unsafe.catalog.id)).toBeNull();
  },
);

it('rejects a confirmed design candidate even when the source catalog publishable flag is false', async () => {
  const unsafe = snapshot('f');
  (unsafe.listings[0].designCandidates[0] as any).status = 'confirmed';
  await expect(storeSourceCatalog(pool, unsafe)).rejects.toThrow(/CATALOG_INVALID_SNAPSHOT/);
});

it('search treats percent/underscore/apostrophe/backslash as literal input and filters by exact brand', async () => {
  for (const q of ['%_']) {
    const result = await queryCatalogListings(pool, first.catalog.id, { q, page: 1, pageSize: 10 });
    expect(result.items.map((r) => r.id)).toEqual(['row-1']);
  }
  for (const q of ["' OR 1=1 --", '\\', '%not-present'])
    expect(
      (await queryCatalogListings(pool, first.catalog.id, { q, page: 1, pageSize: 10 })).total,
    ).toBe(0);
  expect(
    (
      await queryCatalogListings(pool, first.catalog.id, {
        brand: 'QA BETA',
        page: 1,
        pageSize: 10,
      })
    ).items.map((r) => r.id),
  ).toEqual(['row-3']);
  expect(
    (
      await queryCatalogListings(pool, first.catalog.id, {
        brand: "QA BETA' OR 1=1 --",
        page: 1,
        pageSize: 10,
      })
    ).total,
  ).toBe(0);
});

it('finds unaccented text in original content and variation labels while preserving stored accents', async () => {
  for (const q of ['DONG CO HAI KHOANG TRANG', 'PHAN LOAI 1: XANH', 'SKU-A']) {
    const result = await queryCatalogListings(pool, first.catalog.id, { q, page: 1, pageSize: 10 });
    expect(result.items.map((r) => r.id)).toEqual(['row-1', 'row-2', 'row-3', 'row-4']);
  }
  expect((await getCatalogListing(pool, first.catalog.id, 'row-1'))?.contents[0].value).toBe(
    qaOriginal,
  );
  expect((await getCatalogListing(pool, first.catalog.id, 'row-1'))?.variations[0].value).toBe(
    qaVariants,
  );
});

it('paginates stable source order, clamps out-of-range pages and returns empty filtered results', async () => {
  const page1 = await queryCatalogListings(pool, first.catalog.id, { page: 1, pageSize: 2 });
  const page2 = await queryCatalogListings(pool, first.catalog.id, { page: 2, pageSize: 2 });
  const beyond = await queryCatalogListings(pool, first.catalog.id, { page: 999, pageSize: 2 });
  expect(page1.items.map((x) => x.id)).toEqual(['row-1', 'row-2']);
  expect(page2.items.map((x) => x.id)).toEqual(['row-3', 'row-4']);
  expect(beyond).toEqual(page2);
  expect(
    (
      await queryCatalogListings(pool, first.catalog.id, {
        issue: 'multiple_designs',
        page: 1,
        pageSize: 2,
      })
    ).items.map((r) => r.id),
  ).toEqual(['row-1']);
  const empty = await queryCatalogListings(pool, first.catalog.id, {
    q: 'QA不存在',
    page: 99,
    pageSize: 2,
  });
  expect(empty).toMatchObject({ total: 0, page: 1, items: [] });
});

it('filters blank IDs for new listings and existing IDs for updates without rewriting historical source issues', async () => {
  const before = await getCatalogListing(pool, first.catalog.id, 'row-2');
  for (const [issue, expected] of [
    ['missing_item_id', ['row-2', 'row-4']],
    ['existing_item_id', ['row-1', 'row-3']],
  ] as const) {
    const direct = await queryCatalogListings(pool, first.catalog.id, {
      issue,
      page: 1,
      pageSize: 10,
    });
    expect(direct.items.map((row) => row.id)).toEqual(expected);
    const response = await call({
      method: 'GET',
      url: `/v1/source-catalogs/${first.catalog.id}/listings?issue=${issue}&pageSize=10`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((row: { id: string }) => row.id)).toEqual(expected);
  }
  expect(await getCatalogListing(pool, first.catalog.id, 'row-2')).toEqual(before);
  expect(before?.issues.map((issue) => issue.code)).toContain('missing_item_id');
  expect(outbound).not.toHaveBeenCalled();
});

it('read-only HTTP lists summaries without source contents/operational references and details retain source', async () => {
  const list = await call({ method: 'GET', url: '/v1/source-catalogs' });
  expect(list.statusCode).toBe(200);
  expect(list.json().some((x: any) => x.id === first.catalog.id)).toBe(true);
  const rows = await call({
    method: 'GET',
    url: `/v1/source-catalogs/${first.catalog.id}/listings?pageSize=2&page=1`,
  });
  expect(rows.statusCode).toBe(200);
  expect(rows.json().items.map((r: any) => r.id)).toEqual(['row-1', 'row-2']);
  for (const r of rows.json().items) {
    expect(r).not.toHaveProperty('contents');
    expect(r).not.toHaveProperty('operationalReferences');
    expect(r).not.toHaveProperty('designCandidates');
  }
  const detail = await call({
    method: 'GET',
    url: `/v1/source-catalogs/${first.catalog.id}/listings/row-1`,
  });
  expect(detail.json().title).toBe(qaTitle);
  const catalog = await call({ method: 'GET', url: `/v1/source-catalogs/${first.catalog.id}` });
  expect(catalog.json()).toMatchObject({ publishable: false, originalAssetsDownloaded: false });
});

it('HTTP rejects malformed IDs and pagination and cannot traverse source paths or mutate catalogs', async () => {
  for (const suffix of [
    'page=0',
    'page=-1',
    'pageSize=0',
    'pageSize=101',
    'page=NaN',
    'issue=confirmed',
  ]) {
    const res = await call({
      method: 'GET',
      url: `/v1/source-catalogs/${first.catalog.id}/listings?${suffix}`,
    });
    expect(res.statusCode).toBe(400);
  }
  const badId = await call({ method: 'GET', url: '/v1/source-catalogs/not-a-uuid' });
  expect(badId.statusCode).toBe(400);
  const traversal = await call({
    method: 'GET',
    url: `/v1/source-catalogs/${first.catalog.id}/listings/..%2F..%2F.env`,
  });
  expect([400, 404]).toContain(traversal.statusCode);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await call({
      method,
      url: `/v1/source-catalogs/${first.catalog.id}`,
      headers: { 'x-app-client': 'internal-workspace' },
      payload: { publishable: true },
    });
    expect(res.statusCode).toBe(404);
  }
  expect((await getSourceCatalog(pool, first.catalog.id))?.publishable).toBe(false);
});
