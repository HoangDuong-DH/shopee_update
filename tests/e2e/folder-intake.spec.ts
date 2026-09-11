import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { InputBatchRecord, InputBatchState, WorkbookImport } from '@shopee/domain';
import type { ImportRecord } from '../../apps/web/src/api.js';

// Directory-picker and client assembly acceptance. Import processing is a browser
// fixture; every API write is intercepted and no source/product reaches the DB or Shopee.
const commonWorkbookId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const observedAt = '2026-09-11T00:00:00.000Z';
const source = {
  kind: 'product_file' as const,
  fileSha256: 'c'.repeat(64),
  locator: 'Browser-only common workbook fixture',
  observedAt,
};
const fact = (value: string) => ({ value, confirmed: true, sources: [source] });
const commonWorkbook: WorkbookImport = {
  source,
  rows: ['SKU-A', 'SKU-B', 'SKU-C'].map((sku, index) => ({
    key: `${sku}-row`,
    sheet: 'Giá nội bộ',
    row: index + 2,
    headerRow: 1,
    sku: fact(sku),
    name: fact(`Tên nguồn ${sku}`),
    originalPrice: fact(String((index + 1) * 12000)),
    promotionTarget: fact(String((index + 1) * 10000)),
    issues: [],
  })),
  issues: [],
  sheets: [{ name: 'Giá nội bộ', rowCount: 4, importedRows: 3, headerRows: [1] }],
};
const commonWorkbookRecord: ImportRecord = {
  id: commonWorkbookId,
  sha256: source.fileSha256,
  filename: 'TEST FIXTURE · Bảng giá dùng chung.xlsx',
  kind: 'xlsx',
  status: 'ready',
  bytes: 2048,
  createdAt: observedAt,
  message: '',
  body: commonWorkbook,
};
type FolderFileFixture = {
  relativePath: string;
  paragraphs?: string[];
  failed?: boolean;
};

async function folderFixture(page: Page, info: TestInfo, definitions: FolderFileFixture[]) {
  const directory = info.outputPath('selected-folders');
  const imported = new Map<string, ImportRecord>();
  const byBody = new Map<string, ImportRecord>();
  const recordsByPath = new Map<string, ImportRecord>();
  const writes: string[] = [];
  const batchWrites: { id: string; expectedRevision: number; state: InputBatchState }[] = [];
  const batches = new Map<string, InputBatchRecord>();
  const lastBatchRequests = new Map<string, string>();
  let nextSaveFailure: { status: number; code: string } | undefined;
  let disconnectAfterNextSave = false;
  const unexpectedWrites: string[] = [];
  for (const definition of definitions) {
    const absolute = path.resolve(directory, definition.relativePath);
    // Fixture paths are static test data; guard the test output boundary as well.
    if (!absolute.startsWith(path.resolve(directory) + path.sep))
      throw new Error('Folder fixture path escaped test output');
    await mkdir(path.dirname(absolute), { recursive: true });
    const bytes = Buffer.from(`Browser fixture bytes: ${definition.relativePath}`);
    await writeFile(absolute, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = randomUUID();
    const kind = definition.paragraphs ? 'docx' : 'image';
    const filename = path.basename(definition.relativePath);
    const record: ImportRecord = {
      id,
      sha256,
      filename,
      kind,
      status: definition.failed ? 'failed' : 'ready',
      bytes: bytes.length,
      createdAt: observedAt,
      message: definition.failed ? 'WORD_DOCUMENT_MISSING' : '',
      body: definition.paragraphs
        ? { source: { ...source, fileSha256: sha256, filename }, paragraphs: definition.paragraphs }
        : {
            key: id,
            sha256,
            bytes: bytes.length,
            mime: 'image/png',
            width: 1024,
            height: 1024,
            source: { ...source, fileSha256: sha256, filename },
          },
    };
    byBody.set(bytes.toString('base64'), record);
    recordsByPath.set(definition.relativePath, record);
  }
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/v1/input-batches') {
      const input = request.postDataJSON() as (typeof batchWrites)[number];
      batchWrites.push(input);
      if (nextSaveFailure) {
        const failure = nextSaveFailure;
        nextSaveFailure = undefined;
        return route.fulfill({ status: failure.status, json: { code: failure.code } });
      }
      const previous = batches.get(input.id);
      const serialized = JSON.stringify(input);
      if (previous && lastBatchRequests.get(input.id) === serialized)
        return route.fulfill({ json: previous });
      if ((previous?.revision ?? 0) !== input.expectedRevision)
        return route.fulfill({ status: 409, json: { code: 'INPUT_BATCH_REVISION_CONFLICT' } });
      const saved: InputBatchRecord = {
        id: input.id,
        revision: input.expectedRevision + 1,
        state: input.state,
        createdAt: previous?.createdAt ?? observedAt,
        updatedAt: observedAt,
      };
      batches.set(input.id, saved);
      lastBatchRequests.set(input.id, serialized);
      if (disconnectAfterNextSave) {
        disconnectAfterNextSave = false;
        return route.abort('failed');
      }
      return route.fulfill({ status: 201, json: saved });
    }
    if (request.method() === 'POST' && pathname === '/v1/imports') {
      const record = byBody.get(request.postDataBuffer()?.toString('base64') ?? '');
      if (!record) {
        unexpectedWrites.push('Unknown file body');
        return route.fulfill({ status: 400, json: { code: 'INVALID_INPUT' } });
      }
      writes.push(record.id);
      imported.set(record.id, record);
      return route.fulfill({ status: 201, json: { ...record, status: 'queued', body: undefined } });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      unexpectedWrites.push(request.method() + ' ' + pathname);
      return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
    }
    if (pathname === '/v1/input-library') {
      const assigned = new Set(
        [...batches.values()].flatMap((batch) => batch.state.files.map((file) => file.importId)),
      );
      return route.fulfill({
        json: {
          priceBooks: [
            {
              id: commonWorkbookId,
              filename: commonWorkbookRecord.filename,
              status: 'ready',
              createdAt: observedAt,
              bytes: 2048,
              rowCount: 3,
              sheetCount: 1,
              issueCount: 0,
            },
          ],
          batches: [...batches.values()].map((batch) => ({
            id: batch.id,
            revision: batch.revision,
            name: batch.state.name,
            updatedAt: batch.updatedAt,
            folderCount: Object.keys(batch.state.productKeys).length,
            fileCount: batch.state.files.length,
            completedCount: 0,
            priceSelection: batch.state.priceSelection,
          })),
          unassigned: [...imported.values()].filter((record) => !assigned.has(record.id)),
        },
      });
    }
    if (pathname.startsWith('/v1/input-batches/')) {
      const batch = batches.get(pathname.split('/').at(-1)!);
      return route.fulfill({
        status: batch ? 200 : 404,
        json: batch
          ? { ...batch, imports: [commonWorkbookRecord, ...imported.values()] }
          : { code: 'NOT_FOUND' },
      });
    }
    if (pathname === '/v1/imports')
      return route.fulfill({ json: [commonWorkbookRecord, ...imported.values()] });
    if (pathname === `/v1/imports/${commonWorkbookId}`)
      return route.fulfill({ json: commonWorkbookRecord });
    if (pathname.startsWith('/v1/imports/')) {
      const record = imported.get(pathname.split('/').at(-1)!);
      return route.fulfill({ status: record ? 200 : 404, json: record ?? { code: 'NOT_FOUND' } });
    }
    if (pathname.startsWith('/v1/media/'))
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg1sAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    if (['/v1/products', '/v1/plans', '/v1/jobs', '/v1/shops'].includes(pathname))
      return route.fulfill({ json: [] });
    if (pathname === '/v1/status')
      return route.fulfill({ json: { worker: 'online', productionWrites: false } });
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return {
    directory,
    writes,
    unexpectedWrites,
    recordsByPath,
    batches,
    batchWrites,
    rejectNextSave(status: number, code: string) {
      nextSaveFailure = { status, code };
    },
    disconnectAfterNextSave() {
      disconnectAfterNextSave = true;
    },
  };
}

const twoFolders: FolderFileFixture[] = [
  {
    relativePath: 'Listing A/content.docx',
    paragraphs: [
      'TIÊU ĐỀ',
      '  Tiêu đề A nguyên bản  ',
      'BÀI MÔ TẢ ĐĂNG BÁN',
      'Mở đầu A',
      ' Phần thân A  ',
    ],
  },
  { relativePath: 'Listing A/1.png' },
  { relativePath: 'Listing A/2.png' },
  { relativePath: 'Listing A/3.png' },
  {
    relativePath: 'Listing B/content.docx',
    paragraphs: [
      'TIÊU ĐỀ',
      'Tiêu đề B khác hoàn toàn',
      'BÀI MÔ TẢ ĐĂNG BÁN',
      'Mở đầu B',
      'Phần thân B',
    ],
  },
  { relativePath: 'Listing B/1.png' },
  { relativePath: 'Listing B/2.png' },
];

async function openFolders(page: Page, directory: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Bảng giá chung', exact: true })
    .selectOption(commonWorkbookId);
  await page
    .getByRole('combobox', { name: 'Sheet chứa giá', exact: true })
    .selectOption('Giá nội bộ');
  await page.getByRole('combobox', { name: 'Bộ giá áp dụng', exact: true }).selectOption('null');
  await page.getByRole('radio', { name: 'Mỗi thư mục con là một listing', exact: true }).check();
  await page.getByLabel('Chọn thư mục listing', { exact: true }).setInputFiles(directory);
  await page
    .getByTestId('folder-row')
    .filter({ hasText: 'Listing A' })
    .getByRole('button', { name: 'Xem nguồn', exact: true })
    .click();
}

async function choosePreparedRoles(page: Page) {
  const candidate = page.getByTestId('folder-candidate');
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 1.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Dùng làm ảnh bìa', exact: true }).click();
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 3.png', exact: true }).check();
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 2.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Thêm vào cả hai', exact: true }).click();
  await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
  await candidate.getByText('Cách đọc Word trong bộ nguồn', { exact: true }).click();
  await candidate
    .getByRole('checkbox', {
      name: 'Dùng cấu trúc Word này cho cả đợt',
      exact: true,
    })
    .check();
}

async function savedBatch(page: Page, batches: Map<string, InputBatchRecord>) {
  await expect(
    page.getByRole('status').filter({ hasText: 'Đã lưu vào Kho đầu vào' }),
  ).toBeVisible();
  await expect.poll(() => batches.size).toBe(1);
  return structuredClone([...batches.values()][0]);
}

test('fixture: a saved input batch restores both folders, Word, price and image order after reload without uploading again', async ({
  page,
}, info) => {
  const fixture = await folderFixture(page, info, twoFolders);
  await openFolders(page, fixture.directory);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  await choosePreparedRoles(page);
  const before = await savedBatch(page, fixture.batches);
  expect(before.state.priceSelection).toEqual({
    importId: commonWorkbookId,
    sheet: 'Giá nội bộ',
    priceProfile: null,
  });
  expect(before.state.wordRule).toEqual({
    titleHeader: 'TIÊU ĐỀ',
    descriptionHeader: 'BÀI MÔ TẢ ĐĂNG BÁN',
    headline: 'first_line',
    paragraphSeparator: '\n\n',
  });
  expect(new Set(Object.values(before.state.productKeys)).size).toBe(2);
  const groupA = Object.keys(before.state.visual).find((key) => key.endsWith('Listing A'))!;
  expect(before.state.visual[groupA].galleryPaths.map((item) => item.split('/').at(-1))).toEqual([
    '3.png',
    '2.png',
  ]);
  expect(before.state.visual[groupA].descriptionPaths).toEqual(
    before.state.visual[groupA].galleryPaths,
  );
  expect(fixture.writes).toHaveLength(7);

  await page.reload();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Kho đầu vào', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Kho đầu vào', exact: true })).toBeVisible();
  await expect(page.getByTestId('input-batch-row')).toHaveCount(1);
  await page
    .getByTestId('input-batch-row')
    .getByRole('button', { name: 'Tiếp tục xử lý', exact: true })
    .click();
  const candidate = page.getByTestId('folder-candidate');
  await expect(page.getByTestId('folder-row')).toHaveCount(2);
  await page
    .getByTestId('folder-row')
    .filter({ hasText: 'Listing A' })
    .getByRole('button', { name: 'Xem nguồn', exact: true })
    .click();
  await expect(candidate).toContainText('Ảnh bìa: 1.png');
  await expect(candidate).toContainText('Ảnh sản phẩm · 2 ảnh');
  await expect(candidate).toContainText('Ảnh mô tả · 2 ảnh');
  await page.screenshot({
    path: '.local/e2e-artifacts/input-batch-restored-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: '.local/e2e-artifacts/input-batch-restored-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
  await expect(candidate).toContainText('Tiêu đề A nguyên bản');
  await expect(candidate).toContainText('Phần thân A');
  await expect(candidate).not.toContainText('Tiêu đề B khác hoàn toàn');
  await page
    .getByTestId('folder-row')
    .filter({ hasText: 'Listing B' })
    .getByRole('button', { name: 'Xem nguồn', exact: true })
    .click();
  await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
  await expect(candidate).toContainText('Tiêu đề B khác hoàn toàn');
  await expect(candidate).not.toContainText('Tiêu đề A nguyên bản');
  await candidate.getByRole('tab', { name: 'Ảnh trong thư mục', exact: true }).click();
  await expect(candidate).toContainText('Ảnh bìa: Chưa chọn');
  await expect(candidate.getByRole('checkbox', { name: /^Chọn ảnh/ })).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Nguồn đã chọn', exact: true })).toContainText(
    'Giá nội bộ',
  );
  expect([...fixture.batches.values()][0].state).toEqual(before.state);
  expect(fixture.writes).toHaveLength(7);
  expect(fixture.unexpectedWrites).toEqual([]);
});

test('fixture: failed batch persistence keeps visual choices and retries the saved references without reupload', async ({
  page,
}, info) => {
  const fixture = await folderFixture(page, info, twoFolders);
  await openFolders(page, fixture.directory);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  await savedBatch(page, fixture.batches);
  fixture.rejectNextSave(503, 'SERVICE_UNAVAILABLE');
  const candidate = page.getByTestId('folder-candidate');
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 1.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Dùng làm ảnh bìa', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Thử lưu lại', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu vào Kho đầu vào' })).toHaveCount(
    0,
  );
  await expect(candidate).toContainText('Ảnh bìa: 1.png');
  const attemptsAtFailure = fixture.batchWrites.length;
  await page.getByRole('button', { name: 'Thử lưu lại', exact: true }).click();
  const saved = await savedBatch(page, fixture.batches);
  expect(fixture.batchWrites.length).toBeGreaterThan(attemptsAtFailure);
  expect(
    Object.values(saved.state.visual).some((value) => value.coverPath?.endsWith('/1.png')),
  ).toBe(true);
  expect(fixture.writes).toHaveLength(7);
  expect(fixture.unexpectedWrites).toEqual([]);
});

test('fixture: a conflicting batch revision preserves current choices and never overwrites the newer saved batch', async ({
  page,
}, info) => {
  const fixture = await folderFixture(page, info, twoFolders);
  await openFolders(page, fixture.directory);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  const initial = await savedBatch(page, fixture.batches);
  const remote = {
    ...initial,
    revision: initial.revision + 1,
    state: { ...initial.state, name: 'Bản từ máy khác' },
  };
  fixture.batches.set(initial.id, remote);
  const candidate = page.getByTestId('folder-candidate');
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 1.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Dùng làm ảnh bìa', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Bộ đầu vào đã có thay đổi ở nơi khác');
  await expect(candidate).toContainText('Ảnh bìa: 1.png');
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu vào Kho đầu vào' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Mở bản đã lưu', exact: true })).toBeVisible();
  const failedRequestCount = fixture.batchWrites.length;
  // Another local choice must not reset a stale revision or overwrite the remote record.
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 2.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Thêm vào cả hai', exact: true }).click();
  await expect(candidate).toContainText('Ảnh sản phẩm · 1 ảnh');
  await expect(page.getByRole('alert')).toContainText('Bộ đầu vào đã có thay đổi ở nơi khác');
  expect(fixture.batches.get(initial.id)).toEqual(remote);
  expect(fixture.batchWrites).toHaveLength(failedRequestCount);
  expect(fixture.writes).toHaveLength(7);
  expect(fixture.unexpectedWrites).toEqual([]);
});

test('fixture: an uncertain save replays the same request before persisting later image choices', async ({
  page,
}, info) => {
  const fixture = await folderFixture(page, info, twoFolders);
  await openFolders(page, fixture.directory);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  const initial = await savedBatch(page, fixture.batches);
  const candidate = page.getByTestId('folder-candidate');
  fixture.disconnectAfterNextSave();
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 1.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Dùng làm ảnh bìa', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Thử lưu lại', exact: true })).toBeVisible();
  const uncertain = structuredClone(fixture.batchWrites.at(-1)!);
  expect(fixture.batches.get(initial.id)?.revision).toBe(initial.revision + 1);
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 3.png', exact: true }).check();
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 2.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Thêm vào cả hai', exact: true }).click();
  await page.getByRole('button', { name: 'Thử lưu lại', exact: true }).click();
  const final = await savedBatch(page, fixture.batches);
  const attempts = fixture.batchWrites.slice(-3);
  expect(attempts[0]).toEqual(uncertain);
  expect(attempts[1]).toEqual(uncertain);
  expect(attempts[2].expectedRevision).toBe(initial.revision + 1);
  expect(final.revision).toBe(initial.revision + 2);
  const chosen = Object.values(final.state.visual).find((value) =>
    value.coverPath?.endsWith('/1.png'),
  )!;
  expect(chosen.galleryPaths.map((item) => item.split('/').at(-1))).toEqual(['3.png', '2.png']);
  expect(chosen.descriptionPaths).toEqual(chosen.galleryPaths);
  expect(fixture.batches.size).toBe(1);
  expect(fixture.writes).toHaveLength(7);
  expect(fixture.unexpectedWrites).toEqual([]);
});

test('fixture: reads two separate folders with one common price source and leaves numeric image roles unresolved', async ({
  page,
}, info) => {
  const fixture = await folderFixture(page, info, twoFolders);
  await openFolders(page, fixture.directory);
  await expect(page.getByTestId('folder-row')).toHaveCount(2);
  await expect(page.getByRole('combobox', { name: 'Bảng giá chung', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  const candidate = page.getByTestId('folder-candidate');
  await expect(candidate.getByRole('checkbox', { name: /^Chọn ảnh/ })).toHaveCount(3);
  await expect(candidate).toContainText('Ảnh bìa: Chưa chọn');
  await expect(candidate).toContainText('Ảnh sản phẩm · 0 ảnh');
  await expect(candidate).toContainText('Ảnh mô tả · 0 ảnh');
  await expect(page.getByRole('button', { name: 'Xem & hoàn thiện', exact: true })).toHaveCount(0);
  await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
  await expect(candidate).toContainText('Tiêu đề A nguyên bản');
  await expect(candidate).not.toContainText('Tiêu đề B khác hoàn toàn');
  await page
    .getByTestId('folder-row')
    .filter({ hasText: 'Listing B' })
    .getByRole('button', { name: 'Xem nguồn', exact: true })
    .click();
  await candidate.getByRole('tab', { name: 'Ảnh trong thư mục', exact: true }).click();
  await expect(candidate.getByRole('checkbox', { name: /^Chọn ảnh/ })).toHaveCount(2);
  await expect(candidate).toContainText('Ảnh bìa: Chưa chọn');
  await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
  await expect(candidate).toContainText('Tiêu đề B khác hoàn toàn');
  await expect(candidate).not.toContainText('Tiêu đề A nguyên bản');
  await expect(page.getByRole('region', { name: 'Nguồn đã chọn', exact: true })).toContainText(
    'TEST FIXTURE · Bảng giá dùng chung.xlsx',
  );
  await page.getByRole('button', { name: 'Bảng giá & tệp nguồn', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Bảng giá chung', exact: true })).toHaveValue(
    commonWorkbookId,
  );
  await page.getByRole('button', { name: 'Thu gọn phần chọn nguồn', exact: true }).click();
  await expect(
    page.getByText('Bộ đầu vào được lưu riêng để làm tiếp · Chưa gửi lên Shopee', {
      exact: true,
    }),
  ).toBeVisible();
  await candidate.getByRole('tab', { name: 'Ảnh trong thư mục', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/e2e-artifacts/folder-batch-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/e2e-artifacts/folder-batch-mobile.png', fullPage: true });
  expect(fixture.writes).toHaveLength(7);
  expect(fixture.unexpectedWrites).toEqual([]);
});

test('fixture: visual roles and exact Word content survive completing only missing membership', async ({
  page,
}, info) => {
  const fixture = await folderFixture(page, info, twoFolders);
  await openFolders(page, fixture.directory);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  const candidate = page.getByTestId('folder-candidate');
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 1.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Dùng làm ảnh bìa', exact: true }).click();
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 3.png', exact: true }).check();
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh 2.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Thêm vào cả hai', exact: true }).click();
  await expect(candidate).toContainText('Ảnh bìa: 1.png');
  await expect(candidate).toContainText('Ảnh sản phẩm · 2 ảnh');
  await expect(candidate).toContainText('Ảnh mô tả · 2 ảnh');
  await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
  await candidate.getByText('Cách đọc Word trong bộ nguồn', { exact: true }).click();
  await candidate
    .getByRole('checkbox', { name: 'Dùng cấu trúc Word này cho cả đợt', exact: true })
    .check();
  await candidate.getByRole('button', { name: 'Bổ sung SKU/phân loại', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Nhập listing có sẵn', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'File bảng giá', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: /^Một nhóm/ }).check();
  await page.getByLabel('Tên nhóm phân loại 1', { exact: true }).fill('Quy cách nguyên bản');
  await page.getByLabel('SKU dòng 1', { exact: true }).fill('SKU-A');
  await page.getByLabel('Nhãn nhóm 1 dòng 1', { exact: true }).fill(' Gói  12 cái ');
  await page.getByRole('button', { name: 'Tiếp tục: kiểm tra', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'SKU-A' })).toContainText('12.000');
  await page
    .getByRole('checkbox', {
      name: 'Tôi đã kiểm tra đủ SKU, đúng tên và thứ tự phân loại của bộ listing này.',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: 'Tiếp tục: nội dung & ảnh', exact: true }).click();
  await expect(page.getByLabel('Tiêu đề listing', { exact: true })).toHaveValue(
    '  Tiêu đề A nguyên bản  ',
  );
  await expect(page.getByRole('textbox', { name: 'Câu mở đầu content', exact: true })).toHaveValue(
    'Mở đầu A',
  );
  await expect(
    page.getByRole('textbox', { name: 'Nội dung sau toàn bộ ảnh mô tả', exact: true }),
  ).toHaveValue('\n Phần thân A  ');
  await page.getByRole('tab', { name: /^Bộ ảnh/ }).click();
  await expect(
    page.getByRole('list', { name: 'Ảnh đã chọn · Ảnh bìa', exact: true }),
  ).toContainText('1.png');
  await expect(
    page.getByRole('list', { name: 'Ảnh đã chọn · Ảnh bìa', exact: true }).getByRole('img'),
  ).toHaveAttribute('src', '/v1/media/' + fixture.recordsByPath.get('Listing A/1.png')!.id);
  await page.getByRole('tab', { name: /^Ảnh listing/ }).click();
  const selected = page
    .getByRole('list', { name: 'Ảnh đã chọn · Ảnh listing', exact: true })
    .getByRole('listitem');
  await expect(selected).toHaveCount(2);
  await expect(selected.nth(0)).toContainText('3.png');
  await expect(selected.nth(1)).toContainText('2.png');
  await expect(selected.nth(0).getByRole('img')).toHaveAttribute(
    'src',
    '/v1/media/' + fixture.recordsByPath.get('Listing A/3.png')!.id,
  );
  await page.getByRole('tab', { name: /^SKU & phân loại/ }).click();
  await expect(page.getByLabel('Phân loại 1', { exact: true })).toHaveValue(' Gói  12 cái ');
  await expect(page.getByLabel('Phân loại 1', { exact: true })).not.toBeEditable();
  expect(fixture.writes).toHaveLength(7);
  expect(fixture.unexpectedWrites).toEqual([]);
});

test('fixture: keeps failed file processing visible and continues independent folders', async ({
  page,
}, info) => {
  const fixture = await folderFixture(
    page,
    info,
    twoFolders.map((file) => ({ ...file, failed: file.relativePath === 'Listing A/content.docx' })),
  );
  await openFolders(page, fixture.directory);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  const candidate = page.getByTestId('folder-candidate');
  await expect(candidate.getByRole('checkbox', { name: /^Chọn ảnh/ })).toHaveCount(3);
  await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
  await expect(candidate).toContainText('Chưa có tệp Word đọc được trong thư mục.');
  await expect(candidate).toContainText('content.docx');
  await expect(candidate.getByText('WORD_DOCUMENT_MISSING', { exact: true })).not.toBeVisible();
  await expect(page.getByTestId('folder-row')).toHaveCount(2);
  await page
    .getByTestId('folder-row')
    .filter({ hasText: 'Listing B' })
    .getByRole('button', { name: 'Xem nguồn', exact: true })
    .click();
  await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
  await expect(candidate).toContainText('Tiêu đề B khác hoàn toàn');
  await expect(candidate).not.toContainText('Tiêu đề A nguyên bản');
  expect(fixture.writes).toHaveLength(7);
  expect(fixture.unexpectedWrites).toEqual([]);
});

test('fixture: holds navigation while folder uploads are pending and keeps staged files on staying', async ({
  page,
}, info) => {
  const fixture = await folderFixture(page, info, twoFolders);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/v1/imports', async (route) => {
    if (route.request().method() === 'POST') await held;
    return route.fallback();
  });
  try {
    await openFolders(page, fixture.directory);
    await page
      .getByRole('navigation', { name: 'Điều hướng chính' })
      .getByRole('button', { name: 'Kho đầu vào', exact: true })
      .click();
    const dialog = page.getByRole('alertdialog', { name: 'Thay đổi chưa lưu', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Ở lại', exact: true }).click();
    await expect(page.getByTestId('folder-row')).toHaveCount(2);
    const requestStarted = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/v1/imports',
    );
    await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
    await requestStarted;
    await page
      .getByRole('navigation', { name: 'Điều hướng chính' })
      .getByRole('button', { name: 'Kho đầu vào', exact: true })
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: 'Nhập listing theo thư mục', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByLabel('Chọn thư mục listing', { exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Nhập thủ công khi cần', exact: true }),
    ).toBeDisabled();
    release();
    await expect(
      page.getByTestId('folder-candidate').getByRole('checkbox', { name: /^Chọn ảnh/ }),
    ).toHaveCount(3);
    expect(fixture.writes).toHaveLength(7);
    expect(fixture.unexpectedWrites).toEqual([]);
  } finally {
    release();
  }
});

test('fixture: an unfamiliar Word layout stays a source exception and the editor only offers files from that folder', async ({
  page,
}, info) => {
  const fixture = await folderFixture(
    page,
    info,
    twoFolders.map((file) =>
      file.relativePath === 'Listing A/content.docx'
        ? {
            ...file,
            paragraphs: ['Dòng chưa xác định là tiêu đề', ' Toàn bộ chữ gốc cần đối chiếu  '],
          }
        : file,
    ),
  );
  await openFolders(page, fixture.directory);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  const candidate = page.getByTestId('folder-candidate');
  await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
  await expect(candidate).toContainText('Dòng chưa xác định là tiêu đề');
  await candidate.getByRole('button', { name: 'Bổ sung SKU/phân loại', exact: true }).click();
  await page.getByRole('radio', { name: /^Không có phân loại/ }).check();
  await page.getByLabel('SKU dòng 1', { exact: true }).fill('SKU-A');
  await page.getByRole('button', { name: 'Tiếp tục: kiểm tra', exact: true }).click();
  await page
    .getByRole('checkbox', {
      name: 'Tôi đã kiểm tra đủ SKU, đúng tên và thứ tự phân loại của bộ listing này.',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: 'Tiếp tục: nội dung & ảnh', exact: true }).click();
  await expect(page.getByLabel('Tiêu đề listing', { exact: true })).toHaveValue('');
  await expect(
    page.getByRole('textbox', { name: 'Nội dung sau toàn bộ ảnh mô tả', exact: true }),
  ).toHaveValue('');
  const word = page.getByRole('combobox', { name: 'Tệp Word để đối chiếu', exact: true });
  await expect(word.locator('option[value]:not([value=""])')).toHaveCount(1);
  await expect(word.locator('option[value]:not([value=""])')).toHaveAttribute(
    'value',
    fixture.recordsByPath.get('Listing A/content.docx')!.id,
  );
  await expect(
    page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first(),
  ).toBeDisabled();
  await page.getByRole('tab', { name: /^Bộ ảnh/ }).click();
  await page.getByRole('button', { name: 'Chọn ảnh', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Chọn tệp cho ảnh bìa', exact: true });
  await expect(picker.locator('button[aria-pressed]')).toHaveCount(3);
  expect(fixture.writes).toHaveLength(7);
  expect(fixture.unexpectedWrites).toEqual([]);
});
