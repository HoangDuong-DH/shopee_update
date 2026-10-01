import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCheck,
  Files,
  LayoutList,
  Plus,
  Store,
  CircleHelp,
  Gauge,
} from 'lucide-react';
import type {
  ChangePlan,
  InputBatchDetail,
  JobRecord,
  ListingDraft,
  ShopConnection,
} from '@shopee/domain';
import { api, date, RequestError, type ImportRecord } from './api.js';
import type { EditorSeed } from './Editor.js';
import { ShopConnectionsOverview } from './ShopConnectionsOverview.js';
import {
  productionShopKey as savedShopKey,
  resolveExplicitProductionShop,
} from './shop-connections.js';
import { OperationsCenter } from './OperationsCenter.js';
import { deriveDraftSourceImportIds } from './editor-source-scope.js';
import './product-theme.css';
import {
  readWorkspacePage,
  readWorkspaceDraftRoute,
  workspaceNavigationUrl,
  workspaceResources,
  settleWorkspaceReads,
  type WorkspaceResource,
} from './workspace-navigation.js';
import { useFileUploads } from './useFileUploads.js';
import { clearIntakeRecovery } from './intake-state.js';
import { newIntakeDraft, type IntakeDraft } from './intake-state.js';
import { ListingLibrary } from './ListingLibrary.js';
import { WorkspaceSectionBoundary } from './WorkspaceSectionBoundary.js';
import { type ArchiveFlags } from './LocalArchive.js';
import type { FolderManualContext } from './FolderIntake.js';
const Issues = lazy(() => import('./Preview.js').then((module) => ({ default: module.Issues })));
const Preview = lazy(() => import('./Preview.js').then((module) => ({ default: module.Preview })));
const Resources = lazy(() =>
  import('./Resources.js').then((module) => ({ default: module.Resources })),
);
const ListingImport = lazy(() =>
  import('./ListingImport.js').then((module) => ({ default: module.ListingImport })),
);
const ConnectionForm = lazy(() =>
  import('./ConnectionForm.js').then((module) => ({ default: module.ConnectionForm })),
);
const ProductionConnectionForm = lazy(() =>
  import('./ProductionConnectionForm.js').then((module) => ({
    default: module.ProductionConnectionForm,
  })),
);
const AssistantPanel = lazy(() =>
  import('./AssistantPanel.js').then((module) => ({ default: module.AssistantPanel })),
);
const ShopArchive = lazy(() =>
  import('./ShopArchive.js').then((module) => ({ default: module.ShopArchive })),
);
const UsageGuide = lazy(() =>
  import('./UsageGuide.js').then((module) => ({ default: module.UsageGuide })),
);
const FolderIntake = lazy(() =>
  import('./FolderIntake.js').then((module) => ({ default: module.FolderIntake })),
);
const Workbench = lazy(() =>
  import('./Workbench.js').then((module) => ({ default: module.Workbench })),
);
const HandoffIntake = lazy(() =>
  import('./HandoffIntake.js').then((module) => ({ default: module.HandoffIntake })),
);
const ImportUpdates = lazy(() =>
  import('./ImportUpdates.js').then((module) => ({ default: module.ImportUpdates })),
);
const PreparedBatch = lazy(() =>
  import('./PreparedBatch.js').then((module) => ({ default: module.PreparedBatch })),
);
const ProductionPilot = lazy(() =>
  import('./ProductionPilot.js').then((module) => ({ default: module.ProductionPilot })),
);
const ProductionBatches = lazy(() =>
  import('./ProductionBatches.js').then((module) => ({ default: module.ProductionBatches })),
);
const ProductionPreparation = lazy(() =>
  import('./ProductionPreparation.js').then((module) => ({
    default: module.ProductionPreparation,
  })),
);
const ImageQuality = lazy(() =>
  import('./ImageQuality.js').then((module) => ({ default: module.ImageQuality })),
);
const SandboxTryout = lazy(() =>
  import('./SandboxTryout.js').then((module) => ({ default: module.SandboxTryout })),
);
const SourceCatalog = lazy(() =>
  import('./SourceCatalog.js').then((module) => ({ default: module.SourceCatalog })),
);
const Editor = lazy(() => import('./Editor.js').then((module) => ({ default: module.Editor })));
type Page =
  | 'overview'
  | 'sandbox-tryout'
  | 'image-qc'
  | 'prepared-batches'
  | 'workbench'
  | 'updates'
  | 'handoff'
  | 'products'
  | 'sources'
  | 'results'
  | 'shops'
  | 'archives'
  | 'assistant'
  | 'preview'
  | 'editor'
  | 'import'
  | 'guide'
  | 'folder';
const navigation = [
  { id: 'overview', label: 'Tổng quan', icon: Gauge },
  { id: 'products', label: 'Bộ listing', icon: Files },
  { id: 'prepared-batches', label: 'Đăng hàng', icon: Plus },
  { id: 'shops', label: 'Shop', icon: Store },
] as const;
const secondaryNavigation = [
  { id: 'sources', label: 'Kho nguồn', icon: LayoutList },
  { id: 'updates', label: 'Cập nhật listing', icon: LayoutList },
  { id: 'workbench', label: 'Theo dõi công việc', icon: CheckCheck },
  { id: 'image-qc', label: 'Kiểm tra ảnh', icon: CheckCheck },
  { id: 'sandbox-tryout', label: 'Thử sandbox', icon: CheckCheck },
  { id: 'archives', label: 'Kho sao chép', icon: Files },
  { id: 'guide', label: 'Hướng dẫn sử dụng', icon: CircleHelp },
  { id: 'assistant', label: 'Tra cứu & kiểm tra', icon: BookOpen },
] as const;
function restoredPage(): Page {
  try {
    return readWorkspacePage(window.location.search, sessionStorage.getItem('workspace-page'));
  } catch {
    return readWorkspacePage(window.location.search, null);
  }
}
function applyWorkspaceReset(status: { workspaceResetId?: string }) {
  if (!status.workspaceResetId) return false;
  try {
    if (localStorage.getItem('workspace-reset-applied') === status.workspaceResetId) return false;
    // Keep pending request receipts, unsaved sources and unrelated browser data.
    for (const key of ['workspace-page', 'workspace-production-view', 'production-target-shop-v1'])
      sessionStorage.removeItem(key);
    localStorage.setItem('workspace-reset-applied', status.workspaceResetId);
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}
function restoredProductionView(): 'working' | 'new' {
  try {
    return sessionStorage.getItem('workspace-production-view') === 'new' ? 'new' : 'working';
  } catch {
    return 'working';
  }
}
function selectedSourceIds(seed: EditorSeed): string[] | null {
  const ids = [
    ...seed.variants.map((variant) => variant.importId),
    ...(seed.coverId ? [seed.coverId] : []),
    ...seed.galleryIds,
    ...seed.descriptionImageIds,
    ...seed.variants.flatMap((variant) => (variant.imageId ? [variant.imageId] : [])),
    ...(seed.contentBinding ? [seed.contentBinding.mapping.importId] : []),
  ];
  return ids.every((id) =>
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id),
  )
    ? [...new Set(ids)]
    : null;
}
function PreviousProductionResults() {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="production-batch-history"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Kết quả đợt đăng trước</summary>
      {open && <ProductionPilot />}
    </details>
  );
}
export default function Workspace() {
  const [page, setPage] = useState<Page>(restoredPage),
    [imports, setImports] = useState<ImportRecord[]>([]),
    [products, setProducts] = useState<ListingDraft[]>([]),
    [shops, setShops] = useState<ShopConnection[]>([]),
    [plans, setPlans] = useState<ChangePlan[]>([]),
    [jobs, setJobs] = useState<JobRecord[]>([]),
    [status, setStatus] = useState<{
      worker: string;
      isolatedMode?: boolean;
      productionBatchWorkflow?: { enabled: boolean };
    } | null>(null),
    [loadError, setLoadError] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [draft, setDraft] = useState<ListingDraft | null>(null),
    [editor, setEditor] = useState<EditorSeed | null>(null),
    [editorVariants, setEditorVariants] = useState<{ sku: string; originalPrice?: string }[]>([]),
    [editorSourceIds, setEditorSourceIds] = useState<string[] | null>(null),
    [resultTab, setResultTab] = useState<'plans' | 'jobs'>('plans'),
    [dirty, setDirty] = useState(false),
    [editorSection, setEditorSection] = useState<'content' | 'images' | 'structure'>('content'),
    [saveBusy, setSaveBusy] = useState(false),
    [folderBusy, setFolderBusy] = useState(false),
    [folderStarted, setFolderStarted] = useState(false),
    [folderDirty, setFolderDirty] = useState(false),
    [initialBatch, setInitialBatch] = useState<InputBatchDetail | undefined>(),
    [initialPriceImportId, setInitialPriceImportId] = useState<string | undefined>(),
    [folderInstanceKey, setFolderInstanceKey] = useState(() => crypto.randomUUID()),
    [openingBatch, setOpeningBatch] = useState(false),
    [folderManual, setFolderManual] = useState<FolderManualContext | null>(null),
    [folderManualDraft, setFolderManualDraft] = useState<IntakeDraft | undefined>(),
    [editorOrigin, setEditorOrigin] = useState<'import' | 'folder'>('import'),
    [pendingPage, setPendingPage] = useState<Page | null>(null);
  const [patchTarget, setPatchTarget] = useState<string | undefined>();
  const [patchReceipt, setPatchReceipt] = useState<string | undefined>();
  const [patchInstance, setPatchInstance] = useState(0);
  const [sourceMode, setSourceMode] = useState<'catalog' | 'intake'>('catalog');
  const [resourceErrors, setResourceErrors] = useState<Partial<Record<WorkspaceResource, string>>>(
    {},
  );
  const [resourceObservedAt, setResourceObservedAt] = useState<
    Partial<Record<WorkspaceResource, string>>
  >({});
  const [connectionDetail, setConnectionDetail] = useState<string | null | undefined>(() => {
    const query = new URLSearchParams(window.location.search);
    return query.has('connectShop')
      ? `scope:${query.get('partnerId') ?? ''}:${query.get('connectShop') ?? ''}`
      : undefined;
  });
  const [intakeSessionNotice, setIntakeSessionNotice] = useState('');
  const [showLegacyPrepared, setShowLegacyPrepared] = useState(false);
  const [productionBatchVersion, setProductionBatchVersion] = useState(0);
  const [productionView, setProductionView] = useState<'working' | 'new'>(restoredProductionView);
  const [productionShopKey, setProductionShopKey] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    const partner = query.get('partnerId'),
      shop = query.get('shopId');
    if (partner && shop && /^[1-9]\d+$/.test(partner) && /^[1-9]\d+$/.test(shop))
      return partner + ':' + shop;
    try {
      return sessionStorage.getItem('production-target-shop-v1') ?? '';
    } catch {
      return '';
    }
  });
  const [preparationSource, setPreparationSource] = useState<{
    productKey: string;
    revision: number;
  } | null>(null);
  const [unavailableConnectionId, setUnavailableConnectionId] = useState<string | null>(null);
  const [routeSearch, setRouteSearch] = useState(() => window.location.search);
  const [routeBusy, setRouteBusy] = useState(false),
    [routeError, setRouteError] = useState(''),
    [routeRetry, setRouteRetry] = useState(0);
  const [editorHydrating, setEditorHydrating] = useState(false);
  const toolsDisclosure = useRef<HTMLDetailsElement>(null);
  const navigationHistory = useRef(true);
  useEffect(() => {
    if (toolsDisclosure.current) toolsDisclosure.current.open = false;
    try {
      sessionStorage.setItem('workspace-page', page);
      sessionStorage.setItem('workspace-production-view', productionView);
    } catch {
      /* Navigation still works if storage is unavailable. */
    }
    document.title = 'Listing Studio · Quản lý sản phẩm & shop';
    if ((page === 'editor' && !editor) || (page === 'preview' && !draft)) return;
    const source =
      page === 'editor' && editor?.productKey
        ? { productKey: editor.productKey, revision: editor.expectedRevision }
        : page === 'preview' && draft
          ? { productKey: draft.productKey, revision: draft.revision }
          : undefined;
    const next = workspaceNavigationUrl(window.location.href, page, source, productionShopKey);
    const current = window.location.pathname + window.location.search + window.location.hash;
    if (next !== current) {
      if (navigationHistory.current) window.history.pushState({}, '', next);
      else window.history.replaceState({}, '', next);
    }
    navigationHistory.current = true;
  }, [
    page,
    productionView,
    productionShopKey,
    draft?.productKey,
    draft?.revision,
    editor?.productKey,
    editor?.expectedRevision,
  ]);
  const productionShops = shops.filter((shop) => shop.scope.environment === 'production');
  const selectedProductionShop = resolveExplicitProductionShop(shops, productionShopKey);
  const selectedProductionScope =
    !unavailableConnectionId && selectedProductionShop?.state === 'connected'
      ? {
          environment: 'production' as const,
          partnerId: selectedProductionShop.scope.partnerId,
          shopId: selectedProductionShop.scope.shopId,
        }
      : null;
  useEffect(() => {
    try {
      sessionStorage.setItem('production-target-shop-v1', productionShopKey);
    } catch {}
  }, [productionShopKey]);
  const refreshing = useRef(false);
  const refreshVersion = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const livePage = useRef(page);
  livePage.current = page;
  const openingBatchRef = useRef(false);
  const importsRef = useRef(imports);
  importsRef.current = imports;
  const folderReader = useRef<ReturnType<
    (typeof import('./folder-reader.js'))['createFolderReader']
  > | null>(null);
  const editorUploadGuard = useRef(false);
  const readFolderFiles: ReturnType<
    (typeof import('./folder-reader.js'))['createFolderReader']
  > = async (files, onProgress) => {
    if (!folderReader.current) {
      const { createFolderReader } = await import('./folder-reader.js');
      folderReader.current = createFolderReader({ known: () => importsRef.current });
    }
    return folderReader.current(files, onProgress);
  };
  function mergeImports(rows: (ImportRecord & ArchiveFlags)[]) {
    setImports((current) => {
      const merged = new Map(current.map((item) => [item.id, item]));
      for (const item of rows) {
        const previous = merged.get(item.id);
        // Keep newly received bodies and never regress a completed parser result.
        if (previous?.status === 'ready' && ['queued', 'running'].includes(item.status)) continue;
        merged.set(item.id, { ...item, body: item.body ?? previous?.body });
      }
      return [...merged.values()].filter((item) => !(item as ImportRecord & ArchiveFlags).archived);
    });
  }
  async function refresh() {
    const version = ++refreshVersion.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    refreshing.current = true;
    try {
      const options = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) };
      const readers = {
        imports: () => api<(ImportRecord & ArchiveFlags)[]>('/v1/imports?lifecycle=all', options),
        products: () => api<ListingDraft[]>('/v1/products', options),
        shops: () => api<ShopConnection[]>('/v1/shops', options),
        plans: () => api<ChangePlan[]>('/v1/plans', options),
        jobs: () => api<JobRecord[]>('/v1/jobs', options),
        status: () =>
          api<{
            worker: string;
            workspaceResetId?: string;
            isolatedMode?: boolean;
            productionBatchWorkflow?: { enabled: boolean };
          }>('/v1/status', options),
      };
      const required = workspaceResources(livePage.current, sourceMode);
      const { values, errors } = await settleWorkspaceReads(
        Object.fromEntries(required.map((key) => [key, readers[key]])) as typeof readers,
      );
      if (controller.signal.aborted || version !== refreshVersion.current) return;
      if (values.status && applyWorkspaceReset(values.status)) return;
      if (values.imports) mergeImports(values.imports);
      if (values.products) setProducts(values.products);
      if (values.shops) setShops(values.shops);
      if (values.plans) setPlans(values.plans);
      if (values.jobs) setJobs(values.jobs);
      if (values.status) setStatus(values.status);
      setResourceErrors((previous) => {
        const next = { ...previous };
        for (const key of required) {
          delete next[key];
          if (errors[key]) next[key] = errors[key];
        }
        return next;
      });
      setResourceObservedAt((previous) => ({
        ...previous,
        ...Object.fromEntries(Object.keys(values).map((key) => [key, new Date().toISOString()])),
      }));
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      if (version === refreshVersion.current) {
        refreshing.current = false;
        setLoading(false);
      }
    }
  }
  const {
    uploadFiles,
    busy: uploadBusy,
    progress: uploadProgress,
  } = useFileUploads(refresh, saveBusy || folderBusy);
  useEffect(() => {
    void refresh();
  }, [page, sourceMode]);
  useEffect(() => {
    const requested = readWorkspaceDraftRoute(routeSearch);
    if (!requested || requested.page !== page) {
      setRouteBusy(false);
      setRouteError('');
      return;
    }
    const controller = new AbortController();
    setRouteBusy(true);
    setRouteError('');
    const restore = async () => {
      try {
        let latest: ListingDraft | null = null;
        try {
          latest = await api<ListingDraft>(
            '/v1/products/' + encodeURIComponent(requested.productKey),
            { signal: controller.signal },
          );
        } catch (cause) {
          if (
            !(cause instanceof RequestError) ||
            cause.status !== 404 ||
            requested.page !== 'editor' ||
            requested.revision !== 0
          )
            throw cause;
          const { findEditorRecoveries } = await import('./editor-recovery.js');
          const copy = findEditorRecoveries(localStorage, requested.productKey).find(
            (item) => item.expectedRevision === 0,
          );
          if (!copy)
            throw new Error(
              'Không có bản nguồn hoặc phần đang sửa của bộ này trên máy. Chọn lại đúng bộ từ danh sách.',
            );
          if (controller.signal.aborted) return;
          setDraft(null);
          setEditor(copy.seed);
          setEditorSection(copy.section);
          setEditorSourceIds(selectedSourceIds(copy.seed));
          setEditorVariants(copy.pending?.variants ?? []);
          setDirty(false);
          return;
        }
        if (controller.signal.aborted) return;
        if (!latest) throw new Error('Chưa đọc được đúng bản nguồn.');
        setDraft(latest);
        if (requested.page === 'editor') {
          if (!latest.sourceSelection)
            throw new Error(
              'Bộ này chưa có liên kết nguồn để sửa. Mở bản xem và bổ sung đúng hồ sơ nguồn.',
            );
          setEditor({
            ...latest.sourceSelection,
            productKey: latest.productKey,
            expectedRevision: latest.revision,
          });
          setEditorSourceIds(deriveDraftSourceImportIds(latest));
          setEditorVariants(
            latest.variants.map((variant) => ({
              sku: variant.sku.value,
              originalPrice: variant.originalPrice.value,
            })),
          );
        }
        setDirty(false);
        if (latest.revision !== requested.revision)
          setError(
            'Bộ nguồn đã có bản mới. Đang mở bản đã lưu mới nhất; phần đang sửa ở phiên bản trước được giữ riêng để đối chiếu.',
          );
      } catch (cause) {
        if (!controller.signal.aborted)
          setRouteError(cause instanceof Error ? cause.message : 'Chưa mở được đúng bộ nguồn.');
      } finally {
        if (!controller.signal.aborted) setRouteBusy(false);
      }
    };
    void restore();
    return () => controller.abort();
  }, [routeSearch, routeRetry, page]);
  useEffect(() => {
    if (page !== 'editor' || !editorSourceIds?.length) return;
    const controller = new AbortController(),
      queue = editorSourceIds.filter(
        (id) =>
          !importsRef.current.some(
            (record) => record.id === id && record.status === 'ready' && record.body,
          ),
      );
    if (!queue.length) return;
    setEditorHydrating(true);
    const read = async () => {
      const records: ImportRecord[] = [],
        failed: string[] = [];
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let id = queue.shift(); id && !controller.signal.aborted; id = queue.shift()) {
            try {
              const record = await api<ImportRecord>('/v1/imports/' + encodeURIComponent(id), {
                signal: controller.signal,
              });
              if (record.id !== id) throw new Error('Nguồn trả về khác bộ đã chọn.');
              records.push(record);
            } catch {
              if (!controller.signal.aborted) failed.push(id);
            }
          }
        }),
      );
      if (controller.signal.aborted) return;
      mergeImports(records);
      setEditorHydrating(false);
      if (failed.length)
        setError(
          `${failed.length} tệp của bộ này chưa đọc được. Giữ nguyên nội dung và bổ sung lại đúng tệp trước khi chọn ảnh hoặc lưu.`,
        );
    };
    void read();
    return () => {
      controller.abort();
      setEditorHydrating(false);
    };
  }, [page, editor?.productKey, editor?.expectedRevision, JSON.stringify(editorSourceIds)]);
  useEffect(() => {
    // Large immutable sources refresh on navigation/mutation, never on a heartbeat.
    // Imports only need polling while the parser is actually working.
    let polling = false;
    const controller = new AbortController();
    const poll = async () => {
      if (polling || refreshing.current || document.visibilityState === 'hidden') return;
      polling = true;
      try {
        const options = {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        };
        if (importsRef.current.some((item) => ['queued', 'running'].includes(item.status))) {
          const nextImports = await api<(ImportRecord & ArchiveFlags)[]>(
            '/v1/imports?lifecycle=all',
            options,
          );
          if (!controller.signal.aborted) mergeImports(nextImports);
        }
        const next = await api<{ worker: string; workspaceResetId?: string }>(
          '/v1/status',
          options,
        );
        if (controller.signal.aborted) return;
        if (applyWorkspaceReset(next)) return;
        setStatus(next);
        setResourceErrors((previous) => {
          const next = { ...previous };
          delete next.status;
          return next;
        });
        if (livePage.current === 'results') {
          const nextJobs = await api<JobRecord[]>('/v1/jobs', options);
          if (!controller.signal.aborted) setJobs(nextJobs);
        }
      } catch {
        if (!controller.signal.aborted)
          setResourceErrors((previous) => ({
            ...previous,
            status:
              'Chưa đọc lại được tình trạng hệ thống. Trạng thái đang hiển thị là lần đọc trước.',
          }));
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, []);
  useEffect(() => {
    if (!dirty && !uploadBusy && !saveBusy && !folderBusy && !folderDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, uploadBusy, saveBusy, folderBusy, folderDirty]);
  function go(next: Page) {
    if ((saveBusy || folderBusy || openingBatchRef.current) && next !== page) return false;
    if (uploadBusy && next !== page) {
      setError('Đang nhập tệp. Đợi tải xong để xem đủ kết quả trước khi chuyển màn hình.');
      return false;
    }
    if (dirty && next !== page) {
      setPendingPage(next);
      return false;
    }
    setError('');
    setPendingPage(null);
    if (next === 'folder') setFolderStarted(true);
    setPage(next);
    return true;
  }
  function openConnection(
    id: string | null,
    suppliedScope?: { environment: 'production' | 'sandbox'; partnerId: string; shopId: string },
  ) {
    if (!go('shops')) return;
    const shop = shops.find((row) => row.id === id);
    setConnectionDetail(id);
    const url = new URL(window.location.href);
    url.searchParams.set('page', 'shops');
    const scope = shop?.scope ?? suppliedScope;
    if (scope?.environment === 'production') {
      url.searchParams.set('connectShop', scope.shopId);
      url.searchParams.set('partnerId', scope.partnerId);
      url.searchParams.delete('connectionId');
    } else {
      url.searchParams.delete('connectShop');
      url.searchParams.delete('partnerId');
      if (id) url.searchParams.set('connectionId', id);
      else url.searchParams.delete('connectionId');
    }
    window.history.pushState({}, '', url.pathname + url.search);
  }
  useEffect(() => {
    const onBack = () => {
      const next = readWorkspacePage(window.location.search, null);
      const changedRoute = window.location.search !== routeSearch;
      if (next === livePage.current && !changedRoute) return;
      if (dirty || folderDirty || saveBusy || uploadBusy || folderBusy || openingBatchRef.current) {
        const source =
          livePage.current === 'editor' && editor?.productKey
            ? { productKey: editor.productKey, revision: editor.expectedRevision }
            : livePage.current === 'preview' && draft
              ? { productKey: draft.productKey, revision: draft.revision }
              : undefined;
        const previous = new URL(window.location.href);
        previous.search = routeSearch;
        window.history.pushState(
          {},
          '',
          workspaceNavigationUrl(previous.href, livePage.current, source, productionShopKey),
        );
        if (dirty || folderDirty) setPendingPage(next);
        else setError('Đang xử lý công việc. Đợi hoàn tất trước khi chuyển màn hình.');
        return;
      }
      navigationHistory.current = false;
      setRouteSearch(window.location.search);
      const query = new URLSearchParams(window.location.search);
      if (next === 'shops')
        setConnectionDetail(
          query.has('connectShop')
            ? `scope:${query.get('partnerId') ?? ''}:${query.get('connectShop') ?? ''}`
            : (query.get('connectionId') ?? undefined),
        );
      if (next === 'prepared-batches') {
        const partner = query.get('partnerId'),
          shop = query.get('shopId');
        setProductionShopKey(
          partner && shop && /^[1-9]\d*$/.test(partner) && /^[1-9]\d*$/.test(shop)
            ? partner + ':' + shop
            : '',
        );
      }
      setPage(next);
      setError('');
    };
    window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack);
  }, [
    dirty,
    folderDirty,
    saveBusy,
    uploadBusy,
    folderBusy,
    routeSearch,
    editor?.productKey,
    editor?.expectedRevision,
    draft?.productKey,
    draft?.revision,
    productionShopKey,
  ]);
  function startBatch(priceImportId?: string) {
    if (saveBusy || uploadBusy || folderBusy || openingBatchRef.current) return;
    if (dirty || folderDirty) {
      setError(
        'Đợt đang làm còn thay đổi chưa lưu. Mở lại đợt và lưu xong trước khi nhận thư mục mới.',
      );
      return;
    }
    setInitialBatch(undefined);
    setPendingPage(null);
    setInitialPriceImportId(priceImportId);
    setFolderInstanceKey(crypto.randomUUID());
    setFolderManual(null);
    setFolderManualDraft(undefined);
    setFolderStarted(true);
    setError('');
    setPage('folder');
    window.scrollTo(0, 0);
  }
  function startFreshIntakeSession() {
    if (saveBusy || uploadBusy || folderBusy || openingBatchRef.current) return;
    if (dirty || folderDirty) {
      setError(
        'Còn thay đổi chưa lưu. Lưu hoặc bỏ thay đổi ở màn đang làm trước khi bắt đầu phiên nhập mới.',
      );
      return;
    }
    setIntakeSessionNotice('');
    try {
      sessionStorage.removeItem('shopee:prepared-intake:v1');
      sessionStorage.removeItem('production-preparation-working-copy-v1');
    } catch {
      setError('Trình duyệt chưa cho phép bỏ lựa chọn tạm. Kiểm tra quyền lưu trữ rồi thử lại.');
      return;
    }
    setDraft(null);
    setEditor(null);
    setEditorVariants([]);
    setEditorSourceIds(null);
    startBatch();
    setIntakeSessionNotice('Đã bỏ lựa chọn tạm. Dữ liệu đã lưu vẫn ở kho.');
  }
  async function resumeBatch(id: string) {
    if (saveBusy || uploadBusy || folderBusy || openingBatchRef.current) return;
    if (dirty || folderDirty) {
      setError(
        'Còn thay đổi chưa lưu trong đợt đang mở. Giữ hoặc bỏ những thay đổi đó trước khi mở bản đã lưu.',
      );
      return;
    }
    openingBatchRef.current = true;
    setOpeningBatch(true);
    setError('');
    try {
      const saved = await api<InputBatchDetail>('/v1/input-batches/' + encodeURIComponent(id));
      setImports((current) => [
        ...current.filter((item) => !saved.imports.some((source) => source.id === item.id)),
        ...saved.imports,
      ]);
      setInitialBatch(saved);
      setPendingPage(null);
      setInitialPriceImportId(undefined);
      setFolderInstanceKey(crypto.randomUUID());
      setFolderManual(null);
      setFolderManualDraft(undefined);
      setFolderStarted(true);
      setPage('folder');
      window.scrollTo(0, 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa mở được đợt đã lưu.');
    } finally {
      openingBatchRef.current = false;
      setOpeningBatch(false);
    }
  }
  function openFolderEditor(
    seed: EditorSeed,
    variants: { sku: string; originalPrice?: string }[] = [],
  ) {
    if (saveBusy || uploadBusy || folderBusy) return;
    setEditor(seed);
    setEditorSourceIds(selectedSourceIds(seed));
    setEditorVariants(variants);
    setEditorSection('content');
    setEditorOrigin('folder');
    setDraft(null);
    setDirty(true);
    setPage('editor');
    window.scrollTo(0, 0);
  }
  function completeFolderMembership(context?: FolderManualContext) {
    if (saveBusy || uploadBusy || folderBusy) return;
    setFolderManual(context ?? null);
    if (context) {
      setFolderManualDraft({
        ...newIntakeDraft(),
        productKey: context.productKey,
        sourceId: context.priceSource.importId,
        sheet: context.priceSource.sheet,
        profileChoice: JSON.stringify(context.priceSource.priceProfile),
        step: 2,
      });
    } else setFolderManualDraft(undefined);
    setPage('import');
    setDirty(false);
    window.scrollTo(0, 0);
  }
  function open(d: ListingDraft) {
    setPendingPage(null);
    setDraft(d);
    setPage('preview');
    setDirty(false);
    setError('');
    window.scrollTo(0, 0);
  }
  async function openLatestSource(
    key: string,
    section: 'content' | 'images' | 'structure' = 'content',
  ) {
    try {
      const latest = await api<ListingDraft>('/v1/products/' + encodeURIComponent(key));
      if (!latest.sourceSelection) {
        open(latest);
        return;
      }
      setPendingPage(null);
      setDraft(latest);
      setEditorSourceIds(deriveDraftSourceImportIds(latest));
      setEditor({
        ...latest.sourceSelection,
        productKey: latest.productKey,
        expectedRevision: latest.revision,
      });
      setEditorSection(section);
      setEditorVariants(
        latest.variants.map((variant) => ({
          sku: variant.sku.value,
          originalPrice: variant.originalPrice.value,
        })),
      );
      setDirty(false);
      setError('');
      setPage('editor');
      window.scrollTo(0, 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa mở được nguồn mới nhất.');
    }
  }
  function edit(section: 'content' | 'images' | 'structure' = 'content') {
    if (draft?.sourceSelection) {
      setEditorSourceIds(deriveDraftSourceImportIds(draft));
      setEditor({
        ...draft.sourceSelection,
        productKey: draft.productKey,
        expectedRevision: draft.revision,
      });
      setEditorSection(section);
      setEditorVariants(
        draft.variants.map((variant) => ({
          sku: variant.sku.value,
          originalPrice: variant.originalPrice.value,
        })),
      );
      setPage('editor');
      window.scrollTo(0, 0);
    }
  }
  async function uploadEditorFiles(files: FileList | null) {
    if (!files?.length || saveBusy || uploadBusy || folderBusy || editorUploadGuard.current) return;
    editorUploadGuard.current = true;
    setFolderBusy(true);
    setError('');
    try {
      const result = await readFolderFiles(Array.from(files));
      mergeImports(result.flatMap((item) => (item.record ? [item.record] : [])));
      setEditorSourceIds((ids) => [
        ...new Set([
          ...(ids ?? []),
          ...result.flatMap((item) => (item.record ? [item.record.id] : [])),
        ]),
      ]);
      await refresh();
      const unread = result.filter((item) => item.record?.status !== 'ready');
      if (unread.length)
        setError(
          `${unread.length} tệp chưa đọc được: ${unread.map((item) => item.relativePath).join(', ')}. Giữ phần đang nhập và chọn lại các tệp này để thử tiếp.`,
        );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Chưa nhận đủ tệp. Giữ phần đang nhập để thử lại.',
      );
    } finally {
      editorUploadGuard.current = false;
      setFolderBusy(false);
    }
  }
  const parent = ['import', 'folder'].includes(page)
    ? 'sources'
    : ['preview', 'editor'].includes(page)
      ? 'products'
      : page;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace-main">
        Đến nội dung chính
      </a>
      <header className="app-header task-navigation">
        <button
          className="app-brand"
          onClick={() => go('overview')}
          aria-label="Về trung tâm vận hành"
        >
          <span className="brand-tile">
            <LayoutList size={23} />
          </span>
          <span>
            <strong>Listing Studio</strong>
            <small>Quản lý sản phẩm & shop</small>
          </span>
        </button>
        <nav aria-label="Điều hướng chính" className="main-nav">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={parent === id ? 'page' : undefined}
              className={parent === id ? 'active' : ''}
              onClick={() => go(id)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
        <details
          className="workspace-tools"
          ref={toolsDisclosure}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && toolsDisclosure.current) {
              toolsDisclosure.current.open = false;
              toolsDisclosure.current.querySelector('summary')?.focus();
            }
          }}
        >
          <summary>Công cụ</summary>
          <nav aria-label="Công cụ bổ sung">
            {secondaryNavigation.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => go(id)}
                aria-current={page === id ? 'page' : undefined}
              >
                <Icon size={17} />
                {label}
              </button>
            ))}
          </nav>
        </details>
      </header>
      <div className="environment-bar">
        <span>
          <span className={'dot ' + (status?.worker === 'online' ? 'online' : '')} />
          {resourceErrors.status
            ? 'Tình trạng hệ thống chưa được cập nhật'
            : loading
              ? 'Đang đọc tình trạng hệ thống…'
              : status?.worker === 'online'
                ? 'Bộ đọc nguồn đang hoạt động'
                : status?.worker === 'offline'
                  ? 'Bộ đọc nguồn chưa chạy — kiểm tra trình khởi động ứng dụng'
                  : 'Chưa đọc được tình trạng hệ thống; dữ liệu đã tải vẫn được giữ'}
        </span>
        {!loading && status?.worker !== 'online' && (
          <button className="text-button" onClick={() => void refresh()}>
            Đọc lại tình trạng
          </button>
        )}
        <span>
          {status?.isolatedMode
            ? 'Bản thử riêng · Không gửi yêu cầu tới Shopee'
            : status?.productionBatchWorkflow?.enabled === false
              ? 'Luồng đăng đang tắt · Nguồn đã lưu vẫn được giữ'
              : 'Mỗi lần gửi cần đúng shop, nguồn và đối chiếu kết quả'}
        </span>
      </div>
      <main
        id="workspace-main"
        className={'workspace-main' + (page === 'sources' ? ' source-home-main' : '')}
      >
        {uploadProgress}
        {intakeSessionNotice && (
          <p role="status" className="context-note">
            {intakeSessionNotice}
          </p>
        )}
        {folderBusy && (
          <p role="status" className="context-note">
            Đang nhận hoặc lưu đợt nhập. Giữ trang mở đến khi có xác nhận đã lưu.
          </p>
        )}
        {openingBatch && (
          <p role="status" className="context-note">
            Đang mở đợt nhập đã lưu…
          </p>
        )}
        {saveBusy && (
          <p role="status" className="context-note">
            Đang lưu. Đợi kết quả trước khi chuyển màn hình; yêu cầu đang gửi chưa thể hủy bằng cách
            rời trang.
          </p>
        )}
        {(loadError || error) && (
          <div role="alert" className="banner error">
            <span>{error || loadError}</span>
            <button
              onClick={() => {
                setError('');
                void refresh();
              }}
            >
              Thử lại
            </button>
          </div>
        )}
        {routeBusy && (
          <p role="status" className="banner">
            Đang mở đúng bộ nguồn từ đường dẫn…
          </p>
        )}
        {routeError && (
          <div className="banner error" role="alert">
            <p>{routeError}</p>
            <button onClick={() => setRouteRetry((value) => value + 1)}>Đọc lại bộ này</button>
            <button onClick={() => go('products')}>Về bộ listing</button>
          </div>
        )}
        {workspaceResources(page, sourceMode)
          .filter((key) => resourceErrors[key])
          .map((key) => (
            <div key={key} role="alert" className="banner error">
              <div>
                <strong>
                  {
                    {
                      imports: 'Tệp nguồn',
                      products: 'Bộ listing',
                      shops: 'Kết nối shop',
                      plans: 'Bản kiểm tra',
                      jobs: 'Công việc',
                      status: 'Tình trạng hệ thống',
                    }[key]
                  }{' '}
                  chưa được cập nhật
                </strong>
                <p>{resourceErrors[key]}</p>
                {resourceObservedAt[key] && (
                  <small>Dữ liệu đang hiển thị từ {date(resourceObservedAt[key]!)}</small>
                )}
              </div>
              <button onClick={() => void refresh()}>Tải lại mục này</button>
            </div>
          ))}
        {pendingPage && (
          <div role="alertdialog" aria-label="Thay đổi chưa lưu" className="unsaved-notice">
            <div>
              <strong>Bạn có thay đổi chưa lưu</strong>
              <p>
                {page === 'editor' &&
                editor?.expectedRevision === 0 &&
                ['import', 'folder'].includes(pendingPage)
                  ? 'Quay lại sẽ bỏ nội dung và ảnh chưa lưu tại màn này. Bảng SKU và nguồn giá vẫn được giữ để bạn tiếp tục.'
                  : page === 'folder'
                    ? 'Rời màn hình sẽ bỏ những lựa chọn chưa lưu. Bạn vẫn có thể mở lại bản đã lưu từ Kho đầu vào.'
                    : 'Rời màn hình sẽ bỏ phần đang nhập. Bản đã lưu vẫn được giữ.'}
              </p>
            </div>
            <div className="actions">
              <button onClick={() => setPendingPage(null)}>Ở lại</button>
              <button
                disabled={saveBusy || uploadBusy || folderBusy}
                onClick={() => {
                  setDirty(false);
                  if (page === 'import' && !folderManual) clearIntakeRecovery();
                  else if (
                    page === 'editor' &&
                    editor?.expectedRevision === 0 &&
                    !['import', 'folder'].includes(pendingPage)
                  )
                    clearIntakeRecovery(editor.productKey);
                  if (page === 'folder') {
                    setFolderStarted(false);
                    setFolderDirty(false);
                    setFolderManual(null);
                    setFolderManualDraft(undefined);
                  }
                  if (pendingPage === 'folder') setFolderStarted(true);
                  setPage(pendingPage);
                  setPendingPage(null);
                }}
              >
                Bỏ thay đổi và rời đi
              </button>
            </div>
          </div>
        )}
        {loading ? (
          <div role="status" className="empty">
            Đang tải listing và nguồn đã lưu…
          </div>
        ) : (
          <WorkspaceSectionBoundary scope={page}>
            <Suspense
              fallback={
                <div role="status" className="empty">
                  Đang mở mục công việc…
                </div>
              }
            >
              {page === 'overview' && (
                <OperationsCenter
                  onNavigate={(next, scope) => {
                    if (scope?.environment === 'production')
                      setProductionShopKey(scope.partnerId + ':' + scope.shopId);
                    if (next === 'production') {
                      setProductionView('working');
                      go('prepared-batches');
                    } else go(next);
                  }}
                  onImport={() => startBatch()}
                  onConnect={openConnection}
                />
              )}
              {page === 'prepared-batches' && (
                <>
                  <section className="panel" aria-label="Shop đích đang chọn">
                    <label htmlFor="production-target-shop">
                      <strong>Đăng vào shop</strong>
                    </label>
                    {productionShops.length ? (
                      <>
                        <select
                          id="production-target-shop"
                          value={
                            unavailableConnectionId
                              ? 'unavailable:' + unavailableConnectionId
                              : productionShopKey
                          }
                          onChange={(event) => {
                            setProductionShopKey(event.target.value);
                            setUnavailableConnectionId(null);
                          }}
                        >
                          <option value="">Chọn rõ shop đích</option>
                          {unavailableConnectionId && (
                            <option value={'unavailable:' + unavailableConnectionId}>
                              Kết nối đã chọn cần được đọc lại
                            </option>
                          )}
                          {productionShopKey &&
                            !selectedProductionShop &&
                            !unavailableConnectionId && (
                              <option value={productionShopKey}>
                                Chưa đọc được shop đã chọn · {productionShopKey.split(':')[1]}
                              </option>
                            )}
                          {productionShops.map((shop) => (
                            <option key={shop.id} value={savedShopKey(shop)}>
                              {shop.displayName || shop.name} · Shop {shop.scope.shopId}
                              {shop.state === 'connected' ? '' : ' · Cần xử lý kết nối'}
                            </option>
                          ))}
                        </select>
                        {selectedProductionShop && (
                          <p className="caption">
                            Shop đích:{' '}
                            <strong>
                              {selectedProductionShop.displayName || selectedProductionShop.name}
                            </strong>{' '}
                            · Shop ID {selectedProductionShop.scope.shopId} · Partner ID{' '}
                            {selectedProductionShop.scope.partnerId}. Mỗi lô được khóa với shop này.
                          </p>
                        )}
                        {!selectedProductionShop && (
                          <p className="context-note">
                            Chọn shop đích để mở đúng đợt đã lưu. Ứng dụng không tự chọn một shop
                            thay thế.
                          </p>
                        )}
                        {unavailableConnectionId && (
                          <p role="alert" className="context-note">
                            Kết nối đã chọn trong bộ listing chưa được đọc lại. Các đợt của shop
                            khác được giữ riêng.{' '}
                            <button onClick={() => openConnection(unavailableConnectionId)}>
                              Kiểm tra kết nối đã chọn
                            </button>
                          </p>
                        )}
                        {selectedProductionShop && !selectedProductionScope && (
                          <p role="alert" className="context-note">
                            Shop đang chọn cần xử lý kết nối. Các đợt của shop khác không được dùng
                            thay.{' '}
                            <button onClick={() => openConnection(selectedProductionShop.id)}>
                              Xử lý kết nối này
                            </button>
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="empty">
                        Chưa có shop production đang kết nối. Mở Kết nối shop và hoàn tất cấp quyền
                        trước khi chuẩn bị lô.
                      </p>
                    )}
                  </section>
                  <div
                    className="production-workflow-tabs"
                    role="tablist"
                    aria-label="Luồng đăng hàng"
                  >
                    <button
                      type="button"
                      role="tab"
                      id="production-working-tab"
                      aria-controls="production-working-panel"
                      aria-selected={productionView === 'working'}
                      onClick={() => setProductionView('working')}
                    >
                      Đợt đang làm
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="production-new-tab"
                      aria-controls="production-new-panel"
                      aria-selected={productionView === 'new'}
                      onClick={() => setProductionView('new')}
                    >
                      Chuẩn bị lô mới
                    </button>
                  </div>
                  <div
                    id="production-working-panel"
                    role="tabpanel"
                    aria-labelledby="production-working-tab"
                    hidden={productionView !== 'working'}
                  >
                    {selectedProductionScope && (
                      <ProductionBatches
                        key={`${productionBatchVersion}:${productionShopKey}`}
                        targetScope={selectedProductionScope}
                        targetShopName={
                          selectedProductionShop?.displayName || selectedProductionShop?.name
                        }
                        active={productionView === 'working'}
                        onImageQc={() => go('image-qc')}
                        onSource={(key) => void openLatestSource(key)}
                      />
                    )}
                    <PreviousProductionResults />
                  </div>
                  <div
                    id="production-new-panel"
                    role="tabpanel"
                    aria-labelledby="production-new-tab"
                    hidden={productionView !== 'new'}
                  >
                    {selectedProductionScope && (
                      <ProductionPreparation
                        key={productionShopKey}
                        initialProductKey={preparationSource?.productKey}
                        initialSourceRevision={preparationSource?.revision}
                        targetScope={selectedProductionScope}
                        targetShopName={
                          selectedProductionShop?.displayName || selectedProductionShop?.name
                        }
                        onFolders={() => startBatch()}
                        onWorking={() => setProductionView('working')}
                        onSource={(key, section) => void openLatestSource(key, section)}
                        onRegistered={() => {
                          setProductionBatchVersion((value) => value + 1);
                          setPreparationSource(null);
                        }}
                      />
                    )}
                    <details
                      className="production-pilot-legacy"
                      onToggle={(event) => setShowLegacyPrepared(event.currentTarget.open)}
                    >
                      <summary>Công cụ chuẩn bị lô khác</summary>
                      {showLegacyPrepared && <PreparedBatch />}
                    </details>
                  </div>
                </>
              )}
              {page === 'image-qc' && <ImageQuality />}
              {page === 'sandbox-tryout' && <SandboxTryout />}
              {page === 'workbench' && (
                <Workbench
                  onUpdates={(workOrderId, receiptId) => {
                    setPatchTarget(workOrderId);
                    setPatchReceipt(receiptId);
                    setPatchInstance((value) => value + 1);
                    go('updates');
                  }}
                  onReceive={() => go('handoff')}
                  onFolders={() => startBatch()}
                  onSource={open}
                  onShops={() => go('shops')}
                  onDirty={setDirty}
                  onBusy={setSaveBusy}
                />
              )}
              {page === 'updates' && (
                <ImportUpdates
                  key={patchInstance}
                  initialWorkOrderId={patchTarget}
                  initialReceiptId={patchReceipt}
                  onBack={() => go('workbench')}
                  onDirty={setDirty}
                  onBusy={setSaveBusy}
                />
              )}
              {page === 'handoff' && (
                <>
                  <button className="back-link" onClick={() => go('workbench')}>
                    <ArrowLeft size={15} /> Về công việc đăng hàng
                  </button>
                  <HandoffIntake
                    products={products}
                    onSaved={(saved) => {
                      setDirty(false);
                      setProducts((current) => [
                        saved,
                        ...current.filter((source) => source.productKey !== saved.productKey),
                      ]);
                      void refresh();
                      setPage('workbench');
                    }}
                    onFolder={() => startBatch()}
                    onDirty={setDirty}
                    onBusy={setSaveBusy}
                    externalBusy={uploadBusy || folderBusy}
                  />
                </>
              )}
              {page === 'products' && (
                <ListingLibrary
                  onImport={() => startBatch()}
                  onOpen={open}
                  onBusy={setSaveBusy}
                  onPrepare={() => {
                    setPreparationSource(null);
                    setProductionView('new');
                    go('prepared-batches');
                  }}
                />
              )}
              {page === 'sources' && (
                <section className="source-workspace">
                  <div className="source-workspace-topline">
                    <header className="source-workspace-heading">
                      <h1>Kho nguồn</h1>
                    </header>
                    <nav className="source-workspace-modes" aria-label="Chế độ kho listing">
                      <button
                        aria-pressed={sourceMode === 'catalog'}
                        disabled={uploadBusy || openingBatch || saveBusy || folderBusy}
                        onClick={() => setSourceMode('catalog')}
                      >
                        Dữ liệu đã nhận
                      </button>
                      <button
                        aria-pressed={sourceMode === 'intake'}
                        disabled={uploadBusy || openingBatch || saveBusy || folderBusy}
                        onClick={() => setSourceMode('intake')}
                      >
                        Nhập Word / ảnh / bảng giá
                      </button>
                    </nav>
                    <button
                      type="button"
                      disabled={uploadBusy || openingBatch || saveBusy || folderBusy}
                      onClick={startFreshIntakeSession}
                    >
                      Bắt đầu phiên nhập mới
                    </button>
                  </div>
                  {sourceMode === 'catalog' ? (
                    <SourceCatalog onImport={() => setSourceMode('intake')} />
                  ) : (
                    <>
                      <p className="source-intake-context">
                        Dành cho bộ Word, ảnh và bảng giá có sẵn. Excel nội dung đã tiếp nhận nằm ở
                        mục Dữ liệu đã nhận.
                      </p>
                      <Resources
                        imports={imports}
                        products={products}
                        uploadFiles={uploadFiles}
                        uploading={uploadBusy || openingBatch}
                        onNewBatch={startBatch}
                        onResumeBatch={(id) => void resumeBatch(id)}
                        onOpenListing={open}
                      />
                    </>
                  )}
                </section>
              )}
              {folderStarted && (
                <div hidden={page !== 'folder'}>
                  <FolderIntake
                    key={folderInstanceKey}
                    initialBatch={initialBatch}
                    initialPriceImportId={initialPriceImportId}
                    onOpenLibrary={() => {
                      setSourceMode('intake');
                      go('sources');
                    }}
                    imports={imports}
                    products={products}
                    active={page === 'folder'}
                    externalBusy={uploadBusy || saveBusy}
                    onRead={async (files, progress) => {
                      const result = await readFolderFiles(files, progress);
                      setImports((current) => {
                        const merged = new Map(current.map((item) => [item.id, item]));
                        for (const item of result)
                          if (item.record) merged.set(item.record.id, item.record);
                        return [...merged.values()];
                      });
                      await refresh();
                      return result;
                    }}
                    onContinue={openFolderEditor}
                    onOpenExisting={open}
                    onManual={completeFolderMembership}
                    onBusy={setFolderBusy}
                    onDirty={(value) => {
                      setFolderDirty(value);
                      if (page === 'folder') setDirty(value);
                    }}
                  />
                </div>
              )}
              {page === 'import' && (
                <>
                  <button
                    className="back-link"
                    onClick={() => go(folderManual ? 'folder' : 'products')}
                  >
                    <ArrowLeft size={15} />
                    {folderManual ? 'Về các thư mục đang xử lý' : 'Listing của tôi'}
                  </button>
                  <ListingImport
                    key={folderManual?.productKey ?? 'manual'}
                    imports={imports}
                    initialDraft={folderManual ? folderManualDraft : undefined}
                    onDraft={folderManual ? setFolderManualDraft : undefined}
                    onDirty={setDirty}
                    onCancel={() => go(folderManual ? 'folder' : 'products')}
                    onSources={() => {
                      setSourceMode('intake');
                      go('sources');
                    }}
                    onUploadFiles={uploadFiles}
                    externalBusy={uploadBusy || saveBusy || folderBusy}
                    onContinue={(seed, variants = []) => {
                      if (uploadBusy || saveBusy || folderBusy) return;
                      if (products.some((p) => p.productKey === seed.productKey)) {
                        setError(
                          'Mã bộ này đã tồn tại. Mở listing đã lưu để đối chiếu; không nhập lại thành bản khác.',
                        );
                        return;
                      }
                      setEditor(folderManual ? { ...seed, ...folderManual.prepared } : seed);
                      setEditorSourceIds([
                        ...new Set([
                          ...(folderManual?.sourceImportIds ?? []),
                          ...(selectedSourceIds(seed) ?? []),
                        ]),
                      ]);
                      setEditorVariants(variants);
                      setEditorSection('content');
                      setEditorOrigin('import');
                      setDraft(null);
                      setPage('editor');
                      setDirty(true);
                      window.scrollTo(0, 0);
                    }}
                  />
                </>
              )}
              {page === 'preview' && draft && (
                <>
                  {folderStarted && (
                    <button className="back-link" onClick={() => go('folder')}>
                      <ArrowLeft size={15} /> Về các thư mục đang xử lý
                    </button>
                  )}
                  <button className="back-link" onClick={() => go('products')}>
                    <ArrowLeft size={15} />
                    Listing của tôi
                  </button>
                  <Preview
                    key={draft.productKey + draft.revision}
                    draft={draft}
                    shops={shops}
                    onEdit={edit}
                    onBusy={setSaveBusy}
                    selectedShopConnectionId={selectedProductionShop?.id ?? null}
                    onProduction={({ productKey, revision, shopConnectionId }) => {
                      const chosen = shops.find(
                        (shop) =>
                          shop.id === shopConnectionId && shop.scope.environment === 'production',
                      );
                      if (chosen) setProductionShopKey(savedShopKey(chosen));
                      else if (shopConnectionId) setUnavailableConnectionId(shopConnectionId);
                      else {
                        setProductionShopKey('');
                        setUnavailableConnectionId(null);
                      }
                      if (chosen) setUnavailableConnectionId(null);
                      setPreparationSource({ productKey, revision });
                      setProductionView('new');
                      go('prepared-batches');
                    }}
                    onMappingConfirmed={open}
                    onUpdates={() => go('updates')}
                    onPlan={() => {
                      setPendingPage(null);
                      void refresh();
                      setPage('results');
                    }}
                  />
                </>
              )}
              {page === 'editor' && editor && (
                <Editor
                  key={editor.productKey + ':' + editor.expectedRevision}
                  seed={editor}
                  sourceImportIds={editorSourceIds}
                  onOpenLatest={open}
                  imports={
                    editorSourceIds
                      ? imports.filter((item) => editorSourceIds.includes(item.id))
                      : []
                  }
                  initialSection={editorSection}
                  variantSummaries={editorVariants}
                  onUploadFiles={uploadEditorFiles}
                  externalBusy={uploadBusy || folderBusy || editorHydrating || routeBusy}
                  onDirty={setDirty}
                  onBusy={setSaveBusy}
                  onCancel={() => go(draft ? 'preview' : editorOrigin)}
                  onSaved={(d) => {
                    clearIntakeRecovery(d.productKey);
                    setDirty(false);
                    void refresh();
                    open(d);
                  }}
                />
              )}
              {page === 'results' && (
                <>
                  <div className="page-heading">
                    <div>
                      <h1>Kết quả</h1>
                      <p>Phân biệt bộ đã lưu để kiểm tra với công việc thực sự gửi lên Shopee.</p>
                    </div>
                  </div>
                  <div className="tabbar">
                    <button
                      aria-pressed={resultTab === 'plans'}
                      onClick={() => setResultTab('plans')}
                    >
                      Bản kiểm tra theo shop <span>{plans.length}</span>
                    </button>
                    <button
                      aria-pressed={resultTab === 'jobs'}
                      onClick={() => setResultTab('jobs')}
                    >
                      Hàng đợi công việc <span>{jobs.length}</span>
                    </button>
                  </div>
                  {resultTab === 'plans' ? (
                    plans.length ? (
                      plans.map((p) => (
                        <section className="panel" key={p.id}>
                          <div className="section-heading">
                            <div>
                              <span className="tag neutral">
                                {p.scope.environment === 'sandbox' ? 'TEST' : 'SHOP THẬT'} ·{' '}
                                {p.scope.shopId}
                              </span>
                              <h2>{p.desired.title.value}</h2>
                              <p className="caption">
                                {p.operation === 'create'
                                  ? 'Chuẩn bị đăng mới'
                                  : p.operation === 'update'
                                    ? 'Chuẩn bị cập nhật'
                                    : 'Chuẩn bị khuyến mại'}{' '}
                                · Bản nguồn {p.sourceRevision} · {date(p.createdAt)}
                              </p>
                            </div>
                            <button onClick={() => open(p.desired)}>Xem bản đã lưu</button>
                          </div>
                          <div className="application-limit">
                            <strong>Bản kiểm tra nội bộ · chưa gửi yêu cầu đăng</strong>
                            <p>
                              Đây là bản lưu của luồng kiểm tra cũ. Các thông báo khóa gửi trong bản
                              này không phản ánh trạng thái kết nối hoặc đợt đăng API hiện tại. Mở
                              Đợt đang làm để tiếp tục đúng sản phẩm và xem kết quả thực tế.
                            </p>
                            <button
                              onClick={() => {
                                setProductionView('working');
                                go('prepared-batches');
                              }}
                            >
                              Mở đợt đăng qua API
                            </button>
                          </div>
                          {p.issues.some((i) => i.code === 'DUPLICATE_SKU') && (
                            <p className="caption">
                              SKU có trong nhiều dòng hoặc bộ giá của Excel. Đây là cảnh báo chọn
                              nguồn giá, không phải kết luận phân loại trong listing bị trùng. Luồng
                              đăng kiểm lại đúng dòng và bộ giá đã chọn trước khi gửi.
                            </p>
                          )}
                          <Issues
                            issues={p.issues.filter(
                              (i) =>
                                !['PRODUCTION_READ_ONLY', 'EXECUTOR_NOT_RELEASED'].includes(i.code),
                            )}
                          />
                          <details>
                            <summary>Thông báo được lưu cùng bản kiểm tra cũ</summary>
                            <Issues
                              issues={p.issues.filter((i) =>
                                ['PRODUCTION_READ_ONLY', 'EXECUTOR_NOT_RELEASED'].includes(i.code),
                              )}
                            />
                          </details>
                        </section>
                      ))
                    ) : (
                      <EmptyResults onBack={() => go('products')} />
                    )
                  ) : jobs.length ? (
                    jobs.map((j) => (
                      <section className="panel" key={j.id}>
                        <span className="tag">{jobLabel(j.state)}</span>
                        <h2>
                          {j.scope.environment === 'sandbox' ? 'TEST' : 'SHOP THẬT'} ·{' '}
                          {j.scope.shopId}
                        </h2>
                        <p>{j.message}</p>
                        <p className="caption">{date(j.createdAt)}</p>
                        <p>Thao tác điều khiển công việc chưa mở trong bản hiện tại.</p>
                      </section>
                    ))
                  ) : (
                    <EmptyResults onBack={() => go('products')} />
                  )}
                </>
              )}
              {page === 'assistant' && <AssistantPanel plans={plans} />}
              {page === 'archives' && <ShopArchive />}
              {page === 'guide' && (
                <UsageGuide
                  onImport={() => startBatch()}
                  onListings={() => go('products')}
                  onProduction={() => go('prepared-batches')}
                />
              )}
              {page === 'shops' && (
                <>
                  <div className="page-heading">
                    <div>
                      <h1>Kết nối shop</h1>
                      <p>Kiểm tra đúng tài khoản và môi trường trước khi dùng dữ liệu của shop.</p>
                    </div>
                  </div>
                  <ShopConnectionsOverview
                    shops={shops}
                    selectedShopId={selectedProductionShop?.id}
                    onSelectShop={(id) => {
                      const shop = shops.find((row) => row.id === id);
                      if (shop?.scope.environment === 'production')
                        setProductionShopKey(savedShopKey(shop));
                    }}
                    onConnectShop={openConnection}
                    onRefresh={refresh}
                  />
                  {connectionDetail !== undefined && (
                    <section className="connection-detail" aria-label="Chi tiết kết nối đang mở">
                      <button
                        type="button"
                        className="back-link"
                        onClick={() => {
                          setConnectionDetail(undefined);
                          const url = new URL(window.location.href);
                          url.searchParams.delete('connectShop');
                          url.searchParams.delete('partnerId');
                          url.searchParams.delete('connectionId');
                          window.history.replaceState({}, '', url.pathname + url.search);
                        }}
                      >
                        <ArrowLeft size={15} /> Đóng chi tiết kết nối
                      </button>
                      {typeof connectionDetail === 'string' &&
                      !connectionDetail.startsWith('scope:') &&
                      !shops.some((shop) => shop.id === connectionDetail) ? (
                        <p role="alert">
                          Chưa đọc được kết nối đã chọn. Đọc lại danh sách shop để đối chiếu đúng
                          Shop ID và Partner ID; ứng dụng giữ nguyên lựa chọn.
                        </p>
                      ) : shops.find((shop) => shop.id === connectionDetail)?.scope.environment ===
                        'sandbox' ? (
                        <ConnectionForm
                          shop={shops.find((shop) => shop.id === connectionDetail)!}
                          onConnected={() => void refresh()}
                        />
                      ) : (
                        <ProductionConnectionForm
                          key={connectionDetail ?? 'new'}
                          initialScope={
                            connectionDetail === null
                              ? null
                              : shops.find((shop) => shop.id === connectionDetail)?.scope
                          }
                          onConnected={() => void refresh()}
                        />
                      )}
                    </section>
                  )}
                  <p className="caption">
                    Khả năng đăng hoặc cập nhật được kiểm tra trong từng luồng thao tác. Khóa và
                    token được giữ ở máy chủ ứng dụng.
                  </p>
                </>
              )}
            </Suspense>
          </WorkspaceSectionBoundary>
        )}
      </main>
    </div>
  );
}
function EmptyResults({ onBack }: { onBack: () => void }) {
  return (
    <div className="empty">
      <CheckCheck size={32} />
      <h2>Chưa có kết quả ở mục này</h2>
      <p>Nhập nguồn, lưu listing và kiểm tra tài liệu chưa gửi sản phẩm lên Shopee.</p>
      <button onClick={onBack}>Về listing của tôi</button>
    </div>
  );
}
function jobLabel(state: string) {
  return (
    (
      {
        queued: 'Đang chờ',
        running: 'Đang xử lý',
        waiting_retry: 'Chờ thử lại',
        waiting_input: 'Cần bổ sung',
        waiting_external: 'Chờ Shopee',
        unknown: 'Chưa rõ kết quả',
        verified: 'Đã đối chiếu',
        failed: 'Cần xử lý lỗi',
        cancelled: 'Đã hủy',
      } as Record<string, string>
    )[state] ?? state
  );
}
