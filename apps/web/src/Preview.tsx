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
}: {
  draft: ListingDraft;
  shops: ShopConnection[];
  onEdit: () => void;
  onPlan: (p: ChangePlan) => void;
}) {
  const [active, setActive] = useState(draft.coverKey),
    [shop, setShop] = useState(shops[0]?.id ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function prepare() {
    setBusy(true);
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
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">BẢN NHÁP · PHIÊN BẢN {draft.revision}</p>
          <h1>Xem trước listing</h1>
          <p>Ảnh và nội dung từ bộ nguồn đã chọn.</p>
        </div>
        <button onClick={onEdit}>Chỉnh mapping</button>
      </div>
      <div className="preview-layout">
        <section className="panel photo-panel">
          <img className="cover" src={media(active || draft.coverKey)} alt="Ảnh sản phẩm gốc" />
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
            <span className="tag">CHƯA GỬI TỪ ỨNG DỤNG</span>
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
                  <th>Mục tiêu KM</th>
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
                          <strong>{v.optionLabels.join(' / ')}</strong>
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
            <label>
              Shop đích
              <select value={shop} onChange={(e) => setShop(e.target.value)}>
                {!shops.length && <option value="">Chưa thêm kết nối</option>}
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.scope.environment === 'sandbox' ? 'TEST' : 'LIVE'} · {s.name} ·{' '}
                    {s.scope.shopId}
                  </option>
                ))}
              </select>
            </label>
            <p data-testid="shop-scope" className="caption">
              {shops.find((s) => s.id === shop)?.scope.shopId} · Kế hoạch chưa gửi API. Tồn đăng bán
              cần lệnh riêng theo SKU/shop.
            </p>
            <button className="primary" disabled={busy || !shop} onClick={() => void prepare()}>
              {busy ? 'Đang lưu…' : 'Lưu kế hoạch cho shop này'}
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
