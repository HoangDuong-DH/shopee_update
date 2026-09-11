import { test, expect } from '@playwright/test';
// Read-only acceptance against the private source recipe imported into the running local app.
// Separate from unit/integration fixtures; requires scripts/import-recipe.mts .local/recipes/lamy.json.
test('renders the real Lamy source, six SKU bindings and every description image', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (e) => browserErrors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await expect(page.getByTestId('variant-row')).toHaveCount(6);
  await expect(page.getByTestId('variant-row').first()).toContainText('CB 100 Cái Trắng');
  await expect(page.getByTestId('variant-row').first()).toContainText('137.998');
  await expect(page.getByTestId('variant-row').first()).toContainText('68.999');
  await expect(page.getByTestId('description-image')).toHaveCount(9);
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
});
test('opens source mapping and preserves the saved draft after reload without submitting', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await page.getByRole('button', { name: 'Chỉnh mapping' }).click();
  await expect(page.getByLabel('Tiêu đề listing')).toHaveValue(
    'Khẩu trang 5D Lamy 3 lớp trắng đen, quai co giãn ôm mặt, combo 100/300 cái, thùng 500 cái',
  );
  await expect(page.getByLabel('Phân loại 1', { exact: true })).toHaveValue('CB 100 Cái Trắng');
  await page.reload();
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await expect(page.getByTestId('variant-row')).toHaveCount(6);
});
test('keeps a narrow screen usable without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await expect(page.getByRole('heading', { name: 'Xem trước listing' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: '.local/e2e-artifacts/lamy-preview-mobile.png' });
});
