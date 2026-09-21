import { test, expect, type Page } from '@playwright/test';
import { openWorkspaceTool } from './workspace-navigation.js';

// All APIs are browser fixtures; these tests never contact Shopee or a database.
const at = '2026-09-16T09:00:00Z';
const shops = [
  {
    id: 'shop-a',
    name: 'Vườn Hương',
    scope: { environment: 'production', shopId: '101', partnerId: '201' },
  },
  {
    id: 'shop-b',
    name: 'Góc Nhà',
    scope: { environment: 'production', shopId: '102', partnerId: '201' },
  },
];
const carpet = {
  evidenceId: 'carpet-evidence',
  connectionId: 'shop-a',
  scope: shops[0]!.scope,
  itemId: '501',
  title: 'Xịt khử mùi thảm VINA TƯƠI',
  itemSku: 'CARPET',
  modelSkus: ['VTTDPL100', 'VTTDPL300'],
  categoryId: '101127',
  brandId: '1252097',
  attributes: [],
  observedAt: at,
  issues: [],
  itemStatus: 'NORMAL',
};
const comparison = {
  target: carpet,
  recommendations: {
    suggestions: [
      {
        attributeId: '1001',
        name: 'Hạn sử dụng',
        values: [{ valueId: '0', originalValueName: '36 tháng' }],
        evidenceIds: ['other-evidence'],
        sourceClass: 'exact_sku',
        reasons: ['Listing khác chưa chứng minh thời hạn dùng của toàn bộ phân loại.'],
        canPrefill: false,
        confidence: 'reference',
        coverage: { matchedSkuCount: 1, targetSkuCount: 2, partial: true },
      },
      {
        attributeId: '1003',
        name: 'Xuất xứ',
        values: [{ valueId: '200', displayName: 'Việt Nam' }],
        evidenceIds: ['confirmed-receipt'],
        sourceClass: 'product_source',
        reasons: ['PRODUCT_SOURCE_DECLARATION'],
        canPrefill: true,
        confidence: 'confirmed',
        coverage: { matchedSkuCount: 2, targetSkuCount: 2, partial: false },
      },
    ],
    issues: ['Cần xác nhận thông tin trên nhãn sản phẩm.'],
    missingMandatoryAttributeIds: ['1002'],
  },
  metadata: {},
  sourceFacts: [
    {
      attributeId: '1003',
      sourceId: 'confirmed-receipt',
      sourceLocator: 'Nhãn sản phẩm mẫu đã xác nhận',
      confirmed: true,
    },
  ],
};
async function fixture(page: Page, comparisonResult: unknown = comparison) {
  const calls: { method: string; path: string; body: any }[] = [];
  let failSearch = false,
    failComparison = false;
  let releaseSearch: (() => void) | undefined;
  let delaySearch = false;
  let sync = {
    id: 'sync-a',
    state: 'paused',
    code: 'ITEM_LIMIT_REACHED',
    processedCount: 2,
    fetchedCount: 2,
    reusedCount: 0,
    requestCount: 3,
    maxItems: 100,
    canResume: true,
    issues: [],
  };
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    calls.push({ method: request.method(), path: url.pathname, body });
    if (url.pathname === '/v1/seller-knowledge/shops') return route.fulfill({ json: { shops } });
    if (url.pathname === '/v1/seller-knowledge/syncs') return route.fulfill({ json: sync });
    if (url.pathname.endsWith('/syncs/sync-a/resume')) {
      sync = {
        ...sync,
        state: 'complete',
        processedCount: 3,
        fetchedCount: 3,
        requestCount: 5,
        canResume: false,
        code: '',
      };
      return route.fulfill({ json: sync });
    }
    if (url.pathname === '/v1/seller-knowledge/search') {
      if (delaySearch && url.searchParams.get('connectionId') === 'shop-a') {
        await new Promise<void>((resolve) => {
          releaseSearch = resolve;
        });
      }
      if (failSearch)
        return route.fulfill({ status: 503, json: { code: 'SELLER_KNOWLEDGE_UNAVAILABLE' } });
      return route.fulfill({
        json: { listings: url.searchParams.get('connectionId') === 'shop-a' ? [carpet] : [] },
      });
    }
    if (url.pathname === '/v1/seller-knowledge/recommendations') {
      if (failComparison)
        return route.fulfill({ status: 503, json: { code: 'SELLER_KNOWLEDGE_UNAVAILABLE' } });
      return route.fulfill({ json: comparisonResult });
    }
    if (url.pathname === '/v1/seller-knowledge/evidence/other-evidence')
      return route.fulfill({
        json: {
          id: 'other-evidence',
          connectionId: 'shop-a',
          scope: shops[0]!.scope,
          observedAt: at,
          body: {
            title: 'Xịt thơm phòng tham khảo',
            itemId: '500',
            attributes: [{ name: 'Hạn sử dụng', values: [{ originalValueName: '36 tháng' }] }],
          },
          rawEvidence: { privatePath: 'NEVER_SHOW_PRIVATE_PATH' },
        },
      });
    if (url.pathname === '/v1/status') return route.fulfill({ json: { worker: 'online' } });
    if (url.pathname.startsWith('/v1/seller-knowledge'))
      return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await openWorkspaceTool(page, 'Tra cứu & kiểm tra');
  return {
    calls,
    setFailSearch: () => {
      failSearch = true;
    },
    setFailComparison: () => {
      failComparison = true;
    },
    delaySearch: () => {
      delaySearch = true;
    },
    releaseSearch: () => releaseSearch?.(),
  };
}

test('reads a bounded shop batch, resumes, and shows product evidence without offering a write', async ({
  page,
}) => {
  const f = await fixture(page);
  const panel = page.getByRole('region', { name: 'Thông tin từ shop', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByLabel('Shop cần tra cứu').selectOption('shop-a');
  await panel.getByRole('button', { name: 'Đọc thông tin từ shop', exact: true }).click();
  await expect(panel.getByText('2 sản phẩm đã xử lý')).toBeVisible();
  await panel.getByRole('button', { name: 'Tiếp tục lượt đọc', exact: true }).click();
  await expect(panel.getByText('3 sản phẩm đã xử lý')).toBeVisible();
  await panel.getByLabel('Tên sản phẩm hoặc SKU').fill('thảm');
  await panel.getByRole('button', { name: 'Tìm sản phẩm', exact: true }).click();
  await panel
    .getByRole('button', { name: 'Đối chiếu thông tin Xịt khử mùi thảm VINA TƯƠI' })
    .click();
  await expect(panel.getByRole('heading', { name: 'Hạn sử dụng' })).toBeVisible();
  await expect(panel.getByText('Việt Nam', { exact: true })).toBeVisible();
  await expect(panel.getByText('Nguồn: Nhãn sản phẩm mẫu đã xác nhận')).toBeVisible();
  await expect(panel.getByText('Cần xác nhận trước khi dùng', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Xem nguồn tham khảo', exact: true }).click();
  await expect(panel.getByText('Xịt thơm phòng tham khảo', { exact: true })).toBeVisible();
  await expect(panel).not.toContainText('NEVER_SHOW_PRIVATE_PATH');
  await expect(panel.getByRole('button', { name: /Đăng|Áp dụng|Cập nhật Shopee/ })).toHaveCount(0);
  expect(f.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
    '/v1/seller-knowledge/syncs',
    '/v1/seller-knowledge/syncs/sync-a/resume',
    '/v1/seller-knowledge/recommendations',
  ]);
  expect(f.calls.find((c) => c.path === '/v1/seller-knowledge/syncs')?.body).toMatchObject({
    connectionId: 'shop-a',
    maxItems: 100,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: '.local/attribute-research-20260916/seller-knowledge-mobile.png',
    fullPage: true,
  });
});

test('keeps old results after a read failure and marks them as not refreshed', async ({ page }) => {
  const f = await fixture(page);
  const panel = page.getByRole('region', { name: 'Thông tin từ shop', exact: true });
  await panel.getByLabel('Shop cần tra cứu').selectOption('shop-a');
  await panel.getByRole('button', { name: 'Tìm sản phẩm', exact: true }).click();
  await expect(panel.getByText(carpet.title, { exact: true })).toBeVisible();
  f.setFailSearch();
  await panel.getByRole('button', { name: 'Tìm sản phẩm', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByText(carpet.title, { exact: true })).toBeVisible();
  await expect(panel.getByText(/Kết quả trước vẫn được giữ/)).toBeVisible();
});

test('ignores a delayed search response after switching to another shop', async ({ page }) => {
  const f = await fixture(page);
  const panel = page.getByRole('region', { name: 'Thông tin từ shop', exact: true });
  await panel.getByLabel('Shop cần tra cứu').selectOption('shop-a');
  f.delaySearch();
  await panel.getByRole('button', { name: 'Tìm sản phẩm', exact: true }).click();
  await expect.poll(() => f.calls.filter((c) => c.path.endsWith('/search')).length).toBe(1);
  await panel.getByLabel('Shop cần tra cứu').selectOption('shop-b');
  f.releaseSearch();
  await panel.getByRole('button', { name: 'Tìm sản phẩm', exact: true }).click();
  await expect(panel.getByText('Chưa có sản phẩm phù hợp trong dữ liệu đã đọc.')).toBeVisible();
  await expect(panel.getByText(carpet.title, { exact: true })).toHaveCount(0);
});

test('shows incomplete reference coverage while preserving independently confirmed source facts', async ({
  page,
}) => {
  await fixture(page, {
    ...comparison,
    candidateCoverage: { totalCount: 137, limit: 100, truncated: true },
    recommendations: {
      ...comparison.recommendations,
      suggestions: [
        {
          ...comparison.recommendations.suggestions[0],
          values: [],
          confidence: 'blocked',
          reasons: ['CANDIDATE_COVERAGE_INCOMPLETE', 'DEPENDENT_MANDATORY_ATTRIBUTE_MISSING'],
        },
        comparison.recommendations.suggestions[1],
      ],
      issues: [{ code: 'CANDIDATE_COVERAGE_INCOMPLETE', detail: 'Reference scan incomplete' }],
    },
  });
  const panel = page.getByRole('region', { name: 'Thông tin từ shop', exact: true });
  await panel.getByLabel('Shop cần tra cứu').selectOption('shop-a');
  await panel.getByRole('button', { name: 'Tìm sản phẩm', exact: true }).click();
  await panel
    .getByRole('button', { name: 'Đối chiếu thông tin Xịt khử mùi thảm VINA TƯƠI' })
    .click();
  await expect(
    panel.getByText(/Lượt này lấy tối đa 100 trong 137 listing tham khảo/),
  ).toBeVisible();
  await expect(panel.getByText(/Chưa thể kết luận mọi nguồn đều thống nhất/)).toBeVisible();
  await expect(panel.getByText('Việt Nam', { exact: true })).toBeVisible();
  await expect(panel.getByText('Có thể đưa vào bản xem trước', { exact: true })).toBeVisible();
  await expect(panel.getByText(/Lựa chọn này cần thêm thông tin bắt buộc liên quan/)).toBeVisible();
  await expect(panel).not.toContainText('CANDIDATE_COVERAGE_INCOMPLETE');
  await expect(panel).not.toContainText('DEPENDENT_MANDATORY_ATTRIBUTE_MISSING');
});
test('labels deleted history and offers evidence instead of treating it as a current product', async ({
  page,
}) => {
  await fixture(page);
  const deleted = {
    ...carpet,
    evidenceId: 'deleted-evidence',
    itemId: '599',
    title: '',
    itemStatus: 'SELLER_DELETE',
    itemSku: '',
    modelSkus: [],
    attributes: [],
    issues: ['LISTING_DELETED'],
  };
  await page.route('**/v1/seller-knowledge/search?**', (route) =>
    route.fulfill({ json: { listings: [carpet, deleted] } }),
  );
  await page.route('**/v1/seller-knowledge/evidence/deleted-evidence', (route) =>
    route.fulfill({
      json: {
        id: deleted.evidenceId,
        connectionId: 'shop-a',
        scope: shops[0]!.scope,
        observedAt: at,
        body: { title: '', itemId: '599', itemStatus: 'SELLER_DELETE', attributes: [] },
        rawEvidence: [],
      },
    }),
  );
  const panel = page.getByRole('region', { name: 'Thông tin từ shop', exact: true });
  await panel.getByLabel('Shop cần tra cứu').selectOption('shop-a');
  await panel.getByRole('button', { name: 'Tìm sản phẩm', exact: true }).click();
  const history = panel
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Listing đã xóa', exact: true }) });
  await expect(history).toContainText('Shopee ghi nhận đã xóa');
  await expect(history.getByRole('button', { name: /Đối chiếu/ })).toHaveCount(0);
  await history.getByRole('button', { name: 'Xem dấu vết đã xóa 599' }).click();
  await expect(
    panel.getByText('Listing đã xóa — chỉ còn dấu vết trạng thái', { exact: true }),
  ).toBeVisible();
});
