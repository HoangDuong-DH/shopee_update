import { expect, it } from 'vitest';
import type { Repository } from '../../packages/persistence/src/index.js';
import { connectionOperationalHealth, operationsRuntime, OperationsOverviewService } from '../../apps/api/src/operations-overview-service.js';

const now = '2026-10-01T03:00:00.000Z';
const connection = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Public shop name', display_name: null,
  environment: 'production', partner_id: '12345', shop_id: '56789', revision: 4,
  state: 'connected', has_token: true, expires_at: '2026-10-01T04:00:00Z',
  health_checked_at: now, refresh_status: 'healthy', auto_refresh: true,
};

it.each([
  [{ expires_at: '2026-10-01T03:00:00Z' }, 'expired'],
  [{ expires_at: '2026-10-01T03:10:00Z' }, 'expiring'],
  [{ expires_at: '2026-10-01T03:10:01Z' }, 'valid'],
  [{ expires_at: null }, 'unknown'],
  [{ expires_at: 'not-a-date' }, 'unknown'],
  [{ has_token: false }, 'missing'],
  [{ refresh_status: 'unknown' }, 'unknown'],
  [{ state: 'refresh_unknown' }, 'unknown'],
] as const)('does not invent token validity when expiry or rotation is uncertain (%j)', (change, tokenState) => {
  expect(connectionOperationalHealth({ ...connection, ...change }, now).tokenState).toBe(tokenState);
});

it.each([
  ['2026-10-01T02:45:00Z', 'fresh'],
  ['2026-10-01T02:44:59Z', 'stale'],
  [null, 'never_checked'],
  ['not-a-date', 'unknown'],
  ['2026-10-01T03:01:00Z', 'unknown'],
] as const)('separates freshness from failed or unknown health outcomes (%s)', (health_checked_at, state) => {
  const health = connectionOperationalHealth({ ...connection, health_checked_at, refresh_status: 'waiting' }, now).health;
  expect(health.state).toBe(state);
  expect(health.outcome).toBe('attention');
});

it('reports configuration literally, including isolated maintenance suppression, without granting execution', () => {
  expect(operationsRuntime({ PRODUCTION_PILOT_ENABLED: '1', SHOPEE_PRODUCTION_WRITES: 'false', INTERNAL_ISOLATED_MODE: '1' }))
    .toMatchObject({ productionWorkflowEnabled: true, productionWritesConfigured: false,
      connectionMaintenanceEnabled: false, executionReadiness: 'not_assessed' });
  expect(operationsRuntime({ PRODUCTION_PILOT_ENABLED: 'true', SHOPEE_PRODUCTION_WRITES: 'true' }))
    .toMatchObject({ productionWorkflowEnabled: false, productionWritesConfigured: true, connectionMaintenanceEnabled: false });
});

it('turns database failure into unavailable sources instead of zero workloads or leaking driver errors', async () => {
  const fail = async () => { throw Error('postgres://private-user:private-password@private-server/secret-database'); };
  const repo = { probe: fail, pool: { query: fail } } as unknown as Repository;
  const result = await new OperationsOverviewService(repo, { now: () => new Date(now), env: {} }).get();
  expect(result.status).toBe('degraded');
  expect(result.database).toMatchObject({ state: 'unavailable', observedAt: now, data: null });
  expect(result.worker.data).toBeNull();
  expect(result.connections.data).toBeNull();
  for (const source of [result.counts.imports, result.counts.drafts, result.counts.workOrders, result.counts.batches]) {
    expect(source).toMatchObject({ state: 'unavailable', data: null, observedAt: now });
  }
  expect(result.blockers.filter(b => b.severity === 'block')).toHaveLength(7);
  expect(JSON.stringify(result)).not.toContain('private-');
  expect(JSON.stringify(result)).not.toContain('secret-database');
});

it('rejects incomplete or unsafe numeric shop filters without touching the database', async () => {
  const fail = async () => { throw Error('DATABASE_WAS_READ'); };
  const repo = { probe: fail, pool: { query: fail } } as unknown as Repository;
  const service = new OperationsOverviewService(repo);
  await expect(service.get({ environment: 'production', shopId: '56789' })).rejects.not.toThrow('DATABASE_WAS_READ');
  await expect(service.get({ environment: 'production', partnerId: '12345', shopId: '9007199254740992' })).rejects.not.toThrow('DATABASE_WAS_READ');
});
