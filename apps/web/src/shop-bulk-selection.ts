import type { ShopConnection } from '@shopee/domain';
import { connectionHealthView } from './shop-connections.js';
export function shopSelectionKey(shop: ShopConnection): string {
  return JSON.stringify([shop.id, shop.scope.environment, shop.scope.partnerId, shop.scope.shopId]);
}
export function selectedConnections(shops: ShopConnection[], keys: ReadonlySet<string>) {
  return shops.filter((shop) => keys.has(shopSelectionKey(shop)));
}
export function toggleVisibleConnections(keys: ReadonlySet<string>, visible: ShopConnection[]) {
  const next = new Set(keys);
  const all = visible.length > 0 && visible.every((shop) => keys.has(shopSelectionKey(shop)));
  for (const shop of visible) {
    const key = shopSelectionKey(shop);
    if (all) next.delete(key); else next.add(key);
  }
  return next;
}
function csvCell(value: string) {
  // Shop names are user input. Prevent spreadsheet formulas in a local CSV export.
  const safe = /^[=+@\-\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
/** Export only a fixed allowlist of displayed metadata, never tokens or credentials. */
export function connectionStatusCsv(shops: ShopConnection[], now: number) {
  const rows = [['Tên shop', 'Shop ID', 'Partner ID', 'Môi trường', 'Tình trạng đã lưu', 'Token hết hạn lúc', 'Lần kiểm tra đã lưu', 'Xuất lúc']];
  for (const shop of shops) {
    const view = connectionHealthView(shop, now);
    rows.push([shop.displayName || shop.officialName || shop.name || `Shop ${shop.scope.shopId}`,
      shop.scope.shopId, shop.scope.partnerId, shop.scope.environment, view.label,
      view.expiresAt || '', view.checkedAt || '', new Date(now).toISOString()]);
  }
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
