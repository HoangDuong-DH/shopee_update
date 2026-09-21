import { openWorkspaceTool } from './workspace-navigation.js';
import { test, expect } from '@playwright/test';
// Read-only acceptance against the private source recipe imported into the running local app.
// Separate from unit/integration fixtures; requires scripts/import-recipe.mts .local/recipes/lamy.json.
test('renders the real Lamy source, six SKU bindings and every description image', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  const mutations: string[] = [];
  page.on('pageerror', (e) => browserErrors.push(e.message));
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.goto('/');
  await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await expect(page.getByRole('heading', { name: 'Kiểm tra listing', exact: true })).toBeVisible();
  await expect(page.getByTestId('variant-row')).toHaveCount(6);
  await expect(page.getByTestId('variant-row').first()).toContainText('CB 100 Cái Trắng');
  await expect(page.getByTestId('variant-row').first()).toContainText('137.998');
  await expect(page.getByTestId('variant-row').first()).toContainText('68.999');
  await expect(page.getByTestId('description-image')).toHaveCount(9);
  const shop = page.getByLabel('Shop đích', { exact: true });
  await expect(shop).toHaveValue('');
  const sandboxValue = await shop
    .locator('option')
    .filter({ hasText: '227418363' })
    .getAttribute('value');
  expect(sandboxValue).toBeTruthy();
  await shop.selectOption(sandboxValue!);
  await expect(page.getByTestId('shop-scope')).toContainText('227418363');
  const cover = page.getByAltText('Ảnh sản phẩm gốc');
  await expect(cover).toBeVisible();
  await expect
    .poll(() =>
      cover.evaluate(
        (img: HTMLImageElement) => img.naturalWidth === 1024 && img.naturalHeight === 1024,
      ),
    )
    .toBe(true);
  await page.screenshot({ path: '.local/e2e-artifacts/lamy-preview-desktop.png' });
  expect(browserErrors).toEqual([]);
  expect(mutations).toEqual([]);
});
test('reviews the prepared source with locked SKU structure and unchanged data after reload', async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.goto('/');
  await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await page.getByRole('button', { name: 'Đối chiếu nguồn', exact: true }).click();
  await expect(page.getByLabel('Tiêu đề listing')).toHaveValue(
    'Khẩu trang 5D Lamy 3 lớp trắng đen, quai co giãn ôm mặt, combo 100/300 cái, thùng 500 cái',
  );
  await expect(page.getByLabel('Tiêu đề listing')).not.toBeEditable();
  await page.getByRole('tab', { name: /^SKU & phân loại/ }).click();
  await expect(page.getByText('Danh sách SKU và phân loại đã khóa', { exact: true })).toBeVisible();
  await expect(page.locator('.variant-editor').first()).toContainText('LMKT5DT100');
  await expect(page.locator('.variant-editor').first()).toContainText('137.998');
  await expect(page.getByLabel('Phân loại 1', { exact: true })).toHaveValue('CB 100 Cái Trắng');
  await expect(page.getByLabel('Phân loại 1', { exact: true })).not.toBeEditable();
  for (const button of await page.getByRole('button', { name: /^Lưu/ }).all()) {
    await expect(button).toBeDisabled();
  }
  await page.reload();
  await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await expect(page.getByTestId('variant-row')).toHaveCount(6);
  await expect(page.getByTestId('description-image')).toHaveCount(9);
  expect(mutations).toEqual([]);
});
test('keeps a narrow screen usable without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await expect(page.getByRole('heading', { name: 'Kiểm tra listing' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: '.local/e2e-artifacts/lamy-preview-mobile.png' });
});
