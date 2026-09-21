import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  InputLibraryRepository,
  migrate,
  Pool,
  Repository,
} from '../../packages/persistence/src/index.js';
import type { InputBatchState, ListingDraft } from '../../packages/domain/src/index.js';
import { compileDescription } from '../../packages/domain/src/source/normalize.js';
import { InputService } from '../../apps/api/src/input-service.js';
import { fact, fixtureDraft } from '../helpers/fixtures.js';

const database = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '5442')
  throw new Error('LOCAL_TEST_DATABASE_REQUIRED');
const schema = 'test_portable_count_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const repo = new Repository(pool),
  service = new InputService(repo),
  library = new InputLibraryRepository(pool);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let state: InputBatchState, saved: ListingDraft;
const group = 'Cam Sa';
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  async function source(filename: string, kind: 'docx' | 'xlsx' | 'image', body: unknown) {
    const record = await repo.createImport({ filename, kind, sha256: digest(filename), bytes: 12 });
    await repo.finishImport(record.id, body);
    return record;
  }
  const word = await source('content.docx', 'docx', { paragraphs: ['Cam Sa', 'Headline', 'Body'] });
  const image = await source('cover.png', 'image', { mime: 'image/png', width: 100, height: 100 });
  const priceFact = (value: string, cell: string) => ({
    value,
    confirmed: true,
    sources: [
      {
        kind: 'product_file' as const,
        fileSha256: digest('prices.xlsx'),
        locator: 'Prices!' + cell,
        observedAt: '2026-09-16T00:00:00Z',
      },
    ],
  });
  const price = await source('prices.xlsx', 'xlsx', {
    source: fact('').sources[0],
    issues: [],
    sheets: [{ name: 'Prices', rowCount: 2, importedRows: 1, headerRows: [1] }],
    rows: [
      {
        key: 'row-a',
        sheet: 'Prices',
        row: 2,
        headerRow: 1,
        priceProfile: 'SHOP MALL',
        sku: priceFact('VTCAM100', 'A2'),
        name: fact('Cam Sa'),
        originalPrice: priceFact('119998', 'B2'),
        issues: [],
      },
    ],
  });
  const draft = {
    ...fixtureDraft(),
    productKey: 'saved-cam-sa',
    title: fact('Cam Sa'),
    description: compileDescription('Headline', 'Body', []),
    coverKey: image.id,
    galleryKeys: [image.id],
    tierNames: ['Dung tich'],
    variants: [
      {
        key: 'row-a',
        sku: priceFact('VTCAM100', 'A2'),
        optionLabels: ['100ml'],
        originalPrice: priceFact('119998', 'B2'),
      },
    ],
    assets: [
      {
        key: image.id,
        sha256: image.sha256,
        mime: 'image/png',
        width: 100,
        height: 100,
        bytes: 12,
        source: fact('').sources[0],
      },
    ],
  } as ListingDraft;
  saved = await repo.saveProduct(draft, 0);
  const document = {
    format: 'listing-source' as const,
    version: 1 as const,
    product: { productKey: saved.productKey, sourceRevision: 1 },
    word: {
      path: 'content.docx',
      sha256: word.sha256,
      title: { start: 1, end: 1 },
      headline: { start: 2, end: 2 },
      body: { start: 3, end: 3 },
      paragraphSeparator: '\n' as const,
    },
    priceSource: { sha256: price.sha256, sheet: 'Prices', priceProfile: 'SHOP MALL' },
    media: {
      cover: { path: 'cover.png', sha256: image.sha256 },
      gallery: [{ path: 'cover.png', sha256: image.sha256 }],
      description: [],
    },
    tierNames: ['Dung tich'],
    variants: [{ sku: 'VTCAM100', optionLabels: ['100ml'] }],
  };
  const manifestSha = digest(JSON.stringify(document));
  state = {
    version: 1,
    name: 'Cam Sa da luu',
    mode: 'single_listing',
    files: [word, image].map((r) => ({
      name: r.filename,
      relativePath: group + '/' + r.filename,
      size: 12,
      importId: r.id,
      sha256: r.sha256,
    })),
    priceSelection: { importId: price.id, sheet: 'Prices', priceProfile: 'SHOP MALL' },
    visual: {},
    wordPaths: {},
    wordRule: null,
    productKeys: { [group]: 'input-' + randomUUID() },
    manifests: {
      [group]: { relativePath: group + '/listing-source.json', sha256: manifestSha, document },
    },
  };
  state.files.push({
    name: 'listing-source.json',
    relativePath: group + '/listing-source.json',
    size: 12,
    sha256: manifestSha,
  });
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function count(change?: (copy: InputBatchState) => void) {
  const copy = structuredClone(state),
    id = randomUUID();
  copy.productKeys[group] = 'input-' + randomUUID();
  change?.(copy);
  await service.save({ id, expectedRevision: 0, state: copy });
  return (await library.list()).find((row) => row.id === id)!;
}
it('counts a revision-bound existing draft through an intake alias only after comparing its sources', async () => {
  const before = await repo.getProduct(saved.productKey);
  expect((await count()).completedCount).toBe(1);
  expect(await repo.getProduct(saved.productKey)).toEqual(before);
  expect((await pool.query('SELECT count(*)::int n FROM product_revisions')).rows[0].n).toBe(1);
});
it.each([
  'revision',
  'word',
  'price',
  'sku',
  'image',
  'sourceId',
  'unresolved',
  'missingFile',
] as const)(
  'does not count an arbitrary existing product key with mismatched %s',
  async (mismatch) => {
    const result = await count((copy) => {
      const m = copy.manifests![group]!.document;
      if (mismatch === 'revision') m.product.sourceRevision = 2;
      if (mismatch === 'word') m.word.body = { start: 2, end: 3 };
      if (mismatch === 'price') m.priceSource.sha256 = digest('different-pricebook');
      if (mismatch === 'sku') m.variants[0]!.sku = 'UNRELATED';
      if (mismatch === 'image') m.media.gallery = [];
      if (mismatch === 'sourceId')
        m.sourceListingId = {
          value: '123456',
          source: { fileSha256: digest('catalog'), locator: 'Sheet!C2' },
        };
      if (mismatch === 'unresolved') copy.priceSelection = null;
      if (mismatch === 'missingFile') copy.files = copy.files.filter((f) => f.name !== 'cover.png');
    });
    expect(result.completedCount).toBe(0);
  },
);
it('accepts renamed files with identical source bytes and uses bounded metadata queries', async () => {
  const result = await count((copy) => {
    const m = copy.manifests![group]!.document;
    m.word.path = 'renamed-content.docx';
    m.media.cover!.path = 'renamed-cover.png';
    m.media.gallery[0]!.path = 'renamed-cover.png';
    for (const file of copy.files) {
      if (file.name === 'content.docx') file.name = 'renamed-content.docx';
      if (file.name === 'cover.png') file.name = 'renamed-cover.png';
      file.relativePath = group + '/' + file.name;
    }
  });
  expect(result.completedCount).toBe(1);
  const query = vi.spyOn(pool, 'query');
  try {
    const summaries = await library.list();
    expect(summaries.find((row) => row.id === result.id)?.completedCount).toBe(1);
    // One summary read, one deduplicated parsed-source read, one latest-draft read, regardless of intake count.
    expect(query).toHaveBeenCalledTimes(3);
    const sourceCall = query.mock.calls.find(([sql]) => String(sql).includes('FROM source_files'))!;
    expect(String(sourceCall[0])).toContain(
      "CASE WHEN kind IN ('docx','xlsx') THEN body ELSE NULL END",
    );
    expect((sourceCall[1] as string[][])[0]).toHaveLength(3);
  } finally {
    query.mockRestore();
  }
});
it('does not treat equal prices from an unrelated workbook as the same saved binding', async () => {
  const unrelated = structuredClone(saved);
  unrelated.productKey = 'unrelated-price-source';
  unrelated.variants[0]!.originalPrice.sources[0]!.fileSha256 = digest('unrelated-workbook');
  await repo.saveProduct(unrelated, 0);
  const result = await count((copy) => {
    copy.manifests![group]!.document.product.productKey = unrelated.productKey;
  });
  expect(result.completedCount).toBe(0);
});
it('keeps the library readable when an existing draft references an absent gallery asset', async () => {
  const incomplete = structuredClone(saved);
  incomplete.productKey = 'saved-with-missing-asset';
  incomplete.galleryKeys = ['missing-asset'];
  await repo.saveProduct(incomplete, 0);
  expect(
    (
      await count((copy) => {
        copy.manifests![group]!.document.product.productKey = incomplete.productKey;
      })
    ).completedCount,
  ).toBe(0);
});
