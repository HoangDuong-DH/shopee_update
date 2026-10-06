import { fulfillPagedProducts } from './fixtures/product-paging.js';
import { test, expect } from '@playwright/test';

const partnerId = '2010476';
const vina = '1126307464';
const haby = '1340479212';
const attemptId = '11111111-2222-4333-8444-555555555555';

test('switching shops keeps the authorization attempt bound to its own shop and route', async ({ page }) => {
  const prepared: string[] = [];
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/v1/connections/production' && request.method() === 'GET') {
      const shopId = url.searchParams.get('shopId')!;
      return fulfillPagedProducts(route,{ json: {
        environment: 'production', partnerId, shopId,
        expectedHandle: shopId === vina ? 'VINA TƯƠI' : 'Shop ' + shopId,
        appName: 'VestaPro', consoleUrl: 'https://open.shopee.com/console/app/218272',
        connectionId: shopId === vina ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null,
        connectionRevision: shopId === vina ? 1 : 0,
        tokenExpiresAt: null, refreshStatus: 'idle', refreshReason: null,
        autoRefresh: true, state: shopId === vina ? 'connected' : 'disconnected',
        officialName: shopId === vina ? 'VINA TƯƠI' : null, hasSavedKey: true,
        authorizationCallbackUrl: 'http://127.0.0.1:4310/v1/connections/production-pilot/callback',
      } });
    }
    if (path === '/v1/connections/production/authorize' && request.method() === 'POST') {
      const body = request.postDataJSON();
      prepared.push(body.shopId);
      return fulfillPagedProducts(route,{ json: {
        attemptId,
        authorizationUrl: 'https://open.shopee.com/auth?partner_id=' + partnerId,
        callbackUrl: 'http://127.0.0.1:4310/v1/connections/production-pilot/callback',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      } });
    }
    if (path === '/v1/connections/production-pilot/authorization/' + attemptId)
      return fulfillPagedProducts(route,{ json: { attemptId, partnerId, shopId: haby, status: 'pending' } });
    if (path === '/v1/shops') return fulfillPagedProducts(route,{ json: [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'VINA TƯƠI', officialName: 'VINA TƯƠI', displayName: null, nameRevision: 0,
      region: 'VN', state: 'connected', capabilities: [],
      scope: { environment: 'production', partnerId, shopId: vina, connectionRevision: 1, capabilityRevision: 1 },
    }] });
    if (path === '/v1/status')
      return fulfillPagedProducts(route,{ json: { worker: 'online', productionWrites: false } });
    if (path === '/v1/workbench')
      return fulfillPagedProducts(route,{ json: { orders: [], shops: [], sources: [] } });
    if (['/v1/imports','/v1/source-catalogs','/v1/products','/v1/plans','/v1/jobs','/v1/import-patches'].includes(path))
      return fulfillPagedProducts(route,{ json: [] });
    return fulfillPagedProducts(route,{ status: 404, json: {} });
  });

  await page.addInitScript(() => sessionStorage.setItem('shopee-authorization-attempt', JSON.stringify({
    partnerId: '2010476', shopId: '1340479212',
    attempt: {
      attemptId: '11111111-2222-4333-8444-555555555555',
      authorizationUrl: 'https://open.shopee.com/auth?partner_id=2010476',
      callbackUrl: 'http://127.0.0.1:4310/v1/connections/production-pilot/callback',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    },
  })));
  await page.goto('/?page=shops&connectShop=' + vina);
  await expect(page.getByRole('heading', { name: 'VINA TƯƠI', exact: true }).first()).toBeVisible();
  await page.getByLabel('Shop ID', { exact: true }).fill(haby);
  await page.getByRole('button', { name: 'Chọn shop này' }).click();
  await expect(page).toHaveURL(/connectShop=1340479212/);
  await expect(page.getByRole('heading', { name: 'Shop ' + haby })).toBeVisible();
  await page.getByRole('button', { name: '2. Chuẩn bị kết nối Shopee' }).click();
  await expect(page.getByText('Đang chờ bạn cấp quyền trên Shopee')).toBeVisible();
  expect(prepared).toEqual([haby]);

  await page.getByLabel('Shop đã lưu').selectOption('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await expect(page).toHaveURL(/connectShop=1126307464/);
  await expect(page.getByRole('heading', { name: 'VINA TƯƠI', exact: true }).first()).toBeVisible();
  await page.getByLabel('Shop ID', { exact: true }).fill(haby);
  await page.getByRole('button', { name: 'Chọn shop này' }).click();
  await expect(page.getByRole('heading', { name: '3. Mở Shopee và cấp quyền đúng shop' })).toBeVisible();
  await expect(page.getByText('Shop ' + haby + ' · ' + haby)).toBeVisible();
  expect(prepared).toEqual([haby]);
});
