import { Worker } from 'node:worker_threads';
import type { ImportRecord } from '@shopee/persistence';

export const MAX_IMPORT_RESULT_BYTES = 16 * 1024 * 1024;
export type SourceJob = Pick<ImportRecord, 'kind' | 'filename'>;
export type SourceParser = (
  bytes: Uint8Array,
  job: SourceJob,
  signal: AbortSignal,
) => Promise<unknown>;
export function sourceByteLimit(kind: string): number {
  if (kind === 'image') return 32 * 1024 * 1024;
  if (kind === 'xlsx' || kind === 'docx') return 64 * 1024 * 1024;
  throw Error('UNSUPPORTED_SOURCE_KIND');
}
const GENERIC_ERROR = 'Không đọc được tệp. Kiểm tra tệp nguồn và định dạng; bản gốc vẫn được giữ.';
export function safeImportError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  // Only bounded machine codes can cross the parser boundary; never include stacks or file paths.
  return /^(?:ASSET_|UNSUPPORTED_|OFFICE_|ARCHIVE_|XML_|BLOB_|INVALID_|SOURCE_|WORD_)[A-Z0-9_]{1,100}$/.test(
    code,
  )
    ? code
    : GENERIC_ERROR;
}
export type ParserWorkerFactory = (data: { bytes: Uint8Array; job: SourceJob }) => Worker;
const createParserWorker: ParserWorkerFactory = (data) => {
  const source = import.meta.url.endsWith('.ts');
  return new Worker(
    new URL(source ? './source-parser-worker.ts' : './source-parser-worker.js', import.meta.url),
    {
      workerData: data,
      // Do not inherit test-runner flags, inspector endpoints, or a selectable worker entry.
      execArgv: source ? ['--conditions=development', '--import', import.meta.resolve('tsx')] : [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    },
  );
};

export function parseSourceIsolated(
  bytes: Uint8Array,
  job: SourceJob,
  signal: AbortSignal,
  createWorker: ParserWorkerFactory = createParserWorker,
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (!bytes.byteLength || bytes.byteLength > sourceByteLimit(job.kind))
    return Promise.reject(
      Error(bytes.byteLength ? 'SOURCE_FILE_TOO_LARGE' : 'INVALID_SOURCE_BYTES'),
    );
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = createWorker({ bytes, job: { kind: job.kind, filename: job.filename } });
    } catch {
      reject(Error('SOURCE_PARSER_START_FAILED'));
      return;
    }
    let settled = false;
    const finish = (error: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      // Termination is awaited even on success; no parser thread lives beyond its import.
      void worker.terminate().then(
        () => {
          if (error) reject(error);
          else resolve(result);
        },
        () => reject(Error('SOURCE_PARSER_CLEANUP_FAILED')),
      );
    };
    const abort = () => finish(signal.reason ?? Error('SOURCE_IMPORT_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    worker.once('error', (error: Error & { code?: string }) =>
      finish(
        Error(
          error.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? 'SOURCE_PARSER_MEMORY_LIMIT'
            : 'SOURCE_PARSER_FAILED',
        ),
      ),
    );
    worker.once('exit', () => {
      if (!settled) finish(Error('SOURCE_PARSER_EXITED'));
    });
    worker.once('message', (message: unknown) => {
      if (signal.aborted) {
        abort();
        return;
      }
      if (!message || typeof message !== 'object') {
        finish(Error('SOURCE_PARSER_PROTOCOL_INVALID'));
        return;
      }
      const reply = message as { ok?: unknown; json?: unknown; error?: unknown };
      if (reply.ok === false && typeof reply.error === 'string') {
        finish(Error(safeImportError(Error(reply.error))));
        return;
      }
      if (reply.ok !== true || typeof reply.json !== 'string') {
        finish(Error('SOURCE_PARSER_PROTOCOL_INVALID'));
        return;
      }
      if (Buffer.byteLength(reply.json, 'utf8') > MAX_IMPORT_RESULT_BYTES) {
        finish(Error('SOURCE_IMPORT_RESULT_TOO_LARGE'));
        return;
      }
      try {
        finish(null, JSON.parse(reply.json));
      } catch {
        finish(Error('SOURCE_PARSER_PROTOCOL_INVALID'));
      }
    });
    // Covers abort occurring during worker construction before the listener was installed.
    if (signal.aborted) abort();
  });
}
