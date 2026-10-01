import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

type Target = { partnerId: string; shopId: string; displayName?: string };
type CopyPlan = {
  archiveId: string;
  sourceShopId: string;
  sourcePartnerId: string;
  revision: number;
  targets: Target[];
  policy: { targetStatus: 'UNLIST'; stockStrategy: 'source_saleable_snapshot'; priceStrategy: 'source_original'; promotionStrategy: 'record_exception' };
};
type Shop = {
  id: string;
  officialName?: string | null;
  displayName?: string | null;
  state: string;
  scope: { environment: string; partnerId: string; shopId: string };
};
type Connection = { partnerId: string; shopId: string; state: string; officialName?: string | null };

export function ArchiveTargets({ archiveId, sourceShopId, itemCount }: { archiveId: string; sourceShopId: string; itemCount: number }) {
  const [plan, setPlan] = useState<CopyPlan | null>(null);
  const [draft, setDraft] = useState<Target[]>([]);
  const [shops, setShops] = useState<Shop[]>([]);
  const [connections, setConnections] = useState<Record<string, Connection>>({});
  const [knownId, setKnownId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [shopId, setShopId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    if (!archiveId) return;
    let active = true;
    setPlan(null);
    setDraft([]);
    setConnections({});
    setError('');
    void Promise.all([
      api<CopyPlan>('/v1/seller-knowledge/archives/' + encodeURIComponent(archiveId) + '/copy-plan'),
      api<{ shops: Shop[] }>('/v1/seller-knowledge/shops'),
    ]).then(([nextPlan, result]) => {
      if (!active) return;
      setPlan(nextPlan);
      setDraft(nextPlan.targets);
      setPartnerId(nextPlan.sourcePartnerId);
      setShops(result.shops.filter((shop) => shop.scope.environment === 'production'));
    }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [archiveId]);

  useEffect(() => {
    if (!plan) return;
    let active = true;
    void Promise.all(draft.map(async (target) => {
      try {
        const connection = await api<Connection>(
          '/v1/connections/production?partnerId=' + encodeURIComponent(target.partnerId) +
          '&shopId=' + encodeURIComponent(target.shopId));
        return [target.partnerId + ':' + target.shopId, connection] as const;
      } catch {
        return [target.partnerId + ':' + target.shopId,
          { partnerId: target.partnerId, shopId: target.shopId, state: 'unavailable' }] as const;
      }
    })).then((entries) => { if (active) setConnections(Object.fromEntries(entries)); });
    return () => { active = false; };
  }, [plan, draft, refreshCount]);

  const availableShops = useMemo(() => shops.filter((shop) =>
    shop.scope.shopId !== sourceShopId &&
    !draft.some((target) =>
      target.partnerId === shop.scope.partnerId && target.shopId === shop.scope.shopId),
  ), [shops, sourceShopId, draft]);
  const changed = plan ? JSON.stringify(draft) !== JSON.stringify(plan.targets) : false;
  const addTarget = (target: Target) => {
    if (target.shopId === sourceShopId && target.partnerId === plan?.sourcePartnerId) {
      setError('Không thể chọn shop nguồn làm shop đích.');
      return;
    }
    if (draft.some((row) => row.partnerId === target.partnerId && row.shopId === target.shopId)) {
      setError('Shop này đã có trong kế hoạch.');
      return;
    }
    setError('');
    setDraft((rows) => [...rows, target]);
  };
  const save = async () => {
    if (!plan) return;
    setSaving(true);
    setError('');
    try {
      const next = await api<CopyPlan>(
        '/v1/seller-knowledge/archives/' + encodeURIComponent(archiveId) + '/copy-plan', {
          method: 'POST', body: JSON.stringify({ expectedRevision: plan.revision, targets: draft, policy: plan.policy }),
        });
      setPlan(next);
      setDraft(next.targets);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Chưa lưu được kế hoạch.');
    } finally { setSaving(false); }
  };

  return <section className="shop-archive-destinations" aria-label="Shop đích">
    <div className="shop-archive-destination-heading">
      <div>
        <h2>Shop đích · đăng ẩn</h2>
        <p className="caption">Chọn từ các shop đã lưu hoặc nhập Shop ID mới. Kế hoạch này chỉ lưu lựa chọn, chưa đăng sản phẩm. Mỗi lần cấp quyền kết nối đúng một Shop ID; hãy hoàn tất từng shop riêng.</p>
      </div>
      <div className="shop-archive-heading-actions">
        <button type="button" onClick={() => setRefreshCount((value) => value + 1)}>Kiểm tra lại kết nối</button>
        <button type="button" onClick={save} disabled={!changed || saving}>{saving ? 'Đang lưu…' : 'Lưu shop đích'}</button>
      </div>
    </div>
    {error && <p className="shop-archive-error" role="alert">{error}</p>}
    <p className="caption">{itemCount} listing nguồn × {draft.length} shop đích = {itemCount * draft.length} bản dự kiến; kế hoạch chưa gửi lệnh tạo sản phẩm.</p>
    {plan?.policy && <p className="caption">Chính sách đã chốt: đăng ẩn · tồn có thể bán theo ảnh chụp nguồn · giá gốc · khuyến mãi nguồn được ghi là ngoại lệ, không chuyển chương trình.</p>}
    <div className="shop-archive-targets">
      {draft.map((target) => {
        const key = target.partnerId + ':' + target.shopId;
        const connection = connections[key];
        const known = shops.find((shop) => shop.scope.partnerId === target.partnerId &&
          shop.scope.shopId === target.shopId);
        const state = connection?.state ?? 'checking';
        const name = connection?.officialName || known?.displayName || known?.officialName ||
          target.displayName || 'Shop ' + target.shopId;
        return <div key={key}>
          <strong>{name}</strong><span>{target.shopId} · Partner {target.partnerId}</span>
          <span>{state === 'connected' ? 'Đã kết nối' :
            state === 'checking' ? 'Đang kiểm tra' :
              state === 'refresh_unknown' ? 'Cần đối chiếu token' : 'Chưa kết nối'}</span>
          {state !== 'connected' && <a href={'/?page=shops&connectShop=' + target.shopId}>Mở kết nối shop</a>}
          <button type="button" onClick={() => setDraft((rows) => rows.filter((row) =>
            row.partnerId !== target.partnerId || row.shopId !== target.shopId))}>Bỏ khỏi kế hoạch</button>
        </div>;
      })}
      {plan && draft.length === 0 && <p className="caption">Chưa chọn shop đích.</p>}
    </div>
    <div className="shop-archive-add-target">
      <label>Shop đã lưu
        <select value={knownId} onChange={(event) => setKnownId(event.target.value)}>
          <option value="">Chọn shop</option>
          {availableShops.map((shop) => <option value={shop.id} key={shop.id}>
            {shop.displayName || shop.officialName || shop.scope.shopId} · {shop.scope.shopId}
          </option>)}
        </select>
      </label>
      <button type="button" disabled={!knownId} onClick={() => {
        const shop = availableShops.find((row) => row.id === knownId);
        if (shop) addTarget({ partnerId: shop.scope.partnerId, shopId: shop.scope.shopId,
          displayName: shop.displayName || shop.officialName || undefined });
        setKnownId('');
      }}>Thêm shop đã lưu</button>
      <label>Partner ID<input inputMode="numeric" value={partnerId}
        onChange={(event) => setPartnerId(event.target.value)} /></label>
      <label>Shop ID mới<input inputMode="numeric" value={shopId}
        onChange={(event) => setShopId(event.target.value)} /></label>
      <label>Tên hiển thị<input value={displayName}
        onChange={(event) => setDisplayName(event.target.value)} /></label>
      <button type="button" onClick={() => {
        if (!/^[1-9]\d{0,9}$/.test(partnerId) || !/^[1-9]\d{0,15}$/.test(shopId)) {
          setError('Nhập Partner ID và Shop ID hợp lệ.');
          return;
        }
        addTarget({ partnerId, shopId, ...(displayName.trim() ? { displayName: displayName.trim() } : {}) });
        setShopId('');
        setDisplayName('');
      }}>Thêm Shop ID</button>
    </div>
  </section>;
}
