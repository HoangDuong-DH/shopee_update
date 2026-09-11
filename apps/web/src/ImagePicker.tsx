import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, ImagePlus, Search, Upload, X } from 'lucide-react';
import { media, type ImportRecord } from './api.js';

export function ImagePicker({
  title,
  description,
  images,
  selectedIds,
  editable,
  single = false,
  onChange,
  onUploadFiles,
}: {
  title: string;
  description?: string;
  images: ImportRecord[];
  selectedIds: string[];
  editable: boolean;
  single?: boolean;
  onChange: (ids: string[]) => void;
  onUploadFiles?: (files: FileList | null) => Promise<void>;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState('');
  const visible = images.filter((image) =>
    image.filename.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi')),
  );
  function choose(id: string) {
    if (!editable) return;
    onChange(
      single
        ? [id]
        : selectedIds.includes(id)
          ? selectedIds.filter((value) => value !== id)
          : [...selectedIds, id],
    );
    if (single) setBrowsing(false);
  }
  function move(index: number, direction: number) {
    if (!editable) return;
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
        {editable && (
          <button type="button" aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>
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
                {editable && (
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
                      <X size={16} />
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
      {editable && browsing && (
        <section
          className="image-picker-browser"
          aria-label={`Chọn tệp cho ${title.toLocaleLowerCase('vi')}`}
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
              aria-label={`Tìm tệp cho ${title.toLocaleLowerCase('vi')}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Tìm tên ảnh trong bộ listing…"
            />
          </label>
          <p className="caption">
            {visible.length} tệp sẵn sàng trong Tệp nguồn · Chỉ tệp bạn chọn được thêm vào bản nháp
            này.
          </p>
          {!visible.length && (
            <p className="empty">
              {images.length
                ? 'Không có tệp khớp tên tìm kiếm.'
                : 'Chưa có ảnh sẵn sàng. Tải ảnh từ máy để bắt đầu.'}
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
          <button type="button" onClick={() => setBrowsing(false)}>
            Xong · {selectedIds.length} ảnh đã chọn
          </button>
        </section>
      )}
    </div>
  );
}
