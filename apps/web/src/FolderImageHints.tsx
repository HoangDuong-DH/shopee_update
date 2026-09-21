import { useMemo, useState } from 'react';
import { classifyFolderImage, fillSuggestedImageRoles, suggestFolderImageRoles,
  type FolderImageRole, type NamedImageSelection } from './folder-image-names.js';
export type ImageRoleFilter = 'all' | FolderImageRole;
export const imageRoleLabel: Record<FolderImageRole, string> = {
  cover: 'Gợi ý bìa', content: 'Gợi ý ảnh nội dung', variant: 'Gợi ý ảnh phân loại',
  numbered: 'Ảnh đánh số · chưa rõ vai trò', draft: 'Nháp / bản sao · cần chọn tay', unknown: 'Chưa rõ vai trò',
};
export function FolderImageHints({ paths, selection, disabled, filter, onFilter, onApply }: {
  paths: string[]; selection: NamedImageSelection; disabled: boolean;
  filter: ImageRoleFilter; onFilter: (filter: ImageRoleFilter) => void;
  onApply: (selection: NamedImageSelection) => void;
}) {
  const [contentRole, setContentRole] = useState<'gallery' | 'description' | 'both'>('both');
  const suggestions = useMemo(() => suggestFolderImageRoles(paths), [paths]);
  const counts = paths.reduce((all, path) => {
    const role = classifyFolderImage(path).role; all[role] = (all[role] ?? 0) + 1; return all;
  }, {} as Partial<Record<FolderImageRole, number>>);
  const filled = fillSuggestedImageRoles(selection, suggestions, contentRole);
  const canFill = filled.coverPath !== selection.coverPath ||
    filled.galleryPaths.join('\0') !== selection.galleryPaths.join('\0') ||
    filled.descriptionPaths.join('\0') !== selection.descriptionPaths.join('\0');
  return <section className="folder-name-hints" aria-label="Nhận biết vai trò theo tên ảnh">
    <h3>Nhận biết theo tên ảnh</h3>
    <p><b>anh-bia / ảnh bìa / cover</b>: bìa. <b>g1…gn</b>, kể cả tên dài kết thúc bằng <b>-g2</b>: ảnh nội dung.
      {' '}<b>phan-loai / pl</b>: ảnh phân loại.</p>
    <p className="caption">Tên chỉ có số như 2.png, 10.png có thể là trang nội dung hoặc ảnh phân loại.
      {' '}Ứng dụng giữ để bạn xác định, không ghép số ảnh vào SKU.</p>
    <div className="folder-name-actions">
      <label>Ảnh g dùng ở
        <select value={contentRole} disabled={disabled} onChange={(e) => setContentRole(e.target.value as typeof contentRole)}>
          <option value="both">Bộ ảnh đầu trang và ảnh mô tả</option>
          <option value="gallery">Chỉ bộ ảnh đầu trang</option>
          <option value="description">Chỉ ảnh mô tả</option>
        </select>
      </label>
      <button type="button" disabled={disabled || !canFill} onClick={() => onApply(filled)}>Điền vị trí trống theo tên</button>
    </div>
    <p className="caption">Giữ các vị trí bạn đã chọn. Ảnh g xếp theo số 1, 2, …, 10; vẫn có thể bỏ chọn hoặc đổi thứ tự.</p>
    <p className="caption">Để gắn ảnh phân loại với từng SKU, mở “Xem và hoàn thiện nội dung” rồi chọn “SKU &amp; phân loại”.</p>
    {suggestions.warnings.map((warning) => <p className="folder-name-warning" key={warning}>{warning}</p>)}
    <div className="folder-name-filters" aria-label="Lọc ảnh theo tên">
      <button type="button" aria-pressed={filter === 'all'} onClick={() => onFilter('all')}>Tất cả {paths.length}</button>
      {(Object.keys(imageRoleLabel) as FolderImageRole[]).filter((role) => counts[role]).map((role) =>
        <button type="button" key={role} aria-pressed={filter === role} onClick={() => onFilter(role)}>{imageRoleLabel[role]} {counts[role]}</button>)}
    </div>
  </section>;
}
