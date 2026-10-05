import { useWorkspaceDataUpdates } from './useWorkspaceDataUpdates.js';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowRight, FolderOpen, Plus, RefreshCw, Search } from 'lucide-react';
import type { ListingDraft, LocalLibraryPage, LocalProductSummary } from '@shopee/domain';
import { api, date } from './api.js';
import { ArchiveAction, LifecycleFilter, type Lifecycle } from './LocalArchive.js';
import './listing-library.css';
const BulkProductEdit = lazy(() =>
  import('./BulkProductEdit.js').then((module) => ({ default: module.BulkProductEdit })),
);

export function ListingLibrary({
  onImport,
  onOpen,
  onPrepare,
  onBusy,
}: {
  onImport: () => void;
  onOpen: (draft: ListingDraft) => void;
  onPrepare: () => void;
  onBusy?: (value: boolean) => void;
}) {
  const [rows, setRows] = useState<LocalProductSummary[]>([]);
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState('');
  const [lifecycle, setLifecycle] = useState<Lifecycle>('active');
  const [cursor, setCursor] = useState<string | null>(null),
    [observedAt, setObservedAt] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string[]>([]),
    [bulk, setBulk] = useState<ListingDraft[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const blocked = opening || bulkBusy;
  const reportBulkBusy = (value: boolean) => {
    setBulkBusy(value);
    onBusy?.(value);
  };
  const version = useRef(0),
    request = useRef<AbortController | null>(null),
    openLock = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  async function load(append = false, token: string | null = null) {
    const revision = ++version.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({ lifecycle, q: search, limit: '40' });
      if (token) params.set('cursor', token);
      const page = await api<LocalLibraryPage<LocalProductSummary>>(
        '/v1/local-library/products?' + params,
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) },
      );
      if (controller.signal.aborted || revision !== version.current) return;
      setRows((previous) =>
        append
          ? [...new Map([...previous, ...page.items].map((row) => [row.productKey, row])).values()]
          : page.items,
      );
      setCursor(page.nextCursor);
      setObservedAt(page.observedAt);
    } catch (cause) {
      if (!controller.signal.aborted && revision === version.current)
        setError(cause instanceof Error ? cause.message : 'Chưa tải được bộ listing.');
    } finally {
      if (revision === version.current) setBusy(false);
    }
  }
  useEffect(() => {
    setRows([]);
    setCursor(null);
    setSelected([]);
    setBulk(null);
    void load();
    return () => request.current?.abort();
  }, [search, lifecycle]);
  useEffect(() => {
    if (reload) void load();
  }, [reload]);
  useWorkspaceDataUpdates(() => load(), ['sources'], busy || blocked || selected.length > 0 || bulk !== null || rows.length > 40);
  const changed = () => setReload((value) => value + 1);
  async function openRow(row: LocalProductSummary) {
    if (openLock.current || row.archived) return;
    openLock.current = true;
    setOpening(true);
    setError('');
    try {
      const draft = await api<ListingDraft>('/v1/products/' + encodeURIComponent(row.productKey));
      onOpen(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa mở được bộ listing.');
    } finally {
      openLock.current = false;
      setOpening(false);
    }
  }
  async function openBulk() {
    if (openLock.current || !selected.length) return;
    openLock.current = true;
    setOpening(true);
    setError('');
    try {
      const drafts: ListingDraft[] = [];
      const queue = [...selected];
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let key = queue.shift(); key; key = queue.shift())
            drafts.push(await api<ListingDraft>('/v1/products/' + encodeURIComponent(key)));
        }),
      );
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Chưa mở đủ các bộ đã chọn. Giữ lựa chọn và thử lại.');
      setBulk(drafts);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Chưa mở đủ các bộ đã chọn. Giữ lựa chọn và thử lại.',
      );
    } finally {
      openLock.current = false;
      setOpening(false);
    }
  }
  async function refreshBulk() {
    changed();
    if (!bulk || openLock.current) return;
    openLock.current = true;
    setOpening(true);
    try {
      const queue = bulk.map((draft) => draft.productKey),
        drafts: ListingDraft[] = [];
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let key = queue.shift(); key; key = queue.shift())
            drafts.push(await api<ListingDraft>('/v1/products/' + encodeURIComponent(key)));
        }),
      );
      if (results.some((result) => result.status === 'rejected'))
        throw new Error(
          'Đã lưu thay đổi nhưng chưa đọc đủ phiên bản nguồn mới. Giữ biên nhận và tải lại các bộ trước khi sửa tiếp.',
        );
      setBulk(drafts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa đọc đủ nguồn đã lưu.');
    } finally {
      openLock.current = false;
      setOpening(false);
    }
  }
  return (
    <section className="listing-library" aria-labelledby="listing-library-title">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Nguồn đã lưu trong ứng dụng</p>
          <h1 id="listing-library-title">Bộ listing</h1>
          <p>Mở đúng bộ nguồn để sửa nội dung, đối chiếu phân loại và chuẩn bị đăng.</p>
        </div>
        <button className="primary" onClick={onImport} disabled={blocked}>
          <Plus size={17} /> Nhập bộ nguồn
        </button>
      </header>
      <div className="library-toolbar">
        <label className="library-search">
          <Search size={17} />
          <input
            aria-label="Tìm listing"
            disabled={blocked}
            placeholder="Tìm theo tên, mã bộ hoặc SKU"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <LifecycleFilter value={lifecycle} onChange={setLifecycle} disabled={blocked} />
        <button onClick={changed} disabled={busy || blocked}>
          <RefreshCw size={16} /> Làm mới
        </button>
      </div>
      {error && (
        <div role="alert" className="banner error">
          <p>{error}</p>
          <button onClick={changed}>Thử tải lại</button>
        </div>
      )}
      {selected.length > 0 && lifecycle === 'active' && (
        <div className="library-selection" role="status">
          <span>
            Đã chọn <strong>{selected.length}</strong> bộ nguồn
          </span>
          <button disabled={blocked} onClick={() => void openBulk()}>
            {opening ? 'Đang mở…' : 'Chỉnh các bộ đã chọn'}
          </button>
          <button
            disabled={blocked}
            onClick={() => {
              setSelected([]);
              setBulk(null);
            }}
          >
            Bỏ chọn
          </button>
        </div>
      )}
      {bulk && (
        <div className="library-bulk">
          <fieldset disabled={blocked} className="library-bulk-content">
            <Suspense fallback={<p role="status">Đang mở các bộ đã chọn…</p>}>
              <BulkProductEdit
                products={bulk}
                onSaved={() => void refreshBulk()}
                onPrepare={onPrepare}
                onBusy={reportBulkBusy}
              />
            </Suspense>
          </fieldset>
          <button disabled={blocked} onClick={() => setBulk(null)}>
            Đóng chỉnh sửa nhiều bộ
          </button>
        </div>
      )}
      <div className="library-board">
        <div className="library-columns">
          <span>Bộ nguồn</span>
          <span>Phân loại & ảnh</span>
          <span>Cần xử lý</span>
          <span>Thao tác</span>
        </div>
        {rows.map((row) => (
          <article key={row.productKey} className="library-row" data-testid="listing-row">
            <div className="library-identity">
              {lifecycle === 'active' && (
                <input
                  type="checkbox"
                  aria-label={'Chọn ' + (row.title ?? row.productKey)}
                  checked={selected.includes(row.productKey)}
                  disabled={blocked}
                  onChange={(event) =>
                    setSelected((keys) =>
                      event.target.checked
                        ? [...keys, row.productKey]
                        : keys.filter((key) => key !== row.productKey),
                    )
                  }
                />
              )}
              {row.coverKey ? (
                <img
                  loading="lazy"
                  src={'/v1/media/' + encodeURIComponent(row.coverKey)}
                  alt={'Bìa ' + (row.title ?? row.productKey)}
                />
              ) : (
                <span className="library-cover-placeholder">
                  <FolderOpen size={20} />
                  <small>Chưa có bìa</small>
                </span>
              )}
              <div>
                <button
                  className="listing-title"
                  disabled={row.archived || blocked}
                  onClick={() => void openRow(row)}
                  aria-label={(row.title ?? row.productKey) + ' · Xem & kiểm tra'}
                >
                  {row.title ?? 'Chưa có tiêu đề'}
                </button>
                <small>
                  Bản nguồn {row.revision} · {date(row.updatedAt)}
                </small>
                {row.shopAssignments.length > 0 && (
                  <small>
                    {[
                      ...new Set(
                        row.shopAssignments.map(
                          (item) => item.name ?? item.scope?.shopId ?? 'Chưa chọn shop',
                        ),
                      ),
                    ].join(' · ')}
                    {row.shopAssignmentsTruncated ? ' · còn shop khác' : ''}
                  </small>
                )}
              </div>
            </div>
            <div className="library-facts">
              <strong>
                {row.variantCount === null ? 'Chưa đọc được SKU' : `${row.variantCount} SKU`}
              </strong>
              <small>
                {row.galleryCount === null
                  ? 'Chưa đọc được ảnh'
                  : `${row.galleryCount} ảnh sản phẩm`}
              </small>
            </div>
            <div>
              <span
                className={
                  'tag ' +
                  (row.savedBlockingIssueCount !== null && row.savedBlockingIssueCount > 0
                    ? 'danger'
                    : 'neutral')
                }
              >
                {row.savedBlockingIssueCount === null
                  ? 'Chưa kiểm tra nguồn'
                  : row.savedBlockingIssueCount > 0
                    ? `${row.savedBlockingIssueCount} mục cần bổ sung`
                    : 'Cần kiểm tra theo shop'}
              </span>
              <small className="row-note">Theo bản nguồn đã lưu</small>
            </div>
            <div className="library-actions">
              <ArchiveAction
                kind="product"
                resourceId={row.productKey}
                name={row.title ?? row.productKey}
                archived={row.archived}
                disabled={blocked}
                onChanged={changed}
              />
              <button
                disabled={row.archived || blocked}
                onClick={() => void openRow(row)}
                aria-label={'Mở chi tiết bộ ' + row.productKey}
              >
                <ArrowRight size={17} />
              </button>
            </div>
          </article>
        ))}
        {!rows.length && !busy && !error && (
          <div className="empty">
            <FolderOpen size={29} />
            <h2>
              {search
                ? 'Chưa có bộ khớp tìm kiếm'
                : lifecycle === 'archived'
                  ? 'Chưa có bộ được lưu trữ'
                  : 'Bắt đầu từ một bộ nguồn của bạn'}
            </h2>
            <p>
              {search
                ? 'Thử tên sản phẩm hoặc SKU khác.'
                : lifecycle === 'archived'
                  ? 'Các bộ lưu trữ trong ứng dụng sẽ hiện tại đây; sản phẩm trên shop được giữ nguyên.'
                  : 'Nhập Word, ảnh và bảng giá để lưu một bộ listing có nguồn rõ ràng.'}
            </p>
            {!search && lifecycle === 'active' && (
              <button className="primary" onClick={onImport}>
                Nhập bộ nguồn
              </button>
            )}
          </div>
        )}
        {busy && (
          <div className="library-loading" role="status">
            Đang đọc danh sách bộ nguồn…
          </div>
        )}
      </div>
      <footer className="library-footer">
        <span className="caption">
          {rows.length} bộ đang hiển thị{observedAt ? ' · Đọc lúc ' + date(observedAt) : ''}. Lưu
          nguồn chưa gửi sản phẩm lên Shopee.
        </span>
        {cursor && (
          <button onClick={() => void load(true, cursor)} disabled={busy || blocked}>
            Xem thêm
          </button>
        )}
      </footer>
    </section>
  );
}
