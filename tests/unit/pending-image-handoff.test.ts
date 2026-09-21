import { describe, expect, it } from 'vitest';
import {
  applyPendingImageChoices,
  pendingImageChoices,
  readPendingListingMapping,
  resolvePendingListingMapping,
  selectPendingImage,
  updatePendingSku,
  type PendingImageContext,
} from '../../apps/web/src/pending-listing-mapping.js';
import { pendingListingMappingSchema } from '../../packages/domain/src/pending-listing-mapping.js';
import { pendingWorksheet, pendingPriceSource } from '../helpers/pending-listing-fixture.js';

function setup(shared = false, ambiguous = false) {
  const doc: any = pendingWorksheet();
  doc.slots[0].sku = 'B';
  const group = { key: 'A', name: 'A', files: [] as any[] };
  const files: any[] = [];
  for (const [i, slot] of doc.slots.entries()) {
    const path = shared
      ? 'Anh/C01/phan-loai-02.png'
      : `Anh/C01/phan-loai-${i === 0 ? '02' : '01'}.png`;
    const sha256 = (shared || i === 0 ? 'd' : 'e').repeat(64);
    slot.variationImageCandidates = [
      { path, sha256, role: 'variation', familyMatchesSource: true, designId: 'design-one' },
    ];
    if (ambiguous)
      slot.variationImageCandidates.push({
        ...slot.variationImageCandidates[0],
        path: path.replace('C01', 'C02'),
        sha256: 'f'.repeat(64),
        designId: 'design-two',
      });
    for (const candidate of slot.variationImageCandidates) {
      const relativePath = 'A/' + candidate.path;
      if (files.some((f) => f.relativePath === relativePath)) continue;
      group.files.push({ relativePath, name: candidate.path.split('/').at(-1), size: 42 });
      files.push({
        relativePath,
        sha256: candidate.sha256,
        record: {
          id: 'image-' + files.length,
          sha256: candidate.sha256,
          kind: 'image',
          status: 'ready',
        },
      });
    }
  }
  const mapping = readPendingListingMapping(JSON.stringify(doc), {
    relativePath: 'A/listing-mapping.pending.json',
    sha256: 'a'.repeat(64),
  });
  return { mapping, context: { group, files } as PendingImageContext };
}

describe('pending image handoff', () => {
  it('requires a deliberate choice and binds shuffled image filenames by exact slot/SKU, surviving reload', () => {
    const { mapping, context } = setup();
    expect(
      resolvePendingListingMapping(
        { ...mapping, structureConfirmed: true },
        pendingPriceSource(),
        context,
      ).seed?.variants.every((v) => !v.imageId),
    ).toBe(true);
    const selected = applyPendingImageChoices(mapping, context);
    expect(selected.structureConfirmed).toBe(false);
    const restored = pendingListingMappingSchema.parse(
      JSON.parse(JSON.stringify({ ...selected, structureConfirmed: true })),
    );
    const result = resolvePendingListingMapping(restored, pendingPriceSource(), context);
    expect(result.issues).toEqual([]);
    expect(result.seed?.variants.map((v) => [v.rowKey, v.imageId])).toEqual([
      ['row-B', 'image-0'],
      ['row-A', 'image-1'],
    ]);
  });
  it('keeps a source-authorized image for multiple SKU slots without ordinal assignment', () => {
    const { mapping, context } = setup(true);
    for (const slot of mapping.document.slots) {
      const c = slot.variationImageCandidates![0];
      slot.selectedVariationImage = { path: c.path, sha256: c.sha256, sku: slot.sku! };
    }
    const result = resolvePendingListingMapping(
      { ...mapping, structureConfirmed: true },
      pendingPriceSource(),
      context,
    );
    expect(result.seed?.variants.map((v) => v.imageId)).toEqual(['image-0', 'image-0']);
  });
  it('does not choose among C01/C02 until a template is selected, and never overwrites a manual choice', () => {
    const { mapping, context } = setup(false, true);
    expect(applyPendingImageChoices(mapping, context).imageSelections).toBeUndefined();
    const manual = selectPendingImage(
      mapping,
      'slot-b',
      mapping.document.slots[0].variationImageCandidates![1].path,
      context,
    );
    const selected = applyPendingImageChoices(manual, context, 'C01');
    expect(selected.imageSelections?.['slot-b']?.path).toContain('C02');
    expect(selected.imageSelections?.['slot-a']?.path).toContain('C01');
  });
  it.each(['descriptor', 'record', 'pending', 'outside', 'duplicate', 'wrong-family'] as const)(
    'rejects mismatched %s at the seed boundary',
    (fault) => {
      const { mapping, context } = setup();
      const selected = applyPendingImageChoices(mapping, context);
      if (fault === 'descriptor') context.files[0].sha256 = 'f'.repeat(64);
      if (fault === 'record') context.files[0].record!.sha256 = 'f'.repeat(64);
      if (fault === 'pending') context.files[0].record!.status = 'processing' as any;
      if (fault === 'outside') context.group.files = [];
      if (fault === 'duplicate') context.files.push({ ...context.files[0] });
      if (fault === 'wrong-family')
        selected.document.slots[0].variationImageCandidates![0].familyMatchesSource = false;
      expect(
        resolvePendingListingMapping(
          { ...selected, structureConfirmed: true },
          pendingPriceSource(),
          context,
        ).seed,
      ).toBeUndefined();
    },
  );
  it('clears stale source image when SKU is edited; bulk action does not rebind old evidence to a new SKU', () => {
    const { mapping, context } = setup();
    const selected = applyPendingImageChoices(mapping, context);
    const edited = updatePendingSku(selected, 'slot-b', 'CHANGED');
    expect(edited.imageSelections?.['slot-b']).toBeNull();
    expect(applyPendingImageChoices(edited, context).imageSelections?.['slot-b']).toBeNull();
    expect(pendingImageChoices(edited, 'slot-b', context).every((c) => !!c.issue)).toBe(true);
  });
});
