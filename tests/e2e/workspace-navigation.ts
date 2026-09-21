import type { Page } from '@playwright/test';

// Use the same visible task/tool navigation as an operator. No routing or state injection.
export async function openWorkspaceTool(page: Page, name: string) {
  const disclosure = page.locator('details.workspace-tools');
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)))
    await disclosure.locator('summary').click();
  await page
    .getByRole('navigation', { name: 'Công cụ bổ sung', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
}

export async function openInputLibrary(page: Page) {
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Kho listing', exact: true })
    .click();
  await page.getByRole('button', { name: 'Nhập Word / ảnh / bảng giá', exact: true }).click();
}
