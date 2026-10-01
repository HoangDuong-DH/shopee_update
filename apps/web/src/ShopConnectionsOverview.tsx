import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Plus, RefreshCw, Search, Store, X } from 'lucide-react';
import type { ShopConnection } from '@shopee/domain';
import { ShopNameEditor } from './ShopNameEditor.js';
import { connectionHealthView, filterShopConnections } from './shop-connections.js';
import './shop-connections.css';
export type ShopConnectionsOverviewProps = {
  shops: ShopConnection[];
  selectedShopId?: string | null;
  onSelectShop?: (id: string) => void;
  onConnectShop: (id: string | null) => void;
  onRefresh: () => void | Promise<void>;
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
  loading = false,
}: ShopConnectionsOverviewProps) {
  const [query, setQuery] = useState('');
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
          <p className="shop-overview-result-count" role="status">
            {visible.length} / {shops.length} shop trong danh sách
          </p>
          <div className={'shop-overview-layout' + (detail ? ' has-detail' : '')}>
            <div>
              {visible.length ? (
                <ul className="shop-connection-list">
                  {visible.map((shop) => {
                    const view = health.get(shop.id)!;
                    return (
                      <li key={shop.id}>
                        <button
                          type="button"
                          className={
                            'shop-connection-row' + (detailId === shop.id ? ' is-open' : '')
                          }
                          aria-expanded={detailId === shop.id}
                          aria-controls={id + '-detail'}
                          onClick={() => openDetail(shop)}
                        >
                          <span className="shop-connection-identity">
                            <strong>{shopName(shop)}</strong>
                            <small>
                              Shop {shop.scope.shopId} · Partner {shop.scope.partnerId}
                            </small>
                          </span>
                          <span className="shop-connection-state">
                            <span className={'shop-connection-health is-' + view.tone}>
                              {view.label}
                            </span>
                            <small>
                              {shop.scope.environment === 'production' ? 'Shop thật' : 'Thử nghiệm'}
                            </small>
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
                    <dt>Tự gia hạn</dt>
                    <dd>
                      {detail.autoRefresh === true
                        ? 'Đã bật'
                        : detail.autoRefresh === false
                          ? 'Đang tắt'
                          : 'Chưa có thông tin'}
                    </dd>
                  </div>
                </dl>
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
