import { openWorkspaceTool } from './workspace-navigation.js';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import type { InputBatchDetail, PreparedField, PreparedRemote } from '@shopee/domain';
import {
  createBusinessBatchFixture,
  createBusinessBatchExceptionFixture,
  businessCoordinationSheet,
  type BusinessBatchFixture,
  type BusinessExceptionFixture,
  type BusinessListingFixture,
} from '../fixtures/business-batch-fixtures.js';
import { sha256, wordBytes } from './bulk-folder-fixtures.js';

let server: ChildProcess,
  baseURL: string,
  fixture: BusinessBatchFixture,
  exceptions: BusinessExceptionFixture;
let initialBatch: InputBatchDetail, workbookId: string, createRunId: string;
let exceptionPreview: any;
const outcomes: { title: string; status: TestInfo['status']; durationMs: number }[] = [];
const proof: Record<string, any> = {
  synthetic: true,
  liveEvidence: false,
  networkCalls: 0,
  scope:
    'Real browser/API/PostgreSQL/import worker/execution coordinator with independent stateful simulated remote',
  updates: [],
};
const browserErrors: string[] = [],
  outsideRequests: string[] = [];
test.describe.configure({ mode: 'serial', timeout: 360000 });

async function ipc(command: string, data: Record<string, unknown> = {}): Promise<any> {
  const requestId = randomUUID();
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      server.off('message', receive);
      fail(new Error('Fixture IPC timeout: ' + command));
    }, 25000);
    const receive = (message: any) => {
      if (message.requestId !== requestId) return;
      clearTimeout(timer);
      server.off('message', receive);
      done(message.snapshot ?? message);
    };
    server.on('message', receive);
    server.send({ command, requestId, ...data });
  });
}
test.beforeAll(async () => {
  fixture = await createBusinessBatchFixture();
  exceptions = await createBusinessBatchExceptionFixture();
  const options: ForkOptions & { windowsHide: boolean } = {
    execArgv: ['--conditions=development', '--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: resolve('apps/api/tsconfig.json'),
      PREPARED_BUSINESS_EVIDENCE_ROOT: fixture.root,
    },
  };
  server = fork(resolve('tests/e2e/prepared-business-server.mts'), [], options);
  baseURL = await new Promise((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error('Prepared business server did not start')),
      60000,
    );
    let ready = false;
    server.on('message', (message: any) => {
      if (message.ready) {
        ready = true;
        clearTimeout(timer);
        proof.schema = message.schema;
        done(message.baseURL);
      } else if (message.error) {
        clearTimeout(timer);
        fail(new Error(message.error));
      }
    });
    server.on('exit', (code, signal) => {
      if (!ready) {
        clearTimeout(timer);
        fail(new Error(`Server exited ${code}/${signal}`));
      }
    });
    server.stderr?.on('data', (data) => process.stderr.write(data));
  });
});
test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) outsideRequests.push(url.origin);
  });
});
test.afterEach(async ({}, info) => {
  outcomes.push({ title: info.title, status: info.status, durationMs: info.duration });
});
test.afterAll(async () => {
  if (!fixture) return;
  const report = {
    ...proof,
    outcomes,
    browserErrors,
    outsideRequests,
    sourceManifest: fixture.manifestPath,
    exceptionSourceManifest: exceptions?.manifestPath,
    finishedAt: new Date().toISOString(),
    limitation:
      'No Shopee or production evidence. Listing creates and updates ran against an explicitly injected stateful simulated remote.',
  };
  await writeFile(join(fixture.root, 'browser-acceptance.json'), JSON.stringify(report, null, 2));
  await writeFile(
    '.local/acceptance-20260914/prepared-business-latest.json',
    JSON.stringify({ evidenceRoot: fixture.root, ...report }, null, 2),
  );
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      server.kill();
      fail(new Error('Isolated cleanup timeout'));
    }, 25000);
    server.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? done() : fail(new Error('Cleanup failed'));
    });
    server.send('stop');
  });
});
async function get<T = any>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(baseURL + path);
  expect(response.ok(), path + ': ' + (await response.text())).toBe(true);
  return response.json();
}
async function post<T = any>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(baseURL + path, {
    headers: { Origin: baseURL, 'x-app-client': 'internal-workspace' },
    data,
  });
  expect(response.ok(), path + ': ' + (await response.text())).toBe(true);
  return response.json();
}
async function upload(page: Page, filename: string, bytes: Buffer) {
  const response = await page.request.post(baseURL + '/v1/imports', {
    headers: {
      Origin: baseURL,
      'x-app-client': 'internal-workspace',
      'x-file-name': encodeURIComponent(filename),
      'Content-Type': 'application/octet-stream',
    },
    data: bytes,
  });
  expect(response.ok(), await response.text()).toBe(true);
  const record = await response.json();
  await expect
    .poll(async () => (await get(page, '/v1/imports/' + record.id)).status, { timeout: 60000 })
    .toMatch(/ready|failed/);
  return get(page, '/v1/imports/' + record.id);
}
async function intake(page: Page, source: BusinessBatchFixture) {
  await page.goto(baseURL);
  await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }).click();
  await page.getByLabel('Tải bảng giá chung', { exact: true }).setInputFiles(source.workbookPath);
  await expect
    .poll(
      async () =>
        (await get(page, '/v1/imports')).find(
          (record: any) => record.sha256 === source.workbook.sha256,
        )?.status,
      { timeout: 60000 },
    )
    .toBe('ready');
  const records = await get(page, '/v1/imports');
  const priceId = records.find((record: any) => record.sha256 === source.workbook.sha256).id;
  await expect(
    page
      .getByRole('combobox', { name: 'Bảng giá chung', exact: true })
      .locator(`option[value="${priceId}"]`),
  ).toHaveCount(1, { timeout: 60000 });
  const priceSelect = page.getByRole('combobox', { name: 'Bảng giá chung', exact: true });
  // The upload selects its own ready workbook. Wait for that UI transition rather than
  // dispatching a second change while its read callback is still committing state.
  await expect(priceSelect).toHaveValue(priceId);
  await expect(page.getByRole('combobox', { name: 'Sheet chứa giá', exact: true })).toBeEnabled();
  await page
    .getByRole('combobox', { name: 'Sheet chứa giá', exact: true })
    .selectOption(source.shops[0].priceSheet);
  await page.getByRole('combobox', { name: 'Bộ giá áp dụng', exact: true }).selectOption('null');
  await page.getByRole('radio', { name: 'Mỗi thư mục con là một listing', exact: true }).check();
  await page.getByLabel('Chọn thư mục listing', { exact: true }).setInputFiles(source.directory);
  await expect(page.getByTestId('folder-row')).toHaveCount(source.listings.length);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu vào Kho đầu vào' })).toBeVisible({
    timeout: 240000,
  });
  const batches = await get(page, '/v1/input-batches');
  const batch = batches.find((batch: any) => batch.priceSelection?.importId === priceId);
  expect(batch).toBeTruthy();
  return {
    batch: await get<InputBatchDetail>(page, '/v1/input-batches/' + batch.id),
    workbookId: priceId,
  };
}
async function openPrepared(page: Page) {
  await page.goto(baseURL);
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Thực hiện theo lô', exact: true })).toBeVisible();
  await expect(page.getByText('MÔ PHỎNG · không gửi lên Shopee', { exact: true })).toBeVisible();
}
async function waitRun(page: Page, id: string) {
  let observed: any;
  await expect
    .poll(
      async () => {
        observed = await get(page, '/v1/prepared-batches/' + id);
        (proof.stateSamples ??= []).push({
          id,
          state: observed.state,
          counts: observed.counts,
          observedAt: new Date().toISOString(),
        });
        return (
          ['verified', 'unknown', 'blocked', 'cancelled'].includes(observed.state) &&
          observed.items.length > 0 &&
          observed.items.every((item: any) =>
            ['verified', 'unknown', 'blocked', 'cancelled'].includes(item.state),
          )
        );
      },
      { timeout: 180000 },
    )
    .toBe(true);
  return observed;
}
function fileHash(listing: BusinessListingFixture, filename: string) {
  const file = listing.files.find((file) => file.filename === filename);
  expect(file, filename).toBeTruthy();
  return file!.sha256;
}
function assertRemote(listing: BusinessListingFixture, remote: PreparedRemote, sourceKey: string) {
  const doc = remote.document;
  expect(doc.sourceKey).toBe(sourceKey);
  expect(doc.title).toBe(listing.title);
  expect(
    doc.description.map((block) =>
      block.type === 'text' ? block : { type: 'image', sha256: block.image.sha256 },
    ),
  ).toEqual(
    listing.expectedDescription.blocks.map((block) =>
      block.type === 'text' ? block : { type: 'image', sha256: fileHash(listing, block.path) },
    ),
  );
  expect(doc.cover.sha256).toBe(fileHash(listing, listing.media.coverPath));
  expect(doc.cover.width).toBe(doc.cover.height);
  expect(doc.gallery.map((image) => image.sha256)).toEqual(
    listing.media.galleryPaths.map((path) => fileHash(listing, path)),
  );
  expect(doc.gallery.every((image) => image.width * 4 === image.height * 3)).toBe(true);
  expect(doc.tierNames).toEqual(listing.tierNames);
  expect(
    doc.models.map((model) => ({
      sku: model.sku,
      optionLabels: model.optionLabels,
      tierIndex: model.tierIndex,
      originalPrice: model.originalPrice,
      stock: model.stock,
      image: model.image?.sha256,
    })),
  ).toEqual(
    listing.variants.map((variant) => ({
      sku: variant.sku,
      optionLabels: variant.optionLabels,
      tierIndex: variant.tierIndex,
      originalPrice: variant.originalPrice,
      stock: variant.stock,
      image: variant.imagePath ? fileHash(listing, variant.imagePath) : undefined,
    })),
  );
  expect(doc.categoryId).toBe(listing.categoryId);
  expect(doc.brandId).toBe(listing.brandId);
  expect(doc.attributes).toEqual(
    Object.fromEntries(
      listing.attributes.map((attribute) => [attribute.attributeId, [attribute.valueId]]),
    ),
  );
  expect(doc.logistics).toEqual([{ channelId: listing.logistics.channelId, enabled: true }]);
  expect(doc.weightGrams).toBe(listing.logistics.weightGrams);
  expect(doc.dimensionCm).toEqual({
    length: listing.logistics.lengthCm,
    width: listing.logistics.widthCm,
    height: listing.logistics.heightCm,
  });
  expect(doc.publication).toBe('unlisted');
  expect(
    [...remote.modelBindings]
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .map((binding) => ({ sku: binding.sku, tierIndex: binding.tierIndex })),
  ).toEqual(
    listing.variants
      .map((variant) => ({ sku: variant.sku, tierIndex: variant.tierIndex }))
      .sort((a, b) => a.sku.localeCompare(b.sku)),
  );
}

test('80 genuine folders become 80 complete drafts, shop WorkOrders and independently read-back simulated listings', async ({
  page,
}) => {
  const started = Date.now();
  const imported = await intake(page, fixture);
  initialBatch = imported.batch;
  workbookId = imported.workbookId;
  expect(initialBatch.state.files).toHaveLength(520);
  for (const listing of fixture.listings)
    for (const file of listing.files) {
      const descriptor = initialBatch.state.files.find(
        (value) => value.relativePath === file.relativePath,
      )!;
      expect(descriptor.sha256).toBe(file.sha256);
      expect(descriptor.size).toBe(file.bytes);
      const record = initialBatch.imports.find((value) => value.id === descriptor.importId)!;
      expect(record.status).toBe('ready');
      if (file.kind === 'docx') expect((record.body as any).paragraphs).toEqual(listing.paragraphs);
    }
  await openPrepared(page);
  await page
    .getByRole('combobox', { name: 'Bộ thư mục Word và ảnh', exact: true })
    .selectOption(initialBatch.id);
  await page
    .getByRole('combobox', { name: 'File Excel điều phối và giá', exact: true })
    .selectOption(workbookId);
  const previewResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/v1/prepared-batches/preview') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Xem trước lô', exact: true }).click();
  const preview = await (await previewResponse).json();
  createRunId = preview.id;
  expect(preview.state).toBe('prepared');
  expect(preview.issues).toEqual([]);
  expect(preview.entries).toHaveLength(80);
  await expect(
    page.getByRole('table', { name: 'Listing trước khi thực hiện', exact: true }).getByRole('row'),
  ).toHaveCount(81);
  await page.screenshot({ path: join(fixture.root, '80-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Chạy mô phỏng 80 listing', exact: true }).click();
  const result = await waitRun(page, createRunId);
  expect(result.state).toBe('verified');
  expect(result.items).toHaveLength(80);
  expect(result.items.every((item: any) => item.state === 'verified')).toBe(true);
  await expect(
    page
      .getByRole('table', { name: 'Kết quả từng listing', exact: true })
      .getByText('Đã đối chiếu', { exact: true }),
  ).toHaveCount(80, { timeout: 30000 });
  await page.getByRole('heading', { name: 'Kết quả của lô', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(fixture.root, '80-verified-viewport.png') });
  const state = await ipc('snapshot');
  expect(state.counts.products).toBe(80);
  expect(state.counts.work_orders).toBe(80);
  expect(state.platform.items).toHaveLength(80);
  expect(state.platform.calls.filter((call: any) => call.kind === 'create')).toHaveLength(80);
  expect(state.platform.calls.filter((call: any) => call.kind === 'update')).toHaveLength(0);
  for (const listing of fixture.listings) {
    const sourceKey = initialBatch.state.productKeys[listing.groupKey];
    const remote = state.platform.items.filter(
      (row: any) =>
        row.scope.shopId === listing.shopId && row.remote.document.sourceKey === sourceKey,
    );
    expect(remote).toHaveLength(1);
    assertRemote(listing, remote[0].remote, sourceKey);
    const product = state.products.find((product: any) => product.productKey === sourceKey);
    expect(product.categoryId.value).toBe(listing.categoryId);
    expect(product.variants).toHaveLength(listing.variants.length);
  }
  for (const file of fixture.files) expect(sha256(await readFile(file.path))).toBe(file.sha256);
  expect(state.files.every((file: any) => file.sha256 === file.storedBlobSha256)).toBe(true);
  await post(page, '/v1/prepared-batches/' + createRunId + '/submit', {
    fingerprint: result.fingerprint,
  });
  expect(
    (await ipc('snapshot')).platform.calls.filter((call: any) => call.kind === 'create'),
  ).toHaveLength(80);
  await page.reload();
  await openPrepared(page);
  const persisted = await get(page, '/v1/prepared-batches/' + createRunId);
  expect(persisted).toEqual(result);
  await writeFile(
    join(fixture.root, '80-create-readback.json'),
    JSON.stringify({ result, snapshot: state }, null, 2),
  );
  proof.create = {
    importedFolders: 80,
    savedCompleteDrafts: state.counts.products,
    savedWorkOrders: state.counts.work_orders,
    remoteCreated: state.platform.items.length,
    remoteReadbackVerified: 80,
    variants: 200,
    shops: fixture.expected.shopCounts,
    categories: fixture.expected.categoryCounts,
    tiers: fixture.expected.tierCounts,
    durationMs: Date.now() - started,
  };
});

test('six explicit source faults stay isolated beside one ready folder through real imports and preview', async ({
  page,
}) => {
  const imported = await intake(page, exceptions);
  await openPrepared(page);
  await page
    .getByRole('combobox', { name: 'Bộ thư mục Word và ảnh', exact: true })
    .selectOption(imported.batch.id);
  await page
    .getByRole('combobox', { name: 'File Excel điều phối và giá', exact: true })
    .selectOption(imported.workbookId);
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/v1/prepared-batches/preview') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Xem trước lô', exact: true }).click();
  const preview = await (await response).json();
  exceptionPreview = preview;
  expect(preview.entries).toHaveLength(7);
  for (const fault of exceptions.cases) {
    const entry = preview.entries.find((entry: any) =>
      entry.folderKey.endsWith('/' + fault.folderName),
    );
    expect(entry, fault.problem).toBeTruthy();
    if (fault.expectedSourceAssembly === 'ready') expect(entry.issues, fault.problem).toEqual([]);
    else expect(entry.issues.length, fault.problem).toBeGreaterThan(0);
  }
  const state = await ipc('snapshot');
  expect(state.platform.items).toHaveLength(80);
  expect(state.counts.products).toBe(80);
  expect(state.files.filter((file: any) => file.status === 'failed')).toHaveLength(1);
  await page.screenshot({
    path: join(fixture.root, 'six-isolated-source-faults.png'),
    fullPage: true,
  });
  proof.exceptions = {
    blockedSources: 6,
    readyNeighbor: 1,
    remoteWrites: 0,
    cases: exceptions.cases,
    preview,
  };
});

const fields: PreparedField[] = [
  'title',
  'description',
  'cover',
  'gallery',
  'variationImages',
  'price',
  'stock',
  'attributes',
  'logistics',
];
const updateCases: PreparedField[][] = fields.map((field) => [field]);
for (const [fieldIndex, selectedFields] of updateCases.entries()) {
  const field = selectedFields[0],
    caseName = selectedFields.join('+');
  test(`actual versioned source updates ${caseName}, preserving unselected fields and stable model identities`, async ({
    page,
  }) => {
    const listing = fixture.listings[12 + (fieldIndex % 3)];
    const beforeState = await ipc('snapshot');
    const sourceKey = initialBatch.state.productKeys[listing.groupKey];
    const before = beforeState.platform.items.find(
      (row: any) =>
        row.scope.shopId === listing.shopId && row.remote.document.sourceKey === sourceKey,
    ).remote as PreparedRemote;
    const current = await get<InputBatchDetail>(page, '/v1/input-batches/' + initialBatch.id);
    const output = join(fixture.root, 'update-' + caseName);
    await mkdir(output, { recursive: true });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await readFile(fixture.workbookPath)) as unknown as ExcelJS.Buffer);
    const coordination = book.getWorksheet(businessCoordinationSheet)!;
    const desired = structuredClone(before);
    const files = structuredClone(initialBatch.state.files);
    const selectedSkus = ['price', 'stock', 'variationImages'].includes(field)
      ? [listing.variants[0].sku]
      : undefined;
    async function changedFile(filename: string, bytes: Buffer) {
      await writeFile(join(output, filename), bytes);
      const imported = await upload(page, filename, bytes);
      expect(imported.status).toBe('ready');
      const file = files.find((file) => file.relativePath === listing.groupKey + '/' + filename)!;
      file.importId = imported.id;
      file.sha256 = imported.sha256;
      file.size = imported.bytes;
      return {
        importId: imported.id,
        sha256: imported.sha256,
        width: imported.body.width,
        height: imported.body.height,
        mime: imported.body.mime,
      };
    }
    if (field === 'title' || field === 'description') {
      const paragraphs = [...listing.paragraphs];
      paragraphs[1] =
        field === 'title' ? listing.title + ' · Bản cập nhật có nguồn' : before.document.title;
      if (field === 'description') paragraphs[4] += '  Nội dung bổ sung được chỉ định.';
      await changedFile(listing.wordPath, wordBytes(paragraphs));
      if (field === 'title') desired.document.title = paragraphs[1];
      else
        desired.document.description = [
          { type: 'text', text: paragraphs[3] + '\n\n' },
          ...before.document.description.filter((block) => block.type === 'image'),
          { type: 'text', text: '\n\n' + paragraphs.slice(4).join('\n') },
        ];
    } else if (['cover', 'gallery', 'variationImages'].includes(field)) {
      const filename =
        field === 'cover'
          ? listing.media.coverPath
          : field === 'gallery'
            ? listing.media.galleryPaths[0]
            : listing.variants[0].imagePath!;
      const bytes = await sharp({
        create: {
          width: 900,
          height: field === 'cover' ? 900 : 1200,
          channels: 3,
          background: { r: 20 + fieldIndex, g: 31, b: 242 },
        },
      })
        .png()
        .toBuffer();
      const image = await changedFile(filename, bytes);
      if (field === 'cover') desired.document.cover = image;
      else if (field === 'gallery') desired.document.gallery[0] = image;
      else desired.document.models[0].image = image;
    } else if (field === 'price' || field === 'stock') {
      const sheet = book.getWorksheet(listing.priceSheet)!;
      for (const [index, variant] of listing.variants.entries())
        for (const modelField of selectedFields) {
          const value =
            modelField === 'price'
              ? Number(before.document.models[index].originalPrice) + 2345 + index
              : before.document.models[index].stock + 11 + index;
          sheet.getCell(variant.priceRow, modelField === 'price' ? 5 : 9).value = value;
          if (index === 0) {
            if (modelField === 'price') desired.document.models[0].originalPrice = String(value);
            else desired.document.models[0].stock = value;
          }
        }
    } else if (field === 'attributes') {
      const category = fixture.categories.find(
        (category) => category.categoryId === listing.categoryId,
      )!;
      const valueId = category.requiredAttribute.values[((fieldIndex % 3) + 1) % 3].valueId;
      coordination.getCell(listing.coordinationRow, 7).value = valueId;
      desired.document.attributes = { [category.requiredAttribute.attributeId]: [valueId] };
    } else if (field === 'logistics') {
      coordination.getCell(listing.coordinationRow, 9).value = before.document.weightGrams + 33;
      coordination.getCell(listing.coordinationRow, 10).value =
        before.document.dimensionCm.length + 2;
      desired.document.weightGrams += 33;
      desired.document.dimensionCm.length += 2;
      for (const variant of listing.variants)
        book.getWorksheet(listing.priceSheet)!.getCell(variant.priceRow, 7).value =
          desired.document.weightGrams;
    }
    const workbookBytes = Buffer.from(await book.xlsx.writeBuffer());
    await writeFile(join(output, 'Điều phối cập nhật.xlsx'), workbookBytes);
    const importedPrice = await upload(page, 'Điều phối cập nhật.xlsx', workbookBytes);
    const saved = await post(page, '/v1/input-batches', {
      id: initialBatch.id,
      expectedRevision: current.revision,
      state: {
        ...initialBatch.state,
        name: 'QA cập nhật ' + caseName,
        files,
        priceSelection: {
          importId: importedPrice.id,
          sheet: listing.priceSheet,
          priceProfile: null,
        },
      },
    });
    const input = {
      id: randomUUID(),
      inputBatchId: initialBatch.id,
      inputBatchRevision: saved.revision,
      workbookImportId: importedPrice.id,
      operation: 'update',
      fieldMask: selectedFields,
      folderKeys: [listing.groupKey],
      ...(selectedSkus ? { selectedSkus } : {}),
    };
    let preview: any;
    if (field === 'title') {
      await openPrepared(page);
      await page
        .getByRole('combobox', { name: 'Bộ thư mục Word và ảnh', exact: true })
        .selectOption(initialBatch.id);
      await page
        .getByRole('combobox', { name: 'File Excel điều phối và giá', exact: true })
        .selectOption(importedPrice.id);
      await page.getByRole('radio', { name: /Cập nhật link đã có/ }).check();
      await page.getByRole('checkbox', { name: 'Tiêu đề', exact: true }).check();
      await page.locator('summary').filter({ hasText: 'Chọn thư mục trong lô' }).click();
      await page.getByRole('button', { name: 'Bỏ chọn tất cả thư mục', exact: true }).click();
      await page
        .getByRole('checkbox', { name: 'Dùng thư mục ' + listing.groupKey, exact: true })
        .check();
      const response = page.waitForResponse(
        (response) =>
          response.url().endsWith('/v1/prepared-batches/preview') &&
          response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Xem trước lô', exact: true }).click();
      preview = await (await response).json();
      expect(preview.state).toBe('prepared');
      await page.getByRole('button', { name: 'Chạy mô phỏng 1 listing', exact: true }).click();
    } else {
      preview = await post(page, '/v1/prepared-batches/preview', input);
      expect(preview.state, JSON.stringify(preview)).toBe('prepared');
      await post(page, '/v1/prepared-batches/' + preview.id + '/submit', {
        fingerprint: preview.fingerprint,
      });
    }
    const result = await waitRun(page, preview.id);
    expect(result.state, JSON.stringify(result)).toBe('verified');
    const afterState = await ipc('snapshot');
    const after = afterState.platform.items.find(
      (row: any) => row.scope.shopId === listing.shopId && row.remote.itemId === before.itemId,
    ).remote as PreparedRemote;
    expect(after).not.toEqual(before);
    expect(after).toEqual(desired);
    expect(after.modelBindings).toEqual(before.modelBindings);
    expect(after.extra).toEqual(before.extra);
    expect(afterState.platform.items).toHaveLength(80);
    await post(page, '/v1/prepared-batches/' + preview.id + '/submit', {
      fingerprint: preview.fingerprint,
    });
    expect(
      (await ipc('snapshot')).platform.calls.filter((call: any) => call.kind === 'update'),
    ).toHaveLength(fieldIndex + 1);
    await writeFile(
      join(output, 'before-desired-after.json'),
      JSON.stringify(
        { fields: selectedFields, selectedSkus, before, desired, after, result },
        null,
        2,
      ),
    );
    proof.updates.push({
      field: caseName,
      shopId: listing.shopId,
      itemId: before.itemId,
      selectedSkus,
      changed: true,
      unselectedRetained: true,
      state: result.state,
    });
  });
}

test('combined price and stock updates twelve folders across three shops, retaining each unselected model', async ({
  page,
}) => {
  const selected = fixture.listings.slice(12, 24);
  expect(new Set(selected.map((listing) => listing.shopId)).size).toBe(3);
  const beforeState = await ipc('snapshot');
  const desiredItems = structuredClone(beforeState.platform.items);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await readFile(fixture.workbookPath)) as unknown as ExcelJS.Buffer);
  for (const listing of selected) {
    expect(listing.variants.length).toBe(3);
    const sourceKey = initialBatch.state.productKeys[listing.groupKey];
    const before = beforeState.platform.items.find(
      (item: any) =>
        item.scope.shopId === listing.shopId && item.remote.document.sourceKey === sourceKey,
    ).remote as PreparedRemote;
    const desired = desiredItems.find(
      (item: any) =>
        item.scope.shopId === listing.shopId && item.remote.document.sourceKey === sourceKey,
    ).remote as PreparedRemote;
    for (const [index, variant] of listing.variants.entries()) {
      const originalPrice = String(
        Number(before.document.models[index].originalPrice) + 3456 + index,
      );
      const stock = before.document.models[index].stock + 17 + index;
      const sheet = book.getWorksheet(listing.priceSheet)!;
      sheet.getCell(variant.priceRow, 5).value = Number(originalPrice);
      sheet.getCell(variant.priceRow, 9).value = stock;
      if (index === 0) {
        desired.document.models[index].originalPrice = originalPrice;
        desired.document.models[index].stock = stock;
      }
    }
  }
  const output = join(fixture.root, 'bulk-price-stock');
  await mkdir(output, { recursive: true });
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  await writeFile(join(output, 'Giá và tồn mới.xlsx'), bytes);
  const importedPrice = await upload(page, 'Giá và tồn mới.xlsx', bytes);
  const current = await get<InputBatchDetail>(page, '/v1/input-batches/' + initialBatch.id);
  const saved = await post(page, '/v1/input-batches', {
    id: initialBatch.id,
    expectedRevision: current.revision,
    state: {
      ...initialBatch.state,
      name: 'QA cập nhật giá và tồn 12 thư mục',
      priceSelection: {
        importId: importedPrice.id,
        sheet: fixture.shops[0].priceSheet,
        priceProfile: null,
      },
    },
  });
  const selectedSkus = [...new Set(selected.map((listing) => listing.variants[0].sku))];
  const preview = await post(page, '/v1/prepared-batches/preview', {
    id: randomUUID(),
    inputBatchId: initialBatch.id,
    inputBatchRevision: saved.revision,
    workbookImportId: importedPrice.id,
    operation: 'update',
    fieldMask: ['price', 'stock'],
    folderKeys: selected.map((listing) => listing.groupKey),
    selectedSkus,
  });
  expect(preview.entries).toHaveLength(12);
  expect(preview.state, JSON.stringify(preview)).toBe('prepared');
  await post(page, '/v1/prepared-batches/' + preview.id + '/submit', {
    fingerprint: preview.fingerprint,
  });
  const result = await waitRun(page, preview.id);
  expect(result.state, JSON.stringify(result)).toBe('verified');
  expect(result.items.filter((item: any) => item.state === 'verified')).toHaveLength(12);
  const afterState = await ipc('snapshot');
  expect(afterState.platform.items).toEqual(desiredItems);
  expect(afterState.platform.calls.filter((call: any) => call.kind === 'create')).toHaveLength(80);
  expect(afterState.platform.calls.filter((call: any) => call.kind === 'update')).toHaveLength(21);
  await post(page, '/v1/prepared-batches/' + preview.id + '/submit', {
    fingerprint: preview.fingerprint,
  });
  expect(
    (await ipc('snapshot')).platform.calls.filter((call: any) => call.kind === 'update'),
  ).toHaveLength(21);
  await writeFile(
    join(output, 'before-desired-after.json'),
    JSON.stringify(
      {
        fields: ['price', 'stock'],
        selectedSkus,
        before: beforeState.platform.items,
        desired: desiredItems,
        after: afterState.platform.items,
        result,
      },
      null,
      2,
    ),
  );
  proof.bulkUpdate = {
    folders: 12,
    shops: 3,
    fields: ['price', 'stock'],
    changedModels: 12,
    unselectedModelsRetained: 24,
    unaffectedOtherListings: 68,
    state: result.state,
  };
});

test('partial model write remains unknown and read-only reconciliation never resends it', async ({
  page,
}) => {
  const listing = fixture.listings[26];
  const sourceKey = initialBatch.state.productKeys[listing.groupKey];
  const beforeState = await ipc('snapshot');
  const before = beforeState.platform.items.find(
    (item: any) =>
      item.scope.shopId === listing.shopId && item.remote.document.sourceKey === sourceKey,
  ).remote as PreparedRemote;
  const desiredPartial = structuredClone(before);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await readFile(fixture.workbookPath)) as unknown as ExcelJS.Buffer);
  for (const [index, variant] of listing.variants.entries()) {
    const stock = before.document.models[index].stock + 41 + index;
    book.getWorksheet(listing.priceSheet)!.getCell(variant.priceRow, 9).value = stock;
    if (index === 0) desiredPartial.document.models[index].stock = stock;
  }
  const output = join(fixture.root, 'partial-model-fault');
  await mkdir(output, { recursive: true });
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  await writeFile(join(output, 'Tồn mới có nguồn.xlsx'), bytes);
  const price = await upload(page, 'Tồn mới có nguồn.xlsx', bytes);
  const current = await get<InputBatchDetail>(page, '/v1/input-batches/' + initialBatch.id);
  const saved = await post(page, '/v1/input-batches', {
    id: initialBatch.id,
    expectedRevision: current.revision,
    state: {
      ...initialBatch.state,
      name: 'QA lỗi ghi một phần model',
      priceSelection: { importId: price.id, sheet: listing.priceSheet, priceProfile: null },
    },
  });
  const preview = await post(page, '/v1/prepared-batches/preview', {
    id: randomUUID(),
    inputBatchId: initialBatch.id,
    inputBatchRevision: saved.revision,
    workbookImportId: price.id,
    operation: 'update',
    fieldMask: ['stock'],
    folderKeys: [listing.groupKey],
  });
  expect(preview.state).toBe('prepared');
  await ipc('fault', { fault: { kind: 'update_partial', shopId: listing.shopId, sourceKey } });
  await post(page, '/v1/prepared-batches/' + preview.id + '/submit', {
    fingerprint: preview.fingerprint,
  });
  const result = await waitRun(page, preview.id);
  expect(result.state).toBe('unknown');
  expect(result.items[0].state).toBe('unknown');
  const jobId = result.items[0].id;
  expect((await post(page, '/v1/prepared-jobs/' + jobId + '/reconcile', {})).state).toBe('unknown');
  expect((await post(page, '/v1/prepared-jobs/' + jobId + '/reconcile', {})).state).toBe('unknown');
  await post(page, '/v1/prepared-batches/' + preview.id + '/submit', {
    fingerprint: preview.fingerprint,
  });
  const afterState = await ipc('snapshot');
  const after = afterState.platform.items.find(
    (item: any) => item.scope.shopId === listing.shopId && item.remote.itemId === before.itemId,
  ).remote as PreparedRemote;
  expect(after).toEqual(desiredPartial);
  expect(after).not.toEqual(before);
  expect(afterState.platform.calls.filter((call: any) => call.kind === 'update')).toHaveLength(22);
  expect(afterState.platform.items).toHaveLength(80);
  await writeFile(
    join(output, 'partial-readback.json'),
    JSON.stringify({ before, expectedPartial: desiredPartial, after, result }, null, 2),
  );
  proof.executionFault = {
    case: 'partial model write',
    state: 'unknown',
    changedModels: 1,
    incompleteModels: listing.variants.length - 1,
    reconciliationReads: 2,
    replayWrites: 0,
  };
});

test('reload preserves all 80 source identities and completed receipts without additional writes', async ({
  page,
}) => {
  const current = await get<InputBatchDetail>(page, '/v1/input-batches/' + initialBatch.id);
  await post(page, '/v1/input-batches', {
    id: initialBatch.id,
    expectedRevision: current.revision,
    state: initialBatch.state,
  });
  await openPrepared(page);
  await page.reload();
  const restored = await get<InputBatchDetail>(page, '/v1/input-batches/' + initialBatch.id);
  expect(restored.state).toEqual(initialBatch.state);
  expect(Object.keys(restored.state.productKeys)).toHaveLength(80);
  const state = await ipc('snapshot');
  expect(state.counts.products).toBe(80);
  expect(state.platform.items).toHaveLength(80);
  expect(state.platform.calls.filter((call: any) => call.kind === 'create')).toHaveLength(80);
  expect(state.platform.calls.filter((call: any) => call.kind === 'update')).toHaveLength(22);
  expect(state.forbiddenFetches).toEqual([]);
  expect(outsideRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
  expect(state.workerErrors).toEqual([]);
  proof.finalCounts = state.counts;
});

test('mixed source batch executes only its intact neighbor and retains six blocked results', async ({
  page,
}) => {
  expect(exceptionPreview.entries).toHaveLength(7);
  await post(page, '/v1/prepared-batches/' + exceptionPreview.id + '/submit', {
    fingerprint: exceptionPreview.fingerprint,
  });
  await expect
    .poll(
      async () =>
        (await get(page, '/v1/prepared-batches/' + exceptionPreview.id)).items.filter(
          (item: any) => item.state === 'verified',
        ).length,
      { timeout: 60000 },
    )
    .toBe(1);
  const result = await get(page, '/v1/prepared-batches/' + exceptionPreview.id);
  expect(result.state).toBe('blocked');
  expect(result.counts.blocked).toBe(6);
  expect(result.counts.verified).toBe(1);
  expect(result.items.filter((item: any) => item.state === 'blocked')).toHaveLength(6);
  const state = await ipc('snapshot');
  expect(state.platform.items).toHaveLength(81);
  expect(state.counts.products).toBe(81);
  expect(state.platform.calls.filter((call: any) => call.kind === 'create')).toHaveLength(81);
  const good = exceptions.listings[6];
  const remote = state.platform.items.find(
    (item: any) =>
      item.remote.itemId === result.items.find((item: any) => item.state === 'verified').itemId,
  );
  expect(remote.scope.shopId).toBe(good.shopId);
  assertRemote(good, remote.remote, remote.remote.document.sourceKey);
  proof.exceptionExecution = {
    separateFromMain80: true,
    additionalVerifiedListing: 1,
    blocked: 6,
    overallState: result.state,
    totalRemoteAfterNegativeSuite: 81,
    result,
  };
  await writeFile(
    join(fixture.root, 'exception-execution.json'),
    JSON.stringify({ result, snapshot: state }, null, 2),
  );
});
