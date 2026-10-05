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
  ChevronDown,
  CircleHelp,
  Clock3,
  KeyRound,
  History,
} from 'lucide-react';
import type { OperationsBlocker, OperationsOverview, OperationsScope } from '@shopee/domain';
import { api, date } from './api.js';
import { operationsConnectionKey, presentOperationsIssues, connectionIndicator, connectionIndicatorCounts, type ConnectionIndicator } from './operations-presentation.js';
import './operations-center.css';
import { useWorkspaceDataUpdates } from './useWorkspaceDataUpdates.js';
import { operationNextAction, operationsDataUnavailable, type OperationsNextAction } from './operations-presentation.js';

type Destination = OperationsBlocker['route']['page'];
export function OperationsCenter({
  onNavigate,
  onImport,
  onConnect,
}: {
  onNavigate: (page: Destination, scope?: OperationsScope, action?: OperationsNextAction) => void;
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
    return () => request.current?.abort();
  }, [scopeKey]);

  useWorkspaceDataUpdates(load, ['workspace']);
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
    else { const next = operationNextAction(blocker); onNavigate(next.page, blocker.scope, next); }
  };
  const issues = presentOperationsIssues(overview?.blockers ?? [], connections?.items);
  const issueCount = overview?.blockers.length ?? 0;
  return (
    <div className="operations-center">
      <header className="operations-heading">
        <div>
          <span className="operations-eyebrow">Không gian vận hành</span>
          <h1>Hôm nay cần xử lý gì?</h1>
          <p>Tiếp tục công việc, xử lý nguồn và theo dõi đúng shop.</p>
        </div>
        <button className="primary operations-import" onClick={onImport}>
          <FolderOpen size={17} aria-hidden="true" />
          Nhập bộ nguồn
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
              <option
                key={operationsConnectionKey(shop.id, shop.scope)}
                value={JSON.stringify(shop.scope)}
              >
                {shop.name} · {scopeLabel(shop.scope)}
              </option>
            ))}
          </select>
        </div>
        <div className="operations-updated">
          <span className="caption" role="status">
            {overview
              ? `Đọc lúc ${date(overview.observedAt)}`
              : error
                ? 'Chưa đọc được dữ liệu'
                : 'Đang đọc dữ liệu tại máy'}
            {error && overview && ' · Chưa cập nhật được lần mới'}
          </span>
          <button onClick={() => void load()} disabled={busy}>
            <RefreshCw
              size={16}
              aria-hidden="true"
              className={busy ? 'operations-refreshing' : undefined}
            />
            {busy ? 'Đang tải…' : 'Làm mới'}
          </button>
        </div>
      </div>
      {error && (
        <div className="banner error" role="alert">
          <p>{error} Dữ liệu chưa đọc được không được tính là 0.</p>
          <button onClick={() => void load()} disabled={busy}>
            Thử lại
          </button>
        </div>
      )}
      {!overview && !error && <OverviewLoading />}
      {overview && (
        <>
          <nav className="operations-journey" aria-label="Quy trình đăng hàng">
            <button onClick={onImport}><FolderOpen size={17} /><span><strong>1. Nhập nguồn</strong><small>Word, ảnh, bảng giá</small></span><ArrowRight size={14}/></button>
            <button onClick={() => onNavigate('shops')}><Store size={17} /><span><strong>2. Chọn shop</strong><small>Kiểm tra kết nối</small></span><ArrowRight size={14}/></button>
            <button onClick={() => onNavigate('production', overview.scope ?? undefined, {label:'Chuẩn bị',page:'production',view:'new'})}><ListChecks size={17}/><span><strong>3. Chuẩn bị & đăng ẩn</strong><small>Đối chiếu trước khi gửi</small></span><ArrowRight size={14}/></button>
            <button onClick={() => onNavigate('production', overview.scope ?? undefined, {label:'Kết quả',page:'production',view:'working',filter:'qc'})}><CheckCircle2 size={17}/><span><strong>4. Kiểm tra kết quả</strong><small>QC từng listing đã tạo</small></span><ArrowRight size={14}/></button>
          </nav>
          <section className="operations-metrics" aria-label="Tóm tắt từ dữ liệu đã lưu">
            <Metric
              label="Bộ nguồn đã lưu"
              value={drafts?.active}
              note="Toàn workspace · chưa đồng nghĩa đã đăng"
              icon={<FolderOpen size={17} />}
              onClick={() => onNavigate('products')}
            />
            <Metric
              label="Shop kiểm tra gần đây"
              value={healthCount}
              note={
                connections
                  ? `${connections.items.filter(shop => shop.state === 'connected' && ['valid','expiring'].includes(shop.tokenState)).length} kết nối còn hạn · kiểm tra trong 15 phút${connections.truncated ? ' · danh sách đã giới hạn' : ''}`
                  : 'Chưa đọc được kết nối'
              }
              icon={<Store size={17} />}
              onClick={() => onNavigate('shops')}
            />
            <Metric
              label="Đợt chuẩn bị cần xử lý"
              value={batches?.held}
              note={overview.scope ? 'Theo shop đang xem' : 'Các bản chuẩn bị trong database'}
              icon={<ListChecks size={17} />}
              onClick={() => onNavigate('production', overview.scope ?? undefined, {label:'Xem nguồn cần bổ sung',page:'production',view:'new',filter:'all'})}
            />
            <Metric
              label="Lần gửi chưa rõ kết quả"
              value={batches?.operationsUnknown}
              note="Đọc đối chiếu trước khi gửi thêm"
              icon={<TriangleAlert size={17} />}
              onClick={() => onNavigate('production', overview.scope ?? undefined)}
            />
          </section>
          {operationsDataUnavailable(overview) && (
            <div className="operations-partial" role="status">
              <CircleHelp size={16} aria-hidden="true" />
              <p>Một phần dữ liệu chưa đọc được. Dấu — là chưa có kết quả, không phải 0.</p>
            </div>
          )}
          <div className="operations-body">
            <section
              className="operations-panel operations-actions"
              aria-labelledby="operations-attention"
            >
              <header>
                <div>
                  <span className="operations-section-label">Việc cần xử lý</span>
                  <h2 id="operations-attention">Cần chú ý</h2>

                </div>
                <span className="operations-issue-total">{issueCount} lý do</span>
              </header>
              {issueCount ? (
                <>
                  {issues.tasks.length > 0 && (
                    <ul className="operations-task-list">
                      {issues.tasks.map((blocker, index) => (
                        <IssueRow
                          key={`${blocker.code}:${index}`}
                          blocker={blocker}
                          onAction={action}
                        />
                      ))}
                    </ul>
                  )}
                  {issues.connections.length > 0 && (
                    <div className="operations-connection-list">
                      <div className="operations-list-heading">
                        <h3>Kết nối shop</h3>
                        <span>{issues.connections.length} kết nối cần chú ý</span>
                      </div>
                      <div className="operations-connection-tally" aria-label="Shop cần xử lý theo tình trạng đã lưu">
                        {connectionIndicatorCounts(issues.connections).map(({ indicator, count }) => (
                          <span className={`operations-status ${indicator.tone}`} key={`${indicator.label}:${indicator.tone}`}>
                            <ConnectionStatusIcon indicator={indicator} />
                            <strong>{count}</strong> {indicator.label}
                          </span>
                        ))}
                      </div>
                      {issues.connections.map((group) => {
                        const indicator = connectionIndicator(group.issues);
                        return (
                          <div className="operations-connection-row" key={group.key}>
                            <details className={`operations-connection ${group.severity}`}>
                              <summary aria-label={`${group.name} · ${indicator.label} · ${group.issues.length} lý do · ${scopeLabel(group.scope)}`}>
                                <span className="operations-shop-mark" aria-hidden="true"><Store size={17} /></span>
                                <strong className="operations-shop-name">{group.name}</strong>
                                <span className={`operations-status ${indicator.tone}`}>
                                  <ConnectionStatusIcon indicator={indicator} />
                                  {indicator.label}
                                </span>
                                <span className="operations-disclosure">
                                  <span>{group.issues.length}</span>
                                  <ChevronDown size={15} aria-hidden="true" />
                                </span>
                              </summary>
                              <div className="operations-connection-detail">
                                <p className="caption">{scopeLabel(group.scope)}</p>
                                <ul className="operations-connection-reasons">
                                  {group.issues.map((blocker, index) => (
                                    <IssueRow key={`${blocker.code}:${index}`} blocker={blocker} onAction={action} expanded />
                                  ))}
                                </ul>
                              </div>
                            </details>
                            <button className="operations-connect-action" aria-label={`Mở kết nối: ${group.name} · ${scopeLabel(group.scope)}`} onClick={() => onConnect(group.connectionId, group.scope)}>
                              Mở <ArrowRight size={15} aria-hidden="true" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <div
                  className={`operations-clear${overview.status === 'degraded' ? ' partial' : ''}`}
                >
                  <>
                    {overview.status === 'degraded' ? (
                      <CircleHelp size={26} aria-hidden="true" />
                    ) : (
                      <CheckCircle2 size={26} aria-hidden="true" />
                    )}
                  </>
                  <h3>
                    {overview.status === 'degraded'
                      ? 'Chưa thấy vấn đề trong phần đã đọc'
                      : 'Chưa có vấn đề trong dữ liệu đã đọc'}
                  </h3>
                  <p>Trước mỗi lần gửi, ứng dụng vẫn kiểm tra đúng nguồn và shop của đợt đó.</p>
                </div>
              )}
            </section>
            <aside className="operations-side">
              <section className="operations-panel" aria-labelledby="operations-runtime">
                <header>
                  <h2 id="operations-runtime">
                    <Server size={17} aria-hidden="true" />
                    Tình trạng ứng dụng
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
                  <FolderOpen size={17} aria-hidden="true" />
                  <span>Mở bộ listing đã lưu</span>
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
                <button
                  className="operations-shortcut"
                  onClick={() => onNavigate('production', overview.scope ?? undefined)}
                >
                  <ListChecks size={17} aria-hidden="true" />
                  <span>Mở đợt đăng đang làm</span>
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
                <button className="operations-shortcut" onClick={() => onNavigate('shops')}>
                  <Store size={17} aria-hidden="true" />
                  <span>Quản lý kết nối shop</span>
                  <ArrowRight size={16} aria-hidden="true" />
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
      <span className="operations-metric-label">
        {icon}
        <span>{label}</span>
      </span>
      <strong>{value === undefined ? '—' : value.toLocaleString('vi-VN')}</strong>
      <small>{note}</small>
    </button>
  );
}
function scopeLabel(scope: OperationsScope) {
  return `Shop ${scope.shopId} · ${scope.environment === 'production' ? 'Shop thật' : 'Thử nghiệm'} · Đối tác ${scope.partnerId}`;
}
function IssueRow({
  blocker,
  onAction,
  expanded = false,
}: {
  expanded?: boolean;
  blocker: OperationsBlocker;
  onAction: (blocker: OperationsBlocker) => void;
}) {
  return (
    <li className={`operations-issue-row ${blocker.severity}`}>
      <span className={`operations-action-icon ${blocker.severity}`} aria-hidden="true">
        <TriangleAlert size={16} />
      </span>
      <div className="operations-issue-copy">
        <div className="operations-issue-title">
          <strong>{blocker.message}</strong>
          {blocker.count !== undefined && (
            <span className="operations-count">{blocker.count.toLocaleString('vi-VN')} mục</span>
          )}
        </div>
        {expanded && <p>{blocker.nextAction}</p>}
        <details className="operations-evidence">
          <summary>Chi tiết</summary>
          {!expanded && <p>{blocker.nextAction}</p>}
          <dl>
            {blocker.scope && <div><dt>Phạm vi</dt><dd>{scopeLabel(blocker.scope)}</dd></div>}
            <div>
              <dt>Mã</dt>
              <dd>
                <code>{blocker.code}</code>
              </dd>
            </div>
            <div>
              <dt>Nguồn</dt>
              <dd>{blocker.source}</dd>
            </div>
            {blocker.connectionId && (
              <div>
                <dt>Kết nối</dt>
                <dd>{blocker.connectionId}</dd>
              </div>
            )}
            <div>
              <dt>Đường xử lý</dt>
              <dd>
                <code>{blocker.route.apiPath}</code>
              </dd>
            </div>
          </dl>
        </details>
      </div>
      <button
        className="operations-issue-action"
        onClick={() => onAction(blocker)}
        aria-label={`${operationNextAction(blocker).label}: ${blocker.message}`}
      >
        {operationNextAction(blocker).label}
        <ArrowRight size={15} aria-hidden="true" />
      </button>
    </li>
  );
}
function Fact({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className={`operations-fact-dot ${good ? 'good' : ''}`} aria-hidden="true" />
        {value}
      </dd>
    </div>
  );
}
function OverviewLoading() {
  return (
    <div className="operations-loading" role="status">
      <span className="operations-loading-label">Đang đọc tình trạng hệ thống và công việc…</span>
      <div className="operations-loading-metrics" aria-hidden="true">
        {[0, 1, 2, 3].map((key) => (
          <span key={key} />
        ))}
      </div>
      <div className="operations-loading-body" aria-hidden="true">
        <div>
          <span />
          <span />
          <span />
        </div>
        <aside>
          <span />
          <span />
        </aside>
      </div>
    </div>
  );
}

function ConnectionStatusIcon({ indicator }: { indicator: ConnectionIndicator }) {
  const Icon = { clock: Clock3, key: KeyRound, help: CircleHelp, history: History, alert: TriangleAlert }[indicator.icon];
  return <Icon size={14} aria-hidden="true" />;
}
