import type { Page } from '@playwright/test';

// Use the same visible task/tool navigation as an operator. No routing or state injection.
export async function openWorkspaceTool(page: Page, name: string) {
  const label = ({ 'Listing của tôi': 'Bộ listing', 'Kết nối shop': 'Shop', 'Kho listing': 'Kho nguồn' } as Record<string, string>)[name] ?? name;
  const primary = page.getByRole('navigation', { name: 'Điều hướng chính', exact: true }).getByRole('button', { name: label, exact: true });
  if (await primary.count()) {
    await primary.click();
    return;
  }
  const disclosure = page.locator('details.workspace-tools');
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)))
    await disclosure.locator('summary').click();
  await page
    .getByRole('navigation', { name: 'Công cụ bổ sung', exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
}

export async function openInputLibrary(page: Page) {
  await openWorkspaceTool(page, 'Kho nguồn');
  await page.getByRole('button', { name: 'Nhập Word / ảnh / bảng giá', exact: true }).click();
}
