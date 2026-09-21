import { expect, it } from 'vitest';
import { resolvePendingSourceClaim } from '../../apps/api/src/pending-source-claim.js';
import { pendingWorksheet, pendingPriceSource } from '../helpers/pending-listing-fixture.js';
import {
  readPendingListingMapping,
  updatePendingSku,
} from '../../apps/web/src/pending-listing-mapping.js';
import type { InputBatchRecord } from '../../packages/domain/src/input-library.js';
import type { ProductInput } from '../../apps/api/src/product-service.js';

function fixture() {
  const source = pendingPriceSource(),
    binding = { batchId: '00000000-0000-4000-8000-000000000002', revision: 1, groupKey: 'Nguồn/A' };
  const mapping = {
    ...updatePendingSku(
      readPendingListingMapping(JSON.stringify(pendingWorksheet()), {
        relativePath: binding.groupKey + '/listing-mapping.pending.json',
        sha256: 'a'.repeat(64),
      }),
      'slot-b',
      'B',
    ),
    structureConfirmed: true,
  };
  const batch: InputBatchRecord = {
    id: binding.batchId,
    revision: 1,
    createdAt: '2026-09-16T00:00:00Z',
    updatedAt: '2026-09-16T00:00:00Z',
    state: {
      version: 1,
      name: 'Pending fixture',
      mode: 'parent_with_listing_folders',
      files: [
        {
          relativePath: mapping.relativePath,
          name: 'listing-mapping.pending.json',
          sha256: mapping.sha256,
          size: 1,
        },
        {
          relativePath: 'Nguồn/A/ảnh.png',
          name: 'ảnh.png',
          sha256: 'd'.repeat(64),
          size: 10,
          importId: '00000000-0000-4000-8000-000000000003',
        },
      ],
      productKeys: { 'Nguồn/A': mapping.document.product.productKey },
      pendingMappings: { 'Nguồn/A': mapping },
      priceSelection: {
        importId: source.importId,
        sheet: source.sheet,
        priceProfile: source.priceProfile,
      },
      visual: {},
      wordPaths: {},
      wordRule: null,
    },
  };
  const input: ProductInput = {
    productKey: mapping.document.product.productKey,
    expectedRevision: 0,
    folderBinding: binding,
    sourceListingId: null,
    title: mapping.document.title,
    headline: 'Nội dung nguồn',
    body: 'Giữ nguyên',
    tierNames: mapping.document.tiers.map((t) => t.literalHeading),
    coverId: batch.state.files[1].importId,
    galleryIds: [batch.state.files[1].importId!],
    descriptionImageIds: [],
    variants: [1, 0].map((i) => ({
      importId: source.importId,
      rowKey: source.rows[i].key,
      optionLabels: mapping.document.slots[i === 1 ? 0 : 1].optionLabels,
    })),
  };
  const records = new Map<string, any>([
    [
      source.importId,
      {
        id: source.importId,
        kind: 'xlsx',
        status: 'ready',
        sha256: 'c'.repeat(64),
        body: { rows: source.rows },
      },
    ],
    [
      input.coverId!,
      { id: input.coverId, kind: 'image', status: 'ready', sha256: 'd'.repeat(64), bytes: 10 },
    ],
  ]);
  const repo = { getImport: async (id: string) => records.get(id) ?? null };
  return { source, batch, mapping, input, repo, records };
}

it('binds the complete confirmed table and exact pricebook selections without applying worksheet price hints', async () => {
  const f = fixture();
  f.batch.state.productKeys['Nguồn/A'] = 'intake-local-alias';
  const result = await resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping);
  expect(result).toMatchObject(f.input.folderBinding!);
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
});
it.each([
  'unconfirmed',
  'missing',
  'placeholder',
  'no-price',
  'subset',
  'reorder',
  'wrong-source-id',
  'stale',
  'outside-image',
] as const)('blocks %s pending data before product creation', async (kind) => {
  const f = fixture();
  if (kind === 'unconfirmed') f.mapping.structureConfirmed = false;
  if (kind === 'missing') f.mapping.skuEdits['slot-b'] = null;
  if (kind === 'placeholder') f.mapping.skuEdits['slot-b'] = 'CHƯA CÓ SKU';
  if (kind === 'no-price') f.source.rows[1].originalPrice = undefined;
  if (kind === 'subset') f.input.variants.pop();
  if (kind === 'reorder') f.input.variants.reverse();
  if (kind === 'wrong-source-id') f.input.sourceListingId = '123';
  if (kind === 'stale') f.batch.revision = 2;
  if (kind === 'outside-image') f.batch.state.files[1].relativePath = 'Nguồn/B/ảnh.png';
  await expect(resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping)).rejects.toThrow(
    /PENDING_SOURCE_/,
  );
});
it('uses stable source and ordered image hashes, while content or price source changes produce a different proof', async () => {
  const f = fixture();
  const original = await resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping);
  f.batch.state.files[1].relativePath = 'Nguồn/A/renamed.png';
  f.batch.state.files[1].name = 'renamed.png';
  expect((await resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping)).fingerprint).toBe(
    original.fingerprint,
  );
  f.input.body += ' edited';
  expect(
    (await resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping)).fingerprint,
  ).not.toBe(original.fingerprint);
  f.input.body = 'Giữ nguyên';
  f.records.get(f.source.importId).sha256 = 'e'.repeat(64);
  expect(
    (await resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping)).fingerprint,
  ).not.toBe(original.fingerprint);
});

function selectedImagesFixture() {
  const f = fixture(),
    mapping: any = f.mapping;
  const a = {
    path: 'ảnh.png',
    sha256: 'd'.repeat(64),
    role: 'variation',
    familyMatchesSource: true,
  };
  const b = {
    path: 'Anh/C01/phan-loai-02.png',
    sha256: 'e'.repeat(64),
    role: 'variation',
    familyMatchesSource: true,
  };
  mapping.document.slots[0].variationImageCandidates = [b];
  mapping.document.slots[1].variationImageCandidates = [a];
  mapping.document.slots[1].selectedVariationImage = { sku: 'A', path: a.path, sha256: a.sha256 };
  mapping.imageSelections = { 'slot-b': { sku: 'B', path: b.path, sha256: b.sha256 } };
  const bId = '00000000-0000-4000-8000-000000000004';
  f.batch.state.files.unshift({
    relativePath: 'Nguồn/A/' + b.path,
    name: 'phan-loai-02.png',
    sha256: b.sha256,
    size: 11,
    importId: bId,
  });
  f.records.set(bId, { id: bId, kind: 'image', status: 'ready', sha256: b.sha256, bytes: 11 });
  f.input.variants[0].imageId = bId;
  f.input.variants[1].imageId = f.input.coverId;
  return { ...f, a, b, bId };
}

it('binds explicit source and saved image choices to exact stable slots despite shuffled file/price/slot order', async () => {
  const f = selectedImagesFixture();
  await expect(
    resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping),
  ).resolves.toMatchObject(f.input.folderBinding!);
  // Swapping two ready, valid in-group images is still a source-selection mismatch.
  [f.input.variants[0].imageId, f.input.variants[1].imageId] = [
    f.input.variants[1].imageId,
    f.input.variants[0].imageId,
  ];
  await expect(resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping)).rejects.toThrow(
    'PENDING_SOURCE_IMAGE_INVALID',
  );
});

it.each([
  'missing-image',
  'wrong-image',
  'outside-group',
  'wrong-file-hash',
  'wrong-import-hash',
  'wrong-size',
  'duplicate-path',
  'not-ready',
  'wrong-kind',
  'changed-sku',
  'file-error',
  'missing-import',
] as const)('rejects pending selected variant image %s before saving', async (fault) => {
  const f = selectedImagesFixture(),
    file = f.batch.state.files.find((file) => file.importId === f.bId)!;
  if (fault === 'missing-image') delete f.input.variants[0].imageId;
  if (fault === 'wrong-image') f.input.variants[0].imageId = f.input.coverId;
  if (fault === 'outside-group') file.relativePath = 'Nguồn/B/' + f.b.path;
  if (fault === 'wrong-file-hash') file.sha256 = 'f'.repeat(64);
  if (fault === 'wrong-import-hash') f.records.get(f.bId).sha256 = 'f'.repeat(64);
  if (fault === 'wrong-size') file.size = 99;
  if (fault === 'duplicate-path') f.batch.state.files.push({ ...file });
  if (fault === 'not-ready') f.records.get(f.bId).status = 'processing';
  if (fault === 'wrong-kind') f.records.get(f.bId).kind = 'docx';
  if (fault === 'changed-sku') f.mapping.skuEdits['slot-b'] = 'C';
  if (fault === 'file-error') file.error = 'Image failed to read';
  if (fault === 'missing-import') delete file.importId;
  await expect(resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping)).rejects.toThrow(
    /PENDING_SOURCE_/,
  );
});

it('allows deliberately cleared or absent source selection to retain the existing manual in-group image path', async () => {
  const f = selectedImagesFixture();
  (f.mapping as any).imageSelections = { 'slot-b': null, 'slot-a': null };
  f.input.variants[0].imageId = f.input.coverId;
  delete f.input.variants[1].imageId;
  await expect(
    resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping),
  ).resolves.toMatchObject(f.input.folderBinding!);
  // Two candidate designs alone do not force a choice or silently prefer C01.
  delete (f.mapping as any).imageSelections;
  delete (f.mapping.document.slots[1] as any).selectedVariationImage;
  (f.mapping.document.slots[0] as any).variationImageCandidates.push({
    ...f.b,
    path: 'Anh/C02/phan-loai-02.png',
    sha256: 'f'.repeat(64),
  });
  await expect(
    resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping),
  ).resolves.toMatchObject(f.input.folderBinding!);
});

it('permits the same explicitly sourced image for multiple two-tier slots without borrowing another slot by ordinal', async () => {
  const f = selectedImagesFixture();
  (f.mapping.document.slots[0] as any).variationImageCandidates = [f.a];
  (f.mapping as any).imageSelections['slot-b'] = { sku: 'B', path: f.a.path, sha256: f.a.sha256 };
  f.input.variants[0].imageId = f.input.coverId;
  await expect(
    resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping),
  ).resolves.toMatchObject(f.input.folderBinding!);
});

it('keeps the legacy claim fingerprint when optional unselected candidates are retained by the new parser', async () => {
  const f = fixture(),
    before = await resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping);
  (f.mapping.document.slots[1] as any).variationImageCandidates = [
    {
      path: 'ảnh.png',
      sha256: 'd'.repeat(64),
      role: 'variation',
      familyMatchesSource: true,
    },
  ];
  const after = await resolvePendingSourceClaim(f.repo, f.input, f.batch, f.mapping);
  expect(after.fingerprint).toBe(before.fingerprint);
});
