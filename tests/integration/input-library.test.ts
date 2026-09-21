import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BlobStore,
  InputLibraryRepository,
  migrate,
  Pool,
  Repository,
  type ImportRecord,
} from '../../packages/persistence/src/index.js';
import type { InputBatchState, WorkbookImport } from '../../packages/domain/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { fact, fixtureDraft } from '../helpers/fixtures.js';

const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
const headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
let app: Awaited<ReturnType<typeof createApp>>;
let blobRoot: string;
let imageA: ImportRecord, imageB: ImportRecord, word: ImportRecord, price: ImportRecord;

async function source(filename: string, kind: ImportRecord['kind'], body: unknown) {
  const record = await repo.createImport({
    filename,
    kind,
    bytes: 12,
    sha256: createHash('sha256')
      .update(filename + randomUUID())
      .digest('hex'),
  });
  await repo.finishImport(record.id, body);
  return (await repo.getImport(record.id))!;
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  blobRoot = await mkdtemp(join(tmpdir(), 'shopee-input-library-test-'));
  app = await createApp(repo, new BlobStore(blobRoot), ['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
  imageA = await source('original-export.png', 'image', {
    mime: 'image/png',
    width: 12,
    height: 16,
  });
  imageB = await source('second-export.png', 'image', { mime: 'image/png', width: 12, height: 16 });
  word = await source('content.docx', 'docx', {
    paragraphs: ['TIÊU ĐỀ', 'Tên  đã chuẩn bị ', 'MÔ TẢ', 'Dòng một\n\nDòng hai'],
  });
  const workbook: WorkbookImport = {
    source: {
      kind: 'product_file',
      fileSha256: 'fixture',
      locator: 'workbook',
      observedAt: '2026-09-11T00:00:00Z',
    },
    rows: [
      {
        key: 'row-A',
        sheet: 'Bảng chung',
        row: 3,
        headerRow: 1,
        sku: fact('A'),
        name: fact('Prepared A'),
        originalPrice: fact('137998'),
        promotionTarget: fact('68999'),
        issues: [],
      },
    ],
    sheets: [{ name: 'Bảng chung', rowCount: 3, importedRows: 1, headerRows: [1] }],
    issues: [],
  };
  price = await source('Giá chung.xlsx', 'xlsx', workbook);
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (blobRoot?.startsWith(join(tmpdir(), 'shopee-input-library-test-')))
    await rm(blobRoot, { recursive: true, force: true });
});
const call = (options: any) => app.getHttpAdapter().getInstance().inject(options);
const save = (id: string, state: InputBatchState, expectedRevision = 0) =>
  call({
    method: 'POST',
    url: '/v1/input-batches',
    headers,
    payload: { id, expectedRevision, state },
  });
function batch(): InputBatchState {
  return {
    version: 1,
    name: 'Lô đã chuẩn bị',
    mode: 'parent_with_listing_folders',
    files: [
      {
        relativePath: 'Lô/Một/1.png',
        name: '1.png',
        size: imageA.bytes,
        importId: imageA.id,
        sha256: imageA.sha256,
      },
      {
        relativePath: 'Lô/Một/content.docx',
        name: 'content.docx',
        size: word.bytes,
        importId: word.id,
        sha256: word.sha256,
      },
      {
        relativePath: 'Lô/Hai/1.png',
        name: '1.png',
        size: imageB.bytes,
        importId: imageB.id,
        sha256: imageB.sha256,
      },
      {
        relativePath: 'Lô/Hai/content.docx',
        name: 'content.docx',
        size: 12,
        error: 'Chưa nhận được tệp',
      },
    ],
    priceSelection: { importId: price.id, sheet: 'Bảng chung', priceProfile: null },
    visual: {
      'Lô/Một': {
        coverPath: 'Lô/Một/1.png',
        galleryPaths: ['Lô/Một/1.png'],
        descriptionPaths: ['Lô/Một/1.png'],
      },
      'Lô/Hai': { galleryPaths: [], descriptionPaths: [] },
    },
    wordPaths: { 'Lô/Một': 'Lô/Một/content.docx' },
    wordRule: {
      titleHeader: 'TIÊU ĐỀ',
      descriptionHeader: 'MÔ TẢ',
      headline: 'first_line',
      paragraphSeparator: '\n\n',
    },
    productKeys: { 'Lô/Một': 'input-' + randomUUID(), 'Lô/Hai': 'input-' + randomUUID() },
  };
}

it('persists a full batch, reloads original aliases and partial failures, without creating a listing', async () => {
  const id = randomUUID(),
    state = batch();
  const originals = await repo.listImports();
  const products = await repo.listProducts();
  const result = await save(id, state);
  expect(result.statusCode).toBe(201);
  expect(result.json()).toMatchObject({ id, revision: 1, state });
  const restored = await new InputLibraryRepository(pool).get(id);
  expect(restored?.state).toEqual(state);
  expect(restored?.imports.map((file) => file.id).sort()).toEqual(
    [imageA.id, imageB.id, word.id, price.id].sort(),
  );
  expect(restored?.imports.find((file) => file.id === imageA.id)?.filename).toBe(
    'original-export.png',
  );
  expect(restored?.imports.find((file) => file.id === word.id)?.body).toEqual(word.body);
  expect(await repo.listImports()).toEqual(originals);
  expect(await repo.listProducts()).toEqual(products);
  const viaHttp = await call({ method: 'GET', url: '/v1/input-batches/' + id });
  expect(viaHttp.json()).toEqual({...restored,archived:false,archivedAt:null});
  await expect(pool.query('DELETE FROM source_files WHERE id=$1', [word.id])).rejects.toThrow(
    /foreign key/,
  );
});

it('makes concurrent identical save and historical retry idempotent while rejecting a stale differing write', async () => {
  const id = randomUUID(),
    state = batch();
  const [first, repeated] = await Promise.all([save(id, state), save(id, state)]);
  expect(first.statusCode).toBe(201);
  expect(repeated.statusCode).toBe(201);
  expect(first.json()).toEqual(repeated.json());
  const changed = { ...state, name: 'Tên lô mới' };
  const second = await save(id, changed, 1);
  expect(second.json().revision).toBe(2);
  expect((await save(id, state, 0)).json()).toEqual(first.json());
  const stale = await save(id, { ...state, name: 'Ghi cũ từ máy khác' }, 0);
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('INPUT_BATCH_REVISION_CONFLICT');
  expect((await new InputLibraryRepository(pool).get(id))?.state.name).toBe('Tên lô mới');
  expect(
    (
      await pool.query('SELECT count(*)::int AS n FROM input_batch_revisions WHERE batch_id=$1', [
        id,
      ])
    ).rows[0].n,
  ).toBe(2);
  await expect(
    pool.query('UPDATE input_batch_revisions SET state=state WHERE batch_id=$1', [id]),
  ).rejects.toThrow('IMMUTABLE_REVISION');
});

it('accepts only one of two concurrent different revisions', async () => {
  const id = randomUUID(),
    state = batch();
  await save(id, state);
  const replies = await Promise.all([
    save(id, { ...state, name: 'Nhân viên A' }, 1),
    save(id, { ...state, name: 'Nhân viên B' }, 1),
  ]);
  expect(replies.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
});

it('rejects traversal, duplicate paths, wrong folder mode and mappings across folders', async () => {
  for (const invalid of [
    '../1.png',
    'Lô/Một/../1.png',
    'Lô\\Một\\1.png',
    '/Lô/Một/1.png',
    'Lô/1.png',
  ]) {
    const state = batch();
    state.files[0].relativePath = invalid;
    expect((await save(randomUUID(), state)).json().code).toBe('INPUT_BATCH_PATH_INVALID');
  }
  const duplicate = batch();
  duplicate.files.push(duplicate.files[0]);
  expect((await save(randomUUID(), duplicate)).json().code).toBe('INPUT_BATCH_PATH_INVALID');
  const image = batch();
  image.visual['Lô/Một'].coverPath = 'Lô/Hai/1.png';
  expect((await save(randomUUID(), image)).json().code).toBe('INPUT_BATCH_SELECTION_INVALID');
  const doc = batch();
  doc.wordPaths['Lô/Một'] = 'Lô/Hai/content.docx';
  expect((await save(randomUUID(), doc)).json().code).toBe('INPUT_BATCH_SELECTION_INVALID');
  const order = batch();
  order.visual['Lô/Một'].galleryPaths.push('Lô/Một/1.png');
  expect((await save(randomUUID(), order)).json().code).toBe('INPUT_BATCH_SELECTION_INVALID');
});

it('checks source SHA, byte count and extension kind without rewriting the original source', async () => {
  for (const change of [
    { sha256: 'a'.repeat(64) },
    { size: 99 },
    { importId: randomUUID() },
    { importId: word.id, sha256: word.sha256 },
  ]) {
    const state = batch();
    Object.assign(state.files[0], change);
    expect((await save(randomUUID(), state)).json().code).toBe('INPUT_BATCH_SOURCE_MISMATCH');
  }
  const absentHash = batch();
  delete absentHash.files[0].sha256;
  expect((await save(randomUUID(), absentHash)).json().code).toBe('INPUT_BATCH_SOURCE_MISMATCH');
  expect((await repo.getImport(imageA.id))?.filename).toBe('original-export.png');
  expect((await repo.getImport(imageA.id))?.sha256).toBe(imageA.sha256);
});

it('requires exact ready workbook, sheet and price profile; no implicit price fallback', async () => {
  for (const selection of [
    { importId: imageA.id, sheet: 'Bảng chung', priceProfile: null },
    { importId: price.id, sheet: 'Khác', priceProfile: null },
    { importId: price.id, sheet: 'Bảng chung', priceProfile: 'Mall' },
  ]) {
    const state = batch();
    state.priceSelection = selection;
    expect((await save(randomUUID(), state)).json().code).toBe('INPUT_BATCH_PRICE_INVALID');
  }
  const pending = await repo.createImport({
    filename: 'pending.xlsx',
    kind: 'xlsx',
    bytes: 12,
    sha256: 'f'.repeat(64),
  });
  const state = batch();
  state.priceSelection = { importId: pending.id, sheet: 'Bảng chung', priceProfile: null };
  expect((await save(randomUUID(), state)).json().code).toBe('INPUT_BATCH_PRICE_INVALID');
  state.priceSelection = null;
  expect((await save(randomUUID(), state)).statusCode).toBe(201);
});

it('reserves stable listing keys per folder and batch, and prevents claiming an existing listing', async () => {
  const id = randomUUID(),
    state = batch();
  expect((await save(id, state)).statusCode).toBe(201);
  const changed = structuredClone(state);
  changed.productKeys['Lô/Một'] = 'input-' + randomUUID();
  expect((await save(id, changed, 1)).json().code).toBe('INPUT_BATCH_PRODUCT_KEY_CONFLICT');
  expect((await save(randomUUID(), state)).json().code).toBe('INPUT_BATCH_PRODUCT_KEY_CONFLICT');
  const duplicate = batch();
  duplicate.productKeys['Lô/Hai'] = duplicate.productKeys['Lô/Một'];
  expect((await save(randomUUID(), duplicate)).json().code).toBe(
    'INPUT_BATCH_PRODUCT_KEY_CONFLICT',
  );
  const existing = { ...fixtureDraft(), productKey: 'existing-' + randomUUID() };
  await repo.saveProduct(existing, 0);
  const existingState = batch();
  existingState.productKeys['Lô/Một'] = existing.productKey;
  expect((await save(randomUUID(), existingState)).json().code).toBe(
    'INPUT_BATCH_PRODUCT_KEY_CONFLICT',
  );
  expect(await repo.getProduct(existing.productKey)).toEqual(existing);
});

it('restores empty batches and rejects moving a listing identity to a renamed folder implicitly', async () => {
  const state: InputBatchState = {
    version: 1,
    name: 'Chưa chọn thư mục',
    mode: 'single_listing',
    files: [],
    priceSelection: null,
    visual: {},
    wordPaths: {},
    wordRule: null,
    productKeys: {},
  };
  const id = randomUUID();
  expect((await save(id, state)).statusCode).toBe(201);
  expect((await new InputLibraryRepository(pool).get(id))?.state).toEqual(state);
  const populated = batch();
  expect((await save(id, populated, 1)).statusCode).toBe(201);
  const renamed = structuredClone(populated);
  renamed.files[0].relativePath = 'Lô/Bộ đổi tên/1.png';
  renamed.files[1].relativePath = 'Lô/Bộ đổi tên/content.docx';
  renamed.visual = { 'Lô/Hai': { galleryPaths: [], descriptionPaths: [] } };
  renamed.wordPaths = {};
  renamed.productKeys['Lô/Bộ đổi tên'] = renamed.productKeys['Lô/Một'];
  delete renamed.productKeys['Lô/Một'];
  expect((await save(id, renamed, 2)).json().code).toBe('INPUT_BATCH_PRODUCT_KEY_CONFLICT');
});

it('preserves explicitly chosen image order and prior snapshots when saving a revised mapping', async () => {
  const id = randomUUID(),
    state = batch();
  state.files.push({
    relativePath: 'Lô/Một/2.png',
    name: '2.png',
    size: imageB.bytes,
    importId: imageB.id,
    sha256: imageB.sha256,
  });
  state.visual['Lô/Một'].galleryPaths = ['Lô/Một/2.png', 'Lô/Một/1.png'];
  state.visual['Lô/Một'].descriptionPaths = ['Lô/Một/1.png', 'Lô/Một/2.png'];
  expect((await save(id, state)).statusCode).toBe(201);
  const changed = structuredClone(state);
  changed.visual['Lô/Một'].galleryPaths.reverse();
  expect((await save(id, changed, 1)).statusCode).toBe(201);
  expect((await new InputLibraryRepository(pool).get(id))?.state.visual).toEqual(changed.visual);
  const original = (
    await pool.query('SELECT state FROM input_batch_revisions WHERE batch_id=$1 AND revision=1', [
      id,
    ])
  ).rows[0].state;
  expect(original.visual).toEqual(state.visual);
  expect((await repo.getImport(imageB.id))?.sha256).toBe(imageB.sha256);
});

it('lists input work by batch and price book, excludes already linked originals, and counts saved local listings only', async () => {
  const unrelated = await source('unassigned.png', 'image', { mime: 'image/png' });
  const provenanceOnly = await source('existing-listing-word.docx', 'docx', {
    paragraphs: ['Nguồn gốc'],
  });
  const provenanceDraft = { ...fixtureDraft(), productKey: 'provenance-' + randomUUID() };
  provenanceDraft.title.sources = [
    { ...provenanceDraft.title.sources[0], fileSha256: provenanceOnly.sha256 },
  ];
  await repo.saveProduct(provenanceDraft, 0);
  const id = randomUUID(),
    state = batch();
  await save(id, state);
  const local = { ...fixtureDraft(), productKey: state.productKeys['Lô/Một'] };
  await repo.saveProduct(local, 0);
  const response = await call({ method: 'GET', url: '/v1/input-library' });
  expect(response.statusCode).toBe(200);
  const data = response.json();
  expect(data.batches.find((item: any) => item.id === id)).toMatchObject({
    folderCount: 2,
    fileCount: 4,
    completedCount: 1,
    priceSelection: state.priceSelection,
  });
  expect(data.priceBooks.find((item: any) => item.id === price.id)).toMatchObject({
    rowCount: 1,
    sheetCount: 1,
    issueCount: 0,
  });
  expect(data.priceBooks.find((item: any) => item.id === price.id)).not.toHaveProperty('body');
  expect(data.unassigned.map((item: any) => item.id)).toContain(unrelated.id);
  expect(data.unassigned.map((item: any) => item.id)).not.toContain(imageA.id);
  expect(data.unassigned.map((item: any) => item.id)).not.toContain(provenanceOnly.id);
  expect(data.unassigned.every((item: any) => item.kind !== 'xlsx' && item.body === null)).toBe(
    true,
  );
  expect((await call({ method: 'GET', url: '/v1/input-batches' })).json()).toEqual(data.batches);
});

it('rejects cross-origin and structurally invalid requests before creating batches', async () => {
  const id = randomUUID();
  const denied = await call({
    method: 'POST',
    url: '/v1/input-batches',
    headers: { ...headers, origin: 'https://other.example' },
    payload: { id, expectedRevision: 0, state: batch() },
  });
  expect(denied.statusCode).toBe(403);
  expect(await new InputLibraryRepository(pool).get(id)).toBeNull();
  const invalid = await call({
    method: 'POST',
    url: '/v1/input-batches',
    headers,
    payload: { id, expectedRevision: 0, state: { ...batch(), unwantedField: 'must not persist' } },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().code).toBe('INVALID_INPUT');
  expect(await new InputLibraryRepository(pool).get(id)).toBeNull();
});
