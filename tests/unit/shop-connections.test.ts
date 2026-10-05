import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShopConnection } from '@shopee/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShopConnectionsOverview } from '../../apps/web/src/ShopConnectionsOverview.js';
import {
  connectionHealthView,
  filterShopConnections,
  productionShopKey,
  resolveExplicitProductionShop,
} from '../../apps/web/src/shop-connections.js';

const now = Date.parse('2026-10-01T08:00:00.000Z');
function shop(overrides: Partial<ShopConnection> = {}): ShopConnection {
  return {
    id: 'saved-shop-a', name: 'Tinh dầu Vina Tươi', region: 'VN',
    scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897', connectionRevision: 1, capabilityRevision: 1 },
    state: 'connected', capabilities: [], updatedAt: '2026-10-01T07:00:00.000Z',
    ...overrides,
  };
}
afterEach(() => vi.useRealTimers());

describe('explicit production shop selection', () => {
  it('requires a human selection even when exactly one shop is saved', () => {
    expect(resolveExplicitProductionShop([shop()], '')).toBeNull();
  });
  it('does not switch to another shop when the saved selection is missing', () => {
    expect(resolveExplicitProductionShop([shop()], '2010476:1126307464')).toBeNull();
  });
  it('keeps an expired or uncertain selected shop visible instead of switching to a healthy shop', () => {
    const expired = shop({ id: 'expired', state: 'token_expired' });
    const other = shop({ id: 'healthy', scope: { environment: 'production', partnerId: '2010476', shopId: '1126307464', connectionRevision: 1, capabilityRevision: 1 } });
    expect(resolveExplicitProductionShop([other, expired], '2010476:1423724897')).toBe(expired);
    const uncertain = { ...expired, state: 'refresh_unknown' as const };
    expect(resolveExplicitProductionShop([other, uncertain], '2010476:1423724897')).toBe(uncertain);
  });
  it('requires the exact environment and partner as well as shop', () => {
    const otherPartner = shop({ scope: { environment: 'production', partnerId: '999', shopId: '1423724897', connectionRevision: 1, capabilityRevision: 1 } });
    const sandbox = shop({ scope: { environment: 'sandbox', partnerId: '2010476', shopId: '1423724897', connectionRevision: 1, capabilityRevision: 1 } });
    expect(resolveExplicitProductionShop([otherPartner, sandbox], '2010476:1423724897')).toBeNull();
    expect(productionShopKey(otherPartner)).toBe('999:1423724897');
  });
  it('holds an ambiguous response containing two connections for the same scope', () => {
    expect(resolveExplicitProductionShop([shop(), shop({ id: 'duplicate' })], '2010476:1423724897')).toBeNull();
  });
});

describe('connection status shown to an operator', () => {
  it('does not treat saved credentials or a future expiry as a successful shop check', () => {
    expect(connectionHealthView(shop({ tokenExpiresAt: '2026-10-01T10:00:00.000Z' }), now))
      .toMatchObject({ code: 'saved', tone: 'neutral', checkedAt: null, needsAttention: false });
  });
  it('shows a successful check only with its recorded time and healthy result', () => {
    expect(connectionHealthView(shop({ refreshStatus: 'healthy', healthCheckedAt: '2026-10-01T07:59:00.000Z', tokenExpiresAt: '2026-10-01T10:00:00.000Z' }), now))
      .toMatchObject({ code: 'checked', checkedAt: '2026-10-01T07:59:00.000Z', tone: 'success' });
    expect(connectionHealthView(shop({ refreshStatus: 'healthy' }), now).code).toBe('unverified');
    expect(connectionHealthView(shop({ healthCheckedAt: '2026-10-01T07:59:00.000Z', refreshStatus: 'waiting' }), now))
      .toMatchObject({ code: 'waiting', tone: 'warning', needsAttention: true });
  });
  it('marks token expiry from the clock without trusting a stale connected state', () => {
    const expires = shop({ state: 'connected', refreshStatus: 'healthy', healthCheckedAt: '2026-10-01T07:00:00.000Z', tokenExpiresAt: '2026-10-01T08:00:00.000Z' });
    expect(connectionHealthView(expires, now)).toMatchObject({ code: 'expired', needsAttention: true });
  });
  it('preserves unknown refresh and reauthorization ahead of apparently valid token dates', () => {
    expect(connectionHealthView(shop({ refreshStatus: 'unknown', tokenExpiresAt: '2026-10-01T10:00:00.000Z' }), now))
      .toMatchObject({ code: 'unknown', tone: 'warning', needsAttention: true });
    expect(connectionHealthView(shop({ state: 'reauth_required', tokenExpiresAt: '2026-10-01T10:00:00.000Z' }), now))
      .toMatchObject({ code: 'reauthorize', tone: 'danger', needsAttention: true });
  });
  it('never displays invalid dates or invents a missing check or expiry', () => {
    expect(connectionHealthView(shop({ healthCheckedAt: 'bad', tokenExpiresAt: 'bad' }), now))
      .toMatchObject({ code: 'unverified', checkedAt: null, expiresAt: null, needsAttention: true });
  });
});

describe('shop overview search', () => {
  it('finds a saved alias, official name, shop ID, and partner without requiring Vietnamese accents', () => {
    const first = shop({ displayName: 'Đội vận hành miền Bắc', officialName: 'DORIS VINA TƯƠI' });
    const second = shop({ id: 'shop-b', name: 'Abura', scope: { environment: 'production', partnerId: '2010476', shopId: '1126307464', connectionRevision: 1, capabilityRevision: 1 } });
    for (const query of ['doi van hanh', 'vina tuoi', '1423724897', '2010476 1423724897']) {
      expect(filterShopConnections([first, second], query)).toEqual([first]);
    }
    expect(filterShopConnections([first, second], 'khong co')).toEqual([]);
    expect(filterShopConnections([first, second], '')).toEqual([first, second]);
  });
});

describe('shop overview states', () => {
  const callbacks = { onConnectShop: (_id: string | null) => {}, onRefresh: () => {} };
  it('offers a connection action when there are no saved shops', () => {
    const html = renderToStaticMarkup(createElement(ShopConnectionsOverview, { shops: [], ...callbacks }));
    expect(html).toContain('Kết nối shop mới');
    expect(html).toContain('Chưa có shop được lưu');
  });
  it('opens only the explicitly selected shop details and shows its actual scope', () => {
    const first = shop();
    const second = shop({ id: 'shop-b', name: 'Abura', scope: { environment: 'production', partnerId: '2010476', shopId: '1126307464', connectionRevision: 1, capabilityRevision: 1 } });
    const html = renderToStaticMarkup(createElement(ShopConnectionsOverview, { shops: [first, second], selectedShopId: 'shop-b', ...callbacks }));
    expect(html).toContain('shop-name-shop-b');
    expect(html).not.toContain('shop-name-saved-shop-a');
    expect(html).toContain('1126307464');
    expect(html).toContain('Chưa xác minh');
  });
  it('keeps a missing selection unresolved without opening another shop', () => {
    const html = renderToStaticMarkup(createElement(ShopConnectionsOverview, { shops: [shop()], selectedShopId: 'missing', ...callbacks }));
    expect(html).toContain('Shop đang chọn không còn trong danh sách');
    expect(html).not.toContain('shop-name-saved-shop-a');
  });
});


it('does not present stale, future or expiring checks as currently verified', () => {
  const good = shop({ state: 'connected', refreshStatus: 'healthy', healthCheckedAt: '2026-10-01T07:44:59.000Z', tokenExpiresAt: '2026-10-01T10:00:00.000Z' });
  expect(connectionHealthView(good, now)).toMatchObject({ code: 'stale', needsAttention: true, label: 'Cần kiểm tra lại' });
  expect(connectionHealthView({ ...good, healthCheckedAt: '2026-10-01T08:01:00.000Z' }, now).code).toBe('stale');
  expect(connectionHealthView({ ...good, healthCheckedAt: '2026-10-01T07:45:00.000Z' }, now).code).toBe('checked');
  expect(connectionHealthView({ ...good, tokenExpiresAt: '2026-10-01T08:05:00.000Z' }, now).code).toBe('expiring');
});


it('does not show a fresh healthy timestamp as verified when token expiry is missing', () => {
  expect(connectionHealthView(shop({state:'connected',refreshStatus:'healthy',healthCheckedAt:'2026-10-01T07:59:00.000Z'}),now))
    .toMatchObject({code:'unverified',label:'Chưa xác minh',needsAttention:true});
});
