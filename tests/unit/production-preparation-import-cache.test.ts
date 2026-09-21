import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@shopee/domain';
import { Repository } from '@shopee/persistence';
import { ProductionPreparationService } from '../../apps/api/src/production-preparation-service.js';

const guard = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@shopee/persistence', async importOriginal => ({ ...await importOriginal<typeof import('@shopee/persistence')>(), assertPreparationLocalSourcesActive: guard }));
vi.mock('../../apps/api/src/production-batch-source.js', async importOriginal => ({ ...await importOriginal<typeof import('../../apps/api/src/production-batch-source.js')>(), loadProductionBatchSource: vi.fn(async () => ({})) }));
afterEach(() => { vi.restoreAllMocks(); guard.mockClear(); });

async function fixture() {
  const id = randomUUID(), priceId = randomUUID(), priceSha = 'a'.repeat(64);
  const root = await mkdtemp(resolve('.local', 'preparation-import-cache-'));
  await mkdir(resolve(root, 'preparations', id), { recursive: true });
  const entries = ['one', 'two'].map(productKey => ({
    kind: 'ready', productKey, sourceRevision: 1,
    sourceSnapshot: { draft: { productKey, revision: 1 } },
    document: { sourceKey: productKey }, sourceFile: { id: productKey, path: 'unused', sha256: 'c'.repeat(64) },
    priceFiles: [{ id: priceId, path: 'unused.xlsx', sha256: priceSha }], assets: {}, proposedAttributeList: [],
    stockLocation: { referenceItemId: '99', expectedLocationBySku: { SKU: 'VNZ' }, writeLocationBySku: { SKU: null } },
    priceProof: Array.from({ length: 850 }, (_, index) => ({ importId: priceId, fileSha256: priceSha, sku: productKey + index, sheetName: 'Giá', skuCell: 'A2', priceCell: 'B2', originalPrice: '100', priceProfile: 'SHOP MALL' })),
  }));
  const body = { entries }, row = { body, fingerprint: createHash('sha256').update(canonicalJson(body)).digest('hex'), registration: null };
  const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT * FROM production_source_preparations') ? [row] : [], rowCount: 1 }));
  const client = { query, release: vi.fn() }, pool = { connect: vi.fn(async () => client) };
  const read = vi.spyOn(Repository.prototype, 'getImport').mockResolvedValue({ id: priceId, sha256: priceSha } as any);
  const register = vi.fn(async () => ({ batchId: randomUUID(), manifestSha256: 'd'.repeat(64) }));
  const service = new ProductionPreparationService(new Repository(pool as any), {} as any, {
    root, register, readSource: async key => ({ productKey: key, revision: 1 }),
    verifyStock: async () => ({ expectedLocationId: 'VNZ', writeLocationId: null }),
  });
  return { id, row, entries, read, register, service, client, query };
}

it('reads a shared pricebook once for 1,700 proofs, preserving source guard and fresh reads on each registration attempt', async () => {
  const f = await fixture();
  const receipt = await f.service.register(f.id, { expectedFingerprint: f.row.fingerprint });
  expect(receipt.readyCount).toBe(2);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(guard).toHaveBeenCalledWith(f.client, f.entries);
  expect(guard.mock.invocationCallOrder[0]).toBeLessThan(f.read.mock.invocationCallOrder[0]);
  expect(f.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_lock_shared'))).toBe(true);
  // Simulate a later attempt finding the same unregistered preparation after an interruption.
  f.read.mockResolvedValueOnce({ sha256: 'b'.repeat(64) } as any);
  await expect(f.service.register(f.id, { expectedFingerprint: f.row.fingerprint })).rejects.toThrow('PREPARATION_PRICE_SOURCE_CHANGED');
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.register).toHaveBeenCalledTimes(1);
});

it('checks every proof against the cached import and blocks a contradictory later SKU before registration', async () => {
  const f = await fixture();
  f.entries[1].priceProof[849].fileSha256 = 'b'.repeat(64);
  f.row.fingerprint = createHash('sha256').update(canonicalJson(f.row.body)).digest('hex');
  await expect(f.service.register(f.id, { expectedFingerprint: f.row.fingerprint })).rejects.toThrow('PREPARATION_PRICE_SOURCE_CHANGED');
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.register).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE production_source_preparations SET approved_at'))).toBe(false);
  expect(f.client.release).toHaveBeenCalledOnce();
});
