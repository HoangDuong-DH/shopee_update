import { expect, it, vi } from 'vitest';
import * as gateway from '../../packages/shopee/src/index.js';

const credentials = {
  environment: 'sandbox' as const,
  partnerId: '1232297',
  shopId: '227418363',
  accessToken: 'fixture-token-create',
  partnerKey: 'fixture-key-create',
};
const payload = (): gateway.CreateUnlistedPayload => ({
  original_price: 20000,
  description: 'SANDBOX QA synthetic notebook.\n\nKeep exact source.',
  description_type: 'normal' as const,
  weight: 0.2,
  item_name: 'SANDBOX QA notebook A01',
  item_sku: 'SBX-BULK-A01',
  item_status: 'UNLIST' as const,
  category_id: 301378,
  dimension: { package_height: 2, package_length: 21, package_width: 15 },
  logistic_info: [{ enabled: true, logistic_id: 51022, is_free: false }],
  attribute_list: [{ attribute_id: 200134, attribute_value_list: [{ value_id: 101205 }] }],
  brand: { brand_id: 0, original_brand_name: 'No Brand' },
  condition: 'NEW' as const,
  pre_order: { is_pre_order: false as const },
  seller_stock: [{ stock: 0 }],
  image: { image_ratio: '1:1' as const, image_id_list: ['fixture-image'] },
});
const tiers = () => ({
  item_id: 9001,
  standardise_tier_variation: [
    {
      variation_id: 0 as const,
      variation_name: 'Màu',
      variation_option_list: [
        { variation_option_id: 0 as const, variation_option_name: 'Cam', image_id: 'orange' },
        { variation_option_id: 0 as const, variation_option_name: 'Xanh', image_id: 'blue' },
      ],
    },
  ],
  model: [
    {
      tier_index: [0],
      model_sku: 'SBX-BULK-A01-CAM',
      original_price: 20000,
      seller_stock: [{ stock: 3 }],
    },
    {
      tier_index: [1],
      model_sku: 'SBX-BULK-A01-XANH',
      original_price: 20000,
      seller_stock: [{ stock: 4 }],
    },
  ],
});
const success = (response: unknown) =>
  new Response(JSON.stringify({ error: '', response, request_id: 'fixture-request' }));
const client = (transport: typeof fetch) => new gateway.SandboxCreateClient(credentials, transport);

it('exports the bounded creation client', () => {
  expect(gateway.SandboxCreateClient).toBeTypeOf('function');
});
it('signs an exact UNLIST payload for only the fixed sandbox and preserves source text', async () => {
  const transport = vi.fn(async () => success({ item_id: 9001 }));
  expect(await client(transport).createUnlisted(payload())).toMatchObject({
    kind: 'success',
    data: { itemId: '9001' },
  });
  const [raw, init] = transport.mock.calls[0] as unknown as [URL, RequestInit];
  const url = new URL(raw);
  expect(url.origin).toBe('https://openplatform.sandbox.test-stable.shopee.sg');
  expect(url.pathname).toBe('/api/v2/product/add_item');
  expect(url.searchParams.get('shop_id')).toBe(credentials.shopId);
  expect(url.searchParams.get('sign')).toBe(
    gateway.signRequest({
      ...credentials,
      path: url.pathname,
      timestamp: Number(url.searchParams.get('timestamp')),
    }),
  );
  expect(init.redirect).toBe('error');
  expect(JSON.parse(String(init.body))).toEqual(payload());
});
it.each([{ environment: 'production' }, { partnerId: '1' }, { shopId: '1' }])(
  'rejects another environment/partner/shop before transport: %j',
  (change) => {
    const transport = vi.fn();
    expect(
      () =>
        new gateway.SandboxCreateClient(
          { ...credentials, ...change } as typeof credentials,
          transport,
        ),
    ).toThrow('SANDBOX_CREATE_SCOPE_INVALID');
    expect(transport).not.toHaveBeenCalled();
  },
);
it.each([
  { item_status: 'NORMAL' },
  { item_sku: 'LMKT5DT100' },
  { item_name: 'Real product' },
  { image: { image_ratio: '3:4', image_id_list: ['image'] } },
  { scheduled_publish_time: 123 },
  { promotion_images: { image_id_list: ['cover'] } },
  { description_type: 'extended' },
  { seller_stock: [{ stock: -1 }] },
  { original_price: 10.5 },
  { pre_order: { is_pre_order: true } },
  { medicine_id: 1 },
])('rejects out-of-trial create payload before transport: %j', async (change) => {
  const transport = vi.fn();
  await expect(
    client(transport).createUnlisted({ ...payload(), ...change } as any),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
it('uses repeated status query values and retains cursor and counts', async () => {
  const transport = vi.fn(async () =>
    success({
      item: [{ item_id: 9001, item_status: 'UNLIST' }],
      has_next_page: true,
      next_offset: 100,
      total_count: 101,
    }),
  );
  const result = await client(transport).listItemsPage({
    offset: 0,
    statuses: ['UNLIST', 'REVIEWING'],
  });
  expect(result).toMatchObject({ kind: 'success', data: { next_offset: 100, total_count: 101 } });
  const url = new URL(String((transport.mock.calls[0] as any)[0]));
  expect(url.searchParams.getAll('item_status')).toEqual(['UNLIST', 'REVIEWING']);
  expect(url.searchParams.get('page_size')).toBe('100');
});
it('retains metadata needed for dynamic creation preflight', async () => {
  const responses = [
    { category_list: [{ category_id: 301378, has_children: false }] },
    {
      list: [
        {
          category_id: 301378,
          attribute_tree: [{ mandatory: true, attribute_info: { support_search_value: true } }],
        },
      ],
    },
    { brand_list: [], is_mandatory: false, has_next_page: false, next_offset: 0 },
    {
      price_limit: { min_limit: 2, max_limit: 99999 },
      stock_limit: { min_limit: 0, max_limit: 1000 },
      item_count_limit: { max_limit: 100 },
      gtin_limit: { gtin_validation_rule: 'Flexible' },
      dts_limit: { non_pre_order_days_to_ship: 2 },
    },
    {
      logistics_channel_list: [
        {
          logistics_channel_id: 51022,
          enabled: true,
          compulsory_channel: true,
          channel_relation_rules: [{ related_enabled_channels: [51023] }],
        },
      ],
    },
  ];
  let index = 0;
  const transport = vi.fn(async () => success(responses[index++]));
  const c = client(transport);
  const results = [
    await c.categories(),
    await c.attributes('301378'),
    await c.brands('301378'),
    await c.creationLimits('301378'),
    await c.channels(),
  ];
  results.forEach((result, i) =>
    expect(result).toMatchObject({ kind: 'success', data: responses[i] }),
  );
});
it('reads exact base identities and unmodified model fields for independent QC', async () => {
  const items = [
    { item_id: 9002, item_sku: 'SBX-BULK-B', description: ' B\n\n' },
    { item_id: 9001, item_sku: 'SBX-BULK-A', image: { image_id_list: ['i'] } },
  ];
  const models = {
    model: [
      {
        model_id: 10,
        model_sku: 'SBX-BULK-B',
        tier_index: [1],
        stock_info_v2: { seller_stock: [{ stock: 4 }] },
      },
      { model_id: 9, model_sku: 'SBX-BULK-A', tier_index: [0] },
    ],
    tier_variation: [
      { name: 'Màu', option_list: [{ option: 'Cam', image: { image_id: 'orange' } }] },
    ],
  };
  const transport = vi
    .fn()
    .mockImplementationOnce(async () => success({ item_list: items }))
    .mockImplementationOnce(async () => success(models));
  const c = client(transport);
  expect(await c.readBaseItems(['9001', '9002'])).toMatchObject({ kind: 'success', data: items });
  expect(await c.readModels('9001')).toMatchObject({ kind: 'success', data: models });
});
it.each([
  { items: [{ item_id: 9001 }, { item_id: 9001 }] },
  { items: [{ item_id: 9001 }] },
  { items: [{ item_id: 9001 }, { item_id: 9999 }] },
])('rejects missing/duplicate/unrequested base item identities', async ({ items }) => {
  expect(
    await client(async () => success({ item_list: items })).readBaseItems(['9001', '9002']),
  ).toMatchObject({ kind: 'unknown', reason: 'invalid_response' });
});
it('allows exact small zero-tier and two-tier fixtures with declared no GTIN', async () => {
  const zero: gateway.InitTiersPayload = {
    item_id: 9001,
    standardise_tier_variation: [],
    model: [
      {
        tier_index: [],
        model_sku: 'SBX-BULK-ZERO',
        original_price: 20000,
        seller_stock: [{ stock: 0 }],
        gtin_code: '00',
      },
    ],
  };
  const two: gateway.InitTiersPayload = tiers();
  two.standardise_tier_variation.push({
    variation_id: 0,
    variation_name: 'Quy cách',
    variation_option_list: [
      { variation_option_id: 0, variation_option_name: '1 quyển' },
      { variation_option_id: 0, variation_option_name: '2 quyển' },
    ],
  });
  two.model = [0, 1].flatMap((color) =>
    [0, 1].map((size) => ({
      tier_index: [color, size],
      model_sku: `SBX-BULK-${color}-${size}`,
      original_price: 20000,
      seller_stock: [{ stock: color + size }],
      gtin_code: '00' as const,
    })),
  );
  const transport = vi.fn(async () => success({ item_id: 9001 }));
  const c = client(transport);
  expect((await c.createUnlisted({ ...payload(), gtin_code: '00' })).kind).toBe('success');
  expect((await c.initializeTiers(zero)).kind).toBe('success');
  expect((await c.initializeTiers(two)).kind).toBe('success');
  expect(JSON.parse(String((transport.mock.calls[2] as any)[1].body))).toEqual(two);
});
it('rejects unsupported category and malformed metadata, cursors and model identities', async () => {
  const transport = vi.fn();
  await expect(
    client(transport).createUnlisted({ ...payload(), category_id: 300018 } as any),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  expect((await client(async () => success({ category_list: {} })).categories()).kind).toBe(
    'unknown',
  );
  expect(
    (
      await client(async () =>
        success({ item: [], total_count: 1, has_next_page: true, next_offset: 0 }),
      ).listItemsPage({ offset: 0, statuses: ['UNLIST'] })
    ).kind,
  ).toBe('unknown');
  expect(
    (
      await client(async () =>
        success({ model: [{ model_id: 1 }, { model_id: 1 }], tier_variation: [] }),
      ).readModels('9001')
    ).kind,
  ).toBe('unknown');
  expect((await client(async () => success({ item_id: 9002 })).initializeTiers(tiers())).kind).toBe(
    'unknown',
  );
});
it('sends custom standardised tiers without changing source order or model SKU', async () => {
  const transport = vi.fn(async () => success({ item_id: 9001 }));
  expect(await client(transport).initializeTiers(tiers())).toMatchObject({
    kind: 'success',
    data: { itemId: '9001' },
  });
  expect(JSON.parse(String((transport.mock.calls[0] as any)[1].body))).toEqual(tiers());
});
it.each([
  'protected',
  'duplicate_sku',
  'duplicate_index',
  'missing_combination',
  'partial_images',
  'old_field',
] as const)('rejects unsafe tier initialization: %s', async (change) => {
  const data: any = tiers();
  if (change === 'protected') data.item_id = 803934364;
  if (change === 'duplicate_sku') data.model[1].model_sku = data.model[0].model_sku;
  if (change === 'duplicate_index') data.model[1].tier_index = [0];
  if (change === 'missing_combination') data.model.pop();
  if (change === 'partial_images')
    delete data.standardise_tier_variation[0].variation_option_list[0].image_id;
  if (change === 'old_field') data.tier_variation = [];
  const transport = vi.fn();
  await expect(client(transport).initializeTiers(data)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
it.each([200, 403])(
  'retains structured business errors at HTTP %i without sensitive text',
  async (status) => {
    const result = await client(
      async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_acceess_token',
            request_id: 'safe-id',
            message: credentials.accessToken,
          }),
          { status },
        ),
    ).createUnlisted(payload());
    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'invalid_acceess_token',
      requestId: 'safe-id',
      httpStatus: status,
    });
    expect(JSON.stringify(result)).not.toContain(credentials.accessToken);
  },
);
it('does not retry an ambiguous create transport failure', async () => {
  const transport = vi.fn(async () => {
    throw new Error(credentials.accessToken);
  });
  expect(await client(transport).createUnlisted(payload())).toEqual({
    kind: 'unknown',
    reason: 'transport',
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each([{}, { item_id: 0 }, { item_id: 803934364 }, { item_id: 'not-an-id' }])(
  'keeps malformed create acknowledgements unknown',
  async (response) => {
    expect(await client(async () => success(response)).createUnlisted(payload())).toMatchObject({
      kind: 'unknown',
      reason: 'invalid_response',
      requestId: 'fixture-request',
    });
  },
);
it('does not classify a remote server error after create as safely rejected', async () => {
  expect(
    await client(
      async () =>
        new Response(JSON.stringify({ error: 'error_server', request_id: 'server-id' }), {
          status: 500,
        }),
    ).createUnlisted(payload()),
  ).toMatchObject({
    kind: 'unknown',
    reason: 'transport',
    httpStatus: 500,
    requestId: 'server-id',
  });
});
