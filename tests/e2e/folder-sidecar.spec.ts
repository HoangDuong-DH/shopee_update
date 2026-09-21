import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { readWord, type InputBatchRecord } from '@shopee/domain';
import { openInputLibrary, openWorkspaceTool } from './workspace-navigation.js';
import { folderSourceIdentity } from '../../packages/domain/src/folder-source-identity.js';

// Real local files, including the JSON sidecar, are read by the production browser reader.
// Every API route is intercepted. No request reaches the application DB or Shopee.
async function fixture(page: Page, info: TestInfo, existing: boolean, portable = false) {
  const directory = info.outputPath('Cam Sa'),
    priceId = randomUUID(),
    stamp = '2026-09-16T00:00:00.000Z';
  const h = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const word = zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Cam Sả kiểm thử</w:t></w:r></w:p><w:p><w:r><w:t>Mở đầu đã chuẩn bị</w:t></w:r></w:p><w:p><w:r><w:t>Nội dung giữ nguyên</w:t></w:r></w:p></w:body></w:document>',
    ),
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg1sAAAAASUVORK5CYII=',
    'base64',
  );
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'content.docx'), word);
  await writeFile(resolve(directory, 'cover.png'), png);
  await writeFile(resolve(directory, 'g.png'), png);
  const source = {
    kind: 'product_file',
    fileSha256: 'b'.repeat(64),
    filename: 'Giá.xlsx',
    locator: 'Giá',
    observedAt: stamp,
  };
  const fact = (value: string) => ({ value, confirmed: true, sources: [source] });
  const skus = ['VTTDCS300', 'VTTDCS100', 'VTTDCS500'],
    options = ['300ml', '100ml', '500ml'];
  const rows = skus.map((sku, i) => ({
    key: 'row-' + sku,
    sheet: 'Giá',
    row: i + 2,
    headerRow: 1,
    priceProfile: 'SHOP MALL',
    sku: fact(sku),
    name: fact('Cam Sả ' + options[i]),
    originalPrice: fact(String([235998, 119998, 331998][i])),
    issues: [],
  }));
  const price = {
    id: priceId,
    filename: 'Giá.xlsx',
    sha256: source.fileSha256,
    bytes: 100,
    kind: 'xlsx',
    status: 'ready',
    createdAt: stamp,
    body: {
      source,
      rows,
      sheets: [{ name: 'Giá', rowCount: 4, importedRows: 3, headerRows: [1] }],
      issues: [],
    },
  };
  const imageId = randomUUID(),
    wordId = randomUUID();
  const image = {
    id: imageId,
    filename: 'cover.png',
    sha256: h(png),
    bytes: png.length,
    kind: 'image',
    status: 'ready',
    createdAt: stamp,
    body: {
      key: imageId,
      sha256: h(png),
      bytes: png.length,
      mime: 'image/png',
      width: 1,
      height: 1,
      source: { ...source, fileSha256: h(png) },
    },
  };
  const wordRecord = {
    id: wordId,
    filename: 'content.docx',
    sha256: h(word),
    bytes: word.length,
    kind: 'docx',
    status: 'ready',
    createdAt: stamp,
    body: await readWord(word, 'content.docx'),
  };
  const manifest = {
    format: 'listing-source',
    version: 1,
    product: { productKey: 'cam-sa-saved', sourceRevision: existing && !portable ? 1 : 0 },
    sourceListingId: {
      value: null,
      source: { fileSha256: source.fileSha256, locator: 'Catalog!C85' },
    },
    word: {
      path: 'content.docx',
      sha256: h(word),
      title: { start: 1, end: 1 },
      headline: { start: 2, end: 2 },
      body: { start: 3, end: 3 },
      paragraphSeparator: '\n',
    },
    priceSource: { sha256: source.fileSha256, sheet: 'Giá', priceProfile: 'SHOP MALL' },
    media: {
      cover: { path: 'cover.png', sha256: h(png) },
      gallery: [{ path: 'g.png', sha256: h(png) }],
      description: [],
    },
    tierNames: ['Phân loại 1'],
    variants: skus.map((sku, i) => ({ sku, optionLabels: [options[i]], rowKey: rows[i].key })),
  };
  await writeFile(resolve(directory, 'listing-source.json'), JSON.stringify(manifest, null, 2));
  const saved: any = {
    sourceListingId: { value: null, confirmed: true, sources: [source] },
    productKey: 'cam-sa-saved',
    revision: 1,
    title: fact('Cam Sả kiểm thử'),
    description: [
      { type: 'text', text: 'Mở đầu đã chuẩn bị\n\n' },
      { type: 'text', text: '\n\nNội dung giữ nguyên' },
    ],
    coverKey: imageId,
    galleryKeys: [imageId],
    tierNames: ['Phân loại 1'],
    variants: rows.map((r, i) => ({
      key: r.key,
      sku: r.sku,
      optionLabels: [options[i]],
      originalPrice: r.originalPrice,
    })),
    assets: [image.body],
    attributes: {},
    logistics: {},
    issues: [],
    sourceSelection: {
      title: 'Cam Sả kiểm thử',
      headline: 'Mở đầu đã chuẩn bị',
      body: 'Nội dung giữ nguyên',
      coverId: imageId,
      galleryIds: [imageId],
      descriptionImageIds: [],
      tierNames: ['Phân loại 1'],
      variants: rows.map((r, i) => ({
        importId: priceId,
        rowKey: r.key,
        optionLabels: [options[i]],
      })),
    },
  };
  if (portable)
    saved.folderSource = {
      productKey: manifest.product.productKey,
      fingerprint: h(
        Buffer.from(JSON.stringify(folderSourceIdentity(manifest as any, 'SHOP MALL'))),
      ),
    };
  const imports = new Map<string, any>([[priceId, price]]),
    batches = new Map<string, InputBatchRecord>(),
    unexpected: string[] = [],
    uploads: string[] = [],
    productWrites: any[] = [];
  const imageUploads = new Map<string, any>([[h(png), image]]);
  async function addImage(name: string, marker: number) {
    const bytes = Buffer.concat([png, Buffer.from([marker])]);
    const id = randomUUID(),
      sha256 = h(bytes);
    const record = {
      ...image,
      id,
      filename: name,
      sha256,
      bytes: bytes.length,
      body: {
        ...image.body,
        key: id,
        sha256,
        bytes: bytes.length,
        source: { ...image.body.source, fileSha256: sha256 },
      },
    };
    await writeFile(resolve(directory, name), bytes);
    imageUploads.set(sha256, record);
    return { path: name, sha256, id };
  }
  await page.route('**/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (req.method() === 'POST' && path === '/v1/imports') {
      const hash = h(req.postDataBuffer()!),
        record = hash === h(word) ? wordRecord : imageUploads.get(hash);
      if (!record) {
        unexpected.push('Unknown upload');
        return route.fulfill({ status: 400, json: { code: 'INVALID_INPUT' } });
      }
      uploads.push(record.kind);
      imports.set(record.id, record);
      return route.fulfill({ json: record });
    }
    if (req.method() === 'POST' && path === '/v1/input-batches') {
      const body = req.postDataJSON(),
        before = batches.get(body.id);
      const record = {
        id: body.id,
        revision: (before?.revision ?? 0) + 1,
        state: body.state,
        createdAt: stamp,
        updatedAt: stamp,
      };
      batches.set(body.id, record);
      return route.fulfill({ json: record });
    }
    if (req.method() === 'POST' && path === '/v1/products') {
      productWrites.push(req.postDataJSON());
      return route.fulfill({ json: saved });
    }
    if (req.method() !== 'GET') {
      unexpected.push(req.method() + ' ' + path);
      return route.fulfill({ status: 503, json: { code: 'BLOCKED_FIXTURE' } });
    }
    if (path === '/v1/imports') return route.fulfill({ json: [...imports.values()] });
    if (path.startsWith('/v1/imports/'))
      return route.fulfill({ json: imports.get(path.split('/').at(-1)!) ?? {} });
    if (path === '/v1/products') return route.fulfill({ json: existing ? [saved] : [] });
    if (path.startsWith('/v1/products/')) return route.fulfill({ json: saved });
    if (['/v1/plans', '/v1/jobs', '/v1/shops'].includes(path)) return route.fulfill({ json: [] });
    if (path === '/v1/status')
      return route.fulfill({ json: { worker: 'online', productionWrites: false } });
    if (path.startsWith('/v1/media/'))
      return route.fulfill({ contentType: 'image/png', body: png });
    if (path === '/v1/input-library')
      return route.fulfill({
        json: {
          priceBooks: [{ ...price, rowCount: 3, sheetCount: 1, issueCount: 0 }],
          batches: [...batches.values()].map((b) => ({
            id: b.id,
            revision: b.revision,
            name: b.state.name,
            updatedAt: stamp,
            folderCount: 1,
            fileCount: 4,
            completedCount: 0,
            priceSelection: b.state.priceSelection,
          })),
          unassigned: [],
        },
      });
    if (path.startsWith('/v1/input-batches/')) {
      const b = batches.get(path.split('/').at(-1)!);
      return route.fulfill({ json: { ...b, imports: [...imports.values()] } });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return { directory, batches, unexpected, uploads, manifest, productWrites, price, addImage };
}
async function enter(page: Page, directory: string) {
  await page.goto('/');
  await openWorkspaceTool(page, 'Listing của tôi');
  await page.getByRole('button', { name: 'Nhập listing có sẵn', exact: true }).click();
  await page.getByLabel('Chọn thư mục listing', { exact: true }).setInputFiles(directory);
  await page.getByRole('button', { name: 'Đọc các thư mục', exact: true }).click();
}
test('sidecar: 3 prepared SKUs and order survive reload without manual entry or product writes', async ({
  page,
}, info) => {
  const f = await fixture(page, info, false);
  await enter(page, f.directory);
  const candidate = page.getByTestId('folder-candidate');
  await expect(candidate.getByText(/Đã đọc hồ sơ đi kèm: 3 SKU/)).toBeVisible();
  await candidate.getByRole('tab', { name: 'SKU & giá', exact: true }).click();
  await expect(candidate.locator('tbody tr')).toHaveCount(3);
  await expect(candidate.locator('tbody tr').nth(0)).toContainText('VTTDCS300');
  await expect(candidate.locator('tbody tr').nth(1)).toContainText('VTTDCS100');
  await expect(
    candidate.getByRole('button', { name: 'Xem & hoàn thiện', exact: true }),
  ).toBeEnabled();
  await expect.poll(() => [...f.batches.values()][0]?.state.manifests !== undefined).toBe(true);
  const count = f.uploads.length;
  await page.reload();
  await openInputLibrary(page);
  await page
    .getByTestId('input-batch-row')
    .getByRole('button', { name: 'Tiếp tục xử lý', exact: true })
    .click();
  await page
    .getByTestId('folder-candidate')
    .getByRole('tab', { name: 'SKU & giá', exact: true })
    .click();
  await expect(page.getByTestId('folder-candidate').locator('tbody tr').nth(0)).toContainText(
    'VTTDCS300',
  );
  expect(f.uploads.length).toBe(count);
  expect(f.unexpected).toEqual([]);
});
test('sidecar: matching saved source reopens without creating another draft', async ({
  page,
}, info) => {
  const f = await fixture(page, info, true);
  await enter(page, f.directory);
  const button = page
    .getByTestId('folder-candidate')
    .getByRole('button', { name: 'Mở bộ đã lưu', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('heading', { name: 'Cam Sả kiểm thử', exact: true })).toBeVisible();
  expect(f.unexpected).toEqual([]);
});

test('sidecar: deferred price profile stays unselected until the operator chooses', async ({
  page,
}, info) => {
  const f = await fixture(page, info, false);
  const manifest = {
    ...f.manifest,
    priceSource: {
      ...f.manifest.priceSource,
      priceProfile: null,
      selectionMode: 'operator_choice',
    },
  };
  await writeFile(resolve(f.directory, 'listing-source.json'), JSON.stringify(manifest));
  await enter(page, f.directory);
  await expect(page.getByText('Chưa chọn bộ giá', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Bảng giá & tệp nguồn', exact: true }).click();
  const choice = page.getByRole('combobox', { name: 'Bộ giá áp dụng' });
  await expect(choice).toHaveValue('');
  await choice.selectOption(JSON.stringify('SHOP MALL'));
  const candidate = page.getByTestId('folder-candidate');
  await candidate.getByRole('tab', { name: 'SKU & giá', exact: true }).click();
  await expect(candidate.locator('tbody tr')).toHaveCount(3);
  await expect(
    candidate.getByRole('button', { name: 'Xem & hoàn thiện', exact: true }),
  ).toBeEnabled();
  expect(f.unexpected).toEqual([]);
});

test('sidecar: a new intake reopens an identical portable source without product writes', async ({
  page,
}, info) => {
  const f = await fixture(page, info, true, true);
  await enter(page, f.directory);
  const button = page
    .getByTestId('folder-candidate')
    .getByRole('button', { name: 'Mở bộ đã lưu', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('heading', { name: 'Cam Sả kiểm thử', exact: true })).toBeVisible();
  expect(f.productWrites).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

test('sidecar: first save binds the portable identity to the exact saved intake revision', async ({
  page,
}, info) => {
  const f = await fixture(page, info, false);
  await enter(page, f.directory);
  const button = page
    .getByTestId('folder-candidate')
    .getByRole('button', { name: 'Xem & hoàn thiện', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await page.getByLabel(/Bố trí mô tả/).selectOption('headline-images-body');
  await page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first().click();
  await expect.poll(() => f.productWrites.length).toBe(1);
  const batch = [...f.batches.values()][0];
  expect(f.productWrites[0]).toMatchObject({
    productKey: 'cam-sa-saved',
    expectedRevision: 0,
    folderBinding: { batchId: batch.id, revision: batch.revision, groupKey: 'Cam Sa' },
  });
  expect(f.unexpected).toEqual([]);
});

test('pending table: preserves missing slots through reload, requires real SKUs and binds the explicitly chosen price profile', async ({
  page,
}, info) => {
  const f = await fixture(page, info, false);
  const doc = {
    schemaVersion: 'listing-mapping-pending/v1',
    sourceKey: 'pending-cam-sa',
    product: { productKey: 'portable-cam-sa-pending', sourceRevision: 0 },
    sourceWorkbookSha256: 'b'.repeat(64),
    title: 'Cam Sả kiểm thử',
    sourceListingId: null,
    sourceListingIdCell: 'Catalog!C85',
    rawVariationText: '300ml, 100ml, 500ml',
    tiers: [{ ordinal: 1, literalHeading: 'Phân loại 1', options: ['300ml', '100ml', '500ml'] }],
    slots: f.manifest.variants.map((v, i) => ({
      slotId: 'slot-' + i,
      optionPositions: [i],
      optionLabels: v.optionLabels,
      sku: i === 1 ? null : v.sku,
      membershipConfirmed: false,
      sourceCell: 'Catalog!F85',
      status: i === 1 ? 'CHƯA CÓ SKU' : 'source',
      issues: [],
    })),
    issues: [],
  };
  await unlink(resolve(f.directory, 'listing-source.json'));
  await writeFile(resolve(f.directory, 'listing-mapping.pending.json'), JSON.stringify(doc));
  f.price.body.rows.push(
    ...f.price.body.rows.map((r) => ({
      ...r,
      key: r.key + '-regular',
      priceProfile: 'SHOP THƯỜNG',
      originalPrice: { ...r.originalPrice, value: '99999' },
    })),
  );
  await enter(page, f.directory);
  const pendingStatus = page.getByRole('region', { name: 'Trạng thái phân loại đã nhập' });
  await expect(pendingStatus).toContainText('Đã đọc 3 phân loại');
  await expect(pendingStatus).toContainText('Còn 1 phân loại chưa có SKU');
  await expect(
    page.getByTestId('folder-candidate').getByText(/Chưa có nguồn xác định đầy đủ SKU/),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Bảng giá & tệp nguồn', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Bảng giá chung', exact: true })
    .selectOption(f.price.id);
  await page.getByRole('combobox', { name: 'Sheet chứa giá' }).selectOption('Giá');
  await page
    .getByRole('combobox', { name: 'Bộ giá áp dụng' })
    .selectOption(JSON.stringify('SHOP MALL'));
  await page
    .getByTestId('folder-candidate')
    .getByRole('tab', { name: 'SKU & giá', exact: true })
    .click();
  let table = page.getByRole('region', { name: 'Bảng phân loại chờ hoàn thiện' });
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.getByRole('textbox', { name: 'SKU 100ml', exact: true })).toHaveValue('');
  await table.getByRole('checkbox', { name: 'Dùng đủ 3 phân loại trong bảng này' }).check();
  await expect(table.getByRole('button', { name: 'Xem và hoàn thiện nội dung' })).toBeDisabled();
  await table.getByRole('textbox', { name: 'SKU 100ml', exact: true }).fill('CHƯA CÓ SKU');
  await expect
    .poll(() => [...f.batches.values()][0]?.state.pendingMappings?.['Cam Sa']?.skuEdits['slot-1'])
    .toBe('CHƯA CÓ SKU');
  await page.reload();
  await openInputLibrary(page);
  await page
    .getByTestId('input-batch-row')
    .getByRole('button', { name: 'Tiếp tục xử lý', exact: true })
    .click();
  await page
    .getByTestId('folder-candidate')
    .getByRole('tab', { name: 'SKU & giá', exact: true })
    .click();
  table = page.getByRole('region', { name: 'Bảng phân loại chờ hoàn thiện' });
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.getByRole('textbox', { name: 'SKU 100ml', exact: true })).toHaveValue(
    'CHƯA CÓ SKU',
  );
  await expect(table.getByRole('button', { name: 'Xem và hoàn thiện nội dung' })).toBeDisabled();
  await table.getByRole('textbox', { name: 'SKU 100ml', exact: true }).fill('VTTDCS100');
  await page.getByRole('button', { name: 'Bảng giá & tệp nguồn', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Bộ giá áp dụng' })
    .selectOption(JSON.stringify('SHOP THƯỜNG'));
  const next = table.getByRole('button', { name: 'Xem và hoàn thiện nội dung' });
  await expect(next).toBeEnabled();
  expect(f.productWrites).toEqual([]);
  const batch = [...f.batches.values()][0];
  expect(batch.state.pendingMappings?.['Cam Sa'].document.slots[1].sku).toBeNull();
  expect(batch.state.pendingMappings?.['Cam Sa'].skuEdits['slot-1']).toBe('VTTDCS100');
  await next.click();
  await page.getByLabel('Bố trí mô tả trong bộ nguồn').selectOption('headline-images-body');
  await page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first().click();
  await expect.poll(() => f.productWrites.length).toBe(1);
  const payload = f.productWrites[0],
    savedBatch = [...f.batches.values()][0];
  expect(payload).toMatchObject({
    productKey: doc.product.productKey,
    title: doc.title,
    sourceListingId: null,
    folderBinding: { batchId: savedBatch.id, revision: savedBatch.revision, groupKey: 'Cam Sa' },
  });
  expect(payload.variants.map((v: any) => [v.rowKey, ...v.optionLabels])).toEqual([
    ['row-VTTDCS300-regular', '300ml'],
    ['row-VTTDCS100-regular', '100ml'],
    ['row-VTTDCS500-regular', '500ml'],
  ]);
  expect(f.unexpected).toEqual([]);
});

test('pending table: loaded complete SKU source is visible before opening the table and still requires confirmation', async ({
  page,
}, info) => {
  const f = await fixture(page, info, false);
  const labels = ['Bạc Hà', 'Oải Hương', 'Sả Java', 'Vỏ Quế', 'Không Mùi', 'Sả Chanh'];
  const skus = ['VTBHLS1000', 'VTOHLS1000', 'VTSJLS1000', 'VTVQLS1000', 'VTKMLS1000', 'VTSCLS1000'];
  const sourceRow = f.price.body.rows[0];
  f.price.body.rows.splice(
    0,
    f.price.body.rows.length,
    ...skus.map((sku, i) => ({
      ...sourceRow,
      key: 'row-' + sku,
      row: i + 2,
      sku: { ...sourceRow.sku, value: sku },
      name: { ...sourceRow.name, value: 'Nước lau sàn ' + labels[i] + ' 1L' },
      originalPrice: { ...sourceRow.originalPrice, value: '311998' },
    })),
  );
  f.price.body.sheets[0].rowCount = 7;
  f.price.body.sheets[0].importedRows = 6;
  const imageOrder = [2, 1, 5, 6, 3, 4];
  const variationImages = await Promise.all(
    imageOrder.map((ordinal) => f.addImage(`phan-loai-${ordinal}.png`, ordinal)),
  );
  const doc = {
    schemaVersion: 'listing-mapping-pending/v1',
    sourceKey: 'pending-floor-cleaner-six',
    product: { productKey: 'pending-floor-cleaner-six', sourceRevision: 0 },
    sourceWorkbookSha256: 'b'.repeat(64),
    title: 'Nước lau sàn sáu mùi kiểm thử',
    sourceListingId: null,
    sourceListingIdCell: 'Catalog!C176',
    rawVariationText: 'Phân loại 1: Bạc Hà · Oải Hương · Sả Java · Vỏ Quế · Không Mùi · Sả Chanh',
    tiers: [{ ordinal: 1, literalHeading: 'Phân loại 1', options: labels }],
    slots: labels.map((label, i) => ({
      slotId: 'floor-slot-' + i,
      optionPositions: [i],
      optionLabels: [label],
      sku: skus[i],
      membershipConfirmed: false,
      sourceCell: 'Catalog!F176',
      status: 'ĐÃ KHỚP SKU NGUỒN',
      variationImageCandidates: [
        {
          path: variationImages[i].path,
          sha256: variationImages[i].sha256,
          role: 'variation',
          familyMatchesSource: true,
        },
      ],
      issues: [],
    })),
    issues: [],
  };
  await unlink(resolve(f.directory, 'listing-source.json'));
  await writeFile(resolve(f.directory, 'listing-mapping.pending.json'), JSON.stringify(doc));
  await enter(page, f.directory);
  const candidate = page.getByTestId('folder-candidate');
  await expect
    .poll(
      () => [...f.batches.values()][0]?.state.pendingMappings?.['Cam Sa']?.document.slots.length,
    )
    .toBe(6);
  await expect(candidate.getByText(/Chưa có nguồn xác định đầy đủ SKU/)).toHaveCount(0);
  const status = candidate.getByRole('region', { name: 'Trạng thái phân loại đã nhập' });
  await expect(status).toContainText('Đã đọc 6 phân loại');
  await expect(status).toContainText('Đã có mã SKU cho mọi phân loại');
  await candidate.getByRole('button', { name: 'Xem bảng phân loại', exact: true }).click();
  await expect(candidate.getByRole('tab', { name: 'SKU & giá', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const table = candidate.getByRole('region', { name: 'Bảng phân loại chờ hoàn thiện' });
  await expect(table.locator('tbody tr')).toHaveCount(6);
  for (let i = 0; i < labels.length; i++)
    await expect(table.getByRole('textbox', { name: 'SKU ' + labels[i], exact: true })).toHaveValue(
      skus[i],
    );
  await expect(candidate.getByText(/Ảnh trong thư mục chưa xác định được mã SKU/)).toHaveCount(0);
  const confirm = table.getByRole('checkbox', {
    name: 'Dùng đủ 6 phân loại trong bảng này',
    exact: true,
  });
  await expect(confirm).not.toBeChecked();
  const next = table.getByRole('button', { name: 'Xem và hoàn thiện nội dung', exact: true });
  await expect(next).toBeDisabled();
  await page.getByRole('button', { name: 'Bảng giá & tệp nguồn', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Bảng giá chung', exact: true })
    .selectOption(f.price.id);
  await page.getByRole('combobox', { name: 'Sheet chứa giá' }).selectOption('Giá');
  await page
    .getByRole('combobox', { name: 'Bộ giá áp dụng' })
    .selectOption(JSON.stringify('SHOP MALL'));
  await expect(next).toBeDisabled();
  await expect(confirm).not.toBeChecked();
  await table
    .getByRole('button', { name: 'Dùng ảnh đã khớp cho 6 phân loại', exact: true })
    .click();
  await expect(table.getByRole('region', { name: 'Ảnh phân loại từ hồ sơ' })).toContainText(
    'Đã gắn 6/6',
  );
  await expect(confirm).not.toBeChecked();
  await expect
    .poll(
      () =>
        Object.keys(
          [...f.batches.values()][0]?.state.pendingMappings?.['Cam Sa']?.imageSelections ?? {},
        ).length,
    )
    .toBe(6);
  expect(f.productWrites).toEqual([]);
  await page.reload();
  await openInputLibrary(page);
  await page
    .getByTestId('input-batch-row')
    .getByRole('button', { name: 'Tiếp tục xử lý', exact: true })
    .click();
  await page
    .getByTestId('folder-candidate')
    .getByRole('tab', { name: 'SKU & giá', exact: true })
    .click();
  for (let i = 0; i < labels.length; i++)
    await expect(
      table.getByRole('combobox', { name: 'Ảnh phân loại ' + labels[i], exact: true }),
    ).toHaveValue(variationImages[i].path);
  await expect(confirm).not.toBeChecked();
  await confirm.check();
  await expect(next).toBeEnabled();
  expect(f.productWrites).toEqual([]);
  await next.click();
  await page.getByLabel('Bố trí mô tả trong bộ nguồn').selectOption('headline-images-body');
  await page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first().click();
  await expect.poll(() => f.productWrites.length).toBe(1);
  expect(f.productWrites[0].variants.map((v: any) => [v.rowKey, v.imageId])).toEqual(
    skus.map((sku, i) => ['row-' + sku, variationImages[i].id]),
  );
  expect(f.unexpected).toEqual([]);
});

test('pending images: multiple designs stay unselected until a whole template is chosen; one source image can serve three sizes', async ({
  page,
}, info) => {
  const f = await fixture(page, info, false);
  const images = await Promise.all([
    f.addImage('C01-shared.png', 21),
    f.addImage('C02-shared.png', 22),
  ]);
  const skus = ['VTTDCS300', 'VTTDCS100', 'VTTDCS500'],
    labels = ['300ml', '100ml', '500ml'];
  const doc = {
    schemaVersion: 'listing-mapping-pending/v1',
    sourceKey: 'shared-three-sizes',
    product: { productKey: 'shared-three-sizes', sourceRevision: 0 },
    sourceWorkbookSha256: 'b'.repeat(64),
    title: 'Cam Sả ba dung tích kiểm thử',
    sourceListingId: null,
    sourceListingIdCell: 'Catalog!C85',
    rawVariationText: '300ml / 100ml / 500ml',
    tiers: [{ ordinal: 1, literalHeading: 'Dung tích', options: labels }],
    slots: labels.map((label, i) => ({
      slotId: 'slot-' + i,
      optionPositions: [i],
      optionLabels: [label],
      sku: skus[i],
      membershipConfirmed: false,
      sourceCell: 'Catalog!F85',
      status: 'ĐÃ KHỚP',
      issues: [],
      variationImageCandidates: images.map((image, j) => ({
        path: image.path,
        sha256: image.sha256,
        role: 'variation',
        familyMatchesSource: true,
        designId: 'C0' + (j + 1),
      })),
    })),
    issues: [],
  };
  await unlink(resolve(f.directory, 'listing-source.json'));
  await writeFile(resolve(f.directory, 'listing-mapping.pending.json'), JSON.stringify(doc));
  await enter(page, f.directory);
  await page
    .getByTestId('folder-candidate')
    .getByRole('button', { name: 'Xem bảng phân loại', exact: true })
    .click();
  const table = page.getByRole('region', { name: 'Bảng phân loại chờ hoàn thiện' });
  await expect(table.getByRole('button', { name: 'Dùng ảnh đã khớp', exact: true })).toBeDisabled();
  await expect(table.getByRole('region', { name: 'Ảnh phân loại từ hồ sơ' })).toContainText(
    'Đã gắn 0/3',
  );
  await table.getByRole('combobox', { name: 'Bộ thiết kế dùng để điền ảnh' }).selectOption('C02');
  await table
    .getByRole('button', { name: 'Dùng ảnh đã khớp cho 3 phân loại', exact: true })
    .click();
  await expect(table.getByRole('region', { name: 'Ảnh phân loại từ hồ sơ' })).toContainText(
    'Đã gắn 3/3',
  );
  await expect(
    table.getByRole('checkbox', { name: 'Dùng đủ 3 phân loại trong bảng này' }),
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'Bảng giá & tệp nguồn', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Bảng giá chung', exact: true })
    .selectOption(f.price.id);
  await page.getByRole('combobox', { name: 'Sheet chứa giá' }).selectOption('Giá');
  await page
    .getByRole('combobox', { name: 'Bộ giá áp dụng' })
    .selectOption(JSON.stringify('SHOP MALL'));
  await table.getByRole('checkbox', { name: 'Dùng đủ 3 phân loại trong bảng này' }).check();
  const next = table.getByRole('button', { name: 'Xem và hoàn thiện nội dung', exact: true });
  await expect(next).toBeEnabled();
  expect(f.productWrites).toEqual([]);
  await next.click();
  await page.getByLabel('Bố trí mô tả trong bộ nguồn').selectOption('headline-images-body');
  await page.getByRole('button', { name: 'Lưu & xem trước', exact: true }).first().click();
  await expect.poll(() => f.productWrites.length).toBe(1);
  expect(f.productWrites[0].variants.map((v: any) => [v.rowKey, v.imageId])).toEqual(
    skus.map((sku) => ['row-' + sku, images[1].id]),
  );
  expect(f.unexpected).toEqual([]);
});
