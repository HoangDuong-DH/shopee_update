import { useEffect, useRef, useState } from 'react';
import { api, date, post, RequestError } from './api.js';
import './sandbox-tryout.css';

type Context = {
  available: boolean;
  reason?: string;
  connectionRevision: number;
  trialItemId: string;
  itemId: string;
  shopName: string;
  scope: { environment: string; partnerId: string; shopId: string };
  fields: string[];
  legacyRecovery?: {
    id: string;
    runId: string;
    verifiedAt: string;
    basis: 'historical_projection_and_fresh_raw_stability';
  };
};
type Snapshot = { item: Record<string, any>; models: { model: Record<string, any>[] } };
type Inspection = {
  observedAt: string;
  snapshot: { kind: string; data?: Snapshot };
};
type Operation =
  | { kind: 'title'; value: string }
  | {
      kind: 'stock';
      value: { model_id: 0; seller_stock: { stock: number; location_id?: string }[] }[];
    };
type Run = {
  id: string;
  trialItemId: string;
  itemId: string;
  connectionRevision: number;
  fingerprint: string;
  state: 'prepared' | 'unknown' | 'verified' | 'blocked';
  createdAt: string;
  updatedAt: string;
  baseline: Snapshot;
  operation: Operation;
  result?: {
    code?: string;
    acknowledgement?: { requestId?: string };
    check?: {
      verified: boolean;
      selectedMatch: boolean;
      unchanged: boolean;
      mismatchedPaths?: string[];
    };
    readback?: { kind: string; data?: Snapshot; requestId?: string };
  };
};
type Receipt = {
  id: string;
  trialItemId: string;
  itemId: string;
  phase: 'preparing' | 'prepared' | 'sent' | 'cancelling';
  prepare?: {
    id: string;
    trialItemId: string;
    connectionRevision: number;
    operation: Operation;
  };
};
const storageKey = 'shopee.sandbox-tryout.receipt.v1';
const fieldNames = { title: 'Tiêu đề', stock: 'Tồn đăng bán' };
// These service errors are raised before its durable write claim. Other failures
// retain the sent receipt even when a subsequent read still reports prepared.
const beforeWriteErrors = new Set([
  'FIELD_PREPARATION_EXPIRED',
  'FIELD_CONNECTION_CHANGED',
  'FIELD_AUTH_REQUIRED',
  'FIELD_REMOTE_TARGET_CHANGED',
  'FIELD_MODEL_BINDING_CHANGED',
  'FIELD_SHOP_BUSY',
]);
const messages: Record<string, string> = {
  FIELD_SHOP_BUSY:
    'Shop TEST còn một lần ghi đang chạy hoặc chưa rõ kết quả. Giữ bản xem trước và đối chiếu lần đó trước.',
  FIELD_BASELINE_CHANGED:
    'Dữ liệu trên shop đã thay đổi. Đọc lại sản phẩm trước khi chuẩn bị một lần thử mới.',
  FIELD_REMOTE_TARGET_CHANGED: 'Mẫu trên Shopee không còn khớp hồ sơ thử. Chưa thể gửi thay đổi.',
  FIELD_MODEL_BINDING_CHANGED:
    'Phân loại đã khác hồ sơ được xác nhận. Cần đối chiếu trước khi thử.',
  FIELD_CONNECTION_CHANGED:
    'Kết nối TEST đã có phiên bản mới. Đọc lại thông tin trước khi chuẩn bị.',
  FIELD_AUTH_REQUIRED: 'Kết nối TEST cần được cập nhật trong Kết nối shop.',
  FIELD_PREPARATION_EXPIRED:
    'Bản xem trước đã hết thời hạn. Đọc sản phẩm hiện tại và chuẩn bị lại.',
  FIELD_LIMIT_UNVERIFIED:
    'Giá trị nhập chưa khớp giới hạn đang đọc được từ Shopee. Giữ nguồn và kiểm tra lại.',
  FIELD_NOT_FOUND:
    'Chưa tìm thấy biên nhận. Giữ mã lần thử và đọc lại; không gửi một lệnh khác để thay thế.',
};
function errorText(error: unknown) {
  return error instanceof RequestError
    ? (messages[error.code] ?? error.message)
    : error instanceof Error
      ? error.message
      : 'Chưa đọc được kết quả.';
}
function stockRow(snapshot?: Snapshot) {
  const rows = snapshot?.item.stock_info_v2?.seller_stock;
  return snapshot?.item.has_model === false &&
    Array.isArray(rows) &&
    rows.length === 1 &&
    Number.isSafeInteger(rows[0]?.stock)
    ? (rows[0] as { stock: number; location_id?: string })
    : null;
}
function operationValue(operation: Operation) {
  return operation.kind === 'title'
    ? operation.value
    : String(operation.value[0]?.seller_stock[0]?.stock ?? 'Chưa xác minh');
}
function beforeValue(run: Run) {
  return run.operation.kind === 'title'
    ? String(run.baseline.item.item_name ?? '')
    : String(stockRow(run.baseline)?.stock ?? 'Chưa xác minh');
}

export function SandboxTryout() {
  const [context, setContext] = useState<Context | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [field, setField] = useState<'title' | 'stock'>('title');
  const [value, setValue] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const allowed = context?.scope.environment === 'sandbox' && context.available;
  const snapshot = inspection?.snapshot.kind === 'success' ? inspection.snapshot.data : undefined;
  const quantity = stockRow(snapshot);
  const pending =
    uncertain ||
    receipt?.phase === 'preparing' ||
    receipt?.phase === 'cancelling' ||
    run?.state === 'unknown';
  const sourceValid =
    field === 'title'
      ? /^SANDBOX QA(?:\s|$)/.test(value) && value.trim().length > 10
      : /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) && !!quantity;
  const changed =
    field === 'title'
      ? value !== snapshot?.item.item_name
      : quantity && Number(value) !== quantity.stock;

  function storeReceipt(next: Receipt) {
    // Persist before mutation so a reload cannot turn an uncertain request into a new command.
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      throw new Error(
        'Trình duyệt chưa lưu được mã lần thử. Cho phép lưu dữ liệu trình duyệt trước khi gửi.',
      );
    }
    setReceipt(next);
  }
  function accept(next: Run, expected: Receipt, ctx: Context) {
    if (
      next.id !== expected.id ||
      next.itemId !== ctx.itemId ||
      next.trialItemId !== ctx.trialItemId ||
      next.itemId !== expected.itemId ||
      next.trialItemId !== expected.trialItemId
    )
      throw new Error(
        'Biên nhận không thuộc đúng mẫu TEST đang mở. Giữ nguyên lựa chọn để đối chiếu.',
      );
    setRun(next);
    const isUncertain =
      ['sent', 'cancelling'].includes(expected.phase) && next.state === 'prepared';
    setUncertain(isUncertain);
    if (!isUncertain)
      storeReceipt({ ...expected, phase: next.state === 'prepared' ? 'prepared' : 'sent' });
  }
  async function perform(label: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy('');
    }
  }
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void api<Context>('/v1/sandbox-tryout/context')
      .then(async (ctx) => {
        if (!active) return;
        setContext(ctx);
        let saved: Receipt | null = null;
        try {
          saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        } catch {
          setError('Không đọc được mã lần thử trong trình duyệt. Cần đối chiếu trước khi gửi.');
          setUncertain(true);
          return;
        }
        if (!saved) return;
        if (
          !/^[a-f0-9-]{36}$/i.test(saved.id) ||
          saved.itemId !== ctx.itemId ||
          saved.trialItemId !== ctx.trialItemId
        ) {
          setError('Có biên nhận chưa đối chiếu của mẫu TEST khác. Chưa mở lần gửi mới.');
          setUncertain(true);
          return;
        }
        setReceipt(saved);
        setUncertain(saved.phase !== 'prepared');
        const result = await api<Run>('/v1/sandbox-field-trials/' + encodeURIComponent(saved.id));
        if (active) accept(result, saved, ctx);
      })
      .catch((cause) => {
        if (active) setError(errorText(cause));
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);

  async function readProduct() {
    await perform('Đang đọc sản phẩm TEST…', async () => {
      const ctx = await api<Context>('/v1/sandbox-tryout/context');
      setContext(ctx);
      if (ctx.scope.environment !== 'sandbox' || !ctx.trialItemId || !ctx.itemId)
        throw new Error('Chưa có mẫu TEST được xác nhận.');
      const result = await post<Inspection>('/v1/sandbox-field-trials/inspect', {
        trialItemId: ctx.trialItemId,
        connectionRevision: ctx.connectionRevision,
      });
      if (
        result.snapshot.kind !== 'success' ||
        !result.snapshot.data ||
        String(result.snapshot.data.item.item_id) !== ctx.itemId ||
        result.snapshot.data.item.has_model !== false ||
        result.snapshot.data.item.item_status !== 'UNLIST'
      )
        throw new Error('Chưa đọc được đúng mẫu không phân loại. Chưa thể chuẩn bị lệnh thử.');
      setInspection(result);
      setValue('');
      setConfirmed(false);
      if (!ctx.fields.includes(field)) setField(ctx.fields.includes('title') ? 'title' : 'stock');
    });
  }
  async function prepare() {
    if (!context || !allowed || !sourceValid || !changed || !snapshot || pending) return;
    await perform('Đang kiểm tra bản thay đổi…', async () => {
      const operation: Operation =
        field === 'title'
          ? { kind: 'title', value }
          : {
              kind: 'stock',
              value: [
                {
                  model_id: 0,
                  seller_stock: [
                    {
                      stock: Number(value),
                      ...(quantity?.location_id ? { location_id: quantity.location_id } : {}),
                    },
                  ],
                },
              ],
            };
      const next: Receipt = {
        id: crypto.randomUUID(),
        trialItemId: context.trialItemId,
        itemId: context.itemId,
        phase: 'preparing',
      };
      next.prepare = {
        id: next.id,
        trialItemId: next.trialItemId,
        connectionRevision: context.connectionRevision,
        operation,
      };
      storeReceipt(next);
      setUncertain(true);
      try {
        const result = await post<Run>('/v1/sandbox-field-trials/prepare', next.prepare);
        accept(result, next, context);
        setConfirmed(false);
      } catch (cause) {
        if (
          cause instanceof RequestError &&
          cause.status &&
          cause.status >= 400 &&
          cause.status < 500
        ) {
          localStorage.removeItem(storageKey);
          setReceipt(null);
          setUncertain(false);
        }
        throw cause;
      }
    });
  }
  async function restorePreview() {
    if (
      !context ||
      context.scope.environment !== 'sandbox' ||
      receipt?.phase !== 'preparing' ||
      !receipt.prepare
    )
      return;
    const saved = receipt;
    if (saved.prepare!.id !== saved.id || saved.prepare!.trialItemId !== saved.trialItemId) return;
    await perform('Đang khôi phục đúng bản xem trước…', async () => {
      // Prepare never writes to Shopee; the exact persisted request and ID are
      // repeated only on this explicit click, including after a pre-insert loss.
      accept(await post<Run>('/v1/sandbox-field-trials/prepare', saved.prepare), saved, context);
      setConfirmed(false);
    });
  }
  async function cancelPreview() {
    if (
      !context ||
      !run ||
      run.state !== 'prepared' ||
      !receipt ||
      (receipt.phase !== 'cancelling' && (receipt.phase !== 'prepared' || uncertain))
    )
      return;
    await perform('Đang bỏ bản xem trước chưa gửi…', async () => {
      const saved: Receipt = { ...receipt, phase: 'cancelling' };
      storeReceipt(saved);
      setUncertain(true);
      setConfirmed(false);
      accept(
        await post<Run>('/v1/sandbox-field-trials/' + encodeURIComponent(run.id) + '/cancel', {
          fingerprint: run.fingerprint,
        }),
        saved,
        context,
      );
    });
  }
  async function execute() {
    if (
      !context ||
      !allowed ||
      !run ||
      run.state !== 'prepared' ||
      !receipt ||
      pending ||
      !confirmed
    )
      return;
    await perform('Đang gửi một thay đổi lên sandbox và đọc lại…', async () => {
      const next: Receipt = { ...receipt, phase: 'sent' };
      storeReceipt(next);
      setUncertain(true);
      setConfirmed(false);
      try {
        accept(
          await post<Run>('/v1/sandbox-field-trials/execute', {
            id: run.id,
            fingerprint: run.fingerprint,
          }),
          next,
          context,
        );
      } catch (cause) {
        if (
          cause instanceof RequestError &&
          cause.status &&
          cause.status >= 400 &&
          cause.status < 500 &&
          beforeWriteErrors.has(cause.code)
        ) {
          const saved = await api<Run>('/v1/sandbox-field-trials/' + encodeURIComponent(run.id));
          accept(saved, { ...next, phase: 'prepared' }, context);
        }
        throw cause;
      }
    });
  }
  async function readReceipt() {
    if (!receipt || !context) return;
    await perform('Đang đọc biên nhận đã lưu…', async () => {
      const result = await api<Run>('/v1/sandbox-field-trials/' + encodeURIComponent(receipt.id));
      accept(result, receipt, context);
      const ctx = await api<Context>('/v1/sandbox-tryout/context');
      setContext(ctx);
    });
  }
  function startNew() {
    if (busy || pending || !run || !['verified', 'blocked'].includes(run.state)) return;
    localStorage.removeItem(storageKey);
    setReceipt(null);
    setRun(null);
    setInspection(null);
    setValue('');
    setConfirmed(false);
    setError('');
  }
  const check = run?.result?.check;
  return (
    <div className="sandbox-tryout">
      <header className="tryout-heading">
        <p className="eyebrow">NGHIỆM THU BẰNG MẪU KỸ THUẬT</p>
        <h1>Thử trên shop TEST</h1>
        <p>Đọc sản phẩm, xem phần sẽ đổi, rồi tự bấm gửi lên Shopee sandbox.</p>
      </header>
      <div className="tryout-notice">
        <strong>Gửi API sandbox thật khi bạn bấm thực hiện</strong>
        <p>
          Mẫu kỹ thuật đang ẩn dùng để kiểm tra ứng dụng. Bộ listing, Word, ảnh và bảng giá doanh
          nghiệp của bạn được giữ nguyên.
        </p>
      </div>
      {context && (
        <div className="tryout-target">
          <strong>{context.shopName}</strong>
          <span>
            TEST · Shop {context.scope.shopId} · Sản phẩm {context.itemId}
          </span>
        </div>
      )}
      {context?.legacyRecovery && (
        <div className="tryout-notice" role="status">
          <strong>Lần gửi Lamy cũ đã được đối chiếu trạng thái hiện tại.</strong>
          <p>
            {allowed ? 'Khóa thử nghiệm đã được giải phóng. ' : ''}Lịch sử lần gửi vẫn được giữ
            nguyên.
          </p>
        </div>
      )}
      {context && !allowed && (
        <div className="tryout-alert" role="status">
          <strong>Chưa thể gửi thay đổi</strong>
          <p>
            {context.reason ??
              'Shop TEST chưa đủ điều kiện thực thi. Bạn vẫn có thể đọc và đối chiếu.'}
          </p>
          <button
            disabled={!!busy}
            onClick={() =>
              void perform('Đang kiểm tra điều kiện…', async () => {
                const ctx = await api<Context>('/v1/sandbox-tryout/context');
                setContext(ctx);
              })
            }
          >
            Kiểm tra lại điều kiện
          </button>
        </div>
      )}
      {error && (
        <p className="tryout-alert" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">{busy}</p>}
      <ol className="tryout-steps" aria-label="Các bước thử">
        <li aria-current={!run ? 'step' : undefined}>1. Đọc & chọn thay đổi</li>
        <li aria-current={run?.state === 'prepared' ? 'step' : undefined}>2. Xem trước & gửi</li>
        <li aria-current={run && run.state !== 'prepared' ? 'step' : undefined}>
          3. Đối chiếu kết quả
        </li>
      </ol>
      {!run && (
        <section className="tryout-panel">
          <h2>1. Đọc sản phẩm TEST</h2>
          <p>Ứng dụng chỉ chọn mẫu đã có hồ sơ thử. Không cần nhập mã shop hoặc mã sản phẩm.</p>
          <button
            disabled={!context || !!busy || !!receipt || uncertain}
            onClick={() => void readProduct()}
          >
            Đọc sản phẩm TEST
          </button>
          {snapshot && (
            <>
              <div className="tryout-current">
                <strong>{String(snapshot.item.item_name)}</strong>
                <span>
                  Đang ẩn (UNLIST) · Không phân loại · Đọc lúc {date(inspection!.observedAt)}
                </span>
              </div>
              <fieldset className="tryout-field">
                <legend>Chỉ chọn một phần muốn thử</legend>
                {(['title', 'stock'] as const)
                  .filter((f) => context?.fields.includes(f))
                  .map((f) => (
                    <label key={f}>
                      <input
                        type="radio"
                        name="tryout-field"
                        checked={field === f}
                        disabled={!!busy || pending}
                        onChange={() => {
                          setField(f);
                          setValue('');
                        }}
                      />
                      {fieldNames[f]}
                    </label>
                  ))}
              </fieldset>
              <label className="tryout-input" htmlFor="tryout-value">
                {field === 'title' ? 'Tiêu đề mới cho mẫu TEST' : 'Tồn đăng bán mới cho mẫu TEST'}
                <input
                  id="tryout-value"
                  type="text"
                  inputMode={field === 'stock' ? 'numeric' : 'text'}
                  value={value}
                  disabled={!!busy || pending}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={field === 'title' ? 'SANDBOX QA …' : 'Nhập số; 0 là hết hàng'}
                  aria-describedby="tryout-input-help"
                />
              </label>
              <p id="tryout-input-help" className="tryout-help">
                {field === 'title'
                  ? 'Giữ tiền tố SANDBOX QA để phân biệt với hàng thật. Tiêu đề được gửi đúng như bạn nhập.'
                  : quantity
                    ? `Đang có ${quantity.stock} · Vị trí kho ${quantity.location_id ?? 'mặc định đã đọc'}. Ô trống không tạo lệnh; nhập 0 là đặt tồn về 0.`
                    : 'Chưa xác định được một vị trí tồn. Cần đối chiếu; không tự chọn kho.'}
              </p>
              <button
                className="primary"
                disabled={!allowed || !!busy || !!receipt || !sourceValid || !changed || pending}
                onClick={() => void prepare()}
              >
                Xem trước thay đổi
              </button>
            </>
          )}
        </section>
      )}
      {receipt && !busy && (uncertain || !run) && (
        <section className="tryout-alert" role="status">
          <strong>Chưa xác nhận được kết quả lần vừa yêu cầu</strong>
          <p>Giữ mã lần thử và đọc biên nhận. Ứng dụng không tự gửi lại.</p>
          <button disabled={!!busy} onClick={() => void readReceipt()}>
            Đọc lại kết quả
          </button>
          {receipt.phase === 'preparing' && receipt.prepare && (
            <>
              <p>
                Khôi phục đúng nội dung đã lưu với cùng mã lần thử. Bước này chưa gửi thay đổi lên
                Shopee.
              </p>
              <button disabled={!!busy} onClick={() => void restorePreview()}>
                Khôi phục bản xem trước
              </button>
            </>
          )}
          {receipt.phase === 'cancelling' && run?.state === 'prepared' && (
            <button disabled={!!busy} onClick={() => void cancelPreview()}>
              Hoàn tất bỏ bản xem trước
            </button>
          )}
          <small>Mã lần thử: {receipt.id}</small>
        </section>
      )}
      {run && (
        <section className="tryout-panel">
          <h2>{run.state === 'prepared' ? '2. Xem trước thay đổi' : '3. Kết quả đối chiếu'}</h2>
          <p>
            {fieldNames[run.operation.kind]} · Sản phẩm {run.itemId}
          </p>
          <div className="tryout-diff">
            <div>
              <span>Trước khi gửi</span>
              <p>{beforeValue(run)}</p>
            </div>
            <div>
              <span>Giá trị đã yêu cầu</span>
              <p>{operationValue(run.operation)}</p>
            </div>
          </div>
          <p className="tryout-help">
            Giữ nguyên ảnh bìa, gallery, mô tả, ngành hàng, vận chuyển và các giá trị ngoài phần đã
            chọn.
          </p>
          {run.state === 'prepared' && !uncertain && (
            <>
              <label className="tryout-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={!!busy || !allowed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                Tôi đã xem đúng mẫu TEST và phần sẽ thay đổi.
              </label>
              <button
                className="primary"
                disabled={!!busy || !allowed || !confirmed}
                onClick={() => void execute()}
              >
                Gửi thay đổi lên sandbox
              </button>
              <button disabled={!!busy} onClick={() => void cancelPreview()}>
                Bỏ bản xem trước
              </button>
              <p className="tryout-help">
                Bỏ bản xem trước chỉ đóng bản nháp tại ứng dụng, không thay đổi sản phẩm trên
                Shopee.
              </p>
            </>
          )}
          {run.state !== 'prepared' && (
            <>
              <div
                className={`tryout-outcome ${run.state === 'verified' && check?.verified ? 'is-verified' : ''}`}
                role="status"
              >
                <strong>
                  {run.state === 'verified' && check?.verified
                    ? 'Đã đọc lại và đối chiếu'
                    : run.state === 'blocked'
                      ? run.result?.code === 'DRAFT_CANCELLED'
                        ? 'Đã bỏ bản xem trước'
                        : 'Đã chặn trước khi gửi tiếp'
                      : 'Chưa xác định xong kết quả'}
                </strong>
                <p>
                  {run.state === 'unknown'
                    ? 'Không gửi lại lệnh này. Cần người phụ trách đối chiếu trước khi tiếp tục.'
                    : 'Kết luận bên dưới lấy từ biên nhận backend đã lưu.'}
                </p>
              </div>
              <dl className="tryout-checks">
                <div>
                  <dt>Phần đã chọn</dt>
                  <dd>
                    {check?.selectedMatch === true
                      ? 'Đã khớp yêu cầu'
                      : check?.selectedMatch === false
                        ? 'Chưa khớp'
                        : 'Chưa xác minh'}
                  </dd>
                </div>
                <div>
                  <dt>Phần được giữ nguyên</dt>
                  <dd>
                    {check?.unchanged === true
                      ? 'Đã đối chiếu giữ nguyên'
                      : check?.unchanged === false
                        ? 'Phát hiện khác biệt'
                        : 'Chưa xác minh'}
                  </dd>
                </div>
              </dl>
              <button disabled={!!busy} onClick={() => void readReceipt()}>
                Đọc lại kết quả
              </button>
              {['verified', 'blocked'].includes(run.state) && (
                <button disabled={!!busy || pending} onClick={startNew}>
                  Chuẩn bị lần thử mới
                </button>
              )}
            </>
          )}
          <details className="tryout-receipt">
            <summary>Thông tin lần thử đã lưu</summary>
            <p>Mã lần thử: {run.id}</p>
            <p>Đọc biên nhận: {date(run.updatedAt)}</p>
            <p>Kết quả: {run.result?.code ?? run.state}</p>
            {run.result?.acknowledgement?.requestId && (
              <p>Mã yêu cầu Shopee: {run.result.acknowledgement.requestId}</p>
            )}
            {run.result?.check?.mismatchedPaths?.length ? (
              <p>Phần cần đối chiếu: {run.result.check.mismatchedPaths.join(', ')}</p>
            ) : null}
          </details>
        </section>
      )}
    </div>
  );
}
