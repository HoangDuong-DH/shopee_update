import { expect, test, type Page } from '@playwright/test';

const partnerId = '2010476';
const shopIds = ['1126307464', '1423724897'];
const fingerprint = 'a'.repeat(64);
const batches = shopIds.map((shopId, index) => ({
  batchId: `513281a9-764c-4b04-a73e-85b8c6c1c98${index}`,
  partnerId, shopId, shopName: index === 0 ? 'vinatuoi.vn' : 'vuatinhdau.vn',
  state: 'ready', statusFingerprint: fingerprint, publicationMode: 'hidden_for_review',
  completionTarget: 'created_hidden', publishedCount: 0, remainingCount: 1,
  busy: false, enabled: true, executionEnabled: true, canExecute: true,
  canReconcile: false, listings: [{ sourceKey: `source-${index}`, title: `Sản phẩm riêng shop ${shopId}`,
    modelCount: 3, state: 'not_sent', acknowledgedSteps: 0, totalSteps: 0 }],
}));

async function prepare(page: Page) {
  const writes: string[] = [];
  const origin = new URL(String(test.info().project.use.baseURL)).origin;
  await page.addInitScript(() => {
    sessionStorage.setItem('workspace-page', 'prepared-batches');
    sessionStorage.setItem('workspace-production-view', 'working');
  });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route('**/v1/**', route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (route.request().method() !== 'GET') {
      writes.push(url.pathname + url.search);
      return route.abort(); // The response was lost, not proof that the server rejected the write.
    }
    if (path === '/v1/shops') return route.fulfill({ json: shopIds.map((shopId, index) => ({
      id: `shop-${index}`, name: batches[index]!.shopName, state: 'connected',
      scope: { environment: 'production', partnerId, shopId },
    })) });
    if (path === '/v1/production-batches') return route.fulfill({ json: { batches } });
    if (path === '/v1/production-preparations/context') return route.fulfill({ json: {
      scope: { shopId: url.searchParams.get('shopId'), partnerId }, products: [], pricebooks: [], preparations: [],
    } });
    if (path === '/v1/status') return route.fulfill({ json: { worker: 'online' } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  return writes;
}

test('normal batch reads and switching shops never display another shop batch', async ({ page }) => {
  await prepare(page);
  const panel = page.getByRole('region', { name: 'Đợt đăng mới', exact: true });
  await expect(panel.getByRole('listitem').getByText(batches[0]!.listings[0]!.title, { exact: true })).toBeVisible();
  await expect(panel.getByText(batches[1]!.listings[0]!.title, { exact: true })).toHaveCount(0);
  await page.getByLabel('Đăng vào shop', { exact: true }).selectOption(`${partnerId}:${shopIds[1]}`);
  await expect(panel.getByRole('listitem').getByText(batches[1]!.listings[0]!.title, { exact: true })).toBeVisible();
  await expect(panel.getByText(batches[0]!.listings[0]!.title, { exact: true })).toHaveCount(0);
  await expect(panel.getByText(/Shop đích: vuatinhdau.vn · ID 1423724897/)).toBeVisible();
});

test('a lost submit response stays unresolved after reload without sending again', async ({ page }) => {
  const writes = await prepare(page);
  const panel = page.getByRole('region', { name: 'Đợt đăng mới', exact: true });
  const submit = panel.getByRole('button', { name: 'Đăng ẩn 1 listing', exact: true });
  await submit.click();
  await expect(panel.getByRole('alert')).toContainText('Chưa xác nhận được yêu cầu');
  await expect(submit).toBeDisabled();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('shopId=1126307464');
  await page.reload();
  await expect(submit).toBeDisabled();
  await expect(panel.getByText('Cần đọc lại kết quả', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
});

test('export downloads the chosen shop report through the read-only scoped endpoint', async ({ page }) => {
  const writes = await prepare(page);
  await page.getByLabel('Đăng vào shop', { exact: true }).selectOption(`${partnerId}:${shopIds[1]}`);
  let requestUrl = '';
  await page.route('**/v1/production-batches/*/report.xlsx?*', route => {
    requestUrl = route.request().url();
    return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from('PK report fixture') });
  });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất báo cáo Excel', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`Bao-cao-shop-${shopIds[1]}-dot-${batches[1]!.batchId}.xlsx`);
  const url = new URL(requestUrl);
  expect(url.pathname).toBe(`/v1/production-batches/${batches[1]!.batchId}/report.xlsx`);
  expect(url.searchParams.get('shopId')).toBe(shopIds[1]);
  expect(url.searchParams.get('partnerId')).toBe(partnerId);
  expect(writes).toEqual([]);
});

test('export failure is visible and cannot download a JSON error as a workbook', async ({ page }) => {
  const writes = await prepare(page);
  const downloads: string[] = [];
  page.on('download', value => downloads.push(value.suggestedFilename()));
  await page.route('**/v1/production-batches/*/report.xlsx?*', route => route.fulfill({ status: 409, json: { code: 'PRODUCTION_BATCH_SCOPE_MISMATCH' } }));
  await page.getByRole('button', { name: 'Xuất báo cáo Excel', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Chưa lấy được báo cáo của đợt này');
  await expect(page.getByRole('button', { name: 'Xuất báo cáo Excel', exact: true })).toBeEnabled();
  expect(downloads).toEqual([]);
  expect(writes).toEqual([]);
});
