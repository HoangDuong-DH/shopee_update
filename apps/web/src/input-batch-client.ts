import type { InputBatchRecord, InputBatchState } from '@shopee/domain';
import { api, RequestError } from './api.js';

export type BatchSaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';
export type BatchSaveRequest = { id: string; expectedRevision: number; state: InputBatchState };
function stateKey(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stateKey).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + stateKey(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/** One immutable request remains retryable until its outcome is known. Later edits never overtake it. */
export function createInputBatchSaver(options: {
  id: string;
  initial?: InputBatchRecord;
  delay?: number;
  request?: (body: BatchSaveRequest) => Promise<InputBatchRecord>;
  onStatus?: (status: BatchSaveStatus, error?: unknown) => void;
  onSaved?: (record: InputBatchRecord) => void;
}) {
  let revision = options.initial?.revision ?? 0;
  let saved = options.initial ? stateKey(options.initial.state) : '';
  let desired: InputBatchState | undefined;
  let attempted: BatchSaveRequest | undefined;
  let running = false;
  let halted = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request =
    options.request ??
    ((body) =>
      api<InputBatchRecord>('/v1/input-batches', {
        method: 'POST',
        body: JSON.stringify(body),
      }));
  const status = (value: BatchSaveStatus, error?: unknown) => {
    if (!disposed) options.onStatus?.(value, error);
  };
  async function drain() {
    if (running || halted || disposed) return;
    if (!attempted && (!desired || stateKey(desired) === saved)) {
      status('saved');
      return;
    }
    attempted ??= { id: options.id, expectedRevision: revision, state: desired! };
    running = true;
    status('saving');
    try {
      const record = await request(attempted);
      revision = record.revision;
      saved = stateKey(record.state);
      attempted = undefined;
      if (!disposed) options.onSaved?.(record);
    } catch (error) {
      // A validation rejection confirms no write occurred; corrected input can reuse this revision.
      // Network/5xx outcomes remain uncertain and must replay the original request first.
      if (error instanceof RequestError && (error.status === 400 || error.status === 422)) {
        attempted = undefined;
      }
      halted = true;
      status(error instanceof RequestError && error.status === 409 ? 'conflict' : 'error', error);
    } finally {
      running = false;
    }
    if (!halted && !disposed) await drain();
  }
  return {
    schedule(state: InputBatchState) {
      desired = structuredClone(state);
      if (timer) clearTimeout(timer);
      if (halted || disposed) return;
      if (!attempted && stateKey(desired) === saved) {
        status('saved');
        return;
      }
      if (!running) status('pending');
      timer = setTimeout(() => void drain(), options.delay ?? 450);
    },
    retry() {
      if (disposed || running) return;
      halted = false;
      void drain();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export async function verifyReselectedFiles(
  previous: InputBatchState['files'],
  selected: File[],
): Promise<boolean> {
  if (previous.length !== selected.length) return false;
  const byPath = new Map(selected.map((file) => [file.webkitRelativePath || file.name, file]));
  if (byPath.size !== selected.length) return false;
  for (const descriptor of previous) {
    const file = byPath.get(descriptor.relativePath);
    if (!file || file.name !== descriptor.name || file.size !== descriptor.size) return false;
    if (descriptor.sha256) {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const hex = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('');
      if (hex !== descriptor.sha256) return false;
    }
  }
  return true;
}
