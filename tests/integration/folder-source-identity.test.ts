import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  InputLibraryRepository,
  migrate,
  Pool,
  Repository,
} from '../../packages/persistence/src/index.js';
import type { InputBatchState, WorkbookImport } from '../../packages/domain/src/index.js';
import { InputService } from '../../apps/api/src/input-service.js';
import { saveAssembledProduct, type ProductInput } from '../../apps/api/src/product-service.js';
import { fact } from '../helpers/fixtures.js';

const database = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '5442')
  throw new Error('LOCAL_TEST_DATABASE_REQUIRED');
const schema = 'test_folder_identity_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const repo = new Repository(pool),
  service = new InputService(repo);
let word: Awaited<ReturnType<Repository['createImport']>>, image: typeof word, price: typeof word;
async function file(name: string, kind: 'docx' | 'image' | 'xlsx', body: unknown) {
  const sha256 = createHash('sha256').update(name).digest('hex');
  const r = await repo.createImport({ filename: name, kind, sha256, bytes: 12 });
  await repo.finishImport(r.id, kind === 'image' ? { ...(body as object), sha256 } : body);
  return r;
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  word = await file('content.docx', 'docx', {
    paragraphs: ['Exact title', 'Exact headline', 'Exact body'],
  });
  image = await file('cover.png', 'image', { mime: 'image/png', width: 100, height: 100 });
  const workbook: WorkbookImport = {
    source: fact('').sources[0],
    issues: [],
    sheets: [{ name: 'Prices', rowCount: 3, importedRows: 2, headerRows: [1] }],
    rows: ['SHOP MALL', 'SHOP THƯỜNG'].map((profile, i) => ({
      key: 'row-' + i,
      sheet: 'Prices',
      row: i + 2,
      headerRow: 1,
      priceProfile: profile,
      sku: fact('SKU-A'),
      name: fact('Exact product'),
      originalPrice: fact(String(100 + i)),
      issues: [],
    })),
  };
  price = await file('prices.xlsx', 'xlsx', workbook);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function intake(
  productKey: string,
  options: {
    rename?: boolean;
    profile?: string;
    titleRange?: boolean;
    sourceId?: string | null;
  } = {},
) {
  const group = options.rename ? 'Renamed folder' : 'Original folder';
  const wordName = options.rename ? 'renamed.docx' : 'content.docx';
  const imageName = options.rename ? 'renamed.png' : 'cover.png';
  const profile = options.profile ?? 'SHOP MALL';
  const document = {
    format: 'listing-source' as const,
    version: 1 as const,
    product: { productKey, sourceRevision: 0 },
    ...(options.sourceId !== undefined
      ? {
          sourceListingId: {
            value: options.sourceId,
            source: { fileSha256: word.sha256, locator: 'Catalog!C2' },
          },
        }
      : {}),
    word: {
      path: wordName,
      sha256: word.sha256,
      title: { start: 1, end: 1 },
      headline: { start: 2, end: 2 },
      body: { start: options.titleRange ? 2 : 3, end: 3 },
      paragraphSeparator: '\n' as const,
    },
    priceSource: {
      sha256: price.sha256,
      sheet: 'Prices',
      priceProfile: null,
      selectionMode: 'operator_choice' as const,
    },
    media: {
      cover: { path: imageName, sha256: image.sha256 },
      gallery: [{ path: imageName, sha256: image.sha256 }],
      description: [],
    },
    tierNames: ['Size'],
    variants: [{ sku: 'SKU-A', optionLabels: ['100ml'] }],
  };
  const manifestSha = createHash('sha256').update(JSON.stringify(document)).digest('hex');
  const state: InputBatchState = {
    version: 1,
    name: group,
    mode: 'single_listing',
    files: [
      {
        name: wordName,
        relativePath: group + '/' + wordName,
        size: 12,
        sha256: word.sha256,
        importId: word.id,
      },
      {
        name: imageName,
        relativePath: group + '/' + imageName,
        size: 12,
        sha256: image.sha256,
        importId: image.id,
      },
      {
        name: 'listing-source.json',
        relativePath: group + '/listing-source.json',
        size: 12,
        sha256: manifestSha,
      },
    ],
    priceSelection: { importId: price.id, sheet: 'Prices', priceProfile: profile },
    visual: {},
    wordPaths: {},
    wordRule: null,
    productKeys: { [group]: 'input-' + randomUUID() },
    manifests: {
      [group]: { relativePath: group + '/listing-source.json', sha256: manifestSha, document },
    },
  };
  const batchId = randomUUID();
  await service.save({ id: batchId, expectedRevision: 0, state });
  const input: ProductInput = {
    productKey,
    expectedRevision: 0,
    folderBinding: { batchId, revision: 1, groupKey: group },
    ...(options.sourceId !== undefined ? { sourceListingId: options.sourceId } : {}),
    title: 'Exact title',
    headline: 'Exact headline',
    body: options.titleRange ? 'Exact headline\nExact body' : 'Exact body',
    coverId: image.id,
    galleryIds: [image.id],
    descriptionImageIds: [],
    tierNames: ['Size'],
    variants: [
      {
        importId: price.id,
        rowKey: profile === 'SHOP MALL' ? 'row-0' : 'row-1',
        optionLabels: ['100ml'],
      },
    ],
  };
  return { input, state, batchId };
}
it('two intakes and concurrent saves return one portable product and one immutable claim', async () => {
  const key = 'same-' + randomUUID(),
    a = await intake(key),
    b = await intake(key);
  const [first, second] = await Promise.all([
    saveAssembledProduct(repo, a.input),
    saveAssembledProduct(repo, b.input),
  ]);
  expect(first).toEqual(second);
  expect(first.productKey).toBe(key);
  expect(first.revision).toBe(1);
  const summaries = await new InputLibraryRepository(pool).list();
  expect(summaries.find((s) => s.id === a.batchId)?.completedCount).toBe(1);
  expect(summaries.find((s) => s.id === b.batchId)?.completedCount).toBe(1);
  expect(
    (await pool.query('SELECT count(*)::int n FROM product_revisions WHERE product_key=$1', [key]))
      .rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query('SELECT count(*)::int n FROM folder_source_claims WHERE product_key=$1', [
        key,
      ])
    ).rows[0].n,
  ).toBe(1);
  await expect(
    pool.query(
      'UPDATE folder_source_claims SET source_fingerprint=source_fingerprint WHERE product_key=$1',
      [key],
    ),
  ).rejects.toThrow('FOLDER_SOURCE_CLAIM_IMMUTABLE');
});
it('renamed files and outer folder with identical bytes reopen the same product', async () => {
  const key = 'rename-' + randomUUID(),
    a = await intake(key),
    first = await saveAssembledProduct(repo, a.input);
  const b = await intake(key, { rename: true });
  expect(await saveAssembledProduct(repo, b.input)).toEqual(first);
});
it.each(['profile', 'content', 'id'] as const)(
  'blocks changed %s under the same portable identity without creating another revision',
  async (change) => {
    const key = 'changed-' + randomUUID(),
      a = await intake(key),
      first = await saveAssembledProduct(repo, a.input);
    const b = await intake(
      key,
      change === 'profile'
        ? { profile: 'SHOP THƯỜNG' }
        : change === 'content'
          ? { titleRange: true }
          : { sourceId: null },
    );
    await expect(saveAssembledProduct(repo, b.input)).rejects.toThrow('FOLDER_SOURCE_CHANGED');
    expect(await repo.getProduct(key)).toEqual(first);
  },
);
it('blocks stale binding, changed selection and omitted binding on both portable and reserved aliases', async () => {
  const key = 'guard-' + randomUUID(),
    a = await intake(key);
  await expect(
    saveAssembledProduct(repo, { ...a.input, title: 'silently changed' }),
  ).rejects.toThrow('FOLDER_SOURCE_SELECTION_MISMATCH');
  await expect(
    saveAssembledProduct(repo, { ...a.input, folderBinding: undefined }),
  ).rejects.toThrow('FOLDER_SOURCE_BINDING_REQUIRED');
  await expect(
    saveAssembledProduct(repo, {
      ...a.input,
      productKey: Object.values(a.state.productKeys)[0],
      folderBinding: undefined,
    }),
  ).rejects.toThrow('FOLDER_SOURCE_BINDING_REQUIRED');
  await service.save({
    id: a.batchId,
    expectedRevision: 1,
    state: { ...a.state, name: 'Later choices', manifests: {} },
  });
  await expect(saveAssembledProduct(repo, a.input)).rejects.toThrow('FOLDER_SOURCE_BINDING_STALE');
  await expect(
    saveAssembledProduct(repo, { ...a.input, folderBinding: undefined }),
  ).rejects.toThrow('FOLDER_SOURCE_BINDING_REQUIRED');
  expect(await repo.getProduct(key)).toBeNull();
});
it('does not silently reopen a source edited after its first saved revision', async () => {
  const key = 'edited-' + randomUUID(),
    a = await intake(key),
    first = await saveAssembledProduct(repo, a.input);
  const changed = await saveAssembledProduct(repo, {
    ...a.input,
    expectedRevision: 1,
    title: 'Explicit editor change',
  });
  expect(changed.folderSource).toEqual(first.folderSource);
  const b = await intake(key);
  await expect(saveAssembledProduct(repo, b.input)).rejects.toThrow('FOLDER_SOURCE_CHANGED');
  expect((await repo.getProduct(key))?.revision).toBe(2);
});
