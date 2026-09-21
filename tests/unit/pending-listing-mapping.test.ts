import { describe, expect, it } from 'vitest';
import {
  pendingListingMappingSchema,
  pendingListingWorksheetSchema,
} from '../../packages/domain/src/pending-listing-mapping.js';
import {
  readPendingListingMapping,
  resolvePendingListingMapping,
  updatePendingSku,
} from '../../apps/web/src/pending-listing-mapping.js';
import { pendingWorksheet, pendingPriceSource } from '../helpers/pending-listing-fixture.js';

const read = () =>
  readPendingListingMapping(JSON.stringify(pendingWorksheet()), {
    relativePath: 'Nguồn/Bộ A/listing-mapping.pending.json',
    sha256: 'a'.repeat(64),
  });

describe('pending classification intake', () => {
  it('retains exact ordered slots and null SKU without generating combinations or copying worksheet prices', () => {
    const mapping = read();
    expect(mapping.document.slots.map((s) => [s.slotId, s.optionLabels, s.sku])).toEqual([
      ['slot-b', ['Cam Sả (MỚI)', '300ml'], null],
      ['slot-a', ['Hoa Hồng', '100ml'], 'A'],
    ]);
    expect(mapping.document.tiers[0].options).toEqual(['Hoa Hồng', 'Cam Sả (MỚI)']);
    expect(mapping.structureConfirmed).toBe(false);
    expect(mapping.document.slots[0]).not.toHaveProperty('originalPrice');
    expect(resolvePendingListingMapping(mapping, pendingPriceSource()).seed).toBeUndefined();
  });

  it('updates only the selected stable slot and survives durable JSON reload without mixing another source', () => {
    const first = read(),
      second = read();
    second.document.sourceKey = 'other';
    second.document.product.productKey = 'product-b';
    const changed = updatePendingSku(first, 'slot-b', 'B');
    const restored = pendingListingMappingSchema.parse(JSON.parse(JSON.stringify(changed)));
    expect(restored.skuEdits).toEqual({ 'slot-b': 'B' });
    expect(second.skuEdits).toEqual({});
    expect(restored.document).toEqual(first.document);
    expect(() => updatePendingSku(first, 'foreign-slot', 'B')).toThrow('PENDING_SLOT_UNKNOWN');
  });

  it('requires explicit complete table confirmation, then only exact scoped source rows and positive original prices produce a seed', () => {
    let mapping = updatePendingSku(read(), 'slot-b', 'B');
    expect(
      resolvePendingListingMapping(mapping, pendingPriceSource()).issues.map((i) => i.code),
    ).toContain('PENDING_STRUCTURE_UNCONFIRMED');
    mapping = { ...mapping, structureConfirmed: true };
    const result = resolvePendingListingMapping(mapping, pendingPriceSource());
    expect(result.issues).toEqual([]);
    expect(result.seed?.variants.map((v) => [v.rowKey, v.optionLabels])).toEqual([
      ['row-B', ['Cam Sả (MỚI)', '300ml']],
      ['row-A', ['Hoa Hồng', '100ml']],
    ]);
    expect(result.seed?.sourceListingId).toBeNull();
    expect(mapping.document.slots[0].sku).toBeNull();
    const source = pendingPriceSource();
    source.rows[1].originalPrice = undefined;
    expect(resolvePendingListingMapping(mapping, source).seed).toBeUndefined();
    expect(
      resolvePendingListingMapping(mapping, { ...pendingPriceSource(), priceProfile: 'Other' })
        .seed,
    ).toBeUndefined();
  });

  it.each(['', 'CHƯA CÓ SKU', 'CHUA_CO_SKU'])(
    'keeps missing or placeholder %s out of executable draft inputs',
    (sku) => {
      const mapping = { ...updatePendingSku(read(), 'slot-b', sku), structureConfirmed: true };
      const source = pendingPriceSource();
      source.rows[1].sku.value = sku;
      const result = resolvePendingListingMapping(mapping, source);
      expect(result.seed).toBeUndefined();
      expect(result.issues.some((i) => i.code === 'PENDING_SKU_REQUIRED')).toBe(true);
    },
  );

  it('rejects duplicate IDs, label/index mismatch, foreign edits, invalid IDs and an old saved source revision', () => {
    for (const change of [
      (d: any) => {
        d.slots[1].slotId = d.slots[0].slotId;
      },
      (d: any) => {
        d.slots[0].optionLabels[0] = 'Guessed';
      },
      (d: any) => {
        d.sourceListingId = '9007199254740992';
      },
      (d: any) => {
        d.product.sourceRevision = 1;
      },
    ]) {
      const doc = pendingWorksheet();
      change(doc);
      expect(() =>
        readPendingListingMapping(JSON.stringify(doc), {
          relativePath: 'A/listing-mapping.pending.json',
          sha256: 'a'.repeat(64),
        }),
      ).toThrow();
    }
    expect(
      pendingListingMappingSchema.safeParse({ ...read(), skuEdits: { foreign: 'B' } }).success,
    ).toBe(false);
  });
});

function imageWorksheet() {
  const doc: any = pendingWorksheet();
  doc.slots[0].sku = 'B';
  doc.slots[0].variationImageCandidates = [
    {
      path: 'Anh/C01/phan-loai-02.png',
      sha256: 'd'.repeat(64),
      role: 'variation',
      familyMatchesSource: true,
      designId: 'design-one',
    },
  ];
  doc.slots[1].variationImageCandidates = [
    {
      path: 'Anh/C01/phan-loai-01.png',
      sha256: 'e'.repeat(64),
      role: 'variation',
      familyMatchesSource: true,
      designId: 'design-one',
    },
  ];
  for (const slot of doc.slots)
    slot.selectedVariationImage = {
      sku: slot.sku,
      path: slot.variationImageCandidates[0].path,
      sha256: slot.variationImageCandidates[0].sha256,
    };
  return doc;
}

describe('pending source image selection contract', () => {
  it('retains exact explicit slot/SKU selections with shuffled image filenames and strips unrelated hints', () => {
    const doc = imageWorksheet();
    doc.slots[0].variationImageCandidates[0].command = 'never execute';
    const parsed = pendingListingWorksheetSchema.parse(doc);
    expect(parsed.slots.map((s: any) => [s.slotId, s.selectedVariationImage])).toEqual([
      ['slot-b', { sku: 'B', path: 'Anh/C01/phan-loai-02.png', sha256: 'd'.repeat(64) }],
      ['slot-a', { sku: 'A', path: 'Anh/C01/phan-loai-01.png', sha256: 'e'.repeat(64) }],
    ]);
    expect((parsed.slots[0] as any).variationImageCandidates[0]).not.toHaveProperty('command');
  });

  it('never chooses the sole candidate or C01 automatically; old worksheets remain byte-equivalent after parsing', () => {
    const legacy = pendingListingWorksheetSchema.parse(pendingWorksheet());
    expect(pendingListingWorksheetSchema.parse(legacy)).toEqual(legacy);
    expect(
      legacy.slots.every(
        (s) =>
          !Object.hasOwn(s, 'variationImageCandidates') &&
          !Object.hasOwn(s, 'selectedVariationImage'),
      ),
    ).toBe(true);
    const doc = imageWorksheet();
    for (const slot of doc.slots) delete slot.selectedVariationImage;
    doc.slots[0].variationImageCandidates.push({
      ...doc.slots[0].variationImageCandidates[0],
      path: 'Anh/C02/phan-loai-02.png',
      sha256: 'f'.repeat(64),
      designId: 'design-two',
    });
    const parsed = pendingListingWorksheetSchema.parse(doc);
    expect((parsed.slots[0] as any).variationImageCandidates).toHaveLength(2);
    expect(parsed.slots.every((s) => !Object.hasOwn(s, 'selectedVariationImage'))).toBe(true);
  });

  it.each([
    '../escape.png',
    '/absolute.png',
    'C:/outside.png',
    'Anh\\outside.png',
    'Anh/./outside.png',
  ])('rejects candidate path %s', (path) => {
    const doc = imageWorksheet();
    doc.slots[0].variationImageCandidates[0].path = path;
    delete doc.slots[0].selectedVariationImage;
    expect(pendingListingWorksheetSchema.safeParse(doc).success).toBe(false);
  });

  it.each([
    'hash',
    'sku',
    'missing-sku',
    'family',
    'role',
    'duplicate-path',
    'unknown-candidate',
  ] as const)('rejects an explicit source selection with invalid %s', (fault) => {
    const doc = imageWorksheet(),
      slot = doc.slots[0];
    if (fault === 'hash') slot.selectedVariationImage.sha256 = 'f'.repeat(64);
    if (fault === 'sku') slot.selectedVariationImage.sku = 'A';
    if (fault === 'missing-sku') slot.sku = null;
    if (fault === 'family') slot.variationImageCandidates[0].familyMatchesSource = false;
    if (fault === 'role') slot.variationImageCandidates[0].role = 'gallery';
    if (fault === 'duplicate-path')
      slot.variationImageCandidates.push({
        ...slot.variationImageCandidates[0],
        sha256: 'f'.repeat(64),
      });
    if (fault === 'unknown-candidate') slot.selectedVariationImage.path = 'Anh/not-in-source.png';
    expect(pendingListingWorksheetSchema.safeParse(doc).success).toBe(false);
  });

  it('persists explicit overrides per stable slot and rejects stale SKU bindings unless explicitly cleared', () => {
    const raw: any = {
      version: 1,
      relativePath: 'Nguồn/A/listing-mapping.pending.json',
      sha256: 'a'.repeat(64),
      document: imageWorksheet(),
      skuEdits: {},
      structureConfirmed: true,
      imageSelections: { 'slot-b': null },
    };
    const parsed = pendingListingMappingSchema.parse(raw);
    expect((parsed as any).imageSelections).toEqual({ 'slot-b': null });
    expect(
      pendingListingMappingSchema.safeParse({ ...raw, skuEdits: { 'slot-b': 'C' } }).success,
    ).toBe(true);
    expect(
      pendingListingMappingSchema.safeParse({ ...raw, skuEdits: { 'slot-a': 'C' } }).success,
    ).toBe(false);
    expect(
      pendingListingMappingSchema.safeParse({ ...raw, imageSelections: { foreign: null } }).success,
    ).toBe(false);
    expect(
      pendingListingMappingSchema.safeParse({
        ...raw,
        imageSelections: {
          'slot-b': { ...raw.document.slots[0].selectedVariationImage, sku: 'A' },
        },
      }).success,
    ).toBe(false);
  });
});
