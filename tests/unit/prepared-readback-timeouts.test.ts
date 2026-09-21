import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pollPreparedReadback } from '../../packages/shopee/src/prepared-readback.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
type Result = Awaited<ReturnType<typeof pollPreparedReadback>>;
const match = () => ({ verified: true, mismatchedPaths: [] });

it('returns unresolved by its total wall-clock deadline when a read never settles', async () => {
  let result: Result | undefined;
  const options = {
    read: () => new Promise<never>(() => {}),
    check: match,
    delaysMs: [0, 0],
    timeoutMs: 25,
    readTimeoutMs: 100,
  };
  void pollPreparedReadback(options).then((value) => {
    result = value;
  });
  await vi.advanceTimersByTimeAsync(25);
  expect(result?.state).toBe('unresolved');
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds each read independently even when an adapter ignores the supplied abort signal', async () => {
  let result: Result | undefined;
  const signals: AbortSignal[] = [];
  const options = {
    read: (signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<never>(() => {});
    },
    check: match,
    delaysMs: [0, 0],
    timeoutMs: 100,
    readTimeoutMs: 5,
  };
  void pollPreparedReadback(options).then((value) => {
    result = value;
  });
  await vi.advanceTimersByTimeAsync(11);
  expect(result?.state).toBe('unresolved');
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('external cancellation settles immediately while an uncooperative read is in flight', async () => {
  const controller = new AbortController();
  let result: Result | undefined;
  void pollPreparedReadback({
    read: () => new Promise<never>(() => {}),
    check: match,
    signal: controller.signal,
    delaysMs: [0, 0],
    timeoutMs: 100,
    readTimeoutMs: 50,
  }).then((value) => {
    result = value;
  });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result?.state).toBe('unresolved');
  expect(vi.getTimerCount()).toBe(0);
});

it('external cancellation interrupts the delay instead of waiting to start another read', async () => {
  const controller = new AbortController();
  let result: Result | undefined;
  const read = vi.fn(async () => ({
    kind: 'success' as const,
    response: {},
    requestId: 'read-delay',
  }));
  void pollPreparedReadback({
    read,
    check: match,
    signal: controller.signal,
    delaysMs: [0, 1000],
    timeoutMs: 2000,
  }).then((value) => {
    result = value;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result?.state).toBe('unresolved');
  expect(read).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not adopt a second matching response that arrives after the deadline', async () => {
  let result: Result | undefined;
  let resolveLate!: (value: { kind: 'success'; response: {}; requestId: string }) => void;
  let reads = 0;
  const check = vi.fn(match);
  void pollPreparedReadback<Record<string, never>>({
    read: () =>
      ++reads === 1
        ? Promise.resolve({ kind: 'success' as const, response: {}, requestId: 'read-first' })
        : new Promise((resolve) => {
            resolveLate = resolve;
          }),
    check,
    delaysMs: [0, 0],
    timeoutMs: 10,
    readTimeoutMs: 100,
  }).then((value) => {
    result = value;
  });
  await vi.advanceTimersByTimeAsync(10);
  expect(result?.state).toBe('unresolved');
  const before = structuredClone(result);
  resolveLate({ kind: 'success', response: {}, requestId: 'read-too-late' });
  await vi.advanceTimersByTimeAsync(0);
  expect(result).toEqual(before);
  expect(check).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('cleans deadline timers after two in-budget matching reads', async () => {
  const result = await pollPreparedReadback({
    read: async () => ({ kind: 'success', response: {}, requestId: 'read-valid' }),
    check: match,
    delaysMs: [0, 0],
    timeoutMs: 100,
    readTimeoutMs: 20,
  });
  expect(result.state).toBe('verified');
  expect(vi.getTimerCount()).toBe(0);
});
