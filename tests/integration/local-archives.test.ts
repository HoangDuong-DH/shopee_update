import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import {
  Pool,
  Repository,
  BlobStore,
  migrate,
  storeSourceCatalog,
  InputLibraryRepository,
} from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { ProductionPreparationService } from '../../apps/api/src/production-preparation-service.js';
import { buildSourceCatalog } from '../../apps/api/src/source-catalog-build.js';
import { qaWorkbook, qaCanva, qaFolder } from '../fixtures/source-catalog.js';
import { canonicalJson } from '../../packages/domain/src/index.js';

const database = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.port !== '5442')
  throw Error('Isolated local PG required');
const schema = 'test_local_archive_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const repo = new Repository(pool),
  library = new InputLibraryRepository(pool);
const blobs = new BlobStore(resolve('.local/archive-tests', schema));
const outbound = vi
  .spyOn(globalThis, 'fetch')
  .mockRejectedValue(Error('No outbound calls in local archive tests'));
let app: Awaited<ReturnType<typeof createApp>>;
const call = (method: 'GET' | 'POST', url: string, payload?: any) =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url,
      payload,
      headers: { origin: 'http://localhost:5173', 'x-app-client': 'internal-workspace' },
    });
const catalog = buildSourceCatalog(qaWorkbook('a'), qaCanva(), qaFolder);
const priceId = randomUUID(),
  batchId = randomUUID(),
  productKey = 'archive-fixture';
const fact = (value: any) => ({ value, confirmed: true, sources: [] });
const draft: any = {
  productKey,
  revision: 1,
  title: fact('Xịt thử nghiệm local'),
  description: [],
  coverKey: '',
  galleryKeys: [],
  tierNames: [],
  variants: [],
  assets: [],
  attributes: {},
  logistics: {},
  issues: [],
  sourceSelection: {
    title: 'T',
    headline: '',
    body: '',
    galleryIds: [],
    descriptionImageIds: [],
    tierNames: [],
    variants: [{ importId: priceId, rowKey: 'r1', optionLabels: [] }],
  },
};
const state: any = {
  version: 1,
  name: 'Bộ nguồn local',
  mode: 'single_listing',
  files: [],
  priceSelection: null,
  visual: {},
  wordPaths: {},
  wordRule: null,
  productKeys: {},
};
const resources = [
  ['catalog_listing', `${catalog.catalog.id}/row-1`],
  ['input_batch', batchId],
  ['product', productKey],
  ['pricebook', priceId],
] as const;
const archive = (kind: string, resourceId: string, archived = true) =>
  call('POST', '/v1/local-archives', { kind, resourceId, archived });
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await storeSourceCatalog(pool, catalog);
  await pool.query(
    "INSERT INTO source_files(id,sha256,filename,kind,bytes,status,body) VALUES($1,$2,'Giá.xlsx','xlsx',1,'ready',$3)",
    [priceId, 'a'.repeat(64), { rows: [], sheets: [], issues: [] }],
  );
  await repo.saveProduct(draft, 0);
  await library.save(batchId, 0, state);
  app = await createApp(repo, blobs, ['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  expect(outbound).not.toHaveBeenCalled();
  outbound.mockRestore();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

it('archives/restores all four resources without changing source/history rows and is idempotent', async () => {
  const snapshot = async () =>
    Promise.all(
      [
        'source_files',
        'products',
        'product_revisions',
        'input_batches',
        'input_batch_revisions',
        'source_catalog_listings',
      ].map(
        async (table) =>
          (
            await pool.query(
              `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows,
      ),
    );
  const before = await snapshot();
  for (const [kind, resourceId] of resources) {
    const first = await archive(kind, resourceId);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ kind, resourceId, archived: true });
    expect((await archive(kind, resourceId)).json()).toEqual(first.json());
  }
  expect((await call('GET', '/v1/products')).json()).toEqual([]);
  expect((await call('GET', '/v1/input-batches')).json()).toEqual([]);
  expect((await call('GET', '/v1/imports')).json()).toEqual([]);
  expect(
    (await call('GET', `/v1/source-catalogs/${catalog.catalog.id}/listings`))
      .json()
      .items.some((v: any) => v.id === 'row-1'),
  ).toBe(false);
  expect((await call('GET', '/v1/products?lifecycle=archived')).json()[0]).toMatchObject({
    productKey,
    archived: true,
  });
  for (const url of [
    `/v1/products/${productKey}`,
    `/v1/imports/${priceId}`,
    `/v1/input-batches/${batchId}`,
    `/v1/source-catalogs/${catalog.catalog.id}/listings/row-1`,
  ])
    expect((await call('GET', url)).json()).toMatchObject({ archived: true });
  expect((await call('GET', '/v1/local-archives')).json().entries).toHaveLength(4);
  for (const [kind, resourceId] of resources)
    expect((await archive(kind, resourceId, false)).json()).toMatchObject({
      archived: false,
      archivedAt: null,
    });
  expect((await call('GET', '/v1/products')).json()).toHaveLength(1);
  expect(await snapshot()).toEqual(before);
  expect(
    (await pool.query('SELECT count(*) FROM local_resource_archive_events')).rows[0].count,
  ).toBe('8');
});

it('blocks new saves/preparations using archived resources while keeping historical reads', async () => {
  await archive('pricebook', priceId);
  await expect(repo.saveProduct({ ...draft, revision: 2 }, 1)).rejects.toThrow(
    'LOCAL_RESOURCE_ARCHIVED',
  );
  const build = vi.fn();
  const service = new ProductionPreparationService(repo, blobs, { build });
  await expect(
    service.preview({ id: randomUUID(), entries: [{ productKey, sourceRevision: 1 }] }),
  ).rejects.toThrow('LOCAL_RESOURCE_ARCHIVED');
  expect(build).not.toHaveBeenCalled();
  expect(await repo.getProduct(productKey, 1)).toEqual(draft);
  await archive('pricebook', priceId, false);
  await archive('input_batch', batchId);
  await expect(library.save(batchId, 1, { ...state, name: 'Edited' })).rejects.toThrow(
    'LOCAL_RESOURCE_ARCHIVED',
  );
  await archive('input_batch', batchId, false);
});

it('refuses to archive a draft or its pricebook referenced by an unfinished production execution', async () => {
  const prepId = randomUUID(),
    fingerprint = 'b'.repeat(64);
  await pool.query(
    'INSERT INTO production_source_preparations(id,request_hash,request,body,fingerprint) VALUES($1,$2,$3,$4,$2)',
    [
      prepId,
      fingerprint,
      { entries: [{ productKey }] },
      { entries: [{ productKey, sourceSnapshot: { draft }, priceProof: [{ importId: priceId }] }] },
    ],
  );
  await pool.query(
    'INSERT INTO production_preparation_executions(preparation_id,fingerprint,body) VALUES($1,$2,$3)',
    [prepId, fingerprint, { state: 'paused' }],
  );
  for (const [kind, key] of [
    ['product', productKey],
    ['pricebook', priceId],
  ]) {
    const r = await archive(kind!, key!);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('LOCAL_ARCHIVE_IN_USE');
  }
  expect(
    (
      await pool.query(
        'SELECT body FROM production_preparation_executions WHERE preparation_id=$1',
        [prepId],
      )
    ).rows[0].body,
  ).toEqual({ state: 'paused' });
  await pool.query(
    "UPDATE production_preparation_executions SET body='{}'::jsonb || jsonb_build_object('state','completed') WHERE preparation_id=$1",
    [prepId],
  );
  expect((await archive('product', productKey)).statusCode).toBe(201);
  await archive('product', productKey, false);
});

it('rejects unknown resources, kinds, lifecycle and malformed composite IDs', async () => {
  expect((await archive('product', 'missing')).statusCode).toBe(404);
  expect((await archive('pricebook', randomUUID())).statusCode).toBe(404);
  expect((await archive('catalog_listing', 'bad/row')).statusCode).toBe(400);
  expect((await archive('shop', '1423724897')).statusCode).toBe(400);
  expect((await call('GET', '/v1/products?lifecycle=gone')).statusCode).toBe(400);
});

it('protects approved sources after partial registration crashes before its final receipt', async () => {
  const prepId = randomUUID(),
    fingerprint = 'c'.repeat(64),
    partialKey = 'partial-registration-' + randomUUID();
  const partialDraft = { ...draft, productKey: partialKey };
  await repo.saveProduct(partialDraft, 0);
  // Registration commits this marker before writing each child registry. A crash can
  // leave the marker without a final registration receipt or parent execution row.
  await pool.query(
    'INSERT INTO production_source_preparations(id,request_hash,request,body,fingerprint,approved_at) VALUES($1,$2,$3,$4,$2,now())',
    [
      prepId,
      fingerprint,
      { entries: [{ productKey: partialKey }] },
      {
        entries: [
          {
            kind: 'ready',
            productKey: partialKey,
            sourceSnapshot: { draft: partialDraft },
            priceProof: [{ importId: priceId }],
          },
        ],
      },
    ],
  );
  const before = (
    await pool.query('SELECT * FROM production_source_preparations WHERE id=$1', [prepId])
  ).rows[0];
  expect(before.registration).toBeNull();
  expect(
    (
      await pool.query('SELECT 1 FROM production_preparation_executions WHERE preparation_id=$1', [
        prepId,
      ])
    ).rowCount,
  ).toBe(0);
  for (const [kind, key] of [
    ['product', partialKey],
    ['pricebook', priceId],
  ]) {
    const result = await archive(kind!, key!);
    expect(result.statusCode).toBe(409);
    expect(result.json().code).toBe('LOCAL_ARCHIVE_IN_USE');
  }
  expect(
    (await pool.query('SELECT * FROM production_source_preparations WHERE id=$1', [prepId]))
      .rows[0],
  ).toEqual(before);
  // Finish only the isolated fixture, so the remaining tests can use its shared pricebook.
  await pool.query(
    'INSERT INTO production_preparation_executions(preparation_id,fingerprint,body) VALUES($1,$2,$3)',
    [prepId, fingerprint, { state: 'completed' }],
  );
});

it('rechecks archives when registering a prior preview and preserves the preview receipt', async () => {
  const preparationId = randomUUID();
  const body = {
    entries: [
      {
        kind: 'ready',
        productKey,
        sourceRevision: 1,
        title: 'Xịt thử nghiệm local',
        sourceSnapshot: { draft },
        document: { models: [] },
        priceProof: [],
        issues: [],
      },
    ],
  };
  const fingerprint = createHash('sha256').update(canonicalJson(body)).digest('hex');
  await pool.query(
    'INSERT INTO production_source_preparations(id,request_hash,request,body,fingerprint) VALUES($1,$2,$3,$4,$2)',
    [preparationId, fingerprint, { entries: [{ productKey }] }, body],
  );
  const register = vi.fn();
  const service = new ProductionPreparationService(repo, blobs, { register });
  expect((await archive('product', productKey)).statusCode).toBe(201);
  await expect(
    service.register(preparationId, { expectedFingerprint: fingerprint }),
  ).rejects.toThrow('LOCAL_RESOURCE_ARCHIVED');
  expect(register).not.toHaveBeenCalled();
  expect((await service.get(preparationId)).entries[0]!.title).toBe('Xịt thử nghiệm local');
  expect(
    (
      await pool.query('SELECT body FROM production_source_preparations WHERE id=$1', [
        preparationId,
      ])
    ).rows[0].body,
  ).toEqual(body);
  await archive('product', productKey, false);
});

it('serializes archive with an in-flight preview instead of changing its sources during compilation', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const build = vi.fn(async () => {
    entered();
    await gate;
    return { kind: 'blocked' as const, issues: [] };
  });
  const service = new ProductionPreparationService(repo, blobs, {
    build,
    root: resolve('.local/archive-tests', schema),
  });
  const preview = service.preview({
    id: randomUUID(),
    entries: [{ productKey, sourceRevision: 1 }],
  });
  await started;
  let finished = false;
  const archiving = archive('pricebook', priceId).then((r) => {
    finished = true;
    return r;
  });
  try {
    // Observe the database wait, rather than asserting an arbitrary elapsed timeout.
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting =
        (
          await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock(%' AND query LIKE '%current_schema()%'",
          )
        ).rowCount! > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 10));
    }
    expect(waiting).toBe(true);
    expect(finished).toBe(false);
  } finally {
    release();
  }
  expect((await preview).blockedCount).toBe(1);
  expect((await archiving).statusCode).toBe(201);
  await expect(
    service.preview({ id: randomUUID(), entries: [{ productKey, sourceRevision: 1 }] }),
  ).rejects.toThrow('LOCAL_RESOURCE_ARCHIVED');
  await archive('pricebook', priceId, false);
});

it('filters catalog pages before counting/pagination while retaining the immutable catalog totals', async () => {
  const base = `/v1/source-catalogs/${catalog.catalog.id}`;
  const original = (await call('GET', base)).json();
  const all = (await call('GET', base + '/listings?lifecycle=all&pageSize=100')).json();
  expect(all.items.length).toBeGreaterThan(1);
  const first = all.items[0],
    second = all.items[1];
  await archive('catalog_listing', `${catalog.catalog.id}/${first.id}`);
  const active = (await call('GET', base + '/listings?pageSize=1&page=1')).json();
  expect(active).toMatchObject({ total: all.total - 1, page: 1, pageSize: 1 });
  expect(active.items.map((r: any) => r.id)).toEqual([second.id]);
  const archived = (
    await call('GET', base + '/listings?lifecycle=archived&pageSize=1&page=999')
  ).json();
  expect(archived).toMatchObject({ total: 1, page: 1 });
  expect(archived.items[0]).toMatchObject({ id: first.id, archived: true });
  expect((await call('GET', base + '/listings?lifecycle=all&pageSize=100')).json().total).toBe(
    all.total,
  );
  expect((await call('GET', base)).json()).toEqual(original);
  await archive('catalog_listing', `${catalog.catalog.id}/${first.id}`, false);
});
