import { describe, expect, it } from 'vitest';
import type { FolderManifest } from '../../packages/domain/src/folder-manifest.js';
import { folderSourceIdentity } from '../../packages/domain/src/folder-source-identity.js';

function source(): FolderManifest {
  return {
    format: 'listing-source',
    version: 1,
    product: { productKey: 'portable-source', sourceRevision: 0 },
    word: {
      path: 'title.docx',
      sha256: 'a'.repeat(64),
      title: { start: 1, end: 1 },
      body: { start: 2, end: 5 },
      paragraphSeparator: '\n',
    },
    priceSource: {
      sha256: 'b'.repeat(64),
      sheet: 'Prices',
      priceProfile: null,
      selectionMode: 'operator_choice',
    },
    media: {
      cover: { path: 'cover.png', sha256: 'c'.repeat(64) },
      gallery: [
        { path: 'one.png', sha256: 'd'.repeat(64) },
        { path: 'two.png', sha256: 'e'.repeat(64) },
      ],
      description: [],
    },
    tierNames: ['Size'],
    variants: [
      { sku: 'A', optionLabels: ['100ml'] },
      { sku: 'B', optionLabels: ['300ml'] },
    ],
  };
}
describe('portable folder source identity', () => {
  it('ignores local aliases but keeps ordered file content and exact source choices', () => {
    const a = source(),
      b = structuredClone(a);
    b.word.path = 'renamed.docx';
    b.media.cover!.path = 'renamed.png';
    b.media.gallery.forEach((f, i) => {
      f.path = `nested/renamed-${i}.png`;
    });
    expect(folderSourceIdentity(a, 'SHOP MALL')).toEqual(folderSourceIdentity(b, 'SHOP MALL'));
    expect(JSON.stringify(folderSourceIdentity(a, 'SHOP MALL'))).not.toContain('.png');
  });
  it.each(['content', 'sku', 'tier', 'order', 'media', 'id', 'price-source'] as const)(
    'retains %s in the source proof',
    (change) => {
      const a = source(),
        b = structuredClone(a);
      if (change === 'content') b.word.body = { start: 2, end: 4 };
      if (change === 'sku') b.variants[0].sku = 'Different';
      if (change === 'tier') b.tierNames[0] = 'Different';
      if (change === 'order') b.variants.reverse();
      if (change === 'media') b.media.gallery.reverse();
      if (change === 'id')
        b.sourceListingId = {
          value: null,
          source: { fileSha256: 'f'.repeat(64), locator: 'Sheet!C2' },
        };
      if (change === 'price-source') b.priceSource.sha256 = 'f'.repeat(64);
      expect(folderSourceIdentity(a, 'SHOP MALL')).not.toEqual(
        folderSourceIdentity(b, 'SHOP MALL'),
      );
    },
  );
  it('retains operator price profile rather than treating a new profile as another listing', () => {
    expect(folderSourceIdentity(source(), 'SHOP MALL')).not.toEqual(
      folderSourceIdentity(source(), 'SHOP THƯỜNG'),
    );
    expect(folderSourceIdentity(source(), 'SHOP MALL').productKey).toBe('portable-source');
  });
});
