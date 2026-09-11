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
} from 'lucide-react';
import type { ChangePlan, JobRecord, ListingDraft, ShopConnection } from '@shopee/domain';
import { api, date, money, type ImportRecord } from './api.js';
import { Editor, type EditorSeed } from './Editor.js';
import { Issues, Preview } from './Preview.js';
import { Resources } from './Resources.js';
import { ListingImport } from './ListingImport.js';
import { ConnectionForm } from './ConnectionForm.js';
import { AssistantPanel } from './AssistantPanel.js';
type Page =
  'products' | 'sources' | 'results' | 'shops' | 'assistant' | 'preview' | 'editor' | 'import';
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
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [resultTab, setResultTab] = useState<'plans' | 'jobs'>('plans'),
    [dirty, setDirty] = useState(false),
    [uploadBusy, setUploadBusy] = useState(false),
    [saveBusy, setSaveBusy] = useState(false),
    [pendingPage, setPendingPage] = useState<Page | null>(null);
  const refreshing = useRef(false);
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
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!dirty && !uploadBusy && !saveBusy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, uploadBusy, saveBusy]);
  function go(next: Page) {
    if (saveBusy && next !== page) return;
    if (uploadBusy && next !== page) {
      setError('Đang nhập tệp. Đợi tải xong để xem đủ kết quả trước khi chuyển màn hình.');
      return;
    }
    if (dirty && next !== page) {
      setPendingPage(next);
      return;
    }
    setError('');
    setPage(next);
  }
  function open(d: ListingDraft) {
    setDraft(d);
    setPage('preview');
    setDirty(false);
    setError('');
    window.scrollTo(0, 0);
  }
  function edit() {
    if (draft?.sourceSelection) {
      setEditor({
        ...draft.sourceSelection,
        productKey: draft.productKey,
        expectedRevision: draft.revision,
      });
      setPage('editor');
      window.scrollTo(0, 0);
    }
  }
  const displayed = products.filter(
    (p) =>
      (filter !== 'issues' || p.issues.some((i) => i.severity === 'block')) &&
      `${p.productKey} ${p.title.value} ${p.variants.map((v) => v.sku.value).join(' ')}`
        .toLocaleLowerCase('vi')
        .includes(search.toLocaleLowerCase('vi')),
  );
  const parent = ['import', 'preview', 'editor'].includes(page) ? 'products' : page;
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
              <p>Rời màn hình sẽ bỏ phần đang nhập. Bản đã lưu vẫn được giữ.</p>
            </div>
            <div className="actions">
              <button onClick={() => setPendingPage(null)}>Ở lại</button>
              <button
                disabled={saveBusy || uploadBusy}
                onClick={() => {
                  setDirty(false);
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
                  <button className="primary" onClick={() => go('import')}>
                    <Plus size={18} />
                    Nhập listing có sẵn
                  </button>
                </div>
                <ol className="workflow-strip">
                  <li>
                    <span>1</span>
                    <div>
                      <strong>Nhập bộ listing</strong>
                      <small>Đúng danh sách SKU, nội dung và ảnh</small>
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
                    placeholder="Tìm tên listing, mã bộ hoặc SKU"
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
                          <small>
                            {p.productKey} · Bản {p.revision}
                          </small>
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
                      Listing mới: thêm Excel, Word và ảnh trong Tệp nguồn; sau đó chọn Nhập listing
                      có sẵn.
                    </li>
                    <li>
                      Dán đúng danh sách SKU/phân loại của bộ đã chuẩn bị và đối chiếu giá. Ứng dụng
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
              <Resources imports={imports} refresh={refresh} onUploading={setUploadBusy} />
            )}
            {page === 'import' && (
              <>
                <button className="back-link" onClick={() => go('products')}>
                  <ArrowLeft size={15} />
                  Listing của tôi
                </button>
                <ListingImport
                  imports={imports}
                  onDirty={setDirty}
                  onCancel={() => go('products')}
                  onSources={() => go('sources')}
                  onContinue={(seed) => {
                    if (products.some((p) => p.productKey === seed.productKey)) {
                      setError(
                        'Mã bộ này đã tồn tại. Mở listing đã lưu để đối chiếu; không nhập lại thành bản khác.',
                      );
                      return;
                    }
                    setEditor(seed);
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
                imports={imports}
                onDirty={setDirty}
                onBusy={setSaveBusy}
                onCancel={() => go(draft ? 'preview' : 'import')}
                onSaved={(d) => {
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
