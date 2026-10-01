import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Check, FileText, Image, LockKeyhole, Upload } from 'lucide-react';
import type { ListingDraft, SourceSelection, WordImport, WorkbookImport } from '@shopee/domain';
import { api, money, post, RequestError, type ImportRecord } from './api.js';
import { ImagePicker } from './ImagePicker.js';
import { selectWordParagraphs, type WordTarget } from './word-assignment.js';
import { scopedImageRecords } from './editor-source-scope.js';
import { buildEditorPayload, editorRecoveryKey, makeEditorRecovery, readEditorRecovery, writeEditorRecovery, findEditorRecoveries, compareEditorSaveResult, type PendingEditorSave, type EditorRecovery } from './editor-recovery.js';
import './listing-authoring.css';

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
  sourceImportIds = null,
  onOpenLatest,
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
  sourceImportIds?: string[] | null;
  onOpenLatest?: (draft: ListingDraft) => void;
}) {
  const isNew = seed.expectedRevision === 0;
  const [initialRecovery] = useState(() => {
    if (typeof window === 'undefined' || !seed.productKey) return { state: 'none' as const, stale: [] as EditorRecovery[], storageUnavailable: false };
    try {
      const restored = readEditorRecovery(localStorage.getItem(editorRecoveryKey(seed.productKey, seed.expectedRevision)), seed);
      const stale = findEditorRecoveries(localStorage, seed.productKey).filter(copy => copy.expectedRevision !== seed.expectedRevision || restored.state === 'stale');
      return { ...restored, stale, storageUnavailable: false };
    } catch { return { state: 'none' as const, stale: [] as EditorRecovery[], storageUnavailable: true }; }
  });
  const restoredCopy = initialRecovery.state === 'restored' ? initialRecovery.copy : undefined;
  const [form, setForm] = useState<EditorSeed>(() => structuredClone(restoredCopy?.form ?? seed));
  const [editing, setEditing] = useState(isNew || !!restoredCopy),
    [localBusy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState('');
  const busy = localBusy || externalBusy;
  const [tab, setTab] = useState<EditorSection>(restoredCopy?.section ?? initialSection);
  const [imageRole, setImageRole] = useState<'cover' | 'gallery' | 'description'>('cover');
  const [layout, setLayout] = useState(restoredCopy?.layout ?? (isNew ? '' : 'headline-images-body'));
  const [pendingSave, setPendingSave] = useState<PendingEditorSave | null>(restoredCopy?.pending ?? null);
  const [recoveryState, setRecoveryState] = useState<'unknown' | 'unchanged' | 'conflict'>('unknown');
  const [latestSaved, setLatestSaved] = useState<ListingDraft | null>(null);
  const [storageFailed, setStorageFailed] = useState(initialRecovery.storageUnavailable);
  const [recoveryBlocked, setRecoveryBlocked] = useState(initialRecovery.state === 'invalid' || initialRecovery.state === 'stale');
  const [recoveryNotice, setRecoveryNotice] = useState(restoredCopy ? 'Đã khôi phục phần đang sửa trên máy này; chưa lưu thành bản nguồn mới.' : initialRecovery.state === 'invalid' ? 'Không đọc được bản tạm của phiên bản này. Bản nguồn đã lưu vẫn giữ nguyên.' : '');
  const saveLock = useRef(false), completed = useRef(false);
  const sectionProp = useRef(initialSection);
  const pendingRef = useRef<PendingEditorSave | null>(restoredCopy?.pending ?? null);
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
    JSON.stringify(buildEditorPayload(seed, form)) !== JSON.stringify(buildEditorPayload(seed, seed)) || (!isNew && layout !== 'headline-images-body');
  const dirty = isNew || changed || !!pendingSave;
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (sectionProp.current === initialSection) return;
    sectionProp.current = initialSection;
    setTab(initialSection);
  }, [initialSection]);
  const images = imports.filter((item) => item.kind === 'image');
  const selectableImages = scopedImageRecords(images, sourceImportIds);
  const formImages = [...(form.coverId ? [form.coverId] : []), ...form.galleryIds, ...form.descriptionImageIds, ...form.variants.flatMap(variant => variant.imageId ? [variant.imageId] : [])];
  const originalImages = new Set([...(seed.coverId ? [seed.coverId] : []), ...seed.galleryIds, ...seed.descriptionImageIds, ...seed.variants.flatMap(variant => variant.imageId ? [variant.imageId] : [])]);
  const missingNewImage = formImages.some(id => !originalImages.has(id) && !selectableImages.some(image => image.id === id));
  const editable = editing && !busy && !pendingSave && !recoveryBlocked;
  const boundNewContent = isNew && !!form.contentBinding && !!form.folderBinding;
  const canSave =
    editable &&
    (isNew || changed) &&
    !!form.title.trim() &&
    !!form.productKey?.trim() &&
    !missingNewImage &&
    layout === 'headline-images-body';
  const saveReason = busy
    ? uploading || externalBusy
      ? 'Đang tải tệp. Bạn có thể tiếp tục khi tải xong.'
      : 'Đang lưu bản nháp…'
    : pendingSave
      ? 'Kết quả lần lưu trước đang cần đối chiếu. Giữ nguyên yêu cầu này và kiểm tra bản đã lưu trước khi gửi tiếp.'
    : recoveryBlocked
      ? 'Bản tạm chưa khớp nguồn hiện tại. Xem phần đã giữ riêng trước khi bắt đầu sửa tiếp.'
    : missingNewImage
      ? 'Ảnh vừa chọn trong bản tạm chưa thuộc bộ nguồn đang mở. Bổ sung lại đúng tệp vào bộ này trước khi lưu; ảnh và phần chữ đang sửa vẫn được giữ.'
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
    if (boundNewContent && ['title','headline','body'].includes(key)) return;
    if (editable) setForm((current) => {
      const next = {...current, [key]: value};
      if (['title','headline','body'].includes(key) && value !== current[key]) delete next.contentBinding;
      return next;
    });
  }
  function assignVariantImage(index: number, imageId?: string) {
    if (editable && sourceImportIds !== null && (!imageId || selectableImages.some(image => image.id === imageId)))
      setForm((current) => ({
        ...current,
        variants: current.variants.map((variant, i) =>
          i === index ? { ...variant, imageId } : variant,
        ),
      }));
  }
  async function upload(files: FileList | null) {
    if (!onUploadFiles || !files?.length || !editable || sourceImportIds === null || saveLock.current) return;
    saveLock.current = true;
    setBusy(true);
    setUploading(true);
    onBusy?.(true);
    setError('');
    try {
      await onUploadFiles(files);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa tải được tệp. Bạn có thể thử lại.');
    } finally {
      saveLock.current = false;
      setBusy(false);
      setUploading(false);
      onBusy?.(false);
    }
  }
  function persist(pending = pendingRef.current) {
    try {
      const ok = writeEditorRecovery(localStorage, makeEditorRecovery(seed, { form: buildEditorPayload(seed, form), layout, section: tab, sourceImportIds, ...(pending ? { pending } : {}) }));
      setStorageFailed(!ok);
      return ok;
    } catch { setStorageFailed(true); return false; }
  }
  useEffect(() => {
    if (completed.current || recoveryBlocked || !seed.productKey || (!editing && !pendingSave) || (!changed && !isNew && !pendingSave)) return;
    persist();
  }, [form, layout, tab, sourceImportIds, pendingSave, editing, recoveryBlocked]);
  function setPending(value: PendingEditorSave | null) { pendingRef.current = value; setPendingSave(value); }
  function acknowledge(draft: ListingDraft, request: PendingEditorSave) {
    completed.current = true;
    setPending(null);
    try { localStorage.removeItem(editorRecoveryKey(request.payload.productKey, request.payload.expectedRevision)); }
    catch { setStorageFailed(true); }
    onDirty?.(false);
    onSaved(draft);
  }
  async function readSaveResult(request: PendingEditorSave) {
    try {
      const latest = await api<ListingDraft>('/v1/products/' + encodeURIComponent(request.payload.productKey));
      const result = compareEditorSaveResult(request, latest);
      if (result.state === 'saved') { acknowledge(latest, request); return 'saved' as const; }
      setLatestSaved(result.state !== 'unknown' && latest.productKey === request.payload.productKey ? latest : null);
      setRecoveryState(result.state);
      setError(result.state === 'conflict' ? 'Bản đã lưu khác lần đang gửi hoặc đã có phiên bản mới. Phần đang sửa được giữ riêng để đối chiếu.' : result.state === 'unchanged' ? 'Bản nguồn chưa đổi sau lần kiểm tra này. Có thể gửi lại đúng yêu cầu đã giữ; ứng dụng kiểm tra lại trước khi gửi.' : 'Chưa đối chiếu được đầy đủ kết quả. Giữ lần lưu đang chờ và bấm kiểm tra lại.');
      return result.state;
    } catch (cause) {
      const absentNew = request.payload.expectedRevision === 0 && cause instanceof RequestError && cause.status === 404;
      setRecoveryState(absentNew ? 'unchanged' : 'unknown');
      setError(absentNew ? 'Chưa có bản nguồn đã lưu cho bộ này. Có thể gửi lại đúng yêu cầu đã giữ.' : cause instanceof Error ? cause.message : 'Chưa đọc lại được bản đã lưu. Giữ phần đang sửa và kiểm tra lại.');
      return absentNew ? 'unchanged' as const : 'unknown' as const;
    }
  }
  async function captureRequest(): Promise<PendingEditorSave> {
    const payload = buildEditorPayload(seed, form), summaries = variantSummaries ?? [];
    const records = new Map(imports.map(record => [record.id, record]));
    let variants: PendingEditorSave['variants'];
    if (summaries.length === payload.variants.length && summaries.every(variant => variant.originalPrice !== undefined && /^\d*$/.test(variant.originalPrice))) variants = structuredClone(summaries);
    else {
      for (const id of new Set(payload.variants.map(variant => variant.importId))) {
        const record = await api<ImportRecord>('/v1/imports/' + encodeURIComponent(id));
        if (record.id !== id || record.kind !== 'xlsx' || record.status !== 'ready') throw Error('Chưa đọc được đúng bảng giá đã chọn. Giữ phần đang nhập và mở lại nguồn giá.');
        records.set(id, record);
      }
      variants = payload.variants.map(variant => {
        const row = (records.get(variant.importId)?.body as WorkbookImport | undefined)?.rows?.find(row => row.key === variant.rowKey);
        if (!row || typeof row.sku?.value !== 'string' || row.originalPrice && !/^\d*$/.test(row.originalPrice.value)) throw Error('Chưa đối chiếu được đúng dòng SKU và giá nguồn. Không suy giá để lưu tiếp.');
        return { sku: row.sku.value, originalPrice: row.originalPrice?.value ?? '' };
      });
    }
    const imageIds = [...new Set([...(payload.coverId ? [payload.coverId] : []), ...payload.galleryIds, ...payload.descriptionImageIds, ...payload.variants.flatMap(variant => variant.imageId ? [variant.imageId] : [])])];
    for (const id of imageIds) if (!records.has(id)) {
      const record = await api<ImportRecord>('/v1/imports/' + encodeURIComponent(id));
      if (record.id !== id || record.kind !== 'image' || record.status !== 'ready') throw Error('Chưa đọc được đúng tệp ảnh đã liên kết. Bản đang nhập vẫn được giữ.');
      records.set(id, record);
    }
    const sourceIds = [...new Set([...payload.variants.map(variant => variant.importId), ...imageIds, ...(payload.contentBinding ? [payload.contentBinding.mapping.importId] : [])])];
    for (const id of sourceIds) if (!records.has(id)) {
      const record = await api<ImportRecord>('/v1/imports/' + encodeURIComponent(id));
      if (record.id !== id || record.status !== 'ready') throw Error('Chưa đọc được đúng tệp nguồn đã liên kết. Phần đang sửa vẫn được giữ.');
      records.set(id, record);
    }
    const sourceFiles = sourceIds.map(id => {
      const record = records.get(id);
      if (!record || record.id !== id || record.status !== 'ready' || !/^[a-f0-9]{64}$/.test(record.sha256))
        throw Error('Chưa đối chiếu được dấu vân tay tệp nguồn. Chưa gửi bản nháp; giữ phần đang sửa và bổ sung lại đúng tệp.');
      return { id, sha256: record.sha256 };
    });
    return { payload, variants, sourceFiles, submittedAt: new Date().toISOString() };
  }
  async function sendSave(request: PendingEditorSave) {
    try {
      const draft = await post<ListingDraft>('/v1/products', request.payload);
      const result = compareEditorSaveResult(request, draft);
      if (result.state === 'saved') acknowledge(draft, request);
      else await readSaveResult(request);
    } catch (cause) {
      const uncertain = !(cause instanceof RequestError) || ['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE', 'REQUEST_TIMEOUT', 'PRODUCT_REVISION_CONFLICT'].includes(cause.code) || (cause.status ?? 0) >= 500;
      if (uncertain) await readSaveResult(request);
      else {
        setPending(null); persist(null);
        setError(cause.message);
      }
    }
  }
  async function save() {
    if (!canSave || saveLock.current) return;
    saveLock.current = true;
    setBusy(true);
    onBusy?.(true);
    setError('');
    try {
      const request = await captureRequest();
      if (!persist(request)) { setError('Chưa lưu được yêu cầu phục hồi trên máy này. Chưa gửi bản nháp; giữ trang mở và kiểm tra dung lượng hoặc quyền lưu trữ.'); return; }
      setPending(request);
      await sendSave(request);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Chưa lưu được bản nháp. Các thay đổi vẫn đang ở đây.',
      );
    } finally {
      saveLock.current = false;
      setBusy(false);
      onBusy?.(false);
    }
  }
  async function recover(request = pendingRef.current, retry = false) {
    if (!request || saveLock.current || busy) return;
    saveLock.current = true; setBusy(true); onBusy?.(true); setError('');
    try {
      const result = await readSaveResult(request);
      if (retry && result === 'unchanged') {
        if (!persist(request)) { setError('Chưa lưu được yêu cầu phục hồi. Chưa gửi lại; giữ trang đang mở.'); return; }
        await sendSave(request);
      }
    } finally { saveLock.current = false; setBusy(false); onBusy?.(false); }
  }
  function discardChanges() {
    if (busy || pendingRef.current) return;
    try { localStorage.removeItem(editorRecoveryKey(seed.productKey!, seed.expectedRevision)); }
    catch { setStorageFailed(true); setError('Chưa bỏ được bản tạm trên máy. Phần đang sửa được giữ nguyên.'); return; }
    setRecoveryBlocked(false); setForm(structuredClone(seed)); setLayout(isNew ? '' : 'headline-images-body');
    setEditing(isNew); setError(''); setWordPending(null); setRecoveryNotice('Đã bỏ phần chưa lưu của phiên bản này. Bản nguồn đã lưu vẫn giữ nguyên.');
  }
  function tabKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.findIndex(element => element === event.target);
    if (index < 0) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[next]?.click(); tabs[next]?.focus();
  }
  function selectWord(id: string) {
    if (id && !sourceImportIds?.includes(id)) return;
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
      {(recoveryNotice || storageFailed || pendingSave || initialRecovery.stale.length > 0 || recoveryBlocked) && <section className="editor-recovery" aria-label="Phần đang sửa và phục hồi">
        <strong>{pendingSave ? 'Lần lưu đang cần đối chiếu' : 'Phần đang sửa trên máy này'}</strong>
        {recoveryNotice && <p role="status">{recoveryNotice}</p>}
        {storageFailed && <p className="error" role="alert">Chưa lưu được bản phục hồi trên máy này. Giữ trang đang mở; đừng tải lại trước khi lưu được vào ứng dụng hoặc sao chép phần đang sửa.</p>}
        {pendingSave && <>
          <p>Yêu cầu lưu bản nguồn {pendingSave.payload.expectedRevision + 1} cho “{pendingSave.payload.title}” vẫn được giữ nguyên. Đây là lưu trong ứng dụng, chưa gửi lên Shopee.</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void recover()}>Kiểm tra bản đã lưu</button>
            {recoveryState === 'unchanged' && <button type="button" disabled={busy} onClick={() => void recover(pendingSave, true)}>Gửi lại đúng yêu cầu đã giữ</button>}
            {latestSaved && onOpenLatest && <button type="button" disabled={busy} onClick={() => onOpenLatest(latestSaved)}>Xem bản nguồn mới nhất</button>}
          </div>
        </>}
        {initialRecovery.stale.map(copy => <details className="editor-recovery-stale" key={copy.expectedRevision + ':' + copy.updatedAt}>
          <summary>Phần sửa đã giữ riêng từ bản nguồn {copy.expectedRevision} · {copy.form.title}</summary>
          <p>Nguồn hiện tại là bản {seed.expectedRevision}. Phần này chưa được áp dụng vào bản mới.</p>
          <label>Tiêu đề trong bản đang sửa<input readOnly value={copy.form.title} /></label>
          <label>Câu mở đầu trong bản đang sửa<textarea readOnly rows={3} value={copy.form.headline} /></label>
          <label>Nội dung trong bản đang sửa<textarea readOnly rows={6} value={copy.form.body} /></label>
          <p className="caption">Giữ riêng {copy.form.galleryIds.length} ảnh sản phẩm, {copy.form.descriptionImageIds.length} ảnh mô tả và {copy.form.variants.length} dòng phân loại theo đúng bản nguồn cũ.</p>
          {copy.pending && <button type="button" disabled={busy} onClick={() => void recover(copy.pending)}>Đối chiếu lần lưu đang chờ của bản này</button>}
        </details>)}
        {recoveryBlocked && !pendingSave && <button type="button" disabled={busy} onClick={discardChanges}>Bỏ bản tạm của phiên bản này để bắt đầu lại</button>}
      </section>}
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
              discardChanges();
            }}
          >
            Bỏ các thay đổi chưa lưu
          </button>
        )}
      </div>
      <div className="editor-tabs" role="tablist" aria-label="Các phần trong bộ listing" onKeyDown={tabKeys}>
        <button
          id="editor-content-tab"
          role="tab"
          aria-selected={tab === 'content'}
          tabIndex={tab === 'content' ? 0 : -1}
          aria-controls="editor-content-panel"
          onClick={() => setTab('content')}
        >
          <FileText size={17} aria-hidden="true" /> Nội dung
        </button>
        <button
          id="editor-images-tab"
          role="tab"
          aria-selected={tab === 'images'}
          tabIndex={tab === 'images' ? 0 : -1}
          aria-controls="editor-images-panel"
          onClick={() => setTab('images')}
        >
          <Image size={17} aria-hidden="true" /> Bộ ảnh · {form.galleryIds.length} ảnh listing
        </button>
        <button
          id="editor-structure-tab"
          role="tab"
          aria-selected={tab === 'structure'}
          tabIndex={tab === 'structure' ? 0 : -1}
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
              {editable && onUploadFiles && sourceImportIds !== null && (
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
                disabled={busy || sourceImportIds === null}
                value={wordId}
                onChange={(event) => selectWord(event.target.value)}
              >
                <option value="">Chọn tệp Word đã nhập</option>
                {imports
                  .filter((item) => item.kind === 'docx' && item.status === 'ready' && sourceImportIds?.includes(item.id))
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.filename}
                    </option>
                  ))}
              </select>
            </label>
            {sourceImportIds === null && <p className="authoring-source-notice" role="status">Chưa xác định được đúng bộ nguồn để chọn Word. Nội dung hiện có vẫn giữ nguyên; mở lại bộ nguồn hoặc bổ sung đúng tệp có bằng chứng để tiếp tục chọn.</p>}
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
          {form.contentBinding && <p className="caption">Nguồn Excel: {form.contentBinding.mapping.sheet}, dòng {form.contentBinding.row}; cột tiêu đề {form.contentBinding.mapping.columns.title}, nội dung {form.contentBinding.mapping.columns.body}. {boundNewContent ? 'Đang lưu bản nguyên văn. Muốn sửa chữ, lưu bản này trước rồi mở chỉnh sửa, hoặc sửa Excel và chọn lại dòng.' : 'Khi sửa chữ, phần sửa được ghi nhận là lựa chọn thủ công; nguồn gốc vẫn giữ trong lịch sử.'}</p>}
          <p className="caption">
            Bạn cũng có thể dán nguyên văn vào các ô. Khoảng trắng và xuống dòng được giữ lại.
          </p>
          <label>
            Tiêu đề listing
            <input
              ref={titleInput}
              readOnly={!editable || boundNewContent}
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
              readOnly={!editable || boundNewContent}
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
              readOnly={!editable || boundNewContent}
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
          <div className="image-role-tabs" role="tablist" aria-label="Vị trí ảnh" onKeyDown={tabKeys}>
            <button
              id="image-role-cover"
              role="tab"
              aria-selected={imageRole === 'cover'}
              tabIndex={imageRole === 'cover' ? 0 : -1}
              aria-controls="image-role-panel"
              onClick={() => setImageRole('cover')}
            >
              Ảnh bìa <span>{form.coverId ? '1' : '0'}</span>
            </button>
            <button
              id="image-role-gallery"
              role="tab"
              aria-selected={imageRole === 'gallery'}
              tabIndex={imageRole === 'gallery' ? 0 : -1}
              aria-controls="image-role-panel"
              onClick={() => setImageRole('gallery')}
            >
              Ảnh listing <span>{form.galleryIds.length}</span>
            </button>
            <button
              id="image-role-description"
              role="tab"
              aria-selected={imageRole === 'description'}
              tabIndex={imageRole === 'description' ? 0 : -1}
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
                sourceImportIds={sourceImportIds}
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
                sourceImportIds={sourceImportIds}
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
                sourceImportIds={sourceImportIds}
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
                  sourceImportIds={sourceImportIds}
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
