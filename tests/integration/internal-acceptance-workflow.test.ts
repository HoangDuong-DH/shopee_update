import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { zipSync } from 'fflate';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import type { ListingDraft, WorkbookImport } from '@shopee/domain';
import { createApp } from '../../apps/api/src/app.js';
import { importNext } from '../../apps/worker/src/imports.js';
import { ContentWorkbookService } from '../../apps/api/src/content-workbook-service.js';
import { ProductionPreparationService } from '../../apps/api/src/production-preparation-service.js';
import { ProductionPreparationExecution } from '../../apps/api/src/production-preparation-execution.js';
import { loadProductionBatchSource, productionBatchPass1Root } from '../../apps/api/src/production-batch-source.js';
import { expandListingZips } from '../../apps/web/src/listing-zip.js';
import { withProductionScope } from '../../apps/api/src/production-scope.js';
import { ProductionPilotRunner } from '../../apps/api/src/production-pilot-runner.js';
import { ProductionPilotTransport } from '../../packages/shopee/src/production-pilot-transport.js';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import { PreparedWirePlatform } from '../fixtures/prepared-wire-platform.js';
import { businessCategoryFixtures, businessShopFixtures } from '../fixtures/business-batch-fixtures.js';
import { ProductionBatchService } from '../../apps/api/src/production-batch-service.js';
import { sourceContractFromApprovedDraft } from '../../apps/api/src/production-source-contract.js';

const target = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/invalid');
if (process.env.INTERNAL_ISOLATED_MODE !== '1' || target.hostname !== '127.0.0.1' || target.port !== '5443'
  || target.pathname !== '/shopee_internal_test' || target.username !== 'shopee_internal')
  throw Error('INTERNAL_ACCEPTANCE_REQUIRES_ISOLATED_DATABASE');
const schema = 'internal_acceptance_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
const repo = new Repository(pool), headers = { 'x-app-client': 'internal-workspace', origin: 'http://127.0.0.1:5273' };
let root: string, blobs: BlobStore, app: Awaited<ReturnType<typeof createApp>>;
const noNetwork = vi.fn(async () => { throw Error('ACCEPTANCE_OUTBOUND_NETWORK_FORBIDDEN'); });
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
  await mkdir(resolve('.local/internal-acceptance-20260923'), { recursive: true });
  await mkdir(productionBatchPass1Root, { recursive: true });
  root = await mkdtemp(resolve(productionBatchPass1Root, 'internal-acceptance-20260923-'));
  blobs = new BlobStore(root); app = await createApp(repo, blobs, [headers.origin]);
  await app.getHttpAdapter().getInstance().ready(); vi.stubGlobal('fetch', noNetwork);
});
afterAll(async () => {
  await writeFile(resolve(root, 'scope.json'), JSON.stringify({ schema, isolatedPort: 5443, liveTouched: false,
    real: ['ZIP extractor', 'HTTP routes', 'XLSX/image worker', 'PostgreSQL', 'draft compiler', 'preparation queue'],
    fixture: ['source business content', 'stock verifier', 'manifest registry', 'child Shopee execution'],
    outboundFetches: noNetwork.mock.calls.length }, null, 2));
  vi.unstubAllGlobals(); await app?.close(); await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});
async function post(path: string, payload: unknown, expected = 201) {
  const response = await app.inject({ method: 'POST', url: path, headers, payload: payload as any });
  expect(response.statusCode, response.body).toBe(expected); return response.json();
}
async function upload(bytes: Uint8Array, filename: string) {
  const response = await app.inject({ method: 'POST', url: '/v1/imports',
    headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(filename) }, payload: Buffer.from(bytes) });
  expect(response.statusCode, response.body).toBe(202);
  while (await importNext(repo, blobs)) { /* Actual worker consumes original bytes. */ }
  return (await repo.getImport(response.json().id))!;
}
async function confirmPrices(draft:ListingDraft) {
  const response=await app.inject({method:'GET',url:`/v1/products/${draft.productKey}/price-mapping-review`,headers});
  expect(response.statusCode,response.body).toBe(200);const review=response.json();
  expect(review.issues).toEqual([]);
  await post(`/v1/products/${draft.productKey}/confirm-price-mapping`,{
    expectedRevision:draft.revision,expectedFingerprint:review.fingerprint});
}
async function confirmMapping(draft:ListingDraft) {
  const response=await app.inject({method:'GET',url:`/v1/products/${draft.productKey}/mapping-review`,headers});
  expect(response.statusCode,response.body).toBe(200);const review=response.json();
  expect(review.requiresConfirmation).toBe(true);
  return await post(`/v1/products/${draft.productKey}/confirm-mapping`,{
    expectedRevision:draft.revision,expectedFingerprint:review.fingerprint}) as ListingDraft;
}
async function sourcePair(brand = 'NHÃN THỬ') {
  const run = randomUUID();
  const priceBook = new ExcelJS.Workbook(), prices = priceBook.addWorksheet('Giá gốc');
  prices.addRow(['SKU', 'TÊN SẢN PHẨM', 'GIÁ GỐC', 'GIÁ BÁN', 'CÂN NẶNG KHAI BÁO (G)', 'THƯƠNG HIỆU']);
  for (let product = 0; product < 2; product++) for (const [v, volume] of [100, 280, 500].entries())
    prices.addRow([`${run}-${product}-${volume}`, `Xịt nguồn ${product} ${volume}ml`, 11000 + v * 1000, 10000, volume, brand]);
  const price = await upload(Buffer.from(await priceBook.xlsx.writeBuffer()), 'Gia-goc.xlsx');
  expect(price.status).toBe('ready'); const rows = (price.body as WorkbookImport).rows;
  expect(rows).toHaveLength(6);
  const book = new ExcelJS.Workbook(); book.addWorksheet('Nội dung').addRows([
    ['STT', 'Tiêu đề', 'Mở đầu', 'Nội dung'],
    [222, 'Xịt mũ bảo hiểm', 'Mở đầu mũ', 'Nội dung mũ nguyên vẹn'],
    [224, 'Xịt tủ giày', 'Mở đầu tủ', 'Nội dung tủ nguyên vẹn'],
  ]);
  const content = await upload(Buffer.from(await book.xlsx.writeBuffer()), 'Noi-dung.xlsx');
  const mapping = { importId: content.id, sha256: content.sha256, sheet: 'Nội dung', headerRow: 1,
    columns: { stt: 'A', title: 'B', headline: 'C', body: 'D' },
    headers: { stt: 'STT', title: 'Tiêu đề', headline: 'Mở đầu', body: 'Nội dung' } };
  const parsed = await post('/v1/content-workbooks/rows', mapping); expect(parsed.rows).toHaveLength(2);
  const png = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#487456' } }).png().toBuffer();
  const square = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#987456' } }).png().toBuffer();
  const files = await expandListingZips([new File([zipSync({ '222 Mũ/bia.png': square, '222 Mũ/gallery.png': png,
    '224 Tủ/bia.png': square, '224 Tủ/gallery.png': png })], 'Nguon.zip')], { layout: 'listing_folders' });
  expect(files).toHaveLength(4);
  const images = await Promise.all(files.map(async file => upload(new Uint8Array(await file.arrayBuffer()), file.name)));
  const batchId = randomUUID(), groups = ['NguonZIP/222 Mũ', 'NguonZIP/224 Tủ'];
  const contents = new ContentWorkbookService(repo, blobs);
  const selections = await Promise.all([222, 224].map((stt, index) => contents.resolve({ mapping, row: index + 2, stt: String(stt) })));
  const keys = groups.map(() => randomUUID());
  const batch = await post('/v1/input-batches', { id: batchId, expectedRevision: 0, state: {
    version: 1, name: 'Acceptance ZIP Excel', mode: 'parent_with_listing_folders',
    files: files.map((file, index) => ({ name: file.name, relativePath: file.webkitRelativePath, size: file.size,
      importId: images[index]!.id, sha256: images[index]!.sha256 })),
    priceSelection: { importId: price.id, sheet: 'Giá gốc', priceProfile: null }, visual: {}, wordPaths: {}, wordRule: null,
    productKeys: Object.fromEntries(groups.map((group, index) => [group, keys[index]])),
    contentSelections: Object.fromEntries(groups.map((group, index) => [group, selections[index]])),
  } });
  const drafts: ListingDraft[] = [];
  for (let i = 0; i < 2; i++) {
    const selected = selections[i]!, image = images[i * 2]!, gallery = images[i * 2 + 1]!;
    const request = { productKey: keys[i], expectedRevision: 0, folderBinding: { batchId, revision: batch.revision, groupKey: groups[i] },
      contentBinding: selected.binding, title: selected.title, headline: selected.headline, body: selected.body,
      coverId: image.id, galleryIds: [gallery.id], descriptionImageIds: [gallery.id], tierNames: ['Dung tích'],
      variants: rows.slice(i * 3, i * 3 + 3).map((row, v) => ({ importId: price.id, rowKey: row.key, optionLabels: [`${[100, 280, 500][v]}ml`], imageId: image.id })) };
    const draft = await post('/v1/products', request); expect(await post('/v1/products', request)).toEqual(draft);
    await confirmPrices(draft);drafts.push(draft);
  }
  const register = vi.fn(async (input: { manifestPath: string; expectedSha256: string }) => {
    const loaded = await loadProductionBatchSource(input.manifestPath, input.expectedSha256);
    return { batchId: loaded.value.batchId, manifestSha256: loaded.sha256 };
  });
  const service = () => new ProductionPreparationService(repo, blobs, { root, register,
    verifyStock: async () => ({ expectedLocationId: 'FIXTURE-WAREHOUSE', writeLocationId: null }) });
  const entry = (draft: ListingDraft) => ({ productKey: draft.productKey, sourceRevision: draft.revision,
    priceSelection: { importId: price.id, sheet: 'Giá gốc', priceProfile: null },
    stocks: Object.fromEntries(draft.variants.map(v => [v.sku.value, 0])), choices: {
      categoryId: '10', brandId: '20', logistics: [{ channelId: '50', enabled: true }], weightGrams: 500,
      dimensionCm: { length: 12, width: 12, height: 28 }, condition: 'NEW', preOrder: { is_pre_order: false },
      stockLocation: { referenceItemId: '1234', expectedLocationBySku: Object.fromEntries(draft.variants.map(v => [v.sku.value, 'FIXTURE-WAREHOUSE'])),
        writeLocationBySku: Object.fromEntries(draft.variants.map(v => [v.sku.value, null])) } } });
  return { drafts, entry, service, register, content, price };
}

it('ZIP + genuine Excel source bytes survive HTTP save, concurrent bulk remove, compiler and hidden-job recovery with an invalid sibling', async () => {
  const f = await sourcePair();
  const input = { operationId: randomUUID(), entries: f.drafts.map(draft => ({ productKey: draft.productKey, expectedRevision: 1 })), removeVolumesMl: [280], sortVolumeDescending: true };
  const preview = await post('/v1/products/bulk-edit/preview', input);
  expect(preview.changedCount).toBe(2);
  const applied = await Promise.all([0, 1].map(() => post('/v1/products/bulk-edit/apply', { input, expectedDigest: preview.digest })));
  expect(applied.map(result => result.recovered).sort()).toEqual([false, true]);
  const drafts = await Promise.all(f.drafts.map(draft => repo.getProduct(draft.productKey)));
  for (const draft of drafts) { expect(draft!.revision).toBe(2); expect(draft!.variants.map(v => v.optionLabels)).toEqual([['500ml'], ['100ml']]); }
  const held=await f.service().preview({id:randomUUID(),entries:[f.entry(drafts[0]!)]});
  expect(held.readyCount).toBe(0);expect(held.entries[0].issues.some((issue:any)=>issue.code==='SOURCE_MAPPING_PROOF_MISMATCH')).toBe(true);
  const originalFolder=structuredClone(drafts[0]!.folderSource),originalBinding=structuredClone(drafts[0]!.sourceSelection!.folderBinding);
  drafts[0]=await confirmMapping(drafts[0]!);await confirmPrices(drafts[0]!);
  expect(drafts[0].folderSource).toEqual(originalFolder);expect(drafts[0].sourceSelection!.folderBinding).toEqual(originalBinding);
  const entries = drafts.map(draft => f.entry(draft!)); entries[1]!.choices.categoryId = undefined as any;
  const preparationId = randomUUID(), prepared = await f.service().preview({ id: preparationId, entries });
  expect(prepared.entries[0], JSON.stringify(prepared.entries[0])).toMatchObject({ kind: 'ready' });
  expect([prepared.readyCount, prepared.blockedCount]).toEqual([1, 1]);
  expect(prepared.entries[1]!.issues.some((issue: any) => issue.field === 'categoryId')).toBe(true);
  const registered = await f.service().register(preparationId, { expectedFingerprint: prepared.fingerprint });
  expect(f.register).toHaveBeenCalledTimes(1);
  const receipt = f.register.mock.calls[0]![0], manifest = await loadProductionBatchSource(receipt.manifestPath, receipt.expectedSha256);
  expect(manifest.value).toMatchObject({ publicationMode: 'hidden_for_review' });
  expect(manifest.value.listings[0]!.document.models.map(v => v.sku)).toEqual(drafts[0]!.variants.map(v => v.sku.value));
  const snapshotFile = manifest.value.sourceFiles.find((file: any) => file.role === 'listing-snapshot')!;
  const frozenSource = JSON.parse(await readFile(snapshotFile.path, 'utf8'));
  expect(frozenSource.imports.some((file: any) => file.sha256 === f.content.sha256)).toBe(true);
  let done = false;
  const child = { status: vi.fn(async (id: string) => ({ batchId: id, manifestSha256: registered.batches[0]!.manifestSha256,
    state: done ? 'completed' : 'ready', busy: false, canExecute: !done, statusFingerprint: 'a'.repeat(64), listings: [{ state: done ? 'created_unlisted' : 'not_sent' }] })),
    start: vi.fn(async () => { done = true; return {}; }) };
  const queue = new ProductionPreparationExecution(repo, f.service(), child as any, { enabled: true, sleep: async () => {} });
  await queue.start(preparationId, { expectedFingerprint: prepared.fingerprint }); await queue.waitForIdle(preparationId);
  const reopened = new ProductionPreparationExecution(repo, f.service(), child as any, { enabled: true, sleep: async () => {} });
  expect(await reopened.get(preparationId)).toMatchObject({ state: 'completed', completionTarget: 'created_hidden' });
  await reopened.start(preparationId, { expectedFingerprint: prepared.fingerprint }); expect(child.start).toHaveBeenCalledTimes(1);
  expect(noNetwork).not.toHaveBeenCalled();
}, 60000);

it('changed source after preview is rejected and the saved snapshot remains reviewable', async () => {
  const f = await sourcePair(), id = randomUUID(), service = f.service();
  const prepared = await service.preview({ id, entries: [f.entry(f.drafts[0]!)] }); expect(prepared.readyCount).toBe(1);
  const changed = structuredClone(f.drafts[0]!); changed.revision++; changed.title.value += ' đã sửa'; changed.sourceSelection!.title = changed.title.value;
  await repo.saveProduct(changed, 1);
  await expect(service.register(id, { expectedFingerprint: prepared.fingerprint })).rejects.toThrow('PREPARATION_SOURCE_CHANGED');
  expect(await service.get(id)).toEqual(prepared); expect(f.register).not.toHaveBeenCalled(); expect(noNetwork).not.toHaveBeenCalled();
}, 60000);

it('a registered job cannot start after its source changes, nor be read or run as another shop', async () => {
  const f = await sourcePair(), id = randomUUID(), service = f.service();
  const prepared = await service.preview({ id, entries: [f.entry(f.drafts[0]!)] });
  await service.register(id, { expectedFingerprint: prepared.fingerprint });
  const child = { status: vi.fn(), start: vi.fn() };
  const queue = new ProductionPreparationExecution(repo, service, child as any, { enabled: true });
  const other = { environment: 'production' as const, partnerId: '2010476', shopId: '1126307464' };
  await expect(withProductionScope(other, () => service.get(id))).rejects.toThrow('PRODUCTION_BATCH_SCOPE_MISMATCH');
  await expect(withProductionScope(other, () => queue.start(id, { expectedFingerprint: prepared.fingerprint }))).rejects.toThrow('PRODUCTION_BATCH_SCOPE_MISMATCH');
  const changed = structuredClone(f.drafts[0]!); changed.revision++; changed.title.value += ' bản mới'; changed.sourceSelection!.title = changed.title.value;
  await repo.saveProduct(changed, 1);
  const changes = await app.inject({ method: 'GET', url: `/v1/production-preparations/${id}/source-changes?partnerId=2010476&shopId=1423724897`, headers });
  expect(changes.statusCode, changes.body).toBe(200);
  expect(changes.json().entries[0]).toMatchObject({ state: 'changed', sourceRevision: 1, currentRevision: 2, changedFields: ['title'] });
  expect(changes.json().entries[0].changes[0]).toMatchObject({ field: 'title', before: f.drafts[0]!.title.value, after: changed.title.value });
  await expect(queue.start(id, { expectedFingerprint: prepared.fingerprint })).rejects.toThrow('PREPARATION_SOURCE_CHANGED');
  expect(child.status).not.toHaveBeenCalled(); expect(child.start).not.toHaveBeenCalled();
}, 60000);

it('lost child POST response and bounded busy polling preserve durable paused jobs without replay', async () => {
  const f = await sourcePair(), id = randomUUID(), service = f.service();
  const prepared = await service.preview({ id, entries: [f.entry(f.drafts[0]!)] });
  const receipt = await service.register(id, { expectedFingerprint: prepared.fingerprint });
  let sent = false;
  const child = { status: vi.fn(async () => ({ manifestSha256: receipt.batches[0]!.manifestSha256,
    state: sent ? 'running' : 'ready', busy: sent, canExecute: !sent, statusFingerprint: 'a'.repeat(64) })),
    start: vi.fn(async () => { sent = true; throw Error('socket response lost after server accepted'); }) };
  const queue = new ProductionPreparationExecution(repo, service, child as any, { enabled: true, maximumPolls: 2, sleep: async () => {} });
  await queue.start(id, { expectedFingerprint: prepared.fingerprint }); await queue.waitForIdle(id);
  expect(await queue.get(id)).toMatchObject({ state: 'paused', code: 'PREPARATION_RUN_FAILED' });
  const reopened = new ProductionPreparationExecution(repo, service, child as any, { enabled: true, maximumPolls: 2, sleep: async () => {} });
  await reopened.start(id, { expectedFingerprint: prepared.fingerprint }); await reopened.waitForIdle(id);
  expect(await reopened.get(id)).toMatchObject({ state: 'paused', code: 'PREPARATION_CHILD_REVIEW_REQUIRED' });
  expect(child.start).toHaveBeenCalledTimes(1);
  const secondId = randomUUID(), second = await service.preview({ id: secondId, entries: [f.entry(f.drafts[1]!)] });
  const secondReceipt = await service.register(secondId, { expectedFingerprint: second.fingerprint });
  let busy = false;
  const bounded = { status: vi.fn(async () => ({ manifestSha256: secondReceipt.batches[0]!.manifestSha256,
    state: busy ? 'running' : 'ready', busy, canExecute: !busy, statusFingerprint: 'b'.repeat(64) })),
    start: vi.fn(async () => { busy = true; }) };
  const boundedQueue = new ProductionPreparationExecution(repo, service, bounded as any, { enabled: true, maximumPolls: 2, sleep: async () => {} });
  await boundedQueue.start(secondId, { expectedFingerprint: second.fingerprint }); await boundedQueue.waitForIdle(secondId);
  expect(await boundedQueue.get(secondId)).toMatchObject({ state: 'paused', code: 'PREPARATION_CHILD_STILL_RUNNING' });
  expect(bounded.status).toHaveBeenCalledTimes(3); expect(bounded.start).toHaveBeenCalledTimes(1);
  expect(noNetwork).not.toHaveBeenCalled();
}, 60000);

it('compiled original sources reach the real journal and hidden runner; external QC edits hold review and reconciliation performs reads only', async () => {
  const category = businessCategoryFixtures[0]!, f = await sourcePair(category.brandName), id = randomUUID();
  const credentials = { environment: 'production' as const, partnerId: '2010476', shopId: '1423724897',
    partnerKey: 'INTERNAL-ACCEPTANCE-FIXTURE-KEY', accessToken: 'INTERNAL-ACCEPTANCE-FIXTURE-TOKEN' };
  const profile = { ...structuredClone(businessShopFixtures[0]!), shopId: credentials.shopId, ownerId: credentials.partnerId };
  const platform = new PreparedWirePlatform({ shops: [{ profile, credentials: { ...credentials, environment: 'sandbox' },
    allowPortrait: true, allowExtendedDescription: true, gtinRule: 'Optional' }] });
  let externalEdit = true;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe('https://partner.shopeemobile.com');
    url.hostname = 'openplatform.sandbox.test-stable.shopee.sg';
    const reply = await platform.fetch(url, init);
    if (!externalEdit || !url.pathname.endsWith('/get_item_base_info')) return reply;
    const body = await reply.json(); if (body.response?.item_list?.[0]) body.response.item_list[0].item_name += ' thay đổi ngoài ứng dụng';
    return new Response(JSON.stringify(body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  const encryptionKey = '97'.repeat(32), box = new SecretBox(encryptionKey), connectionId = randomUUID();
  await pool.query(`INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at,partner_key_ciphertext,token_ciphertext)
    VALUES($1,'production',$2,$3,'Already connected isolated fixture','connected',now()+interval '1 hour',$4,$5)`,
    [connectionId, credentials.partnerId, credentials.shopId, box.seal({ partnerKey: credentials.partnerKey }, 'production:2010476:1423724897'),
      box.seal({ accessToken: credentials.accessToken }, 'production:2010476:1423724897')]);
  const request = f.entry(f.drafts[0]!); request.choices.categoryId = category.categoryId; request.choices.brandId = category.brandId;
  request.choices.logistics = [{ channelId: profile.logisticsChannelId, enabled: true }];
  (request.choices as any).attributeList = [{ attribute_id: Number(category.requiredAttribute.attributeId),
    attribute_value_list: [{ value_id: Number(category.requiredAttribute.values[0]!.valueId) }] }];
  const service = f.service(), prepared = await service.preview({ id, entries: [request] });
  expect(prepared.entries[0], JSON.stringify(prepared.entries[0])).toMatchObject({ kind: 'ready' });
  await service.register(id, { expectedFingerprint: prepared.fingerprint });
  const frozen = (await pool.query('SELECT body FROM production_source_preparations WHERE id=$1', [id])).rows[0].body.entries[0];
  const client = new ProductionPilotTransport(credentials, { transport });
  const read = async (path: string, query: Record<string, string> = {}) => {
    const reply = await client.read('/api/v2/' + path, query); expect(reply.kind).toBe('success');
    if (reply.kind !== 'success') throw Error('Fixture metadata unavailable'); return reply as any;
  };
  const limits = await read('product/get_item_limit', { category_id: category.categoryId }),
    brands = await read('product/get_brand_list', { category_id: category.categoryId, offset: '0', page_size: '100', status: '1' }),
    attributes = await read('product/get_attribute_tree', { category_id_list: category.categoryId }), channels = await read('logistics/get_channel_list');
  const sourceIdentity = f.drafts[0]!.productKey, sourceRevision = 1, now = new Date().toISOString();
  const runner = new ProductionPilotRunner(repo, { allowedSources: [{ sourceIdentity, sourceRevision }], assetRoot: root,
    evidenceRoot: resolve(root, 'wire-evidence'), encryptionKey, transport, readbackDelaysMs: [1, 2],
    capabilityProbe: { sourceIdentity, sourceRevision, authorizationReference: 'Explicit isolated acceptance of this exact source' },
    pause: async ms => { platform.advance(ms); } });
  const source = { sourceIdentity, sourceRevision, connectionId, connectionRevision: 1, assets: frozen.assets,
    document: frozen.document, issues: [], metadata: { environment: 'production', partnerId: credentials.partnerId, shopId: credentials.shopId,
      connectionRevision: 1, categoryId: category.categoryId, observedAt: now, expiresAt: new Date(Date.now() + 600000).toISOString(),
      requestIds: [limits.requestId, brands.requestId, attributes.requestId, channels.requestId] },
    capabilityEvidence: { environment: 'production', partnerId: credentials.partnerId, shopId: credentials.shopId, connectionRevision: 1,
      gallery34: { state: 'unknown', observedAt: now, references: ['Original portrait source bytes'] },
      extendedDescription: { state: 'unknown', observedAt: now, references: ['Source exact image description'] } },
    capabilityProbe: { sourceIdentity, sourceRevision, authorizationReference: 'Explicit isolated acceptance of this exact source', capabilities: ['gallery34', 'extendedDescription'] },
    context: { images: [], sourceContract:sourceContractFromApprovedDraft(frozen.sourceSnapshot.draft,frozen.sourceSnapshot.input.stocks),
      brandName: category.brandName, condition: 'NEW', preOrder: { is_pre_order: false },
      stockLocationBySku: Object.fromEntries(frozen.document.models.map((model: any) => [model.sku, null])), limits: limits.response,
      capabilities: { gallery34: false, extendedDescription: false }, attributeList: frozen.proposedAttributeList,
      channelInfoById: Object.fromEntries(channels.response.logistics_channel_list.map((channel: any) => [String(channel.logistics_channel_id), channel])) } };
  const accepted = await runner.prepare(source as any); expect(accepted.kind, JSON.stringify(accepted)).toBe('ready');
  if (accepted.kind !== 'ready') throw Error('Fixture not ready');
  const held = await runner.run(accepted.operationId); expect(held.state, JSON.stringify(held)).toBe('unresolved');
  const before = await runner.journal.get(accepted.operationId);
  expect(before.operation.state).toBe('acknowledged'); expect(before.verification).toBeNull();
  const writes = platform.calls.filter(call => call.method === 'POST').length;
  expect(platform.calls.filter(call => call.path.endsWith('/add_item'))).toHaveLength(1);
  expect(platform.calls.filter(call => call.path.endsWith('/init_tier_variation'))).toHaveLength(1);
  externalEdit = false;
  const reconciled = await runner.run(accepted.operationId); expect(reconciled.state, JSON.stringify(reconciled)).toBe('verified');
  expect(platform.calls.filter(call => call.method === 'POST')).toHaveLength(writes);
  const after = await runner.journal.get(accepted.operationId);
  expect(after.operation.source_payload).toEqual(before.operation.source_payload);
  expect(after.verification.readbacks).toHaveLength(2);
  expect(platform.snapshot().items[0]!.base.item_status).toBe('UNLIST');
  expect(platform.calls.some(call => call.path.endsWith('/unlist_item'))).toBe(false);
  expect(noNetwork).not.toHaveBeenCalled();
  await writeFile(resolve(root, 'compiled-runner-receipt.json'), JSON.stringify({ preparationId: id, operationId: accepted.operationId,
    createCount: 1, initializationCount: 1, totalWrites: writes, rawReadbacks: after.verification.readbacks.length,
    finalStatus: 'UNLIST', externalEditHeld: true, reconciliationWrites: 0, actualShopeeNetwork: false,
    title: frozen.document.title, skuCount: frozen.document.models.length }, null, 2));
}, 60000);

it('operational report HTTP and Excel keep ACK separate from verified, preserve names and expose no raw secret fields', async () => {
  const batchId = randomUUID(), scope = '?partnerId=2010476&shopId=1126307464';
  const status = { batchId, partnerId: '2010476', shopId: '1126307464', shopName: 'Isolated nonlegacy reporting fixture', state: 'held',
    publicationMode: 'hidden_for_review', connection: { accessToken: 'DO-NOT-EXPORT-SECRET' },
    listings: [
      { sourceKey: 'sent', title: 'Xịt mũ đang đối chiếu', modelCount: 3, state: 'created_readback_pending', acknowledgedSteps: 5, totalSteps: 5, itemId: '12345' },
      { sourceKey: 'verified', title: '=DANGEROUS_FORMULA()', modelCount: 2, state: 'created_unlisted', acknowledgedSteps: 5, totalSteps: 5, itemId: '12346' },
      { sourceKey: 'invalid', title: 'Xịt tủ giày thiếu SKU', modelCount: 0, state: 'not_sent', acknowledgedSteps: 0, totalSteps: 0, currentSource: 'source_changed', itemId: null },
    ], lastResult: { listings: [{ sourceKey: 'sent', state: 'unresolved', code: 'EXTERNAL_TITLE_CHANGED' }] } };
  const fakeStatus = vi.spyOn(ProductionBatchService.prototype, 'status').mockResolvedValue(status as any);
  try {
    const json = await app.inject({ method: 'GET', url: `/v1/production-batches/${batchId}/report${scope}`, headers });
    expect(json.statusCode, json.body).toBe(200);
    const report = json.json(); expect(report.summary).toMatchObject({ total: 3, verifiedHidden: 1, awaitingReconciliation: 1, needsSource: 1 });
    expect(report.rows[0]).toMatchObject({ title: 'Xịt mũ đang đối chiếu', group: 'reconciling', reasonCode: 'EXTERNAL_TITLE_CHANGED' });
    expect(report.rows[0].next).toContain('không gửi tạo lại'); expect(json.body).not.toContain('DO-NOT-EXPORT-SECRET');
    const xlsx = await app.inject({ method: 'GET', url: `/v1/production-batches/${batchId}/report.xlsx${scope}`, headers });
    expect(xlsx.statusCode).toBe(200); expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    const book = new ExcelJS.Workbook(); await book.xlsx.load(xlsx.rawPayload as any);
    expect(book.worksheets.map(sheet => sheet.name)).toEqual(['Tong quan', 'San pham']);
    expect(book.getWorksheet('San pham')!.getCell('A3').value).toBe('=DANGEROUS_FORMULA()');
    expect(book.getWorksheet('San pham')!.getCell('A3').type).toBe(ExcelJS.ValueType.String);
    const foreign = await app.inject({ method: 'GET', url: `/v1/production-batches/${batchId}/report?partnerId=2010476&shopId=1423724897`, headers });
    expect(foreign.statusCode).toBe(409); expect(foreign.json().code).toBe('PRODUCTION_BATCH_SCOPE_MISMATCH');
    expect(noNetwork).not.toHaveBeenCalled();
  } finally { fakeStatus.mockRestore(); }
});
