import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import ExcelJS from 'exceljs';
vi.mock('../../apps/api/src/production-pilot-read-scheduler.js', () => ({
  readProductionPilotWithBackoff: async (
    client: any,
    path: string,
    query: Record<string, string>,
    record: any,
  ) => {
    const result = await client.read(path, query);
    await record(result, 0);
    return result;
  },
}));
import {
  loadProductionBatchSource,
  readProductionBatchManifest,
  collectProductionBatchInput,
  productionBatchPass1Root,
} from '../../apps/api/src/production-batch-source.js';
import { findProductionSourceBrand } from '../../apps/api/src/production-pilot-source.js';
import { ProductionPilotReadSession } from '../../apps/api/src/production-pilot-read-session.js';
import { ProductionPilotRunner, type ProductionPilotPreparedInput } from '../../apps/api/src/production-pilot-runner.js';
import {canonicalJson} from '@shopee/domain';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let root: string;
afterEach(() => vi.useRealTimers());
beforeEach(async () => {
  await mkdir(productionBatchPass1Root, { recursive: true });
  root = await mkdtemp(resolve(productionBatchPass1Root, 'fixture-'));
});
async function fixture() {
  const md = resolve(root, 'original.md'),
    prices = resolve(root, 'DORIS.xlsx'),
    image = resolve(root, 'original.png');
  await Promise.all([
    writeFile(md, 'Original unchanged markdown'),
    writeFile(prices, 'Original immutable workbook fixture'),
    writeFile(image, 'original image bytes'),
  ]);
  const importId = randomUUID(),
    media = {
      importId,
      sha256: sha('original image bytes'),
      width: 100,
      height: 100,
      mime: 'image/png',
    };
  const listing = {
    sourceIdentity: 'pass1:test-a',
    sourceRevision: 1,
    sourceKey: 'prepared-a',
    sourceFileId: 'md',
    document: {
      sourceKey: 'pass1:test-a',
      title: 'Title\nwith source spaces',
      description: [{ type: 'text', text: ' Exact text\n\nunchanged ' }],
      cover: media,
      gallery: [media],
      tierNames: [],
      models: [
        { sku: 'SKU-A', optionLabels: [], tierIndex: [], originalPrice: '125000', stock: 100 },
      ],
      categoryId: '101128',
      brandId: '42',
      attributes: {},
      logistics: [{ channelId: '5001', enabled: true }],
      weightGrams: 322.3,
      dimensionCm: { length: 10, width: 20, height: 30 },
      publication: 'unlisted',
    },
    proposedAttributeList: [],
    brandName: 'Original brand',
    condition: 'NEW',
    preOrder: { is_pre_order: false },
    stockLocation: {
      referenceItemId: '99',
      expectedLocationBySku: { 'SKU-A': 'VNZ' },
      writeLocationBySku: { 'SKU-A': null },
    },
    priceProof: [
      {
        sku: 'SKU-A',
        sourceFileId: 'prices',
        sheetName: 'Sheet1',
        skuCell: 'A2',
        priceCell: 'O2',
        originalPrice: '125000',
        priceSet: 'SHOP MALL',
      },
    ],
  };
  const value = {
    version: 1,
    batchId: randomUUID(),
    scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
    authorizationReference:
      'User approved these prepared sources, Mall original prices and stock100 per SKU',
    sourceFiles: [
      { id: 'md', role: 'listing-markdown', path: md, sha256: sha(await readFile(md)) },
      { id: 'prices', role: 'pricebook', path: prices, sha256: sha(await readFile(prices)) },
    ],
    assets: { [importId]: image },
    listings: [listing],
  };
  const path = resolve(root, 'manifest.json');
  const save = async () => {
    const bytes = JSON.stringify(value);
    await writeFile(path, bytes);
    return sha(bytes);
  };
  return { value, path, save, md, prices, image };
}
it('loads exactly the nominated receipt and preserves original text, order and SKU values', async () => {
  const f = await fixture(),
    digest = await f.save();
  const loaded = await loadProductionBatchSource(f.path, digest);
  expect(loaded.sha256).toBe(digest);
  expect(loaded.value).toEqual(f.value);
});
it('keeps immutable source status readable after an original asset changes while the execution loader still blocks', async () => {
  const f = await fixture(), sha = await f.save();
  await writeFile(f.image, 'changed source');
  expect((await readProductionBatchManifest(f.path,sha)).value).toEqual(f.value);
  await expect(loadProductionBatchSource(f.path,sha)).rejects.toThrow('PRODUCTION_BATCH_ASSET_CHANGED');
});
async function savedDraftFixture() {
  const f = await fixture();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.getCell('A2').value = 'SKU-A';
  sheet.getCell('O2').value = 125000;
  await workbook.xlsx.writeFile(f.prices);
  const value: any = f.value;
  value.version = 2;
  value.sourceFiles[0].role = 'listing-snapshot';
  value.sourceFiles[1].sha256 = sha(await readFile(f.prices));
  value.listings[0].document.models[0].stock = 0;
  value.listings[0].priceProof[0].priceSet = 'SHOP THƯỜNG';
  value.preparation = { id: randomUUID(), fingerprint: 'c'.repeat(64) };
  return { ...f, value };
}
it('version 2 preserves explicitly supplied zero stock and the selected regular price set', async () => {
  const f = await savedDraftFixture();
  const loaded = await loadProductionBatchSource(f.path, await f.save());
  expect(loaded.value.version).toBe(2);
  expect(loaded.value.listings[0]!.document.models[0]!.stock).toBe(0);
  expect(loaded.value.listings[0]!.priceProof[0]!.priceSet).toBe('SHOP THƯỜNG');
});
it('loads an already frozen historical test declaration without recompiling its existing-ID source or changing bytes',async()=>{
 const f=await savedDraftFixture();
 const authorization={reason:'distinct_prepared_listing_test',authorizationReference:'Historical exact trial source/revision receipt'};
 const snapshot=JSON.stringify({draft:{productKey:f.value.listings[0].sourceIdentity,revision:1,sourceListingId:{value:'29926930476',confirmed:true}},input:{existingListingAuthorization:authorization}});
 await writeFile(f.md,snapshot);f.value.sourceFiles[0].sha256=sha(snapshot);f.value.listings[0].existingListingAuthorization=authorization;
 const digest=await f.save(),before=await readFile(f.path);
 const loaded=await loadProductionBatchSource(f.path,digest);
 expect(loaded.value.listings[0].existingListingAuthorization).toEqual(authorization);
 expect(loaded.sha256).toBe(digest);
 expect(await readFile(f.path)).toEqual(before);expect(await readFile(f.md,'utf8')).toBe(snapshot);
});
it('version 2 binds explicit hidden mode to the manifest hash while old bytes remain unchanged',async()=>{
  const f=await savedDraftFixture();const oldSha=await f.save();
  const old=await loadProductionBatchSource(f.path,oldSha);
  expect(Object.hasOwn(old.value,'publicationMode')).toBe(false);
  f.value.publicationMode='hidden_for_review';const hiddenSha=await f.save();
  expect(hiddenSha).not.toBe(oldSha);
  expect(await loadProductionBatchSource(f.path,hiddenSha)).toMatchObject({value:{publicationMode:'hidden_for_review'}});
  await expect(loadProductionBatchSource(f.path,oldSha)).rejects.toThrow();
  f.value.publicationMode='public_without_qc';
  await expect(loadProductionBatchSource(f.path,await f.save())).rejects.toThrow();
});
it('version 2 rejects a price that is internally consistent but disagrees with the workbook cell', async () => {
  const f = await savedDraftFixture();
  f.value.listings[0].document.models[0].originalPrice = '130000';
  f.value.listings[0].priceProof[0].originalPrice = '130000';
  await expect(loadProductionBatchSource(f.path, await f.save())).rejects.toThrow('PRODUCTION_BATCH_PRICE_CELL_MISMATCH');
});
it('version 2 rejects source SKU cells pointing at a different product even at the same price', async () => {
  const f = await savedDraftFixture();
  f.value.listings[0].priceProof[0].skuCell = 'A3';
  await expect(loadProductionBatchSource(f.path, await f.save())).rejects.toThrow('PRODUCTION_BATCH_PRICE_CELL_MISMATCH');
});
it('preserves four distinct explicitly prepared sources without adding new default identities', async () => {
  const f = await fixture(),
    original = structuredClone(f.value.listings[0]!);
  f.value.listings = Array.from({ length: 4 }, (_, index) => {
    const source = structuredClone(original),
      sku = 'SOURCE-SKU-' + index;
    source.sourceIdentity = 'explicit-pass1-source-' + index;
    source.sourceKey = 'input-' + index;
    source.document.sourceKey = source.sourceIdentity;
    source.document.title = ' Original source ' + index + ' ';
    source.document.models[0]!.sku = sku;
    source.priceProof[0]!.sku = sku;
    source.stockLocation.expectedLocationBySku = { [sku]: 'VNZ' } as any;
    source.stockLocation.writeLocationBySku = { [sku]: null } as any;
    return source;
  });
  const loaded = await loadProductionBatchSource(f.path, await f.save());
  expect(loaded.value.listings).toEqual(f.value.listings);
  expect(Object.isFrozen(loaded.value.listings[0]!.document.models)).toBe(true);
});
it.each(['manifest', 'markdown', 'pricebook', 'asset'])(
  'rejects changed %s bytes',
  async (part) => {
    const f = await fixture(),
      digest = await f.save();
    await writeFile(
      { manifest: f.path, markdown: f.md, pricebook: f.prices, asset: f.image }[part]!,
      'changed',
    );
    await expect(loadProductionBatchSource(f.path, digest)).rejects.toThrow('PRODUCTION_BATCH_');
  },
);
it.each([
  (f: Awaited<ReturnType<typeof fixture>>) => {
    f.value.scope.shopId = 'other';
  },
  (f: Awaited<ReturnType<typeof fixture>>) => {
    f.value.listings.push(structuredClone(f.value.listings[0]!));
  },
  (f: Awaited<ReturnType<typeof fixture>>) => {
    f.value.listings[0]!.document.models[0]!.stock = 50;
  },
  (f: Awaited<ReturnType<typeof fixture>>) => {
    f.value.listings[0]!.priceProof[0]!.originalPrice = '1';
  },
  (f: Awaited<ReturnType<typeof fixture>>) => {
    f.value.listings[0]!.priceProof = [];
  },
  (f: Awaited<ReturnType<typeof fixture>>) => {
    f.value.listings[0]!.sourceFileId = 'missing';
  },
  (f: Awaited<ReturnType<typeof fixture>>) => {
    f.value.listings[0]!.document.sourceKey = 'other';
  },
  (f: Awaited<ReturnType<typeof fixture>>) => {
    f.value.listings[0]!.stockLocation.expectedLocationBySku = {} as any;
  },
])('rejects ambiguous source or unproven values %#', async (alter) => {
  const f = await fixture();
  alter(f);
  await expect(loadProductionBatchSource(f.path, await f.save())).rejects.toThrow(
    'PRODUCTION_BATCH_',
  );
});
it('does not fall back to another manifest when the exact nominated path is missing', async () => {
  const f = await fixture();
  await f.save();
  await expect(
    loadProductionBatchSource(resolve(root, 'absent.json'), 'a'.repeat(64)),
  ).rejects.toThrow();
});
it('rejects a manifest path outside the dedicated batch root', async () => {
  await expect(
    loadProductionBatchSource(resolve('.local', 'not-pass1.json'), 'a'.repeat(64)),
  ).rejects.toThrow('PRODUCTION_BATCH_');
});
it('finds the exact source brand through actual page cursors, starting from zero', async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce({
      brand_list: [
        { brand_id: 0, original_brand_name: 'NoBrand' },
        { brand_id: 1, original_brand_name: 'Other' },
      ],
      has_next_page: true,
      next_offset: 1243729,
    })
    .mockResolvedValueOnce({
      brand_list: [{ brand_id: 42, original_brand_name: 'Original brand' }],
      has_next_page: false,
    });
  expect(await findProductionSourceBrand(get, '101128', '42', 'Original brand')).toEqual({
    brand_id: 42,
    original_brand_name: 'Original brand',
  });
  expect(get.mock.calls.map((call) => call[1].offset)).toEqual(['0', '1243729']);
  expect(
    get.mock.calls.every(
      (call) => call[0] === '/api/v2/product/get_brand_list' && call[1].category_id === '101128',
    ),
  ).toBe(true);
});
it.each([
  { brand_list: [], has_next_page: true, next_offset: 0 },
  { brand_list: [], has_next_page: true },
  { brand_list: [{ brand_id: 42, original_brand_name: 'Wrong brand' }], has_next_page: false },
  {
    brand_list: [
      { brand_id: 42, original_brand_name: 'Original brand' },
      { brand_id: 42, original_brand_name: 'Original brand' },
    ],
    has_next_page: false,
  },
  { brand_list: [], has_next_page: false },
])('rejects invalid, missing or ambiguous brand pages %#', async (response) => {
  await expect(
    findProductionSourceBrand(
      vi.fn().mockResolvedValue(response),
      '101128',
      '42',
      'Original brand',
    ),
  ).rejects.toThrow('PRODUCTION_PILOT_');
});
it('refuses collector work without verified capability evidence before touching a connection', async () => {
  const f = await fixture();
  await expect(
    collectProductionBatchInput(
      {} as any,
      { manifestPath: f.path, expectedSha256: await f.save(), sourceKey: 'prepared-a' },
      {} as any,
    ),
  ).rejects.toThrow('PRODUCTION_BATCH_CAPABILITY_EVIDENCE_REQUIRED');
});

function readerFixture(alter?: (path: string, response: any) => void | Promise<void>) {
  const encryptionKey = '91'.repeat(32),
    box = new SecretBox(encryptionKey),
    owner = 'production:2010476:1423724897';
  const connection = {
    id: randomUUID(),
    state: 'connected',
    revision: 1,
    expires_at: new Date(Date.now() + 3600000),
    partner_key_ciphertext: box.seal({ partnerKey: 'FIXTURE-KEY' }, owner),
    token_ciphertext: box.seal({ accessToken: 'FIXTURE-TOKEN' }, owner),
  };
  const repo = { pool: { query: vi.fn().mockResolvedValue({ rows: [connection] }) } } as any;
  const calls: { path: string; method: string; query: Record<string, string> }[] = [];
  const transport = vi.fn(async (input: any, init: RequestInit) => {
    const url = new URL(String(input)),
      path = url.pathname;
    calls.push({ path, method: String(init.method), query: Object.fromEntries(url.searchParams) });
    let response: any;
    const raw: any = { error: '', request_id: 'fixture-request-' + calls.length };
    if (path.endsWith('get_shop_info'))
      Object.assign(raw, {
        shop_name: 'Vuatinhdau - Đại Lý Chính Hãng',
        region: 'VN',
        status: 'NORMAL',
      });
    else if (path.endsWith('get_item_list'))
      response =
        url.searchParams.get('item_status') === 'UNLIST'
          ? { total_count: 1, has_next_page: false, item: [{ item_id: 99, item_status: 'UNLIST' }] }
          : { total_count: 0, has_next_page: false };
    else if (path.endsWith('get_item_base_info'))
      response = {
        item_list: [
          {
            item_id: 99,
            item_sku: 'REFERENCE-SOURCE',
            item_name: 'Existing reference',
            has_model: true,
          },
        ],
      };
    else if (path.endsWith('get_model_list'))
      response = {
        model: [
          {
            model_id: 88,
            model_sku: 'REFERENCE-SKU',
            stock_info_v2: {
              seller_stock: [{ location_id: 'VNZ', stock: 100, if_saleable: true }],
              summary_info: { total_reserved_stock: 0, total_available_stock: 100 },
            },
          },
        ],
      };
    else if (path.endsWith('get_category'))
      response = { category_list: [{ category_id: 101128, has_children: false }] };
    else if (path.endsWith('get_item_limit'))
      response = { fixture: 'complete response retained for runner validation' };
    else if (path.endsWith('get_attribute_tree'))
      response = { list: [{ category_id: 101128, attribute_tree: [] }] };
    else if (path.endsWith('get_brand_list'))
      response =
        url.searchParams.get('offset') === '0'
          ? {
              brand_list: [{ brand_id: 1, original_brand_name: 'Other' }],
              has_next_page: true,
              next_offset: 900,
            }
          : {
              brand_list: [{ brand_id: 42, original_brand_name: 'Original brand' }],
              has_next_page: false,
            };
    else if (path.endsWith('get_channel_list'))
      response = { logistics_channel_list: [{ logistics_channel_id: 5001 }] };
    else if (path.endsWith('get_warehouse_detail')) raw.error = 'warehouse.error_not_in_whitelist';
    else throw Error('Unexpected endpoint');
    if (response) raw.response = response;
    await alter?.(path, raw);
    return new Response(JSON.stringify(raw), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const priorCapabilityEvidence = {
    environment: 'production' as const,
    partnerId: '2010476' as const,
    shopId: '1423724897' as const,
    connectionRevision: 1,
    gallery34: {
      state: 'supported' as const,
      observedAt: new Date().toISOString(),
      references: ['Verified fixture evidence'],
      verifiedOperationId: randomUUID(),
    },
    extendedDescription: {
      state: 'unsupported' as const,
      observedAt: new Date().toISOString(),
      references: ['Explicit earlier denial'],
    },
  };
  return { repo, calls, options: { encryptionKey, transport, priorCapabilityEvidence } };
}
it('collects isolated fresh GET evidence with manifest-bound stock, brand and preserved source values', async () => {
  const f = await fixture(),
    digest = await f.save(),
    reader = readerFixture();
  const result = await collectProductionBatchInput(
    reader.repo,
    { manifestPath: f.path, expectedSha256: digest, sourceKey: 'prepared-a' },
    reader.options,
  );
  expect(result.input.document).toEqual(f.value.listings[0]!.document);
  expect(result.sourceReceiptSha256).toBe(digest);
  expect(result.input.context.brandName).toBe('Original brand');
  expect(result.input.context.stockLocationBySku).toEqual({ 'SKU-A': null });
  expect(result.input.stockLocationEvidence?.expectedLocationBySku).toEqual({ 'SKU-A': 'VNZ' });
  expect(result.input.capabilityProbe).toBeUndefined();
  expect(result.input.capabilityEvidence.extendedDescription.state).toBe('unsupported');
  expect(
    result.evidenceFiles.every((path) =>
      path.startsWith(resolve(productionBatchPass1Root, 'evidence', f.value.batchId)),
    ),
  ).toBe(true);
  expect(reader.calls.every((call) => call.method === 'GET')).toBe(true);
  expect(
    reader.calls
      .filter((call) => call.path.endsWith('get_brand_list'))
      .map((call) => call.query.offset),
  ).toEqual(['0', '900']);
  expect(reader.calls.find((call) => call.path.endsWith('get_model_list'))?.query.item_id).toBe(
    '99',
  );
});
function dynamicAttributeTree() {
 return [{attribute_id:7,mandatory:true,attribute_info:{input_type:1,input_validation_type:0,format_type:1},attribute_value_list:[{value_id:70,name:'Parent',child_attribute_list:[{attribute_id:8,mandatory:true,attribute_info:{input_type:3,input_validation_type:1,format_type:2,attribute_unit_list:['g']},attribute_value_list:[]}]}]}];
}
it('blocks documented DATE selections before writer preparation until date readback comparison is supported',async()=>{
 const f=await fixture(),listing=f.value.listings[0]!;
 (listing as any).proposedAttributeList=[{attribute_id:7,attribute_value_list:[{value_id:0,original_value_name:'1634526913'}]}];listing.document.attributes={'7':['0']};
 const reader=readerFixture((path,raw)=>{if(path.endsWith('get_attribute_tree'))raw.response.list[0].attribute_tree=[{attribute_id:7,mandatory:true,attribute_info:{input_type:3,input_validation_type:4,date_format_type:0,format_type:1},attribute_value_list:[]}];});
 await expect(collectProductionBatchInput(reader.repo,{manifestPath:f.path,expectedSha256:await f.save(),sourceKey:'prepared-a'},reader.options)).rejects.toThrow('PRODUCTION_PILOT_ATTRIBUTE_DATE_READBACK_UNSUPPORTED');
 expect(reader.calls.every(call=>call.method==='GET')).toBe(true);
 expect(reader.calls.some(call=>call.path.endsWith('get_brand_list'))).toBe(false);
});
it('collects nested mandatory free-text attributes without changing source values or sending writes',async()=>{
 const f=await fixture(), listing=f.value.listings[0]!;
 (listing as any).proposedAttributeList=[{attribute_id:8,attribute_value_list:[{value_id:0,original_value_name:'130',value_unit:'g'}]},{attribute_id:7,attribute_value_list:[{value_id:70}]}];
 listing.document.attributes={'8':['0'],'7':['70']};
 const reader=readerFixture((path,raw)=>{if(path.endsWith('get_attribute_tree'))raw.response.list[0].attribute_tree=dynamicAttributeTree();});
 const result=await collectProductionBatchInput(reader.repo,{manifestPath:f.path,expectedSha256:await f.save(),sourceKey:'prepared-a'},reader.options);
 expect(result.input.context.attributeList).toEqual(listing.proposedAttributeList);
 expect(result.input.document).toEqual(listing.document);
 expect(reader.calls.every(call=>call.method==='GET')).toBe(true);
});
it('stops before later preflight work when an active mandatory child is absent',async()=>{
 const f=await fixture(),listing=f.value.listings[0]!;
 (listing as any).proposedAttributeList=[{attribute_id:7,attribute_value_list:[{value_id:70}]}];listing.document.attributes={'7':['70']};
 const reader=readerFixture((path,raw)=>{if(path.endsWith('get_attribute_tree'))raw.response.list[0].attribute_tree=dynamicAttributeTree();});
 await expect(collectProductionBatchInput(reader.repo,{manifestPath:f.path,expectedSha256:await f.save(),sourceKey:'prepared-a'},reader.options)).rejects.toThrow('PRODUCTION_PILOT_MANDATORY_ATTRIBUTE_MISSING');
 expect(reader.calls.some(call=>call.path.endsWith('get_brand_list'))).toBe(false);
});
it.each([{original_value_name:'130.9',value_unit:'g',code:'CUSTOM_ATTRIBUTE_UNVERIFIED'},{original_value_name:'130',value_unit:'kg',code:'ATTRIBUTE_UNIT_CHANGED'}])('rejects incompatible current free-text constraints ($code)',async bad=>{
 const f=await fixture(),listing=f.value.listings[0]!;
 (listing as any).proposedAttributeList=[{attribute_id:7,attribute_value_list:[{value_id:70}]},{attribute_id:8,attribute_value_list:[{value_id:0,original_value_name:bad.original_value_name,value_unit:bad.value_unit}]}];listing.document.attributes={'7':['70'],'8':['0']};
 const reader=readerFixture((path,raw)=>{if(path.endsWith('get_attribute_tree'))raw.response.list[0].attribute_tree=dynamicAttributeTree();});
 await expect(collectProductionBatchInput(reader.repo,{manifestPath:f.path,expectedSha256:await f.save(),sourceKey:'prepared-a'},reader.options)).rejects.toThrow('PRODUCTION_PILOT_'+bad.code);
});
it('skips duplicate inventory only for an explicit source waiver and still reads its exact stock reference',async()=>{
 const f=await fixture();(f.value.listings[0] as any).existingListingAuthorization={reason:'distinct_prepared_listing_test',authorizationReference:'Explicit confirmed distinct listing test'};
 const reader=readerFixture(),digest=await f.save();const result=await collectProductionBatchInput(reader.repo,{manifestPath:f.path,expectedSha256:digest,sourceKey:'prepared-a'},reader.options);
 expect(reader.calls.filter(call=>call.path.endsWith('get_item_list')||call.path.endsWith('get_item_base_info'))).toHaveLength(0);expect(reader.calls.filter(call=>call.path.endsWith('get_model_list')).map(call=>call.query.item_id)).toEqual(['99']);expect(result.inventoryCount).toBeNull();expect(result.input.document).toEqual(f.value.listings[0]!.document);
});
it('does not treat the old allowExistingListings boolean as permission to omit a new-create inventory scan',async()=>{
 const f=await fixture(),reader=readerFixture();await collectProductionBatchInput(reader.repo,{manifestPath:f.path,expectedSha256:await f.save(),sourceKey:'prepared-a'},{...reader.options,allowExistingListings:true});expect(reader.calls.filter(call=>call.path.endsWith('get_item_list'))).toHaveLength(4);
});
it('bounds repeated metadata work for the measured 55-item shop / 41-page brand scenario without caching item limits',async()=>{
 const f=await fixture();(f.value.listings[0] as any).existingListingAuthorization={reason:'distinct_prepared_listing_test',authorizationReference:'Explicit confirmed distinct listing test'};
 const reader=readerFixture((path,raw)=>{if(path.endsWith('get_brand_list')){const offset=Number(reader.calls.at(-1)!.query.offset);raw.response=offset===4000?{brand_list:[{brand_id:42,original_brand_name:'Original brand'}],has_next_page:false}:{brand_list:[{brand_id:1,original_brand_name:'Other'}],has_next_page:true,next_offset:offset+100};}});
 const digest=await f.save(),readSession=new ProductionPilotReadSession({batchId:f.value.batchId,manifestSha256:digest});const args={manifestPath:f.path,expectedSha256:digest,sourceKey:'prepared-a'};
 const first=await collectProductionBatchInput(reader.repo,args,{...reader.options,readSession});expect(reader.calls).toHaveLength(48);expect(reader.calls.filter(call=>call.path.endsWith('get_brand_list'))).toHaveLength(41);
 const second=await collectProductionBatchInput(reader.repo,args,{...reader.options,readSession});expect(reader.calls).toHaveLength(52);expect(reader.calls.filter(call=>call.path.endsWith('get_item_limit'))).toHaveLength(2);expect(reader.calls.some(call=>call.path.endsWith('get_item_list'))).toBe(false);expect(second.input.document).toEqual(first.input.document);
});
it('reuses metadata within one source-bound session but reads write-critical limits and stock reference again',async()=>{
 const f=await fixture();(f.value.listings[0] as any).existingListingAuthorization={reason:'distinct_prepared_listing_test',authorizationReference:'Explicit confirmed distinct listing test'};
 const reader=readerFixture(),digest=await f.save(),readSession=new ProductionPilotReadSession({batchId:f.value.batchId,manifestSha256:digest});
 const args={manifestPath:f.path,expectedSha256:digest,sourceKey:'prepared-a'},options={...reader.options,readSession};
 const first=await collectProductionBatchInput(reader.repo,args,options),mark=reader.calls.length,second=await collectProductionBatchInput(reader.repo,args,options);
 expect(reader.calls.slice(mark).map(call=>call.path.split('/').at(-1))).toEqual(['get_shop_info','get_model_list','get_item_limit','get_warehouse_detail']);
 expect(first.input.document).toEqual(second.input.document);const originalCategory=JSON.parse(await readFile(first.evidenceFiles.find(path=>path.endsWith('category.json'))!,'utf8'));expect(Date.parse(second.input.metadata.observedAt)).toBeGreaterThanOrEqual(Date.parse(originalCategory.observedAt));expect(Date.parse(second.input.metadata.expiresAt)).toBe(Date.parse(originalCategory.observedAt)+15*60*1000);
 const firstBrand=first.evidenceFiles.find(path=>path.endsWith('brands-0.json'));expect(second.evidenceFiles).toContain(firstBrand);
});

async function timedCollectorFixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-16T01:00:00.000Z'));
  const f = await fixture();
  const galleryId = randomUUID();
  f.value.listings[0]!.document.gallery = [{ ...f.value.listings[0]!.document.cover, importId: galleryId, width: 75 }];
  f.value.assets[galleryId] = f.image;
  (f.value.listings[0] as any).existingListingAuthorization = {
    reason: 'distinct_prepared_listing_test',
    authorizationReference: 'Explicit confirmed distinct listing test',
  };
  const reader = readerFixture((path, raw) => {
    // Distinct receipt times reproduce the real 403 ms shop-to-stock timing gap.
    vi.setSystemTime(Date.now() + 403);
    if (path.endsWith('get_model_list')) raw.response.model[0].stock_info_v2.shopee_stock = [];
    if (path.endsWith('get_item_limit')) raw.response = {
      price_limit: { min_limit: 1, max_limit: 1000000 },
      stock_limit: { min_limit: 0, max_limit: 1000000 },
      item_name_length_limit: { min_limit: 1, max_limit: 120 },
      item_image_count_limit: { min_limit: 1, max_limit: 9 },
      item_description_length_limit: { min_limit: 1, max_limit: 5000 },
      gtin_limit: { gtin_validation_rule: 'Optional' },
      size_chart_limit: { size_chart_mandatory: false },
    };
    if (path.endsWith('get_channel_list')) raw.response.logistics_channel_list = [{
      logistics_channel_id: 5001, enabled: true, fee_type: 'SIZE_INPUT',
      force_enable: false, mask_channel_id: 0, support_pause: false, compulsory_channel: false,
      weight_limit: { item_min_weight: 0, item_max_weight: 10 },
      item_max_dimension: { length: 200, width: 200, height: 200, unit: 'cm', dimension_sum: 0 },
      volume_limit: { item_min_volume: 0, item_max_volume: 0 },
    }];
  });
  const digest = await f.save();
  const readSession = new ProductionPilotReadSession({ batchId: f.value.batchId, manifestSha256: digest });
  const runner = new ProductionPilotRunner(reader.repo, {
    allowedSources: [{ sourceIdentity: f.value.listings[0]!.sourceIdentity, sourceRevision: 1 }],
    assetRoot: root, evidenceRoot: root,
  });
  // Exercise the actual pre-write validation/codec/stock guard without invoking a journal,
  // capability DB lookup, asset upload or Shopee writer. None of those methods is mocked.
  const validate = (input: ProductionPilotPreparedInput) =>
    (runner as unknown as { validate(value: ProductionPilotPreparedInput): unknown }).validate(input);
  const collect = () => collectProductionBatchInput(reader.repo,
    { manifestPath: f.path, expectedSha256: digest, sourceKey: 'prepared-a' },
    { ...reader.options, readSession });
  return { reader, collect, validate };
}

it.each(['cold', 'warm'])('validates collected %s-session stock evidence in the actual runner without renewing cached metadata', async warmth => {
  const test = await timedCollectorFixture();
  const first = await test.collect();
  let collected = first;
  if (warmth === 'warm') {
    vi.setSystemTime(Date.now() + 30000);
    collected = await test.collect();
  }
  const checked = test.validate(collected.input);
  expect(checked, JSON.stringify(checked)).toMatchObject({ kind: 'ready', stockLocations: { 'SKU-A': 'VNZ' } });
  const receipts = await Promise.all(collected.evidenceFiles.map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const times = receipts.map(receipt => Date.parse(receipt.observedAt));
  expect(Date.parse(collected.input.metadata.observedAt)).toBe(Math.max(...times));
  expect(Date.parse(collected.input.metadata.expiresAt)).toBe(Math.min(...times) + 15 * 60000);
  expect(Date.parse(collected.input.stockLocationEvidence!.observedAt)).toBeLessThanOrEqual(Date.parse(collected.input.metadata.observedAt));
  expect(collected.input.context.stockLocationBySku).toEqual({ 'SKU-A': null });
  if (warmth === 'warm') {
    const cached = first.evidenceFiles.find(path => path.endsWith('category.json'))!;
    expect(collected.evidenceFiles).toContain(cached);
    const category = JSON.parse(await readFile(cached, 'utf8'));
    expect(Date.parse(collected.input.metadata.expiresAt)).toBe(Date.parse(category.observedAt) + 15 * 60000);
    expect(test.reader.calls.filter(call => call.path.endsWith('get_category'))).toHaveLength(1);
    expect(test.reader.calls.filter(call => call.path.endsWith('get_model_list'))).toHaveLength(2);
    vi.setSystemTime(Date.parse(collected.input.metadata.expiresAt));
    expect(() => test.validate(collected.input)).toThrow('PRODUCTION_PILOT_METADATA_STALE_OR_MISMATCHED');
  }
  expect(test.reader.calls.every(call => call.method === 'GET')).toBe(true);
});
it.each(['existing_readback','publish'])('requires an exact acknowledged existing operation before any %s GET',async purpose=>{
 const f=await fixture(),reader=readerFixture();await expect(collectProductionBatchInput(reader.repo,{manifestPath:f.path,expectedSha256:await f.save(),sourceKey:'prepared-a'},{...reader.options,purpose} as any)).rejects.toThrow('EXISTING_OPERATION_REQUIRED');expect(reader.calls).toHaveLength(0);
});
it.each(['valid-readback','valid-publish','wrong-document','missing-ACK','wrong-item','unverified-publish'])('validates targeted existing-operation provenance: %s',async fault=>{
 const f=await fixture(),reader=readerFixture(),digest=await f.save(),source=f.value.listings[0]!;
 const connection=(await reader.repo.pool.query('fixture')).rows[0];
 const sourcePayload={sourceIdentity:source.sourceIdentity,sourceRevision:1,connectionId:connection.id,document:source.document,batchAuthorization:{manifestSha256:digest}};
 const expectedProjection={title:source.document.title},sourceFingerprint=sha(canonicalJson({scope:f.value.scope,sourceIdentity:source.sourceIdentity,sourceRevision:1,sourcePayload,expectedProjection}));
 const operation={id:randomUUID(),owner_key:'production:2010476:1423724897',connection_id:connection.id,source_identity:source.sourceIdentity,source_revision:1,source_fingerprint:sourceFingerprint,source_payload:structuredClone(sourcePayload),expected_projection:expectedProjection,item_id:'701',state:fault==='valid-publish'?'verified':'acknowledged',evidence_steps:[{step_key:'media-0',state:'acknowledged'},{step_key:'media-1',state:'acknowledged'},{step_key:'create',state:'acknowledged'}]};
 if(fault==='wrong-document')operation.source_payload.document.title='Changed';if(fault==='missing-ACK')operation.evidence_steps.pop();if(fault==='wrong-item')operation.item_id='702';
 reader.repo.pool.query.mockImplementation(async(sql:string)=>({rows:[sql.includes('production_pilot_operations')?operation:connection]}));
 const options={...reader.options,purpose:fault==='valid-readback'?'existing_readback':'publish',trustedExistingOperation:{operationId:operation.id,itemId:'701',sourceIdentity:source.sourceIdentity,sourceRevision:1,sourceFingerprint}} as any;
 const call=collectProductionBatchInput(reader.repo,{manifestPath:f.path,expectedSha256:digest,sourceKey:'prepared-a'},options);
 if(fault.startsWith('valid')){await call;expect(reader.calls.filter(call=>call.path.endsWith('get_item_list'))).toHaveLength(0);expect(reader.calls.filter(call=>call.path.endsWith('get_model_list')).map(call=>call.query.item_id)).toEqual(['99']);}
 else{await expect(call).rejects.toThrow('EXISTING_OPERATION_UNVERIFIED');expect(reader.calls).toHaveLength(0);}
});
it('rechecks source bytes after metadata collection rather than returning stale prepared input', async () => {
  const f = await fixture(),
    digest = await f.save();
  const reader = readerFixture(async (path) => {
    if (path.endsWith('get_channel_list')) await writeFile(f.md, 'changed during reads');
  });
  await expect(
    collectProductionBatchInput(
      reader.repo,
      { manifestPath: f.path, expectedSha256: digest, sourceKey: 'prepared-a' },
      reader.options,
    ),
  ).rejects.toThrow('SOURCE_FILE_CHANGED');
  expect(reader.calls.every((call) => call.method === 'GET')).toBe(true);
});
it.each([false, true])(
  'only accepts repeated real SKUs for a source with explicit duplicate-listing test authorization: %s',
  async (authorized) => {
    const f = await fixture();
    if (authorized)
      (f.value.listings[0] as any).existingListingAuthorization = {
        reason: 'distinct_prepared_listing_test',
        authorizationReference:
          'User explicitly selected this distinct prepared listing despite overlapping SKU',
      };
    const reader = readerFixture((path, raw) => {
      if (path.endsWith('get_model_list')) raw.response.model[0].model_sku = 'SKU-A';
    });
    const call = collectProductionBatchInput(
      reader.repo,
      { manifestPath: f.path, expectedSha256: await f.save(), sourceKey: 'prepared-a' },
      reader.options,
    );
    if (authorized) expect((await call).input.document).toEqual(f.value.listings[0]!.document);
    else await expect(call).rejects.toThrow('DUPLICATE_LISTING_OR_SKU');
    expect(reader.calls.every((call) => call.method === 'GET')).toBe(true);
  },
);
it('blocks duplicate attribute category metadata before using any tree', async () => {
  const f = await fixture(),
    reader = readerFixture((path, raw) => {
      if (path.endsWith('get_attribute_tree')) raw.response.list.push({ ...raw.response.list[0] });
    });
  await expect(
    collectProductionBatchInput(
      reader.repo,
      { manifestPath: f.path, expectedSha256: await f.save(), sourceKey: 'prepared-a' },
      reader.options,
    ),
  ).rejects.toThrow('ATTRIBUTE_TREE_UNVERIFIED');
});
it.each(['missing', 'duplicate', 'parent'])(
  'blocks %s source category and never registers or chooses another category',
  async (fault) => {
    const f = await fixture(),
      reader = readerFixture((path, raw) => {
        if (path.endsWith('get_category'))
          raw.response.category_list =
            fault === 'missing'
              ? []
              : fault === 'duplicate'
                ? [
                    { category_id: 101128, has_children: false },
                    { category_id: 101128, has_children: false },
                  ]
                : [{ category_id: 101128, has_children: true }];
      });
    await expect(
      collectProductionBatchInput(
        reader.repo,
        { manifestPath: f.path, expectedSha256: await f.save(), sourceKey: 'prepared-a' },
        reader.options,
      ),
    ).rejects.toThrow('CATEGORY_UNVERIFIED');
    expect(reader.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(
      reader.calls.some(
        (call) => call.path.includes('register') || call.path.includes('recommend'),
      ),
    ).toBe(false);
  },
);
