import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Clock3, CircleHelp, LoaderCircle, Minus, AlertCircle } from 'lucide-react';
import type { ShopConnection } from '@shopee/domain';
import {
  connectionActionClient,
  executeConnectionActions,
  prepareConnectionActions,
  type ConnectionAction,
  type ConnectionActionRow,
} from './bulk-connection-actions.js';
import './bulk-connection-actions.css';
export type BulkConnectionActionsProps = {
  shops: ShopConnection[];
  initialAction?: ConnectionAction;
  onRefresh: () => void | Promise<void>;
  onConnectShop: (id: string | null) => void;
  onBusyChange?: (busy: boolean) => void;
};
const labels: Record<ConnectionActionRow['status'], string> = {
  ready: 'Đủ điều kiện',
  held: 'Giữ riêng',
  reading: 'Đang đọc',
  running: 'Đang gửi',
  success: 'Đã xác nhận',
  waiting: 'Chờ an toàn',
  failed: 'Chưa đạt',
  unknown: 'Chưa rõ kết quả',
  cancelled: 'Đã bỏ khỏi hàng chờ',
};
function name(shop: ShopConnection) {
  return shop.displayName || shop.officialName || shop.name || `Shop ${shop.scope.shopId}`;
}
function identity(shop: ShopConnection) {
  return JSON.stringify([shop.id, shop.scope.environment, shop.scope.partnerId, shop.scope.shopId]);
}
function signature(shops: ShopConnection[]) {
  return shops.map(identity).sort().join('|');
}
function snapshotLabel(row: ConnectionActionRow) {
  const saved = row.after ?? row.before;
  if (!saved) return 'Chưa đọc';
  const states: Record<string, string> = {
    connected: 'Đã lưu kết nối',
    token_expired: 'Token đã hết hạn',
    reauth_required: 'Cần cấp quyền lại',
    refresh_unknown: 'Gia hạn chưa rõ',
    disconnected: 'Chưa kết nối',
  };
  return `${states[saved.state] ?? 'Cần đối chiếu'} · phiên ${saved.connectionRevision}`;
}
function StatusIcon({ status }: { status: ConnectionActionRow['status'] }) {
  const Icon = status === 'success' || status === 'ready' ? Check :
    status === 'reading' || status === 'running' ? LoaderCircle :
    status === 'unknown' ? CircleHelp : status === 'waiting' ? Clock3 :
    status === 'cancelled' ? Minus : AlertCircle;
  return <Icon size={15} aria-hidden="true" className={status === 'reading' || status === 'running' ? 'bulk-connections__spin' : undefined} />;
}
function ResultTable({ rows, busy, onConnectShop }: {
  rows: ConnectionActionRow[]; busy: boolean; onConnectShop: BulkConnectionActionsProps['onConnectShop'];
}) {
  return <ul className="bulk-connections__results">{rows.map((row, index) =>
    <li key={identity(row.shop) + ':' + index}>
      <details className="bulk-connections__row">
        <summary>
          <strong>{name(row.shop)}</strong>
          <span className={'bulk-connections__status bulk-connections__status--' + row.status}><StatusIcon status={row.status} />{labels[row.status]}</span>
          <ChevronDown size={15} className="bulk-connections__chevron" aria-hidden="true" />
        </summary>
        <div className="bulk-connections__row-detail">
          <p>{row.message}</p>
          <small>Shop {row.shop.scope.shopId} · Partner {row.shop.scope.partnerId} · {row.shop.scope.environment === 'production' ? 'Shop thật' : 'Thử nghiệm'}</small>
          <small>{snapshotLabel(row)}{row.completedAt && ' · ' + new Date(row.completedAt).toLocaleString('vi-VN')}</small>
          {row.shop.scope.environment === 'production' && ['held', 'failed', 'unknown', 'waiting'].includes(row.status) &&
            <button type="button" disabled={busy} onClick={() => onConnectShop(row.shop.id)}>Mở kết nối</button>}
        </div>
      </details>
    </li>)}</ul>;
}
/** Mounted only by an explicit selection action. No live checks or refreshes occur on mount. */
export function BulkConnectionActions({
  shops,
  initialAction = 'check',
  onRefresh,
  onConnectShop,
  onBusyChange,
}: BulkConnectionActionsProps) {
  const [rows, setRows] = useState<ConnectionActionRow[]>([]);
  const [reviewedEligibleCount, setReviewedEligibleCount] = useState(0);
  const [reviewedAction, setReviewedAction] = useState<ConnectionAction>(initialAction);
  const [history, setHistory] = useState<ConnectionActionRow[][]>([]);
  const [busy, setBusy] = useState<'review' | 'run' | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const [message, setMessage] = useState('');
  const [cancelRequested, setCancelRequested] = useState(false);
  const mounted = useRef(true);
  const lock = useRef(false);
  const stop = useRef(false);
  const uncertainRefreshes = useRef(new Set<string>());
  const callbacks = useRef({ onRefresh, onBusyChange });
  callbacks.current = { onRefresh, onBusyChange };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current = true;
      callbacks.current.onBusyChange?.(false);
    };
  }, []);
  useEffect(() => {
    if (busy !== 'run') return;
    const preventExit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventExit);
    return () => window.removeEventListener('beforeunload', preventExit);
  }, [busy]);
  function start(kind: 'review' | 'run') {
    if (lock.current) return false;
    lock.current = true;
    stop.current = false;
    setCancelRequested(false);
    setBusy(kind);
    callbacks.current.onBusyChange?.(true);
    return true;
  }
  function finish() {
    lock.current = false;
    if (mounted.current) {
      setBusy(null);
      callbacks.current.onBusyChange?.(false);
    }
  }
  async function review() {
    if (!shops.length || !start('review')) return;
    setHasRun(false);
    const selected = structuredClone(shops);
    setMessage(
      'Đang đọc trạng thái đã lưu của các shop đã chọn; bước này chưa kiểm tra trực tiếp với Shopee.',
    );
    try {
      const next = await prepareConnectionActions(selected, initialAction);
      if (!mounted.current) return;
      for (const row of next) {
        if (initialAction === 'refresh' && uncertainRefreshes.current.has(identity(row.shop))) {
          row.status = 'held';
          row.message =
            'Nhóm trước có lần gia hạn chưa rõ kết quả. Mở kết nối để đối chiếu bằng chứng; chưa gửi lại từ nhóm này.';
        }
      }
      if (rows.length) setHistory((previous) => [...previous, rows]);
      setRows(next);
      setReviewedEligibleCount(next.filter((row) => row.status === 'ready').length);
      setReviewedAction(initialAction);
      setMessage(
        'Đã rà soát dữ liệu đã lưu. Kiểm tra danh sách và lý do từng shop trước khi bấm thực hiện.',
      );
    } catch {
      if (mounted.current) setMessage('Chưa hoàn tất rà soát. Chưa gửi thao tác kết nối.');
    } finally {
      finish();
    }
  }
  async function run() {
    if (!rows.some((row) => row.status === 'ready') || !start('run')) return;
    setHasRun(true);
    setMessage('Đang xử lý phạm vi đã rà soát. Mỗi shop có một kết quả riêng.');
    try {
      const result = await executeConnectionActions(rows, reviewedAction, connectionActionClient, {
        shouldStop: () => stop.current,
        onRow: (row, index) => {
          if (row.action === 'refresh' && row.status === 'unknown')
            uncertainRefreshes.current.add(identity(row.shop));
          if (mounted.current)
            setRows((current) => current.map((item, i) => (i === index ? row : item)));
        },
      });
      if (mounted.current) {
        setRows(result);
        setMessage(
          'Đã kết thúc nhóm thao tác. Các shop giữ riêng, chờ hoặc chưa rõ kết quả không được tự thử lại.',
        );
      }
      try {
        await callbacks.current.onRefresh();
      } catch {
        if (mounted.current)
          setMessage(
            'Đã kết thúc nhóm, nhưng chưa tải lại được danh sách shop. Kết quả từng shop vẫn được giữ bên dưới.',
          );
      }
    } finally {
      finish();
    }
  }
  const ready = rows.filter((row) => row.status === 'ready').length;
  const changedSelection =
    rows.length > 0 &&
    (signature(shops) !== signature(rows.map((row) => row.shop)) ||
      initialAction !== reviewedAction);
  const selectedAction =
    initialAction === 'check' ? 'Kiểm tra trực tiếp với Shopee' : 'Gia hạn kết nối';
  const reviewedActionLabel = reviewedAction === 'check' ? 'Kiểm tra' : 'Gia hạn';
  const finished = hasRun && !busy;
  const completed = rows.filter(row => !['ready', 'reading', 'running'].includes(row.status)).length;
  const attention = rows.filter(row => ['held', 'failed', 'unknown', 'waiting'].includes(row.status));
  const statusCounts = (Object.keys(labels) as ConnectionActionRow['status'][])
    .map(status => ({ status, count: rows.filter(row => row.status === status).length })).filter(row => row.count);
  return <section className="bulk-connections" aria-label="Thao tác kết nối đã chọn">
    <div className="bulk-connections__heading">
      <h3>{selectedAction}{finished && <span className="bulk-connections__finished"> · Hoàn tất</span>}</h3>
      <button type="button" disabled={!!busy || !shops.length} onClick={() => void review()}>Xem trước {shops.length} shop</button>
    </div>
    <ol className="bulk-connections__steps" aria-label="Các bước thao tác nhóm">
      {['Xem trước', 'Thực hiện', 'Kết quả'].map((step,index) => {
        const current = finished ? 2 : rows.length ? 1 : 0;
        return <li key={step} aria-current={index === current ? 'step' : undefined} className={index < current ? 'is-done' : undefined}>
          <span>{index < current ? <Check size={12} aria-hidden="true" /> : index+1}</span>{step}
        </li>;
      })}
    </ol>
    {!rows.length && <p className="bulk-connections__hint">Xem trước danh sách rồi chọn {initialAction === 'check' ? 'Kiểm tra' : 'Gia hạn'} để thực hiện.</p>}
    {!rows.length && <details className="bulk-connections__disclosure"><summary>Xem {shops.length} shop đã chọn</summary>
      <ul className="bulk-connections__selection">{shops.map((shop, index) => <li key={identity(shop) + ':' + index}>
        <strong>{name(shop)}</strong><span>Shop {shop.scope.shopId} · Partner {shop.scope.partnerId} · {shop.scope.environment === 'production' ? 'Shop thật' : 'Thử nghiệm'}</span>
      </li>)}</ul>
    </details>}
    {rows.length > 0 && <>
      <div className="bulk-connections__totals" aria-label="Tóm tắt kết quả nhóm">{statusCounts.map(({status, count}) =>
        <span key={status} className={'bulk-connections__total bulk-connections__status--' + status}>
          <StatusIcon status={status} /><strong>{count}</strong>{labels[status]}
        </span>)}</div>
      {busy === 'run' && <progress className="bulk-connections__progress" value={completed} max={rows.length} aria-label="Tiến độ thao tác nhóm" />}
      {!finished && <>
        <div className="bulk-connections__controls">
          <span>{rows.length} shop · {reviewedEligibleCount} đủ điều kiện</span>
          <button type="button" className="primary" disabled={!!busy || !ready || changedSelection} onClick={() => void run()}>
            {reviewedActionLabel} {reviewedEligibleCount} shop
          </button>
        </div>
        <div className="bulk-connections__cancel">{busy === 'run' && <button type="button" disabled={cancelRequested} onClick={() => {
          stop.current = true; setCancelRequested(true);
          setMessage('Đã yêu cầu bỏ các shop chưa gửi khỏi hàng chờ. Các yêu cầu đang gửi tiếp tục chờ kết quả; chưa bị hủy trên máy chủ.');
        }}>Bỏ các shop chưa gửi</button>}</div>
      </>}
      {changedSelection && <p className="bulk-connections__notice">Lựa chọn đã đổi. Xem trước lại để tiếp tục.</p>}
      {finished && attention.length > 0 && <div className="bulk-connections__attention"><strong>Cần xử lý · {attention.length}</strong>
        <ResultTable rows={attention} busy={!!busy} onConnectShop={onConnectShop} />
      </div>}
      <details className="bulk-connections__disclosure" open={!finished}>
        <summary>{finished ? 'Xem toàn bộ kết quả' : 'Danh sách rà soát'} · {rows.length} shop</summary>
        <ResultTable rows={rows} busy={!!busy} onConnectShop={onConnectShop} />
      </details>
    </>}
    <span className="bulk-connections__announcement" role="status" aria-live="polite">{busy === 'run' ? `Đang xử lý ${completed}/${rows.length} shop` : finished ? `Hoàn tất nhóm ${rows.length} shop. ${attention.length} cần xử lý.` : busy === 'review' ? 'Đang rà soát shop' : ''}</span>
    <details className="bulk-connections__help"><summary>Thông tin phiên</summary>
      {message && <p>{message}</p>}
      <p>Chạy tối đa 2 shop cùng lúc. Kết quả chưa rõ không được tự gửi lại. Bảng nhóm giữ trong tab này; tải lại trang sẽ mất bảng nhóm. Bằng chứng gia hạn từng shop được máy chủ lưu.</p>
      <p>Việc đăng và sao chép sản phẩm vẫn tạm dừng.</p>
    </details>
    {history.length > 0 && <details className="bulk-connections__disclosure"><summary>Nhóm trước · {history.length}</summary>
      {history.map((previous,index) => <div className="bulk-connections__history" key={index}>
        <strong>Nhóm {index+1} · {previous[0]?.action === 'refresh' ? 'Gia hạn' : 'Kiểm tra'}</strong>
        <ResultTable rows={previous} busy={!!busy} onConnectShop={onConnectShop} />
      </div>)}
    </details>}
  </section>;
}
