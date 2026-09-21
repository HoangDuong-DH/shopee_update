export type FolderImageRole = 'cover' | 'content' | 'variant' | 'numbered' | 'draft' | 'unknown';
export type FolderImageName = { role: FolderImageRole; ordinal?: number; reason: string };
export type SuggestedImageRoles = {
  coverPath?: string;
  contentPaths: string[];
  variantPaths: string[];
  warnings: string[];
};
export type NamedImageSelection = {
  coverPath?: string;
  galleryPaths: string[];
  descriptionPaths: string[];
};
const fold = (value: string) => value.normalize('NFKC').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().trim();
const stemOf = (path: string) => fold(path.split(/[\\/]/).at(-1) ?? '')
  .replace(/\.(?:png|jpe?g|webp)$/i, '').trim();
const sequence = (text: string | undefined) => {
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};
const contentMatch = (stem: string) => stem.match(/^(?:(.*?)[\s._-]+)?g[\s_-]*([0-9]+)$/);

// Names are hints about media roles, never authority to assign a file to a SKU.
// Always use the selected relative path: import records may be reused by SHA under another name.
export function classifyFolderImage(relativePath: string): FolderImageName {
  if (!/\.(?:png|jpe?g|webp)$/i.test(relativePath))
    return { role: 'unknown', reason: 'Chưa nhận ra vai trò từ tên tệp.' };
  const stem = stemOf(relativePath);
  if (/^chua[\s._-]+phan[\s._-]+vai[\s._-]+tro(?:[\s._-]|$)/.test(stem))
    return { role: 'unknown', reason: 'Hồ sơ giữ ảnh này ở nhóm chưa xác định vai trò; chọn thủ công sau khi đối chiếu.' };
  const folders = relativePath.split(/[\\/]/).slice(0, -1).map((part) => part.normalize('NFC').toLowerCase());
  const draftToken = /(?:^|[\s._()\[\]-])(?:nhap|draft|backup)(?:$|[\s._()\[\]-])/;
  if (draftToken.test(stem) || folders.some((part) => /(?:^|[\s._()\[\]-])(?:nháp|draft|backup)(?:$|[\s._()\[\]-])/.test(part)) ||
      /(?:[\s._-]+copy(?:[\s._-]*\d+)?|\(\d+\))$/.test(stem))
    return { role: 'draft', reason: 'Tên có dấu hiệu bản nháp hoặc bản sao; chỉ dùng khi bạn tự chọn.' };
  if (/(?:^|[\s._-])(?:anh[\s._-]*)?(?:bia|cover)(?:[\s._-]*\d+)?$/.test(stem) ||
      /^(?:anh[\s._-]+bia|cover)(?:[\s._-]|$)/.test(stem))
    return { role: 'cover', reason: 'Tên có “ảnh bìa”, “anh-bia”, “bia” hoặc “cover”.' };
  const content = contentMatch(stem);
  const contentNumber = sequence(content?.[2]);
  if (content && contentNumber !== undefined)
    return { role: 'content', ordinal: contentNumber, reason: `Ảnh nội dung g${contentNumber}; có thể dùng ở ảnh sản phẩm, mô tả hoặc cả hai.` };
  const variant = stem.match(/(?:^|[\s._-])(?:phan[\s._-]+loai|pl)(?:[\s._-]+([0-9]+))?(?:[\s._-]|$)/);
  if (variant) return { role: 'variant', ...(sequence(variant[1]) !== undefined ? { ordinal: sequence(variant[1]) } : {}), reason: 'Tên ghi ảnh phân loại; cần chọn đúng SKU trong bản nháp.' };
  const variantNumber = /^\d+$/.test(stem) ? sequence(stem) : undefined;
  if (variantNumber !== undefined)
    return { role: 'numbered', ordinal: variantNumber, reason: `Tên chỉ có số ${variantNumber}; chưa rõ là trang nội dung hay ảnh phân loại.` };
  return { role: 'unknown', reason: 'Chưa nhận ra vai trò từ tên tệp; bạn có thể chọn thủ công.' };
}

export function suggestFolderImageRoles(paths: string[]): SuggestedImageRoles {
  const entries = [...new Set(paths)].map((path) => ({ path, hint: classifyFolderImage(path) }));
  const byNumber = (a: typeof entries[number], b: typeof entries[number]) =>
    (a.hint.ordinal ?? 0) - (b.hint.ordinal ?? 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const covers = entries.filter((e) => e.hint.role === 'cover');
  const content = entries.filter((e) => e.hint.role === 'content').sort(byNumber);
  const variants = entries.filter((e) => e.hint.role === 'variant').sort(byNumber);
  const warnings: string[] = [];
  if (covers.length > 1) warnings.push(`Có ${covers.length} ảnh mang tên bìa. Chọn đúng một ảnh; chưa tự chọn bìa.`);
  const numbers = new Map<number, number>();
  for (const e of content) numbers.set(e.hint.ordinal!, (numbers.get(e.hint.ordinal!) ?? 0) + 1);
  const duplicates = [...numbers].filter(([, count]) => count > 1).map(([n]) => `g${n}`);
  const prefixes = new Set(content.map((e) => (contentMatch(stemOf(e.path))?.[1] ?? '')
    .replace(/[\s._-]+/g, ' ').trim()).filter(Boolean));
  if (duplicates.length) warnings.push(`Trùng số ảnh ${duplicates.join(', ')}. Chưa tự ghép ảnh nội dung; chọn đúng bộ ảnh trước.`);
  if (prefixes.size > 1) warnings.push('Ảnh g có nhiều phần tên sản phẩm khác nhau. Chưa tự trộn các bộ; chọn ảnh phù hợp bằng tay.');
  return {
    ...(covers.length === 1 ? { coverPath: covers[0].path } : {}),
    contentPaths: duplicates.length || prefixes.size > 1 ? [] : content.map((e) => e.path),
    variantPaths: variants.map((e) => e.path), warnings,
  };
}

export function fillSuggestedImageRoles(
  current: NamedImageSelection,
  suggestions: SuggestedImageRoles,
  contentRole: 'gallery' | 'description' | 'both',
): NamedImageSelection {
  return {
    ...(current.coverPath ? { coverPath: current.coverPath } : suggestions.coverPath ? { coverPath: suggestions.coverPath } : {}),
    galleryPaths: current.galleryPaths.length ? [...current.galleryPaths]
      : contentRole === 'gallery' || contentRole === 'both' ? [...suggestions.contentPaths] : [],
    descriptionPaths: current.descriptionPaths.length ? [...current.descriptionPaths]
      : contentRole === 'description' || contentRole === 'both' ? [...suggestions.contentPaths] : [],
  };
}
