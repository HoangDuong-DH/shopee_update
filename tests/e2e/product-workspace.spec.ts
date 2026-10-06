import { fulfillPagedProducts } from './fixtures/product-paging.js';
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
  await page.getByRole('combobox', { name: 'Kho đã lưu' }).selectOption(fixture.archiveId);
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


test('appearance persists and follows device changes only when system is selected', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(baseURL + '/?page=overview');
  const appearance = page.getByRole('combobox', { name: 'Giao diện', exact: true });
  await expect(page.getByRole('region', { name: 'Tóm tắt từ dữ liệu đã lưu', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await appearance.selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
  await page.reload();
  await expect(appearance).toHaveValue('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await appearance.selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  for (const theme of ['light', 'dark']) {
    await appearance.selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const pairs = await page.evaluate(() => {
      const rgb = (value: string) => {
        const values = value.match(/[\d.]+/g)?.map(Number) ?? [];
        if (values.length < 3) throw Error('COLOR_NOT_RESOLVED:' + value);
        return values;
      };
      const background = (element: Element): number[] => {
        const values = rgb(getComputedStyle(element).backgroundColor);
        if (values.length === 3 || values[3]! > .99) return values;
        if (!element.parentElement) throw Error('BACKGROUND_NOT_RESOLVED');
        return background(element.parentElement);
      };
      const luminance = (values: number[]) => {
        const linear = values.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
      };
      const selectors = ['.operations-import', '.main-nav button.active', '#operations-shop', '.appearance-control select', '.operations-issue-copy strong'];
      return selectors.map(selector => {
        const element = document.querySelector(selector);
        if (!element) throw Error('CONTRAST_TARGET_MISSING:' + selector);
        const foreground = luminance(rgb(getComputedStyle(element).color)), back = luminance(background(element));
        return { selector, ratio: (Math.max(foreground, back) + .05) / (Math.min(foreground, back) + .05) };
      });
    });
    for (const pair of pairs) expect(pair.ratio, `${theme} ${pair.selector} normal text contrast`).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: resolve(evidenceRoot, 'focused-overview-' + theme + '.png'), fullPage: true });
  }
});

test('focused shell and tools reflow at four widths before and after lazy source styles', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(baseURL + '/?page=overview');
  const appearance = page.getByRole('combobox', { name: 'Giao diện', exact: true });
  for (const theme of ['light', 'dark']) {
    await appearance.selectOption(theme);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await primary(page).getByRole('button', { name: 'Tổng quan', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Tóm tắt từ dữ liệu đã lưu', exact: true })).toBeVisible();
      const tools = page.locator('details.workspace-tools');
      const summary = tools.locator('summary');
      const toolbar = page.locator('.workspace-toolbar');
      const before = (await toolbar.boundingBox())!;
      await summary.click();
      await expect(tools).toHaveAttribute('open', '');
      const menu = page.getByRole('navigation', { name: 'Công cụ bổ sung', exact: true });
      await expect(menu).toBeVisible();
      const opened = (await toolbar.boundingBox())!, menuBox = (await menu.boundingBox())!;
      expect(Math.abs(opened.height - before.height)).toBeLessThanOrEqual(1);
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width + 1);
      await summary.press('Escape');
      await expect(tools).not.toHaveAttribute('open', '');
      await expect(summary).toBeFocused();
      for (const [name, destination] of [['Bộ listing', 'products'], ['Đăng hàng', 'prepared-batches'], ['Shop', 'shops'], ['Tổng quan', 'overview']] as const) {
        await primary(page).getByRole('button', { name, exact: true }).click();
        await expect(page).toHaveURL(new RegExp('page=' + destination));
        if (destination === 'products') await expect(page.getByText('Bộ nguồn QA từ file', { exact: true }).first()).toBeVisible();
        else if (destination === 'prepared-batches') await expect(page.getByLabel('Đăng vào shop', { exact: true })).toBeVisible();
        else if (destination === 'shops') await expect(page.getByRole('region', { name: 'Danh sách kết nối shop', exact: true })).toBeVisible();
        else await expect(page.getByRole('region', { name: 'Tóm tắt từ dữ liệu đã lưu', exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth,
          document.getElementById('workspace-main')!.scrollWidth - document.getElementById('workspace-main')!.clientWidth)), { message: `${theme} ${destination} at ${width}px must preserve reflow` }).toBeLessThanOrEqual(1);
      }
      await expect(page.locator('.environment-bar > span').first()).toBeVisible();
    }
  }
  await openWorkspaceTool(page, 'Kho nguồn');
  await expect(page).toHaveURL(/page=sources/);
  await openWorkspaceTool(page, 'Theo dõi công việc');
  await expect(page).toHaveURL(/page=workbench/);
  await primary(page).getByRole('button', { name: 'Tổng quan', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Tóm tắt từ dữ liệu đã lưu', exact: true })).toBeVisible();
  const tools = page.locator('details.workspace-tools');
  const before = (await page.locator('.workspace-toolbar').boundingBox())!;
  await tools.locator('summary').click();
  const after = (await page.locator('.workspace-toolbar').boundingBox())!;
  expect(after.height).toBe(before.height);
  expect(await tools.locator('nav').evaluate(element => getComputedStyle(element).position)).toBe('absolute');
  await page.getByRole('heading', { name: 'Hôm nay cần xử lý gì?', exact: true }).click();
  await expect(tools).not.toHaveAttribute('open', '');
  // Outside pointer clicks keep native destination focus; only Escape restores
  // focus to the menu trigger (asserted above and in the keyboard test).
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(primary(page).getByRole('button', { name: 'Tổng quan', exact: true }).locator('svg')).toBeVisible();
  await page.screenshot({ path: resolve(evidenceRoot, 'focused-overview-mobile-dark.png'), fullPage: true });
});

test('reduced motion disables menu and pressed movement without blocking keyboard tasks', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto(baseURL + '/?page=overview');
  await expect(page.getByRole('region', { name: 'Tóm tắt từ dữ liệu đã lưu', exact: true })).toBeVisible();
  const summary = page.locator('details.workspace-tools > summary');
  await summary.press('Enter');
  await expect(page.locator('details.workspace-tools')).toHaveAttribute('open', '');
  const motion = await page.locator('details.workspace-tools nav').evaluate(element => ({
    animation: getComputedStyle(element).animationName, transition: getComputedStyle(element).transitionDuration,
  }));
  expect(motion.animation).toBe('none');
  expect(motion.transition).toBe('0s');
  await summary.press('Escape');
  await expect(summary).toBeFocused();
  const button = primary(page).getByRole('button', { name: 'Bộ listing', exact: true });
  await button.focus();
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  expect(await button.evaluate(element => getComputedStyle(element).transform)).toBe('none');
  await page.mouse.up();
  await expect(page).toHaveURL(/page=products/);
  await expect(page.getByText('Bộ nguồn QA từ file', { exact: true }).first()).toBeVisible();
});

test('compact shop indicators retain full reasons and navigate to the exact connection', async ({ page }) => {
  await control('second-shop-unknown');
  await page.goto(baseURL + '/?page=overview');
  const row = page.locator('.operations-connection-row').filter({ hasText: fixture.shops[1]!.name });
  await expect(row).toBeVisible();
  await expect(row.locator('.operations-connection-detail')).not.toBeVisible();
  const summary = row.locator('summary').first();
  expect((await summary.boundingBox())!.height).toBeLessThanOrEqual(90);
  await summary.click();
  await expect(row.locator('.operations-connection-detail')).toContainText(fixture.shops[1]!.scope.shopId);
  await expect(row.locator('.operations-connection-detail')).toContainText('Kết nối shop đang cần xử lý.');
  await summary.click();
  await row.getByRole('button', { name: /^Mở kết nối:/ }).click();
  await expect(page).toHaveURL(new RegExp('connectShop=' + fixture.shops[1]!.scope.shopId));
  await expect(page).toHaveURL(new RegExp('partnerId=' + fixture.shops[1]!.scope.partnerId));
});

test('shop batch selection respects filters, exports chosen rows and preserves keyboard and layout', async ({ page }) => {
  await page.goto(baseURL + '/?page=shops');
  const region = page.getByRole('region', { name: 'Danh sách kết nối shop', exact: true });
  const rowChecks = region.getByRole('checkbox', { name: /^Chọn shop:/ });
  await expect(rowChecks).toHaveCount(3);
  const a = fixture.shops[0]!, b = fixture.shops[1]!, sandbox = fixture.shops[2]!;
  await region.getByRole('checkbox', { name: new RegExp('^Chọn shop: ' + a.name) }).check();
  await region.getByRole('searchbox', { name: 'Tìm kết nối shop', exact: true }).fill(b.scope.shopId);
  await region.getByRole('checkbox', { name: 'Chọn các shop đang hiển thị', exact: true }).check();
  const bar = region.locator('.shop-bulk-bar');
  await expect(bar).toContainText('2 shop đã chọn');
  await expect(bar).toContainText('1 ngoài bộ lọc');
  await bar.locator('.shop-bulk-more > summary').click();
  await bar.getByRole('button', { name: 'Tóm tắt', exact: true }).click();
  const selected = region.getByRole('region', { name: 'Tóm tắt shop đã chọn', exact: true });
  await expect(selected).toContainText(a.name);
  await expect(selected).toContainText(b.name);
  await expect(selected).not.toContainText(sandbox.name);
  const download = page.waitForEvent('download');
  await bar.getByRole('button', { name: 'Xuất trạng thái', exact: true }).click();
  const exported = await download;
  const csv = await import('node:fs/promises').then(fs => exported.path().then(path => fs.readFile(path!, 'utf8')));
  expect(csv).toContain(a.scope.shopId);
  expect(csv).toContain(b.scope.shopId);
  expect(csv).not.toContain(sandbox.scope.shopId);
  await bar.locator('.shop-bulk-more > summary').click();
  await region.getByRole('searchbox', { name: 'Tìm kết nối shop', exact: true }).fill('');
  await expect(region.getByRole('checkbox', { name: 'Chọn các shop đang hiển thị', exact: true })).toHaveJSProperty('indeterminate', true);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, 'selected shop toolbar at ' + width).toBeLessThanOrEqual(1);
  }
  await bar.getByRole('button', { name: 'Bỏ chọn', exact: true }).click();
  await expect(bar).not.toBeVisible();
  await primary(page).getByRole('button', { name: 'Bộ listing', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Tìm listing', exact: true })).toBeVisible();
  const controls = ['.library-search input', '.library-toolbar select', '.library-toolbar > button'];
  const boxes = await Promise.all(controls.map(selector => page.locator(selector).boundingBox()));
  expect(Math.max(...boxes.map(box => box!.y)) - Math.min(...boxes.map(box => box!.y))).toBeLessThanOrEqual(1);
});


test('selected shops hand off exact targets and require explicit archive source without writes', async ({ page }) => {
  await page.goto(baseURL + '/?page=shops');
  const region = page.getByRole('region', { name: 'Danh sách kết nối shop', exact: true });
  const a = fixture.shops[0]!, b = fixture.shops[1]!;
  await region.getByRole('checkbox', { name: new RegExp('^Chọn shop: ' + a.name) }).check();
  await region.getByRole('checkbox', { name: new RegExp('^Chọn shop: ' + b.name) }).check();
  const from = apiRequests.length;
  await region.getByRole('button', { name: 'Chuẩn bị sao chép', exact: true }).click();
  await expect(page).toHaveURL(/page=archives.*copyTargets=/);
  const targets = JSON.parse(new URL(page.url()).searchParams.get('copyTargets')!);
  expect(targets).toEqual([a, b].map(shop => ({ connectionId: shop.id, ...shop.scope })));
  await expect(page.getByRole('heading', { name: 'Kho nguồn để sao chép', exact: true })).toBeVisible();
  expect(apiRequests.slice(from).filter(request => request.method !== 'GET')).toEqual([]);
  await primary(page).getByRole('button', { name: 'Shop', exact: true }).click();
  await openWorkspaceTool(page, 'Kho sao chép');
  await expect(page).not.toHaveURL(/copyTargets=/);
  await expect(page.getByRole('region', { name: 'Shop đã chọn để chuẩn bị sao chép', exact: true })).toHaveCount(0);
});


test('bulk connection UI sends each reviewed shop once, holds sandbox and retains unknown outcomes', async ({ page }) => {
  const a = fixture.shops[0]!, b = fixture.shops[1]!, sandbox = fixture.shops[2]!;
  const writes: { id: string; action: string; body: unknown }[] = [];
  await page.route('**/v1/connections/production?*', async route => {
    const url = new URL(route.request().url());
    const shop = [a, b].find(row => row.scope.shopId === url.searchParams.get('shopId'));
    if (!shop) return route.continue();
    await fulfillPagedProducts(route,{ json: { connectionId: shop.id, ...shop.scope,
      connectionRevision: 1, state: 'connected', refreshStatus: 'saved', refreshReason: null,
      hasSavedKey: true, tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), officialName: shop.name } });
  });
  await page.route('**/v1/connections/*/check', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[3]!;
    writes.push({ id, action: 'check', body: route.request().postDataJSON() });
    await new Promise(resolve => setTimeout(resolve, 150));
    await fulfillPagedProducts(route,{ json: { kind: id === a.id ? 'success' : 'unknown' } });
  });
  await page.goto(baseURL + '/?page=shops');
  const region = page.getByRole('region', { name: 'Danh sách kết nối shop', exact: true });
  await region.getByRole('checkbox', { name: 'Chọn các shop đang hiển thị', exact: true }).check();
  await region.getByRole('button', { name: 'Kiểm tra kết nối', exact: true }).click();
  const actions = page.getByRole('region', { name: 'Thao tác kết nối đã chọn', exact: true });
  expect(writes).toEqual([]);
  await expect(actions.getByRole('list', { name: 'Các bước thao tác nhóm' })).toContainText('Xem trước');
  await expect(actions.locator('[aria-current=step]')).toHaveText('1Xem trước');
  await actions.getByRole('button', { name: 'Xem trước 3 shop', exact: true }).click();
  await expect(actions).toContainText('3 shop · 2 đủ điều kiện');
  await expect(actions).toContainText('Giữ riêng shop thử nghiệm');
  const run = actions.getByRole('button', { name: 'Kiểm tra 2 shop', exact: true });
  await run.dblclick();
  await expect(actions).toContainText('Đã kết thúc nhóm thao tác');
  await expect(actions.locator('[aria-current=step]')).toHaveText('3Kết quả');
  expect(writes).toEqual(expect.arrayContaining([a,b].map(shop => ({id: shop.id, action: 'check', body: {expectedRevision: 1}}))));
  expect(writes).toHaveLength(2);
  expect(writes.some(row => row.id === sandbox.id)).toBe(false);
  await expect(actions).toContainText('Chưa rõ kết quả');
  await expect(actions.getByText(a.name, { exact: true })).not.toBeVisible();
  const results = actions.locator('details').filter({ has: page.locator('summary', { hasText: 'Xem toàn bộ kết quả' }) }).first();
  await expect(results).not.toHaveAttribute('open', '');
  await results.locator('summary').first().click();
  await expect(actions.getByText(a.name, { exact: true })).toBeVisible();
  await expect(actions.getByText('Shopee xác nhận quyền truy cập ở lần kiểm tra này.', { exact: true })).not.toBeVisible();
  await results.locator('.bulk-connections__row').filter({ hasText: a.name }).locator('summary').click();
  await expect(actions.getByText('Shopee xác nhận quyền truy cập ở lần kiểm tra này.', { exact: true })).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
  await region.getByRole('button', { name: 'Bỏ chọn', exact: true }).click();
  await expect(actions).toContainText(b.name);
  await expect(actions).toContainText('Chưa rõ kết quả');
});


test('a saved connection change in another tab updates overview without reloading or waiting for polling', async ({page}) => {
  await control('second-shop-unknown');
  await page.goto(baseURL + '/?page=overview');
  await expect(page.locator('.operations-connection-row').filter({hasText:fixture.shops[1]!.name})).toBeVisible();
  const other = await page.context().newPage();
  try {
    await other.goto(baseURL + '/?page=shops');
    await other.getByRole('button',{name:new RegExp(fixture.shops[1]!.name + ' · Shop')}).click();
    await other.getByText('Chỉnh tên gợi nhớ trong ứng dụng',{exact:true}).click();
    await other.getByLabel('Tên gợi nhớ trong ứng dụng').fill('Kết nối vừa cập nhật QA');
    const update = page.waitForResponse(reply => new URL(reply.url()).pathname === '/v1/operations/overview',{timeout:5000});
    await other.getByRole('button',{name:'Lưu tên gợi nhớ',exact:true}).click();
    await update;
    await expect(page.locator('.operations-connection-row').filter({hasText:'Kết nối vừa cập nhật QA'})).toBeVisible();
    await expect(page).toHaveURL(/page=overview/);
    await other.getByLabel('Tên gợi nhớ trong ứng dụng').fill(fixture.shops[1]!.name);
    await other.getByRole('button',{name:'Lưu tên gợi nhớ',exact:true}).click();
    await expect(other.getByText('Đã lưu tên gợi nhớ trong ứng dụng.',{exact:true})).toBeVisible();
  } finally {await other.close();}
});

test('the journey and workload actions open the correct tab and retain exact shop scope across reload', async ({page}) => {
  await page.goto(baseURL + '/?page=overview');
  await expect(page.getByText('Một phần dữ liệu chưa đọc được.',{exact:false})).not.toBeVisible();
  const second = fixture.shops[1]!;
  await page.getByRole('combobox',{name:/^Phạm vi công việc/}).selectOption(JSON.stringify(second.scope));
  await expect(heldMetric(page)).toHaveText('2');
  await page.getByRole('navigation',{name:'Quy trình đăng hàng'}).getByRole('button',{name:/3. Chuẩn bị/}).click();
  await expect(page.getByRole('tab',{name:'Chuẩn bị lô mới'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByLabel('Đăng vào shop',{exact:true})).toHaveValue(key(second));
  await primary(page).getByRole('button',{name:'Tổng quan',exact:true}).click();
  await page.getByRole('combobox',{name:/^Phạm vi công việc/}).selectOption(JSON.stringify(second.scope));
  await expect(heldMetric(page)).toHaveText('2');
  await page.getByRole('button',{name:/^Xem nguồn cần bổ sung:/}).click();
  await expect(page).toHaveURL(/work=all/);
  await expect(page.getByRole('tab',{name:'Chuẩn bị lô mới'})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.preparation-history')).toHaveAttribute('open','');
  await expect(page.locator('.preparation-history')).toContainText('Bản kiểm tra đã lưu (2)');
  await page.reload();
  await expect(page.getByLabel('Đăng vào shop',{exact:true})).toHaveValue(key(second));
  await expect(page.locator('.preparation-history')).toHaveAttribute('open','');
  await expect(page.locator('.preparation-history')).toContainText('Bản kiểm tra đã lưu (2)');
  expect(apiRequests.filter(request => request.method !== 'GET' && request.path.startsWith('/v1/production-'))).toEqual([]);
});
