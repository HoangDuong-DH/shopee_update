import { useEffect, useRef, useState } from 'react';
import { api, date, RequestError } from './api.js';
import './seller-knowledge.css';

type Scope = { environment: string; shopId: string; partnerId: string };
type Issue = string | { code?: string; message?: string; reason?: string };
type Sync = {
  id: string;
  connectionId?: string;
  state: string;
  code: string | null;
  processedCount: number;
  fetchedCount: number;
  reusedCount: number;
  requestCount: number;
  maxItems: number;
  canResume: boolean;
  issues: Issue[];
};
type Shop = {
  id?: string;
  connectionId?: string;
  name?: string;
  shopName?: string;
  displayName?: string;
  scope: Scope;
  listingCount?: number;
  lastSeenAt?: string | null;
  latestSync?: Sync | null;
  categories?: { id: string; name: string; count: number }[];
};
type Listing = {
  evidenceId: string;
  connectionId: string;
  scope: Scope;
  itemId: string;
  title: string;
  itemSku: string;
  modelSkus: string[];
  categoryId: string | null;
  brandId: string | null;
  attributes: unknown[] | null;
  observedAt: string;
  issues: Issue[];
  itemStatus: string;
};
type Value = {
  valueId: string | number;
  originalValueName?: string;
  displayName?: string;
  valueUnit?: string;
};
type Suggestion = {
  attributeId: string | number;
  name: string;
  values: Value[];
  evidenceIds: string[];
  sourceClass: string;
  reasons: string[];
  canPrefill: boolean;
  confidence: string;
  coverage?: { matchedSkuCount: number; targetSkuCount: number; partial: boolean };
};
type Comparison = {
  target: { title: string; itemId?: string };
  candidateCoverage?: { totalCount: number; limit: number; truncated: boolean };
  sourceFacts?: {
    attributeId: string | number;
    sourceId: string;
    sourceLocator: string;
    confirmed: boolean;
  }[];
  recommendations: {
    suggestions: Suggestion[];
    issues: Issue[];
    missingMandatoryAttributeIds: (string | number)[];
  };
};
type Evidence = {
  id: string;
  connectionId: string;
  scope: Scope;
  observedAt: string;
  body: {
    title?: string;
    itemId?: string;
    itemSku?: string;
    modelSkus?: string[];
    attributes?: unknown[];
    [key: string]: unknown;
  };
};
type Task = 'shops' | 'sync' | 'poll' | 'search' | 'compare' | 'evidence';
const messages: Record<string, string> = {
  KNOWLEDGE_BATCH_LIMIT: 'Đã đọc đủ số sản phẩm của lượt này. Có thể tiếp tục từ vị trí đã lưu.',
  KNOWLEDGE_CONNECTION_EXPIRED:
    'Kết nối shop đã hết hạn. Mở Kết nối shop để cập nhật rồi tiếp tục lượt đọc.',
  KNOWLEDGE_CONNECTION_CHANGED: 'Kết nối shop đã thay đổi. Kiểm tra kết nối rồi tiếp tục lượt đọc.',
  KNOWLEDGE_CONNECTED_PRODUCTION_REQUIRED: 'Chọn một shop thật đã kết nối để đọc thông tin.',
  KNOWLEDGE_CREDENTIALS_INVALID: 'Chưa đọc được thông tin kết nối. Mở Kết nối shop để kiểm tra.',
  KNOWLEDGE_NETWORK_ERROR: 'Chưa đọc được dữ liệu từ Shopee. Tiến độ đã có vẫn được giữ.',
  KNOWLEDGE_READ_REJECTED:
    'Shopee chưa chấp nhận lượt đọc. Kiểm tra kết nối shop trước khi tiếp tục.',
  KNOWLEDGE_REQUEST_CONFLICT:
    'Lượt đọc đã được lưu với lựa chọn khác. Mở lại trang để đọc tiến độ đã lưu.',
  KNOWLEDGE_SYNC_NOT_FOUND: 'Không tìm thấy lượt đọc đã lưu. Mở lại trang để tải danh sách.',
  PRODUCT_SOURCE_DECLARATION: 'Giá trị lấy từ nguồn sản phẩm có ghi nhận xác nhận.',
  HISTORICAL_REFERENCE_ONLY: 'Listing đã đọc chỉ cung cấp thông tin tham khảo.',
  CROSS_SHOP_CONTEXT_ONLY: 'Nguồn thuộc shop khác; chưa dùng để điền cho shop này.',
  PRODUCT_SOURCE_CONFIRMATION_REQUIRED: 'Cần nhãn hoặc xác nhận nguồn của đúng sản phẩm.',
  PARTIAL_SKU_COVERAGE: 'Nguồn chỉ khớp một phần SKU; chưa thể áp dụng cho toàn bộ phân loại.',
  CONFLICTING_VALUES: 'Các nguồn ghi giá trị khác nhau. Cần đối chiếu trước khi chọn.',
  HISTORICAL_DISAGREEMENT:
    'Nguồn sản phẩm đã xác nhận khác listing cũ; giữ ưu tiên nguồn sản phẩm.',
  INVALID_SOURCE_FACT: 'Nguồn khai báo chưa đủ điều kiện hoặc chưa truy vết được.',
  SOURCE_PROVENANCE_REQUIRED: 'Nguồn sản phẩm chưa có thông tin để truy vết và đối chiếu.',
  SOURCE_FACT_LIMIT: 'Nguồn sản phẩm vượt giới hạn đối chiếu của lượt này; kết quả chưa đầy đủ.',
  CANDIDATE_COVERAGE_INCOMPLETE:
    'Chưa kiểm hết listing tham khảo; cần đối chiếu thêm trước khi dùng giá trị từ listing khác.',
  DEPENDENT_MANDATORY_ATTRIBUTE_MISSING:
    'Lựa chọn này cần thêm thông tin bắt buộc liên quan. Bổ sung đủ nguồn trước khi đưa vào bản xem trước.',
  DEPENDENCY_NOT_PREFILLABLE:
    'Thông tin này phụ thuộc một lựa chọn chưa đủ điều kiện đưa vào bản xem trước.',
  INVALID_ATTRIBUTE_DEPENDENCY:
    'Chưa xác minh được quan hệ giữa các thuộc tính ngành. Cần đọc lại thông tin ngành.',
  INACTIVE_ATTRIBUTE: 'Thuộc tính này chưa áp dụng với các lựa chọn hiện tại.',
  INACTIVE_CURRENT_ATTRIBUTE:
    'Giá trị đang lưu chưa áp dụng với lựa chọn hiện tại, nên chưa dùng để xác nhận thông tin liên quan.',
  INVALID_CURRENT_ATTRIBUTE:
    'Một giá trị đang lưu không khớp điều kiện ngành hiện tại; cần đối chiếu lại.',
  CURRENT_ATTRIBUTE_LIMIT: 'Có nhiều thuộc tính đang lưu hơn giới hạn kiểm tra; chưa đối chiếu đủ.',
  METADATA_UNAVAILABLE:
    'Thông tin ngành đã hết thời hạn đối chiếu hoặc không khớp shop và ngành đang chọn. Cần đọc lại.',
  STALE_OBSERVATION: 'Bản thông tin tham khảo đã cũ; cần đọc lại listing trước khi sử dụng.',
  EVIDENCE_TRUNCATED: 'Chỉ một phần nguồn nằm trong giới hạn đối chiếu của lượt này.',
  EVIDENCE_REQUIRED: 'Chưa có bằng chứng để đối chiếu thông tin này.',
  OBSERVATION_ATTRIBUTE_LIMIT:
    'Một listing có quá nhiều thuộc tính để đối chiếu đầy đủ trong lượt này.',
  OBSERVATION_STATUS: 'Trạng thái listing tham khảo chưa phù hợp để dùng làm nguồn đề xuất.',
  UNKNOWN_ATTRIBUTE: 'Thuộc tính này chưa có trong thông tin ngành mới nhất.',
  INAPPLICABLE_ATTRIBUTE: 'Thuộc tính này được xác định không áp dụng cho sản phẩm.',
  UNSUPPORTED_METADATA: 'Chưa hỗ trợ đầy đủ cách nhập của thuộc tính này; cần kiểm tra thủ công.',
  TOO_MANY_VALUES: 'Số giá trị vượt giới hạn của thuộc tính; cần đối chiếu lại nguồn.',
  INVALID_VALUE_TYPE: 'Cách ghi giá trị chưa đúng yêu cầu của thuộc tính.',
  INVALID_VALUE_UNIT: 'Đơn vị chưa khớp yêu cầu của thuộc tính.',
  INVALID_VALUE_ID: 'Giá trị chưa có trong lựa chọn hiện hành của thuộc tính.',
  VALUE_NAME_MISMATCH: 'Tên giá trị không khớp lựa chọn được tham chiếu.',
  EMPTY_VALUE: 'Giá trị trong nguồn đang trống.',
  DUPLICATE_VALUE: 'Nguồn có giá trị trùng cần đối chiếu lại.',
  SELLER_KNOWLEDGE_CATEGORY_REVIEW_REQUIRED:
    'Thông tin ngành còn điểm cần đối chiếu. Chưa thể đưa ra đề xuất.',
  SELLER_KNOWLEDGE_SCOPE_MISMATCH: 'Nguồn không thuộc đúng shop và sản phẩm đã chọn.',
  LISTING_DELETED: 'Listing này đã bị xóa trên Shopee.',
  SHIPPING_FEE_UNAVAILABLE: 'Chưa có phí vận chuyển ước tính; cần đối chiếu vận chuyển riêng.',
  ATTRIBUTE_LIST_NOT_RETURNED:
    'Shopee chưa trả danh sách thuộc tính; chưa thể dùng làm nguồn đề xuất.',
  MODEL_SKU_IDENTITY_INCOMPLETE:
    'SKU phân loại còn trống hoặc trùng; chưa nhận diện đủ mọi phiên bản.',
  ITEM_STATUS_CHANGED_DURING_READ:
    'Trạng thái listing thay đổi trong lúc đọc. Cần đọc lại để đối chiếu.',
};
const shopId = (shop: Shop) => shop.connectionId ?? shop.id ?? '';
const shopName = (shop: Shop) =>
  shop.displayName ?? shop.shopName ?? shop.name ?? `Shop ${shop.scope.shopId}`;
const isActive = (sync: Sync | null) => !!sync && ['queued', 'running'].includes(sync.state);
function issueText(issue: Issue) {
  const text =
    typeof issue === 'string' ? issue : (issue.message ?? issue.reason ?? issue.code ?? '');
  return (
    messages[text] ??
    (/^[A-Z][A-Z0-9_]+$/.test(text) ? 'Thông tin này còn cần đối chiếu nguồn.' : text)
  );
}
function IssueList({ issues }: { issues: Issue[] }) {
  return issues.length ? (
    <ul className="seller-knowledge-issues">
      {issues.map((issue, i) => (
        <li key={i}>{issueText(issue)}</li>
      ))}
    </ul>
  ) : null;
}
function sourceLabel(value: string) {
  if (value === 'product_source' || value === 'confirmed_product_source')
    return 'Nguồn sản phẩm đã xác nhận';
  if (value === 'user_confirmed') return 'Xác nhận của người dùng';
  if (value === 'exact_sku') return 'Listing tham khảo có SKU trùng';
  if (value === 'same_shop') return 'Listing khác trong cùng shop';
  if (value === 'external_context') return 'Nguồn tham khảo ngoài shop';
  if (value === 'seller_observation' || value === 'marketplace_observation')
    return 'Thông tin đã đọc từ listing';
  return 'Nguồn cần đối chiếu';
}
function evidenceAttributes(attributes: unknown[]) {
  return attributes
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const a = raw as Record<string, unknown>;
      const values = a.values ?? a.attribute_value_list;
      const label = a.name ?? a.original_attribute_name ?? a.attribute_name;
      const rendered = Array.isArray(values)
        ? values
            .map((v) => {
              if (!v || typeof v !== 'object') return '';
              const value = v as Record<string, unknown>;
              return [
                value.originalValueName ?? value.original_value_name,
                value.valueUnit ?? value.value_unit,
              ]
                .filter((p) => typeof p === 'string' && p)
                .join(' ');
            })
            .filter(Boolean)
            .join(', ')
        : '';
      return rendered
        ? { label: typeof label === 'string' && label ? label : 'Giá trị đã lưu', value: rendered }
        : null;
    })
    .filter((a): a is { label: string; value: string } => !!a);
}

export function SellerKnowledgePanel() {
  const [shops, setShops] = useState<Shop[]>([]),
    [connectionId, setConnectionId] = useState('');
  const [query, setQuery] = useState(''),
    [categoryId, setCategoryId] = useState('');
  const [sync, setSync] = useState<Sync | null>(null),
    [pollRequested, setPollRequested] = useState(false),
    [pollStopped, setPollStopped] = useState(false);
  const [listings, setListings] = useState<Listing[]>([]),
    [searched, setSearched] = useState(false);
  const [comparison, setComparison] = useState<Comparison | null>(null),
    [evidence, setEvidence] = useState<Evidence | null>(null);
  const [busy, setBusy] = useState<Partial<Record<Task, boolean>>>({}),
    [error, setError] = useState('');
  const [stale, setStale] = useState(false),
    [comparisonStale, setComparisonStale] = useState(false),
    [evidenceStale, setEvidenceStale] = useState(false);
  const generation = useRef(0),
    requests = useRef<Partial<Record<Task, AbortController>>>({});
  const syncIntent = useRef<{ connectionId: string; requestId: string } | null>(null);
  const currentShop = shops.find((s) => shopId(s) === connectionId);

  function cancel(task: Task) {
    requests.current[task]?.abort();
    delete requests.current[task];
    setBusy((b) => ({ ...b, [task]: false }));
  }
  async function request<T>(
    task: Task,
    path: string,
    body: unknown | undefined,
    done: (result: T) => void,
    failed?: () => void,
  ) {
    requests.current[task]?.abort();
    const controller = new AbortController(),
      currentGeneration = generation.current;
    requests.current[task] = controller;
    setBusy((b) => ({ ...b, [task]: true }));
    setError('');
    try {
      const result = await api<T>(path, {
        signal: controller.signal,
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      });
      if (!controller.signal.aborted && generation.current === currentGeneration) done(result);
    } catch (e) {
      if (controller.signal.aborted || generation.current !== currentGeneration) return;
      setError(
        e instanceof RequestError
          ? (messages[e.code] ?? e.message)
          : 'Chưa đọc được kết quả. Thông tin đã có vẫn được giữ.',
      );
      failed?.();
    } finally {
      if (requests.current[task] === controller && generation.current === currentGeneration) {
        delete requests.current[task];
        setBusy((b) => ({ ...b, [task]: false }));
      }
    }
  }
  function loadShops() {
    void request<{ shops: Shop[] }>('shops', '/v1/seller-knowledge/shops', undefined, (result) =>
      setShops(result.shops),
    );
  }
  useEffect(() => {
    loadShops();
    return () => {
      generation.current++;
      Object.values(requests.current).forEach((r) => r?.abort());
    };
  }, []);
  function selectShop(id: string) {
    generation.current++;
    Object.values(requests.current).forEach((r) => r?.abort());
    requests.current = {};
    setBusy({});
    setConnectionId(id);
    setQuery('');
    setCategoryId('');
    setListings([]);
    setSearched(false);
    setComparison(null);
    setEvidence(null);
    setStale(false);
    setComparisonStale(false);
    setEvidenceStale(false);
    setError('');
    setSync(shops.find((s) => shopId(s) === id)?.latestSync ?? null);
    setPollRequested(false);
    setPollStopped(false);
    syncIntent.current = null;
  }
  function acceptSync(result: Sync) {
    setSync(result);
    setShops((old) =>
      old.map((shop) => (shopId(shop) === connectionId ? { ...shop, latestSync: result } : shop)),
    );
  }
  useEffect(() => {
    if (!sync || pollStopped || (!isActive(sync) && !pollRequested)) return;
    const timer = setTimeout(() => {
      void request<Sync>(
        'poll',
        `/v1/seller-knowledge/syncs/${encodeURIComponent(sync.id)}`,
        undefined,
        (result) => {
          acceptSync(result);
          setPollRequested(false);
        },
        () => {
          setPollStopped(true);
          setPollRequested(false);
        },
      );
    }, 1800);
    return () => clearTimeout(timer);
  }, [sync, pollRequested, pollStopped, connectionId]);
  function startSync() {
    if (!connectionId || busy.sync || isActive(sync) || sync?.canResume) return;
    if (syncIntent.current?.connectionId !== connectionId)
      syncIntent.current = { connectionId, requestId: crypto.randomUUID() };
    void request<Sync>(
      'sync',
      '/v1/seller-knowledge/syncs',
      { ...syncIntent.current, maxItems: 100 },
      (result) => {
        acceptSync(result);
        syncIntent.current = null;
        setPollStopped(false);
      },
    );
  }
  function resumeSync() {
    if (!sync || !connectionId || busy.sync) return;
    cancel('poll');
    void request<Sync>(
      'sync',
      `/v1/seller-knowledge/syncs/${encodeURIComponent(sync.id)}/resume`,
      {},
      (result) => {
        acceptSync(result);
        setPollStopped(false);
        setPollRequested(result.state !== 'complete');
      },
    );
  }
  function refreshProgress() {
    if (!sync) return;
    void request<Sync>(
      'poll',
      `/v1/seller-knowledge/syncs/${encodeURIComponent(sync.id)}`,
      undefined,
      (result) => {
        acceptSync(result);
        setPollStopped(false);
      },
      () => setPollStopped(true),
    );
  }
  function search() {
    if (!connectionId) return;
    cancel('compare');
    cancel('evidence');
    const params = new URLSearchParams({ connectionId, query: query.trim(), limit: '30' });
    if (categoryId) params.set('categoryId', categoryId);
    void request<{ listings: Listing[] }>(
      'search',
      `/v1/seller-knowledge/search?${params}`,
      undefined,
      (result) => {
        setListings(result.listings);
        setSearched(true);
        setStale(false);
        setComparison(null);
        setEvidence(null);
        setComparisonStale(false);
        setEvidenceStale(false);
      },
      () => {
        setStale(true);
        setComparisonStale(true);
      },
    );
  }
  function compare(listing: Listing) {
    cancel('evidence');
    void request<Comparison>(
      'compare',
      '/v1/seller-knowledge/recommendations',
      { connectionId, evidenceId: listing.evidenceId },
      (result) => {
        setComparison(result);
        setComparisonStale(false);
        setEvidence(null);
        setEvidenceStale(false);
      },
      () => setComparisonStale(true),
    );
  }
  function readEvidence(id: string) {
    void request<Evidence | null>(
      'evidence',
      `/v1/seller-knowledge/evidence/${encodeURIComponent(id)}`,
      undefined,
      (result) => {
        if (!result || result.connectionId !== connectionId) {
          setError('Nguồn không thuộc shop đang chọn. Hãy đối chiếu lại.');
          setEvidenceStale(true);
          return;
        }
        setEvidence(result);
        setEvidenceStale(false);
      },
      () => setEvidenceStale(true),
    );
  }
  const syncLabels: Record<string, string> = {
    queued: 'Đang chờ đọc',
    running: 'Đang đọc thông tin',
    paused: 'Đã lưu tiến độ, còn sản phẩm chưa đọc',
    complete: 'Đã đọc hết danh sách',
    failed: 'Lượt đọc cần kiểm tra',
  };
  return (
    <section className="panel seller-knowledge" aria-labelledby="seller-knowledge-heading">
      <div className="section-heading">
        <div>
          <h2 id="seller-knowledge-heading">Thông tin từ shop</h2>
          <p className="caption">
            Đọc các listing đã có để tìm thông tin tham khảo theo đúng shop và ngành.
          </p>
        </div>
        <span className="tag neutral">Chỉ đọc Shopee</span>
      </div>
      <p>
        Thông tin trên listing là bằng chứng tại thời điểm đọc. Hãy đối chiếu nguồn sản phẩm trước
        khi sử dụng cho sản phẩm khác.
      </p>
      {error && (
        <p role="alert" className="issue block">
          {error}
        </p>
      )}
      <label htmlFor="seller-knowledge-shop">Shop cần tra cứu</label>
      <div className="knowledge-search">
        <select
          id="seller-knowledge-shop"
          value={connectionId}
          onChange={(e) => selectShop(e.target.value)}
        >
          <option value="">Chọn shop đã kết nối</option>
          {shops.map((shop) => (
            <option key={shopId(shop)} value={shopId(shop)}>
              {shopName(shop)}
            </option>
          ))}
        </select>
        <button disabled={!!busy.shops} onClick={loadShops}>
          Tải lại danh sách shop
        </button>
      </div>
      {!busy.shops && !shops.length && (
        <p className="caption">Chưa có shop để tra cứu. Mở Kết nối shop để kiểm tra kết nối.</p>
      )}
      {currentShop && (
        <>
          <div className="seller-knowledge-sync">
            <div>
              <strong>{shopName(currentShop)}</strong>
              <p className="caption">
                Mỗi lượt đọc tối đa 100 sản phẩm và lưu vị trí để tiếp tục. Không đăng hoặc sửa sản
                phẩm.
              </p>
            </div>
            <button
              disabled={!!busy.sync || isActive(sync) || !!sync?.canResume}
              onClick={startSync}
            >
              {busy.sync && !sync ? 'Đang mở lượt đọc…' : 'Đọc thông tin từ shop'}
            </button>
          </div>
          {sync && (
            <div className="seller-knowledge-progress" aria-live="polite">
              <strong>{syncLabels[sync.state] ?? 'Đã lưu lượt đọc'}</strong>
              <p>{sync.processedCount} sản phẩm đã xử lý</p>
              <p className="caption">
                {sync.fetchedCount} đọc mới · {sync.reusedCount} chưa thay đổi
              </p>
              <IssueList issues={[...(sync.code ? [sync.code] : []), ...(sync.issues ?? [])]} />
              {pollStopped && (
                <p className="issue warn">
                  Chưa cập nhật được tiến độ. Lượt đọc có thể vẫn đang chạy.
                </p>
              )}
              <div className="actions">
                {sync.canResume && (!isActive(sync) || pollStopped) && (
                  <button disabled={!!busy.sync || !!busy.poll} onClick={resumeSync}>
                    Tiếp tục lượt đọc
                  </button>
                )}
                {(isActive(sync) || pollStopped) && (
                  <button disabled={!!busy.poll || !!busy.sync} onClick={refreshProgress}>
                    Đọc lại tiến độ
                  </button>
                )}
              </div>
            </div>
          )}
          <form
            className="seller-knowledge-form"
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <label htmlFor="seller-knowledge-query">Tên sản phẩm hoặc SKU</label>
            <div className="knowledge-search">
              <input
                id="seller-knowledge-query"
                value={query}
                maxLength={200}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ví dụ: xịt khử mùi thảm, VTTDPL100"
              />
              <button disabled={!!busy.search}>{busy.search ? 'Đang tìm…' : 'Tìm sản phẩm'}</button>
            </div>
            {!!currentShop.categories?.length && (
              <>
                <label htmlFor="seller-knowledge-category">Ngành đã đọc</label>
                <select
                  id="seller-knowledge-category"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  <option value="">Tất cả ngành đã đọc</option>
                  {currentShop.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name || 'Ngành chưa có tên'} ({category.count})
                    </option>
                  ))}
                </select>
              </>
            )}
          </form>
          {stale && listings.length > 0 && (
            <p className="issue warn">
              Kết quả trước vẫn được giữ; chưa cập nhật được theo lượt tìm mới.
            </p>
          )}
          {searched && !listings.length && <p>Chưa có sản phẩm phù hợp trong dữ liệu đã đọc.</p>}
          {!!listings.length && (
            <div className="seller-knowledge-list">
              {listings.map((listing) => (
                <article key={listing.evidenceId}>
                  <div>
                    <h3>
                      {listing.title ||
                        (listing.itemStatus?.endsWith('_DELETE')
                          ? 'Listing đã xóa'
                          : 'Sản phẩm chưa có tên')}
                    </h3>
                    <p className="caption">
                      {listing.itemStatus?.endsWith('_DELETE')
                        ? `Shopee ghi nhận đã xóa · Mã listing ${listing.itemId}`
                        : listing.itemStatus === 'NORMAL'
                          ? 'Đang mở bán'
                          : listing.itemStatus === 'UNLIST'
                            ? 'Đang ẩn trên Shopee'
                            : 'Trạng thái cần đối chiếu'}
                    </p>
                    <p className="caption">
                      Đọc lúc {date(listing.observedAt)} · {listing.modelSkus.length} SKU phân loại
                    </p>
                    {listing.itemSku && <p className="caption">SKU: {listing.itemSku}</p>}
                    <IssueList issues={listing.issues ?? []} />
                  </div>
                  {listing.itemStatus?.endsWith('_DELETE') ? (
                    <button
                      aria-label={`Xem dấu vết đã xóa ${listing.itemId}`}
                      disabled={!!busy.evidence || !!busy.search || stale}
                      onClick={() => readEvidence(listing.evidenceId)}
                    >
                      Xem dấu vết đã xóa
                    </button>
                  ) : (
                    <button
                      aria-label={`Đối chiếu thông tin ${listing.title}`}
                      disabled={!!busy.compare || !!busy.search || stale}
                      onClick={() => compare(listing)}
                    >
                      Đối chiếu thông tin
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
          {comparison && (
            <div className="seller-knowledge-comparison" aria-live="polite">
              <h3>Đối chiếu: {comparison.target.title}</h3>
              {comparison.candidateCoverage?.truncated && (
                <p className="issue warn">
                  Lượt này lấy tối đa {comparison.candidateCoverage.limit} trong{' '}
                  {comparison.candidateCoverage.totalCount} listing tham khảo. Chưa thể kết luận mọi
                  nguồn đều thống nhất. Nguồn sản phẩm đã xác nhận được xét riêng.
                </p>
              )}
              {comparisonStale && (
                <p className="issue warn">
                  Kết quả đối chiếu trước vẫn được giữ; lần đọc mới chưa hoàn tất.
                </p>
              )}
              <IssueList issues={comparison.recommendations.issues ?? []} />
              {!!comparison.recommendations.missingMandatoryAttributeIds?.length && (
                <p className="issue warn">
                  Còn {comparison.recommendations.missingMandatoryAttributeIds.length} thông tin bắt
                  buộc chưa đủ nguồn.
                </p>
              )}
              {!comparison.recommendations.suggestions.length && (
                <p>Chưa có thông tin tham khảo phù hợp để đề xuất.</p>
              )}
              {comparison.recommendations.suggestions.map((suggestion, i) => (
                <article
                  className="seller-knowledge-suggestion"
                  key={`${suggestion.attributeId}-${i}`}
                >
                  <h4>{suggestion.name}</h4>
                  <p>
                    {suggestion.values
                      .map((value) =>
                        [
                          value.displayName || value.originalValueName || 'Giá trị chưa có tên',
                          value.valueUnit,
                        ]
                          .filter(Boolean)
                          .join(' '),
                      )
                      .join(', ') || 'Chưa chọn giá trị vì nguồn còn điểm cần đối chiếu.'}
                  </p>
                  <span className="tag neutral">
                    {suggestion.canPrefill
                      ? 'Có thể đưa vào bản xem trước'
                      : 'Cần xác nhận trước khi dùng'}
                  </span>
                  <p className="caption">{sourceLabel(suggestion.sourceClass)}</p>
                  {suggestion.coverage && suggestion.coverage.targetSkuCount > 0 && (
                    <p className="caption">
                      Nguồn khớp {suggestion.coverage.matchedSkuCount}/
                      {suggestion.coverage.targetSkuCount} SKU của sản phẩm.
                    </p>
                  )}
                  <IssueList issues={suggestion.reasons ?? []} />
                  {suggestion.sourceClass === 'product_source' &&
                    (comparison.sourceFacts ?? [])
                      .filter((fact) => String(fact.attributeId) === String(suggestion.attributeId))
                      .map((fact) => (
                        <p key={fact.sourceId} className="caption">
                          Nguồn: {fact.sourceLocator}
                        </p>
                      ))}
                  <div className="actions">
                    {suggestion.sourceClass !== 'product_source' &&
                      suggestion.evidenceIds.map((id, index) => (
                        <button
                          key={id}
                          disabled={!!busy.evidence || comparisonStale}
                          onClick={() => readEvidence(id)}
                        >
                          {suggestion.evidenceIds.length === 1
                            ? 'Xem nguồn tham khảo'
                            : `Xem nguồn tham khảo ${index + 1}`}
                        </button>
                      ))}
                  </div>
                </article>
              ))}
            </div>
          )}
          {evidence && (
            <div className="seller-knowledge-evidence" aria-live="polite">
              <div className="section-heading">
                <h3>Nguồn tham khảo</h3>
                <button
                  onClick={() => {
                    cancel('evidence');
                    setEvidence(null);
                  }}
                >
                  Đóng nguồn
                </button>
              </div>
              {evidenceStale && (
                <p className="issue warn">
                  Đang giữ bản nguồn trước; chưa đọc được bản vừa yêu cầu.
                </p>
              )}
              <strong>
                {evidence.body.title ||
                  (String(evidence.body.itemStatus ?? '').endsWith('_DELETE')
                    ? 'Listing đã xóa — chỉ còn dấu vết trạng thái'
                    : 'Bản thông tin đã lưu')}
              </strong>
              <p className="caption">
                {shopName(currentShop)} · Đọc lúc {date(evidence.observedAt)}
              </p>
              <p className="caption">
                Nội dung đã đọc từ listing; chưa phải xác nhận áp dụng cho sản phẩm đang đối chiếu.
              </p>
              <dl>
                {evidenceAttributes(evidence.body.attributes ?? []).map((a, index) => (
                  <div key={index}>
                    <dt>{a.label}</dt>
                    <dd>{a.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </>
      )}
    </section>
  );
}
