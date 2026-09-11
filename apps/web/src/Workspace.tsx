import { useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import type { ChangePlan, JobRecord, ListingDraft, ShopConnection } from '@shopee/domain';
import { api, date, money, type ImportRecord } from './api.js';
import { Editor, type EditorSeed } from './Editor.js';
import { Issues, Preview } from './Preview.js';
import { Resources } from './Resources.js';
import { ListingImport } from './ListingImport.js';
import { ConnectionForm } from './ConnectionForm.js';
import { AssistantPanel } from './AssistantPanel.js';
import { useFileUploads } from './useFileUploads.js';
import { clearIntakeRecovery } from './intake-state.js';
import { UsageGuide } from './UsageGuide.js';
import { FolderIntake, type FolderManualContext } from './FolderIntake.js';
import { createFolderReader } from './folder-reader.js';
import { newIntakeDraft, type IntakeDraft } from './intake-state.js';
type Page =
  | 'products'
  | 'sources'
  | 'results'
  | 'shops'
  | 'assistant'
  | 'preview'
  | 'editor'
  | 'import'
  | 'guide'
  | 'folder';
const navigation = [
  { id: 'products', label: 'Listing của tôi', icon: LayoutList },
  { id: 'sources', label: 'Tệp nguồn', icon: Files },
  { id: 'results', label: 'Kết quả', icon: CheckCheck },
] as const;
export default function Workspace() {
  const [page, setPage] = useState<Page>('products'),
    [imports, setImports] = useState<ImportRecord[]>([]),
    [products, setProducts] = useState<ListingDraft[]>([]),
    [shops, setShops] = useState<ShopConnection[]>([]),
    [plans, setPlans] = useState<ChangePlan[]>([]),
    [jobs, setJobs] = useState<JobRecord[]>([]),
    [status, setStatus] = useState<{ worker: string } | null>(null),
    [loadError, setLoadError] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [draft, setDraft] = useState<ListingDraft | null>(null),
    [editor, setEditor] = useState<EditorSeed | null>(null),
    [editorVariants, setEditorVariants] = useState<{ sku: string; originalPrice?: string }[]>([]),
    [editorSourceIds, setEditorSourceIds] = useState<string[] | null>(null),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [resultTab, setResultTab] = useState<'plans' | 'jobs'>('plans'),
    [dirty, setDirty] = useState(false),
    [editorSection, setEditorSection] = useState<'content' | 'images' | 'structure'>('content'),
    [saveBusy, setSaveBusy] = useState(false),
    [folderBusy, setFolderBusy] = useState(false),
    [folderStarted, setFolderStarted] = useState(false),
    [folderDirty, setFolderDirty] = useState(false),
    [folderManual, setFolderManual] = useState<FolderManualContext | null>(null),
    [folderManualDraft, setFolderManualDraft] = useState<IntakeDraft | undefined>(),
    [editorOrigin, setEditorOrigin] = useState<'import' | 'folder'>('import'),
    [pendingPage, setPendingPage] = useState<Page | null>(null);
  const refreshing = useRef(false);
  const importsRef = useRef(imports);
  importsRef.current = imports;
  const folderReader = useRef<ReturnType<typeof createFolderReader> | null>(null);
  const editorUploadGuard = useRef(false);
  if (!folderReader.current)
    folderReader.current = createFolderReader({ known: () => importsRef.current });
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const [a, b, c, d, e, f] = await Promise.all([
        api<ImportRecord[]>('/v1/imports'),
        api<ListingDraft[]>('/v1/products'),
        api<ShopConnection[]>('/v1/shops'),
        api<ChangePlan[]>('/v1/plans'),
        api<JobRecord[]>('/v1/jobs'),
        api<{ worker: string }>('/v1/status'),
      ]);
      setImports(a);
      setProducts(b);
      setShops(c);
      setPlans(d);
      setJobs(e);
      setStatus(f);
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }
  const {
    uploadFiles,
    busy: uploadBusy,
    progress: uploadProgress,
  } = useFileUploads(refresh, saveBusy || folderBusy);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
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
    if ((saveBusy || folderBusy) && next !== page) return;
    if (uploadBusy && next !== page) {
      setError('Đang nhập tệp. Đợi tải xong để xem đủ kết quả trước khi chuyển màn hình.');
      return;
    }
    if (dirty && next !== page) {
      setPendingPage(next);
      return;
    }
    setError('');
    if (next === 'folder') setFolderStarted(true);
    setPage(next);
  }
  function openFolderEditor(
    seed: EditorSeed,
    variants: { sku: string; originalPrice?: string }[] = [],
  ) {
    if (saveBusy || uploadBusy || folderBusy) return;
    setEditor(seed);
    setEditorSourceIds(null);
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
  function edit(section: 'content' | 'images' | 'structure' = 'content') {
    if (draft?.sourceSelection) {
      setEditorSourceIds(null);
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
    if (editorSourceIds === null) return uploadFiles(files);
    if (!files?.length || saveBusy || uploadBusy || folderBusy || editorUploadGuard.current) return;
    editorUploadGuard.current = true;
    setFolderBusy(true);
    setError('');
    try {
      const result = await folderReader.current!(Array.from(files));
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
  const displayed = products.filter(
    (p) =>
      (filter !== 'issues' || p.issues.some((i) => i.severity === 'block')) &&
      `${p.productKey} ${p.title.value} ${p.variants.map((v) => v.sku.value).join(' ')}`
        .toLocaleLowerCase('vi')
        .includes(search.toLocaleLowerCase('vi')),
  );
  const parent = ['import', 'preview', 'editor', 'folder'].includes(page) ? 'products' : page;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace-main">
        Đến nội dung chính
      </a>
      <header className="app-header">
        <button
          className="app-brand"
          onClick={() => go('products')}
          aria-label="Về Listing của tôi"
        >
          <span className="brand-tile">
            <LayoutList size={23} />
          </span>
          <span>
            Shopee <strong>Listing</strong>
            <small>Không gian nội bộ</small>
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
        <div className="header-tools">
          <button
            onClick={() => go('guide')}
            aria-label="Hướng dẫn sử dụng"
            title="Hướng dẫn sử dụng"
          >
            <CircleHelp size={18} />
            <span>Hướng dẫn</span>
          </button>
          <button onClick={() => go('shops')} aria-current={page === 'shops' ? 'page' : undefined}>
            <Store size={17} />
            <span>Kết nối shop</span>
          </button>
          <button
            onClick={() => go('assistant')}
            aria-label="Tra cứu & kiểm tra"
            title="Tra cứu & kiểm tra"
          >
            <BookOpen size={18} />
          </button>
        </div>
      </header>
      <div className="environment-bar">
        <span>
          <span className={'dot ' + (status?.worker === 'online' ? 'online' : '')} />
          {status?.worker === 'online' ? 'Ứng dụng đang hoạt động' : 'Đang kiểm tra kết nối'}
        </span>
        <span>Nhập và đối chiếu nguồn · Chưa bật đăng/cập nhật lên Shopee</span>
      </div>
      <main id="workspace-main" className="workspace-main">
        {uploadProgress}
        {folderBusy && (
          <p role="status" className="context-note">
            Đang đọc các tệp trong thư mục. Giữ trang mở để nhận đủ kết quả của từng bộ.
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
                    ? 'Rời màn hình sẽ bỏ lô thư mục đang xử lý. Các tệp và listing đã lưu trên ứng dụng vẫn được giữ.'
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
          <>
            {page === 'products' && (
              <>
                <div className="page-heading">
                  <div>
                    <h1>Listing của tôi</h1>
                    <p>Mỗi dòng là một bộ listing đã chuẩn bị. Mở bộ cần làm để kiểm tra nguồn.</p>
                  </div>
                  <button className="primary" onClick={() => go('folder')}>
                    <Plus size={18} />
                    Nhập listing có sẵn
                  </button>
                </div>
                <ol className="workflow-strip">
                  <li>
                    <span>1</span>
                    <div>
                      <strong>Nhận các thư mục listing</strong>
                      <small>Ảnh và Word của từng bộ · bảng giá chung</small>
                    </div>
                  </li>
                  <li>
                    <span>2</span>
                    <div>
                      <strong>Kiểm tra nguồn</strong>
                      <small>Đối chiếu giá, phân loại và shop</small>
                    </div>
                  </li>
                  <li className="unavailable">
                    <span>3</span>
                    <div>
                      <strong>Đăng & theo dõi</strong>
                      <small>Chưa mở trong bản hiện tại</small>
                    </div>
                  </li>
                </ol>
                <div className="list-toolbar">
                  <div className="tabbar">
                    <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                      Tất cả <span>{products.length}</span>
                    </button>
                    <button aria-pressed={filter === 'issues'} onClick={() => setFilter('issues')}>
                      Cần bổ sung{' '}
                      <span>
                        {
                          products.filter((p) => p.issues.some((i) => i.severity === 'block'))
                            .length
                        }
                      </span>
                    </button>
                  </div>
                  <input
                    aria-label="Tìm listing"
                    placeholder="Tìm tên listing hoặc mã SKU"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="listing-board">
                  <div className="listing-columns">
                    <span>Bộ listing</span>
                    <span>SKU & ảnh</span>
                    <span>Giá đăng mới</span>
                    <span>Trạng thái</span>
                    <span />
                  </div>
                  {displayed.map((p) => (
                    <article className="listing-row" data-testid="listing-row" key={p.productKey}>
                      <div className="listing-identity">
                        {p.coverKey ? (
                          <img
                            src={'/v1/media/' + encodeURIComponent(p.coverKey)}
                            alt={'Bìa ' + p.title.value}
                          />
                        ) : (
                          <div className="listing-placeholder">Chưa có bìa</div>
                        )}
                        <div>
                          <button
                            className="listing-title"
                            aria-label={p.title.value + ' · Xem & kiểm tra'}
                            onClick={() => open(p)}
                          >
                            {p.title.value || 'Chưa có tiêu đề'}
                          </button>
                          <small>Bản nguồn {p.revision} · Đã lưu trong ứng dụng</small>
                        </div>
                      </div>
                      <div className="listing-facts">
                        <strong>{p.variants.length} SKU</strong>
                        <small>
                          {p.galleryKeys.length} ảnh sản phẩm ·{' '}
                          {p.description.filter((b) => b.type === 'image').length} ảnh mô tả
                        </small>
                      </div>
                      <div className="listing-price">
                        <strong>{priceRange(p)}</strong>
                        <small>GIÁ GỐC từ nguồn</small>
                      </div>
                      <div>
                        <span
                          className={
                            'tag ' +
                            (p.issues.some((i) => i.severity === 'block') ? 'danger' : 'neutral')
                          }
                        >
                          {p.issues.some((i) => i.severity === 'block')
                            ? 'Cần bổ sung nguồn'
                            : 'Chưa kiểm tra theo shop'}
                        </span>
                        <small className="row-note">Bộ nguồn nội bộ</small>
                      </div>
                      <button
                        className="open-listing"
                        aria-label={'Mở chi tiết bộ ' + p.productKey}
                        onClick={() => open(p)}
                      >
                        <ArrowRight size={18} />
                      </button>
                    </article>
                  ))}
                  {!displayed.length && (
                    <div className="empty">
                      <h2>
                        {products.length
                          ? 'Không có listing khớp bộ lọc'
                          : 'Bắt đầu bằng listing bên bạn đã chuẩn bị'}
                      </h2>
                      <p>
                        {products.length
                          ? 'Thử tìm theo SKU hoặc chọn Tất cả.'
                          : 'Nhập bộ có sẵn để giữ riêng danh sách SKU, nội dung và ảnh của từng listing.'}
                      </p>
                    </div>
                  )}
                </div>
                <details className="usage-guide">
                  <summary>Cách dùng trong công việc hằng ngày</summary>
                  <ol>
                    <li>
                      Listing đã có trong bảng: bấm tên để xem và kiểm tra. Không cần nhập lại.
                    </li>
                    <li>
                      Listing mới: chọn Nhập listing có sẵn. Thêm bảng giá, nội dung và ảnh ngay tại
                      bước cần dùng.
                    </li>
                    <li>
                      Điền từng SKU/phân loại của bộ đã chuẩn bị vào bảng và đối chiếu giá. Ứng dụng
                      không tự quyết định gộp hay tách link.
                    </li>
                    <li>
                      Bước gửi lên Shopee hiện chưa mở. Lưu trong ứng dụng chỉ giữ bản nguồn nội bộ.
                    </li>
                  </ol>
                </details>
              </>
            )}
            {page === 'sources' && (
              <Resources imports={imports} uploadFiles={uploadFiles} uploading={uploadBusy} />
            )}
            {folderStarted && (
              <div hidden={page !== 'folder'}>
                <FolderIntake
                  imports={imports}
                  products={products}
                  active={page === 'folder'}
                  externalBusy={uploadBusy || saveBusy}
                  onRead={async (files, progress) => {
                    const result = await folderReader.current!(files, progress);
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
                  onSources={() => go('sources')}
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
                    setEditorSourceIds(folderManual?.sourceImportIds ?? null);
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
                imports={
                  editorSourceIds
                    ? imports.filter((item) => editorSourceIds.includes(item.id))
                    : imports
                }
                initialSection={editorSection}
                variantSummaries={editorVariants}
                onUploadFiles={uploadEditorFiles}
                externalBusy={uploadBusy || folderBusy}
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
                  <button aria-pressed={resultTab === 'jobs'} onClick={() => setResultTab('jobs')}>
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
                        <Issues issues={p.issues} />
                        <p className="caption">
                          Chưa gửi lên Shopee. Bước thực thi đang được hoàn thiện.
                        </p>
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
            {page === 'guide' && (
              <UsageGuide onImport={() => go('folder')} onListings={() => go('products')} />
            )}
            {page === 'shops' && (
              <>
                <div className="page-heading">
                  <div>
                    <h1>Kết nối shop</h1>
                    <p>Kiểm tra đúng tài khoản và môi trường trước khi dùng dữ liệu của shop.</p>
                  </div>
                </div>
                {shops.map((s) => (
                  <section className="panel" key={s.id}>
                    <span
                      className={
                        'tag ' + (s.scope.environment === 'sandbox' ? 'neutral' : 'danger')
                      }
                    >
                      {s.scope.environment === 'sandbox' ? 'TEST / SANDBOX' : 'SHOP THẬT / CHỈ ĐỌC'}
                    </span>
                    <h2>{s.name}</h2>
                    <dl>
                      <div>
                        <dt>Shop ID</dt>
                        <dd>{s.scope.shopId}</dd>
                      </div>
                      <div>
                        <dt>Partner ID</dt>
                        <dd>{s.scope.partnerId}</dd>
                      </div>
                      <div>
                        <dt>Kết nối</dt>
                        <dd>
                          {s.state === 'connected'
                            ? 'Đã kết nối để đọc thông tin shop'
                            : 'Cần kiểm tra kết nối'}
                        </dd>
                      </div>
                    </dl>
                    {s.scope.environment === 'sandbox' && (
                      <ConnectionForm shop={s} onConnected={() => void refresh()} />
                    )}
                  </section>
                ))}
                {!shops.length && (
                  <p className="empty">Chưa có shop được cấu hình trong ứng dụng.</p>
                )}
                <p className="caption">
                  Kết nối đọc shop không đồng nghĩa đã hỗ trợ đăng listing. Khóa và token được giữ ở
                  máy chủ ứng dụng.
                </p>
              </>
            )}
          </>
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
function priceRange(p: ListingDraft) {
  const prices = p.variants
    .map((v) => v.originalPrice.value)
    .filter((v) => /^\d+$/.test(v))
    .map(BigInt);
  if (prices.length !== p.variants.length || !prices.length) return 'Cần đối chiếu giá';
  const min = prices.reduce((a, b) => (a < b ? a : b)),
    max = prices.reduce((a, b) => (a > b ? a : b));
  return min === max ? money(String(min)) : `${money(String(min))} – ${money(String(max))}`;
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
