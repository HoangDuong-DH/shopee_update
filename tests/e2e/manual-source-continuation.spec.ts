import { expect, test, type Page } from '@playwright/test';
import { fact, fixtureDraft } from '../helpers/fixtures.js';

const partnerId = '2010476', shopId = '1126307464', preparationId = '1651c52c-4cc8-4b57-951a-6b9b4d6b2281';
const title = 'Tinh dầu Bạc Hà nguồn hiện tại';
async function setup(page: Page, registered: boolean, partial = false) {
  const product = fixtureDraft();
  product.productKey = 'manual-source-continue'; product.title = fact(title); product.revision = 2;
  product.sourceSelection = { title, headline: '', body: 'Nội dung bản nguồn mới nhất', galleryIds: [], descriptionImageIds: [], tierNames: product.tierNames,
    variants: product.variants.map(variant => ({ importId: '11111111-1111-4111-8111-111111111111', rowKey: variant.key, optionLabels: variant.optionLabels })) };
  const snapshot = { id: preparationId, fingerprint: 'a'.repeat(64), readyCount: 1, blockedCount: 0,
    publicationMode: 'hidden_for_review', imageQcPolicy: 'defer_image_qc', registration: registered ? { batches: [] } : null,
    entries: [{ productKey: product.productKey, sourceRevision: 1, title: 'Tinh dầu Bạc Hà nguồn đã kiểm tra', kind: 'ready', issues: [],
      document: { title: 'Tinh dầu Bạc Hà nguồn đã kiểm tra', description: [], models: [] } }] };
  if (partial) { snapshot.readyCount = 2; snapshot.entries.push({ productKey: 'still-current', sourceRevision: 1, title: 'Nước lau sàn nguồn còn khớp', kind: 'ready', issues: [], document: { title: 'Nước lau sàn nguồn còn khớp', description: [], models: [] } }); }
  const requests: string[] = [], writes: string[] = [];
  const origin = new URL(String(test.info().project.use.baseURL)).origin;
  await page.addInitScript(() => { sessionStorage.setItem('workspace-page', 'prepared-batches'); sessionStorage.setItem('workspace-production-view', 'new'); });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route('**/v1/**', route => {
    const url = new URL(route.request().url()), path = url.pathname;
    requests.push(path);
    if (route.request().method() !== 'GET') { writes.push(path); return route.abort(); }
    if (path === '/v1/shops') return route.fulfill({ json: [{ id: 'selected-shop', name: 'vinatuoi.vn', displayName: 'VINA TƯƠI Nội bộ', state: 'connected',
      scope: { environment: 'production', partnerId, shopId } }] });
    if (path === '/v1/products') return route.fulfill({ json: [{ ...product, revision: 1, title: fact('Bản danh sách cũ') }] });
    if (path === '/v1/products/' + product.productKey) return route.fulfill({ json: product });
    if (path === '/v1/production-preparations/context') return route.fulfill({ json: { scope: { shopId, partnerId },
      products: [{ productKey: product.productKey, title, revision: product.revision, skus: [], issues: [] }, ...(partial ? [{ productKey: 'still-current', title: 'Nước lau sàn nguồn còn khớp', revision: 1, skus: [], issues: [] }] : [])], pricebooks: [], preparations: [snapshot] } });
    if (path.endsWith('/source-changes')) return route.fulfill({ json: { preparationId, scope: { shopId, partnerId }, entries: [
      { productKey: product.productKey, title: snapshot.entries[0]!.title, sourceRevision: 1, currentRevision: 2, state: 'changed', changedFields: ['title'],
        changes: [{ field: 'title', label: 'Tiêu đề', before: snapshot.entries[0]!.title, after: title }] },
      ...(partial ? [{ productKey: 'still-current', title: 'Nước lau sàn nguồn còn khớp', sourceRevision: 1, currentRevision: 1, state: 'current', changedFields: [], changes: [] }] : []),
    ] } });
    if (path.endsWith('/execution')) return route.fulfill({ json: null });
    if (path === '/v1/production-batches') return route.fulfill({ json: { batches: [] } });
    return route.fulfill({ json: path === '/v1/status' ? { worker: 'online' } : [] });
  });
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu', exact: true });
  await panel.getByText('Bản kiểm tra đã lưu (1)', { exact: true }).click();
  await panel.getByRole('button', { name: `Tinh dầu Bạc Hà nguồn đã kiểm tra · ${partial ? 2 : 1} đủ nguồn, 0 cần bổ sung`, exact: true }).click();
  return { panel, writes, requests };
}

test('preparation shows selected shop and blocks registration for a changed source', async ({ page }) => {
  const { panel, writes } = await setup(page, false);
  await expect(panel.getByText(/Shop đích: VINA TƯƠI Nội bộ · ID 1126307464/).first()).toBeVisible();
  await expect(panel.getByText(/vuatinhdau\.vn/)).toHaveCount(0);
  const changes = panel.getByRole('region', { name: 'Nguồn đã thay đổi', exact: true });
  await expect(changes.getByRole('alert')).toContainText('1 bộ nguồn đã khác bản kiểm tra này');
  await expect(changes).toContainText('bản đã kiểm tra 1 → bản hiện tại 2');
  await changes.getByText('Xem 1 mục đã thay đổi của Tinh dầu Bạc Hà nguồn đã kiểm tra', { exact: true }).click();
  await expect(changes.locator('pre').first()).toHaveText('Tinh dầu Bạc Hà nguồn đã kiểm tra');
  await expect(changes.locator('pre').last()).toHaveText(title);
  await expect(panel.getByRole('button', { name: 'Chuẩn bị đợt cho 1 listing đủ nguồn', exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('source-version-block.png'), fullPage: true });
});

test('registered snapshot stops sending and opens the latest editable source instead of cached summary', async ({ page }) => {
  const { panel, writes, requests } = await setup(page, true);
  await expect(panel.getByRole('button', { name: 'Đăng ẩn các listing đã chuẩn bị', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Mở nguồn hiện tại của Tinh dầu Bạc Hà nguồn đã kiểm tra', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Đối chiếu nguồn listing', exact: true })).toBeVisible();
  await expect(page.getByText('Bản nguồn 2 · Đã lưu trong ứng dụng', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Tiêu đề listing', exact: true })).toHaveValue(title);
  expect(requests).toContain('/v1/products/manual-source-continue');
  expect(writes).toEqual([]);
});

test('one changed source keeps its warning while independent registered sources can continue', async ({ page }) => {
  const { panel, writes } = await setup(page, true, true);
  await expect(panel.getByRole('region', { name: 'Nguồn đã thay đổi', exact: true })).toContainText('Phần độc lập còn khớp nguồn có thể tiếp tục');
  await expect(panel.getByRole('button', { name: 'Đăng ẩn các listing đã chuẩn bị', exact: true })).toBeEnabled();
  expect(writes).toEqual([]);
});
