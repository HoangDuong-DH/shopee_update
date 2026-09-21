import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  type Fact,
  type ListingDraft,
  type WordImport,
  type WorkbookImport,
} from '@shopee/domain';
import { Pool, Repository, BlobStore, migrate, type ImportRecord } from '@shopee/persistence';
import { importNext } from '../../apps/worker/src/imports.js';
import { assembleProduct } from '../../apps/api/src/product-service.js';
import { ProductionPreparationService } from '../../apps/api/src/production-preparation-service.js';
import {
  loadProductionBatchSource,
  productionBatchPass1Root,
} from '../../apps/api/src/production-batch-source.js';
import type { ProductionDraftSourceInput } from '../../apps/api/src/production-draft-source.js';

const schema = 'test_draft_preparation_' + randomUUID().replaceAll('-', '');
const database = new URL(process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.port !== '5442')
  throw Error('This acceptance requires isolated schemas on local PostgreSQL 5442.');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
let root: string, blobs: BlobStore;
const noNetwork = vi.fn(async () => {
  throw Error('No outbound network is allowed in this acceptance.');
});
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  root = await mkdtemp(resolve(productionBatchPass1Root, 'draft-source-acceptance-'));
  blobs = new BlobStore(root);
  vi.stubGlobal('fetch', noNetwork);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
async function importFile(bytes: Uint8Array, filename: string, kind: ImportRecord['kind']) {
  const sha256 = await blobs.put(bytes);
  const record = await repo.createImport({ sha256, filename, kind, bytes: bytes.length });
  while (await importNext(repo, blobs)) {
    /* Run the actual local import worker. */
  }
  const ready = await repo.getImport(record.id);
  expect(ready?.status).toBe('ready');
  return ready!;
}
async function sources(count: number) {
  const run = randomUUID(),
    book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('Giá đại lý');
  sheet.addRow([
    'SKU',
    'TÊN SẢN PHẨM',
    'GIÁ GỐC',
    'GIÁ BÁN',
    'CÂN NẶNG KHAI BÁO (G)',
    'THƯƠNG HIỆU',
  ]);
  for (let i = 0; i < count; i++)
    for (let v = 0; v < 2; v++)
      sheet.addRow([
        `${run}-${i}-${v}`,
        `Sản phẩm nguồn ${i} / ${v}`,
        100000 + i * 1000 + v * 500,
        90000,
        v ? 322.3 : 130.9,
        'Nhãn nguồn',
      ]);
  const pricebook = await importFile(
    Buffer.from(await book.xlsx.writeBuffer()),
    'Bảng giá chung.xlsx',
    'xlsx',
  );
  const rows = (pricebook.body as WorkbookImport).rows;
  const drafts: ListingDraft[] = [],
    entries: ProductionDraftSourceInput[] = [];
  for (let i = 0; i < count; i++) {
    const paragraphs = [
      ` Bộ nguồn ${run}-${i} `,
      `Mở đầu ${i}`,
      '',
      'Giữ nguyên nội dung đã chuẩn bị.',
      'Không tự thay đặc tính.',
    ];
    const document = zipSync({
      'word/document.xml': strToU8(
        `<w:document xmlns:w="urn:fixture"><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
      ),
    });
    const word = await importFile(document, `${run}/${i}/Nội dung.docx`, 'docx');
    const read = (word.body as WordImport).paragraphs;
    expect(read).toEqual(paragraphs);
    const images: ImportRecord[] = [];
    for (const [index, width, height] of [
      [0, 120, 120],
      [1, 90, 120],
      [2, 120, 120],
    ] as const) {
      const png = await sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: (20 + i * 10) % 256, g: 50 + index * 30, b: 120 },
        },
      })
        .png()
        .toBuffer();
      images.push(await importFile(png, `${run}/${i}/${index}.png`, 'image'));
    }
    const selected = rows.slice(i * 2, i * 2 + 2);
    const draft = await assembleProduct(repo, {
      expectedRevision: 0,
      title: read[0]!,
      headline: read[1]!,
      body: read.slice(2).join('\n'),
      coverId: images[0]!.id,
      galleryIds: [images[1]!.id],
      descriptionImageIds: [],
      tierNames: [' Quy cách '],
      variants: selected.map((row, v) => ({
        importId: pricebook.id,
        rowKey: row.key,
        optionLabels: [v ? '300 ml' : '100 ml'],
        imageId: images[2]!.id,
      })),
    });
    const fact = <T>(value: T): Fact<T> => ({
      value,
      confirmed: true,
      sources: [
        {
          kind: 'user_decision',
          fileSha256: word.sha256,
          locator: 'Explicit fixture facts; not Shopee metadata',
          observedAt: new Date().toISOString(),
        },
      ],
    });
    draft.categoryId = fact(String(10 + (i % 3)));
    draft.brandId = fact('20');
    draft.attributes = { [String(100 + (i % 3))]: fact([String(200 + (i % 3))]) };
    draft.logistics = { '50': fact(true) };
    await repo.saveProduct(draft, 0);
    drafts.push(draft);
    entries.push({
      productKey: draft.productKey,
      sourceRevision: 1,
      priceSelection: { importId: pricebook.id, sheet: 'Giá đại lý', priceProfile: null },
      stocks: Object.fromEntries(selected.map((row, v) => [row.sku.value, v ? 7 : 0])),
      choices: {
        weightGrams: 322.3,
        dimensionCm: { length: 12, width: 12, height: 28 },
        condition: 'NEW',
        preOrder: { is_pre_order: false },
        stockLocation: {
          referenceItemId: '1234',
          expectedLocationBySku: Object.fromEntries(
            selected.map((row) => [row.sku.value, 'FIXTURE-WAREHOUSE']),
          ),
          writeLocationBySku: Object.fromEntries(selected.map((row) => [row.sku.value, null])),
        },
      },
    });
  }
  const register = vi.fn(async (input: { manifestPath: string; expectedSha256: string }) => {
    const loaded = await loadProductionBatchSource(input.manifestPath, input.expectedSha256);
    return { batchId: loaded.value.batchId, manifestSha256: loaded.sha256 };
  });
  const service = () =>
    new ProductionPreparationService(repo, blobs, {
      root,
      register,
      verifyStock: async () => ({ expectedLocationId: 'FIXTURE-WAREHOUSE', writeLocationId: null }),
    });
  return { entries, drafts, register, service, pricebook };
}

it('imports eighty original Word/image source sets and a shared pricebook through the real compiler into twenty v2 manifest groups', async () => {
  const startedAt = new Date().toISOString(),
    began = performance.now();
  const f = await sources(80),
    hashes = f.drafts.map(digest),
    input = { id: randomUUID(), entries: f.entries };
  const importedAt = performance.now();
  const preview = await f.service().preview(input),
    previewedAt = performance.now();
  expect(preview.readyCount).toBe(80);
  expect(preview.blockedCount).toBe(0);
  expect(f.register).not.toHaveBeenCalled();
  expect(await f.service().preview(input)).toEqual(preview);
  const receipt = await f
    .service()
    .register(input.id, { expectedFingerprint: preview.fingerprint });
  const registeredAt = performance.now();
  expect(receipt.batches).toHaveLength(20);
  expect(f.register).toHaveBeenCalledTimes(20);
  const manifests = await Promise.all(
    f.register.mock.calls.map(
      async ([call]) =>
        (await loadProductionBatchSource(call.manifestPath, call.expectedSha256)).value,
    ),
  );
  expect(manifests.map((m) => m.listings.length)).toEqual(Array.from({ length: 20 }, () => 4));
  const listings = manifests.flatMap((m) => m.listings);
  expect(new Set(listings.map((l) => l.document.categoryId)).size).toBe(3);
  for (const [i, listing] of listings.entries()) {
    const before = f.drafts[i]!;
    expect(listing.document.title).toBe(before.title.value);
    expect(listing.document.description).toEqual(before.description);
    expect(
      listing.document.models.map((m) => [
        m.sku,
        m.optionLabels,
        m.originalPrice,
        m.stock,
        m.weightGrams,
      ]),
    ).toEqual(
      before.variants.map((v, index) => [
        v.sku.value,
        v.optionLabels,
        v.originalPrice.value,
        index ? 7 : 0,
        Number(v.declaredWeightGrams!.value),
      ]),
    );
    expect(listing.document.cover.sha256).toBe(
      before.assets.find((a) => a.key === before.coverKey)!.sha256,
    );
    expect(listing.document.gallery.map((a) => a.sha256)).toEqual(
      before.galleryKeys.map((key) => before.assets.find((a) => a.key === key)!.sha256),
    );
    expect(listing.brandName).toBe('Nhãn nguồn');
    expect(listing.priceProof.every((p) => p.priceSet === '(Không phân bộ)')).toBe(true);
    expect(digest(await repo.getProduct(before.productKey, 1))).toBe(hashes[i]);
  }
  const exported = JSON.parse(await readFile(f.register.mock.calls[0]![0].manifestPath, 'utf8'));
  expect(exported.sourceFiles.filter((s: any) => s.role === 'pricebook')).toHaveLength(1);
  expect(
    (await f.service().register(input.id, { expectedFingerprint: preview.fingerprint })).batches,
  ).toEqual(receipt.batches);
  expect(f.register).toHaveBeenCalledTimes(20);
  expect(noNetwork).not.toHaveBeenCalled();
  await writeFile(
    resolve(root, 'source-preparation-acceptance.json'),
    JSON.stringify(
      {
        startedAt,
        completedAt: new Date().toISOString(),
        preparationId: input.id,
        scope:
          'Real local parser/worker/PostgreSQL/compiler/v2 manifest; stock evidence and registry receipt fixture; no Shopee calls or browser folder picker.',
        observed: {
          wordFiles: 80,
          imageFiles: 240,
          sharedPricebooks: 1,
          savedListings: 80,
          skuCount: 160,
          fixtureCategoryIds: 3,
          readyCount: 80,
          blockedCount: 0,
          manifestGroups: 20,
          outboundHttpCalls: 0,
          sourceRevisionsUnchanged: true,
          stockValues: [0, 7],
        },
        durationsMs: {
          importAndSave: Math.round(importedAt - began),
          compileAndFreeze: Math.round(previewedAt - importedAt),
          verifyAndRegister: Math.round(registeredAt - previewedAt),
          totalWithAudit: Math.round(performance.now() - began),
        },
        manifestReceipts: receipt.batches,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
}, 120000);

it('keeps incomplete saved facts and unsupported size-chart sources blocked while preparing a complete sibling', async () => {
  const f = await sources(3);
  const unconfirmed = structuredClone(f.drafts[1]!);
  unconfirmed.revision = 2;
  unconfirmed.variants[0]!.originalPrice.confirmed = false;
  await repo.saveProduct(unconfirmed, 1);
  f.entries[1]!.sourceRevision = 2;
  const chart = structuredClone(f.drafts[2]!);
  chart.revision = 2;
  chart.sizeChartKey = chart.coverKey;
  await repo.saveProduct(chart, 1);
  f.entries[2]!.sourceRevision = 2;
  const input = { id: randomUUID(), entries: f.entries },
    preview = await f.service().preview(input);
  expect([preview.readyCount, preview.blockedCount]).toEqual([1, 2]);
  expect(preview.entries[1].issues.some((i: any) => i.code === 'UNCONFIRMED_FACT')).toBe(true);
  expect(preview.entries[2].issues.some((i: any) => i.field === 'sizeChartKey')).toBe(true);
  await f.service().register(input.id, { expectedFingerprint: preview.fingerprint });
  expect(f.register).toHaveBeenCalledTimes(1);
  const loaded = await loadProductionBatchSource(
    f.register.mock.calls[0]![0].manifestPath,
    f.register.mock.calls[0]![0].expectedSha256,
  );
  expect(loaded.value.listings.map((l) => l.sourceIdentity)).toEqual([f.drafts[0]!.productKey]);
  expect(noNetwork).not.toHaveBeenCalled();
}, 30000);

it('rejects a changed saved source revision after preview while retaining the exact preview and sending no registration', async () => {
  const f = await sources(1),
    input = { id: randomUUID(), entries: f.entries },
    preview = await f.service().preview(input);
  const changed = structuredClone(f.drafts[0]!);
  changed.revision = 2;
  changed.title.value += ' new revision';
  changed.sourceSelection!.title = changed.title.value;
  await repo.saveProduct(changed, 1);
  await expect(
    f.service().register(input.id, { expectedFingerprint: preview.fingerprint }),
  ).rejects.toThrow('PREPARATION_SOURCE_CHANGED');
  expect(await f.service().get(input.id)).toEqual(preview);
  expect(f.register).not.toHaveBeenCalled();
  expect(noNetwork).not.toHaveBeenCalled();
}, 30000);
