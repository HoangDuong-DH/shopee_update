import 'dotenv/config';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  Pool,
  Repository,
  BlobStore,
  migrate,
  WorkOrderRepository,
} from '../../packages/persistence/src/index.js';
import { ImportPatchService } from '../../apps/api/src/import-patch-service.js';
import { inspectAssets, type PatchSelection } from '../../packages/domain/src/index.js';
import { fixtureDraft } from '../helpers/fixtures.js';
import { createApp } from '../../apps/api/src/app.js';
const schema = 'test_' + randomUUID().replaceAll('-', ''),
  admin = new Pool({ connectionString: process.env.DATABASE_URL }),
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},public`,
  });
const repo = new Repository(pool),
  orders = new WorkOrderRepository(pool);
let root: string,
  blobs: BlobStore,
  service: ImportPatchService,
  price: string,
  stock: string,
  image: string,
  word: string,
  orderId: string,
  otherOrder: string;
async function file(
  filename: string,
  kind: 'xlsx' | 'image' | 'docx',
  bytes: Buffer,
  body?: unknown,
) {
  const sha256 = await blobs.put(bytes);
  const record = await repo.createImport({ filename, kind, bytes: bytes.length, sha256 });
  if (body) await repo.finishImport(record.id, body);
  return record.id;
}
async function excel(rows: unknown[][], filename = 'update.xlsx') {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Dữ liệu').addRows(rows);
  return file(filename, 'xlsx', Buffer.from(await book.xlsx.writeBuffer()));
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), 'shopee-patch-'));
  blobs = new BlobStore(root);
  service = new ImportPatchService(repo, blobs);
  const draft = fixtureDraft();
  await repo.saveProduct(draft, 0);
  for (let i = 0; i < 2; i++) {
    const connection = randomUUID(),
      id = randomUUID();
    await pool.query(
      "INSERT INTO connections(id,environment,partner_id,shop_id,name,state) VALUES($1,'production','123',$2,$3,'connected')",
      [connection, String(100 + i), 'Shop ' + i],
    );
    await orders.save(id, 0, {
      productKey: 'test',
      sourceRevision: 1,
      connectionId: connection,
      operation: 'update',
      itemId: String(300 + i),
      fieldMask: ['title'],
      stocks: {},
    });
    if (i === 0) orderId = id;
    else otherOrder = id;
  }
  price = await excel([
    ['SKU', 'GIÁ GỐC'],
    ['A', 200],
  ]);
  stock = await excel(
    [
      ['SKU', 'TỒN ĐĂNG BÁN'],
      ['A', 0],
    ],
    'stock.xlsx',
  );
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  image = await file(
    'cover.png',
    'image',
    bytes,
    (await inspectAssets([{ key: 'cover.png', bytes }]))[0],
  );
  word = await file('text.docx', 'docx', Buffer.from('test-word-fixture'), {
    paragraphs: ['Header', '  Supplied new title  ', 'Body', ' First line ', 'Second  line\nthird'],
    source: {},
  });
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (root?.startsWith(join(tmpdir(), 'shopee-patch-')))
    await rm(root, { recursive: true, force: true });
});
const selection = (content: PatchSelection['contents'] = []): PatchSelection => ({
  name: 'Imported updates',
  workOrders: [{ id: orderId, revision: 1 }],
  fileRefs: [],
  workbooks: [],
  contents: content,
});
async function workbookSelection(id: string, field: 'price' | 'stock') {
  const workbook = await service.workbook(id);
  return {
    ...selection(),
    fileRefs: [{ importId: id }],
    workbooks: [
      {
        importId: id,
        sheet: 'Dữ liệu',
        blockKey: workbook.blocks[0].key,
        workOrderIds: [orderId],
        fields: [field],
      },
    ],
  } as PatchSelection;
}
it('derives price from original sparse Excel, scopes one shop, and leaves source and work untouched', async () => {
  const before = await repo.getProduct('test'),
    order = await orders.get(orderId);
  const preview = await service.preview(await workbookSelection(price, 'price'));
  expect(preview.operations).toHaveLength(1);
  expect(preview.operations[0]).toMatchObject({
    field: 'price',
    before: '100',
    after: '200',
    workOrderId: orderId,
    state: 'changed',
  });
  expect(preview.remoteRead).toBe(false);
  expect(preview.targets[0].shopId).toBe('100');
  expect(await repo.getProduct('test')).toEqual(before);
  expect(await orders.get(orderId)).toEqual(order);
  expect(await repo.listJobs()).toEqual([]);
});
it('stores zero stock as a scoped proposal, not a new product or an applied stock receipt', async () => {
  const input = await workbookSelection(stock, 'stock'),
    preview = await service.preview(input);
  expect(preview.operations[0]).toMatchObject({ field: 'stock', before: null, after: 0 });
  const saved = await service.save({
    id: randomUUID(),
    selection: input,
    previewFingerprint: preview.fingerprint,
    selectedOperationIds: preview.operations.map((op) => op.id),
  });
  expect(saved.receipt.state).toBe('prepared');
  expect(await service.get(saved.receipt.id)).toEqual(saved.receipt);
  expect((await pool.query('SELECT count(*)::int n FROM stock_instructions')).rows[0].n).toBe(0);
});
it('accepts cover-only import and preserves all unselected content without assembling a full listing', async () => {
  const input = selection([{ workOrderId: orderId, coverImportId: image }]);
  input.fileRefs = [{ importId: image, relativePath: 'Listing/cover.png' }];
  const preview = await service.preview(input);
  expect(preview.operations.map((op) => op.field)).toEqual(['cover']);
  expect(preview.operations[0].after).toMatchObject({ importId: image });
  expect(preview.operations[0].sources[0]).toMatchObject({ importId: image, locator: 'cover' });
});
it('derives exact selected Word paragraphs including whitespace and newlines', async () => {
  const input = selection([
    {
      workOrderId: orderId,
      word: {
        importId: word,
        titleParagraphs: [1],
        descriptionParagraphs: [3, 4],
        separator: '\n\n',
      },
    },
  ]);
  input.fileRefs = [{ importId: word }];
  const preview = await service.preview(input);
  expect(preview.operations.find((op) => op.field === 'title')?.after).toBe(
    '  Supplied new title  ',
  );
  expect(preview.operations.find((op) => op.field === 'description')?.after).toEqual([
    { type: 'text', text: ' First line \n\nSecond  line\nthird' },
  ]);
});
it('rejects stale references, wrong source kind, and values supplied outside imported selection', async () => {
  await expect(
    service.preview({ ...selection(), workOrders: [{ id: orderId, revision: 999 }] }),
  ).rejects.toThrow('PATCH_TARGET_CHANGED');
  await expect(
    service.preview(selection([{ workOrderId: orderId, coverImportId: price }])),
  ).rejects.toThrow('PATCH_SOURCE_KIND');
  await expect(service.preview({ ...selection(), price: 17 })).rejects.toThrow();
});
it('makes concurrent saves and Save As semantic duplicates refer to one immutable receipt', async () => {
  const input = await workbookSelection(price, 'price'),
    preview = await service.preview(input),
    request = {
      id: randomUUID(),
      selection: input,
      previewFingerprint: preview.fingerprint,
      selectedOperationIds: preview.operations.map((op) => op.id),
    };
  const results = await Promise.all([service.save(request), service.save(request)]);
  expect(results[0].receipt.id).toBe(results[1].receipt.id);
  const copy = await excel(
      [
        ['SKU', 'GIÁ GỐC'],
        ['A', 200],
      ],
      'different-name.xlsx',
    ),
    copyInput = await workbookSelection(copy, 'price'),
    copyPreview = await service.preview(copyInput);
  const duplicate = await service.save({
    ...request,
    id: randomUUID(),
    selection: copyInput,
    previewFingerprint: copyPreview.fingerprint,
    selectedOperationIds: copyPreview.operations.map((op) => op.id),
  });
  expect(duplicate.reused).toBe(true);
  expect(duplicate.receipt.id).toBe(results[0].receipt.id);
  await expect(service.save({ ...request, selectedOperationIds: [] })).rejects.toThrow(
    'PATCH_SAVE_CONFLICT',
  );
  await expect(
    pool.query("UPDATE import_patch_receipts SET name='changed' WHERE id=$1", [
      duplicate.receipt.id,
    ]),
  ).rejects.toThrow('IMMUTABLE_REVISION');
});
it('blocks conflicting imported values for a target while allowing unaffected operations to be prepared', async () => {
  const input = await workbookSelection(price, 'price'),
    other = await excel(
      [
        ['SKU', 'GIÁ GỐC'],
        ['A', 300],
      ],
      'other.xlsx',
    ),
    second = await workbookSelection(other, 'price');
  input.workbooks.push(...second.workbooks);
  input.fileRefs.push(...second.fileRefs);
  const preview = await service.preview(input);
  expect(preview.operations.every((op) => op.state === 'blocked')).toBe(true);
  await expect(
    service.save({
      id: randomUUID(),
      selection: input,
      previewFingerprint: preview.fingerprint,
      selectedOperationIds: preview.operations.map((op) => op.id),
    }),
  ).rejects.toThrow('PATCH_SELECTION_BLOCKED');
});
it('does not broadcast a shared SKU to multiple listings in one shop implicitly', async () => {
  const first = await orders.get(orderId);
  const id = randomUUID();
  await orders.save(id, 0, { ...first!.config, itemId: '999' });
  const input = await workbookSelection(price, 'price');
  input.workOrders.push({ id, revision: 1 });
  input.workbooks[0].workOrderIds.push(id);
  const preview = await service.preview(input);
  expect(preview.operations).toEqual([]);
  expect(preview.issues.some((issue) => issue.code === 'PATCH_TARGET_AMBIGUOUS')).toBe(true);
});
it('rejects save after target changes without inserting a partial receipt', async () => {
  const input = selection([{ workOrderId: otherOrder, coverImportId: image }]);
  input.workOrders = [{ id: otherOrder, revision: 1 }];
  input.fileRefs = [{ importId: image }];
  const preview = await service.preview(input),
    old = await orders.get(otherOrder);
  await orders.save(otherOrder, 1, { ...old!.config, fieldMask: ['description'] });
  const id = randomUUID();
  await expect(
    service.save({
      id,
      selection: input,
      previewFingerprint: preview.fingerprint,
      selectedOperationIds: preview.operations.map((op) => op.id),
    }),
  ).rejects.toThrow('PATCH_TARGET_CHANGED');
  await expect(service.get(id)).rejects.toThrow('PATCH_NOT_FOUND');
});
it('serves the complete local HTTP preview/save/reload path without dispatching a platform job', async () => {
  const app = await createApp(repo, blobs, ['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
  const call = (options: any) => app.getHttpAdapter().getInstance().inject(options),
    headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
  try {
    const context = await call({ method: 'GET', url: '/v1/import-patches/context' });
    expect(context.statusCode).toBe(200);
    expect(context.json().execution).toEqual({
      writesEnabled: false,
      comparisonBasis: 'saved_source',
    });
    const parsed = await call({ method: 'GET', url: '/v1/import-patches/workbooks/' + price });
    expect(parsed.statusCode).toBe(200);
    expect(parsed.json().rows[0].values.price.value).toBe('200');
    const input = selection([{ workOrderId: orderId, coverImportId: image }]);
    input.fileRefs = [{ importId: image }];
    const preview = await call({
      method: 'POST',
      url: '/v1/import-patches/preview',
      headers,
      payload: input,
    });
    expect(preview.statusCode).toBe(201);
    const saved = await call({
      method: 'POST',
      url: '/v1/import-patches',
      headers,
      payload: {
        id: randomUUID(),
        selection: input,
        previewFingerprint: preview.json().fingerprint,
        selectedOperationIds: preview.json().operations.map((op: any) => op.id),
      },
    });
    expect(saved.statusCode).toBe(201);
    const receipt = saved.json().receipt;
    const reopened = await call({ method: 'GET', url: '/v1/import-patches/' + receipt.id });
    expect(reopened.json()).toEqual(receipt);
    expect(
      (await call({ method: 'GET', url: '/v1/import-patches' }))
        .json()
        .some((row: any) => row.id === receipt.id),
    ).toBe(true);
    expect(
      (
        await call({
          method: 'POST',
          url: '/v1/import-patches/preview',
          headers,
          payload: { ...input, originalPrice: 17 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/v1/import-patches/preview',
          headers: { ...headers, origin: 'http://other.invalid' },
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call({
          method: 'POST',
          url: '/v1/import-patches/' + receipt.id + '/execute',
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(await repo.listJobs()).toEqual([]);
  } finally {
    await app.close();
  }
});
it('requires imported source membership and unique manifest paths without forbidding aliases of the same bytes', async () => {
  const input = selection([{ workOrderId: orderId, coverImportId: image }]);
  await expect(service.preview(input)).rejects.toThrow('PATCH_SOURCE_OUTSIDE_MANIFEST');
  input.fileRefs = [
    { importId: image, relativePath: 'Set/cover.png' },
    { importId: word, relativePath: 'Set/cover.png' },
  ];
  await expect(service.preview(input)).rejects.toThrow('PATCH_MANIFEST_INVALID');
  input.fileRefs = [{ importId: image }, { importId: image }];
  await expect(service.preview(input)).rejects.toThrow('PATCH_MANIFEST_INVALID');
  input.fileRefs = [
    { importId: image, relativePath: 'Set/cover.png' },
    { importId: image, relativePath: 'Other/cover.png' },
  ];
  expect((await service.preview(input)).operations).toHaveLength(1);
});
it('rejects missing or corrupted original media bytes rather than saving a false provenance receipt', async () => {
  const bytes = await sharp({ create: { width: 21, height: 20, channels: 3, background: 'blue' } })
      .png()
      .toBuffer(),
    id = await file(
      'broken.png',
      'image',
      bytes,
      (await inspectAssets([{ key: 'broken.png', bytes }]))[0],
    );
  const record = (await repo.getImport(id))!;
  await writeFile(
    join(root, 'blobs', record.sha256.slice(0, 2), record.sha256),
    Buffer.from('tampered'),
  );
  const input = selection([{ workOrderId: orderId, coverImportId: id }]);
  input.fileRefs = [{ importId: id }];
  await expect(service.preview(input)).rejects.toThrow('PATCH_SOURCE_INTEGRITY');
});
it('requires explicit placement for new Word with existing images, and preserves canonical images-only layout', async () => {
  const original = await repo.getProduct('test'),
    key = 'layout-' + randomUUID();
  const source = {
    ...original!,
    productKey: key,
    sourceSelection: {
      title: 'Old',
      headline: ' Old head ',
      body: ' Old body\n\nrest ',
      coverId: image,
      galleryIds: [image],
      descriptionImageIds: [image],
      tierNames: original!.tierNames,
      variants: [],
    },
    description: [
      { type: 'text' as const, text: ' Old head \n\n' },
      { type: 'image' as const, assetKey: image },
      { type: 'text' as const, text: '\n\n Old body\n\nrest ' },
    ],
  };
  await repo.saveProduct(source, 0);
  const existing = (await orders.get(orderId))!,
    id = randomUUID();
  await orders.save(id, 0, { ...existing.config, productKey: key, itemId: String(Date.now()) });
  const input = selection([
    { workOrderId: id, word: { importId: word, descriptionParagraphs: [3, 4], separator: '\n\n' } },
  ]);
  input.workOrders = [{ id, revision: 1 }];
  input.fileRefs = [{ importId: word }];
  const unresolved = await service.preview(input);
  expect(unresolved.operations[0].state).toBe('blocked');
  expect(
    unresolved.operations[0].issues.some(
      (issue) => issue.code === 'PATCH_DESCRIPTION_LAYOUT_REQUIRED',
    ),
  ).toBe(true);
  input.contents[0].descriptionLayout = 'images_after_first_paragraph';
  const explicit = await service.preview(input);
  expect(explicit.operations[0].after).toEqual([
    { type: 'text', text: ' First line \n\n' },
    { type: 'image', assetKey: image },
    { type: 'text', text: '\n\nSecond  line\nthird' },
  ]);
  input.contents = [
    { workOrderId: id, descriptionImages: { mode: 'replace', importIds: [image] } },
  ];
  input.fileRefs = [{ importId: image }];
  expect((await service.preview(input)).operations[0].after).toEqual(source.description);
});
it('resolves duplicate-save aliases and replays the original receipt even after the work changed', async () => {
  const base = (await orders.get(orderId))!,
    target = randomUUID();
  await orders.save(target, 0, { ...base.config, itemId: '901' });
  const input = selection([{ workOrderId: target, coverImportId: image }]);
  input.workOrders = [{ id: target, revision: 1 }];
  input.fileRefs = [{ importId: image }];
  const preview = await service.preview(input);
  const request = {
      id: randomUUID(),
      selection: input,
      previewFingerprint: preview.fingerprint,
      selectedOperationIds: preview.operations.map((op) => op.id),
    },
    first = await service.save(request),
    alias = randomUUID();
  const duplicate = await service.save({ ...request, id: alias });
  expect(duplicate.reused).toBe(true);
  expect((await service.get(alias)).id).toBe(first.receipt.id);
  await orders.save(target, 1, { ...base.config, itemId: '901', fieldMask: ['description'] });
  expect((await service.save(request)).receipt.id).toBe(first.receipt.id);
  expect((await service.save({ ...request, id: alias })).receipt.id).toBe(first.receipt.id);
});
