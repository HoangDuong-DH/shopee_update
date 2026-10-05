import { useWorkspaceDataUpdates } from './useWorkspaceDataUpdates.js';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Plus, RefreshCw, Search, Store, X, Download, ListChecks, ShieldCheck, Copy, MoreHorizontal } from 'lucide-react';
import type { ShopConnection } from '@shopee/domain';
import { ShopNameEditor } from './ShopNameEditor.js';
import { connectionHealthView, filterShopConnections } from './shop-connections.js';
import { shopSelectionKey, selectedConnections, toggleVisibleConnections, connectionStatusCsv } from './shop-bulk-selection.js';
import { BulkConnectionActions } from './BulkConnectionActions.js';
import './shop-connections.css';
export type ShopConnectionsOverviewProps = {
  shops: ShopConnection[];
  selectedShopId?: string | null;
  onSelectShop?: (id: string) => void;
  onConnectShop: (id: string | null) => void;
  onRefresh: () => void | Promise<void>;
  onPrepareCopy?: (shops: ShopConnection[]) => void;
  onBatchBusyChange?: (busy: boolean) => void;
  loading?: boolean;
};
function shopName(shop: ShopConnection) {
  return shop.displayName || shop.officialName || shop.name || `Shop ${shop.scope.shopId}`;
}
function timeLabel(value: string | null) {
  return value ? new Date(value).toLocaleString('vi-VN') : 'Chưa có thông tin';
}

export function ShopConnectionsOverview({
  shops,
  selectedShopId,
  onSelectShop,
  onConnectShop,
  onRefresh,
  onPrepareCopy,
  onBatchBusyChange,
  loading = false,
}: ShopConnectionsOverviewProps) {
  const [query, setQuery] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [bulkSummary, setBulkSummary] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkAction, setBulkAction] = useState<'check' | 'refresh' | null>(null);
  const [bulkTargets, setBulkTargets] = useState<ShopConnection[]>([]);
  function openBulkAction(action: 'check' | 'refresh') {
    setBulkTargets(selected.map((shop) => ({ ...shop, scope: { ...shop.scope } })));
    setBulkAction(action);
  }
  const selectVisible = useRef<HTMLInputElement>(null);
  const bulkMore = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const menu = bulkMore.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const menu = bulkMore.current;
      if (event.key === 'Escape' && menu?.open) { menu.open = false; menu.querySelector('summary')?.focus(); }
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  const [environment, setEnvironment] = useState<'all' | 'production' | 'sandbox'>('all');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(selectedShopId ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const refreshLock = useRef(false);
  const detailElement = useRef<HTMLElement>(null);
  const id = useId();
  useEffect(() => {
    if (selectedShopId !== undefined) setDetailId(selectedShopId);
  }, [selectedShopId]);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  const health = useMemo(
    () => new Map(shops.map((shop) => [shop.id, connectionHealthView(shop, now)])),
    [shops, now],
  );
  const visible = filterShopConnections(shops, query).filter(
    (shop) =>
      (environment === 'all' || shop.scope.environment === environment) &&
      (!attentionOnly || health.get(shop.id)?.needsAttention),
  );
  const selected = selectedConnections(shops, selectedKeys);
  const visibleSelected = visible.filter((shop) => selectedKeys.has(shopSelectionKey(shop))).length;
  const hiddenSelected = selected.length - visibleSelected;
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;
  useEffect(() => {
    if (selectVisible.current) selectVisible.current.indeterminate = visibleSelected > 0 && !allVisibleSelected;
  }, [visibleSelected, allVisibleSelected]);
  useEffect(() => {
    const available = new Set(shops.map(shopSelectionKey));
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => available.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [shops]);
  function exportSelected() {
    if (!selected.length) return;
    const url = URL.createObjectURL(new Blob([connectionStatusCsv(selected, Date.now())], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'trang-thai-shop-da-chon.csv';
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const productionCount = shops.filter((shop) => shop.scope.environment === 'production').length;
  const attentionCount = [...health.values()].filter((view) => view.needsAttention).length;
  const detail = detailId ? shops.find((shop) => shop.id === detailId) : undefined;
  const detailHealth = detail ? health.get(detail.id)! : null;
  const missingSelection = Boolean(
    selectedShopId && !shops.some((shop) => shop.id === selectedShopId),
  );
  const busy = loading || refreshing;
  async function refresh() {
    if (refreshLock.current || loading) return;
    refreshLock.current = true;
    setRefreshing(true);
    setRefreshError('');
    try {
      await onRefresh();
    } catch (cause) {
      if (mounted.current)
        setRefreshError(
          cause instanceof Error
            ? cause.message
            : 'Chưa tải lại được danh sách shop. Bạn có thể thử lại.',
        );
    } finally {
      refreshLock.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }
  useWorkspaceDataUpdates(refresh, ['connections'], busy || bulkRunning);
  function openDetail(shop: ShopConnection) {
    setDetailId(shop.id);
    requestAnimationFrame(() => detailElement.current?.focus({ preventScroll: true }));
  }
  return (
    <section className="shop-overview" aria-label="Danh sách kết nối shop" aria-busy={busy}>
      <header className="shop-overview-heading">
        <div>
          <h2>Các shop đã lưu</h2>
          <p>
            {shops.length} shop · {productionCount} shop thật · {shops.length - productionCount}{' '}
            shop thử nghiệm{attentionCount > 0 ? ` · ${attentionCount} kết nối cần kiểm tra` : ''}
          </p>
        </div>
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={16} aria-hidden="true" />
            {busy ? 'Đang đọc…' : 'Đọc lại danh sách'}
          </button>
          <button type="button" className="primary" onClick={() => onConnectShop(null)}>
            <Plus size={16} aria-hidden="true" />
            Kết nối shop mới
          </button>
        </div>
      </header>
      {refreshError && (
        <p role="alert" className="notice warning">
          {refreshError}
        </p>
      )}
      {missingSelection && (
        <p role="alert" className="notice warning">
          Shop đang chọn không còn trong danh sách. Đọc lại danh sách hoặc chọn rõ shop cần mở.
        </p>
      )}
      {busy && !shops.length && (
        <p role="status" className="shop-overview-empty">
          Đang đọc các kết nối đã lưu…
        </p>
      )}
      {!busy && !shops.length && (
        <div className="shop-overview-empty">
          <Store size={24} aria-hidden="true" />
          <h3>Chưa có shop được lưu</h3>
          <p>Chọn Kết nối shop mới để cấp quyền cho đúng shop và ứng dụng.</p>
        </div>
      )}
      {shops.length > 0 && (
        <>
          <div className="shop-overview-controls">
            <label className="shop-overview-search" htmlFor={id + '-search'}>
              <Search size={17} aria-hidden="true" />
              <input
                id={id + '-search'}
                type="search"
                value={query}
                placeholder="Tìm tên shop, Shop ID hoặc Partner ID"
                aria-label="Tìm kết nối shop"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label htmlFor={id + '-environment'} className="shop-overview-environment">
              Môi trường
              <select
                id={id + '-environment'}
                value={environment}
                onChange={(event) => setEnvironment(event.target.value as typeof environment)}
              >
                <option value="all">Tất cả shop</option>
                <option value="production">Shop thật</option>
                <option value="sandbox">Thử nghiệm</option>
              </select>
            </label>
            <label className="shop-overview-attention">
              <input
                type="checkbox"
                checked={attentionOnly}
                onChange={(event) => setAttentionOnly(event.target.checked)}
              />
              Chỉ kết nối cần kiểm tra
            </label>
          </div>
          <div className="shop-selection-heading">
            <label className="shop-select-visible">
              <input type="checkbox" ref={selectVisible} disabled={!visible.length || busy}
                checked={allVisibleSelected} aria-label="Chọn các shop đang hiển thị"
                onChange={() => setSelectedKeys((current) => toggleVisibleConnections(current, visible))} />
              Chọn tất cả đang hiển thị
            </label>
            <span className="shop-overview-result-count" role="status">{visible.length} / {shops.length} shop</span>
          </div>
          {selected.length > 0 && (
            <div className="shop-bulk-bar">
              <span role="status"><strong>{selected.length}</strong> shop đã chọn{hiddenSelected > 0 && <small> · {hiddenSelected} ngoài bộ lọc</small>}</span>
              <button type="button" disabled={bulkRunning} onClick={() => openBulkAction('check')}><ShieldCheck size={16} aria-hidden="true" />Kiểm tra kết nối</button>
              <button type="button" disabled={bulkRunning} onClick={() => openBulkAction('refresh')}><RefreshCw size={16} aria-hidden="true" />Gia hạn kết nối</button>
              {onPrepareCopy && <button type="button" disabled={bulkRunning} onClick={() => onPrepareCopy(selected)}><Copy size={16} aria-hidden="true" />Chuẩn bị sao chép</button>}
              <details className="shop-bulk-more" ref={bulkMore}>
                <summary><MoreHorizontal size={16} aria-hidden="true" />Thêm</summary>
                <div>
                  <button type="button" aria-expanded={bulkSummary} onClick={() => setBulkSummary((value) => !value)}><ListChecks size={16} aria-hidden="true" />Tóm tắt</button>
                  <button type="button" onClick={exportSelected}><Download size={16} aria-hidden="true" />Xuất trạng thái</button>
                  <button type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />Đọc lại dữ liệu đã lưu</button>
                </div>
              </details>
              <button type="button" className="text-button" onClick={() => { setSelectedKeys(new Set()); setBulkSummary(false); }}>Bỏ chọn</button>
              {bulkSummary && <section className="shop-bulk-summary" aria-label="Tóm tắt shop đã chọn">
                <p>Trạng thái đã lưu trong ứng dụng; không kiểm tra mới với Shopee.</p>
                <ul>{selected.map((shop) => <li key={shopSelectionKey(shop)}><strong>{shopName(shop)}</strong><span className={'shop-connection-health is-' + health.get(shop.id)!.tone}>{health.get(shop.id)!.label}</span><small>{shop.scope.environment === 'production' ? 'Shop thật' : 'Thử nghiệm'} · {shop.scope.shopId} · Partner {shop.scope.partnerId}</small></li>)}</ul>
              </section>}
            </div>
          )}
          {bulkAction && <BulkConnectionActions shops={bulkTargets} initialAction={bulkAction} onRefresh={onRefresh} onConnectShop={onConnectShop} onBusyChange={(value) => { setBulkRunning(value); onBatchBusyChange?.(value); }} />}
          <div className={'shop-overview-layout' + (detail ? ' has-detail' : '')}>
            <div>
              {visible.length ? (
                <ul className="shop-connection-list">
                  {visible.map((shop) => {
                    const view = health.get(shop.id)!;
                    return (
                      <li key={shop.id} className={selectedKeys.has(shopSelectionKey(shop)) ? 'is-selected' : undefined}>
                        <label className="shop-row-select">
                          <input type="checkbox" aria-label={`Chọn shop: ${shopName(shop)} · ${shop.scope.shopId} · ${shop.scope.environment} · Partner ${shop.scope.partnerId}`}
                            checked={selectedKeys.has(shopSelectionKey(shop))} disabled={busy}
                            onChange={() => setSelectedKeys((current) => {
                              const next = new Set(current), key = shopSelectionKey(shop);
                              if (next.has(key)) next.delete(key); else next.add(key);
                              return next;
                            })} />
                        </label>
                        <button
                          type="button"
                          className={
                            'shop-connection-row' + (detailId === shop.id ? ' is-open' : '')
                          }
                          aria-label={`${shopName(shop)} · Shop ${shop.scope.shopId} · Partner ${shop.scope.partnerId} · ${view.label}`}
                          aria-expanded={detailId === shop.id}
                          aria-controls={id + '-detail'}
                          onClick={() => openDetail(shop)}
                        >
                          <span className="shop-connection-identity">
                            <strong>{shopName(shop)}</strong>
                            <small>
                              {shop.scope.shopId}
                            </small>
                          </span>
                          <span className="shop-connection-state">
                            <span className={'shop-connection-health is-' + view.tone}>
                              {view.label}
                            </span>
                            {shop.scope.environment === 'sandbox' && <small>Thử nghiệm</small>}
                          </span>
                          <ChevronRight size={17} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="shop-overview-empty">
                  <h3>Không có shop khớp bộ lọc</h3>
                  <p>Thử tên gợi nhớ, tên Shopee hoặc Shop ID.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      setEnvironment('all');
                      setAttentionOnly(false);
                    }}
                  >
                    Xóa bộ lọc
                  </button>
                </div>
              )}
            </div>
            {detail && detailHealth && (
              <aside
                id={id + '-detail'}
                className="shop-connection-detail"
                aria-label={'Chi tiết kết nối ' + shopName(detail)}
                tabIndex={-1}
                ref={detailElement}
              >
                <header>
                  <div>
                    <small>
                      {detail.scope.environment === 'production' ? 'Shop thật' : 'Thử nghiệm'}
                    </small>
                    <h3>{shopName(detail)}</h3>
                  </div>
                  <button
                    type="button"
                    className="shop-detail-close"
                    aria-label="Đóng chi tiết shop"
                    onClick={() => setDetailId(null)}
                  >
                    <X size={17} aria-hidden="true" />
                  </button>
                </header>
                <p className={'shop-connection-health is-' + detailHealth.tone}>
                  {detailHealth.label}
                </p>
                <p className="shop-connection-guidance">{detailHealth.detail}</p>
                <dl>
                  <div>
                    <dt>Shop ID</dt>
                    <dd>{detail.scope.shopId}</dd>
                  </div>
                  <div>
                    <dt>Partner ID</dt>
                    <dd>{detail.scope.partnerId}</dd>
                  </div>
                  <div>
                    <dt>Khu vực</dt>
                    <dd>{detail.region}</dd>
                  </div>
                  <div>
                    <dt>
                      {detailHealth.code === 'checked'
                        ? 'Lần kiểm tra quyền truy cập'
                        : 'Cập nhật tình trạng kết nối'}
                    </dt>
                    <dd>{timeLabel(detailHealth.checkedAt)}</dd>
                  </div>
                  <div>
                    <dt>Thời hạn token đã lưu</dt>
                    <dd>{timeLabel(detailHealth.expiresAt)}</dd>
                  </div>
                  <div>
                    <dt>Cho phép tự gia hạn</dt>
                    <dd>
                      {detail.autoRefresh === true
                        ? 'Đã cho phép cho shop này'
                        : detail.autoRefresh === false
                          ? 'Chưa cho phép cho shop này'
                          : 'Chưa có thông tin'}
                    </dd>
                  </div>
                </dl>
                <p className="shop-connection-guidance">
                  Tùy chọn riêng của shop. Tự gia hạn chỉ chạy khi dịch vụ gia hạn của ứng dụng
                  đang hoạt động.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onConnectShop(detail.id)}
                  >
                    {detailHealth.actionLabel}
                  </button>
                  {onSelectShop && detail.scope.environment === 'production' && (
                    <button type="button" onClick={() => onSelectShop(detail.id)}>
                      Chọn làm shop đích
                    </button>
                  )}
                </div>
                <details className="shop-alias-editor">
                  <summary>Chỉnh tên gợi nhớ trong ứng dụng</summary>
                  <ShopNameEditor key={detail.id} shop={detail} onSaved={onRefresh} />
                </details>
              </aside>
            )}
          </div>
        </>
      )}
    </section>
  );
}
