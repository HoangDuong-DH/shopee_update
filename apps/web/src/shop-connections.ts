import type { ShopConnection } from '@shopee/domain';

export type ConnectionHealthView = {
  code: 'saved' | 'checked' | 'expired' | 'unknown' | 'reauthorize' | 'waiting' | 'disconnected' | 'stale' | 'expiring' | 'unverified';
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  label: string;
  detail: string;
  actionLabel: string;
  needsAttention: boolean;
  checkedAt: string | null;
  expiresAt: string | null;
};
export function productionShopKey(shop: ShopConnection): string {
  return `${shop.scope.partnerId}:${shop.scope.shopId}`;
}

/** Missing or unusable selections stay visible for repair; never choose another shop implicitly. */
export function resolveExplicitProductionShop(shops: ShopConnection[], key: string): ShopConnection | null {
  if (!key) return null;
  const matches = shops.filter(shop => shop.scope.environment === 'production' && productionShopKey(shop) === key);
  return matches.length === 1 ? matches[0] : null;
}

function searchText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLocaleLowerCase('vi').trim();
}
export function filterShopConnections(shops: ShopConnection[], query: string): ShopConnection[] {
  const terms = searchText(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return shops;
  return shops.filter(shop => {
    const text = searchText([shop.name, shop.displayName, shop.officialName, shop.scope.shopId,
      shop.scope.partnerId, shop.scope.environment === 'production' ? 'shop thật production' : 'thử nghiệm sandbox test'].filter(Boolean).join(' '));
    return terms.every(term => text.includes(term));
  });
}

/** A saved token and its expiry are separate from the last recorded access check. */
export function connectionHealthView(shop: ShopConnection, now = Date.now()): ConnectionHealthView {
  const checkedAt = shop.healthCheckedAt && Number.isFinite(Date.parse(shop.healthCheckedAt)) ? shop.healthCheckedAt : null;
  const expiresAt = shop.tokenExpiresAt && Number.isFinite(Date.parse(shop.tokenExpiresAt)) ? shop.tokenExpiresAt : null;
  const base = { checkedAt, expiresAt };
  if (shop.state === 'refresh_unknown' || shop.refreshStatus === 'unknown')
    return { ...base, code: 'unknown', tone: 'warning', label: 'Gia hạn chưa rõ kết quả',
      detail: 'Mở đúng kết nối để phục hồi từ bằng chứng hoặc cấp quyền lại theo kết quả kiểm tra.', actionLabel: 'Phục hồi kết nối', needsAttention: true };
  if (shop.state === 'reauth_required' || shop.refreshStatus === 'reauth_required')
    return { ...base, code: 'reauthorize', tone: 'danger', label: 'Cần cấp quyền lại',
      detail: 'Kiểm tra cấu hình và cấp quyền cho đúng ứng dụng, đúng shop.', actionLabel: 'Kiểm tra / cấp quyền lại', needsAttention: true };
  if (shop.state === 'disconnected')
    return { ...base, code: 'disconnected', tone: 'neutral', label: 'Chưa kết nối',
      detail: 'Hoàn tất cấp quyền trước khi dùng dữ liệu hoặc chuẩn bị đăng vào shop này.', actionLabel: 'Kết nối shop', needsAttention: true };
  if (shop.state === 'token_expired' || (expiresAt && Date.parse(expiresAt) <= now))
    return { ...base, code: 'expired', tone: 'warning', label: 'Token đã hết hạn',
      detail: 'Mở kết nối để xem kết quả gia hạn; cấp quyền lại nếu được yêu cầu.', actionLabel: 'Gia hạn / cấp quyền lại', needsAttention: true };
  if (shop.refreshStatus === 'waiting')
    return { ...base, code: 'waiting', tone: 'warning', label: 'Đang chờ kiểm tra / gia hạn',
      detail: shop.refreshReason === 'SHOP_CHECK_TEMPORARILY_UNAVAILABLE'
        ? 'Lần kiểm tra chưa nhận được kết quả từ Shopee. Mở kết nối để đọc lại khi có thể.'
        : 'Hệ thống đang chờ điều kiện xử lý kết nối. Mở kết nối để xem việc cần làm.',
      actionLabel: 'Xem kết nối đang chờ', needsAttention: true };
  if (!expiresAt)
    return { ...base, code: 'unverified', tone: 'warning', label: 'Chưa xác minh', detail: 'Chưa có thời hạn token hợp lệ đã lưu. Mở đúng kết nối để xác minh; chưa thể coi lần kiểm tra trước là kết nối hiện tại.', actionLabel: 'Kiểm tra kết nối', needsAttention: true };
  if (expiresAt && Date.parse(expiresAt) - now <= 10 * 60_000)
    return { ...base, code: 'expiring', tone: 'warning', label: 'Sắp hết hạn', detail: 'Kết nối còn hạn nhưng sắp cần gia hạn. Mở kết nối để xem việc tiếp theo.', actionLabel: 'Gia hạn kết nối', needsAttention: true };
  if (shop.refreshStatus === 'healthy' && checkedAt && (now - Date.parse(checkedAt) < 0 || now - Date.parse(checkedAt) > 15 * 60_000))
    return { ...base, code: 'stale', tone: 'warning', label: 'Cần kiểm tra lại', detail: 'Lần kiểm tra đã lưu quá 15 phút hoặc có thời điểm chưa hợp lệ. Kết nối chưa được kiểm tra mới.', actionLabel: 'Kiểm tra kết nối', needsAttention: true };
  if (shop.refreshStatus === 'healthy' && checkedAt)
    return { ...base, code: 'checked', tone: 'success', label: 'Đã kiểm tra quyền truy cập',
      detail: 'Kết quả thuộc lần kiểm tra đã lưu bên dưới. Quyền đăng được kiểm tra tiếp trong từng thao tác.', actionLabel: 'Quản lý kết nối', needsAttention: false };
  return { ...base, code: 'saved', tone: 'neutral', label: 'Đã lưu kết nối',
    detail: 'Đã có kết nối trong ứng dụng. Mở kết nối và kiểm tra với Shopee trước khi chạy công việc.', actionLabel: 'Kiểm tra kết nối', needsAttention: false };
}
