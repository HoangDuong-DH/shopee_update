import { openWorkspaceTool } from './workspace-navigation.js';
import { test, expect } from '@playwright/test';
// Local KB acceptance: search/read only; creates no product, review, or Shopee write.
test('searches the actual KB and opens a full source without treating it as a current shop rule', async ({
  page,
}) => {
  await page.goto('/');
  await openWorkspaceTool(page, 'Tra cứu & kiểm tra');
  await page.getByLabel('Từ khóa tài liệu').fill('get_attribute_tree');
  await page.getByRole('button', { name: 'Tìm tài liệu', exact: true }).click();
  await expect(page.getByTestId('knowledge-hit').first()).toBeVisible();
  await page
    .getByTestId('knowledge-hit')
    .first()
    .getByRole('button', { name: 'Đọc bản đầy đủ' })
    .click();
  await expect(page.getByRole('heading', { name: 'Bản tài liệu đầy đủ' })).toBeVisible();
  await expect(page.getByTestId('knowledge-full-source')).toContainText('get_attribute_tree');
  await expect(
    page.getByText('Bản chụp tham khảo; cần đối chiếu hiệu lực và phạm vi trước khi áp dụng.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: '.local/e2e-artifacts/knowledge-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
