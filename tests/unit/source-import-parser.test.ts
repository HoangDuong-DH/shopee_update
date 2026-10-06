import { Worker } from 'node:worker_threads';
import { importNext } from '../../apps/worker/src/imports.js';
import { once } from 'node:events';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { zipSync, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import {
  parseSourceIsolated,
  MAX_IMPORT_RESULT_BYTES,
  safeImportError,
} from '../../apps/worker/src/source-parser.js';

it('terminates a genuinely spinning CPU thread while the main event loop stays responsive', async () => {
  const controller = new AbortController();
  let worker!: Worker;
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks++;
  }, 10);
  const timer = setTimeout(() => controller.abort(Error('SOURCE_IMPORT_TIMEOUT')), 150);
  const promise = parseSourceIsolated(
    new Uint8Array([1]),
    { kind: 'docx', filename: 'Spin.docx' },
    controller.signal,
    () => (worker = new Worker('while (true) {}', { eval: true, execArgv: [] })),
  );
  const exited = once(worker, 'exit');
  try {
    await expect(promise).rejects.toThrow('SOURCE_IMPORT_TIMEOUT');
    await exited;
    expect(worker.threadId).toBe(-1);
    expect(ticks).toBeGreaterThan(2);
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timer);
    await worker.terminate();
  }
});

it('terminates CPU work on lease cancellation and never returns a late result', async () => {
  const controller = new AbortController();
  let worker!: Worker;
  const running = parseSourceIsolated(
    new Uint8Array([1]),
    { kind: 'docx', filename: 'Cancelled.docx' },
    controller.signal,
    () => (worker = new Worker('while (true) {}', { eval: true, execArgv: [] })),
  );
  controller.abort(Error('IMPORT_LEASE_LOST'));
  await expect(running).rejects.toThrow('IMPORT_LEASE_LOST');
  expect(worker.threadId).toBe(-1);
});

it('rejects oversized IPC results without returning truncated content', async () => {
  const controller = new AbortController();
  const running = parseSourceIsolated(
    new Uint8Array([1]),
    { kind: 'docx', filename: 'Large.docx' },
    controller.signal,
    () =>
      new Worker(
        'const {parentPort,workerData}=require("node:worker_threads"); parentPort.postMessage({ok:true,json:"a".repeat(workerData)});',
        { eval: true, execArgv: [], workerData: MAX_IMPORT_RESULT_BYTES + 1 },
      ),
  );
  await expect(running).rejects.toThrow('SOURCE_IMPORT_RESULT_TOO_LARGE');
});

it('reads real XLSX, Word and PNG fixtures in the fixed parser entry', async () => {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(Error('SOURCE_IMPORT_TIMEOUT')), 10000);
  try {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Giá').addRows([
      ['SKU', 'Tên sản phẩm', 'Giá gốc'],
      ['FIXTURE-1', 'Sản phẩm fixture', 25000],
    ]);
    const workbook = new Uint8Array(await book.xlsx.writeBuffer());
    const parsed = (await parseSourceIsolated(
      workbook,
      { kind: 'xlsx', filename: 'Price.xlsx' },
      controller.signal,
    )) as any;
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.source.filename).toBe('Price.xlsx');
    const word = zipSync({
      'word/document.xml': strToU8(
        '<w:document><w:body><w:p><w:r><w:t>Fixture content</w:t></w:r></w:p></w:body></w:document>',
      ),
    });
    expect(
      await parseSourceIsolated(
        word,
        { kind: 'docx', filename: 'Content.docx' },
        controller.signal,
      ),
    ).toMatchObject({ paragraphs: ['Fixture content'] });
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    expect(
      await parseSourceIsolated(
        png,
        { kind: 'image', filename: 'Original.png' },
        controller.signal,
      ),
    ).toMatchObject({ width: 1, height: 1, mime: 'image/png' });
  } finally {
    clearTimeout(deadline);
  }
});

it('rejects invalid files safely and retains machine codes without paths or stack details', async () => {
  await expect(
    parseSourceIsolated(
      new Uint8Array([1, 2, 3]),
      { kind: 'xlsx', filename: 'Invalid.xlsx' },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(safeImportError(Error('SOURCE_FILE_TOO_LARGE'))).toBe('SOURCE_FILE_TOO_LARGE');
  expect(safeImportError(Error('BLOB_MISSING C:/private/customer.xlsx'))).not.toContain('private');
});

it('awaits termination before returning an import with a lost lease', async () => {
  let worker!: Worker;
  const repo = {
    claimImport: async () => ({
      id: 'fixture',
      sha256: 'a'.repeat(64),
      filename: 'Spin.docx',
      kind: 'docx',
      bytes: 1,
      leaseEpoch: 1,
      workerId: 'fixture-worker',
    }),
    renewImportLease: async () => false,
    finishClaimedImport: () => {
      throw Error('STALE_COMPLETION_FORBIDDEN');
    },
  };
  expect(
    await importNext(repo as any, { read: async () => new Uint8Array([1]) } as any, {
      renewEveryMs: 100,
      createParserWorker: () =>
        (worker = new Worker('while (true) {}', { eval: true, execArgv: [] })),
    }),
  ).toBe(true);
  // The import driver must wait for the worker's cancellation cleanup, not just race its result.
  expect(worker.threadId).toBe(-1);
});

it('records CPU timeout only after stopping the isolated thread, then permits the next source', async () => {
  let worker!: Worker;
  const completed: unknown[][] = [];
  const repo = {
    claimImport: async () => ({
      id: 'fixture',
      sha256: 'a'.repeat(64),
      filename: 'Spin.docx',
      kind: 'docx',
      bytes: 1,
      leaseEpoch: 1,
      workerId: 'fixture-worker',
    }),
    renewImportLease: async () => true,
    finishClaimedImport: async (...args: unknown[]) => {
      expect(worker.threadId).toBe(-1);
      completed.push(args);
      return true;
    },
  };
  expect(
    await importNext(repo as any, { read: async () => new Uint8Array([1]) } as any, {
      timeoutMs: 150,
      createParserWorker: () =>
        (worker = new Worker('while (true) {}', { eval: true, execArgv: [] })),
    }),
  ).toBe(true);
  expect(completed[0][1]).toBeNull();
  expect(completed[0][2]).toBe('SOURCE_IMPORT_TIMEOUT');
  expect(
    await importNext(repo as any, { read: async () => new Uint8Array([1]) } as any, {
      parse: async () => ({ paragraphs: ['next fixture'] }),
    }),
  ).toBe(true);
  expect(completed).toHaveLength(2);
  expect(completed[1][2]).toBe('');
});

it('does not load the Excel parser when the fixed worker reads Word or image fixtures', async ({
  task,
}) => {
  const checkout = resolve(dirname(task.file!.filepath), '../..');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('SOURCE_IMPORT_TIMEOUT')), 10000);
  const guard = pathToFileURL(
    resolve(checkout, 'tests/unit/fixtures/source-import-dependency-guard.mjs'),
  ).href;
  const createWorker = (data: any) =>
    new Worker(pathToFileURL(resolve(checkout, 'apps/worker/src/source-parser-worker.ts')), {
      workerData: data,
      execArgv: [
        '--conditions=development',
        '--import',
        pathToFileURL(createRequire(resolve(checkout, 'apps/worker/package.json')).resolve('tsx'))
          .href,
        '--import',
        guard,
      ],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
  try {
    const word = zipSync({
      'word/document.xml': strToU8(
        '<w:document><w:body><w:p><w:r><w:t>Fixture content</w:t></w:r></w:p></w:body></w:document>',
      ),
    });
    expect(
      await parseSourceIsolated(
        word,
        { kind: 'docx', filename: 'Content.docx' },
        controller.signal,
        createWorker,
      ),
    ).toMatchObject({ paragraphs: ['Fixture content'] });
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    expect(
      await parseSourceIsolated(
        png,
        { kind: 'image', filename: 'Original.png' },
        controller.signal,
        createWorker,
      ),
    ).toMatchObject({ width: 1, height: 1 });
  } finally {
    clearTimeout(timer);
  }
});
