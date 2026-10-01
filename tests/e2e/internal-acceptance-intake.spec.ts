import { test, expect } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { zipSync } from 'fflate';
import { openInputLibrary, openWorkspaceTool } from './workspace-navigation.js';
let server: ChildProcess, baseURL: string, evidenceRoot: string, fixture: any;
test.beforeAll(async () => {
  if (process.env.INTERNAL_ISOLATED_MODE !== '1' || new URL(process.env.DATABASE_URL!).port !== '5443') throw Error('INTERNAL_ACCEPTANCE_ISOLATION_REQUIRED');
  server = fork(resolve('tests/e2e/internal-acceptance-server.mts'), [], { execArgv: ['--import', './scripts/internal-network-guard.mjs', '--conditions=development', '--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, TSX_TSCONFIG_PATH: resolve('apps/api/tsconfig.json') }, windowsHide: true } as any);
  baseURL = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(Error('Isolated acceptance startup timed out')), 45000);
    server.on('message', (message: any) => { if (message.ready) { clearTimeout(timer); evidenceRoot = message.root; fixture = message.fixture; done(message.baseURL); }
      else if (message.error) { clearTimeout(timer); fail(Error(message.error)); } });
    server.once('exit', code => { clearTimeout(timer); fail(Error('Fixture exit ' + code)); });
    server.stderr?.on('data', data => process.stderr.write(data));
  });
});
test.afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((done, fail) => { const timer = setTimeout(() => { server.kill(); fail(Error('Fixture cleanup timed out')); }, 20000);
    server.once('exit', code => { clearTimeout(timer); code === 0 ? done() : fail(Error('Fixture cleanup failed')); }); server.send('stop'); });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && evidenceRoot) {
    await writeFile(resolve(evidenceRoot, 'failed-ui.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: resolve(evidenceRoot, 'failed-ui.png'), fullPage: true });
  }
});
async function snapshot() {
  return new Promise<any>((done, fail) => { const requestId = randomUUID(), timer = setTimeout(() => fail(Error('Snapshot timeout')), 10000);
    const receive = (message: any) => { if (message.requestId !== requestId) return; clearTimeout(timer); server.off('message', receive); done(message.snapshot); };
    server.on('message', receive); server.send({ command: 'snapshot', requestId }); });
}
test('operator imports actual ZIP and Excel, edits a draft, prepares and runs a hidden job, refreshes and exports its QC report', async ({ page }) => {
  test.setTimeout(180000); page.setDefaultTimeout(15000);
  const requests: string[] = [], outside: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (!['127.0.0.1', 'localhost'].includes(url.hostname)) outside.push(url.origin);
    if (request.method() === 'POST') requests.push(url.pathname); });
  const image = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#436555' } }).png().toBuffer();
  const cover = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#715b43' } }).png().toBuffer();
  const archive = zipSync({ '222 Mũ/bia.png': cover, '222 Mũ/gallery.png': image, '224 Tủ/bia.png': cover });
  const prices = new ExcelJS.Workbook(); prices.addWorksheet('Giá gốc').addRows([
    ['SKU', 'TÊN SẢN PHẨM', 'GIÁ GỐC', 'GIÁ BÁN', 'CÂN NẶNG KHAI BÁO (G)', 'THƯƠNG HIỆU'],
    ['ACCEPT-100', 'Xịt mũ 100ml', 11000, 10000, 100, fixture.category.brandName],
    ['ACCEPT-280', 'Xịt mũ 280ml', 12000, 11000, 280, fixture.category.brandName],
    ['ACCEPT-500', 'Xịt mũ 500ml', 13000, 12000, 500, fixture.category.brandName],
  ]);
  const content = new ExcelJS.Workbook(); content.addWorksheet('Nội dung').addRows([
    ['STT', 'Tiêu đề', 'Mở đầu', 'Nội dung'], [222, 'Xịt mũ bảo hiểm QA', 'Mở đầu QA', 'Nội dung nguyên văn QA'], [224, 'Xịt tủ giày thiếu SKU', 'Mở đầu', 'Chờ xác định SKU'],
  ]);
  const priceBytes = Buffer.from(await prices.xlsx.writeBuffer()), contentBytes = Buffer.from(await content.xlsx.writeBuffer());
  await page.goto(baseURL); await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByRole('button', { name: 'Nhập bộ nguồn', exact: true }).first().click();
  await page.getByLabel('Tải bảng giá chung', { exact: true }).setInputFiles({ name: 'Gia-goc.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: priceBytes });
  await page.getByRole('combobox', { name: 'Sheet chứa giá', exact: true }).selectOption('Giá gốc');
  await page.getByRole('combobox', { name: 'Bộ giá áp dụng', exact: true }).selectOption('null');
  await page.getByLabel('Bố cục trong ZIP', { exact: true }).selectOption('listing_folders');
  await page.getByLabel('Chọn ZIP nguồn listing', { exact: true }).setInputFiles({ name: 'Nguon.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) });
  await expect(page.getByTestId('folder-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu vào Kho đầu vào' })).toBeVisible();
  await page.getByText('Nội dung từ Excel — ghép cùng lúc theo STT', { exact: true }).click();
  await page.getByLabel('Chọn Excel nội dung', { exact: true }).setInputFiles({ name: 'Noi-dung.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: contentBytes });
  await page.getByLabel('Sheet nội dung', { exact: true }).selectOption('Nội dung');
  for (const [label, column] of [['Cột STT', 'A'], ['Cột Tiêu đề', 'B'], ['Cột Câu mở đầu (tùy chọn)', 'C'], ['Cột Nội dung sau ảnh', 'D']])
    await page.getByLabel(label!, { exact: true }).selectOption(column!);
  await page.getByRole('button', { name: 'Xem ghép nội dung cho cả lô', exact: true }).click();
  await page.getByRole('button', { name: 'Áp dụng nội dung các bộ đã chọn', exact: true }).click();
  await expect(page.getByText('Đã gắn nội dung: 2 bộ.', { exact: false })).toBeVisible();
  const candidate = page.getByTestId('folder-candidate');
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh bia.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Dùng làm ảnh bìa', exact: true }).click();
  await candidate.getByRole('checkbox', { name: 'Chọn ảnh gallery.png', exact: true }).check();
  await candidate.getByRole('button', { name: 'Thêm vào cả hai', exact: true }).click();
  await candidate.getByRole('button', { name: 'Bổ sung SKU/phân loại', exact: true }).click();
  await page.getByRole('radio', { name: /^Một nhóm/ }).check();
  await page.getByLabel('Tên nhóm phân loại 1', { exact: true }).fill('Dung tích');
  for (const [index, volume] of [100, 280, 500].entries()) {
    if (index) await page.getByRole('button', { name: 'Thêm dòng SKU', exact: true }).click();
    await page.getByLabel(`SKU dòng ${index + 1}`, { exact: true }).fill(`ACCEPT-${volume}`);
    await page.getByLabel(`Nhãn nhóm 1 dòng ${index + 1}`, { exact: true }).fill(`${volume}ml`);
  }
  await page.getByRole('button', { name: 'Tiếp tục: kiểm tra', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Tôi đã kiểm tra đủ SKU, đúng tên và thứ tự phân loại của bộ listing này.', exact: true }).check();
  await page.getByRole('button', { name: 'Tiếp tục: nội dung & ảnh', exact: true }).click();
  await expect(page.getByLabel('Tiêu đề listing', { exact: true })).toHaveValue('Xịt mũ bảo hiểm QA');
  await page.getByRole('combobox', { name: 'Bố trí mô tả trong bộ nguồn', exact: true }).selectOption('headline-images-body');
  await page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first().click();
  await expect.poll(async () => (await snapshot()).products.length).toBe(1);
  await page.reload(); await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByTestId('listing-row').getByRole('checkbox', { name: 'Chọn Xịt mũ bảo hiểm QA', exact: true }).check();
  await page.getByRole('button', { name: 'Chỉnh các bộ đã chọn', exact: true }).click();
  const bulk = page.getByRole('region', { name: 'Chỉnh phân loại hàng loạt' });
  await bulk.getByRole('checkbox', { name: /Xịt mũ bảo hiểm QA/ }).check();
  await bulk.getByLabel(/Dung tích cần bỏ/).fill('280');
  await bulk.getByRole('button', { name: 'Xem trước 1 bộ đã chọn', exact: true }).click();
  await bulk.getByRole('button', { name: 'Lưu 1 bộ nguồn đã xem trước', exact: true }).click();
  await expect(bulk.getByRole('status')).toContainText('Đã lưu: 1 bộ nguồn có phiên bản mới');
  const edited = (await snapshot()).products[0];
  expect(edited.revision).toBe(2);
  await openInputLibrary(page); await page.getByRole('button', { name: 'Tiếp tục xử lý', exact: true }).click();
  await expect(page.getByTestId('folder-row')).toHaveCount(2);
  const saved = await snapshot();
  expect(saved.products).toHaveLength(1); expect(saved.products[0].revision).toBe(2);
  expect(saved.products[0].variants.map((variant: any) => variant.sku.value)).toEqual(['ACCEPT-500', 'ACCEPT-100']);
  expect(saved.batches[0].state.contentSelections['NguonZIP/224 Tủ'].title).toBe('Xịt tủ giày thiếu SKU');
  expect(saved.errors).toEqual([]); expect(outside).toEqual([]);
  await page.getByRole('navigation', { name: 'Điều hướng chính', exact: true }).getByRole('button', { name: 'Đăng hàng', exact: true }).click();
  await page.getByLabel('Đăng vào shop', { exact: true }).selectOption(`${fixture.scope.partnerId}:${fixture.scope.shopId}`);
  await expect(page.getByRole('region', { name: 'Shop đích đang chọn', exact: true })).toContainText(fixture.scope.shopId);
  await page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true }).click();
  const preparation = page.getByRole('region', { name: 'Chuẩn bị đợt từ listing đã lưu', exact: true });
  await expect(preparation).toContainText(fixture.profile.name);
  await expect(preparation).toContainText(fixture.scope.shopId);
  async function configurePreparation() {
    await preparation.getByRole('checkbox', { name: /Xịt mũ bảo hiểm QA/ }).check();
    await preparation.getByRole('combobox', { name: 'Ngành hàng', exact: true }).selectOption(fixture.category.categoryId);
    await preparation.getByRole('combobox', { name: 'Thương hiệu', exact: true }).selectOption(fixture.category.brandId);
    await preparation.getByRole('combobox', { name: 'Tình trạng sản phẩm', exact: true }).selectOption('NEW');
    await preparation.getByLabel('Hàng đặt trước', { exact: true }).selectOption('no');
    for (const dimension of ['Dài', 'Rộng', 'Cao']) await preparation.getByLabel(dimension + ' kiện hàng (cm)', { exact: true }).fill('12');
    await preparation.getByLabel(fixture.category.requiredAttribute.name, { exact: true }).selectOption(fixture.category.requiredAttribute.values[0].valueId);
    await preparation.getByRole('checkbox', { name: 'QA vận chuyển ' + fixture.profile.name, exact: true }).check();
    await preparation.getByLabel('Tồn áp dụng cho 2 dòng SKU trong 1 listing đã chọn', { exact: true }).fill('100');
    await preparation.getByRole('button', { name: 'Áp dụng 100 cho các dòng SKU đã chọn', exact: true }).click();
    await preparation.getByRole('button', { name: 'Chọn listing tham khảo kho', exact: true }).click();
    await preparation.getByRole('combobox', { name: 'Trạng thái listing tham khảo kho', exact: true }).selectOption('UNLIST');
    await preparation.getByRole('combobox', { name: 'Listing đang có tại shop', exact: true }).selectOption(fixture.referenceItemId);
    await expect(preparation).toContainText('Đã có đối chiếu kho cho đúng shop và các SKU đã chọn.');
  }
  await configurePreparation();
  const heldReply = page.waitForResponse(reply => new URL(reply.url()).pathname === '/v1/production-preparations/preview');
  await preparation.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn', exact: true }).click();
  const held = await (await heldReply).json();
  expect(held).toMatchObject({ readyCount: 0, blockedCount: 1 });
  expect(held.entries[0]).toMatchObject({ productKey: edited.productKey, sourceRevision: edited.revision, kind: 'blocked' });
  expect(held.entries[0].issues).toHaveLength(1);
  expect(held.entries[0].issues[0]).toMatchObject({ field: 'sourceSelection', severity: 'block' });
  expect(['SOURCE_MAPPING_PROOF_MISMATCH', 'SOURCE_MAPPING_CONFIRMATION_REQUIRED']).toContain(held.entries[0].issues[0].code);
  await expect(preparation.getByRole('region', { name: 'Kết quả kiểm tra nguồn', exact: true })).toContainText('0 listing đủ nguồn · 1 cần bổ sung');
  expect(requests.filter(path => /\/production-preparations\/[^/]+\/run$/.test(path))).toEqual([]);
  expect((await snapshot()).fixtureCalls.filter((call: any) => call.method === 'POST')).toEqual([]);

  await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByRole('button', { name: 'Xịt mũ bảo hiểm QA · Xem & kiểm tra', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kiểm tra listing', exact: true })).toBeVisible();
  const mappingReply = page.waitForResponse(reply => new URL(reply.url()).pathname === `/v1/products/${edited.productKey}/mapping-review`);
  await page.getByRole('button', { name: 'Xem bản ánh xạ cần xác nhận', exact: true }).click();
  const mapping = await (await mappingReply).json();
  const expectedCoverSha = createHash('sha256').update(cover).digest('hex'), expectedGallerySha = createHash('sha256').update(image).digest('hex');
  expect(mapping).toMatchObject({ productKey: edited.productKey, revision: edited.revision, requiresConfirmation: true,
    mapping: { title: 'Xịt mũ bảo hiểm QA', tierNames: ['Dung tích'], cover: expectedCoverSha, gallery: [expectedGallerySha] },
    imageRoles: { cover: 'bia.png', gallery: ['gallery.png'], variants: [null, null] } });
  expect(mapping.mapping.variants.map((row: any) => [row.optionLabels, row.sku, row.originalPrice])).toEqual([
    [['500ml'], 'ACCEPT-500', '13000'], [['100ml'], 'ACCEPT-100', '11000'],
  ]);
  expect(mapping.mapping.description.filter((part: any) => part.type === 'image').map((part: any) => part.sha256)).toEqual([expectedGallerySha]);
  expect(mapping.sourceHashes.map((row: any) => [row.kind, row.sha256]).sort()).toEqual([
    ['image', expectedCoverSha], ['image', expectedGallerySha],
    ['xlsx', createHash('sha256').update(priceBytes).digest('hex')], ['xlsx', createHash('sha256').update(contentBytes).digest('hex')],
  ].sort());
  const mappingConfirmation = page.waitForResponse(reply => new URL(reply.url()).pathname === `/v1/products/${edited.productKey}/confirm-mapping`);
  const confirmedMappingReply = page.waitForResponse(reply => new URL(reply.url()).pathname === `/v1/products/${edited.productKey}/mapping-review`);
  await page.getByRole('button', { name: 'Tôi đã đối chiếu và xác nhận đúng ánh xạ này', exact: true }).click();
  const mappingConfirmationReply = await mappingConfirmation;
  expect(mappingConfirmationReply.status()).toBe(201);
  const confirmedDraft = await mappingConfirmationReply.json(), confirmedRevision = confirmedDraft.revision;
  expect(confirmedRevision).toBe(edited.revision + 1);
  expect(confirmedDraft.folderSource).toEqual(edited.folderSource);
  expect(confirmedDraft.sourceSelection.folderBinding).toEqual(edited.sourceSelection.folderBinding);
  expect(confirmedDraft.sourceSelection.mappingConfirmation).toMatchObject({ reviewedRevision: edited.revision,
    confirmedRevision, sourceHashes: mapping.sourceHashes, decisionFingerprint: mapping.fingerprint });
  expect(confirmedDraft.variants.map((variant: any) => [variant.sku.value, variant.originalPrice.value])).toEqual([['ACCEPT-500', '13000'], ['ACCEPT-100', '11000']]);
  expect(await (await confirmedMappingReply).json()).toMatchObject({ revision: confirmedRevision,
    requiresConfirmation: false, approvalBasis: 'current_decision', sourceHashes: mapping.sourceHashes });
  const priceReviewReply = page.waitForResponse(reply => new URL(reply.url()).pathname === `/v1/products/${edited.productKey}/price-mapping-review`);
  await page.getByRole('button', { name: 'Xem bảng đối chiếu SKU và giá', exact: true }).click();
  const priceReview = await (await priceReviewReply).json();
  expect(priceReview).toMatchObject({ productKey: edited.productKey, revision: confirmedRevision, confirmed: false, issues: [] });
  expect(priceReview.rows.map((row: any) => [row.optionLabels, row.sku, row.originalPrice, row.sourceFilename, row.sheetName, row.skuCell, row.priceCell])).toEqual([
    [['500ml'], 'ACCEPT-500', '13000', 'Gia-goc.xlsx', 'Giá gốc', 'A4', 'C4'],
    [['100ml'], 'ACCEPT-100', '11000', 'Gia-goc.xlsx', 'Giá gốc', 'A2', 'C2'],
  ]);
  const priceConfirmation = page.waitForResponse(reply => new URL(reply.url()).pathname === `/v1/products/${edited.productKey}/confirm-price-mapping`);
  await page.getByRole('button', { name: 'Tôi đã đối chiếu từng phân loại, SKU và giá nguồn', exact: true }).click();
  expect((await priceConfirmation).status()).toBe(201);
  await expect(page.getByText('Đã xác nhận cho đúng phiên bản listing này.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Kiểm tra listing', exact: true })).toBeVisible();
  const storedPriceReview = page.waitForResponse(reply => new URL(reply.url()).pathname === `/v1/products/${edited.productKey}/price-mapping-review`);
  await page.getByRole('button', { name: 'Xem bảng đối chiếu SKU và giá', exact: true }).click();
  expect(await (await storedPriceReview).json()).toMatchObject({ revision: confirmedRevision, confirmed: true, fingerprint: priceReview.fingerprint });
  await openWorkspaceTool(page, 'Đăng hàng');
  await expect(page.getByLabel('Đăng vào shop', { exact: true })).toHaveValue(`${fixture.scope.partnerId}:${fixture.scope.shopId}`);
  await page.getByRole('tab', { name: 'Chuẩn bị lô mới', exact: true }).click();
  await configurePreparation();
  await preparation.getByRole('button', { name: 'Kiểm tra 1 listing đã chọn', exact: true }).click();
  await expect(preparation.getByRole('region', { name: 'Kết quả kiểm tra nguồn', exact: true })).toContainText('1 listing đủ nguồn · 0 cần bổ sung');
  await preparation.getByRole('button', { name: 'Chuẩn bị đợt cho 1 listing đủ nguồn', exact: true }).click();
  await preparation.getByRole('button', { name: 'Đăng ẩn các listing đã chuẩn bị', exact: true }).click();
  await page.reload();
  await page.getByRole('tab', { name: 'Đợt đang làm', exact: true }).click();
  await expect(page.getByText('Xịt mũ bảo hiểm QA', { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await snapshot()).deferredImageReceipts.length, { timeout: 70000 }).toBe(1);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Đợt đăng mới', exact: true })).toContainText('Shop đích: ' + fixture.profile.name);
  await expect(page.getByText('Đã tạo ẩn · Ảnh chưa QC', { exact: true }).first()).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất báo cáo Excel', exact: true }).click();
  const download = await downloadEvent, downloadedPath = await download.path();
  expect(download.suggestedFilename()).toContain(fixture.scope.shopId);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await readFile(downloadedPath!) as any);
  expect(book.worksheets.map(sheet => sheet.name)).toEqual(['Tong quan', 'San pham']);
  expect(book.getWorksheet('San pham')!.getCell('J2').value).toBe(2);
  expect(book.getWorksheet('Tong quan')!.getCell('B2').text).toContain(fixture.scope.shopId);
  expect(book.getWorksheet('Tong quan')!.getCell('B2').text).toContain(fixture.profile.name);
  const report = JSON.stringify(book.getWorksheet('San pham')!.getSheetValues());
  expect(report).toContain('Xịt mũ bảo hiểm QA'); expect(report).toContain('Ảnh chưa QC');
  const final = await snapshot(), mutations = final.fixtureCalls.filter((call: any) => call.method === 'POST');
  expect(mutations.filter((call: any) => call.path.endsWith('/add_item'))).toHaveLength(1);
  expect(mutations.filter((call: any) => call.path.endsWith('/init_tier_variation'))).toHaveLength(1);
  expect(mutations.some((call: any) => call.path.endsWith('/unlist_item'))).toBe(false);
  expect(requests.filter(path => /\/production-preparations\/[^/]+\/run$/.test(path))).toHaveLength(1);
  const executed = final.operations.find((op: any) => op.source_identity === saved.products[0].productKey);
  expect(executed.state).toBe('acknowledged');
  expect(final.deferredImageReceipts[0]).toMatchObject({ operation_id: executed.id, basis: 'image_qc_deferred_by_operator' });
  expect(final.deferredImageReceipts[0].readbacks).toHaveLength(2);
  expect(executed.source_revision).toBe(confirmedRevision);
  expect(executed.source_payload.document.models.map((model: any) => model.sku)).toEqual(['ACCEPT-500', 'ACCEPT-100']);
  expect(executed.source_payload.document.models.map((model: any) => model.originalPrice)).toEqual(['13000', '11000']);
  expect(executed.source_payload.document.models.map((model: any) => model.stock)).toEqual([100, 100]);
  expect(executed.source_payload.document.description.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')).toContain('Nội dung nguyên văn QA');
  expect(final.fixtureItems.find((item: any) => item.itemId === executed.item_id || String(item.base.item_id) === executed.item_id)?.base.item_status).toBe('UNLIST');
  expect(final.products).toHaveLength(1); expect(final.errors).toEqual([]); expect(outside).toEqual([]);
  await download.saveAs(resolve(evidenceRoot, 'hidden-qc-report.xlsx'));
  await page.screenshot({ path: resolve(evidenceRoot, 'hidden-job-report.png'), fullPage: true });
  await writeFile(resolve(evidenceRoot, 'ui-evidence.json'), JSON.stringify({ requests, outside, products: final.products.length,
    realUIAPIWorkerPG: true, realPreparationRegistryParentChildJournal: true, externalPlatformFixtureOnly: true,
    preconnectedExistingShop: fixture, operationId: executed.id, sourceRevision: executed.source_revision,
    createCount: 1, initializationCount: 1, finalStatus: 'UNLIST', imageQc: 'pending', refreshResendCount: 0,
    reportDownloaded: true, actualShopeeRequests: 0 }, null, 2));
});
