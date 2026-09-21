import { test, expect, type Page } from '@playwright/test';
import type { CatalogListingDetail, SourceCatalogDetail } from '@shopee/domain';

// UI fixtures only: every API request is intercepted; no database or Shopee calls.
const catalog: SourceCatalogDetail = {
  id: '7b451dfe-ac3c-480f-8bc8-a389cd88223a',
  name: 'Bộ nội dung Vina Tươi và các nhãn hàng',
  revision: 1,
  receivedAt: '2026-09-14T09:00:00Z',
  counts: { listings: 62, designs: 7, pages: 19, needsReview: 62 },
  brands: [
    { name: 'VINA TƯƠI', count: 31 },
    { name: 'ABURA', count: 31 },
  ],
  sources: [
    { id: 'source-a', kind: 'workbook', name: 'Nội dung gốc.xlsx', sha256: 'a'.repeat(64) },
  ],
  notes: ['BRAND không xác định shop.'],
  missing: ['Chưa có nguồn SKU, giá và tồn đăng bán.'],
  originalAssetsDownloaded: false,
  publishable: false,
  importFingerprint: 'b'.repeat(64),
};
const listing: CatalogListingDetail = {
  id: 'sheet-0-row-4',
  brand: 'VINA TƯƠI',
  sourceNumber: '4',
  itemId: null,
  title:
    'Tinh dầu thiên nhiên nguyên chất dùng cho máy khuếch tán, xông phòng và chăm sóc không gian sống Vina Tươi',
  sheet: '01 VINA',
  row: 4,
  contentAvailable: true,
  variationAvailable: true,
  designCandidateCount: 1,
  status: 'needs_review',
  issues: [
    {
      code: 'MISSING_SHOP',
      message: 'Chưa xác định shop đích.',
      action: 'Đối chiếu shop trước khi đăng.',
    },
  ],
  titleSource: { sourceId: 'source-a', sheet: '01 VINA', cell: 'D4', label: 'Tiêu đề nguồn' },
  contents: [
    {
      label: 'Bản gốc',
      value: 'Dòng đầu\n\n  Giữ khoảng trắng & <script>nguồn</script>',
      evidence: { sourceId: 'source-a', sheet: '01 VINA', cell: 'E4', label: 'Bản gốc' },
    },
  ],
  variations: [],
  reviewNotes: [],
  designCandidates: [
    {
      id: 'design-a',
      title: 'Thiết kế gợi ý chưa xác nhận',
      url: 'https://www.canva.com/design/fixture/edit',
      folderId: 'folder-a',
      pageCount: 3,
      observedPageCount: 3,
      complete: true,
      updatedAt: '2026-09-14T08:00:00Z',
      reason: 'Tên gần giống',
      status: 'suggested',
    },
  ],
  shopBinding: null,
  priceSource: null,
  stockSource: null,
  attributeReference: null,
  operationalConcernCount: 1,
  operationalReferences: [
    {
      shopHandle: 'shop_fixture',
      itemId: '29926930476',
      title: 'Tên quan sát cũ',
      sourceUrl: 'https://shopee.vn/product/fixture/29926930476',
      observedAt: '2026-09-14T09:00:00Z',
      categoryLabel: 'Ngành cần kiểm tra',
      categoryGuideUrl: '',
      attributes: [{ label: 'Xuất xứ', value: 'Theo listing cũ' }],
      concerns: ['Ngành trên listing cũ có thể không phù hợp sản phẩm.'],
      apiVerified: false,
      approvedForReuse: false,
    },
  ],
};
async function fixtures(
  page: Page,
  options: {
    empty?: boolean;
    fail?: boolean;
    operationalOnly?: boolean;
    sourceItemId?: string | null;
    legacyMissingIdIssue?: boolean;
  } = {},
) {
  const calls: URL[] = [],
    posts: string[] = [];
  let fail = options.fail;
  const shownListing: CatalogListingDetail = {
    ...listing,
    itemId: options.sourceItemId === undefined ? listing.itemId : options.sourceItemId,
    issues: [
      ...(options.operationalOnly ? [] : listing.issues),
      ...(options.legacyMissingIdIssue
        ? [
            {
              code: 'missing_item_id',
              message: 'Chưa có ID listing trong nguồn',
              action: 'Ghi chú cũ được giữ nguyên trong fixture.',
            },
          ]
        : []),
    ],
  };
  await page.route('**/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    calls.push(url);
    if (req.method() !== 'GET') {
      posts.push(url.pathname);
      return route.abort('blockedbyclient');
    }
    let body: unknown = [];
    if (url.pathname === '/v1/status') body = { worker: 'online' };
    else if (url.pathname === '/v1/source-catalogs') {
      if (fail) {
        fail = false;
        return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } });
      }
      body = options.empty ? [] : [catalog];
    } else if (url.pathname.endsWith('/listings/' + listing.id)) body = shownListing;
    else if (url.pathname.endsWith('/listings'))
      body = {
        items: url.searchParams.get('q')
          ? [shownListing]
          : [
              shownListing,
              {
                ...listing,
                id: 'sheet-0-row-5',
                row: 5,
                title: 'Bộ tinh dầu nguyên chất dùng cho máy khuếch tán · nội dung cần đối chiếu',
              },
            ],
        total: url.searchParams.get('q') ? 1 : 62,
        page: Number(url.searchParams.get('page') || '1'),
        pageSize: 30,
      };
    else if (url.pathname === '/v1/source-catalogs/' + catalog.id) body = catalog;
    else if (url.pathname === '/v1/input-library')
      body = { priceBooks: [], batches: [], unassigned: [] };
    return route.fulfill({ json: body });
  });
  return { calls, posts };
}

test('catalog is home; four task routes and secondary tools remain keyboard reachable', async ({
  page,
}) => {
  const fixture = await fixtures(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Kho listing', exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Điều hướng chính', exact: true });
  await expect(nav.getByRole('button')).toHaveText([
    'Kho listing',
    'Đăng hàng',
    'Cập nhật listing',
    'Theo dõi công việc',
  ]);
  await expect(page.getByRole('button', { name: 'Thử sandbox', exact: true })).toBeHidden();
  const tools = page.getByText('Công cụ', { exact: true });
  await tools.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Thử sandbox', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tools).toBeFocused();
  expect(fixture.posts).toEqual([]);
});

test('search resets pagination; source detail preserves text and exposes unconfirmed evidence', async ({
  page,
}, info) => {
  const fixture = await fixtures(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Trang sau', exact: true }).click();
  await expect
    .poll(() =>
      fixture.calls
        .filter((u) => u.pathname.endsWith('/listings'))
        .at(-1)
        ?.searchParams.get('page'),
    )
    .toBe('2');
  await page
    .getByRole('searchbox', { name: 'Tìm trong nguồn đã nhận', exact: true })
    .fill('tinh dầu');
  await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  await expect
    .poll(() =>
      fixture.calls
        .filter((u) => u.pathname.endsWith('/listings'))
        .at(-1)
        ?.searchParams.get('page'),
    )
    .toBe('1');
  await expect
    .poll(() =>
      fixture.calls
        .filter((u) => u.pathname.endsWith('/listings'))
        .at(-1)
        ?.searchParams.get('q'),
    )
    .toBe('tinh dầu');
  await page.getByRole('button', { name: 'Xem nguồn: ' + listing.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: listing.title, exact: true })).toBeFocused();
  expect(await page.getByTestId('catalog-source-content-0').textContent()).toBe(
    listing.contents[0]!.value,
  );
  await page.getByRole('button', { name: 'Ghi chú & đối chiếu', exact: true }).click();
  await expect(page.getByTestId('catalog-source-content-0')).toHaveCount(0);
  await page.getByText('Đối chiếu với shop cũ', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'shop_fixture · ID 29926930476', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Ngành trên listing cũ có thể không phù hợp sản phẩm.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/chưa xác minh qua API và chưa/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('catalog-detail-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Ảnh Canva', exact: true }).click();
  await expect(page.getByText('Ảnh gợi ý · chưa xác nhận', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nội dung', exact: true }).click();
  expect(await page.getByTestId('catalog-source-content-0').textContent()).toBe(
    listing.contents[0]!.value,
  );
  await expect(page.getByRole('button', { name: /Đăng ngay|Sẵn sàng đăng/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Về danh sách nguồn', exact: true }).click();
  await expect(
    page.getByRole('searchbox', { name: 'Tìm trong nguồn đã nhận', exact: true }),
  ).toHaveValue('tinh dầu');
  await page.screenshot({ path: info.outputPath('catalog-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('catalog-mobile.png'), fullPage: true });
  expect(fixture.posts).toEqual([]);
});

test('failed catalog load can retry and an empty catalog directs to the existing intake', async ({
  page,
}) => {
  const fixture = await fixtures(page, { fail: true, empty: true });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Chưa tải được nguồn', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Tải lại nguồn', exact: true }).click();
  await expect(page.getByText('Chưa có bộ nội dung được tiếp nhận', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nhập Word, ảnh và bảng giá', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kho đầu vào', exact: true })).toBeVisible();
  expect(fixture.posts).toEqual([]);
});

test('compact source workspace shows a full source row and the next at 694px without hiding navigation or source state', async ({
  page,
}, info) => {
  await fixtures(page);
  await page.setViewportSize({ width: 694, height: 735 });
  await page.goto('/');
  const rows = page.locator('.catalog-table tbody tr');
  await expect(rows).toHaveCount(2);
  const first = await rows.first().boundingBox(),
    second = await rows.nth(1).boundingBox();
  expect(first!.y).toBeLessThan(530);
  expect(first!.y + first!.height).toBeLessThanOrEqual(735);
  expect(second!.y).toBeLessThan(735);
  await expect(
    page.getByText('Đã nhận nguồn · Cần bổ sung để đăng', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('catalog-694-desktop.png'), fullPage: true });
});

test('an old-shop concern alone is counted and opens the notes panel directly', async ({
  page,
}) => {
  const fixture = await fixtures(page, { operationalOnly: true });
  await page.goto('/');
  const row = page.locator('.catalog-table tbody tr').first();
  await row.getByText('1 mục cần đối chiếu', { exact: true }).click();
  await row.getByRole('button', { name: 'Xem 1 cảnh báo từ shop cũ', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Ghi chú & đối chiếu', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Xem 1 phần cần đối chiếu', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Xem 0 phần cần đối chiếu', exact: true }),
  ).toHaveCount(0);
  await page.getByText('Đối chiếu với shop cũ', { exact: true }).click();
  await expect(
    page.getByText('Ngành trên listing cũ có thể không phù hợp sản phẩm.', { exact: true }),
  ).toBeVisible();
  expect(fixture.posts).toEqual([]);
});

test('blank source ID means a new listing and does not retain the obsolete missing-ID warning', async ({
  page,
}) => {
  const fixture = await fixtures(page, { sourceItemId: null, legacyMissingIdIssue: true });
  await page.goto('/');
  const row = page.locator('.catalog-table tbody tr').first();
  await expect(row.getByText('Đăng mới', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Xem nguồn: ' + listing.title, exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Xem 2 phần cần đối chiếu', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Ghi chú & đối chiếu', exact: true }).click();
  await expect(page.getByText('Chưa có ID listing trong nguồn', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ảnh Canva', exact: true }).click();
  await expect(page.getByText('Đăng mới', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Về danh sách nguồn', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Lọc phần cần đối chiếu', exact: true })
    .selectOption('missing_item_id');
  await expect
    .poll(() =>
      fixture.calls
        .filter((url) => url.pathname.endsWith('/listings'))
        .at(-1)
        ?.searchParams.get('issue'),
    )
    .toBe('missing_item_id');
  expect(fixture.posts).toEqual([]);
});

test('existing source ID is shown as an update target and has a distinct catalog filter', async ({
  page,
}) => {
  const itemId = '29583754373';
  const fixture = await fixtures(page, { sourceItemId: itemId });
  await page.goto('/');
  const row = page.locator('.catalog-table tbody tr').first();
  await expect(row.getByText('Cập nhật link ' + itemId, { exact: true })).toBeVisible();
  await expect(row.getByText('Đăng mới', { exact: true })).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Lọc phần cần đối chiếu', exact: true })
    .selectOption('existing_item_id');
  await expect
    .poll(() =>
      fixture.calls
        .filter((url) => url.pathname.endsWith('/listings'))
        .at(-1)
        ?.searchParams.get('issue'),
    )
    .toBe('existing_item_id');
  await row.getByRole('button', { name: 'Xem nguồn: ' + listing.title, exact: true }).click();
  await page.getByRole('button', { name: 'Ảnh Canva', exact: true }).click();
  await expect(page.getByText('Cập nhật link ' + itemId, { exact: true })).toBeVisible();
  expect(fixture.posts).toEqual([]);
});

test('an invalid source ID is an explicit exception and never labelled as a new listing', async ({
  page,
}) => {
  const fixture = await fixtures(page, { sourceItemId: 'unknown-item' });
  await page.goto('/');
  const row = page.locator('.catalog-table tbody tr').first();
  await expect(
    row.getByText('ID nguồn không hợp lệ · cần kiểm tra', { exact: true }),
  ).toBeVisible();
  await expect(row.getByText('Đăng mới', { exact: true })).toHaveCount(0);
  expect(fixture.posts).toEqual([]);
});
