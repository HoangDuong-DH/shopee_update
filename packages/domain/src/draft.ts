import type { ListingDraft, Issue } from './contracts.js';
import { parseVnd } from './source/normalize.js';
export function validateDraft(draft: ListingDraft): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, field: string, message: string) =>
    issues.push({ code, field, message, severity: 'block', sources: draft.title.sources });
  if (!draft.title.value.trim()) add('MISSING_TITLE', 'title', 'Chưa chọn tiêu đề.');
  if (!draft.variants.length) add('MISSING_VARIANTS', 'variations', 'Chưa chọn SKU.');
  const keys = new Set(draft.assets.map((a) => a.key));
  const required = [
    draft.coverKey,
    ...draft.galleryKeys,
    ...draft.description.flatMap((b) => (b.type === 'image' ? [b.assetKey] : [])),
    ...draft.variants.flatMap((v) => (v.imageKey ? [v.imageKey] : [])),
  ];
  if (required.some((key) => !key || !keys.has(key)))
    add('MISSING_ASSET', 'gallery', 'Ảnh được chọn chưa có tệp nguồn tương ứng.');
  const skus = new Set<string>(),
    options = new Set<string>();
  for (const v of draft.variants) {
    if (skus.has(v.sku.value))
      add('DUPLICATE_VARIANT_SKU', 'variations', `SKU ${v.sku.value} bị chọn nhiều lần.`);
    skus.add(v.sku.value);
    if (v.optionLabels.length !== draft.tierNames.length || v.optionLabels.some((x) => !x.trim()))
      add('INVALID_TIER_MAPPING', 'variations', `Chưa điền đủ tên phân loại cho ${v.sku.value}.`);
    const identity = JSON.stringify(v.optionLabels);
    if (options.has(identity))
      add('DUPLICATE_OPTION', 'variations', 'Có hai SKU cùng tổ hợp phân loại.');
    options.add(identity);
    try {
      if (BigInt(parseVnd(v.originalPrice.value)) <= 0n) throw new Error();
    } catch {
      add('INVALID_ORIGINAL_PRICE', 'price', `GIÁ GỐC của ${v.sku.value} chưa hợp lệ.`);
    }
  }
  return issues;
}
