import { openWorkspaceTool } from './workspace-navigation.js';
import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page, conflict = false) {
  let shop = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Official Test Shop',
    officialName: 'Official Test Shop',
    displayName: null as string | null,
    nameRevision: 0,
    region: 'VN',
    state: 'connected',
    capabilities: [],
    updatedAt: '2026-09-14T00:00:00.000Z',
    scope: {
      environment: 'sandbox',
      partnerId: '1232297',
      shopId: '227418363',
      connectionRevision: 7,
      capabilityRevision: 3,
    },
  };
  const writes: any[] = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'PATCH' && path.endsWith('/display-name')) {
      writes.push(request.postDataJSON());
      if (conflict) {
        shop = {
          ...shop,
          name: 'Tên mới của đồng nghiệp',
          displayName: 'Tên mới của đồng nghiệp',
          nameRevision: 1,
        };
        return route.fulfill({ status: 409, json: { code: 'CONNECTION_NAME_REVISION_CONFLICT' } });
      }
      const body = request.postDataJSON();
      shop = {
        ...shop,
        name: body.displayName ?? shop.officialName,
        displayName: body.displayName,
        nameRevision: shop.nameRevision + 1,
      };
      return route.fulfill({ json: shop });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      writes.push({ unexpected: path });
      return route.fulfill({ status: 503, json: { code: 'UNEXPECTED_FIXTURE_WRITE' } });
    }
    if (path === '/v1/shops') return route.fulfill({ json: [shop] });
    if (path === '/v1/status')
      return route.fulfill({ json: { worker: 'online', productionWrites: false } });
    if (path === '/v1/workbench')
      return route.fulfill({ json: { orders: [], shops: [shop], sources: [] } });
    if (
      [
        '/v1/imports',
        '/v1/source-catalogs',
        '/v1/products',
        '/v1/plans',
        '/v1/jobs',
        '/v1/import-patches',
      ].includes(path)
    )
      return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await openWorkspaceTool(page, 'Kết nối shop');
  return writes;
}

test('fixture: edits a local shop alias and restores the official name', async ({ page }) => {
  const writes = await setup(page);
  const input = page.getByLabel('Tên gợi nhớ trong ứng dụng');
  await expect(input).toHaveValue('');
  await input.fill('Shop thử nghiệm VN');
  await page.getByRole('button', { name: 'Lưu tên gợi nhớ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Shop thử nghiệm VN', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Tên trên Shopee: Official Test Shop.', { exact: false }),
  ).toBeVisible();
  expect(writes).toEqual([{ displayName: 'Shop thử nghiệm VN', expectedNameRevision: 0 }]);
  await input.fill('');
  await page.getByRole('button', { name: 'Lưu tên gợi nhớ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Official Test Shop', exact: true }),
  ).toBeVisible();
  expect(writes[1]).toEqual({ displayName: null, expectedNameRevision: 1 });
});

test('fixture: keeps a conflicting draft until the user reloads the saved name', async ({
  page,
}) => {
  const writes = await setup(page, true);
  const input = page.getByLabel('Tên gợi nhớ trong ứng dụng');
  await input.fill('Bản đang sửa');
  await page.getByRole('button', { name: 'Lưu tên gợi nhớ', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Tên gợi nhớ đã có bản mới');
  // Workspace polling may receive the colleague's newer alias while this draft is still open.
  await expect(
    page.getByRole('heading', { name: 'Tên mới của đồng nghiệp', exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(input).toHaveValue('Bản đang sửa');
  await page.getByRole('button', { name: 'Tải lại tên đã lưu', exact: true }).click();
  await expect(input).toHaveValue('Tên mới của đồng nghiệp');
  expect(writes).toHaveLength(1);
});
