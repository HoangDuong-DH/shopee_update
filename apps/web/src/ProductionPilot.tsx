import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  ImageOff,
  LoaderCircle,
  RefreshCw,
  Store,
  Upload,
} from 'lucide-react';
import { z } from 'zod';
import { api, money } from './api.js';
import './production-pilot.css';

const count = z.number().int().nonnegative();
const countsSchema = z.object({
  total: count,
  acknowledged: count,
  sent: count,
  unknown: count,
  rejected: count,
  uploadsAcknowledged: count.optional(),
  createsAcknowledged: count.optional(),
  modelsAcknowledged: count.optional(),
});
const attemptSchema = z.object({
  operationId: z.string(),
  sourceIdentity: z.string(),
  sourceRevision: count,
  itemId: z.union([z.string(), z.number()]).nullish(),
  state: z.string(),
  publicationState: z.string().nullish(),
  rejectionClosed: z.boolean(),
  reasonCode: z.string().nullish(),
  requestId: z.string().nullish(),
  stepCounts: countsSchema,
});
const listingSchema = z.object({
  sourceKey: z.string(),
  sourceRevision: count.optional(),
  title: z.string(),
  skuCount: count,
  coverImportId: z.string(),
  models: z.array(
    z.object({
      sku: z.string(),
      label: z.string(),
      originalPrice: z.string().regex(/^\d+$/),
      stock: count,
      weightGrams: z.number().nonnegative(),
    }),
  ),
  operationId: z.string().nullish(),
  itemId: z.union([z.string(), z.number().int().positive()]).nullish(),
  state: z.string(),
  publicationState: z.string().nullish(),
  lastCode: z.string().nullish(),
  reasonCode: z.string().nullish(),
  stepCounts: countsSchema,
});
const statusSchema = z.object({
  enabled: z.boolean(),
  active: z.boolean(),
  phase: z.string(),
  code: z.string().nullish(),
  canStart: z.boolean(),
  remainingCount: count.optional(),
  continuationKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  continuationKind: z.enum(['initial', 'remaining', 'reconcile']).optional(),
  startBlockedCode: z.string().nullish(),
  historicalAttempts: z.array(attemptSchema).default([]),
  sourceReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  shop: z.object({ shopId: z.string(), name: z.string() }),
  listings: z.array(listingSchema),
});
type PilotStatus = z.infer<typeof statusSchema>;
type PilotListing = z.infer<typeof listingSchema>;
const attemptKey = (hash: string) => 'shopee.production-pilot.start.' + hash;
const currentAttemptKey = (status: PilotStatus) =>
  attemptKey(status.continuationKey ?? status.sourceReceiptSha256);
const attentionStates = new Set(['unknown', 'rejected', 'blocked', 'failed', 'mismatch']);
const explanations: Record<string, string> = {
  DESC_IMAGES_NOT_ALLOWED:
    'Shopee chưa cho phép chèn ảnh trong mô tả của shop này. Lần gửi và ảnh gốc được giữ lại; việc đổi nội dung cần một phiên bản nguồn riêng đã được chốt.',
  DESCRIPTION_IMAGES_NOT_ALLOWED:
    'Shopee chưa cho phép chèn ảnh trong mô tả của shop này. Nguồn và biên nhận được giữ lại để xử lý; ứng dụng không tự bỏ ảnh hoặc gửi lại.',
  PRODUCTION_PILOT_SOURCE_CHANGED:
    'Bộ nguồn đã có phiên bản mới. Tải lại trạng thái để xem đúng nội dung trước khi thực hiện.',
  PRODUCTION_PILOT_CONTINUATION_CHANGED:
    'Kết quả đã thay đổi. Tải lại trạng thái để xem chính xác phần còn lại trước khi tiếp tục.',
  PRODUCTION_PILOT_RECONCILIATION_REQUIRED:
    'Đã có lần thực hiện cần đối chiếu. Theo dõi kết quả đã lưu; ứng dụng không tạo lại listing.',
  PRODUCTION_PILOT_COVER_CASE_UNVERIFIED:
    'Shopee đã xử lý lại ảnh bìa. Cần đối chiếu ảnh trả về với ảnh nguồn trước khi xác nhận đúng nội dung và tiếp tục. Kết quả hiện chưa được xác nhận đạt.',
  READBACK_MISMATCH:
    'Giá trị đọc lại từ Shopee chưa khớp bộ nguồn, ví dụ giá, tồn hoặc cân nặng. Cần kiểm tra phần lệch trước khi tiếp tục; ứng dụng giữ nguyên nguồn đã chốt.',
  PUBLICATION_READBACK_MISMATCH:
    'Kết quả đọc lại sau yêu cầu mở bán chưa khớp đầy đủ với bộ nguồn hoặc trạng thái mong muốn. Cần đối chiếu lại trước khi xác nhận đã hoàn tất.',
  PRODUCTION_PILOT_DISABLED:
    'Đợt đăng này chưa được bật thực hiện. Bộ nguồn vẫn được giữ để đối chiếu.',
};
function listingState(listing: PilotListing) {
  if (listing.publicationState === 'verified') return 'Đã mở bán, đối chiếu đạt';
  if (listing.publicationState)
    return attentionStates.has(listing.publicationState)
      ? 'Chờ xử lý kết quả mở bán'
      : 'Đang đối chiếu mở bán';
  if (listing.state === 'verified') return 'Đã tạo ẩn, đối chiếu đạt';
  if (listing.state === 'unknown' && !listing.itemId) return 'Chưa xác nhận được kết quả tạo';
  if (attentionStates.has(listing.state))
    return listing.itemId ? 'Cần đối chiếu listing đã tạo' : 'Chưa có listing được tạo';
  if (listing.itemId) return 'Đã nhận mã listing, chờ đối chiếu';
  return listing.operationId ? 'Đang xử lý nguồn và ảnh' : 'Chưa gửi đăng';
}
function phaseLabel(status: PilotStatus) {
  if (!status.active && status.phase === 'partial_complete') {
    const published = status.listings.filter(
      (listing) =>
        listing.state === 'verified' && listing.publicationState === 'verified' && listing.itemId,
    ).length;
    const unsent = status.listings.filter((listing) => !listing.operationId).length;
    return `Đã đăng ${published} listing; ${unsent} listing chưa gửi`;
  }
  if (!status.active)
    return status.listings.some((l) => l.operationId)
      ? 'Kết quả đợt đăng'
      : 'Bộ listing sẵn sàng để kiểm tra';
  return (
    (
      {
        checking: 'Đang kiểm tra điều kiện đăng',
        uploading: 'Đang tải ảnh gốc',
        creating: 'Đang tạo listing ẩn',
        verifying: 'Đang đọc lại để đối chiếu',
        publishing: 'Đang mở bán và đối chiếu',
      } as Record<string, string>
    )[status.phase] ?? 'Đang xử lý đợt đăng'
  );
}

/** UI for the frozen, approved pilot sources. Every write goes through the backend journal. */
export function ProductionPilot() {
  const [status, setStatus] = useState<PilotStatus | null>(null);
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(false);
  const [starting, setStarting] = useState(false),
    [attempted, setAttempted] = useState(false);
  const [startError, setStartError] = useState('');
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true),
    startGuard = useRef(false);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    try {
      const value = statusSchema.parse(
        await api<unknown>('/v1/production-pilot/status', {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
        }),
      );
      if (!mounted.current || request.signal.aborted) return;
      setStatus(value);
      setLoadError(false);
      try {
        const held = sessionStorage.getItem(currentAttemptKey(value)) === 'sent';
        setAttempted(held);
        if (!value.active && value.canStart) startGuard.current = held;
      } catch {
        setAttempted(true);
      }
    } catch {
      if (mounted.current && !request.signal.aborted) setLoadError(true);
    } finally {
      if (mounted.current && !request.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    if (!status?.active) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [status?.active, refresh]);
  const existing = status?.listings.some((l) => l.operationId) ?? false;
  const remainingCount = status?.remainingCount ?? status?.listings.length ?? 0;
  const continuation = Boolean(
    status?.continuationKey && ['remaining', 'reconcile'].includes(status.continuationKind ?? ''),
  );
  const disabled =
    !status?.enabled ||
    !status.canStart ||
    !remainingCount ||
    status.active ||
    (existing && !continuation) ||
    loading ||
    loadError ||
    starting ||
    attempted;
  async function start() {
    if (disabled || !status || startGuard.current) return;
    startGuard.current = true;
    setStarting(true);
    setStartError('');
    try {
      // The server's remaining-work key changes only when its durable plan changes. An uncertain
      // attempt for the same remaining work stays held across reload; completed work is not resent.
      sessionStorage.setItem(currentAttemptKey(status), 'sent');
      setAttempted(true);
      const result = await api<{ started: boolean }>('/v1/production-pilot/start', {
        method: 'POST',
        body: JSON.stringify({
          sourceReceiptSha256: status.sourceReceiptSha256,
          ...(status.continuationKey ? { continuationKey: status.continuationKey } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (result.started !== true) throw new Error('Unconfirmed start');
      if (mounted.current) await refresh();
    } catch {
      if (mounted.current)
        setStartError(
          'Chưa xác nhận được yêu cầu bắt đầu. Giữ lần thực hiện này và tải lại trạng thái để đối chiếu; không bấm đăng lại.',
        );
    } finally {
      if (mounted.current) setStarting(false);
    }
  }
  const totalSkus = status?.listings.reduce((sum, l) => sum + l.skuCount, 0) ?? 0;
  return (
    <section className="production-pilot" aria-labelledby="production-pilot-title">
      <header className="production-pilot-heading">
        <div>
          <span className="production-pilot-eyebrow">ĐĂNG BỘ NGUỒN ĐÃ CHỐT</span>
          <h1 id="production-pilot-title">Đăng listing đã chuẩn bị</h1>
          <p>Kiểm tra bộ nguồn, gửi bằng API và theo dõi từng listing ngay tại đây.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading || starting}>
          <RefreshCw size={16} className={loading ? 'production-pilot-spin' : ''} /> Tải lại trạng
          thái
        </button>
      </header>
      {loadError && (
        <p className="production-pilot-notice is-error" role="alert">
          Chưa tải được trạng thái mới. Thông tin đang hiển thị là lần đọc trước; thao tác đăng được
          giữ lại đến khi kết nối trở lại.
        </p>
      )}
      {startError && (
        <p className="production-pilot-notice is-error" role="alert">
          {startError}
        </p>
      )}
      {!status ? (
        <p className="production-pilot-notice" role="status">
          {loading
            ? 'Đang đọc bộ nguồn và kết quả đã lưu…'
            : 'Chưa đọc được đợt đăng. Bấm Tải lại trạng thái.'}
        </p>
      ) : (
        <>
          <div className="production-pilot-target">
            <div className="production-pilot-shop">
              <Store size={23} />
              <div>
                <small>Shop nhận sản phẩm · SHOP THẬT</small>
                <strong>{status.shop.name}</strong>
                <span>ID {status.shop.shopId}</span>
              </div>
            </div>
            <div className="production-pilot-source-count">
              <strong>
                {status.listings.length} listing · {totalSkus} phân loại
              </strong>
              <span>Ảnh, nội dung, giá và tồn theo bộ đã chốt</span>
            </div>
          </div>
          <div className="production-pilot-status" role="status">
            {status.active ? (
              <LoaderCircle size={19} className="production-pilot-spin" />
            ) : (
              <CheckCircle2 size={19} />
            )}
            <strong>{phaseLabel(status)}</strong>
            {status.active && <span>Cập nhật mỗi 5 giây</span>}
          </div>
          {(status.code || status.startBlockedCode) && (
            <p className="production-pilot-notice is-attention">
              {explanations[(status.code || status.startBlockedCode)!] ??
                'Đợt đăng cần được kiểm tra trước khi tiếp tục. Nguồn và các kết quả đã nhận vẫn được giữ lại.'}
            </p>
          )}
          <div className="production-pilot-listings">
            {status.listings.map((listing) => (
              <PilotCard key={listing.sourceKey} listing={listing} />
            ))}
          </div>
          <footer className="production-pilot-actions">
            <div>
              <strong>Tạo ẩn → Đối chiếu → Mở bán → Đọc lại</strong>
              <p>
                {continuation && status.canStart
                  ? status.continuationKind === 'reconcile'
                    ? 'Tiếp tục đọc lại kết quả đã nhận. Chỉ mở bán sau khi đối chiếu đạt; các listing hoàn tất được giữ nguyên.'
                    : 'Chỉ gửi các listing chưa thực hiện. Listing đã mở bán và đối chiếu đạt được giữ nguyên.'
                  : existing
                    ? 'Đã có lần thực hiện. Xem kết quả từng listing và tải lại trạng thái để theo dõi.'
                    : attempted
                      ? 'Yêu cầu đã được ghi nhận tại trình duyệt. Đối chiếu trạng thái trước khi xử lý tiếp.'
                      : !status.enabled
                        ? 'Đợt đăng chưa được bật thực hiện.'
                        : 'Nút này thực hiện trên shop thật hiển thị ở trên, theo đúng bộ nguồn đã chốt.'}
              </p>
            </div>
            <button
              type="button"
              className="primary"
              disabled={disabled}
              onClick={() => void start()}
            >
              {starting ? (
                <LoaderCircle size={18} className="production-pilot-spin" />
              ) : (
                <Upload size={18} />
              )}
              {continuation
                ? status.continuationKind === 'reconcile'
                  ? 'Đối chiếu và tiếp tục phần còn lại'
                  : `Tiếp tục ${remainingCount} listing còn lại`
                : `Đăng ${status.listings.length} listing bằng API`}
            </button>
          </footer>
          <p className="production-pilot-scope">
            Phạm vi màn hình này: {status.listings.length} listing đang hiển thị. Biên nhận gửi ảnh
            hoặc tạo listing chưa phải kết quả đối chiếu hoàn tất.
          </p>
          {status.historicalAttempts.length > 0 && (
            <section className="production-pilot-history" aria-label="Lịch sử các phiên bản nguồn">
              <h2>Lần thực hiện trước</h2>
              {status.historicalAttempts.map((attempt) => (
                <article key={attempt.operationId}>
                  <div className="production-pilot-history-heading">
                    <strong>Phiên bản nguồn {attempt.sourceRevision}</strong>
                    <span className="production-pilot-badge">
                      {attempt.rejectionClosed
                        ? 'Đã đối chiếu và đóng lần bị từ chối'
                        : 'Còn kết quả cần đối chiếu'}
                    </span>
                  </div>
                  {attempt.reasonCode && (
                    <p>
                      {explanations[attempt.reasonCode] ??
                        'Giữ lịch sử lần thực hiện này để đối chiếu với bộ nguồn hiện tại.'}
                    </p>
                  )}
                  <div className="production-pilot-receipts">
                    <span>
                      {attempt.stepCounts.uploadsAcknowledged === undefined
                        ? `${attempt.stepCounts.acknowledged} bước đã nhận biên nhận`
                        : `${attempt.stepCounts.uploadsAcknowledged} ảnh đã nhận biên nhận`}
                    </span>
                    <span>
                      {attempt.itemId
                        ? `Mã listing: ${attempt.itemId}`
                        : 'Không có mã listing trong biên nhận đã lưu'}
                    </span>
                  </div>
                  {attempt.requestId && (
                    <details>
                      <summary>Mã đối chiếu lần thực hiện</summary>
                      <code>{attempt.requestId}</code>
                    </details>
                  )}
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}

function PilotCard({ listing }: { listing: PilotListing }) {
  const [imageFailed, setImageFailed] = useState(false);
  const verified = listing.publicationState === 'verified';
  const attention =
    attentionStates.has(listing.state) || attentionStates.has(listing.publicationState ?? '');
  const itemId =
    listing.itemId === null || listing.itemId === undefined ? '' : String(listing.itemId);
  const itemUrl = /^[1-9]\d*$/.test(itemId)
    ? 'https://banhang.shopee.vn/portal/product/' + itemId
    : undefined;
  const prices = listing.models.map((m) => BigInt(m.originalPrice));
  const min = prices.length ? prices.reduce((a, b) => (a < b ? a : b)) : undefined;
  const max = prices.length ? prices.reduce((a, b) => (a > b ? a : b)) : undefined;
  const priceLabel =
    min === undefined
      ? 'Chưa có giá'
      : min === max
        ? money(String(min))
        : `${money(String(min))} – ${money(String(max))}`;
  const stockValues = new Set(listing.models.map((m) => m.stock));
  return (
    <article className="production-pilot-card">
      <div className="production-pilot-card-head">
        <div className="production-pilot-cover">
          {imageFailed ? (
            <ImageOff aria-label="Chưa tải được ảnh bìa" size={30} />
          ) : (
            <img
              src={'/v1/production-pilot/assets/' + encodeURIComponent(listing.coverImportId)}
              alt={'Ảnh bìa của ' + listing.title}
              onError={() => setImageFailed(true)}
            />
          )}
        </div>
        <div className="production-pilot-card-content">
          <span
            className={
              'production-pilot-badge' +
              (verified ? ' is-verified' : attention ? ' is-attention' : '')
            }
          >
            {listingState(listing)}
          </span>
          <h2>{listing.title}</h2>
          <dl className="production-pilot-facts">
            <div>
              <dt>Giá gốc</dt>
              <dd>{priceLabel}</dd>
            </div>
            <div>
              <dt>Tồn đăng bán</dt>
              <dd>
                {stockValues.size === 1
                  ? `${listing.models[0]!.stock.toLocaleString('vi-VN')} / phân loại`
                  : 'Theo từng phân loại'}
              </dd>
            </div>
            <div>
              <dt>Phân loại</dt>
              <dd>{listing.skuCount}</dd>
            </div>
          </dl>
        </div>
      </div>
      {(listing.reasonCode || listing.lastCode) && (
        <p className="production-pilot-card-message">
          {explanations[(listing.reasonCode || listing.lastCode)!] ??
            'Có phần cần đối chiếu. Giữ nguyên lần thực hiện này để kiểm tra kết quả.'}
        </p>
      )}
      {listing.operationId && (
        <div className="production-pilot-receipts">
          <span>{listing.stepCounts.acknowledged} bước đã nhận biên nhận</span>
          {listing.stepCounts.sent > 0 && <span>{listing.stepCounts.sent} bước chờ phản hồi</span>}
          {listing.stepCounts.unknown > 0 && (
            <span>{listing.stepCounts.unknown} bước chưa rõ kết quả</span>
          )}
          {listing.stepCounts.rejected > 0 && (
            <span>{listing.stepCounts.rejected} bước bị từ chối</span>
          )}
          {!itemId && <span>Chưa có mã listing</span>}
        </div>
      )}
      <details className="production-pilot-models">
        <summary>Xem {listing.skuCount} phân loại</summary>
        <div
          className="production-pilot-table-scroll"
          tabIndex={0}
          aria-label={'Bảng phân loại của ' + listing.title}
        >
          <table>
            <thead>
              <tr>
                <th>Phân loại</th>
                <th>SKU</th>
                <th>Giá gốc</th>
                <th>Tồn đăng bán</th>
                <th>Cân nặng</th>
              </tr>
            </thead>
            <tbody>
              {listing.models.map((m) => (
                <tr key={m.sku}>
                  <th scope="row">{m.label}</th>
                  <td>{m.sku}</td>
                  <td>{money(m.originalPrice)}</td>
                  <td>{m.stock.toLocaleString('vi-VN')}</td>
                  <td>{m.weightGrams.toLocaleString('vi-VN')} g</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {itemUrl && (
        <a
          className="production-pilot-item-link"
          href={itemUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Mở trong Kênh Người Bán <ExternalLink size={14} />
        </a>
      )}
    </article>
  );
}
