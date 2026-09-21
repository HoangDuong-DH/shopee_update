import { createHash, randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

// Browser fixtures only. All API calls are intercepted; no Shopee or main DB writes occur.
const createdAt = '2026-09-15T10:00:00.000Z';
const workbookId = 'e4ce8a97-87f7-47b1-aa53-cb848a18972d';
const savedId = 'f7e0993e-d82a-4160-b04e-f0f0fb039f72';
type FixtureOptions = {
  failLibrary?: boolean;
  holdLibrary?: boolean;
  loseSave?: boolean;
  failSource?: boolean;
  failedImage?: boolean;
  existing?: boolean;
  noDispatch?: boolean;
  rejectSave?: boolean;
  templateFailure?: boolean;
};

async function fixture(page: Page, options: FixtureOptions = {}) {
  const writes: { path: string; body: any }[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  const books: any[] = [];
  const records = new Map<string, any>();
  const batches: any[] = [];
  let failLibrary = !!options.failLibrary;
  let failSource = !!options.failSource;
  let loseSave = !!options.loseSave;
  let release: () => void = () => {};
  const held = options.holdLibrary
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  if (options.existing) {
    batches.push({
      id: savedId,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      imports: [],
      state: {
        version: 1,
        name: 'Đợt đã lưu',
        mode: 'parent_with_listing_folders',
        files: [],
        priceSelection: null,
        visual: {},
        wordPaths: {},
        wordRule: null,
        productKeys: { 'Đợt đã lưu/Can 5L': 'fixture-listing' },
      },
    });
    books.push({
      id: workbookId,
      filename: 'Điều phối đã lưu.xlsx',
      status: 'ready',
      createdAt,
      bytes: 12,
      rowCount: 1,
      sheetCount: 2,
      issueCount: 0,
    });
    records.set(workbookId, {
      id: workbookId,
      filename: options.noDispatch ? 'FILE GIÁ DORIS.xlsx' : 'Điều phối đã lưu.xlsx',
      kind: 'xlsx',
      status: 'ready',
      body: {
        sheets: options.noDispatch
          ? [{ name: 'FILE GIÁ DORIS' }]
          : [{ name: 'Điều phối listing' }, { name: 'Giá' }],
      },
    });
  }
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      unexpected.push(url.origin);
      return route.abort('blockedbyclient');
    }
    if (!path.startsWith('/v1/')) return route.continue();
    if (path === '/v1/prepared-batches/context')
      return route.fulfill({ json: { mode: 'unavailable', shops: [], batches: [] } });
    if (path === '/v1/production-pilot/status')
      return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
    if (path === '/v1/status') return route.fulfill({ json: { worker: 'online' } });
    if (path === '/v1/workbench')
      return route.fulfill({ json: { orders: [], sources: [], shops: [], execution: {} } });
    if (path === '/v1/input-library') {
      await held;
      if (failLibrary) {
        failLibrary = false;
        return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
      }
      return route.fulfill({
        json: {
          priceBooks: books,
          batches: batches.map((batch) => ({
            id: batch.id,
            revision: batch.revision,
            name: batch.state.name,
            updatedAt,
            folderCount: Object.keys(batch.state.productKeys).length,
            fileCount: batch.state.files.length,
            completedCount: 0,
            priceSelection: null,
          })),
          unassigned: [],
        },
      });
    }
    if (path === '/v1/imports' && method === 'POST') {
      const filename = decodeURIComponent(request.headers()['x-file-name']!);
      const bytes = request.postDataBuffer()!;
      const kind = filename.endsWith('.xlsx')
        ? 'xlsx'
        : filename.endsWith('.docx')
          ? 'docx'
          : 'image';
      const id = kind === 'xlsx' ? workbookId : randomUUID();
      const record = {
        id,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        filename,
        kind,
        bytes: bytes.length,
        createdAt,
        status: options.failedImage && kind === 'image' ? 'failed' : 'ready',
        message: options.failedImage && kind === 'image' ? 'Ảnh không đọc được.' : '',
        body:
          kind === 'xlsx'
            ? { sheets: [{ name: 'Điều phối listing' }, { name: 'Giá' }], rows: [] }
            : kind === 'docx'
              ? { paragraphs: ['TIÊU ĐỀ', 'Can 5L', 'BÀI MÔ TẢ ĐĂNG BÁN', 'Nội dung fixture'] }
              : { width: 100, height: 100 },
      };
      records.set(id, record);
      writes.push({ path, body: { filename, sha256: record.sha256 } });
      if (kind === 'xlsx') books.push({ ...record, rowCount: 1, sheetCount: 2, issueCount: 0 });
      return route.fulfill({ json: record });
    }
    if (path.startsWith('/v1/imports/'))
      return route.fulfill({ json: records.get(path.split('/').at(-1)!) });
    if (path === '/v1/input-batches' && method === 'POST') {
      const body = request.postDataJSON();
      writes.push({ path, body });
      if (options.rejectSave)
        return route.fulfill({ status: 422, json: { code: 'INPUT_BATCH_PATH_INVALID' } });
      let saved = batches.find((batch) => batch.id === body.id);
      if (!saved) {
        saved = {
          id: body.id,
          revision: 1,
          state: body.state,
          createdAt,
          updatedAt: createdAt,
          imports: [...records.values()],
        };
        batches.push(saved);
      }
      if (loseSave) {
        loseSave = false;
        return route.abort('connectionfailed');
      }
      return route.fulfill({ json: saved });
    }
    if (path.startsWith('/v1/input-batches/')) {
      if (failSource) {
        failSource = false;
        return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
      }
      return route.fulfill({ json: batches.find((batch) => batch.id === path.split('/').at(-1)) });
    }
    if (path === '/v1/prepared-batches/template' && options.templateFailure)
      return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
    if (path === '/v1/prepared-batches/template')
      return route.fulfill({
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: Buffer.from('fixture-download-only'),
      });
    if (
      method === 'GET' &&
      [
        '/v1/imports',
        '/v1/source-catalogs',
        '/v1/products',
        '/v1/shops',
        '/v1/plans',
        '/v1/jobs',
        '/v1/import-patches',
      ].includes(path)
    )
      return route.fulfill({ json: [] });
    unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return { writes, unexpected, pageErrors, release, batches };
}
const updatedAt = createdAt;
async function open(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Đăng hàng', exact: true }).click();
  await page.getByText('Công cụ chuẩn bị lô khác', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Nhận nguồn cho lô này', exact: true }),
  ).toBeVisible();
}
async function chooseFolder(
  page: Page,
  paths = ['Đợt mới/Can 5L/Noi_dung.docx', 'Đợt mới/Can 5L/Anh/bia.png'],
) {
  await page.getByLabel('Chọn thư mục nguồn cho lô', { exact: true }).evaluate((element, names) => {
    const transfer = new DataTransfer();
    names.forEach((path, i) => {
      const file = new File([`local-source-${i}`], path.split('/').at(-1)!, {
        type: path.endsWith('.docx')
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'image/png',
      });
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      transfer.items.add(file);
    });
    (element as HTMLInputElement).files = transfer.files;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, paths);
}

test('intake distinguishes loading and empty sources and provides direct actions', async ({
  page,
}) => {
  const f = await fixture(page, { holdLibrary: true });
  await open(page);
  await expect(page.getByLabel('Bộ thư mục Word và ảnh', { exact: true })).toHaveText(
    'Đang tải đợt nhập…',
  );
  await expect(page.getByText('Chưa có đợt thư mục đã lưu', { exact: true })).toHaveCount(0);
  f.release();
  await expect(page.getByText('Chưa có đợt thư mục đã lưu.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Bộ thư mục Word và ảnh', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Nhập thư mục Word và ảnh', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Nhập Excel điều phối', exact: true }),
  ).toBeEnabled();
  await expect(page.getByText('File cần có sheet', { exact: false })).toContainText(
    'phiếu bàn giao hai sheet chưa đủ',
  );
  expect(f.writes).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

test('failed source listing is an error rather than empty and reload recovers saved choices', async ({
  page,
}) => {
  const f = await fixture(page, { failLibrary: true, existing: true });
  await open(page);
  await expect(page.getByText('Không tải được danh sách nguồn.', { exact: true })).toBeVisible();
  await expect(page.getByText('Chưa có đợt thư mục đã lưu', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Thử tải nguồn lại', exact: true }).click();
  await expect(page.getByLabel('Bộ thư mục Word và ảnh', { exact: true })).toContainText(
    'Đợt đã lưu',
  );
  expect(f.unexpected).toEqual([]);
});

test('direct folder and workbook intake saves real returned sources and selects them without leaving the page', async ({
  page,
}) => {
  const f = await fixture(page);
  await open(page);
  await expect(
    page.getByRole('button', { name: 'Nhập thư mục Word và ảnh', exact: true }),
  ).toBeEnabled();
  await chooseFolder(page);
  await expect(
    page.getByText('Đã lưu 1 thư mục vào đợt “Đợt mới”.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Bộ thư mục Word và ảnh', { exact: true })).toHaveValue(
    f.batches[0].id,
  );
  await page.getByLabel('Chọn Excel điều phối cho lô', { exact: true }).setInputFiles({
    name: 'Dieu-phoi.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('fixture-workbook'),
  });
  await expect(page.getByLabel('File Excel điều phối và giá', { exact: true })).toHaveValue(
    workbookId,
  );
  await expect(page.getByRole('button', { name: 'Xem trước lô', exact: true })).toBeEnabled();
  const saves = f.writes.filter((write) => write.path === '/v1/input-batches');
  expect(saves).toHaveLength(1);
  expect(saves[0].body.state.files.map((file: any) => file.relativePath)).toEqual([
    'Đợt mới/Can 5L/Noi_dung.docx',
    'Đợt mới/Can 5L/Anh/bia.png',
  ]);
  expect(saves[0].body.state.visual).toEqual({});
  expect(saves[0].body.state.priceSelection).toBeNull();
  expect(f.writes.every((write) => ['/v1/input-batches', '/v1/imports'].includes(write.path))).toBe(
    true,
  );
  await page.screenshot({
    path: '.local/e2e-artifacts/prepared-intake-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '.local/e2e-artifacts/prepared-intake-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  expect(f.pageErrors).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

test('lost save response retains one immutable request and does not upload files again', async ({
  page,
}) => {
  const f = await fixture(page, { loseSave: true });
  await open(page);
  await expect(
    page.getByRole('button', { name: 'Nhập thư mục Word và ảnh', exact: true }),
  ).toBeEnabled();
  await chooseFolder(page);
  await expect(
    page.getByRole('button', { name: 'Kiểm tra và lưu tiếp đợt này', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Nhập thư mục Word và ảnh', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Kiểm tra và lưu tiếp đợt này', exact: true }).click();
  await expect(
    page.getByText('Đã lưu 1 thư mục vào đợt “Đợt mới”.', { exact: false }),
  ).toBeVisible();
  const saves = f.writes.filter((write) => write.path === '/v1/input-batches');
  expect(saves).toHaveLength(2);
  expect(saves[0].body).toEqual(saves[1].body);
  expect(f.writes.filter((write) => write.path === '/v1/imports')).toHaveLength(2);
  expect(f.batches).toHaveLength(1);
  expect(f.unexpected).toEqual([]);
});

test('unreadable image remains an explicit source issue instead of a successful complete listing', async ({
  page,
}) => {
  const f = await fixture(page, { failedImage: true });
  await open(page);
  await expect(
    page.getByRole('button', { name: 'Nhập thư mục Word và ảnh', exact: true }),
  ).toBeEnabled();
  await chooseFolder(page);
  await expect(
    page.getByText('1 tệp cần kiểm tra trước khi xem trước.', { exact: false }),
  ).toBeVisible();
  expect(f.batches[0].state.files[1].error).toBe('Ảnh không đọc được.');
  expect(f.unexpected).toEqual([]);
});

test('selected batch read failure has an inline retry and preserves selected workbook', async ({
  page,
}) => {
  const f = await fixture(page, { existing: true, failSource: true });
  await open(page);
  await page.getByLabel('File Excel điều phối và giá', { exact: true }).selectOption(workbookId);
  await page.getByLabel('Bộ thư mục Word và ảnh', { exact: true }).selectOption(savedId);
  await expect(page.getByText('Chưa đọc được đợt đã chọn.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Xem trước lô', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Đọc lại đợt đã chọn', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xem trước lô', exact: true })).toBeEnabled();
  await expect(page.getByLabel('File Excel điều phối và giá', { exact: true })).toHaveValue(
    workbookId,
  );
  expect(f.unexpected).toEqual([]);
});

test('wrong parent-folder level is rejected before uploads', async ({ page }) => {
  const f = await fixture(page);
  await open(page);
  await expect(
    page.getByRole('button', { name: 'Nhập thư mục Word và ảnh', exact: true }),
  ).toBeEnabled();
  await chooseFolder(page, ['Can 5L/Noi_dung.docx']);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Tệp nằm trực tiếp trong thư mục cha' }),
  ).toBeVisible();
  expect(f.writes).toEqual([]);
});

test('template download is explicit and does not change selected source', async ({ page }) => {
  const f = await fixture(page, { existing: true });
  await open(page);
  await page.getByLabel('File Excel điều phối và giá', { exact: true }).selectOption(workbookId);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Tải mẫu điều phối', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('Mau-dieu-phoi-listing.xlsx');
  await expect(page.getByLabel('File Excel điều phối và giá', { exact: true })).toHaveValue(
    workbookId,
  );
  expect(f.writes).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

test('a pricebook without the dispatch sheet never enables batch preview', async ({ page }) => {
  const f = await fixture(page, { existing: true, noDispatch: true });
  await open(page);
  await page.getByLabel('Bộ thư mục Word và ảnh', { exact: true }).selectOption(savedId);
  await page.getByLabel('File Excel điều phối và giá', { exact: true }).selectOption(workbookId);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Excel này chưa có sheet Điều phối listing' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Xem trước lô', exact: true })).toBeDisabled();
  expect(f.writes).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

test('definitive intake validation rejection does not trap the user in an endless uncertain retry', async ({
  page,
}) => {
  const f = await fixture(page, { rejectSave: true });
  await open(page);
  await expect(
    page.getByRole('button', { name: 'Nhập thư mục Word và ảnh', exact: true }),
  ).toBeEnabled();
  await chooseFolder(page);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Cấu trúc thư mục chưa hợp lệ' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Nhập thư mục Word và ảnh', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Kiểm tra và lưu tiếp đợt này', exact: true }),
  ).toHaveCount(0);
  expect(f.batches).toHaveLength(0);
  expect(f.unexpected).toEqual([]);
});

test('template endpoint failure is visible without dropping existing selections', async ({
  page,
}) => {
  const f = await fixture(page, { existing: true, templateFailure: true });
  await open(page);
  await page.getByLabel('File Excel điều phối và giá', { exact: true }).selectOption(workbookId);
  await page.getByRole('button', { name: 'Tải mẫu điều phối', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Chưa tải được mẫu điều phối' }),
  ).toBeVisible();
  await expect(page.getByLabel('File Excel điều phối và giá', { exact: true })).toHaveValue(
    workbookId,
  );
  expect(f.writes).toEqual([]);
  expect(f.unexpected).toEqual([]);
});
