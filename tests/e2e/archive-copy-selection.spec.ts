import { test, expect } from '@playwright/test';
// All API calls are fixture-only; use a separate UI server, never the operating app.
test.use({ baseURL: process.env.ARCHIVE_COPY_TEST_BASE_URL ?? 'http://127.0.0.1:5188' });

const destination = {
  id: 'dest-connection',
  scope: { environment: 'production', partnerId: '44', shopId: '202' },
  state: 'connected',
  displayName: 'Shop đích đã chọn',
};
const archive = {
  id: 'archive-fixture',
  name: 'Kho Hoa Lài',
  sourceShopId: '101',
  itemCount: 1,
  completedAt: '2026-10-01T00:00:00Z',
  selection: { excludedOfficialBrands: ['Ngoại lệ nguồn'] },
};
const policy = {
  targetStatus: 'UNLIST',
  stockStrategy: 'source_saleable_snapshot',
  priceStrategy: 'source_original',
  promotionStrategy: 'record_exception',
};
const savedTarget = { partnerId: '55', shopId: '303', displayName: 'Shop đã lưu trước' };

test('incoming destinations require source and explicit replace before one local plan save', async ({
  page,
}) => {
  const writes: unknown[] = [];
  let plan = {
    archiveId: archive.id,
    sourceShopId: '101',
    sourcePartnerId: '44',
    revision: 2,
    targets: [savedTarget],
    policy,
  };
  await page.route('**/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (req.method() !== 'GET') {
      writes.push({ path: url.pathname, body: req.postDataJSON() });
      if (!url.pathname.endsWith('/copy-plan')) return route.abort('blockedbyclient');
      const body = req.postDataJSON();
      plan = { ...plan, targets: body.targets, revision: 3 };
      return route.fulfill({ json: plan });
    }
    let value: unknown = [];
    if (url.pathname === '/v1/seller-knowledge/archives') value = [archive];
    if (url.pathname === '/v1/seller-knowledge/shops') value = { shops: [destination] };
    if (url.pathname.endsWith('/copy-plan')) value = plan;
    if (url.pathname === '/v1/connections') value = [destination];
    if (url.pathname === '/v1/status') value = { worker: 'online' };
    if (url.pathname === '/v1/connections/production')
      value = {
        state: 'connected',
        partnerId: url.searchParams.get('partnerId'),
        shopId: url.searchParams.get('shopId'),
      };
    return route.fulfill({ json: value });
  });
  const params = new URLSearchParams({
    page: 'archives',
    copyTargets: JSON.stringify([{ connectionId: destination.id, ...destination.scope }]),
  });
  await page.goto('/?' + params);
  await expect(page.getByRole('combobox', { name: 'Kho đã lưu' })).toHaveValue('');
  await expect(page.getByText('Shop đích đã chọn', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole('combobox', { name: 'Kho đã lưu' }).selectOption(archive.id);
  await expect(page.getByText('Shop đã lưu trước', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Thay bằng các shop đã chọn', exact: true }).click();
  await expect(page.getByText('Shop đã lưu trước', { exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Lưu shop đích', exact: true }).click();
  await expect(page.getByText(/Đã lưu kế hoạch shop đích/)).toBeVisible();
  expect(writes).toEqual([
    {
      path: '/v1/seller-knowledge/archives/archive-fixture/copy-plan',
      body: {
        expectedRevision: 2,
        targets: [{ partnerId: '44', shopId: '202', displayName: 'Shop đích đã chọn' }],
        policy,
      },
    },
  ]);
});

async function setupSaveCase(
  page: import('@playwright/test').Page,
  behavior: 'success' | 'lost' | 'conflict' = 'success',
  holdSave = false,
) {
  const writes: { path: string; body: any }[] = [];
  let getPlanCount = 0;
  let missingDestination = false;
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let plan = {
    archiveId: archive.id,
    sourceShopId: '101',
    sourcePartnerId: '44',
    revision: 2,
    targets: [savedTarget],
    policy,
  };
  const other = { ...archive, id: 'other-archive', name: 'Kho khác', sourceShopId: '999' };
  await page.route('**/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (req.method() !== 'GET') {
      writes.push({ path: url.pathname, body: req.postDataJSON() });
      if (!url.pathname.endsWith('/copy-plan')) return route.abort('blockedbyclient');
      const body = req.postDataJSON();
      if (behavior === 'conflict') {
        plan = {
          ...plan,
          revision: 3,
          targets: [{ partnerId: '66', shopId: '404', displayName: 'Shop do phiên khác lưu' }],
        };
        return route.fulfill({
          status: 409,
          json: { message: 'KNOWLEDGE_COPY_PLAN_REVISION_CONFLICT' },
        });
      }
      plan = { ...plan, targets: body.targets, revision: 3 };
      if (behavior === 'lost') return route.abort('failed');
      if (holdSave) await saveGate;
      return route.fulfill({ json: plan });
    }
    let value: unknown = [];
    if (url.pathname === '/v1/seller-knowledge/archives') value = [archive, other];
    if (url.pathname === '/v1/seller-knowledge/shops')
      value = { shops: missingDestination ? [] : [destination] };
    if (url.pathname.endsWith('/copy-plan')) {
      getPlanCount++;
      value = plan;
    }
    if (url.pathname === '/v1/connections') value = [destination];
    if (url.pathname === '/v1/status') value = { worker: 'online' };
    if (url.pathname === '/v1/connections/production')
      value = {
        state: 'connected',
        partnerId: url.searchParams.get('partnerId'),
        shopId: url.searchParams.get('shopId'),
      };
    return route.fulfill({ json: value });
  });
  const params = new URLSearchParams({
    page: 'archives',
    copyTargets: JSON.stringify([{ connectionId: destination.id, ...destination.scope }]),
  });
  await page.goto('/?' + params);
  await page.getByRole('combobox', { name: 'Kho đã lưu' }).selectOption(archive.id);
  await page.getByRole('button', { name: 'Thay bằng các shop đã chọn', exact: true }).click();
  return {
    writes,
    getPlanCount: () => getPlanCount,
    releaseSave,
    removeDestination: () => {
      missingDestination = true;
    },
  };
}

test('double click saves once and source selection is locked during pending save', async ({
  page,
}) => {
  const fixture = await setupSaveCase(page);
  await page.getByRole('button', { name: 'Lưu shop đích', exact: true }).evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  try {
    await expect(page.getByRole('combobox', { name: 'Kho đã lưu' })).toBeDisabled();
  } finally {
    fixture.releaseSave();
  }
  await expect(page.getByText(/Đã lưu kế hoạch shop đích/)).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]?.path).toBe('/v1/seller-knowledge/archives/archive-fixture/copy-plan');
});

test('lost save response is reconciled by one read with no second POST', async ({ page }) => {
  const fixture = await setupSaveCase(page, 'lost');
  await page.getByRole('button', { name: 'Lưu shop đích', exact: true }).click();
  await expect(page.getByText(/Đã lưu kế hoạch shop đích/)).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.getPlanCount()).toBe(2);
});

test('revision conflict holds retry until saved plan is read and reviewed', async ({ page }) => {
  const fixture = await setupSaveCase(page, 'conflict');
  await page.getByRole('button', { name: 'Lưu shop đích', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Đọc lại kế hoạch');
  await expect(page.getByRole('button', { name: 'Lưu shop đích', exact: true })).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Đọc lại kế hoạch đã lưu', exact: true }).click();
  await expect(page.getByText('Shop do phiên khác lưu', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lưu shop đích', exact: true })).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
});

test('a missing destination at save stays held and produces no plan POST', async ({ page }) => {
  const fixture = await setupSaveCase(page);
  fixture.removeDestination();
  await page.getByRole('button', { name: 'Lưu shop đích', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Shop đích đã thay đổi');
  await expect(
    page.getByRole('region', { name: 'Đối chiếu shop đích đã chọn', exact: true }),
  ).toContainText('Giữ riêng: kết nối đã chọn không còn');
  await expect(
    page.getByRole('button', { name: 'Thay bằng các shop đã chọn', exact: true }),
  ).toBeDisabled();
  expect(fixture.writes).toEqual([]);
});

test('explicit merge preserves prior saved targets and policy', async ({ page }) => {
  const fixture = await setupSaveCase(page);
  await page.getByRole('button', { name: 'Giữ kế hoạch đã lưu', exact: true }).click();
  await page.getByRole('button', { name: 'Gộp vào kế hoạch đã lưu', exact: true }).click();
  await expect(page.getByText('Shop đã lưu trước', { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  await page.getByRole('button', { name: 'Lưu shop đích', exact: true }).click();
  await expect(page.getByText(/Đã lưu kế hoạch shop đích/)).toBeVisible();
  expect(fixture.writes).toEqual([
    {
      path: '/v1/seller-knowledge/archives/archive-fixture/copy-plan',
      body: {
        expectedRevision: 2,
        targets: [
          savedTarget,
          { partnerId: '44', shopId: '202', displayName: 'Shop đích đã chọn' },
        ],
        policy,
      },
    },
  ]);
});
