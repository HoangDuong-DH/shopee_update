import { test, expect, type Page } from '@playwright/test';

// UI fixtures only: every API request is intercepted, including reads.
// These tests do not prove PostgreSQL reservations or actual Shopee behavior.
const inputId = '33333333-3333-4333-8333-333333333333';
const workbookId = '44444444-4444-4444-8444-444444444444';
const jobId = '55555555-5555-4555-8555-555555555555';
const folderKey = 'Bộ UI fixture/Listing A';
const createdAt = '2026-09-14T09:00:00.000Z';
type State = 'prepared' | 'queued' | 'unknown' | 'verified' | 'cancelled';
type RecordedRequest = { method: string; path: string; body: unknown };

async function installFixture(page: Page, initial: State, dropReconcile = false) {
  const requests: RecordedRequest[] = [],
    unexpected: string[] = [],
    errors: string[] = [];
  let run = {
    id: '66666666-6666-4666-8666-666666666666',
    fingerprint: 'c'.repeat(64),
    operation: 'create',
    createdAt,
    mode: 'simulation',
    state: initial as string,
    issues: [],
    entries: [
      {
        folderKey,
        shopName: 'Shop UI fixture',
        categoryId: '123',
        title: 'Listing nguồn giả lập giao diện',
        skuCount: 2,
        issues: [],
      },
    ],
    items: [
      {
        id: jobId,
        folderKey,
        shopName: 'Shop UI fixture',
        state: initial as string,
        itemId: null as string | null,
        message: '',
        check: null as unknown,
        paused: false,
      },
    ],
  };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      unexpected.push('External request: ' + url.origin);
      return route.abort('blockedbyclient');
    }
    const path = url.pathname;
    if (!path.startsWith('/v1/')) return route.continue();
    const body = method === 'POST' ? request.postDataJSON() : null;
    requests.push({ method, path, body });
    if (method === 'GET' && path === '/v1/prepared-batches/context')
      return route.fulfill({
        json: {
          mode: 'simulation',
          shops: [{ id: 'ui-shop', name: 'Shop UI fixture', shopId: '123' }],
          batches: [{ id: run.id, state: run.state, operation: run.operation, createdAt }],
        },
      });
    if (method === 'GET' && path === '/v1/input-library')
      return route.fulfill({
        json: {
          batches: [
            {
              id: inputId,
              revision: 1,
              name: 'Bộ UI fixture',
              folderCount: 1,
              fileCount: 3,
              completedCount: 1,
              updatedAt: createdAt,
              priceSelection: null,
            },
          ],
          priceBooks: [
            {
              id: workbookId,
              filename: 'Điều phối UI fixture.xlsx',
              status: 'ready',
              bytes: 100,
              rowCount: 2,
              sheetCount: 2,
              issueCount: 0,
              createdAt,
            },
          ],
          unassigned: [],
        },
      });
    if (method === 'GET' && path === '/v1/input-batches/' + inputId)
      return route.fulfill({
        json: {
          id: inputId,
          revision: 1,
          createdAt,
          updatedAt: createdAt,
          imports: [],
          state: {
            version: 1,
            name: 'Bộ UI fixture',
            mode: 'parent_with_listing_folders',
            files: [],
            priceSelection: null,
            visual: {},
            wordPaths: {},
            wordRule: null,
            productKeys: { [folderKey]: 'ui-source-a' },
          },
        },
      });
    if (method === 'GET' && path === '/v1/imports/' + workbookId)
      return route.fulfill({
        json: {
          id: workbookId,
          filename: 'Điều phối UI fixture.xlsx',
          kind: 'xlsx',
          status: 'ready',
          body: { sheets: [{ name: 'Điều phối listing' }, { name: 'Giá' }] },
        },
      });
    if (method === 'GET' && path === '/v1/production-pilot/status')
      return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
    if (method === 'POST' && path === '/v1/prepared-batches/preview') {
      run = {
        ...run,
        id: body.id,
        state: 'prepared',
        items: run.items.map((item) => ({ ...item, state: 'prepared' })),
      };
      return route.fulfill({ json: run });
    }
    if (method === 'GET' && path === '/v1/prepared-batches/' + run.id)
      return route.fulfill({ json: run });
    if (method === 'POST' && path === `/v1/prepared-jobs/${jobId}/control`) {
      if (!['pause', 'resume', 'cancel'].includes(body.action)) {
        unexpected.push('Unsupported control action');
        return route.fulfill({ status: 400, json: { code: 'INVALID_INPUT' } });
      }
      run.items[0] = {
        ...run.items[0]!,
        paused: body.action === 'pause',
        state: body.action === 'cancel' ? 'cancelled' : 'queued',
      };
      run.state =
        body.action === 'cancel' ? 'cancelled' : body.action === 'pause' ? 'paused' : 'queued';
      return route.fulfill({ json: run.items[0] });
    }
    if (method === 'POST' && path === `/v1/prepared-jobs/${jobId}/reconcile`) {
      run.state = 'verified';
      run.items[0] = {
        ...run.items[0]!,
        state: 'verified',
        itemId: 'UI-FIXTURE-001',
        check: { verified: true },
      };
      if (dropReconcile) {
        dropReconcile = false;
        return route.abort('connectionfailed');
      }
      return route.fulfill({ json: run.items[0] });
    }
    if (method === 'GET' && path === '/v1/workbench')
      return route.fulfill({
        json: {
          orders: [],
          sources: [],
          shops: [],
          execution: { productionWrites: false, sandboxUpdates: false, createEnabled: false },
        },
      });
    if (method === 'GET' && path === '/v1/status')
      return route.fulfill({ json: { worker: 'online' } });
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
    unexpected.push(method + ' ' + path);
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return { requests, unexpected, errors, current: () => structuredClone(run) };
}

async function openBatchPage(page: Page) {
  await page.getByRole('button', { name: 'Đăng hàng', exact: true }).click();
  await page.getByText('Công cụ chuẩn bị lô khác', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Thực hiện theo lô', exact: true })).toBeVisible();
  await expect(page.getByText('MÔ PHỎNG · không gửi lên Shopee', { exact: true })).toBeVisible();
}

test('UI fixture: prepared management cancels once, rereads the result and permits another batch', async ({
  page,
}) => {
  const fixture = await installFixture(page, 'prepared');
  await page.goto('/');
  await openBatchPage(page);
  await page.getByLabel('Bộ thư mục Word và ảnh', { exact: true }).selectOption(inputId);
  await page.getByLabel('File Excel điều phối và giá', { exact: true }).selectOption(workbookId);
  await page.getByRole('button', { name: 'Xem trước lô', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Kiểm tra trước khi thực hiện', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Quản lý phần chưa chạy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kết quả của lô', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Hủy ${folderKey}`, exact: true }).click();
  const resultTable = page.getByRole('table', { name: 'Kết quả từng listing' });
  await expect(resultTable).toContainText('Đã dừng');
  await expect(page.getByRole('button', { name: `Hủy ${folderKey}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Chuẩn bị lô khác', exact: true })).toBeEnabled();
  const controlIndex = fixture.requests.findIndex((request) => request.path.endsWith('/control'));
  expect(fixture.requests.filter((request) => request.path.endsWith('/control'))).toEqual([
    { method: 'POST', path: `/v1/prepared-jobs/${jobId}/control`, body: { action: 'cancel' } },
  ]);
  expect(fixture.requests.slice(controlIndex + 1)).toContainEqual({
    method: 'GET',
    path: '/v1/prepared-batches/' + fixture.current().id,
    body: null,
  });
  expect(fixture.requests.some((request) => request.path.endsWith('/submit'))).toBe(false);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('UI fixture: queued pause and resume follow the current row state with a read after each action', async ({
  page,
}) => {
  const fixture = await installFixture(page, 'queued');
  await page.goto('/');
  await openBatchPage(page);
  await page.getByRole('button', { name: 'Mở kết quả', exact: true }).click();
  await page.getByRole('button', { name: `Tạm dừng ${folderKey}`, exact: true }).click();
  await expect(page.getByRole('table', { name: 'Kết quả từng listing' })).toContainText(
    'Đang tạm dừng',
  );
  await page.getByRole('button', { name: `Tiếp tục ${folderKey}`, exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Tạm dừng ${folderKey}`, exact: true }),
  ).toBeEnabled();
  expect(
    fixture.requests
      .filter((request) => request.path.endsWith('/control'))
      .map((request) => request.body),
  ).toEqual([{ action: 'pause' }, { action: 'resume' }]);
  for (const [index, request] of fixture.requests.entries()) {
    if (request.path.endsWith('/control'))
      expect(fixture.requests.slice(index + 1)).toContainEqual({
        method: 'GET',
        path: '/v1/prepared-batches/' + fixture.current().id,
        body: null,
      });
  }
  expect(fixture.requests.some((request) => request.path.endsWith('/submit'))).toBe(false);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('UI fixture: a lost unknown-reconciliation response locks actions and never replays POST after reload', async ({
  page,
}) => {
  const fixture = await installFixture(page, 'unknown', true);
  await page.goto('/');
  await openBatchPage(page);
  await page.getByRole('button', { name: 'Mở kết quả', exact: true }).click();
  await page.getByRole('button', { name: `Đọc đối chiếu ${folderKey}`, exact: true }).click();
  await expect(page.getByText(/Chưa xác nhận thao tác đọc đối chiếu/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Đọc đối chiếu ${folderKey}`, exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Chuẩn bị lô khác', exact: true })).toBeDisabled();
  await page.reload();
  await openBatchPage(page);
  await expect(page.getByRole('heading', { name: 'Kết quả của lô', exact: true })).toBeVisible();
  await expect(page.getByText(/Chưa xác nhận thao tác đọc đối chiếu/)).toBeVisible();
  await page.getByRole('button', { name: 'Đọc lại kết quả', exact: true }).click();
  await expect(page.getByText(/Chưa xác nhận thao tác đọc đối chiếu/)).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Kết quả từng listing' })).toContainText(
    'Đã đối chiếu',
  );
  await expect(page.getByRole('button', { name: 'Chuẩn bị lô khác', exact: true })).toBeEnabled();
  expect(fixture.requests.filter((request) => request.method === 'POST')).toEqual([
    { method: 'POST', path: `/v1/prepared-jobs/${jobId}/reconcile`, body: {} },
  ]);
  expect(
    await page.evaluate(() => sessionStorage.getItem('shopee.prepared-batch.pending-control')),
  ).toBeNull();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
