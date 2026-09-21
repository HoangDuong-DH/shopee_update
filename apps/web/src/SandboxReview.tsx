import { useEffect, useRef, useState } from 'react';
import type {
  SandboxField,
  SandboxPrepareInput,
  SandboxReadResult,
  SandboxRun,
  SandboxSnapshot,
  WorkOrderView,
} from '@shopee/domain';
import { api, date, media, post, RequestError } from './api.js';

const fieldNames = { title: 'Tiêu đề', description: 'Nội dung mô tả', gallery: 'Ảnh sản phẩm' };
const runLabels: Record<SandboxRun['state'], string> = {
  prepared: 'Đã lưu bản thay đổi để xem trước',
  in_flight: 'Đã gửi yêu cầu, đang chờ đối chiếu',
  unknown: 'Chưa xác định kết quả ghi',
  verified: 'Đã đọc lại và đối chiếu',
  rejected: 'Yêu cầu bị từ chối',
  drift: 'Dữ liệu đã thay đổi, cần đối chiếu lại',
};
export function SandboxReview({
  order,
  blocked,
  onBusy,
  onRunChange,
  onRecoveryNeeded,
}: {
  order: WorkOrderView;
  blocked: boolean;
  onBusy: (busy: boolean) => void;
  onRunChange?: (run: SandboxRun) => void;
  onRecoveryNeeded?: () => void;
}) {
  const [read, setRead] = useState<SandboxReadResult | null>(null);
  const [run, setRun] = useState<SandboxRun | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [prepareUncertain, setPrepareUncertain] = useState(false);
  const [recoverId, setRecoverId] = useState<string | null>(null);
  const lock = useRef(false);
  const recoveryGeneration = useRef(0);
  const prepareBody = useRef<SandboxPrepareInput | null>(null);
  const storageKey = `sandbox-work-order:${order.id}:${order.revision}`;
  const scope = {
    connectionId: order.config.connectionId!,
    itemId: order.config.itemId!,
    productKey: order.config.productKey,
    sourceRevision: order.config.sourceRevision,
  };
  const sandbox = order.shop?.scope.environment === 'sandbox';
  const canRead =
    sandbox &&
    order.shop?.state === 'connected' &&
    order.config.operation === 'update' &&
    !!order.config.itemId;
  const supported =
    order.config.fieldMask.length > 0 &&
    order.config.fieldMask.every((field) => ['title', 'description', 'gallery'].includes(field));
  const matchesScope = (value: SandboxRun) =>
    value.workOrderId === order.id &&
    value.workOrderRevision === order.revision &&
    value.connectionId === scope.connectionId &&
    value.itemId === scope.itemId &&
    value.productKey === scope.productKey &&
    value.sourceRevision === scope.sourceRevision &&
    value.fieldMask.length === order.config.fieldMask.length &&
    value.fieldMask.every((field) => order.config.fieldMask.includes(field));
  const matchesTarget = (value: SandboxRun) =>
    value.connectionId === scope.connectionId && value.itemId === scope.itemId;
  function remember(value: SandboxRun) {
    if (!matchesTarget(value))
      throw new Error(
        'Bản thay đổi không thuộc đúng công việc đang mở. Giữ nguyên lựa chọn và kiểm tra lại.',
      );
    setRun(value);
    setUncertain(false);
    onRunChange?.(value);
    setRecoverId(value.id);
    try {
      localStorage.setItem(storageKey, value.id);
    } catch {
      /* Server remains the record of execution. */
    }
  }
  useEffect(() => {
    let active = true;
    const generation = recoveryGeneration.current;
    let id: string | null = order.sandboxRun?.id ?? null;
    if (order.sandboxRun && matchesTarget(order.sandboxRun)) {
      setRun(order.sandboxRun);
      onRunChange?.(order.sandboxRun);
    }
    try {
      id ??= localStorage.getItem(storageKey);
    } catch {
      /* Storage may be unavailable. */
    }
    if (id) {
      setRecoverId(id);
      void api<SandboxRun>('/v1/sandbox-listings/runs/' + encodeURIComponent(id))
        .then((value) => {
          if (active && generation === recoveryGeneration.current && matchesTarget(value)) {
            setRun(value);
            onRunChange?.(value);
          }
        })
        .catch(() => {
          if (active && generation === recoveryGeneration.current)
            setError(
              'Chưa lấy được kết quả lần trước. Bấm Đọc lại kết quả trước khi tạo yêu cầu khác.',
            );
        });
    }
    return () => {
      active = false;
    };
  }, [storageKey, order.sandboxRun?.id]);
  async function perform(label: string, action: () => Promise<void>) {
    if (lock.current || blocked) return;
    lock.current = true;
    setBusy(label);
    onBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      lock.current = false;
      setBusy('');
      onBusy(false);
    }
  }
  if (order.sandboxReconciliation)
    return (
      <section className="sandbox-review" aria-label="Lịch sử đã đối chiếu">
        <h2>Lamy đã được đối chiếu trạng thái hiện tại</h2>
        <p>Đã giải phóng khóa của lần gửi cũ lúc {date(order.sandboxReconciliation.verifiedAt)}.</p>
        <p>
          Lịch sử vẫn giữ kết quả kiểm ban đầu. Phiếu đối chiếu mới xác nhận dữ liệu hiện tại và ảnh
          bìa; không gửi lại lần cập nhật cũ.
        </p>
        <p>
          Chọn <strong>Thử sandbox</strong> ở đầu trang để thực hiện phép thử mới trên listing mẫu.
        </p>
        <small>Mã phiếu: {order.sandboxReconciliation.id}</small>
      </section>
    );
  return (
    <section className="sandbox-review" aria-label="Đối chiếu và thực hiện sandbox">
      <div className="section-heading">
        <div>
          <h2>Đối chiếu với Shopee</h2>
          <p>Chỉ gửi đúng những phần đã chọn sau khi bạn xem bản thay đổi.</p>
        </div>
        <span className="tag neutral">SANDBOX</span>
      </div>
      {!canRead && (
        <p className="context-note">
          {!sandbox
            ? 'Shop thật hiện chỉ đọc; chưa mở gửi thay đổi trong luồng này.'
            : order.config.operation === 'create'
              ? 'Đăng mới chưa được hỗ trợ trong luồng thực thi này. Công việc vẫn được lưu để theo dõi.'
              : !order.config.itemId
                ? 'Chọn đúng mã sản phẩm và lưu công việc trước khi đọc.'
                : 'Kết nối shop cần được kiểm tra trước khi đọc.'}
        </p>
      )}
      {error && (
        <div role="alert" className="banner error">
          {error}
        </div>
      )}
      {busy && <p role="status">{busy} Giữ trang mở để nhận kết quả.</p>}
      {canRead && (
        <div className="actions">
          <button
            disabled={blocked || !!busy || !!run || !!recoverId || prepareUncertain}
            onClick={() =>
              void perform('Đang đọc listing từ sandbox…', async () => {
                prepareBody.current = null;
                setRead(await post<SandboxReadResult>('/v1/sandbox-listings/read', scope));
                setConfirmed(false);
              })
            }
          >
            Đọc & đối chiếu sandbox
          </button>
          {recoverId && (
            <button
              disabled={blocked || !!busy}
              onClick={() =>
                void perform('Đang lấy kết quả đã lưu…', async () =>
                  remember(
                    await api<SandboxRun>(
                      '/v1/sandbox-listings/runs/' + encodeURIComponent(recoverId),
                    ),
                  ),
                )
              }
            >
              Đọc lại kết quả
            </button>
          )}
        </div>
      )}
      {read && (
        <div className="sandbox-readback">
          <p className="caption">
            Đã đọc shop {read.scope.shopId} · Link {read.snapshot.itemId} ·{' '}
            {date(read.snapshot.observedAt)}
          </p>
          <div className="sandbox-comparison">
            <div>
              <h3>Đang có trên Shopee</h3>
              <p>{read.snapshot.title}</p>
              <p>
                {read.snapshot.models.length} SKU · {read.snapshot.gallery.imageIds.length} ảnh sản
                phẩm
              </p>
            </div>
            <div>
              <h3>Bản nguồn đã chọn</h3>
              <p>{read.source.title}</p>
              <p>
                {read.source.skus.length} SKU · Bản {read.source.revision}
              </p>
            </div>
          </div>
          <ul>
            {read.comparison.map((item) => (
              <li key={item.field}>
                {fieldNames[item.field]}:{' '}
                {item.state === 'equal'
                  ? 'Trùng với nguồn'
                  : item.state === 'different'
                    ? 'Có khác biệt'
                    : 'Cần đối chiếu tệp ảnh trước khi gửi'}
              </li>
            ))}
          </ul>
          {read.checks.length > 0 && (
            <div className="banner">
              <h3>Cần xử lý trước khi gửi</h3>
              {read.checks.map((check) => (
                <p key={check.code + check.field}>{check.message}</p>
              ))}
            </div>
          )}
          {!supported && (
            <p className="context-note">
              Luồng sandbox hiện hỗ trợ tiêu đề, nội dung mô tả và ảnh sản phẩm. Chọn riêng phần đã
              hỗ trợ để kiểm tra; các phần khác giữ nguyên và được báo rõ trong công việc.
            </p>
          )}
          {supported && !run && !recoverId && (
            <button
              disabled={blocked || !!busy || read.checks.length > 0}
              onClick={() =>
                void perform('Đang kiểm tra và lưu bản thay đổi…', async () => {
                  prepareBody.current ??= {
                    ...scope,
                    workOrderId: order.id,
                    workOrderRevision: order.revision,
                    id: crypto.randomUUID(),
                    baselineFingerprint: read.snapshot.fingerprint,
                    fieldMask: order.config.fieldMask as SandboxField[],
                  };
                  try {
                    const prepared = await post<SandboxRun>(
                      '/v1/sandbox-listings/prepare',
                      prepareBody.current,
                    );
                    setPrepareUncertain(false);
                    remember(prepared);
                  } catch (cause) {
                    if (
                      cause instanceof RequestError &&
                      cause.status &&
                      cause.status >= 400 &&
                      cause.status < 500
                    ) {
                      prepareBody.current = null;
                      setPrepareUncertain(false);
                      setRead(null);
                    } else setPrepareUncertain(true);
                    throw cause;
                  }
                })
              }
            >
              {prepareUncertain ? 'Lấy lại bản xem trước' : 'Xem trước những phần sẽ đổi'}
            </button>
          )}
        </div>
      )}
      {run && (
        <div className="sandbox-run" data-testid="sandbox-run">
          <div className="section-heading">
            <h3>{runLabels[run.state]}</h3>
            <small>{date(run.updatedAt)}</small>
          </div>
          <p>
            Link {run.itemId} · Bản nguồn {run.sourceRevision} ·{' '}
            {run.fieldMask.map((field) => fieldNames[field]).join(', ')}
          </p>
          {!matchesScope(run) && (
            <p className="context-note">
              Lần ghi trước trên link này dùng bộ hoặc lựa chọn khác. Đối chiếu lần đó trước; chưa
              áp dụng kết quả này cho công việc hiện tại.
            </p>
          )}
          {run.preview.map((change) => (
            <section className="sandbox-change" key={change.field}>
              <h4>{fieldNames[change.field]}</h4>
              <div className="sandbox-comparison">
                <div>
                  <strong>Trước</strong>
                  <ChangeValue field={change.field} value={change.before} />
                </div>
                <div>
                  <strong>Sau</strong>
                  <ChangeValue field={change.field} value={change.after} />
                </div>
              </div>
            </section>
          ))}
          {run.result && (
            <div className="sandbox-result">
              <p>{run.result.message}</p>
              <dl>
                <div>
                  <dt>Những phần được chọn</dt>
                  <dd>
                    {run.result.selectedFieldsMatch === undefined
                      ? 'Chưa xác minh'
                      : run.result.selectedFieldsMatch
                        ? 'Đã khớp sau khi đọc lại'
                        : 'Chưa khớp'}
                  </dd>
                </div>
                <div>
                  <dt>Những phần phải giữ nguyên</dt>
                  <dd>
                    {run.result.unselectedFieldsMatch === undefined
                      ? 'Chưa xác minh'
                      : run.result.unselectedFieldsMatch
                        ? 'Đã đối chiếu giữ nguyên'
                        : 'Phát hiện khác biệt'}
                  </dd>
                </div>
                <div>
                  <dt>Kiểm duyệt của Shopee</dt>
                  <dd>Chưa kiểm tra; đối chiếu dữ liệu không đồng nghĩa được duyệt</dd>
                </div>
              </dl>
              {run.result.after && <RemoteSummary snapshot={run.result.after} />}
              <details className="sandbox-run-diagnostics">
                <summary>Thông tin tra cứu lần thực hiện</summary>
                <p>Mã lần thực hiện: {run.id}</p>
                <p>Kết quả: {run.result.code}</p>
                {run.result.failure && (
                  <p>
                    Bước tải ảnh:{' '}
                    {run.result.failure.code ?? run.result.failure.reason ?? 'Chưa xác định'}
                    {run.result.failure.httpStatus
                      ? ` · HTTP ${run.result.failure.httpStatus}`
                      : ''}
                  </p>
                )}
                {run.result.requestIds.map((requestId, index) => (
                  <p key={`${index}-${requestId}`}>Mã yêu cầu Shopee: {requestId}</p>
                ))}
              </details>
            </div>
          )}
          {uncertain && (
            <p role="status" className="context-note">
              Chưa nhận được phản hồi của yêu cầu vừa gửi. Đọc lại kết quả trước khi gửi hoặc đổi
              cấu hình.
            </p>
          )}
          {run.state === 'prepared' && matchesScope(run) && !uncertain && (
            <>
              <label className="sandbox-confirm">
                <input
                  type="checkbox"
                  disabled={blocked || !!busy}
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Tôi đã xem đúng link sandbox và những phần sẽ thay đổi.
              </label>
              <button
                className="primary"
                disabled={blocked || !!busy || !confirmed}
                onClick={() =>
                  void perform('Đang gửi thay đổi và đọc lại kết quả sandbox…', async () => {
                    setConfirmed(false);
                    try {
                      remember(
                        await post<SandboxRun>(
                          `/v1/sandbox-listings/runs/${encodeURIComponent(run.id)}/execute`,
                          { expectedRevision: run.revision },
                        ),
                      );
                    } catch (cause) {
                      setUncertain(true);
                      onRecoveryNeeded?.();
                      throw cause;
                    }
                  })
                }
              >
                Gửi thay đổi lên sandbox
              </button>
            </>
          )}
          {['unknown', 'in_flight'].includes(run.state) && (
            <>
              <p className="context-note">
                Chưa gửi lại thay đổi. Đọc trạng thái hiện tại để xác định kết quả trước.
              </p>
              <button
                disabled={blocked || !!busy}
                onClick={() =>
                  void perform('Đang đọc lại để đối chiếu kết quả…', async () =>
                    remember(
                      await post<SandboxRun>(
                        `/v1/sandbox-listings/runs/${encodeURIComponent(run.id)}/reconcile`,
                        { expectedRevision: run.revision },
                      ),
                    ),
                  )
                }
              >
                Đọc lại & đối chiếu kết quả
              </button>
            </>
          )}
          {['drift', 'rejected', 'verified'].includes(run.state) && canRead && (
            <button
              disabled={blocked || !!busy}
              onClick={() =>
                void perform('Đang đọc bản hiện tại để chuẩn bị lần mới…', async () => {
                  recoveryGeneration.current++;
                  setRun(null);
                  setRecoverId(null);
                  setRead(null);
                  setConfirmed(false);
                  setUncertain(false);
                  setPrepareUncertain(false);
                  prepareBody.current = null;
                  try {
                    localStorage.removeItem(storageKey);
                  } catch {
                    /* Server retains previous attempts. */
                  }
                  setRead(await post<SandboxReadResult>('/v1/sandbox-listings/read', scope));
                })
              }
            >
              Đọc lại và chuẩn bị lần mới
            </button>
          )}
        </div>
      )}
    </section>
  );
}
function ChangeValue({ field, value }: { field: SandboxField; value: unknown }) {
  if (field === 'title')
    return (
      <p className="preserve-text">
        {typeof value === 'string' ? value : 'Chưa có dữ liệu để hiển thị'}
      </p>
    );
  if (Array.isArray(value))
    return (
      <div className="sandbox-content-preview">
        {value.map((block: unknown, index) => {
          if (
            block &&
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'text' &&
            'text' in block &&
            typeof block.text === 'string'
          )
            return (
              <p className="preserve-text" key={index}>
                {block.text}
              </p>
            );
          if (
            block &&
            typeof block === 'object' &&
            'assetKey' in block &&
            typeof block.assetKey === 'string'
          )
            return (
              <figure key={index}>
                <img
                  src={media(block.assetKey)}
                  alt={`Ảnh nguồn ở vị trí ${index + 1}`}
                  style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain' }}
                />
                <figcaption>Vị trí {index + 1}</figcaption>
              </figure>
            );
          return (
            <p className="caption" key={index}>
              Ảnh ở vị trí {index + 1} trong dữ liệu hiện tại
            </p>
          );
        })}
      </div>
    );
  if (value && typeof value === 'object') {
    const images =
      'imageIds' in value && Array.isArray(value.imageIds)
        ? value.imageIds
        : 'assetKeys' in value && Array.isArray(value.assetKeys)
          ? value.assetKeys
          : null;
    if (images) return <p>{images.length} ảnh, giữ đúng thứ tự đã chọn</p>;
  }
  return <p className="caption">Dữ liệu được giữ trong bản thay đổi đã lưu.</p>;
}
function RemoteSummary({ snapshot }: { snapshot: SandboxSnapshot }) {
  return (
    <details>
      <summary>Dữ liệu đọc lại từ Shopee</summary>
      <p>{snapshot.title}</p>
      <p>
        {snapshot.gallery.imageIds.length} ảnh sản phẩm · {snapshot.models.length} SKU ·{' '}
        {date(snapshot.observedAt)}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Phân loại</th>
              <th>Giá gốc</th>
              <th>Tồn khả dụng</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.models.map((model) => (
              <tr key={model.modelId}>
                <td>{model.sku}</td>
                <td>{model.optionLabels.join(' / ')}</td>
                <td>{model.originalPrice ?? 'Chưa có'}</td>
                <td>{model.availableStock ?? 'Chưa có'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
