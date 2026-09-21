import { test, expect, type Page } from '@playwright/test';
const key = 'recovery-floor-cleaner';
const title = 'Nước Lau Sàn Hương Quế';
const preparationId = '1651c52c-4cc8-4b57-951a-6b9b4d6b2281';
const priceId = '252d91d1-93c7-429a-a4fc-1e719a0bbaf9';
const fact = (value: unknown) => ({ value, confirmed: true, sources: [] });
const workingKey = 'production-preparation-working-copy-v1';
async function openPreparation(page: Page) {
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true }).click();
}

test('reload preserves an explicit shipping override instead of resetting it to the source default', async ({ page }) => {
  const f = await fixture(page, 'none');
  f.draft.logistics = { '7': fact(true) };
  await f.region.getByRole('checkbox', { name: new RegExp(title) }).check();
  const channel = f.region.getByRole('checkbox', { name: 'Vận chuyển phù hợp', exact: true });
  await expect(channel).toBeChecked();
  await channel.uncheck();
  await expect.poll(() => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null')?.entries[0]?.choices.logistics, workingKey))
    .toEqual([{ channelId: '7', enabled: false }]);
  await page.reload();
  await openPreparation(page);
  await expect(channel).not.toBeChecked();
  await expect(f.region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn', exact: true })).toBeEnabled();
  expect(f.reads.source).toBe(2);
  expect(f.reads.metadata).toBe(2);
  expect(f.draft.logistics).toEqual({ '7': fact(true) });
  expect(f.writes).toEqual([]);
});
async function fixture(page: Page, failure: 'context' | 'source' | 'execution' | 'none') {
  const writes: string[] = [],
    reads = { context: 0, source: 0, execution: 0, metadata: 0 },
    scope = { shopId: '1423724897', partnerId: '2010476' };
  const draft = {
    productKey: key,
    revision: 1,
    title: fact(title),
    sourceSelection: {
      title,
      headline: '',
      body: 'Nội dung nguồn',
      coverId: 'cover',
      galleryIds: ['gallery'],
      descriptionImageIds: [],
      tierNames: ['Dung tích'],
      variants: [
        { importId: priceId, rowKey: 'row1', optionLabels: ['1 lít'], imageId: 'variant' },
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
        optionLabels: ['1 lít'],
        originalPrice: fact('125000'),
        declaredWeightGrams: fact('1000'),
        imageKey: 'variant',
      },
    ],
    attributes: {},
    logistics: {},
    assets: [],
    issues: [],
  };
  const prepared = {
    id: preparationId,
    fingerprint: 'a'.repeat(64),
    readyCount: 1,
    blockedCount: 0,
    publicationMode: 'hidden_for_review',
    registration: { batches: [] },
    entries: [
      {
        productKey: key,
        title,
        kind: 'ready',
        issues: [],
        document: { title, description: [], models: [] },
      },
    ],
  };
  const appOrigin = new URL(String(test.info().project.use.baseURL)).origin;
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === appOrigin ? route.continue() : route.abort(),
  );
  await page.route('**/v1/**', (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push(path);
      return route.abort();
    }
    if (path === '/v1/production-preparations/context') {
      reads.context++;
      if (failure === 'context' && reads.context === 1)
        return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
      return route.fulfill({
        json: {
          scope,
          products: [
            { productKey: key, title, revision: draft.revision, skus: ['SKU-A'], issues: [] },
          ],
          pricebooks: [{ id: priceId, filename: 'DORIS.xlsx' }],
          preparations: failure === 'execution' ? [prepared] : [],
        },
      });
    }
    if (path === '/v1/products/' + key) {
      reads.source++;
      if (failure === 'source' && reads.source === 1)
        return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
      return route.fulfill({ json: draft });
    }
    if (path === '/v1/imports/' + priceId)
      return route.fulfill({
        json: {
          id: priceId,
          filename: 'DORIS.xlsx',
          body: { rows: [{ key: 'row1', sheet: 'DORIS', priceProfile: 'SHOP MALL' }] },
        },
      });
    if (path === '/v1/production-preparations/metadata') {
      reads.metadata++;
      const query = new URL(request.url()).searchParams;
      return route.fulfill({
        json: {
          shop: { id: scope.shopId, name: 'vuatinhdau.vn' },
          categories: [{ id: '101', label: 'Lau sàn', path: 'Nhà cửa > Lau sàn' }],
          attributes: [],
          channels: [
            {
              id: '7',
              name: 'Vận chuyển phù hợp',
              enabled: true,
              forceEnabled: false,
              compulsory: false,
            },
          ],
          brands: {
            items: [{ id: '202', name: 'VINA TƯƠI', label: 'VINA TƯƠI' }],
            hasNextPage: false,
            nextOffset: null,
          },
          ...(query.get('includeInventory') === 'true'
            ? {
                inventory: {
                  items: [{ itemId: '501', title: 'Listing tham khảo' }],
                  hasNextPage: false,
                  nextOffset: null,
                },
              }
            : {}),
          ...(query.get('referenceItemId') === '501'
            ? {
                reference: {
                  itemId: '501',
                  title: 'Listing tham khảo',
                  stockLocations: [],
                  writeMappingVerified: true,
                  writeMapping: {
                    expectedLocationId: 'READ',
                    writeLocationId: 'WRITE',
                    verifiedOperationId: 'proof',
                    verificationFingerprint: 'f'.repeat(64),
                    referenceRequestId: 'read',
                    warehouseRequestId: 'warehouse',
                  },
                },
              }
            : {}),
        },
      });
    }
    if (path === '/v1/production-preparations/' + preparationId + '/execution') {
      reads.execution++;
      if (reads.execution === 1)
        return route.fulfill({
          status: 409,
          json: {
            code: 'PRODUCTION_EXECUTION_POLICY_SOURCE_CHANGED',
            message: 'Lựa chọn thực thi cần đối chiếu. Đọc lại đợt đăng trước khi tiếp tục.',
          },
        });
      return route.fulfill({
        json: {
          state: 'paused',
          completedBatches: [],
          totalBatches: 1,
          publicationMode: 'hidden_for_review',
        },
      });
    }
    if (path === '/v1/production-batches') return route.fulfill({ json: { batches: [] } });
    if (path.startsWith('/v1/media/')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ json: path === '/v1/status' ? { worker: 'online' } : [] });
  });
  await page.goto('/');
  await openPreparation(page);
  return {
    region: page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' }),
    reads,
    writes,
    draft,
    scope,
  };
}
test('failed context read stops loading and offers explicit read-only recovery', async ({
  page,
}) => {
  const f = await fixture(page, 'context');
  await expect(f.region.getByRole('alert')).toBeVisible();
  await expect(f.region.getByText('Đang đọc kho listing…', { exact: true })).toHaveCount(0);
  await f.region.getByRole('button', { name: 'Đọc lại kho listing', exact: true }).click();
  await expect(f.region.getByRole('checkbox', { name: new RegExp(title) })).toBeVisible();
  await expect(f.region.getByRole('alert')).toHaveCount(0);
  expect(f.reads.context).toBe(2);
  expect(f.writes).toEqual([]);
});
test('failed source read offers a retry and keeps selection and common stock', async ({ page }) => {
  const f = await fixture(page, 'source');
  await f.region.getByRole('checkbox', { name: new RegExp(title) }).check();
  const retry = f.region.getByRole('button', { name: 'Đọc lại nguồn listing này', exact: true });
  await expect(retry).toBeVisible();
  await expect(f.region.getByText('Đang đọc nguồn và dòng giá…', { exact: true })).toHaveCount(0);
  await f.region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn').fill('100');
  await retry.click();
  await expect(
    f.region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn', exact: true }),
  ).toBeEnabled();
  await expect(f.region.getByRole('checkbox', { name: new RegExp(title) })).toBeChecked();
  await expect(f.region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn')).toHaveValue('100');
  await expect(retry).toHaveCount(0);
  expect(f.reads.source).toBe(2);
  expect(f.writes).toEqual([]);
});
test('successful progress reread clears the old error and points to the correct working tab', async ({
  page,
}) => {
  const f = await fixture(page, 'execution');
  await f.region.getByText('Bản kiểm tra đã lưu (1)', { exact: true }).click();
  await f.region.getByRole('button', { name: new RegExp(title + ' · 1 đủ nguồn') }).click();
  await expect(f.region.getByRole('alert')).toContainText('Lựa chọn thực thi cần đối chiếu');
  await f.region.getByRole('button', { name: 'Đọc lại tiến độ đăng', exact: true }).click();
  await expect(f.region.getByRole('alert')).toHaveCount(0);
  await expect(f.region.getByText(/Xem kết quả từng listing ở tab.*Đợt đang làm/)).toBeVisible();
  await expect(f.region).not.toContainText('Đăng theo đợt bên dưới');
  expect(f.reads.execution).toBe(2);
  expect(f.writes).toEqual([]);
});

test('reload before preview restores scoped inputs after fresh reads without restoring warehouse proof or QC permission', async ({
  page,
}) => {
  const f = await fixture(page, 'none');
  await f.region.getByRole('checkbox', { name: new RegExp(title) }).check();
  await f.region.getByRole('combobox', { name: 'Ngành hàng', exact: true }).selectOption('101');
  await f.region.getByRole('combobox', { name: 'Thương hiệu', exact: true }).selectOption('202');
  await f.region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn').fill('100');
  await f.region.getByRole('button', { name: /Áp dụng tồn/ }).click();
  await f.region.getByLabel('Dài kiện hàng (cm)', { exact: true }).fill('12');
  await f.region.getByLabel('Rộng kiện hàng (cm)', { exact: true }).fill('13');
  await f.region.getByLabel('Cao kiện hàng (cm)', { exact: true }).fill('28');
  await f.region.getByRole('checkbox', { name: 'Vận chuyển phù hợp', exact: true }).check();
  await f.region.getByRole('button', { name: 'Chọn listing tham khảo kho', exact: true }).click();
  await f.region
    .getByRole('combobox', { name: 'Listing đang có tại shop', exact: true })
    .selectOption('501');
  await expect(
    f.region.getByText('Đã có đối chiếu kho cho đúng shop và các SKU đã chọn.'),
  ).toBeVisible();
  await f.region
    .getByRole('checkbox', { name: 'Tạm hoãn kiểm tra ảnh để thử đăng ẩn', exact: true })
    .check();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) ?? 'null')?.entries[0]?.stocks['SKU-A'],
        workingKey,
      ),
    )
    .toBe('100');
  const copy = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), workingKey);
  expect(copy.scope).toEqual(f.scope);
  expect(copy.entries[0]).toMatchObject({
    revision: 1,
    choices: {
      categoryId: '101',
      brandId: '202',
      dimensionCm: { length: 12, width: 13, height: 28 },
    },
  });
  expect(copy.entries[0].choices).not.toHaveProperty('stockLocation');
  for (const property of ['metadata', 'knowledgeAcceptanceId', 'publicationMode', 'imageQcPolicy'])
    expect(copy.entries[0]).not.toHaveProperty(property);
  expect(copy).not.toHaveProperty('imageQcPolicy');
  const before = { ...f.reads };
  await page.reload();
  await openPreparation(page);
  await expect(f.region.getByRole('checkbox', { name: new RegExp(title) })).toBeChecked();
  await expect(f.region.getByRole('combobox', { name: 'Thương hiệu', exact: true })).toHaveValue(
    '202',
  );
  await expect(f.region.getByLabel('Cao kiện hàng (cm)', { exact: true })).toHaveValue('28');
  await expect(f.region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn')).toHaveValue('100');
  await expect(
    f.region.getByRole('checkbox', { name: 'Vận chuyển phù hợp', exact: true }),
  ).toBeChecked();
  await expect(
    f.region.getByRole('checkbox', { name: 'Tạm hoãn kiểm tra ảnh để thử đăng ẩn', exact: true }),
  ).not.toBeChecked();
  await expect(f.region.getByRole('radio', { name: 'Đăng ẩn để QC', exact: true })).toBeChecked();
  await expect(
    f.region.getByText('Đã có đối chiếu kho cho đúng shop và các SKU đã chọn.'),
  ).toHaveCount(0);
  await expect(f.region.getByLabel('Phần nhập tạm')).toContainText('chưa kiểm tra lại');
  await expect(
    f.region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn', exact: true }),
  ).toBeEnabled();
  expect(f.reads.context).toBeGreaterThan(before.context);
  expect(f.reads.source).toBeGreaterThan(before.source);
  expect(f.reads.metadata).toBeGreaterThan(before.metadata);
  expect(f.writes).toEqual([]);
  await f.region.getByRole('button', { name: 'Bỏ phần nhập tạm', exact: true }).click();
  await expect(f.region.getByRole('checkbox', { name: new RegExp(title) })).not.toBeChecked();
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), workingKey))
    .toBeNull();
  await page.reload();
  await openPreparation(page);
  await expect(f.region.getByRole('checkbox', { name: new RegExp(title) })).not.toBeChecked();
  expect(f.writes).toEqual([]);
});

for (const changedTarget of ['source revision', 'shop scope'] as const)
  test(`does not restore inputs onto a changed ${changedTarget}`, async ({ page }) => {
    const f = await fixture(page, 'none');
    await f.region.getByRole('checkbox', { name: new RegExp(title) }).check();
    await f.region.getByLabel('Dài kiện hàng (cm)', { exact: true }).fill('12');
    await expect
      .poll(() =>
        page.evaluate(
          (key) => JSON.parse(sessionStorage.getItem(key) ?? 'null')?.entries.length,
          workingKey,
        ),
      )
      .toBe(1);
    if (changedTarget === 'source revision') f.draft.revision = 2;
    else f.scope.shopId = '999999';
    await page.reload();
    await openPreparation(page);
    await expect(f.region.getByRole('checkbox', { name: new RegExp(title) })).not.toBeChecked();
    await expect(f.region.getByLabel('Dài kiện hàng (cm)', { exact: true })).toHaveCount(0);
    await expect(f.region.getByLabel('Phần nhập tạm')).toContainText(
      changedTarget === 'source revision' ? 'đã đổi phiên bản' : 'shop khác',
    );
    expect(f.writes).toEqual([]);
  });

test('an uncertain preview keeps priority over the temporary form and is never resubmitted automatically', async ({
  page,
}) => {
  const f = await fixture(page, 'none');
  await f.region.getByRole('checkbox', { name: new RegExp(title) }).check();
  await f.region.getByLabel('Dài kiện hàng (cm)', { exact: true }).fill('12');
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) ?? 'null')?.entries.length,
        workingKey,
      ),
    )
    .toBe(1);
  const pending = {
    id: preparationId,
    publicationMode: 'hidden_for_review',
    imageQcPolicy: 'required',
    entries: [
      { productKey: key, sourceRevision: 1, choices: { dimensionCm: { length: 99 } }, stocks: {} },
    ],
  };
  await page.evaluate(
    (value) => sessionStorage.setItem('production-preparation-pending', JSON.stringify(value)),
    pending,
  );
  const before = f.reads.source;
  await page.reload();
  await openPreparation(page);
  await expect(
    f.region.getByRole('button', { name: 'Lấy lại kết quả kiểm tra trước', exact: true }),
  ).toBeVisible();
  await expect(f.region.getByRole('checkbox', { name: new RegExp(title) })).not.toBeChecked();
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('production-preparation-pending')!),
    ),
  ).toEqual(pending);
  expect(f.reads.source).toBe(before);
  expect(f.writes).toEqual([]);
});

test('successful explicit registration removes registered listings from the temporary form without executing them', async ({
  page,
}) => {
  const f = await fixture(page, 'none');
  await f.region.getByRole('checkbox', { name: new RegExp(title) }).check();
  await f.region.getByLabel('Dài kiện hàng (cm)', { exact: true }).fill('12');
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) ?? 'null')?.entries.length,
        workingKey,
      ),
    )
    .toBe(1);
  await page.route('**/v1/production-preparations/preview', (route) => {
    f.writes.push('/v1/production-preparations/preview');
    return route.fulfill({
      json: {
        id: preparationId,
        fingerprint: 'a'.repeat(64),
        readyCount: 1,
        blockedCount: 0,
        publicationMode: 'hidden_for_review',
        entries: [
          {
            productKey: key,
            title,
            kind: 'ready',
            issues: [],
            document: { title, description: [], models: [] },
          },
        ],
      },
    });
  });
  await page.route('**/v1/production-preparations/' + preparationId + '/register', (route) => {
    f.writes.push('/v1/production-preparations/' + preparationId + '/register');
    return route.fulfill({ json: {} });
  });
  await f.region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn', exact: true }).click();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), workingKey)).not.toBeNull();
  await f.region
    .getByRole('button', { name: 'Chuẩn bị đợt cho 1 listing đủ nguồn', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), workingKey))
    .toBeNull();
  expect(f.writes).toEqual([
    '/v1/production-preparations/preview',
    '/v1/production-preparations/' + preparationId + '/register',
  ]);
});

for (const scope of ['initial', 'current category'] as const) {
  test(`failed ${scope} shop choices can be reread without losing input or sending a listing`, async ({
    page,
  }) => {
    const f = await fixture(page, 'none');
    let calls = 0;
    const requestedCategories: (string | null)[] = [];
    let releaseRetry!: () => void;
    const heldRetry = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const failureCall = scope === 'initial' ? 1 : 2;
    await page.route('**/v1/production-preparations/metadata?*', async (route) => {
      expect(route.request().method()).toBe('GET');
      calls++;
      requestedCategories.push(new URL(route.request().url()).searchParams.get('categoryId'));
      if (calls === failureCall)
        return route.fulfill({
          status: 409,
          json: {
            code:
              scope === 'initial'
                ? 'PRODUCTION_PREPARATION_AUTH_REQUIRED'
                : 'PRODUCTION_PREPARATION_CONNECTION_CHANGED',
            message:
              'Thông tin chưa đủ điều kiện hoặc đã thay đổi. Mở kết quả để xem phần cần xử lý; chưa gửi thêm thay đổi.',
          },
        });
      if (calls === failureCall + 1) await heldRetry;
      return route.fallback();
    });
    await f.region.getByRole('checkbox', { name: new RegExp(title) }).check();
    if (scope === 'current category')
      await f.region.getByRole('combobox', { name: 'Ngành hàng', exact: true }).selectOption('101');
    const retry = f.region.getByRole('button', { name: 'Đọc lại lựa chọn của shop', exact: true });
    await expect(retry).toBeVisible();
    await expect(f.region.getByText(/Vào Công cụ → Kết nối shop/)).toBeVisible();
    await f.region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn').fill('100');
    await f.region.getByLabel('Dài kiện hàng (cm)', { exact: true }).fill('12');
    await f.region.getByLabel('Rộng kiện hàng (cm)', { exact: true }).fill('13');
    await retry.click();
    await expect(retry).toBeDisabled();
    await expect(
      f.region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn', exact: true }),
    ).toBeDisabled();
    await f.region.getByLabel('Cao kiện hàng (cm)', { exact: true }).fill('29');
    releaseRetry();
    await expect(retry).toHaveCount(0);
    await expect(
      f.region
        .getByRole('combobox', { name: 'Ngành hàng', exact: true })
        .getByRole('option', { name: 'Nhà cửa > Lau sàn', exact: true }),
    ).toHaveCount(1);
    await expect(f.region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn')).toHaveValue('100');
    await expect(f.region.getByLabel('Dài kiện hàng (cm)', { exact: true })).toHaveValue('12');
    await expect(f.region.getByLabel('Rộng kiện hàng (cm)', { exact: true })).toHaveValue('13');
    await expect(f.region.getByLabel('Cao kiện hàng (cm)', { exact: true })).toHaveValue('29');
    await expect(f.region.getByRole('checkbox', { name: new RegExp(title) })).toBeChecked();
    expect(requestedCategories.at(-1)).toBe(scope === 'initial' ? null : '101');
    if (scope === 'current category')
      await expect(f.region.getByRole('combobox', { name: 'Ngành hàng', exact: true })).toHaveValue(
        '101',
      );
    expect(calls).toBe(failureCall + 1);
    expect(f.writes).toEqual([]);
  });
}
