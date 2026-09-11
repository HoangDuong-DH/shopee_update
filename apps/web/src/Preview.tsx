import { useState } from 'react';
import type { ChangePlan, ListingDraft, ShopConnection } from '@shopee/domain';
import { media, money, post } from './api.js';
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
}: {
  draft: ListingDraft;
  shops: ShopConnection[];
  onEdit: () => void;
  onPlan: (p: ChangePlan) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [active, setActive] = useState(draft.coverKey),
    [shop, setShop] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
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
          <p className="eyebrow">
            {draft.productKey} · Bản nguồn {draft.revision}
          </p>
          <h1>Kiểm tra listing</h1>
          <p>Đối chiếu bộ đã chuẩn bị trước khi chọn shop. Mở xem không thay đổi dữ liệu.</p>
        </div>
        <button disabled={busy || !draft.sourceSelection} onClick={onEdit}>
          Đối chiếu nguồn
        </button>
      </div>
      <section className="review-summary" aria-label="Các bước kiểm tra">
        <div>
          <strong>{draft.variants.length} SKU trong bộ</strong>
          <span>Giữ thứ tự và tên phân loại đã lưu</span>
        </div>
        <div>
          <strong>
            {draft.issues.some((i) => i.severity === 'block')
              ? 'Cần bổ sung nguồn'
              : 'Đã có bản nguồn'}
          </strong>
          <span>Chưa kiểm đầy đủ điều kiện theo shop</span>
        </div>
        <div>
          <strong>Chưa có kết quả từ Shopee</strong>
          <span>Chức năng gửi và đọc lại chưa mở</span>
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
            <h3>Kiểm tra theo shop</h3>
            <p className="caption">
              Chọn rõ shop để lưu một bản kiểm tra nội bộ cho luồng đăng mới. Cập nhật link đang có
              cần đối chiếu mã sản phẩm trên Shopee; bước đó chưa mở.
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
            <button className="primary" disabled={busy || !shop} onClick={() => void prepare()}>
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
      <Issues issues={draft.issues} />
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
            <dd>Chưa có bộ thực thi và đối chiếu kết quả Shopee trong ứng dụng.</dd>
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
