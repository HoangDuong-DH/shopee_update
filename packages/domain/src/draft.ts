import type { ListingDraft, Issue, SourceRef } from './contracts.js';
import { parseVnd } from './source/normalize.js';
import { isMissingPendingSku } from './pending-listing-mapping.js';
export function validateDraft(draft: ListingDraft): Issue[] {
  const issues: Issue[] = [];
  // Each issue cites the provenance of the field it concerns, never a neighbouring fact.
  const add = (code: string, field: string, message: string, sources: SourceRef[]) =>
    issues.push({ code, field, message, severity: 'block', sources: [...sources] });
  if (!draft.title.value.trim())
    add('MISSING_TITLE', 'title', 'Chưa chọn tiêu đề.', draft.title.sources);
  if (!draft.variants.length) add('MISSING_VARIANTS', 'variations', 'Chưa chọn SKU.', []);
  const keys = new Set(draft.assets.map((a) => a.key));
  const required = [
    draft.coverKey,
    ...draft.galleryKeys,
    ...draft.description.flatMap((b) => (b.type === 'image' ? [b.assetKey] : [])),
    ...draft.variants.flatMap((v) => (v.imageKey ? [v.imageKey] : [])),
  ];
  // A dangling reference has no AssetRef whose source could be cited.
  if (required.some((key) => !key || !keys.has(key)))
    add('MISSING_ASSET', 'gallery', 'Ảnh được chọn chưa có tệp nguồn tương ứng.', []);
  const skus = new Set<string>(),
    options = new Set<string>();
  for (const v of draft.variants) {
    if (isMissingPendingSku(v.sku.value))
      add(
        'MISSING_VARIANT_SKU',
        'variations',
        `Phân loại ${v.optionLabels.join(' / ') || 'sản phẩm'} CHƯA CÓ SKU. Bổ sung mã thật khớp bảng giá trước khi chuẩn bị đăng.`,
        v.sku.sources,
      );
    if (skus.has(v.sku.value))
      add(
        'DUPLICATE_VARIANT_SKU',
        'variations',
        `SKU ${v.sku.value} bị chọn nhiều lần.`,
        v.sku.sources,
      );
    skus.add(v.sku.value);
    if (v.optionLabels.length !== draft.tierNames.length || v.optionLabels.some((x) => !x.trim()))
      add(
        'INVALID_TIER_MAPPING',
        'variations',
        `Chưa điền đủ tên phân loại cho ${v.sku.value}.`,
        v.sku.sources,
      );
    const identity = JSON.stringify(v.optionLabels);
    if (options.has(identity))
      add('DUPLICATE_OPTION', 'variations', 'Có hai SKU cùng tổ hợp phân loại.', v.sku.sources);
    options.add(identity);
    try {
      if (BigInt(parseVnd(v.originalPrice.value)) <= 0n) throw new Error();
    } catch {
      add(
        'INVALID_ORIGINAL_PRICE',
        'price',
        `GIÁ GỐC của ${v.sku.value} chưa hợp lệ.`,
        v.originalPrice.sources,
      );
    }
  }
  return issues;
}
