import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BlobStore, Repository } from '../../packages/persistence/src/index.js';
import { currentProductionScope, legacyProductionScope, withProductionScope, bindProductionService,
  type ProductionScope } from '../../apps/api/src/production-scope.js';
import { ProductionWorkflows } from '../../apps/api/src/production-workflows.js';
import { ProductionPreparationService } from '../../apps/api/src/production-preparation-service.js';
import { ProductionPreparationExecution } from '../../apps/api/src/production-preparation-execution.js';
import { ProductionPreparationMetadataService } from '../../apps/api/src/production-preparation-metadata.js';
import { ProductionPilotReadSession } from '../../apps/api/src/production-pilot-read-session.js';
import { runPass1ProductionBatch } from '../../apps/api/src/production-batch-runner.js';

const shopA: ProductionScope = { environment: 'production', partnerId: '2010476', shopId: '1126307464' };
const shopB: ProductionScope = { environment: 'production', partnerId: '2010476', shopId: '1126307465' };
function deferred() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

describe('production shop execution isolation', () => {
  it('keeps interleaved async work and detached callbacks bound to their original shop', async () => {
    const gateA = deferred(), gateB = deferred();
    const background: Promise<string>[] = [];
    const service = () => ({ async execute(gate: ReturnType<typeof deferred>) {
      const before = currentProductionScope().shopId;
      await gate.wait;
      const after = currentProductionScope().shopId;
      background.push(new Promise(resolve => setImmediate(() => resolve(currentProductionScope().shopId))));
      return { before, after };
    } });
    const a = bindProductionService(shopA, service()), b = bindProductionService(shopB, service());
    const runA = a.execute(gateA), runB = b.execute(gateB);
    gateB.release(); const resultB = await runB;
    gateA.release(); const resultA = await runA;
    expect(resultA).toEqual({ before: shopA.shopId, after: shopA.shopId });
    expect(resultB).toEqual({ before: shopB.shopId, after: shopB.shopId });
    expect(await Promise.all(background)).toEqual([shopB.shopId, shopA.shopId]);
    expect(currentProductionScope()).toEqual(legacyProductionScope);
  });

  it('uses independent workflow caches and selected-shop connection queries under concurrency', async () => {
    const gates = new Map([[shopA.shopId, deferred()], [shopB.shopId, deferred()]]);
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      expect(sql).toContain('FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3');
      expect(values[1]).toBe(shopA.partnerId);
      const shopId = String(values[2]);
      await gates.get(shopId)!.wait;
      expect(currentProductionScope().shopId).toBe(shopId);
      return { rows: [] }; // Stop safely before decoding a token or any upstream request.
    });
    const flows = new ProductionWorkflows(new Repository({ query } as any), new BlobStore('.local/scope-tests-unused'), {} as any);
    const a = flows.get(shopA), b = flows.get(shopB);
    expect(a).toBe(flows.get(shopA)); expect(a).not.toBe(b);
    expect(a.metadata).not.toBe(b.metadata); expect(a.batch).not.toBe(b.batch);
    const runA = a.metadata.get({ includeInventory: false }).catch(error => error.message);
    const runB = b.metadata.get({ includeInventory: false }).catch(error => error.message);
    gates.get(shopB.shopId)!.release(); gates.get(shopA.shopId)!.release();
    expect(await Promise.all([runA, runB])).toEqual(['PRODUCTION_PREPARATION_AUTH_REQUIRED', 'PRODUCTION_PREPARATION_AUTH_REQUIRED']);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not return another shop preparation or execution when the UUID is known', async () => {
    const preparationId = randomUUID();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM production_source_preparations')) return { rows: [{ id: preparationId,
        fingerprint: 'a'.repeat(64), created_at: new Date().toISOString(), body: { scope: shopA, entries: [] } }] };
      if (sql.includes('FROM production_preparation_executions')) return { rows: [{ body: { state: 'paused', currentBatchId: randomUUID() } }] };
      if (sql.includes('FROM production_execution_policies')) return { rows: [] };
      throw Error('Unexpected database access');
    });
    const repo = new Repository({ query } as any);
    const preparation = new ProductionPreparationService(repo, new BlobStore('.local/scope-tests-unused'));
    const execution = new ProductionPreparationExecution(repo, preparation, {} as any);
    await expect(withProductionScope(shopB, () => preparation.get(preparationId))).rejects.toThrow('PRODUCTION_BATCH_SCOPE_MISMATCH');
    await expect(withProductionScope(shopB, () => execution.get(preparationId))).rejects.toThrow('PRODUCTION_BATCH_SCOPE_MISMATCH');
  });

  it('validates read-session scope at call time and isolates in-flight cache across shops', async () => {
    const now = Date.now(), gates = [deferred(), deferred()];
    const session = new ProductionPilotReadSession({ batchId: randomUUID(), manifestSha256: 'a'.repeat(64), now: () => now });
    const load = (shop: ProductionScope, index: number) => vi.fn(async () => {
      await gates[index]!.wait;
      return { observedAt: new Date(now).toISOString(), file: shop.shopId + '.json',
        result: { kind: 'success', requestId: shop.shopId, response: { shop: shop.shopId } } as any };
    });
    const loadA = load(shopA, 0), loadB = load(shopB, 1);
    const a = withProductionScope(shopA, () => session.read({ ...shopA, connectionRevision: 1 }, '/api/v2/product/get_category', {}, loadA));
    const b = withProductionScope(shopB, () => session.read({ ...shopB, connectionRevision: 1 }, '/api/v2/product/get_category', {}, loadB));
    gates[1]!.release(); gates[0]!.release();
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA.file).toBe(shopA.shopId + '.json'); expect(resultB.file).toBe(shopB.shopId + '.json');
    const cached = await withProductionScope(shopA, () => session.read({ ...shopA, connectionRevision: 1 }, '/api/v2/product/get_category', {}, loadA));
    expect(cached.cacheHit).toBe(true); expect(loadA).toHaveBeenCalledTimes(1); expect(loadB).toHaveBeenCalledTimes(1);
    await expect(withProductionScope(shopB, () => session.read({ ...shopA, connectionRevision: 1 }, '/api/v2/product/get_category', {}, loadA))).rejects.toThrow();
  });

  it('rejects a foreign manifest at the shared runner boundary before DB/network/evidence writes', async () => {
    const query = vi.fn(() => { throw Error('Database should not be touched for a foreign manifest'); });
    const load = vi.fn(async () => ({ value: { version: 2, batchId: randomUUID(), scope: shopA, listings: [] },
      sha256: 'a'.repeat(64), manifestPath: 'foreign-fixture.json' }));
    await expect(withProductionScope(shopB, () => runPass1ProductionBatch({ mode: 'inspect', manifestPath: 'foreign-fixture.json', expectedSha256: 'a'.repeat(64) },
      { repo: new Repository({ query } as any), blobs: new BlobStore('.local/scope-tests-unused'), load } as any)))
      .rejects.toThrow('PRODUCTION_BATCH_SCOPE_MISMATCH');
    expect(query).not.toHaveBeenCalled();
  });
});
