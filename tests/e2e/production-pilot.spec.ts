import { test, expect, type Page } from '@playwright/test';

// All application APIs are intercepted. These browser fixtures cannot write to Shopee or the DB.
const ready = () => ({
  enabled: true,
  canStart: true,
  active: false,
  phase: 'ready',
  historicalAttempts: [],
  sourceReceiptSha256: 'a'.repeat(64),
  shop: { shopId: '1423724897', name: 'Shop tinh dầu kiểm thử' },
  listings: [12, 3].map((count, index) => ({
    sourceKey: 'fixture-' + index,
    title: index === 0 ? 'Bộ tinh dầu can 5 lít' : 'Bộ túi treo thơm',
    skuCount: count,
    coverImportId: 'cover-' + index,
    state: 'not_sent',
    models: Array.from({ length: count }, (_, i) => ({
      sku: `SKU-${index}-${i}`,
      label: `Hương ${i + 1}`,
      originalPrice: '125000',
      stock: 100,
      weightGrams: 5500,
    })),
    stepCounts: { total: 0, acknowledged: 0, sent: 0, unknown: 0, rejected: 0 },
  })),
});
async function fixture(page: Page, initial: any = ready(), dropStart = false) {
  let current = initial,
    reads = 0,
    starts: unknown[] = [],
    failStatus = false;
  const appOrigin = new URL(String(test.info().project.use.baseURL)).origin;
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === appOrigin ? route.continue() : route.abort(),
  );
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/production-pilot/status') {
      reads++;
      if (failStatus) return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } });
      return route.fulfill({ json: current });
    }
    if (path === '/v1/production-pilot/start' && route.request().method() === 'POST') {
      starts.push(route.request().postDataJSON());
      if (dropStart) return route.abort();
      current = { ...current, active: true, phase: 'checking' };
      return route.fulfill({ status: 202, json: { started: true } });
    }
    if (route.request().method() !== 'GET') return route.abort();
    if (path.startsWith('/v1/production-pilot/assets/'))
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#d9e8db"/></svg>',
      });
    return route.fulfill({ json: path === '/v1/status' ? { worker: 'online' } : [] });
  });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  if (!(await page.locator('.production-batch-history').getAttribute('open')))
    await page.getByText('Kết quả đợt đăng trước', { exact: true }).click();
  return {
    starts,
    reads: () => reads,
    set: (value: any) => (current = value),
    fail: () => (failStatus = true),
  };
}

test('frozen source is understandable and only one exact start request is sent', async ({
  page,
}) => {
  const f = await fixture(page);
  const pilot = page.getByRole('region', { name: 'Đăng listing đã chuẩn bị' });
  await expect(pilot.getByText('Shop tinh dầu kiểm thử', { exact: true })).toBeVisible();
  await expect(pilot.getByText('2 listing · 15 phân loại', { exact: true })).toBeVisible();
  await expect(pilot.getByRole('textbox')).toHaveCount(0);
  await pilot.getByText('Xem 12 phân loại', { exact: true }).click();
  await expect(pilot.getByRole('cell', { name: 'SKU-0-0', exact: true })).toBeVisible();
  await expect(pilot.getByRole('cell', { name: '125.000 ₫', exact: true })).toHaveCount(12);
  await pilot.getByRole('button', { name: 'Đăng 2 listing bằng API', exact: true }).click();
  await expect(
    pilot.getByRole('button', { name: 'Đăng 2 listing bằng API', exact: true }),
  ).toBeDisabled();
  expect(f.starts).toEqual([{ sourceReceiptSha256: 'a'.repeat(64) }]);
  await expect(page.locator('details.production-pilot-legacy')).not.toHaveAttribute('open', '');
});

test('image-upload receipts and a create rejection are never shown as a created listing', async ({
  page,
}) => {
  const status: any = ready();
  status.code = 'DESCRIPTION_IMAGES_NOT_ALLOWED';
  status.listings[0] = {
    ...status.listings[0],
    operationId: 'operation-1',
    state: 'rejected',
    lastCode: 'DESCRIPTION_IMAGES_NOT_ALLOWED',
    stepCounts: { total: 32, acknowledged: 31, sent: 0, unknown: 0, rejected: 1 },
  };
  await fixture(page, status);
  const pilot = page.getByRole('region', { name: 'Đăng listing đã chuẩn bị' });
  await expect(
    pilot
      .getByText('Shopee chưa cho phép chèn ảnh trong mô tả của shop này.', { exact: false })
      .first(),
  ).toBeVisible();
  await expect(pilot.getByText('Chưa có listing được tạo', { exact: true }).first()).toBeVisible();
  await expect(pilot.getByText('31 bước đã nhận biên nhận', { exact: true })).toBeVisible();
  await expect(pilot.getByText('Đã mở bán, đối chiếu đạt', { exact: true })).toHaveCount(0);
  await expect(pilot.getByRole('link', { name: 'Mở trong Kênh Người Bán' })).toHaveCount(0);
  await expect(pilot.getByRole('button', { name: 'Đăng 2 listing bằng API' })).toBeDisabled();
});

test('uncertain start remains held after reload and does not silently resend', async ({ page }) => {
  const f = await fixture(page, ready(), true);
  await page.getByRole('button', { name: 'Đăng 2 listing bằng API' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Chưa xác nhận được yêu cầu' }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  if (!(await page.locator('.production-batch-history').getAttribute('open')))
    await page.getByText('Kết quả đợt đăng trước', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đăng 2 listing bằng API' })).toBeDisabled();
  await page.getByRole('button', { name: 'Tải lại trạng thái', exact: true }).click();
  expect(f.starts).toHaveLength(1);
});

function remaining() {
  const status: any = ready();
  status.phase = 'partial_complete';
  status.remainingCount = 1;
  status.continuationKind = 'remaining';
  status.continuationKey = 'b'.repeat(64);
  status.listings[0] = {
    ...status.listings[0],
    operationId: 'published-source',
    itemId: '51467852283',
    state: 'verified',
    publicationState: 'verified',
  };
  return status;
}
test('continues only the server-proven remaining work after an earlier batch attempt', async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('shopee.production-pilot.start.' + 'a'.repeat(64), 'sent'),
  );
  const f = await fixture(page, remaining());
  await expect(
    page.getByText('Đã đăng 1 listing; 1 listing chưa gửi', { exact: true }),
  ).toBeVisible();
  const button = page.getByRole('button', { name: 'Tiếp tục 1 listing còn lại', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeDisabled();
  expect(f.starts).toEqual([
    { sourceReceiptSha256: 'a'.repeat(64), continuationKey: 'b'.repeat(64) },
  ]);
  await expect(page.getByText('Đã mở bán, đối chiếu đạt', { exact: true })).toBeVisible();
});
test('an uncertain continuation stays held for the same remaining work after reload', async ({
  page,
}) => {
  const f = await fixture(page, remaining(), true);
  await page.getByRole('button', { name: 'Tiếp tục 1 listing còn lại', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Chưa xác nhận được yêu cầu' }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  if (!(await page.locator('.production-batch-history').getAttribute('open')))
    await page.getByText('Kết quả đợt đăng trước', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Tiếp tục 1 listing còn lại', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Tải lại trạng thái', exact: true }).click();
  expect(f.starts).toHaveLength(1);
});
test('shows readback continuation separately from a new create', async ({ page }) => {
  const status = remaining();
  status.phase = 'stopped';
  status.continuationKind = 'reconcile';
  status.listings[1] = {
    ...status.listings[1],
    operationId: 'ack-source',
    itemId: '51467852284',
    state: 'acknowledged',
  };
  await fixture(page, status);
  await expect(
    page.getByRole('button', { name: 'Đối chiếu và tiếp tục phần còn lại', exact: true }),
  ).toBeEnabled();
  await expect(page.getByText('Tiếp tục đọc lại kết quả đã nhận.', { exact: false })).toBeVisible();
});

test('verified creation and publication stay distinct; narrow screens retain all content', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const status: any = ready();
  status.listings[0] = {
    ...status.listings[0],
    operationId: 'op-a',
    itemId: '123456789',
    state: 'verified',
  };
  status.listings[1] = {
    ...status.listings[1],
    operationId: 'op-b',
    itemId: '123456790',
    state: 'verified',
    publicationState: 'verified',
  };
  const f = await fixture(page, status);
  await expect(page.getByText('Đã tạo ẩn, đối chiếu đạt', { exact: true })).toBeVisible();
  await expect(page.getByText('Đã mở bán, đối chiếu đạt', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Mở trong Kênh Người Bán' }).first()).toHaveAttribute(
    'href',
    'https://banhang.shopee.vn/portal/product/123456789',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  f.fail();
  await page.getByRole('button', { name: 'Tải lại trạng thái', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Chưa tải được trạng thái mới' }),
  ).toBeVisible();
  await expect(page.getByText('Đã mở bán, đối chiếu đạt', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.local/production-pilot-ui-mobile.png', fullPage: true });
});

test('status is polled only while the server reports active work', async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page);
  await expect(page.getByRole('button', { name: 'Đăng 2 listing bằng API' })).toBeEnabled();
  const idleReads = f.reads();
  await page.clock.fastForward(11000);
  expect(f.reads()).toBe(idleReads);
  await page.getByRole('button', { name: 'Đăng 2 listing bằng API' }).click();
  await expect(page.getByText('Đang kiểm tra điều kiện đăng', { exact: true })).toBeVisible();
  const activeReads = f.reads();
  await page.clock.fastForward(6000);
  await expect.poll(() => f.reads()).toBeGreaterThan(activeReads);
});

test('backend canStart blocks a new request even when no current operation is displayed', async ({
  page,
}) => {
  const status = {
    ...ready(),
    canStart: false,
    startBlockedCode: 'PRODUCTION_PILOT_RECONCILIATION_REQUIRED',
  };
  const f = await fixture(page, status);
  await expect(page.getByRole('button', { name: 'Đăng 2 listing bằng API' })).toBeDisabled();
  expect(f.starts).toHaveLength(0);
});

test('closed rejection remains visible separately from the new frozen source revision', async ({
  page,
}) => {
  const status: any = ready();
  status.listings.forEach((listing: any) => (listing.sourceRevision = 3));
  status.historicalAttempts = [
    {
      operationId: 'old-op',
      sourceIdentity: 'catalog:fixture-0',
      sourceRevision: 2,
      itemId: null,
      state: 'rejected',
      rejectionClosed: true,
      reasonCode: 'DESC_IMAGES_NOT_ALLOWED',
      requestId: 'request-previous',
      stepCounts: {
        total: 32,
        acknowledged: 31,
        sent: 0,
        unknown: 0,
        rejected: 1,
        uploadsAcknowledged: 31,
        createsAcknowledged: 0,
        modelsAcknowledged: 0,
      },
    },
  ];
  await fixture(page, status);
  await expect(
    page.getByRole('heading', { name: 'Lần thực hiện trước', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('31 ảnh đã nhận biên nhận', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Đã đối chiếu và đóng lần bị từ chối', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Đăng 2 listing bằng API' })).toBeEnabled();
});

test('unknown create result never implies that no listing was created', async ({ page }) => {
  const status: any = ready();
  status.listings[0] = {
    ...status.listings[0],
    operationId: 'op-unknown',
    itemId: null,
    state: 'unknown',
    stepCounts: { total: 1, acknowledged: 0, sent: 0, unknown: 1, rejected: 0 },
  };
  await fixture(page, status);
  await expect(page.getByText('Chưa xác nhận được kết quả tạo', { exact: true })).toBeVisible();
  await expect(page.getByText('Chưa có listing được tạo', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Đăng 2 listing bằng API' })).toBeDisabled();
});

test('explains pending cover review and source mismatches without claiming verification', async ({
  page,
}) => {
  const status = remaining();
  status.phase = 'stopped';
  status.code = 'PRODUCTION_PILOT_COVER_CASE_UNVERIFIED';
  status.canStart = false;
  status.listings[1] = {
    ...status.listings[1],
    operationId: 'ack-cover-review',
    itemId: '51267858328',
    state: 'acknowledged',
    stepCounts: { total: 13, acknowledged: 13, sent: 0, unknown: 0, rejected: 0 },
  };
  const f = await fixture(page, status);
  await expect(page.getByText('Shopee đã xử lý lại ảnh bìa.', { exact: false })).toBeVisible();
  await expect(page.getByText('Đã nhận mã listing, chờ đối chiếu', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Tiếp tục 1 listing còn lại', exact: true }),
  ).toBeDisabled();
  expect(f.starts).toHaveLength(0);
  f.set({ ...status, code: 'READBACK_MISMATCH' });
  await page.getByRole('button', { name: 'Tải lại trạng thái', exact: true }).click();
  await expect(
    page.getByText('Giá trị đọc lại từ Shopee chưa khớp bộ nguồn', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('giá, tồn hoặc cân nặng', { exact: false })).toBeVisible();
  await expect(page.getByText('Đã nhận mã listing, chờ đối chiếu', { exact: true })).toBeVisible();
  expect(f.starts).toHaveLength(0);
});
