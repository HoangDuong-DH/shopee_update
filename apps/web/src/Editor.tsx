import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, FileText, Image, LockKeyhole, Upload } from 'lucide-react';
import type { ListingDraft, SourceSelection, WordImport } from '@shopee/domain';
import { api, money, post, type ImportRecord } from './api.js';
import { ImagePicker } from './ImagePicker.js';
import { selectWordParagraphs, type WordTarget } from './word-assignment.js';

export type EditorSeed = SourceSelection & { productKey?: string; expectedRevision: number };
export type EditorSection = 'content' | 'images' | 'structure';
type EditableField =
  'title' | 'headline' | 'body' | 'coverId' | 'galleryIds' | 'descriptionImageIds';
const wordTargets: Record<WordTarget, string> = {
  title: 'Tiêu đề listing',
  headline: 'Câu mở đầu',
  body: 'Phần chữ sau ảnh',
};

export function Editor({
  seed,
  imports,
  onSaved,
  onCancel,
  onDirty,
  onBusy,
  onUploadFiles,
  externalBusy = false,
  variantSummaries,
  initialSection = 'content',
}: {
  seed: EditorSeed;
  imports: ImportRecord[];
  onSaved: (draft: ListingDraft) => void;
  onCancel: () => void;
  onDirty?: (dirty: boolean) => void;
  onBusy?: (busy: boolean) => void;
  onUploadFiles?: (files: FileList | null) => Promise<void>;
  externalBusy?: boolean;
  variantSummaries?: { sku: string; originalPrice?: string }[];
  initialSection?: EditorSection;
}) {
  const isNew = seed.expectedRevision === 0;
  const [form, setForm] = useState<EditorSeed>(() => structuredClone(seed));
  const [editing, setEditing] = useState(isNew),
    [localBusy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState('');
  const busy = localBusy || externalBusy;
  const [tab, setTab] = useState<EditorSection>(initialSection);
  const [imageRole, setImageRole] = useState<'cover' | 'gallery' | 'description'>('cover');
  const [layout, setLayout] = useState(isNew ? '' : 'headline-images-body');
  const [wordId, setWordId] = useState(''),
    [word, setWord] = useState<WordImport | null>(null);
  const [wordLoading, setWordLoading] = useState(false),
    [wordError, setWordError] = useState('');
  const [wordStart, setWordStart] = useState('1'),
    [wordEnd, setWordEnd] = useState('1');
  const [wordPending, setWordPending] = useState<{ field: WordTarget; text: string } | null>(null);
  const [wordAssignmentError, setWordAssignmentError] = useState('');
  const titleInput = useRef<HTMLInputElement>(null),
    layoutInput = useRef<HTMLSelectElement>(null);
  const wordRequest = useRef<AbortController | null>(null),
    wordGeneration = useRef(0);
  const changed =
    JSON.stringify(form) !== JSON.stringify(seed) || (!isNew && layout !== 'headline-images-body');
  const dirty = isNew || changed;
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    setTab(initialSection);
  }, [initialSection]);
  const images = imports.filter((item) => item.kind === 'image' && item.status === 'ready');
  const editable = editing && !busy;
  const canSave =
    editable &&
    (isNew || changed) &&
    !!form.title.trim() &&
    !!form.productKey?.trim() &&
    layout === 'headline-images-body';
  const saveReason = busy
    ? uploading || externalBusy
      ? 'Đang tải tệp. Bạn có thể tiếp tục khi tải xong.'
      : 'Đang lưu bản nháp…'
    : !editing
      ? 'Đang xem bản đã lưu. Chọn “Điều chỉnh nội dung và ảnh” nếu cần sửa.'
      : !form.productKey?.trim()
        ? 'Chưa nhận diện được bộ listing. Giữ phần đang nhập và báo người phụ trách ứng dụng.'
        : !form.title.trim()
          ? 'Cần bổ sung tiêu đề từ bộ nội dung đã chuẩn bị.'
          : layout !== 'headline-images-body'
            ? layout === 'other'
              ? 'Bố trí mô tả này chưa được hỗ trợ. Cần bổ sung cách đọc đúng bộ nguồn.'
              : 'Cần chọn cách bố trí mô tả đúng với bộ nguồn.'
            : !isNew && !changed
              ? 'Chưa có thay đổi mới để lưu.'
              : '';

  function update<K extends EditableField>(key: K, value: EditorSeed[K]) {
    if (editable) setForm((current) => ({ ...current, [key]: value }));
  }
  function assignVariantImage(index: number, imageId?: string) {
    if (editable)
      setForm((current) => ({
        ...current,
        variants: current.variants.map((variant, i) =>
          i === index ? { ...variant, imageId } : variant,
        ),
      }));
  }
  async function upload(files: FileList | null) {
    if (!onUploadFiles || !files?.length || !editable) return;
    setBusy(true);
    setUploading(true);
    onBusy?.(true);
    setError('');
    try {
      await onUploadFiles(files);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa tải được tệp. Bạn có thể thử lại.');
    } finally {
      setBusy(false);
      setUploading(false);
      onBusy?.(false);
    }
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
    setWordStart('1');
    setWordEnd('1');
    setWordPending(null);
    setWordAssignmentError('');
  }
  function previewWord(field: WordTarget) {
    if (!word || !editable) return;
    const result = selectWordParagraphs(word.paragraphs, Number(wordStart), Number(wordEnd), field);
    setWordPending(null);
    setWordAssignmentError('');
    if ('error' in result) setWordAssignmentError(result.error);
    else setWordPending({ field, text: result.text });
  }
  function focusMissing() {
    setTab('content');
    requestAnimationFrame(() => {
      const element = !form.title.trim() ? titleInput.current : layoutInput.current;
      element?.focus();
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
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
          !Array.isArray(body.paragraphs) ||
          body.paragraphs.some((paragraph) => typeof paragraph !== 'string')
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
            {isNew ? 'NỘI DUNG & ẢNH CÓ SẴN' : 'ĐỐI CHIẾU BẢN ĐÃ LƯU'} · {form.variants.length} SKU
          </p>
          <h1>{isNew ? 'Nội dung và ảnh của listing' : 'Đối chiếu nguồn listing'}</h1>
          <p>
            {isNew
              ? 'Kiểm tra nội dung và ảnh từ bộ listing bạn đã chuẩn bị.'
              : `Bản nguồn ${seed.expectedRevision} · Đã lưu trong ứng dụng`}
          </p>
          <details className="editor-reference">
            <summary>Thông tin gửi người hỗ trợ</summary>
            <p>
              Mã bộ listing: <code>{seed.productKey ?? 'Chưa nhận diện được bộ listing'}</code>
            </p>
          </details>
        </div>
        <div className="actions">
          <button disabled={busy} onClick={onCancel}>
            <ArrowLeft size={16} aria-hidden="true" /> Quay lại
          </button>
          <button className="primary" disabled={!canSave} onClick={() => void save()}>
            {localBusy && !uploading ? 'Đang lưu…' : 'Lưu & xem trước'}
          </button>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {editing && !canSave && saveReason && (
        <div className="note save-reason" role="status">
          <p>{saveReason}</p>
          {editable &&
            !!form.productKey?.trim() &&
            (!form.title.trim() || layout !== 'headline-images-body') && (
              <button className="text-button" onClick={focusMissing}>
                Đi đến phần cần bổ sung
              </button>
            )}
        </div>
      )}
      <div className="note editor-mode">
        <div>
          <strong>
            {editing ? 'Đang chuẩn bị bản nháp trong ứng dụng' : 'Đang xem bản đã lưu'}
          </strong>
          <p>
            {editing
              ? 'Dùng đúng nội dung và ảnh đã chuẩn bị. Khi lưu, ứng dụng giữ một phiên bản để bạn xem lại.'
              : 'Xem nội dung, bộ ảnh và phân loại ở các mục bên dưới. Bản đã lưu được giữ nguyên cho đến khi bạn chọn điều chỉnh.'}
          </p>
        </div>
        {!isNew && !editing && (
          <button disabled={busy} onClick={() => setEditing(true)}>
            Điều chỉnh nội dung và ảnh
          </button>
        )}
        {!isNew && editing && (
          <button
            disabled={busy}
            onClick={() => {
              setForm(structuredClone(seed));
              setLayout('headline-images-body');
              setEditing(false);
              setError('');
              setWordPending(null);
            }}
          >
            Bỏ các thay đổi chưa lưu
          </button>
        )}
      </div>
      <div className="editor-tabs" role="tablist" aria-label="Các phần trong bộ listing">
        <button
          id="editor-content-tab"
          role="tab"
          aria-selected={tab === 'content'}
          aria-controls="editor-content-panel"
          onClick={() => setTab('content')}
        >
          <FileText size={17} aria-hidden="true" /> Nội dung
        </button>
        <button
          id="editor-images-tab"
          role="tab"
          aria-selected={tab === 'images'}
          aria-controls="editor-images-panel"
          onClick={() => setTab('images')}
        >
          <Image size={17} aria-hidden="true" /> Bộ ảnh · {form.galleryIds.length} ảnh listing
        </button>
        <button
          id="editor-structure-tab"
          role="tab"
          aria-selected={tab === 'structure'}
          aria-controls="editor-structure-panel"
          onClick={() => setTab('structure')}
        >
          <LockKeyhole size={17} aria-hidden="true" /> SKU & phân loại · {form.variants.length}
        </button>
      </div>
      {tab === 'content' && (
        <section
          id="editor-content-panel"
          role="tabpanel"
          aria-labelledby="editor-content-tab"
          className="panel editor-section"
        >
          <div className="editor-word-source">
            <div className="section-heading">
              <div>
                <h2>Dùng nội dung từ Word</h2>
                <p className="caption">
                  Mở tệp đã chuẩn bị để đối chiếu hoặc chọn chính xác đoạn cần đưa vào listing.
                </p>
              </div>
              {editable && onUploadFiles && (
                <label className="upload-button">
                  <Upload size={16} aria-hidden="true" /> Tải Word từ máy
                  <input
                    type="file"
                    accept=".docx"
                    aria-label="Tải tệp Word cho listing"
                    onChange={(event) => {
                      const files = event.currentTarget.files;
                      void upload(files);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
              )}
            </div>
            <label>
              Tệp Word để đối chiếu
              <select
                disabled={busy}
                value={wordId}
                onChange={(event) => selectWord(event.target.value)}
              >
                <option value="">Chọn tệp Word đã nhập</option>
                {imports
                  .filter((item) => item.kind === 'docx' && item.status === 'ready')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.filename}
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
                <details className="word-paragraph-reference" open={editing || undefined}>
                  <summary>Xem {word.paragraphs.length} đoạn trong Word</summary>
                  <ol>
                    {word.paragraphs.map((paragraph, index) => (
                      <li key={index}>
                        <span className="word-paragraph-number">{index + 1}</span>
                        <span className="word-paragraph-text">
                          {paragraph || <i>Đoạn trống</i>}
                        </span>
                      </li>
                    ))}
                  </ol>
                </details>
                {editable && (
                  <div className="word-assignment">
                    <p>
                      <strong>Chọn đoạn để điền</strong> · Văn bản được giữ nguyên.
                    </p>
                    <div className="word-range">
                      <label>
                        Từ đoạn
                        <input
                          type="number"
                          min={1}
                          max={word.paragraphs.length}
                          value={wordStart}
                          onChange={(event) => {
                            setWordStart(event.target.value);
                            setWordPending(null);
                            setWordAssignmentError('');
                          }}
                        />
                      </label>
                      <label>
                        Đến đoạn
                        <input
                          type="number"
                          min={1}
                          max={word.paragraphs.length}
                          value={wordEnd}
                          onChange={(event) => {
                            setWordEnd(event.target.value);
                            setWordPending(null);
                            setWordAssignmentError('');
                          }}
                        />
                      </label>
                    </div>
                    <div className="actions">
                      {(Object.keys(wordTargets) as WordTarget[]).map((field) => (
                        <button key={field} onClick={() => previewWord(field)}>
                          Đưa vào {wordTargets[field].toLocaleLowerCase('vi')}
                        </button>
                      ))}
                    </div>
                    {wordAssignmentError && (
                      <p className="error" role="alert">
                        {wordAssignmentError}
                      </p>
                    )}
                    {wordPending && (
                      <div
                        className="word-apply-preview"
                        role="region"
                        aria-label="Xem trước nội dung sẽ điền"
                      >
                        <h3>{wordTargets[wordPending.field]}</h3>
                        <p>
                          {form[wordPending.field]
                            ? 'Ô này đã có nội dung. Xem hai bản trước khi thay thế.'
                            : 'Xem đúng đoạn đã chọn trước khi điền.'}
                        </p>
                        <div className="word-before-after">
                          <div>
                            <strong>Hiện tại</strong>
                            <pre>{form[wordPending.field] || '(Ô đang trống)'}</pre>
                          </div>
                          <div>
                            <strong>Sau khi áp dụng</strong>
                            <pre>{wordPending.text || '(Đoạn trống)'}</pre>
                          </div>
                        </div>
                        <div className="actions">
                          <button
                            className="primary"
                            onClick={() => {
                              update(wordPending.field, wordPending.text);
                              setWordPending(null);
                            }}
                          >
                            <Check size={16} aria-hidden="true" /> Áp dụng vào{' '}
                            {wordTargets[wordPending.field].toLocaleLowerCase('vi')}
                          </button>
                          <button onClick={() => setWordPending(null)}>Hủy lựa chọn</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <details>
                  <summary>Văn bản để sao chép thủ công</summary>
                  <label>
                    Văn bản Word để chọn và sao chép
                    <textarea rows={10} readOnly value={word.paragraphs.join('\n')} />
                  </label>
                </details>
                <p className="caption">
                  Đây là phần chữ theo thứ tự đoạn trong Word. Bố cục và ảnh nhúng chưa được nhập;
                  vị trí đoạn Word chưa được lưu thành liên kết nguồn của từng ô.
                </p>
              </>
            )}
          </div>
          <h2>Nội dung đã chuẩn bị</h2>
          <p className="caption">
            Bạn cũng có thể dán nguyên văn vào các ô. Khoảng trắng và xuống dòng được giữ lại.
          </p>
          <label>
            Tiêu đề listing
            <input
              ref={titleInput}
              readOnly={!editable}
              value={form.title}
              onChange={(event) => update('title', event.target.value)}
            />
          </label>
          <div className="editor-layout-choice">
            <label>
              Bố trí mô tả trong bộ nguồn
              <select
                ref={layoutInput}
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
          <div className="content-image-position">
            <Image size={18} aria-hidden="true" />
            <span>
              {form.descriptionImageIds.length
                ? `${form.descriptionImageIds.length} ảnh mô tả được đặt tại đây`
                : 'Vị trí dành cho ảnh mô tả trong bộ nguồn'}
            </span>
            <button
              onClick={() => {
                setImageRole('description');
                setTab('images');
              }}
            >
              Xem ảnh mô tả
            </button>
          </div>
          <label>
            Nội dung sau toàn bộ ảnh mô tả
            <textarea
              readOnly={!editable}
              rows={12}
              value={form.body}
              onChange={(event) => update('body', event.target.value)}
            />
          </label>
        </section>
      )}
      {tab === 'images' && (
        <section
          id="editor-images-panel"
          role="tabpanel"
          aria-labelledby="editor-images-tab"
          className="panel editor-section"
        >
          <h2>Bộ ảnh của listing này</h2>
          <p className="caption">
            Chọn vị trí cần xem. Ảnh bìa, ảnh listing và ảnh mô tả được quản lý riêng theo bộ đã
            chuẩn bị.
          </p>
          <div className="image-role-tabs" role="tablist" aria-label="Vị trí ảnh">
            <button
              id="image-role-cover"
              role="tab"
              aria-selected={imageRole === 'cover'}
              aria-controls="image-role-panel"
              onClick={() => setImageRole('cover')}
            >
              Ảnh bìa <span>{form.coverId ? '1' : '0'}</span>
            </button>
            <button
              id="image-role-gallery"
              role="tab"
              aria-selected={imageRole === 'gallery'}
              aria-controls="image-role-panel"
              onClick={() => setImageRole('gallery')}
            >
              Ảnh listing <span>{form.galleryIds.length}</span>
            </button>
            <button
              id="image-role-description"
              role="tab"
              aria-selected={imageRole === 'description'}
              aria-controls="image-role-panel"
              onClick={() => setImageRole('description')}
            >
              Ảnh mô tả <span>{form.descriptionImageIds.length}</span>
            </button>
          </div>
          <div id="image-role-panel" role="tabpanel" aria-labelledby={`image-role-${imageRole}`}>
            {imageRole === 'cover' && (
              <ImagePicker
                key="cover"
                title="Ảnh bìa"
                description="Ảnh bìa riêng đã chuẩn bị cho listing."
                single
                images={images}
                selectedIds={form.coverId ? [form.coverId] : []}
                editable={editable}
                onChange={(ids) => update('coverId', ids[0])}
                onUploadFiles={onUploadFiles ? upload : undefined}
              />
            )}
            {imageRole === 'gallery' && (
              <ImagePicker
                key="gallery"
                title="Ảnh listing"
                description="Bộ ảnh người mua xem khi mở listing. Số thứ tự là thứ tự hiển thị."
                images={images}
                selectedIds={form.galleryIds}
                editable={editable}
                onChange={(ids) => update('galleryIds', ids)}
                onUploadFiles={onUploadFiles ? upload : undefined}
              />
            )}
            {imageRole === 'description' && (
              <ImagePicker
                key="description"
                title="Ảnh mô tả"
                description="Ảnh nằm trong phần mô tả. Chọn đủ ảnh và giữ đúng thứ tự của bộ nguồn."
                images={images}
                selectedIds={form.descriptionImageIds}
                editable={editable}
                onChange={(ids) => update('descriptionImageIds', ids)}
                onUploadFiles={onUploadFiles ? upload : undefined}
              />
            )}
          </div>
          <div className="note">
            <p>
              Ảnh riêng cho từng phân loại nằm trong mục{' '}
              <button className="text-button" onClick={() => setTab('structure')}>
                SKU & phân loại
              </button>
              .
            </p>
          </div>
        </section>
      )}
      {tab === 'structure' && (
        <section
          id="editor-structure-panel"
          role="tabpanel"
          aria-labelledby="editor-structure-tab"
          className="panel editor-structure"
        >
          <div className="section-heading">
            <div>
              <h2>Danh sách SKU và phân loại đã khóa</h2>
              <p className="caption">
                Giữ nguyên danh sách, tên nhóm, tên phân loại và thứ tự đã nhập. Tại đây chỉ có thể
                chọn ảnh phân loại khi đang điều chỉnh.
              </p>
            </div>
            <span className="tag">
              <LockKeyhole size={14} aria-hidden="true" /> {form.variants.length} SKU ·{' '}
              {seed.tierNames.length} nhóm phân loại
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
                  {variantSummaries?.[index] ? (
                    <div className="variant-source-summary">
                      <p>
                        SKU: <strong>{variantSummaries[index].sku}</strong>
                      </p>
                      <p>
                        GIÁ GỐC:{' '}
                        <strong>
                          {/^[1-9]\d*$/.test(variantSummaries[index].originalPrice ?? '')
                            ? money(variantSummaries[index].originalPrice)
                            : 'Chưa có giá nguồn hợp lệ'}
                        </strong>
                      </p>
                    </div>
                  ) : (
                    <p className="caption">Xem SKU và giá ở màn kiểm tra</p>
                  )}
                  {seed.variants[index].optionLabels.map((label, tier) => (
                    <label key={tier}>
                      {seed.tierNames[tier] || `Nhóm ${tier + 1}`}
                      <input
                        aria-label={
                          'Phân loại ' + (index + 1) + (tier ? ' tầng ' + (tier + 1) : '')
                        }
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
                <ImagePicker
                  title={`Ảnh phân loại ${index + 1}`}
                  single
                  images={images}
                  selectedIds={variant.imageId ? [variant.imageId] : []}
                  editable={editable}
                  onChange={(ids) => assignVariantImage(index, ids[0])}
                  onUploadFiles={onUploadFiles ? upload : undefined}
                />
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="editor-save-bar">
        <div>
          <strong>
            {busy
              ? uploading || externalBusy
                ? 'Đang tải tệp…'
                : 'Đang lưu bản nháp…'
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
          {localBusy && !uploading ? 'Đang lưu…' : 'Lưu & xem trước'}
        </button>
      </div>
    </div>
  );
}
