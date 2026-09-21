import { describe, expect, it } from 'vitest';
import { compareManifestSavedDraft } from '../../apps/web/src/folder-manifest.js';
import { compileDescription } from '../../packages/domain/src/source/normalize.js';

function fixture() {
  const seed: any = {
    title: 'Cam Sả',
    headline: 'Đầu đề',
    body: 'Dòng thứ nhất\n\nDòng thứ hai',
    descriptionImageIds: ['new-image'],
    coverId: undefined,
    galleryIds: [],
    tierNames: [],
    variants: [],
  };
  const saved: any = {
    productKey: 'cam-sa',
    revision: 1,
    title: { value: seed.title },
    description: compileDescription(seed.headline, seed.body, ['old-image']).map((block) =>
      block.type === 'text'
        ? { text: block.text, type: block.type }
        : { assetKey: block.assetKey, type: block.type },
    ),
    assets: [{ key: 'old-image', sha256: 'a'.repeat(64) }],
    galleryKeys: [],
    tierNames: [],
    variants: [],
  };
  const input: any = {
    files: [{ record: { id: 'new-image', sha256: 'a'.repeat(64) } }],
    priceSource: { rows: [] },
  };
  const manifest: any = { product: { productKey: 'cam-sa', sourceRevision: 1 } };
  return { seed, saved, input, manifest };
}

describe('saved folder content after PostgreSQL JSONB round trip', () => {
  it('compares text values and image hashes regardless of object property order', () => {
    const f = fixture();
    expect(compareManifestSavedDraft(f.manifest, f.seed, f.input, f.saved)).toEqual([]);
  });
  it.each(['text', 'line-break', 'image', 'order'])('still rejects changed %s', (change) => {
    const f = fixture();
    if (change === 'text') f.saved.description[0].text += 'x';
    if (change === 'line-break')
      f.saved.description[2].text = f.saved.description[2].text.replace('\n\n', '\n');
    if (change === 'image') f.saved.assets[0].sha256 = 'b'.repeat(64);
    if (change === 'order') f.saved.description.reverse();
    expect(compareManifestSavedDraft(f.manifest, f.seed, f.input, f.saved)).toContain(
      'Nội dung hoặc ảnh mô tả khác bản đã lưu.',
    );
  });
});
