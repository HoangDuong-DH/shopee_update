import { fulfillPagedProducts } from './fixtures/product-paging.js';
import { test, expect, type Page } from '@playwright/test';
import { seed, imports, sourceIds, variants, priceId, coverId, galleryId, foreignImageId, shopId, draftFromPayload, mappingReviewFor, priceReviewFor } from './fixtures/editor-authoring-data.js';
import { editorRecoveryKey, makeEditorRecovery, type EditorSavePayload } from '../../apps/web/src/editor-recovery.js';

test.beforeEach(async ({ page }, info) => {
  test.skip(info.config.metadata.editorAuthoringFixture !== true, 'Run with the isolated component fixture runner.');
  const origin = new URL(String(info.project.use.baseURL)).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route('**/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/v1/media/')) return fulfillPagedProducts(route,{ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/k1sAAAAASUVORK5CYII=', 'base64') });
    if (path.startsWith('/v1/imports/')) {
      const record = imports.find(record => record.id === path.split('/').at(-1));
      if (record) return fulfillPagedProducts(route,{ json: record });
    }
    if (path.endsWith('/mapping-review')) return fulfillPagedProducts(route,{ json: mappingReviewFor(draftFromPayload(seed, 2), false) });
    return fulfillPagedProducts(route,{ status: 404, json: { code: 'NOT_FOUND' } });
  });
});
async function openEditing(page: Page, query = '') {
  await page.goto('/frontend-fixture?' + query);
  await page.getByRole('button', { name: 'Điều chỉnh nội dung và ảnh', exact: true }).click();
}
const title = (page: Page) => page.getByRole('textbox', { name: 'Tiêu đề listing', exact: true });
const body = (page: Page) => page.getByRole('textbox', { name: 'Nội dung sau toàn bộ ảnh mô tả', exact: true });
const save = (page: Page) => page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first();

test('reload restores exact text, image order and the last section for the same product revision', async ({ page }) => {
  await openEditing(page);
  await title(page).fill('  Chữ đang sửa nguyên văn  ');
  await body(page).fill(' Giữ\nđúng khoảng trắng và xuống dòng ');
  await page.getByRole('tab', { name: /Bộ ảnh/ }).click();
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.section, editorRecoveryKey(seed.productKey, 2))).toBe('images');
  await page.reload();
  await expect(page.getByRole('tab', { name: /Bộ ảnh/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Nội dung', exact: true }).click();
  await expect(title(page)).toHaveValue('  Chữ đang sửa nguyên văn  ');
  await expect(body(page)).toHaveValue(' Giữ\nđúng khoảng trắng và xuống dòng ');
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), editorRecoveryKey(seed.productKey, 2));
  expect(stored.form.galleryIds).toEqual([galleryId]); expect(stored.form.variants[0].importId).toBe(priceId);
  expect(stored.form.variants[0].optionLabels).toEqual(seed.variants[0]!.optionLabels);
});

test('a lost POST response reads and accepts the exact next local revision without replaying the write', async ({ page }) => {
  const writes: EditorSavePayload[] = [], events: string[] = [];
  await page.route('**/v1/products**', route => {
    if (route.request().method() === 'POST') { events.push('POST'); writes.push(route.request().postDataJSON()); return route.abort('failed'); }
    events.push('GET'); return fulfillPagedProducts(route,{ json: draftFromPayload(writes[0]!) });
  });
  await openEditing(page, 'emptyImports'); await title(page).fill('Sau chỉnh nội dung · TEST'); await save(page).click();
  await expect(page.getByTestId('saved-result')).toBeVisible();
  expect(events).toEqual(['POST', 'GET']); expect(writes).toHaveLength(1);
  expect(writes[0]!.variants).toEqual(seed.variants); expect(writes[0]).not.toHaveProperty('mappingConfirmation');
  expect(await page.evaluate(key => localStorage.getItem(key), editorRecoveryKey(seed.productKey, 2))).toBeNull();
});

test('response loss keeps the immutable request on reload and rechecks before an explicit retry', async ({ page }) => {
  const writes: EditorSavePayload[] = [], events: string[] = []; let committed = false;
  await page.route('**/v1/products**', route => {
    if (route.request().method() === 'POST') {
      events.push('POST'); writes.push(route.request().postDataJSON());
      if (writes.length === 1) return route.abort('failed');
      committed = true; return fulfillPagedProducts(route,{ json: draftFromPayload(writes[1]!) });
    }
    events.push('GET'); return fulfillPagedProducts(route,{ json: committed ? draftFromPayload(writes[1]!) : draftFromPayload(seed, 2) });
  });
  await openEditing(page); await title(page).fill('Yêu cầu đang giữ · TEST'); await save(page).click();
  await expect(page.getByRole('button', { name: 'Gửi lại đúng yêu cầu đã giữ', exact: true })).toBeVisible();
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), editorRecoveryKey(seed.productKey, 2));
  expect(stored.pending.sourceFiles.map((file: { id: string }) => file.id).sort()).toEqual([priceId, coverId, galleryId].sort());
  await page.reload(); await expect(title(page)).toHaveValue('Yêu cầu đang giữ · TEST'); await expect(title(page)).not.toBeEditable();
  await expect(save(page)).toBeDisabled(); expect(writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Kiểm tra bản đã lưu', exact: true }).click();
  await page.getByRole('button', { name: 'Gửi lại đúng yêu cầu đã giữ', exact: true }).click();
  await expect(page.getByTestId('saved-result')).toBeVisible();
  expect(writes[1]).toEqual(writes[0]); expect(events).toEqual(['POST', 'GET', 'GET', 'GET', 'POST']);
  expect(variants[0]!.originalPrice).toBe('125000');
});

test('a changed price remains a conflict and opening the latest source keeps the pending copy', async ({ page }) => {
  const writes: EditorSavePayload[] = [];
  await page.route('**/v1/products**', route => {
    if (route.request().method() === 'POST') { writes.push(route.request().postDataJSON()); return route.abort('failed'); }
    const latest = draftFromPayload(writes[0]!); latest.variants[0]!.originalPrice.value = '125001';
    return fulfillPagedProducts(route,{ json: latest });
  });
  await openEditing(page); await title(page).fill('Copy đang chờ · TEST'); await save(page).click();
  await expect(page.getByRole('alert')).toContainText('Phần đang sửa được giữ riêng');
  await expect(page.getByRole('button', { name: 'Gửi lại đúng yêu cầu đã giữ', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Xem bản nguồn mới nhất', exact: true }).click();
  await expect(page.getByTestId('continuation-result')).toContainText('"revision":3');
  expect(await page.evaluate(key => Boolean(JSON.parse(localStorage.getItem(key)!)?.pending), editorRecoveryKey(seed.productKey, 2))).toBe(true);
  expect(writes).toHaveLength(1);
});

test('quota failure truthfully warns and prevents a write without durable request recovery', async ({ page }) => {
  let writes = 0;
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('Quota', 'QuotaExceededError'); }; });
  await page.route('**/v1/products', route => { writes++; return route.abort(); });
  await openEditing(page); await title(page).fill('Không mất nội dung · TEST'); await save(page).click();
  await expect(page.getByText('Chưa lưu được bản phục hồi trên máy này.', { exact: false })).toBeVisible();
  await expect(page.getByText('Chưa lưu được yêu cầu phục hồi trên máy này.', { exact: false })).toBeVisible();
  await expect(title(page)).toHaveValue('Không mất nội dung · TEST'); expect(writes).toBe(0);
});

test('older revision text is retained separately without replacing the newer seed', async ({ page }) => {
  const recovery = makeEditorRecovery(seed, { form: { ...seed, title: 'Chữ đang sửa bản cũ · TEST' }, layout: 'headline-images-body', section: 'content', sourceImportIds: sourceIds });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: editorRecoveryKey(seed.productKey, 2), value: JSON.stringify(recovery) });
  await page.goto('/frontend-fixture?revision=3');
  await expect(title(page)).toHaveValue('Nguồn phiên bản mới · TEST');
  await page.getByText('Phần sửa đã giữ riêng từ bản nguồn 2', { exact: false }).click();
  await expect(page.getByLabel('Tiêu đề trong bản đang sửa', { exact: true })).toHaveValue('Chữ đang sửa bản cũ · TEST');
  await expect(page.getByLabel('Tiêu đề trong bản đang sửa', { exact: true })).not.toBeEditable();
});

test('image choices stay within the source set and Escape returns keyboard focus', async ({ page }) => {
  await page.goto('/frontend-fixture?component=images'); await page.getByRole('button', { name: 'Thêm ảnh', exact: true }).click();
  const chooser = page.getByRole('region', { name: 'Chọn tệp cho ảnh sản phẩm', exact: true });
  await expect(chooser.getByText(imports.find(record => record.id === foreignImageId)!.filename, { exact: true })).toHaveCount(0);
  const search = chooser.getByRole('textbox', { name: 'Tìm tệp cho ảnh sản phẩm', exact: true }); await expect(search).toBeFocused(); await search.fill('anh bia');
  await chooser.getByRole('button', { name: /Ảnh bìa.png/ }).click();
  await expect(page.getByTestId('image-selection')).toHaveText(JSON.stringify([galleryId, coverId]));
  await search.press('Escape'); await expect(chooser).toHaveCount(0); await expect(page.getByRole('button', { name: 'Thêm ảnh', exact: true })).toBeFocused();
});

test('an unknown source retains linked media and gives no global picker or remove action', async ({ page }) => {
  await page.goto('/frontend-fixture?component=images&scope=unknown');
  await expect(page.getByRole('img', { name: imports[2]!.filename, exact: true })).toBeVisible();
  await expect(page.getByText('Chưa xác định được đúng bộ nguồn.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thêm ảnh', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Bỏ ảnh sản phẩm/ })).toHaveCount(0);
});

test('production continuation requires an explicit shop and passes the exact product and revision', async ({ page }) => {
  await page.goto('/frontend-fixture?component=preview');
  const action = page.getByRole('button', { name: 'Mở đợt đăng qua API', exact: true }); await expect(action).toBeDisabled();
  await page.getByRole('combobox', { name: 'Shop để tiếp tục', exact: true }).selectOption(shopId); await action.click();
  await expect(page.getByTestId('continuation-result')).toHaveText(JSON.stringify({ productKey: seed.productKey, revision: 2, shopConnectionId: shopId }));
});

test('an unavailable selected shop stays pinned and never adopts a different shop', async ({ page }) => {
  await page.goto('/frontend-fixture?component=preview&missingShop&selectedShop=' + shopId);
  await expect(page.getByRole('combobox', { name: 'Shop để tiếp tục', exact: true })).toHaveValue(shopId);
  await expect(page.getByText('Shop đã chọn chưa sẵn sàng.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Mở đợt đăng qua API', exact: true }).click();
  await expect(page.getByTestId('continuation-result')).toContainText('"shopConnectionId":"' + shopId + '"');
});

test('mobile authoring stays within the viewport and section tabs work by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await openEditing(page);
  const content = page.getByRole('tab', { name: 'Nội dung', exact: true }); await content.focus(); await content.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Bộ ảnh/ })).toBeFocused(); await expect(page.getByRole('tab', { name: /Bộ ảnh/ })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('editor-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 720 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('tab', { name: /Bộ ảnh/ }).press('End'); await expect(page.getByRole('tab', { name: /SKU & phân loại/ })).toBeFocused();
});

async function preparationFixture(page: Page, sourceRevision = 2) {
  const writes: { path: string; body: { entries: Array<{ stocks: Record<string, number> }> } }[] = [];
  await page.route('**/v1/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      if (path !== '/v1/production-preparations/preview') return route.abort();
      writes.push({ path, body: request.postDataJSON() });
      return fulfillPagedProducts(route,{ json: { id: '66666666-6666-4666-8666-666666666666', fingerprint: 'a'.repeat(64), readyCount: 0, blockedCount: 1,
        entries: [{ productKey: seed.productKey, title: seed.title, kind: 'blocked', issues: [{ field: 'categoryId', code: 'SOURCE_REQUIRED', message: 'Cần nguồn ngành hàng của bộ thử.' }] }] } });
    }
    if (path === '/v1/production-preparations/context') return fulfillPagedProducts(route,{ json: {
      scope: { partnerId: 'FIXTURE-PARTNER', shopId: 'FIXTURE-SHOP' },
      products: [{ productKey: seed.productKey, title: seed.title, revision: sourceRevision, skus: variants.map(v => v.sku), issues: [] },
        { productKey: 'fixture-another-source', title: 'Bộ thử khác đã chuẩn bị', revision: 1, skus: ['FIXTURE-OTHER'], issues: [] }],
      pricebooks: [], preparations: [],
    } });
    if (path.startsWith('/v1/products/')) {
      const draft = draftFromPayload(seed, sourceRevision);
      if (path.endsWith('fixture-another-source')) { draft.productKey = 'fixture-another-source'; draft.revision = 1; draft.title.value = 'Bộ thử khác đã chuẩn bị'; }
      return fulfillPagedProducts(route,{ json: draft });
    }
    if (path.startsWith('/v1/imports/')) return fulfillPagedProducts(route,{ json: { ...imports[0], body: { rows: [{ key: seed.variants[0]!.rowKey, sheet: 'Sheet1', priceProfile: null }] } } });
    if (path === '/v1/production-preparations/metadata') return fulfillPagedProducts(route,{ json: { shop: { id: 'FIXTURE-SHOP', name: 'Shop thử giao diện' }, categories: [], attributes: [], channels: [] } });
    return route.fallback();
  });
  return writes;
}

test('preparation selects only the requested revision and submits stock zero only after explicit application', async ({ page }) => {
  const writes = await preparationFixture(page);
  await page.goto('/frontend-fixture?component=preparation');
  await expect(page.getByRole('checkbox', { name: new RegExp(seed.title) })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Bộ thử khác đã chuẩn bị/ })).not.toBeChecked();
  const input = page.getByRole('textbox', { name: 'Tồn áp dụng cho 1 dòng SKU trong 1 listing đã chọn', exact: true });
  await expect(input).toHaveValue(''); expect(writes).toEqual([]);
  await input.fill('0'); await page.getByRole('button', { name: 'Áp dụng 0 cho các dòng SKU đã chọn', exact: true }).click();
  await expect(page.getByText('Đã áp dụng tồn 0 cho 1 dòng SKU', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1); expect(writes[0]!.body.entries[0]!.stocks).toEqual({ 'FIXTURE-SKU-EXACT': 0 });
});

test('preparation refuses to adopt a changed source revision automatically', async ({ page }) => {
  const writes = await preparationFixture(page, 3);
  await page.goto('/frontend-fixture?component=preparation');
  await expect(page.getByText('Bộ vừa mở đã đổi phiên bản nguồn.', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: new RegExp(seed.title) })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Bộ thử khác đã chuẩn bị/ })).not.toBeChecked(); expect(writes).toEqual([]);
});

test('preparation keeps an existing shop working copy instead of applying the newly requested product', async ({ page }) => {
  const working = { version: 1, scope: { partnerId: 'FIXTURE-PARTNER', shopId: 'FIXTURE-SHOP' }, selected: [{ productKey: 'fixture-another-source', revision: 1 }],
    entries: [{ productKey: 'fixture-another-source', revision: 1, choices: {}, stocks: {}, brandSearch: '' }], stock: '', opened: 'fixture-another-source' };
  await page.addInitScript(value => sessionStorage.setItem('production-preparation-working-copy-v1:FIXTURE-PARTNER:FIXTURE-SHOP', JSON.stringify(value)), working);
  const writes = await preparationFixture(page);
  await page.goto('/frontend-fixture?component=preparation');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('production-preparation-working-copy-v1:FIXTURE-PARTNER:FIXTURE-SHOP')!)?.attributeMode)).toBe('minimum_required');
  await expect(page.getByText('Đang giữ phần chuẩn bị hoặc lần kiểm tra cần phục hồi của shop này.', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Bộ thử khác đã chuẩn bị/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: new RegExp(seed.title) })).not.toBeChecked(); expect(writes).toEqual([]);
});

test('edited folder sources follow the current server mapping gate before confirming price on the new revision', async ({ page }) => {
  const payload = { ...seed, folderBinding: { batchId: '77777777-7777-4777-8777-777777777777', revision: 1, groupKey: 'TEST/Bộ riêng' } }, writes: Array<{ path: string; body: unknown }> = [];
  let current = draftFromPayload(payload, 2);
  await page.route('**/v1/products/**', route => {
    const path = new URL(route.request().url()).pathname, request = route.request();
    if (request.method() === 'POST') {
      writes.push({ path, body: request.postDataJSON() });
      if (path.endsWith('/confirm-mapping')) { current = draftFromPayload(payload, 3); return fulfillPagedProducts(route,{ json: current }); }
      if (path.endsWith('/confirm-price-mapping')) return fulfillPagedProducts(route,{ json: { confirmed: true } });
      return route.abort();
    }
    if (path.endsWith('/mapping-review')) return fulfillPagedProducts(route,{ json: mappingReviewFor(current, current.revision === 2) });
    if (path.endsWith('/price-mapping-review')) return fulfillPagedProducts(route,{ json: priceReviewFor(current) });
    return route.abort();
  });
  await page.goto('/frontend-fixture?component=preview&folder');
  await expect(page.getByText('Xác nhận cấu trúc và đúng ảnh nguồn', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Xem bảng đối chiếu SKU và giá', exact: true }).click();
  const confirmPrice = page.getByRole('button', { name: 'Tôi đã đối chiếu từng phân loại, SKU và giá nguồn', exact: true }); await expect(confirmPrice).toBeDisabled();
  await page.getByRole('button', { name: 'Xem bản ánh xạ cần xác nhận', exact: true }).click();
  await expect(page.getByText(imports[2]!.filename, { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Tôi đã đối chiếu và xác nhận đúng ánh xạ này', exact: true }).click();
  await expect(page.getByText('Bộ đã lưu · Bản nguồn 3', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Bảng đối chiếu SKU và giá', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Xác nhận cấu trúc và đúng ảnh nguồn', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Xem bảng đối chiếu SKU và giá', exact: true }).click(); await confirmPrice.click();
  expect(writes).toEqual([{ path: '/v1/products/' + seed.productKey + '/confirm-mapping', body: { expectedRevision: 2, expectedFingerprint: '2'.repeat(64) } },
    { path: '/v1/products/' + seed.productKey + '/confirm-price-mapping', body: { expectedRevision: 3, expectedFingerprint: 'f'.repeat(64) } }]);
});

test('a current server decision suppresses mapping confirmation even for an unbound source', async ({ page }) => {
  const writes: string[] = [];
  await page.route('**/v1/products/**', route => {
    if (route.request().method() !== 'GET') { writes.push(route.request().url()); return route.abort(); }
    return fulfillPagedProducts(route,{ json: mappingReviewFor(draftFromPayload(seed, 2), false) });
  });
  await page.goto('/frontend-fixture?component=preview');
  await expect(page.getByText('Đã có xác nhận cấu trúc và ảnh cho bản nguồn hiện tại.', { exact: false })).toBeVisible();
  await expect(page.getByText('Xác nhận cấu trúc và đúng ảnh nguồn', { exact: true })).toHaveCount(0); expect(writes).toEqual([]);
});

test('unknown mapping status cannot authorize price confirmation and offers a read-only recovery action', async ({ page }) => {
  let readable = false; const writes: string[] = [];
  await page.route('**/v1/products/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') { writes.push(path); return route.abort(); }
    if (path.endsWith('/mapping-review')) return readable ? fulfillPagedProducts(route,{ json: mappingReviewFor(draftFromPayload(seed, 2), false) }) : fulfillPagedProducts(route,{ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
    if (path.endsWith('/price-mapping-review')) return fulfillPagedProducts(route,{ json: priceReviewFor(draftFromPayload(seed, 2)) });
    return route.abort();
  });
  await page.goto('/frontend-fixture?component=preview&folder');
  await expect(page.getByText('Chưa xác định được yêu cầu xác nhận cấu trúc', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Xem bảng đối chiếu SKU và giá', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Tôi đã đối chiếu từng phân loại, SKU và giá nguồn', exact: true }); await expect(confirm).toBeDisabled();
  readable = true; await page.getByRole('button', { name: 'Đọc lại trạng thái xác nhận cấu trúc', exact: true }).click(); await expect(confirm).toBeEnabled(); expect(writes).toEqual([]);
});

test('an old mapping response cannot unlock price confirmation after the source revision changes', async ({ page }) => {
  let reads = 0, release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/v1/products/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/mapping-review')) {
      reads++;
      if (reads === 1) { await waiting; try { await fulfillPagedProducts(route,{ json: mappingReviewFor(draftFromPayload(seed, 2), false) }); } catch { /* The obsolete read may have been cancelled. */ } return; }
      return fulfillPagedProducts(route,{ json: mappingReviewFor(draftFromPayload(seed, 3), true) });
    }
    if (path.endsWith('/price-mapping-review')) return fulfillPagedProducts(route,{ json: priceReviewFor(draftFromPayload(seed, 3)) });
    return route.abort();
  });
  await page.goto('/frontend-fixture?component=preview&switchPreview'); await expect.poll(() => reads).toBe(1);
  await page.getByRole('button', { name: 'Chuyển bản nguồn thử mới', exact: true }).click(); await expect.poll(() => reads).toBe(2);
  release(); await expect(page.getByText('Xác nhận cấu trúc và đúng ảnh nguồn', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Xem bảng đối chiếu SKU và giá', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Tôi đã đối chiếu từng phân loại, SKU và giá nguồn', exact: true })).toBeDisabled();
});
