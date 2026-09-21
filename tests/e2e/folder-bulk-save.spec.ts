import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { openInputLibrary } from './workspace-navigation.js';

test('save ready folder batch, recover a lost reply after reload, and never duplicate or publish', async ({ page }) => {
  const stamp = '2026-09-17T00:00:00Z', batchId = randomUUID(), priceId = randomUUID(), imageId = randomUUID();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const source = { kind: 'product_file', fileSha256: hash('price'), filename: 'DORIS.xlsx', locator: 'Giá', observedAt: stamp };
  const fact = (value: string) => ({ value, confirmed: true, sources: [source] });
  const image = { id: imageId, filename: 'anh-bia.png', sha256: hash('image'), bytes: 100, kind: 'image', status: 'ready', createdAt: stamp,
    body: { key: imageId, sha256: hash('image'), bytes: 100, mime: 'image/png', width: 300, height: 300, source } };
  const rows = ['Cam Sả', 'Hoa Lài'].map((name, index) => ({ key: 'row-' + index, sheet: 'Giá', row: index + 2, headerRow: 1,
    priceProfile: 'SHOP MALL', sku: fact('SKU-' + index), name: fact(name + ' 100ml'), originalPrice: fact('100000'), issues: [] }));
  const price = { id: priceId, filename: 'DORIS.xlsx', sha256: source.fileSha256, bytes: 100, kind: 'xlsx', status: 'ready', createdAt: stamp,
    body: { source, rows, sheets: [{ name: 'Giá', rowCount: 3, importedRows: 2, headerRows: [1] }], issues: [] } };
  const imports: any[] = [price, image], files: any[] = [], manifests: Record<string, any> = {}, productKeys: Record<string, string> = {};
  for (const [index, row] of rows.entries()) {
    const group = 'Lo/Bo ' + index, wordId = randomUUID(), title = 'Xịt ' + row.name.value;
    const word = { id: wordId, filename: 'content.docx', sha256: hash(group), bytes: 100, kind: 'docx', status: 'ready', createdAt: stamp,
      body: { paragraphs: [title, 'Mở đầu đã chọn', 'Giữ nội dung nguồn'], issues: [] } };
    imports.push(word);
    const document = { format: 'listing-source', version: 1, product: { productKey: 'ready-' + index, sourceRevision: 0 },
      sourceListingId: { value: null, source: { fileSha256: source.fileSha256, locator: 'C' + index } },
      word: { path: 'content.docx', sha256: word.sha256, title: { start: 1, end: 1 }, headline: { start: 2, end: 2 }, body: { start: 3, end: 3 }, paragraphSeparator: '\n' },
      priceSource: { sha256: price.sha256, sheet: 'Giá', priceProfile: 'SHOP MALL' },
      media: { cover: { path: 'anh-bia.png', sha256: image.sha256 }, gallery: [{ path: 'g01.png', sha256: image.sha256 }], description: [] },
      tierNames: ['Dung tích'], variants: [{ sku: row.sku.value, rowKey: row.key, optionLabels: ['100ml'], image: { path: 'phan-loai.png', sha256: image.sha256 } }] };
    const json = JSON.stringify(document);
    manifests[group] = { relativePath: group + '/listing-source.json', sha256: hash(json), document };
    productKeys[group] = 'intake-' + index;
    for (const [name, record] of [['content.docx', word], ['anh-bia.png', image], ['g01.png', image], ['phan-loai.png', image]] as const)
      files.push({ name, relativePath: group + '/' + name, size: record.bytes, sha256: record.sha256, importId: record.id });
    files.push({ name: 'listing-source.json', relativePath: group + '/listing-source.json', size: Buffer.byteLength(json), sha256: hash(json) });
  }
  let batch: any = { id: batchId, revision: 3, createdAt: stamp, updatedAt: stamp, state: {
    version: 1, name: 'Lô đã chuẩn bị', mode: 'parent_with_listing_folders', files, priceSelection: { importId: priceId, sheet: 'Giá', priceProfile: 'SHOP MALL' },
    visual: {}, wordPaths: {}, wordRule: null, productKeys, manifests,
  } };
  const products = new Map<string, any>(), writes: any[] = [], forbidden: string[] = [], reads: string[] = [];
  let lostReply = true;
  await page.route('**/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/v1/input-batches') {
      const body = request.postDataJSON(); batch = { ...batch, revision: body.expectedRevision + 1, state: body.state };
      return route.fulfill({ json: batch });
    }
    if (request.method() === 'POST' && path === '/v1/products') {
      const body = request.postDataJSON(); writes.push(body);
      const { productKey, expectedRevision: _revision, ...selection } = body;
      const row = rows.find(row => row.key === body.variants[0].rowKey)!;
      const saved = { productKey, revision: 1, title: fact(body.title), sourceListingId: fact(null as any), sourceSelection: selection,
        folderSource: { productKey, fingerprint: hash('fixture') }, description: [], coverKey: imageId, galleryKeys: [imageId],
        variants: [{ key: row.key, sku: row.sku, originalPrice: row.originalPrice, optionLabels: ['100ml'], imageKey: imageId }],
        tierNames: ['Dung tích'], assets: [image.body], attributes: {}, logistics: {}, issues: [] };
      products.set(productKey, saved);
      if (lostReply) { lostReply = false; return route.abort('connectionreset'); }
      return route.fulfill({ json: saved });
    }
    if (request.method() !== 'GET') { forbidden.push(request.method() + ' ' + path); return route.abort('blockedbyclient'); }
    reads.push(path);
    let json: unknown = [];
    if (path === '/v1/status') json = { worker: 'online' };
    else if (path === '/v1/imports') json = imports;
    else if (path.startsWith('/v1/imports/')) json = imports.find(item => item.id === path.split('/').at(-1));
    else if (path === '/v1/products') json = [...products.values()];
    else if (path.startsWith('/v1/products/')) json = products.get(path.split('/').at(-1)!);
    else if (path === '/v1/input-library') json = { batches: [{ id: batchId, name: 'Lô đã chuẩn bị', folderCount: 2, fileCount: files.length, completedCount: 0, updatedAt: stamp }], priceBooks: [], unassigned: [] };
    else if (path === '/v1/input-batches/' + batchId) json = { ...batch, imports };
    else if (path.startsWith('/v1/media/')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg1sAAAAASUVORK5CYII=', 'base64') });
    return route.fulfill({ json });
  });
  async function openBatch() {
    await openInputLibrary(page);
    await page.getByRole('button', { name: 'Tiếp tục xử lý', exact: true }).click();
  }
  await page.goto('/'); await openBatch();
  const bulk = page.getByRole('region', { name: 'Lưu các bộ đã sẵn sàng' });
  await expect(bulk.getByRole('button', { name: 'Lưu tất cả 2 bộ đã sẵn sàng' })).toBeEnabled();
  expect(writes).toHaveLength(0);
  await bulk.getByRole('button', { name: 'Lưu tất cả 2 bộ đã sẵn sàng' }).click();
  await expect(bulk.getByText('Cần đọc lại kết quả', { exact: false })).toBeVisible();
  expect(writes).toHaveLength(1);
  const original = structuredClone(writes[0]);
  await page.reload(); await openBatch();
  await bulk.getByRole('button', { name: 'Đọc lại kết quả và tiếp tục lưu', exact: true }).click();
  await expect(bulk.getByRole('status')).toHaveText('Đã lưu 2/2 bộ.');
  expect(writes).toHaveLength(2);
  expect(writes.map(item => item.productKey)).toEqual(['ready-0', 'ready-1']);
  expect(writes[0]).toEqual(original);
  expect(writes[1].folderBinding).toEqual({ batchId, revision: batch.revision, groupKey: 'Lo/Bo 1' });
  expect(writes.every(item => item.variants[0].imageId === imageId)).toBe(true);
  expect(reads).toContain('/v1/products/ready-0');
  expect(forbidden).toEqual([]);
  await expect(bulk.getByRole('button')).toBeDisabled();
});
