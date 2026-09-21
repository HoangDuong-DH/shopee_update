import { test, expect, type Page } from '@playwright/test';
import type { ChangePlan, ListingDraft, ShopConnection } from '@shopee/domain';
import { openWorkspaceTool } from './workspace-navigation.js';

// Entire API is intercepted. These navigation fixtures never read or write the main DB/Shopee.
const evidence = {
  kind: 'product_file' as const,
  fileSha256: 'a'.repeat(64),
  locator: 'UI fixture workbook · Nguồn!C58',
  observedAt: '2026-09-16T00:00:00.000Z',
};
const fact = <T>(value: T) => ({ value, confirmed: true, sources: [evidence] });
const shop: ShopConnection = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Shop fixture không ghi Shopee',
  scope: {
    environment: 'production',
    partnerId: '2010476',
    shopId: '1423724897',
    connectionRevision: 1,
    capabilityRevision: 1,
  },
  region: 'VN',
  state: 'connected',
  capabilities: [],
  updatedAt: evidence.observedAt,
};
function draft(itemId: string | null): ListingDraft {
  return {
    productKey: 'fixture-source-routing',
    revision: 1,
    sourceListingId: fact(itemId),
    title: fact('Xịt thơm Hoa Hồng · fixture routing'),
    description: [{ type: 'text', text: 'Nội dung nguồn giữ nguyên.' }],
    coverKey: '',
    galleryKeys: [],
    assets: [],
    attributes: {},
    logistics: {},
    issues: [],
    tierNames: ['Dung tích'],
    variants: [
      {
        key: 'fixture-100',
        sku: fact('FIXTURE-100'),
        optionLabels: ['100ml'],
        originalPrice: fact('10000'),
      },
    ],
  };
}
async function fixture(page: Page, itemId: string | null) {
  const value = draft(itemId);
  const writes: { pathname: string; body: unknown }[] = [];
  let saved = false;
  const plan: ChangePlan = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    revision: 1,
    fingerprint: 'b'.repeat(64),
    scope: shop.scope,
    productKey: value.productKey,
    sourceRevision: value.revision,
    operation: 'create',
    fieldMask: ['title'],
    desired: value,
    stocks: [],
    createdAt: evidence.observedAt,
    issues: [
      {
        code: 'PRODUCTION_READ_ONLY',
        severity: 'block',
        field: 'publication',
        message: 'Thông báo khóa production lịch sử.',
        sources: [evidence],
      },
      {
        code: 'EXECUTOR_NOT_RELEASED',
        severity: 'block',
        field: 'publication',
        message: 'Thông báo chưa có executor lịch sử.',
        sources: [evidence],
      },
      {
        code: 'DUPLICATE_SKU',
        severity: 'warn',
        field: 'variants',
        message: 'SKU xuất hiện ở hai bộ giá fixture.',
        sources: [evidence],
      },
    ],
  };
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push({ pathname, body: request.postDataJSON() });
      if (pathname === '/v1/plans' && request.method() === 'POST') {
        saved = true;
        return route.fulfill({ status: 201, json: plan });
      }
      return route.fulfill({ status: 503, json: { code: 'UNEXPECTED_FIXTURE_WRITE' } });
    }
    if (pathname === '/v1/products') return route.fulfill({ json: [value] });
    if (pathname === '/v1/shops') return route.fulfill({ json: [shop] });
    if (pathname === '/v1/plans') return route.fulfill({ json: saved ? [plan] : [] });
    if (pathname === '/v1/status') return route.fulfill({ json: { worker: 'online' } });
    if (pathname === '/v1/import-patches/context')
      return route.fulfill({ json: { workOrders: [], imports: [] } });
    if (pathname === '/v1/production-batches')
      return route.fulfill({ json: { batches: [], enabled: true } });
    if (pathname === '/v1/input-library')
      return route.fulfill({ json: { priceBooks: [], batches: [], unassigned: [] } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await openWorkspaceTool(page, 'Listing của tôi');
  await page
    .getByRole('button', { name: value.title.value + ' · Xem & kiểm tra', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Kiểm tra listing', exact: true })).toBeVisible();
  return { writes, value, plan };
}

test('blank source ID opens the API production workspace without creating anything', async ({
  page,
}) => {
  const state = await fixture(page, null);
  await expect(page.getByText('Tiếp tục đăng qua API', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mở Cập nhật listing', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Mở đợt đăng qua API', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Đợt đang làm', exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test('existing source ID opens updates and never offers a new production listing', async ({
  page,
}) => {
  const state = await fixture(page, '29583754373');
  await expect(page.getByText('Cập nhật link đã có: 29583754373', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mở đợt đăng qua API', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Mở Cập nhật listing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nhập bộ cập nhật', exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test('invalid source ID blocks both new-listing and update navigation until resolved', async ({
  page,
}) => {
  const state = await fixture(page, 'unknown-item');
  await expect(page.getByText('ID listing trong nguồn chưa hợp lệ', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mở đợt đăng qua API', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Mở Cập nhật listing', exact: true })).toHaveCount(
    0,
  );
  expect(state.writes).toEqual([]);
});

test('saving the legacy local check explains its scope and preserves historical lock messages separately', async ({
  page,
}) => {
  const state = await fixture(page, null);
  await expect(
    page.getByRole('heading', { name: 'Lưu bản kiểm tra nội bộ (luồng cũ)', exact: true }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'Shop đích', exact: true }).selectOption(shop.id);
  await page.getByRole('button', { name: 'Lưu bản kiểm tra theo shop', exact: true }).click();
  await expect(
    page.getByText('Bản kiểm tra nội bộ · chưa gửi yêu cầu đăng', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Thông báo khóa production lịch sử.', { exact: true })).toBeHidden();
  await expect(page.getByText('Thông báo chưa có executor lịch sử.', { exact: true })).toBeHidden();
  await expect(
    page.getByText('SKU xuất hiện ở hai bộ giá fixture.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/không phải kết luận phân loại trong listing bị trùng/),
  ).toBeVisible();
  await page.getByText('Thông báo được lưu cùng bản kiểm tra cũ', { exact: true }).click();
  await expect(page.getByText('Thông báo khóa production lịch sử.', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Thông báo chưa có executor lịch sử.', { exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([
    {
      pathname: '/v1/plans',
      body: {
        productKey: state.value.productKey,
        sourceRevision: 1,
        connectionId: shop.id,
        operation: 'create',
        fieldMask: ['title', 'description', 'gallery', 'variations', 'price'],
      },
    },
  ]);
});
