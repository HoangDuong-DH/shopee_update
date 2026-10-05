import { expect, it } from 'vitest';
import type { ShopConnection } from '@shopee/domain';
import { RequestError } from '../../apps/web/src/api.js';
import {
  prepareConnectionActions,
  executeConnectionActions,
  type ConnectionSnapshot,
  type ConnectionActionClient,
} from '../../apps/web/src/bulk-connection-actions.js';
function shop(
  id = 'shop-a',
  shopId = '1423724897',
  extra: Partial<ShopConnection> = {},
): ShopConnection {
  return {
    id,
    name: id,
    region: 'VN',
    scope: {
      environment: 'production',
      partnerId: '2010476',
      shopId,
      connectionRevision: 3,
      capabilityRevision: 1,
    },
    state: 'connected',
    capabilities: [],
    updatedAt: '2026-10-02T00:00:00Z',
    ...extra,
  };
}
function snapshot(
  row: ShopConnection,
  extra: Partial<ConnectionSnapshot> = {},
): ConnectionSnapshot {
  return {
    environment: row.scope.environment,
    connectionId: row.id,
    partnerId: row.scope.partnerId,
    shopId: row.scope.shopId,
    connectionRevision: row.scope.connectionRevision,
    state: row.state,
    refreshStatus: 'idle',
    refreshReason: null,
    hasSavedKey: true,
    tokenExpiresAt: null,
    officialName: row.name,
    ...extra,
  };
}
function fixture(rows: ShopConnection[]) {
  const saved = new Map(rows.map((row) => [row.scope.shopId, snapshot(row)]));
  const requests: { id: string; action: string; revision: number }[] = [];
  const client: ConnectionActionClient = {
    read: async (scope) => {
      const value = saved.get(scope.shopId);
      if (!value) throw Error('MISSING_FIXTURE');
      return { ...value };
    },
    perform: async (id, action, revision) => {
      requests.push({ id, action, revision });
      const current = [...saved.values()].find((row) => row.connectionId === id)!;
      if (action === 'refresh') current.connectionRevision++;
      current.refreshStatus = action === 'check' ? 'healthy' : 'idle';
      return { kind: 'success', connectionRevision: current.connectionRevision };
    },
  };
  return { client, saved, requests };
}
it('reviews saved snapshots without performing a live check and holds sandbox individually', async () => {
  const production = shop();
  const sandbox = shop('test', '227418363', {
    scope: { ...production.scope, environment: 'sandbox', shopId: '227418363' },
  });
  const f = fixture([production, sandbox]);
  const rows = await prepareConnectionActions([production, sandbox], 'check', f.client);
  expect(rows.map((row) => row.status)).toEqual(['ready', 'held']);
  expect(f.requests).toEqual([]);
});
it('holds uncertain refresh and reauthorization without dropping healthy selected shops', async () => {
  const shops = [shop(), shop('b', '1126307464'), shop('c', '12345')];
  const f = fixture(shops);
  f.saved.get('1126307464')!.refreshStatus = 'unknown';
  f.saved.get('12345')!.state = 'reauth_required';
  const reviewed = await prepareConnectionActions(shops, 'refresh', f.client);
  const rows = await executeConnectionActions(reviewed, 'refresh', f.client);
  expect(rows.map((row) => row.status)).toEqual(['success', 'held', 'held']);
  expect(f.requests).toEqual([{ id: 'shop-a', action: 'refresh', revision: 3 }]);
});
it('holds a different connection, partner, environment or shop returned by a snapshot read', async () => {
  for (const change of [
    { connectionId: 'other' },
    { partnerId: '99' },
    { environment: 'sandbox' },
    { shopId: '99' },
  ]) {
    const row = shop();
    const f = fixture([row]);
    Object.assign(f.saved.get(row.scope.shopId)!, change);
    const result = await prepareConnectionActions([row], 'check', f.client);
    expect(result[0]!.status).toBe('held');
    expect(f.requests).toEqual([]);
  }
});
it('holds changed revision immediately before execution instead of silently approving a new version', async () => {
  const row = shop();
  const f = fixture([row]);
  const reviewed = await prepareConnectionActions([row], 'refresh', f.client);
  f.saved.get(row.scope.shopId)!.connectionRevision = 4;
  const rows = await executeConnectionActions(reviewed, 'refresh', f.client);
  expect(rows[0]!.status).toBe('held');
  expect(f.requests).toEqual([]);
});
it('keeps a lost refresh response unknown after readback and never resends completed or unknown rows', async () => {
  const row = shop();
  const f = fixture([row]);
  const reviewed = await prepareConnectionActions([row], 'refresh', f.client);
  f.client.perform = async (id, action, revision) => {
    f.requests.push({ id, action, revision });
    f.saved.get(row.scope.shopId)!.connectionRevision = 4;
    throw new RequestError('fixture transport timeout', 'REQUEST_TIMEOUT');
  };
  const rows = await executeConnectionActions(reviewed, 'refresh', f.client);
  expect(rows[0]).toMatchObject({ status: 'unknown', after: { connectionRevision: 4 } });
  const again = await executeConnectionActions(rows, 'refresh', f.client);
  expect(again[0]!.status).toBe('unknown');
  expect(f.requests).toHaveLength(1);
});
it('records backend waiting and rejected results separately for exact scoped rows', async () => {
  const shops = [shop(), shop('b', '1126307464')];
  const f = fixture(shops);
  const reviewed = await prepareConnectionActions(shops, 'check', f.client);
  f.client.perform = async (id) =>
    id === 'shop-a'
      ? { kind: 'waiting', code: 'CONNECTION_BUSY' }
      : { kind: 'rejected', code: 'SHOP_AUTHORIZATION_UNAVAILABLE' };
  const rows = await executeConnectionActions(reviewed, 'check', f.client);
  expect(rows.map((row) => [row.shop.id, row.status])).toEqual([
    ['shop-a', 'waiting'],
    ['b', 'failed'],
  ]);
});
it('keeps a successful live check separate from an unresolved credential refresh', async () => {
  const row = shop();
  const f = fixture([row]);
  Object.assign(f.saved.get(row.scope.shopId)!, {
    refreshStatus: 'unknown',
    state: 'refresh_unknown',
  });
  const reviewed = await prepareConnectionActions([row], 'check', f.client);
  f.client.perform = async () => ({ kind: 'success' });
  const rows = await executeConnectionActions(reviewed, 'check', f.client);
  expect(rows[0]).toMatchObject({ status: 'success', after: { refreshStatus: 'unknown' } });
  expect(rows[0]!.message).toContain('gia hạn');
});
it('bounds concurrency and cancels queued shops while allowing in-flight requests to settle', async () => {
  const shops = [shop(), shop('b', '1126307464'), shop('c', '12345'), shop('d', '67890')];
  const f = fixture(shops);
  const reviewed = await prepareConnectionActions(shops, 'check', f.client);
  let active = 0,
    peak = 0,
    cancelled = false;
  const releases: (() => void)[] = [];
  f.client.perform = async (id, action, revision) => {
    f.requests.push({ id, action, revision });
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return { kind: 'success' };
  };
  const running = executeConnectionActions(reviewed, 'check', f.client, {
    shouldStop: () => cancelled,
  });
  while (releases.length < 2) await Promise.resolve();
  cancelled = true;
  releases.forEach((release) => release());
  const rows = await running;
  expect(peak).toBe(2);
  expect(f.requests).toHaveLength(2);
  expect(rows.map((row) => row.status)).toEqual(['success', 'success', 'cancelled', 'cancelled']);
});
it('freezes reviewed identities even when caller selection objects later change', async () => {
  const row = shop();
  const f = fixture([row]);
  const reviewed = await prepareConnectionActions([row], 'check', f.client);
  row.scope.shopId = 'different';
  row.id = 'different';
  const rows = await executeConnectionActions(reviewed, 'check', f.client);
  expect(rows[0]!.status).toBe('success');
  expect(f.requests).toEqual([{ id: 'shop-a', action: 'check', revision: 3 }]);
});

it('shows selected scope review before enabling any live operation', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { BulkConnectionActions } = await import('../../apps/web/src/BulkConnectionActions.js');
  const html = renderToStaticMarkup(
    createElement(BulkConnectionActions, {
      shops: [shop()],
      initialAction: 'refresh',
      onRefresh: () => {},
      onConnectShop: () => {},
    }),
  );
  expect(html).toContain('1423724897');
  expect(html).toContain('2010476');
  expect(html).toContain('Xem trước');
  expect(html).not.toContain('Đã gia hạn');
});

it('never resends a waiting backend action when executing the same reviewed group again', async () => {
  const row = shop();
  const f = fixture([row]);
  const reviewed = await prepareConnectionActions([row], 'refresh', f.client);
  f.client.perform = async (id, action, revision) => {
    f.requests.push({ id, action, revision });
    return { kind: 'waiting', code: 'CONNECTION_BUSY' };
  };
  const rows = await executeConnectionActions(reviewed, 'refresh', f.client);
  const again = await executeConnectionActions(rows, 'refresh', f.client);
  expect(again[0]!.status).toBe('waiting');
  expect(f.requests).toHaveLength(1);
});
it('holds an unknown rotation appearing after review even at the same revision', async () => {
  const row = shop();
  const f = fixture([row]);
  const reviewed = await prepareConnectionActions([row], 'refresh', f.client);
  f.saved.get(row.scope.shopId)!.refreshStatus = 'unknown';
  const rows = await executeConnectionActions(reviewed, 'refresh', f.client);
  expect(rows[0]!.status).toBe('held');
  expect(f.requests).toEqual([]);
});
it('requires a changed saved revision for successful refresh instead of trusting a success label', async () => {
  const row = shop();
  const f = fixture([row]);
  const reviewed = await prepareConnectionActions([row], 'refresh', f.client);
  f.client.perform = async () => ({ kind: 'success', connectionRevision: 3 });
  const rows = await executeConnectionActions(reviewed, 'refresh', f.client);
  expect(rows[0]!.status).toBe('unknown');
});
it('retains unknown when a successful response cannot be read back from the same exact connection', async () => {
  const row = shop();
  const f = fixture([row]);
  const reviewed = await prepareConnectionActions([row], 'check', f.client);
  f.client.perform = async () => {
    f.saved.get(row.scope.shopId)!.connectionId = 'other';
    return { kind: 'success' };
  };
  const rows = await executeConnectionActions(reviewed, 'check', f.client);
  expect(rows[0]!.status).toBe('unknown');
  expect(rows[0]!.after).toBeUndefined();
});
it('holds duplicate saved identities rather than sending concurrent requests to the same shop', async () => {
  const first = shop();
  const second = shop('other');
  const f = fixture([first]);
  const rows = await prepareConnectionActions([first, second], 'check', f.client);
  expect(rows.map((row) => row.status)).toEqual(['held', 'held']);
  expect(f.requests).toEqual([]);
});
it('cancels before POST if cancellation arrives during the fresh snapshot read', async () => {
  const row = shop();
  const f = fixture([row]);
  const reviewed = await prepareConnectionActions([row], 'check', f.client);
  let cancelled = false;
  const read = f.client.read;
  f.client.read = async (scope) => {
    const saved = await read(scope);
    cancelled = true;
    return saved;
  };
  const rows = await executeConnectionActions(reviewed, 'check', f.client, {
    shouldStop: () => cancelled,
  });
  expect(rows[0]!.status).toBe('cancelled');
  expect(f.requests).toEqual([]);
});
