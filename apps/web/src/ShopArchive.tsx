import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ArchiveTargets } from './ArchiveTargets.js';
import './shop-archive.css';

type Archive = {
  id: string;
  name: string;
  sourceShopId: string;
  itemCount: number;
  completedAt: string | null;
  selection: { includedOfficialBrands?: string[]; excludedOfficialBrands?: string[] };
};
type Item = {
  itemId: string;
  title: string;
  itemStatus: string;
  brandId: string;
  modelCount: number;
  galleryCount: number;
  videoCount: number;
};
type Detail = Item & {
  sourceShopId: string;
  evidenceId: string;
  contentHash: string;
  observedAt: string;
  rawItem: Record<string, any>;
  rawModels: Record<string, any> | null;
  mediaRefsExpected?: number;
  mediaRefsStored?: number;
  mediaRefsFailed?: number;
  mediaRefsPending?: number;
  mediaCaptureComplete?: boolean;
  copyReadiness: string;
};
export function ShopArchive() {
  const [archives, setArchives] = useState<Archive[]>([]);
  const [archiveId, setArchiveId] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    void api<Archive[]>('/v1/seller-knowledge/archives').then((value) => {
      if (!active) return;
      setArchives(value);
      setArchiveId((old) => old || value[0]?.id || '');
    }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!archiveId) return;
    let active = true;
    setLoading(true);
    setError('');
    setSelected(null);
    setDetail(null);
    void api<Item[]>(`/v1/seller-knowledge/archives/${encodeURIComponent(archiveId)}/items?limit=100`)
      .then((value) => { if (active) setItems(value); })
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [archiveId]);

  useEffect(() => {
    if (!archiveId || !selected) return;
    let active = true;
    void api<Detail>(`/v1/seller-knowledge/archives/${encodeURIComponent(archiveId)}/items/${selected}`)
      .then((value) => { if (active) setDetail(value); })
      .catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [archiveId, selected]);

  const current = archives.find((archive) => archive.id === archiveId);
  const tierNames = detail?.rawModels?.tier_variation?.map((tier: any) => tier.name) ?? [];
  const modelSkus = detail?.rawModels?.model?.map((model: any) => model.model_sku).filter(Boolean) ?? [];
  const parentSku = detail?.rawItem?.item_sku;
  const sourceShop = current?.sourceShopId ?? detail?.sourceShopId;
  return <section className="shop-archive panel" aria-labelledby="shop-archive-heading">
    <header className="shop-archive-header">
      <div>
        <h1 id="shop-archive-heading">Kho nguồn để sao chép</h1>
        <p className="caption">Bản chụp Shopee theo đúng shop và item. Ảnh, video được lưu ngoài PostgreSQL theo dấu kiểm nội dung.</p>
      </div>
      <label>Kho đã lưu
        <select value={archiveId} onChange={(event) => setArchiveId(event.target.value)}>
          {archives.map((archive) => <option value={archive.id} key={archive.id}>{archive.name} · {archive.itemCount} listing</option>)}
        </select>
      </label>
    </header>
    {error && <p className="shop-archive-error" role="alert">{error}</p>}
    {current && <div className="shop-archive-summary">
      <strong>{current.itemCount} listing</strong>
      <span>Shop nguồn {current.sourceShopId}</span>
      <span>Giữ: {current.selection.includedOfficialBrands?.join(', ') || 'theo bộ nguồn'}</span>
      <span>Loại: {current.selection.excludedOfficialBrands?.join(', ') || 'không có'}</span>
    </div>}
    {archiveId && <ArchiveTargets archiveId={archiveId} sourceShopId={sourceShop ?? ''} itemCount={current?.itemCount ?? 0} />}
    <div className="shop-archive-grid">
      <div>
        <h2>Listing nguồn</h2>
        {loading && <p>Đang đọc kho…</p>}
        <ul className="shop-archive-list">
          {items.map((item) => <li key={item.itemId}>
            <button type="button" aria-pressed={selected === item.itemId} onClick={() => setSelected(item.itemId)}>
              <strong>{item.title}</strong>
              <small>{item.itemId} · {item.modelCount || 1} SKU · {item.galleryCount} ảnh · {item.videoCount} video</small>
            </button>
          </li>)}
        </ul>
      </div>
      <div className="shop-archive-detail">
        <h2>Chi tiết nguồn</h2>
        {!selected && <p className="caption">Chọn một listing để xem cấu trúc và tình trạng media.</p>}
        {selected && !detail && <p>Đang đọc bản chụp…</p>}
        {detail && <>
          <h3>{detail.title}</h3>
          <p><a href={`https://banhang.shopee.vn/portal/product/${detail.itemId}`} target="_blank" rel="noreferrer">Mở listing nguồn {detail.itemId}</a></p>
          <dl>
            <div><dt>Trạng thái nguồn</dt><dd>{detail.itemStatus}</dd></div>
            <div><dt>Tầng phân loại</dt><dd>{tierNames.length ? tierNames.join(' / ') : 'Không có'}</dd></div>
            <div><dt>SKU</dt><dd>{modelSkus.length ? modelSkus.length : parentSku ? 1 : 0}</dd></div>
            <div><dt>Ảnh / video</dt><dd>{detail.galleryCount} / {detail.videoCount}</dd></div>
            <div><dt>Tệp media</dt><dd>{detail.mediaRefsStored ?? 0}/{detail.mediaRefsExpected ?? 0} đã lưu</dd></div>
            <div><dt>Đọc từ Shopee</dt><dd>{new Date(detail.observedAt).toLocaleString('vi-VN')}</dd></div>
          </dl>
          {!detail.mediaCaptureComplete && <p className="caption">Media còn đang lưu; chưa thể dùng bản này để đăng ở shop khác.</p>}
          <p className="caption">Trước khi sao chép, từng shop đích còn phải xác minh ngành, thương hiệu, vận chuyển, SKU trùng và quyền dùng media. Trạng thái đăng đích sẽ là ẩn.</p>
        </>}
      </div>
    </div>
  </section>;
}
