import { test, expect, type Page } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { openWorkspaceTool } from './workspace-navigation.js';

type Shop = { id: string; name: string; scope: { environment: string; partnerId: string; shopId: string } };
let server: ChildProcess, baseURL: string, apiURL: string, evidenceRoot: string;
let fixture: { shops: Shop[]; preparationIds: Record<string, string[]>; archiveId: string; archiveItemId: string; archiveContentHash: string; productKey: string };
const results: { title: string; status: string; durationMs: number }[] = [];
const outside: string[] = [];
const apiRequests: { path: string; method: string; partnerId: string | null; shopId: string | null }[] = [];

function ipc(message: Record<string, unknown>) {
  return new Promise<any>((done, fail) => {
    const requestId = randomUUID(), timer = setTimeout(() => { server.off('message', receive); fail(Error('WORKSPACE_FIXTURE_CONTROL_TIMEOUT')); }, 10000);
    const receive = (value: any) => {
      if (value.requestId !== requestId) return;
      clearTimeout(timer); server.off('message', receive);
      value.error ? fail(Error(value.error)) : done(value);
    };
    server.on('message', receive); server.send({ ...message, requestId });
  });
}
const control = (action: string, extra: Record<string, unknown> = {}) => ipc({ command: 'workspace-control', action, ...extra });
const key = (shop: Shop) => `${shop.scope.partnerId}:${shop.scope.shopId}`;
const primary = (page: Page) => page.getByRole('navigation', { name: 'Điều hướng chính', exact: true });
const heldMetric = (page: Page) => page.getByRole('button', { name: /^Đợt chuẩn bị cần xử lý/ }).locator('strong');

test.beforeAll(async () => {
  const database = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/invalid');
  if (process.env.INTERNAL_ISOLATED_MODE !== '1' || database.hostname !== '127.0.0.1' || database.port !== '5443'
    || database.pathname !== '/shopee_internal_test' || database.username !== 'shopee_internal') throw Error('WORKSPACE_ACCEPTANCE_ISOLATION_REQUIRED');
  server = fork(resolve('tests/e2e/internal-acceptance-server.mts'), [], {
    execArgv: ['--import', './scripts/internal-network-guard.mjs', '--conditions=development', '--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve('apps/api/tsconfig.json'), WORKSPACE_BROWSER_ACCEPTANCE: '1' },
  } as any);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => { server.kill(); fail(Error('Workspace fixture startup timed out')); }, 45000);
    server.on('message', (message: any) => {
      if (message.ready) { clearTimeout(timer); baseURL = message.baseURL; apiURL = message.apiURL;
        evidenceRoot = message.root; fixture = message.workspaceFixture; done(); }
      else if (message.error) { clearTimeout(timer); fail(Error(message.error)); }
    });
    server.once('exit', code => { clearTimeout(timer); fail(Error('Workspace fixture exited ' + code)); });
    server.stderr?.on('data', bytes => process.stderr.write(bytes));
  });
});
test.beforeEach(async ({ page }) => {
  await control('reset');
  page.setDefaultTimeout(15000);
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) outside.push(url.origin);
    if (url.pathname.startsWith('/v1/')) apiRequests.push({ path: url.pathname, method: request.method(),
      partnerId: url.searchParams.get('partnerId'), shopId: url.searchParams.get('shopId') });
  });
});
test.afterEach(async ({ page }, info) => {
  results.push({ title: info.title, status: info.status ?? 'unknown', durationMs: info.duration });
  if (info.status !== info.expectedStatus && evidenceRoot) {
    const slug = info.title.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 90);
    await writeFile(resolve(evidenceRoot, slug + '.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: resolve(evidenceRoot, slug + '.png'), fullPage: true });
  }
});
test.afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  try {
    await control('reset');
    const final = (await ipc({ command: 'snapshot' })).snapshot;
    await writeFile(resolve(evidenceRoot, 'product-workspace-evidence.json'), JSON.stringify({
      results, outside, apiRequests, schema: final.schema, actualShopeeRequests: final.actualShopeeRequests,
      realUIAPI: true, realIsolatedPostgreSQL: true, transportFixtureOnly: true,
      fixtureControls: 'Synthetic DB rows and selective query failures; no UI response fulfillment.',
      storedSources: final.products.map((draft: any) => ({ productKey: draft.productKey, revision: draft.revision })),
      fixturePlatformCallsAfterSetup: final.fixtureCalls.length, errors: final.errors,
    }, null, 2));
    expect(final.products).toHaveLength(1);
    expect(final.products[0]).toMatchObject({ productKey: fixture.productKey, revision: 1 });
    expect(final.fixtureCalls).toEqual([]);
    expect(final.errors).toEqual([]);
    expect(outside).toEqual([]);
  } finally {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => { server.kill(); fail(Error('Workspace fixture cleanup timed out')); }, 20000);
      server.once('exit', code => { clearTimeout(timer); code === 0 ? done() : fail(Error('Workspace fixture cleanup failed')); });
      server.send('stop');
    });
  }
});

test('four primary tasks navigate by URL, survive reload and follow browser Back', async ({ page }) => {
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Hôm nay cần xử lý gì?', exact: true })).toBeVisible();
  const nav = primary(page);
  await expect(nav.getByRole('button')).toHaveCount(4);
  const from = apiRequests.length;
  const libraryReply = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/local-library/products');
  await nav.getByRole('button', { name: 'Bộ listing', exact: true }).click();
  await expect(page).toHaveURL(/page=products/);
  const library = await (await libraryReply).json();
  expect(library.items.map((row: any) => row.productKey)).toEqual([fixture.productKey]);
  expect(library.items[0]).toMatchObject({ title: 'Bộ nguồn QA từ file', variantCount: 1, galleryCount: 1 });
  await expect(page.getByText('Bộ nguồn QA từ file', { exact: true }).first()).toBeVisible();
  expect(apiRequests.slice(from).filter(request => request.path === '/v1/products')).toEqual([]);
  for (const [name, destination] of [['Đăng hàng', 'prepared-batches'], ['Shop', 'shops']] as const) {
    await nav.getByRole('button', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp('page=' + destination));
  }
  await page.goBack();
  await expect(page).toHaveURL(/page=prepared-batches/);
  await expect(page.getByLabel('Đăng vào shop', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/page=products/);
  await expect(page.getByText('Bộ nguồn QA từ file', { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/page=products/);
  await expect(page.getByText('Bộ nguồn QA từ file', { exact: true }).first()).toBeVisible();
  await nav.getByRole('button', { name: 'Tổng quan', exact: true }).click();
  await expect(page).toHaveURL(/page=overview/);
  await expect(page.getByRole('region', { name: 'Tóm tắt từ dữ liệu đã lưu', exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(evidenceRoot, 'product-workspace-desktop.png'), fullPage: true });
});

test('shop selection is explicit and an unknown selected connection never falls back', async ({ page }) => {
  await page.goto(baseURL + '/?page=prepared-batches');
  const selected = page.getByLabel('Đăng vào shop', { exact: true });
  await expect(selected).toHaveValue('');
  await expect(page.getByText('Ứng dụng không tự chọn một shop thay thế.', { exact: false })).toBeVisible();
  await expect(selected.locator('option')).toHaveCount(3); // prompt and two production shops, no sandbox target
  const second = fixture.shops[1]!;
  await selected.selectOption(key(second));
  await expect(selected).toHaveValue(key(second));
  await expect(page.getByRole('region', { name: 'Shop đích đang chọn', exact: true })).toContainText(second.scope.shopId);
  await control('second-shop-unknown');
  const from = apiRequests.length;
  await page.reload();
  await expect(selected).toHaveValue(key(second));
  await expect(page.getByRole('alert').filter({ hasText: 'Các đợt của shop khác không được dùng thay' })).toBeVisible();
  expect(apiRequests.slice(from).filter(request => request.path.startsWith('/v1/production-batches')
    || request.path === '/v1/production-preparations/context')).toEqual([]);
});

test('overview counts and the continue action stay bound to the selected shop in both scopes', async ({ page }) => {
  await page.goto(baseURL + '/?page=overview');
  const scope = page.getByRole('combobox', { name: /^Phạm vi công việc/ });
  const first = fixture.shops[0]!, second = fixture.shops[1]!;
  for (const [shop, count] of [[first, '1'], [second, '2']] as const) {
    const reply = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/v1/operations/overview' && url.searchParams.get('shopId') === shop.scope.shopId;
    });
    await scope.selectOption(JSON.stringify(shop.scope));
    const data = await (await reply).json();
    expect(data.scope).toEqual(shop.scope);
    expect(data.counts.batches.data.held).toBe(Number(count));
    expect(data.connections.data.items.map((row: any) => row.scope.shopId)).toEqual([shop.scope.shopId]);
    await expect(heldMetric(page)).toHaveText(count);
  }
  const contextReply = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/v1/production-preparations/context' && url.searchParams.get('shopId') === second.scope.shopId;
  });
  await page.getByRole('button', { name: 'Mở đợt đăng đang làm', exact: true }).click();
  await expect(page).toHaveURL(/page=prepared-batches/);
  await expect(page.getByLabel('Đăng vào shop', { exact: true })).toHaveValue(key(second));
  const context = await (await contextReply).json();
  expect(context.scope).toMatchObject(second.scope);
  expect(context.preparations.map((row: any) => row.id).sort()).toEqual([...fixture.preparationIds[second.scope.shopId]!].sort());
  expect(context.preparations.some((row: any) => fixture.preparationIds[first.scope.shopId]!.includes(row.id))).toBe(false);
  const firstContextReply = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/v1/production-preparations/context' && url.searchParams.get('shopId') === first.scope.shopId;
  });
  await page.getByLabel('Đăng vào shop', { exact: true }).selectOption(key(first));
  const firstContext = await (await firstContextReply).json();
  expect(firstContext.scope).toMatchObject(first.scope);
  expect(firstContext.preparations.map((row: any) => row.id).sort()).toEqual([...fixture.preparationIds[first.scope.shopId]!].sort());
  expect(firstContext.preparations.some((row: any) => fixture.preparationIds[second.scope.shopId]!.includes(row.id))).toBe(false);
});

test('a failed system-status resource leaves saved sources usable and can be retried', async ({ page }) => {
  await control('fail-resource', { resource: 'status', enabled: true });
  await page.goto(baseURL + '/?page=products');
  const failure = page.getByRole('alert').filter({ hasText: 'Tình trạng hệ thống chưa được cập nhật' });
  await expect(failure).toBeVisible();
  await expect(page.getByText('Bộ nguồn QA từ file', { exact: true }).first()).toBeVisible();
  await control('fail-resource', { resource: 'status', enabled: false });
  await failure.getByRole('button', { name: 'Tải lại mục này', exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(page.getByText('Bộ nguồn QA từ file', { exact: true }).first()).toBeVisible();
});

test('an unavailable database count remains unknown while other local counts stay visible', async ({ page }) => {
  await control('fail-resource', { resource: 'draft-count', enabled: true });
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/v1/operations/overview');
  await page.goto(baseURL + '/?page=overview');
  const data = await (await response).json();
  expect(data.counts.drafts).toMatchObject({ state: 'unavailable', data: null, code: 'OPERATIONS_DRAFTS_UNAVAILABLE' });
  expect(data.counts.batches.data.held).toBe(3);
  const sources = page.getByRole('button', { name: /^Bộ nguồn đã lưu/ }).locator('strong');
  await expect(sources).toHaveText('—');
  await expect(heldMetric(page)).toHaveText('3');
  await expect(page.getByText('OPERATIONS_DRAFTS_UNAVAILABLE', { exact: true })).toBeAttached();
  await control('fail-resource', { resource: 'draft-count', enabled: false });
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(sources).toHaveText('1');
});

test('archive navigation retains real stored evidence and connection metadata uses the actual API port', async ({ page }) => {
  await page.goto(baseURL + '/?page=overview');
  await openWorkspaceTool(page, 'Kho sao chép');
  await expect(page).toHaveURL(/page=archives/);
  await expect(page.getByRole('heading', { name: 'Kho nguồn để sao chép', exact: true })).toBeVisible();
  const archiveReply = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith('/items/' + fixture.archiveItemId));
  await page.getByRole('button', { name: /^Xịt mũ bảo hiểm QA lưu trữ/ }).click();
  const evidence = await (await archiveReply).json();
  expect(evidence).toMatchObject({ sourceShopId: fixture.shops[0]!.scope.shopId, itemStatus: 'UNLIST', contentHash: fixture.archiveContentHash,
    canCopyNow: false, copyReadiness: 'blocked' });
  await expect(page.getByText('UNLIST', { exact: true })).toBeVisible();
  await primary(page).getByRole('button', { name: 'Shop', exact: true }).click();
  const second = fixture.shops[1]!;
  await page.getByRole('button', { name: new RegExp('^' + second.name) }).click();
  const detail = page.getByRole('complementary', { name: 'Chi tiết kết nối ' + second.name, exact: true });
  const metadataReply = page.waitForResponse(reply => {
    const url = new URL(reply.url());
    return url.pathname === '/v1/connections/production' && url.searchParams.get('shopId') === second.scope.shopId;
  });
  await detail.getByRole('button', { name: 'Quản lý kết nối', exact: true }).click();
  const metadata = await (await metadataReply).json();
  expect(metadata).toMatchObject({ partnerId: second.scope.partnerId, shopId: second.scope.shopId });
  const callback = new URL(metadata.authorizationCallbackUrl);
  expect(callback.port).toBe(new URL(apiURL).port);
  expect(callback.pathname).toBe('/v1/connections/production-pilot/callback');
  expect(callback.port).not.toBe('4310');
  await expect(page.getByRole('region', { name: 'Chi tiết kết nối đang mở', exact: true }).getByLabel('Shop ID', { exact: true })).toHaveValue(second.scope.shopId);
  await page.screenshot({ path: resolve(evidenceRoot, 'product-workspace-shops.png'), fullPage: true });
  const invalidResult = await page.goto(`${apiURL}/v1/connections/production-pilot/authorization-result/${randomUUID()}`);
  expect(invalidResult!.status()).toBe(400);
  const returnLink = page.getByRole('link', { name: /^Quay lại ứng dụng/ });
  const destination = new URL((await returnLink.getAttribute('href'))!);
  expect(destination.origin).toBe(baseURL);
  expect(destination.searchParams.get('page')).toBe('shops');
  expect(destination.port).not.toBe('5173');
  await returnLink.click();
  await expect(page).toHaveURL(baseURL + '/?page=shops');
  await expect(page.getByRole('region', { name: 'Danh sách kết nối shop', exact: true })).toContainText(second.name);
});

test('small-screen tasks stay within the viewport and primary navigation works with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + '/?page=overview');
  await expect(page.getByRole('heading', { name: 'Hôm nay cần xử lý gì?', exact: true })).toBeVisible();
  const nav = primary(page);
  await nav.getByRole('button', { name: 'Tổng quan', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('button', { name: 'Bộ listing', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/page=products/);
  await expect(page.getByText('Bộ nguồn QA từ file', { exact: true }).first()).toBeVisible();
  for (const [name, destination] of [['Bộ listing', 'products'], ['Đăng hàng', 'prepared-batches'], ['Shop', 'shops'], ['Tổng quan', 'overview']] as const) {
    await nav.getByRole('button', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp('page=' + destination));
    if (destination === 'products') await expect(page.getByText('Bộ nguồn QA từ file', { exact: true }).first()).toBeVisible();
    else if (destination === 'prepared-batches') await expect(page.getByLabel('Đăng vào shop', { exact: true })).toBeVisible();
    else if (destination === 'shops') await expect(page.getByRole('region', { name: 'Danh sách kết nối shop', exact: true })).toContainText('Cửa hàng thử B');
    else await expect(page.getByRole('region', { name: 'Tóm tắt từ dữ liệu đã lưu', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const main = document.getElementById('workspace-main');
      return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0);
    }), {
      message: `The ${destination} page must fit a 390px viewport without hiding content.`,
    }).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: resolve(evidenceRoot, 'product-workspace-mobile.png'), fullPage: true });
});
