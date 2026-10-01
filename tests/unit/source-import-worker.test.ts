import { afterEach, expect, it, vi } from 'vitest';
import { importNext } from '../../apps/worker/src/imports.js';

vi.mock('@shopee/domain', async importActual => ({ ...(await importActual<object>()),
  inspectAssets: vi.fn(async () => [{ width: 120, height: 120, mime: 'image/png' }]),
}));
const claim = { id: 'import-a', sha256: 'a'.repeat(64), filename: 'Original.png', kind: 'image',
  bytes: 100, status: 'running', message: '', body: null, createdAt: new Date().toISOString(),
  leaseEpoch: 2, workerId: 'worker-a', leaseUntil: new Date(Date.now() + 300000).toISOString() };
const repository = () => ({ claimImport: vi.fn(async () => claim),
  renewImportLease: vi.fn(async () => true), finishClaimedImport: vi.fn(async () => true),
  finishImport: vi.fn(() => { throw Error('Unfenced completion forbidden'); }) });
afterEach(() => { vi.useRealTimers(); });

it('passes the worker identity and lease to a single successful completion', async () => {
  const repo = repository();
  expect(await importNext(repo as any, { read: async () => new Uint8Array([1]) } as any, { workerId: 'worker-a' })).toBe(true);
  expect(repo.claimImport).toHaveBeenCalledWith('worker-a');
  expect(repo.finishClaimedImport).toHaveBeenCalledWith(claim, { width: 120, height: 120, mime: 'image/png' }, '');
  expect(repo.finishImport).not.toHaveBeenCalled();
});

it('records parse failure through the same lease without an unfenced fallback', async () => {
  const repo = repository(); repo.finishClaimedImport.mockResolvedValue(false);
  await importNext(repo as any, { read: async () => { throw Error('BLOB_MISSING'); } } as any, { workerId: 'worker-a' });
  expect(repo.finishClaimedImport).toHaveBeenCalledOnce();
  expect(repo.finishClaimedImport).toHaveBeenCalledWith(claim, null, 'BLOB_MISSING');
  expect(repo.finishImport).not.toHaveBeenCalled();
});

it('renews a long parse and stops completing when its lease is lost', async () => {
  vi.useFakeTimers(); const repo = repository();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  repo.renewImportLease.mockResolvedValue(false);
  const running = importNext(repo as any, { read: async () => { await gate; return new Uint8Array([1]); } } as any,
    { workerId: 'worker-a', renewEveryMs: 1000 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(repo.renewImportLease).toHaveBeenCalledWith(claim);
  release(); expect(await running).toBe(true);
  expect(repo.finishClaimedImport).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000); expect(repo.renewImportLease).toHaveBeenCalledOnce();
});
