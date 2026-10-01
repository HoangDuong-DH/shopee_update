import { useEffect, useRef, useState } from 'react';
import type { ChangePlan, ListingDraft, ShopConnection } from '@shopee/domain';
import { z } from 'zod';
import { sourceListingIntent } from '../../../packages/domain/src/source-catalog.js';
import { api, media, money, post } from './api.js';
import './listing-authoring.css';
export type PreviewContinuation = { productKey: string; revision: number; shopConnectionId: string | null };
type MappingReview = {
  productKey: string; revision: number; fingerprint: string;
  sourceHashes: Array<{ importId: string; sha256: string; kind: 'xlsx' | 'docx' | 'image' }>;
  requiresConfirmation: boolean; approvalBasis: 'current_decision' | 'stored_folder' | 'unconfirmed';
  mapping: { title: string; tierNames: string[]; variants: Array<{ sku: string; optionLabels: string[]; originalPrice: string }> };
  imageRoles: { cover: string | null; gallery: Array<string | null>; variants: Array<string | null> };
};
const mappingReviewSchema = z.object({
  productKey: z.string().min(1), revision: z.number().int().positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requiresConfirmation: z.boolean(), approvalBasis: z.enum(['current_decision', 'stored_folder', 'unconfirmed']),
  sourceHashes: z.array(z.object({ importId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['xlsx', 'docx', 'image']) })).min(1).max(5000),
  mapping: z.object({ title: z.string(), tierNames: z.array(z.string()).max(2), variants: z.array(z.object({ sku: z.string(), optionLabels: z.array(z.string()).max(2), originalPrice: z.string().regex(/^\d*$/) })).max(2000) }),
  imageRoles: z.object({ cover: z.string().nullable(), gallery: z.array(z.string().nullable()), variants: z.array(z.string().nullable()) }),
}).refine(value => value.requiresConfirmation === (value.approvalBasis === 'unconfirmed'));
type PriceMappingReview = {
  productKey: string; revision: number; title: string; fingerprint: string; confirmed: boolean;
  tierNames: string[];
  rows: Array<{ slotKey: string; optionLabels: string[]; sourceName: string; sourceFilename: string; sourceImportedAt: string; fileSha256: string; sku: string;
    sheetName: string; skuCell: string; priceCell: string; originalPrice: string; priceProfile: string | null }>;
  issues: Array<{ code: string; message: string; slotKey?: string }>;
};
export function Issues({ issues }: { issues: ListingDraft['issues'] }) {
  return (
    <div className="issues">
      {issues.map((i, n) => (
        <div className={'issue ' + i.severity} key={n}>
          <strong>{i.severity === 'block' ? 'Cần xử lý' : 'Lưu ý'}</strong>
          <span>{i.message}</span>
          {i.sources[0] && <small>{i.sources[0].locator}</small>}
        </div>
      ))}
    </div>
  );
}
export function Preview({
  draft,
  shops,
  onEdit,
  onPlan,
  onBusy,
  onProduction,
  onUpdates,
  onMappingConfirmed,
  selectedShopConnectionId = null,
}: {
  draft: ListingDraft;
  shops: ShopConnection[];
  onEdit: (section?: 'content' | 'images' | 'structure') => void;
  onPlan: (p: ChangePlan) => void;
  onBusy?: (busy: boolean) => void;
  onProduction?: (target: PreviewContinuation) => void;
  onUpdates?: () => void;
  onMappingConfirmed?: (draft: ListingDraft) => void;
  selectedShopConnectionId?: string | null;
}) {
  const sourceKey = draft.productKey + ':' + draft.revision, sourceRef = useRef(sourceKey);
  sourceRef.current = sourceKey;
  const sourceIntent = sourceListingIntent(draft.sourceListingId?.value);
  const [active, setActive] = useState(draft.coverKey),
    [shop, setShop] = useState(selectedShopConnectionId ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [planShop, setPlanShop] = useState('');
  const saveLock = useRef(false);
  const decisionLock = useRef(false), alive = useRef(true);
  const mappingRead = useRef<AbortController | null>(null), priceRead = useRef<AbortController | null>(null);
  const mappingGeneration = useRef(0), priceGeneration = useRef(0);
  useEffect(() => { setShop(selectedShopConnectionId ?? ''); }, [selectedShopConnectionId]);
  const productionShops = shops.filter(connection => connection.scope.environment === 'production');
  const selectedProductionShop = productionShops.filter(connection => connection.id === shop);
  const productionShop = selectedProductionShop.length === 1 ? selectedProductionShop[0] : null;
  const [mappingReview, setMappingReview] = useState<MappingReview | null>(null),
    [mappingBusy, setMappingBusy] = useState(false);
  const [mappingStatus, setMappingStatus] = useState<'loading' | 'ready' | 'failed' | 'none'>(draft.sourceSelection ? 'loading' : 'none'),
    [mappingError, setMappingError] = useState(''), [mappingOpen, setMappingOpen] = useState(false), [mappingAwaitingRevision, setMappingAwaitingRevision] = useState<number | null>(null);
  const [priceReview, setPriceReview] = useState<PriceMappingReview | null>(null),
    [priceBusy, setPriceBusy] = useState(false);
  const operationBusy = busy || mappingBusy || priceBusy;
  const currentMapping = mappingReview?.productKey === draft.productKey && mappingReview.revision === draft.revision ? mappingReview : null;
  const currentPriceReview = priceReview?.productKey === draft.productKey && priceReview.revision === draft.revision ? priceReview : null;
  const canConfirmPrice = !!currentMapping && !currentMapping.requiresConfirmation && mappingStatus === 'ready' && mappingAwaitingRevision === null;
  const activeRequest = (key: string) => alive.current && sourceRef.current === key;
  useEffect(() => { alive.current = true; return () => { alive.current = false; mappingRead.current?.abort(); priceRead.current?.abort(); }; }, []);
  useEffect(() => {
    setActive(draft.coverKey); setMappingReview(null); setPriceReview(null); setMappingOpen(false); setMappingError(''); setError(''); setMappingAwaitingRevision(null);
    priceRead.current?.abort(); priceGeneration.current += 1; setPriceBusy(false);
    if (draft.sourceSelection) void openMappingReview(false);
    else { mappingRead.current?.abort(); mappingGeneration.current += 1; setMappingStatus('none'); setMappingBusy(false); }
    return () => { mappingRead.current?.abort(); priceRead.current?.abort(); };
  }, [sourceKey, !!draft.sourceSelection]);
  async function openPriceReview() {
    if (operationBusy || decisionLock.current || mappingAwaitingRevision !== null) return;
    const key = sourceKey, generation = ++priceGeneration.current, controller = new AbortController();
    priceRead.current?.abort(); priceRead.current = controller;
    setPriceBusy(true); setError('');
    try {
      const reviewed = await api<PriceMappingReview>('/v1/products/' + encodeURIComponent(draft.productKey) + '/price-mapping-review', { signal: controller.signal });
      if (!activeRequest(key) || generation !== priceGeneration.current || controller.signal.aborted) return;
      if (reviewed.productKey !== draft.productKey || reviewed.revision !== draft.revision) throw Error('Listing đã có bản mới. Mở lại trước khi đối chiếu SKU và giá.');
      setPriceReview(reviewed);
    } catch (cause) { if (activeRequest(key) && generation === priceGeneration.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Chưa đọc được bảng đối chiếu SKU và giá.'); }
    finally { if (activeRequest(key) && generation === priceGeneration.current) setPriceBusy(false); }
  }
  async function confirmPriceReview() {
    if (!currentPriceReview || !canConfirmPrice || currentPriceReview.issues.length || operationBusy || decisionLock.current) return;
    const key = sourceKey, reviewed = currentPriceReview;
    decisionLock.current = true; setPriceBusy(true); setError(''); onBusy?.(true);
    try {
      await post('/v1/products/' + encodeURIComponent(draft.productKey) + '/confirm-price-mapping', {
        expectedRevision: reviewed.revision, expectedFingerprint: reviewed.fingerprint,
      });
      if (activeRequest(key)) setPriceReview({ ...reviewed, confirmed: true });
    } catch (cause) { if (activeRequest(key)) { setPriceReview(null); setError(cause instanceof Error ? cause.message : 'Nguồn đã đổi. Mở lại bảng đối chiếu trước khi xác nhận.'); } }
    finally { decisionLock.current = false; onBusy?.(false); if (activeRequest(key)) setPriceBusy(false); }
  }
  async function openMappingReview(expand = true) {
    if (decisionLock.current) return;
    const key = sourceKey, generation = ++mappingGeneration.current, controller = new AbortController();
    mappingRead.current?.abort(); mappingRead.current = controller;
    setMappingBusy(true); setMappingStatus('loading'); setMappingError('');
    try {
      const raw = await api<unknown>('/v1/products/' + encodeURIComponent(draft.productKey) + '/mapping-review', { signal: controller.signal });
      if (!activeRequest(key) || generation !== mappingGeneration.current || controller.signal.aborted) return;
      const reviewed = mappingReviewSchema.parse(raw);
      if (reviewed.productKey !== draft.productKey || reviewed.revision !== draft.revision) throw Error('Bản nguồn đã đổi. Mở lại listing mới nhất trước khi xác nhận.');
      setMappingReview(reviewed); setMappingStatus('ready'); setMappingOpen(expand);
    } catch (cause) { if (activeRequest(key) && generation === mappingGeneration.current && !controller.signal.aborted) {
      setMappingReview(null); setMappingStatus('failed'); setMappingError(cause instanceof z.ZodError ? 'Chưa đọc được đầy đủ hồ sơ xác nhận cấu trúc của bản nguồn này.' : cause instanceof Error ? cause.message : 'Chưa đọc được bản ánh xạ.');
    } }
    finally { if (activeRequest(key) && generation === mappingGeneration.current) setMappingBusy(false); }
  }
  async function confirmMapping() {
    if (!currentMapping?.requiresConfirmation || !mappingOpen || operationBusy || decisionLock.current) return;
    const key = sourceKey, reviewed = currentMapping;
    decisionLock.current = true; setMappingBusy(true); setPriceReview(null); priceRead.current?.abort(); priceGeneration.current += 1; setError(''); onBusy?.(true);
    try {
      const updated = await post<ListingDraft>('/v1/products/' + encodeURIComponent(draft.productKey) + '/confirm-mapping', {
        expectedRevision: reviewed.revision,
        expectedFingerprint: reviewed.fingerprint,
      });
      if (!activeRequest(key)) return;
      if (updated.productKey !== draft.productKey || updated.revision !== reviewed.revision + 1 || !updated.sourceSelection) throw Error('Chưa đối chiếu được phiên bản vừa xác nhận. Mở bản nguồn đã lưu trước khi xác nhận giá.');
      setMappingReview(null); setMappingOpen(false); setMappingAwaitingRevision(updated.revision);
      onMappingConfirmed?.(updated);
    } catch (cause) { if (activeRequest(key)) { setMappingReview(null); setMappingOpen(false); setMappingStatus('failed'); setMappingError(cause instanceof Error ? cause.message : 'Bản ánh xạ đã đổi. Đọc lại trước khi xác nhận.'); } }
    finally { decisionLock.current = false; onBusy?.(false); if (activeRequest(key)) setMappingBusy(false); }
  }
  const sourceChecks: {
    title: string;
    detail: string;
    present: boolean;
    section: 'content' | 'images' | 'structure';
  }[] = [
    {
      title: 'Tiêu đề và nội dung',
      detail: 'Xem nguyên văn nội dung đã chọn',
      present:
        !!draft.title.value && draft.description.some((b) => b.type === 'text' && b.text !== ''),
      section: 'content',
    },
    {
      title: 'Ảnh bìa và ảnh sản phẩm',
      detail: 'Xem đúng ảnh và thứ tự trong bộ',
      present: !!draft.coverKey && draft.galleryKeys.length > 0,
      section: 'images',
    },
    {
      title: 'Phân loại và giá nguồn',
      detail: 'Đối chiếu từng SKU với bảng giá',
      present:
        draft.variants.length > 0 &&
        draft.variants.every((v) => !!v.sku.value && /^\d+$/.test(v.originalPrice.value)),
      section: 'structure',
    },
  ];
  async function prepare() {
    if (saveLock.current || !shops.some((s) => s.id === planShop)) return;
    saveLock.current = true;
    setBusy(true);
    onBusy?.(true);
    setError('');
    try {
      onPlan(
        await post<ChangePlan>('/v1/plans', {
          productKey: draft.productKey,
          sourceRevision: draft.revision,
          connectionId: planShop,
          operation: 'create',
          fieldMask: ['title', 'description', 'gallery', 'variations', 'price'],
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saveLock.current = false;
      setBusy(false);
      onBusy?.(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Bộ đã lưu · Bản nguồn {draft.revision}</p>
          <h1>Kiểm tra listing</h1>
          <p>Đối chiếu bộ đã chuẩn bị trước khi chọn shop. Mở xem không thay đổi dữ liệu.</p>
        </div>
        <button disabled={busy || !draft.sourceSelection} onClick={() => onEdit()}>
          Đối chiếu nguồn
        </button>
      </div>
      <section className="panel next-actions preview-source-review" aria-label="Việc tiếp theo">
        <div className="section-heading">
          <div>
            <h2>Việc tiếp theo</h2>
            <p>
              Kiểm tra từng phần của bộ nguồn. “Đã có nguồn” chưa có nghĩa đã đạt điều kiện đăng.
            </p>
          </div>
          <span className="tag neutral">{draft.variants.length} SKU trong bộ</span>
        </div>
        <div className="source-checks">
          {sourceChecks.map((check) => (
            <button
              key={check.section}
              disabled={busy || !draft.sourceSelection}
              onClick={() => onEdit(check.section)}
            >
              <span className={'tag ' + (check.present ? 'neutral' : 'danger')}>
                {check.present ? 'Đã có nguồn' : 'Cần bạn bổ sung'}
              </span>
              <strong>{check.title}</strong>
              <small>{check.detail}</small>
              <span className="check-action">
                {check.present ? 'Mở để đối chiếu' : 'Mở phần cần bổ sung'} →
              </span>
            </button>
          ))}
        </div>
        {draft.sourceSelection && mappingStatus === 'loading' && <p role="status">Đang đọc trạng thái xác nhận cấu trúc và ảnh của bản nguồn này…</p>}
        {draft.sourceSelection && mappingStatus === 'failed' && <div className="authoring-source-notice" role="status">
          <strong>Chưa xác định được yêu cầu xác nhận cấu trúc</strong><p>{mappingError} Chưa thể xác nhận SKU và giá khi trạng thái cấu trúc còn cần đối chiếu.</p>
          <div className="actions"><button disabled={operationBusy} onClick={() => void openMappingReview(false)}>Đọc lại trạng thái xác nhận cấu trúc</button>
            <button disabled={operationBusy} onClick={() => onEdit()}>Mở nguồn đã lưu để đối chiếu</button></div>
        </div>}
        {mappingAwaitingRevision !== null && <p role="status">Đã lưu xác nhận cấu trúc ở bản nguồn {mappingAwaitingRevision}. Mở đúng bản mới trước khi đối chiếu SKU và giá.</p>}
        {draft.sourceSelection && mappingStatus === 'ready' && currentMapping && !currentMapping.requiresConfirmation && <p className="caption" role="status">Đã có xác nhận cấu trúc và ảnh cho bản nguồn hiện tại. {currentMapping.approvalBasis === 'stored_folder' ? 'Hồ sơ bộ thư mục vẫn khớp nguồn đã lưu.' : 'Biên nhận khớp đúng phiên bản và tệp nguồn.'}</p>}
        {draft.sourceSelection && mappingStatus === 'ready' && currentMapping?.requiresConfirmation && (
          <div className="application-limit">
            <strong>Xác nhận cấu trúc và đúng ảnh nguồn</strong>
            <p>Xem lại từng tầng phân loại, SKU, giá và vai trò ảnh. Xác nhận bước này tạo bản nguồn mới; sau đó đối chiếu giá cho đúng bản mới. Lưu nháp không tự xác nhận.</p>
            <button disabled={operationBusy} onClick={() => void openMappingReview()}>Xem bản ánh xạ cần xác nhận</button>
            {mappingOpen && <div aria-label="Đối chiếu ánh xạ nguồn">
              <p><strong>{currentMapping.mapping.title}</strong></p>
              <p>Phân loại: {currentMapping.mapping.tierNames.join(' → ') || 'Một sản phẩm không phân loại'}</p>
              <p>Ảnh bìa: {currentMapping.imageRoles.cover ?? 'Chưa có'}</p>
              <p>Ảnh listing: {currentMapping.imageRoles.gallery.join(' · ') || 'Chưa có'}</p>
              <ol>{currentMapping.mapping.variants.map((variant, index) => <li key={index}>
                {variant.optionLabels.join(' / ') || 'Sản phẩm lẻ'} · SKU {variant.sku} · Giá {money(variant.originalPrice)} · Ảnh phân loại {currentMapping.imageRoles.variants[index] ?? 'Không có'}
              </li>)}</ol>
              <details className="image-file-evidence"><summary>Thông tin {currentMapping.sourceHashes.length} tệp nguồn để đối chiếu</summary>
                <ul>{currentMapping.sourceHashes.map(source => <li key={source.importId}>{source.kind === 'xlsx' ? 'Bảng giá' : source.kind === 'docx' ? 'Nội dung Word' : 'Ảnh'} · <code>{source.sha256}</code></li>)}</ul>
              </details>
              <button disabled={operationBusy} onClick={() => void confirmMapping()}>Tôi đã đối chiếu và xác nhận đúng ánh xạ này</button>
            </div>}
          </div>
        )}
        {draft.sourceSelection && <div className="application-limit">
          <strong>Đối chiếu SKU và giá sau khi tạo listing</strong>
          <p>Hệ thống đọc lại từng dòng và ô trong file giá gốc. Anh xác nhận đúng sản phẩm, mùi, cỡ và giá cho từng phân loại.</p>
          {!canConfirmPrice && <p className="caption">Xác nhận cấu trúc và ảnh trước khi xác nhận SKU và giá. Bạn vẫn có thể mở bảng để đối chiếu nguồn; chưa tạo biên nhận giá.</p>}
          <button disabled={operationBusy || mappingAwaitingRevision !== null} onClick={() => void openPriceReview()}>Xem bảng đối chiếu SKU và giá</button>
          {currentPriceReview && <div aria-label="Bảng đối chiếu SKU và giá">
            <p>{currentPriceReview.confirmed ? 'Đã xác nhận cho đúng phiên bản listing này.' : 'Chưa xác nhận.'}</p>
            <ol>{currentPriceReview.rows.map(row => <li key={row.slotKey}>
              <strong>{row.optionLabels.join(' / ') || 'Sản phẩm lẻ'}</strong> → {row.sourceName} · SKU {row.sku} · Giá gốc {money(row.originalPrice)}
              <small> · {row.sourceFilename} (nhập {new Date(row.sourceImportedAt).toLocaleString('vi-VN')}) · {row.sheetName}, SKU {row.skuCell}, giá {row.priceCell}, bộ giá {row.priceProfile ?? 'không phân bộ'} · dấu kiểm file {row.fileSha256}</small>
            </li>)}</ol>
            {currentPriceReview.issues.length > 0 && <div className="source-issues"><h3>Cần anh xử lý trước khi xác nhận</h3>
              <ul>{currentPriceReview.issues.map((item, index) => <li key={index}>{item.message}</li>)}</ul>
            </div>}
            {!currentPriceReview.confirmed && <button disabled={operationBusy || !canConfirmPrice || currentPriceReview.issues.length > 0}
              onClick={() => void confirmPriceReview()}>Tôi đã đối chiếu từng phân loại, SKU và giá nguồn</button>}
          </div>}
        </div>}
        {draft.issues.length > 0 && (
          <div className="source-issues">
            <h3>Thông tin cần kiểm tra từ nguồn</h3>
            <Issues issues={draft.issues} />
          </div>
        )}
        <div className="application-limit">
          {sourceIntent.kind === 'update' ? <>
            <strong>Cập nhật link đã có: {sourceIntent.itemId}</strong>
            <p>Bộ nguồn có ID listing. Chọn đúng shop và các phần muốn thay trong Cập nhật listing;
              hệ thống không dùng bộ này để tạo link mới. Việc lưu bộ cập nhật chưa gửi lên Shopee.</p>
            {onUpdates && <button disabled={busy} onClick={onUpdates}>Mở Cập nhật listing</button>}
          </> : sourceIntent.kind === 'invalid' ? <>
            <strong>ID listing trong nguồn chưa hợp lệ</strong>
            <p>Kiểm tra lại ID của link cần cập nhật. Hệ thống không tự chuyển thành đăng mới.</p>
          </> : <>
          <strong>Tiếp tục đăng qua API</strong>
          <p>
            Màn hình này dùng để xem và sửa bộ nguồn. Vào Đăng hàng để xem đợt đang làm,
            kiểm tra ngành, giá, tồn và vận chuyển, rồi tự bấm gửi qua API.
            Nếu bộ đã nằm trong một đợt, tiếp tục đợt đó để tránh đăng trùng.
          </p>
          {onProduction && <div className="authoring-shop-context">
            <label>Shop để tiếp tục
              <select value={shop} disabled={operationBusy} onChange={event => setShop(event.target.value)}>
                <option value="">Chọn shop để tiếp tục</option>
                {shop && !productionShop && <option value={shop}>Shop đã chọn chưa có trong danh sách hiện tại</option>}
                {productionShops.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.scope.shopId}</option>)}
              </select>
            </label>
            <button disabled={operationBusy || !shop} onClick={() => onProduction({ productKey: draft.productKey, revision: draft.revision, shopConnectionId: shop || null })}>Mở đợt đăng qua API</button>
            <p className="caption">{productionShop ? `Tiếp tục riêng ${draft.title.value} · bản nguồn ${draft.revision} · shop ${productionShop.scope.shopId}.` : shop ? 'Shop đã chọn chưa sẵn sàng. Mở kết nối để xử lý; hệ thống giữ đúng shop này.' : 'Chọn đúng shop đích; ứng dụng không tự chọn shop đầu tiên.'}</p>
          </div>}
          </>}
        </div>
      </section>
      <div className="preview-layout">
        <section className="panel photo-panel">
          {active || draft.coverKey ? (
            <img className="cover" src={media(active || draft.coverKey)} alt="Ảnh sản phẩm gốc" />
          ) : (
            <div className="empty">Chưa chọn ảnh bìa từ bộ nguồn</div>
          )}
          <div className="filmstrip">
            {[...new Set([draft.coverKey, ...draft.galleryKeys])].filter(Boolean).map((key) => (
              <button
                key={key}
                type="button"
                aria-label={`Xem ${key === draft.coverKey ? 'ảnh bìa' : `ảnh sản phẩm ${draft.galleryKeys.indexOf(key) + 1}`}`}
                aria-pressed={active === key}
                className={active === key ? 'chosen' : ''}
                onClick={() => setActive(key)}
              >
                <img src={media(key)} alt="" loading="lazy" />
              </button>
            ))}
          </div>
          <p className="caption">
            Giữ nguyên tỉ lệ và tệp gốc. Bìa / bộ ảnh / mô tả được gán riêng.
          </p>
        </section>
        <section className="panel product-detail">
          <div className="tags">
            <span className="tag neutral">Bộ nguồn nội bộ</span>
            <span className="tag neutral">{draft.variants.length} SKU</span>
          </div>
          <h2>{draft.title.value}</h2>
          <div className="price">
            {draft.variants[0] && money(draft.variants[0].originalPrice.value)}
          </div>
          <p className="caption">
            GIÁ GỐC dùng khi đăng mới. Giá mục tiêu khuyến mại nằm ở cột riêng.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Phân loại / SKU</th>
                  <th>Giá gốc</th>
                  <th>Giá bán mục tiêu</th>
                </tr>
              </thead>
              <tbody>
                {draft.variants.map((v) => (
                  <tr key={v.key} data-testid="variant-row">
                    <td>
                      <div className="variant">
                        {v.imageKey && (
                          <img src={media(v.imageKey)} alt={v.optionLabels.join(' / ')} />
                        )}
                        <div>
                          <strong>
                            {v.optionLabels.length
                              ? v.optionLabels.join(' / ')
                              : 'Không có phân loại'}
                          </strong>
                          <small>{v.sku.value}</small>
                        </div>
                      </div>
                    </td>
                    <td title={v.originalPrice.sources.map((s) => s.locator).join(', ')}>
                      {money(v.originalPrice.value)}
                    </td>
                    <td className="muted">{money(v.promotionTarget?.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="target">
            <h3>Lưu bản kiểm tra nội bộ (luồng cũ)</h3>
            <p className="caption">
              Chỉ lưu một bản kiểm tra gắn với shop. Nút này không đăng sản phẩm và không đưa
              sản phẩm vào đợt đăng API. Dùng mục Đăng hàng để thực hiện đăng.
            </p>
            <label>
              Shop đích
              <select
                aria-label="Shop đích"
                disabled={operationBusy}
                value={planShop}
                onChange={(e) => setPlanShop(e.target.value)}
              >
                <option value="">
                  {shops.length ? 'Chọn shop cần kiểm tra' : 'Chưa thêm kết nối'}
                </option>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.scope.environment === 'sandbox' ? 'TEST' : 'LIVE'} · {s.name} ·{' '}
                    {s.scope.shopId}
                  </option>
                ))}
              </select>
            </label>
            <p data-testid="shop-scope" className="caption">
              {planShop
                ? `${shops.find((s) => s.id === planShop)?.scope.shopId} · Chỉ lưu trong ứng dụng, chưa gửi lên Shopee.`
                : 'Chưa chọn shop đích.'}
            </p>
            <button disabled={operationBusy || !planShop} onClick={() => void prepare()}>
              {busy ? 'Đang lưu…' : 'Lưu bản kiểm tra theo shop'}
            </button>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </div>
        </section>
      </div>
      <details className="coverage-details">
        <summary>Những gì còn thiếu trước khi đăng</summary>
        <dl>
          <div>
            <dt>Ngành và thuộc tính</dt>
            <dd>
              {draft.categoryId
                ? 'Có ngành trong nguồn; chưa kiểm quy tắc của shop.'
                : 'Chưa đối chiếu ngành, thương hiệu và thuộc tính theo shop.'}
            </dd>
          </div>
          <div>
            <dt>Tồn đăng bán</dt>
            <dd>
              Cần mức được quyết định riêng cho từng SKU/shop. Không lấy mức tồn thử làm mặc định.
            </dd>
          </div>
          <div>
            <dt>Vận chuyển</dt>
            <dd>Chưa kiểm đầy đủ kênh, cân nặng và kích thước theo shop.</dd>
          </div>
          <div>
            <dt>Đăng / cập nhật / QC</dt>
            <dd>Xem biên nhận và kết quả đọc lại trong đợt Đăng hàng. Bản xem nguồn này chưa phải kết quả trên Shopee.</dd>
          </div>
        </dl>
      </details>
      <section className="panel description-panel">
        <div className="section-heading">
          <h2>Mô tả sản phẩm</h2>
          <span className="caption">
            {draft.description.filter((b) => b.type === 'image').length} ảnh trong content
          </span>
        </div>
        <div className="description">
          {draft.description.map((block, i) =>
            block.type === 'text' ? (
              <p key={i}>{block.text}</p>
            ) : (
              <img
                key={i}
                data-testid="description-image"
                src={media(block.assetKey)}
                alt={'Ảnh mô tả ' + i}
                loading="lazy"
              />
            ),
          )}
        </div>
      </section>
    </>
  );
}
