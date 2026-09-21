import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  RefreshCw,
  Upload,
  FolderCheck,
  SearchCheck,
  Search,
  ChevronRight,
  ArrowRight,
  EyeOff,
  ExternalLink,
} from 'lucide-react';
import { z } from 'zod';
import { api, RequestError } from './api.js';
import './production-pilot.css';
import './production-batches.css';

const listing = z.object({
  sourceKey: z.string(),
  title: z.string(),
  modelCount: z.number(),
  state: z.string(),
  itemId: z.string().nullable().optional(),
  acknowledgedSteps: z.number(),
  totalSteps: z.number(),
  canPublish: z.boolean().optional(),
  imageQcStatus: z.string().optional(),
  productKey: z.string().optional(),
  excluded: z.boolean().optional(),
  canExclude: z.boolean().optional(),
  canExecute: z.boolean().optional(),
  currentSource: z.enum(['current', 'source_changed', 'archived']).optional(),
  currentRevision: z.number().optional(),
});
const batch = z.object({
  batchId: z.string(),
  blockingWork:z.object({blocksExecution:z.boolean().optional(),operationId:z.string(),itemId:z.string().nullable(),title:z.string(),batchId:z.string().optional(),sourceKey:z.string().optional(),state:z.literal('awaiting_reconciliation')}).optional(),
  name: z.string().optional(),
  state: z.string(),
  code: z.string().optional(),
  statusFingerprint: z.string().optional(),
  shopName: z.string().optional(),
  partnerId: z.string().optional(),
  shopId: z.string().optional(),
  listings: z.array(listing),
  publishedCount: z.number().optional(),
  publicationMode: z.enum(['hidden_for_review', 'publish_after_verification']).optional(),
  completionTarget: z.enum(['created_hidden', 'published']).optional(),
  imageQcPolicy: z.enum(['required', 'defer_image_qc']).optional(),
  imageQcPendingCount: z.number().optional(),
  createdVerifiedCount: z.number().optional(),
  hiddenVerifiedCount: z.number().optional(),
  completedCount: z.number().optional(),
  remainingCount: z.number().optional(),
  excludedCount: z.number().optional(),
  busy: z.boolean().optional(),
  interrupted: z.boolean().optional(),
  interruptedInspection: z.boolean().optional(),
  acceptedStatusFingerprints: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  executionEnabled: z.boolean().optional(),
  holdReason: z.string().optional(),
  canExecute: z.boolean(),
  canReconcile: z.boolean().optional(),
  lastResult: z
    .object({
      stopped: z.boolean(),
      code: z.string().optional(),
      listings: z.array(
        z.object({ sourceKey: z.string(), state: z.string(), code: z.string().optional() }),
      ),
    })
    .nullable()
    .optional(),
});
type Batch = z.infer<typeof batch>;
const labels: Record<string, string> = {
  not_sent: 'Chưa gửi',
  inspected: 'Kiểm tra nguồn đạt',
  blocked: 'Cần xử lý trước khi tiếp tục',
  created_readback_pending: 'Đã tạo, cần đối chiếu',
  created_unlisted: 'Đã đối chiếu, chưa mở bán',
  created_hidden_image_qc_deferred: 'Đã tạo ẩn · Ảnh chưa QC',
  publication_readback_pending: 'Đã yêu cầu mở bán, cần đối chiếu',
  published: 'Đã mở bán, đối chiếu đạt',
  sent: 'Đang xác định kết quả gửi',
  unknown: 'Chưa xác định kết quả',
  rejected: 'Shopee đã từ chối',
  needs_review: 'Cần kiểm tra nhật ký',
  authorized_not_started: 'Đã chuẩn bị, chưa gửi',
  excluded: 'Đã loại khỏi đợt · chưa gửi',
};
function explanation(code?: string, deferImages = false) {
  if (code?.includes('SHOP_BUSY'))
    return 'Shop còn một công việc đã tạo link nhưng chưa đối chiếu xong. Mở công việc đang giữ lượt để tiếp tục; lô mới chưa gửi sản phẩm.';
  if (code?.includes('METADATA') && code?.includes('EXPIRED'))
    return 'Thông tin ngành hoặc quyền shop đã hết thời gian kiểm tra. Ứng dụng cần đọc lại trước khi gửi; không cần nhập lại ảnh, nội dung hay SKU.';
  if (code?.includes('SIZE_CHART'))
    return 'Ngành đã chọn yêu cầu bảng kích thước. Bộ nguồn hiện chưa đủ dữ liệu này, nên listing chưa được gửi.';
  if (code?.includes('COVER_CASE'))
    return deferImages
      ? 'Lần trước dừng ở bước QC ảnh bìa. Bạn đã chọn hoãn QC ảnh; bấm “Tiếp tục listing này” để kiểm dữ liệu và tiếp tục giữ ẩn. Ảnh chưa được xác nhận đạt.'
      : 'Shopee đã xử lý lại ảnh bìa. Cần đối chiếu ảnh trả về với ảnh nguồn trước khi tiếp tục.';
  if (code?.includes('ATTRIBUTE_DATE_READBACK_UNSUPPORTED'))
    return 'Thuộc tính ngày chưa được hỗ trợ đối chiếu sau đăng. Listing chưa được gửi; giữ nguyên ngày trong nguồn để xử lý.';
  if (code?.includes('READBACK'))
    return 'Dữ liệu đọc lại chưa khớp nguồn. Kiểm tra ảnh, giá, tồn, phân loại và cân nặng; ứng dụng giữ nguyên nguồn để đối chiếu.';
  if (code?.includes('AUTH') || code?.includes('CONNECTION'))
    return 'Kết nối shop cần được kiểm tra lại tại Kết nối shop.';
  if (code?.includes('SOURCE') || code?.includes('MANIFEST') || code?.includes('REGISTRATION'))
    return 'Bộ nguồn chưa còn khớp bản đã tiếp nhận. Cần đối chiếu lại tệp gốc trước khi đăng.';
  return 'Đợt này cần kiểm tra kết quả đã lưu trước khi tiếp tục.';
}
const weightReview = z.object({
  sourceKey: z.string(),
  eligible: z.boolean(),
  approved: z.boolean(),
  reason: z.string().nullable().optional(),
  reviewFingerprint: z.string().optional(),
  itemId: z.string().optional(),
  modelCount: z.number().optional(),
  groups: z
    .array(
      z.object({
        sourceGrams: z.number(),
        observedGrams: z.number(),
        count: z.number(),
        skus: z.array(z.string()),
      }),
    )
    .optional(),
  observedAt: z.array(z.string()).optional(),
  expiresAt: z.string().optional(),
  coverReview: z
    .object({ basis: z.string(), reviewer: z.string().nullable().optional() })
    .nullable()
    .optional(),
});
function reviewReason(reason?: string | null) {
  if (reason?.includes('COVER'))
    return 'Ảnh bìa chưa đủ bằng chứng đối chiếu. Hoàn tất kiểm tra ảnh trước khi duyệt cân nặng.';
  if (
    reason?.includes('READS_EXPIRED') ||
    reason?.includes('READBACK_EXPIRED') ||
    reason?.includes('TWO_READS')
  )
    return 'Cần hai lần đọc mới trước khi duyệt. Chọn “Chỉ đọc đối chiếu”, rồi mở lại bảng này.';
  if (reason?.includes('OTHER_FIELDS') || reason?.includes('UNSTABLE'))
    return 'Ngoài cân nặng còn dữ liệu chưa khớp hoặc chưa ổn định. Chưa thể chấp nhận riêng cân nặng.';
  if (reason?.includes('NOT_ROUNDING') || reason?.includes('MODEL_BINDING'))
    return 'Cân nặng hoặc phân loại không khớp trường hợp làm tròn. Cần kiểm tra riêng listing này.';
  if (reason?.includes('CHANGED') || reason?.includes('CONFLICT'))
    return 'Dữ liệu đã thay đổi từ lần xem trước. Đọc lại để xem đúng mức cần duyệt.';
  if (reason?.includes('NO_WEIGHT_DIFFERENCE'))
    return 'Không phát hiện chênh lệch cân nặng cần duyệt.';
  return 'Chưa đủ bằng chứng để duyệt cân nặng. Đọc lại kết quả hoặc kiểm tra thông tin listing.';
}
const withProductionScope=(path:string,scope:ProductionTargetScope)=>path+(path.includes('?')?'&':'?')+new URLSearchParams({partnerId:scope.partnerId,shopId:scope.shopId});
function WeightReviewPanel({
  batchId,
  sourceKey,
  targetScope,
  onImageQc,
  deferImages = false,
}: {
  batchId: string;
  sourceKey: string;
  targetScope:ProductionTargetScope;
  onImageQc?: () => void;
  deferImages?: boolean;
}) {
  const [value, setValue] = useState<z.infer<typeof weightReview> | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [accepted, setAccepted] = useState(false);
  const active = useRef(true),
    request = useRef<AbortController | null>(null),
    submitting = useRef(false);
  const read = useCallback(async () => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError('');
    try {
      const response = weightReview.parse(
        await api(
          withProductionScope('/v1/production-batches/' +
            encodeURIComponent(batchId) +
            '/review?sourceKey=' +
            encodeURIComponent(sourceKey),targetScope),
          { signal: abort.signal },
        ),
      );
      if (active.current && !abort.signal.aborted) {
        setValue(response);
        setAccepted(response.approved);
      }
    } catch (reason) {
      if (active.current && !abort.signal.aborted)
        setError(
          reviewReason(
            reason instanceof RequestError
              ? reason.code
              : reason instanceof Error
                ? reason.message
                : '',
          ),
        );
    } finally {
      if (active.current && !abort.signal.aborted) setBusy(false);
    }
  }, [batchId, sourceKey]);
  useEffect(() => {
    active.current = true;
    void read();
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, [read]);
  async function approve() {
    if (
      !value?.eligible ||
      !value.reviewFingerprint ||
      submitting.current ||
      busy ||
      accepted ||
      (value.expiresAt && Date.parse(value.expiresAt) <= Date.now())
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const response = z.object({ approved: z.literal(true) }).parse(
        await api(withProductionScope('/v1/production-batches/' + encodeURIComponent(batchId) + '/review/approve',targetScope), {
          method: 'POST',
          body: JSON.stringify({ sourceKey, expectedReviewFingerprint: value.reviewFingerprint }),
        }),
      );
      if (active.current) setAccepted(response.approved);
    } catch (reason) {
      if (active.current)
        setError(
          'Chưa xác nhận được việc lưu chấp nhận. Đọc lại bảng đối chiếu để kiểm tra. ' +
            reviewReason(
              reason instanceof RequestError
                ? reason.code
                : reason instanceof Error
                  ? reason.message
                  : '',
            ),
        );
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="production-weight-review" aria-label="Đối chiếu cân nặng">
      <h4>Cân nặng Shopee đang lưu{value?.itemId ? ' · Listing ' + value.itemId : ''}</h4>
      {busy && !value && <p role="status">Đang đọc bằng chứng đối chiếu…</p>}
      {error && <p role="alert">{error}</p>}
      {value?.groups && (
        <>
          <p>
            {value.modelCount} phân loại đã được đối chiếu theo SKU. Giá, tồn, nội dung và phân loại
            phải khớp trước khi mở nút chấp nhận.
          </p>
          <div className="production-weight-table">
            <table>
              <thead>
                <tr>
                  <th>Nguồn của bạn</th>
                  <th>Shopee đang lưu</th>
                  <th>Phân loại</th>
                </tr>
              </thead>
              <tbody>
                {value.groups.map((group) => (
                  <tr key={group.sourceGrams + ':' + group.observedGrams}>
                    <td>
                      {group.sourceGrams.toLocaleString('vi-VN', { maximumFractionDigits: 20 })} g
                    </td>
                    <td>{group.observedGrams.toLocaleString('vi-VN')} g</td>
                    <td>
                      <details>
                        <summary>{group.count} SKU</summary>
                        <p>{group.skus.join(', ')}</p>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {value.coverReview && (
            <p className="production-batch-help">
              Ảnh bìa có phiếu đối chiếu riêng
              {value.coverReview.basis === 'manual_review' ? ' bằng kiểm tra hình ảnh' : ''}. Quyết
              định bên dưới chỉ áp dụng cân nặng.
            </p>
          )}
        </>
      )}
      {accepted ? (
        <p role="status" className="notice">
          Đã lưu mức cân nặng được chấp nhận cho listing này.{' '}
          {deferImages
            ? 'Chọn “Tiếp tục listing này” để kiểm dữ liệu và hoàn tất đăng ẩn; ảnh vẫn chưa QC.'
            : 'Chọn “Chỉ đọc đối chiếu” để kiểm tra lại; listing chưa tự động mở bán.'}
        </p>
      ) : (
        value && !value.eligible && <p role="status">{reviewReason(value.reason)}</p>
      )}
      {value?.eligible && !accepted && value.expiresAt && (
        <p className="production-batch-help">
          Bằng chứng có thể duyệt đến {new Date(value.expiresAt).toLocaleTimeString('vi-VN')}. Sau
          thời điểm này cần đọc lại listing.
        </p>
      )}
      <div className="production-batch-actions">
        {value?.eligible && !accepted && (
          <button
            type="button"
            className="primary"
            disabled={busy || (!!value.expiresAt && Date.parse(value.expiresAt) <= Date.now())}
            onClick={() => void approve()}
          >
            Chấp nhận mức Shopee đang lưu
          </button>
        )}
        <button type="button" className="secondary" disabled={busy} onClick={() => void read()}>
          Đọc lại bảng đối chiếu
        </button>
        {value?.reason?.includes('COVER') && onImageQc && (
          <button type="button" className="secondary" onClick={onImageQc}>
            Mở Kiểm tra ảnh
          </button>
        )}
      </div>
      {!accepted && value?.eligible && (
        <p className="production-batch-help">
          Chỉ lưu chấp nhận các mức đang hiển thị, hiệu lực 24 giờ cho đúng listing. Tệp nguồn được
          giữ nguyên. Không gửi lệnh đổi cân nặng hoặc mở bán khi bấm nút này.
        </p>
      )}
    </section>
  );
}
function foldBatchSearch(value: string) {
  return value
    .toLocaleLowerCase('vi-VN')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .trim();
}
function batchRowCounts(item: Batch) {
  const counts = { waiting: 0, attention: 0, hidden: 0, published: 0 };
  for (const row of item.listings) {
    if (row.excluded) continue;
    if (row.currentSource && row.currentSource !== 'current' && !row.itemId) { counts.attention++; continue; }
    if (row.state === 'published') counts.published++;
    else if (['created_unlisted', 'created_hidden_image_qc_deferred'].includes(row.state))
      counts.hidden++;
    else if (['not_sent', 'inspected', 'authorized_not_started'].includes(row.state)) counts.waiting++;
    else counts.attention++;
  }
  return counts;
}
type ProductionTargetScope={environment:'production';partnerId:string;shopId:string};
export function ProductionBatches({ targetScope, onImageQc, onSource, active = true }: { targetScope:ProductionTargetScope;onImageQc?: () => void; onSource?: (key: string) => void; active?: boolean }) {
  const [batches, setBatches] = useState<Batch[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [loaded, setLoaded] = useState(false),
    [pending, setPending] = useState<string | null>(null),
    [held, setHeld] = useState<Record<string, string>>({}),
    [publicationConfirmations, setPublicationConfirmations] = useState<Record<string, string>>({}),
    [filter, setFilter] = useState('active'),
    [search, setSearch] = useState(''),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [hidePublished, setHidePublished] = useState(false),
    [reviewing, setReviewing] = useState<string | null>(null);
  const mounted = useRef(true),
    posting = useRef(false),
    reading = useRef(false),
    controller = useRef<AbortController | null>(null);
  const recoveryBatchIds = useRef(new Set<string>());
  const scoped=(path:string)=>path+(path.includes('?')?'&':'?')+new URLSearchParams({partnerId:targetScope.partnerId,shopId:targetScope.shopId});
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const abort = new AbortController();
    controller.current = abort;
    try {
      const value = await api<unknown>(scoped('/v1/production-batches'), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      const parsed = z.object({ batches: z.array(batch) }).parse(value);
      for (const id of recoveryBatchIds.current) {
        if (!parsed.batches.some(item => item.batchId === id)) parsed.batches.push(batch.parse(await api(scoped('/v1/production-batches/' + encodeURIComponent(id)), { signal: abort.signal })));
      parsed.batches=parsed.batches.filter(item=>item.shopId===targetScope.shopId && (!item.partnerId || item.partnerId===targetScope.partnerId));
      }
      if (mounted.current) {
        if (!posting.current)
          for (const item of parsed.batches) {
            const marker = sessionStorage.getItem('production-batch:' + item.batchId);
            if (
              marker &&
              item.acceptedStatusFingerprints &&
              !item.acceptedStatusFingerprints.includes(marker)
            )
              sessionStorage.removeItem('production-batch:' + item.batchId);
          }
        setBatches(parsed.batches);
        setPublicationConfirmations((previous) =>
          Object.fromEntries(
            parsed.batches.flatMap((item) =>
              item.listings.flatMap((row) => {
                const key = item.batchId + ':' + row.sourceKey;
                return row.canPublish &&
                  row.state === 'created_unlisted' &&
                  row.imageQcStatus !== 'deferred' &&
                  previous[key] === item.statusFingerprint
                  ? [[key, previous[key]!]]
                  : [];
              }),
            ),
          ),
        );
        setError('');
        setLoaded(true);
        setHeld(
          Object.fromEntries(
            parsed.batches.map((item) => [
              item.batchId,
              sessionStorage.getItem('production-batch:' + item.batchId) ?? '',
            ]),
          ),
        );
      }
    } catch (reason) {
      if (mounted.current && !abort.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'Chưa đọc được trạng thái đợt đăng.');
        setLoaded(true);
      }
    } finally {
      reading.current = false;
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [refresh, active]);
  const pollingDelay = batches.some((item) => item.busy) ? 3000 : 15000;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, pollingDelay);
    return () => clearInterval(timer);
  }, [refresh, pollingDelay, active]);
  async function exclude(item: Batch, sourceKey: string) {
    if (posting.current || pending || !item.statusFingerprint) return;
    posting.current = true;
    setPending(item.batchId);
    setError('');
    setNotice('');
    try {
      await api(scoped('/v1/production-batches/' + encodeURIComponent(item.batchId) + '/exclusions'), {
        method: 'POST', body: JSON.stringify({ expectedStatusFingerprint: item.statusFingerprint, sourceKey }),
      });
      await refresh();
      setNotice('Đã loại listing chưa gửi khỏi đợt này. Bộ nguồn vẫn giữ nguyên để sửa và chuẩn bị lại; không xóa link trên Shopee.');
    } catch (reason) {
      setError('Chưa xác nhận được việc loại khỏi đợt. Đọc lại trạng thái; nguồn và link Shopee vẫn được giữ. ' + (reason instanceof Error ? reason.message : ''));
    } finally { posting.current = false; if (mounted.current) setPending(null); }
  }
  async function openBlockingBatch(id: string) {
    recoveryBatchIds.current.add(id);
    setFilter('all'); setSearch(''); setSelectedId(id);
    await refresh();
  }
  async function run(
    item: Batch,
    mode: 'inspect' | 'execute' | 'reconcile' | 'publish',
    sourceKey?: string,
  ) {
    if (posting.current || pending || !item.statusFingerprint) return;
    const key = item.statusFingerprint;
    if (mode === 'publish') {
      if (
        item.publicationMode !== 'hidden_for_review' ||
        !sourceKey ||
        item.busy ||
        !item.enabled ||
        item.executionEnabled === false ||
        sessionStorage.getItem('production-batch:' + item.batchId) === key ||
        !item.listings.some(
          (row) =>
            row.sourceKey === sourceKey &&
            row.canPublish &&
            row.state === 'created_unlisted' &&
            row.imageQcStatus !== 'deferred',
        ) ||
        publicationConfirmations[item.batchId + ':' + sourceKey] !== key
      )
        return;
      setPublicationConfirmations({});
    }
    posting.current = true;
    sessionStorage.setItem('production-batch:' + item.batchId, key);
    setHeld((previous) => ({ ...previous, [item.batchId]: key }));
    setPending(item.batchId);
    setError('');
    try {
      await api(
        scoped('/v1/production-batches/' +
          encodeURIComponent(item.batchId) +
          (mode === 'publish' ? '/publish' : '/run')),
        {
          method: 'POST',
          body: JSON.stringify({
            ...(mode === 'publish' ? {} : { mode }),
            expectedStatusFingerprint: key,
            ...(sourceKey ? { sourceKey } : {}),
          }),
        },
      );
      await refresh();
    } catch (reason) {
      // These rejections happen before acceptance; they are not uncertain writes.
      if (reason instanceof RequestError && ['PRODUCTION_BATCH_STATUS_CHANGED', 'PRODUCTION_BATCH_IN_PROGRESS',
        'PRODUCTION_BATCH_EXECUTION_DISABLED', 'PRODUCTION_BATCH_SOURCE_CHANGED', 'PRODUCTION_BATCH_SOURCE_ARCHIVED',
        'PRODUCTION_BATCH_EXECUTION_HELD', 'PRODUCTION_BATCH_RECONCILIATION_REQUIRED'].includes(reason.code)) {
        sessionStorage.removeItem('production-batch:' + item.batchId);
        setHeld(previous => ({ ...previous, [item.batchId]: '' }));
      }
      if (mounted.current)
        setError(
          'Chưa xác nhận được yêu cầu. Đọc lại trạng thái để kiểm tra; không bấm gửi lại. ' +
            (reason instanceof Error ? reason.message : ''),
        );
    } finally {
      posting.current = false;
      if (mounted.current) setPending(null);
    }
  }
  const needsQc = (item: Batch) =>
    item.canReconcile === true ||
    item.listings.some((row) =>
      [
        'created_readback_pending',
        'publication_readback_pending',
        'created_unlisted',
        'created_hidden_image_qc_deferred',
      ].includes(row.state),
    );
  const filters = [
    { key: 'active', label: 'Chưa hoàn tất', accept: (item: Batch) => !['completed', 'completed_with_exclusions'].includes(item.state) },
    { key: 'all', label: 'Tất cả', accept: (_item: Batch) => true },
    {
      key: 'ready',
      label: 'Có thể tiếp tục',
      accept: (item: Batch) => item.canExecute && item.executionEnabled !== false,
    },
    { key: 'qc', label: 'Cần đối chiếu', accept: needsQc },
    {
      key: 'held',
      label: 'Đang giữ lại',
      accept: (item: Batch) => item.executionEnabled === false,
    },
  ];
  const visibleBatches = batches.filter((item) => {
    const accepted = filters.find((option) => option.key === filter)!.accept(item);
    const text = [
      item.name,
      item.shopName,
      item.shopId,
      ...item.listings.map((row) => row.title),
    ].join(' ');
    return accepted && foldBatchSearch(text).includes(foldBatchSearch(search));
  });
  const selectedBatch =
    visibleBatches.find((item) => item.batchId === selectedId) ?? visibleBatches[0];
  return (
    <section
      className="production-pilot production-batches batch-workspace"
      aria-label="Đợt đăng mới"
    >
      <div className="production-pilot-heading">
        <div>
          <h2>Đăng theo đợt</h2>
          <p>Mỗi đợt giữ bản nguồn đã chốt lúc chuẩn bị. Loại mục chưa gửi nếu cần sửa, rồi chuẩn bị lại từ nguồn mới. Các link đã tạo được giữ để QC.</p>
        </div>
        <button type="button" className="secondary batch-refresh" onClick={() => void refresh()}>
          <RefreshCw size={16} className={pending ? 'production-pilot-spin' : undefined} />
          Đọc lại đợt đăng
        </button>
      </div>
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      {pending && <p role="status" className="notice">Đang xử lý yêu cầu. Giữ nguyên màn hình này; kết quả sẽ cập nhật tại đúng đợt bạn đã chọn.</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {!loaded && !error && <p role="status">Đang đọc các đợt đã tiếp nhận…</p>}
      {loaded && !error && !batches.length && (
        <div className="production-batch-empty">
          <FolderCheck size={26} />
          <div>
            <strong>Chưa có đợt đăng</strong>
            <p>Mở “Chuẩn bị lô mới”, chọn các listing đã lưu và kiểm tra nguồn để bắt đầu.</p>
          </div>
        </div>
      )}
      {batches.length > 0 && (
        <>
          <div className="batch-workspace-toolbar">
            <label className="batch-search">
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                aria-label="Tìm đợt đăng hoặc sản phẩm"
                placeholder="Tìm theo tên sản phẩm, đợt hoặc shop…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="production-batch-filters" role="group" aria-label="Lọc đợt đăng">
              {filters.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className="secondary"
                  aria-pressed={filter === option.key}
                  onClick={() => setFilter(option.key)}
                >
                  {option.label} <span>{batches.filter(option.accept).length}</span>
                </button>
              ))}
            </div>
          </div>
          {!visibleBatches.length ? (
            <div className="batch-no-results" role="status">
              <Search size={25} />
              <strong>Không có đợt phù hợp</strong>
              <p>Thử tên sản phẩm khác hoặc quay lại tất cả đợt.</p>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setSearch('');
                  setFilter('all');
                }}
              >
                Xóa tìm kiếm và bộ lọc
              </button>
            </div>
          ) : (
            <div className="batch-workspace-layout">
              <nav className="batch-selector" aria-label="Danh sách đợt đăng">
                <div className="batch-selector-heading">
                  <strong>{visibleBatches.length} đợt đăng</strong>
                  <span>Chọn để xem</span>
                </div>
                {visibleBatches.map((item) => {
                  const counts = batchRowCounts(item);
                  const active = selectedBatch?.batchId === item.batchId;
                  const number = batches.indexOf(item) + 1;
                  return (
                    <button
                      key={item.batchId}
                      type="button"
                      className="batch-selector-item"
                      aria-pressed={active}
                      aria-label={'Chọn đợt ' + (item.name ?? item.listings[0]?.title ?? number)}
                      onClick={() => {
                        setSelectedId(item.batchId);
                        setReviewing(null);
                      }}
                    >
                      <span className="batch-selector-top">
                        <b>Đợt {number}</b>
                        <span>
                          {item.state === 'unavailable'
                            ? 'Chưa đọc được'
                            : item.listings.length + ' sản phẩm'}
                        </span>
                      </span>
                      <span
                        className="batch-selector-name"
                        title={item.name ?? item.listings[0]?.title}
                      >
                        Gồm: {item.name ?? item.listings[0]?.title ?? 'Bộ nguồn đã tiếp nhận'}
                      </span>
                      <span className="batch-selector-shop">
                        {item.shopName ?? 'Shop đã chỉ định'}
                      </span>
                      <span
                        className={
                          'batch-selector-state ' +
                          (item.executionEnabled === false
                            ? 'is-held'
                            : item.busy
                              ? 'is-running'
                              : counts.attention
                                ? 'is-attention'
                                : '')
                        }
                      >
                        {item.state === 'unavailable'
                          ? 'Cần đọc lại'
                          : item.executionEnabled === false
                            ? 'Đang giữ lại'
                            : item.busy
                              ? 'Đang xử lý'
                              : counts.attention
                                ? `${counts.attention} cần đối chiếu`
                                : counts.waiting
                                  ? `${counts.waiting} chưa gửi`
                                  : counts.hidden
                                    ? `${counts.hidden} đang ẩn`
                                    : `${counts.published} đã mở bán`}
                        <ChevronRight size={16} aria-hidden="true" />
                      </span>
                    </button>
                  );
                })}
              </nav>
              <section className="batch-selected" aria-label="Chi tiết đợt đăng">
                {selectedBatch &&
                  (() => {
                    const item = selectedBatch;
                    const counts = batchRowCounts(item);
                    const unavailable = item.state === 'unavailable';
                    const writeAllowed = !unavailable && item.executionEnabled !== false;
                    const hidden = item.publicationMode === 'hidden_for_review';
                    const uncertain = held[item.batchId] === item.statusFingerprint;
                    const disabled =
                      !!pending ||
                      !!item.busy ||
                      uncertain ||
                      !item.statusFingerprint ||
                      !item.enabled;
                    const canReconcile =
                      item.canReconcile ??
                      item.listings.some((row) =>
                        [
                          'created_readback_pending',
                          'publication_readback_pending',
                          'created_unlisted',
                        ].includes(row.state),
                      );
                    const shownRows = item.listings.filter(
                      (row) => (!hidePublished || row.state !== 'published') && (!row.excluded || filter === 'all'),
                    );
                    const finished = counts.waiting === 0 && counts.attention === 0;
                    const nextStep = unavailable
                      ? 'Chưa đọc được đợt đăng'
                      : item.busy
                        ? 'Đang xử lý đợt này'
                        : !writeAllowed
                          ? 'Đợt đang được giữ lại'
                          : uncertain
                            ? 'Cần đọc lại kết quả'
                            : finished
                              ? counts.hidden
                                ? 'Đã tạo ẩn · chờ kiểm tra'
                                : 'Đợt đã hoàn tất'
                              : !item.canExecute && counts.attention
                                ? 'Đọc lại để xác định kết quả'
                                : hidden
                                  ? 'Tiếp tục đăng ẩn'
                                  : 'Tiếp tục theo chế độ đã chọn';
                    const showCurrentStop =
                      item.lastResult?.stopped && (counts.waiting > 0 || counts.attention > 0);
                    return (
                      <article
                        key={item.batchId}
                        className="production-pilot-card production-batch-card"
                        aria-label={
                          item.name ?? 'Bộ nguồn ' + (item.listings[0]?.title ?? item.batchId)
                        }
                      >
                        <header className="batch-detail-heading">
                          <div>
                            <p className="batch-detail-eyebrow">
                              ĐỢT {batches.indexOf(item) + 1} ·{' '}
                              {item.shopName ?? 'Shop đã chỉ định'}
                            </p>
                            <h3>
                              {unavailable
                                ? 'Chưa đọc được danh sách sản phẩm'
                                : item.listings.length + ' sản phẩm trong đợt'}
                            </h3>
                          </div>
                          <span className={'batch-mode-tag ' + (hidden ? 'is-hidden' : 'is-auto')}>
                            {hidden ? <EyeOff size={15} /> : <Upload size={15} />}
                            {unavailable
                              ? 'Chưa đọc được chế độ đăng'
                              : hidden
                                ? 'Đăng ẩn để QC'
                                : item.publicationMode === 'publish_after_verification'
                                  ? 'Mở bán sau kiểm tra'
                                  : 'Lô cũ · Tự mở bán sau đối chiếu'}
                          </span>
                        </header>
                        {!unavailable && (
                          <div
                            className="batch-progress-overview"
                            aria-label="Tiến độ theo trạng thái sản phẩm"
                          >
                            <span>
                              <b>{counts.waiting}</b> Chưa gửi
                            </span>
                            <span className={counts.attention ? 'has-attention' : ''}>
                              <b>{counts.attention}</b> Cần đối chiếu
                            </span>
                            <span>
                              <b>{counts.hidden}</b> Đang ẩn
                            </span>
                            <span className={counts.published ? 'has-success' : ''}>
                              <b>{counts.published}</b> Đã mở bán
                            </span>
                          </div>
                        )}
                        <div className="batch-next-action">
                          <div>
                            <strong>{nextStep}</strong>
                            <p>
                              {unavailable
                                ? 'Bấm Đọc lại đợt đăng để lấy trạng thái. Chưa xác định được kết quả của đợt này.'
                                : hidden
                                  ? 'Các sản phẩm mới được giữ ẩn để kiểm tra trước khi mở bán.'
                                  : 'Chế độ này tự mở bán sau khi đối chiếu đạt.'}
                            </p>
                          </div>
                          <div className="production-batch-actions">
                            {writeAllowed && !(hidden && item.remainingCount === 0) && (
                              <button
                                type="button"
                                className="primary batch-run"
                                disabled={disabled || !item.canExecute}
                                onClick={() => void run(item, 'execute')}
                              >
                                <Upload size={17} />
                                {hidden
                                  ? 'Đăng ẩn'
                                  : item.publishedCount
                                    ? 'Tiếp tục'
                                    : 'Đăng'}{' '}
                                {item.remainingCount ?? item.listings.length} listing
                                {!hidden && item.publishedCount ? ' còn lại' : ''}
                              </button>
                            )}
                            {writeAllowed && canReconcile && (
                              <button
                                type="button"
                                className="secondary"
                                disabled={
                                  item.canReconcile === true
                                    ? !!pending ||
                                      !!item.busy ||
                                      !item.statusFingerprint ||
                                      !item.enabled
                                    : disabled
                                }
                                onClick={() => void run(item, 'reconcile')}
                              >
                                <RefreshCw size={16} />
                                {item.interrupted ? 'Đọc lại để phục hồi' : 'Chỉ đọc đối chiếu'}
                              </button>
                            )}
                          </div>
                        </div>
                        {uncertain && !item.busy && (
                          <p className="batch-feedback" role="status">
                            Đã gửi một yêu cầu từ màn hình này. Đang chờ trạng thái mới để tránh gửi
                            trùng.
                          </p>
                        )}
                        {item.state === 'unavailable' && (
                          <p className="batch-feedback" role="alert">
                            {explanation(item.code)}
                          </p>
                        )}
                        {!unavailable && !writeAllowed && (
                          <p role="status" className="batch-feedback">
                            <strong>Đang giữ lại — chưa đăng.</strong>{' '}
                            {item.holdReason ??
                              'Bộ nguồn cần được bổ sung và kiểm tra trước khi đăng.'}{' '}
                            Bạn vẫn có thể kiểm tra nguồn.
                          </p>
                        )}
                        {item.busy && (
                          <p className="batch-feedback" role="status">
                            {item.interrupted
                              ? 'Lần xử lý trước chưa ghi xong kết quả. Cần phục hồi có bằng chứng trước khi gửi tiếp.'
                              : 'Đang xử lý đợt. Trạng thái bên dưới được cập nhật tự động.'}
                          </p>
                        )}
                        {showCurrentStop && (
                          <p className="batch-feedback" role="alert">
                            {explanation(
                              item.lastResult?.code ??
                                item.lastResult?.listings.find((row) => row.code)?.code,
                              hidden && item.imageQcPolicy === 'defer_image_qc',
                            )}
                          </p>
                        )}
                        {item.blockingWork && <div className="batch-feedback" role="status">
                          <strong>{item.blockingWork.blocksExecution===false ? 'Chờ QC riêng, không chặn đợt này: ' : 'Cần xử lý công việc trước: '}{item.blockingWork.title}</strong>
                          <p>{item.blockingWork.blocksExecution===false ? 'Shopee đã nhận đủ lệnh tạo và phân loại. Bạn có thể đăng đợt này; link cũ vẫn cần kiểm tra, không được coi là đã QC đạt.' : item.blockingWork.itemId ? 'Link đã tạo đang chờ đối chiếu. Lô này sẽ tiếp tục sau khi công việc đó được xử lý; không cần tạo lại link cũ.' : 'Công việc này đang giữ lượt xử lý của shop. Kiểm tra trạng thái đã lưu trước khi tiếp tục lô mới.'}</p>
                          {item.blockingWork.batchId && <button type="button" disabled={pending!==null} onClick={()=>void openBlockingBatch(item.blockingWork!.batchId!)}>Mở công việc đang chờ</button>}
                          {item.blockingWork.itemId && <a href={'https://banhang.shopee.vn/portal/product/'+encodeURIComponent(item.blockingWork.itemId)} target="_blank" rel="noreferrer">Xem link trên Shopee</a>}
                        </div>}
                        {hidden && item.imageQcPolicy === 'defer_image_qc' && (
                          <p className="batch-policy-note">
                            <EyeOff size={15} />
                            Đã chọn hoãn QC ảnh. Ảnh chưa được xác nhận đạt; sản phẩm chưa mở bán
                            vẫn giữ ẩn.
                          </p>
                        )}
                        {hidden && (item.imageQcPendingCount ?? 0) > 0 && (
                          <details className="batch-qc-note">
                            <summary>{item.imageQcPendingCount} listing ảnh chưa QC</summary>
                            <p>
                              Khi muốn kiểm tra ảnh, bấm “Chỉ đọc đối chiếu” để tạo hồ sơ. Sau đó mở
                              “Kiểm tra ảnh”, lưu kết quả và đọc đối chiếu lần nữa. Listing vẫn ẩn
                              đến khi bạn chọn mở bán.
                            </p>
                          </details>
                        )}
                        <div className="batch-products-heading">
                          <h4>Sản phẩm trong đợt</h4>
                          {counts.published > 0 && (
                            <label>
                              <input
                                type="checkbox"
                                checked={hidePublished}
                                onChange={(event) => setHidePublished(event.target.checked)}
                              />
                              Ẩn sản phẩm đã mở bán
                            </label>
                          )}
                        </div>
                        {!shownRows.length && (
                          <p className="batch-all-done">
                            Tất cả sản phẩm trong đợt đã mở bán. Bỏ chọn bộ lọc để xem lại.
                          </p>
                        )}
                        <ol className="production-batch-rows">
                          {shownRows.map((row) => {
                            const code = item.lastResult?.listings.find(
                              (result) => result.sourceKey === row.sourceKey,
                            )?.code;
                            const rowState =
                              row.state === 'published'
                                ? 'published'
                                : ['created_unlisted', 'created_hidden_image_qc_deferred'].includes(
                                      row.state,
                                    )
                                  ? 'hidden'
                                  : ['not_sent', 'inspected', 'authorized_not_started'].includes(row.state)
                                    ? 'waiting'
                                    : 'attention';
                            return (
                              <li key={row.sourceKey} className={'batch-product is-' + rowState}>
                                <div className="batch-product-main">
                                  <span className="batch-product-position">
                                    {item.listings.indexOf(row) + 1}
                                  </span>
                                  <div className="batch-product-identity">
                                    <strong>{row.title}</strong>
                                    <span>{row.modelCount} phân loại</span>
                                  </div>
                                </div>
                                <div className="production-batch-row-status">
                                  <span className={'batch-status-label is-' + rowState}>
                                    {row.state === 'published' && <CheckCircle2 size={15} />}
                                    {row.excluded ? 'Đã loại khỏi đợt · chưa gửi' : hidden && row.state === 'created_unlisted'
                                      ? 'Đã tạo ẩn, chờ bạn kiểm tra'
                                      : (labels[row.state] ?? 'Cần đối chiếu')}
                                  </span>
                                  {!row.excluded && row.state !== 'published' &&
                                    writeAllowed &&
                                    !(
                                      hidden &&
                                      [
                                        'created_unlisted',
                                        'created_hidden_image_qc_deferred',
                                      ].includes(row.state)
                                    ) && (
                                      <button
                                        type="button"
                                        className="secondary batch-row-action"
                                        disabled={disabled || !(row.canExecute ?? item.canExecute)}
                                        onClick={() => void run(item, 'execute', row.sourceKey)}
                                      >
                                        {row.state === 'not_sent'
                                          ? hidden
                                            ? 'Đăng ẩn listing này'
                                            : 'Đăng listing này'
                                          : 'Tiếp tục listing này'}
                                        <ArrowRight size={14} />
                                      </button>
                                    )}
                                  {!row.excluded && row.currentSource && row.currentSource !== 'current' && <p className="notice warning">
                                    {row.currentSource === 'archived' ? 'Nguồn đã lưu trữ; không đăng từ bản cũ này.' : 'Nguồn đã có phiên bản mới. Loại mục chưa gửi rồi chuẩn bị lại từ bản mới.'}
                                  </p>}
                                  {row.canExclude && <button type="button" className="secondary" disabled={!!pending || !!item.busy}
                                    onClick={() => void exclude(item, row.sourceKey)}>Loại khỏi đợt này</button>}
                                  {row.productKey && onSource && <button type="button" className="secondary" disabled={!!pending || !!item.busy}
                                    onClick={() => onSource(row.productKey!)}>Mở nguồn mới nhất để sửa</button>}
                                  {hidden &&
                                    row.state === 'created_hidden_image_qc_deferred' &&
                                    onImageQc && (
                                      <button
                                        type="button"
                                        className="secondary batch-row-action"
                                        onClick={onImageQc}
                                      >
                                        Kiểm tra ảnh sau đối chiếu
                                        <ArrowRight size={14} />
                                      </button>
                                    )}
                                </div>
                                {hidden &&
                                  writeAllowed &&
                                  row.canPublish &&
                                  row.state === 'created_unlisted' &&
                                  row.imageQcStatus !== 'deferred' && (
                                    <div className="production-batch-publish">
                                      <label>
                                        <input
                                          type="checkbox"
                                          disabled={disabled}
                                          checked={
                                            publicationConfirmations[
                                              item.batchId + ':' + row.sourceKey
                                            ] === item.statusFingerprint
                                          }
                                          onChange={(event) =>
                                            setPublicationConfirmations((previous) => ({
                                              ...previous,
                                              [item.batchId + ':' + row.sourceKey]: event.target
                                                .checked
                                                ? item.statusFingerprint!
                                                : '',
                                            }))
                                          }
                                        />
                                        <span>Tôi đã kiểm tra listing này và đồng ý mở bán</span>
                                      </label>
                                      <button
                                        type="button"
                                        disabled={
                                          disabled ||
                                          publicationConfirmations[
                                            item.batchId + ':' + row.sourceKey
                                          ] !== item.statusFingerprint
                                        }
                                        onClick={() => void run(item, 'publish', row.sourceKey)}
                                      >
                                        Mở bán listing này
                                      </button>
                                    </div>
                                  )}
                                <details className="batch-product-details">
                                  <summary>Chi tiết sản phẩm</summary>
                                  <div className="batch-product-detail-body">
                                    {row.itemId && (
                                      <p>
                                        Mã Shopee <strong>{row.itemId}</strong>
                                        {/^\d+$/.test(row.itemId) && (
                                          <a
                                            href={
                                              'https://banhang.shopee.vn/portal/product/' +
                                              row.itemId
                                            }
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            Xem trên Shopee
                                            <ExternalLink size={13} />
                                          </a>
                                        )}
                                      </p>
                                    )}
                                    {row.totalSteps > 0 && (
                                      <p className="production-batch-help">
                                        {row.acknowledgedSteps}/{row.totalSteps} bước có biên nhận.
                                        Biên nhận gửi không thay thế kết quả đối chiếu.
                                      </p>
                                    )}
                                    {code && (
                                      <p className="production-batch-help">
                                        <b>Kết quả lần xử lý trước: </b>
                                        {explanation(
                                          code,
                                          hidden && item.imageQcPolicy === 'defer_image_qc',
                                        )}
                                      </p>
                                    )}
                                    {!row.excluded && row.state !== 'published' && (
                                      <div className="production-batch-actions">
                                        <button
                                          type="button"
                                          className="secondary"
                                          disabled={disabled}
                                          onClick={() => void run(item, 'inspect', row.sourceKey)}
                                        >
                                          <SearchCheck size={15} />
                                          Kiểm tra listing này
                                        </button>
                                        {writeAllowed &&
                                          row.state === 'created_readback_pending' && (
                                            <button
                                              type="button"
                                              className="secondary"
                                              disabled={!!pending || !!item.busy}
                                              onClick={() =>
                                                setReviewing(
                                                  reviewing === item.batchId + ':' + row.sourceKey
                                                    ? null
                                                    : item.batchId + ':' + row.sourceKey,
                                                )
                                              }
                                            >
                                              {reviewing === item.batchId + ':' + row.sourceKey
                                                ? 'Đóng bảng đối chiếu'
                                                : 'Xem chênh lệch cân nặng'}
                                            </button>
                                          )}
                                      </div>
                                    )}
                                  </div>
                                </details>
                                {reviewing === item.batchId + ':' + row.sourceKey &&
                                  writeAllowed && (
                                    <WeightReviewPanel
                                      batchId={item.batchId}
                                      sourceKey={row.sourceKey}
                                      targetScope={targetScope}
                                      onImageQc={onImageQc}
                                      deferImages={
                                        hidden && item.imageQcPolicy === 'defer_image_qc'
                                      }
                                    />
                                  )}
                              </li>
                            );
                          })}
                        </ol>
                        <details className="batch-tools">
                          <summary>Công cụ của đợt</summary>
                          <div>
                            <p>{item.name ?? item.listings[0]?.title}</p>
                            <p className="production-batch-help">
                              {item.listings.length} listing · {item.shopName ?? 'Shop đã chỉ định'}
                              {item.shopId ? ' · Shop ' + item.shopId : ''}
                            </p>
                            <p className="production-batch-help">
                              {hidden
                                ? `${item.createdVerifiedCount ?? 0}/${item.listings.length} đã tạo, đối chiếu đạt`
                                : `${item.publishedCount ?? 0}/${item.listings.length} đã mở bán`}
                            </p>
                            {hidden && (
                              <p className="production-batch-help">
                                {item.hiddenVerifiedCount ?? 0} đang ẩn chờ kiểm tra ·{' '}
                                {item.publishedCount ?? 0} đã mở bán
                              </p>
                            )}
                            <button
                              type="button"
                              className="secondary"
                              disabled={disabled}
                              onClick={() => void run(item, 'inspect')}
                            >
                              <SearchCheck size={16} />
                              Kiểm tra nguồn
                            </button>
                            <p className="production-batch-help">
                              “Kiểm tra nguồn” chỉ đọc dữ liệu.{' '}
                              {hidden
                                ? '“Đăng ẩn” tạo và đối chiếu listing, vẫn giữ ẩn. Mở bán là thao tác riêng cho đúng sản phẩm đã xác nhận.'
                                : '“Đăng” tạo listing ở trạng thái ẩn, đối chiếu rồi tự mở bán. Những listing đã hoàn tất được bỏ qua.'}
                            </p>
                            {!showCurrentStop && item.lastResult?.stopped && (
                              <p className="production-batch-help">
                                Lần xử lý trước: {explanation(item.lastResult.code)}
                              </p>
                            )}
                          </div>
                        </details>
                      </article>
                    );
                  })()}
              </section>
            </div>
          )}
        </>
      )}
    </section>
  );
}
