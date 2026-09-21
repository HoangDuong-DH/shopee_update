import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import { canonicalJson } from '@shopee/domain';
import { productionPilotWriteFingerprint } from '../../packages/shopee/src/production-pilot-transport.js';
vi.mock('../../apps/api/src/production-pilot-read-scheduler.js', () => ({
  readProductionPilotWithBackoff: async (client: any, path: string, query: any, record: any) => {
    const result = await client.read(path, query);
    await record(result, 0);
    return result;
  },
}));
import { ProductionPreparationMetadataService } from '../../apps/api/src/production-preparation-metadata.js';
const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' };
const encryptionKey = Buffer.alloc(32, 4).toString('hex'),
  owner = 'production:2010476:1423724897';
let directory: string,
  now: number,
  connection: any,
  responses: Record<string, any>,
  calls: URL[],
  proofRows: any[];
beforeEach(async () => {
  const root = resolve('.local/preparation-metadata-unit');
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(resolve(root, 'case-'));
  now = Date.now();
  const box = new SecretBox(encryptionKey);
  connection = {
    id: randomUUID(),
    environment: 'production',
    partner_id: '2010476',
    shop_id: '1423724897',
    state: 'connected',
    revision: 2,
    expires_at: new Date(now + 3_600_000),
    partner_key_ciphertext: box.seal({ partnerKey: 'fixture-key' }, owner),
    token_ciphertext: box.seal({ accessToken: 'fixture-token' }, owner),
  };
  calls = [];
  proofRows = [];
  responses = {
    get_shop_info: {
      shop_name: 'Shop từ kết nối',
      shop_id: 1423724897,
      status: 'NORMAL',
      region: 'VN',
    },
    get_category: {
      category_list: [
        {
          category_id: 1,
          parent_category_id: 0,
          display_category_name: 'Nhà cửa',
          original_category_name: 'Home',
          has_children: true,
        },
        {
          category_id: 2,
          parent_category_id: 1,
          display_category_name: 'Tinh dầu',
          original_category_name: 'Oil',
          has_children: false,
        },
        {
          category_id: 3,
          parent_category_id: 1,
          display_category_name: 'Khử mùi',
          original_category_name: 'Deodorizer',
          has_children: false,
        },
      ],
    },
    get_attribute_tree: {
      list: [
        {
          category_id: 2,
          attribute_tree: [
            {
              attribute_id: 7,
              name: 'Mùi',
              mandatory: true,
              attribute_info: {
                input_type: 5,
                input_validation_type: 2,
                format_type: 1,
                max_value_count: 5,
                attribute_unit_list: ['ml'],
                support_search_value: false,
              },
              attribute_value_list: [
                {
                  value_id: 8,
                  name: 'Sả',
                  value_unit: '',
                  child_attribute_list: [
                    {
                      attribute_id: 9,
                      name: 'Màu',
                      mandatory: false,
                      attribute_info: { input_type: 1 },
                      attribute_value_list: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    get_brand_list: {
      brand_list: [
        { brand_id: 0, original_brand_name: 'No Brand', display_brand_name: 'Không thương hiệu' },
        { brand_id: 41, original_brand_name: 'VINA TƯƠI', display_brand_name: 'Vina Tươi' },
      ],
      has_next_page: false,
      is_mandatory: true,
      input_type: 'DROP_DOWN',
    },
    get_channel_list: {
      logistics_channel_list: [
        {
          logistics_channel_id: 5001,
          logistics_channel_name: 'Nhanh',
          enabled: true,
          force_enable: false,
          compulsory_channel: true,
          fee_type: 'SIZE_INPUT',
          mask_channel_id: 0,
          weight_limit: { item_min_weight: 0, item_max_weight: 30 },
          item_max_dimension: {
            unit: 'cm',
            height: 100,
            width: 100,
            length: 100,
            dimension_sum: 200,
          },
          channel_relation_rules: {
            related_enabled_channels: [5004],
            related_dependent_block_channels: [],
          },
        },
      ],
    },
    get_item_limit: {
      price_limit: { min_limit: 1000, max_limit: 1_000_000 },
      size_chart_limit: { support_image_size_chart: false },
      weight_limit: { weight_mandatory: true },
    },
    get_item_list: {
      item: [{ item_id: 99, item_status: 'NORMAL' }],
      total_count: 1,
      has_next_page: false,
    },
    get_item_base_info: {
      item_list: [
        {
          item_id: 99,
          item_name: 'Nguồn tham chiếu',
          item_sku: 'OLD-99',
          item_status: 'NORMAL',
          category_id: 2,
        },
      ],
    },
    get_model_list: {
      model: [
        {
          model_id: 44,
          model_sku: 'REF-A',
          stock_info_v2: { seller_stock: [{ location_id: 'VNZ', stock: 100, if_saleable: true }] },
        },
      ],
    },
    get_warehouse_detail: {
      error: 'warehouse.error_not_in_whitelist',
      request_id: 'warehouse-denied',
    },
  };
});
function fixture() {
  const repo = {
    pool: {
      query: vi.fn(async (sql: string) => ({
        rows: structuredClone(
          sql.includes('production_pilot_operations') ? proofRows : [connection],
        ),
      })),
    },
  };
  const transport = vi.fn(async (input: any, init: any) => {
    const url = new URL(String(input));
    calls.push(url);
    expect(init.method).toBe('GET');
    expect(url.host).toBe('partner.shopeemobile.com');
    expect(url.searchParams.get('shop_id')).toBe(scope.shopId);
    const endpoint = url.pathname.split('/').at(-1)!;
    const value =
      typeof responses[endpoint] === 'function' ? responses[endpoint](url) : responses[endpoint];
    return new Response(
      JSON.stringify(
        value?.error
          ? value
          : {
              error: '',
              request_id: 'fixture-request-' + calls.length,
              ...(endpoint === 'get_shop_info' ? value : { response: value }),
            },
      ),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return {
    repo,
    service: new ProductionPreparationMetadataService(repo as any, {
      transport,
      encryptionKey,
      evidenceRoot: directory,
      now: () => now,
      cacheTtlMs: 60_000,
    }),
  };
}
it('stops subsequent metadata reads when the operator cancels an in-flight read', async () => {
  const controller = new AbortController();
  const first = responses.get_shop_info;
  responses.get_shop_info = () => { controller.abort(new Error('operator-cancelled')); return first; };
  await expect(fixture().service.get({ categoryId: '2' }, controller.signal)).rejects.toThrow('operator-cancelled');
  expect(calls).toHaveLength(1);
});
it('returns operator choices and exact leaf paths, with no assumed category authorization or default reference', async () => {
  const { service } = fixture();
  const result = await service.get({ categoryId: '2' });
  expect(result.shop).toEqual({ id: '1423724897', name: 'Shop từ kết nối' });
  expect(result.categories).toEqual([
    { id: '2', label: 'Tinh dầu', path: 'Nhà cửa > Tinh dầu', isLeaf: true },
    { id: '3', label: 'Khử mùi', path: 'Nhà cửa > Khử mùi', isLeaf: true },
  ]);
  expect(result.categoryAuthorizationVerified).toBe(false);
  expect(result.reference).toBeUndefined();
  expect(calls.some((c) => c.pathname.endsWith('get_model_list'))).toBe(false);
  expect(result.attributes?.[0]).toMatchObject({
    id: '7',
    label: 'Mùi',
    mandatory: true,
    inputType: 'multi_combobox',
    units: ['ml'],
    maxValueCount: 5,
  });
  expect(result.attributes?.[0]?.values[0]?.children[0]).toMatchObject({ id: '9', label: 'Màu' });
  expect(result.brands?.items[0]).toEqual({
    id: '0',
    name: 'No Brand',
    label: 'Không thương hiệu',
  });
  expect(result.channels[0]).toMatchObject({
    id: '5001',
    enabled: true,
    forceEnabled: false,
    compulsory: true,
    relatedEnabledChannelIds: ['5004'],
  });
  expect(result.itemLimits?.sizeChart.mandatory).toBeNull();
  expect(result.itemLimits?.sizeChart.supportImage).toBe(false);
  expect(result.inventory?.items).toEqual([
    { itemId: '99', title: 'Nguồn tham chiếu', itemSku: 'OLD-99', status: 'NORMAL' },
  ]);
  const publicJson = JSON.stringify(result);
  expect(publicJson).not.toContain('fixture-key');
  expect(publicJson).not.toContain('fixture-token');
  expect(publicJson).not.toContain(directory);
});
it('reads only an explicitly selected current-shop reference and keeps location observation separate from write mapping', async () => {
  const { service } = fixture();
  const result = await service.get({ referenceItemId: '99', includeInventory: false });
  expect(result.reference).toMatchObject({
    itemId: '99',
    title: 'Nguồn tham chiếu',
    modelCount: 1,
    writeMappingVerified: false,
    stockLocations: [{ id: 'VNZ', saleable: true, modelIds: ['44'] }],
  });
  expect(
    calls
      .filter((c) => c.pathname.endsWith('get_model_list'))
      .map((c) => c.searchParams.get('item_id')),
  ).toEqual(['99']);
});
it('retains original cache provenance while always fetching fresh item limits and shop identity', async () => {
  const { service } = fixture();
  const a = await service.get({ categoryId: '2', includeInventory: false });
  now += 1000;
  responses.get_item_limit.price_limit.max_limit = 900_000;
  const b = await service.get({ categoryId: '2', includeInventory: false });
  expect(calls.filter((c) => c.pathname.endsWith('get_category'))).toHaveLength(1);
  expect(calls.filter((c) => c.pathname.endsWith('get_item_limit'))).toHaveLength(2);
  expect(calls.filter((c) => c.pathname.endsWith('get_shop_info'))).toHaveLength(2);
  expect(b.evidence.find((e) => e.path.endsWith('get_category'))).toEqual({
    ...a.evidence.find((e) => e.path.endsWith('get_category')),
    cacheHit: true,
  });
  expect(b.itemLimits?.price.max).toBe(900_000);
  const readFolders = await readdir(directory);
  const all = await Promise.all(
    readFolders.flatMap(async (d) => {
      const files = await readdir(resolve(directory, d));
      return Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map((f) => readFile(resolve(directory, d, f), 'utf8')),
      );
    }),
  );
  expect(all.flat().join('')).not.toContain('fixture-token');
  expect(all.flat().join('')).not.toContain('fixture-key');
});
it('invalidates cached metadata after TTL or connection revision change', async () => {
  const { service } = fixture();
  await service.get({ includeInventory: false });
  now += 60_001;
  await service.get({ includeInventory: false });
  connection.revision++;
  await service.get({ includeInventory: false });
  expect(calls.filter((c) => c.pathname.endsWith('get_category'))).toHaveLength(3);
});
it('uses returned opaque numeric brand offset and exact names without aliasing or auto-selecting duplicate names', async () => {
  responses.get_brand_list = (url: URL) =>
    url.searchParams.get('offset') === '0'
      ? {
          brand_list: [{ brand_id: 1, original_brand_name: 'Other' }],
          has_next_page: true,
          next_offset: 19001,
          is_mandatory: true,
        }
      : {
          brand_list: [
            { brand_id: 2, original_brand_name: 'VINA TƯƠI' },
            { brand_id: 3, original_brand_name: 'VINA TƯƠI' },
            { brand_id: 4, original_brand_name: 'Vina Tươi' },
          ],
          has_next_page: false,
          is_mandatory: true,
        };
  const { service } = fixture();
  const result = await service.get({
    categoryId: '2',
    brandName: 'VINA TƯƠI',
    includeInventory: false,
  });
  expect(
    calls
      .filter((c) => c.pathname.endsWith('get_brand_list'))
      .map((c) => c.searchParams.get('offset')),
  ).toEqual(['0', '19001']);
  expect(result.brands?.items.map((b) => b.id)).toEqual(['2', '3']);
  expect(result.brands?.searchComplete).toBe(true);
});
it.each([false, true])('deduplicates identical brand IDs with recorded evidence, across pages: %s', async (acrossPages) => {
  const repeated = { brand_id: 4310858, original_brand_name: 'HOOKA', display_brand_name: 'HOOKA' };
  const target = { brand_id: 41, original_brand_name: 'VINA TƯƠI', display_brand_name: 'Vina Tươi' };
  responses.get_brand_list = (url: URL) => acrossPages && url.searchParams.get('offset') === '0'
    ? { brand_list: [repeated, target], has_next_page: true, next_offset: 19001 }
    : { brand_list: acrossPages ? [repeated, target] : [repeated, { ...repeated }, target], has_next_page: false };
  const { service } = fixture();
  const result = await service.get({ categoryId: '2', brandName: 'VINA TƯƠI', includeInventory: false });
  expect(result.brands?.items).toEqual([{ id: '41', name: 'VINA TƯƠI', label: 'Vina Tươi' }]);
  expect(result.brands?.searchComplete).toBe(true);
  expect((result.brands as any).anomalies).toContainEqual({ code: 'DUPLICATE_IDENTICAL_BRAND', brandId: '4310858', offset: acrossPages ? 19001 : 0 });
  if (acrossPages) expect((result.brands as any).anomalies).toContainEqual({ code: 'DUPLICATE_IDENTICAL_BRAND', brandId: '41', offset: 19001 });
});
it.each([
  { acrossPages: false, field: 'original_brand_name' },
  { acrossPages: false, field: 'display_brand_name' },
  { acrossPages: true, field: 'original_brand_name' },
  { acrossPages: true, field: 'display_brand_name' },
])('rejects conflicting brand records for the same ID: %j', async ({ acrossPages, field }) => {
  const first = { brand_id: 41, original_brand_name: 'VINA TƯƠI', display_brand_name: 'Vina Tươi' };
  const conflicting = { ...first, [field]: 'A different brand' };
  responses.get_brand_list = (url: URL) => acrossPages && url.searchParams.get('offset') === '0'
    ? { brand_list: [first], has_next_page: true, next_offset: 19001 }
    : { brand_list: acrossPages ? [conflicting] : [first, conflicting], has_next_page: false };
  const { service } = fixture();
  await expect(service.get({ categoryId: '2', brandName: 'VINA TƯƠI', includeInventory: false })).rejects.toThrow('PRODUCTION_PREPARATION_BRANDS_INVALID');
});
it.each([
  { shopId: 'other' },
  { categoryId: '0' },
  { categoryId: '2', brandOffset: -1 },
  { brandName: 'VINA TƯƠI' },
  { categoryId: '2', brandName: 'VINA TƯƠI', brandOffset: 2 },
  { referenceItemId: '99&shop_id=7' },
  { inventoryStatus: 'SELLER_DELETE' },
])('rejects malformed or unscoped browser query before any API call %#', async (input) => {
  const { service } = fixture();
  await expect(service.get(input as any)).rejects.toThrow('PRODUCTION_PREPARATION_QUERY_INVALID');
  expect(calls).toHaveLength(0);
});
it.each(['expired', 'wrong-shop', 'disconnected'])(
  'rejects %s stored connection before the API',
  async (kind) => {
    if (kind === 'expired') connection.expires_at = new Date(now - 1);
    if (kind === 'wrong-shop') connection.shop_id = '123';
    if (kind === 'disconnected') connection.state = 'disconnected';
    const { service } = fixture();
    await expect(service.get()).rejects.toThrow('PRODUCTION_PREPARATION_AUTH_REQUIRED');
    expect(calls).toHaveLength(0);
  },
);
it('detects revision changes during the read and does not return mixed context', async () => {
  responses.get_category = () => {
    connection.revision++;
    return { category_list: [] };
  };
  const { service } = fixture();
  await expect(service.get({ includeInventory: false })).rejects.toThrow(
    'PRODUCTION_PREPARATION_CONNECTION_CHANGED',
  );
});
it.each(['duplicate', 'cycle', 'missing-parent', 'nonleaf'])(
  'fails closed for category tree %s instead of selecting a fallback',
  async (kind) => {
    if (kind === 'duplicate')
      responses.get_category.category_list.push({ ...responses.get_category.category_list[1] });
    if (kind === 'cycle') responses.get_category.category_list[0].parent_category_id = 2;
    if (kind === 'missing-parent') responses.get_category.category_list[1].parent_category_id = 888;
    const { service } = fixture();
    await expect(
      service.get({ categoryId: kind === 'nonleaf' ? '1' : '2', includeInventory: false }),
    ).rejects.toThrow('PRODUCTION_PREPARATION_CATEGORY');
    expect(calls.some((c) => c.pathname.endsWith('get_item_limit'))).toBe(false);
  },
);
it('retains searchable/unsupported attribute information rather than pretending empty choices are complete', async () => {
  responses.get_attribute_tree.list[0].attribute_tree[0].attribute_info.support_search_value = true;
  const { service } = fixture();
  const result = await service.get({ categoryId: '2', includeInventory: false });
  expect(result.attributes?.[0]?.searchRequired).toBe(true);
});
it('rejects malformed relation rules instead of interpreting them as no channel dependencies', async () => {
  responses.get_channel_list.logistics_channel_list[0].channel_relation_rules = 'unparsed';
  const { service } = fixture();
  await expect(service.get({ includeInventory: false })).rejects.toThrow(
    'PRODUCTION_PREPARATION_CHANNEL_RELATIONS_INVALID',
  );
});
it('rejects reference response identity mismatch and does not read models of a different item', async () => {
  responses.get_item_base_info.item_list[0].item_id = 100;
  const { service } = fixture();
  await expect(service.get({ referenceItemId: '99', includeInventory: false })).rejects.toThrow(
    'PRODUCTION_PREPARATION_REFERENCE_INVALID',
  );
  expect(calls.some((c) => c.pathname.endsWith('get_model_list'))).toBe(false);
});
it('does not cache authorization errors or include raw upstream messages in thrown errors', async () => {
  responses.get_category = {
    error: 'error_auth',
    request_id: 'denied',
    message: 'fixture-token secret raw',
  };
  const { service } = fixture();
  await expect(service.get({ includeInventory: false })).rejects.toThrow(
    /^PRODUCTION_PREPARATION_READ_FAILED$/,
  );
  await expect(service.get({ includeInventory: false })).rejects.toThrow(
    /^PRODUCTION_PREPARATION_READ_FAILED$/,
  );
  expect(calls.filter((c) => c.pathname.endsWith('get_category'))).toHaveLength(2);
});
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function addVerifiedStockProof() {
  const operationId = randomUUID(),
    image = {
      importId: randomUUID(),
      sha256: 'a'.repeat(64),
      width: 100,
      height: 100,
      mime: 'image/png',
    };
  const document = {
    sourceKey: 'source-test',
    title: 'Original',
    description: [{ type: 'text', text: 'Original' }],
    cover: image,
    gallery: [image],
    tierNames: [],
    models: [
      { sku: 'SOURCE-A', optionLabels: [], tierIndex: [], originalPrice: '1000', stock: 100 },
    ],
    categoryId: '2',
    brandId: '0',
    attributes: {},
    logistics: [],
    publication: 'unlisted',
    weightGrams: 100,
    dimensionCm: { length: 1, width: 1, height: 1 },
  };
  const source_payload = {
    sourceIdentity: 'source-test',
    sourceRevision: 1,
    connectionId: connection.id,
    connectionRevision: 1,
    document,
    stockLocationEvidence: {
      ...scope,
      connectionRevision: 1,
      expectedLocationBySku: { 'SOURCE-A': 'VNZ' },
    },
    context: { stockLocationBySku: { 'SOURCE-A': null } },
  };
  const expected_projection = {
    status: 'UNLIST',
    models: [{ sku: 'SOURCE-A', stock: 100, stockLocation: 'VNZ' }],
  };
  const operation = {
    id: operationId,
    item_id: '101',
    owner_key: owner,
    state: 'verified',
    revision: 4,
    connection_id: connection.id,
    connection_revision: 1,
    source_identity: 'source-test',
    source_revision: 1,
    source_payload,
    expected_projection,
    source_fingerprint: digest({
      scope,
      sourceIdentity: 'source-test',
      sourceRevision: 1,
      sourcePayload: source_payload,
      expectedProjection: expected_projection,
    }),
  };
  const payload = { item_status: 'UNLIST', seller_stock: [{ stock: 100 }] };
  const receipt = { kind: 'success', response: { item_id: 101 }, requestId: 'create-receipt' };
  const steps = [
    {
      step_key: 'media-0',
      kind: 'media',
      path: '/api/v2/media_space/upload_image',
      state: 'acknowledged',
    },
    {
      step_key: 'media-1',
      kind: 'media',
      path: '/api/v2/media_space/upload_image',
      state: 'acknowledged',
    },
    {
      step_key: 'create',
      kind: 'create',
      path: '/api/v2/product/add_item',
      state: 'acknowledged',
      payload,
      fingerprint: productionPilotWriteFingerprint('/api/v2/product/add_item', payload),
      receipt,
      outcome_fingerprint: digest(receipt),
    },
  ];
  const readbacks = [0, 1].map((i) => {
    const raw = { item: { item_id: 101 }, models: { model: [] } },
      projection = expected_projection;
    return {
      ...scope,
      itemId: '101',
      observedAt: new Date(now - 5000 + i * 1000).toISOString(),
      requestIds: ['read-' + i],
      raw,
      projection,
      rawSha256: digest(raw),
      projectionSha256: digest(projection),
    };
  });
  const verification = {
    id: randomUUID(),
    operation_id: operationId,
    operation_revision: 3,
    item_id: '101',
    phase: 'created_unlisted',
    expected_fingerprint: digest(expected_projection),
    readbacks,
    evidence_fingerprint: digest(readbacks),
  };
  proofRows = [{ operation, steps, verification }];
  responses.get_model_list.model[0].stock_info_v2 = {
    summary_info: { total_reserved_stock: 0, total_available_stock: 100 },
    seller_stock: [{ location_id: 'VNZ', stock: 100, if_saleable: true }],
    shopee_stock: [],
  };
}
it('offers stock write mapping only from verified same-shop journal plus fresh exact single-location reference and warehouse evidence', async () => {
  addVerifiedStockProof();
  const { service } = fixture();
  const result = await service.get({ referenceItemId: '99', includeInventory: false });
  expect(result.reference).toMatchObject({
    writeMappingVerified: true,
    writeMapping: {
      expectedLocationId: 'VNZ',
      writeLocationId: null,
      verifiedOperationId: proofRows[0].operation.id,
      verificationFingerprint: proofRows[0].verification.evidence_fingerprint,
      warehouseRequestId: 'warehouse-denied',
    },
  });
});
it.each([
  'corrupt-proof',
  'wrong-scope',
  'payload-changed',
  'missing-media',
  'changed-location',
  'reserved-stock',
  'warehouse-available',
])('does not infer a stock mapping when %s', async (kind) => {
  addVerifiedStockProof();
  if (kind === 'corrupt-proof') proofRows[0].verification.readbacks[0].raw.item.item_id = 102;
  if (kind === 'wrong-scope') proofRows[0].operation.owner_key = 'production:other:shop';
  if (kind === 'payload-changed')
    proofRows[0].steps[2].payload.seller_stock[0].location_id = 'OTHER';
  if (kind === 'missing-media') proofRows[0].steps.shift();
  if (kind === 'changed-location')
    responses.get_model_list.model[0].stock_info_v2.seller_stock[0].location_id = 'ABC';
  if (kind === 'reserved-stock')
    responses.get_model_list.model[0].stock_info_v2.summary_info.total_reserved_stock = 1;
  if (kind === 'warehouse-available') responses.get_warehouse_detail = [];
  const { service } = fixture();
  const result = await service.get({ referenceItemId: '99', includeInventory: false });
  expect(result.reference?.writeMappingVerified).toBe(false);
  expect(result.reference?.writeMapping).toBeUndefined();
});
