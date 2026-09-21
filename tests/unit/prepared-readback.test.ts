import { expect, it } from 'vitest';
import { pollPreparedReadback } from '../../packages/shopee/src/prepared-readback.js';
it('waits for delayed read propagation and requires two matching reads without a write callback', async () => {
  let reads = 0;
  const sleeps: number[] = [];
  const result = await pollPreparedReadback({
    read: async () => ({
      kind: 'success',
      response: { title: ++reads === 1 ? 'old' : 'new' },
      requestId: 'read-' + reads,
    }),
    check: (r) => ({
      verified: r.title === 'new',
      mismatchedPaths: r.title === 'new' ? [] : ['item.item_name'],
    }),
    pause: async (ms) => {
      sleeps.push(ms);
    },
    delaysMs: [0, 1, 2, 3],
  });
  expect(result.state).toBe('verified');
  expect(reads).toBe(3);
  expect(sleeps).toEqual([1, 2]);
  expect(result.observations[0].mismatchedPaths).toEqual(['item.item_name']);
});
it('keeps partial application unresolved after the bounded read budget', async () => {
  let reads = 0;
  const result = await pollPreparedReadback({
    read: async () => {
      reads++;
      return { kind: 'success', response: {}, requestId: 'partial-' + reads };
    },
    check: () => ({ verified: false, mismatchedPaths: ['models.2.stock'] }),
    pause: async () => {},
    delaysMs: [0, 1, 1],
  });
  expect(result.state).toBe('unresolved');
  expect(reads).toBe(3);
  expect(result.observations).toHaveLength(3);
});
it('does not convert malformed or failed reads to successful verification', async () => {
  let reads = 0;
  const result = await pollPreparedReadback({
    read: async () => {
      reads++;
      return reads === 1
        ? { kind: 'unknown', code: 'transport' }
        : { kind: 'success', response: {}, requestId: 'broken' };
    },
    check: () => {
      throw new Error('bad structure');
    },
    pause: async () => {},
    delaysMs: [0, 1],
  });
  expect(result.state).toBe('unresolved');
  expect(result.observations.every((r) => r.verified === false)).toBe(true);
});
it('cancellation stops further reads and cannot claim verified after one match', async () => {
  const controller = new AbortController();
  let reads = 0;
  const result = await pollPreparedReadback({
    read: async () => {
      reads++;
      controller.abort();
      return { kind: 'success', response: {}, requestId: 'one' };
    },
    check: () => ({ verified: true, mismatchedPaths: [] }),
    signal: controller.signal,
    pause: async () => {},
    delaysMs: [0, 1, 1],
  });
  expect(reads).toBe(1);
  expect(result.state).toBe('unresolved');
});
