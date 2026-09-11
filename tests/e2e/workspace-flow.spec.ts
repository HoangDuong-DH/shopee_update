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
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Kho đầu vào', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Bộ listing', exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Bộ listing đã tiếp nhận', exact: true }),
  ).toContainText('Khẩu trang 5D Lamy');
  await page.screenshot({ path: '.local/e2e-artifacts/input-library-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/e2e-artifacts/input-library-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('tab', { name: /^Bảng giá chung/ }).click();
  await page
    .getByTestId('price-book-row')
    .filter({ hasText: 'FILE KINI (MẸ & BÉ, BCS).xlsx' })
    .getByRole('button', { name: 'Tra giá', exact: true })
    .click();
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
    page.getByRole('heading', { name: 'Nhập listing theo thư mục', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Chọn thư mục listing', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('SKU dòng 1', { exact: true })).toHaveCount(0);
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
  await page.getByRole('button', { name: 'Nhập thủ công khi cần', exact: true }).click();
  const workbook = page.getByRole('combobox', { name: 'File bảng giá', exact: true });
  const sourceId = await workbook
    .locator('option')
    .filter({ hasText: 'FILE KINI (MẸ & BÉ, BCS).xlsx' })
    .getAttribute('value');
  expect(sourceId).toBeTruthy();
  await workbook.selectOption(sourceId!);
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Kho đầu vào', exact: true })
    .click();
  const dialog = page.getByRole('alertdialog', { name: 'Thay đổi chưa lưu', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Ở lại', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(workbook).toHaveValue(sourceId!);
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Kho đầu vào', exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Bỏ thay đổi và rời đi', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kho đầu vào', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nhập listing có sẵn', exact: true })).toHaveCount(
    0,
  );
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
  await page.getByRole('tab', { name: /^SKU & phân loại/ }).click();
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

test('explains a disabled save and opens the exact missing field without changing the source', async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await page.getByRole('button', { name: 'Đối chiếu nguồn', exact: true }).click();
  await page.getByRole('button', { name: 'Điều chỉnh nội dung và ảnh', exact: true }).click();
  await page.getByLabel('Tiêu đề listing', { exact: true }).fill('');
  await page.getByRole('tab', { name: /^Bộ ảnh/ }).click();
  await expect(
    page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first(),
  ).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Cần bổ sung tiêu đề' })).toBeVisible();
  await page.getByRole('button', { name: 'Đi đến phần cần bổ sung', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Nội dung', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Tiêu đề listing', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Tiêu đề listing', { exact: true })).toHaveValue('');
  expect(mutations).toEqual([]);
});

test('shows selected media by role and opens an explicit thumbnail picker only when editing', async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await page
    .getByRole('region', { name: 'Việc tiếp theo', exact: true })
    .getByRole('button', { name: /Ảnh bìa và ảnh sản phẩm/ })
    .click();
  await expect(page.getByRole('tab', { name: /^Bộ ảnh/ })).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('list', { name: 'Ảnh đã chọn · Ảnh bìa', exact: true }).getByRole('listitem'),
  ).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Chọn tệp cho ảnh bìa', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Đổi ảnh', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: /^Ảnh listing/ }).click();
  await expect(
    page
      .getByRole('list', { name: 'Ảnh đã chọn · Ảnh listing', exact: true })
      .getByRole('listitem'),
  ).toHaveCount(8);
  await page.getByRole('tab', { name: /^Ảnh mô tả/ }).click();
  await expect(
    page.getByRole('list', { name: 'Ảnh đã chọn · Ảnh mô tả', exact: true }).getByRole('listitem'),
  ).toHaveCount(9);
  await page.getByRole('tab', { name: /^Ảnh bìa/ }).click();
  await page.getByRole('button', { name: 'Điều chỉnh nội dung và ảnh', exact: true }).click();
  await page.getByRole('button', { name: 'Đổi ảnh', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Chọn tệp cho ảnh bìa', exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.locator('button[aria-pressed]').first().locator('img')).toBeVisible();
  await expect(picker.getByLabel('Tìm tệp cho ảnh bìa', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^SKU & phân loại/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const firstVariantPhoto = page
    .getByRole('list', { name: 'Ảnh đã chọn · Ảnh phân loại 1', exact: true })
    .getByRole('img');
  await expect(firstVariantPhoto).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/e2e-artifacts/nontech-variant-mobile.png' });
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
    await page
      .getByRole('navigation', { name: 'Điều hướng chính' })
      .getByRole('button', { name: 'Kho đầu vào', exact: true })
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: 'Kiểm tra listing', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: 'Đang lưu. Đợi kết quả trước' }),
    ).toBeVisible();
    releaseResponse();
    await expect(
      page.getByRole('button', { name: 'Lưu bản kiểm tra theo shop', exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole('alert')).toContainText('Giữ phần đang nhập và thử lại');
    await page
      .getByRole('navigation', { name: 'Điều hướng chính' })
      .getByRole('button', { name: 'Kho đầu vào', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Kho đầu vào', exact: true })).toBeVisible();
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
    await page
      .getByRole('navigation', { name: 'Điều hướng chính' })
      .getByRole('button', { name: 'Kho đầu vào', exact: true })
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: 'Đối chiếu nguồn listing', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(
      page.getByRole('status').filter({ hasText: 'Đang lưu. Đợi kết quả trước' }),
    ).toBeVisible();
    releaseResponse();
    await expect(page.getByRole('alert')).toContainText('Giữ phần đang nhập và thử lại');
    await expect(title).toHaveValue('TEST FIXTURE · Nội dung mới chưa gửi');
    await expect(title).toBeEditable();
    await page
      .getByRole('navigation', { name: 'Điều hướng chính' })
      .getByRole('button', { name: 'Kho đầu vào', exact: true })
      .click();
    const dialog = page.getByRole('alertdialog', { name: 'Thay đổi chưa lưu', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Ở lại', exact: true }).click();
    await expect(title).toHaveValue('TEST FIXTURE · Nội dung mới chưa gửi');
    expect(interceptedWrites).toEqual(['POST']);
  } finally {
    releaseResponse();
  }
});

test('routes next actions to the prepared content and locked SKU structure without editing or writing', async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  const checklist = page.getByRole('region', { name: 'Việc tiếp theo', exact: true });
  await expect(checklist).toBeVisible();
  await checklist.getByRole('button', { name: /Tiêu đề và nội dung/ }).click();
  await expect(page.getByLabel('Tiêu đề listing', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Tiêu đề listing', { exact: true })).not.toBeEditable();
  await page.getByRole('button', { name: 'Quay lại', exact: true }).first().click();
  await checklist.getByRole('button', { name: /Phân loại và giá nguồn/ }).click();
  await expect(page.getByText('Danh sách SKU và phân loại đã khóa', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Phân loại 1', { exact: true })).toHaveValue('CB 100 Cái Trắng');
  await expect(page.getByLabel('Phân loại 1', { exact: true })).not.toBeEditable();
  expect(mutations).toEqual([]);
});

test('fixture: assigning Word paragraphs previews before replacement and keeps literal text and blank lines', async ({
  page,
}) => {
  const wordId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const fixture = {
    id: wordId,
    filename: 'TEST FIXTURE · Nội dung nguyên bản.docx',
    kind: 'docx',
    status: 'ready',
    sha256: 'b'.repeat(64),
    bytes: 2048,
    createdAt: '2026-09-11T00:00:00.000Z',
    message: '',
    body: { paragraphs: ['  Tiêu đề gốc  ', ' Dòng một ', '', 'Dòng cuối  '] },
  };
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  await page.route('**/v1/imports', async (route) => {
    if (route.request().method() !== 'GET') return route.abort();
    return route.fulfill({ json: [fixture] });
  });
  await page.route('**/v1/imports/' + wordId, (route) => route.fulfill({ json: fixture }));
  await page.goto('/');
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await page.getByRole('button', { name: 'Đối chiếu nguồn', exact: true }).click();
  await page.getByRole('button', { name: 'Điều chỉnh nội dung và ảnh', exact: true }).click();
  const title = page.getByLabel('Tiêu đề listing', { exact: true });
  const originalTitle = await title.inputValue();
  await page
    .getByRole('combobox', { name: 'Tệp Word để đối chiếu', exact: true })
    .selectOption(wordId);
  await page.getByRole('button', { name: 'Đưa vào tiêu đề listing', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Xem trước nội dung sẽ điền', exact: true }),
  ).toBeVisible();
  await expect(title).toHaveValue(originalTitle);
  await page.getByRole('button', { name: 'Áp dụng vào tiêu đề listing', exact: true }).click();
  await expect(title).toHaveValue('  Tiêu đề gốc  ');
  await page.getByLabel('Từ đoạn', { exact: true }).fill('2');
  await page.getByLabel('Đến đoạn', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Đưa vào phần chữ sau ảnh', exact: true }).click();
  await page.getByRole('button', { name: 'Áp dụng vào phần chữ sau ảnh', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Nội dung sau toàn bộ ảnh mô tả', exact: true }),
  ).toHaveValue(' Dòng một \n\nDòng cuối  ');
  expect(mutations).toEqual([]);
});

test('fixture: retrying an upload from the editor locks save and preserves unfinished content', async ({
  page,
}) => {
  let releaseRetry!: () => void;
  const heldRetry = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let attempts = 0;
  await page.route('**/v1/imports', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++;
    if (attempts === 2) await heldRetry;
    await route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
  });
  const productWrites: string[] = [];
  await page.route('**/v1/products', async (route) => {
    if (route.request().method() === 'GET') return route.continue();
    productWrites.push(route.request().method());
    return route.abort();
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
    await page.getByRole('button', { name: 'Đối chiếu nguồn', exact: true }).click();
    await page.getByRole('button', { name: 'Điều chỉnh nội dung và ảnh', exact: true }).click();
    const title = page.getByLabel('Tiêu đề listing', { exact: true });
    await title.fill('TEST FIXTURE · Giữ nội dung khi tải lại');
    await page.getByLabel('Tải tệp Word cho listing', { exact: true }).setInputFiles({
      name: 'retry-in-editor.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('browser-upload-retry-only'),
    });
    await expect(
      page.getByTestId('upload-file-row').filter({ hasText: 'retry-in-editor.docx' }),
    ).toContainText('Chưa nhận');
    const retryStarted = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/v1/imports',
    );
    await page.getByRole('button', { name: 'Thử lại 1 tệp chưa nhận', exact: true }).click();
    await retryStarted;
    await expect(title).not.toBeEditable();
    await expect(
      page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first(),
    ).toBeDisabled();
    await expect(title).toHaveValue('TEST FIXTURE · Giữ nội dung khi tải lại');
    releaseRetry();
    await expect(
      page.getByTestId('upload-file-row').filter({ hasText: 'retry-in-editor.docx' }),
    ).toContainText('Chưa nhận');
    await expect(title).toBeEditable();
    await expect(title).toHaveValue('TEST FIXTURE · Giữ nội dung khi tải lại');
    expect(attempts).toBe(2);
    expect(productWrites).toEqual([]);
  } finally {
    releaseRetry();
  }
});

test('discarding an edit to a saved listing keeps a separate unfinished intake recoverable', async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/');
  await page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }).click();
  await page.getByRole('button', { name: 'Nhập thủ công khi cần', exact: true }).click();
  const workbook = page.getByRole('combobox', { name: 'File bảng giá', exact: true });
  const sourceId = await workbook
    .locator('option')
    .filter({ hasText: 'FILE KINI (MẸ & BÉ, BCS).xlsx' })
    .getAttribute('value');
  expect(sourceId).toBeTruthy();
  await workbook.selectOption(sourceId!);
  await page.reload();
  await page.getByRole('button', { name: /Khẩu trang 5D Lamy 3 lớp trắng đen/ }).click();
  await page.getByRole('button', { name: 'Đối chiếu nguồn', exact: true }).click();
  await page.getByRole('button', { name: 'Điều chỉnh nội dung và ảnh', exact: true }).click();
  await page.getByLabel('Tiêu đề listing', { exact: true }).fill('TEST FIXTURE · Bỏ sửa bộ đã lưu');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Kho đầu vào', exact: true })
    .click();
  await page
    .getByRole('alertdialog', { name: 'Thay đổi chưa lưu', exact: true })
    .getByRole('button', { name: 'Bỏ thay đổi và rời đi', exact: true })
    .click();
  await page.getByRole('button', { name: 'Listing của tôi', exact: true }).click();
  await page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }).click();
  await page.getByRole('button', { name: 'Nhập thủ công khi cần', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Bạn có một bộ đang nhập dở', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Tiếp tục phần đang nhập', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'File bảng giá', exact: true })).toHaveValue(
    sourceId!,
  );
  expect(mutations).toEqual([]);
});
