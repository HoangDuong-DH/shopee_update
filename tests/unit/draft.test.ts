import { expect, it } from 'vitest';
import { validateDraft } from '../../packages/domain/src/draft.js';
import { fixtureDraft } from '../helpers/fixtures.js';
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
