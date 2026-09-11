import { useEffect, useRef, useState } from 'react';
import type { ListingDraft, SourceSelection, WordImport } from '@shopee/domain';
import { api, media, post, type ImportRecord } from './api.js';
export type EditorSeed = SourceSelection & { productKey?: string; expectedRevision: number };
type EditableField =
  'title' | 'headline' | 'body' | 'coverId' | 'galleryIds' | 'descriptionImageIds';

export function Editor({
  seed,
  imports,
  onSaved,
  onCancel,
  onDirty,
  onBusy,
}: {
  seed: EditorSeed;
  imports: ImportRecord[];
  onSaved: (draft: ListingDraft) => void;
  onCancel: () => void;
  onDirty?: (dirty: boolean) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const isNew = seed.expectedRevision === 0;
  const [form, setForm] = useState<EditorSeed>(() => structuredClone(seed));
  const [editing, setEditing] = useState(isNew),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [tab, setTab] = useState<'content' | 'images'>('content');
  const [layout, setLayout] = useState(isNew ? '' : 'headline-images-body');
  const [wordId, setWordId] = useState(''),
    [word, setWord] = useState<WordImport | null>(null);
  const [wordLoading, setWordLoading] = useState(false),
    [wordError, setWordError] = useState('');
  const [imageSearch, setImageSearch] = useState('');
  const wordRequest = useRef<AbortController | null>(null),
    wordGeneration = useRef(0);
  const changed = JSON.stringify(form) !== JSON.stringify(seed),
    dirty = isNew || changed;
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  const images = imports.filter((item) => item.kind === 'image' && item.status === 'ready');
  const visibleImages = images.filter((item) =>
    item.filename.toLocaleLowerCase('vi').includes(imageSearch.toLocaleLowerCase('vi')),
  );
  const editable = editing && !busy;
  const canSave =
    editable &&
    (isNew || changed) &&
    !!form.title.trim() &&
    !!form.productKey?.trim() &&
    layout === 'headline-images-body';

  function update<K extends EditableField>(key: K, value: EditorSeed[K]) {
    if (editable) setForm((current) => ({ ...current, [key]: value }));
  }
  function assignVariantImage(index: number, imageId: string) {
    if (editable)
      setForm((current) => ({
        ...current,
        variants: current.variants.map((variant, i) =>
          i === index ? { ...variant, imageId: imageId || undefined } : variant,
        ),
      }));
  }
  function toggle(key: 'galleryIds' | 'descriptionImageIds', id: string) {
    update(
      key,
      form[key].includes(id) ? form[key].filter((value) => value !== id) : [...form[key], id],
    );
  }
  function move(key: 'galleryIds' | 'descriptionImageIds', id: string, direction: number) {
    const values = [...form[key]],
      index = values.indexOf(id),
      target = index + direction;
    if (index < 0 || target < 0 || target >= values.length) return;
    [values[index], values[target]] = [values[target], values[index]];
    update(key, values);
  }
  async function save() {
    if (!canSave) return;
    setBusy(true);
    onBusy?.(true);
    setError('');
    try {
      const payload: EditorSeed = {
        ...form,
        productKey: seed.productKey,
        tierNames: [...seed.tierNames],
        variants: seed.variants.map((variant, index) => ({
          ...variant,
          optionLabels: [...variant.optionLabels],
          imageId: form.variants[index].imageId,
        })),
      };
      const draft = await post<ListingDraft>('/v1/products', payload);
      onDirty?.(false);
      onSaved(draft);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Chưa lưu được bản nháp. Các thay đổi vẫn đang ở đây.',
      );
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }
  function selectWord(id: string) {
    wordRequest.current?.abort();
    wordGeneration.current += 1;
    setWordId(id);
    setWord(null);
    setWordError('');
    setWordLoading(!!id);
  }
  useEffect(() => {
    if (!wordId) return;
    const controller = new AbortController(),
      generation = ++wordGeneration.current;
    wordRequest.current = controller;
    setWordLoading(true);
    void api<ImportRecord>('/v1/imports/' + encodeURIComponent(wordId), {
      signal: controller.signal,
    })
      .then((record) => {
        if (controller.signal.aborted || generation !== wordGeneration.current) return;
        const body = record.body as WordImport | undefined;
        if (
          record.id !== wordId ||
          record.kind !== 'docx' ||
          record.status !== 'ready' ||
          !body ||
          !Array.isArray(body.paragraphs)
        )
          throw new Error('Tệp Word chưa sẵn sàng để đối chiếu.');
        setWord(body);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && generation === wordGeneration.current)
          setWordError(cause instanceof Error ? cause.message : 'Chưa đọc được tệp Word.');
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === wordGeneration.current)
          setWordLoading(false);
      });
    return () => controller.abort();
  }, [wordId]);

  return (
    <div className="editor-workspace">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            {isNew ? 'BƯỚC 2 / 2 · NỘI DUNG & ẢNH CÓ SẴN' : 'ĐỐI CHIẾU BẢN ĐÃ LƯU'} ·{' '}
            {form.variants.length} SKU
          </p>
          <h1>{isNew ? 'Nội dung và ảnh của listing' : 'Đối chiếu nguồn listing'}</h1>
          <p>
            Mã bộ listing: <strong>{seed.productKey ?? 'Chưa có mã ổn định'}</strong>
            {!isNew ? ` · phiên bản ${seed.expectedRevision}` : ''}
          </p>
        </div>
        <div className="actions">
          <button disabled={busy} onClick={onCancel}>
            Quay lại
          </button>
          <button className="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? 'Đang lưu…' : 'Lưu & xem trước'}
          </button>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="note editor-mode">
        <div>
          <strong>
            {editing ? 'Đang chuẩn bị bản nháp trong ứng dụng' : 'Đang xem bản đã lưu'}
          </strong>
          <p>
            {editing
              ? 'Nội dung và ảnh được lưu thành phiên bản để xem lại trước khi thực thi lên shop.'
              : 'Bạn có thể đối chiếu nội dung, ảnh và phân loại. Chọn điều chỉnh khi có thay đổi cụ thể cần lưu.'}
          </p>
        </div>
        {!isNew && !editing && (
          <button onClick={() => setEditing(true)}>Điều chỉnh nội dung và ảnh</button>
        )}
        {!isNew && editing && (
          <button
            disabled={busy}
            onClick={() => {
              setForm(structuredClone(seed));
              setLayout('headline-images-body');
              setEditing(false);
              setError('');
            }}
          >
            Bỏ các thay đổi chưa lưu
          </button>
        )}
      </div>
      <div className="editor-tabs" role="tablist" aria-label="Nội dung và ảnh">
        <button
          id="editor-content-tab"
          role="tab"
          aria-selected={tab === 'content'}
          aria-controls="editor-content-panel"
          onClick={() => setTab('content')}
        >
          Nội dung
        </button>
        <button
          id="editor-images-tab"
          role="tab"
          aria-selected={tab === 'images'}
          aria-controls="editor-images-panel"
          onClick={() => setTab('images')}
        >
          Bộ ảnh · {form.galleryIds.length} ảnh listing
        </button>
      </div>
      {tab === 'content' && (
        <section
          id="editor-content-panel"
          role="tabpanel"
          aria-labelledby="editor-content-tab"
          className="panel editor-section"
        >
          <h2>Nội dung đã chuẩn bị</h2>
          <p className="caption">
            Dán nguyên văn từ bộ listing của bạn. Các khoảng trắng và xuống dòng trong ô được giữ
            lại.
          </p>
          <label>
            Tiêu đề listing
            <input
              readOnly={!editable}
              value={form.title}
              onChange={(event) => update('title', event.target.value)}
            />
          </label>
          <div className="editor-layout-choice">
            <label>
              Bố trí mô tả trong bộ nguồn
              <select
                disabled={!editable}
                value={layout}
                onChange={(event) => setLayout(event.target.value)}
              >
                <option value="">Chọn cách bố trí đã chuẩn bị</option>
                <option value="headline-images-body">
                  Câu mở đầu → toàn bộ ảnh mô tả → phần chữ còn lại
                </option>
                <option value="other">Bộ nguồn có bố trí khác</option>
              </select>
            </label>
            <p className="caption">
              Cách bố trí hiện hỗ trợ thêm một dòng trống sau câu mở đầu và sau toàn bộ ảnh mô tả.
              Chỉ chọn khi đúng với bộ listing của bạn.
            </p>
            {layout === 'other' && (
              <p className="error" role="alert">
                Bố trí này chưa được ứng dụng hỗ trợ đầy đủ. Bản nháp chưa thể lưu theo cách bố trí
                khác; cần bổ sung cách đọc đúng bộ nguồn.
              </p>
            )}
          </div>
          <label>
            Câu mở đầu content
            <textarea
              readOnly={!editable}
              rows={3}
              value={form.headline}
              onChange={(event) => update('headline', event.target.value)}
            />
          </label>
          <label>
            Nội dung sau toàn bộ ảnh mô tả
            <textarea
              readOnly={!editable}
              rows={12}
              value={form.body}
              onChange={(event) => update('body', event.target.value)}
            />
          </label>
          <details className="editor-word-source">
            <summary>Mở Word để đối chiếu văn bản</summary>
            <label>
              Tệp Word để đối chiếu
              <select value={wordId} onChange={(event) => selectWord(event.target.value)}>
                <option value="">Chọn tệp đã nhập</option>
                {imports
                  .filter((item) => item.kind === 'docx' && item.status === 'ready')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.filename} · {item.sha256.slice(0, 8)}
                    </option>
                  ))}
              </select>
            </label>
            {wordLoading && <p role="status">Đang đọc văn bản…</p>}
            {wordError && (
              <p className="error" role="alert">
                {wordError}
              </p>
            )}
            {word && (
              <>
                <label>
                  Văn bản Word để chọn và sao chép
                  <textarea rows={14} readOnly value={word.paragraphs.join('\n')} />
                </label>
                <p className="caption">
                  Khung này hiển thị phần chữ được đọc theo thứ tự các đoạn. Chưa nhập nguyên bố
                  cục, ảnh nhúng hoặc ánh xạ tự động từng đoạn sang listing. Nội dung bạn dán và vị
                  trí ảnh cần được đối chiếu trước khi lưu.
                </p>
              </>
            )}
          </details>
        </section>
      )}
      {tab === 'images' && (
        <section
          id="editor-images-panel"
          role="tabpanel"
          aria-labelledby="editor-images-tab"
          className="panel editor-section"
        >
          <div className="section-heading">
            <div>
              <h2>Bộ ảnh gốc</h2>
              <p className="caption">
                Ảnh bìa, ảnh listing và ảnh mô tả giữ vai trò riêng. Chọn theo bộ đã chuẩn bị, giữ
                đúng thứ tự.
              </p>
            </div>
            <span className="tag">{images.length} tệp sẵn sàng</span>
          </div>
          <div className="editor-image-summary">
            <span>Bìa: {form.coverId ? 'đã chọn' : 'chưa chọn'}</span>
            <span>Ảnh listing: {form.galleryIds.length}</span>
            <span>Ảnh mô tả: {form.descriptionImageIds.length}</span>
          </div>
          {(['galleryIds', 'descriptionImageIds'] as const).map((key) => (
            <div className="editor-image-order" key={key}>
              <h3>{key === 'galleryIds' ? 'Thứ tự ảnh listing' : 'Thứ tự ảnh mô tả'}</h3>
              {form[key].length ? (
                <ol className="editor-selected-images">
                  {form[key].map((id, index) => {
                    const name = images.find((image) => image.id === id)?.filename ?? 'Ảnh đã chọn';
                    return (
                      <li key={id}>
                        <img src={media(id)} alt={name} loading="lazy" />
                        <span>
                          {index + 1}. {name}
                        </span>
                        <div className="actions">
                          <button
                            disabled={!editable || index === 0}
                            aria-label={`Đưa ${key === 'galleryIds' ? 'ảnh listing' : 'ảnh mô tả'} ${index + 1} lên trước`}
                            onClick={() => move(key, id, -1)}
                          >
                            ←
                          </button>
                          <button
                            disabled={!editable || index === form[key].length - 1}
                            aria-label={`Đưa ${key === 'galleryIds' ? 'ảnh listing' : 'ảnh mô tả'} ${index + 1} về sau`}
                            onClick={() => move(key, id, 1)}
                          >
                            →
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="caption">Chưa chọn ảnh cho vai trò này.</p>
              )}
            </div>
          ))}
          {editable && (
            <p className="caption">
              Chọn vai trò ở từng tệp bên dưới. Bìa được chọn riêng; các tệp được dùng nguyên bản.
            </p>
          )}
          <label>
            Tìm ảnh theo tên tệp
            <input
              value={imageSearch}
              onChange={(event) => setImageSearch(event.target.value)}
              placeholder="Nhập tên tệp trong bộ listing"
            />
          </label>
          {!images.length && (
            <p className="empty">Chưa có ảnh sẵn sàng. Nhập các ảnh gốc vào Tệp nguồn trước.</p>
          )}
          <div className="asset-grid">
            {visibleImages.map((image) => (
              <div className="asset" key={image.id}>
                <img src={media(image.id)} alt={image.filename} loading="lazy" />
                <p title={image.filename}>{image.filename}</p>
                <label className="inline">
                  <input
                    type="radio"
                    name="cover"
                    disabled={!editable}
                    checked={form.coverId === image.id}
                    onChange={() => update('coverId', image.id)}
                  />
                  Ảnh bìa
                </label>
                {(['galleryIds', 'descriptionImageIds'] as const).map((key) => (
                  <label className="inline" key={key}>
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={form[key].includes(image.id)}
                      onChange={() => toggle(key, image.id)}
                    />
                    {key === 'galleryIds' ? 'Ảnh listing' : 'Ảnh mô tả'}
                    {form[key].includes(image.id) ? ` · số ${form[key].indexOf(image.id) + 1}` : ''}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="panel editor-structure">
        <div className="section-heading">
          <div>
            <h2>Danh sách SKU và phân loại đã khóa</h2>
            <p className="caption">
              Giữ nguyên danh sách, tên nhóm, tên phân loại và thứ tự đã nhập. Tại đây chỉ có thể
              chọn ảnh phân loại khi đang điều chỉnh.
            </p>
          </div>
          <span className="tag">
            {form.variants.length} SKU · {seed.tierNames.length} nhóm phân loại
          </span>
        </div>
        {seed.tierNames.length ? (
          <div className="editor-tier-names">
            {seed.tierNames.map((name, index) => (
              <label key={index}>
                Tên nhóm phân loại {index + 1}
                <input readOnly value={name} />
              </label>
            ))}
          </div>
        ) : (
          <p>Listing không có phân loại.</p>
        )}
        <div className="editor-variant-list">
          {form.variants.map((variant, index) => (
            <div className="variant-editor" key={variant.importId + ':' + variant.rowKey}>
              <span className="number">{index + 1}</span>
              <div className="editor-variant-labels">
                {seed.variants[index].optionLabels.map((label, tier) => (
                  <label key={tier}>
                    {seed.tierNames[tier] || `Nhóm ${tier + 1}`}
                    <input
                      aria-label={'Phân loại ' + (index + 1) + (tier ? ' tầng ' + (tier + 1) : '')}
                      readOnly
                      value={label}
                    />
                  </label>
                ))}
                {!seed.tierNames.length && <p>SKU duy nhất trong bộ listing</p>}
                <small>
                  Nguồn:{' '}
                  {imports.find((item) => item.id === variant.importId)?.filename ??
                    'Tệp đã liên kết khi nhập'}
                </small>
              </div>
              <label>
                Ảnh phân loại {index + 1}
                <select
                  disabled={!editable}
                  value={variant.imageId ?? ''}
                  onChange={(event) => assignVariantImage(index, event.target.value)}
                >
                  <option value="">Chưa gán ảnh</option>
                  {images.map((image) => (
                    <option key={image.id} value={image.id}>
                      {image.filename}
                    </option>
                  ))}
                </select>
              </label>
              {variant.imageId && (
                <img
                  src={media(variant.imageId)}
                  alt={'Ảnh phân loại ' + (index + 1) + ' đã chọn'}
                />
              )}
            </div>
          ))}
        </div>
      </section>
      <div className="editor-save-bar">
        <div>
          <strong>
            {busy
              ? 'Đang lưu bản nháp…'
              : changed
                ? 'Có thay đổi chưa lưu'
                : isNew
                  ? 'Bộ listing đang được tiếp nhận'
                  : 'Bản đã lưu đang được giữ nguyên'}
          </strong>
          <p className="caption">
            Lưu tại đây tạo bản nháp trong ứng dụng. Chưa gửi thay đổi lên shop.
          </p>
        </div>
        <button className="primary" disabled={!canSave} onClick={() => void save()}>
          {busy ? 'Đang lưu…' : 'Lưu & xem trước'}
        </button>
      </div>
    </div>
  );
}
