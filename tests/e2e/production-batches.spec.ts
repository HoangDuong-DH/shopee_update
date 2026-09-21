import { test, expect, type Page } from '@playwright/test';
const id = '513281a9-764c-4b04-a73e-85b8c6c1c984';
function ready() {
  return {
    batchId: id,
    state: 'ready',
    statusFingerprint: 'a'.repeat(64),
    shopName: 'vuatinhdau.vn',
    shopId: '1423724897',
    publishedCount: 1,
    remainingCount: 1,
    busy: false,
    interrupted: false,
    enabled: true,
    canExecute: true,
    lastResult: null,
    listings: [
      {
        sourceKey: 'a',
        title: 'Listing đã đăng',
        modelCount: 48,
        state: 'published',
        itemId: '51467852283',
        acknowledgedSteps: 12,
        totalSteps: 12,
      },
      {
        sourceKey: 'b',
        title: 'Bộ nguồn còn lại giữ nguyên',
        modelCount: 48,
        state: 'not_sent',
        acknowledgedSteps: 0,
        totalSteps: 0,
      },
    ],
  };
}
async function fixture(page: Page, initial: any = ready(), drop = false) {
  let current = initial;
  const starts: any[] = [];
  const publications: any[] = [];
  const writes: { path: string; payload: unknown }[] = [];
  const appOrigin = new URL(String(test.info().project.use.baseURL)).origin;
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === appOrigin ? route.continue() : route.abort(),
  );
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') {
      writes.push({ path, payload: route.request().postDataJSON() });
    }
    if (path === '/v1/production-batches')
      return route.fulfill({
        json: { batches: Array.isArray(current) ? current : current ? [current] : [] },
      });
    if (path === '/v1/production-preparations/context')
      return route.fulfill({
        json: { scope: { shopId: '1423724897' }, products: [], pricebooks: [], preparations: [] },
      });
    if (
      /^\/v1\/production-batches\/[^/]+\/run$/.test(path) &&
      route.request().method() === 'POST'
    ) {
      starts.push(route.request().postDataJSON());
      if (drop) return route.abort();
      const sentId = path.split('/')[3];
      const running = (value: any) => ({
        ...value,
        busy: true,
        state: 'running',
        statusFingerprint: 'b'.repeat(64),
      });
      current = Array.isArray(current)
        ? current.map((value) => (value.batchId === sentId ? running(value) : value))
        : running(current);
      return route.fulfill({ status: 202, json: { requestId: 'fixture-only' } });
    }
    if (
      path === '/v1/production-batches/' + id + '/publish' &&
      route.request().method() === 'POST'
    ) {
      publications.push(route.request().postDataJSON());
      if (drop) return route.abort();
      const sentId = path.split('/')[3];
      const running = (value: any) => ({
        ...value,
        busy: true,
        state: 'running',
        statusFingerprint: 'b'.repeat(64),
      });
      current = Array.isArray(current)
        ? current.map((value) => (value.batchId === sentId ? running(value) : value))
        : running(current);
      return route.fulfill({ status: 202, json: { requestId: 'publication-fixture-only' } });
    }
    if (route.request().method() !== 'GET') return route.abort();
    if (path === '/v1/production-pilot/status')
      return route.fulfill({ status: 503, json: { message: 'Fixture: old panel unavailable' } });
    return route.fulfill({ json: path === '/v1/status' ? { worker: 'online' } : [] });
  });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  return { starts, publications, writes, set: (value: any) => (current = value) };
}
function hiddenReady() {
  return {
    ...ready(),
    publicationMode: 'hidden_for_review',
    completionTarget: 'created_hidden',
    createdVerifiedCount: 1,
    hiddenVerifiedCount: 1,
    completedCount: 1,
    publishedCount: 0,
    remainingCount: 1,
    listings: [
      {
        ...ready().listings[0]!,
        title: 'Xịt thơm Trà Trắng',
        state: 'created_unlisted',
        canPublish: true,
      },
      { ...ready().listings[1]!, title: 'Xịt thơm Rừng Thông', canPublish: false },
    ],
  };
}
test('stale unsent source can be excluded without publishing or deleting its source', async ({ page }) => {
  const initial: any = ready();
  initial.canExecute = false;
  Object.assign(initial.listings[1], { currentSource: 'source_changed', currentRevision: 2, canExecute: false, canExclude: true });
  const f = await fixture(page, initial);
  const exclusions: any[] = [];
  await page.route('**/v1/production-batches/' + id + '/exclusions', async route => {
    exclusions.push(route.request().postDataJSON());
    const updated = { ...initial, state: 'completed_with_exclusions', excludedCount: 1, remainingCount: 0,
      statusFingerprint: 'c'.repeat(64), listings: initial.listings.map((row: any) => row.sourceKey === 'b'
        ? { ...row, excluded: true, canExclude: false } : row) };
    f.set(updated);
    await route.fulfill({ json: updated });
  });
  await expect(page.getByText('Nguồn đã có phiên bản mới. Loại mục chưa gửi rồi chuẩn bị lại từ bản mới.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Loại khỏi đợt này', exact: true }).click();
  await expect(page.getByText(/Đã loại listing chưa gửi khỏi đợt này/)).toBeVisible();
  expect(exclusions).toEqual([{ expectedStatusFingerprint: 'a'.repeat(64), sourceKey: 'b' }]);
  expect(f.starts).toEqual([]);
  expect(f.publications).toEqual([]);
});
test('hidden execution finishes at verified hidden listing and never requests publication', async ({
  page,
}) => {
  const initial = hiddenReady(),
    f = await fixture(page, initial),
    region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await expect(region.getByText('Đăng ẩn để QC', { exact: true })).toBeVisible();
  await region.getByText('Công cụ của đợt', { exact: true }).click();
  await expect(region.getByText('1/2 đã tạo, đối chiếu đạt')).toBeVisible();
  await expect(region.getByText('1 đang ẩn chờ kiểm tra · 0 đã mở bán')).toBeVisible();
  await region.getByRole('button', { name: 'Đăng ẩn 1 listing', exact: true }).click();
  expect(f.starts).toEqual([{ mode: 'execute', expectedStatusFingerprint: 'a'.repeat(64) }]);
  f.set({
    ...initial,
    state: 'complete',
    canExecute: false,
    remainingCount: 0,
    createdVerifiedCount: 2,
    hiddenVerifiedCount: 2,
    completedCount: 2,
    statusFingerprint: 'c'.repeat(64),
    listings: initial.listings.map((row) => ({
      ...row,
      state: 'created_unlisted',
      canPublish: true,
    })),
  });
  await region.getByRole('button', { name: 'Đọc lại đợt đăng' }).click();
  await expect(region.getByText('2/2 đã tạo, đối chiếu đạt')).toBeVisible();
  await expect(region.getByText('Đã tạo ẩn, chờ bạn kiểm tra')).toHaveCount(2);
  await expect(region.getByRole('button', { name: 'Mở bán listing này', exact: true })).toHaveCount(
    2,
  );
  expect(f.publications).toEqual([]);
});
test('manual publication binds confirmation to the displayed listing and latest status', async ({
  page,
}) => {
  const initial = hiddenReady(),
    f = await fixture(page, initial),
    region = page.getByRole('region', { name: 'Đợt đăng mới' }),
    row = region
      .locator('li')
      .filter({ has: page.getByText('Xịt thơm Trà Trắng', { exact: true }) }),
    button = row.getByRole('button', { name: 'Mở bán listing này', exact: true });
  await expect(button).toBeDisabled();
  await row.getByRole('checkbox', { name: 'Tôi đã kiểm tra listing này và đồng ý mở bán' }).check();
  f.set({ ...initial, statusFingerprint: 'c'.repeat(64) });
  await region.getByRole('button', { name: 'Đọc lại đợt đăng' }).click();
  await expect(button).toBeDisabled();
  await row.getByRole('checkbox').check();
  await button.click();
  await expect(button).toBeDisabled();
  expect(f.publications).toEqual([{ sourceKey: 'a', expectedStatusFingerprint: 'c'.repeat(64) }]);
  expect(f.starts).toEqual([]);
  await expect(
    region
      .locator('li')
      .filter({ has: page.getByText('Xịt thơm Rừng Thông', { exact: true }) })
      .getByRole('button', { name: 'Mở bán listing này', exact: true }),
  ).toHaveCount(0);
});
test('lost manual publication response stays held after refresh and reload without replay', async ({
  page,
}) => {
  const f = await fixture(page, hiddenReady(), true),
    region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await region
    .getByRole('checkbox', { name: 'Tôi đã kiểm tra listing này và đồng ý mở bán' })
    .check();
  await region.getByRole('button', { name: 'Mở bán listing này', exact: true }).click();
  await expect(region.getByRole('alert')).toContainText('Chưa xác nhận được yêu cầu');
  await region.getByRole('button', { name: 'Đọc lại đợt đăng' }).click();
  await expect(
    region.getByRole('button', { name: 'Mở bán listing này', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await expect(
    region.getByRole('button', { name: 'Mở bán listing này', exact: true }),
  ).toBeDisabled();
  expect(f.publications).toHaveLength(1);
  expect(f.starts).toEqual([]);
});
test('deferred image QC is visibly incomplete and cannot publish until a fresh verified status', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const initial = {
      ...hiddenReady(),
      imageQcPolicy: 'defer_image_qc',
      imageQcPendingCount: 1,
      completedCount: 2,
      remainingCount: 0,
      canExecute: false,
      canReconcile: true,
      listings: [
        hiddenReady().listings[0]!,
        {
          ...hiddenReady().listings[1]!,
          state: 'created_hidden_image_qc_deferred',
          imageQcStatus: 'deferred',
          canPublish: false,
        },
      ],
    },
    f = await fixture(page, initial),
    region = page.getByRole('region', { name: 'Đợt đăng mới' }),
    row = region
      .locator('li')
      .filter({ has: page.getByText('Xịt thơm Rừng Thông', { exact: true }) });
  await expect(region.getByText('1 listing ảnh chưa QC', { exact: true })).toBeVisible();
  await expect(region.getByText('Khi muốn kiểm tra ảnh', { exact: false })).toContainText(
    'bấm “Chỉ đọc đối chiếu” để tạo hồ sơ',
  );
  expect(f.starts).toEqual([]);
  await expect(row.getByText('Đã tạo ẩn · Ảnh chưa QC', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Mở bán listing này', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Tiếp tục listing này', exact: true })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  f.set({
    ...initial,
    imageQcPendingCount: 0,
    hiddenVerifiedCount: 2,
    createdVerifiedCount: 2,
    statusFingerprint: 'c'.repeat(64),
    listings: initial.listings.map((r) => ({
      ...r,
      state: 'created_unlisted',
      imageQcStatus: 'verified',
      canPublish: true,
    })),
  });
  await region.getByRole('button', { name: 'Đọc lại đợt đăng' }).click();
  await expect(row.getByRole('button', { name: 'Mở bán listing này', exact: true })).toBeDisabled();
  expect(f.publications).toEqual([]);
});
for (const deferred of [true, false]) {
  test(`saved cover checkpoint explains ${deferred ? 'deferred' : 'required'} image QC and waits for the correct explicit action`, async ({
    page,
  }) => {
    const code = 'PRODUCTION_BATCH_COVER_CASE_REVIEW_REQUIRED';
    const f = await fixture(page, {
      ...hiddenReady(),
      state: 'paused',
      imageQcPolicy: deferred ? 'defer_image_qc' : 'required',
      createdVerifiedCount: 0,
      hiddenVerifiedCount: 0,
      completedCount: 0,
      remainingCount: 1,
      canExecute: deferred,
      canReconcile: true,
      lastResult: {
        stopped: true,
        code,
        listings: [{ sourceKey: 'a', state: 'created_readback_pending', code }],
      },
      listings: [
        {
          ...hiddenReady().listings[0]!,
          title: 'Xịt thơm bàn làm việc Hương Thảo',
          state: 'created_readback_pending',
          canPublish: false,
        },
      ],
    });
    const region = page.getByRole('region', { name: 'Đợt đăng mới' });
    if (deferred) {
      await expect(region.getByRole('alert')).toContainText('Lần trước dừng ở bước QC ảnh bìa.');
      await expect(region.getByRole('alert')).toContainText('bấm “Tiếp tục listing này”');
      await expect(region.getByRole('alert')).toContainText('kiểm dữ liệu và tiếp tục giữ ẩn');
      await expect(region.getByRole('alert')).toContainText('Ảnh chưa được xác nhận đạt.');
      await expect(region).not.toContainText(
        'Cần đối chiếu ảnh trả về với ảnh nguồn trước khi tiếp tục.',
      );
      await expect(region.getByText('Đã chọn hoãn QC ảnh.', { exact: false })).toBeVisible();
    } else {
      await expect(region.getByRole('alert')).toContainText(
        'Cần đối chiếu ảnh trả về với ảnh nguồn trước khi tiếp tục.',
      );
      await expect(region.getByText('Đã chọn hoãn QC ảnh.', { exact: false })).toHaveCount(0);
    }
    await expect(
      region.getByRole('button', { name: 'Mở bán listing này', exact: true }),
    ).toHaveCount(0);
    expect(f.starts).toEqual([]);
    expect(f.publications).toEqual([]);
    await region
      .getByRole('button', {
        name: deferred ? 'Tiếp tục listing này' : 'Chỉ đọc đối chiếu',
        exact: true,
      })
      .click();
    expect(f.starts).toEqual([
      deferred
        ? { mode: 'execute', sourceKey: 'a', expectedStatusFingerprint: 'a'.repeat(64) }
        : { mode: 'reconcile', expectedStatusFingerprint: 'a'.repeat(64) },
    ]);
    expect(f.publications).toEqual([]);
  });
}

test('an accepted weight receipt under deferred image QC directs explicit hidden continuation without starting it', async ({
  page,
}) => {
  const f = await fixture(page, {
    ...hiddenReady(),
    imageQcPolicy: 'defer_image_qc',
    listings: [
      { ...hiddenReady().listings[0], state: 'created_readback_pending', canPublish: false },
    ],
  });
  await page.route('**/v1/production-batches/' + id + '/review**', async (route) => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: { sourceKey: 'a', eligible: true, approved: true } });
  });
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await region.getByText('Chi tiết sản phẩm', { exact: true }).first().click();
  await region.getByRole('button', { name: 'Xem chênh lệch cân nặng', exact: true }).click();
  const panel = region.getByRole('region', { name: 'Đối chiếu cân nặng' });
  await expect(panel.getByRole('status')).toContainText(
    'Chọn “Tiếp tục listing này” để kiểm dữ liệu và hoàn tất đăng ẩn',
  );
  await expect(panel.getByRole('status')).toContainText('ảnh vẫn chưa QC');
  await expect(panel.getByRole('status')).not.toContainText('Chọn “Chỉ đọc đối chiếu”');
  expect(f.starts).toEqual([]);
  expect(f.publications).toEqual([]);
});

test('registered batch is readable and sends only selected mode plus server fingerprint once', async ({
  page,
}) => {
  const f = await fixture(page),
    region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await region.getByText('Công cụ của đợt', { exact: true }).click();
  await expect(region.getByText('2 listing · vuatinhdau.vn · Shop 1423724897')).toBeVisible();
  await expect(region.getByText('1/2 đã mở bán')).toBeVisible();
  await expect(region.getByText('Lô cũ · Tự mở bán sau đối chiếu', { exact: true })).toBeVisible();
  await expect(region.getByRole('searchbox', { name: 'Tìm đợt đăng hoặc sản phẩm' })).toHaveCount(
    1,
  );
  await region.getByRole('button', { name: 'Tiếp tục 1 listing còn lại' }).click();
  expect(f.starts).toEqual([{ mode: 'execute', expectedStatusFingerprint: 'a'.repeat(64) }]);
  await expect(region.getByRole('button', { name: 'Tiếp tục 1 listing còn lại' })).toBeDisabled();
  await expect(region.getByText('Đang xử lý đợt.', { exact: false })).toBeVisible();
});
test('uncertain POST stays held after reload without another outgoing request', async ({
  page,
}) => {
  const f = await fixture(page, ready(), true),
    region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await region.getByRole('button', { name: 'Tiếp tục 1 listing còn lại' }).click();
  await expect(region.getByRole('alert')).toContainText('Chưa xác nhận được yêu cầu');
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await expect(region.getByRole('button', { name: 'Tiếp tục 1 listing còn lại' })).toBeDisabled();
  expect(f.starts).toHaveLength(1);
});
test('read-only QC action and image discrepancy do not imply successful publication', async ({
  page,
}) => {
  const initial = ready();
  initial.listings[1]!.state = 'created_readback_pending';
  (initial as any).lastResult = {
    stopped: true,
    listings: [
      { sourceKey: 'b', state: 'blocked', code: 'PRODUCTION_PILOT_COVER_CASE_UNVERIFIED' },
    ],
  };
  const f = await fixture(page, initial),
    region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await expect(region.getByRole('alert')).toContainText('Cần đối chiếu ảnh trả về');
  await expect(region.getByText('Đã tạo, cần đối chiếu')).toBeVisible();
  await region.getByRole('button', { name: 'Chỉ đọc đối chiếu' }).click();
  expect(f.starts[0].mode).toBe('reconcile');
});
test('an unsupported date readback rule explains that preflight stopped before sending the listing', async ({
  page,
}) => {
  const code = 'PRODUCTION_PILOT_ATTRIBUTE_DATE_READBACK_UNSUPPORTED';
  const f = await fixture(page, {
    ...hiddenReady(),
    canExecute: false,
    lastResult: { stopped: true, code, listings: [{ sourceKey: 'b', state: 'blocked', code }] },
    listings: [{ ...hiddenReady().listings[1] }],
  });
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await expect(region.getByRole('alert')).toContainText(
    'Thuộc tính ngày chưa được hỗ trợ đối chiếu sau đăng. Listing chưa được gửi',
  );
  await expect(region.getByText('Chưa gửi', { exact: true })).toBeVisible();
  await expect(region).not.toContainText('Dữ liệu đọc lại chưa khớp nguồn.');
  expect(f.starts).toEqual([]);
  expect(f.publications).toEqual([]);
});

test('no manifest displays an honest empty state and no write action', async ({ page }) => {
  await fixture(page, null);
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await expect(region.getByText('Chưa có đợt đăng', { exact: true })).toBeVisible();
  await expect(region.getByRole('button', { name: /listing/ })).toHaveCount(0);
});
test('held source batches remain inspectable and hide all execution actions', async ({ page }) => {
  const f = await fixture(page, {
    ...ready(),
    state: 'held',
    executionEnabled: false,
    canExecute: false,
    holdReason: 'Hai bộ này cần bảng kích thước theo ngành đã chọn.',
  });
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await expect(region.getByText('Đang giữ lại — chưa đăng.')).toBeVisible();
  await expect(
    region.getByText('Hai bộ này cần bảng kích thước theo ngành đã chọn.', { exact: false }),
  ).toBeVisible();
  await expect(region.getByRole('button', { name: /^(Đăng|Tiếp tục|Chỉ đọc)/ })).toHaveCount(0);
  await region.getByText('Công cụ của đợt', { exact: true }).click();
  await region.getByRole('button', { name: 'Kiểm tra nguồn', exact: true }).click();
  expect(f.starts[0].mode).toBe('inspect');
});
test('mobile layout keeps source titles and action buttons within the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await expect(region.getByText('Bộ nguồn còn lại giữ nguyên')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('fresh server proof of no accepted request releases a failed-before-acceptance button', async ({
  page,
}) => {
  const f = await fixture(page, ready(), true),
    region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await region.getByRole('button', { name: 'Tiếp tục 1 listing còn lại' }).click();
  await expect(region.getByRole('alert')).toContainText('Chưa xác nhận');
  f.set({ ...ready(), acceptedStatusFingerprints: [] });
  await region.getByRole('button', { name: 'Đọc lại đợt đăng' }).click();
  await expect(region.getByRole('button', { name: 'Tiếp tục 1 listing còn lại' })).toBeEnabled();
  expect(f.starts).toHaveLength(1);
});
test('per-listing action shows the product name while preserving its source key and category exception', async ({
  page,
}) => {
  const source: any = ready();
  const productName =
    'Xịt Khử Mùi Thảm VINA TƯƠI - Tinh Dầu Thiên Nhiên Thảm Sofa Rèm 100ml 300ml 500ml';
  source.listings[1].sourceKey = '775';
  source.listings[1].title = productName;
  source.lastResult = {
    stopped: true,
    listings: [{ sourceKey: '775', state: 'blocked', code: 'SIZE_CHART_UNVERIFIED' }],
  };
  const f = await fixture(page, source),
    region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await expect(region.getByText(productName, { exact: true })).toBeVisible();
  await expect(region.getByText('775', { exact: true })).toHaveCount(0);
  await expect(region.getByRole('alert')).toContainText('Ngành đã chọn yêu cầu bảng kích thước.');
  await region.getByRole('button', { name: 'Đăng listing này', exact: true }).click();
  expect(f.starts[0]).toEqual({
    mode: 'execute',
    sourceKey: '775',
    expectedStatusFingerprint: 'a'.repeat(64),
  });
});
test('employee sees exact grouped weights and approves locally without starting publication', async ({
  page,
}) => {
  await page.setViewportSize({ width: 674, height: 1050 });
  const initial = ready();
  initial.listings[1]!.state = 'created_readback_pending';
  Object.assign(initial.listings[1]!, { itemId: '53267854751' });
  const f = await fixture(page, initial),
    approvals: any[] = [];
  await page.route('**/v1/production-batches/' + id + '/review**', async (route) => {
    if (route.request().method() === 'POST') {
      approvals.push(route.request().postDataJSON());
      return route.fulfill({ json: { approved: true } });
    }
    return route.fulfill({
      json: {
        sourceKey: 'b',
        eligible: true,
        approved: false,
        reviewFingerprint: 'c'.repeat(64),
        itemId: '5002',
        modelCount: 48,
        groups: [
          { sourceGrams: 130.9, observedGrams: 131, count: 16, skus: ['SKU100-A', 'SKU100-B'] },
          { sourceGrams: 322.3, observedGrams: 322, count: 16, skus: ['SKU300-A'] },
          { sourceGrams: 503.8, observedGrams: 504, count: 16, skus: ['SKU500-A'] },
        ],
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        coverReview: { basis: 'manual_review', reviewer: 'Independent QA agent' },
      },
    });
  });
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await region
    .locator('.production-batch-rows > li')
    .filter({ hasText: 'Bộ nguồn còn lại giữ nguyên' })
    .getByText('Chi tiết sản phẩm', { exact: true })
    .click();
  await region.getByRole('button', { name: 'Xem chênh lệch cân nặng' }).click();
  const panel = region.getByRole('region', { name: 'Đối chiếu cân nặng' });
  await expect(panel.getByText('130,9 g', { exact: true })).toBeVisible();
  await expect(panel.getByText('131 g', { exact: true })).toBeVisible();
  await panel.getByText('16 SKU').first().click();
  await expect(panel.getByText('SKU100-A, SKU100-B')).toBeVisible();
  const listing = region
    .locator('.production-batch-rows > li')
    .filter({ has: page.getByRole('region', { name: 'Đối chiếu cân nặng' }) });
  const layout = await listing.evaluate((element) => {
    const row = element.getBoundingClientRect();
    const info = element.querySelector('.batch-product-main')!.getBoundingClientRect();
    const actions = element.querySelector('.production-batch-row-status')!.getBoundingClientRect();
    const review = element.querySelector('.production-weight-review')!.getBoundingClientRect();
    return {
      row: row.width,
      info: info.width,
      actionsTop: actions.top,
      infoBottom: info.bottom,
      review: review.width,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(layout.info).toBeGreaterThan(300);
  expect(layout.info).toBeGreaterThan(layout.row * 0.8);
  expect(layout.actionsTop).toBeGreaterThanOrEqual(layout.infoBottom);
  expect(layout.review).toBeGreaterThan(layout.row * 0.95);
  expect(layout.overflow).toBe(false);
  await expect(listing.getByText('Mã Shopee 53267854751', { exact: false })).toBeVisible();
  await listing.screenshot({ path: '.local/e2e-artifacts/weight-review-listing-674.png' });
  await panel.screenshot({ path: '.local/e2e-artifacts/weight-review-panel.png' });
  expect(approvals).toHaveLength(0);
  expect(f.starts).toHaveLength(0);
  await panel.getByRole('button', { name: 'Chấp nhận mức Shopee đang lưu' }).click();
  expect(approvals).toEqual([{ sourceKey: 'b', expectedReviewFingerprint: 'c'.repeat(64) }]);
  expect(f.starts).toHaveLength(0);
  await expect(panel.getByRole('status')).toContainText('listing chưa tự động mở bán');
  await expect(panel.getByRole('button', { name: 'Chấp nhận mức Shopee đang lưu' })).toHaveCount(0);
});
test('review with unrelated mismatch offers no approval and has readable mobile layout', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const initial = ready();
  initial.listings[1]!.state = 'created_readback_pending';
  await fixture(page, initial);
  await page.route('**/v1/production-batches/' + id + '/review**', (route) =>
    route.fulfill({
      json: {
        sourceKey: 'b',
        eligible: false,
        approved: false,
        reason: 'PRODUCTION_BATCH_REVIEW_OTHER_FIELDS_DIFFER',
      },
    }),
  );
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await region
    .locator('.production-batch-rows > li')
    .filter({ hasText: 'Bộ nguồn còn lại giữ nguyên' })
    .getByText('Chi tiết sản phẩm', { exact: true })
    .click();
  await region.getByRole('button', { name: 'Xem chênh lệch cân nặng' }).click();
  const panel = region.getByRole('region', { name: 'Đối chiếu cân nặng' });
  await expect(
    panel.getByText('Ngoài cân nặng còn dữ liệu chưa khớp', { exact: false }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Chấp nhận mức Shopee đang lưu' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('batch filters retain held sources visibly without giving them write actions', async ({
  page,
}) => {
  await fixture(page, {
    ...ready(),
    name: 'Tinh dầu 777 và 772',
    executionEnabled: false,
    canExecute: false,
    state: 'held',
    holdReason: 'Cần bảng kích thước.',
  });
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await expect(
    region.getByRole('button', { name: 'Chọn đợt Tinh dầu 777 và 772', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await region.getByRole('button', { name: /^Có thể tiếp tục\s+0$/ }).click();
  await expect(region.getByText('Không có đợt phù hợp', { exact: true })).toBeVisible();
  await region.getByRole('button', { name: /^Đang giữ lại\s+1$/ }).click();
  await expect(
    region.getByRole('button', { name: 'Chọn đợt Tinh dầu 777 và 772', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(region.getByRole('button', { name: /^(Đăng|Tiếp tục|Chỉ đọc)/ })).toHaveCount(0);
  await region.getByText('Công cụ của đợt', { exact: true }).click();
  await expect(region.getByRole('button', { name: 'Kiểm tra nguồn', exact: true })).toBeVisible();
});
test('server-proven orphan offers only explicit read-only recovery even when an old request marker remains', async ({
  page,
}) => {
  const state = ready();
  state.canExecute = false;
  (state as any).canReconcile = true;
  state.interrupted = true;
  state.listings[1]!.state = 'needs_review';
  const f = await fixture(page, state),
    region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await page.evaluate(
    ({ id, fingerprint }) => sessionStorage.setItem('production-batch:' + id, fingerprint),
    { id, fingerprint: state.statusFingerprint },
  );
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await expect(region.getByRole('button', { name: 'Tiếp tục 1 listing còn lại' })).toBeDisabled();
  await region.getByRole('button', { name: 'Đọc lại để phục hồi' }).click();
  expect(f.starts).toEqual([
    { mode: 'reconcile', expectedStatusFingerprint: state.statusFingerprint },
  ]);
});

test('batch search and selection isolate one detail without submitting requests', async ({
  page,
}) => {
  const first = { ...hiddenReady(), name: 'Lô xịt thơm trong nhà' };
  const second = {
    ...hiddenReady(),
    batchId: '713281a9-764c-4b04-a73e-85b8c6c1c982',
    name: 'Lô nước lau sàn',
    statusFingerprint: 'd'.repeat(64),
    listings: [{ ...hiddenReady().listings[1], title: 'Nước lau sàn Hương Quế' }],
    createdVerifiedCount: 0,
    hiddenVerifiedCount: 0,
    completedCount: 0,
  };
  const f = await fixture(page, [first, second]);
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  const search = region.getByRole('searchbox', { name: 'Tìm đợt đăng hoặc sản phẩm' });
  await expect(search).toBeVisible();
  await search.fill('Hương Quế');
  await region.getByRole('button', { name: /Lô nước lau sàn/ }).click();
  const detail = region.getByRole('region', { name: 'Chi tiết đợt đăng' });
  await expect(detail).toHaveCount(1);
  await expect(detail.getByText('Nước lau sàn Hương Quế', { exact: true })).toBeVisible();
  await expect(detail.getByText('Xịt thơm Rừng Thông', { exact: true })).toHaveCount(0);
  await search.fill('');
  await region.getByRole('button', { name: /Lô xịt thơm trong nhà/ }).click();
  await expect(detail.getByText('Xịt thơm Rừng Thông', { exact: true })).toBeVisible();
  await expect(detail.getByText('Nước lau sàn Hương Quế', { exact: true })).toHaveCount(0);
  expect(f.starts).toEqual([]);
  expect(f.publications).toEqual([]);
});

test('hiding published products keeps hidden-QC work visible and never requests publication', async ({
  page,
}) => {
  const initial = {
    ...hiddenReady(),
    name: 'Lô xịt thơm cần hoàn tất',
    imageQcPolicy: 'defer_image_qc',
    imageQcPendingCount: 1,
    publishedCount: 1,
    listings: [
      {
        ...hiddenReady().listings[0],
        sourceKey: 'live',
        title: 'Oải Hương đã mở bán',
        state: 'published',
        canPublish: false,
      },
      {
        ...hiddenReady().listings[0],
        sourceKey: 'qc',
        title: 'Hương Thảo giữ ẩn chờ QC',
        state: 'created_hidden_image_qc_deferred',
        canPublish: false,
      },
      {
        ...hiddenReady().listings[1],
        sourceKey: 'new',
        title: 'Hoa Hồng chưa gửi',
        state: 'not_sent',
        canPublish: false,
      },
    ],
  };
  const f = await fixture(page, initial);
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  const detail = region.getByRole('region', { name: 'Chi tiết đợt đăng' });
  const rows = detail.locator('.production-batch-rows > li');
  await expect(rows).toHaveCount(3);
  await detail.getByRole('checkbox', { name: 'Ẩn sản phẩm đã mở bán' }).check();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Oải Hương đã mở bán' })).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Hương Thảo giữ ẩn chờ QC' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Hoa Hồng chưa gửi' })).toHaveCount(1);
  await expect(detail.getByRole('button', { name: 'Mở bán listing này', exact: true })).toHaveCount(
    0,
  );
  await detail.getByRole('checkbox', { name: 'Ẩn sản phẩm đã mở bán' }).uncheck();
  await expect(rows).toHaveCount(3);
  expect(f.writes).toEqual([]);
});

test('selected batch execution uses that batch identity and fingerprint only', async ({ page }) => {
  const selectedId = '713281a9-764c-4b04-a73e-85b8c6c1c982';
  const source = {
    ...hiddenReady(),
    batchId: selectedId,
    name: 'Lô nước lau sàn Hương Quế',
    statusFingerprint: 'd'.repeat(64),
    completedCount: 0,
    createdVerifiedCount: 0,
    hiddenVerifiedCount: 0,
    listings: [
      { ...hiddenReady().listings[1], title: 'Nước lau sàn Hương Quế', sourceKey: 'floor-cleaner' },
    ],
  };
  const f = await fixture(page, [{ ...hiddenReady(), name: 'Lô xịt thơm ban đầu' }, source]);
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await region.getByRole('button', { name: /Lô nước lau sàn Hương Quế/ }).click();
  expect(f.writes).toEqual([]);
  await region
    .getByRole('region', { name: 'Chi tiết đợt đăng' })
    .getByRole('button', { name: 'Đăng ẩn 1 listing', exact: true })
    .click();
  expect(f.writes).toEqual([
    {
      path: '/v1/production-batches/' + selectedId + '/run',
      payload: { mode: 'execute', expectedStatusFingerprint: 'd'.repeat(64) },
    },
  ]);
  expect(f.publications).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`batch selector and long product names stay readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1050 });
    const longTitle =
      'Xịt Thơm Oải Hương VINA TƯƠI Khử Mùi Ẩm Mốc Tủ Quần Áo - Xịt Lúc Tủ Mở Rồi Mới Xếp Đồ Vào';
    const initial = {
      ...hiddenReady(),
      name: 'Lô xịt thơm cho phòng và tủ quần áo',
      publishedCount: 2,
      completedCount: 2,
      remainingCount: 2,
      createdVerifiedCount: 2,
      hiddenVerifiedCount: 0,
      imageQcPolicy: 'defer_image_qc',
      canReconcile: true,
      listings: [
        {
          ...hiddenReady().listings[0],
          sourceKey: 'oai-huong',
          title: longTitle,
          state: 'published',
          canPublish: false,
        },
        {
          ...hiddenReady().listings[0],
          sourceKey: 'sa-java',
          title: 'Xịt thơm Sả Java VINA TƯƠI khử mùi nhà bếp thông minh',
          state: 'published',
          canPublish: false,
        },
        {
          ...hiddenReady().listings[0],
          sourceKey: 'huong-thao',
          title: 'Xịt thơm bàn làm việc Hương Thảo VINA TƯƠI lá xanh hơi cay',
          state: 'created_readback_pending',
          canPublish: false,
        },
        {
          ...hiddenReady().listings[1],
          sourceKey: 'hoa-hong',
          title: 'Xịt thơm Hoa Hồng VINA TƯƠI cách làm thơm phòng ngủ',
          state: 'not_sent',
          canPublish: false,
        },
      ],
    };
    const f = await fixture(page, [
      initial,
      {
        ...hiddenReady(),
        batchId: '813281a9-764c-4b04-a73e-85b8c6c1c982',
        name: 'Nước lau sàn VINA TƯƠI',
      },
    ]);
    const region = page.getByRole('region', { name: 'Đợt đăng mới' });
    const detail = region.getByRole('region', { name: 'Chi tiết đợt đăng' });
    await expect(detail.getByText(longTitle, { exact: true })).toBeVisible();
    await expect(
      region.getByRole('searchbox', { name: 'Tìm đợt đăng hoặc sản phẩm' }),
    ).toBeVisible();
    const overflow = await region.evaluate((element) => ({
      page: document.documentElement.scrollWidth > window.innerWidth,
      controls: Array.from(element.querySelectorAll('button, input, summary'))
        .filter((control) => {
          const rect = control.getBoundingClientRect();
          return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1);
        })
        .map((control) => control.textContent),
    }));
    expect(overflow).toEqual({ page: false, controls: [] });
    await region.screenshot({ path: `.local/batch-ui-redesign-20260917/batch-${width}.png` });
    expect(f.writes).toEqual([]);
  });
}

test('unavailable backend batches remain unknown rather than completed or zero published', async ({
  page,
}) => {
  const f = await fixture(page, {
    batchId: id,
    state: 'unavailable',
    code: 'PRODUCTION_BATCH_MANIFEST_CHANGED',
    listings: [],
    canExecute: false,
  });
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await expect(region.getByText('Chưa đọc được đợt đăng', { exact: true })).toBeVisible();
  await expect(region.getByText('Đợt đã hoàn tất', { exact: true })).toHaveCount(0);
  await expect(region.getByText('0 đã mở bán', { exact: true })).toHaveCount(0);
  await expect(region.getByText('Chưa đọc được chế độ đăng', { exact: true })).toBeVisible();
  await expect(region.getByRole('button', { name: /^Đăng 0 listing$/ })).toHaveCount(0);
  f.set(hiddenReady());
  await region.getByRole('button', { name: 'Đọc lại đợt đăng' }).click();
  await expect(region.getByText('Chưa đọc được đợt đăng', { exact: true })).toHaveCount(0);
  expect(f.writes).toEqual([]);
});

test('translated review expiry uses the API code to explain the next read-only action', async ({
  page,
}) => {
  await fixture(page, {
    ...hiddenReady(),
    listings: [
      { ...hiddenReady().listings[0], state: 'created_readback_pending', canPublish: false },
    ],
  });
  await page.route('**/v1/production-batches/*/review?*', (route) =>
    route.fulfill({
      status: 409,
      json: {
        code: 'PRODUCTION_BATCH_REVIEW_READBACK_EXPIRED',
        message: 'Kết quả đọc đã cũ. Bấm đọc lại kết quả rồi mở lại phần đối chiếu.',
      },
    }),
  );
  const region = page.getByRole('region', { name: 'Đợt đăng mới' });
  await region.getByText('Chi tiết sản phẩm', { exact: true }).first().click();
  await region.getByRole('button', { name: 'Xem chênh lệch cân nặng' }).first().click();
  await expect(
    region.getByText(
      'Cần hai lần đọc mới trước khi duyệt. Chọn “Chỉ đọc đối chiếu”, rồi mở lại bảng này.',
      { exact: true },
    ),
  ).toBeVisible();
});
