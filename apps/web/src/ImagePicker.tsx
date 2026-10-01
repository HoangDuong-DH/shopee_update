import { useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, ImagePlus, Search, Upload, X } from 'lucide-react';
import { media, type ImportRecord } from './api.js';
import { scopedImageRecords } from './editor-source-scope.js';
import './listing-authoring.css';

export function ImagePicker({
  title,
  description,
  images,
  selectedIds,
  editable,
  single = false,
  onChange,
  onUploadFiles,
  sourceImportIds = null,
}: {
  title: string;
  description?: string;
  images: ImportRecord[];
  selectedIds: string[];
  editable: boolean;
  single?: boolean;
  onChange: (ids: string[]) => void;
  onUploadFiles?: (files: FileList | null) => Promise<void>;
  sourceImportIds?: string[] | null;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null);
  const eligible = scopedImageRecords(images, sourceImportIds);
  const canChoose = editable && sourceImportIds !== null;
  const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLocaleLowerCase('vi');
  const visible = eligible.filter((image) =>
    normalized(image.filename).includes(normalized(query)),
  );
  function closeBrowser() { setBrowsing(false); requestAnimationFrame(() => trigger.current?.focus()); }
  function choose(id: string) {
    if (!canChoose || !eligible.some(image => image.id === id)) return;
    onChange(
      single
        ? [id]
        : selectedIds.includes(id)
          ? selectedIds.filter((value) => value !== id)
          : [...selectedIds, id],
    );
    if (single) closeBrowser();
  }
  function move(index: number, direction: number) {
    if (!canChoose) return;
    const target = index + direction;
    if (target < 0 || target >= selectedIds.length) return;
    const ids = [...selectedIds];
    [ids[index], ids[target]] = [ids[target], ids[index]];
    onChange(ids);
  }
  return (
    <div className={`image-picker${single ? ' image-picker-single' : ''}`}>
      <div className="section-heading">
        <div>
          <h3>{title}</h3>
          {description && <p className="caption">{description}</p>}
        </div>
        {canChoose && (
          <button ref={trigger} type="button" aria-expanded={browsing} onClick={() => {
            if (browsing) closeBrowser(); else { setBrowsing(true); requestAnimationFrame(() => search.current?.focus()); }
          }}>
            <ImagePlus size={16} aria-hidden="true" />{' '}
            {browsing
              ? 'Đóng kho ảnh'
              : single
                ? selectedIds.length
                  ? 'Đổi ảnh'
                  : 'Chọn ảnh'
                : 'Thêm ảnh'}
          </button>
        )}
      </div>
      {editable && sourceImportIds === null && <p className="authoring-source-notice" role="status">Chưa xác định được đúng bộ nguồn. Ảnh hiện có vẫn được giữ; mở lại bộ nguồn và bổ sung tệp có bằng chứng trước khi đổi ảnh.</p>}
      {selectedIds.length ? (
        <ol className="editor-selected-images" aria-label={`Ảnh đã chọn · ${title}`}>
          {selectedIds.map((id, index) => {
            const image = images.find((value) => value.id === id);
            return (
              <li key={id}>
                <img
                  src={media(id)}
                  alt={image?.filename ?? 'Ảnh đã liên kết trong bộ listing'}
                  loading="lazy"
                />
                <span className="image-picker-filename">
                  <strong>{!single && `${index + 1}. `}</strong>
                  {image?.filename ?? 'Ảnh đã liên kết trong bộ listing'}
                </span>
                <a className="text-button" href={media(id)} target="_blank" rel="noopener noreferrer">Xem tệp gốc {single ? '' : index + 1}</a>
                {image ? <details className="image-file-evidence"><summary>Thông tin tệp nguồn</summary><dl>
                  <div><dt>Tệp</dt><dd>{image.filename}</dd></div>
                  <div><dt>Vai trò đang chọn</dt><dd>{title}{!single && ` · vị trí ${index + 1}`}</dd></div>
                  <div><dt>SHA-256</dt><dd><code>{image.sha256}</code></dd></div>
                  <div><dt>Nhận vào ứng dụng</dt><dd>{new Date(image.createdAt).toLocaleString('vi-VN')}</dd></div>
                </dl></details> : <p className="caption">Chưa đọc được thông tin tệp đã liên kết. Ảnh đang giữ nguyên.</p>}
                {canChoose && (
                  <div className="actions">
                    {!single && (
                      <>
                        <button
                          type="button"
                          disabled={index === 0}
                          aria-label={`Đưa ${title.toLocaleLowerCase('vi')} ${index + 1} lên trước`}
                          onClick={() => move(index, -1)}
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <button
                          type="button"
                          disabled={index === selectedIds.length - 1}
                          aria-label={`Đưa ${title.toLocaleLowerCase('vi')} ${index + 1} về sau`}
                          onClick={() => move(index, 1)}
                        >
                          <ChevronRight size={16} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      aria-label={`Bỏ ${title.toLocaleLowerCase('vi')} ${index + 1} khỏi bản nháp`}
                      onClick={() => onChange(selectedIds.filter((value) => value !== id))}
                    >
                      <X size={16} /> Bỏ chọn
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="image-picker-empty">
          <ImagePlus size={28} aria-hidden="true" />
          <p>Chưa chọn {title.toLocaleLowerCase('vi')}.</p>
          {editable && <p className="caption">Chọn đúng tệp đã được chuẩn bị cho vị trí này.</p>}
        </div>
      )}
      {canChoose && browsing && (
        <section
          className="image-picker-browser"
          aria-label={`Chọn tệp cho ${title.toLocaleLowerCase('vi')}`}
          onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeBrowser(); } }}
        >
          <div className="section-heading">
            <div>
              <h4>Chọn tệp cho {title.toLocaleLowerCase('vi')}</h4>
              <p className="caption">
                {single ? 'Chọn một tệp. ' : 'Chọn theo thứ tự muốn hiển thị. '}Tệp được giữ nguyên,
                không cắt hoặc chỉnh sửa ảnh.
              </p>
            </div>
            {onUploadFiles && (
              <label className="upload-button">
                <Upload size={16} aria-hidden="true" /> Tải ảnh từ máy
                <input
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp"
                  aria-label={`Tải tệp cho ${title.toLocaleLowerCase('vi')}`}
                  onChange={(event) => {
                    const files = event.currentTarget.files;
                    void onUploadFiles(files);
                    event.currentTarget.value = '';
                  }}
                />
              </label>
            )}
          </div>
          <label className="image-picker-search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Tìm ảnh theo tên tệp</span>
            <input
              ref={search}
              aria-label={`Tìm tệp cho ${title.toLocaleLowerCase('vi')}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Tìm tên ảnh trong bộ listing…"
            />
          </label>
          <p className="caption">
            {visible.length} ảnh thuộc bộ nguồn đang mở · Bạn chọn rõ vai trò và thứ tự; việc chọn ảnh chưa phải xác nhận nguồn để đăng.
          </p>
          {!visible.length && (
            <p className="empty">
              {eligible.length
                ? 'Không có tệp khớp tên tìm kiếm.'
                : 'Chưa có ảnh đủ thông tin trong bộ nguồn này. Bổ sung đúng tệp gốc để tiếp tục.'}
            </p>
          )}
          <div className="image-picker-grid">
            {visible.map((image) => (
              <button
                type="button"
                className={`image-picker-option${selectedIds.includes(image.id) ? ' selected' : ''}`}
                aria-pressed={selectedIds.includes(image.id)}
                key={image.id}
                onClick={() => choose(image.id)}
              >
                <img src={media(image.id)} alt="" loading="lazy" />
                <span title={image.filename}>{image.filename}</span>
                {selectedIds.includes(image.id) && (
                  <span className="image-picker-check">
                    <Check size={14} />{' '}
                    {single ? 'Đã chọn' : `Số ${selectedIds.indexOf(image.id) + 1}`}
                  </span>
                )}
              </button>
            ))}
          </div>
          <button type="button" onClick={closeBrowser}>
            Xong · {selectedIds.length} ảnh đã chọn
          </button>
        </section>
      )}
    </div>
  );
}
