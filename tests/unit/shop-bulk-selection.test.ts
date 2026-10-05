import { describe, expect, it } from 'vitest';
import type { ShopConnection } from '@shopee/domain';
import { shopSelectionKey, selectedConnections, toggleVisibleConnections, connectionStatusCsv } from '../../apps/web/src/shop-bulk-selection.js';
const shop = (id: string): ShopConnection => ({ id, name: 'Shop ' + id, region: 'VN',
  scope: { environment: 'production', partnerId: '2010476', shopId: id, connectionRevision: 1, capabilityRevision: 1 },
  state: 'connected', capabilities: [], updatedAt: '2026-10-02T00:00:00Z' });
describe('multi-shop local operations', () => {
  it('separates connection, environment and partner and rejects stale identities', () => {
    const a = shop('1');
    const changed = { ...a, scope: { ...a.scope, partnerId: '99' } };
    const sandbox = { ...a, scope: { ...a.scope, environment: 'sandbox' as const } };
    expect(new Set([a, changed, sandbox].map(shopSelectionKey)).size).toBe(3);
    expect(selectedConnections([changed, sandbox], new Set([shopSelectionKey(a)]))).toEqual([]);
    expect(selectedConnections([{ ...a, scope: { ...a.scope, connectionRevision: 2 } }], new Set([shopSelectionKey(a)]))).toHaveLength(1);
  });
  it('selects only filtered rows and preserves intentionally selected hidden rows', () => {
    const [a, b, c] = ['1','2','3'].map(shop);
    const original = new Set([shopSelectionKey(c!)]);
    const selected = toggleVisibleConnections(original, [a!, b!]);
    expect(selectedConnections([a!, b!, c!], selected)).toEqual([a, b, c]);
    expect(toggleVisibleConnections(selected, [a!, b!])).toEqual(original);
    expect(toggleVisibleConnections(original, [])).toEqual(original);
    expect(original.size).toBe(1);
  });
  it('exports only selected metadata and escapes names without leaking arbitrary fields', () => {
    const a = { ...shop('1'), displayName: '=HYPERLINK("bad")', tokenExpiresAt: '2026-10-01T00:00:00Z', secret: 'DO_NOT_EXPORT', accessToken: 'DO_NOT_EXPORT' };
    const output = connectionStatusCsv([a], Date.parse('2026-10-02T00:00:00Z'));
    expect(output.startsWith('\uFEFF')).toBe(true);
    expect(output).toContain(`"'=HYPERLINK(""bad"")"`);
    expect(output).toContain('Token đã hết hạn');
    expect(output).not.toContain('DO_NOT_EXPORT');
    expect(output).not.toContain('accessToken');
    expect(connectionStatusCsv([], Date.now()).split('\r\n')).toHaveLength(2);
  });
});
