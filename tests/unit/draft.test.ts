import { expect, it } from 'vitest';
import type { ListingDraft, SourceRef, Variant } from '../../packages/domain/src/contracts.js';
import { validateDraft } from '../../packages/domain/src/draft.js';
import { fixtureDraft, source } from '../helpers/fixtures.js';
it('blocks conflicting SKU and missing media references without discarding supplied content', () => {
  const draft = fixtureDraft();
  draft.variants.push({ ...draft.variants[0], key: 'two' });
  const issues = validateDraft(draft);
  expect(issues.map((x) => x.code)).toContain('DUPLICATE_VARIANT_SKU');
  expect(issues.map((x) => x.code)).toContain('MISSING_ASSET');
  expect(draft.description[0]).toEqual({ type: 'text', text: 'Supplied body' });
});
it('keeps square cover and portrait gallery as distinct original assets', () => {
  const d = fixtureDraft();
  d.assets = ['a', 'b'].map((key, i) => ({
    key,
    sha256: key,
    bytes: 100,
    mime: 'image/png',
    width: i ? 768 : 1024,
    height: 1024,
    source: d.title.sources[0],
  }));
  expect(validateDraft(d)).toEqual([]);
});
const ref = (locator: string): SourceRef => ({ ...source, locator });
const cite = <T>(value: T, locator: string) => ({
  value,
  confirmed: true,
  sources: [ref(locator)],
});
const variant = (key: string, sku: string, optionLabels: string[], price = '100'): Variant => ({
  key,
  sku: cite(sku, `sku!${key}`),
  optionLabels,
  originalPrice: cite(price, `price!${key}`),
});
// Every field carries its own provenance so a borrowed citation cannot pass by coincidence.
const sourcedDraft = (): ListingDraft => {
  const draft = fixtureDraft();
  draft.title = cite('Supplied title', 'title!A1');
  draft.assets = ['a', 'b'].map((key) => ({
    key,
    sha256: key,
    bytes: 100,
    mime: 'image/png',
    width: 1024,
    height: 1024,
    source: ref(`asset!${key}`),
  }));
  draft.variants = [variant('one', 'A', ['One'])];
  return draft;
};
const issue = (draft: ListingDraft, code: string) =>
  validateDraft(draft).find((x) => x.code === code);
it('cites the title sources for a missing title', () => {
  const draft = sourcedDraft();
  draft.title = cite('   ', 'title!A1');
  expect(issue(draft, 'MISSING_TITLE')?.sources).toEqual([ref('title!A1')]);
});
it('cites the SKU sources of the variant that repeats a SKU', () => {
  const draft = sourcedDraft();
  draft.variants = [variant('one', 'A', ['One']), variant('two', 'A', ['Two'])];
  expect(issue(draft, 'DUPLICATE_VARIANT_SKU')?.sources).toEqual([ref('sku!two')]);
});
it.each(['', '  ', 'CHƯA CÓ SKU', 'chua_co_sku', 'Chưa-có-SKU'])(
  'keeps missing SKU %j as a sourced blocking issue rather than a sendable code',
  (sku) => {
    const draft = sourcedDraft();
    draft.variants = [variant('one', sku, ['One'])];
    const before = structuredClone(draft);
    const missing = issue(draft, 'MISSING_VARIANT_SKU');
    expect(missing?.severity).toBe('block');
    expect(missing?.sources).toEqual([ref('sku!one')]);
    expect(draft).toEqual(before);
  },
);
it('cites the SKU sources of the variant with an incomplete tier mapping', () => {
  const draft = sourcedDraft();
  draft.variants = [variant('one', 'A', ['One']), variant('two', 'B', [' '])];
  expect(issue(draft, 'INVALID_TIER_MAPPING')?.sources).toEqual([ref('sku!two')]);
});
it('cites the SKU sources of the variant that repeats an option combination', () => {
  const draft = sourcedDraft();
  draft.variants = [variant('one', 'A', ['One']), variant('two', 'B', ['One'])];
  expect(issue(draft, 'DUPLICATE_OPTION')?.sources).toEqual([ref('sku!two')]);
});
it('cites the original price sources of the variant with an invalid price', () => {
  const draft = sourcedDraft();
  draft.variants = [variant('one', 'A', ['One']), variant('two', 'B', ['Two'], '0')];
  expect(issue(draft, 'INVALID_ORIGINAL_PRICE')?.sources).toEqual([ref('price!two')]);
});
it('cites no sources when a selected image has no asset to point at', () => {
  const draft = sourcedDraft();
  draft.galleryKeys = ['a', 'missing'];
  expect(issue(draft, 'MISSING_ASSET')?.sources).toEqual([]);
});
it('cites no sources when no variant was selected', () => {
  const draft = sourcedDraft();
  draft.variants = [];
  expect(issue(draft, 'MISSING_VARIANTS')?.sources).toEqual([]);
});
it('never borrows the title provenance for issues on other fields', () => {
  const draft = sourcedDraft();
  draft.galleryKeys = ['missing'];
  draft.variants = [variant('one', 'A', ['One'], '0'), variant('two', 'A', ['One'])];
  const issues = validateDraft(draft).filter((x) => x.field !== 'title');
  expect(issues.map((x) => x.code).sort()).toEqual([
    'DUPLICATE_OPTION',
    'DUPLICATE_VARIANT_SKU',
    'INVALID_ORIGINAL_PRICE',
    'MISSING_ASSET',
  ]);
  for (const x of issues) expect(x.sources.map((s) => s.locator)).not.toContain('title!A1');
});
