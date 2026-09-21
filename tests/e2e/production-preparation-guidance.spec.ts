import { test, expect, type Page } from '@playwright/test';

const priceId = '252d91d1-93c7-429a-a4fc-1e719a0bbaf9';
const previewId = '1651c52c-4cc8-4b57-951a-6b9b4d6b2281';
const products = [
  { productKey: 'guidance-que', title: 'Nước Lau Sàn Hương Quế' },
  { productKey: 'guidance-sa', title: 'Xịt Cam Sả' },
];
const fields = [
  'categoryId',
  'brandId',
  'brandName',
  'condition',
  'preOrder',
  'dimensionCm',
  'stockLocation',
];
const fact = (value: unknown) => ({ value, confirmed: true, sources: [] });
async function fixture(page: Page, slow = false) {
  const requests: { path: string; body: any }[] = [];
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const appOrigin = new URL(String(test.info().project.use.baseURL)).origin;
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === appOrigin ? route.continue() : route.abort(),
  );
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (route.request().method() === 'POST') {
      requests.push({ path, body: route.request().postDataJSON() });
      if (path !== '/v1/production-preparations/preview') return route.abort();
      if (slow) await waiting;
      return route.fulfill({
        json: {
          id: previewId,
          fingerprint: 'a'.repeat(64),
          readyCount: 0,
          blockedCount: products.length,
          publicationMode: 'hidden_for_review',
          entries: products.map((product) => ({
            ...product,
            kind: 'blocked',
            issues: [
              ...fields.map((field) => ({
                field,
                code: 'OPERATING_FIELD_REQUIRED',
                message: 'Cần bổ sung thông tin vận hành có nguồn.',
              })),
              {
                field: 'dimensionCm',
                code: 'OPERATING_FIELD_REQUIRED',
                message: 'Cần bổ sung thông tin vận hành có nguồn.',
              },
            ],
          })),
        },
      });
    }
    if (path === '/v1/production-preparations/context')
      return route.fulfill({
        json: {
          scope: { shopId: '1423724897' },
          products: products.map((p) => ({ ...p, revision: 1, skus: ['SKU-A'], issues: [] })),
          pricebooks: [{ id: priceId, filename: 'DORIS.xlsx' }],
          preparations: [],
        },
      });
    if (path === '/v1/production-preparations/metadata')
      return route.fulfill({
        json: {
          shop: { id: '1423724897', name: 'vuatinhdau.vn' },
          categories: [{ id: '10', label: 'Làm thơm nhà', path: 'Nhà cửa > Làm thơm nhà' }],
          attributes: [],
          brands: {
            items: [{ id: '20', name: 'VINA TƯƠI', label: 'VINA TƯƠI' }],
            hasNextPage: false,
            nextOffset: null,
          },
          channels: [
            {
              id: '50',
              name: 'Vận chuyển của shop',
              enabled: true,
              forceEnabled: false,
              compulsory: false,
            },
          ],
          itemLimits: { sizeChart: { mandatory: false } },
        },
      });
    const product = products.find((p) => path === '/v1/products/' + p.productKey);
    if (product)
      return route.fulfill({
        json: {
          productKey: product.productKey,
          revision: 1,
          title: fact(product.title),
          sourceSelection: {
            title: product.title,
            headline: '',
            body: 'Nội dung nguồn',
            coverId: 'cover',
            galleryIds: ['gallery'],
            descriptionImageIds: [],
            tierNames: ['Dung tích'],
            variants: [
              { importId: priceId, rowKey: 'row1', optionLabels: ['100ml'], imageId: 'variant' },
            ],
          },
          description: [{ type: 'text', text: 'Nội dung nguồn' }],
          coverKey: 'cover',
          galleryKeys: ['gallery'],
          tierNames: ['Dung tích'],
          variants: [
            {
              key: 'row1',
              sku: fact('SKU-A'),
              optionLabels: ['100ml'],
              originalPrice: fact('125000'),
              declaredWeightGrams: fact('130.9'),
              imageKey: 'variant',
            },
          ],
          attributes: {},
          logistics: {},
          assets: [],
          issues: [],
        },
      });
    if (path === '/v1/imports/' + priceId)
      return route.fulfill({
        json: {
          id: priceId,
          filename: 'DORIS.xlsx',
          body: { rows: [{ key: 'row1', sheet: 'DORIS', priceProfile: 'SHOP MALL' }] },
        },
      });
    if (path === '/v1/production-batches') return route.fulfill({ json: { batches: [] } });
    if (path.startsWith('/v1/media/')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ json: path === '/v1/status' ? { worker: 'online' } : [] });
  });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true }).click();
  const region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  return { region, requests, release };
}

test('idle preparation polls only small status and restores its location on reload', async ({ page }) => {
  await page.clock.install();
  await fixture(page);
  const paths: string[] = [];
  page.on('request', request => paths.push(new URL(request.url()).pathname));
  await page.clock.runFor(16_000);
  expect(paths.filter(path => path === '/v1/status').length).toBeGreaterThan(0);
  for (const path of ['/v1/imports', '/v1/products', '/v1/shops', '/v1/plans', '/v1/jobs'])
    expect(paths.filter(value => value === path)).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('slow autofill shows local waiting and cancellation keeps input and selection', async ({ page }) => {
  const f = await fixture(page);
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/v1/production-preparations/autofill', async route => {
    await delayed;
    await route.abort().catch(() => {});
  });
  await f.region.getByRole('button', { name: 'Chọn 2 listing trong kết quả', exact: true }).click();
  const stock = f.region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn', { exact: true });
  await stock.fill('1000');
  const fill = f.region.getByRole('button', { name: 'Điền nhanh cả lô · 2 listing', exact: true });
  await expect(fill).toBeEnabled();
  await fill.click();
  await expect(f.region.getByText(/Đang tra ngành, thương hiệu và vận chuyển/)).toBeVisible();
  await expect(fill).toBeDisabled();
  await f.region.getByRole('button', { name: 'Dừng chờ, giữ phần đã nhập', exact: true }).click();
  await expect(fill).toBeEnabled();
  await expect(stock).toHaveValue('1000');
  await expect(f.region.getByRole('button', { name: 'Kiểm tra 2 listing đã chọn', exact: true })).toBeEnabled();
  release();
  expect(f.requests).toEqual([]);
});

test('missing operating issues name each field, deduplicate and navigate to the correct product without a write', async ({
  page,
}) => {
  const f = await fixture(page);
  expect(f.requests).toEqual([]);
  await f.region.getByRole('button', { name: 'Chọn 2 listing trong kết quả', exact: true }).click();
  await f.region.getByRole('button', { name: 'Kiểm tra 2 listing đã chọn', exact: true }).click();
  const result = f.region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' });
  await expect(result).toBeFocused();
  await expect(result).toBeInViewport();
  await expect(result).not.toContainText('Cần bổ sung thông tin vận hành có nguồn.');
  await result.screenshot({
    path: '.local/e2e-artifacts/preparation-guidance/operating-fields-desktop.png',
  });
  const second = result
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: /^Xịt Cam Sả · Cần bổ sung/ }) });
  await expect(second.locator('.preparation-issue-list > li')).toHaveCount(6);
  await expect(
    second.getByRole('button', { name: 'Bổ sung thương hiệu', exact: true }),
  ).toHaveCount(1);
  await expect(
    second.getByText('2 vị trí cần kiểm tra trong mục này.', { exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole('button', { name: 'Bổ sung kích thước kiện hàng', exact: true }),
  ).toHaveCount(1);
  await second.getByRole('button', { name: 'Bổ sung kích thước kiện hàng', exact: true }).click();
  const editor = f.region
    .locator('.preparation-entry')
    .filter({ has: page.getByText('Xịt Cam Sả · 1 SKU', { exact: true }) });
  await expect(editor.getByLabel('Dài kiện hàng (cm)', { exact: true })).toBeFocused();
  await expect(editor.getByLabel('Dài kiện hàng (cm)', { exact: true })).toBeInViewport();
  expect(f.requests.map((r) => r.path)).toEqual(['/v1/production-preparations/preview']);
  await editor.getByLabel('Dài kiện hàng (cm)', { exact: true }).fill('12');
  await expect(result).toHaveCount(0);
  await expect(
    f.region.getByText('Thông tin đã thay đổi. Kiểm tra lại các listing trước khi chuẩn bị đợt.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(f.requests.filter((r) => r.path.endsWith('/register') || r.path.endsWith('/run'))).toEqual(
    [],
  );
});

test('preview waits visibly, prevents duplicate submissions and preserves hidden mode', async ({
  page,
}) => {
  const f = await fixture(page, true);
  await f.region.getByRole('button', { name: 'Chọn 2 listing trong kết quả', exact: true }).click();
  await f.region.getByRole('button', { name: 'Kiểm tra 2 listing đã chọn', exact: true }).click();
  await expect(
    f.region.locator('.preparation-progress').filter({ hasText: 'Đang kiểm tra 2 listing' }),
  ).toBeVisible();
  await expect(f.region.getByRole('button', { name: 'Đang xử lý…', exact: true })).toBeDisabled();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].body.publicationMode).toBe('hidden_for_review');
  f.release();
  await expect(f.region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' })).toBeFocused();
  await expect(
    f.region.getByRole('button', { name: 'Chuẩn bị đợt cho 0 listing đủ nguồn', exact: true }),
  ).toBeDisabled();
  expect(f.requests).toHaveLength(1);
});

test('warehouse issue points to the read-only warehouse action and mobile guidance stays in the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  await f.region.getByRole('button', { name: 'Chọn 2 listing trong kết quả', exact: true }).click();
  await f.region.getByRole('button', { name: 'Kiểm tra 2 listing đã chọn', exact: true }).click();
  const result = f.region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' });
  await result.getByRole('button', { name: 'Bổ sung kho áp dụng', exact: true }).last().click();
  const editor = f.region
    .locator('.preparation-entry')
    .filter({ has: page.getByText('Xịt Cam Sả · 1 SKU', { exact: true }) });
  await expect(
    editor.getByRole('button', { name: 'Chọn listing tham khảo kho', exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(f.requests).toHaveLength(1);
});

test('source conflicts and unknown fields retain their original explanations without suggesting an operating override', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.route('**/v1/production-preparations/preview', (route) =>
    route.fulfill({
      json: {
        id: previewId,
        fingerprint: 'a'.repeat(64),
        readyCount: 0,
        blockedCount: 1,
        publicationMode: 'hidden_for_review',
        entries: [
          {
            ...products[0],
            kind: 'blocked',
            issues: [
              {
                code: 'CONFIRMED_FACT_CONFLICT',
                field: 'categoryId',
                message: 'Lựa chọn khác dữ kiện đã xác nhận; cần sửa nguồn bằng phiên bản riêng.',
              },
              {
                code: 'UNKNOWN_SOURCE',
                field: 'quyCachMoi',
                message: 'Quy cách trong nguồn cần đối chiếu riêng.',
              },
              { code: 'SOURCE_UNAVAILABLE', message: 'Chưa đọc được nguồn đã lưu.' },
            ],
          },
        ],
      },
    }),
  );
  await f.region.getByRole('checkbox', { name: 'Nước Lau Sàn Hương Quế', exact: false }).check();
  await f.region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn', exact: true }).click();
  const result = f.region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' });
  await expect(
    result.getByText('Lựa chọn khác dữ kiện đã xác nhận; cần sửa nguồn bằng phiên bản riêng.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(result.getByText('quyCachMoi', { exact: true })).toBeVisible();
  await expect(result.getByText('Bộ nguồn', { exact: true })).toBeVisible();
  await expect(result.getByRole('button', { name: 'Bổ sung ngành hàng', exact: true })).toHaveCount(
    0,
  );
  await expect(result.getByRole('button', { name: 'Đối chiếu bộ nguồn', exact: true })).toHaveCount(
    3,
  );
  await expect(result).not.toContainText('undefined');
  expect(f.requests).toEqual([]);
});

test('warehouse selector reaches hidden listings and later pages, retains the chosen item and drops obsolete proof', async ({
  page,
}) => {
  const f = await fixture(page),
    metadataQueries: URLSearchParams[] = [];
  await page.route('**/v1/production-preparations/metadata*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    metadataQueries.push(query);
    const base: any = {
      shop: { id: '1423724897', name: 'vuatinhdau.vn' },
      categories: [],
      channels: [],
      attributes: [],
    };
    if (query.get('includeInventory') === 'true') {
      const hidden = query.get('inventoryStatus') === 'UNLIST',
        later = query.get('inventoryOffset') === '20';
      base.inventory = {
        items: hidden
          ? [
              {
                itemId: later ? '502' : '501',
                title: later ? 'Listing ẩn trang sau' : 'Listing ẩn trang đầu',
              },
            ]
          : [],
        hasNextPage: hidden && !later,
        nextOffset: hidden && !later ? 20 : null,
        status: hidden ? 'UNLIST' : 'NORMAL',
      };
    }
    if (query.has('referenceItemId')) {
      const verified = query.get('referenceItemId') === '502';
      base.reference = {
        itemId: query.get('referenceItemId'),
        title: verified ? 'Listing ẩn trang sau' : 'Listing chưa đủ bằng chứng',
        writeMappingVerified: verified,
        stockLocations: [],
        ...(verified
          ? {
              writeMapping: {
                expectedLocationId: 'READ-TEST',
                writeLocationId: 'WRITE-TEST',
                verifiedOperationId: 'proof-only',
                verificationFingerprint: 'b'.repeat(64),
                referenceRequestId: 'read-1',
                warehouseRequestId: 'warehouse-1',
              },
            }
          : {}),
      };
    }
    return route.fulfill({ json: base });
  });
  await f.region.getByRole('checkbox', { name: 'Nước Lau Sàn Hương Quế', exact: false }).check();
  const editor = f.region.locator('.preparation-entry');
  await editor.getByRole('button', { name: 'Chọn listing tham khảo kho', exact: true }).click();
  await expect(editor.getByText('Chưa có listing trong nhóm này.', { exact: false })).toBeVisible();
  await editor
    .getByRole('combobox', { name: 'Trạng thái listing tham khảo kho', exact: true })
    .selectOption('UNLIST');
  await expect(
    editor.getByRole('combobox', { name: 'Listing đang có tại shop', exact: true }).locator('option'),
  ).toHaveCount(2);
  await editor.getByRole('button', { name: 'Tải thêm listing tham khảo kho', exact: true }).click();
  await expect(
    editor.getByRole('combobox', { name: 'Listing đang có tại shop', exact: true }).locator('option'),
  ).toHaveCount(3);
  await editor.getByRole('combobox', { name: 'Listing đang có tại shop', exact: true }).selectOption('502');
  await expect(
    editor.getByText('Đã có đối chiếu kho cho đúng shop và các SKU đã chọn.', { exact: true }),
  ).toBeVisible();
  await expect(editor.getByRole('combobox', { name: 'Listing đang có tại shop', exact: true })).toHaveValue('502');
  await expect(
    editor.getByRole('combobox', { name: 'Listing đang có tại shop', exact: true }).locator('option'),
  ).toHaveCount(3);
  await editor.getByRole('combobox', { name: 'Listing đang có tại shop', exact: true }).selectOption('501');
  await expect(
    editor.getByText('Đã đọc thông tin; chưa đủ bằng chứng', { exact: false }),
  ).toBeVisible();
  await expect(
    editor.getByText('Đã có đối chiếu kho cho đúng shop và các SKU đã chọn.', { exact: true }),
  ).toHaveCount(0);
  await f.region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn', exact: true }).click();
  expect(f.requests[0].body.entries[0].choices.stockLocation).toBeUndefined();
  expect(
    metadataQueries.some(
      (q) => q.get('inventoryStatus') === 'UNLIST' && q.get('inventoryOffset') === '20',
    ),
  ).toBe(true);
  expect(f.requests.map((r) => r.path)).toEqual(['/v1/production-preparations/preview']);
});

test('parcel dimension inputs explain whole centimeters and preserve a fractional value for correction', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.region.getByRole('checkbox', { name: 'Nước Lau Sàn Hương Quế', exact: false }).check();
  const editor = f.region.locator('.preparation-entry');
  for (const axis of ['Dài', 'Rộng', 'Cao']) {
    const field = editor.getByLabel(axis + ' kiện hàng (cm)', { exact: false });
    await expect(field).toHaveAttribute('min', '1');
    await expect(field).toHaveAttribute('step', '1');
  }
  const length = editor.getByLabel('Dài kiện hàng (cm)', { exact: false });
  await length.fill('12.5');
  await expect(length).toHaveValue('12.5');
  expect(await length.evaluate((input: HTMLInputElement) => input.validity.stepMismatch)).toBe(
    true,
  );
  await expect(
    editor.getByText('Số nguyên từ 1 cm; theo số đo kiện đóng gói.', { exact: true }),
  ).toHaveCount(3);
  expect(f.requests).toEqual([]);
});
