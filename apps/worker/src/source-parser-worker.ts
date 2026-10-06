import { parentPort, workerData } from 'node:worker_threads';

import {
  MAX_IMPORT_RESULT_BYTES,
  safeImportError,
  sourceByteLimit,
  type SourceJob,
} from './source-parser.js';

if (!parentPort) throw Error('SOURCE_PARSER_THREAD_REQUIRED');
const port = parentPort;
try {
  const { bytes, job } = workerData as { bytes: Uint8Array; job: SourceJob };
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw Error('INVALID_SOURCE_BYTES');
  if (bytes.byteLength > sourceByteLimit(job.kind)) throw Error('SOURCE_FILE_TOO_LARGE');
  const body =
    job.kind === 'xlsx'
      ? await (await import('@shopee/domain/source/kini')).readKini(bytes, job.filename)
      : job.kind === 'docx'
        ? await (await import('@shopee/domain/source/word')).readWord(bytes, job.filename)
        : (
            await (
              await import('@shopee/domain/source/assets')
            ).inspectAssets([{ key: job.filename, bytes }])
          )[0];
  const json = JSON.stringify(body);
  if (typeof json !== 'string') throw Error('SOURCE_PARSER_PROTOCOL_INVALID');
  if (Buffer.byteLength(json, 'utf8') > MAX_IMPORT_RESULT_BYTES)
    throw Error('SOURCE_IMPORT_RESULT_TOO_LARGE');
  port.postMessage({ ok: true, json });
} catch (error) {
  port.postMessage({ ok: false, error: safeImportError(error) });
}
