import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  RefreshCw,
  FolderOpen,
  Store,
  ListChecks,
  TriangleAlert,
  CheckCircle2,
  Server,
} from 'lucide-react';
import type { OperationsBlocker, OperationsOverview, OperationsScope } from '@shopee/domain';
import { api, date } from './api.js';
import './operations-center.css';

type Destination = OperationsBlocker['route']['page'];
export function OperationsCenter({
  onNavigate,
  onImport,
  onConnect,
}: {
  onNavigate: (page: Destination, scope?: OperationsScope) => void;
  onImport: () => void;
  onConnect: (id: string | null, scope?: OperationsScope) => void;
}) {
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scopeKey, setScopeKey] = useState('');
  const [shopOptions, setShopOptions] = useState<OperationsOverview['connections']['data']>(null);
  const loadVersion = useRef(0);
  const request = useRef<AbortController | null>(null);

  async function load() {
    const version = ++loadVersion.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const scope = scopeKey ? (JSON.parse(scopeKey) as OperationsScope) : null;
      const query = scope ? '?' + new URLSearchParams(scope).toString() : '';
      const next = await api<OperationsOverview>('/v1/operations/overview' + query, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (version !== loadVersion.current || controller.signal.aborted) return;
      setOverview(next);
      setError('');
      if (!scope && next.connections.data) setShopOptions(next.connections.data);
    } catch (cause) {
      if (version !== loadVersion.current || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Chưa đọc được dữ liệu vận hành.');
    } finally {
      if (version === loadVersion.current) setBusy(false);
    }
  }
  useEffect(() => {
    setOverview(null);
    void load();
    const update = () => {
      if (!document.hidden) void load();
    };
    const timer = setInterval(update, 30_000);
    window.addEventListener('focus', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
      request.current?.abort();
    };
  }, [scopeKey]);

  const sources = overview?.counts;
  const imports = sources?.imports.data,
    drafts = sources?.drafts.data,
    batches = sources?.batches.data;
  const connections = overview?.connections.data;
  const healthCount = connections?.items.filter(
    (shop) =>
      shop.state === 'connected' &&
      shop.tokenState === 'valid' &&
      shop.health.state === 'fresh' &&
      shop.health.outcome === 'healthy',
  ).length;
  const action = (blocker: OperationsBlocker) => {
    if (blocker.connectionId) onConnect(blocker.connectionId, blocker.scope);
    else onNavigate(blocker.route.page, blocker.scope);
  };
  return (
    <div className="operations-center">
      <header className="operations-heading">
        <div>
          <span className="operations-eyebrow">Vận hành hằng ngày</span>
          <h1>Hôm nay cần xử lý gì?</h1>
          <p>Nguồn đã lưu, kết nối và công việc của bạn trong cùng một nơi.</p>
        </div>
        <button className="primary" onClick={onImport}>
          <FolderOpen size={17} /> Nhập bộ nguồn
        </button>
      </header>
      <div className="operations-toolbar">
        <div className="operations-scope">
          <label htmlFor="operations-shop">Phạm vi công việc</label>
          <select
            id="operations-shop"
            value={scopeKey}
            onChange={(event) => setScopeKey(event.target.value)}
          >
            <option value="">Tất cả shop trong workspace</option>
            {shopOptions?.items.map((shop) => (
              <option key={shop.id} value={JSON.stringify(shop.scope)}>
                {shop.name} · {shop.scope.shopId}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className="caption">
            {overview ? `Đọc lúc ${date(overview.observedAt)}` : 'Đang đọc dữ liệu tại máy'}
            {error && overview && ' · Chưa cập nhật được lần mới'}
          </span>
          <button onClick={() => void load()} disabled={busy}>
            <RefreshCw size={16} /> {busy ? 'Đang tải…' : 'Làm mới'}
          </button>
        </div>
      </div>
      {error && (
        <div className="banner error" role="alert">
          <p>{error} Dữ liệu chưa đọc được không được tính là 0.</p>
          <button onClick={() => void load()}>Thử lại</button>
        </div>
      )}
      {!overview && !error && (
        <div className="operations-loading" role="status">
          Đang đọc tình trạng hệ thống và công việc…
        </div>
      )}
      {overview && (
        <>
          <section className="operations-metrics" aria-label="Tóm tắt từ dữ liệu đã lưu">
            <Metric
              label="Bộ nguồn đã lưu"
              value={drafts?.active}
              note="Trong workspace · chưa đồng nghĩa đã đăng"
              icon={<FolderOpen size={19} />}
              onClick={() => onNavigate('products')}
            />
            <Metric
              label="Shop vừa được kiểm tra"
              value={healthCount}
              note={
                connections
                  ? `Trong ${connections.total} kết nối đã lưu${connections.truncated ? ' · danh sách đã giới hạn' : ''}`
                  : 'Chưa đọc được kết nối'
              }
              icon={<Store size={19} />}
              onClick={() => onNavigate('shops')}
            />
            <Metric
              label="Đợt chuẩn bị cần xử lý"
              value={batches?.held}
              note={overview.scope ? 'Theo shop đang xem' : 'Các bản chuẩn bị trong database'}
              icon={<ListChecks size={19} />}
              onClick={() => onNavigate('production', overview.scope ?? undefined)}
            />
            <Metric
              label="Lần gửi chưa rõ kết quả"
              value={batches?.operationsUnknown}
              note="Đọc đối chiếu trước khi gửi thêm"
              icon={<TriangleAlert size={19} />}
              onClick={() => onNavigate('production', overview.scope ?? undefined)}
            />
          </section>
          <div className="operations-body">
            <section
              className="operations-panel operations-actions"
              aria-labelledby="operations-attention"
            >
              <header>
                <div>
                  <h2 id="operations-attention">Cần chú ý</h2>
                  <p>Vấn đề kèm bước xử lý tiếp theo.</p>
                </div>
                <span className="tag neutral">{overview.blockers.length} mục</span>
              </header>
              {overview.blockers.length ? (
                <ul>
                  {overview.blockers.map((blocker, index) => (
                    <li key={`${blocker.code}:${blocker.connectionId ?? index}`}>
                      <span className={`operations-action-icon ${blocker.severity}`}>
                        <TriangleAlert size={17} />
                      </span>
                      <div>
                        <strong>{blocker.message}</strong>
                        <p>{blocker.nextAction}</p>
                        {blocker.scope && (
                          <small>
                            Shop {blocker.scope.shopId} ·{' '}
                            {blocker.scope.environment === 'production'
                              ? 'Shop thật'
                              : 'Thử nghiệm'}
                          </small>
                        )}
                        <details>
                          <summary>Thông tin để hỗ trợ</summary>
                          <code>{blocker.code}</code>
                          <p>Nguồn: {blocker.source}</p>
                        </details>
                      </div>
                      <button onClick={() => action(blocker)}>
                        Xử lý <ArrowRight size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="operations-clear">
                  <CheckCircle2 size={26} />
                  <h3>Chưa có vấn đề trong dữ liệu đã đọc</h3>
                  <p>Trước mỗi lần gửi, ứng dụng vẫn kiểm tra đúng nguồn và shop của đợt đó.</p>
                </div>
              )}
            </section>
            <aside className="operations-side">
              <section className="operations-panel" aria-labelledby="operations-runtime">
                <header>
                  <h2 id="operations-runtime">
                    <Server size={18} /> Tình trạng ứng dụng
                  </h2>
                </header>
                <dl className="operations-facts">
                  <Fact
                    label="Database"
                    value={
                      overview.database.data
                        ? overview.database.data.schemaReady
                          ? 'Đã kiểm tra cấu trúc'
                          : 'Cần cập nhật cấu trúc'
                        : 'Chưa kiểm tra được'
                    }
                    good={overview.database.data?.schemaReady}
                  />
                  <Fact
                    label="Bộ đọc nguồn"
                    value={
                      overview.worker.data?.state === 'online'
                        ? 'Đang hoạt động'
                        : overview.worker.data
                          ? 'Chưa chạy'
                          : 'Chưa đọc được'
                    }
                    good={overview.worker.data?.state === 'online'}
                  />
                  <Fact
                    label="Luồng đăng"
                    value={
                      overview.runtime.productionWorkflowEnabled ? 'Đã bật cấu hình' : 'Đang tắt'
                    }
                  />
                  <Fact
                    label="Tự gia hạn kết nối"
                    value={overview.runtime.connectionMaintenanceEnabled ? 'Đã bật' : 'Đang tắt'}
                  />
                </dl>
                {overview.runtime.isolatedMode && (
                  <p className="operations-isolation">
                    Bản thử riêng. Yêu cầu ra ngoài tới Shopee bị chặn.
                  </p>
                )}
                <p className="caption">
                  Khả năng gửi được xác định trong từng đợt. Kết nối còn hạn hoặc cấu hình đã bật
                  chưa đủ để kết luận có thể đăng.
                </p>
              </section>
              <section className="operations-panel" aria-label="Tiếp tục công việc">
                <header>
                  <h2>Tiếp tục công việc</h2>
                </header>
                <button className="operations-shortcut" onClick={() => onNavigate('products')}>
                  <FolderOpen size={18} />
                  <span>Mở bộ listing đã lưu</span>
                  <ArrowRight size={16} />
                </button>
                <button
                  className="operations-shortcut"
                  onClick={() => onNavigate('production', overview.scope ?? undefined)}
                >
                  <ListChecks size={18} />
                  <span>Mở đợt đăng đang làm</span>
                  <ArrowRight size={16} />
                </button>
                <button className="operations-shortcut" onClick={() => onNavigate('shops')}>
                  <Store size={18} />
                  <span>Quản lý kết nối shop</span>
                  <ArrowRight size={16} />
                </button>
                <p className="caption">
                  {imports
                    ? `${imports.queued + imports.running} tệp đang chờ/đọc · ${imports.failed} tệp lỗi`
                    : 'Chưa đọc được thống kê tệp.'}
                </p>
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  note,
  icon,
  onClick,
}: {
  label: string;
  value?: number;
  note: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="operations-metric" onClick={onClick}>
      <span>
        {icon}
        {label}
      </span>
      <strong>{value === undefined ? '—' : value.toLocaleString('vi-VN')}</strong>
      <small>{note}</small>
    </button>
  );
}
function Fact({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className={`operations-fact-dot ${good ? 'good' : ''}`} />
        {value}
      </dd>
    </div>
  );
}
