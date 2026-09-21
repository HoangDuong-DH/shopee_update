import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, FileSpreadsheet, FolderOpen, Search, Upload } from 'lucide-react';
import type {
  CatalogRow,
  CatalogSourceField,
  InputLibrary,
  ListingDraft,
  WorkbookImport,
} from '@shopee/domain';
import { api, date, media, money, type ImportRecord } from './api.js';
import { Issues } from './Preview.js';
import { ListingFolderGuide } from './ListingFolderGuide.js';
import { ArchiveAction, LifecycleFilter, type Lifecycle } from './LocalArchive.js';
import './input-library.css';

const sourceStatus = (status: string) =>
  ({ ready: 'Đã đọc', queued: 'Chờ đọc', running: 'Đang đọc', failed: 'Cần kiểm tra' })[status] ??
  'Chưa xác định';
const priceValue = (value?: string) => (value === undefined || value === '' ? '—' : money(value));
const sourceFields: [CatalogSourceField, string][] = [
  ['sku', 'SKU trong nguồn'],
  ['name', 'Tên trong nguồn'],
  ['brand', 'Thương hiệu trong nguồn'],
  ['category', 'Ngành hàng trong nguồn'],
  ['unitOfMeasure', 'Đơn vị tính'],
  ['physicalWeightGrams', 'Cân nặng thực (g)'],
  ['declaredWeightGrams', 'Cân nặng khai báo (g)'],
  ['originalPrice', 'GIÁ GỐC'],
  ['promotionTarget', 'GIÁ BÁN'],
];
function PriceSourceDetails({ row, filename }: { row: CatalogRow; filename?: string }) {
  return (
    <details data-testid="price-source-details" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
      <summary style={{ cursor: 'pointer', minHeight: 44, paddingBlock: 10 }}>
        Thông tin nguồn
      </summary>
      <p className="caption">
        {filename}
        <br />
        {row.sheet} · dòng {row.row} · {row.priceProfile ?? 'Theo bảng nguồn'}
      </p>
      <p className="caption">
        Giữ giá trị trong file để đối chiếu; chưa xác nhận thành thuộc tính hoặc cấu hình Shopee.
      </p>
      <dl style={{ margin: 0 }}>
        {sourceFields.map(([field, label]) => {
          const fact = row[field],
            header = row.sourceHeaders?.[field];
          if (!fact && !header && field !== 'originalPrice' && field !== 'promotionTarget')
            return null;
          return (
            <div key={field} style={{ borderTop: '1px solid #e2e6eb', paddingBlock: 8 }}>
              <dt style={{ fontWeight: 600 }}>{label}</dt>
              <dd style={{ margin: '4px 0 0' }}>
                <span data-testid={'source-fact-' + field} style={{ whiteSpace: 'pre-wrap' }}>
                  {fact?.value === undefined || fact.value === '' ? '—' : fact.value}
                </span>
                {fact?.sources.map((source, index) => (
                  <small key={index}>
                    {source.filename && source.filename !== filename ? source.filename + ' · ' : ''}
                    {source.locator}
                  </small>
                ))}
                {header && (
                  <small>
                    <span>Nhãn cột: </span>
                    <span data-testid={'source-header-' + field} style={{ whiteSpace: 'pre-wrap' }}>
                      {header.value}
                    </span>
                    {header.sources.map((source, index) => (
                      <span key={index} style={{ display: 'block' }}>
                        {source.filename && source.filename !== filename
                          ? source.filename + ' · '
                          : ''}
                        {source.locator}
                      </span>
                    ))}
                  </small>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
export function Resources({
  imports,
  products,
  uploadFiles,
  uploading,
  onNewBatch,
  onResumeBatch,
  onOpenListing,
}: {
  imports: ImportRecord[];
  products: ListingDraft[];
  uploadFiles: (files: FileList | null) => Promise<void>;
  uploading: boolean;
  onNewBatch: (priceImportId?: string) => void;
  onResumeBatch: (id: string) => void;
  onOpenListing: (draft: ListingDraft) => void;
}) {
  const [tab, setTab] = useState<'bundles' | 'prices'>('bundles');
  const [lifecycle, setLifecycle] = useState<Lifecycle>('active');
  const [viewProducts, setViewProducts] = useState<ListingDraft[]>(products);
  const [library, setLibrary] = useState<InputLibrary | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [sourceId, setSourceId] = useState(''),
    [catalog, setCatalog] = useState<WorkbookImport | null>(null);
  const [reading, setReading] = useState(false),
    [priceError, setPriceError] = useState('');
  const [sheet, setSheet] = useState(''),
    [profile, setProfile] = useState(''),
    [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<InputLibrary>('/v1/input-library?lifecycle=' + lifecycle, { signal: controller.signal }),
      api<ListingDraft[]>('/v1/products?lifecycle=' + lifecycle, { signal: controller.signal }),
    ]).then(([value, listings]) => {
        if (!controller.signal.aborted) {
          setLibrary(value);
          setViewProducts(listings);
          setError('');
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Chưa đọc được kho đầu vào.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [imports, reload, lifecycle]);
  function archiveChanged() {
    request.current++;
    setSourceId(''); setCatalog(null); setReading(false);
    setReload((value) => value + 1);
  }
  function changeLifecycle(value: Lifecycle) {
    setLifecycle(value); setLibrary(null); setViewProducts([]); setLoading(true);
    archiveChanged();
  }
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function loadPrice(id: string) {
    const generation = ++request.current;
    setSourceId(id);
    setCatalog(null);
    setSheet('');
    setProfile('');
    setQuery('');
    setPage(0);
    setPriceError('');
    setReading(true);
    try {
      const result = await api<ImportRecord>('/v1/imports/' + encodeURIComponent(id));
      if (generation !== request.current) return;
      const body = result.body as WorkbookImport | undefined;
      if (
        result.kind !== 'xlsx' ||
        result.status !== 'ready' ||
        !body ||
        !Array.isArray(body.rows) ||
        !Array.isArray(body.sheets)
      )
        throw new Error('Bảng giá chưa đọc xong hoặc chưa có dữ liệu hợp lệ.');
      setCatalog(body);
    } catch (cause) {
      if (generation === request.current)
        setPriceError(cause instanceof Error ? cause.message : 'Chưa đọc được bảng giá.');
    } finally {
      if (generation === request.current) setReading(false);
    }
  }
  const keyword = search.toLocaleLowerCase('vi');
  const batches = (library?.batches ?? []).filter((batch) =>
    batch.name.toLocaleLowerCase('vi').includes(keyword),
  );
  const completed = viewProducts.filter((product) =>
    `${product.title.value} ${product.productKey} ${product.variants.map((v) => v.sku.value).join(' ')}`
      .toLocaleLowerCase('vi')
      .includes(keyword),
  );
  const priceBooks = library?.priceBooks ?? [];
  const profiles = Array.from(
    new Set(
      (catalog?.rows ?? [])
        .filter((row) => !sheet || row.sheet === sheet)
        .map((row) => row.priceProfile ?? null),
    ),
  );
  const priceRows = useMemo(
    () =>
      (catalog?.rows ?? []).filter(
        (row) =>
          (!sheet || row.sheet === sheet) &&
          (!profile || JSON.stringify(row.priceProfile ?? null) === profile) &&
          `${row.sku.value} ${row.name.value} ${row.priceProfile ?? ''}`
            .toLocaleLowerCase('vi')
            .includes(query.toLocaleLowerCase('vi')),
      ),
    [catalog, sheet, profile, query],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(priceRows.length / 50) - 1));
  return (
    <div className="input-library">
      <div className="page-heading">
        <div>
          <h1>Kho đầu vào</h1>
          <p>Bảng giá dùng chung. Word và ảnh được quản lý theo từng bộ listing.</p>
        </div>
        <button className="primary" disabled={uploading} onClick={() => onNewBatch()}>
          <FolderOpen size={18} /> Nhập thư mục listing
        </button>
      </div>
      <div className="input-library-nav" role="tablist" aria-label="Loại nguồn đầu vào">
        <button role="tab" aria-selected={tab === 'bundles'} onClick={() => setTab('bundles')}>
          <FolderOpen size={18} /> Bộ listing
        </button>
        <button role="tab" aria-selected={tab === 'prices'} onClick={() => setTab('prices')}>
          <FileSpreadsheet size={18} /> Bảng giá chung <span>{priceBooks.length}</span>
        </button>
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
          <button onClick={() => setReload((value) => value + 1)}>Thử tải lại kho</button>
        </div>
      )}
      {loading && <p role="status">Đang mở kho đầu vào…</p>}
      <LifecycleFilter value={lifecycle} onChange={changeLifecycle} disabled={uploading} />
      <p className="caption">Lưu trữ trong ứng dụng để dọn danh sách. Chọn Đã lưu trữ để khôi phục; tệp gốc và lịch sử được giữ.</p>
      {tab === 'bundles' ? (
        <>
          <ListingFolderGuide onOpenPrices={() => setTab('prices')} />
          <div className="input-library-toolbar">
            <p>Tiếp tục đợt đang làm hoặc mở bộ đã lưu để đối chiếu.</p>
            <label className="library-search">
              <Search size={17} />
              <input
                aria-label="Tìm bộ nguồn"
                placeholder="Tìm tên bộ hoặc SKU…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          <section className="library-section" aria-label="Các đợt nhập đã lưu">
            <div className="section-heading">
              <h2>
                Đợt nhập đã lưu <span className="count">{batches.length}</span>
              </h2>
            </div>
            {batches.length ? (
              <div className="input-batch-list">
                {batches.map((batch) => (
                  <article className="input-batch-row" data-testid="input-batch-row" key={batch.id}>
                    <span className="library-file-icon">
                      <FolderOpen size={23} />
                    </span>
                    <div className="library-row-main">
                      <h3>{batch.name}</h3>
                      <p>
                        {batch.folderCount} bộ listing · {batch.fileCount} tệp ·{' '}
                        {batch.completedCount}/{batch.folderCount} bộ đã lưu
                      </p>
                      <small>
                        Cập nhật {date(batch.updatedAt)}
                        {batch.priceSelection
                          ? ` · ${priceBooks.find((book) => book.id === batch.priceSelection!.importId)?.filename ?? 'Bảng giá đã chọn'} / ${batch.priceSelection.sheet}`
                          : ' · Chưa chọn bảng giá'}
                      </small>
                    </div>
                    <button disabled={uploading || lifecycle === 'archived'} onClick={() => onResumeBatch(batch.id)}>
                      Tiếp tục xử lý <ArrowRight size={16} />
                    </button>
                    <ArchiveAction kind="input_batch" resourceId={batch.id} name={batch.name}
                      archived={lifecycle === 'archived'} disabled={uploading} onChanged={archiveChanged} />
                  </article>
                ))}
              </div>
            ) : (
              <div className="library-empty">
                <FolderOpen size={27} />
                <div>
                  <h3>{search ? 'Không tìm thấy đợt nhập' : lifecycle === 'archived' ? 'Chưa có đợt nhập nào được lưu trữ' : 'Nhận một lần, làm tiếp khi cần'}</h3>
                  <p>
                    {search
                      ? 'Thử tên thư mục khác.'
                      : lifecycle === 'archived' ? 'Đợt nhập được lưu trữ sẽ xuất hiện ở đây để khôi phục.' : 'Chọn thư mục chứa các listing. Những nguồn và vị trí ảnh đã lưu sẽ nằm ở đây để mở lại.'}
                  </p>
                </div>
                {!search && lifecycle === 'active' && (
                  <button disabled={uploading} onClick={() => onNewBatch()}>
                    Chọn thư mục listing
                  </button>
                )}
              </div>
            )}
          </section>
          <section className="library-section" aria-label="Bộ listing đã tiếp nhận">
            <div className="section-heading">
              <h2>
                Bộ listing đã tiếp nhận <span className="count">{completed.length}</span>
              </h2>
            </div>
            {completed.length ? (
              <div className="input-batch-list">
                {completed.map((product) => (
                  <article className="input-batch-row" key={product.productKey}>
                    {product.coverKey ? (
                      <img
                        className="library-cover"
                        src={media(product.coverKey)}
                        alt={product.title.value}
                      />
                    ) : (
                      <span className="library-file-icon">
                        <FolderOpen size={23} />
                      </span>
                    )}
                    <div className="library-row-main">
                      <h3>{product.title.value}</h3>
                      <p>
                        {product.variants.length} SKU · {product.galleryKeys.length} ảnh sản phẩm ·
                        Bản nguồn {product.revision}
                      </p>
                      <small>Đã lưu trong ứng dụng</small>
                    </div>
                    <button disabled={uploading || lifecycle === 'archived'} onClick={() => onOpenListing(product)}>
                      Mở bộ đã lưu
                    </button>
                    <ArchiveAction kind="product" resourceId={product.productKey} name={product.title.value}
                      archived={lifecycle === 'archived'} disabled={uploading} onChanged={archiveChanged} />
                  </article>
                ))}
              </div>
            ) : (
              <p className="caption">
                {search ? 'Không có bộ khớp từ khóa.' : lifecycle === 'archived' ? 'Chưa có bộ listing nào được lưu trữ.' : 'Các bộ hoàn thiện sẽ xuất hiện tại đây.'}
              </p>
            )}
          </section>
          {!!library?.unassigned.length && (
            <details className="library-unassigned panel">
              <summary>
                Tệp cũ chưa xếp vào đợt nhập <span>{library.unassigned.length}</span>
              </summary>
              <p className="caption">
                Giữ để đối chiếu. Hệ thống chưa đủ thông tin để xác định các tệp này thuộc bộ nào.
              </p>
              <ul>
                {library.unassigned.map((file) => (
                  <li key={file.id}>
                    <span>{file.filename}</span>
                    <small>
                      {sourceStatus(file.status)} · {date(file.createdAt)}
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <>
          <div className="input-library-toolbar">
            <p>
              Thêm Excel một lần rồi dùng cho nhiều bộ. Bản giá mới được giữ riêng để bạn chọn rõ.
            </p>
            <label className={`upload-button${uploading ? ' disabled' : ''}`}>
              <Upload size={17} /> Thêm bảng giá Excel
              <input
                aria-label="Thêm bảng giá Excel"
                type="file"
                accept=".xlsx"
                multiple
                disabled={uploading}
                onChange={(event) => {
                  const files = event.currentTarget.files;
                  if (files && Array.from(files).some((file) => !/\.xlsx$/i.test(file.name))) {
                    setError(
                      'Khu vực bảng giá chỉ nhận Excel (.xlsx). Nhận Word và ảnh bằng Nhập thư mục listing.',
                    );
                  } else {
                    setError('');
                    void uploadFiles(files);
                  }
                  event.currentTarget.value = '';
                }}
              />
            </label>
          </div>
          <div className="input-batch-list" aria-label="Danh sách bảng giá">
            {priceBooks.map((book) => (
              <article
                data-testid="price-book-row"
                className={`input-batch-row ${sourceId === book.id ? 'selected' : ''}`}
                key={book.id}
              >
                <span className="library-file-icon price">
                  <FileSpreadsheet size={23} />
                </span>
                <div className="library-row-main">
                  <h3>{book.filename}</h3>
                  <p>
                    {sourceStatus(book.status)}
                    {book.status === 'ready'
                      ? ` · ${book.rowCount} dòng theo bộ giá · ${book.sheetCount} trang tính`
                      : ''}
                  </p>
                  <small>
                    Nhập {date(book.createdAt)}
                    {book.issueCount ? ' · Có mục cần đối chiếu theo bộ giá' : ''}
                  </small>
                </div>
                <div className="actions">
                  <button
                    disabled={book.status !== 'ready'}
                    onClick={() => void loadPrice(book.id)}
                  >
                    Tra giá
                  </button>
                  <button
                    disabled={uploading || book.status !== 'ready' || lifecycle === 'archived'}
                    onClick={() => onNewBatch(book.id)}
                  >
                    Dùng cho đợt mới <ArrowRight size={15} />
                  </button>
                  <ArchiveAction kind="pricebook" resourceId={book.id} name={book.filename}
                    archived={lifecycle === 'archived'} disabled={uploading} onChanged={archiveChanged} />
                </div>
              </article>
            ))}
          </div>
          {!loading && !priceBooks.length && (
            <div className="library-empty">
              <FileSpreadsheet size={30} />
              <div>
                <h3>{lifecycle === 'archived' ? 'Chưa có bảng giá nào được lưu trữ' : 'Thêm bảng giá dùng chung của công ty'}</h3>
                <p>
                  {lifecycle === 'archived' ? 'Bảng giá được lưu trữ sẽ xuất hiện ở đây để khôi phục.' : 'Chọn file Excel bằng nút phía trên. Word và ảnh được nhận cùng thư mục listing.'}
                </p>
              </div>
            </div>
          )}
          {sourceId && (
            <section className="panel library-price-detail" aria-label="Nội dung bảng giá">
              <div className="section-heading">
                <div>
                  <h2>
                    {priceBooks.find((book) => book.id === sourceId)?.filename ?? 'Tra bảng giá'}
                  </h2>
                  <p className="caption">
                    GIÁ GỐC dùng cho đăng mới · GIÁ BÁN là giá mục tiêu khuyến mại riêng.
                  </p>
                </div>
                <button
                  onClick={() => {
                    request.current++;
                    setSourceId('');
                    setCatalog(null);
                    setReading(false);
                  }}
                >
                  Đóng bảng tra
                </button>
              </div>
              {reading && <p role="status">Đang đọc bảng giá…</p>}
              {priceError && (
                <p role="alert" className="error">
                  {priceError}
                </p>
              )}
              {catalog && (
                <>
                  <div className="filters">
                    <select
                      aria-label="Trang tính bảng giá"
                      value={sheet}
                      onChange={(event) => {
                        setSheet(event.target.value);
                        setProfile('');
                        setPage(0);
                      }}
                    >
                      <option value="">Tất cả trang tính</option>
                      {catalog.sheets.map((item) => (
                        <option key={item.name}>{item.name}</option>
                      ))}
                    </select>
                    <select
                      aria-label="Bộ giá để tra"
                      value={profile}
                      onChange={(event) => {
                        setProfile(event.target.value);
                        setPage(0);
                      }}
                    >
                      <option value="">Tất cả bộ giá</option>
                      {profiles.map((value) => (
                        <option key={JSON.stringify(value)} value={JSON.stringify(value)}>
                          {value ?? 'Giá theo trang tính'}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="Tìm SKU"
                      placeholder="Tìm SKU hoặc tên hàng…"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setPage(0);
                      }}
                    />
                  </div>
                  <Issues issues={catalog.issues} />
                  <div className="library-pagination">
                    <span>
                      {priceRows.length} dòng theo bộ giá · Hiển thị{' '}
                      {priceRows.length ? currentPage * 50 + 1 : 0}–
                      {Math.min((currentPage + 1) * 50, priceRows.length)}
                    </span>
                    <div className="actions">
                      <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                        Trang trước
                      </button>
                      <button
                        disabled={(currentPage + 1) * 50 >= priceRows.length}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        Trang sau
                      </button>
                    </div>
                  </div>
                  <div className="table-panel catalog-table">
                    <table>
                      <thead>
                        <tr>
                          <th>SKU / Tên nguồn</th>
                          <th>Trang tính / Bộ giá</th>
                          <th>GIÁ GỐC</th>
                          <th>GIÁ BÁN</th>
                          <th>Đối chiếu</th>
                        </tr>
                      </thead>
                      <tbody>
                        {priceRows.slice(currentPage * 50, currentPage * 50 + 50).map((row) => (
                          <tr key={row.key}>
                            <td>
                              <strong>{row.sku.value}</strong>
                              <small>{row.name.value}</small>
                              <PriceSourceDetails
                                row={row}
                                filename={
                                  catalog.source.filename ??
                                  priceBooks.find((book) => book.id === sourceId)?.filename
                                }
                              />
                            </td>
                            <td>
                              {row.sheet}
                              <small>
                                {row.priceProfile ?? 'Theo bảng nguồn'} · dòng {row.row}
                              </small>
                            </td>
                            <td title={row.originalPrice?.sources[0]?.locator}>
                              {priceValue(row.originalPrice?.value)}
                            </td>
                            <td>{priceValue(row.promotionTarget?.value)}</td>
                            <td>
                              {row.issues.length ? (
                                <details>
                                  <summary>{row.issues.length} điểm cần xem</summary>
                                  {row.issues.map((issue, index) => (
                                    <p key={index}>{issue.message}</p>
                                  ))}
                                </details>
                              ) : (
                                <span className="tag neutral">Đã đọc</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!priceRows.length && (
                      <p className="empty">Không có dòng khớp. Thử đổi trang tính hoặc từ khóa.</p>
                    )}
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
