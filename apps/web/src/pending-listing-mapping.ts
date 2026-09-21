import type { CatalogRow } from '@shopee/domain';
import {
  pendingListingMappingSchema,
  pendingListingWorksheetSchema,
  isMissingPendingSku,
  pendingSelectedVariationImage,
  type PendingVariationImageCandidate,
  resolvePendingMappingRows,
  type PendingListingMapping,
} from '../../../packages/domain/src/pending-listing-mapping.js';
import { resolveListingInput, type ListingInputResult } from './listing-input.js';
import type { FolderGroup, UploadedFolderFile } from './folder-source.js';

export type PendingPriceSource = {
  importId: string;
  sheet: string;
  priceProfile: string | null;
  rows: CatalogRow[];
};

export function readPendingListingMapping(
  text: string,
  file: { relativePath: string; sha256: string },
): PendingListingMapping {
  if (text.length > 5_000_000) throw new Error('PENDING_WORKSHEET_TOO_LARGE');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('PENDING_WORKSHEET_INVALID');
  }
  const parsed = pendingListingWorksheetSchema.safeParse(raw);
  if (!parsed.success) throw new Error('PENDING_WORKSHEET_INVALID');
  return pendingListingMappingSchema.parse({
    version: 1,
    ...file,
    document: parsed.data,
    skuEdits: {},
    structureConfirmed: parsed.data.slots.every((s) => s.membershipConfirmed),
  });
}

export function pendingSlotSku(mapping: PendingListingMapping, slotId: string): string | null {
  const slot = mapping.document.slots.find((s) => s.slotId === slotId);
  if (!slot) throw new Error('PENDING_SLOT_UNKNOWN');
  return Object.hasOwn(mapping.skuEdits, slotId) ? mapping.skuEdits[slotId]! : slot.sku;
}

export function updatePendingSku(
  mapping: PendingListingMapping,
  slotId: string,
  sku: string,
): PendingListingMapping {
  if (!mapping.document.slots.some((s) => s.slotId === slotId))
    throw new Error('PENDING_SLOT_UNKNOWN');
  return pendingListingMappingSchema.parse({
    ...mapping,
    skuEdits: { ...mapping.skuEdits, [slotId]: sku === '' ? null : sku },
    ...(pendingSlotSku(mapping, slotId) !== sku
      ? { imageSelections: { ...mapping.imageSelections, [slotId]: null } }
      : {}),
  });
}

export function resolvePendingListingMapping(
  mapping: PendingListingMapping,
  source?: PendingPriceSource,
  images?: PendingImageContext,
): ListingInputResult {
  const resolved = resolvePendingMappingRows(mapping, source);
  if (resolved.issues.length || !source) return resolved;
  const doc = mapping.document;
  const skus = doc.slots.map((s) => pendingSlotSku(mapping, s.slotId));
  const result = resolveListingInput(
    {
      productKey: doc.product.productKey,
      importId: source.importId,
      sheet: source.sheet,
      priceProfile: source.priceProfile,
      tierCount: doc.tiers.length as 0 | 1 | 2,
      tierNames: doc.tiers.map((t) => t.literalHeading),
      membership: doc.slots.map((s, i) => [skus[i]!, ...s.optionLabels].join('\t')).join('\n'),
    },
    source.rows,
  );
  if (result.seed) {
    result.seed.sourceListingId = doc.sourceListingId;
    result.seed.title = doc.title;
    for (const [index, slot] of doc.slots.entries()) {
      const selected = pendingSelectedVariationImage(mapping, slot.slotId);
      if (!selected) continue;
      const choice = pendingImageChoices(mapping, slot.slotId, images).find(
        (entry) =>
          entry.candidate.path === selected.path && entry.candidate.sha256 === selected.sha256,
      );
      if (!choice?.importId || choice.issue) {
        result.issues.push({
          code: 'PENDING_SOURCE_IMAGE_INVALID',
          line: index + 1,
          message: `Ảnh phân loại “${slot.optionLabels.join(' / ')}” thiếu, đã đổi hoặc chưa đọc xong. Kiểm tra ảnh đã chọn trong bảng.`,
        });
        continue;
      }
      const row = result.rows.find(
        (entry) => entry.line === index + 1 && entry.sku === selected.sku,
      );
      const variant =
        row &&
        result.seed.variants.find(
          (entry) =>
            entry.rowKey === row.row.key &&
            entry.importId === source.importId &&
            JSON.stringify(entry.optionLabels) === JSON.stringify(slot.optionLabels),
        );
      if (!variant) {
        result.issues.push({
          code: 'PENDING_SOURCE_IMAGE_INVALID',
          line: index + 1,
          message: 'Ảnh chưa khớp đúng SKU và phân loại đang chọn.',
        });
      } else if (!variant.imageId) variant.imageId = choice.importId;
    }
    if (result.issues.length) delete result.seed;
  }
  return result;
}

export type PendingImageContext = { group: FolderGroup; files: UploadedFolderFile[] };
export type PendingImageChoice = {
  candidate: PendingVariationImageCandidate;
  importId?: string;
  issue?: string;
};

/** Names identify a whole source template only; they never establish SKU membership. */
export function pendingImageDesign(candidate: PendingVariationImageCandidate): string | undefined {
  return (
    candidate.path.match(/(?:^|\/)(C\d{2})(?:\/|$)/i)?.[1]?.toUpperCase() ?? candidate.designId
  );
}

export function pendingImageChoices(
  mapping: PendingListingMapping,
  slotId: string,
  images?: PendingImageContext,
): PendingImageChoice[] {
  const slot = mapping.document.slots.find((entry) => entry.slotId === slotId);
  if (!slot) throw new Error('PENDING_SLOT_UNKNOWN');
  const sku = pendingSlotSku(mapping, slotId);
  return (slot.variationImageCandidates ?? []).map((candidate) => {
    const fail = (issue: string): PendingImageChoice => ({ candidate, issue });
    if (isMissingPendingSku(sku)) return fail('Cần SKU thật trước khi chọn ảnh.');
    if (sku !== slot.sku)
      return fail('SKU đã đổi; cần đối chiếu lại ảnh cho SKU mới trong màn hoàn thiện.');
    if (!candidate.familyMatchesSource || candidate.role !== 'variation')
      return fail('Ảnh chưa khớp dòng sản phẩm.');
    if (!images || mapping.relativePath !== images.group.key + '/listing-mapping.pending.json')
      return fail('Chưa nhận đủ tệp của đúng thư mục này.');
    const relativePath = images.group.key + '/' + candidate.path;
    const matches = images.files.filter((file) => file.relativePath === relativePath);
    const file = matches[0];
    if (
      matches.length !== 1 ||
      !images.group.files.some((entry) => entry.relativePath === relativePath) ||
      file?.sha256 !== candidate.sha256 ||
      file.record?.sha256 !== candidate.sha256
    )
      return fail('Tệp ảnh thiếu hoặc đã đổi so với hồ sơ.');
    if (file.record.kind !== 'image' || file.record.status !== 'ready')
      return fail('Ảnh chưa đọc xong hoặc không phải tệp ảnh.');
    return { candidate, importId: file.record.id };
  });
}

export function selectPendingImage(
  mapping: PendingListingMapping,
  slotId: string,
  path: string,
  images?: PendingImageContext,
): PendingListingMapping {
  const sku = pendingSlotSku(mapping, slotId);
  const choice = path
    ? pendingImageChoices(mapping, slotId, images).find((entry) => entry.candidate.path === path)
    : undefined;
  if (path && (!choice?.importId || choice.issue || !sku))
    throw new Error('PENDING_SOURCE_IMAGE_INVALID');
  return pendingListingMappingSchema.parse({
    ...mapping,
    imageSelections: {
      ...mapping.imageSelections,
      [slotId]: choice
        ? { path: choice.candidate.path, sha256: choice.candidate.sha256, sku }
        : null,
    },
  });
}

/** Explicit bulk action fills empty slots only, from exactly one validated candidate. */
export function applyPendingImageChoices(
  mapping: PendingListingMapping,
  images: PendingImageContext,
  design?: string,
): PendingListingMapping {
  let next = mapping;
  for (const slot of mapping.document.slots) {
    if (pendingSelectedVariationImage(next, slot.slotId)) continue;
    const choices = pendingImageChoices(next, slot.slotId, images).filter(
      (entry) =>
        entry.importId &&
        !entry.issue &&
        (!design || pendingImageDesign(entry.candidate) === design),
    );
    if (choices.length === 1)
      next = selectPendingImage(next, slot.slotId, choices[0]!.candidate.path, images);
  }
  return next;
}
