export type ArchiveCopyTargetIntent = {
  connectionId: string;
  environment: string;
  partnerId: string;
  shopId: string;
};
export type ArchiveCopyPreparationIntent = {
  explicit: boolean;
  targets: ArchiveCopyTargetIntent[];
  error: string | null;
};
export type ArchiveCopyTarget = { partnerId: string; shopId: string; displayName?: string };
export type ArchiveCopyShop = {
  id: string;
  scope: { environment: string; partnerId: string; shopId: string };
  displayName?: string | null;
  officialName?: string | null;
};
export type ArchiveCopyResolvedTarget = {
  intent: ArchiveCopyTargetIntent;
  target: ArchiveCopyTarget | null;
  reason:
    | 'CONNECTION_MISSING'
    | 'CONNECTION_SCOPE_CHANGED'
    | 'SANDBOX_UNSUPPORTED'
    | 'SOURCE_IS_TARGET'
    | null;
};
/** Only identities enter navigation; names, credentials and tokens stay out of the URL. */
export function buildArchiveCopyPreparationUrl(shops: ArchiveCopyShop[]): string {
  const targets = shops.map((shop) => ({
    connectionId: shop.id,
    environment: shop.scope.environment,
    partnerId: shop.scope.partnerId,
    shopId: shop.scope.shopId,
  }));
  const params = new URLSearchParams({ page: 'archives', copyTargets: JSON.stringify(targets) });
  return '/?' + params.toString();
}
export function readArchiveCopyPreparationIntent(search: string): ArchiveCopyPreparationIntent {
  const params = new URLSearchParams(search);
  if (!params.has('copyTargets')) return { explicit: false, targets: [], error: null };
  try {
    const value: unknown = JSON.parse(params.get('copyTargets')!);
    if (!Array.isArray(value) || !value.length || value.length > 500) throw Error('invalid');
    const targets: ArchiveCopyTargetIntent[] = value.map((row) => {
      if (
        !row ||
        typeof row !== 'object' ||
        typeof row.connectionId !== 'string' ||
        !row.connectionId.trim() ||
        row.connectionId.length > 150 ||
        !['production', 'sandbox'].includes(row.environment) ||
        typeof row.partnerId !== 'string' ||
        !/^[1-9]\d{0,9}$/.test(row.partnerId) ||
        typeof row.shopId !== 'string' ||
        !/^[1-9]\d{0,15}$/.test(row.shopId)
      )
        throw Error('invalid');
      return {
        connectionId: row.connectionId,
        environment: row.environment,
        partnerId: row.partnerId,
        shopId: row.shopId,
      };
    });
    if (new Set(targets.map((row) => JSON.stringify(row))).size !== targets.length)
      throw Error('duplicate');
    return { explicit: true, targets, error: null };
  } catch {
    return {
      explicit: true,
      targets: [],
      error:
        'Chưa đọc được lựa chọn shop đích. Quay về Kết nối shop để chọn lại; ứng dụng không tự thay shop.',
    };
  }
}
export function resolveArchiveCopyTargets(
  targets: ArchiveCopyTargetIntent[],
  shops: ArchiveCopyShop[],
  source: { shopId: string } | null,
): ArchiveCopyResolvedTarget[] {
  return targets.map((intent) => {
    const matches = shops.filter((shop) => shop.id === intent.connectionId);
    const shop = matches.length === 1 ? matches[0] : null;
    const reason = !shop
      ? 'CONNECTION_MISSING'
      : shop.scope.environment !== intent.environment ||
          shop.scope.partnerId !== intent.partnerId ||
          shop.scope.shopId !== intent.shopId
        ? 'CONNECTION_SCOPE_CHANGED'
        : intent.environment !== 'production'
          ? 'SANDBOX_UNSUPPORTED'
          : intent.shopId === source?.shopId
            ? 'SOURCE_IS_TARGET'
            : null;
    const displayName = shop?.displayName || shop?.officialName;
    return {
      intent,
      reason,
      target: reason
        ? null
        : {
            partnerId: intent.partnerId,
            shopId: intent.shopId,
            ...(displayName ? { displayName } : {}),
          },
    };
  });
}
export function applyArchiveCopyTargets(
  saved: ArchiveCopyTarget[],
  resolved: ArchiveCopyResolvedTarget[],
  mode: 'merge' | 'replace',
): ArchiveCopyTarget[] {
  if (!resolved.length || resolved.some((row) => row.reason || !row.target))
    throw Error('COPY_TARGETS_HELD');
  const targets = mode === 'merge' ? saved.map((row) => ({ ...row })) : [];
  for (const row of resolved) {
    const target = row.target!;
    if (
      !targets.some(
        (existing) => existing.partnerId === target.partnerId && existing.shopId === target.shopId,
      )
    )
      targets.push(target);
  }
  if (targets.length > 30) throw Error('COPY_TARGET_LIMIT');
  return targets;
}
export function archiveCopyHoldReason(reason: ArchiveCopyResolvedTarget['reason']): string {
  return reason === 'CONNECTION_MISSING'
    ? 'Giữ riêng: kết nối đã chọn không còn trong danh sách.'
    : reason === 'CONNECTION_SCOPE_CHANGED'
      ? 'Giữ riêng: định danh hoặc môi trường kết nối đã thay đổi.'
      : reason === 'SANDBOX_UNSUPPORTED'
        ? 'Giữ riêng: luồng kho nguồn chỉ hỗ trợ shop thật.'
        : reason === 'SOURCE_IS_TARGET'
          ? 'Giữ riêng: shop nguồn trùng shop đích.'
          : 'Đã đối chiếu đúng shop đích; chưa kiểm điều kiện đăng.';
}
