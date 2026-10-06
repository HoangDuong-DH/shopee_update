import { afterEach, expect, it, vi } from 'vitest';
import { importNext as runImportNext, type ImportOptions } from '../../apps/worker/src/imports.js';
import { inspectAssets } from '@shopee/domain';
const importNext = (repo: any, blobs: any, options: ImportOptions = {}) =>
  runImportNext(repo, blobs, {
    parse: async (bytes) => (await inspectAssets([{ key: 'Original.png', bytes }]))[0],
    ...options,
  });

vi.mock('@shopee/domain', async (importActual) => ({
  ...(await importActual<object>()),
  inspectAssets: vi.fn(async () => [{ width: 120, height: 120, mime: 'image/png' }]),
}));
const claim = {
  id: 'import-a',
  sha256: 'a'.repeat(64),
  filename: 'Original.png',
  kind: 'image',
  bytes: 100,
  status: 'running',
  message: '',
  body: null,
  createdAt: new Date().toISOString(),
  leaseEpoch: 2,
  workerId: 'worker-a',
  leaseUntil: new Date(Date.now() + 300000).toISOString(),
};
const repository = () => ({
  claimImport: vi.fn(async () => claim),
  renewImportLease: vi.fn(async () => true),
  finishClaimedImport: vi.fn(async (_claim: unknown, _body: unknown, _message = '') => true),
  finishImport: vi.fn(() => {
    throw Error('Unfenced completion forbidden');
  }),
});
afterEach(() => {
  vi.useRealTimers();
});

it('passes the worker identity and lease to a single successful completion', async () => {
  const repo = repository();
  expect(
    await importNext(repo as any, { read: async () => new Uint8Array([1]) } as any, {
      workerId: 'worker-a',
    }),
  ).toBe(true);
  expect(repo.claimImport).toHaveBeenCalledWith('worker-a');
  expect(repo.finishClaimedImport).toHaveBeenCalledWith(
    claim,
    { width: 120, height: 120, mime: 'image/png' },
    '',
  );
  expect(repo.finishImport).not.toHaveBeenCalled();
});

it('records parse failure through the same lease without an unfenced fallback', async () => {
  const repo = repository();
  repo.finishClaimedImport.mockResolvedValue(false);
  await importNext(
    repo as any,
    {
      read: async () => {
        throw Error('BLOB_MISSING');
      },
    } as any,
    { workerId: 'worker-a' },
  );
  expect(repo.finishClaimedImport).toHaveBeenCalledOnce();
  expect(repo.finishClaimedImport).toHaveBeenCalledWith(claim, null, 'BLOB_MISSING');
  expect(repo.finishImport).not.toHaveBeenCalled();
});

it('renews a long parse and stops completing when its lease is lost', async () => {
  vi.useFakeTimers();
  const repo = repository();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  repo.renewImportLease.mockResolvedValue(false);
  const running = importNext(
    repo as any,
    {
      read: async () => {
        await gate;
        return new Uint8Array([1]);
      },
    } as any,
    { workerId: 'worker-a', renewEveryMs: 1000 },
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(repo.renewImportLease).toHaveBeenCalledWith(claim);
  release();
  expect(await running).toBe(true);
  expect(repo.finishClaimedImport).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(repo.renewImportLease).toHaveBeenCalledOnce();
});

it('bounds even a blob read that never settles and continues to the next source', async () => {
  vi.useFakeTimers();
  const repo = repository();
  const running = importNext(
    repo as any,
    { read: () => new Promise(() => {}) } as any,
    { timeoutMs: 1000 } as any,
  );
  let settled = false;
  void running.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(1001);
  expect(settled).toBe(true);
  expect(repo.finishClaimedImport).toHaveBeenCalledWith(claim, null, 'SOURCE_IMPORT_TIMEOUT');
  expect(await running).toBe(true);
  expect(await importNext(repo as any, { read: async () => new Uint8Array([1]) } as any)).toBe(
    true,
  );
  expect(repo.finishClaimedImport).toHaveBeenCalledTimes(2);
});

it('rejects oversized metadata before allocating or reading its blob', async () => {
  const repo = repository();
  repo.claimImport.mockResolvedValue({ ...claim, bytes: 64 * 1024 * 1024 + 1 });
  const read = vi.fn(async () => new Uint8Array([1]));
  await importNext(repo as any, { read } as any);
  expect(read).not.toHaveBeenCalled();
  expect(repo.finishClaimedImport).toHaveBeenCalledWith(
    expect.anything(),
    null,
    'SOURCE_FILE_TOO_LARGE',
  );
});

it('uses one deadline across blob read and parsing and rejects a late parse result', async () => {
  vi.useFakeTimers();
  const repo = repository();
  let readFinished!: () => void, parseFinished!: (body: unknown) => void;
  const parse = vi.fn(
    () =>
      new Promise((resolve) => {
        parseFinished = resolve;
      }),
  );
  const running = importNext(
    repo as any,
    {
      read: async () => {
        await new Promise<void>((resolve) => {
          readFinished = resolve;
        });
        return new Uint8Array([1]);
      },
    } as any,
    { timeoutMs: 1000, parse },
  );
  await vi.advanceTimersByTimeAsync(600);
  readFinished();
  await vi.advanceTimersByTimeAsync(300);
  expect(parse).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(101);
  expect(await running).toBe(true);
  expect(repo.finishClaimedImport).toHaveBeenCalledWith(claim, null, 'SOURCE_IMPORT_TIMEOUT');
  parseFinished({ late: true });
  await vi.advanceTimersByTimeAsync(100);
  expect(repo.finishClaimedImport).toHaveBeenCalledOnce();
});

it('cancels parsing immediately on lost lease without waiting for parser cooperation', async () => {
  vi.useFakeTimers();
  const repo = repository();
  repo.renewImportLease.mockResolvedValue(false);
  let signal!: AbortSignal;
  const running = importNext(repo as any, { read: async () => new Uint8Array([1]) } as any, {
    renewEveryMs: 100,
    parse: async (_bytes, _job, currentSignal) => {
      signal = currentSignal;
      return new Promise(() => {});
    },
  });
  await vi.advanceTimersByTimeAsync(101);
  expect(await running).toBe(true);
  expect(signal.aborted).toBe(true);
  expect(repo.finishClaimedImport).not.toHaveBeenCalled();
});

it('cancels and reports a failed lease renewal without completing the stale source', async () => {
  vi.useFakeTimers();
  const repo = repository();
  repo.renewImportLease.mockRejectedValue(Error('database failure'));
  const running = importNext(repo as any, { read: () => new Promise(() => {}) } as any, {
    renewEveryMs: 100,
  });
  const rejected = expect(running).rejects.toThrow('IMPORT_LEASE_RENEWAL_FAILED');
  await vi.advanceTimersByTimeAsync(101);
  await rejected;
  expect(repo.finishClaimedImport).not.toHaveBeenCalled();
});

it('bounds a never-settling renewal and keeps completion fenced', async () => {
  vi.useFakeTimers();
  const repo = repository();
  repo.renewImportLease.mockImplementation(() => new Promise(() => {}));
  const running = importNext(repo as any, { read: () => new Promise(() => {}) } as any, {
    renewEveryMs: 100,
    timeoutMs: 10000,
  });
  const rejected = expect(running).rejects.toThrow('IMPORT_LEASE_RENEWAL_FAILED');
  await vi.advanceTimersByTimeAsync(5101);
  await rejected;
  expect(repo.finishClaimedImport).not.toHaveBeenCalled();
});

it('keeps renewing long valid work and completes only with its original claim', async () => {
  vi.useFakeTimers();
  const repo = repository();
  let release!: (body: unknown) => void;
  const running = importNext(repo as any, { read: async () => new Uint8Array([1]) } as any, {
    renewEveryMs: 100,
    parse: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await vi.advanceTimersByTimeAsync(250);
  release({ source: 'fixture' });
  expect(await running).toBe(true);
  expect(repo.renewImportLease).toHaveBeenCalledTimes(2);
  expect(repo.finishClaimedImport).toHaveBeenCalledWith(claim, { source: 'fixture' }, '');
});

it('rejects invalid source bytes before creating a parser and redacts unsafe errors', async () => {
  const repo = repository(),
    parse = vi.fn();
  await importNext(repo as any, { read: async () => new Uint8Array() } as any, { parse });
  expect(parse).not.toHaveBeenCalled();
  expect(repo.finishClaimedImport).toHaveBeenCalledWith(claim, null, 'INVALID_SOURCE_BYTES');
  repo.finishClaimedImport.mockClear();
  await importNext(
    repo as any,
    {
      read: async () => {
        throw Error('BLOB_MISSING C:/private/customer.xlsx');
      },
    } as any,
  );
  expect(repo.finishClaimedImport.mock.calls[0][2]).not.toContain('private');
});

it('checks actual byte size independently from claimed metadata', async () => {
  const repo = repository(),
    parse = vi.fn();
  await importNext(repo as any, { read: async () => new Uint8Array(32 * 1024 * 1024 + 1) } as any, {
    parse,
  });
  expect(parse).not.toHaveBeenCalled();
  expect(repo.finishClaimedImport).toHaveBeenCalledWith(claim, null, 'SOURCE_FILE_TOO_LARGE');
});
