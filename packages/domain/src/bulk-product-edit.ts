import { z } from 'zod';
import type { ListingDraft } from './contracts.js';
import { validateDraft } from './draft.js';

/** Server audit metadata, never a product field or a grant to publish. */
export const localBulkEditReceiptSchema = z.object({
  operationId: z.string().uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  previousRevision: z.number().int().positive(),
  recordedAt: z.iso.datetime(),
}).strict();

export const bulkProductEditInput = z.object({
  operationId: z.string().uuid(),
  entries: z.array(z.object({ productKey: z.string().min(1).max(500), expectedRevision: z.number().int().positive(),
    removeVariantKeys: z.array(z.string().min(1)).max(2000).default([]) }).strict()).min(1).max(80),
  removeVolumesMl: z.array(z.number().finite().positive().max(1_000_000)).max(30).default([]),
  sortVolumeDescending: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.entries.map(entry => entry.productKey)).size !== value.entries.length)
    ctx.addIssue({ code: 'custom', message: 'Không chọn trùng bộ nguồn.' });
});
export type BulkProductEditInput = z.infer<typeof bulkProductEditInput>;
export type BulkEditIssue = { code: string; message: string };

export function explicitVolumesMl(labels: string[]): number[] {
  // Only quantities with units in option labels; never infer from SKU digits or product names.
  return [...labels.join(' ').toLocaleLowerCase('vi-VN').matchAll(/(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(ml|lít|lit|l)(?![\p{L}])/gu)]
    .map(match => Number(match[1]!.replace(',', '.')) * (match[2] === 'ml' ? 1 : 1000));
}

export function previewBulkProductEdit(draft: ListingDraft, entry: BulkProductEditInput['entries'][number], input: BulkProductEditInput) {
  const issues: BulkEditIssue[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });
  if (draft.productKey !== entry.productKey || draft.revision !== entry.expectedRevision)
    add('PRODUCT_REVISION_CONFLICT', 'Nguồn đã có bản mới. Đọc lại rồi xem trước thay đổi; phần lựa chọn hiện tại được giữ.');
  const keys = new Set(draft.variants.map(variant => variant.key));
  if (keys.size !== draft.variants.length) add('BULK_EDIT_AMBIGUOUS_KEY', 'Có mã dòng phân loại bị trùng; cần xác định đúng nguồn trước khi sửa hàng loạt.');
  if (entry.removeVariantKeys.some(key => !keys.has(key))) add('BULK_EDIT_VARIANT_NOT_FOUND', 'Một phân loại được chọn bỏ không còn thuộc phiên bản nguồn này.');
  const selected = draft.sourceSelection;
  if (!selected || selected.variants.length !== draft.variants.length || selected.variants.some((source, index) => {
    const variant = draft.variants[index]!;
    return source.rowKey !== variant.key || JSON.stringify(source.optionLabels) !== JSON.stringify(variant.optionLabels)
      || (source.imageId ?? '') !== (variant.imageKey ?? '');
  })) add('BULK_EDIT_SOURCE_MAPPING_REQUIRED', 'Liên kết từng phân loại với dòng giá và ảnh chưa đầy đủ. Mở bộ nguồn để kiểm tra trước.');
  const removed = draft.variants.filter(variant => entry.removeVariantKeys.includes(variant.key)
    || explicitVolumesMl(variant.optionLabels).some(volume => input.removeVolumesMl.includes(volume)));
  const removedKeys = new Set(removed.map(variant => variant.key));
  const keep = draft.variants.map((variant, index) => ({ variant, index })).filter(value => !removedKeys.has(value.variant.key));
  if (!keep.length) add('BULK_EDIT_EMPTY_VARIANTS', 'Thao tác này sẽ bỏ hết phân loại. Giữ lại ít nhất một phân loại.');
  if (input.sortVolumeDescending) keep.sort((a, b) => {
    const av = explicitVolumesMl(a.variant.optionLabels), bv = explicitVolumesMl(b.variant.optionLabels);
    const volume = Math.max(0, ...bv) - Math.max(0, ...av);
    // Same primary volume: single option first, then combos; retain original ordering on ties.
    const combo = (value: typeof a, volumes: number[]) => volumes.length > 1 || /combo|bộ\s*[2-9]|cặp|\+|tặng|[x×]\s*[2-9]|[2-9]\s*(?:chai|lọ)/iu.test(value.variant.optionLabels.join(' ')) ? 1 : 0;
    return volume || combo(a, av) - combo(b, bv) || a.index - b.index;
  });
  const changed = removed.length > 0 || keep.some((value, index) => value.index !== index);
  const after = structuredClone(draft);
  after.variants = keep.map(value => structuredClone(value.variant));
  if (selected) after.sourceSelection!.variants = keep.map(value => structuredClone(selected.variants[value.index]!));
  after.revision = draft.revision + (changed ? 1 : 0);
  const options = draft.tierNames.map((_name, index) => [...new Set(after.variants.map(variant => variant.optionLabels[index]!))]);
  if (draft.tierNames.length === 2 && options.reduce((count, values) => count * values.length, 1) !== keep.length)
    add('BULK_EDIT_INCOMPLETE_GRID', 'Bỏ riêng lựa chọn này làm thiếu tổ hợp của hai tầng phân loại. Chọn bỏ trọn một dung tích hoặc kiểm tra cấu trúc trước.');
  const signature = (issue: ListingDraft['issues'][number]) => JSON.stringify([issue.code, issue.field, issue.message]);
  const previousValidation = new Set(validateDraft(draft).map(signature));
  after.issues = [...draft.issues.filter(issue => !previousValidation.has(signature(issue))), ...validateDraft(after)];
  return { after, changed, issues, removed, options,
    models: after.variants.map(variant => ({ key: variant.key, sku: variant.sku.value, labels: variant.optionLabels,
      tierIndex: variant.optionLabels.map((label, index) => options[index]!.indexOf(label)),
      price: variant.originalPrice.value, imageKey: variant.imageKey,
      priceSources: variant.originalPrice.sources, skuSources: variant.sku.sources })),
    warnings: input.sortVolumeDescending && keep.some(value => !explicitVolumesMl(value.variant.optionLabels).length)
      ? ['Phân loại không ghi dung tích được giữ thứ tự tương đối và xếp cuối; không suy đoán dung tích từ SKU.'] : [],
  };
}
