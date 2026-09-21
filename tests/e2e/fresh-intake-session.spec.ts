import { expect, test } from '@playwright/test';

test('fresh intake clears only temporary selections and remounts the folder picker without writes', async ({ page }) => {
  const writes: string[] = [];
  await page.route('**/v1/**', async (route) => {
    if (route.request().method() !== 'GET') {
      writes.push(route.request().url());
      return route.abort('blockedbyclient');
    }
    const path = new URL(route.request().url()).pathname;
    const json = path === '/v1/status' ? { worker: 'online' }
      : path === '/v1/input-library' ? { batches: [], priceBooks: [], unassigned: [] }
      : [];
    await route.fulfill({ json });
  });
  await page.goto('/');
  const temporary = ['shopee:prepared-intake:v1', 'production-preparation-working-copy-v1'];
  const protectedKeys = [
    'production-preparation-pending', 'shopee.import-patch.pending-save',
    'shopee.prepared-batch.pending-submit', 'shopee.prepared-batch.pending-control',
    'shopee.prepared-batch.pending-intake', 'production-batch:receipt',
    'shopee.production-pilot.start.receipt', 'unrelated-app-setting',
  ];
  await page.evaluate(({ temporary, protectedKeys }) => {
    for (const key of [...temporary, ...protectedKeys]) sessionStorage.setItem(key, 'keep-' + key);
    localStorage.setItem('shopee.sandbox-tryout.receipt.v1', 'keep-receipt');
  }, { temporary, protectedKeys });
  await page.getByRole('button', { name: 'Bắt đầu phiên nhập mới', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nhập listing theo thư mục' })).toBeVisible();
  await expect(page.getByText('Đã bỏ lựa chọn tạm. Dữ liệu đã lưu vẫn ở kho.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Đọc các thư mục', exact: true })).toBeDisabled();
  const before = await page.getByRole('radio', { name: 'Thư mục này là một listing', exact: true }).isChecked();
  await page.getByRole('radio', { name: before ? 'Mỗi thư mục con là một listing' : 'Thư mục này là một listing', exact: true }).check();
  await page.getByRole('button', { name: '← Kho đầu vào', exact: true }).click();
  await page.getByRole('button', { name: 'Bắt đầu phiên nhập mới', exact: true }).click();
  expect(await page.getByRole('radio', { name: 'Thư mục này là một listing', exact: true }).isChecked()).toBe(before);
  const storage = await page.evaluate(({ temporary, protectedKeys }) => ({
    temporary: temporary.map(key => sessionStorage.getItem(key)),
    protected: protectedKeys.map(key => sessionStorage.getItem(key)),
    receipt: localStorage.getItem('shopee.sandbox-tryout.receipt.v1'),
  }), { temporary, protectedKeys });
  expect(storage.temporary).toEqual([null, null]);
  expect(storage.protected).toEqual(protectedKeys.map(key => 'keep-' + key));
  expect(storage.receipt).toBe('keep-receipt');
  expect(writes).toEqual([]);
});
