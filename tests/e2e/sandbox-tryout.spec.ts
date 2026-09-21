import { openWorkspaceTool } from './workspace-navigation.js';
import { test, expect } from '@playwright/test';
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { resolve } from 'node:path';
let server: ChildProcess, url: string;
// Actual browser -> API -> isolated PG; only outbound Shopee fetch is a stateful fixture.
test.beforeAll(async () => {
  server = fork(resolve('tests/e2e/sandbox-tryout-server.mts'), [], {
    execPath: process.execPath,
    execArgv: ['--conditions=development', '--import', 'tsx'],
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve('apps/api/tsconfig.json') },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  } as ForkOptions);
  const ready = await new Promise<any>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error('Isolated sandbox tryout server setup timed out')),
      30000,
    );
    server.on('message', (value: any) => {
      if (value.ready) {
        clearTimeout(timer);
        done(value);
      }
    });
    server.once('exit', (code, signal) => {
      clearTimeout(timer);
      fail(new Error(`Isolated server exited ${code}/${signal}`));
    });
    server.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  });
  url = ready.url;
});
test.afterAll(async () => {
  if (!server) return;
  if (!server.connected || server.exitCode !== null || server.signalCode)
    throw new Error('Fixture server exited unexpectedly before cleanup');
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      server.kill();
      fail(new Error('Fixture cleanup timed out'));
    }, 15000);
    server.once('exit', (code, signal) => {
      clearTimeout(timer);
      code === 0 && !signal ? done() : fail(new Error(`Fixture cleanup failed ${code}/${signal}`));
    });
    server.send('stop');
  });
});
test.beforeEach(async ({ request }) => {
  const response = await request.post(url + '/__fixture/reset', {
    data: {},
    headers: { Origin: url, 'X-App-Client': 'internal-workspace' },
  });
  expect(response.ok(), await response.text()).toBe(true);
});

test('title-only local API workflow preserves the rest and reopening sends no POST', async ({
  page,
  request,
}, testInfo) => {
  const posts: string[] = [],
    errors: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') posts.push(new URL(req.url()).pathname);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await openWorkspaceTool(page, 'Thử sandbox');
  await expect(
    page.getByRole('heading', { name: 'Thử trên shop TEST', exact: true }),
  ).toBeVisible();
  expect(posts).toEqual([]);
  await page.getByRole('button', { name: 'Đọc sản phẩm TEST', exact: true }).click();
  const before = (await (await request.get(url + '/__fixture/state')).json()).current;
  const title = 'SANDBOX QA Tên có nguồn nhập từ giao diện';
  await page.getByLabel('Tiêu đề mới cho mẫu TEST', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Xem trước thay đổi', exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  const execute = page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true });
  await expect(execute).toBeDisabled();
  expect((await (await request.get(url + '/__fixture/state')).json()).writes).toEqual([]);
  await page.getByLabel('Tôi đã xem đúng mẫu TEST và phần sẽ thay đổi.').check();
  await execute.click();
  await expect(page.getByText('Đã đọc lại và đối chiếu', { exact: true })).toBeVisible();
  await expect(page.getByText('Đã đối chiếu giữ nguyên', { exact: true })).toBeVisible();
  const state = await (await request.get(url + '/__fixture/state')).json();
  expect(state.writes).toEqual([
    { path: '/api/v2/product/update_item', body: { item_id: 803935036, item_name: title } },
  ]);
  expect(state.current).toEqual({ ...before, item: { ...before.item, item_name: title } });
  const originalPosts = [...posts];
  await page.reload();
  await openWorkspaceTool(page, 'Thử sandbox');
  await expect(page.getByText('Đã đọc lại và đối chiếu', { exact: true })).toBeVisible();
  expect(posts).toEqual(originalPosts);
  await page.screenshot({
    path: testInfo.outputPath('sandbox-tryout-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sandbox-tryout-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('zero stock is explicit and retains its exact warehouse and all other source values', async ({
  page,
  request,
}) => {
  await page.goto(url);
  await openWorkspaceTool(page, 'Thử sandbox');
  await page.getByRole('button', { name: 'Đọc sản phẩm TEST', exact: true }).click();
  const before = (await (await request.get(url + '/__fixture/state')).json()).current;
  await page.getByLabel('Tồn đăng bán', { exact: true }).check();
  await expect(
    page.getByRole('button', { name: 'Xem trước thay đổi', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Tồn đăng bán mới cho mẫu TEST', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Xem trước thay đổi', exact: true }).click();
  await page.getByLabel('Tôi đã xem đúng mẫu TEST và phần sẽ thay đổi.').check();
  await page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }).click();
  await expect(page.getByText('Đã đọc lại và đối chiếu', { exact: true })).toBeVisible();
  const state = await (await request.get(url + '/__fixture/state')).json();
  expect(state.writes).toEqual([
    {
      path: '/api/v2/product/update_stock',
      body: {
        item_id: 803935036,
        stock_list: [{ model_id: 0, seller_stock: [{ stock: 0, location_id: 'QA-W1' }] }],
      },
    },
  ]);
  before.item.stock_info_v2.seller_stock[0].stock = 0;
  before.item.stock_info_v2.summary_info.total_available_stock = 0;
  expect(state.current).toEqual(before);
});

test('unknown response and reload never replay a write or enable a new test', async ({
  page,
  request,
}) => {
  await request.post(url + '/__fixture/reset', {
    data: { fault: true },
    headers: { Origin: url, 'X-App-Client': 'internal-workspace' },
  });
  const posts: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') posts.push(new URL(req.url()).pathname);
  });
  await page.goto(url);
  await openWorkspaceTool(page, 'Thử sandbox');
  await page.getByRole('button', { name: 'Đọc sản phẩm TEST', exact: true }).click();
  await page
    .getByLabel('Tiêu đề mới cho mẫu TEST', { exact: true })
    .fill('SANDBOX QA Tình huống chưa xác định');
  await page.getByRole('button', { name: 'Xem trước thay đổi', exact: true }).click();
  await page.getByLabel('Tôi đã xem đúng mẫu TEST và phần sẽ thay đổi.').check();
  // The actual local API receives the request; only its browser response is lost.
  await page.route('**/v1/sandbox-field-trials/execute', async (route) => {
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }).click();
  await expect(
    page.getByText('Chưa xác nhận được kết quả lần vừa yêu cầu', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await openWorkspaceTool(page, 'Thử sandbox');
  await expect(page.getByText('Chưa xác định xong kết quả', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chuẩn bị lần thử mới', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Đọc lại kết quả', exact: true }).click();
  expect(posts.filter((path) => path.endsWith('/execute'))).toHaveLength(1);
  expect((await (await request.get(url + '/__fixture/state')).json()).writes).toHaveLength(1);
});

test('lost prepare before insert restores the exact same request only after a user click', async ({
  page,
  request,
}) => {
  const bodies: unknown[] = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/sandbox-field-trials/prepare')) bodies.push(req.postDataJSON());
  });
  await page.goto(url);
  await openWorkspaceTool(page, 'Thử sandbox');
  await page.getByRole('button', { name: 'Đọc sản phẩm TEST', exact: true }).click();
  await page
    .getByLabel('Tiêu đề mới cho mẫu TEST', { exact: true })
    .fill('SANDBOX QA Khôi phục đúng bản xem trước');
  await page.route('**/v1/sandbox-field-trials/prepare', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Xem trước thay đổi', exact: true }).click();
  await expect(
    page.getByText('Chưa xác nhận được kết quả lần vừa yêu cầu', { exact: true }),
  ).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('shopee.sandbox-tryout.receipt.v1')!),
  );
  expect(stored.prepare).toEqual(bodies[0]);
  await page.unroute('**/v1/sandbox-field-trials/prepare');
  await page.reload();
  await openWorkspaceTool(page, 'Thử sandbox');
  await expect(page.getByText(/Chưa tìm thấy biên nhận/)).toBeVisible();
  expect(bodies).toHaveLength(1);
  await page.getByRole('button', { name: 'Khôi phục bản xem trước', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }),
  ).toBeDisabled();
  expect(bodies).toEqual([stored.prepare, stored.prepare]);
  expect((await (await request.get(url + '/__fixture/state')).json()).writes).toEqual([]);
});

test('expired prepared receipt can be cancelled locally before starting a new draft', async ({
  page,
  request,
}) => {
  const posts: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') posts.push(new URL(req.url()).pathname);
  });
  await page.goto(url);
  await openWorkspaceTool(page, 'Thử sandbox');
  await page.getByRole('button', { name: 'Đọc sản phẩm TEST', exact: true }).click();
  await page
    .getByLabel('Tiêu đề mới cho mẫu TEST', { exact: true })
    .fill('SANDBOX QA Bản xem trước hết hạn');
  await page.getByRole('button', { name: 'Xem trước thay đổi', exact: true }).click();
  await page.getByLabel('Tôi đã xem đúng mẫu TEST và phần sẽ thay đổi.').check();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('shopee.sandbox-tryout.receipt.v1')!),
  );
  const expired = await request.post(url + '/__fixture/expire', {
    data: {},
    headers: { Origin: url, 'X-App-Client': 'internal-workspace' },
  });
  expect(expired.ok(), await expired.text()).toBe(true);
  await page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }).click();
  await expect(page.getByText(/Bản xem trước đã hết thời hạn/)).toBeVisible();
  await page.getByRole('button', { name: 'Bỏ bản xem trước', exact: true }).click();
  await expect(page.getByText('Đã bỏ bản xem trước', { exact: true })).toBeVisible();
  const cancelled = await (await request.get(url + '/v1/sandbox-field-trials/' + stored.id)).json();
  expect(cancelled.state).toBe('blocked');
  expect(cancelled.result).toMatchObject({ code: 'DRAFT_CANCELLED', mutationSent: false });
  expect(posts.filter((path) => path.endsWith('/cancel'))).toEqual([
    '/v1/sandbox-field-trials/' + stored.id + '/cancel',
  ]);
  expect((await (await request.get(url + '/__fixture/state')).json()).writes).toEqual([]);
  await page.getByRole('button', { name: 'Chuẩn bị lần thử mới', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đọc sản phẩm TEST', exact: true })).toBeEnabled();
});

test('lost cancellation stays locked across reload until explicit same-receipt cancellation', async ({
  page,
  request,
}) => {
  const cancels: { path: string; body: unknown }[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/cancel'))
      cancels.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() });
  });
  await page.goto(url);
  await openWorkspaceTool(page, 'Thử sandbox');
  await page.getByRole('button', { name: 'Đọc sản phẩm TEST', exact: true }).click();
  await page
    .getByLabel('Tiêu đề mới cho mẫu TEST', { exact: true })
    .fill('SANDBOX QA Bỏ bản nháp có mất kết nối');
  await page.getByRole('button', { name: 'Xem trước thay đổi', exact: true }).click();
  await page.route('**/v1/sandbox-field-trials/*/cancel', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Bỏ bản xem trước', exact: true }).click();
  await expect(
    page.getByText('Chưa xác nhận được kết quả lần vừa yêu cầu', { exact: true }),
  ).toBeVisible();
  await page.unroute('**/v1/sandbox-field-trials/*/cancel');
  await page.reload();
  await openWorkspaceTool(page, 'Thử sandbox');
  await expect(
    page.getByRole('button', { name: 'Hoàn tất bỏ bản xem trước', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Chuẩn bị lần thử mới', exact: true })).toHaveCount(
    0,
  );
  expect(cancels).toHaveLength(1);
  await page.getByRole('button', { name: 'Hoàn tất bỏ bản xem trước', exact: true }).click();
  await expect(page.getByText('Đã bỏ bản xem trước', { exact: true })).toBeVisible();
  expect(cancels).toEqual([cancels[0], cancels[0]]);
  expect((await (await request.get(url + '/__fixture/state')).json()).writes).toEqual([]);
});
