import { openWorkspaceTool, openInputLibrary } from './workspace-navigation.js';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InputBatchDetail, ListingDraft, WorkbookImport, WorkOrderView } from '@shopee/domain';
import {
  categoryFamilies,
  conflictSheet,
  createBulkFolderFixture,
  priceSheet,
  sha256,
  sharedSku,
  shopProfiles,
  type BulkFolderFixture,
  type SourceFile,
} from './bulk-folder-fixtures.js';

let server: ChildProcess,
  baseURL: string,
  fixture: BulkFolderFixture,
  batchId: string,
  workbookId: string;
const outcomes: { title: string; status: TestInfo['status']; durationMs: number }[] = [];
const proof: Record<string, unknown> = {
  synthetic: true,
  scope: 'real local API/PostgreSQL/import worker/browser; no Shopee network',
  startedAt: new Date().toISOString(),
};
const browserWrites: string[] = [],
  browserErrors: string[] = [],
  outsideRequests: string[] = [];
test.describe.configure({ mode: 'serial', timeout: 240000 });
test.beforeAll(async () => {
  fixture = await createBulkFolderFixture();
  const options: ForkOptions & { windowsHide: boolean } = {
    execArgv: ['--conditions=development', '--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: resolve('apps/api/tsconfig.json'),
      BULK_FOLDER_EVIDENCE_ROOT: fixture.root,
    },
  };
  server = fork(resolve('tests/e2e/bulk-folder-server.mts'), [], options);
  baseURL = await new Promise<string>((done, fail) => {
    let ready = false;
    const timer = setTimeout(
      () => fail(new Error('Isolated bulk folder server did not start')),
      60000,
    );
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
        fail(new Error(`Fixture exited before ready: ${code}/${signal}`));
      }
    });
    server.stderr?.on('data', (data) => process.stderr.write(data));
  });
});
test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('request', (request) => {
    if (!['localhost', '127.0.0.1'].includes(new URL(request.url()).hostname))
      outsideRequests.push(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
      browserWrites.push(request.method() + ' ' + new URL(request.url()).pathname);
  });
});
test.afterEach(async ({}, info) => {
  outcomes.push({ title: info.title, status: info.status, durationMs: info.duration });
});
test.afterAll(async () => {
  if (!fixture) return;
  const result = {
    ...proof,
    finishedAt: new Date().toISOString(),
    outcomes,
    browserErrors,
    outsideRequests,
    browserWrites,
    sourceManifest: join(fixture.root, 'source-manifest.json'),
    categoryFamilies,
    shopProfiles,
    limitations: [
      'Category families are synthetic source labels, not live Shopee category capability.',
      'Price profiles are explicitly selected per input batch. Folder intake does not assign a separate destination shop/category to every folder.',
      'This acceptance persists 80 source folders; it does not claim 80 completed listing drafts or remote create/update.',
      'Three separate subset source drafts and destination WorkOrders are saved locally. They are not an 80-draft acceptance or multi-shop remote execution.',
      'The product editor/API has no category routing input and does not copy workbook category facts into categoryId; this remains an application gap.',
    ],
  };
  await writeFile(join(fixture.root, 'browser-acceptance.json'), JSON.stringify(result, null, 2));
  await writeFile(
    resolve('.local/acceptance-20260914/bulk-folder-latest.json'),
    JSON.stringify({ evidenceRoot: fixture.root, ...result }, null, 2),
  );
  if (!server) return;
  if (server.exitCode !== null || server.signalCode !== null)
    throw new Error('Isolated fixture exited unexpectedly before cleanup.');
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      server.kill();
      fail(new Error('Isolated bulk folder cleanup exceeded 25 seconds.'));
    }, 25000);
    server.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) done();
      else fail(new Error(`Cleanup failed: ${code}/${signal}`));
    });
    server.send('stop');
  });
});
async function json<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(baseURL + path);
  expect(response.ok(), path + ' should return a successful real API response').toBe(true);
  return response.json();
}
async function snapshot(): Promise<any> {
  const requestId = randomUUID();
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Database snapshot timed out')), 15000);
    const receive = (message: any) => {
      if (message.requestId !== requestId) return;
      clearTimeout(timer);
      server.off('message', receive);
      done(message.snapshot);
    };
    server.on('message', receive);
    server.send({ command: 'snapshot', requestId });
  });
}
async function newIntake(page: Page) {
  await page.goto(baseURL);
  await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Nhập listing theo thư mục', exact: true }),
  ).toBeVisible();
}
async function saved(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu vào Kho đầu vào' })).toBeVisible({
    timeout: 180000,
  });
}
async function reopen(page: Page) {
  await page.goto(baseURL);
  await openInputLibrary(page);
  await page
    .getByTestId('input-batch-row')
    .filter({ hasText: basename(fixture.directory) })
    .getByRole('button', { name: 'Tiếp tục xử lý', exact: true })
    .click();
  await expect(page.getByTestId('folder-row')).toHaveCount(80);
}
async function selectFolder(page: Page, name: string) {
  await page
    .getByTestId('folder-row')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Xem nguồn', exact: true })
    .click();
}
async function chooseProfile(
  page: Page,
  sheet = priceSheet,
  profile: string | null = shopProfiles[0].priceProfile,
) {
  const expand = page.getByRole('button', { name: 'Bảng giá & tệp nguồn', exact: true });
  if (await expand.isVisible()) await expand.click();
  const priceSource = page.getByRole('combobox', { name: 'Bảng giá chung', exact: true });
  if ((await priceSource.inputValue()) !== workbookId) await priceSource.selectOption(workbookId);
  await page.getByRole('combobox', { name: 'Sheet chứa giá', exact: true }).selectOption(sheet);
  await page
    .getByRole('combobox', { name: 'Bộ giá áp dụng', exact: true })
    .selectOption(JSON.stringify(profile));
  const collapse = page.getByRole('button', { name: 'Thu gọn phần chọn nguồn', exact: true });
  if (await collapse.isVisible()) await collapse.click();
}
async function assertOriginals(detail: InputBatchDetail, files: SourceFile[]) {
  expect(detail.state.files).toHaveLength(files.length);
  const actual = new Map(detail.state.files.map((file) => [file.relativePath, file]));
  for (const source of files) {
    const descriptor = actual.get(source.relativePath);
    expect(descriptor, source.relativePath).toBeTruthy();
    expect(descriptor!.sha256, source.relativePath).toBe(source.sha256);
    expect(descriptor!.size, source.relativePath).toBe(source.bytes);
    const imported = detail.imports.find((record) => record.id === descriptor!.importId)!;
    expect(imported, source.relativePath).toBeTruthy();
    expect(imported.sha256).toBe(source.sha256);
    expect(imported.status, source.relativePath).toBe(source.expectedStatus);
    if (source.paragraphs)
      expect((imported.body as { paragraphs: string[] }).paragraphs, source.relativePath).toEqual(
        source.paragraphs,
      );
    expect(
      sha256(await readFile(source.path)),
      'Original disk source has not changed: ' + source.relativePath,
    ).toBe(source.sha256);
  }
}

test('80 real DOCX/image folders and one real three-profile workbook survive worker parsing, separate membership and reload', async ({
  page,
}) => {
  await newIntake(page);
  await page.getByLabel('Tải bảng giá chung', { exact: true }).setInputFiles(fixture.workbook.path);
  await expect(
    page
      .getByRole('combobox', { name: 'Bảng giá chung', exact: true })
      .locator('option')
      .filter({ hasText: basename(fixture.workbook.path) }),
  ).toHaveCount(1, { timeout: 30000 });
  const imports = await json<{ id: string; sha256: string }[]>(page, '/v1/imports');
  workbookId = imports.find((record) => record.sha256 === fixture.workbook.sha256)!.id;
  await chooseProfile(page);
  const workbook = await json<{ body: WorkbookImport }>(page, '/v1/imports/' + workbookId);
  const scoped = workbook.body.rows.filter((row) => row.sheet === priceSheet);
  expect(scoped).toHaveLength(240);
  expect([...new Set(scoped.map((row) => row.category?.value))].sort()).toEqual(
    [...categoryFamilies].sort(),
  );
  for (const shop of shopProfiles) {
    const shared = scoped.filter(
      (row) => row.sku.value === sharedSku && row.priceProfile === shop.priceProfile,
    );
    expect(shared).toHaveLength(1);
    expect(shared[0].originalPrice?.value).toBe(String(shop.price));
    expect(shared[0].promotionTarget?.value).toBe(String(shop.price - 1000));
  }
  const shops = await json<{ scope: { shopId: string }; name: string }[]>(page, '/v1/shops');
  expect(shops.map((shop) => shop.scope.shopId).sort()).toEqual(
    shopProfiles.map((shop) => shop.shopId).sort(),
  );
  await page.getByRole('radio', { name: 'Mỗi thư mục con là một listing', exact: true }).check();
  await page.getByLabel('Chọn thư mục listing', { exact: true }).setInputFiles(fixture.directory);
  await expect(page.getByTestId('folder-row')).toHaveCount(80);
  const started = Date.now();
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  await saved(page);
  proof.bulkReadDurationMs = Date.now() - started;
  await expect(page.getByRole('region', { name: 'Nguồn đã chọn', exact: true })).toContainText(
    '320/320 tệp đã đọc được',
  );
  const batches = await json<{ id: string; folderCount: number }[]>(page, '/v1/input-batches');
  expect(batches).toHaveLength(1);
  batchId = batches[0].id;
  const detail = await json<InputBatchDetail>(page, '/v1/input-batches/' + batchId);
  await assertOriginals(
    detail,
    fixture.folders.flatMap((folder) => folder.files),
  );
  expect(Object.keys(detail.state.productKeys)).toHaveLength(80);
  expect(new Set(Object.values(detail.state.productKeys)).size).toBe(80);
  expect(detail.state.priceSelection).toEqual({
    importId: workbookId,
    sheet: priceSheet,
    priceProfile: shopProfiles[0].priceProfile,
  });
  expect(
    Object.values(detail.state.visual).every(
      (roles) =>
        !roles.coverPath && roles.galleryPaths.length === 0 && roles.descriptionPaths.length === 0,
    ),
  ).toBe(true);
  const copiedImages = [fixture.folders[78].files[3], fixture.folders[79].files[3]].map((source) =>
    detail.state.files.find((file) => file.relativePath === source.relativePath)!,
  );
  expect(copiedImages[0].importId).toBe(copiedImages[1].importId);
  expect(copiedImages[0].relativePath).not.toBe(copiedImages[1].relativePath);
  for (const index of [0, 1, 2, 3, 79]) {
    await selectFolder(page, fixture.folders[index].name);
    const candidate = page.getByTestId('folder-candidate');
    await candidate.getByRole('tab', { name: 'Ảnh trong thư mục', exact: true }).click();
    await expect(candidate.getByRole('checkbox', { name: /^Chọn ảnh/ })).toHaveCount(3);
    await expect(candidate).toContainText('Ảnh bìa: Chưa chọn');
    await expect(candidate).toContainText('Ảnh sản phẩm · 0 ảnh');
    await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
    await expect(candidate).toContainText(fixture.folders[index].files[0].paragraphs![1].trim());
    await expect(candidate).not.toContainText(
      fixture.folders[(index + 1) % 80].files[0].paragraphs![1].trim(),
    );
  }
  await page.screenshot({
    path: join(fixture.root, '80-folders-read-desktop.png'),
    fullPage: false,
  });
  const writesBefore = browserWrites.filter((write) => write === 'POST /v1/imports').length;
  await reopen(page);
  const reopened = await json<InputBatchDetail>(page, '/v1/input-batches/' + batchId);
  expect(reopened.state).toEqual(detail.state);
  expect(browserWrites.filter((write) => write === 'POST /v1/imports')).toHaveLength(writesBefore);
  await selectFolder(page, fixture.folders[79].name);
  await expect(
    page.getByTestId('folder-candidate').getByRole('checkbox', { name: /^Chọn ảnh/ }),
  ).toHaveCount(3);
  const db = await snapshot();
  expect(db.files).toHaveLength(320); // 320 folder files, one duplicate byte body, plus one workbook.
  expect(db.processed).toBe(320);
  expect(db.files.every((file: any) => file.sha256 === file.storedBlobSha256)).toBe(true);
  expect(db.counts).toEqual({ products: 0, work_orders: 0, jobs: 0, connections: 3 });
  expect(db.workerErrors).toEqual([]);
  expect(db.forbiddenFetches).toEqual([]);
  proof.bulk = {
    folderCount: 80,
    sourceFileCount: 320,
    wordCount: 80,
    imageCount: 240,
    independentListingIdentities: 80,
    workbookRows: 242,
    profiles: 3,
    categoryFamilies: 4,
    uniqueStoredFilesIncludingWorkbook: 320,
    exactWordParagraphsVerified: 80,
    exactStoredFileHashesVerified: 320,
    identicalImageMembershipsPreserved: copiedImages,
    reloadWithoutReupload: true,
  };
});

for (const shop of shopProfiles)
  test(`same SKU resolves only the explicit ${shop.priceProfile} source profile and preserves selected Word/image order`, async ({
    page,
  }) => {
    await reopen(page);
    await chooseProfile(page, priceSheet, shop.priceProfile);
    await saved(page);
    await selectFolder(page, fixture.folders[0].name);
    const candidate = page.getByTestId('folder-candidate');
    const prior = await json<InputBatchDetail>(page, '/v1/input-batches/' + batchId);
    const groupKey = Object.keys(prior.state.productKeys).find((key) =>
      key.endsWith(fixture.folders[0].name),
    )!;
    if (!prior.state.visual[groupKey]?.coverPath) {
      await candidate.getByRole('checkbox', { name: 'Chọn ảnh 1.png', exact: true }).check();
      await candidate.getByRole('button', { name: 'Dùng làm ảnh bìa', exact: true }).click();
      await candidate.getByRole('checkbox', { name: 'Chọn ảnh 3.png', exact: true }).check();
      await candidate.getByRole('checkbox', { name: 'Chọn ảnh 2.png', exact: true }).check();
      await candidate.getByRole('button', { name: 'Thêm vào cả hai', exact: true }).click();
    }
    await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
    await candidate.getByText('Cách đọc Word trong bộ nguồn', { exact: true }).click();
    await candidate
      .getByRole('checkbox', { name: 'Dùng cấu trúc Word này cho cả đợt', exact: true })
      .check();
    await saved(page);
    const detail = await json<InputBatchDetail>(page, '/v1/input-batches/' + batchId);
    expect(detail.state.priceSelection?.priceProfile).toBe(shop.priceProfile);
    expect(detail.state.visual[groupKey].galleryPaths.map((path) => basename(path))).toEqual([
      '3.png',
      '2.png',
    ]);
    expect(detail.state.visual[groupKey].descriptionPaths).toEqual(
      detail.state.visual[groupKey].galleryPaths,
    );
    await candidate.getByRole('button', { name: 'Bổ sung SKU/phân loại', exact: true }).click();
    await page.getByRole('radio', { name: /^Một nhóm/ }).check();
    await page.getByLabel('Tên nhóm phân loại 1', { exact: true }).fill('Quy cách nguồn QA');
    await page.getByLabel('SKU dòng 1', { exact: true }).fill(sharedSku);
    await page.getByLabel('Nhãn nhóm 1 dòng 1', { exact: true }).fill(' Gói  12 cái ');
    await page.getByRole('button', { name: 'Tiếp tục: kiểm tra', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: sharedSku });
    await expect(row).toContainText(shop.price.toLocaleString('vi-VN'));
    for (const other of shopProfiles.filter((other) => other !== shop))
      await expect(row).not.toContainText(other.price.toLocaleString('vi-VN'));
    await page
      .getByRole('checkbox', {
        name: 'Tôi đã kiểm tra đủ SKU, đúng tên và thứ tự phân loại của bộ listing này.',
        exact: true,
      })
      .check();
    await page.getByRole('button', { name: 'Tiếp tục: nội dung & ảnh', exact: true }).click();
    await expect(page.getByLabel('Tiêu đề listing', { exact: true })).toHaveValue(
      fixture.folders[0].files[0].paragraphs![1],
    );
    await expect(
      page.getByRole('textbox', { name: 'Câu mở đầu content', exact: true }),
    ).toHaveValue(fixture.folders[0].files[0].paragraphs![3]);
    await page.getByRole('tab', { name: /^SKU & phân loại/ }).click();
    await expect(page.getByLabel('Phân loại 1', { exact: true })).toHaveValue(' Gói  12 cái ');
    await expect(page.getByLabel('Phân loại 1', { exact: true })).not.toBeEditable();
    await page.getByRole('tab', { name: /^Bộ ảnh/ }).click();
    await page.getByRole('tab', { name: /^Ảnh listing/ }).click();
    const images = page
      .getByRole('list', { name: 'Ảnh đã chọn · Ảnh listing', exact: true })
      .getByRole('listitem');
    await expect(images).toHaveCount(2);
    await expect(images.nth(0)).toContainText('3.png');
    await expect(images.nth(1)).toContainText('2.png');
    (proof.profileMappings ??= [] as unknown[]) as unknown[];
    (proof.profileMappings as unknown[]).push({
      fixtureShop: shop,
      sku: sharedSku,
      importedOriginalPrice: String(shop.price),
      selectedPriceProfilePersisted: true,
      exactTitleAndVariantLabel: true,
      imageOrder: ['3.png', '2.png'],
    });
  });

test('duplicate SKU rows remain a source conflict in the chosen scope instead of selecting the first price', async ({
  page,
}) => {
  await reopen(page);
  await chooseProfile(page, conflictSheet, null);
  await saved(page);
  await selectFolder(page, fixture.folders[0].name);
  await page
    .getByTestId('folder-candidate')
    .getByRole('tab', { name: 'Word & nội dung', exact: true })
    .click();
  await page.getByRole('button', { name: 'Bổ sung SKU/phân loại', exact: true }).click();
  await page.getByRole('radio', { name: /^Không có phân loại/ }).check();
  await page.getByLabel('SKU dòng 1', { exact: true }).fill(sharedSku);
  await page.getByRole('button', { name: 'Tiếp tục: kiểm tra', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('có 2 dòng nguồn phù hợp');
  await expect(
    page.getByRole('button', { name: 'Tiếp tục: nội dung & ảnh', exact: true }),
  ).toHaveCount(0);
  expect(
    (await json<InputBatchDetail>(page, '/v1/input-batches/' + batchId)).state.priceSelection,
  ).toEqual({ importId: workbookId, sheet: conflictSheet, priceProfile: null });
  proof.duplicateSku = {
    selectedScope: conflictSheet,
    matchingRows: 2,
    blocked: true,
    firstPriceWasNotChosen: true,
  };
});

test('missing Word and corrupt DOCX/PNG remain isolated while a neighbouring folder parses and both batches reload', async ({
  page,
}) => {
  await newIntake(page);
  await chooseProfile(page);
  await page.getByRole('radio', { name: 'Mỗi thư mục con là một listing', exact: true }).check();
  await page
    .getByLabel('Chọn thư mục listing', { exact: true })
    .setInputFiles(fixture.exceptionDirectory);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  await saved(page);
  await expect(page.getByTestId('folder-row')).toHaveCount(4);
  const batches = await json<{ id: string }[]>(page, '/v1/input-batches');
  expect(batches).toHaveLength(2);
  const exceptionId = batches.find((batch) => batch.id !== batchId)!.id;
  const detail = await json<InputBatchDetail>(page, '/v1/input-batches/' + exceptionId);
  await assertOriginals(detail, fixture.exceptions);
  for (const name of ['01 Missing Word', '02 Corrupt Word']) {
    await selectFolder(page, name);
    await page
      .getByTestId('folder-candidate')
      .getByRole('tab', { name: 'Word & nội dung', exact: true })
      .click();
    await expect(page.getByTestId('folder-candidate')).toContainText(
      'Chưa có tệp Word đọc được trong thư mục.',
    );
  }
  await selectFolder(page, '03 Good Neighbour');
  await page
    .getByTestId('folder-candidate')
    .getByRole('tab', { name: 'Word & nội dung', exact: true })
    .click();
  await expect(page.getByTestId('folder-candidate')).toContainText('QA hàng xóm đọc được');
  await expect(page.getByTestId('folder-candidate')).not.toContainText('QA ảnh lỗi nhưng Word tốt');
  await selectFolder(page, '04 Corrupt Image');
  await page
    .getByTestId('folder-candidate')
    .getByRole('tab', { name: 'Ảnh trong thư mục', exact: true })
    .click();
  await expect(
    page.getByTestId('folder-candidate').getByRole('checkbox', { name: /^Chọn ảnh/ }),
  ).toHaveCount(0);
  await page.screenshot({
    path: join(fixture.root, 'isolated-file-exceptions.png'),
    fullPage: false,
  });
  const before = await snapshot();
  await page.reload();
  await openInputLibrary(page);
  await expect(page.getByTestId('input-batch-row')).toHaveCount(2);
  await page
    .getByTestId('input-batch-row')
    .filter({ hasText: basename(fixture.exceptionDirectory) })
    .getByRole('button', { name: 'Tiếp tục xử lý', exact: true })
    .click();
  await expect(page.getByTestId('folder-row')).toHaveCount(4);
  await assertOriginals(
    await json<InputBatchDetail>(page, '/v1/input-batches/' + exceptionId),
    fixture.exceptions,
  );
  const after = await snapshot();
  expect(after.files).toEqual(before.files);
  expect(after.files.filter((file: any) => file.status === 'failed')).toHaveLength(2);
  expect(after.workerErrors).toEqual([]);
  expect(after.forbiddenFetches).toEqual([]);
  expect(after.counts).toEqual({ products: 0, work_orders: 0, jobs: 0, connections: 3 });
  expect(browserErrors).toEqual([]);
  expect(outsideRequests).toEqual([]);
  expect(
    browserWrites.every((write) => ['POST /v1/imports', 'POST /v1/input-batches'].includes(write)),
  ).toBe(true);
  proof.exceptionIsolation = {
    folders: 4,
    fileCount: 7,
    corruptFilesRetained: 2,
    missingWordRemainsMissing: true,
    healthyNeighbourReady: true,
    reloadPreservedBothBatches: true,
  };
  proof.finalDatabaseCounts = after.counts;
});

test('three separate source drafts retain their own profile prices and real API WorkOrders bind the explicit fixture shops', async ({
  page,
}) => {
  if (!workbookId) {
    await newIntake(page);
    await page
      .getByLabel('Tải bảng giá chung', { exact: true })
      .setInputFiles(fixture.workbook.path);
    await expect(
      page
        .getByRole('combobox', { name: 'Bảng giá chung', exact: true })
        .locator('option')
        .filter({ hasText: basename(fixture.workbook.path) }),
    ).toHaveCount(1, { timeout: 30000 });
    workbookId = (await json<{ id: string; sha256: string }[]>(page, '/v1/imports')).find(
      (file) => file.sha256 === fixture.workbook.sha256,
    )!.id;
  }
  const storedBefore = await snapshot();
  const expectedFileHashes = new Set([
    ...storedBefore.files.map((file: { sha256: string }) => file.sha256),
    ...fixture.folders[0].files.map((file) => file.sha256),
  ]);
  const receipts: {
    batchId: string;
    productKey: string;
    sourceRevision: number;
    workOrderId: string;
    shopId: string;
    priceProfile: string;
    originalPrice: string;
  }[] = [];
  const shops = await json<{ id: string; scope: { shopId: string }; name: string }[]>(
    page,
    '/v1/shops',
  );
  for (const shop of shopProfiles) {
    await newIntake(page);
    await chooseProfile(page, priceSheet, shop.priceProfile);
    // Explicitly select one original folder. All Word and image references stay within it.
    await page
      .getByLabel('Chọn thư mục listing', { exact: true })
      .setInputFiles(join(fixture.directory, fixture.folders[0].name));
    await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
    await saved(page);
    await expect(page.getByTestId('folder-row')).toHaveCount(1);
    const candidate = page.getByTestId('folder-candidate');
    await candidate.getByRole('checkbox', { name: 'Chọn ảnh 1.png', exact: true }).check();
    await candidate.getByRole('button', { name: 'Dùng làm ảnh bìa', exact: true }).click();
    await candidate.getByRole('checkbox', { name: 'Chọn ảnh 3.png', exact: true }).check();
    await candidate.getByRole('checkbox', { name: 'Chọn ảnh 2.png', exact: true }).check();
    await candidate.getByRole('button', { name: 'Thêm vào cả hai', exact: true }).click();
    await candidate.getByRole('tab', { name: 'Word & nội dung', exact: true }).click();
    await candidate.getByText('Cách đọc Word trong bộ nguồn', { exact: true }).click();
    await candidate
      .getByRole('checkbox', { name: 'Dùng cấu trúc Word này cho cả đợt', exact: true })
      .check();
    await saved(page);
    const batches = await json<
      { id: string; name: string; priceSelection: { priceProfile: string } }[]
    >(page, '/v1/input-batches');
    const batch = batches.find(
      (batch) =>
        batch.name === fixture.folders[0].name &&
        batch.priceSelection.priceProfile === shop.priceProfile,
    )!;
    const detail = await json<InputBatchDetail>(page, '/v1/input-batches/' + batch.id);
    expect(detail.state.files).toHaveLength(4);
    const productKey = Object.values(detail.state.productKeys)[0];
    const folderImageIds = new Set(
      detail.state.files.filter((file) => file.name.endsWith('.png')).map((file) => file.importId),
    );
    await candidate.getByRole('button', { name: 'Bổ sung SKU/phân loại', exact: true }).click();
    await page.getByRole('radio', { name: /^Một nhóm/ }).check();
    await page.getByLabel('Tên nhóm phân loại 1', { exact: true }).fill('Quy cách nguồn QA');
    await page.getByLabel('SKU dòng 1', { exact: true }).fill(sharedSku);
    await page.getByLabel('Nhãn nhóm 1 dòng 1', { exact: true }).fill(' Gói  12 cái ');
    await page.getByRole('button', { name: 'Tiếp tục: kiểm tra', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: sharedSku })).toContainText(
      shop.price.toLocaleString('vi-VN'),
    );
    await page
      .getByRole('checkbox', {
        name: 'Tôi đã kiểm tra đủ SKU, đúng tên và thứ tự phân loại của bộ listing này.',
        exact: true,
      })
      .check();
    await page.getByRole('button', { name: 'Tiếp tục: nội dung & ảnh', exact: true }).click();
    await page.getByLabel('Bố trí mô tả trong bộ nguồn').selectOption('headline-images-body');
    const save = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/v1/products',
    );
    await page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first().click();
    expect((await save).ok()).toBe(true);
    const source = await json<ListingDraft>(page, '/v1/products/' + productKey);
    expect(source.revision).toBe(1);
    expect(source.title.value).toBe(fixture.folders[0].files[0].paragraphs![1]);
    expect(source.variants).toHaveLength(1);
    expect(source.variants[0].sku.value).toBe(sharedSku);
    expect(source.variants[0].optionLabels).toEqual([' Gói  12 cái ']);
    expect(source.variants[0].originalPrice.value).toBe(String(shop.price));
    expect(source.variants[0].promotionTarget?.value).toBe(String(shop.price - 1000));
    expect(source.assets.every((asset) => folderImageIds.has(asset.key))).toBe(true);
    expect(source.galleryKeys).toEqual(
      ['3.png', '2.png'].map(
        (name) => detail.state.files.find((file) => file.name === name)!.importId,
      ),
    );
    expect(
      source.description.filter((block) => block.type === 'image').map((block) => block.assetKey),
    ).toEqual(source.galleryKeys);
    const connection = shops.find((connection) => connection.scope.shopId === shop.shopId)!;
    const orderId = randomUUID();
    const request = {
      id: orderId,
      expectedRevision: 0,
      config: {
        productKey,
        sourceRevision: 1,
        connectionId: connection.id,
        operation: 'create',
        itemId: null,
        fieldMask: [],
        stocks: { [sharedSku]: 10 + receipts.length },
      },
    };
    const created = await page.request.post(baseURL + '/v1/work-orders', {
      data: request,
      headers: { Origin: baseURL, 'x-app-client': 'internal-workspace' },
    });
    expect(created.ok()).toBe(true);
    const order = await json<WorkOrderView>(page, '/v1/work-orders/' + orderId);
    expect(order.config).toEqual(request.config);
    expect(order.shop?.name).toBe(shop.name);
    expect(order.shop?.scope.shopId).toBe(shop.shopId);
    expect(order.source.variants[0].originalPrice.value).toBe(String(shop.price));
    expect(order.source.productKey).toBe(productKey);
    // A repeated receipt request must not create another work order.
    const replay = await page.request.post(baseURL + '/v1/work-orders', {
      data: request,
      headers: { Origin: baseURL, 'x-app-client': 'internal-workspace' },
    });
    expect(replay.ok()).toBe(true);
    expect((await replay.json()).id).toBe(orderId);
    receipts.push({
      batchId: batch.id,
      productKey,
      sourceRevision: 1,
      workOrderId: orderId,
      shopId: shop.shopId,
      priceProfile: shop.priceProfile,
      originalPrice: String(shop.price),
    });
  }
  await page.goto(baseURL);
  await expect(page.getByTestId('work-order-row')).toHaveCount(3);
  for (const shop of shopProfiles)
    await expect(page.getByTestId('work-order-row').filter({ hasText: shop.name })).toHaveCount(1);
  await page.screenshot({
    path: join(fixture.root, 'three-local-shop-work-orders.png'),
    fullPage: false,
  });
  const workbench = await json<{ orders: WorkOrderView[] }>(page, '/v1/workbench');
  expect(workbench.orders).toHaveLength(3);
  expect(new Set(workbench.orders.map((order) => order.config.productKey)).size).toBe(3);
  for (const receipt of receipts) {
    const order = workbench.orders.find((order) => order.id === receipt.workOrderId)!;
    expect(order.source.variants[0].originalPrice.value).toBe(receipt.originalPrice);
    expect(order.shop?.scope.shopId).toBe(receipt.shopId);
  }
  const db = await snapshot();
  expect(db.counts).toEqual({ products: 3, work_orders: 3, jobs: 0, connections: 3 });
  expect(db.files).toHaveLength(expectedFileHashes.size);
  expect(db.workerErrors).toEqual([]);
  expect(db.forbiddenFetches).toEqual([]);
  expect(browserErrors).toEqual([]);
  expect(outsideRequests).toEqual([]);
  proof.savedSubset = {
    sourceDraftCount: 3,
    workOrderCount: 3,
    independentProfiles: 3,
    identicalSkuBoundToExplicitShop: true,
    workOrderReplayWithoutDuplicate: true,
    receipts,
  };
  proof.finalDatabaseCounts = db.counts;
});
