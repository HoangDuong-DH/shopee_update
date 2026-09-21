import { expect, it, vi } from 'vitest';
import * as gateway from '../../packages/shopee/src/index.js';

const credentials = {
  environment: 'sandbox' as const,
  partnerId: '1232297',
  shopId: '227418363',
  accessToken: 'fixture-field-token',
  partnerKey: 'fixture-field-key',
};
const success = (response?: unknown) =>
  new Response(JSON.stringify({ error: '', request_id: 'field-receipt', response }));
const client = (transport: typeof fetch) => new gateway.SandboxFieldClient(credentials, transport);

it('exports an isolated field trial client and operation schema', () => {
  expect(gateway.SandboxFieldClient).toBeTypeOf('function');
  expect(gateway.fieldOperationSchema).toBeDefined();
});

it.each([{ environment: 'production' }, { partnerId: '1' }, { shopId: '1' }])(
  'blocks an unauthorized field client scope before network: %j',
  (changes) => {
    const transport = vi.fn();
    expect(
      () => new gateway.SandboxFieldClient({ ...credentials, ...changes } as any, transport),
    ).toThrow('SANDBOX_FIELD_SCOPE_INVALID');
    expect(transport).not.toHaveBeenCalled();
  },
);

it.each(['803934364', '846056124', '0', '9007199254740993', 'invalid'])(
  'never writes a protected or invalid target %s',
  async (itemId) => {
    const transport = vi.fn();
    await expect(
      client(transport).execute(itemId, { kind: 'title', value: 'SANDBOX QA changed' }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  },
);

it('reads a zero-tier item without requesting models and preserves its raw price and stock', async () => {
  const item = {
    item_id: 9001,
    has_model: false,
    price_info: [{ original_price: 20000 }],
    stock_info_v2: { seller_stock: [{ stock: 0 }] },
  };
  const transport = vi.fn(async () => success({ item_list: [item] }));
  expect(await client(transport).read('9001')).toMatchObject({
    kind: 'success',
    data: {
      item,
      models: { model: [], tier_variation: [] },
    },
  });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('reads model item metadata without reordering model or option identities', async () => {
  const item = { item_id: 9001, has_model: true };
  const models = {
    model: [
      { model_id: 11, tier_index: [1] },
      { model_id: 10, tier_index: [0] },
    ],
    tier_variation: [{ name: 'Colour', option_list: [{ option: ' A ' }, { option: 'B' }] }],
    standardise_tier_variation: [{ variation_id: 0, variation_name: 'Colour' }],
  };
  const transport = vi
    .fn()
    .mockImplementationOnce(async () => success({ item_list: [item] }))
    .mockImplementationOnce(async () => success(models));
  expect(await client(transport).read('9001')).toMatchObject({
    kind: 'success',
    data: { item, models },
  });
  expect(transport).toHaveBeenCalledTimes(2);
});

it('does not guess whether a malformed base response has models', async () => {
  const transport = vi.fn(async () => success({ item_list: [{ item_id: 9001 }] }));
  expect(await client(transport).read('9001')).toMatchObject({
    kind: 'unknown',
    reason: 'invalid_response',
  });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('reads promotions for exactly one item with GET and retains ongoing, upcoming and unknown metadata', async () => {
  const promotion = [
    {
      promotion_id: '18446744073709551615',
      model_id: 10,
      promotion_staging: 'ongoing',
      promotion_type: 'Discount Promotions',
      promotion_price_info: [{ promotion_price: 1000 }],
    },
    {
      promotion_id: '42',
      model_id: 11,
      promotion_staging: 'upcoming',
      start_time: 1900000000,
      end_time: 1900001000,
      promotion_stock_info_v2: { summary_info: { total_reserved_stock: 20 } },
      future_metadata: { preserved: true },
    },
  ];
  const transport = vi.fn(async () =>
    success({ success_list: [{ item_id: 9001, promotion }], failure_list: [] }),
  );
  const outcome = await client(transport).readPromotions('9001');
  expect(outcome).toMatchObject({
    kind: 'success',
    requestId: 'field-receipt',
    data: { itemId: '9001', promotionFieldPresent: true, item: { item_id: '9001', promotion } },
  });
  const [url, init] = transport.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/api/v2/product/get_item_promotion');
  expect(url.searchParams.get('item_id_list')).toBe('9001');
  expect(url.searchParams.get('shop_id')).toBe(credentials.shopId);
  expect(url.searchParams.get('sign')).toBe(
    gateway.signRequest({
      ...credentials,
      path: url.pathname,
      timestamp: Number(url.searchParams.get('timestamp')),
    }),
  );
  expect(init.method).toBe('GET');
  expect(init.body).toBeUndefined();
  expect(init.redirect).toBe('error');
});

it.each([{}, { promotion: [] }])(
  'keeps an omitted promotion field distinguishable from an explicit empty list: %j',
  async (fields) => {
    const transport = vi.fn(async () => success({ success_list: [{ item_id: 9001, ...fields }] }));
    expect(await client(transport).readPromotions('9001')).toMatchObject({
      kind: 'success',
      data: {
        itemId: '9001',
        promotionFieldPresent: Object.hasOwn(fields, 'promotion'),
        item: { item_id: '9001', ...fields },
      },
    });
  },
);

it.each([
  { success_list: [] },
  { success_list: [{ item_id: 9002, promotion: [] }] },
  { success_list: [{ item_id: 9001 }, { item_id: 9001 }] },
  { success_list: [{ item_id: 9001 }, { item_id: 9002 }] },
  { success_list: [{ item_id: 9001 }], failure_list: [{ item_id: 9001, failed_reason: 'failed' }] },
  {
    success_list: [{ item_id: 9001 }],
    failure_list: [{ item_id: 9002, failed_reason: 'extra failed target' }],
  },
  { success_list: [], failure_list: [{ item_id: 9001, failed_reason: 'failed' }] },
  { success_list: [{ item_id: 9001, promotion: null }] },
  { success_list: [{ item_id: 9001, promotion: {} }] },
  { success_list: [{ item_id: 9001, promotion: [null] }] },
  { success_list: [{ item_id: 9001 }], failure_list: {} },
])(
  'refuses incomplete, duplicate, extra or failed promotion target coverage: %j',
  async (response) => {
    const transport = vi.fn(async () => success(response));
    expect(await client(transport).readPromotions('9001')).toMatchObject({
      kind: 'unknown',
      reason: 'invalid_response',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it('returns sanitized permission rejection and transport uncertainty for promotion diagnosis without retry', async () => {
  const rejected = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: 'error_api_permission',
          request_id: credentials.accessToken,
          message: credentials.partnerKey,
        }),
      ),
  );
  expect(await client(rejected).readPromotions('9001')).toEqual({
    kind: 'rejected',
    code: 'error_api_permission',
    httpStatus: 200,
  });
  const unavailable = vi.fn(async () => {
    throw new Error('unavailable');
  });
  expect(await client(unavailable).readPromotions('9001')).toMatchObject({
    kind: 'unknown',
    reason: 'transport',
  });
  expect(unavailable).toHaveBeenCalledTimes(1);
});

it.each([
  [
    { kind: 'title', value: 'SANDBOX QA unchanged spaces  ' },
    { item_name: 'SANDBOX QA unchanged spaces  ' },
  ],
  [
    { kind: 'description', value: { description_type: 'normal', description: ' A\n\nB ' } },
    { description_type: 'normal', description: ' A\n\nB ' },
  ],
  [
    {
      kind: 'description',
      value: {
        description_type: 'extended',
        description_info: {
          extended_description: {
            field_list: [
              { field_type: 'text', text: ' A\n\n' },
              { field_type: 'image', image_info: { image_id: 'desc-1' } },
            ],
          },
        },
      },
    },
    {
      description_type: 'extended',
      description_info: {
        extended_description: {
          field_list: [
            { field_type: 'text', text: ' A\n\n' },
            { field_type: 'image', image_info: { image_id: 'desc-1' } },
          ],
        },
      },
    },
  ],
  [
    {
      kind: 'gallery',
      value: { image_id_list: ['second', 'first'], image_ratio: '3:4' },
      preserveCover: ['cover-old'],
    },
    {
      image: { image_id_list: ['second', 'first'], image_ratio: '3:4' },
      promotion_images: { image_id_list: ['cover-old'] },
    },
  ],
  [
    {
      kind: 'gallery',
      value: { image_id_list: ['square'], image_ratio: '1:1' },
      preserveCover: [],
    },
    { image: { image_id_list: ['square'], image_ratio: '1:1' } },
  ],
  [{ kind: 'cover', value: ['cover-new'] }, { promotion_images: { image_id_list: ['cover-new'] } }],
])(
  'sends only the selected item field and its explicit media preservation payload: %j',
  async (operation, expected) => {
    const transport = vi.fn(async () => success({ item_id: 9001 }));
    expect(await client(transport).execute('9001', operation as any)).toMatchObject({
      kind: 'success',
      data: { successIds: [], failureIds: [] },
      httpStatus: 200,
    });
    const [raw, init] = transport.mock.calls[0] as unknown as [URL, RequestInit];
    const url = new URL(raw);
    expect(url.origin).toBe('https://openplatform.sandbox.test-stable.shopee.sg');
    expect(url.pathname).toBe('/api/v2/product/update_item');
    expect(url.searchParams.get('sign')).toBe(
      gateway.signRequest({
        ...credentials,
        path: url.pathname,
        timestamp: Number(url.searchParams.get('timestamp')),
      }),
    );
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({ item_id: 9001, ...expected });
  },
);

it('requires explicit cover preservation for a 3:4 gallery', async () => {
  const transport = vi.fn();
  await expect(
    client(transport).execute('9001', {
      kind: 'gallery',
      value: {
        image_id_list: ['g1'],
        image_ratio: '3:4',
      },
      preserveCover: [],
    }),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  { kind: 'price', value: [{ model_id: 10, original_price: 2.5 }] },
  {
    kind: 'price',
    value: [
      { model_id: 10, original_price: 20000 },
      { model_id: 10, original_price: 21000 },
    ],
  },
  { kind: 'stock', value: [{ model_id: 10, seller_stock: [{ stock: -1 }] }] },
  { kind: 'stock', value: [{ model_id: 10, seller_stock: [{ stock: 1 }, { stock: 2 }] }] },
  { kind: 'title', value: 'SANDBOX QA valid', original_price: 1 },
  {
    kind: 'description',
    value: { description_type: 'normal', description: 'x', item_status: 'NORMAL' },
  },
  { kind: 'cover', value: ['one', 'two'] },
])('blocks malformed or wider operation before network: %j', async (operation) => {
  const transport = vi.fn();
  await expect(client(transport).execute('9001', operation as any)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it('preserves partial price acknowledgements instead of advertising every model succeeded', async () => {
  const transport = vi.fn(async () =>
    success({
      success_list: [{ model_id: 10, original_price: 21000 }],
      failure_list: [{ model_id: 11, failed_reason: 'sensitive detail not retained' }],
    }),
  );
  expect(
    await client(transport).execute('9001', {
      kind: 'price',
      value: [
        { model_id: 10, original_price: 21000 },
        { model_id: 11, original_price: 22000 },
      ],
    }),
  ).toEqual({
    kind: 'success',
    data: { successIds: ['10'], failureIds: ['11'] },
    requestId: 'field-receipt',
    httpStatus: 200,
  });
  const [url, init] = transport.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/api/v2/product/update_price');
  expect(JSON.parse(String(init.body))).toEqual({
    item_id: 9001,
    price_list: [
      { model_id: 10, original_price: 21000 },
      { model_id: 11, original_price: 22000 },
    ],
  });
});

it.each([
  { success_list: [], failure_list: [] },
  { success_list: [{ model_id: 12, original_price: 21000 }], failure_list: [] },
  {
    success_list: [
      { model_id: 10, original_price: 21000 },
      { model_id: 10, original_price: 21000 },
    ],
    failure_list: [],
  },
  { success_list: [{ model_id: 10, original_price: 21000 }], failure_list: [{ model_id: 10 }] },
  { success_list: [{ model_id: 10, original_price: 1 }], failure_list: [] },
])(
  'treats incomplete, duplicate, overlapping or wrong price acknowledgements as unknown: %j',
  async (response) => {
    const transport = vi.fn(async () => success(response));
    expect(
      await client(transport).execute('9001', {
        kind: 'price',
        value: [{ model_id: 10, original_price: 21000 }],
      }),
    ).toMatchObject({ kind: 'unknown', reason: 'invalid_response' });
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it('supports an explicit zero stock decision and default model 0 exactly once', async () => {
  const transport = vi.fn(async () =>
    success({ success_list: [{ model_id: 0, stock: 0, location_id: '' }], failure_list: [] }),
  );
  expect(
    await client(transport).execute('9001', {
      kind: 'stock',
      value: [{ model_id: 0, seller_stock: [{ stock: 0 }] }],
    }),
  ).toMatchObject({ kind: 'success', data: { successIds: ['0'], failureIds: [] } });
  const [url, init] = transport.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/api/v2/product/update_stock');
  expect(JSON.parse(String(init.body))).toEqual({
    item_id: 9001,
    stock_list: [{ model_id: 0, seller_stock: [{ stock: 0 }] }],
  });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('rejects a stock acknowledgement for another warehouse', async () => {
  const transport = vi.fn(async () =>
    success({ success_list: [{ model_id: 10, stock: 1, location_id: 'other' }], failure_list: [] }),
  );
  expect(
    await client(transport).execute('9001', {
      kind: 'stock',
      value: [{ model_id: 10, seller_stock: [{ stock: 1, location_id: 'same' }] }],
    }),
  ).toMatchObject({ kind: 'unknown', reason: 'invalid_response' });
});

it.each([
  ['error_server', 200, 'unknown'],
  ['error_inner', 200, 'unknown'],
  ['product.error_busi', 500, 'unknown'],
  ['error_update_price_fail', 200, 'unknown'],
  ['error_busi_update_stock_failed', 200, 'unknown'],
  ['invalid_acceess_token', 200, 'rejected'],
  ['product.error_busi', 200, 'rejected'],
])(
  'classifies mutation error %s/%i without retries or sensitive message retention',
  async (error, status, kind) => {
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error,
            message: credentials.accessToken,
            request_id: 'field-error',
            warning: credentials.partnerKey,
          }),
          { status },
        ),
    );
    const result = await client(transport).execute('9001', {
      kind: 'title',
      value: 'SANDBOX QA changed',
    });
    expect(result).toMatchObject({ kind, httpStatus: status, requestId: 'field-error' });
    expect(JSON.stringify(result)).not.toContain(credentials.accessToken);
    expect(JSON.stringify(result)).not.toContain(credentials.partnerKey);
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it('returns unknown for a lost response without retrying', async () => {
  const transport = vi.fn(async () => {
    throw new Error(credentials.accessToken);
  });
  expect(
    await client(transport).execute('9001', { kind: 'title', value: 'SANDBOX QA changed' }),
  ).toEqual({ kind: 'unknown', reason: 'transport' });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('does not accept an acknowledgement for another item', async () => {
  const transport = vi.fn(async () => success({ item_id: 803934364 }));
  expect(
    await client(transport).execute('9001', { kind: 'title', value: 'SANDBOX QA changed' }),
  ).toMatchObject({ kind: 'unknown', reason: 'invalid_response' });
});
