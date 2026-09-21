import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { Pool, Repository, BlobStore, InputLibraryRepository, migrate } from '@shopee/persistence';
import type { InputBatchState } from '@shopee/domain';
import { PreparedBatchService } from '../../apps/api/src/prepared-batch-service.js';
import { importNext } from '../../apps/worker/src/imports.js';
import {
  createBusinessBatchFixture,
  type BusinessBatchFixture,
} from '../fixtures/business-batch-fixtures.js';
import { BusinessPlatform } from '../fixtures/business-platform.js';

const schema = 'test_prepared_source_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
// A nested pool acquisition would fail this acceptance with connection timeout.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema}`,
  max: 1,
  connectionTimeoutMillis: 1500,
});
const repo = new Repository(pool),
  library = new InputLibraryRepository(pool);
let fixture: BusinessBatchFixture,
  blobs: BlobStore,
  service: PreparedBatchService,
  gateway: BusinessPlatform;
let batchId: string, workbookId: string, initialState: InputBatchState;
async function upload(bytes: Uint8Array, filename: string, kind: 'xlsx' | 'image' | 'docx') {
  const sha256 = await blobs.put(bytes);
  const record = await repo.createImport({ sha256, filename, kind, bytes: bytes.length });
  while (await importNext(repo, blobs)) {
    /* use actual source readers */
  }
  expect((await repo.getImport(record.id))!.status).toBe('ready');
  return record;
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  fixture = await createBusinessBatchFixture({ count: 2 });
  blobs = new BlobStore(join(fixture.root, 'recovery-blobs'));
  const files: InputBatchState['files'] = [];
  for (const file of fixture.files) {
    const record = await upload(await readFile(file.path), file.filename, file.kind);
    if (file.kind === 'xlsx') workbookId = record.id;
    else
      files.push({
        relativePath: file.relativePath,
        name: file.filename,
        size: file.bytes,
        importId: record.id,
        sha256: record.sha256,
      });
  }
  initialState = {
    version: 1,
    name: 'Source recovery fixture',
    mode: 'parent_with_listing_folders',
    files,
    priceSelection: {
      importId: workbookId,
      sheet: fixture.shops[0].priceSheet,
      priceProfile: null,
    },
    visual: {},
    wordPaths: {},
    wordRule: null,
    productKeys: Object.fromEntries(
      fixture.listings.map((row) => [row.groupKey, 'qa-recovery-' + randomUUID()]),
    ),
  };
  batchId = randomUUID();
  await library.save(batchId, 0, initialState);
  for (const shop of fixture.shops)
    await pool.query(
      "INSERT INTO connections(id,environment,partner_id,shop_id,name,state) VALUES($1,'sandbox',$2,$3,$4,'connected')",
      [randomUUID(), shop.ownerId, shop.shopId, shop.name],
    );
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE prepared_source_versions,prepared_source_batches,prepared_execution_bindings,prepared_execution_jobs,prepared_execution_batches,work_orders,products CASCADE',
  );
  await pool.query('UPDATE connections SET revision=1');
  const current = (await library.get(batchId))!;
  await library.save(batchId, current.revision, initialState);
  gateway = new BusinessPlatform();
  service = new PreparedBatchService(repo, blobs, gateway);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function input() {
  return {
    id: randomUUID(),
    inputBatchId: batchId,
    inputBatchRevision: (await library.get(batchId))!.revision,
    workbookImportId: workbookId,
    operation: 'create' as const,
    fieldMask: [],
  };
}
it('four concurrent retries finish with a single-connection pool and create no duplicate local work', async () => {
  const request = await input(),
    preview = await service.preview(request);
  const receipts = await Promise.all(
    Array.from({ length: 4 }, () =>
      service.submit(preview.id, { fingerprint: preview.fingerprint }),
    ),
  );
  expect(receipts.every((row) => row.state === 'queued')).toBe(true);
  expect(await repo.listProducts()).toHaveLength(2);
  expect(Number((await pool.query('SELECT count(*) FROM work_orders')).rows[0].count)).toBe(2);
  expect(
    Number((await pool.query('SELECT count(*) FROM prepared_execution_jobs')).rows[0].count),
  ).toBe(2);
  expect(gateway.snapshot().items).toHaveLength(0);
}, 15000);
it('a source-receipt insert failure cannot leave an orphan owner/source reservation', async () => {
  const request = await input(),
    query = pool.query.bind(pool);
  const spy = vi.spyOn(pool, 'query').mockImplementation(((...args: any[]) => {
    if (String(args[0]).startsWith('INSERT INTO prepared_source_batches'))
      throw new Error('INJECT_SOURCE_STORAGE_FAILURE');
    return (query as any)(...args);
  }) as any);
  await expect(service.preview(request)).rejects.toThrow('INJECT_SOURCE_STORAGE_FAILURE');
  spy.mockRestore();
  expect(
    Number((await pool.query('SELECT count(*) FROM prepared_execution_bindings')).rows[0].count),
  ).toBe(0);
  await pool.query('UPDATE connections SET revision=2');
  expect((await service.preview(request)).state).toBe('prepared');
});
it('a crash after reservation stays publicly recoverable after credential renewal and can be cancelled', async () => {
  const request = await input(),
    query = pool.query.bind(pool);
  const spy = vi.spyOn(pool, 'query').mockImplementation(((...args: any[]) => {
    if (String(args[0]).startsWith('UPDATE prepared_source_batches SET body'))
      throw new Error('INJECT_PHASE_FAILURE');
    return (query as any)(...args);
  }) as any);
  await expect(service.preview(request)).rejects.toThrow('INJECT_PHASE_FAILURE');
  spy.mockRestore();
  const receipt = await service.get(request.id);
  expect(receipt.items).toHaveLength(2);
  expect(receipt.items.every((row: any) => row.state === 'prepared')).toBe(true);
  await pool.query('UPDATE connections SET revision=2');
  expect((await service.preview(request)).fingerprint).toBe(receipt.fingerprint);
  for (const item of receipt.items) await service.control(item.id, 'cancel');
  expect((await service.preview({ ...request, id: randomUUID() })).state).toBe('prepared');
  expect(gateway.snapshot().items).toHaveLength(0);
});
it('an input edit during local source saving blocks enqueue inside its transaction', async () => {
  const request = await input(),
    preview = await service.preview(request),
    save = repo.saveProduct.bind(repo);
  const spy = vi.spyOn(repo, 'saveProduct').mockImplementationOnce(async (...args) => {
    const saved = await save(...args),
      current = (await library.get(batchId))!;
    await library.save(batchId, current.revision, {
      ...current.state,
      name: 'Changed during submission',
    });
    return saved;
  });
  await expect(service.submit(preview.id, { fingerprint: preview.fingerprint })).rejects.toThrow(
    'PREPARED_INPUT_REVISION_CHANGED',
  );
  spy.mockRestore();
  expect(
    (await service.execution!.get(preview.id)).jobs.every((row) => row.state === 'prepared'),
  ).toBe(true);
  expect(gateway.snapshot().items).toHaveLength(0);
});
it('a fractional dimension is isolated to its source row and no whole-batch envelope exception escapes', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await readFile(fixture.workbookPath)) as unknown as ExcelJS.Buffer);
  workbook.getWorksheet('Điều phối listing')!.getCell('K2').value = 1.5;
  const changed = await upload(
    Buffer.from(await workbook.xlsx.writeBuffer()),
    'fractional.xlsx',
    'xlsx',
  );
  const preview = await service.preview({ ...(await input()), workbookImportId: changed.id });
  expect(preview.entries).toHaveLength(2);
  expect(preview.entries.filter((row: any) => row.issues.length)).toHaveLength(1);
  expect(preview.entries[0].issues[0].code).toBe('PREPARED_SOURCE_ENVELOPE');
  expect(preview.entries[1].issues).toEqual([]);
});
