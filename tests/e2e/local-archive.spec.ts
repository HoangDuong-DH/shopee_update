import { test, expect, type Page } from '@playwright/test';
import { openInputLibrary, openWorkspaceTool } from './workspace-navigation.js';

// UI fixtures: intercept every API request, including writes. No shop or main DB writes.
async function setup(page: Page, blocked = false) {
  const states = new Map<string, boolean>();
  const writes: { kind: string; resourceId: string; archived: boolean }[] = [];
  const listing = { id: 'row-1', title: 'Xịt thơm Hoa Lài', brand: 'VINA TƯƠI', sheet: 'Vina', row: 171,
    itemId: null, issues: [], contentAvailable: true, variationAvailable: true, designCandidateCount: 0 };
  const catalog = { id: 'catalog-1', name: 'Nội dung Vina Tươi', revision: 1, receivedAt: '2026-09-17T00:00:00Z',
    counts: { listings: 1, designs: 0, pages: 0, needsReview: 0 }, brands: [{ name: 'VINA TƯƠI', count: 1 }],
    sources: [], notes: [], missing: [] };
  const product = { productKey: 'draft-1', title: { value: 'Nháp Xịt Cam Sả' }, revision: 1,
    variants: [], issues: [], galleryKeys: [], description: [] };
  const batch = { id: 'batch-1', name: 'Nhập thử Cam Sả', folderCount: 1, fileCount: 15,
    completedCount: 1, updatedAt: '2026-09-17T00:00:00Z', priceSelection: null };
  const book = { id: 'book-1', filename: 'Giá cũ.xlsx', status: 'ready', createdAt: '2026-09-17T00:00:00Z',
    rowCount: 3, sheetCount: 1, issueCount: 0 };
  await page.route('**/v1/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') {
      if (url.pathname !== '/v1/local-archives') return route.abort('blockedbyclient');
      const value = request.postDataJSON();
      writes.push(value);
      if (blocked) return route.fulfill({ status: 409, json: { code: 'LOCAL_ARCHIVE_IN_USE', message: 'Nguồn đang được công việc sử dụng.' } });
      states.set(value.kind + ':' + value.resourceId, value.archived);
      return route.fulfill({ json: { ...value, archivedAt: value.archived ? '2026-09-17T00:00:00Z' : null } });
    }
    const include = (kind: string, id: string) => url.searchParams.get('lifecycle') === 'all'
      || Boolean(states.get(kind + ':' + id)) === (url.searchParams.get('lifecycle') === 'archived');
    let body: unknown = [];
    if (url.pathname === '/v1/status') body = { worker: 'online' };
    else if (url.pathname === '/v1/source-catalogs') body = [catalog];
    else if (url.pathname === '/v1/source-catalogs/catalog-1') body = catalog;
    else if (url.pathname.endsWith('/listings')) body = { items: include('catalog_listing', 'catalog-1/row-1') ? [listing] : [],
      total: include('catalog_listing', 'catalog-1/row-1') ? 1 : 0, page: 1, pageSize: 30 };
    else if (url.pathname === '/v1/products') body = include('product', 'draft-1') ? [product] : [];
    else if (url.pathname === '/v1/input-library') body = {
      priceBooks: include('pricebook', 'book-1') ? [book] : [],
      batches: include('input_batch', 'batch-1') ? [batch] : [], unassigned: [],
    };
    return route.fulfill({ json: body });
  });
  await page.goto('/');
  return { writes, states };
}

test('catalog archive requires named confirmation, cancel does not write, restore survives reload', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Lưu trữ: Xịt thơm Hoa Lài', exact: true }).click();
  await page.getByRole('button', { name: 'Hủy', exact: true }).click();
  expect(fixture.writes).toEqual([]);
  await page.getByRole('button', { name: 'Lưu trữ: Xịt thơm Hoa Lài', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Lưu trữ Xịt thơm Hoa Lài' })).toContainText('Sản phẩm trên Shopee', { ignoreCase: true });
  await page.getByRole('button', { name: 'Xác nhận lưu trữ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xem nguồn: Xịt thơm Hoa Lài' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('combobox', { name: 'Trạng thái lưu trữ' }).selectOption('archived');
  await page.getByRole('button', { name: 'Khôi phục: Xịt thơm Hoa Lài', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận khôi phục', exact: true }).click();
  await page.getByRole('combobox', { name: 'Trạng thái lưu trữ' }).selectOption('active');
  await expect(page.getByRole('button', { name: 'Xem nguồn: Xịt thơm Hoa Lài' })).toBeVisible();
  expect(fixture.writes).toEqual([
    { kind: 'catalog_listing', resourceId: 'catalog-1/row-1', archived: true },
    { kind: 'catalog_listing', resourceId: 'catalog-1/row-1', archived: false },
  ]);
});

test('server refuses archive while in use; row remains and error explains failure', async ({ page }) => {
  await setup(page, true);
  await page.getByRole('button', { name: 'Lưu trữ: Xịt thơm Hoa Lài', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận lưu trữ', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Xem nguồn: Xịt thơm Hoa Lài' })).toBeVisible();
});

test('input library archives and restores batches and pricebooks without offering archived inputs to new work', async ({ page }) => {
  const fixture = await setup(page);
  await openInputLibrary(page);
  await page.getByRole('button', { name: 'Lưu trữ: Nhập thử Cam Sả', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận lưu trữ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nhập thử Cam Sả', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Trạng thái lưu trữ' }).selectOption('archived');
  await expect(page.getByRole('button', { name: 'Tiếp tục xử lý', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Khôi phục: Nhập thử Cam Sả', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận khôi phục', exact: true }).click();
  await page.getByRole('combobox', { name: 'Trạng thái lưu trữ' }).selectOption('active');
  await page.getByRole('tab', { name: /Bảng giá chung/ }).click();
  await page.getByRole('button', { name: 'Lưu trữ: Giá cũ.xlsx', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận lưu trữ', exact: true }).click();
  await page.getByRole('combobox', { name: 'Trạng thái lưu trữ' }).selectOption('archived');
  await expect(page.getByRole('button', { name: 'Dùng cho đợt mới', exact: false })).toBeDisabled();
  await page.getByRole('button', { name: 'Khôi phục: Giá cũ.xlsx', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận khôi phục', exact: true }).click();
  expect(fixture.writes.map((w) => w.kind)).toEqual(['input_batch', 'input_batch', 'pricebook', 'pricebook']);
});

test('saved drafts archive and restore in Listing của tôi', async ({ page }) => {
  const fixture = await setup(page);
  await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByRole('button', { name: 'Lưu trữ: Nháp Xịt Cam Sả', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận lưu trữ', exact: true }).click();
  await expect(page.locator('[data-testid="listing-row"]')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Trạng thái lưu trữ' }).selectOption('archived');
  await expect(page.getByRole('button', { name: /Nháp Xịt Cam Sả · Xem/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Khôi phục: Nháp Xịt Cam Sả', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận khôi phục', exact: true }).click();
  await page.getByRole('combobox', { name: 'Trạng thái lưu trữ' }).selectOption('active');
  await expect(page.locator('[data-testid="listing-row"]')).toHaveCount(1);
  expect(fixture.writes.map((w) => w.archived)).toEqual([true, false]);
});
