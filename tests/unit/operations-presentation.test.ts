import { describe, expect, it } from 'vitest';
import type {
  OperationsBlocker,
  OperationsConnectionHealth,
  OperationsScope,
} from '../../packages/domain/src/operations-overview.js';
import {
  operationsConnectionKey,
  operationNextAction,
  operationsDataUnavailable,
  connectionIndicator,
  connectionIndicatorCounts,
  presentOperationsIssues,
} from '../../apps/web/src/operations-presentation.js';

const scope: OperationsScope = { environment: 'production', partnerId: '123', shopId: '456' };
const blocker = (change: Partial<OperationsBlocker> = {}): OperationsBlocker => ({
  code: 'TOKEN_EXPIRED',
  severity: 'attention',
  source: 'saved_connection',
  message: 'Kết nối hết hạn',
  nextAction: 'Mở đúng shop để kết nối lại.',
  connectionId: 'connection-a',
  scope,
  route: { page: 'shops', apiPath: '/v1/shops' },
  ...change,
});
const connection = (
  change: Partial<OperationsConnectionHealth> = {},
): OperationsConnectionHealth => ({
  id: 'connection-a',
  name: 'Shop A',
  scope,
  revision: 1,
  state: 'connected',
  tokenState: 'expired',
  tokenExpiresAt: null,
  health: { state: 'stale', outcome: 'unknown', checkedAt: null },
  refreshState: 'idle',
  autoRefresh: false,
  ...change,
});

describe('overview issue presentation', () => {
  it('keeps every reason, count, route and exact scope while grouping one connection', () => {
    const expiry = blocker({ count: 7 });
    const uncertain = blocker({
      code: 'REFRESH_UNKNOWN',
      severity: 'block',
      count: 0,
      source: 'refresh_receipt',
      message: 'Kết quả gia hạn chưa rõ',
      nextAction: 'Đọc biên nhận; chưa gửi lại.',
      route: { page: 'results', apiPath: '/v1/results' },
    });
    const original = [expiry, uncertain];
    const before = structuredClone(original);
    const result = presentOperationsIssues(original, [connection()]);
    expect(result.tasks).toEqual([]);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]).toMatchObject({ name: 'Shop A', severity: 'block', scope });
    expect(result.connections[0]!.issues).toEqual([uncertain, expiry]);
    expect(result.connections[0]!.issues[0]).toBe(uncertain);
    expect(original).toEqual(before);
  });

  it('never merges across environment, partner, shop or connection identity', () => {
    const variants = [
      blocker(),
      blocker({ scope: { ...scope, environment: 'sandbox' } }),
      blocker({ scope: { ...scope, partnerId: '987' } }),
      blocker({ scope: { ...scope, shopId: '789' } }),
      blocker({ connectionId: 'connection-b' }),
    ];
    const result = presentOperationsIssues(variants, [connection()]);
    expect(result.connections).toHaveLength(5);
    expect(new Set(result.connections.map((group) => group.key)).size).toBe(5);
    expect(result.connections.map((group) => group.issues).flat()).toEqual(variants);
    expect(result.connections.slice(1).some((group) => group.name === 'Shop A')).toBe(false);
  });

  it('names a group only from a fully matching connection, even if IDs or shop numbers match', () => {
    const elsewhere = connection({
      name: 'Wrong partner name',
      scope: { ...scope, partnerId: '987' },
    });
    const otherEnvironment = connection({
      name: 'Wrong environment name',
      scope: { ...scope, environment: 'sandbox' },
    });
    const otherConnection = connection({ id: 'connection-b', name: 'Wrong connection name' });
    expect(
      presentOperationsIssues([blocker()], [elsewhere, otherEnvironment, otherConnection])
        .connections[0]!.name,
    ).toBe('Shop 456');
    expect(
      presentOperationsIssues([blocker()], [elsewhere, connection()]).connections[0]!.name,
    ).toBe('Shop A');
  });

  it('keeps workspace tasks and incomplete identities individually actionable', () => {
    const noScope = blocker({ scope: undefined });
    const noId = blocker({
      connectionId: undefined,
      severity: 'block',
      code: 'BATCH_HELD',
      count: 3,
    });
    const result = presentOperationsIssues([noScope, noId]);
    expect(result.connections).toEqual([]);
    expect(result.tasks).toEqual([noId, noScope]);
    expect(result.tasks[0]!.route).toEqual(noId.route);
  });

  it('handles empty and unavailable connection names without inventing a known shop', () => {
    expect(presentOperationsIssues([])).toEqual({ tasks: [], connections: [] });
    expect(
      presentOperationsIssues([blocker()], [connection({ name: ' ' })]).connections[0]!.name,
    ).toBe('Shop 456');
    expect(operationsConnectionKey('a', scope)).not.toBe(
      operationsConnectionKey('a', { ...scope, partnerId: '987' }),
    );
  });
});

describe('compact connection indicators', () => {
  it('uses authoritative reason codes and keeps unverified status distinct from expiry', () => {
    const expired = blocker({ code: 'CONNECTION_TOKEN_EXPIRED' });
    const unknown = blocker({ code: 'CONNECTION_TOKEN_UNKNOWN' });
    expect(connectionIndicator([expired]).label).toBe('Cần gia hạn');
    expect(connectionIndicator([expired, unknown]).label).toBe('Chưa xác minh');
    expect(connectionIndicator([blocker({ code: 'CONNECTION_TOKEN_MISSING' })]).label).toBe('Chưa cấp quyền');
    expect(connectionIndicator([blocker({ code: 'NEW_SERVER_REASON', message: 'Hết hạn' })])).toMatchObject({ label: 'Cần xử lý', icon: 'alert' });
  });
  it('counts shops once rather than counting their multiple reasons', () => {
    const groups = presentOperationsIssues([
      blocker({ code: 'CONNECTION_TOKEN_EXPIRED' }), blocker({ code: 'CONNECTION_HEALTH_NOT_FRESH' }),
      blocker({ connectionId: 'b', code: 'CONNECTION_TOKEN_EXPIRED' }),
      blocker({ connectionId: 'c', code: 'CONNECTION_TOKEN_UNKNOWN' }),
    ]).connections;
    const before = structuredClone(groups);
    expect(connectionIndicatorCounts(groups).map((row) => [row.indicator.label, row.count])).toEqual([['Cần gia hạn', 2], ['Chưa xác minh', 1]]);
    expect(groups).toEqual(before);
  });
});


it('gives each action its actual destination and does not call guidance a repair', () => {
  expect(operationNextAction(blocker({connectionId:undefined,code:'PRODUCTION_WORKFLOW_DISABLED', route:{page:'guide',apiPath:'/v1/operations/overview'}}))).toMatchObject({label:'Xem luồng đăng', page:'production', view:'working'});
  expect(operationNextAction(blocker({connectionId:undefined,code:'PRODUCTION_QC_PENDING',route:{page:'production',apiPath:'/v1/production-batches'}}))).toMatchObject({label:'Đối chiếu listing', page:'production', filter:'qc'});
  expect(operationNextAction(blocker({connectionId:undefined,code:'PREPARATIONS_HELD',route:{page:'production',apiPath:'/v1/production-preparations/context'}}))).toMatchObject({label:'Xem nguồn cần bổ sung', filter:'all'});
  expect(operationNextAction(blocker({connectionId:undefined,code:'DATABASE_DOWN',route:{page:'guide',apiPath:'/health/ready'}})).label).toBe('Xem hướng dẫn');
});
it('distinguishes unreadable data from a readable workload that needs attention', () => {
  const part = {state:'available',data:{}};
  const value = {database:part,worker:part,connections:part,counts:{imports:part,drafts:part,workOrders:part,batches:part}} as any;
  expect(operationsDataUnavailable(value)).toBe(false);
  expect(operationsDataUnavailable({...value,worker:{state:'unavailable',data:null}})).toBe(true);
});
