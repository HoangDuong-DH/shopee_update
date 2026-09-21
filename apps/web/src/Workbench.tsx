import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FileInput, Plus, RefreshCw } from 'lucide-react';
import type {
  DraftField,
  ListingDraft,
  Workbench as WorkbenchData,
  WorkIssueKind,
  WorkOrderConfig,
  WorkOrderView,
} from '@shopee/domain';
import { api, date, media, post } from './api.js';
import { SandboxReview } from './SandboxReview.js';
import { SavedPatchList } from './ImportUpdates.js';
import './workbench.css';

const issueLabels: Record<WorkIssueKind, string> = {
  missing_source: 'Nguồn chưa có thông tin',
  mapping_needed: 'Cần xác định cách ghép',
  connection: 'Cần xử lý kết nối',
  unsupported: 'Ứng dụng chưa hỗ trợ',
  conflict: 'Có phiên bản thay đổi',
};
export const fieldLabels: Record<DraftField, string> = {
  title: 'Tiêu đề',
  description: 'Nội dung mô tả',
  gallery: 'Ảnh sản phẩm',
  category: 'Ngành hàng',
  brand: 'Thương hiệu',
  attributes: 'Thuộc tính',
  variations: 'Phân loại',
  price: 'Giá',
  stock: 'Tồn đăng bán',
  logistics: 'Vận chuyển',
  video: 'Video',
  sizeChart: 'Bảng kích thước',
  identifiers: 'Mã nhận diện',
  compliance: 'Hồ sơ sản phẩm',
  fulfillment: 'Xử lý đơn',
  publication: 'Trạng thái hiển thị',
};
const fields = Object.keys(fieldLabels) as DraftField[];
function workState(order: WorkOrderView): 'needs_attention' | 'ready_to_check' | 'verified' {
  if (
    order.sandboxRun?.state === 'verified' &&
    order.sandboxRunMatchesConfig &&
    !order.issues.length
  )
    return 'verified';
  if (
    order.sandboxRun &&
    ['unknown', 'in_flight', 'drift', 'rejected'].includes(order.sandboxRun.state)
  )
    return 'needs_attention';
  return order.state;
}
const emptyConfig = (
  source: ListingDraft,
  connectionId: string,
  operation: 'create' | 'update',
): WorkOrderConfig => ({
  productKey: source.productKey,
  sourceRevision: source.revision,
  connectionId,
  operation,
  itemId: null,
  fieldMask: [],
  stocks: {},
});

export function Workbench({
  onUpdates,
  onReceive,
  onFolders,
  onSource,
  onShops,
  onDirty,
  onBusy,
}: {
  onUpdates: (workOrderId?: string, receiptId?: string) => void;
  onReceive: () => void;
  onFolders: () => void;
  onSource: (source: ListingDraft) => void;
  onShops: () => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'needs_attention' | 'ready_to_check' | 'verified'>(
    'all',
  );
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [sourceKeys, setSourceKeys] = useState<string[]>([]);
  const [shopId, setShopId] = useState('');
  const [operation, setOperation] = useState<'' | 'create' | 'update'>('');
  const [selected, setSelected] = useState<WorkOrderView | null>(null);
  const createRequests = useRef<
    { id: string; expectedRevision: number; config: WorkOrderConfig }[] | null
  >(null);
  const lock = useRef(false);
  async function reload() {
    setLoading(true);
    try {
      setData(await api<WorkbenchData>('/v1/workbench'));
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    onDirty(creating && (sourceKeys.length > 0 || !!shopId || !!operation));
  }, [creating, sourceKeys, shopId, operation, onDirty]);
  function upsert(order: WorkOrderView) {
    setData(
      (current) =>
        current && {
          ...current,
          orders: [order, ...current.orders.filter((row) => row.id !== order.id)],
        },
    );
    setSelected(order);
  }
  async function createOrders() {
    if (lock.current || !data || !sourceKeys.length || !shopId || !operation) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    createRequests.current ??= sourceKeys.map((key) => ({
      id: crypto.randomUUID(),
      expectedRevision: 0,
      config: emptyConfig(
        data.sources.find((source) => source.productKey === key)!,
        shopId,
        operation,
      ),
    }));
    try {
      for (const body of createRequests.current) {
        const saved = await post<WorkOrderView>('/v1/work-orders', body);
        setData(
          (current) =>
            current && {
              ...current,
              orders: [saved, ...current.orders.filter((row) => row.id !== saved.id)],
            },
        );
      }
      createRequests.current = null;
      setCreating(false);
      setSourceKeys([]);
      setShopId('');
      setOperation('');
      onDirty(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  if (selected)
    return (
      <WorkOrderDetail
        onUpdates={onUpdates}
        key={selected.id}
        order={selected}
        data={data!}
        onSaved={upsert}
        onBack={() => {
          setSelected(null);
          onDirty(false);
          void reload();
        }}
        onSource={onSource}
        onShops={onShops}
        onDirty={onDirty}
        onBusy={onBusy}
      />
    );
  const orders =
    data?.orders.filter(
      (order) =>
        (filter === 'all' || workState(order) === filter) &&
        `${order.source.title.value} ${order.shop?.name ?? ''} ${order.config.itemId ?? ''} ${order.source.variants.map((item) => item.sku.value).join(' ')}`
          .toLocaleLowerCase('vi')
          .includes(query.toLocaleLowerCase('vi')),
    ) ?? [];
  return (
    <div className="workbench">
      <div className="page-heading">
        <div>
          <h1>Công việc đăng hàng</h1>
          <p>
            Mỗi công việc gắn một bộ listing với một shop. Xử lý phần còn vướng, rồi đối chiếu trước
            khi gửi.
          </p>
        </div>
        <div className="workbench-actions">
          <button className="primary" onClick={() => onUpdates()} disabled={busy}>
            <FileInput size={18} />
            Nhập bộ cập nhật
          </button>
          <button onClick={onFolders} disabled={busy}>
            <FileInput size={18} />
            Nhận thư mục listing
          </button>
        </div>
      </div>
      {error && (
        <div role="alert" className="banner error">
          <span>{error}</span>
          <button onClick={() => void reload()} disabled={busy}>
            Tải lại danh sách
          </button>
        </div>
      )}
      <div className="workbench-tools">
        <div className="tabbar">
          {(['all', 'needs_attention', 'ready_to_check', 'verified'] as const).map((value) => (
            <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {value === 'all'
                ? 'Tất cả'
                : value === 'needs_attention'
                  ? 'Cần xử lý'
                  : value === 'verified'
                    ? 'Đã đối chiếu'
                    : 'Có thể đối chiếu'}{' '}
              <span>
                {data?.orders.filter((row) => value === 'all' || workState(row) === value).length ??
                  0}
              </span>
            </button>
          ))}
        </div>
        <div className="workbench-actions">
          <input
            aria-label="Tìm công việc"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Tên listing, shop hoặc SKU"
          />
          <button onClick={() => setCreating(true)} disabled={busy || !data?.sources.length}>
            <Plus size={16} />
            Chọn bộ đã có
          </button>
          <button
            aria-label="Làm mới công việc"
            disabled={busy || loading}
            onClick={() => void reload()}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {creating && data && (
        <section className="workbench-create" aria-label="Tạo công việc từ bộ đã có">
          <div className="section-heading">
            <h2>Chọn bộ và nơi cần đăng</h2>
            <button
              disabled={busy || !!createRequests.current}
              onClick={() => {
                setCreating(false);
                setSourceKeys([]);
                setShopId('');
                setOperation('');
              }}
            >
              Đóng
            </button>
          </div>
          <p className="caption">
            Chọn nhiều bộ để tạo từng công việc riêng. Bước này chỉ lưu việc cần làm trong ứng dụng.
          </p>
          <fieldset disabled={busy || !!createRequests.current} className="workbench-source-picks">
            <legend>Bộ listing đã tiếp nhận</legend>
            {data.sources.map((source) => (
              <label key={source.productKey}>
                <input
                  type="checkbox"
                  checked={sourceKeys.includes(source.productKey)}
                  onChange={(event) =>
                    setSourceKeys((current) =>
                      event.target.checked
                        ? [...current, source.productKey]
                        : current.filter((key) => key !== source.productKey),
                    )
                  }
                />
                <span>
                  {source.title.value}
                  <small>
                    Bản {source.revision} · {source.variants.length} SKU
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="workbench-form-grid">
            <label>
              Shop đích
              <select
                aria-label="Shop đích cho công việc mới"
                disabled={busy || !!createRequests.current}
                value={shopId}
                onChange={(event) => setShopId(event.target.value)}
              >
                <option value="">Chọn shop</option>
                {data.shops.map((shop) => (
                  <option key={shop.id} value={shop.id}>
                    {shop.name} ·{' '}
                    {shop.scope.environment === 'sandbox' ? 'SANDBOX' : 'SHOP THẬT / CHỈ ĐỌC'} ·{' '}
                    {shop.scope.shopId}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Công việc cần làm
              <select
                aria-label="Loại công việc mới"
                disabled={busy || !!createRequests.current}
                value={operation}
                onChange={(event) => setOperation(event.target.value as typeof operation)}
              >
                <option value="">Chọn công việc</option>
                <option value="update">Cập nhật link đã có</option>
                <option value="create">Đăng link mới</option>
              </select>
            </label>
          </div>
          {createRequests.current && (
            <p role="status">
              Đang giữ đúng các công việc đã gửi. Thử lưu lại để xác nhận kết quả, tránh tạo trùng.
            </p>
          )}
          <button
            className="primary"
            disabled={busy || !sourceKeys.length || !shopId || !operation}
            onClick={() => void createOrders()}
          >
            {busy ? 'Đang lưu công việc…' : `Lưu ${sourceKeys.length || ''} công việc`}
          </button>
        </section>
      )}
      {loading && !data ? (
        <p role="status" className="empty">
          Đang lấy công việc đã lưu…
        </p>
      ) : (
        <section className="workbench-list" aria-label="Danh sách công việc">
          {orders.map((order) => (
            <article className="workbench-row" key={order.id} data-testid="work-order-row">
              <div className="workbench-identity">
                {order.source.coverKey ? (
                  <img src={media(order.source.coverKey)} alt="" />
                ) : (
                  <div className="workbench-cover-empty" />
                )}
                <div>
                  <button className="listing-title" onClick={() => setSelected(order)}>
                    {order.source.title.value}
                  </button>
                  <small>
                    Bản nguồn {order.config.sourceRevision} · {order.source.variants.length} SKU
                  </small>
                </div>
              </div>
              <div className="workbench-target">
                <strong>{order.shop?.name ?? 'Chưa chọn shop'}</strong>
                <small>
                  {order.shop?.scope.environment === 'sandbox' ? 'SANDBOX' : 'SHOP THẬT / CHỈ ĐỌC'}{' '}
                  ·{' '}
                  {order.config.operation === 'update'
                    ? `Cập nhật ${order.config.itemId || '— chưa chọn link'}`
                    : 'Đăng mới'}
                </small>
              </div>
              <div className="workbench-problem">
                {workState(order) === 'verified' ? (
                  <>
                    <strong className="workbench-ready">Đã đọc lại và đối chiếu</strong>
                    <small>Sandbox · Kiểm duyệt Shopee chưa kiểm tra</small>
                  </>
                ) : order.sandboxReconciliation ? (
                  <>
                    <strong>Đã đối chiếu trạng thái hiện tại</strong>
                    <small>Lịch sử lần gửi được giữ nguyên · Thử phép mới tại Thử sandbox</small>
                  </>
                ) : order.sandboxRun &&
                  ['unknown', 'in_flight'].includes(order.sandboxRun.state) ? (
                  <>
                    <strong>Chưa xác định kết quả ghi</strong>
                    <small>Cần đọc lại trước khi gửi thay đổi khác</small>
                  </>
                ) : order.sandboxRun && ['drift', 'rejected'].includes(order.sandboxRun.state) ? (
                  <>
                    <strong>
                      {order.sandboxRun.state === 'drift'
                        ? 'Dữ liệu đã thay đổi'
                        : 'Yêu cầu bị từ chối'}
                    </strong>
                    <small>
                      {order.sandboxRun.result?.message ??
                        'Mở công việc để xem kết quả và đối chiếu lại.'}
                    </small>
                  </>
                ) : order.issues.length ? (
                  <>
                    <strong>{issueLabels[order.issues[0]!.kind]}</strong>
                    <small>{order.issues[0]!.message}</small>
                    {order.issues.length > 1 && (
                      <small>Và {order.issues.length - 1} việc cần xử lý</small>
                    )}
                  </>
                ) : (
                  <>
                    <strong className="workbench-ready">Có thể đọc & đối chiếu</strong>
                    <small>Chưa gửi thay đổi lên Shopee</small>
                  </>
                )}
              </div>
              <button
                onClick={() => setSelected(order)}
                aria-label={`Làm tiếp ${order.source.title.value}`}
              >
                <span>Làm tiếp</span>
                <ArrowRight size={17} />
              </button>
            </article>
          ))}
          {!orders.length && (
            <div className="empty">
              <h2>
                {data?.orders.length
                  ? 'Không có công việc khớp bộ lọc'
                  : 'Bắt đầu từ bộ listing đã chuẩn bị'}
              </h2>
              <p>
                {data?.orders.length
                  ? 'Chọn Tất cả hoặc tìm theo tên shop.'
                  : 'Nhận bộ mới hoặc chọn bộ đã có, rồi xác định shop và việc cần làm.'}
              </p>
              {!data?.orders.length && (
                <button onClick={() => setCreating(true)} disabled={!data?.sources.length}>
                  Chọn bộ đã có
                </button>
              )}
            </div>
          )}
        </section>
      )}
      <div className="workbench-footnote">
        <button className="back-link" onClick={onReceive}>
          Nhập / xuất hồ sơ
        </button>
        <span>
          Shop thật giữ chế độ chỉ đọc. Khả năng thực thi được kiểm tra riêng cho từng việc.
        </span>
      </div>
      <SavedPatchList onOpen={(id) => onUpdates(undefined, id)} />
    </div>
  );
}

function WorkOrderDetail({
  onUpdates,
  order,
  data,
  onSaved,
  onBack,
  onSource,
  onShops,
  onDirty,
  onBusy,
}: {
  onUpdates: (workOrderId?: string, receiptId?: string) => void;
  order: WorkOrderView;
  data: WorkbenchData;
  onSaved: (order: WorkOrderView) => void;
  onBack: () => void;
  onSource: (source: ListingDraft) => void;
  onShops: () => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [config, setConfig] = useState<WorkOrderConfig>(order.config);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(() =>
    ['unknown', 'in_flight'].includes(order.sandboxRun?.state ?? ''),
  );
  const lock = useRef(false);
  const changed = JSON.stringify(config) !== JSON.stringify(order.config);
  useEffect(() => {
    onDirty(changed);
  }, [changed, onDirty]);
  async function save() {
    if (lock.current || recoveryRequired) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      onSaved(
        await post<WorkOrderView>('/v1/work-orders', {
          id: order.id,
          expectedRevision: order.revision,
          config,
        }),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <div className="workbench-detail">
      <button className="primary" disabled={busy || changed} onClick={() => onUpdates(order.id)}>
        <FileInput size={17} />
        Nhập bộ cập nhật
      </button>
      <SavedPatchList workOrderId={order.id} onOpen={(id) => onUpdates(order.id, id)} />
      <button
        className="back-link"
        disabled={busy}
        onClick={() => (changed ? setDiscard(true) : onBack())}
      >
        <ArrowLeft size={16} />
        Về công việc đăng hàng
      </button>
      {discard && (
        <div role="alertdialog" aria-label="Cấu hình công việc chưa lưu" className="banner">
          <p>Các lựa chọn công việc chưa lưu. Giữ lại để tiếp tục hoặc bỏ thay đổi.</p>
          <button onClick={() => setDiscard(false)}>Ở lại</button>
          <button onClick={onBack}>Bỏ thay đổi</button>
        </div>
      )}
      <div className="page-heading">
        <div>
          <h1>{order.source.title.value}</h1>
          <p>
            Bản nguồn {order.config.sourceRevision} · {order.source.variants.length} SKU · Lưu công
            việc lúc {date(order.updatedAt)}
          </p>
        </div>
        <button disabled={busy || changed} onClick={() => onSource(order.source)}>
          Xem bộ nguồn
        </button>
      </div>
      {error && (
        <div role="alert" className="banner error">
          {error} <span>Lựa chọn đang nhập vẫn được giữ.</span>
        </div>
      )}
      <div className="workbench-detail-grid">
        <section className="workbench-settings" aria-label="Thiết lập công việc">
          <h2>Thông tin công việc</h2>
          <p>
            Để thay giá, tồn, Word hoặc ảnh, dùng “Nhập bộ cập nhật”. Chỉ mở thiết lập nâng cao khi
            cần đổi liên kết công việc.
          </p>
          {recoveryRequired && (
            <p className="context-note">
              Link này có lần ghi chưa xác định kết quả. Đọc lại và đối chiếu ở phía dưới trước khi
              đổi cấu hình công việc.
            </p>
          )}
          <details className="patch-advanced">
            <summary>Thiết lập nâng cao / cách nhập thủ công</summary>
            <fieldset disabled={busy || recoveryRequired}>
              <div className="workbench-form-grid">
                <label>
                  Shop đích
                  <select
                    value={config.connectionId ?? ''}
                    aria-label="Shop đích"
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        connectionId: event.target.value || null,
                        itemId: null,
                        stocks: {},
                      })
                    }
                  >
                    <option value="">Chọn shop</option>
                    {data.shops.map((shop) => (
                      <option key={shop.id} value={shop.id}>
                        {shop.name} ·{' '}
                        {shop.scope.environment === 'sandbox' ? 'SANDBOX' : 'SHOP THẬT / CHỈ ĐỌC'} ·{' '}
                        {shop.scope.shopId}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Công việc
                  <select
                    aria-label="Loại công việc"
                    value={config.operation}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        operation: event.target.value as 'create' | 'update',
                        itemId: null,
                      })
                    }
                  >
                    <option value="update">Cập nhật link đã có</option>
                    <option value="create">Đăng link mới</option>
                  </select>
                </label>
              </div>
              {config.operation === 'update' && (
                <label>
                  Mã sản phẩm trên Shopee
                  <input
                    aria-label="Mã sản phẩm trên Shopee"
                    inputMode="numeric"
                    value={config.itemId ?? ''}
                    onChange={(event) =>
                      setConfig({ ...config, itemId: event.target.value || null })
                    }
                    placeholder="Nhập đúng mã của link cần cập nhật"
                  />
                  <small>Không tự tìm link dựa trên tên hoặc SKU.</small>
                </label>
              )}
              {order.latestSourceRevision !== order.config.sourceRevision && (
                <div className="banner">
                  <p>
                    Bộ nguồn đã có bản {order.latestSourceRevision}. Công việc vẫn đang dùng bản{' '}
                    {order.config.sourceRevision}.
                  </p>
                  <button
                    onClick={() =>
                      setConfig({ ...config, sourceRevision: order.latestSourceRevision })
                    }
                  >
                    Chọn bản nguồn {order.latestSourceRevision}
                  </button>
                </div>
              )}
              <fieldset className="workbench-field-mask">
                <legend>Những phần được phép thay đổi</legend>
                <p className="caption">
                  Chọn đúng yêu cầu. Khả năng gửi thực tế được kiểm tra bên dưới.
                </p>
                {fields.map((field) => (
                  <label key={field}>
                    <input
                      type="checkbox"
                      checked={config.fieldMask.includes(field)}
                      onChange={(event) =>
                        setConfig({
                          ...config,
                          fieldMask: event.target.checked
                            ? [...config.fieldMask, field]
                            : config.fieldMask.filter((value) => value !== field),
                        })
                      }
                    />
                    {fieldLabels[field]}
                  </label>
                ))}
              </fieldset>
              {config.fieldMask.includes('stock') && (
                <fieldset className="workbench-stocks">
                  <legend>Tồn đăng bán do shop quyết định</legend>
                  <p className="caption">
                    Để trống nếu chưa xác nhận. Nhập 0 chỉ khi chủ động ngừng bán SKU đó.
                  </p>
                  {order.source.variants.map((variant) => (
                    <label key={variant.key}>
                      <span>
                        {variant.optionLabels.join(' / ') || variant.sku.value}
                        <small>{variant.sku.value}</small>
                      </span>
                      <input
                        aria-label={`Tồn đăng bán ${variant.sku.value}`}
                        type="number"
                        min="0"
                        step="1"
                        value={config.stocks[variant.sku.value] ?? ''}
                        onChange={(event) => {
                          const stocks = { ...config.stocks };
                          if (event.target.value === '') delete stocks[variant.sku.value];
                          else stocks[variant.sku.value] = Number(event.target.value);
                          setConfig({ ...config, stocks });
                        }}
                      />
                    </label>
                  ))}
                </fieldset>
              )}
            </fieldset>
            <div className="workbench-save">
              <button
                className="primary"
                disabled={busy || recoveryRequired || !changed}
                onClick={() => void save()}
              >
                {busy ? 'Đang lưu…' : 'Lưu lựa chọn công việc'}
              </button>
              <span>
                {changed ? (
                  'Có lựa chọn chưa lưu'
                ) : (
                  <>
                    <Check size={15} />
                    Đã lưu trong ứng dụng
                  </>
                )}
              </span>
            </div>
          </details>
        </section>
        <aside className="workbench-exceptions" aria-label="Những việc cần xử lý">
          <h2>Việc cần xử lý</h2>
          {changed && (
            <p role="status" className="context-note">
              Lưu lựa chọn để cập nhật kết quả kiểm tra.
            </p>
          )}
          {Object.entries(issueLabels).map(([kind, label]) => {
            const issues = order.issues.filter((issue) => issue.kind === kind);
            return (
              issues.length > 0 && (
                <section key={kind}>
                  <h3>{label}</h3>
                  {issues.map((issue) => (
                    <div className="workbench-issue" key={`${issue.code}:${issue.field}`}>
                      <p>{issue.message}</p>
                      <small>{issue.action}</small>
                    </div>
                  ))}
                  {kind === 'connection' && (
                    <button disabled={busy || changed} onClick={onShops}>
                      Mở kết nối shop
                    </button>
                  )}
                  {['missing_source', 'mapping_needed', 'conflict'].includes(kind) && (
                    <button disabled={busy || changed} onClick={() => onSource(order.source)}>
                      Đối chiếu bộ nguồn
                    </button>
                  )}
                </section>
              )
            );
          })}
          {!order.issues.length && (
            <p className="workbench-ready">
              Đủ thông tin để bắt đầu đọc và đối chiếu. Chưa xác nhận được phép ghi.
            </p>
          )}
        </aside>
      </div>
      <SandboxReview
        key={`${order.id}:${order.revision}`}
        order={order}
        blocked={changed || busy}
        onBusy={(value) => {
          setBusy(value);
          onBusy(value);
        }}
        onRunChange={(run) => setRecoveryRequired(['unknown', 'in_flight'].includes(run.state))}
        onRecoveryNeeded={() => setRecoveryRequired(true)}
      />
    </div>
  );
}
