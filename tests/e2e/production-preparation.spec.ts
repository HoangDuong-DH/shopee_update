import { test, expect, type Page } from '@playwright/test';
const sourceKey = 'saved-source-a',
  priceId = '252d91d1-93c7-429a-a4fc-1e719a0bbaf9',
  previewId = '1651c52c-4cc8-4b57-951a-6b9b4d6b2281',
  fp = 'a'.repeat(64);
async function fixture(
  page: Page,
  blocked = false,
  prior = false,
  effectivePolicy?: Record<string, unknown>,
) {
  const fact = (value: any) => ({
    value,
    confirmed: true,
    sources: [
      {
        kind: 'product_file',
        fileSha256: 'fixture',
        locator: 'source',
        observedAt: '2026-09-15T00:00:00.000Z',
      },
    ],
  });
  const selection = {
    title: 'Listing tinh dầu đã chuẩn bị',
    headline: 'Dòng đầu',
    body: ' Dòng 1\n\nDòng 2 ',
    coverId: 'cover',
    galleryIds: ['gallery'],
    descriptionImageIds: [],
    tierNames: ['Dung tích'],
    variants: [
      { importId: priceId, rowKey: 'row1', optionLabels: ['100ml'], imageId: 'variation' },
    ],
  };
  const draft = {
    productKey: sourceKey,
    revision: 4,
    sourceSelection: selection,
    title: fact(selection.title),
    description: [{ type: 'text', text: selection.body }],
    coverKey: 'cover',
    galleryKeys: ['gallery'],
    tierNames: selection.tierNames,
    variants: [
      {
        key: 'row1',
        sku: fact('SKU-A'),
        optionLabels: ['100ml'],
        originalPrice: fact('125000'),
        declaredWeightGrams: fact('130.9'),
        imageKey: 'variation',
      },
    ],
    assets: [],
    categoryId: fact('10'),
    brandId: fact('20'),
    attributes: {},
    logistics: { '50': fact(true) },
    issues: [],
  };
  const summary = {
    productKey: sourceKey,
    revision: 4,
    title: selection.title,
    skus: ['SKU-A'],
    categoryId: '10',
    brandId: '20',
    sourceSelection: selection,
    attributes: {},
    logistics: draft.logistics,
    issues: [],
  };
  const meta: any = {
    shop: { id: '1423724897', name: 'vuatinhdau.vn' },
    categories: [{ id: '10', label: 'Tinh dầu', path: 'Nhà cửa > Tinh dầu' }],
    attributes: [],
    brands: {
      items: [{ id: '20', name: 'VINA TƯƠI', label: 'VINA TƯƠI' }],
      hasNextPage: false,
      nextOffset: null,
    },
    channels: [
      {
        id: '50',
        name: 'Kênh vận chuyển của shop',
        enabled: true,
        forceEnabled: false,
        compulsory: false,
      },
    ],
    itemLimits: { sizeChart: { mandatory: false } },
  };
  let registered = prior,
    running = false;
  const requests: { path: string; body: any }[] = [];
  const preview: any = {
    id: previewId,
    fingerprint: fp,
    readyCount: blocked ? 0 : 1,
    blockedCount: blocked ? 1 : 0,
    entries: [
      {
        productKey: sourceKey,
        title: selection.title,
        kind: blocked ? 'blocked' : 'ready',
        issues: blocked
          ? [{ field: 'stockLocation', message: 'Chưa có bằng chứng đối chiếu kho.' }]
          : [],
        document: {
          title: selection.title,
          description: draft.description,
          weightGrams: 130.9,
          models: [
            {
              sku: 'SKU-A',
              optionLabels: ['100ml'],
              originalPrice: '125000',
              stock: 0,
              weightGrams: 130.9,
            },
          ],
        },
        priceProof: [
          { sku: 'SKU-A', originalPrice: '125000', sheetName: 'DORIS', priceProfile: 'SHOP MALL' },
        ],
      },
    ],
  };
  const appOrigin = new URL(String(test.info().project.use.baseURL)).origin;
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === appOrigin ? route.continue() : route.abort(),
  );
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (route.request().method() === 'POST') {
      requests.push({ path, body: route.request().postDataJSON() });
      if (path === '/v1/production-preparations/preview') {
        preview.publicationMode =
          route.request().postDataJSON().publicationMode ?? 'hidden_for_review';
        preview.imageQcPolicy = route.request().postDataJSON().imageQcPolicy ?? 'required';
        return route.fulfill({ json: preview });
      }
      if (path === '/v1/production-preparations/' + previewId + '/register') {
        registered = true;
        return route.fulfill({
          json: { batches: [{ batchId: 'fixture-only' }], readyCount: 1, blockedCount: 0 },
        });
      }
      if (path === '/v1/production-preparations/' + previewId + '/run') {
        running = true;
        return route.fulfill({ json: { state: 'running', completedBatches: [], totalBatches: 1 } });
      }
      return route.abort();
    }
    if (path === '/v1/production-preparations/context')
      return route.fulfill({
        json: {
          scope: { shopId: '1423724897' },
          products: [summary],
          pricebooks: [{ id: priceId, filename: 'DORIS.xlsx' }],
          preparations: registered ? [{ ...preview, registration: { batches: [] } }] : [],
        },
      });
    if (path === '/v1/production-preparations/metadata')
      return route.fulfill({
        json: {
          ...meta,
          ...(url.searchParams.get('includeInventory') === 'true'
            ? {
                inventory: {
                  items: [{ itemId: '9001', title: 'Listing tham khảo kho' }],
                  hasNextPage: false,
                  nextOffset: null,
                },
              }
            : {}),
          ...(url.searchParams.has('referenceItemId')
            ? {
                reference: {
                  itemId: '9001',
                  title: 'Listing tham khảo kho',
                  writeMappingVerified: true,
                  stockLocations: [],
                  writeMapping: {
                    expectedLocationId: 'READ-TEST',
                    writeLocationId: 'WRITE-TEST',
                    verifiedOperationId: 'proof-only',
                    verificationFingerprint: 'b'.repeat(64),
                    referenceRequestId: 'read-1',
                    warehouseRequestId: 'warehouse-1',
                  },
                },
              }
            : {}),
        },
      });
    if (path === '/v1/products/' + sourceKey) return route.fulfill({ json: draft });
    if (path === '/v1/products') return route.fulfill({ json: [draft] });
    if (path === '/v1/imports/' + priceId)
      return route.fulfill({
        json: {
          id: priceId,
          filename: 'DORIS.xlsx',
          body: { rows: [{ key: 'row1', sheet: 'DORIS', priceProfile: 'SHOP MALL' }] },
        },
      });
    if (path === '/v1/production-preparations/' + previewId + '/execution')
      return route.fulfill({
        json: running
          ? { state: 'running', completedBatches: [], totalBatches: 1 }
          : prior
            ? { state: 'paused', completedBatches: [], totalBatches: 1, ...effectivePolicy }
            : null,
      });
    if (path === '/v1/production-batches') return route.fulfill({ json: { batches: [] } });
    if (path.startsWith('/v1/media/')) return route.fulfill({ status: 404, body: '' });
    if (path === '/v1/production-pilot/status')
      return route.fulfill({ status: 503, json: { message: 'Old pilot not part of fixture' } });
    return route.fulfill({ json: path === '/v1/status' ? { worker: 'online' } : [] });
  });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true }).click();
  return { requests, preview, draft, meta };
}

test('editing a pending preparation invalidates its old preview and preserves the new choices', async ({
  page,
}) => {
  const f = await fixture(page),
    region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: any[] = [];
  await page.route('**/v1/production-preparations/preview', async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await hold;
    await route.fulfill({ json: { ...f.preview, publicationMode: 'hidden_for_review' } });
  });
  await region
    .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
    .check();
  await region.getByLabel('Tình trạng sản phẩm').selectOption('NEW');
  await region.getByLabel('Dài kiện hàng (cm)').fill('12');
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  await expect.poll(() => requests.length).toBe(1);
  await region.getByLabel('Dài kiện hàng (cm)').fill('25');
  release();
  await expect(region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' })).toBeEnabled();
  await expect(region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' })).toHaveCount(0);
  await expect(
    region.getByText('Thông tin đã thay đổi. Kiểm tra lại các listing trước khi chuẩn bị đợt.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(region.getByLabel('Dài kiện hàng (cm)')).toHaveValue('25');
  expect(
    await page.evaluate(() => sessionStorage.getItem('production-preparation-pending')),
  ).toBeNull();
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  await expect(region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' })).toBeVisible();
  expect(requests[0].entries[0].choices.dimensionCm.length).toBe(12);
  expect(requests[1].entries[0].choices.dimensionCm.length).toBe(25);
  expect(requests[1].id).not.toBe(requests[0].id);
  expect(f.requests.filter((r) => r.path.endsWith('/register') || r.path.endsWith('/run'))).toEqual(
    [],
  );
});

for (const oldStatus of [200, 503]) {
  test(`a late preview ${oldStatus} cannot overwrite or unlock a newer request`, async ({
    page,
  }) => {
    const f = await fixture(page),
      region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
    // Deliberately simulate a response which cannot be cancelled, so the generation
    // guard is tested independently of the browser's AbortController behaviour.
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) =>
        String(input).endsWith('/production-preparations/preview')
          ? original(input, { ...init, signal: undefined })
          : original(input, init);
    });
    let releaseOld!: () => void, releaseNew!: () => void, deliveredOld!: () => void;
    const old = new Promise<void>((resolve) => {
        releaseOld = resolve;
      }),
      latest = new Promise<void>((resolve) => {
        releaseNew = resolve;
      }),
      oldDelivered = new Promise<void>((resolve) => {
        deliveredOld = resolve;
      }),
      requests: any[] = [];
    await page.route('**/v1/production-preparations/preview', async (route) => {
      requests.push(route.request().postDataJSON());
      const first = requests.length === 1;
      await (first ? old : latest);
      await route.fulfill({
        status: first ? oldStatus : 200,
        json:
          first && oldStatus !== 200
            ? { code: 'OLD_RESPONSE_FAILURE' }
            : {
                ...f.preview,
                publicationMode: 'hidden_for_review',
                fingerprint: (first ? 'a' : 'c').repeat(64),
              },
      });
      if (first) deliveredOld();
    });
    await region
      .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
      .check();
    await region.getByLabel('Dài kiện hàng (cm)').fill('12');
    await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
    await expect.poll(() => requests.length).toBe(1);
    await region.getByLabel('Dài kiện hàng (cm)').fill('25');
    await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
    await expect.poll(() => requests.length).toBe(2);
    releaseOld();
    await oldDelivered;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(region.getByRole('button', { name: 'Đang xử lý…', exact: true })).toBeDisabled();
    await expect(region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' })).toHaveCount(0);
    await expect(region.getByRole('alert')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => JSON.parse(sessionStorage.getItem('production-preparation-pending')!).id,
      ),
    ).toBe(requests[1].id);
    releaseNew();
    const result = region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' });
    await expect(result).toBeVisible();
    await expect(region.getByLabel('Dài kiện hàng (cm)')).toHaveValue('25');
    await result.getByRole('button', { name: 'Chuẩn bị đợt cho 1 listing đủ nguồn' }).click();
    expect(f.requests.filter((r) => r.path.endsWith('/register'))).toEqual([
      {
        path: '/v1/production-preparations/' + previewId + '/register',
        body: { expectedFingerprint: 'c'.repeat(64) },
      },
    ]);
    expect(f.requests.filter((r) => r.path.endsWith('/run'))).toEqual([]);
  });
}

test('leaving a pending preparation preserves exact recovery and ignores the old component response', async ({
  page,
}) => {
  const f = await fixture(page),
    region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) =>
      String(input).endsWith('/production-preparations/preview')
        ? original(input, { ...init, signal: undefined })
        : original(input, init);
  });
  let releaseOld!: () => void, releaseNew!: () => void, deliveredOld!: () => void;
  const old = new Promise<void>((resolve) => {
      releaseOld = resolve;
    }),
    latest = new Promise<void>((resolve) => {
      releaseNew = resolve;
    }),
    oldDelivered = new Promise<void>((resolve) => {
      deliveredOld = resolve;
    }),
    requests: any[] = [];
  await page.route('**/v1/production-preparations/preview', async (route) => {
    requests.push(route.request().postDataJSON());
    const first = requests.length === 1;
    await (first ? old : latest);
    await route.fulfill({ json: { ...f.preview, publicationMode: 'hidden_for_review' } });
    if (first) deliveredOld();
  });
  await region
    .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
    .check();
  await region.getByLabel('Dài kiện hàng (cm)').fill('25');
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole('button', { name: 'Về kho listing', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true }).click();
  await region.getByRole('button', { name: 'Lấy lại kết quả kiểm tra trước' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  releaseOld();
  await oldDelivered;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' })).toHaveCount(0);
  await expect(
    region.getByRole('button', { name: 'Lấy lại kết quả kiểm tra trước' }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => JSON.parse(sessionStorage.getItem('production-preparation-pending')!).id,
    ),
  ).toBe(requests[1].id);
  releaseNew();
  await expect(region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' })).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('production-preparation-pending')),
  ).toBeNull();
  expect(f.requests.filter((r) => r.path.endsWith('/register') || r.path.endsWith('/run'))).toEqual(
    [],
  );
});

test('changing a parent attribute removes only its inactive descendants from the local preview', async ({
  page,
}) => {
  const f = await fixture(page);
  const field = (id: string, label: string, values: any[]) => ({
    id,
    label,
    mandatory: false,
    inputType: 'single_dropdown',
    units: [],
    maxValueCount: 1,
    values,
  });
  const option = (id: string, label: string, children: any[] = []) => ({
    id,
    label,
    unit: null,
    children,
  });
  f.meta.attributes = [
    field('7', 'Loại sản phẩm', [
      option('70', 'Có thông tin phụ', [
        field('8', 'Nhóm chi tiết', [
          option('80', 'Có chi tiết sâu', [
            field('9', 'Chi tiết sâu', [option('90', 'Giá trị sâu')]),
          ]),
        ]),
      ]),
      option('71', 'Không có thông tin phụ'),
    ]),
    field('10', 'Thông tin độc lập', [option('100', 'Giữ nguyên')]),
  ];
  const sourceBefore = JSON.stringify(f.draft);
  const region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region
    .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
    .check();
  await region.getByLabel('Loại sản phẩm', { exact: true }).selectOption('70');
  await region.getByLabel('Nhóm chi tiết', { exact: true }).selectOption('80');
  await region.getByLabel('Chi tiết sâu', { exact: true }).selectOption('90');
  await region.getByLabel('Thông tin độc lập', { exact: true }).selectOption('100');
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  const first = f.requests.at(-1)!.body.entries[0].choices.attributeList;
  expect(first.map((row: any) => row.attribute_id).sort()).toEqual([10, 7, 8, 9]);
  await region.getByLabel('Loại sản phẩm', { exact: true }).selectOption('71');
  await expect(region.getByLabel('Nhóm chi tiết', { exact: true })).toHaveCount(0);
  await expect(region.getByLabel('Chi tiết sâu', { exact: true })).toHaveCount(0);
  await expect(
    region.getByText('Đã bỏ lựa chọn phụ thuộc không còn áp dụng', { exact: false }),
  ).toContainText('Nhóm chi tiết, Chi tiết sâu');
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  const second = f.requests.at(-1)!.body.entries[0].choices.attributeList;
  expect(second).toEqual([
    first.find((row: any) => row.attribute_id === 10),
    {
      attribute_id: 7,
      attribute_value_list: [{ value_id: 71, original_value_name: 'Không có thông tin phụ' }],
    },
  ]);
  await region.getByLabel('Loại sản phẩm', { exact: true }).selectOption('70');
  await expect(region.getByLabel('Nhóm chi tiết', { exact: true })).toHaveValue('');
  await expect(region.getByLabel('Chi tiết sâu', { exact: true })).toHaveCount(0);
  expect(JSON.stringify(f.draft)).toBe(sourceBefore);
  expect(f.requests.map((request) => request.path)).toEqual([
    '/v1/production-preparations/preview',
    '/v1/production-preparations/preview',
  ]);
});

test('draft knowledge requires explicit confirmed selections and carries only the accepted receipt into local preview', async ({
  page,
}) => {
  const f = await fixture(page),
    connectionId = '55d8eb95-9a73-40eb-a6e3-2fbcb8b9623e',
    receiptId = '0be3ee9f-fc0e-4876-ad86-a59e6209384a';
  const knowledgeRequests: any[] = [];
  const factEvidenceId = '815b5a2f-24c8-4a27-b7f2-4b025e803b57',
    historyEvidenceId = 'b0c19b16-9272-4894-b7b9-f1e594e9b206';
  const evidenceRequests: string[] = [];
  const target = {
    productKey: sourceKey,
    expectedRevision: 4,
    connectionId,
    categoryId: 10,
    brandId: 20,
  };
  await page.route('**/v1/seller-knowledge/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/shops'))
      return route.fulfill({
        json: {
          shops: [
            {
              id: connectionId,
              state: 'connected',
              scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
            },
          ],
        },
      });
    if (path.includes('/evidence/')) {
      evidenceRequests.push(path);
      return route.fulfill({
        json: {
          observedAt: new Date().toISOString(),
          body: { title: 'Listing lịch sử có nguồn', attributes: [] },
        },
      });
    }
    const body = route.request().postDataJSON();
    knowledgeRequests.push({ path, body });
    if (path.endsWith('/draft-recommendations'))
      return route.fulfill({
        json: {
          target,
          fingerprint: fp,
          sourceFacts: [{ attributeId: 7, sourceLocator: 'Word gốc, trang 2' }],
          metadata: {
            observedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
          recommendations: {
            issues: [],
            suggestions: [
              {
                attributeId: 7,
                name: 'Xuất xứ đã xác nhận',
                sourceClass: 'product_source',
                canPrefill: true,
                reasons: ['CONFIRMED_PRODUCT_SOURCE'],
                evidenceIds: [factEvidenceId],
                values: [{ valueId: 8, displayName: 'Việt Nam' }],
              },
              {
                attributeId: 9,
                name: 'Mô tả lịch sử',
                sourceClass: 'same_shop',
                canPrefill: false,
                reasons: ['REFERENCE_ONLY'],
                evidenceIds: [historyEvidenceId],
                values: [{ valueId: 10, displayName: 'Chưa xác nhận' }],
              },
            ],
          },
        },
      });
    if (path.endsWith('/draft-acceptances'))
      return route.fulfill({
        json: {
          id: receiptId,
          target,
          fingerprint: 'b'.repeat(64),
          attributeList: [{ attribute_id: 7, attribute_value_list: [{ value_id: 8 }] }],
          metadata: { expiresAt: new Date(Date.now() + 600000).toISOString() },
          localOnly: true,
          shopMutations: 0,
        },
      });
    return route.abort();
  });
  const region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region
    .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
    .check();
  expect(knowledgeRequests).toEqual([]);
  await region.getByRole('button', { name: 'Đọc gợi ý có nguồn' }).click();
  const suggestions = region.getByRole('region', { name: 'Gợi ý thuộc tính cho bản nháp' });
  await expect(suggestions.getByLabel('Chọn Xuất xứ đã xác nhận')).not.toBeChecked();
  await expect(suggestions.getByLabel('Chọn Mô tả lịch sử')).toBeDisabled();
  await expect(suggestions.getByText('Word gốc, trang 2')).toBeVisible();
  const evidenceButtons = suggestions.getByRole('button', {
    name: 'Xem nguồn tham khảo 1',
    exact: true,
  });
  await expect(evidenceButtons).toHaveCount(1);
  await evidenceButtons.click();
  await expect(suggestions.getByText('Listing lịch sử có nguồn', { exact: false })).toBeVisible();
  expect(evidenceRequests).toEqual(['/v1/seller-knowledge/evidence/' + historyEvidenceId]);
  await expect(
    suggestions.getByRole('button', { name: 'Dùng thông tin đã chọn trong bản xem trước' }),
  ).toBeDisabled();
  await suggestions.getByLabel('Chọn Xuất xứ đã xác nhận').check();
  await suggestions
    .getByRole('button', { name: 'Dùng thông tin đã chọn trong bản xem trước' })
    .click();
  await expect(
    suggestions.getByText('Đã lưu lựa chọn cho bản xem trước', { exact: false }),
  ).toBeVisible();
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  const preview = f.requests.find((r) => r.path.endsWith('/preview'))!.body;
  expect(preview.entries[0]).toMatchObject({
    knowledgeAcceptanceId: receiptId,
    choices: { attributeList: [{ attribute_id: 7, attribute_value_list: [{ value_id: 8 }] }] },
  });
  expect(knowledgeRequests[0].body).toEqual(target);
  expect(knowledgeRequests[1].body).toMatchObject({
    ...target,
    recommendationFingerprint: fp,
    attributeIds: [7],
  });
  expect(knowledgeRequests.some((r) => /publish|execute|run/.test(r.path))).toBe(false);
});

test('a delayed knowledge acceptance preserves newer unrelated preparation edits', async ({
  page,
}) => {
  const f = await fixture(page),
    connectionId = '55d8eb95-9a73-40eb-a6e3-2fbcb8b9623e',
    receiptId = '0be3ee9f-fc0e-4876-ad86-a59e6209384a';
  let release!: () => void, requested!: () => void;
  const waiting = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      requested = resolve;
    });
  const target = {
    productKey: sourceKey,
    expectedRevision: 4,
    connectionId,
    categoryId: 10,
    brandId: 20,
  };
  await page.route('**/v1/seller-knowledge/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/shops'))
      return route.fulfill({
        json: {
          shops: [
            {
              id: connectionId,
              state: 'connected',
              scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
            },
          ],
        },
      });
    const metadata = {
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    if (path.endsWith('/draft-recommendations'))
      return route.fulfill({
        json: {
          target,
          fingerprint: fp,
          sourceFacts: [],
          metadata,
          recommendations: {
            issues: [],
            suggestions: [
              {
                attributeId: 7,
                name: 'Xuất xứ',
                sourceClass: 'product_source',
                canPrefill: true,
                reasons: [],
                evidenceIds: [],
                values: [{ valueId: 8, displayName: 'Việt Nam' }],
              },
            ],
          },
        },
      });
    if (path.endsWith('/draft-acceptances')) {
      requested();
      await waiting;
      return route.fulfill({
        json: {
          id: receiptId,
          target,
          attributeList: [{ attribute_id: 7, attribute_value_list: [{ value_id: 8 }] }],
          metadata,
        },
      });
    }
    return route.abort();
  });
  const region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region
    .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
    .check();
  await region.getByRole('button', { name: 'Đọc gợi ý có nguồn' }).click();
  await region.getByLabel('Chọn Xuất xứ', { exact: true }).check();
  await region.getByRole('button', { name: 'Dùng thông tin đã chọn trong bản xem trước' }).click();
  await started;
  await region.getByLabel('Dài kiện hàng (cm)').fill('17');
  release();
  await expect(
    region.getByText('Đã lưu lựa chọn cho bản xem trước', { exact: false }),
  ).toBeVisible();
  await expect(region.getByLabel('Dài kiện hàng (cm)')).toHaveValue('17');
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  expect(f.requests.find((r) => r.path.endsWith('/preview'))!.body.entries[0]).toMatchObject({
    knowledgeAcceptanceId: receiptId,
    choices: { dimensionCm: { length: 17 } },
  });
});

test('saved listing uses existing mapping, explicit zero stock and server warehouse proof; preparation and publishing remain separate', async ({
  page,
}) => {
  const f = await fixture(page),
    region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region
    .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
    .check();
  await expect(region.getByRole('radio', { name: 'Đăng ẩn để QC', exact: true })).toBeChecked();
  await expect(region.getByLabel('Cân nặng đóng gói (g)', { exact: false })).toHaveValue('130.9');
  await expect(region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn')).toHaveValue('');
  await expect(region.getByText('DORIS.xlsx · DORIS · SHOP MALL', { exact: false })).toBeVisible();
  await region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn').fill('0');
  await region.getByRole('button', { name: 'Áp dụng tồn cho SKU đã chọn' }).click();
  await region.getByLabel('Tình trạng sản phẩm').selectOption('NEW');
  await region.getByLabel('Hàng đặt trước', { exact: true }).selectOption('no');
  for (const label of ['Dài', 'Rộng', 'Cao'])
    await region.getByLabel(label + ' kiện hàng (cm)').fill(label === 'Cao' ? '28' : '12');
  await region.getByRole('button', { name: 'Chọn listing tham khảo kho' }).click();
  await region.getByLabel('Listing đang có tại shop').selectOption('9001');
  await expect(
    region.getByText('Đã có đối chiếu kho cho đúng shop', { exact: false }),
  ).toBeVisible();
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  const received = f.requests[0]!.body.entries[0];
  expect(f.requests[0]!.body.publicationMode).toBe('hidden_for_review');
  expect(f.requests[0]!.body.imageQcPolicy).toBe('required');
  expect(received).toMatchObject({
    productKey: sourceKey,
    sourceRevision: 4,
    priceSelection: { importId: priceId, sheet: 'DORIS', priceProfile: 'SHOP MALL' },
    stocks: { 'SKU-A': 0 },
    choices: {
      brandId: '20',
      brandName: 'VINA TƯƠI',
      weightGrams: 130.9,
      stockLocation: {
        referenceItemId: '9001',
        expectedLocationBySku: { 'SKU-A': 'READ-TEST' },
        writeLocationBySku: { 'SKU-A': 'WRITE-TEST' },
      },
    },
  });
  expect(received).not.toHaveProperty('title');
  expect(received).not.toHaveProperty('document');
  const result = region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' });
  await result.locator('summary').click();
  await expect(result.getByText('125.000 đ', { exact: true })).toBeVisible();
  expect(await result.locator('.preparation-source-text').last().textContent()).toBe(
    ' Dòng 1\n\nDòng 2 ',
  );
  expect(f.requests.filter((r) => r.path.endsWith('/run'))).toHaveLength(0);
  await result.getByRole('button', { name: 'Chuẩn bị đợt cho 1 listing đủ nguồn' }).click();
  await expect(page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(f.requests[1]!.body).toEqual({ expectedFingerprint: fp });
  expect(f.requests.filter((r) => r.path.endsWith('/run'))).toHaveLength(0);
  await expect(result.getByText('Đăng ẩn để QC', { exact: true })).toBeVisible();
  await result
    .getByRole('button', { name: 'Đăng ẩn các listing đã chuẩn bị', exact: true })
    .click();
  expect(f.requests[2]!.body).toEqual({ expectedFingerprint: fp });
  await expect(
    result.getByRole('button', { name: 'Đăng ẩn các listing đã chuẩn bị', exact: true }),
  ).toBeDisabled();
});
test('automatic publication is an explicit new preparation choice and survives its preview', async ({
  page,
}) => {
  const f = await fixture(page),
    region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region
    .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
    .check();
  await region.getByRole('radio', { name: 'Mở bán sau kiểm tra', exact: true }).check();
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  expect(f.requests[0]!.body.publicationMode).toBe('publish_after_verification');
  await expect(
    region
      .getByRole('region', { name: 'Kết quả kiểm tra nguồn' })
      .getByText('Mở bán sau kiểm tra', { exact: true }),
  ).toBeVisible();
  expect(f.requests.filter((r) => r.path.endsWith('/run') || r.path.endsWith('/publish'))).toEqual(
    [],
  );
  await region.getByRole('radio', { name: 'Đăng ẩn để QC', exact: true }).check();
  await expect(region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' })).toHaveCount(0);
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  expect(f.requests[1]!.body.publicationMode).toBe('hidden_for_review');
  expect(f.requests[1]!.body.id).not.toBe(f.requests[0]!.body.id);
});
test('image QC deferral is explicit, hidden-only and preserved in the saved preview', async ({
  page,
}) => {
  const f = await fixture(page),
    region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region
    .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
    .check();
  const defer = region.getByRole('checkbox', {
    name: 'Tạm hoãn kiểm tra ảnh để thử đăng ẩn',
    exact: true,
  });
  await expect(defer).toBeVisible();
  await expect(defer).not.toBeChecked();
  await defer.check();
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  expect(f.requests[0]!.body).toMatchObject({
    publicationMode: 'hidden_for_review',
    imageQcPolicy: 'defer_image_qc',
  });
  await expect(
    region
      .getByRole('region', { name: 'Kết quả kiểm tra nguồn' })
      .getByText('Ảnh chưa QC', { exact: true }),
  ).toBeVisible();
  await region.getByRole('radio', { name: 'Mở bán sau kiểm tra', exact: true }).check();
  await expect(defer).not.toBeChecked();
  await expect(defer).toBeDisabled();
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  expect(f.requests[1]!.body).toMatchObject({
    publicationMode: 'publish_after_verification',
    imageQcPolicy: 'required',
  });
});
test('missing warehouse proof stays an explicit exception and mobile form has no horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page, true),
    region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region
    .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
    .check();
  await region.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn' }).click();
  expect(f.requests[0]!.body.entries[0].choices).not.toHaveProperty('stockLocation');
  expect(f.requests[0]!.body.entries[0].stocks).toEqual({});
  await expect(region.getByText('Chưa có bằng chứng đối chiếu kho.')).toBeVisible();
  await expect(
    region.getByRole('button', { name: 'Chuẩn bị đợt cho 0 listing đủ nguồn' }),
  ).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('paused parent queue from a previous session can be explicitly resumed without repeating preparation', async ({
  page,
}) => {
  const f = await fixture(page, false, true),
    region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region.getByText('Bản kiểm tra đã lưu (1)').click();
  await region
    .getByRole('button', { name: 'Listing tinh dầu đã chuẩn bị · 1 đủ nguồn, 0 cần bổ sung' })
    .click();
  await expect(region.getByRole('status').last()).toContainText('Đang tạm dừng để kiểm tra');
  await expect(region.getByText('Lô cũ · Tự mở bán sau đối chiếu', { exact: true })).toBeVisible();
  await region.getByRole('button', { name: 'Tiếp tục các listing chưa hoàn tất' }).click();
  expect(f.requests).toEqual([
    {
      path: '/v1/production-preparations/' + previewId + '/run',
      body: { expectedFingerprint: fp },
    },
  ]);
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true }).click();
  await region.getByText('Bản kiểm tra đã lưu (1)').click();
  await region
    .getByRole('button', { name: 'Listing tinh dầu đã chuẩn bị · 1 đủ nguồn, 0 cần bổ sung' })
    .click();
  await expect(
    region.getByRole('button', { name: 'Đăng các listing đã chuẩn bị', exact: true }),
  ).toBeDisabled();
  expect(f.requests).toHaveLength(1);
});
test('converted legacy preparation displays effective hidden image-QC policy without starting the paused work', async ({
  page,
}) => {
  const f = await fixture(page, false, true, {
    publicationMode: 'hidden_for_review',
    imageQcPolicy: 'defer_image_qc',
    executionPolicyFingerprint: 'c'.repeat(64),
  });
  const region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region.getByText('Bản kiểm tra đã lưu (1)').click();
  await region
    .getByRole('button', { name: 'Listing tinh dầu đã chuẩn bị · 1 đủ nguồn, 0 cần bổ sung' })
    .click();
  const run = region.locator('.preparation-run');
  await expect(
    run.getByRole('button', { name: 'Tiếp tục đăng ẩn các listing chưa hoàn tất', exact: true }),
  ).toBeVisible();
  await expect(
    run.getByText('Đã chuyển phần còn lại sang đăng ẩn và mở bán thủ công.', { exact: true }),
  ).toBeVisible();
  await expect(run.getByText('Đã chọn tạm hoãn kiểm tra ảnh.', { exact: false })).toBeVisible();
  await expect(run).not.toContainText('rồi tự mở bán');
  await run.getByRole('button', { name: 'Đọc lại tiến độ đăng' }).click();
  expect(f.requests).toEqual([]);
});
test('interrupted local preview reuses the same request after reload and never starts a batch', async ({
  page,
}) => {
  const f = await fixture(page);
  const stored = {
    id: previewId,
    entries: [
      {
        productKey: sourceKey,
        sourceRevision: 4,
        priceSelection: { importId: priceId, sheet: 'DORIS', priceProfile: 'SHOP MALL' },
        stocks: { 'SKU-A': 0 },
        choices: {},
      },
    ],
  };
  await page.evaluate(
    (value) => sessionStorage.setItem('production-preparation-pending', JSON.stringify(value)),
    stored,
  );
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính', exact: true })
    .getByRole('button', { name: 'Đăng hàng', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true }).click();
  const region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region.getByRole('button', { name: 'Lấy lại kết quả kiểm tra trước' }).click();
  expect(f.requests).toEqual([{ path: '/v1/production-preparations/preview', body: stored }]);
  await expect(region.getByRole('region', { name: 'Kết quả kiểm tra nguồn' })).toBeVisible();
});
test('switching between working batches and new preparation preserves the selected source and stock input', async ({
  page,
}) => {
  const f = await fixture(page),
    region = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu' });
  await region
    .getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false })
    .check();
  await region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn').fill('37');
  await page.getByRole('tab', { name: 'Đợt đang làm', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Đợt đăng mới' })).toBeVisible();
  await expect(region).toBeHidden();
  await page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true }).click();
  await expect(region.getByLabel('Tồn đăng bán chung cho các SKU đã chọn')).toHaveValue('37');
  await expect(
    region.getByRole('checkbox', { name: 'Listing tinh dầu đã chuẩn bị', exact: false }),
  ).toBeChecked();
  expect(f.requests).toHaveLength(0);
});
