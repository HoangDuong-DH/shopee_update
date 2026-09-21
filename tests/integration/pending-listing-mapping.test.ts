import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { InputService } from '../../apps/api/src/input-service.js';
import { productInput, saveAssembledProduct } from '../../apps/api/src/product-service.js';
import { resolvePendingSourceClaim } from '../../apps/api/src/pending-source-claim.js';
import type { InputBatchState } from '../../packages/domain/src/input-library.js';
import {
  readPendingListingMapping,
  resolvePendingListingMapping,
  updatePendingSku,
} from '../../apps/web/src/pending-listing-mapping.js';
import { pendingWorksheet, pendingPriceSource } from '../helpers/pending-listing-fixture.js';

const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const service = new InputService(new Repository(pool));
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

function state(): InputBatchState {
  const mappings = ['A', 'B'].map((label, index) => {
    const document = pendingWorksheet();
    document.product.productKey = 'pending-' + randomUUID();
    document.sourceKey = 'source-' + label;
    return readPendingListingMapping(JSON.stringify(document), {
      relativePath: `Nguồn/${label}/listing-mapping.pending.json`,
      sha256: String(index + 1).repeat(64),
    });
  });
  return {
    version: 1,
    name: 'Hai bộ đang bổ sung',
    mode: 'parent_with_listing_folders',
    files: mappings.map((m) => ({
      relativePath: m.relativePath,
      name: 'listing-mapping.pending.json',
      size: 1000,
      sha256: m.sha256,
    })),
    priceSelection: null,
    visual: {},
    wordPaths: {},
    wordRule: null,
    productKeys: Object.fromEntries(
      mappings.map((m, i) => [`Nguồn/${['A', 'B'][i]}`, m.document.product.productKey]),
    ),
    pendingMappings: Object.fromEntries(mappings.map((m, i) => [`Nguồn/${['A', 'B'][i]}`, m])),
  };
}

it('reloads each incomplete source from PostgreSQL, edits one slot, and retains the other source and prior revision', async () => {
  const id = randomUUID(),
    first = state();
  await service.save({ id, expectedRevision: 0, state: first });
  const reloaded = (await new InputService(new Repository(pool)).library.get(id))!;
  expect(reloaded.state.pendingMappings).toEqual(first.pendingMappings);
  const next = structuredClone(reloaded.state);
  next.pendingMappings!['Nguồn/A'] = {
    ...updatePendingSku(next.pendingMappings!['Nguồn/A'], 'slot-b', 'B'),
    structureConfirmed: true,
  };
  await service.save({ id, expectedRevision: reloaded.revision, state: next });
  const last = (await service.library.get(id))!;
  expect(last.state.pendingMappings!['Nguồn/A'].skuEdits).toEqual({ 'slot-b': 'B' });
  expect(last.state.pendingMappings!['Nguồn/B']).toEqual(first.pendingMappings!['Nguồn/B']);
  expect(
    (
      await pool.query('SELECT state FROM input_batch_revisions WHERE batch_id=$1 AND revision=1', [
        id,
      ])
    ).rows[0].state,
  ).toEqual(first);
  await expect(service.save({ id, expectedRevision: 1, state: first })).rejects.toThrow(
    'INPUT_BATCH_REVISION_CONFLICT',
  );
});

it('does not create products, plans, jobs or production operations while saving missing/placeholder/price-less slots', async () => {
  const before = await pool.query(`SELECT (SELECT count(*)::int FROM products) AS products,
    (SELECT count(*)::int FROM plan_revisions) AS plans, (SELECT count(*)::int FROM jobs) AS jobs,
    (SELECT count(*)::int FROM production_pilot_operations) AS operations`);
  for (const sku of ['', 'CHƯA CÓ SKU', 'B']) {
    const value = state();
    value.pendingMappings!['Nguồn/A'] = {
      ...updatePendingSku(value.pendingMappings!['Nguồn/A'], 'slot-b', sku),
      structureConfirmed: true,
    };
    await service.save({ id: randomUUID(), expectedRevision: 0, state: value });
    const source = pendingPriceSource();
    source.rows[1].originalPrice = undefined;
    expect(
      resolvePendingListingMapping(value.pendingMappings!['Nguồn/A'], source).seed,
    ).toBeUndefined();
  }
  expect(
    (
      await pool.query(`SELECT (SELECT count(*)::int FROM products) AS products,
    (SELECT count(*)::int FROM plan_revisions) AS plans, (SELECT count(*)::int FROM jobs) AS jobs,
    (SELECT count(*)::int FROM production_pilot_operations) AS operations`)
    ).rows,
  ).toEqual(before.rows);
  expect(productInput.safeParse({ expectedRevision: 0, ...pendingWorksheet() }).success).toBe(
    false,
  );
});

it('rejects cross-group keys, wrong file hashes and unknown slot edits before storing an input revision', async () => {
  for (const mutate of [
    (s: InputBatchState) => {
      s.pendingMappings!['Nguồn/A'].relativePath = 'Nguồn/B/listing-mapping.pending.json';
    },
    (s: InputBatchState) => {
      s.files[0].sha256 = '9'.repeat(64);
    },
    (s: InputBatchState) => {
      s.pendingMappings!['Nguồn/A'].skuEdits.foreign = 'B';
    },
  ]) {
    const id = randomUUID(),
      value = state();
    mutate(value);
    await expect(async () =>
      service.save({ id, expectedRevision: 0, state: value }),
    ).rejects.toThrow();
    expect(await service.library.get(id)).toBeNull();
  }
});

it('does not replace a saved source worksheet while editing SKU slots', async () => {
  const id = randomUUID(),
    first = state();
  await service.save({ id, expectedRevision: 0, state: first });
  for (const mutate of [
    (s: InputBatchState) => {
      s.pendingMappings!['Nguồn/A'].document.title = 'Different source';
    },
    (s: InputBatchState) => {
      s.pendingMappings!['Nguồn/A'].sha256 = '9'.repeat(64);
      s.files[0].sha256 = '9'.repeat(64);
    },
  ]) {
    const changed = structuredClone(first);
    mutate(changed);
    await expect(service.save({ id, expectedRevision: 1, state: changed })).rejects.toThrow(
      'INPUT_BATCH_PENDING_SOURCE_CHANGED',
    );
  }
  expect((await service.library.get(id))!.revision).toBe(1);
});

it('blocks omitted binding and a submitted subset at the product save boundary, even with real price rows', async () => {
  const repo = new Repository(pool),
    prices = pendingPriceSource();
  const record = await repo.createImport({
    kind: 'xlsx',
    sha256: randomUUID().replaceAll('-', '').repeat(2),
    filename: 'Pending prices.xlsx',
    bytes: 1,
  });
  await repo.finishImport(record.id, {
    rows: prices.rows,
    sheets: [{ name: prices.sheet, rowCount: 3, importedRows: 2, headerRows: [1] }],
    issues: [],
  });
  const id = randomUUID(),
    first = state();
  first.productKeys['Nguồn/A'] = 'intake-alias-' + randomUUID();
  first.priceSelection = {
    importId: record.id,
    sheet: prices.sheet,
    priceProfile: prices.priceProfile,
  };
  await service.save({ id, expectedRevision: 0, state: first });
  const input = {
    productKey: first.pendingMappings!['Nguồn/A'].document.product.productKey,
    expectedRevision: 0,
    title: 'Nguồn giữ nguyên',
    headline: '',
    body: '',
    sourceListingId: null,
    coverId: undefined,
    galleryIds: [],
    descriptionImageIds: [],
    tierNames: first.pendingMappings!['Nguồn/A'].document.tiers.map((t) => t.literalHeading),
    variants: [{ importId: record.id, rowKey: 'row-A', optionLabels: ['Hoa Hồng', '100ml'] }],
  };
  await expect(saveAssembledProduct(repo, input)).rejects.toThrow('FOLDER_SOURCE_BINDING_REQUIRED');
  await expect(
    saveAssembledProduct(repo, {
      ...input,
      folderBinding: { batchId: id, revision: 1, groupKey: 'Nguồn/A' },
    }),
  ).rejects.toThrow('PENDING_SOURCE_INCOMPLETE');
  const complete = structuredClone(first);
  complete.pendingMappings!['Nguồn/A'] = {
    ...updatePendingSku(complete.pendingMappings!['Nguồn/A'], 'slot-b', 'B'),
    structureConfirmed: true,
  };
  await service.save({ id, expectedRevision: 1, state: complete });
  await expect(
    saveAssembledProduct(repo, {
      ...input,
      folderBinding: { batchId: id, revision: 2, groupKey: 'Nguồn/A' },
    }),
  ).rejects.toThrow('PENDING_SOURCE_SELECTION_MISMATCH');
  expect(await repo.getProduct(input.productKey)).toBeNull();

  const full = {
    ...input,
    folderBinding: { batchId: id, revision: 2, groupKey: 'Nguồn/A' },
    variants: [
      { importId: record.id, rowKey: 'row-B', optionLabels: ['Cam Sả (MỚI)', '300ml'] },
      { importId: record.id, rowKey: 'row-A', optionLabels: ['Hoa Hồng', '100ml'] },
    ],
  };
  const saved = await saveAssembledProduct(repo, full);
  expect(saved.revision).toBe(1);
  expect(saved.folderSource?.productKey).toBe(input.productKey);
  expect(saved.variants.map((v) => [v.sku.value, v.optionLabels])).toEqual([
    ['B', ['Cam Sả (MỚI)', '300ml']],
    ['A', ['Hoa Hồng', '100ml']],
  ]);
  expect(await saveAssembledProduct(repo, full)).toEqual(saved);
  const copyId = randomUUID(),
    copyGroup = 'Nguồn/Bản sao';
  const copiedMapping = {
    ...structuredClone(complete.pendingMappings!['Nguồn/A']),
    relativePath: copyGroup + '/listing-mapping.pending.json',
  };
  const copied: InputBatchState = {
    ...complete,
    files: [{ ...complete.files[0], relativePath: copiedMapping.relativePath }],
    productKeys: { [copyGroup]: 'other-intake-' + randomUUID() },
    pendingMappings: { [copyGroup]: copiedMapping },
  };
  await service.save({ id: copyId, expectedRevision: 0, state: copied });
  expect(
    await saveAssembledProduct(repo, {
      ...full,
      folderBinding: { batchId: copyId, revision: 1, groupKey: copyGroup },
    }),
  ).toEqual(saved);
  expect(
    (
      await pool.query('SELECT count(*)::int AS n FROM product_revisions WHERE product_key=$1', [
        input.productKey,
      ])
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query('SELECT count(*)::int AS n FROM folder_source_claims WHERE product_key=$1', [
        input.productKey,
      ])
    ).rows[0].n,
  ).toBe(1);
  expect(
    (await pool.query('SELECT count(*)::int AS n FROM production_pilot_operations')).rows[0].n,
  ).toBe(0);
});

it('persists explicit per-slot image choices separately from immutable source, then enforces them after database reload', async () => {
  const repo = new Repository(pool),
    prices = pendingPriceSource(),
    first = state(),
    id = randomUUID();
  const price = await repo.createImport({
    kind: 'xlsx',
    filename: 'Pending image prices.xlsx',
    bytes: 1,
    sha256: randomUUID().replaceAll('-', '').repeat(2),
  });
  await repo.finishImport(price.id, {
    rows: prices.rows,
    sheets: [{ name: prices.sheet, rowCount: 3, importedRows: 2, headerRows: [1] }],
    issues: [],
  });
  const images = [];
  for (const label of ['A', 'B']) {
    const record = await repo.createImport({
      kind: 'image',
      filename: label + '.png',
      bytes: 10,
      sha256: randomUUID().replaceAll('-', '').repeat(2),
    });
    await repo.finishImport(record.id, { width: 100, height: 100 });
    images.push(record);
  }
  const a = images[0],
    b = images[1],
    mapping = first.pendingMappings!['Nguồn/A'];
  mapping.document.slots[0].variationImageCandidates = [
    {
      path: 'Anh/phan-loai-02.png',
      sha256: b.sha256,
      role: 'variation',
      familyMatchesSource: true,
    },
  ];
  mapping.document.slots[1].variationImageCandidates = [
    {
      path: 'Anh/phan-loai-01.png',
      sha256: a.sha256,
      role: 'variation',
      familyMatchesSource: true,
    },
  ];
  mapping.document.slots[1].selectedVariationImage = {
    sku: 'A',
    path: 'Anh/phan-loai-01.png',
    sha256: a.sha256,
  };
  first.priceSelection = {
    importId: price.id,
    sheet: prices.sheet,
    priceProfile: prices.priceProfile,
  };
  first.files.push(
    ...[b, a].map((record, index) => ({
      relativePath: 'Nguồn/A/Anh/phan-loai-0' + (2 - index) + '.png',
      name: 'phan-loai-0' + (2 - index) + '.png',
      importId: record.id,
      sha256: record.sha256,
      size: 10,
    })),
  );
  await service.save({ id, expectedRevision: 0, state: first });
  const next = structuredClone(first),
    completed = next.pendingMappings!['Nguồn/A'];
  completed.skuEdits['slot-b'] = 'B';
  completed.structureConfirmed = true;
  completed.imageSelections = {
    'slot-b': { sku: 'B', path: 'Anh/phan-loai-02.png', sha256: b.sha256 },
  };
  await service.save({ id, expectedRevision: 1, state: next });
  const reloaded = (await new InputService(repo).library.get(id))!,
    stored = reloaded.state.pendingMappings!['Nguồn/A'];
  expect(stored.imageSelections).toEqual(completed.imageSelections);
  expect(stored.document).toEqual(mapping.document);
  const input = {
    productKey: stored.document.product.productKey,
    expectedRevision: 0,
    folderBinding: { batchId: id, revision: 2, groupKey: 'Nguồn/A' },
    sourceListingId: null,
    title: stored.document.title,
    headline: '',
    body: '',
    coverId: a.id,
    galleryIds: [],
    descriptionImageIds: [],
    tierNames: stored.document.tiers.map((t) => t.literalHeading),
    variants: [
      {
        importId: price.id,
        rowKey: 'row-B',
        optionLabels: stored.document.slots[0].optionLabels,
        imageId: b.id,
      },
      {
        importId: price.id,
        rowKey: 'row-A',
        optionLabels: stored.document.slots[1].optionLabels,
        imageId: a.id,
      },
    ],
  };
  await expect(resolvePendingSourceClaim(repo, input, reloaded, stored)).resolves.toMatchObject(
    input.folderBinding,
  );
  input.variants[0].imageId = a.id;
  await expect(resolvePendingSourceClaim(repo, input, reloaded, stored)).rejects.toThrow(
    'PENDING_SOURCE_IMAGE_INVALID',
  );
  expect(await repo.getProduct(input.productKey)).toBeNull();
  const original = (
    await pool.query('SELECT state FROM input_batch_revisions WHERE batch_id=$1 AND revision=1', [
      id,
    ])
  ).rows[0].state;
  expect(original.pendingMappings['Nguồn/A']).not.toHaveProperty('imageSelections');
  expect(original.pendingMappings['Nguồn/A'].document).toEqual(stored.document);
});
