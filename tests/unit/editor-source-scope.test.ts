import { describe, expect, it } from 'vitest';
import type { ListingDraft } from '@shopee/domain';
import { fixtureDraft } from '../helpers/fixtures.js';
import { deriveDraftSourceImportIds, scopedImageRecords, initialPreparationSelection } from '../../apps/web/src/editor-source-scope.js';
import type { ImportRecord } from '../../apps/web/src/api.js';

const book = '11111111-1111-4111-8111-111111111111';
const cover = '22222222-2222-4222-8222-222222222222';
const description = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
function draft(): ListingDraft {
  const value = fixtureDraft();
  value.coverKey = cover; value.galleryKeys = [cover];
  value.description = [{ type: 'text', text: 'Nguồn nguyên văn' }, { type: 'image', assetKey: description }];
  value.variants = [{ ...value.variants[0]!, imageKey: cover }];
  value.assets = [cover, description, other].map((key, index) => ({
    key, sha256: String(index + 1).repeat(64), bytes: 300, mime: 'image/png', width: 120, height: 120,
    source: { kind: 'product_file', fileSha256: String(index + 1).repeat(64), locator: `Bộ nguồn/ảnh-${index}.png`, observedAt: '2026-10-01T00:00:00Z' },
  }));
  value.sourceSelection = {
    title: value.title.value, headline: 'Nguồn nguyên văn', body: '', coverId: cover, galleryIds: [cover], descriptionImageIds: [description],
    tierNames: value.tierNames, variants: [{ importId: book, rowKey: 'exact-row', optionLabels: value.variants[0]!.optionLabels, imageId: cover }],
  };
  return value;
}
function image(id: string, sha256 = '1'.repeat(64)): ImportRecord {
  return { id, sha256, filename: id + '.png', kind: 'image', status: 'ready', bytes: 300, createdAt: '2026-10-01T00:00:00Z', message: '' };
}

describe('image choices bound to a saved source', () => {
  it('includes actual selected gallery, variant and structured-description sources but excludes unused assets', () => {
    expect(deriveDraftSourceImportIds(draft())?.sort()).toEqual([book, cover, description].sort());
  });
  it('keeps a legacy draft without explicit source selection out of the global image library', () => {
    const value = draft(); delete value.sourceSelection;
    expect(deriveDraftSourceImportIds(value)).toBeNull();
  });
  it('holds selected images lacking file evidence while preserving the draft itself', () => {
    const value = draft(); value.assets = value.assets.filter(asset => asset.key !== description);
    expect(deriveDraftSourceImportIds(value)).toBeNull();
    expect(value.description[1]).toEqual({ type: 'image', assetKey: description });
  });
  it('holds conflicting file evidence and a selected role differing from the stored layout', () => {
    const value = draft(); value.assets[0]!.source.fileSha256 = '9'.repeat(64);
    expect(deriveDraftSourceImportIds(value)).toBeNull();
    const changed = draft(); changed.sourceSelection!.descriptionImageIds = [];
    expect(deriveDraftSourceImportIds(changed)).toBeNull();
  });
  it('never uses ready images from another source or falls back when scope is absent', () => {
    expect(scopedImageRecords([image(cover), image(other)], [cover]).map(value => value.id)).toEqual([cover]);
    expect(scopedImageRecords([image(cover)], null)).toEqual([]);
  });
  it('does not offer an ambiguous import ID or an image whose stored content SHA changed', () => {
    expect(scopedImageRecords([image(cover), image(cover, '2'.repeat(64))], [cover])).toEqual([]);
    expect(scopedImageRecords([{ ...image(cover), body: { sha256: '9'.repeat(64) } }], [cover])).toEqual([]);
  });
});

describe('continuing one exact source into preparation', () => {
  const products = [{ productKey: 'source-a', revision: 3 }];
  it('selects only the explicitly requested current revision', () => {
    expect(initialPreparationSelection(products, 'source-a', 3, false)).toEqual({ state: 'ready', productKey: 'source-a' });
  });
  it.each([
    ['source-a', 2, false, 'changed'], ['missing', 3, false, 'missing'], ['source-a', 3, true, 'held'],
  ] as const)('keeps %s with revision %s separate when an exact continuation is unsafe', (key, revision, active, state) => {
    expect(initialPreparationSelection(products, key, revision, active).state).toBe(state);
  });
});
