import type { BlobStore, Repository } from '@shopee/persistence';
import {
  parseSourceIsolated,
  sourceByteLimit,
  safeImportError,
  type SourceParser,
  type ParserWorkerFactory,
} from './source-parser.js';

export type ImportOptions = {
  workerId?: string;
  renewEveryMs?: number;
  timeoutMs?: number;
  /** Trusted in-process dependency injection for tests; production uses the isolated parser. */
  parse?: SourceParser;
  /** Trusted worker construction injection; no filename or executable is accepted from source data. */
  createParserWorker?: ParserWorkerFactory;
};
const DEFAULT_TIMEOUT_MS = 120_000;

function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function importNext(
  repo: Repository,
  blobs: BlobStore,
  options: ImportOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const renewEveryMs = options.renewEveryMs ?? 60_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > DEFAULT_TIMEOUT_MS ||
    !Number.isSafeInteger(renewEveryMs) ||
    renewEveryMs <= 0 ||
    renewEveryMs > 60_000
  )
    throw Error('INVALID_IMPORT_LIMITS');
  const job = await repo.claimImport(options.workerId ?? `source-import:${process.pid}`);
  if (!job) return false;
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  const deadline = setTimeout(() => controller.abort(Error('SOURCE_IMPORT_TIMEOUT')), timeoutMs);
  let leaseLost = false,
    renewalFailed = false,
    renewal: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (renewal || controller.signal.aborted) return;
    const renewalController = new AbortController();
    const renewalDeadline = setTimeout(
      () => renewalController.abort(Error('IMPORT_LEASE_RENEWAL_FAILED')),
      5_000,
    );
    const signal = AbortSignal.any([controller.signal, renewalController.signal]);
    renewal = bounded(() => repo.renewImportLease(job), signal)
      .then((owned) => {
        if (!owned) {
          leaseLost = true;
          controller.abort(Error('IMPORT_LEASE_LOST'));
        }
      })
      .catch(() => {
        leaseLost = true;
        renewalFailed = !controller.signal.aborted;
        controller.abort(Error('IMPORT_LEASE_RENEWAL_FAILED'));
      })
      .finally(() => {
        clearTimeout(renewalDeadline);
        renewal = null;
      });
  }, renewEveryMs);
  timer.unref();
  let body: unknown = null,
    message = '';
  try {
    const maxBytes = sourceByteLimit(job.kind);
    if (!Number.isSafeInteger(job.bytes) || job.bytes <= 0) throw Error('INVALID_SOURCE_SIZE');
    if (job.bytes > maxBytes) throw Error('SOURCE_FILE_TOO_LARGE');
    if (!job.filename || job.filename.length > 1024) throw Error('INVALID_SOURCE_FILENAME');
    const bytes = await bounded(
      () => blobs.read(job.sha256, { signal: controller.signal, maxBytes }),
      controller.signal,
    );
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw Error('INVALID_SOURCE_BYTES');
    if (bytes.byteLength > maxBytes) throw Error('SOURCE_FILE_TOO_LARGE');
    body = options.parse
      ? await bounded(() => options.parse!(bytes, job, controller.signal), controller.signal)
      : await parseSourceIsolated(bytes, job, controller.signal, options.createParserWorker);
    if (performance.now() >= expiresAt) controller.abort(Error('SOURCE_IMPORT_TIMEOUT'));
    controller.signal.throwIfAborted();
  } catch (e) {
    body = null;
    message = safeImportError(e);
  } finally {
    clearInterval(timer);
    // A renewal is bounded independently and shares cancellation with the overall deadline.
    await renewal;
    clearTimeout(deadline);
  }
  if (renewalFailed) throw Error('IMPORT_LEASE_RENEWAL_FAILED');
  // A stale parser/read result never bypasses the claim epoch, identity and database expiry fence.
  if (!leaseLost) await repo.finishClaimedImport(job, body, message);
  return true;
}
