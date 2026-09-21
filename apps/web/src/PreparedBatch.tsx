import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  FolderOpen,
  RefreshCw,
  Upload,
} from 'lucide-react';
import type { InputBatchDetail, InputBatchRecord, InputLibrary } from '@shopee/domain';
import { api, date, post, RequestError, type ImportRecord } from './api.js';
import { createFolderReader, type FolderReadProgress } from './folder-reader.js';
import { groupDirectoryFiles, type FolderMode } from './folder-source.js';
import type { BatchSaveRequest } from './input-batch-client.js';
import './prepared-batch.css';

type BatchIssue = string | { message: string; code?: string; severity?: string };
type PreviewEntry = {
  folderKey: string;
  shopName: string;
  categoryId?: string | number;
  title: string;
  skuCount: number;
  issues: BatchIssue[];
};
type BatchPreview = {
  id: string;
  fingerprint: string;
  entries: PreviewEntry[];
  issues: BatchIssue[];
  state: 'prepared' | 'blocked';
};
type BatchItem = {
  id: string;
  folderKey: string;
  shopName: string;
  state: string;
  itemId?: string;
  message?: string;
  check?: unknown;
  paused?: boolean;
};
type BatchRun = Omit<BatchPreview, 'state'> & {
  state: string;
  operation: 'create' | 'update';
  createdAt: string;
  items: BatchItem[];
};
type BatchSummary = Pick<BatchRun, 'id' | 'state' | 'operation' | 'createdAt'>;
type BatchContext = {
  mode: 'simulation' | 'unavailable';
  shops: { id: string; name: string; shopId: string }[];
  batches: BatchSummary[];
};

const fields = [
  ['title', 'Tiêu đề'],
  ['description', 'Mô tả'],
  ['cover', 'Ảnh bìa'],
  ['gallery', 'Bộ ảnh sản phẩm'],
  ['variationImages', 'Ảnh phân loại'],
  ['price', 'Giá gốc'],
  ['stock', 'Tồn đăng bán'],
  ['attributes', 'Thông tin ngành hàng'],
  ['logistics', 'Vận chuyển'],
] as const;
const statusLabels: Record<string, string> = {
  prepared: 'Đã chuẩn bị',
  blocked: 'Cần sửa nguồn',
  queued: 'Đang chờ',
  running: 'Đang xử lý',
  paused: 'Đang tạm dừng',
  waiting_input: 'Cần bổ sung thông tin',
  unknown: 'Chưa rõ kết quả',
  verified: 'Đã đối chiếu',
  completed: 'Đã kết thúc',
  failed: 'Không hoàn tất',
  cancelled: 'Đã dừng',
};
const activeStates = new Set(['queued', 'running']);
const attentionStates = new Set(['blocked', 'waiting_input', 'unknown', 'failed']);
const pendingKey = 'shopee.prepared-batch.pending-submit';
const pendingControlKey = 'shopee.prepared-batch.pending-control';
const pendingIntakeKey = 'shopee.prepared-batch.pending-intake';
type JobAction = 'pause' | 'resume' | 'cancel' | 'reconcile';
type PendingControl = { batchId: string; jobId: string; folderKey: string; action: JobAction };
const jobActionLabels: Record<JobAction, string> = {
  pause: 'Tạm dừng',
  resume: 'Tiếp tục',
  cancel: 'Hủy',
  reconcile: 'Đọc đối chiếu',
};
const isUuid = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const issueText = (issue: BatchIssue) => (typeof issue === 'string' ? issue : issue.message);
const statusText = (state: string) => statusLabels[state] ?? 'Cần kiểm tra trạng thái';

function BatchIssues({ issues }: { issues: BatchIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="prepared-issues">
      {issues.map((issue, index) => (
        <li key={index}>{issueText(issue)}</li>
      ))}
    </ul>
  );
}

/** Imports already saved in the input library; this screen never generates source content. */
export function PreparedBatch() {
  const [context, setContext] = useState<BatchContext | null>(null);
  const [library, setLibrary] = useState<InputLibrary | null>(null);
  const [inputBatchId, setInputBatchId] = useState('');
  const [source, setSource] = useState<InputBatchDetail | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [sourceVersion, setSourceVersion] = useState(0);
  const [libraryError, setLibraryError] = useState('');
  const [contextError, setContextError] = useState('');
  const [intakeMode, setIntakeMode] = useState<FolderMode>('parent_with_listing_folders');
  const [intakeProgress, setIntakeProgress] = useState<FolderReadProgress | null>(null);
  const [intakeMessage, setIntakeMessage] = useState('');
  const [intakeError, setIntakeError] = useState('');
  const [pendingIntake, setPendingIntake] = useState<BatchSaveRequest | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [folderKeys, setFolderKeys] = useState<string[]>([]);
  const [previewFolderKeys, setPreviewFolderKeys] = useState<string[]>([]);
  const [folderQuery, setFolderQuery] = useState('');
  const [historicalPreview, setHistoricalPreview] = useState(false);
  const [workbookImportId, setWorkbookImportId] = useState('');
  const [workbookState, setWorkbookState] = useState<'none' | 'loading' | 'valid' | 'invalid'>(
    'none',
  );
  const [workbookError, setWorkbookError] = useState('');
  const [workbookVersion, setWorkbookVersion] = useState(0);
  const [operation, setOperation] = useState<'create' | 'update'>('create');
  const [fieldMask, setFieldMask] = useState<string[]>([]);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [run, setRun] = useState<BatchRun | null>(null);
  const [busy, setBusy] = useState<
    'load' | 'import' | 'preview' | 'submit' | 'read' | 'control' | null
  >('load');
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [pendingId, setPendingId] = useState('');
  const [query, setQuery] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [pollError, setPollError] = useState('');
  const [readVersion, setReadVersion] = useState(0);
  const [pendingControl, setPendingControl] = useState<PendingControl | null>(null);
  const guard = useRef(false);
  const loadController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const workbookPicker = useRef<HTMLInputElement>(null);
  const importedRecords = useRef<ImportRecord[]>([]);
  const folderReader = useRef<ReturnType<typeof createFolderReader> | null>(null);
  if (!folderReader.current)
    folderReader.current = createFolderReader({ known: () => importedRecords.current });

  async function load() {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setBusy('load');
    const results = await Promise.allSettled([
      api<BatchContext>('/v1/prepared-batches/context', { signal: controller.signal }),
      api<InputLibrary>('/v1/input-library', { signal: controller.signal }),
    ]);
    if (controller.signal.aborted || !mounted.current) return;
    if (results[0].status === 'fulfilled') setContext(results[0].value);
    else setContext(null);
    if (results[1].status === 'fulfilled') setLibrary(results[1].value);
    setContextError(results[0].status === 'rejected' ? (results[0].reason as Error).message : '');
    setLibraryError(results[1].status === 'rejected' ? (results[1].reason as Error).message : '');
    setBusy(null);
  }

  async function saveIntake(request: BatchSaveRequest) {
    setPendingIntake(request);
    try {
      sessionStorage.setItem(pendingIntakeKey, JSON.stringify(request));
    } catch {
      // The same immutable request remains recoverable in this mounted page.
    }
    let record: InputBatchRecord;
    try {
      record = await post<InputBatchRecord>('/v1/input-batches', request);
    } catch (cause) {
      if (cause instanceof RequestError && [400, 422].includes(cause.status ?? 0)) {
        if (mounted.current) setPendingIntake(null);
        try {
          sessionStorage.removeItem(pendingIntakeKey);
        } catch {
          /* The rejected request is no longer pending. */
        }
      }
      throw cause;
    }
    if (!mounted.current) return;
    setPendingIntake(null);
    try {
      sessionStorage.removeItem(pendingIntakeKey);
    } catch {
      /* In-memory result is retained. */
    }
    await load();
    if (!mounted.current) return;
    setInputBatchId(record.id);
    setSourceVersion((value) => value + 1);
    const failed = request.state.files.filter((file) => file.error).length;
    setIntakeMessage(
      `Đã lưu ${Object.keys(record.state.productKeys).length} thư mục vào đợt “${record.state.name}”. ${failed ? `${failed} tệp cần kiểm tra trước khi xem trước.` : 'Tiếp tục chọn Excel điều phối để đối chiếu.'}`,
    );
  }

  async function receiveFiles(files: File[], kind: 'folders' | 'workbook') {
    if (!files.length || guard.current || busy || pendingIntake) return;
    guard.current = true;
    setBusy('import');
    setIntakeError('');
    setIntakeMessage('');
    setPreview(null);
    try {
      const descriptors = files.map((file) => ({
        relativePath: file.webkitRelativePath || file.name,
        name: file.name,
        size: file.size,
      }));
      const grouped = kind === 'folders' ? groupDirectoryFiles(descriptors, intakeMode) : null;
      if (grouped?.issues.length)
        throw new Error(grouped.issues.map((issue) => issue.message).join(' '));
      if (
        grouped &&
        (!grouped.bundles.length || grouped.bundles.length > 500 || files.length > 5000)
      )
        throw new Error('Chọn từ 1 đến 500 thư mục listing, tối đa 5.000 tệp trong một đợt.');
      const result = await folderReader.current!(files, (progress) => {
        if (mounted.current) setIntakeProgress(progress);
      });
      if (!mounted.current) return;
      for (const file of result) if (file.record) importedRecords.current.push(file.record);
      if (kind === 'workbook') {
        const record = result[0]?.record;
        if (!record || record.kind !== 'xlsx' || record.status !== 'ready')
          throw new Error(
            result[0]?.error ||
              record?.message ||
              'Excel chưa đọc xong. Tệp đã nhận được giữ trong kho nguồn; tải lại nguồn để kiểm tra.',
          );
        await load();
        if (!mounted.current) return;
        setWorkbookImportId(record.id);
        setIntakeMessage(
          `Đã đọc ${record.filename}. Bước xem trước sẽ kiểm tra sheet Điều phối listing và nguồn giá.`,
        );
      } else {
        const state: BatchSaveRequest['state'] = {
          version: 1,
          name: descriptors[0]!.relativePath.split('/')[0]!,
          mode: intakeMode,
          files: descriptors.map((file, index) => {
            const received = result[index]!;
            const failure =
              received.error ||
              (received.record?.status !== 'ready'
                ? received.record?.message || 'Tệp chưa đọc xong.'
                : undefined);
            return {
              ...file,
              ...(received.sha256 ? { sha256: received.sha256 } : {}),
              ...(received.record ? { importId: received.record.id } : {}),
              ...(failure ? { error: failure } : {}),
            };
          }),
          priceSelection: null,
          visual: {},
          wordPaths: {},
          wordRule: null,
          productKeys: Object.fromEntries(
            grouped!.bundles.map((bundle) => [bundle.key, `folder-${crypto.randomUUID()}`]),
          ),
        };
        await saveIntake({ id: crypto.randomUUID(), expectedRevision: 0, state });
      }
    } catch (cause) {
      if (mounted.current) setIntakeError((cause as Error).message);
    } finally {
      guard.current = false;
      if (mounted.current) {
        setBusy(null);
        setIntakeProgress(null);
      }
    }
  }

  async function retryIntakeSave() {
    if (!pendingIntake || guard.current || busy) return;
    guard.current = true;
    setBusy('import');
    setIntakeError('');
    try {
      await saveIntake(pendingIntake);
    } catch (cause) {
      if (mounted.current) setIntakeError((cause as Error).message);
    } finally {
      guard.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function downloadTemplate() {
    if (templateBusy) return;
    setTemplateBusy(true);
    setTemplateError('');
    try {
      const response = await fetch('/v1/prepared-batches/template', {
        headers: { 'X-App-Client': 'internal-workspace' },
      });
      if (!response.ok || !response.headers.get('Content-Type')?.includes('spreadsheetml'))
        throw new Error(
          'Chưa tải được mẫu điều phối. Thử tải lại; các nguồn đang chọn vẫn được giữ.',
        );
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'Mau-dieu-phoi-listing.xlsx';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (mounted.current)
        setTemplateError(cause instanceof Error ? cause.message : 'Chưa tải được mẫu điều phối.');
    } finally {
      if (mounted.current) setTemplateBusy(false);
    }
  }

  function receiveRun(value: BatchRun) {
    setRun(value);
    setPendingId(value.id);
    setStep(3);
    setPollError('');
    if (value.state !== 'prepared') {
      setUncertain(false);
      try {
        sessionStorage.removeItem(pendingKey);
      } catch {
        /* State remains visible in this tab. */
      }
    }
  }

  function clearPendingControl() {
    setPendingControl(null);
    try {
      sessionStorage.removeItem(pendingControlKey);
    } catch {
      /* Do not repeat control requests. */
    }
  }

  async function readRun(id: string, showResults = step === 3) {
    if (guard.current) return;
    guard.current = true;
    setBusy('read');
    setError('');
    try {
      const result = await api<BatchRun>('/v1/prepared-batches/' + encodeURIComponent(id));
      if (!mounted.current) return;
      receiveRun(result);
      clearPendingControl();
      if (result.state === 'prepared' && !uncertain && !showResults) {
        setPreview({ ...result, state: 'prepared' });
        const keys = [...new Set(result.entries.map((entry) => entry.folderKey))];
        setFolderKeys(keys);
        setPreviewFolderKeys(keys);
        setHistoricalPreview(true);
        setOperation(result.operation);
        setFieldMask([]);
        setStep(2);
      }
      setReadVersion((value) => value + 1);
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    } finally {
      guard.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function controlJob(item: BatchItem, action: JobAction) {
    if (
      guard.current ||
      !run ||
      context?.mode !== 'simulation' ||
      uncertain ||
      pendingControl ||
      !isUuid(item.id)
    )
      return;
    const allowed =
      action === 'reconcile'
        ? item.state === 'unknown'
        : action === 'cancel'
          ? ['prepared', 'queued'].includes(item.state)
          : item.state === 'queued' && (action === 'resume' ? !!item.paused : !item.paused);
    if (!allowed) return;
    guard.current = true;
    setBusy('control');
    setError('');
    const request: PendingControl = {
      batchId: run.id,
      jobId: item.id,
      folderKey: item.folderKey,
      action,
    };
    setPendingControl(request);
    let accepted = false;
    try {
      try {
        sessionStorage.setItem(pendingControlKey, JSON.stringify(request));
      } catch {
        /* Keep the request visible in this tab. */
      }
      await post(
        '/v1/prepared-jobs/' +
          encodeURIComponent(item.id) +
          (action === 'reconcile' ? '/reconcile' : '/control'),
        action === 'reconcile' ? {} : { action },
      );
      accepted = true;
      const current = await api<BatchRun>('/v1/prepared-batches/' + encodeURIComponent(run.id));
      if (!mounted.current) return;
      receiveRun(current);
      clearPendingControl();
      setReadVersion((value) => value + 1);
    } catch (cause) {
      if (!mounted.current) return;
      setError((cause as Error).message);
      const definitive =
        !accepted &&
        cause instanceof RequestError &&
        cause.status !== undefined &&
        cause.status >= 400 &&
        cause.status < 500;
      if (definitive) clearPendingControl();
    } finally {
      guard.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    try {
      const rawControl = sessionStorage.getItem(pendingControlKey);
      let control: PendingControl | null = null;
      if (rawControl) {
        const stored = JSON.parse(rawControl) as PendingControl;
        if (
          isUuid(stored.batchId) &&
          isUuid(stored.jobId) &&
          typeof stored.folderKey === 'string' &&
          Object.hasOwn(jobActionLabels, stored.action)
        ) {
          control = stored;
          setPendingControl(stored);
        }
      }
      const id = control?.batchId ?? sessionStorage.getItem(pendingKey);
      if (id && /^[a-f0-9-]{36}$/i.test(id)) {
        setPendingId(id);
        setUncertain(!control);
        setStep(3);
        // Read the existing request; never repeat its submission on mount.
        void api<BatchRun>('/v1/prepared-batches/' + id)
          .then((value) => {
            if (mounted.current) receiveRun(value);
          })
          .catch(() => {
            if (mounted.current)
              setError(
                'Chưa đọc được lần thực hiện đang chờ. Bấm Đọc lại kết quả để tiếp tục đối chiếu.',
              );
          });
      }
    } catch {
      /* The saved batch list remains a server-backed recovery path. */
    }
    return () => {
      mounted.current = false;
      loadController.current?.abort();
    };
  }, []);

  useEffect(() => {
    setSource(null);
    setSourceError('');
    setFolderKeys([]);
    setFolderQuery('');
    if (!inputBatchId) {
      setSourceLoading(false);
      return;
    }
    const controller = new AbortController();
    setSourceLoading(true);
    void api<InputBatchDetail>('/v1/input-batches/' + encodeURIComponent(inputBatchId), {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setSource(value);
          setFolderKeys(Object.keys(value.state.productKeys));
          setSourceError('');
        }
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setSourceError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSourceLoading(false);
      });
    return () => controller.abort();
  }, [inputBatchId, sourceVersion]);

  useEffect(() => {
    setWorkbookError('');
    if (!workbookImportId) {
      setWorkbookState('none');
      return;
    }
    const controller = new AbortController();
    setWorkbookState('loading');
    void api<ImportRecord>('/v1/imports/' + encodeURIComponent(workbookImportId), {
      signal: controller.signal,
    })
      .then((record) => {
        if (controller.signal.aborted) return;
        const body = record.body as { sheets?: { name?: string }[] } | undefined;
        if (record.id !== workbookImportId || record.kind !== 'xlsx' || record.status !== 'ready')
          throw new Error('Excel chưa đọc xong. Đợi đọc tệp rồi kiểm tra lại.');
        if (
          !Array.isArray(body?.sheets) ||
          !body.sheets.some((sheet) => sheet.name === 'Điều phối listing')
        )
          throw new Error(
            'Excel này chưa có sheet Điều phối listing. Bảng giá DORIS và phiếu bàn giao được giữ làm nguồn, nhưng chưa thể dùng riêng để xem trước lô này.',
          );
        setWorkbookState('valid');
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) {
          setWorkbookState('invalid');
          setWorkbookError(cause.message);
        }
      });
    return () => controller.abort();
  }, [workbookImportId, workbookVersion]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(pendingIntakeKey);
      if (!raw) return;
      const value = JSON.parse(raw) as BatchSaveRequest;
      if (
        isUuid(value.id) &&
        value.expectedRevision === 0 &&
        value.state?.version === 1 &&
        Array.isArray(value.state.files)
      )
        setPendingIntake(value);
    } catch {
      /* Invalid local recovery data is not submitted. */
    }
  }, []);

  useEffect(() => {
    if (step !== 1) heading.current?.focus();
  }, [step, preview?.id]);

  useEffect(() => {
    if (!run || !activeStates.has(run.state) || busy === 'control' || pendingControl) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await api<BatchRun>('/v1/prepared-batches/' + encodeURIComponent(run.id), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        receiveRun(next);
        if (activeStates.has(next.state)) timer = setTimeout(() => void tick(), 2000);
      } catch {
        if (!controller.signal.aborted)
          setPollError(
            'Tạm mất kết nối. Kết quả đã nhận vẫn được giữ; bấm Đọc lại kết quả để tiếp tục theo dõi.',
          );
      }
    };
    timer = setTimeout(() => void tick(), 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [run?.id, run?.state, readVersion, busy, pendingControl]);

  async function prepare() {
    if (
      guard.current ||
      !source ||
      source.id !== inputBatchId ||
      !workbookImportId ||
      !folderKeys.length ||
      folderKeys.some((key) => !Object.hasOwn(source.state.productKeys, key))
    )
      return;
    guard.current = true;
    setBusy('preview');
    setError('');
    const selectedFolders = [...folderKeys];
    try {
      const result = await post<BatchPreview>('/v1/prepared-batches/preview', {
        id: crypto.randomUUID(),
        inputBatchId,
        inputBatchRevision: source.revision,
        workbookImportId,
        operation,
        fieldMask: operation === 'update' ? fieldMask : [],
        folderKeys: selectedFolders,
      });
      if (!mounted.current) return;
      setPreview(result);
      setPreviewFolderKeys(selectedFolders);
      setHistoricalPreview(false);
      setRun(null);
      setQuery('');
      setOnlyIssues(false);
      setStep(2);
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    } finally {
      guard.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function submit() {
    if (
      guard.current ||
      context?.mode !== 'simulation' ||
      preview?.state !== 'prepared' ||
      pendingControl ||
      !folderKeys.length ||
      folderSelectionChanged ||
      uncertain
    )
      return;
    guard.current = true;
    setBusy('submit');
    setError('');
    setPendingId(preview.id);
    setStep(3);
    setRun(null);
    setQuery('');
    setOnlyIssues(false);
    let accepted = false;
    try {
      try {
        sessionStorage.setItem(pendingKey, preview.id);
      } catch {
        /* Server keeps the batch ID. */
      }
      await post('/v1/prepared-batches/' + encodeURIComponent(preview.id) + '/submit', {
        fingerprint: preview.fingerprint,
      });
      accepted = true;
      const result = await api<BatchRun>('/v1/prepared-batches/' + encodeURIComponent(preview.id));
      if (!mounted.current) return;
      receiveRun(result);
      if (result.state === 'prepared') setUncertain(true);
    } catch (cause) {
      if (!mounted.current) return;
      setError((cause as Error).message);
      const definitive =
        !accepted &&
        cause instanceof RequestError &&
        cause.status !== undefined &&
        cause.status >= 400 &&
        cause.status < 500;
      if (definitive) {
        setStep(2);
        try {
          sessionStorage.removeItem(pendingKey);
        } catch {
          /* No automatic retry. */
        }
      } else setUncertain(true);
    } finally {
      guard.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  function restart() {
    if (busy || uncertain || pendingControl || (run && activeStates.has(run.state))) return;
    setStep(1);
    setPreview(null);
    setRun(null);
    setPendingId('');
    setError('');
    setPollError('');
    setFolderKeys(source ? Object.keys(source.state.productKeys) : []);
    setHistoricalPreview(false);
    void load();
  }

  const selectedBatch = library?.batches.find((batch) => batch.id === inputBatchId);
  const allFolderKeys = source ? Object.keys(source.state.productKeys) : [];
  const folderSelectionChanged =
    folderKeys.length !== previewFolderKeys.length ||
    folderKeys.some((key) => !previewFolderKeys.includes(key));
  const changeFolder = (key: string, selected: boolean) =>
    setFolderKeys((current) =>
      selected ? [...new Set([...current, key])] : current.filter((value) => value !== key),
    );
  const canPreview =
    !busy &&
    !libraryError &&
    !contextError &&
    !pendingIntake &&
    workbookState === 'valid' &&
    !sourceLoading &&
    source?.id === inputBatchId &&
    !!library?.priceBooks.some((book) => book.id === workbookImportId && book.status === 'ready') &&
    folderKeys.length > 0 &&
    folderKeys.every((key) => allFolderKeys.includes(key)) &&
    (operation === 'create' || fieldMask.length > 0);
  const hasAttention = (item: BatchItem) => !!item.paused || attentionStates.has(item.state);
  const previewEntries = (preview?.entries ?? []).filter(
    (entry) =>
      (!onlyIssues || entry.issues.length > 0) &&
      `${entry.folderKey} ${entry.title} ${entry.shopName}`
        .toLocaleLowerCase('vi')
        .includes(query.toLocaleLowerCase('vi')),
  );
  const resultItems = (run?.items ?? []).filter(
    (item) =>
      (!onlyIssues || hasAttention(item)) &&
      `${item.folderKey} ${item.shopName} ${item.itemId ?? ''}`
        .toLocaleLowerCase('vi')
        .includes(query.toLocaleLowerCase('vi')),
  );
  const attentionCount = run?.items.filter(hasAttention).length ?? 0;

  return (
    <div className="prepared-batch">
      <header className="prepared-heading">
        <div>
          <p className="prepared-eyebrow">TỪ BỘ LISTING ĐÃ CHUẨN BỊ</p>
          <h1>Thực hiện theo lô</h1>
          <p>Dùng thư mục Word, ảnh và Excel đã nhập. Giữ nguyên nội dung của từng listing.</p>
        </div>
        <button onClick={() => void load()} disabled={!!busy}>
          <RefreshCw size={16} /> Tải lại nguồn
        </button>
      </header>

      <div
        className={`prepared-mode ${context?.mode === 'simulation' ? 'is-simulation' : ''}`}
        role="status"
      >
        <strong>
          {busy === 'load' && !context
            ? 'Đang kiểm tra chế độ thực hiện…'
            : contextError
              ? 'Chưa đọc được chế độ thực hiện'
              : context?.mode === 'simulation'
                ? 'MÔ PHỎNG · không gửi lên Shopee'
                : 'CHƯA MỞ THỰC THI'}
        </strong>
        <span>
          {contextError
            ? 'Tải lại cấu hình trước khi xem trước hoặc thực hiện lô.'
            : context?.mode === 'simulation'
              ? 'Kết quả bên dưới dùng để kiểm tra ứng dụng; không phải bằng chứng đã đăng hoặc cập nhật shop thật.'
              : 'Hiện bạn có thể đối chiếu nguồn và xem trước. Bộ mô phỏng chưa được cấu hình; màn hình này chưa mở đăng hoặc cập nhật Shopee thật.'}
        </span>
      </div>

      <ol className="prepared-steps" aria-label="Các bước thực hiện">
        {['Nhập nguồn', 'Xem trước', 'Kết quả'].map((label, index) => (
          <li key={label} aria-current={step === index + 1 ? 'step' : undefined}>
            <span>{step > index + 1 ? <Check size={15} /> : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {error && (
        <div className="prepared-alert" role="alert">
          {error}
        </div>
      )}
      {contextError && (
        <div className="prepared-alert" role="alert">
          {contextError}
        </div>
      )}
      {busy === 'load' && <p role="status">Đang tải bộ nguồn và cấu hình…</p>}

      {step === 1 && (
        <section className="prepared-panel" aria-labelledby="prepared-source-heading">
          <h2 id="prepared-source-heading">Nhận nguồn cho lô này</h2>
          <p className="prepared-intake-intro">
            Nhập ngay tại đây hoặc dùng đợt đã lưu. Word, ảnh và dữ liệu gốc được giữ nguyên.
          </p>
          <p className="prepared-picker-help">
            Công cụ này chuẩn bị và kiểm thử lô sandbox theo cấu trúc hiện có. Luồng đăng shop thật
            dùng bộ nguồn đã được kiểm tra ở phần phía trên; chưa tự chuyển mọi thư mục mới thành
            một lô production.
          </p>
          {libraryError && (
            <div className="prepared-alert" role="alert">
              <strong>Không tải được danh sách nguồn.</strong>
              <p>{libraryError}</p>
              <button disabled={!!busy} onClick={() => void load()}>
                Thử tải nguồn lại
              </button>
            </div>
          )}
          <div className="prepared-input-grid">
            <div className="prepared-source-picker">
              <label>
                Bộ thư mục Word và ảnh
                {(!!library?.batches.length || (busy === 'load' && !library)) && !libraryError ? (
                  <select
                    aria-label="Bộ thư mục Word và ảnh"
                    value={inputBatchId}
                    disabled={
                      !!busy || !!libraryError || !library?.batches.length || !!pendingIntake
                    }
                    onChange={(event) => {
                      setInputBatchId(event.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="">
                      {busy === 'load' && !library
                        ? 'Đang tải đợt nhập…'
                        : libraryError
                          ? 'Chưa tải được đợt nhập'
                          : library && !library.batches.length
                            ? 'Chưa có đợt thư mục đã lưu'
                            : 'Chọn đợt nhập đã lưu'}
                    </option>
                    {library?.batches.map((batch) => (
                      <option key={batch.id} value={batch.id}>
                        {batch.name} · {batch.folderCount} thư mục
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="prepared-source-empty" role="status">
                    {libraryError
                      ? 'Danh sách đợt nhập chưa tải được.'
                      : 'Chưa có đợt thư mục đã lưu.'}
                  </span>
                )}
              </label>
              {!libraryError && library && !library.batches.length && (
                <p className="prepared-picker-help">
                  Kho listing có thể đã có tài liệu tham khảo. Bước này cần thư mục Word và ảnh gốc
                  đã được nhập thành một đợt.
                </p>
              )}
              <div className="prepared-folder-import">
                <label>
                  Thư mục bạn sẽ chọn
                  <select
                    aria-label="Cấu trúc thư mục cần nhập"
                    value={intakeMode}
                    disabled={!!busy || !!pendingIntake}
                    onChange={(event) => setIntakeMode(event.target.value as FolderMode)}
                  >
                    <option value="parent_with_listing_folders">
                      Thư mục cha chứa nhiều listing
                    </option>
                    <option value="single_listing">Một thư mục là một listing</option>
                  </select>
                </label>
                <button
                  disabled={!!busy || !!pendingIntake}
                  onClick={() => folderPicker.current?.click()}
                >
                  <FolderOpen size={17} /> Nhập thư mục Word và ảnh
                </button>
                <input
                  ref={folderPicker}
                  type="file"
                  hidden
                  multiple
                  {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)}
                  aria-label="Chọn thư mục nguồn cho lô"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    void receiveFiles(files, 'folders');
                  }}
                />
              </div>
              <p className="prepared-picker-help">
                Mỗi thư mục con giữ trọn một listing. Để bảng giá ngoài thư mục cha này; chọn Excel
                ở bên cạnh.
              </p>
            </div>
            <div className="prepared-source-picker">
              <label>
                File Excel điều phối và giá
                {(!!library?.priceBooks.length || (busy === 'load' && !library)) &&
                !libraryError ? (
                  <select
                    aria-label="File Excel điều phối và giá"
                    value={workbookImportId}
                    disabled={
                      !!busy || !!libraryError || !library?.priceBooks.length || !!pendingIntake
                    }
                    onChange={(event) => {
                      setWorkbookImportId(event.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="">
                      {busy === 'load' && !library
                        ? 'Đang tải Excel…'
                        : libraryError
                          ? 'Chưa tải được Excel'
                          : library && !library.priceBooks.length
                            ? 'Chưa có Excel đã nhập'
                            : 'Chọn Excel đã nhập'}
                    </option>
                    {library?.priceBooks.map((book) => (
                      <option key={book.id} value={book.id} disabled={book.status !== 'ready'}>
                        {book.filename}
                        {book.status !== 'ready' ? ' · chưa đọc xong' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="prepared-source-empty" role="status">
                    {libraryError ? 'Danh sách Excel chưa tải được.' : 'Chưa có Excel đã nhập.'}
                  </span>
                )}
              </label>
              <div className="prepared-intake-actions">
                <button
                  disabled={!!busy || !!pendingIntake}
                  onClick={() => workbookPicker.current?.click()}
                >
                  <Upload size={17} /> Nhập Excel điều phối
                </button>
                <button disabled={templateBusy} onClick={() => void downloadTemplate()}>
                  <Download size={17} /> {templateBusy ? 'Đang tải mẫu…' : 'Tải mẫu điều phối'}
                </button>
                <input
                  ref={workbookPicker}
                  type="file"
                  accept=".xlsx"
                  hidden
                  aria-label="Chọn Excel điều phối cho lô"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    void receiveFiles(files, 'workbook');
                  }}
                />
              </div>
              <p className="prepared-picker-help">
                File cần có sheet <strong>Điều phối listing</strong> và dữ liệu giá trong cùng
                workbook. Chỉ có file DORIS hoặc phiếu bàn giao hai sheet chưa đủ cho bước này.
              </p>
              <p className="prepared-picker-help">
                Mẫu điều phối giúp xác định đúng tệp và SKU. Thông tin ngành hàng phải có nguồn và
                được kiểm tra theo từng ngành; ứng dụng chưa tự suy đoán các thuộc tính còn thiếu.
              </p>
              {workbookState === 'loading' && <p role="status">Đang kiểm tra cấu trúc Excel…</p>}
              {workbookError && (
                <div className="prepared-alert" role="alert">
                  <p>{workbookError}</p>
                  <button
                    disabled={!!busy}
                    onClick={() => setWorkbookVersion((value) => value + 1)}
                  >
                    Kiểm tra Excel lại
                  </button>
                </div>
              )}
              {templateError && (
                <p className="prepared-alert" role="alert">
                  {templateError}
                </p>
              )}
            </div>
          </div>
          {intakeProgress && (
            <div className="prepared-import-progress" role="status">
              <strong>
                Đang nhận tệp {intakeProgress.completed}/{intakeProgress.total}
              </strong>
              <progress max={intakeProgress.total || 1} value={intakeProgress.completed} />
              <span>{intakeProgress.filename}</span>
              <small>Giữ trang này mở đến khi lưu xong đợt nhập.</small>
            </div>
          )}
          {intakeMessage && (
            <p className="prepared-intake-message" role="status">
              {intakeMessage}
            </p>
          )}
          {intakeError && (
            <p className="prepared-alert" role="alert">
              {intakeError}
            </p>
          )}
          {pendingIntake && !busy && (
            <div className="prepared-alert" role="alert">
              <strong>Chưa xác nhận lưu xong đợt “{pendingIntake.state.name}”.</strong>
              <p>Tệp đã nhận vẫn được giữ. Tiếp tục lưu đúng đợt này trước khi nhập đợt khác.</p>
              <button onClick={() => void retryIntakeSave()}>Kiểm tra và lưu tiếp đợt này</button>
            </div>
          )}
          {sourceLoading && <p role="status">Đang đọc phiên bản bộ nguồn…</p>}
          {sourceError && (
            <div className="prepared-alert" role="alert">
              <strong>Chưa đọc được đợt đã chọn.</strong>
              <p>{sourceError}</p>
              <button
                disabled={!!busy || sourceLoading}
                onClick={() => setSourceVersion((value) => value + 1)}
              >
                Đọc lại đợt đã chọn
              </button>
            </div>
          )}
          {source && selectedBatch && (
            <p className="prepared-source-note">
              <FolderOpen size={17} />
              <span>
                {selectedBatch.name} · {selectedBatch.folderCount} thư mục · bản {source.revision}
                <small>
                  Shop, ngành hàng, SKU và dữ liệu áp dụng được đối chiếu từ Excel ở bước tiếp theo.
                </small>
              </span>
            </p>
          )}
          {source?.state.files.some((file) => file.error) && (
            <details className="prepared-file-issues">
              <summary>
                Tệp cần kiểm tra ({source.state.files.filter((file) => file.error).length})
              </summary>
              <ul>
                {source.state.files
                  .filter((file) => file.error)
                  .map((file) => (
                    <li key={file.relativePath}>
                      <strong>{file.relativePath}</strong>
                      <span>{file.error}</span>
                    </li>
                  ))}
              </ul>
            </details>
          )}
          {source && (
            <details className="prepared-folder-selection">
              <summary>
                Chọn thư mục trong lô{' '}
                <span>
                  {folderKeys.length}/{allFolderKeys.length} đã chọn
                </span>
              </summary>
              <div className="prepared-folder-tools">
                <label>
                  Tìm thư mục nguồn
                  <input
                    value={folderQuery}
                    onChange={(event) => setFolderQuery(event.target.value)}
                    placeholder="Tên thư mục…"
                  />
                </label>
                <button
                  disabled={!!busy || folderKeys.length === allFolderKeys.length}
                  onClick={() => setFolderKeys([...allFolderKeys])}
                >
                  Chọn tất cả thư mục
                </button>
                <button disabled={!!busy || !folderKeys.length} onClick={() => setFolderKeys([])}>
                  Bỏ chọn tất cả thư mục
                </button>
              </div>
              <div className="prepared-folder-list">
                {allFolderKeys
                  .filter((key) =>
                    key.toLocaleLowerCase('vi').includes(folderQuery.toLocaleLowerCase('vi')),
                  )
                  .map((key) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        aria-label={`Dùng thư mục ${key}`}
                        checked={folderKeys.includes(key)}
                        disabled={!!busy}
                        onChange={(event) => changeFolder(key, event.target.checked)}
                      />
                      <span>{key}</span>
                    </label>
                  ))}
              </div>
              {!folderKeys.length && (
                <p role="status">Chưa chọn thư mục nào. Chọn ít nhất một thư mục để xem trước.</p>
              )}
            </details>
          )}
          <fieldset className="prepared-operation">
            <legend>Bạn muốn làm gì?</legend>
            {(
              [
                ['create', 'Đăng mới', 'Một thư mục là một listing theo dữ liệu nguồn.'],
                ['update', 'Cập nhật link đã có', 'Chỉ đổi các phần bạn chọn từ tệp mới.'],
              ] as const
            ).map(([value, label, help]) => (
              <label className={operation === value ? 'is-selected' : ''} key={value}>
                <input
                  type="radio"
                  name="prepared-operation"
                  value={value}
                  checked={operation === value}
                  disabled={!!busy}
                  onChange={() => setOperation(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{help}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {operation === 'update' && (
            <fieldset className="prepared-fields">
              <legend>Chỉ cập nhật các phần này</legend>
              <p>
                Giá trị được lấy từ nguồn nhập, không cần gõ lại. Những phần không chọn được giữ
                nguyên.
              </p>
              <div>
                {fields.map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="checkbox"
                      checked={fieldMask.includes(value)}
                      disabled={!!busy}
                      onChange={(event) =>
                        setFieldMask((current) =>
                          event.target.checked
                            ? [...current, value]
                            : current.filter((field) => field !== value),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="prepared-footer">
            <span>Chưa thực hiện thay đổi nào</span>
            <button className="primary" disabled={!canPreview} onClick={() => void prepare()}>
              {busy === 'preview' ? 'Đang đối chiếu…' : 'Xem trước lô'}
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
      )}

      {step === 2 && preview && (
        <section className="prepared-panel">
          <div className="prepared-panel-heading">
            <div>
              <h2 ref={heading} tabIndex={-1}>
                Kiểm tra trước khi thực hiện
              </h2>
              <p>
                {preview.entries.length} thư mục ·{' '}
                {preview.entries.reduce((total, entry) => total + entry.skuCount, 0)} SKU ·{' '}
                {operation === 'create'
                  ? 'Đăng mới'
                  : fieldMask.length
                    ? `Cập nhật ${fieldMask.map((field) => fields.find(([key]) => key === field)?.[1] ?? field).join(', ')}`
                    : 'Cập nhật theo bản đã chuẩn bị'}
              </p>
            </div>
            <button
              disabled={!!busy || uncertain}
              onClick={() => {
                setStep(1);
                setPreview(null);
                if (historicalPreview) setFolderKeys([...allFolderKeys]);
                setHistoricalPreview(false);
              }}
            >
              <ArrowLeft size={16} /> Sửa lựa chọn nguồn
            </button>
          </div>
          <BatchIssues issues={preview.issues} />
          {preview.state === 'blocked' && (
            <p className="prepared-alert" role="status">
              Lô còn thông tin cần xử lý. Sửa đúng nguồn hoặc liên kết bị báo, rồi xem trước lại.
            </p>
          )}
          <div className="prepared-filters">
            <label>
              Tìm trong lô
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tên thư mục, listing hoặc shop…"
              />
            </label>
            <label className="prepared-inline">
              <input
                type="checkbox"
                checked={onlyIssues}
                onChange={(event) => setOnlyIssues(event.target.checked)}
              />
              Chỉ hiện phần cần kiểm tra
            </label>
          </div>
          {!historicalPreview && (
            <div className="prepared-scope-selection">
              <span>
                <strong>{folderKeys.length}</strong> thư mục được chọn
              </span>
              <button
                disabled={!!busy || uncertain || folderKeys.length === allFolderKeys.length}
                onClick={() => setFolderKeys([...allFolderKeys])}
              >
                Chọn tất cả thư mục
              </button>
              <button
                disabled={!!busy || uncertain || !folderKeys.length}
                onClick={() => setFolderKeys([])}
              >
                Bỏ chọn tất cả thư mục
              </button>
            </div>
          )}
          {folderSelectionChanged && (
            <div className="prepared-alert" role="status">
              <p>
                {folderKeys.length
                  ? `Phạm vi đã đổi thành ${folderKeys.length} thư mục. Xem trước lại để đối chiếu đúng phần được chọn.`
                  : 'Chưa chọn thư mục nào. Lô sẽ không được thực hiện.'}
              </p>
              {!historicalPreview && (
                <button disabled={!canPreview || uncertain} onClick={() => void prepare()}>
                  Xem trước {folderKeys.length} thư mục đã chọn
                </button>
              )}
            </div>
          )}
          <div className="prepared-table-wrap">
            <table aria-label="Listing trước khi thực hiện">
              <thead>
                <tr>
                  <th>Chọn</th>
                  <th>Thư mục / listing</th>
                  <th>Shop</th>
                  <th>Ngành hàng</th>
                  <th>SKU</th>
                  <th>Kiểm tra nguồn</th>
                </tr>
              </thead>
              <tbody>
                {previewEntries.map((entry, index) => (
                  <tr key={`${entry.folderKey}-${entry.shopName}-${index}`}>
                    <td data-label="Chọn">
                      <input
                        type="checkbox"
                        aria-label={`Chọn thư mục ${entry.folderKey}`}
                        checked={folderKeys.includes(entry.folderKey)}
                        disabled={
                          !!busy ||
                          uncertain ||
                          historicalPreview ||
                          !allFolderKeys.includes(entry.folderKey)
                        }
                        onChange={(event) => changeFolder(entry.folderKey, event.target.checked)}
                      />
                    </td>
                    <td data-label="Thư mục / listing">
                      <strong>{entry.title || 'Chưa xác định tiêu đề'}</strong>
                      <small>{entry.folderKey}</small>
                    </td>
                    <td data-label="Shop">{entry.shopName || 'Chưa xác định shop'}</td>
                    <td data-label="Ngành hàng">{entry.categoryId || 'Chưa xác định'}</td>
                    <td data-label="SKU">{entry.skuCount}</td>
                    <td data-label="Kiểm tra nguồn">
                      {entry.issues.length ? (
                        <BatchIssues issues={entry.issues} />
                      ) : (
                        <span className="prepared-status is-ready">Đủ dữ liệu để thử</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!previewEntries.length && (
            <p className="prepared-empty">Không có thư mục khớp phần đang lọc.</p>
          )}
          <div className="prepared-footer">
            <span>
              {context?.mode === 'simulation'
                ? 'Chạy trên bộ mô phỏng, không gửi lên Shopee.'
                : 'Thực thi chưa được cấu hình. Bản xem trước vẫn được giữ.'}
            </span>
            {context?.mode === 'simulation' && (
              <button
                disabled={!!busy || uncertain || !!pendingControl}
                onClick={() => void readRun(preview.id, true)}
              >
                Quản lý phần chưa chạy
              </button>
            )}
            <button
              className="primary"
              disabled={
                !!busy ||
                uncertain ||
                !!pendingControl ||
                context?.mode !== 'simulation' ||
                preview.state !== 'prepared' ||
                !folderKeys.length ||
                folderSelectionChanged ||
                !preview.entries.length
              }
              onClick={() => void submit()}
            >
              Chạy mô phỏng {preview.entries.length} listing
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="prepared-panel">
          <div className="prepared-panel-heading">
            <div>
              <h2 ref={heading} tabIndex={-1}>
                Kết quả của lô
              </h2>
              <p>{run ? statusText(run.state) : 'Đang xác nhận lần thực hiện'}</p>
            </div>
            <button
              disabled={!!busy || !(pendingId || run?.id)}
              onClick={() => void readRun(pendingId || run!.id)}
            >
              <RefreshCw size={16} /> Đọc lại kết quả
            </button>
          </div>
          {busy === 'submit' && <p role="status">Đang gửi yêu cầu tới bộ mô phỏng…</p>}
          {uncertain && (
            <p className="prepared-alert" role="alert">
              Chưa xác nhận được kết quả của lần gửi này. Ứng dụng giữ nguyên mã lô; đọc lại kết quả
              để đối chiếu, không bấm gửi một lô thay thế.
            </p>
          )}
          {pollError && (
            <p className="prepared-alert" role="alert">
              {pollError}
            </p>
          )}
          {pendingControl && (
            <p className="prepared-alert" role="alert">
              {busy === 'control'
                ? `Đang ${jobActionLabels[pendingControl.action].toLocaleLowerCase('vi')} cho ${pendingControl.folderKey}…`
                : `Chưa xác nhận thao tác ${jobActionLabels[pendingControl.action].toLocaleLowerCase('vi')} cho ${pendingControl.folderKey}. Bấm Đọc lại kết quả để xem trạng thái mới; ứng dụng không tự gửi lại thao tác.`}
            </p>
          )}
          {run && (
            <>
              <div className="prepared-result-counts">
                <span>
                  <strong>{run.items.length}</strong> listing trong lần chạy
                </span>
                <span>
                  <strong>{run.items.filter((item) => item.state === 'verified').length}</strong> đã
                  đối chiếu
                </span>
                <span>
                  <strong>{attentionCount}</strong> cần xử lý
                </span>
              </div>
              {activeStates.has(run.state) && !pollError && (
                <p role="status">Đang tự cập nhật kết quả… Bạn có thể xem từng listing bên dưới.</p>
              )}
              <div className="prepared-filters">
                <label>
                  Tìm kết quả
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Thư mục, shop hoặc mã link…"
                  />
                </label>
                <label className="prepared-inline">
                  <input
                    type="checkbox"
                    checked={onlyIssues}
                    onChange={(event) => setOnlyIssues(event.target.checked)}
                  />
                  Chỉ hiện phần cần xử lý
                </label>
              </div>
              <div className="prepared-table-wrap">
                <table aria-label="Kết quả từng listing">
                  <thead>
                    <tr>
                      <th>Thư mục</th>
                      <th>Shop</th>
                      <th>Trạng thái</th>
                      <th>Mã link trong lần thử</th>
                      <th>Chi tiết</th>
                      {context?.mode === 'simulation' && <th>Thao tác</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {resultItems.map((item) => (
                      <tr key={item.id}>
                        <td data-label="Thư mục">
                          <strong>{item.folderKey}</strong>
                        </td>
                        <td data-label="Shop">{item.shopName}</td>
                        <td data-label="Trạng thái">
                          <span
                            className={`prepared-status ${hasAttention(item) ? 'needs-attention' : item.state === 'verified' ? 'is-ready' : ''}`}
                          >
                            {item.paused ? 'Đang tạm dừng' : statusText(item.state)}
                          </span>
                        </td>
                        <td data-label="Mã link trong lần thử">{item.itemId ?? 'Chưa có'}</td>
                        <td data-label="Chi tiết">
                          {item.message ||
                            (item.state === 'verified'
                              ? 'Đã đối chiếu với nguồn trong bộ mô phỏng.'
                              : 'Chưa có ghi chú thêm.')}
                          {item.check !== undefined && (
                            <details>
                              <summary>Thông tin đối chiếu</summary>
                              <pre>
                                {typeof item.check === 'string'
                                  ? item.check
                                  : JSON.stringify(item.check, null, 2)}
                              </pre>
                            </details>
                          )}
                        </td>
                        {context?.mode === 'simulation' && (
                          <td data-label="Thao tác">
                            {isUuid(item.id) ? (
                              <div className="prepared-scope-selection">
                                {item.state === 'queued' && (
                                  <button
                                    aria-label={`${item.paused ? 'Tiếp tục' : 'Tạm dừng'} ${item.folderKey}`}
                                    disabled={!!busy || uncertain || !!pendingControl}
                                    onClick={() =>
                                      void controlJob(item, item.paused ? 'resume' : 'pause')
                                    }
                                  >
                                    {item.paused ? 'Tiếp tục' : 'Tạm dừng'}
                                  </button>
                                )}
                                {['prepared', 'queued'].includes(item.state) && (
                                  <button
                                    aria-label={`Hủy ${item.folderKey}`}
                                    disabled={!!busy || uncertain || !!pendingControl}
                                    onClick={() => void controlJob(item, 'cancel')}
                                  >
                                    Hủy phần chưa chạy
                                  </button>
                                )}
                                {item.state === 'unknown' && (
                                  <button
                                    aria-label={`Đọc đối chiếu ${item.folderKey}`}
                                    disabled={!!busy || uncertain || !!pendingControl}
                                    onClick={() => void controlJob(item, 'reconcile')}
                                  >
                                    Đọc đối chiếu
                                  </button>
                                )}
                                {!['prepared', 'queued', 'unknown'].includes(item.state) && (
                                  <span>—</span>
                                )}
                              </div>
                            ) : (
                              <span>Sửa nguồn rồi xem trước lại.</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!resultItems.length && (
                <p className="prepared-empty">
                  {run.items.length
                    ? 'Không có kết quả khớp phần đang lọc.'
                    : 'Chưa có kết quả từng listing. Đọc lại trạng thái của cùng lô để tiếp tục.'}
                </p>
              )}
            </>
          )}
          <div className="prepared-footer">
            <span>Kết quả mô phỏng không xác nhận trạng thái của shop thật.</span>
            <button
              disabled={
                !!busy || uncertain || !!pendingControl || !!(run && activeStates.has(run.state))
              }
              onClick={restart}
            >
              Chuẩn bị lô khác
            </button>
          </div>
        </section>
      )}

      {!!context?.batches.length && (
        <section className="prepared-recent" aria-label="Các lô đã lưu">
          <h2>Các lô đã lưu</h2>
          {context.batches.map((batch) => (
            <article key={batch.id}>
              <div>
                <strong>
                  {batch.operation === 'update' ? 'Cập nhật' : 'Đăng mới'} · {date(batch.createdAt)}
                </strong>
                <small>{statusText(batch.state)}</small>
              </div>
              <button
                disabled={
                  !!busy || uncertain || !!pendingControl || !!(run && activeStates.has(run.state))
                }
                onClick={() => {
                  setQuery('');
                  setOnlyIssues(false);
                  void readRun(batch.id, false);
                }}
              >
                Mở kết quả
              </button>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
