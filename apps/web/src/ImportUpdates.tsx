import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowDown, ArrowUp, FileUp, FolderOpen } from 'lucide-react';
import type {
  ContentBlock,
  Issue,
  PatchPreview,
  PatchReceipt,
  PatchSelection,
  PatchWorkbook,
  WorkOrderView,
  WordImport,
} from '@shopee/domain';
import { api, date, media, money, post, RequestError, type ImportRecord } from './api.js';
import './import-updates.css';
import { ImportPatchTable } from './ImportPatchTable.js';
import { ImportWorkbookMapping, type WorkbookUse } from './ImportWorkbookMapping.js';

type Context = { workOrders: WorkOrderView[]; imports: ImportRecord[] };
type FileEntry = {
  key: string;
  name: string;
  relativePath: string;
  record?: ImportRecord;
  workbook?: PatchWorkbook;
  error?: string;
  file?: File;
};
type ImageRole = 'cover' | 'gallery' | 'descriptionImages' | 'variantImage';
type Assignment = {
  target: string;
  roles: ImageRole[];
  sku: string;
  title: number[];
  description: number[];
  separator: '\n' | '\n\n';
};
const blankAssignment = (): Assignment => ({
  target: '',
  roles: [],
  sku: '',
  title: [],
  description: [],
  separator: '\n',
});
const labels: Record<PatchPreview['operations'][number]['field'], string> = {
  price: 'Giá gốc',
  stock: 'Tồn đăng bán',
  title: 'Tiêu đề',
  description: 'Mô tả',
  cover: 'Ảnh bìa',
  gallery: 'Bộ ảnh sản phẩm',
  variantImage: 'Ảnh phân loại',
};
const roleLabels: Record<ImageRole, string> = {
  cover: 'Ảnh bìa',
  gallery: 'Bộ ảnh sản phẩm',
  descriptionImages: 'Ảnh trong mô tả',
  variantImage: 'Ảnh phân loại',
};
const targetLabel = (order: WorkOrderView) =>
  `${order.source.title.value} · ${order.shop?.name ?? 'Chưa chọn shop'} · ${order.config.itemId ?? 'Chưa có link'}`;
const pendingSaveKey = 'shopee.import-patch.pending-save';
type SaveRequest = {
  id: string;
  selection: PatchSelection;
  previewFingerprint: string;
  selectedOperationIds: string[];
};

export function SavedPatchList({
  workOrderId,
  onOpen,
}: {
  workOrderId?: string;
  onOpen: (id: string) => void;
}) {
  const [receipts, setReceipts] = useState<PatchReceipt[]>([]),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void api<PatchReceipt[]>('/v1/import-patches')
      .then((data) => {
        if (active) {
          setReceipts(data);
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [workOrderId]);
  const visible = receipts.filter(
    (row) =>
      !workOrderId || row.preview.targets.some((target) => target.workOrderId === workOrderId),
  );
  if (!visible.length && !failed) return null;
  return (
    <section className="patch-saved-list" aria-label="Bộ cập nhật đã lưu">
      <h2>Bộ cập nhật đã lưu</h2>
      {failed ? (
        <p>Chưa tải được bộ cập nhật đã lưu. Mở “Nhập bộ cập nhật” để tải lại.</p>
      ) : (
        visible.map((row) => (
          <article key={row.id}>
            <div>
              <strong>{row.name}</strong>
              <small>
                {row.selectedOperationIds.length} thay đổi · {row.preview.targets.length} công việc
                · {date(row.createdAt)}
              </small>
              <small>Chưa gửi lên Shopee</small>
            </div>
            <button onClick={() => onOpen(row.id)} aria-label={`Mở bộ cập nhật ${row.name}`}>
              Mở lại
            </button>
          </article>
        ))
      )}
    </section>
  );
}

export function ImportUpdates({
  initialWorkOrderId,
  initialReceiptId,
  onBack,
  onDirty,
  onBusy,
}: {
  initialWorkOrderId?: string;
  initialReceiptId?: string;
  onBack: () => void;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
}) {
  const [context, setContext] = useState<Context | null>(null),
    [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<string[]>(
    initialWorkOrderId ? [initialWorkOrderId] : [],
  );
  const [workbookMappings, setWorkbookMappings] = useState<Record<string, WorkbookUse[]>>({}),
    [assignments, setAssignments] = useState<Record<string, Assignment>>({});
  const [imageOrder, setImageOrder] = useState<string[]>([]),
    [roleOrders, setRoleOrders] = useState<Record<string, string[]>>({}),
    [layouts, setLayouts] = useState<Record<string, boolean>>({});
  const [imagePicks, setImagePicks] = useState<string[]>([]),
    [bulkTarget, setBulkTarget] = useState(''),
    [bulkRole, setBulkRole] = useState<ImageRole | ''>('');
  const [name, setName] = useState('Bộ cập nhật ' + new Date().toLocaleDateString('vi-VN'));
  const [preview, setPreview] = useState<PatchPreview | null>(null),
    [selectedOps, setSelectedOps] = useState<string[]>([]),
    [receipt, setReceipt] = useState<PatchReceipt | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [showUnchanged, setShowUnchanged] = useState(false);
  const [targetQuery, setTargetQuery] = useState(''),
    [shopFilter, setShopFilter] = useState(''),
    [fieldFilter, setFieldFilter] = useState('');
  const [reused, setReused] = useState(false),
    [listKey, setListKey] = useState(0);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const guard = useRef(false),
    alive = useRef(true),
    saveRequest = useRef<SaveRequest | null>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const dirty = (files.length > 0 && !receipt) || saveUncertain;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  useEffect(
    () => () => {
      alive.current = false;
      onBusy(false);
    },
    [onBusy],
  );
  async function load() {
    setLoading(true);
    try {
      setContext(await api<Context>('/v1/import-patches/context'));
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    let pending = false;
    try {
      const raw = sessionStorage.getItem(pendingSaveKey);
      if (raw) {
        const value = JSON.parse(raw) as SaveRequest;
        if (
          typeof value.id === 'string' &&
          typeof value.previewFingerprint === 'string' &&
          value.selection &&
          Array.isArray(value.selectedOperationIds)
        ) {
          saveRequest.current = value;
          setSaveUncertain(true);
          pending = true;
        }
      }
    } catch {
      setError(
        'Trình duyệt chưa đọc được lần lưu đang chờ. Kiểm tra danh sách bộ cập nhật đã lưu.',
      );
    }
    if (initialReceiptId && !pending) void openReceipt(initialReceiptId);
  }, []);
  function invalidate() {
    setPreview(null);
    setSelectedOps([]);
    setReceipt(null);
    saveRequest.current = null;
    setError('');
    setFieldFilter('');
  }
  function changeTargets(next: string[]) {
    invalidate();
    setSelectedTargets(next);
    setWorkbookMappings((current) =>
      Object.fromEntries(
        Object.entries(current).map(([key, uses]) => [
          key,
          uses.map((use) => ({
            ...use,
            workOrderIds: use.workOrderIds.filter((id) => next.includes(id)),
          })),
        ]),
      ),
    );
    setAssignments((current) =>
      Object.fromEntries(
        Object.entries(current).map(([key, value]) => [
          key,
          next.includes(value.target) ? value : { ...value, target: '' },
        ]),
      ),
    );
  }
  const targets = context?.workOrders.filter((order) => selectedTargets.includes(order.id)) ?? [];
  const choices = context?.workOrders.filter((order) => order.config.operation === 'update') ?? [];
  const patchableTargets = targets.filter((order) => !!order.config.itemId && !!order.shop);
  const assign = (key: string) => assignments[key] ?? blankAssignment();
  const workbookUses = (key: string): WorkbookUse[] =>
    workbookMappings[key] ?? [
      {
        id: 'primary',
        blockKey: '',
        workOrderIds: selectedTargets.length === 1 ? [selectedTargets[0]] : [],
      },
    ];
  function updateAssignment(key: string, next: Partial<Assignment>) {
    invalidate();
    setAssignments((current) => ({
      ...current,
      [key]: { ...(current[key] ?? blankAssignment()), ...next },
    }));
  }
  async function readFile(entry: FileEntry): Promise<FileEntry> {
    let record = entry.record;
    if (!record) {
      if (!entry.file) throw new Error('Chọn lại tệp chưa nhận được.');
      record = await api<ImportRecord>('/v1/imports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(entry.name),
        },
        body: entry.file,
      });
    }
    const received = record;
    setFiles((current) =>
      current.map((file) => (file.key === entry.key ? { ...file, record: received } : file)),
    );
    if (record.kind === 'xlsx')
      return {
        ...entry,
        file: undefined,
        record,
        workbook: await api<PatchWorkbook>('/v1/import-patches/workbooks/' + record.id),
        error: undefined,
      };
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      record = await api<ImportRecord>('/v1/imports/' + record.id);
      if (record.status === 'ready') return { ...entry, file: undefined, record, error: undefined };
      if (record.status === 'failed')
        throw new Error(record.message || 'Tệp chưa đọc được. Kiểm tra bản gốc rồi thử lại.');
      if (!alive.current) throw new Error('Đã rời màn hình nhập.');
      await new Promise((done) => setTimeout(done, 350));
    }
    return {
      ...entry,
      record,
      error: 'Đã nhận tệp, đang chờ bộ đọc. Bấm Đọc lại khi ứng dụng sẵn sàng.',
    };
  }
  async function upload(chosen: FileList | null) {
    if (!chosen?.length || guard.current) return;
    guard.current = true;
    setBusy(true);
    invalidate();
    const pending = Array.from(chosen, (file) => ({
      key: crypto.randomUUID(),
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      file,
    }));
    setFiles((current) => [...current, ...pending]);
    setImageOrder((current) => [...current, ...pending.map((file) => file.key)]);
    try {
      for (const entry of pending) {
        try {
          const loaded = await readFile(entry);
          setFiles((current) => current.map((file) => (file.key === entry.key ? loaded : file)));
        } catch (cause) {
          setFiles((current) =>
            current.map((file) =>
              file.key === entry.key ? { ...file, error: (cause as Error).message } : file,
            ),
          );
        }
      }
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function retry(entry: FileEntry) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    invalidate();
    try {
      const loaded = await readFile(entry);
      setFiles((current) => current.map((file) => (file.key === entry.key ? loaded : file)));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  function makeSelection(): PatchSelection {
    if (!patchableTargets.length || patchableTargets.length !== targets.length)
      throw new Error('Chọn công việc đã xác định đúng shop và link cần cập nhật.');
    const ready = files.filter((file) => file.record && !file.error),
      contents: PatchSelection['contents'] = [];
    const content = (target: string) => {
      let row = contents.find((value) => value.workOrderId === target);
      if (!row) {
        row = { workOrderId: target };
        contents.push(row);
      }
      return row;
    };
    for (const key of imageOrder) {
      const file = ready.find((value) => value.key === key);
      if (!file?.record || file.record.kind === 'xlsx') continue;
      const mapping = assign(key),
        hasWord = mapping.title.length || mapping.description.length;
      if (!mapping.roles.length && !hasWord) continue;
      if (!selectedTargets.includes(mapping.target))
        throw new Error(`Chọn đúng công việc cho ${file.name}.`);
      const row = content(mapping.target);
      if (file.record.kind === 'docx' && hasWord) {
        if (row.word)
          throw new Error(
            'Một công việc đang chọn nội dung từ nhiều Word. Chọn đúng một tệp cho lần cập nhật này.',
          );
        row.word = {
          importId: file.record.id,
          separator: mapping.separator,
          ...(mapping.title.length ? { titleParagraphs: mapping.title } : {}),
          ...(mapping.description.length ? { descriptionParagraphs: mapping.description } : {}),
        };
      }
      if (file.record.kind === 'image') {
        if (mapping.roles.includes('cover')) {
          if (row.coverImportId)
            throw new Error('Một công việc đang chọn nhiều ảnh bìa. Giữ đúng một ảnh.');
          row.coverImportId = file.record.id;
        }
        if (mapping.roles.includes('gallery')) {
          row.gallery ??= { mode: 'replace', importIds: [] };
          row.gallery.importIds.push(file.record.id);
        }
        if (mapping.roles.includes('descriptionImages')) {
          row.descriptionImages ??= { mode: 'replace', importIds: [] };
          row.descriptionImages.importIds.push(file.record.id);
        }
        if (mapping.roles.includes('variantImage')) {
          if (!mapping.sku) throw new Error(`Chọn SKU cho ảnh ${file.name}.`);
          row.variantImages ??= [];
          row.variantImages.push({ sku: mapping.sku, importId: file.record.id });
        }
      }
    }
    for (const row of contents) {
      if (layouts[row.workOrderId] && row.word?.descriptionParagraphs?.length)
        row.descriptionLayout = 'images_after_first_paragraph';
      for (const role of ['gallery', 'descriptionImages'] as const)
        if (row[role])
          row[role].importIds = imagesForRole(row.workOrderId, role).map(
            (key) => ready.find((file) => file.key === key)!.record!.id,
          );
    }
    const workbooks: PatchSelection['workbooks'] = [];
    for (const file of ready.filter((value) => value.record?.kind === 'xlsx')) {
      for (const use of workbookUses(file.key)) {
        const block = file.workbook?.blocks.find((value) => value.key === use.blockKey);
        if (!block)
          throw new Error(`Chọn sheet và bộ giá trong ${file.name}, hoặc bỏ tệp khỏi đợt này.`);
        if (
          !use.workOrderIds.length ||
          use.workOrderIds.some((id) => !selectedTargets.includes(id))
        )
          throw new Error(
            `Chọn rõ công việc áp dụng cho ${block.priceProfile ?? block.sheet} trong ${file.name}.`,
          );
        workbooks.push({
          importId: file.record!.id,
          sheet: block.sheet,
          blockKey: block.key,
          workOrderIds: use.workOrderIds,
          fields: block.fields.filter(
            (field): field is 'price' | 'stock' => field === 'price' || field === 'stock',
          ),
        });
      }
    }
    if (!workbooks.length && !contents.length)
      throw new Error('Chọn phần dữ liệu trong Excel, Word hoặc ảnh cần cập nhật.');
    return {
      name,
      workOrders: targets.map((order) => ({ id: order.id, revision: order.revision })),
      fileRefs: ready.map((file) => ({
        importId: file.record!.id,
        relativePath: file.relativePath,
      })),
      workbooks,
      contents,
    };
  }
  async function check() {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await post<PatchPreview>('/v1/import-patches/preview', makeSelection());
      setPreview(result);
      setSelectedOps(
        result.operations
          .filter(
            (op) =>
              op.state === 'changed' && !op.issues.some((issue) => issue.severity === 'block'),
          )
          .map((op) => op.id),
      );
      setReceipt(null);
      saveRequest.current = null;
      setTimeout(() => previewHeading.current?.focus(), 0);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (guard.current || (!saveRequest.current && (!preview || !selectedOps.length))) return;
    guard.current = true;
    setBusy(true);
    setError('');
    saveRequest.current ??= {
      id: crypto.randomUUID(),
      selection: preview!.selection,
      previewFingerprint: preview!.fingerprint,
      selectedOperationIds: [...selectedOps],
    };
    try {
      sessionStorage.setItem(pendingSaveKey, JSON.stringify(saveRequest.current));
      const result = await post<{ receipt: PatchReceipt; reused: boolean }>(
        '/v1/import-patches',
        saveRequest.current,
      );
      sessionStorage.removeItem(pendingSaveKey);
      saveRequest.current = null;
      setSaveUncertain(false);
      setReceipt(result.receipt);
      setPreview(result.receipt.preview);
      setSelectedOps(result.receipt.selectedOperationIds);
      setReused(result.reused);
      setListKey((value) => value + 1);
      onDirty(false);
    } catch (cause) {
      const uncertain =
        cause instanceof RequestError &&
        (['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(cause.code) ||
          (cause.status ?? 0) >= 500);
      setSaveUncertain(uncertain);
      setError((cause as Error).message);
      if (!uncertain) {
        saveRequest.current = null;
        sessionStorage.removeItem(pendingSaveKey);
      }
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function openReceipt(id: string) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<PatchReceipt>('/v1/import-patches/' + id);
      setReceipt(result);
      setPreview(result.preview);
      setSelectedOps(result.selectedOperationIds);
      setName(result.name);
      setReused(false);
      onDirty(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  function reset() {
    invalidate();
    setFiles([]);
    setWorkbookMappings({});
    setAssignments({});
    setImageOrder([]);
    setRoleOrders({});
    setImagePicks([]);
    setLayouts({});
    setSelectedTargets(initialWorkOrderId ? [initialWorkOrderId] : []);
    setReused(false);
  }
  function imagesForRole(target: string, role: 'gallery' | 'descriptionImages') {
    const keys = imageOrder.filter((key) => {
      const mapping = assign(key);
      return (
        mapping.target === target &&
        mapping.roles.includes(role) &&
        files.some((file) => file.key === key && file.record?.kind === 'image' && !file.error)
      );
    });
    const explicit = roleOrders[JSON.stringify([target, role])] ?? [];
    return [
      ...explicit.filter((key) => keys.includes(key)),
      ...keys.filter((key) => !explicit.includes(key)),
    ];
  }
  function moveRoleImage(
    target: string,
    role: 'gallery' | 'descriptionImages',
    key: string,
    direction: number,
  ) {
    invalidate();
    const next = imagesForRole(target, role),
      index = next.indexOf(key),
      destination = index + direction;
    if (index < 0 || destination < 0 || destination >= next.length) return;
    [next[index], next[destination]] = [next[destination], next[index]];
    setRoleOrders((current) => ({ ...current, [JSON.stringify([target, role])]: next }));
  }
  function applyImageGroup() {
    if (
      !selectedTargets.includes(bulkTarget) ||
      !bulkRole ||
      !imagePicks.length ||
      (bulkRole === 'cover' && imagePicks.length !== 1)
    )
      return;
    invalidate();
    setAssignments((current) => {
      const next = { ...current };
      for (const key of imagePicks)
        next[key] = {
          ...(next[key] ?? blankAssignment()),
          target: bulkTarget,
          roles:
            next[key]?.target === bulkTarget
              ? [...new Set([...(next[key]?.roles ?? []), bulkRole])]
              : [bulkRole],
          sku: next[key]?.target === bulkTarget ? next[key].sku : '',
        };
      return next;
    });
    setImagePicks([]);
  }
  const visibleOps =
    preview?.operations.filter(
      (op) =>
        (receipt
          ? receipt.selectedOperationIds.includes(op.id)
          : showUnchanged || op.state !== 'unchanged') &&
        (!fieldFilter || op.field === fieldFilter),
    ) ?? [];
  const selectableVisibleIds = visibleOps
    .filter(
      (op) => op.state === 'changed' && !op.issues.some((issue) => issue.severity === 'block'),
    )
    .map((op) => op.id);
  const selectedVisibleIds = selectableVisibleIds.filter((id) => selectedOps.includes(id));
  function selectVisible(checked: boolean) {
    if (busy || saveUncertain || receipt) return;
    saveRequest.current = null;
    setSelectedOps((current) =>
      checked
        ? [...new Set([...current, ...selectableVisibleIds])]
        : current.filter((id) => !selectableVisibleIds.includes(id)),
    );
  }
  const assignedImageFiles = imageOrder
    .map((key) => files.find((file) => file.key === key))
    .filter(
      (file): file is FileEntry =>
        !!file && file.record?.kind === 'image' && file.record.status === 'ready',
    );
  const unavailableFiles = files.some((file) => !!file.error || !file.record);
  return (
    <div className="import-updates">
      <button className="back-link" disabled={busy || saveUncertain} onClick={onBack}>
        <ArrowLeft size={16} /> Về công việc
      </button>
      <header className="patch-heading">
        <div>
          <h1>Nhập bộ cập nhật</h1>
          <p>
            Nhận bảng giá/tồn, Word và ảnh mới. Phần không có trong bộ cập nhật được giữ nguyên.
          </p>
        </div>
        <span className="patch-local">Chuẩn bị nội bộ</span>
      </header>
      {error && (
        <div className="banner error" role="alert">
          {error}
          <button disabled={busy} onClick={() => void load()}>
            Tải lại dữ liệu công việc
          </button>
        </div>
      )}
      {saveUncertain && (
        <div className="banner" role="alert">
          <div>
            <strong>Chưa xác nhận được lần lưu trước.</strong>
            <p>
              Giữ nguyên lựa chọn và xác nhận lại bằng đúng mã lần lưu. Ứng dụng sẽ tìm biên nhận đã
              có trước khi tạo mới.
            </p>
          </div>
          <button disabled={busy} onClick={() => void save()}>
            Xác nhận lại lần lưu trước
          </button>
        </div>
      )}
      {loading && !context ? (
        <p role="status">Đang lấy công việc và nguồn đã lưu…</p>
      ) : !context ? (
        <button onClick={() => void load()}>Tải lại</button>
      ) : (
        <>
          {!receipt && !preview && !saveUncertain && (
            <>
              <section className="patch-section" aria-label="Dữ liệu cập nhật">
                <div className="section-heading">
                  <div>
                    <h2>1. Nhận dữ liệu mới</h2>
                    <p>Chọn tệp riêng hoặc thư mục có nhiều bộ. Chỉ nhập phần muốn thay đổi.</p>
                  </div>
                  <div className="patch-upload-buttons">
                    <label className="patch-file-button">
                      <FileUp size={17} />
                      Chọn tệp
                      <input
                        aria-label="Chọn tệp cập nhật"
                        type="file"
                        multiple
                        accept=".xlsx,.docx,.png,.jpg,.jpeg,.webp"
                        disabled={busy}
                        onChange={(event) => {
                          void upload(event.target.files);
                          event.target.value = '';
                        }}
                      />
                    </label>
                    <label className="patch-file-button">
                      <FolderOpen size={17} />
                      Chọn thư mục
                      <input
                        aria-label="Chọn thư mục cập nhật"
                        type="file"
                        multiple
                        {...({ webkitdirectory: '' } as Record<string, string>)}
                        disabled={busy}
                        onChange={(event) => {
                          void upload(event.target.files);
                          event.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                </div>
                <label className="patch-batch-name">
                  Tên bộ cập nhật
                  <input
                    value={name}
                    disabled={busy}
                    onChange={(event) => {
                      invalidate();
                      setName(event.target.value);
                    }}
                  />
                </label>
                {!files.length ? (
                  <p className="patch-empty">
                    Excel có thể chỉ gồm SKU và giá hoặc tồn. Word và ảnh dùng bộ bạn đã chuẩn bị.
                  </p>
                ) : (
                  <ul className="patch-file-list">
                    {files.map((file) => (
                      <li key={file.key}>
                        <div>
                          <strong>{file.name}</strong>
                          <small>{file.relativePath}</small>
                          {file.error && <span className="error">{file.error}</span>}
                        </div>
                        <span>
                          {file.error
                            ? 'Cần xử lý'
                            : (file.record?.kind === 'xlsx' && file.workbook) ||
                                file.record?.status === 'ready'
                              ? 'Đã đọc'
                              : 'Đang nhận / đọc…'}
                        </span>
                        <button
                          disabled={busy}
                          onClick={() => {
                            invalidate();
                            setFiles((current) =>
                              current.filter((value) => value.key !== file.key),
                            );
                          }}
                          aria-label={`Bỏ tệp ${file.name}`}
                        >
                          Bỏ khỏi đợt
                        </button>
                        {file.error && (
                          <button disabled={busy} onClick={() => void retry(file)}>
                            Đọc lại
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="patch-section" aria-label="Chọn nơi cập nhật">
                <h2>2. Xác định công việc và nguồn</h2>
                <p>
                  Chọn đúng link đã được liên kết trong công việc. Bảng giá áp dụng cho các công
                  việc được chọn, theo SKU khớp chính xác.
                </p>
                <div className="patch-target-filters">
                  <label>
                    Shop
                    <select
                      aria-label="Lọc shop cập nhật"
                      value={shopFilter}
                      onChange={(event) => setShopFilter(event.target.value)}
                    >
                      <option value="">Tất cả shop</option>
                      {[
                        ...new Map(
                          choices
                            .filter((order) => order.shop)
                            .map((order) => [order.shop!.id, order.shop!]),
                        ).values(),
                      ].map((shop) => (
                        <option key={shop.id} value={shop.id}>
                          {shop.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Tìm listing hoặc SKU
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      placeholder="Tên, SKU hoặc mã link"
                    />
                  </label>
                </div>
                <div className="patch-targets">
                  {choices
                    .filter(
                      (order) =>
                        (!shopFilter || order.shop?.id === shopFilter) &&
                        `${order.source.title.value} ${order.config.itemId} ${order.source.variants.map((v) => v.sku.value).join(' ')}`
                          .toLocaleLowerCase('vi')
                          .includes(targetQuery.toLocaleLowerCase('vi')),
                    )
                    .map((order) => (
                      <label key={order.id} className="patch-target">
                        <input
                          type="checkbox"
                          aria-label={`Chọn công việc ${order.source.title.value}`}
                          disabled={busy || !order.shop || !order.config.itemId}
                          checked={selectedTargets.includes(order.id)}
                          onChange={(event) =>
                            changeTargets(
                              event.target.checked
                                ? [...selectedTargets, order.id]
                                : selectedTargets.filter((id) => id !== order.id),
                            )
                          }
                        />
                        <span>
                          <strong>{order.source.title.value}</strong>
                          <small>
                            {order.shop?.name ?? 'Chưa chọn shop'} ·{' '}
                            {order.shop?.scope.environment === 'production'
                              ? 'SHOP THẬT / CHỈ ĐỌC'
                              : 'SANDBOX'}{' '}
                            · Link {order.config.itemId ?? 'chưa xác định'} ·{' '}
                            {order.source.variants.length} SKU
                          </small>
                          {order.sandboxRun &&
                            ['unknown', 'in_flight'].includes(order.sandboxRun.state) && (
                              <small className="error">
                                Lần gửi trước chưa rõ kết quả. Có thể lưu đề xuất; cần phục hồi
                                trước thực thi.
                              </small>
                            )}
                        </span>
                      </label>
                    ))}
                </div>
                {!choices.length && (
                  <p>
                    Chưa có công việc cập nhật. Về Công việc để liên kết bộ nguồn với đúng shop và
                    link.
                  </p>
                )}
                {files
                  .filter((file) => file.workbook)
                  .map((file) => (
                    <ImportWorkbookMapping
                      key={file.key}
                      name={file.name}
                      workbook={file.workbook!}
                      uses={workbookUses(file.key)}
                      targets={patchableTargets}
                      busy={busy}
                      onChange={(uses) => {
                        invalidate();
                        setWorkbookMappings((current) => ({ ...current, [file.key]: uses }));
                      }}
                    />
                  ))}
                {files
                  .filter((file) => file.record?.kind === 'docx' && file.record.body)
                  .map((file) => {
                    const mapping = assign(file.key),
                      paragraphs = (file.record!.body as WordImport).paragraphs;
                    return (
                      <div className="patch-word" key={file.key}>
                        <h3>{file.name}</h3>
                        <TargetSelect
                          file={file}
                          value={mapping.target}
                          targets={patchableTargets}
                          busy={busy}
                          onChange={(target) => updateAssignment(file.key, { target })}
                        />
                        <p>
                          Chọn nguyên đoạn muốn dùng. Không chọn tiêu đề nếu chỉ cập nhật mô tả.
                        </p>
                        <div className="patch-paragraphs">
                          {paragraphs.map((text, index) => (
                            <div key={index} className="patch-paragraph">
                              <span className="patch-paragraph-number">{index + 1}</span>
                              <pre>{text || ' '}</pre>
                              <div>
                                {(['title', 'description'] as const).map((role) => (
                                  <label key={role}>
                                    <input
                                      type="checkbox"
                                      aria-label={`${role === 'title' ? 'Tiêu đề' : 'Mô tả'}: đoạn ${index + 1} của ${file.name}`}
                                      disabled={busy}
                                      checked={mapping[role].includes(index)}
                                      onChange={(event) =>
                                        updateAssignment(file.key, {
                                          [role]: event.target.checked
                                            ? [...mapping[role], index].sort((a, b) => a - b)
                                            : mapping[role].filter((value) => value !== index),
                                        })
                                      }
                                    />
                                    {role === 'title' ? 'Tiêu đề' : 'Mô tả'}
                                  </label>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                        <label>
                          Cách xuống dòng giữa các đoạn
                          <select
                            value={mapping.separator}
                            disabled={busy}
                            onChange={(event) =>
                              updateAssignment(file.key, {
                                separator: event.target.value as Assignment['separator'],
                              })
                            }
                          >
                            <option value={'\n'}>Xuống dòng</option>
                            <option value={'\n\n'}>Thêm một dòng trống</option>
                          </select>
                        </label>
                      </div>
                    );
                  })}
                {assignedImageFiles.length > 0 && (
                  <div className="patch-media">
                    <h3>Ảnh vừa nhập</h3>
                    <p>
                      Chọn vai trò của ảnh. Nếu thay gallery, các ảnh đánh dấu “Bộ ảnh sản phẩm” sẽ
                      thay toàn bộ gallery theo thứ tự dưới đây.
                    </p>
                    <p className="muted">
                      Mỗi tệp đang gắn với một công việc. Gán nhóm sang công việc khác sẽ bỏ các vai
                      trò và SKU cũ của tệp; cùng công việc sẽ thêm vai trò.
                    </p>
                    <div className="patch-bulk-images">
                      <label>
                        Công việc cho nhóm ảnh
                        <select
                          aria-label="Công việc cho nhóm ảnh"
                          value={bulkTarget}
                          disabled={busy}
                          onChange={(event) => setBulkTarget(event.target.value)}
                        >
                          <option value="">Chọn listing nhận nhóm ảnh</option>
                          {patchableTargets.map((order) => (
                            <option key={order.id} value={order.id}>
                              {targetLabel(order)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Thêm vai trò
                        <select
                          aria-label="Vai trò cho nhóm ảnh"
                          value={bulkRole}
                          disabled={busy}
                          onChange={(event) => setBulkRole(event.target.value as ImageRole | '')}
                        >
                          <option value="">Chọn vai trò</option>
                          <option value="cover">Ảnh bìa (chọn 1 ảnh)</option>
                          <option value="gallery">Bộ ảnh sản phẩm — thay cả bộ</option>
                          <option value="descriptionImages">
                            Ảnh trong mô tả — thay cả bộ ảnh
                          </option>
                        </select>
                      </label>
                      <button
                        disabled={
                          busy ||
                          !bulkRole ||
                          !selectedTargets.includes(bulkTarget) ||
                          !imagePicks.length ||
                          (bulkRole === 'cover' && imagePicks.length !== 1)
                        }
                        onClick={applyImageGroup}
                      >
                        Gán cho {imagePicks.length} ảnh đã chọn
                      </button>
                      <p>
                        Có thể dùng cùng ảnh ở nhiều vai trò. Gán thêm vai trò không bỏ vai trò đã
                        chọn.
                      </p>
                    </div>
                    <label className="patch-image-pick">
                      <input
                        type="checkbox"
                        aria-label="Chọn tất cả ảnh"
                        disabled={busy}
                        checked={
                          assignedImageFiles.length > 0 &&
                          assignedImageFiles.every((file) => imagePicks.includes(file.key))
                        }
                        onChange={(event) =>
                          setImagePicks(
                            event.target.checked ? assignedImageFiles.map((file) => file.key) : [],
                          )
                        }
                      />
                      Chọn tất cả ảnh ({assignedImageFiles.length})
                    </label>
                    <div className="patch-image-grid">
                      {assignedImageFiles.map((file, index) => {
                        const mapping = assign(file.key),
                          target = targets.find((order) => order.id === mapping.target);
                        return (
                          <article key={file.key} className="patch-image-card">
                            <label className="patch-image-pick">
                              <input
                                type="checkbox"
                                aria-label={`Chọn ảnh ${file.name}`}
                                disabled={busy}
                                checked={imagePicks.includes(file.key)}
                                onChange={(event) =>
                                  setImagePicks((current) =>
                                    event.target.checked
                                      ? [...current, file.key]
                                      : current.filter((key) => key !== file.key),
                                  )
                                }
                              />
                              Chọn ảnh
                            </label>
                            <img src={media(file.record!.id)} alt={file.name} />
                            <strong>{file.name}</strong>
                            <TargetSelect
                              file={file}
                              value={mapping.target}
                              targets={patchableTargets}
                              busy={busy}
                              onChange={(target) => updateAssignment(file.key, { target, sku: '' })}
                            />
                            <label>
                              Thêm vai trò
                              <select
                                aria-label={`Vai trò ${file.name}`}
                                value=""
                                disabled={busy}
                                onChange={(event) =>
                                  updateAssignment(file.key, {
                                    roles: [
                                      ...new Set([
                                        ...mapping.roles,
                                        event.target.value as ImageRole,
                                      ]),
                                    ],
                                  })
                                }
                              >
                                <option value="">Chọn vai trò để thêm</option>
                                <option value="cover">Ảnh bìa</option>
                                <option value="gallery">Bộ ảnh sản phẩm — thay cả bộ</option>
                                <option value="descriptionImages">
                                  Ảnh trong mô tả — thay cả bộ ảnh
                                </option>
                                <option value="variantImage">Ảnh phân loại</option>
                              </select>
                            </label>
                            <div className="patch-role-tags">
                              {mapping.roles.map((role) => (
                                <span key={role}>
                                  {roleLabels[role]}
                                  <button
                                    disabled={busy}
                                    aria-label={`Bỏ ${roleLabels[role]} của ${file.name}`}
                                    onClick={() =>
                                      updateAssignment(file.key, {
                                        roles: mapping.roles.filter((value) => value !== role),
                                      })
                                    }
                                  >
                                    ×
                                  </button>
                                </span>
                              ))}
                            </div>
                            {mapping.roles.includes('variantImage') && (
                              <label>
                                SKU
                                <select
                                  aria-label={`SKU cho ${file.name}`}
                                  value={mapping.sku}
                                  disabled={busy}
                                  onChange={(event) =>
                                    updateAssignment(file.key, { sku: event.target.value })
                                  }
                                >
                                  <option value="">Chọn đúng phân loại</option>
                                  {target?.source.variants.map((variant) => (
                                    <option key={variant.key} value={variant.sku.value}>
                                      {variant.sku.value} · {variant.optionLabels.join(' / ')}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                          </article>
                        );
                      })}
                    </div>
                    <div className="patch-role-orders">
                      {targets.flatMap((order) =>
                        (['gallery', 'descriptionImages'] as const).map((role) => {
                          const keys = imagesForRole(order.id, role);
                          if (!keys.length) return null;
                          return (
                            <section
                              key={JSON.stringify([order.id, role])}
                              className="patch-role-order"
                              aria-label={`Thứ tự ${roleLabels[role]} của ${order.source.title.value}`}
                            >
                              <strong>
                                {roleLabels[role]} · {order.source.title.value}
                              </strong>
                              <small>
                                {order.shop?.name} · Link {order.config.itemId} · Thứ tự riêng cho
                                phần này
                              </small>
                              <ol>
                                {keys.map((key, index) => {
                                  const file = files.find((file) => file.key === key)!;
                                  return (
                                    <li key={key}>
                                      <span>{index + 1}</span>
                                      <img src={media(file.record!.id)} alt="" />
                                      <span>{file.name}</span>
                                      <button
                                        aria-label={`Đưa ${file.name} lên trước trong ${roleLabels[role]} của ${order.source.title.value}`}
                                        disabled={busy || index === 0}
                                        onClick={() => moveRoleImage(order.id, role, key, -1)}
                                      >
                                        <ArrowUp size={16} />
                                      </button>
                                      <button
                                        aria-label={`Đưa ${file.name} xuống sau trong ${roleLabels[role]} của ${order.source.title.value}`}
                                        disabled={busy || index === keys.length - 1}
                                        onClick={() => moveRoleImage(order.id, role, key, 1)}
                                      >
                                        <ArrowDown size={16} />
                                      </button>
                                    </li>
                                  );
                                })}
                              </ol>
                            </section>
                          );
                        }),
                      )}
                    </div>
                  </div>
                )}
                {targets
                  .filter((order) =>
                    files.some((file) => {
                      const mapping = assign(file.key);
                      return (
                        mapping.target === order.id &&
                        file.record?.kind === 'docx' &&
                        mapping.description.length > 0 &&
                        (order.source.description.some((block) => block.type === 'image') ||
                          files.some(
                            (image) =>
                              assign(image.key).target === order.id &&
                              assign(image.key).roles.includes('descriptionImages'),
                          ))
                      );
                    }),
                  )
                  .map((order) => (
                    <label className="patch-layout" key={order.id}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={!!layouts[order.id]}
                        onChange={(event) => {
                          invalidate();
                          setLayouts((current) => ({
                            ...current,
                            [order.id]: event.target.checked,
                          }));
                        }}
                      />
                      <span>
                        Với {order.source.title.value}: đặt bộ ảnh mô tả sau đoạn mở đầu, trước phần
                        chữ còn lại.
                        <small>
                          Áp dụng cho các đoạn Word đã chọn. Ảnh mô tả sẽ giữ thứ tự riêng đã chọn ở
                          trên.
                        </small>
                      </span>
                    </label>
                  ))}
                <div className="patch-actions">
                  <button
                    className="primary"
                    disabled={busy || !files.length || !targets.length || unavailableFiles}
                    onClick={() => void check()}
                  >
                    {busy ? 'Đang xử lý…' : 'Xem thay đổi'}
                  </button>
                  <span>Chưa gửi lên Shopee</span>
                </div>
              </section>
            </>
          )}
          {preview && (
            <section className="patch-section patch-preview" aria-label="Bản thay đổi">
              <div className="section-heading">
                <div>
                  <h2 tabIndex={-1} ref={previewHeading}>
                    {receipt ? 'Đã lưu bộ cập nhật' : 'Kiểm tra thay đổi'}
                  </h2>
                  <p>
                    {receipt
                      ? `${receipt.name} · ${date(receipt.createdAt)}`
                      : 'Đối chiếu với bản nguồn đã lưu. Chưa đọc dữ liệu hiện tại trên Shopee.'}
                  </p>
                </div>
                {receipt ? (
                  <button onClick={reset} disabled={busy}>
                    Nhập bộ khác
                  </button>
                ) : (
                  <button disabled={busy || saveUncertain} onClick={invalidate}>
                    Điều chỉnh nguồn hoặc đích
                  </button>
                )}
              </div>
              {receipt && (
                <p className="patch-receipt-note" role="status">
                  {reused
                    ? 'Đã tìm thấy biên nhận của cùng bộ thay đổi. '
                    : 'Đã lưu đề xuất trong ứng dụng. '}
                  Chưa gửi lên Shopee
                </p>
              )}
              <div className="patch-preview-targets">
                {preview.targets.map((target) => (
                  <span key={target.workOrderId}>
                    {target.title} · {target.shopName} ·{' '}
                    {target.environment === 'production' ? 'CHỈ ĐỌC' : 'SANDBOX'} · Link{' '}
                    {target.itemId}
                  </span>
                ))}
              </div>
              <SourceIssues issues={preview.issues} />
              {!receipt && (
                <div className="patch-filter-row">
                  <label>
                    Lọc trường
                    <select
                      value={fieldFilter}
                      onChange={(event) => setFieldFilter(event.target.value)}
                    >
                      <option value="">Tất cả thay đổi</option>
                      {[...new Set(preview.operations.map((op) => op.field))].map((field) => (
                        <option key={field} value={field}>
                          {labels[field]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={showUnchanged}
                      onChange={(event) => setShowUnchanged(event.target.checked)}
                    />
                    Hiện {preview.operations.filter((op) => op.state === 'unchanged').length} phần
                    giữ nguyên
                  </label>
                  <span>{selectedOps.length} thay đổi được chọn</span>
                  <button
                    disabled={
                      busy ||
                      saveUncertain ||
                      selectableVisibleIds.length === selectedVisibleIds.length
                    }
                    onClick={() => selectVisible(true)}
                  >
                    Chọn {selectableVisibleIds.length} thay đổi đang hiển thị
                  </button>
                  <button
                    disabled={busy || saveUncertain || !selectedVisibleIds.length}
                    onClick={() => selectVisible(false)}
                  >
                    Bỏ chọn {selectedVisibleIds.length} thay đổi đang hiển thị
                  </button>
                </div>
              )}
              <div className="patch-operations">
                <ImportPatchTable
                  operations={visibleOps.filter((operation) =>
                    ['price', 'stock', 'title'].includes(operation.field),
                  )}
                  targets={preview.targets}
                  selected={selectedOps}
                  readOnly={!!receipt}
                  disabled={busy || saveUncertain}
                  labels={labels}
                  onToggle={(id, checked) => {
                    saveRequest.current = null;
                    setSelectedOps((current) =>
                      checked ? [...current, id] : current.filter((value) => value !== id),
                    );
                  }}
                  renderValue={(operation, value) => (
                    <OperationValue operation={operation} value={value} />
                  )}
                />
                {visibleOps
                  .filter((operation) => !['price', 'stock', 'title'].includes(operation.field))
                  .map((operation) => {
                    const label =
                      labels[operation.field] + (operation.sku ? ' · ' + operation.sku : '');
                    return (
                      <article
                        key={operation.id}
                        className="patch-operation"
                        data-testid="patch-operation"
                      >
                        <div className="patch-operation-title">
                          {!receipt && (
                            <input
                              type="checkbox"
                              aria-label={`Chọn thay đổi ${label}`}
                              disabled={
                                busy ||
                                saveUncertain ||
                                operation.state !== 'changed' ||
                                operation.issues.some((issue) => issue.severity === 'block')
                              }
                              checked={selectedOps.includes(operation.id)}
                              onChange={(event) => {
                                saveRequest.current = null;
                                setSelectedOps((current) =>
                                  event.target.checked
                                    ? [...current, operation.id]
                                    : current.filter((id) => id !== operation.id),
                                );
                              }}
                            />
                          )}
                          <div>
                            <strong>{label}</strong>
                            <small>
                              {(() => {
                                const target = preview.targets.find(
                                  (target) => target.workOrderId === operation.workOrderId,
                                );
                                return `${target?.title} · ${target?.shopName} · Link ${target?.itemId} · ${target?.environment === 'production' ? 'SHOP THẬT / CHỈ ĐỌC' : 'SANDBOX'}`;
                              })()}
                            </small>
                          </div>
                          <span>
                            {operation.state === 'blocked'
                              ? 'Cần xử lý'
                              : operation.state === 'unchanged'
                                ? 'Giữ nguyên'
                                : 'Có thay đổi'}
                          </span>
                        </div>
                        <div className="patch-before-after">
                          <div>
                            <small>Bản nguồn đã lưu</small>
                            <OperationValue operation={operation} value={operation.before} />
                          </div>
                          <div>
                            <small>Theo tệp mới</small>
                            <div data-testid="patch-after">
                              <OperationValue operation={operation} value={operation.after} />
                            </div>
                          </div>
                        </div>
                        <SourceIssues issues={operation.issues} />
                        <details>
                          <summary>Xem nguồn đối chiếu</summary>
                          {operation.sources.map((source, index) => (
                            <p key={index}>
                              {source.filename} · {source.locator}
                            </p>
                          ))}
                        </details>
                      </article>
                    );
                  })}
              </div>
              {!visibleOps.length && <p>Không có thay đổi trong phần đang xem.</p>}
              {preview.executionBlockers.length > 0 && (
                <details className="patch-execution-limits">
                  <summary>
                    Điều kiện thực thi chưa hoàn tất ({preview.executionBlockers.length})
                  </summary>
                  {preview.executionBlockers.map((blocker, index) => (
                    <p key={index}>{blocker.message}</p>
                  ))}
                </details>
              )}
              <p className="patch-local-note">
                Bộ cập nhật này chỉ được chuẩn bị và lưu. Chưa có bước gửi, đọc lại hoặc nghiệm thu
                Shopee cho bộ này.
              </p>
              {!receipt && (
                <div className="patch-save">
                  <strong>{preview.selection.name}</strong>
                  <button
                    className="primary"
                    disabled={busy || saveUncertain || !selectedOps.length}
                    onClick={() => void save()}
                  >
                    {busy
                      ? 'Đang lưu…'
                      : `Lưu ${selectedOps.length} thay đổi cho ${new Set(preview.operations.filter((op) => selectedOps.includes(op.id)).map((op) => op.workOrderId)).size} công việc`}
                  </button>
                  <small>Lưu trong ứng dụng. Chưa gửi lên Shopee.</small>
                </div>
              )}
            </section>
          )}
          <SavedPatchList
            key={listKey}
            onOpen={(id) => {
              if (dirty && !receipt) {
                setError('Lưu bộ đang làm hoặc bỏ các tệp đang nhập trước khi mở bộ khác.');
                return;
              }
              void openReceipt(id);
            }}
          />
        </>
      )}
    </div>
  );
}

function TargetSelect({
  file,
  value,
  targets,
  busy,
  onChange,
}: {
  file: FileEntry;
  value: string;
  targets: WorkOrderView[];
  busy: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <label>
      Công việc
      <select
        aria-label={`Công việc cho ${file.name}`}
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Chọn listing nhận dữ liệu này</option>
        {targets.map((order) => (
          <option key={order.id} value={order.id}>
            {targetLabel(order)}
          </option>
        ))}
      </select>
    </label>
  );
}
function SourceIssues({ issues }: { issues: Issue[] }) {
  return issues.length ? (
    <ul className="patch-issues">
      {issues.map((issue, index) => (
        <li key={index} className={issue.severity === 'block' ? 'error' : ''}>
          <strong>{issue.severity === 'block' ? 'Cần xử lý' : 'Lưu ý'}: </strong>
          {issue.message}
          {issue.sources.map((source, i) => (
            <small key={i}>
              {source.filename} · {source.locator}
            </small>
          ))}
        </li>
      ))}
    </ul>
  ) : null;
}
function OperationValue({
  operation,
  value,
}: {
  operation: PatchPreview['operations'][number];
  value: unknown;
}): ReactNode {
  if (value === null || value === undefined)
    return <span className="patch-unset">Chưa có giá trị trong nguồn đã lưu</span>;
  if (operation.field === 'price') return <strong>{money(String(value))}</strong>;
  if (operation.field === 'stock') return <strong>{String(value)}</strong>;
  if (operation.field === 'cover' || operation.field === 'variantImage') {
    const image = value as { importId?: string | null };
    return image.importId ? (
      <img className="patch-value-image" src={media(image.importId)} alt="Ảnh đối chiếu" />
    ) : (
      <span>Chưa có ảnh nguồn</span>
    );
  }
  if (operation.field === 'gallery')
    return (
      <div className="patch-value-gallery">
        {(value as { importId?: string | null }[]).map((image, index) =>
          image.importId ? (
            <figure key={index}>
              <img src={media(image.importId)} alt={`Ảnh ${index + 1}`} />
              <figcaption>{index + 1}</figcaption>
            </figure>
          ) : (
            <span key={index}>Chưa có ảnh {index + 1}</span>
          ),
        )}
      </div>
    );
  if (operation.field === 'description' && Array.isArray(value))
    return (
      <div className="patch-description">
        {(value as ContentBlock[]).map((block, index) =>
          block.type === 'text' ? (
            <pre key={index}>{block.text}</pre>
          ) : (
            <img
              key={index}
              className="patch-value-image"
              src={media(block.assetKey)}
              alt={`Ảnh mô tả ${index + 1}`}
            />
          ),
        )}
      </div>
    );
  return <pre>{typeof value === 'string' ? value : JSON.stringify(value)}</pre>;
}
