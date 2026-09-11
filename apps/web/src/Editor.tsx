import { useState } from 'react';
import type { ListingDraft, SourceSelection, WordImport } from '@shopee/domain';
import { api, media, post, type ImportRecord } from './api.js';
export type EditorSeed = SourceSelection & { productKey?: string; expectedRevision: number };
export function Editor({
  seed,
  imports,
  onSaved,
  onCancel,
}: {
  seed: EditorSeed;
  imports: ImportRecord[];
  onSaved: (d: ListingDraft) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(seed),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [word, setWord] = useState<WordImport | null>(null);
  const images = imports.filter((i) => i.kind === 'image' && i.status === 'ready');
  const update = <K extends keyof EditorSeed>(key: K, value: EditorSeed[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  function toggle(key: 'galleryIds' | 'descriptionImageIds', id: string) {
    update(key, form[key].includes(id) ? form[key].filter((x) => x !== id) : [...form[key], id]);
  }
  function move(key: 'galleryIds' | 'descriptionImageIds', id: string, direction: number) {
    const values = [...form[key]],
      i = values.indexOf(id),
      j = i + direction;
    if (i < 0 || j < 0 || j >= values.length) return;
    [values[i], values[j]] = [values[j], values[i]];
    update(key, values);
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      onSaved(await post<ListingDraft>('/v1/products', form));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadWord(id: string) {
    if (!id) {
      setWord(null);
      return;
    }
    try {
      const r = await api<ImportRecord>('/v1/imports/' + id);
      setWord(r.body as WordImport);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">GHÉP NGUỒN · {form.variants.length} SKU</p>
          <h1>Chuẩn bị listing</h1>
          <p>Chọn nội dung và gán ảnh. Không tự viết lại hoặc chỉnh sửa ảnh.</p>
        </div>
        <div className="actions">
          <button onClick={onCancel}>Quay lại</button>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Đang lưu…' : 'Lưu & xem trước'}
          </button>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <section className="panel">
        <h2>Nội dung đã chuẩn bị</h2>
        <label>
          Đọc nội dung từ Word
          <select defaultValue="" onChange={(e) => void loadWord(e.target.value)}>
            <option value="">Chọn tệp Word để đối chiếu / sao chép</option>
            {imports
              .filter((x) => x.kind === 'docx' && x.status === 'ready')
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.filename}
                </option>
              ))}
          </select>
        </label>
        {word && (
          <details open className="word-source">
            <summary>Các đoạn nguyên bản trong Word</summary>
            {word.paragraphs.map((p, i) => (
              <div key={i}>
                <small>Đoạn {i + 1}</small>
                <pre>{p || '(đoạn trống)'}</pre>
                <div className="actions">
                  <button onClick={() => update('title', p)}>Dùng làm tiêu đề</button>
                  <button onClick={() => update('headline', p)}>Dùng làm câu mở đầu</button>
                  <button onClick={() => update('body', form.body ? form.body + '\n\n' + p : p)}>
                    Thêm vào nội dung
                  </button>
                </div>
              </div>
            ))}
          </details>
        )}
        <label>
          Tiêu đề listing
          <input value={form.title} onChange={(e) => update('title', e.target.value)} />
        </label>
        <label>
          Câu mở đầu content
          <textarea
            rows={2}
            value={form.headline}
            onChange={(e) => update('headline', e.target.value)}
          />
        </label>
        <label>
          Nội dung sau toàn bộ ảnh mô tả
          <textarea rows={10} value={form.body} onChange={(e) => update('body', e.target.value)} />
        </label>
        <p className="caption">
          Câu mở đầu → xuống dòng → tất cả ảnh content theo thứ tự → xuống dòng → phần nội dung còn
          lại.
        </p>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Phân loại</h2>
          <span className="caption">Giá được lấy từ đúng dòng KINI đã chọn.</span>
        </div>
        <label>
          Tên tầng phân loại
          <input
            value={form.tierNames[0] ?? ''}
            onChange={(e) => update('tierNames', [e.target.value])}
          />
        </label>
        {form.variants.map((v, i) => (
          <div className="variant-editor" key={v.rowKey}>
            <span className="number">{i + 1}</span>
            <label>
              Nhãn phân loại
              <input
                aria-label={'Phân loại ' + (i + 1)}
                value={v.optionLabels[0] ?? ''}
                onChange={(e) =>
                  update(
                    'variants',
                    form.variants.map((x, n) =>
                      n === i ? { ...x, optionLabels: [e.target.value] } : x,
                    ),
                  )
                }
              />
            </label>
            <label>
              Ảnh phân loại
              <select
                value={v.imageId ?? ''}
                onChange={(e) =>
                  update(
                    'variants',
                    form.variants.map((x, n) =>
                      n === i ? { ...x, imageId: e.target.value || undefined } : x,
                    ),
                  )
                }
              >
                <option value="">Chưa gán ảnh</option>
                {images.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.filename}
                  </option>
                ))}
              </select>
            </label>
            {v.imageId && <img src={media(v.imageId)} alt="Ảnh phân loại đã chọn" />}
          </div>
        ))}
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Bộ ảnh gốc</h2>
          <span className="caption">{images.length} tệp sẵn sàng</span>
        </div>
        <p>
          Chọn bìa, ảnh trong bộ listing và ảnh trong content độc lập. Số trên ảnh là thứ tự đã
          chọn.
        </p>
        {!images.length && <p className="empty">Nhập ảnh ở mục Nguồn tài liệu trước khi gán.</p>}
        <div className="asset-grid">
          {images.map((img) => (
            <div className="asset" key={img.id}>
              <img src={media(img.id)} alt={img.filename} loading="lazy" />
              <p title={img.filename}>{img.filename}</p>
              <label className="inline">
                <input
                  type="radio"
                  name="cover"
                  checked={form.coverId === img.id}
                  onChange={() => update('coverId', img.id)}
                />
                Ảnh bìa
              </label>
              {(['galleryIds', 'descriptionImageIds'] as const).map((key) => (
                <div key={key} className="asset-role">
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={form[key].includes(img.id)}
                      onChange={() => toggle(key, img.id)}
                    />
                    {key === 'galleryIds' ? 'Bộ ảnh' : 'Content'}{' '}
                    {form[key].includes(img.id) ? '#' + (form[key].indexOf(img.id) + 1) : ''}
                  </label>
                  {form[key].includes(img.id) && (
                    <span>
                      <button aria-label="Đưa ảnh lên trước" onClick={() => move(key, img.id, -1)}>
                        ←
                      </button>
                      <button aria-label="Đưa ảnh về sau" onClick={() => move(key, img.id, 1)}>
                        →
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
