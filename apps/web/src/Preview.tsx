import { useState } from 'react';
import type { ChangePlan, ListingDraft, ShopConnection } from '@shopee/domain';
import { sourceListingIntent } from '../../../packages/domain/src/source-catalog.js';
import { api, media, money, post } from './api.js';
type MappingReview = {
  productKey: string; revision: number; fingerprint: string;
  mapping: { title: string; tierNames: string[]; variants: Array<{ sku: string; optionLabels: string[]; originalPrice: string }> };
  imageRoles: { cover: string | null; gallery: Array<string | null>; variants: Array<string | null> };
};
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
}: {
  draft: ListingDraft;
  shops: ShopConnection[];
  onEdit: (section?: 'content' | 'images' | 'structure') => void;
  onPlan: (p: ChangePlan) => void;
  onBusy?: (busy: boolean) => void;
  onProduction?: () => void;
  onUpdates?: () => void;
  onMappingConfirmed?: (draft: ListingDraft) => void;
}) {
  const sourceIntent = sourceListingIntent(draft.sourceListingId?.value);
  const [active, setActive] = useState(draft.coverKey),
    [shop, setShop] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [mappingReview, setMappingReview] = useState<MappingReview | null>(null),
    [mappingBusy, setMappingBusy] = useState(false);
  const [priceReview, setPriceReview] = useState<PriceMappingReview | null>(null),
    [priceBusy, setPriceBusy] = useState(false);
  async function openPriceReview() {
    setPriceBusy(true); setError('');
    try {
      const reviewed = await api<PriceMappingReview>('/v1/products/' + encodeURIComponent(draft.productKey) + '/price-mapping-review');
      if (reviewed.revision !== draft.revision) throw Error('Listing đã có bản mới. Mở lại trước khi đối chiếu SKU và giá.');
      setPriceReview(reviewed);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa đọc được bảng đối chiếu SKU và giá.'); }
    finally { setPriceBusy(false); }
  }
  async function confirmPriceReview() {
    if (!priceReview || priceReview.issues.length || priceBusy) return;
    setPriceBusy(true); setError('');
    try {
      await post('/v1/products/' + encodeURIComponent(draft.productKey) + '/confirm-price-mapping', {
        expectedRevision: priceReview.revision, expectedFingerprint: priceReview.fingerprint,
      });
      setPriceReview({ ...priceReview, confirmed: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Nguồn đã đổi. Mở lại bảng đối chiếu trước khi xác nhận.'); }
    finally { setPriceBusy(false); }
  }
  async function openMappingReview() {
    setMappingBusy(true); setError('');
    try {
      const reviewed = await api<MappingReview>('/v1/products/' + encodeURIComponent(draft.productKey) + '/mapping-review');
      if (reviewed.revision !== draft.revision) throw Error('Bản nguồn đã đổi. Mở lại listing mới nhất trước khi xác nhận.');
      setMappingReview(reviewed);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa đọc được bản ánh xạ.'); }
    finally { setMappingBusy(false); }
  }
  async function confirmMapping() {
    if (!mappingReview || mappingBusy) return;
    setMappingBusy(true); setError('');
    try {
      const updated = await post<ListingDraft>('/v1/products/' + encodeURIComponent(draft.productKey) + '/confirm-mapping', {
        expectedRevision: mappingReview.revision,
        expectedFingerprint: mappingReview.fingerprint,
      });
      setMappingReview(null);
      onMappingConfirmed?.(updated);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Bản ánh xạ đã đổi. Đọc lại trước khi xác nhận.'); }
    finally { setMappingBusy(false); }
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
    if (!shops.some((s) => s.id === shop)) return;
    setBusy(true);
    onBusy?.(true);
    setError('');
    try {
      onPlan(
        await post<ChangePlan>('/v1/plans', {
          productKey: draft.productKey,
          sourceRevision: draft.revision,
          connectionId: shop,
          operation: 'create',
          fieldMask: ['title', 'description', 'gallery', 'variations', 'price'],
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
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
      <section className="panel next-actions" aria-label="Việc tiếp theo">
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
        {draft.sourceSelection && !draft.sourceSelection.folderBinding && (
          <div className="application-limit">
            <strong>Xác nhận cấu trúc và đúng ảnh nguồn</strong>
            <p>Xem lại từng tầng phân loại, SKU, giá và vai trò ảnh. Lưu nháp không tự xác nhận.</p>
            <button disabled={busy || mappingBusy} onClick={() => void openMappingReview()}>Xem bản ánh xạ cần xác nhận</button>
            {mappingReview && <div aria-label="Đối chiếu ánh xạ nguồn">
              <p><strong>{mappingReview.mapping.title}</strong></p>
              <p>Phân loại: {mappingReview.mapping.tierNames.join(' → ') || 'Một sản phẩm không phân loại'}</p>
              <p>Ảnh bìa: {mappingReview.imageRoles.cover ?? 'Chưa có'}</p>
              <p>Ảnh listing: {mappingReview.imageRoles.gallery.join(' · ') || 'Chưa có'}</p>
              <ol>{mappingReview.mapping.variants.map((variant, index) => <li key={index}>
                {variant.optionLabels.join(' / ') || 'Sản phẩm lẻ'} · SKU {variant.sku} · Giá {money(variant.originalPrice)} · Ảnh phân loại {mappingReview.imageRoles.variants[index] ?? 'Không có'}
              </li>)}</ol>
              <button disabled={busy || mappingBusy} onClick={() => void confirmMapping()}>Tôi đã đối chiếu và xác nhận đúng ánh xạ này</button>
            </div>}
          </div>
        )}
        {draft.sourceSelection && <div className="application-limit">
          <strong>Đối chiếu SKU và giá sau khi tạo listing</strong>
          <p>Hệ thống đọc lại từng dòng và ô trong file giá gốc. Anh xác nhận đúng sản phẩm, mùi, cỡ và giá cho từng phân loại.</p>
          <button disabled={busy || priceBusy} onClick={() => void openPriceReview()}>Xem bảng đối chiếu SKU và giá</button>
          {priceReview && <div aria-label="Bảng đối chiếu SKU và giá">
            <p>{priceReview.confirmed ? 'Đã xác nhận cho đúng phiên bản listing này.' : 'Chưa xác nhận.'}</p>
            <ol>{priceReview.rows.map(row => <li key={row.slotKey}>
              <strong>{row.optionLabels.join(' / ') || 'Sản phẩm lẻ'}</strong> → {row.sourceName} · SKU {row.sku} · Giá gốc {money(row.originalPrice)}
              <small> · {row.sourceFilename} (nhập {new Date(row.sourceImportedAt).toLocaleString('vi-VN')}) · {row.sheetName}, SKU {row.skuCell}, giá {row.priceCell}, bộ giá {row.priceProfile ?? 'không phân bộ'} · dấu kiểm file {row.fileSha256}</small>
            </li>)}</ol>
            {priceReview.issues.length > 0 && <div className="source-issues"><h3>Cần anh xử lý trước khi xác nhận</h3>
              <ul>{priceReview.issues.map((item, index) => <li key={index}>{item.message}</li>)}</ul>
            </div>}
            {!priceReview.confirmed && <button disabled={busy || priceBusy || priceReview.issues.length > 0}
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
          {onProduction && <button disabled={busy} onClick={onProduction}>Mở đợt đăng qua API</button>}
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
                className={active === key ? 'chosen' : ''}
                onClick={() => setActive(key)}
              >
                <img src={media(key)} alt="Chọn ảnh xem trước" />
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
                disabled={busy}
                value={shop}
                onChange={(e) => setShop(e.target.value)}
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
              {shop
                ? `${shops.find((s) => s.id === shop)?.scope.shopId} · Chỉ lưu trong ứng dụng, chưa gửi lên Shopee.`
                : 'Chưa chọn shop đích.'}
            </p>
            <button disabled={busy || !shop} onClick={() => void prepare()}>
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
