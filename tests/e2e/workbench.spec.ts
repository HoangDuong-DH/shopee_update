import { test, expect, type Page } from '@playwright/test';
import type {
  HandoffDocument,
  ListingDraft,
  ShopConnection,
  WorkIssue,
  WorkOrderConfig,
  WorkOrderView,
  SandboxRun,
  SandboxSnapshot,
} from '@shopee/domain';

// Every endpoint, including reads, is a browser fixture. No work order or Shopee write reaches a server.
const time = '2026-09-11T09:00:00.000Z';
const sourceRef = {
  kind: 'product_file' as const,
  fileSha256: 'f'.repeat(64),
  locator: 'Synthetic operator acceptance',
  observedAt: time,
};
const fact = (value: string) => ({ value, confirmed: true, sources: [sourceRef] });
const sources: ListingDraft[] = ['Khẩu trang mẫu hai tầng', 'Sổ tay mẫu không phân loại'].map(
  (name, index) => ({
    productKey: 'fixture-' + index,
    revision: 1,
    title: fact(name),
    description: [{ type: 'text', text: 'Nội dung đã chuẩn bị\nGiữ nguyên xuống dòng.' }],
    coverKey: '',
    galleryKeys: [],
    tierNames: index ? [] : ['Màu', 'Quy cách'],
    variants: [
      {
        key: 'v' + index,
        sku: fact('TEST-SKU-' + index),
        optionLabels: index ? [] : ['Trắng', '100 cái'],
        originalPrice: fact('137998'),
      },
    ],
    assets: [],
    attributes: {},
    logistics: {},
    issues: [],
  }),
);
const shop: ShopConnection = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Shop thử vận hành',
  region: 'VN',
  state: 'connected',
  updatedAt: time,
  capabilities: [],
  scope: {
    environment: 'sandbox',
    partnerId: '1232297',
    shopId: '227418363',
    connectionRevision: 1,
    capabilityRevision: 1,
  },
};
const production: ShopConnection = {
  ...shop,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Shop thật chỉ đọc',
  scope: { ...shop.scope, environment: 'production', shopId: '999' },
};
const baseConfig: WorkOrderConfig = {
  productKey: sources[0]!.productKey,
  sourceRevision: 1,
  connectionId: shop.id,
  operation: 'update',
  itemId: '803934364',
  fieldMask: ['title'],
  stocks: {},
};
function order(
  config: WorkOrderConfig = baseConfig,
  issues: WorkIssue[] = [],
  id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
): WorkOrderView {
  return {
    id,
    revision: 1,
    config: structuredClone(config),
    source: sources.find((row) => row.productKey === config.productKey)!,
    shop: config.connectionId === production.id ? production : shop,
    latestSourceRevision: 1,
    sandboxRun: null,
    sandboxRunMatchesConfig: false,
    issues,
    state: issues.length ? 'needs_attention' : 'ready_to_check',
    createdAt: time,
    updatedAt: time,
  };
}
const snapshot: SandboxSnapshot = {
  itemId: '803934364',
  title: 'Tiêu đề cũ trên sandbox',
  descriptionType: 'extended',
  description: [{ type: 'text', text: 'Mô tả gốc' }],
  gallery: { imageIds: ['image-a'], ratio: '3:4' },
  coverImageIds: ['cover'],
  categoryId: '300018',
  status: 'NORMAL',
  tierNames: sources[0]!.tierNames,
  models: [
    {
      modelId: '1',
      sku: 'TEST-SKU-0',
      tierIndex: [0, 0],
      optionLabels: ['Trắng', '100 cái'],
      originalPrice: '137998',
      currentPrice: '137998',
      currency: 'VND',
      availableStock: 100,
      reservedStock: 0,
    },
  ],
  protectedFields: {},
  fingerprint: 'a'.repeat(64),
  observedAt: time,
  requestIds: ['fixture-read'],
};

async function fixture(page: Page, initial = [order()]) {
  const writes: { path: string; body: any }[] = [];
  const unexpected: string[] = [];
  let orders = structuredClone(initial),
    run: SandboxRun | null = null;
  let dropExecuteReply = false;
  let driftExecution = false,
    failPrepare = false,
    readCount = 0;
  let failSave = false,
    unknown = false;
  await page.route('**/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const write = request.method() === 'POST';
    const body = write ? request.postDataJSON() : null;
    if (path === '/v1/import-patches' && !write) return route.fulfill({ json: [] });
    if (write) writes.push({ path, body });
    if (path === '/v1/workbench' && !write)
      return route.fulfill({
        json: {
          orders: orders.map((row) => ({
            ...row,
            sandboxRun:
              run &&
              row.config.connectionId === run.connectionId &&
              row.config.itemId === run.itemId
                ? run
                : null,
            sandboxRunMatchesConfig:
              !!run &&
              row.config.productKey === run.productKey &&
              row.config.sourceRevision === run.sourceRevision,
          })),
          sources,
          shops: [shop, production],
          execution: { productionWrites: false, sandboxUpdates: true, createEnabled: false },
        },
      });
    if (path === '/v1/work-orders' && write) {
      if (failSave) {
        failSave = false;
        return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
      }
      const found = orders.find((row) => row.id === body.id);
      const result = {
        ...order(body.config, [], body.id),
        revision: found ? found.revision + 1 : 1,
      };
      orders = [result, ...orders.filter((row) => row.id !== result.id)];
      return route.fulfill({ json: result });
    }
    if (path === '/v1/sandbox-listings/read' && write)
      return route.fulfill({
        json: {
          scope: shop.scope,
          snapshot: {
            ...snapshot,
            fingerprint: readCount++ ? 'b'.repeat(64) : snapshot.fingerprint,
          },
          source: {
            productKey: body.productKey,
            revision: body.sourceRevision,
            title: sources[0]!.title.value,
            skus: ['TEST-SKU-0'],
          },
          comparison: [{ field: 'title', state: 'different' }],
          limits: null,
          checks: [],
          capabilities: {
            title: 'available',
            description: 'requires_preflight',
            gallery: 'requires_preflight',
            cover: 'not_implemented',
            productionWrite: false,
            automaticTokenRefresh: false,
          },
        },
      });
    if (path === '/v1/sandbox-listings/prepare' && write) {
      if (failPrepare) {
        failPrepare = false;
        return route.fulfill({ status: 409, json: { code: 'SANDBOX_BASELINE_CHANGED' } });
      }
      run = {
        id: body.id,
        workOrderId: body.workOrderId,
        workOrderRevision: body.workOrderRevision,
        revision: 1,
        state: 'prepared',
        connectionId: body.connectionId,
        itemId: body.itemId,
        productKey: body.productKey,
        sourceRevision: body.sourceRevision,
        fieldMask: body.fieldMask,
        baseline: { ...snapshot, fingerprint: body.baselineFingerprint },
        preview: [{ field: 'title', before: snapshot.title, after: sources[0]!.title.value }],
        uploads: [],
        result: null,
        createdAt: time,
        updatedAt: time,
      };
      return route.fulfill({ json: run });
    }
    if (run && path === '/v1/sandbox-listings/runs/' + run.id && !write)
      return route.fulfill({ json: run });
    if (run && path === `/v1/sandbox-listings/runs/${run.id}/execute` && write) {
      run = {
        ...run,
        revision: 2,
        state: driftExecution ? 'drift' : unknown ? 'unknown' : 'verified',
        result: driftExecution
          ? {
              code: 'BASELINE_CHANGED',
              message: 'Dữ liệu hiện tại đã thay đổi trước khi ghi.',
              requestIds: [],
            }
          : unknown
            ? {
                code: 'UNKNOWN',
                message: 'Mất phản hồi sau khi gửi; chưa xác định kết quả.',
                requestIds: [],
              }
            : {
                code: 'VERIFIED',
                message: 'Đã đọc lại và khớp dữ liệu.',
                requestIds: ['fixture-write'],
                selectedFieldsMatch: true,
                unselectedFieldsMatch: true,
                after: { ...snapshot, title: sources[0]!.title.value },
              },
      };
      if (dropExecuteReply) return route.abort('connectionfailed');
      return route.fulfill({ json: run });
    }
    if (run && path === `/v1/sandbox-listings/runs/${run.id}/reconcile` && write) {
      run = {
        ...run,
        revision: 3,
        state: 'verified',
        result: {
          code: 'VERIFIED',
          message: 'Đã đọc lại xác nhận; không gửi thay đổi lần nữa.',
          requestIds: ['fixture-reconcile-'.repeat(6)],
          selectedFieldsMatch: true,
          unselectedFieldsMatch: true,
          after: { ...snapshot, title: sources[0]!.title.value },
        },
      };
      return route.fulfill({ json: run });
    }
    if (!write && path === '/v1/products') return route.fulfill({ json: sources });
    if (!write && path === '/v1/shops') return route.fulfill({ json: [shop, production] });
    if (!write && ['/v1/imports', '/v1/plans', '/v1/jobs'].includes(path))
      return route.fulfill({ json: [] });
    if (!write && path === '/v1/status') return route.fulfill({ json: { worker: 'online' } });
    if (write) unexpected.push(path);
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return {
    writes,
    unexpected,
    failNextSave: () => {
      failSave = true;
    },
    unknownExecution: () => {
      unknown = true;
    },
    loseExecuteReply: () => {
      dropExecuteReply = true;
    },
    driftExecution: () => {
      driftExecution = true;
    },
    failPrepareOnce: () => {
      failPrepare = true;
    },
  };
}

test('fixture: workbench starts with concrete exceptions and stays usable on mobile', async ({
  page,
}) => {
  const issues: WorkIssue[] = [
    {
      code: 'FIELD',
      kind: 'mapping_needed',
      field: 'itemId',
      message: 'Chưa xác định đúng link cần cập nhật.',
      action: 'Điền mã sản phẩm của đúng shop.',
    },
    {
      code: 'UNSUPPORTED',
      kind: 'unsupported',
      field: 'price',
      message: 'Chưa có luồng gửi thay đổi giá.',
      action: 'Cần bổ sung tính năng ứng dụng.',
    },
  ];
  const state = await fixture(page, [order(baseConfig, issues)]);
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Công việc đăng hàng', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('work-order-row')).toContainText('Cần xác định cách ghép');
  await expect(
    page.getByRole('button', { name: 'Nhận thư mục listing', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '.local/e2e-artifacts/operation-workbench-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: '.local/e2e-artifacts/operation-workbench-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: /^Làm tiếp / }).click();
  await page.getByText('Thiết lập nâng cao / cách nhập thủ công', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Cần xác định cách ghép', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Ứng dụng chưa hỗ trợ', exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
});

test('fixture: select prepared sources and explicit shop creates separate work orders only', async ({
  page,
}) => {
  const state = await fixture(page, []);
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: 'Chọn bộ đã có', exact: true }).first().click();
  const form = page.getByRole('region', { name: 'Tạo công việc từ bộ đã có' });
  await expect(form.getByRole('button', { name: /Lưu .*công việc/ })).toBeDisabled();
  await form.getByRole('checkbox', { name: /Khẩu trang mẫu hai tầng/ }).check();
  await form.getByRole('checkbox', { name: /Sổ tay mẫu không phân loại/ }).check();
  await page.getByLabel('Shop đích cho công việc mới').selectOption(shop.id);
  await page.getByLabel('Loại công việc mới').selectOption('update');
  await form.getByRole('button', { name: 'Lưu 2 công việc', exact: true }).click();
  await expect(page.getByTestId('work-order-row')).toHaveCount(2);
  expect(state.writes).toHaveLength(2);
  expect(new Set(state.writes.map((request) => request.body.id)).size).toBe(2);
  for (const request of state.writes) {
    expect(request.path).toBe('/v1/work-orders');
    expect(request.body.config.connectionId).toBe(shop.id);
    expect(request.body.config.stocks).toEqual({});
    expect(request.body.config.itemId).toBeNull();
    expect(request.body.config.fieldMask).toEqual([]);
  }
  expect(state.unexpected).toEqual([]);
});

test('fixture: blank stock remains undecided and explicit zero survives a failed save', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: /^Làm tiếp / }).click();
  await page.getByText('Thiết lập nâng cao / cách nhập thủ công', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Tồn đăng bán', exact: true }).check();
  const stock = page.getByLabel('Tồn đăng bán TEST-SKU-0', { exact: true });
  await expect(stock).toHaveValue('');
  await stock.fill('0');
  state.failNextSave();
  await page.getByRole('button', { name: 'Lưu lựa chọn công việc', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Lựa chọn đang nhập vẫn được giữ');
  await expect(stock).toHaveValue('0');
  await page.getByRole('button', { name: 'Lưu lựa chọn công việc', exact: true }).click();
  await expect(page.getByText('Đã lưu trong ứng dụng', { exact: true })).toBeVisible();
  expect(state.writes[0]!.body).toEqual(state.writes[1]!.body);
  expect(state.writes[1]!.body.config.stocks).toEqual({ 'TEST-SKU-0': 0 });
  expect(state.writes.some((request) => request.path.includes('sandbox-listings'))).toBe(false);
});

test('fixture: sandbox flow selects fields, previews exact changes, and reconciles unknown without retrying write', async ({
  page,
}) => {
  const state = await fixture(page);
  state.unknownExecution();
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: /^Làm tiếp / }).click();
  await page.getByText('Thiết lập nâng cao / cách nhập thủ công', { exact: true }).click();
  await page.getByRole('button', { name: 'Đọc & đối chiếu sandbox', exact: true }).click();
  await expect(page.getByText('Tiêu đề cũ trên sandbox', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Xem trước những phần sẽ đổi', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: 'Tôi đã xem đúng link sandbox và những phần sẽ thay đổi.',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Chưa xác định kết quả ghi', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Mã sản phẩm trên Shopee', { exact: true })).toBeDisabled();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: /^Làm tiếp / }).click();
  await page.getByText('Thiết lập nâng cao / cách nhập thủ công', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Chưa xác định kết quả ghi', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Đọc lại & đối chiếu kết quả', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Đã đọc lại và đối chiếu', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Đã đối chiếu giữ nguyên', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Mã sản phẩm trên Shopee', { exact: true })).toBeEnabled();
  await expect(
    page.getByText('Chưa kiểm tra; đối chiếu dữ liệu không đồng nghĩa được duyệt', { exact: true }),
  ).toBeVisible();
  expect(state.writes.filter((request) => request.path.endsWith('/execute'))).toHaveLength(1);
  expect(state.writes.filter((request) => request.path.endsWith('/reconcile'))).toHaveLength(1);
  const prepare = state.writes.find((request) => request.path.endsWith('/prepare'))!;
  expect(prepare.body.fieldMask).toEqual(['title']);
  expect(prepare.body.workOrderId).toBe(order().id);
  expect(prepare.body.workOrderRevision).toBe(1);
  expect(prepare.body.baselineFingerprint).toBe(snapshot.fingerprint);
  await page.getByText('Thông tin tra cứu lần thực hiện', { exact: true }).click();
  await expect(
    page.getByText('Mã lần thực hiện: ' + prepare.body.id, { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: '.local/e2e-artifacts/workbench-result-mobile.png',
    fullPage: true,
  });
  expect(state.unexpected).toEqual([]);
});

test('fixture: production task cannot enter sandbox execution', async ({ page }) => {
  const state = await fixture(page, [order({ ...baseConfig, connectionId: production.id })]);
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: /^Làm tiếp / }).click();
  await page.getByText('Thiết lập nâng cao / cách nhập thủ công', { exact: true }).click();
  await expect(
    page.getByText('Shop thật hiện chỉ đọc; chưa mở gửi thay đổi trong luồng này.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Đọc & đối chiếu sandbox', exact: true }),
  ).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('fixture: changing shop clears item binding and manually declared stock', async ({ page }) => {
  const state = await fixture(page, [
    order({ ...baseConfig, fieldMask: ['stock'], stocks: { 'TEST-SKU-0': 87 } }),
  ]);
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: /^Làm tiếp / }).click();
  await page.getByText('Thiết lập nâng cao / cách nhập thủ công', { exact: true }).click();
  await expect(page.getByLabel('Tồn đăng bán TEST-SKU-0', { exact: true })).toHaveValue('87');
  await page.getByLabel('Shop đích', { exact: true }).selectOption(production.id);
  await expect(page.getByLabel('Tồn đăng bán TEST-SKU-0', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Mã sản phẩm trên Shopee', { exact: true })).toHaveValue('');
  expect(state.writes).toEqual([]);
});

test('fixture: lost execution response locks changes until reading the server result', async ({
  page,
}) => {
  const state = await fixture(page);
  state.loseExecuteReply();
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: /^Làm tiếp / }).click();
  await page.getByText('Thiết lập nâng cao / cách nhập thủ công', { exact: true }).click();
  await page.getByRole('button', { name: 'Đọc & đối chiếu sandbox', exact: true }).click();
  await page.getByRole('button', { name: 'Xem trước những phần sẽ đổi', exact: true }).click();
  await page
    .getByRole('checkbox', {
      name: 'Tôi đã xem đúng link sandbox và những phần sẽ thay đổi.',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }).click();
  await expect(
    page.getByText(
      'Chưa nhận được phản hồi của yêu cầu vừa gửi. Đọc lại kết quả trước khi gửi hoặc đổi cấu hình.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Mã sản phẩm trên Shopee', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Đọc lại kết quả', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Đã đọc lại và đối chiếu', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Mã sản phẩm trên Shopee', { exact: true })).toBeEnabled();
  expect(state.writes.filter((request) => request.path.endsWith('/execute'))).toHaveLength(1);
});

test('fixture: a terminal drift allows a new read and a new immutable preparation', async ({
  page,
}) => {
  const state = await fixture(page);
  state.driftExecution();
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: /^Làm tiếp / }).click();
  await page.getByText('Thiết lập nâng cao / cách nhập thủ công', { exact: true }).click();
  await page.getByRole('button', { name: 'Đọc & đối chiếu sandbox', exact: true }).click();
  await page.getByRole('button', { name: 'Xem trước những phần sẽ đổi', exact: true }).click();
  await page
    .getByRole('checkbox', {
      name: 'Tôi đã xem đúng link sandbox và những phần sẽ thay đổi.',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: 'Gửi thay đổi lên sandbox', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Dữ liệu đã thay đổi, cần đối chiếu lại', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Đọc lại & đối chiếu kết quả', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Đọc lại và chuẩn bị lần mới', exact: true }).click();
  await page.getByRole('button', { name: 'Xem trước những phần sẽ đổi', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Đã lưu bản thay đổi để xem trước', exact: true }),
  ).toBeVisible();
  const attempts = state.writes.filter((request) => request.path.endsWith('/prepare'));
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.body.id).not.toBe(attempts[0]!.body.id);
  expect(attempts[1]!.body.baselineFingerprint).toBe('b'.repeat(64));
  expect(state.writes.filter((request) => request.path.endsWith('/execute'))).toHaveLength(1);
});

test('fixture: definitive baseline rejection discards stale preparation before a fresh read', async ({
  page,
}) => {
  const state = await fixture(page);
  state.failPrepareOnce();
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: /^Làm tiếp / }).click();
  await page.getByText('Thiết lập nâng cao / cách nhập thủ công', { exact: true }).click();
  await page.getByRole('button', { name: 'Đọc & đối chiếu sandbox', exact: true }).click();
  await page.getByRole('button', { name: 'Xem trước những phần sẽ đổi', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Xem trước những phần sẽ đổi', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Đọc & đối chiếu sandbox', exact: true }).click();
  await page.getByRole('button', { name: 'Xem trước những phần sẽ đổi', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Đã lưu bản thay đổi để xem trước', exact: true }),
  ).toBeVisible();
  const attempts = state.writes.filter((request) => request.path.endsWith('/prepare'));
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.body.id).not.toBe(attempts[0]!.body.id);
  expect(attempts[1]!.body.baselineFingerprint).toBe('b'.repeat(64));
  expect(state.writes.filter((request) => request.path.endsWith('/execute'))).toHaveLength(0);
});

const handoff: HandoffDocument = {
  format: 'shopee-listing-handoff',
  version: 1,
  product: { productKey: sources[0]!.productKey, sourceRevision: 1 },
  scope: { kind: 'saved_product', productKey: sources[0]!.productKey, revision: 1 },
  sources: [
    {
      importId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      sha256: sourceRef.fileSha256,
      kind: 'xlsx',
      filename: 'Giá fixture.xlsx',
    },
  ],
  content: {
    origin: { kind: 'user_selection', sourceImportIds: [] },
    title: 'Tiêu đề đã được người chuẩn bị cập nhật',
    headline: 'Dòng mở đầu',
    body: 'Dòng nguyên văn\n\n  Giữ khoảng trắng  ',
  },
  media: { galleryIds: [], descriptionImageIds: [] },
  tierNames: sources[0]!.tierNames,
  variants: [
    {
      price: {
        importId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        rowKey: 'row-a',
        sheet: 'Giá thử',
        priceProfile: null,
        sku: 'TEST-SKU-0',
        originalPrice: '137998',
        promotionTarget: '68999',
      },
      optionLabels: ['Trắng', '100 cái'],
    },
  ],
  confirmed: { content: true, imageRoles: true, membership: true },
};
test('fixture: opens exported handoff, compares source version, then applies exact reviewed document', async ({
  page,
}) => {
  const state = await fixture(page);
  const requests: { path: string; body: any }[] = [];
  await page.route('**/v1/handoffs/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: handoff });
    const body = request.postDataJSON();
    requests.push({ path, body });
    if (path === '/v1/handoffs/preview')
      return route.fulfill({
        json: {
          ...body,
          previewFingerprint: 'd'.repeat(64),
          draft: { ...sources[0], title: fact(handoff.content.title), revision: 2 },
          changes: [
            { field: 'Tiêu đề', before: sources[0]!.title.value, after: handoff.content.title },
          ],
          issues: [],
          canApply: true,
        },
      });
    if (path === '/v1/handoffs/apply')
      return route.fulfill({
        json: {
          product: { ...sources[0], title: fact(handoff.content.title), revision: 2 },
          replayed: false,
        },
      });
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: 'Nhập / xuất hồ sơ', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Bộ listing đã lưu', exact: true })
    .selectOption(sources[0]!.productKey);
  const downloadWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Tải hồ sơ để dùng lại', exact: true }).click();
  expect((await downloadWait).suggestedFilename()).toBe('listing-fixture-0-r1.json');
  await page.getByRole('button', { name: 'Mở hồ sơ của bộ này', exact: true }).click();
  await expect(
    page.getByRole('radio', { name: 'Cập nhật nguồn của bộ đã lưu', exact: true }),
  ).toBeChecked();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Đối chiếu trước khi lưu', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '1 phần sẽ được cập nhật', exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.screenshot({
    path: '.local/e2e-artifacts/handoff-source-preview.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Lưu phiên bản nguồn mới', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Công việc đăng hàng', exact: true }),
  ).toBeVisible();
  expect(requests[1]!.body).toEqual({
    document: handoff,
    mode: 'update_source',
    productKey: sources[0]!.productKey,
    expectedRevision: 1,
    previewFingerprint: 'd'.repeat(64),
  });
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('fixture: importing a handoff does not apply changes before reviewing and handles a source mismatch', async ({
  page,
}) => {
  const state = await fixture(page),
    requests: string[] = [];
  await page.route('**/v1/handoffs/preview', async (route) => {
    requests.push(route.request().method());
    return route.fulfill({ status: 409, json: { code: 'HANDOFF_SOURCE_MISMATCH' } });
  });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Theo dõi công việc', exact: true })
    .click();
  await page.getByRole('button', { name: 'Nhập / xuất hồ sơ', exact: true }).click();
  await page.locator('.handoff-receive input[type="file"]').setInputFiles({
    name: 'listing-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(handoff)),
  });
  await expect(
    page.getByRole('heading', { name: handoff.content.title, exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: 'Đối chiếu trước khi lưu', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Hồ sơ tham chiếu tệp chưa có hoặc khác bản gốc',
  );
  await expect(
    page.getByRole('button', { name: 'Lưu phiên bản nguồn mới', exact: true }),
  ).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
