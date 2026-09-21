export type PreparedReadbackObservation = {
  attempt: number;
  observedAt: string;
  verified: boolean;
  requestId?: string;
  code?: string;
  mismatchedPaths: string[];
  snapshot?: unknown;
};
/** Read-only bounded reconciliation. A transient successful acknowledgement is not an input here.
 * Callers must finish/abort the issuing adapter first; this never retries a mutation. */
export async function pollPreparedReadback<T>(options: {
  read: (
    signal?: AbortSignal,
  ) => Promise<
    | { kind: 'success'; response: T; requestId: string }
    | { kind: 'unknown' | 'rejected'; code: string }
  >;
  check: (snapshot: T) => { verified: boolean; mismatchedPaths: string[] };
  signal?: AbortSignal;
  delaysMs?: number[];
  pause?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  readTimeoutMs?: number;
}): Promise<{ state: 'verified' | 'unresolved'; observations: PreparedReadbackObservation[] }> {
  const delays = options.delaysMs ?? [0, 1000, 3000, 5000, 8000],
    observations: PreparedReadbackObservation[] = [];
  if (
    delays.length < 2 ||
    delays.length > 10 ||
    delays.some((ms) => !Number.isSafeInteger(ms) || ms < 0 || ms > 10000) ||
    delays.reduce((sum, n) => sum + n, 0) > 30000
  )
    throw new Error('PREPARED_READBACK_BUDGET_INVALID');
  const timeoutMs = options.timeoutMs ?? 30000,
    readTimeoutMs = options.readTimeoutMs ?? 12000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isSafeInteger(readTimeoutMs) ||
    readTimeoutMs < 1 ||
    readTimeoutMs > 30000
  )
    throw new Error('PREPARED_READBACK_BUDGET_INVALID');
  const overall = new AbortController(),
    deadline = Date.now() + timeoutMs;
  const cancel = () => overall.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const overallTimer = setTimeout(cancel, timeoutMs);
  const expired = () => overall.signal.aborted || Date.now() >= deadline;
  const abortable = async <R>(promise: Promise<R>, signal: AbortSignal): Promise<R> => {
    let listener: () => void = () => {};
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          listener = () => reject(new Error('PREPARED_READBACK_TIMEOUT'));
          signal.addEventListener('abort', listener, { once: true });
          if (signal.aborted) listener();
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', listener);
    }
  };
  const pause = async (ms: number) => {
    if (options.pause)
      return abortable(
        Promise.resolve().then(() => options.pause!(ms)),
        overall.signal,
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await abortable(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
        overall.signal,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  let consecutive = 0;
  try {
    for (const [attempt, delay] of delays.entries()) {
      if (expired()) break;
      try {
        if (delay) await pause(delay);
      } catch {
        break;
      }
      if (expired()) break;
      const row: PreparedReadbackObservation = {
        attempt: attempt + 1,
        observedAt: new Date().toISOString(),
        verified: false,
        mismatchedPaths: [],
      };
      const readController = new AbortController(),
        cancelRead = () => readController.abort();
      overall.signal.addEventListener('abort', cancelRead, { once: true });
      const readTimer = setTimeout(cancelRead, readTimeoutMs);
      try {
        const result = await abortable(
          Promise.resolve().then(() => options.read(readController.signal)),
          readController.signal,
        );
        if (expired() || readController.signal.aborted)
          throw new Error('PREPARED_READBACK_TIMEOUT');
        if (result.kind === 'success') {
          row.requestId = result.requestId;
          row.snapshot = structuredClone(result.response);
          const checked = options.check(structuredClone(result.response));
          row.verified =
            checked.verified === true &&
            Array.isArray(checked.mismatchedPaths) &&
            checked.mismatchedPaths.length === 0;
          row.mismatchedPaths = checked.mismatchedPaths;
        } else
          row.code = /^[A-Za-z0-9_.-]{1,100}$/.test(result.code)
            ? result.code
            : 'PREPARED_READBACK_FAILED';
      } catch {
        row.verified = false;
        row.code = readController.signal.aborted
          ? 'PREPARED_READBACK_TIMEOUT'
          : 'PREPARED_READBACK_INVALID';
      } finally {
        clearTimeout(readTimer);
        overall.signal.removeEventListener('abort', cancelRead);
      }
      observations.push(row);
      consecutive = row.verified ? consecutive + 1 : 0;
      if (consecutive >= 2 && !expired()) return { state: 'verified', observations };
    }
    return { state: 'unresolved', observations };
  } finally {
    clearTimeout(overallTimer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
