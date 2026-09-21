import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assembleFolderListing,
  type FolderAssemblyInput,
} from '../../apps/web/src/folder-source.js';
import { createFolderReader } from '../../apps/web/src/folder-reader.js';
import { compileDescription } from '../../packages/domain/src/source/normalize.js';
import { folderManifestSchema } from '../../packages/domain/src/folder-manifest.js';
import { inputBatchSave } from '../../apps/api/src/input-service.js';

const h = 'a'.repeat(64),
  ph = 'b'.repeat(64);
const source = {
  kind: 'product_file' as const,
  fileSha256: ph,
  locator: 'Prices!A2',
  observedAt: '2026-09-16T00:00:00Z',
};
const fact = (value: string) => ({ value, confirmed: true, sources: [source] });
export function sidecarFixture(tiers = 1) {
  const variants =
    tiers === 0
      ? [{ sku: 'SKU-0', optionLabels: [] }]
      : tiers === 1
        ? [
            { sku: 'SKU-300', optionLabels: ['300ml'] },
            { sku: 'SKU-100', optionLabels: ['100ml'] },
          ]
        : [
            { sku: 'SKU-300', optionLabels: ['Lài', '300ml'] },
            { sku: 'SKU-100', optionLabels: ['Trà', '100ml'] },
          ];
  const manifest: any = {
    format: 'listing-source',
    version: 1,
    product: { productKey: 'saved-source', sourceRevision: 0 },
    sourceListingId: { value: null, source: { fileSha256: ph, locator: 'Catalog!C4' } },
    word: {
      path: 'content.docx',
      sha256: h,
      title: { start: 1, end: 1 },
      headline: { start: 2, end: 2 },
      body: { start: 3, end: 3 },
      paragraphSeparator: '\n',
    },
    priceSource: { sha256: ph, sheet: 'Prices', priceProfile: 'SHOP MALL' },
    media: {
      cover: { path: 'cover.png', sha256: h },
      gallery: [{ path: 'g.png', sha256: h }],
      description: [],
    },
    tierNames: tiers === 0 ? [] : tiers === 1 ? ['Dung tích'] : ['Hương', 'Dung tích'],
    variants,
  };
  const names = ['content.docx', 'cover.png', 'g.png'];
  const records = names.map((name, i) => ({
    relativePath: 'One/' + name,
    sha256: h,
    record: {
      id: 'import-' + i,
      filename: name,
      sha256: h,
      kind: i === 0 ? 'docx' : 'image',
      status: 'ready',
      bytes: 10,
      createdAt: '',
      message: '',
      body: i === 0 ? { paragraphs: ['Title', 'Headline', 'Body'], source } : { source, sha256: h },
    },
  }));
  const input: any = {
    group: {
      key: 'One',
      name: 'One',
      files: names.map((name) => ({ name, relativePath: 'One/' + name, size: 10 })),
    },
    files: records,
    priceSource: {
      importId: 'prices',
      sheet: 'Prices',
      priceProfile: 'SHOP MALL',
      sha256: ph,
      rows: variants.map((v: any, i: number) => ({
        key: 'row-' + i,
        sheet: 'Prices',
        row: i + 2,
        headerRow: 1,
        priceProfile: 'SHOP MALL',
        sku: fact(v.sku),
        name: fact('Product'),
        originalPrice: fact(String(100 + i)),
        issues: [],
      })),
    },
    rules: {},
    productKey: 'input-reserved',
    manifest,
  };
  return { input: input as FolderAssemblyInput, manifest };
}
describe('prepared folder sidecar', () => {
  it('keeps a portable new source identity when the same folder enters a different intake', async () => {
    const { input } = sidecarFixture();
    input.productKey = 'intake-first-reserved';
    const first = await assembleFolderListing(input);
    const secondInput = structuredClone(input);
    secondInput.productKey = 'intake-second-reserved';
    const second = await assembleFolderListing(secondInput);
    expect(first.seed).toBeDefined();
    expect(second.seed).toBeDefined();
    expect(second.seed?.productKey).toBe(first.seed?.productKey);
  });
  it('uses an explicitly selected price profile only when the sidecar defers that choice', async () => {
    const { input, manifest } = sidecarFixture();
    manifest.priceSource.priceProfile = null;
    manifest.priceSource.selectionMode = 'operator_choice';
    expect(folderManifestSchema.safeParse(manifest).success).toBe(true);
    input.priceSource.rows = ['SHOP THƯỜNG', 'SHOP MALL'].flatMap((profile) =>
      input.priceSource.rows.map((row, i) => ({
        ...row,
        key: profile + ':' + i,
        priceProfile: profile,
        originalPrice: fact(String((profile === 'SHOP MALL' ? 500 : 200) + i)),
      })),
    );
    for (const selected of ['SHOP THƯỜNG', 'SHOP MALL']) {
      input.priceSource.priceProfile = selected;
      const result = await assembleFolderListing(input);
      expect(result.seed?.variants).toHaveLength(2);
      expect(result.seed?.variants[0].rowKey).toBe(selected + ':0');
    }
    input.priceSource.priceProfile = null;
    const undecided = await assembleFolderListing(input);
    expect(undecided.seed).toBeUndefined();
    expect(undecided.issues.some((i) => i.code === 'FOLDER_MANIFEST_PRICE_CHOICE_REQUIRED')).toBe(
      true,
    );
    input.priceSource.priceProfile = 'SHOP MALL';
    input.priceSource.sha256 = 'c'.repeat(64);
    expect((await assembleFolderListing(input)).seed).toBeUndefined();
    manifest.priceSource.priceProfile = 'SHOP MALL';
    expect(folderManifestSchema.safeParse(manifest).success).toBe(false);
  });
  it('retains the exact unnamed-profile requirement for legacy null without selectionMode', async () => {
    const { input, manifest } = sidecarFixture();
    manifest.priceSource.priceProfile = null;
    expect((await assembleFolderListing(input)).seed).toBeUndefined();
    input.priceSource.priceProfile = null;
    input.priceSource.rows.forEach((r) => {
      delete r.priceProfile;
    });
    expect((await assembleFolderListing(input)).seed?.variants).toHaveLength(2);
  });
  it.each([0, 1, 2])(
    'uses exact %s-tier source membership without asking for re-entry',
    async (tiers) => {
      const { input, manifest } = sidecarFixture(tiers);
      const a = await assembleFolderListing(input);
      expect(a.seed?.tierNames).toEqual(manifest.tierNames);
      expect(a.seed?.variants.map((v) => v.optionLabels)).toEqual(
        manifest.variants.map((v: any) => v.optionLabels),
      );
      expect(a.seed?.sourceListingId).toBeNull();
      expect(a.seed).not.toHaveProperty('stocks');
    },
  );
  it('reads listing-source.json locally without uploading executable or arbitrary JSON', async () => {
    const { manifest } = sidecarFixture();
    let calls = 0;
    const file = new File([JSON.stringify(manifest)], 'listing-source.json');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'One/listing-source.json' });
    const output = await createFolderReader({
      request: async () => {
        calls++;
        throw Error('Unexpected HTTP');
      },
    })([file]);
    expect((output[0] as any).manifest).toEqual(manifest);
    expect(calls).toBe(0);
    expect(output[0].sha256).toBe(
      createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    );
  });
  it.each(['path', 'duplicate-sku', 'duplicate-combination', 'commands'])(
    'blocks invalid manifest %s',
    async (reason) => {
      const { input, manifest } = sidecarFixture();
      if (reason === 'path') manifest.word.path = '../another/content.docx';
      if (reason === 'duplicate-sku') manifest.variants[1].sku = manifest.variants[0].sku;
      if (reason === 'duplicate-combination')
        manifest.variants[1].optionLabels = manifest.variants[0].optionLabels;
      if (reason === 'commands') manifest.commands = ['publish'];
      expect(folderManifestSchema.safeParse(manifest).success).toBe(false);
      const a = await assembleFolderListing(input);
      expect(a.seed).toBeUndefined();
      expect(a.issues.some((i) => i.code === 'FOLDER_MANIFEST_INVALID')).toBe(true);
    },
  );
  it.each(['hash', 'price-hash', 'profile', 'missing-file'])(
    'blocks wrong %s without guessing a replacement',
    async (reason) => {
      const { input } = sidecarFixture();
      if (reason === 'hash') input.files[0].sha256 = 'c'.repeat(64);
      if (reason === 'price-hash') input.priceSource.sha256 = 'c'.repeat(64);
      if (reason === 'profile') input.priceSource.priceProfile = null;
      if (reason === 'missing-file') input.files.pop();
      const a = await assembleFolderListing(input);
      expect(a.seed).toBeUndefined();
      expect(a.issues.some((i) => i.code.startsWith('FOLDER_MANIFEST_'))).toBe(true);
    },
  );
  it('only reopens the exact saved revision with matching content, order, price and image hashes', async () => {
    const { input, manifest } = sidecarFixture();
    const initial = await assembleFolderListing(input),
      seed = initial.seed!;
    manifest.product.sourceRevision = 1;
    const saved: any = {
      sourceListingId: { value: null, confirmed: true, sources: [source] },
      productKey: 'saved-source',
      revision: 1,
      title: fact(seed.title),
      description: compileDescription(seed.headline, seed.body, seed.descriptionImageIds),
      coverKey: seed.coverId,
      galleryKeys: seed.galleryIds,
      tierNames: seed.tierNames,
      variants: seed.variants.map((v) => {
        const row = input.priceSource.rows.find((r) => r.key === v.rowKey)!;
        return {
          key: v.rowKey,
          sku: row.sku,
          optionLabels: v.optionLabels,
          originalPrice: row.originalPrice,
        };
      }),
      assets: input.files
        .filter((f) => f.record?.kind === 'image')
        .map((f) => ({ key: f.record!.id, sha256: f.sha256 })),
      attributes: {},
      logistics: {},
      issues: [],
    };
    input.savedProducts = [saved];
    const exact = await assembleFolderListing(input);
    expect(exact.seed).toBeUndefined();
    expect(exact.existingProductKey).toBe('saved-source');
    input.savedProducts = [structuredClone(saved)];
    delete input.savedProducts[0].sourceListingId;
    expect((await assembleFolderListing(input)).existingProductKey).toBe('saved-source');
    manifest.sourceListingId.value = '123456789';
    const withoutTargetEvidence = await assembleFolderListing(input);
    expect(withoutTargetEvidence.existingProductKey).toBeUndefined();
    expect(withoutTargetEvidence.seed).toBeUndefined();
    input.savedProducts = [saved];
    saved.sourceListingId.value = '123456789';
    const withoutManifestEvidence = structuredClone(input);
    delete withoutManifestEvidence.manifest!.sourceListingId;
    expect(
      (await assembleFolderListing(withoutManifestEvidence)).existingProductKey,
    ).toBeUndefined();
    manifest.sourceListingId.value = null;
    saved.sourceListingId.value = null;
    for (const alter of [
      (x: any) => x.revision++,
      (x: any) => (x.title.value = 'Changed'),
      (x: any) => x.variants.reverse(),
      (x: any) => (x.assets[0].sha256 = 'c'.repeat(64)),
    ]) {
      input.savedProducts = [structuredClone(saved)];
      alter(input.savedProducts[0]);
      const result = await assembleFolderListing(input);
      expect(result.seed).toBeUndefined();
      expect(result.existingProductKey).toBeUndefined();
      expect(result.issues.some((i) => i.code === 'FOLDER_MANIFEST_SAVED_SOURCE_MISMATCH')).toBe(
        true,
      );
    }
    input.savedProducts = [];
    const missing = await assembleFolderListing(input);
    expect(missing.seed).toBeUndefined();
    expect(missing.existingProductKey).toBeUndefined();
  });
  it('persists a source manifest only when it belongs to the exact listed sidecar file', () => {
    const { manifest } = sidecarFixture();
    const state: any = {
      version: 1,
      name: 'Source',
      mode: 'single_listing',
      files: [
        {
          relativePath: 'One/listing-source.json',
          name: 'listing-source.json',
          size: 100,
          sha256: h,
        },
      ],
      priceSelection: null,
      visual: {},
      wordPaths: {},
      wordRule: null,
      productKeys: { One: 'input-key' },
      manifests: {
        One: { relativePath: 'Other/listing-source.json', sha256: h, document: manifest },
      },
    };
    expect(
      inputBatchSave.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 0,
        state,
      }).success,
    ).toBe(false);
    state.manifests.One.relativePath = 'One/listing-source.json';
    expect(
      inputBatchSave.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 0,
        state,
      }).success,
    ).toBe(true);
  });
});
