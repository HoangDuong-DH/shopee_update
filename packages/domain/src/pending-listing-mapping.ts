import { z } from 'zod';
import type { CatalogRow } from './contracts.js';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !!v.trim() && !/[\t\r\n\x00]/.test(v));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = text(1024).refine(
  (v) => !/[\\:*?"<>|]/.test(v) && v.split('/').every((p) => p && p !== '.' && p !== '..'),
);
export const pendingVariationImageCandidateSchema = z.object({
  path,
  sha256: hash,
  role: z.literal('variation'),
  familyMatchesSource: z.boolean(),
  designId: text(200).optional(),
  filename: text(1024).optional(),
  visibleFlavor: text(200).optional(),
  visibleSizes: z.array(text(200)).max(20).optional(),
});
export type PendingVariationImageCandidate = z.infer<typeof pendingVariationImageCandidateSchema>;
export const pendingVariationImageSelectionSchema = z
  .object({
    path,
    sha256: hash,
    sku: text(500).refine((v) => !isMissingPendingSku(v)),
  })
  .strict();
export type PendingVariationImageSelection = z.infer<typeof pendingVariationImageSelectionSchema>;
function matchesImageCandidate(
  candidates: PendingVariationImageCandidate[] | undefined,
  selection: PendingVariationImageSelection,
) {
  return (
    candidates?.filter(
      (candidate) =>
        candidate.path === selection.path &&
        candidate.sha256 === selection.sha256 &&
        candidate.role === 'variation' &&
        candidate.familyMatchesSource,
    ).length === 1
  );
}
export function isMissingPendingSku(value: string | null | undefined): boolean {
  if (!value?.trim()) return true;
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f\s_-]/g, '')
      .toUpperCase() === 'CHUACOSKU'
  );
}

// A worksheet is source material, not a sendable listing. Only these known fields
// enter the mapping editor; prices, stock and other source annotations stay in
// the original file identified by its SHA and never become execution defaults.
export const pendingListingWorksheetSchema = z
  .object({
    schemaVersion: z.literal('listing-mapping-pending/v1'),
    sourceKey: text(500),
    product: z
      .object({
        productKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
        sourceRevision: z.literal(0),
      })
      .strict(),
    sourceWorkbookSha256: hash,
    title: text(10000),
    sourceListingId: z
      .string()
      .regex(/^[1-9]\d*$/)
      .refine((v) => Number.isSafeInteger(Number(v)))
      .nullable(),
    sourceListingIdCell: text(1024),
    rawVariationText: z.string().max(50000),
    tiers: z
      .array(
        z.object({
          ordinal: z.number().int().min(1).max(2),
          literalHeading: text(200),
          options: z.array(text(200)).min(1).max(2000),
        }),
      )
      .max(2),
    slots: z
      .array(
        z.object({
          slotId: text(200),
          optionPositions: z.array(z.number().int().min(0)).max(2),
          optionLabels: z.array(text(200)).max(2),
          sku: text(500)
            .refine((v) => !isMissingPendingSku(v))
            .nullable(),
          membershipConfirmed: z.boolean(),
          sourceCell: text(1024),
          status: text(200),
          issues: z.array(z.string().max(2000)).max(100),
          variationImageCandidates: z
            .array(pendingVariationImageCandidateSchema)
            .max(20)
            .optional(),
          // An explicit source choice; the presence of candidates alone never selects an image.
          selectedVariationImage: pendingVariationImageSelectionSchema.optional(),
        }),
      )
      .min(1)
      .max(2000),
    issues: z.array(z.string().max(2000)).max(100),
  })
  .superRefine((doc, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (new Set(doc.slots.map((s) => s.slotId)).size !== doc.slots.length)
      fail('Duplicate source slot');
    if (new Set(doc.slots.map((s) => JSON.stringify(s.optionPositions))).size !== doc.slots.length)
      fail('Duplicate source combination');
    if (new Set(doc.tiers.map((t) => t.literalHeading)).size !== doc.tiers.length)
      fail('Duplicate source tier');
    for (const [index, tier] of doc.tiers.entries()) {
      if (tier.ordinal !== index + 1 || new Set(tier.options).size !== tier.options.length)
        fail('Invalid source tier order');
    }
    for (const slot of doc.slots) {
      const candidates = slot.variationImageCandidates;
      if (
        candidates &&
        new Set(candidates.map((candidate) => candidate.path)).size !== candidates.length
      )
        fail('Duplicate source image candidate path');
      if (
        slot.selectedVariationImage &&
        (slot.selectedVariationImage.sku !== slot.sku ||
          !matchesImageCandidate(candidates, slot.selectedVariationImage))
      )
        fail('Selected source image does not match its exact SKU and candidate');
      if (
        slot.optionPositions.length !== doc.tiers.length ||
        slot.optionLabels.length !== doc.tiers.length ||
        slot.optionLabels.some(
          (label, i) => doc.tiers[i]?.options[slot.optionPositions[i]!] !== label,
        )
      )
        fail('Source slot does not match its exact labels');
    }
    if (!doc.tiers.length && doc.slots.length !== 1) fail('Untiered source requires one slot');
  });
export type PendingListingWorksheet = z.infer<typeof pendingListingWorksheetSchema>;

export const pendingListingMappingSchema = z
  .object({
    version: z.literal(1),
    relativePath: path,
    sha256: hash,
    document: pendingListingWorksheetSchema,
    skuEdits: z.record(
      z.string().min(1).max(200),
      z
        .string()
        .max(500)
        .refine((v) => !/[\t\r\n\x00]/.test(v))
        .nullable(),
    ),
    structureConfirmed: z.boolean(),
    // Missing means use the explicit worksheet choice; null means deliberately cleared.
    // Optional with no default preserves canonical legacy claim data.
    imageSelections: z
      .record(text(200), pendingVariationImageSelectionSchema.nullable())
      .optional(),
  })
  .strict()
  .superRefine((mapping, ctx) => {
    const ids = new Set(mapping.document.slots.map((s) => s.slotId));
    if (Object.keys(mapping.skuEdits).some((id) => !ids.has(id)))
      ctx.addIssue({ code: 'custom', message: 'Unknown source slot edit' });
    if (Object.keys(mapping.imageSelections ?? {}).some((id) => !ids.has(id)))
      ctx.addIssue({ code: 'custom', message: 'Unknown source slot image selection' });
    for (const slot of mapping.document.slots) {
      const selected = Object.hasOwn(mapping.imageSelections ?? {}, slot.slotId)
        ? mapping.imageSelections![slot.slotId]
        : slot.selectedVariationImage;
      const sku = Object.hasOwn(mapping.skuEdits, slot.slotId)
        ? mapping.skuEdits[slot.slotId]
        : slot.sku;
      if (
        selected &&
        (selected.sku !== sku || !matchesImageCandidate(slot.variationImageCandidates, selected))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Selected image does not match the current source slot SKU and candidate',
        });
    }
  });
export type PendingListingMapping = z.infer<typeof pendingListingMappingSchema>;

/** Pure lookup after schema validation; neither candidate order nor design naming grants selection. */
export function pendingSelectedVariationImage(
  mapping: PendingListingMapping,
  slotId: string,
): PendingVariationImageSelection | undefined {
  const slot = mapping.document.slots.find((value) => value.slotId === slotId);
  if (!slot) throw new Error('PENDING_SLOT_UNKNOWN');
  return (
    (Object.hasOwn(mapping.imageSelections ?? {}, slotId)
      ? mapping.imageSelections![slotId]
      : slot.selectedVariationImage) ?? undefined
  );
}

export type PendingMappingIssue = { code: string; message: string; line?: number };
export function resolvePendingMappingRows(
  mapping: PendingListingMapping,
  source?: {
    sheet: string;
    priceProfile: string | null;
    rows: CatalogRow[];
  },
): {
  rows: { line: number; sku: string; optionLabels: string[]; row: CatalogRow }[];
  issues: PendingMappingIssue[];
} {
  const parsed = pendingListingMappingSchema.safeParse(mapping);
  if (!parsed.success)
    return {
      rows: [],
      issues: [{ code: 'PENDING_WORKSHEET_INVALID', message: 'Hồ sơ phân loại chưa hợp lệ.' }],
    };
  const result: ReturnType<typeof resolvePendingMappingRows> = { rows: [], issues: [] };
  if (!mapping.structureConfirmed)
    result.issues.push({
      code: 'PENDING_STRUCTURE_UNCONFIRMED',
      message: 'Chưa xác nhận dùng đủ các phân loại trong bảng này.',
    });
  if (!source)
    result.issues.push({
      code: 'PENDING_PRICE_SOURCE_REQUIRED',
      message: 'Chọn bảng giá, trang tính và bộ giá để đối chiếu.',
    });
  const skus = new Set<string>();
  for (const [index, slot] of mapping.document.slots.entries()) {
    const sku = Object.hasOwn(mapping.skuEdits, slot.slotId)
      ? mapping.skuEdits[slot.slotId]
      : slot.sku;
    const add = (code: string, message: string) =>
      result.issues.push({ code, message, line: index + 1 });
    if (isMissingPendingSku(sku)) {
      add('PENDING_SKU_REQUIRED', 'CHƯA CÓ SKU: cần mã thật khớp bảng giá.');
      continue;
    }
    if (skus.has(sku!)) add('DUPLICATE_SKU', 'Mã SKU đang trùng với một phân loại khác.');
    skus.add(sku!);
    if (!source) continue;
    const matches = source.rows.filter(
      (r) =>
        r.sku.value === sku &&
        r.sheet === source.sheet &&
        (r.priceProfile ?? null) === source.priceProfile,
    );
    if (matches.length !== 1) {
      add(
        'PENDING_PRICE_ROW_UNRESOLVED',
        'SKU cần khớp duy nhất một dòng trong trang tính và bộ giá đã chọn.',
      );
      continue;
    }
    const row = matches[0]!;
    result.rows.push({ line: index + 1, sku: sku!, optionLabels: [...slot.optionLabels], row });
    if (
      !row.sku.confirmed ||
      !row.sku.sources.length ||
      !row.originalPrice?.confirmed ||
      !row.originalPrice.sources.length ||
      !/^[1-9]\d*$/.test(row.originalPrice.value)
    )
      add(
        'PENDING_PRICE_REQUIRED',
        'SKU và GIÁ GỐC cần có nguồn xác nhận, giá phải là số đồng nguyên dương.',
      );
    for (const issue of row.issues.filter((i) => i.severity === 'block'))
      add('SOURCE_BLOCKED', issue.message);
  }
  return result;
}
