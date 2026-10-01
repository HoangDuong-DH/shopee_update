import { test, expect, type Page } from '@playwright/test';

// Synthetic numeric IDs satisfy the form's scope format without using a real shop.
const partnerId = '7900001', shopId = '7900000021';
const attemptId = '79000000-0000-4000-8000-000000000021';
const connectionId = '79000000-0000-4000-8000-000000000022';
const attemptKey = 'shopee-authorization-attempt:' + partnerId + ':' + shopId;
const statusPath = '/v1/connections/production-pilot/authorization/' + attemptId;

test.beforeEach(async ({ page }, info) => {
  test.skip(info.config.metadata.authorizationRecoveryFixture !== true, 'Run only with the isolated authorization component fixture.');
  const origin = new URL(String(info.project.use.baseURL)).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
});

async function verifyReadOnlyRetry(page: Page, blockStorageAfterRestore: boolean) {
  const callbackUrl = new URL('/v1/connections/production-pilot/callback', String(test.info().project.use.baseURL)).href;
  const targetReads: Array<{ partnerId: string | null; shopId: string | null }> = [];
  const statusReads: Array<{ method: string; path: string }> = [], writes: Array<{ method: string; path: string }> = [];
  let verified = false;
  await page.addInitScript(({ key, attempt }) => sessionStorage.setItem(key, JSON.stringify({ ...attempt, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() })), {
    key: attemptKey, attempt: { attemptId, partnerId, shopId, callbackUrl, authorizationUrl: 'https://open.shopee.com/auth?partner_id=' + partnerId },
  });
  await page.route('**/v1/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== 'GET') { writes.push({ method: request.method(), path }); return route.abort(); }
    if (path === '/v1/shops') return route.fulfill({ json: [] });
    if (path === '/v1/connections/production') {
      targetReads.push({ partnerId: url.searchParams.get('partnerId'), shopId: url.searchParams.get('shopId') });
      return route.fulfill({ json: { partnerId, shopId, expectedHandle: 'Shop thử phục hồi kết nối', appName: 'Ứng dụng thử cục bộ',
        consoleUrl: 'https://open.shopee.com', connectionId: verified ? connectionId : null,
        tokenExpiresAt: null, autoRefresh: false, refreshStatus: 'idle', refreshReason: null,
        connectionRevision: verified ? 2 : 0, hasSavedKey: true, officialName: verified ? 'Shop thử phục hồi kết nối' : null,
        state: verified ? 'connected' : 'disconnected', authorizationCallbackUrl: callbackUrl } });
    }
    if (path === statusPath) {
      statusReads.push({ method: request.method(), path });
      if (statusReads.length === 1) return route.fulfill({ status: 503, json: { code: 'FIXTURE_STATUS_READ_UNAVAILABLE' } });
      verified = true;
      return route.fulfill({ json: { attemptId, partnerId, shopId, status: 'verified', connectionRevision: 2 } });
    }
    return route.fulfill({ status: 404, json: { code: 'FIXTURE_UNEXPECTED_REQUEST' } });
  });
  try {
    await page.goto('/frontend-fixture?component=authorization&partnerId=' + partnerId + '&connectShop=' + shopId);
    await expect(page.getByText('Chưa xác nhận được kết quả kết nối. Tải lại trạng thái kết nối để kiểm tra trước khi làm tiếp.', { exact: true })).toBeVisible({ timeout: 10000 });
    expect(statusReads).toEqual([{ method: 'GET', path: statusPath }]);
    await expect(page.getByTestId('authorization-connected-count')).toHaveText('0');
    if (blockStorageAfterRestore) {
      await page.evaluate(() => {
        const blockedStorage = sessionStorage, get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
        Storage.prototype.getItem = function (this: Storage, key: string) {
          if (this === blockedStorage) throw new DOMException('Fixture storage unavailable', 'SecurityError');
          return get.call(this, key);
        };
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
          if (this === blockedStorage) throw new DOMException('Fixture storage unavailable', 'SecurityError');
          return set.call(this, key, value);
        };
        Storage.prototype.removeItem = function (this: Storage, key: string) {
          if (this === blockedStorage) throw new DOMException('Fixture storage unavailable', 'SecurityError');
          return remove.call(this, key);
        };
      });
      expect(await page.evaluate(() => { try { sessionStorage.getItem('any'); return false; } catch { return true; } })).toBe(true);
    }
    const beforeRetry = targetReads.length;
    await page.getByRole('button', { name: 'Tải lại trạng thái kết nối', exact: true }).click();
    await expect.poll(() => targetReads.length).toBeGreaterThan(beforeRetry);
    await expect.poll(() => statusReads.length, { timeout: 7000 }).toBe(2);
    await expect(page.getByText('Đã xác minh và lưu kết nối đọc thông tin shop. Chưa gửi sản phẩm lên Shopee.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('authorization-connected-count')).toHaveText('1');
    await expect(page.getByLabel('Partner ID', { exact: true })).toHaveValue(partnerId);
    await expect(page.getByLabel('Shop ID', { exact: true })).toHaveValue(shopId);
    expect(targetReads.every(scope => scope.partnerId === partnerId && scope.shopId === shopId)).toBe(true);
    expect(statusReads).toEqual([{ method: 'GET', path: statusPath }, { method: 'GET', path: statusPath }]);
    expect(writes).toEqual([]);
  } finally {
    await test.info().attach('authorization-retry-observations', { body: JSON.stringify({ blockStorageAfterRestore, partnerId, shopId, attemptId, targetReads, statusReads, writes, verified }, null, 2), contentType: 'application/json' });
  }
}

test('authorization status retries the same exact shop attempt after one failed GET without authorizing again', async ({ page }) => {
  await verifyReadOnlyRetry(page, false);
});

test('authorization status retry retains the in-memory exact attempt when sessionStorage becomes unavailable', async ({ page }) => {
  await verifyReadOnlyRetry(page, true);
});
