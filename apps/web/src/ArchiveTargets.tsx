import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import {
  applyArchiveCopyTargets,
  resolveArchiveCopyTargets,
  archiveCopyHoldReason,
  type ArchiveCopyPreparationIntent,
} from './archive-copy-selection.js';

type Target = { partnerId: string; shopId: string; displayName?: string };
type CopyPlan = {
  archiveId: string;
  sourceShopId: string;
  sourcePartnerId: string;
  revision: number;
  targets: Target[];
  policy: {
    targetStatus: 'UNLIST';
    stockStrategy: 'source_saleable_snapshot';
    priceStrategy: 'source_original';
    promotionStrategy: 'record_exception';
  };
};
type Shop = {
  id: string;
  officialName?: string | null;
  displayName?: string | null;
  state: string;
  scope: { environment: string; partnerId: string; shopId: string };
};
type Connection = {
  partnerId: string;
  shopId: string;
  state: string;
  officialName?: string | null;
};

export function ArchiveTargets({
  archiveId,
  sourceShopId,
  itemCount,
  preparationIntent,
  onBusyChange,
}: {
  archiveId: string;
  sourceShopId: string;
  itemCount: number;
  preparationIntent?: ArchiveCopyPreparationIntent;
  onBusyChange?: (busy: boolean) => void;
}) {
  const saveLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
  const [selectionDecision, setSelectionDecision] = useState<'merge' | 'replace' | 'keep' | null>(
    null,
  );
  const [message, setMessage] = useState('');
  const [saveConflict, setSaveConflict] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    if (!archiveId) return;
    let active = true;
    setPlan(null);
    setDraft([]);
    setConnections({});
    setSelectionDecision(null);
    setSaveConflict(false);
    setMessage('');
    setError('');
    void Promise.all([
      api<CopyPlan>(
        '/v1/seller-knowledge/archives/' + encodeURIComponent(archiveId) + '/copy-plan',
      ),
      api<{ shops: Shop[] }>('/v1/seller-knowledge/shops'),
    ])
      .then(([nextPlan, result]) => {
        if (!active) return;
        setPlan(nextPlan);
        setDraft(nextPlan.targets);
        setPartnerId(nextPlan.sourcePartnerId);
        setShops(result.shops);
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [archiveId, preparationIntent]);

  useEffect(() => {
    if (!plan) return;
    let active = true;
    void Promise.all(
      draft.map(async (target) => {
        try {
          const connection = await api<Connection>(
            '/v1/connections/production?partnerId=' +
              encodeURIComponent(target.partnerId) +
              '&shopId=' +
              encodeURIComponent(target.shopId),
          );
          return [target.partnerId + ':' + target.shopId, connection] as const;
        } catch {
          return [
            target.partnerId + ':' + target.shopId,
            { partnerId: target.partnerId, shopId: target.shopId, state: 'unavailable' },
          ] as const;
        }
      }),
    ).then((entries) => {
      if (active) setConnections(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [plan, draft, refreshCount]);

  const incoming = useMemo(
    () =>
      resolveArchiveCopyTargets(
        preparationIntent?.targets ?? [],
        shops,
        plan ? { shopId: plan.sourceShopId } : null,
      ),
    [preparationIntent, shops, plan],
  );
  const incomingHeld =
    Boolean(preparationIntent?.error) || !plan || incoming.some((row) => row.reason);
  const availableShops = useMemo(
    () =>
      shops.filter(
        (shop) =>
          shop.scope.environment === 'production' &&
          shop.scope.shopId !== sourceShopId &&
          !draft.some(
            (target) =>
              target.partnerId === shop.scope.partnerId && target.shopId === shop.scope.shopId,
          ),
      ),
    [shops, sourceShopId, draft],
  );
  const changed = plan ? JSON.stringify(draft) !== JSON.stringify(plan.targets) : false;
  const addTarget = (target: Target) => {
    if (saveLock.current) return;
    if (target.shopId === sourceShopId) {
      setError('Không thể chọn shop nguồn làm shop đích.');
      return;
    }
    if (draft.some((row) => row.partnerId === target.partnerId && row.shopId === target.shopId)) {
      setError('Shop này đã có trong kế hoạch.');
      return;
    }
    if (draft.length >= 30) {
      setError('Một kế hoạch hỗ trợ tối đa 30 shop đích.');
      return;
    }
    setError('');
    setMessage('');
    setDraft((rows) => [...rows, target]);
  };
  const chooseIncoming = (mode: 'merge' | 'replace') => {
    try {
      setDraft(applyArchiveCopyTargets(draft, incoming, mode));
      setSelectionDecision(mode);
      setError('');
      setMessage('Lựa chọn đang ở bản nháp; bấm Lưu shop đích để lưu kế hoạch nội bộ.');
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message === 'COPY_TARGET_LIMIT'
          ? 'Một kế hoạch hỗ trợ tối đa 30 shop đích. Chọn lại nhóm shop trước khi lưu.'
          : 'Shop đích còn trường hợp giữ riêng. Đối chiếu hoặc chọn lại ở Kết nối shop.',
      );
    }
  };
  const save = async () => {
    if (
      saveLock.current ||
      !plan ||
      saveConflict ||
      (preparationIntent?.explicit && !selectionDecision)
    )
      return;
    saveLock.current = true;
    onBusyChange?.(true);
    setSaving(true);
    setError('');
    setMessage('');
    const path = '/v1/seller-knowledge/archives/' + encodeURIComponent(archiveId) + '/copy-plan';
    try {
      // Re-read exact connection identities before an explicit local plan save.
      if (selectionDecision === 'merge' || selectionDecision === 'replace') {
        const fresh = await api<{ shops: Shop[] }>('/v1/seller-knowledge/shops');
        setShops(fresh.shops);
        if (
          resolveArchiveCopyTargets(preparationIntent?.targets ?? [], fresh.shops, {
            shopId: plan.sourceShopId,
          }).some((row) => row.reason)
        )
          throw Error('Shop đích đã thay đổi. Lựa chọn được giữ riêng; chọn lại trước khi lưu.');
      }
      if (!mounted.current) return;
      let next: CopyPlan;
      try {
        next = await api<CopyPlan>(path, {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: plan.revision,
            targets: draft,
            policy: plan.policy,
          }),
        });
      } catch (reason) {
        // A lost response never triggers another POST. Read the saved plan once.
        const observed = await api<CopyPlan>(path).catch(() => null);
        if (
          observed &&
          observed.revision > plan.revision &&
          JSON.stringify(observed.targets) === JSON.stringify(draft) &&
          JSON.stringify(observed.policy) === JSON.stringify(plan.policy)
        )
          next = observed;
        else {
          setSaveConflict(true);
          throw Error(
            (reason instanceof Error ? reason.message + ' ' : '') +
              'Chưa xác minh lần lưu. Đọc lại kế hoạch và đối chiếu trước khi lưu tiếp.',
          );
        }
      }
      if (!mounted.current) return;
      setPlan(next);
      setDraft(next.targets);
      setMessage(
        'Đã lưu kế hoạch shop đích nội bộ. Chưa chuẩn bị lệnh tạo, sao chép hoặc đăng sản phẩm.',
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Chưa lưu được kế hoạch.');
    } finally {
      saveLock.current = false;
      setSaving(false);
      onBusyChange?.(false);
    }
  };
  const reloadPlan = async () => {
    if (saveLock.current) return;
    saveLock.current = true;
    onBusyChange?.(true);
    setSaving(true);
    try {
      const next = await api<CopyPlan>(
        '/v1/seller-knowledge/archives/' + encodeURIComponent(archiveId) + '/copy-plan',
      );
      setPlan(next);
      setDraft(next.targets);
      setSaveConflict(false);
      setSelectionDecision(null);
      setError('');
      setMessage('Đã đọc lại kế hoạch đã lưu. Đối chiếu rồi chọn gộp hoặc thay shop đích nếu cần.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Chưa đọc được kế hoạch.');
    } finally {
      saveLock.current = false;
      setSaving(false);
      onBusyChange?.(false);
    }
  };

  return (
    <section className="shop-archive-destinations" aria-label="Shop đích">
      <div className="shop-archive-destination-heading">
        <div>
          <h2>Shop đích · kế hoạch đăng ẩn</h2>
          <p className="caption">
            Chọn từ các shop đã lưu hoặc nhập Shop ID mới. Kế hoạch này chỉ lưu lựa chọn, chưa đăng
            sản phẩm. Mỗi lần cấp quyền kết nối đúng một Shop ID; hãy hoàn tất từng shop riêng.
          </p>
        </div>
        <div className="shop-archive-heading-actions">
          <button type="button" onClick={() => setRefreshCount((value) => value + 1)}>
            Kiểm tra lại kết nối
          </button>
          <button
            type="button"
            onClick={save}
            disabled={
              !changed ||
              saving ||
              saveConflict ||
              Boolean(
                preparationIntent?.explicit &&
                (!selectionDecision || (selectionDecision !== 'keep' && incomingHeld)),
              )
            }
          >
            {saving ? 'Đang lưu…' : 'Lưu shop đích'}
          </button>
        </div>
      </div>
      {preparationIntent?.explicit && (
        <section aria-label="Đối chiếu shop đích đã chọn">
          <p className="caption">
            Các shop đã chọn ở Kết nối shop được giữ riêng dưới đây. Kế hoạch đã lưu chưa thay đổi;
            chọn rõ gộp hoặc thay trước khi lưu.
          </p>
          {incoming.map((row) => {
            const known = shops.find((shop) => shop.id === row.intent.connectionId);
            return (
              <div key={JSON.stringify(row.intent)}>
                <strong>
                  {known?.displayName || known?.officialName || 'Shop ' + row.intent.shopId}
                </strong>
                <p className="caption">
                  {row.intent.shopId} · Partner {row.intent.partnerId} ·{' '}
                  {row.intent.environment === 'production' ? 'Shop thật' : 'Thử nghiệm'} ·{' '}
                  {archiveCopyHoldReason(row.reason)}
                </p>
              </div>
            );
          })}
          {preparationIntent.error && <p role="alert">{preparationIntent.error}</p>}
          {incoming.length > 30 && (
            <p role="alert">
              Một kế hoạch hỗ trợ tối đa 30 shop đích. Lựa chọn vượt giới hạn được giữ lại để chọn
              nhóm khác.
            </p>
          )}
          <div className="shop-archive-heading-actions">
            <button
              type="button"
              disabled={incomingHeld || saving || incoming.length > 30}
              onClick={() => chooseIncoming('merge')}
            >
              Gộp vào kế hoạch đã lưu
            </button>
            <button
              type="button"
              disabled={incomingHeld || saving || incoming.length > 30}
              onClick={() => chooseIncoming('replace')}
            >
              Thay bằng các shop đã chọn
            </button>
            <button
              type="button"
              disabled={!plan || saving}
              onClick={() => {
                setDraft(plan!.targets);
                setSelectionDecision('keep');
                setError('');
                setMessage('Giữ kế hoạch đã lưu; các shop chọn thêm chưa được áp dụng.');
              }}
            >
              Giữ kế hoạch đã lưu
            </button>
          </div>
        </section>
      )}
      {message && <p role="status">{message}</p>}
      {saveConflict && (
        <button type="button" onClick={reloadPlan} disabled={saving}>
          Đọc lại kế hoạch đã lưu
        </button>
      )}
      {error && (
        <p className="shop-archive-error" role="alert">
          {error}
        </p>
      )}
      <p className="caption">
        {itemCount} listing nguồn × {draft.length} shop đích = {itemCount * draft.length} bản dự
        kiến; kế hoạch chưa gửi lệnh tạo sản phẩm.
      </p>
      {plan?.policy && (
        <p className="caption">
          Chính sách đã chốt: đăng ẩn · tồn có thể bán theo ảnh chụp nguồn · giá gốc · khuyến mãi
          nguồn được ghi là ngoại lệ, không chuyển chương trình.
        </p>
      )}
      <div className="shop-archive-targets">
        {draft.map((target) => {
          const key = target.partnerId + ':' + target.shopId;
          const connection = connections[key];
          const known = shops.find(
            (shop) =>
              shop.scope.environment === 'production' &&
              shop.scope.partnerId === target.partnerId &&
              shop.scope.shopId === target.shopId,
          );
          const state = connection?.state ?? 'checking';
          const name =
            connection?.officialName ||
            known?.displayName ||
            known?.officialName ||
            target.displayName ||
            'Shop ' + target.shopId;
          return (
            <div key={key}>
              <strong>{name}</strong>
              <span>
                {target.shopId} · Partner {target.partnerId}
              </span>
              <span>
                {state === 'connected'
                  ? 'Đã kết nối'
                  : state === 'checking'
                    ? 'Đang kiểm tra'
                    : state === 'refresh_unknown'
                      ? 'Cần đối chiếu token'
                      : 'Chưa kết nối'}
              </span>
              {state !== 'connected' && (
                <a
                  href={
                    '/?page=shops&connectShop=' +
                    encodeURIComponent(target.shopId) +
                    '&partnerId=' +
                    encodeURIComponent(target.partnerId)
                  }
                >
                  Mở kết nối shop
                </a>
              )}
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  setDraft((rows) =>
                    rows.filter(
                      (row) => row.partnerId !== target.partnerId || row.shopId !== target.shopId,
                    ),
                  )
                }
              >
                Bỏ khỏi kế hoạch
              </button>
            </div>
          );
        })}
        {plan && draft.length === 0 && <p className="caption">Chưa chọn shop đích.</p>}
      </div>
      <div className="shop-archive-add-target">
        <label>
          Shop đã lưu
          <select value={knownId} onChange={(event) => setKnownId(event.target.value)}>
            <option value="">Chọn shop</option>
            {availableShops.map((shop) => (
              <option value={shop.id} key={shop.id}>
                {shop.displayName || shop.officialName || shop.scope.shopId} · {shop.scope.shopId}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!knownId}
          onClick={() => {
            const shop = availableShops.find((row) => row.id === knownId);
            if (shop)
              addTarget({
                partnerId: shop.scope.partnerId,
                shopId: shop.scope.shopId,
                displayName: shop.displayName || shop.officialName || undefined,
              });
            setKnownId('');
          }}
        >
          Thêm shop đã lưu
        </button>
        <label>
          Partner ID
          <input
            inputMode="numeric"
            value={partnerId}
            onChange={(event) => setPartnerId(event.target.value)}
          />
        </label>
        <label>
          Shop ID mới
          <input
            inputMode="numeric"
            value={shopId}
            onChange={(event) => setShopId(event.target.value)}
          />
        </label>
        <label>
          Tên hiển thị
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <button
          type="button"
          onClick={() => {
            if (!/^[1-9]\d{0,9}$/.test(partnerId) || !/^[1-9]\d{0,15}$/.test(shopId)) {
              setError('Nhập Partner ID và Shop ID hợp lệ.');
              return;
            }
            addTarget({
              partnerId,
              shopId,
              ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            });
            setShopId('');
            setDisplayName('');
          }}
        >
          Thêm Shop ID
        </button>
      </div>
    </section>
  );
}
