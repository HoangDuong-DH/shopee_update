import { fulfillPagedProducts } from './fixtures/product-paging.js';
import { expect, test, type Page } from '@playwright/test';
import { bulkProductEditInput, previewBulkProductEdit } from '../../packages/domain/src/bulk-product-edit.js';
import { fact, fixtureDraft } from '../helpers/fixtures.js';
import { openWorkspaceTool } from './workspace-navigation.js';

async function setup(page: Page, conflict = false) {
  let product = fixtureDraft(); product.productKey = 'browser-bulk'; product.title = fact('Tinh dầu Bạc Hà browser');
  product.variants = ['100ml', '280ml', '500ml'].map((label, index) => ({ key: `row-${index}`, sku: fact(`REAL-${index}`), optionLabels: [label], originalPrice: fact('20000') }));
  product.sourceSelection = { title: product.title.value, headline: 'H', body: 'B', galleryIds: [], descriptionImageIds: [], tierNames: product.tierNames,
    variants: product.variants.map(variant => ({ importId: '11111111-1111-4111-8111-111111111111', rowKey: variant.key, optionLabels: variant.optionLabels })) };
  const previewResponse = (raw: unknown) => {
    const input = bulkProductEditInput.parse(raw), result = previewBulkProductEdit(product, input.entries[0]!, input);
    return { input, digest: 'f'.repeat(64), localOnly: true, changedCount: 1, blockedCount: result.issues.length ? 1 : 0,
      entries: [{ productKey: product.productKey, title: product.title.value, expectedRevision: product.revision, nextRevision: result.after.revision,
        changed: result.changed, beforeCount: product.variants.length, afterCount: result.after.variants.length, issues: result.issues, warnings: result.warnings,
        removed: result.removed.map(variant => ({ key: variant.key, sku: variant.sku.value, labels: variant.optionLabels })), models: result.models }] };
  };
  const writes: string[] = [];
  const origin = new URL(String(test.info().project.use.baseURL)).origin;
  await page.addInitScript(() => sessionStorage.setItem('workspace-page', 'products'));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    if (path === '/v1/products/bulk-edit/preview') return fulfillPagedProducts(route,{ json: previewResponse(route.request().postDataJSON()) });
    if (path === '/v1/products/bulk-edit/apply') {
      if (conflict) return fulfillPagedProducts(route,{ status: 409, json: { code: 'PRODUCT_REVISION_CONFLICT' } });
      const command = route.request().postDataJSON(), preview = previewResponse(command.input);
      expect(command.expectedDigest).toBe(preview.digest);
      product = previewBulkProductEdit(product, command.input.entries[0], command.input).after;
      return fulfillPagedProducts(route,{ json: { ...preview, applied: true, recovered: false } });
    }
    if (route.request().method() !== 'GET') return route.abort();
    if (path === '/v1/products') return fulfillPagedProducts(route,{ json: [product] });
    if (path === '/v1/status') return fulfillPagedProducts(route,{ json: { worker: 'online' } });
    return fulfillPagedProducts(route,{ json: [] });
  });
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Chỉnh phân loại hàng loạt' });
  await panel.getByRole('checkbox', { name: /Tinh dầu Bạc Hà browser/ }).check();
  await panel.getByLabel(/Dung tích cần bỏ/).fill('280');
  await panel.getByRole('button', { name: 'Xem trước 1 bộ đã chọn', exact: true }).click();
  await expect(panel.getByText('1 bộ có thay đổi · 0 bộ cần xử lý trước', { exact: true })).toBeVisible();
  await panel.getByText('Tinh dầu Bạc Hà browser · bản 1 → 2 · 3 → 2 phân loại', { exact: true }).click();
  await expect(panel.getByText('Bỏ: 280ml (REAL-1)', { exact: true })).toBeVisible();
  return { panel, writes, advanceRevision: () => { product = { ...product, revision: product.revision + 1 }; } };
}

test('operator previews removed SKUs and commits only the reviewed local revision', async ({ page }) => {
  const { panel, writes } = await setup(page);
  await panel.getByRole('button', { name: 'Lưu 1 bộ nguồn đã xem trước', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Đã lưu: 1 bộ nguồn có phiên bản mới');
  await expect(panel.getByRole('checkbox', { name: /Tinh dầu Bạc Hà browser · bản 2 · 2 phân loại/ })).toBeChecked();
  expect(writes).toEqual(['/v1/products/bulk-edit/preview', '/v1/products/bulk-edit/apply']);
  await page.screenshot({ path: test.info().outputPath('bulk-saved.png'), fullPage: true });
});

test('revision conflict keeps the selected products and volume input for review', async ({ page }) => {
  const { panel, writes } = await setup(page, true);
  await panel.getByRole('button', { name: 'Lưu 1 bộ nguồn đã xem trước', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Lựa chọn của bạn vẫn giữ ở đây');
  await expect(panel.getByRole('checkbox', { name: /Tinh dầu Bạc Hà browser/ })).toBeChecked();
  await expect(panel.getByLabel(/Dung tích cần bỏ/)).toHaveValue('280');
  await expect(panel.getByRole('button', { name: 'Xem trước 1 bộ đã chọn', exact: true })).toBeEnabled();
  expect(writes).toHaveLength(2);
});

test('bulk edit choices survive navigation and reload without restoring permission to apply', async ({ page }) => {
  const { panel, writes } = await setup(page);
  await panel.getByLabel('Tìm bộ nguồn để chỉnh phân loại', { exact: true }).fill('Bạc Hà');
  await page.getByRole('navigation', { name: 'Điều hướng chính', exact: true }).getByRole('button', { name: 'Kho listing', exact: true }).click();
  await openWorkspaceTool(page, 'Listing của tôi');
  await expect(panel.getByRole('checkbox', { name: /Tinh dầu Bạc Hà browser/ })).toBeChecked();
  await expect(panel.getByLabel(/Dung tích cần bỏ/)).toHaveValue('280');
  await expect(panel.getByLabel('Tìm bộ nguồn để chỉnh phân loại', { exact: true })).toHaveValue('Bạc Hà');
  await expect(panel.getByRole('button', { name: 'Lưu 1 bộ nguồn đã xem trước', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(panel.getByRole('checkbox', { name: /Tinh dầu Bạc Hà browser/ })).toBeChecked();
  await expect(panel.getByLabel(/Dung tích cần bỏ/)).toHaveValue('280');
  await expect(panel.getByRole('status')).toContainText('Xem trước lại theo nguồn hiện tại');
  await expect(panel.getByRole('button', { name: 'Lưu 1 bộ nguồn đã xem trước', exact: true })).toHaveCount(0);
  expect(writes).toEqual(['/v1/products/bulk-edit/preview']);
});

test('bulk source filter keeps hidden selection explicit and clearing all removes it', async ({ page }) => {
  const { panel, writes } = await setup(page);
  await panel.getByLabel('Tìm bộ nguồn để chỉnh phân loại', { exact: true }).fill('không có sản phẩm');
  await expect(panel.getByText(/1 bộ đã chọn đang ngoài bộ lọc/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Xem trước 1 bộ đã chọn', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Bỏ chọn tất cả bộ nguồn', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Xem trước 0 bộ đã chọn', exact: true })).toBeDisabled();
  await expect(panel.getByRole('region', { name: 'Phạm vi thay đổi phân loại', exact: true })).toHaveCount(0);
  expect(writes).toEqual(['/v1/products/bulk-edit/preview']);
});

test('restoring a newer source keeps volume criteria but drops old individual variant removals', async ({ page }) => {
  const { panel, writes, advanceRevision } = await setup(page);
  await panel.getByText('Chọn từng phân loại cần bỏ', { exact: true }).click();
  await panel.getByRole('checkbox', { name: '100ml · SKU REAL-0 · 20000 đ', exact: true }).check();
  advanceRevision();
  await page.reload();
  await expect(panel.getByRole('status')).toContainText('1 bộ đã đổi phiên bản');
  await expect(panel.getByLabel(/Dung tích cần bỏ/)).toHaveValue('280');
  await panel.getByText('Chọn từng phân loại cần bỏ', { exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: '100ml · SKU REAL-0 · 20000 đ', exact: true })).not.toBeChecked();
  await expect(panel.getByRole('checkbox', { name: /Tinh dầu Bạc Hà browser · bản 2/ })).toBeChecked();
  expect(writes).toEqual(['/v1/products/bulk-edit/preview']);
});
