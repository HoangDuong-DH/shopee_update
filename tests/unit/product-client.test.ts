import { expect, it, vi } from 'vitest';
import {
  SandboxProductClient,
  normalizeProductSnapshot,
  productFingerprint,
  signRequest,
} from '../../packages/shopee/src/index.js';
const credentials = {
  environment: 'sandbox' as const,
  partnerId: '1232297',
  shopId: '227418363',
  accessToken: 'test-token',
  partnerKey: 'test-partner-key',
};
const item = () => ({
  item_id: 803934364,
  item_name: 'Tên gốc',
  category_id: 300018,
  item_status: 'NORMAL',
  description_type: 'extended',
  description_info: {
    extended_description: {
      field_list: [
        { field_type: 'text', text: 'Tiêu đề\n\n' },
        {
          field_type: 'image',
          image_info: { image_id: 'g1', image_url: 'https://example.invalid/image' },
        },
        { field_type: 'text', text: '\n\nNội dung  giữ nguyên' },
      ],
    },
  },
  image: {
    image_id_list: ['g1', 'g2'],
    image_ratio: '3:4',
    image_url_list: ['https://example.invalid/1'],
  },
  promotion_image: { image_id_list: ['cover'], image_ratio: '1:1' },
  brand: { brand_id: 7 },
  weight: '0.2',
  update_time: 1,
});
const models = () => ({
  tier_variation: [{ name: 'Màu', option_list: [{ option: 'Trắng' }, { option: 'Đen' }] }],
  model: [
    {
      model_id: 12,
      model_sku: 'B',
      tier_index: [1],
      price_info: [{ currency: 'VND', original_price: 200, current_price: 100 }],
      stock_info_v2: {
        summary_info: { total_available_stock: 45, total_reserved_stock: 6 },
        seller_stock: [{ stock: 51 }],
      },
    },
    {
      model_id: 11,
      model_sku: 'A',
      tier_index: [0],
      price_info: [{ currency: 'VND', original_price: 100, current_price: 50 }],
      stock_info_v2: { summary_info: { total_available_stock: 7, total_reserved_stock: 2 } },
    },
  ],
});
const success = (response: unknown) =>
  new Response(JSON.stringify({ error: '', response, request_id: 'request-1' }), { status: 200 });

it('normalizes by model ID while binding SKU and option by tier index and preserves exact text', () => {
  const result = normalizeProductSnapshot(item(), models(), '803934364');
  expect(
    result.models.map((m) => [
      m.modelId,
      m.sku,
      m.optionLabels,
      m.originalPrice,
      m.availableStock,
      m.reservedStock,
    ]),
  ).toEqual([
    ['11', 'A', ['Trắng'], '100', 7, 2],
    ['12', 'B', ['Đen'], '200', 45, 6],
  ]);
  expect(result.description).toEqual([
    { type: 'text', text: 'Tiêu đề\n\n' },
    { type: 'image', imageId: 'g1' },
    { type: 'text', text: '\n\nNội dung  giữ nguyên' },
  ]);
  expect(JSON.stringify(result)).not.toContain('example.invalid');
  expect(result.coverImageIds).toEqual(['cover']);
  const changed = item();
  changed.update_time = 888;
  expect(
    normalizeProductSnapshot(
      changed,
      { ...models(), model: [...models().model].reverse() },
      '803934364',
    ).fingerprint,
  ).toBe(result.fingerprint);
});
it('does not turn missing stock into zero and rejects duplicate IDs and wrong item', () => {
  const raw = models();
  delete (raw.model[0] as { stock_info_v2?: unknown }).stock_info_v2;
  expect(normalizeProductSnapshot(item(), raw, '803934364').models[1]?.availableStock).toBeNull();
  expect(() => normalizeProductSnapshot(item(), models(), '1')).toThrow(
    'SANDBOX_REMOTE_ITEM_MISMATCH',
  );
  expect(() =>
    normalizeProductSnapshot(
      item(),
      { ...models(), model: [models().model[0], models().model[0]] },
      '803934364',
    ),
  ).toThrow('SANDBOX_REMOTE_MODEL_DUPLICATE');
});
it('uses fixed sandbox host, shop signatures, and fail-closed production gate', async () => {
  const calls: URL[] = [];
  const transport = vi.fn(async (url: URL | RequestInfo) => {
    const u = new URL(String(url));
    calls.push(u);
    return success(u.pathname.endsWith('get_item_base_info') ? { item_list: [item()] } : models());
  }) as typeof fetch;
  expect(
    () => new SandboxProductClient({ ...credentials, environment: 'production' }, transport),
  ).toThrow('SANDBOX_SCOPE_REQUIRED');
  const result = await new SandboxProductClient(credentials, transport).read('803934364');
  expect(result.kind).toBe('success');
  for (const url of calls) {
    expect(url.hostname).toBe('openplatform.sandbox.test-stable.shopee.sg');
    expect(url.searchParams.get('sign')).toBe(
      signRequest({
        partnerId: credentials.partnerId,
        path: url.pathname,
        timestamp: Number(url.searchParams.get('timestamp')),
        partnerKey: credentials.partnerKey,
        accessToken: credentials.accessToken,
        shopId: credentials.shopId,
      }),
    );
  }
  expect(calls[0]?.searchParams.get('item_id_list')).toBe('803934364');
});
it('separates HTTP failure, business rejection, and malformed response without echoing secrets', async () => {
  const forbidden = await new SandboxProductClient(
    credentials,
    vi.fn(async () => new Response('key=test-partner-key', { status: 403 })) as typeof fetch,
  ).read('803934364');
  expect(forbidden).toEqual({ kind: 'unknown', reason: 'transport', httpStatus: 403 });
  const forbiddenToken = await new SandboxProductClient(
    credentials,
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_acceess_token',
            message: credentials.accessToken,
            request_id: 'req-403',
          }),
          { status: 403 },
        ),
    ) as typeof fetch,
  ).read('803934364');
  expect(forbiddenToken).toEqual({
    kind: 'rejected',
    code: 'invalid_acceess_token',
    requestId: 'req-403',
    httpStatus: 403,
  });
  const rejected = await new SandboxProductClient(
    credentials,
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'error_auth',
            message: credentials.accessToken,
            request_id: 'req-auth',
          }),
        ),
    ) as typeof fetch,
  ).read('803934364');
  expect(rejected).toEqual({ kind: 'rejected', code: 'error_auth', requestId: 'req-auth' });
  expect(JSON.stringify([forbidden, rejected])).not.toContain(credentials.accessToken);
  const invalid = await new SandboxProductClient(
    credentials,
    vi.fn(async () => success({ item_list: [] })) as typeof fetch,
  ).read('803934364');
  expect(invalid).toEqual({ kind: 'unknown', reason: 'invalid_response' });
});
it('rejects arbitrary fields before transport and never treats write response as readback', async () => {
  const transport = vi.fn(async () =>
    success({ item_id: 803934364, item_name: 'old value' }),
  ) as typeof fetch;
  const client = new SandboxProductClient(credentials, transport);
  await expect(
    client.update({ item_id: 803934364, item_name: 'new', original_price: 1 } as never),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  expect(await client.update({ item_id: 803934364, item_name: 'new' })).toMatchObject({
    kind: 'success',
    data: { itemId: '803934364' },
  });
});
it('uploads the exact bytes with scene and public signature, including partial failure handling', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 9, 0, 4]);
  const transport = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(u.searchParams.has('access_token')).toBe(false);
    expect(u.searchParams.has('shop_id')).toBe(false);
    expect(u.searchParams.get('sign')).toBe(
      signRequest({
        partnerId: credentials.partnerId,
        partnerKey: credentials.partnerKey,
        path: u.pathname,
        timestamp: Number(u.searchParams.get('timestamp')),
      }),
    );
    const form = init?.body as FormData;
    expect(form.get('scene')).toBe('desc');
    expect(new Uint8Array(await (form.get('image') as Blob).arrayBuffer())).toEqual(bytes);
    return success({
      image_info_list: [{ error: '', image_info: { image_id: 'mapped-original' } }],
    });
  }) as typeof fetch;
  expect(
    await new SandboxProductClient(credentials, transport).upload(bytes, 'image/png', 'desc'),
  ).toMatchObject({ kind: 'success', data: { imageId: 'mapped-original' } });
  const partial = new SandboxProductClient(
    credentials,
    vi.fn(async () =>
      success({
        image_info: { image_id: 'should-not-use' },
        image_info_list: [{ error: 'invalid_image' }],
      }),
    ) as typeof fetch,
  );
  expect(await partial.upload(bytes, 'image/png', 'desc')).toMatchObject({
    kind: 'rejected',
    code: 'image_upload_rejected',
  });
});
it('canonical fingerprints are invariant to object insertion order but preserve array ordering', () => {
  expect(productFingerprint({ a: 1, b: 2 })).toBe(productFingerprint({ b: 2, a: 1 }));
  expect(productFingerprint(['a', 'b'])).not.toBe(productFingerprint(['b', 'a']));
});
it('supports one explicit original promotion cover and rejects ambiguous preservation payloads', async () => {
  const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({
      item_id: 803934364,
      promotion_images: { image_id_list: ['vn-original-cover'] },
    });
    return success({ item_id: 803934364 });
  }) as typeof fetch;
  const client = new SandboxProductClient(credentials, transport);
  expect(
    await client.update({
      item_id: 803934364,
      promotion_images: { image_id_list: ['vn-original-cover'] },
    }),
  ).toMatchObject({ kind: 'success' });
  for (const imageIds of [[], ['one', 'two'], [' ']])
    await expect(
      client.update({ item_id: 803934364, promotion_images: { image_id_list: imageIds } }),
    ).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
});
it('accepts explicit null or empty upload list errors and matching image IDs, but rejects missing or malformed errors', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 2]);
  const upload = async (entry: unknown, topId = 'same-id') =>
    new SandboxProductClient(
      credentials,
      vi.fn(async () =>
        success({ image_info: { image_id: topId }, image_info_list: [entry] }),
      ) as typeof fetch,
    ).upload(bytes, 'image/png', 'desc');
  for (const error of [null, ''])
    expect(await upload({ error, image_info: { image_id: 'same-id' } })).toMatchObject({
      kind: 'success',
      data: { imageId: 'same-id' },
    });
  expect(
    await upload({ error: 'invalid_image', image_info: { image_id: 'same-id' } }),
  ).toMatchObject({
    kind: 'rejected',
    code: 'image_upload_rejected',
    httpStatus: 200,
    requestId: 'request-1',
  });
  for (const entry of [
    { image_info: { image_id: 'same-id' } },
    { error: false },
    { error: 0 },
    { error: {} },
  ])
    expect(await upload(entry)).toMatchObject({
      kind: 'unknown',
      reason: 'invalid_response',
      httpStatus: 200,
      requestId: 'request-1',
    });
  expect(await upload({ error: null, image_info: { image_id: 'different-id' } })).toMatchObject({
    kind: 'unknown',
    reason: 'invalid_response',
  });
});
it('canonicalizes unordered logistics by channel ID without hiding enabled or fee changes', () => {
  const channels = [
    {
      logistic_id: 51022,
      enabled: false,
      shipping_fee: 20000,
      estimated_shipping_fee: 20000,
      is_free: false,
      custom_extra: { source: 'retained' },
    },
    {
      logistic_id: 50040,
      enabled: true,
      shipping_fee: 50000,
      estimated_shipping_fee: 50000,
      is_free: false,
    },
    {
      logistic_id: 51023,
      enabled: false,
      shipping_fee: 20000,
      estimated_shipping_fee: 20000,
      is_free: false,
    },
  ];
  const before = normalizeProductSnapshot(
    { ...item(), logistic_info: channels },
    models(),
    '803934364',
  );
  const rotated = normalizeProductSnapshot(
    { ...item(), logistic_info: [channels[2], channels[0], channels[1]] },
    models(),
    '803934364',
  );
  expect(rotated.fingerprint).toBe(before.fingerprint);
  expect((rotated.protectedFields.item as Record<string, unknown>).logistic_info).toEqual([
    channels[1],
    channels[0],
    channels[2],
  ]);
  expect(channels.map((c) => c.logistic_id)).toEqual([51022, 50040, 51023]);
  for (const change of [
    { enabled: false },
    { shipping_fee: 49999 },
    { estimated_shipping_fee: 49999 },
    { is_free: true },
  ]) {
    const changed = channels.map((c) => (c.logistic_id === 50040 ? { ...c, ...change } : c));
    expect(
      normalizeProductSnapshot({ ...item(), logistic_info: changed }, models(), '803934364')
        .fingerprint,
    ).not.toBe(before.fingerprint);
  }
  const galleryChanged = item();
  galleryChanged.image.image_id_list.reverse();
  expect(
    normalizeProductSnapshot({ ...galleryChanged, logistic_info: channels }, models(), '803934364')
      .fingerprint,
  ).not.toBe(before.fingerprint);
  const descriptionChanged = item();
  descriptionChanged.description_info.extended_description.field_list.reverse();
  expect(
    normalizeProductSnapshot(
      { ...descriptionChanged, logistic_info: channels },
      models(),
      '803934364',
    ).fingerprint,
  ).not.toBe(before.fingerprint);
});
it('canonicalizes only the outer attribute collection while preserving values, names and inner order', () => {
  const attributes = [
    {
      attribute_id: 201067,
      original_attribute_name: 'Tên tổ chức',
      is_mandatory: false,
      attribute_value_list: [
        { value_id: 0, original_value_name: 'Nguồn A' },
        { value_id: 0, original_value_name: 'Nguồn B' },
      ],
      source_extra: 'retained',
    },
    {
      attribute_id: 200088,
      original_attribute_name: 'Chất liệu',
      is_mandatory: true,
      attribute_value_list: [{ value_id: 42, original_value_name: 'Vải' }],
    },
  ];
  const before = normalizeProductSnapshot(
    { ...item(), attribute_list: attributes },
    models(),
    '803934364',
  );
  const reversed = normalizeProductSnapshot(
    { ...item(), attribute_list: [...attributes].reverse() },
    models(),
    '803934364',
  );
  expect(reversed.fingerprint).toBe(before.fingerprint);
  expect((reversed.protectedFields.item as Record<string, unknown>).attribute_list).toEqual([
    attributes[1],
    attributes[0],
  ]);
  expect(attributes[0]!.attribute_value_list.map((v) => v.original_value_name)).toEqual([
    'Nguồn A',
    'Nguồn B',
  ]);
  const changes = [
    [{ ...attributes[0], original_attribute_name: 'Tên đã đổi' }, attributes[1]],
    [
      {
        ...attributes[0],
        attribute_value_list: [{ value_id: 0, original_value_name: 'Giá trị đã đổi' }],
      },
      attributes[1],
    ],
    [
      {
        ...attributes[0],
        attribute_value_list: [...attributes[0]!.attribute_value_list].reverse(),
      },
      attributes[1],
    ],
    [attributes[0], { ...attributes[1], is_mandatory: false }],
  ];
  for (const changed of changes)
    expect(
      normalizeProductSnapshot({ ...item(), attribute_list: changed }, models(), '803934364')
        .fingerprint,
    ).not.toBe(before.fingerprint);
});
it('rejects duplicate or unidentifiable outer attributes rather than hiding ambiguous values', () => {
  expect(() =>
    normalizeProductSnapshot(
      { ...item(), attribute_list: [{ attribute_id: 200088 }, { attribute_id: 200088 }] },
      models(),
      '803934364',
    ),
  ).toThrow('SANDBOX_REMOTE_ATTRIBUTES_DUPLICATE');
  for (const invalid of [[{ attribute_value_list: [] }], [{ attribute_id: -1 }], null, {}])
    expect(() =>
      normalizeProductSnapshot({ ...item(), attribute_list: invalid }, models(), '803934364'),
    ).toThrow('SANDBOX_REMOTE_ATTRIBUTES_INVALID');
});
it('rejects duplicate or unidentifiable logistics entries instead of comparing ambiguous channels', () => {
  expect(() =>
    normalizeProductSnapshot(
      {
        ...item(),
        logistic_info: [
          { logistic_id: 50040, enabled: true },
          { logistic_id: 50040, enabled: false },
        ],
      },
      models(),
      '803934364',
    ),
  ).toThrow('SANDBOX_REMOTE_LOGISTICS_DUPLICATE');
  for (const invalid of [[{ enabled: true }], [{ logistic_id: -1 }], null, {}]) {
    expect(() =>
      normalizeProductSnapshot({ ...item(), logistic_info: invalid }, models(), '803934364'),
    ).toThrow('SANDBOX_REMOTE_LOGISTICS_INVALID');
  }
});
