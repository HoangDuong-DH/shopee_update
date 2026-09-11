import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { InputBatchRecord, InputBatchState } from '@shopee/domain';
import {
  createInputBatchSaver,
  verifyReselectedFiles,
  type BatchSaveRequest,
} from '../../apps/web/src/input-batch-client.js';
import { RequestError } from '../../apps/web/src/api.js';

const state = (name: string): InputBatchState => ({
  version: 1,
  name,
  mode: 'single_listing',
  files: [],
  priceSelection: null,
  visual: {},
  wordPaths: {},
  wordRule: null,
  productKeys: {},
});
const result = (body: BatchSaveRequest): InputBatchRecord => ({
  id: body.id,
  revision: body.expectedRevision + 1,
  state: body.state,
  createdAt: '',
  updatedAt: '',
});
afterEach(() => vi.useRealTimers());

describe('input batch persistence', () => {
  it('coalesces rapid edits and serializes a later selection behind an in-flight save', async () => {
    vi.useFakeTimers();
    const calls: BatchSaveRequest[] = [];
    let resolveFirst!: (record: InputBatchRecord) => void;
    const saver = createInputBatchSaver({
      id: 'one',
      delay: 10,
      request: async (body) => {
        calls.push(body);
        if (calls.length === 1)
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        return result(body);
      },
    });
    saver.schedule(state('first'));
    saver.schedule(state('second'));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.map((body) => body.state.name)).toEqual(['second']);
    saver.schedule(state('third'));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
    resolveFirst(result(calls[0]));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((body) => [body.expectedRevision, body.state.name])).toEqual([
      [0, 'second'],
      [1, 'third'],
    ]);
    saver.dispose();
  });

  it('replays the exact uncertain request before persisting newer choices', async () => {
    vi.useFakeTimers();
    const calls: BatchSaveRequest[] = [];
    const saved: string[] = [];
    const saver = createInputBatchSaver({
      id: 'one',
      delay: 10,
      request: async (body) => {
        calls.push(structuredClone(body));
        if (calls.length === 1) throw new RequestError('connection lost', 'NETWORK_UNAVAILABLE');
        return result(body);
      },
      onSaved: (record) => saved.push(record.state.name),
    });
    saver.schedule(state('source A'));
    await vi.advanceTimersByTimeAsync(10);
    saver.schedule(state('source B'));
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    saver.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toMatchObject({ expectedRevision: 1, state: { name: 'source B' } });
    expect(saved).toEqual(['source A', 'source B']);
    saver.dispose();
  });

  it('stops after a conflict and preserves the pending choices instead of overwriting', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const request = vi.fn(async () => {
      throw new RequestError('conflict', 'INPUT_BATCH_REVISION_CONFLICT', 409);
    });
    const saver = createInputBatchSaver({
      id: 'one',
      delay: 10,
      request,
      onStatus: (value) => statuses.push(value),
    });
    saver.schedule(state('local'));
    await vi.advanceTimersByTimeAsync(10);
    saver.schedule(state('more local changes'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe('conflict');
    saver.dispose();
  });

  it('sends corrected input at the same revision after a definitive validation rejection', async () => {
    vi.useFakeTimers();
    const calls: BatchSaveRequest[] = [];
    const saver = createInputBatchSaver({
      id: 'one',
      delay: 10,
      request: async (body) => {
        calls.push(structuredClone(body));
        if (calls.length === 1) throw new RequestError('invalid input', 'INVALID_INPUT', 400);
        return result(body);
      },
    });
    saver.schedule(state('invalid'));
    await vi.advanceTimersByTimeAsync(10);
    saver.schedule(state('corrected'));
    saver.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((body) => [body.expectedRevision, body.state.name])).toEqual([
      [0, 'invalid'],
      [0, 'corrected'],
    ]);
    saver.dispose();
  });

  it('does not rewrite a restored batch merely because object property order differs', async () => {
    vi.useFakeTimers();
    const initial = result({ id: 'one', expectedRevision: 3, state: state('same') });
    const request = vi.fn(async (body: BatchSaveRequest) => result(body));
    const saver = createInputBatchSaver({ id: 'one', initial, request, delay: 10 });
    saver.schedule(Object.fromEntries(Object.entries(initial.state).reverse()) as InputBatchState);
    await vi.advanceTimersByTimeAsync(100);
    expect(request).not.toHaveBeenCalled();
    saver.dispose();
  });

  it('does not save a queued change after the screen is disposed', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (body: BatchSaveRequest) => result(body));
    const saver = createInputBatchSaver({ id: 'one', request, delay: 10 });
    saver.schedule(state('leave'));
    saver.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('resuming original folder files', () => {
  function file(content: string, path: string) {
    const value = new File([content], path.split('/').at(-1)!);
    Object.defineProperty(value, 'webkitRelativePath', { value: path });
    return value;
  }
  it('requires exact relative paths, sizes and original bytes before reusing folder choices', async () => {
    const descriptors = [
      {
        relativePath: 'one/a.png',
        name: 'a.png',
        size: 3,
        sha256: createHash('sha256').update('abc').digest('hex'),
      },
    ];
    expect(await verifyReselectedFiles(descriptors, [file('abc', 'one/a.png')])).toBe(true);
    expect(await verifyReselectedFiles(descriptors, [file('xyz', 'one/a.png')])).toBe(false);
    expect(await verifyReselectedFiles(descriptors, [file('abc', 'other/a.png')])).toBe(false);
    expect(await verifyReselectedFiles(descriptors, [file('abcd', 'one/a.png')])).toBe(false);
    expect(await verifyReselectedFiles(descriptors, [])).toBe(false);
  });
});
