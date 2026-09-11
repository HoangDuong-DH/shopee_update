import { test, expect } from '@playwright/test';
import type { ListingDraft } from '@shopee/domain';

// Read-only acceptance of the operator workflow against the running local workspace.
// A return to global SKU assembly, implicit shop selection, or editable source review
// must fail these checks without creating a draft, plan, job, or Shopee request.
test('starts from prepared listings with a clear next action', async ({ page }) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Listing của tôi', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId('listing-row').filter({ hasText: 'Khẩu trang 5D Lamy' }),
  ).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Ghép.*SKU|Ghép listing từ SKU/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Kế hoạch', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Công việc', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '.local/e2e-artifacts/workspace-home-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Listing của tôi', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/e2e-artifacts/workspace-home-mobile.png' });
  expect(mutations).toEqual([]);
});

test('keeps the price catalog read-only instead of assembling arbitrary SKU groups', async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Tệp nguồn', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Tệp đã nhập', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tra bảng giá', exact: true }).click();
  const workbook = page.getByLabel('File bảng giá', { exact: true });
  await workbook.selectOption({ label: 'FILE KINI (MẸ & BÉ, BCS).xlsx' });
  await page.getByLabel('Tìm SKU', { exact: true }).fill('LMKT5DT100');
  await expect(page.getByRole('cell', { name: /LMKT5DT100/ }).first()).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Ghép.*SKU|Ghép listing/ })).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('opens prepared listing import without creating a product or choosing arbitrary SKU', async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Nhập listing có sẵn', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Ghép.*SKU|Ghép listing/ })).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('preserves unfinished import when staying and discards only after explicit navigation choice', async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }).click();
  const bundleCode = page.getByLabel('Mã bộ listing nội bộ', { exact: true });
  const membership = page.getByLabel('Bảng SKU và phân loại đã chuẩn bị', { exact: true });
  await bundleCode.fill('browser-check-unsaved-only');
  await membership.fill('LMKT5DT100\tCB 100 Cái Trắng');
  await page.getByRole('button', { name: 'Tệp nguồn', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Thay đổi chưa lưu', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Ở lại', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(bundleCode).toHaveValue('browser-check-unsaved-only');
  await expect(membership).toHaveValue('LMKT5DT100\tCB 100 Cái Trắng');
  await page.getByRole('button', { name: 'Tệp nguồn', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Bỏ thay đổi và rời đi', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tệp nguồn', exact: true })).toBeVisible();
  await expect(bundleCode).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('fixture: reviews both classification tiers without flattening or unlocking source labels', async ({
  page,
}) => {
  // Browser-only fixture, deliberately distinct from the real Lamy acceptance cases.
  // It replaces GET /v1/products for this page; no fixture is imported into the database.
  const source = {
    kind: 'user_decision' as const,
    fileSha256: 'browser-fixture-only',
    locator: 'Two-tier readonly UI fixture',
    observedAt: '2026-09-11T00:00:00.000Z',
  };
  const title = 'TEST FIXTURE · Hai nhóm phân loại đã chuẩn bị';
  const fixture: ListingDraft = {
    productKey: 'browser-fixture-two-tiers',
    revision: 1,
    title: { value: title, confirmed: true, sources: [source] },
    description: [{ type: 'text', text: 'Nội dung fixture chưa gửi' }],
    coverKey: '',
    galleryKeys: [],
    assets: [],
    attributes: {},
    logistics: {},
    issues: [],
    tierNames: ['Màu sắc', 'Quy cách'],
    variants: [
      {
        key: 'fixture-a',
        sku: { value: 'TEST-RED-12', confirmed: true, sources: [source] },
        optionLabels: ['Đỏ nguyên bản', '  Gói 12 cái  '],
        originalPrice: { value: '12000', confirmed: true, sources: [source] },
      },
      {
        key: 'fixture-b',
        sku: { value: 'TEST-BLUE-24', confirmed: true, sources: [source] },
        optionLabels: ['Xanh nguyên bản', 'Gói 24 cái'],
        originalPrice: { value: '24000', confirmed: true, sources: [source] },
      },
    ],
    sourceSelection: {
      title,
      headline: 'Nội dung fixture chưa gửi',
      body: '',
      galleryIds: [],
      descriptionImageIds: [],
      tierNames: ['Màu sắc', 'Quy cách'],
      variants: [
        {
          importId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          rowKey: 'fixture-a',
          optionLabels: ['Đỏ nguyên bản', '  Gói 12 cái  '],
        },
        {
          importId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          rowKey: 'fixture-b',
          optionLabels: ['Xanh nguyên bản', 'Gói 24 cái'],
        },
      ],
    },
  };
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.route('**/v1/products', async (route) => {
    if (route.request().method() !== 'GET') return route.abort();
    await route.fulfill({ json: [fixture] });
  });
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByTestId('variant-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Đối chiếu nguồn', exact: true }).click();
  await expect(page.getByText('Danh sách SKU và phân loại đã khóa', { exact: true })).toBeVisible();
  const controls = await page.locator('input,textarea').evaluateAll((elements) =>
    elements.map((element) => {
      const control = element as HTMLInputElement | HTMLTextAreaElement;
      return { value: control.value, locked: control.readOnly || control.disabled };
    }),
  );
  for (const value of [
    'Màu sắc',
    'Quy cách',
    'Đỏ nguyên bản',
    '  Gói 12 cái  ',
    'Xanh nguyên bản',
    'Gói 24 cái',
  ]) {
    expect(controls).toContainEqual({ value, locked: true });
  }
  expect(mutations).toEqual([]);
});

test('fixture: keeps the listing screen stable while a plan save is pending', async ({ page }) => {
  // The POST response is deliberately held in the browser and then rejected.
  // The request never reaches the API, database, or Shopee; this exercises UI recovery only.
  let releaseResponse!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const interceptedWrites: string[] = [];
  await page.route('**/v1/plans', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    interceptedWrites.push(route.request().method());
    await heldResponse;
    await route.fulfill({ status: 503, json: { code: 'TEST_FIXTURE_SAVE_UNAVAILABLE' } });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
    const shop = page.getByLabel('Shop đích', { exact: true });
    const sandboxValue = await shop
      .locator('option')
      .filter({ hasText: '227418363' })
      .getAttribute('value');
    expect(sandboxValue).toBeTruthy();
    await shop.selectOption(sandboxValue!);
    const requestStarted = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/v1/plans',
    );
    await page.getByRole('button', { name: 'Lưu bản kiểm tra theo shop', exact: true }).click();
    await requestStarted;
    await expect(page.getByRole('button', { name: 'Đối chiếu nguồn', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Tệp nguồn', exact: true }).click({ force: true });
    await expect(
      page.getByRole('heading', { name: 'Kiểm tra listing', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /Đang lưu/i })).toBeVisible();
    releaseResponse();
    await expect(
      page.getByRole('button', { name: 'Lưu bản kiểm tra theo shop', exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole('alert')).toContainText('TEST_FIXTURE_SAVE_UNAVAILABLE');
    await page.getByRole('button', { name: 'Tệp nguồn', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tệp nguồn', exact: true })).toBeVisible();
    expect(interceptedWrites).toEqual(['POST']);
  } finally {
    releaseResponse();
  }
});

test('fixture: retains edited content after a failed save and blocks navigation while saving', async ({
  page,
}) => {
  // Only POST /v1/products is intercepted. The changed title remains browser state;
  // the held request is rejected without reaching the local API or changing real Lamy data.
  let releaseResponse!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const interceptedWrites: string[] = [];
  await page.route('**/v1/products', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    interceptedWrites.push(route.request().method());
    await heldResponse;
    await route.fulfill({ status: 503, json: { code: 'TEST_FIXTURE_PRODUCT_SAVE_UNAVAILABLE' } });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
    await page.getByRole('button', { name: 'Đối chiếu nguồn', exact: true }).click();
    await page.getByRole('button', { name: 'Điều chỉnh nội dung và ảnh', exact: true }).click();
    const title = page.getByLabel('Tiêu đề listing', { exact: true });
    await title.fill('TEST FIXTURE · Nội dung mới chưa gửi');
    const requestStarted = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname === '/v1/products',
    );
    await page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first().click();
    await requestStarted;
    await page.getByRole('button', { name: 'Tệp nguồn', exact: true }).click({ force: true });
    await expect(
      page.getByRole('heading', { name: 'Đối chiếu nguồn listing', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /Đang lưu/i })).toBeVisible();
    releaseResponse();
    await expect(page.getByRole('alert')).toContainText('TEST_FIXTURE_PRODUCT_SAVE_UNAVAILABLE');
    await expect(title).toHaveValue('TEST FIXTURE · Nội dung mới chưa gửi');
    await expect(title).toBeEditable();
    await page.getByRole('button', { name: 'Tệp nguồn', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Thay đổi chưa lưu', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Ở lại', exact: true }).click();
    await expect(title).toHaveValue('TEST FIXTURE · Nội dung mới chưa gửi');
    expect(interceptedWrites).toEqual(['POST']);
  } finally {
    releaseResponse();
  }
});
