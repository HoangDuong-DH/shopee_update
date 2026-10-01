import {createApp} from '../../apps/api/src/app.js';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import {
  Pool,
  Repository,
  BlobStore,
  InputLibraryRepository,
  migrate,
} from '../../packages/persistence/src/index.js';
import { InputService } from '../../apps/api/src/input-service.js';
import { ContentWorkbookService } from '../../apps/api/src/content-workbook-service.js';
import { saveAssembledProduct } from '../../apps/api/src/product-service.js';
import type { ContentMapping } from '../../packages/domain/src/content-workbook.js';
import type { InputBatchState } from '../../packages/domain/src/input-library.js';
const schema = 'test_content_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
let root: string, blobs: BlobStore, contents: ContentWorkbookService;
let app: Awaited<ReturnType<typeof createApp>>;
const headers={'x-app-client':'internal-workspace',origin:'http://localhost:5173'};
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), 'shopee-content-fixture-'));
  blobs = new BlobStore(root);
  contents = new ContentWorkbookService(repo, blobs);
  app = await createApp(repo,blobs,['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (root) await rm(root, { recursive: true, force: true });
});
it('saves Excel+images+real price row with batch CAS, restores sources, retries once without duplicate, blocks stale/faked content', async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Bài đăng').addRows([
    ['STT', 'Tiêu đề', 'Mở đầu', 'Nội dung'],
    [222, 'Xịt mũ bảo hiểm', 'Mở đầu', 'Nội dung đúng'],
  ]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer()),
    sha = await blobs.put(bytes),
    content = await repo.createImport({
      filename: 'content.xlsx',
      kind: 'xlsx',
      bytes: bytes.length,
      sha256: sha,
    });
  await repo.finishImport(content.id, {}, 'Không phải bảng giá');
  const mapping: ContentMapping = {
    importId: content.id,
    sha256: sha,
    sheet: 'Bài đăng',
    headerRow: 1,
    columns: { stt: 'A', title: 'B', headline: 'C', body: 'D' },
    headers: { stt: 'STT', title: 'Tiêu đề', headline: 'Mở đầu', body: 'Nội dung' },
  };
  const inspected=await app.inject({method:'GET',url:'/v1/content-workbooks/'+content.id,headers});
  expect(inspected.statusCode).toBe(200);expect(inspected.json().priceParserStatus).toBe('failed');
  const parsed=await app.inject({method:'POST',url:'/v1/content-workbooks/rows',headers,payload:mapping});
  expect(parsed.statusCode).toBe(201);expect(parsed.json().rows[0].title).toBe('Xịt mũ bảo hiểm');
  const badHeader=await app.inject({method:'POST',url:'/v1/content-workbooks/rows',headers,payload:{...mapping,headers:{...mapping.headers,title:'Wrong'}}});
  expect(badHeader.statusCode).toBe(409);expect(badHeader.json().code).toBe('CONTENT_HEADER_CHANGED');expect(badHeader.json().message).toContain('cột');
  const missing=await app.inject({method:'GET',url:'/v1/content-workbooks/'+randomUUID(),headers});expect(missing.statusCode).toBe(404);
  const badSheet=await app.inject({method:'POST',url:'/v1/content-workbooks/rows',headers,payload:{...mapping,sheet:'Wrong'}});expect(badSheet.statusCode).toBe(404);
  const selected = await contents.resolve({mapping,row:2,stt:'222'});
  const priceSha = await blobs.put(Buffer.from('price fixture')),
    price = await repo.createImport({
      filename: 'price.xlsx',
      kind: 'xlsx',
      bytes: 13,
      sha256: priceSha,
    });
  const fact = (value: string) => ({
    value,
    confirmed: true,
    sources: [
      {
        kind: 'product_file' as const,
        fileSha256: priceSha,
        locator: 'Giá!A2',
        observedAt: content.createdAt,
      },
    ],
  });
  await repo.finishImport(price.id, {
    rows: [
      {
        key: 'row-a',
        sheet: 'Giá',
        row: 2,
        headerRow: 1,
        priceProfile: null,
        sku: fact('REAL-SKU-300'),
        name: fact('Xịt 300ml'),
        originalPrice: fact('99000'),
        issues: [],
      },
    ],
    sheets: [{ name: 'Giá', rowCount: 2, importedRows: 1, headerRows: [1] }],
    issues: [],
  });
  const imageSha = await blobs.put(Buffer.from('image fixture')),
    image = await repo.createImport({
      filename: 'bia.jpg',
      kind: 'image',
      bytes: 13,
      sha256: imageSha,
    });
  await repo.finishImport(image.id, {
    key: image.id,
    sha256: imageSha,
    bytes: 13,
    mime: 'image/jpeg',
    width: 1000,
    height: 1000,
    source: {
      kind: 'product_file',
      fileSha256: imageSha,
      locator: 'bia.jpg',
      observedAt: content.createdAt,
    },
  });
  const group = 'Lo/222 Mũ',
    productKey = 'content-' + randomUUID(),
    id = randomUUID();
  const state: InputBatchState = {
    version: 1,
    name: 'Lô Excel',
    mode: 'parent_with_listing_folders',
    files: [
      {
        name: 'bia.jpg',
        relativePath: group + '/bia.jpg',
        size: 13,
        importId: image.id,
        sha256: imageSha,
      },
    ],
    priceSelection: { importId: price.id, sheet: 'Giá', priceProfile: null },
    visual: {},
    wordPaths: {},
    wordRule: null,
    productKeys: { [group]: productKey },
    contentSelections: { [group]: selected },
  };
  const service = new InputService(repo, contents);
  const batchReply=await app.inject({method:'POST',url:'/v1/input-batches',headers,payload:{id,expectedRevision:0,state}});
  expect(batchReply.statusCode).toBe(201);const batch=batchReply.json();
  const reopened = await new InputLibraryRepository(pool).get(id);
  expect(reopened!.imports.map((i) => i.id)).toContain(content.id);
  expect(reopened!.state.contentSelections![group]!.binding).toEqual(selected.binding);
  const input = {
    productKey,
    expectedRevision: 0,
    folderBinding: { batchId: id, revision: batch.revision, groupKey: group },
    contentBinding: selected.binding,
    title: selected.title,
    headline: selected.headline,
    body: selected.body,
    coverId: image.id,
    galleryIds: [image.id],
    descriptionImageIds: [image.id],
    tierNames: ['Dung tích'],
    variants: [{ importId: price.id, rowKey: 'row-a', optionLabels: ['300ml'], imageId: image.id }],
  };
  const reply=await app.inject({method:'POST',url:'/v1/products',headers,payload:input});
  expect(reply.statusCode).toBe(201);const draft=reply.json();
  expect(draft.title.sources[0]!.locator).toBe('Bài đăng!B2');
  expect(draft.variants[0]!.sku.value).toBe('REAL-SKU-300');
  expect(await saveAssembledProduct(repo, input, blobs)).toEqual(draft);
  expect(Number((await pool.query('SELECT count(*) n FROM products')).rows[0].n)).toBe(1);
  await expect(saveAssembledProduct(repo, { ...input, title: 'Faked' }, blobs)).rejects.toThrow(
    'CONTENT_SELECTION_MISMATCH',
  );
  await service.save({
    id,
    expectedRevision: batch.revision,
    state: { ...state, name: 'Lô đổi tên' },
  });
  await expect(saveAssembledProduct(repo, input, blobs)).rejects.toThrow(
    'FOLDER_SOURCE_BINDING_STALE',
  );
  const altered = structuredClone(state);
  altered.contentSelections![group]!.body = 'Fake body';
  await expect(service.save({ id, expectedRevision: 2, state: altered })).rejects.toThrow(
    'CONTENT_SELECTION_MISMATCH',
  );
});
