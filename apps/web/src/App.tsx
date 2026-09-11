import { useEffect, useState } from 'react';
import type {
  CatalogRow,
  ChangePlan,
  JobRecord,
  ListingDraft,
  ShopConnection,
  WorkbookImport,
} from '@shopee/domain';
import { api, date, money, post, type ImportRecord } from './api.js';
import { Editor, type EditorSeed } from './Editor.js';
import { Issues, Preview } from './Preview.js';
import { ConnectionForm } from './ConnectionForm.js';
const nav = [
  ['products', 'Danh mục listing'],
  ['sources', 'Nguồn tài liệu'],
  ['catalog', 'Bảng SKU & giá'],
  ['plans', 'Kế hoạch'],
  ['jobs', 'Công việc'],
  ['shops', 'Kết nối shop'],
] as const;
type Page = (typeof nav)[number][0] | 'preview' | 'editor';
export default function App() {
  const [page, setPage] = useState<Page>('products'),
    [imports, setImports] = useState<ImportRecord[]>([]),
    [products, setProducts] = useState<ListingDraft[]>([]),
    [shops, setShops] = useState<ShopConnection[]>([]),
    [plans, setPlans] = useState<ChangePlan[]>([]),
    [jobs, setJobs] = useState<JobRecord[]>([]),
    [status, setStatus] = useState<{ worker: string } | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [uploading, setUploading] = useState('');
  const [draft, setDraft] = useState<ListingDraft | null>(null),
    [editor, setEditor] = useState<EditorSeed | null>(null),
    [sourceId, setSourceId] = useState(''),
    [catalog, setCatalog] = useState<WorkbookImport | null>(null),
    [search, setSearch] = useState(''),
    [sheet, setSheet] = useState(''),
    [selected, setSelected] = useState<string[]>([]);
  async function refresh() {
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
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);
  async function upload(files: FileList | null) {
    if (!files) return;
    setError('');
    try {
      for (const file of Array.from(files)) {
        setUploading(file.name);
        await api('/v1/imports', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: file,
        });
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading('');
    }
  }
  async function loadCatalog(id: string) {
    setSourceId(id);
    setSelected([]);
    setSheet('');
    if (!id) {
      setCatalog(null);
      return;
    }
    try {
      const r = await api<ImportRecord>('/v1/imports/' + id);
      setCatalog(r.body as WorkbookImport);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function open(d: ListingDraft) {
    setDraft(d);
    setPage('preview');
  }
  function edit() {
    if (!draft?.sourceSelection) return;
    setEditor({
      ...draft.sourceSelection,
      productKey: draft.productKey,
      expectedRevision: draft.revision,
    });
    setPage('editor');
  }
  function group() {
    if (!catalog) return;
    const rows = selected.map((k) => catalog.rows.find((r) => r.key === k)!);
    setEditor({
      expectedRevision: 0,
      title: '',
      headline: '',
      body: '',
      galleryIds: [],
      descriptionImageIds: [],
      tierNames: ['Phân loại'],
      variants: rows.map((r) => ({
        importId: sourceId,
        rowKey: r.key,
        optionLabels: [r.name.value],
      })),
    });
    setPage('editor');
  }
  const visible = (catalog?.rows ?? []).filter(
    (r) =>
      (!sheet || r.sheet === sheet) &&
      (!search ||
        (r.sku.value + ' ' + r.name.value + ' ' + (r.priceProfile ?? ''))
          .toLocaleLowerCase('vi')
          .includes(search.toLocaleLowerCase('vi'))),
  );
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('products');
          }}
        >
          <span className="brand-mark">S.</span>
          <span>
            Shopee
            <br />
            <strong>Workspace</strong>
          </span>
        </a>
        <span className="workspace-label">VẬN HÀNH NỘI BỘ</span>
        <nav>
          {nav.map(([id, label], i) => (
            <button
              key={id}
              className={
                page === id || (id === 'products' && ['preview', 'editor'].includes(page))
                  ? 'active'
                  : ''
              }
              onClick={() => setPage(id)}
            >
              <span className="nav-symbol">{['▦', '▤', '≡', '□', '↻', '⌘'][i]}</span>
              {label}
              {id === 'products' && products.length > 0 && (
                <span className="nav-count">{products.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className={'dot ' + (status?.worker === 'online' ? 'online' : '')} />
          {status?.worker === 'online' ? 'Bộ nhập đang hoạt động' : 'Chờ kết nối hệ thống'}
          <small>
            Shop thật: chỉ đọc
            <br />
            Bản phát triển 0.1.0
          </small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            Không gian chung{' '}
            <span className="muted">/ {nav.find(([id]) => id === page)?.[1] ?? 'Listing'}</span>
          </span>
          <span className="tag neutral">LOCAL WORKSPACE</span>
        </header>
        <div className="content">
          {error && (
            <div role="alert" className="banner error">
              {error}
              <button onClick={() => void refresh()}>Thử lại</button>
            </div>
          )}
          {loading ? (
            <p className="empty">Đang tải dữ liệu đã lưu…</p>
          ) : (
            <>
              {page === 'products' && (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">TỪ NGUỒN ĐẾN LISTING</p>
                      <h1>Danh mục của bạn</h1>
                      <p>Chuẩn bị nội dung, đối chiếu SKU và lưu kế hoạch cho từng shop.</p>
                    </div>
                    <button className="primary" onClick={() => setPage('catalog')}>
                      Ghép listing từ SKU
                    </button>
                  </div>
                  <div className="metrics">
                    <div>
                      <span>Bản nháp đã lưu</span>
                      <strong>{products.length.toString().padStart(2, '0')}</strong>
                    </div>
                    <div>
                      <span>Nguồn sẵn sàng</span>
                      <strong>
                        {imports
                          .filter((i) => i.status === 'ready')
                          .length.toString()
                          .padStart(2, '0')}
                      </strong>
                    </div>
                    <div>
                      <span>Kế hoạch chuẩn bị</span>
                      <strong>{plans.length.toString().padStart(2, '0')}</strong>
                    </div>
                  </div>
                  <div className="section-heading">
                    <h2>Listing gần đây</h2>
                    <span className="caption">Lưu bền vững trong cơ sở dữ liệu</span>
                  </div>
                  {products.length ? (
                    <div className="product-grid">
                      {products.map((p) => (
                        <button className="product-card" key={p.productKey} onClick={() => open(p)}>
                          {p.coverKey ? (
                            <img src={'/v1/media/' + p.coverKey} alt={p.title.value} />
                          ) : (
                            <div className="no-image">Chưa có ảnh bìa</div>
                          )}
                          <div>
                            <span className="tag neutral">BẢN NHÁP · V{p.revision}</span>
                            <h3>{p.title.value || 'Chưa chọn tiêu đề'}</h3>
                            <p>
                              {p.variants.length} SKU <span>·</span>{' '}
                              {p.description.filter((b) => b.type === 'image').length} ảnh content
                            </p>
                            <strong>{money(p.variants[0]?.originalPrice.value)}</strong>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="panel empty">
                      <h2>Bắt đầu với tài liệu đã có</h2>
                      <p>Nhập Excel, Word và bộ ảnh, sau đó chọn các SKU thuộc cùng một listing.</p>
                      <button className="primary" onClick={() => setPage('sources')}>
                        Nhập nguồn tài liệu
                      </button>
                    </div>
                  )}
                  <div className="note">
                    <strong>Giai đoạn hiện tại</strong>
                    <p>
                      Nhập nguồn, ghép SKU và xem trước. Kết nối backend, luồng đăng và đối soát
                      Shopee đang được triển khai tiếp; các kế hoạch chưa được gửi lên sàn.
                    </p>
                  </div>
                </>
              )}
              {page === 'sources' && (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">TÀI LIỆU & ẢNH GỐC</p>
                      <h1>Nguồn tài liệu</h1>
                      <p>Giữ nguyên tệp. Mỗi lần nhập có dấu vân tay để đối chiếu nguồn.</p>
                    </div>
                    <label className="button primary upload">
                      {uploading ? 'Đang nhập…' : 'Thêm tệp nguồn'}
                      <input
                        type="file"
                        multiple
                        accept=".xlsx,.docx,.png,.jpg,.jpeg,.webp"
                        disabled={!!uploading}
                        onChange={(e) => {
                          void upload(e.target.files);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                  {uploading && <p role="status">Đang lưu {uploading}</p>}
                  <div className="panel table-panel">
                    <table>
                      <thead>
                        <tr>
                          <th>Tệp nguồn</th>
                          <th>Loại</th>
                          <th>Trạng thái</th>
                          <th>Ngày nhập</th>
                        </tr>
                      </thead>
                      <tbody>
                        {imports.map((i) => (
                          <tr key={i.id}>
                            <td>
                              <strong>{i.filename}</strong>
                              <small>
                                {(i.bytes / 1024 / 1024).toFixed(2)} MB · {i.sha256.slice(0, 12)}
                              </small>
                              {i.message && <small className="error">{i.message}</small>}
                            </td>
                            <td>{i.kind.toUpperCase()}</td>
                            <td>
                              <span
                                className={'tag ' + (i.status === 'ready' ? 'success' : 'neutral')}
                              >
                                {
                                  (
                                    {
                                      ready: 'Sẵn sàng',
                                      queued: 'Đang chờ',
                                      running: 'Đang đọc',
                                      failed: 'Cần kiểm tra',
                                    } as Record<string, string>
                                  )[i.status]
                                }
                              </span>
                            </td>
                            <td>{date(i.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!imports.length && (
                      <p className="empty">Chưa có tệp. Có thể nhập nhiều ảnh cùng lúc.</p>
                    )}
                  </div>
                </>
              )}
              {page === 'catalog' && (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">ÁNH XẠ THEO NGUỒN</p>
                      <h1>Bảng SKU & giá</h1>
                      <p>Chọn từng dòng thuộc cùng listing. Bộ giá và vị trí ô được giữ riêng.</p>
                    </div>
                    <button className="primary" disabled={!selected.length} onClick={group}>
                      Ghép {selected.length || ''} SKU vào listing
                    </button>
                  </div>
                  <div className="filters">
                    <select
                      aria-label="File bảng giá"
                      value={sourceId}
                      onChange={(e) => void loadCatalog(e.target.value)}
                    >
                      <option value="">Chọn file Excel</option>
                      {imports
                        .filter((i) => i.kind === 'xlsx' && i.status === 'ready')
                        .map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.filename}
                          </option>
                        ))}
                    </select>
                    <select
                      aria-label="Sheet"
                      value={sheet}
                      onChange={(e) => setSheet(e.target.value)}
                    >
                      <option value="">Tất cả sheet</option>
                      {catalog?.sheets.map((s) => (
                        <option key={s.name}>{s.name}</option>
                      ))}
                    </select>
                    <input
                      aria-label="Tìm SKU"
                      placeholder="Tìm mã SKU, tên, bộ giá…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  {catalog && (
                    <>
                      <Issues issues={catalog.issues} />
                      <p className="caption">
                        {visible.length} dòng khớp · {selected.length} đã chọn ·{' '}
                        {catalog.sheets.filter((s) => !s.headerRows.length).length} sheet chưa có
                        mapping
                      </p>
                      <div className="panel table-panel catalog-table">
                        <table>
                          <thead>
                            <tr>
                              <th></th>
                              <th>SKU / Tên nguồn</th>
                              <th>Sheet / Bộ giá</th>
                              <th>GIÁ GỐC</th>
                              <th>GIÁ BÁN</th>
                              <th>Kiểm tra</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visible.slice(0, 250).map((r: CatalogRow) => (
                              <tr
                                key={r.key}
                                className={selected.includes(r.key) ? 'selected' : ''}
                              >
                                <td>
                                  <input
                                    type="checkbox"
                                    aria-label={'Chọn ' + r.sku.value + ' ' + r.sheet + ' ' + r.row}
                                    checked={selected.includes(r.key)}
                                    onChange={() =>
                                      setSelected((s) =>
                                        s.includes(r.key)
                                          ? s.filter((k) => k !== r.key)
                                          : [...s, r.key],
                                      )
                                    }
                                  />
                                </td>
                                <td>
                                  <strong>{r.sku.value}</strong>
                                  <small>{r.name.value}</small>
                                </td>
                                <td>
                                  {r.sheet}
                                  <small>
                                    {r.priceProfile ?? 'Theo bảng nguồn'} · dòng {r.row}
                                  </small>
                                </td>
                                <td title={r.originalPrice?.sources[0].locator}>
                                  {money(r.originalPrice?.value)}
                                </td>
                                <td>{money(r.promotionTarget?.value)}</td>
                                <td title={r.issues.map((i) => i.message).join('\n')}>
                                  <span
                                    className={
                                      'tag ' +
                                      (r.issues.some((i) => i.severity === 'block')
                                        ? 'danger'
                                        : r.issues.length
                                          ? ''
                                          : 'success')
                                    }
                                  >
                                    {r.issues.some((i) => i.severity === 'block')
                                      ? 'Cần chọn nguồn'
                                      : r.issues.length
                                        ? 'Có lưu ý'
                                        : 'Đã đọc'}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {visible.length > 250 && (
                        <p className="caption">
                          Đang hiển thị 250 dòng đầu. Lọc sheet hoặc tìm SKU để thu hẹp.
                        </p>
                      )}
                    </>
                  )}
                  {!catalog && <div className="empty">Chọn bảng giá đã nhập để bắt đầu.</div>}
                </>
              )}
              {page === 'preview' && draft && (
                <Preview
                  key={draft.productKey + draft.revision}
                  draft={draft}
                  shops={shops}
                  onEdit={edit}
                  onPlan={() => {
                    void refresh();
                    setPage('plans');
                  }}
                />
              )}
              {page === 'editor' && editor && (
                <Editor
                  key={editor.productKey ?? 'new'}
                  seed={editor}
                  imports={imports}
                  onCancel={() => setPage(draft ? 'preview' : 'catalog')}
                  onSaved={(d) => {
                    void refresh();
                    open(d);
                  }}
                />
              )}
              {page === 'plans' && (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">THEO TỪNG SHOP</p>
                      <h1>Kế hoạch thực thi</h1>
                      <p>Nội dung và nguồn được cố định theo phiên bản khi lưu.</p>
                    </div>
                  </div>
                  {plans.length ? (
                    plans.map((p) => (
                      <section className="panel" key={p.id}>
                        <div className="section-heading">
                          <div>
                            <span
                              className={
                                'tag ' + (p.scope.environment === 'sandbox' ? '' : 'danger')
                              }
                            >
                              {p.scope.environment === 'sandbox' ? 'TEST' : 'LIVE'} ·{' '}
                              {p.scope.shopId}
                            </span>
                            <h2>{p.desired.title.value}</h2>
                            <p className="caption">
                              Nguồn v{p.sourceRevision} · {date(p.createdAt)} ·{' '}
                              {p.fingerprint.slice(0, 12)}
                            </p>
                          </div>
                          <button onClick={() => open(p.desired)}>Xem bản đã lưu</button>
                        </div>
                        <Issues issues={p.issues} />
                        <button
                          className="primary"
                          disabled={p.issues.some((i) => i.severity === 'block')}
                          onClick={() =>
                            void post('/v1/plans/' + p.id + '/submit', {
                              revision: p.revision,
                              fingerprint: p.fingerprint,
                            })
                              .then(refresh)
                              .catch((e) => setError(e.message))
                          }
                        >
                          Đưa vào hàng đợi
                        </button>
                      </section>
                    ))
                  ) : (
                    <p className="empty">Lưu kế hoạch từ bản xem trước listing.</p>
                  )}
                </>
              )}
              {page === 'jobs' && (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">TIẾN ĐỘ & PHỤC HỒI</p>
                      <h1>Công việc</h1>
                      <p>Chỉ xuất hiện công việc đã được lưu thành công vào cơ sở dữ liệu.</p>
                    </div>
                  </div>
                  {jobs.length ? (
                    jobs.map((j) => (
                      <section className="panel" key={j.id}>
                        <span className="tag">{j.state}</span>
                        <h2>
                          {j.scope.environment.toUpperCase()} · {j.scope.shopId}
                        </h2>
                        <p>{j.message}</p>
                        <p className="caption">{date(j.createdAt)}</p>
                        <div className="actions">
                          {(['pause', 'resume', 'cancel'] as const).map((a, i) => (
                            <button
                              key={a}
                              disabled={['verified', 'failed', 'cancelled'].includes(j.state)}
                              onClick={() =>
                                void post('/v1/jobs/' + j.id + '/' + a, {})
                                  .then(refresh)
                                  .catch((e) => setError(e.message))
                              }
                            >
                              {['Tạm dừng', 'Tiếp tục', 'Hủy bước chưa gửi'][i]}
                            </button>
                          ))}
                        </div>
                      </section>
                    ))
                  ) : (
                    <div className="panel empty">
                      <h2>Chưa có công việc gửi lên sàn</h2>
                      <p>Các kế hoạch đang ở giai đoạn chuẩn bị.</p>
                    </div>
                  )}
                </>
              )}
              {page === 'shops' && (
                <>
                  <div className="page-heading">
                    <div>
                      <p className="eyebrow">OPEN PLATFORM</p>
                      <h1>Kết nối shop</h1>
                      <p>Thông tin kết nối được quản lý ở backend của ứng dụng.</p>
                    </div>
                  </div>
                  {shops.map((s) => (
                    <section className="panel" key={s.id}>
                      <span className="tag">
                        {s.scope.environment === 'sandbox' ? 'TEST / SANDBOX' : 'LIVE / CHỈ ĐỌC'}
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
                          <dt>Trạng thái backend</dt>
                          <dd>
                            {s.state === 'connected'
                              ? 'Đã kết nối'
                              : 'Chưa cấu hình thông tin kết nối'}
                          </dd>
                        </div>
                      </dl>
                      {s.scope.environment === 'sandbox' && (
                        <ConnectionForm shop={s} onConnected={() => void refresh()} />
                      )}
                    </section>
                  ))}
                  <div className="note">
                    <strong>Đăng nhập trình duyệt chưa tạo kết nối cho backend</strong>
                    <p>
                      Kết nối sandbox trực tiếp là bước tiếp theo. Mọi thao tác ghi vào shop thật
                      vẫn đang khóa.
                    </p>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
