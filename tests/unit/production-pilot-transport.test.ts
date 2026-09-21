import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProductionPilotTransport,
  productionPilotUploadFingerprint,
  productionPilotWriteFingerprint,
  type ProductionPilotMutationIntent,
} from '../../packages/shopee/src/production-pilot-transport.js';
import { signRequest } from '../../packages/shopee/src/sign.js';

const credentials = {
  environment: 'production' as const,
  partnerId: '2010476',
  shopId: '1423724897',
  partnerKey: 'fixture-production-partner-key',
  accessToken: 'fixture-production-access-token',
};
const addPath = '/api/v2/product/add_item';
const initPath = '/api/v2/product/init_tier_variation';
const publishPath = '/api/v2/product/unlist_item';
const payload = {
  item_status: 'UNLIST',
  item_sku: 'SOURCE-A',
  item_name: 'Nguồn gốc',
  category_id: 1001,
};
const permit = () => ({ operationId: randomUUID(), stepId: 'create' });
const envelope = { error: '', request_id: 'fixture-request', response: { item_id: 9001 } };
const response = (value: unknown = envelope, status = 200) =>
  vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(value), { status }));
const allow = () =>
  vi.fn<(intent: Readonly<ProductionPilotMutationIntent>) => Promise<boolean>>(async () => true);

afterEach(() => vi.restoreAllMocks());

describe('production pilot transport boundary', () => {
  it('reads category recommendations by the exact source title without a mutation permit', async () => {
    const transport = response({ ...envelope, response: { category_id: [101128] } });
    const title = 'Xịt Thơm Ô Tô VINA TƯƠI 100ml';
    const result = await new ProductionPilotTransport(credentials, { transport }).read(
      '/api/v2/product/category_recommend', { item_name: title },
    );
    expect(result).toMatchObject({ kind: 'success', response: { category_id: [101128] } });
    const [address, init] = transport.mock.calls[0]!;
    const url = new URL(String(address));
    expect(url.pathname).toBe('/api/v2/product/category_recommend');
    expect(url.searchParams.get('item_name')).toBe(title);
    expect(url.searchParams.has('product_cover_image')).toBe(false);
    expect(url.searchParams.get('shop_id')).toBe('1423724897');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });
  it.each([
    { environment: 'sandbox' },
    { partnerId: '4294967296' },
    { shopId: '9007199254740992' },
    { shopId: '01423724897' },
    { partnerKey: '' },
    { accessToken: '' },
    { accessToken: 'bad\ntoken' },
  ])('rejects non-production scope or malformed credentials (%j)', (override) => {
    const transport = response();
    expect(
      () => new ProductionPilotTransport({ ...credentials, ...override } as any, { transport }),
    ).toThrow('PRODUCTION_PILOT_SCOPE_FORBIDDEN');
    expect(transport).not.toHaveBeenCalled();
  });

  it('separates two shops and partners while preserving legacy fingerprints', async () => {
    const scopeA = { environment: 'production' as const, partnerId: credentials.partnerId, shopId: credentials.shopId };
    const scopeB = { ...scopeA, partnerId: '1232297', shopId: '227418363' };
    const bytes = Uint8Array.of(1, 2, 3);
    const options = { scene: 'normal' as const, ratio: '3:4' as const };
    expect(productionPilotWriteFingerprint(addPath, payload, scopeA)).toBe(productionPilotWriteFingerprint(addPath, payload));
    expect(productionPilotUploadFingerprint(bytes, 'image/png', options, scopeA)).toBe(productionPilotUploadFingerprint(bytes, 'image/png', options));
    for (const otherScope of [scopeB, { ...scopeA, shopId: scopeB.shopId }, { ...scopeA, partnerId: scopeB.partnerId }]) {
      expect(productionPilotWriteFingerprint(addPath, payload, otherScope)).not.toBe(productionPilotWriteFingerprint(addPath, payload, scopeA));
      expect(productionPilotUploadFingerprint(bytes, 'image/png', options, otherScope)).not.toBe(productionPilotUploadFingerprint(bytes, 'image/png', options, scopeA));
    }
    const transport = response();
    const original = { ...credentials, ...scopeB };
    const client = new ProductionPilotTransport(original, { transport,
      authorizeMutation: async intent => intent.fingerprint === productionPilotWriteFingerprint(addPath, payload, scopeB) });
    original.shopId = scopeA.shopId;
    expect(await client.write(addPath, payload, permit())).toMatchObject({ kind: 'success' });
    const url = new URL(String(transport.mock.calls[0]![0]));
    expect(url.searchParams.get('shop_id')).toBe(scopeB.shopId);
    expect(url.searchParams.get('partner_id')).toBe(scopeB.partnerId);
    expect(url.searchParams.get('sign')).toBe(signRequest({ ...credentials, ...scopeB, path: addPath,
      timestamp: Number(url.searchParams.get('timestamp')) }));
  });

  it('denies another shop journal fingerprints for both writes and uploads before network', async () => {
    const transport = response();
    const bytes = Uint8Array.of(1, 2, 3);
    const options = { scene: 'normal' as const, ratio: '3:4' as const };
    const allowed = new Set([productionPilotWriteFingerprint(addPath, payload),
      productionPilotUploadFingerprint(bytes, 'image/png', options)]);
    const client = new ProductionPilotTransport({ ...credentials, shopId: '227418363' }, { transport,
      authorizeMutation: async intent => allowed.has(intent.fingerprint) });
    await expect(client.write(addPath, payload, permit())).rejects.toThrow('PRODUCTION_PILOT_PERMIT_DENIED');
    await expect(client.upload(bytes, 'image/png', options, { ...permit(), stepId: 'media-0' })).rejects.toThrow('PRODUCTION_PILOT_PERMIT_DENIED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('performs a signed read without any mutation permit', async () => {
    const transport = response({ ...envelope, response: { item_list: [] } });
    const original = { ...credentials };
    const client = new ProductionPilotTransport(original, { transport });
    original.shopId = '999';
    expect(
      await client.read('/api/v2/product/get_item_base_info', { item_id_list: '9001' }),
    ).toMatchObject({ kind: 'success', requestId: 'fixture-request' });
    const [address, init] = transport.mock.calls[0]!;
    const url = new URL(String(address));
    expect(url.origin).toBe('https://partner.shopeemobile.com');
    expect(url.pathname).toBe('/api/v2/product/get_item_base_info');
    expect(url.searchParams.get('shop_id')).toBe(credentials.shopId);
    expect(url.searchParams.get('partner_id')).toBe(credentials.partnerId);
    expect(url.searchParams.get('sign')).toBe(
      signRequest({
        ...credentials,
        path: url.pathname,
        timestamp: Number(url.searchParams.get('timestamp')),
      }),
    );
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init?.body).toBeUndefined();
  });

  it.each(['partner_id', 'shop_id', 'access_token', 'timestamp', 'sign', 'Partner_Id'])(
    'blocks auth query override %s before network',
    async (key) => {
      const transport = response();
      const client = new ProductionPilotTransport(credentials, { transport });
      await expect(client.read('/api/v2/product/get_item_list', { [key]: '999' })).rejects.toThrow(
        'PRODUCTION_PILOT_ENDPOINT_FORBIDDEN',
      );
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    'https://evil.test/api/v2/product/get_item_list',
    '/api/v2/order/get_order_list',
    '/api/v2/product/add_item',
  ])('blocks unapproved read path %s', async (path) => {
    const transport = response();
    await expect(
      new ProductionPilotTransport(credentials, { transport }).read(path),
    ).rejects.toThrow('PRODUCTION_PILOT_ENDPOINT_FORBIDDEN');
    expect(transport).not.toHaveBeenCalled();
  });

  it('denies mutations when there is no coordinator authorizer', async () => {
    const transport = response();
    await expect(
      new ProductionPilotTransport(credentials, { transport }).write(addPath, payload, permit()),
    ).rejects.toThrow('PRODUCTION_PILOT_PERMIT_REQUIRED');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { operationId: 'wrong', stepId: 'create' },
    { operationId: randomUUID(), stepId: '' },
  ])('rejects missing or malformed explicit permit (%j)', async (proof) => {
    const transport = response(),
      authorizeMutation = allow();
    const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
    await expect(client.write(addPath, payload, proof as any)).rejects.toThrow(
      'PRODUCTION_PILOT_PERMIT_REQUIRED',
    );
    expect(authorizeMutation).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('binds the journal authorization to the actual immutable payload and exact scope', async () => {
    const original = structuredClone(payload),
      proof = permit();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorizeMutation = vi.fn<
      (intent: Readonly<ProductionPilotMutationIntent>) => Promise<boolean>
    >(async () => {
      await barrier;
      return true;
    });
    const transport = response();
    const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
    const waiting = client.write(addPath, original, proof);
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());
    original.item_name = 'changed while authorizing';
    release();
    expect((await waiting).kind).toBe('success');
    expect(authorizeMutation.mock.calls[0]![0]).toEqual({
      ...proof,
      path: addPath,
      fingerprint: productionPilotWriteFingerprint(addPath, payload),
    });
    expect(JSON.parse(String(transport.mock.calls[0]![1]?.body))).toEqual(payload);
  });

  it('uses stable JSON fingerprints, preserving every meaningful payload difference', () => {
    expect(productionPilotWriteFingerprint(addPath, payload)).toBe(
      productionPilotWriteFingerprint(addPath, {
        category_id: payload.category_id,
        item_name: payload.item_name,
        item_sku: payload.item_sku,
        item_status: payload.item_status,
      }),
    );
    expect(
      productionPilotWriteFingerprint(addPath, { ...payload, original_price: 10000 }),
    ).not.toBe(productionPilotWriteFingerprint(addPath, { ...payload, original_price: 20000 }));
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(),
    1n,
    () => 'computed',
    { toJSON: () => 'changed' },
    new Array(1),
  ])('rejects values that cannot be hashed and sent as the same JSON case %#', async (extra) => {
    const transport = response(),
      authorizeMutation = allow();
    const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
    await expect(client.write(addPath, { ...payload, extra }, permit())).rejects.toThrow(
      'PRODUCTION_PILOT_WRITE_FORBIDDEN',
    );
    expect(authorizeMutation).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not send denied or errored journal authorization', async () => {
    const transport = response();
    for (const authorizeMutation of [
      vi.fn(async () => false),
      vi.fn(async () => {
        throw new Error(credentials.accessToken);
      }),
    ]) {
      const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
      await expect(client.write(addPath, payload, permit())).rejects.toThrow(
        'PRODUCTION_PILOT_PERMIT_DENIED',
      );
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('consumes a permit before network and prevents concurrent/repeated sends', async () => {
    const transport = response(),
      authorizeMutation = allow(),
      proof = permit();
    const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
    const results = await Promise.allSettled([
      client.write(addPath, payload, proof),
      client.write(addPath, payload, proof),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(transport).toHaveBeenCalledOnce();
    await expect(client.write(addPath, payload, proof)).rejects.toThrow(
      'PRODUCTION_PILOT_PERMIT_CONSUMED',
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    ['/api/v2/product/update_item', { item_id: 9001, item_status: 'NORMAL' }],
    ['/api/v2/product/delete_item', { item_id: 9001 }],
    ['/api/v2/product/update_price', { item_id: 9001 }],
    [addPath, { ...payload, item_status: 'NORMAL' }],
    [addPath, { ...payload, item_id: 9001 }],
    [addPath, { ...payload, shop_id: 999 }],
    [initPath, { item_id: 0, model: [], standardise_tier_variation: [] }],
  ])('rejects unapproved mutations without invoking journal callback (%s)', async (path, body) => {
    const transport = response(),
      authorizeMutation = allow();
    const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
    await expect(client.write(path as string, body as any, permit())).rejects.toThrow(
      'PRODUCTION_PILOT_WRITE_FORBIDDEN',
    );
    expect(authorizeMutation).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('allows init only with an exact concrete item and separately authorized body', async () => {
    const transport = response({ ...envelope, response: { model: [{ model_id: 9101 }] } }),
      authorizeMutation = allow();
    const body = {
      item_id: 9001,
      model: [
        {
          model_sku: 'SKU-A',
          tier_index: [0],
          original_price: 10000,
          seller_stock: [{ stock: 1 }],
        },
      ],
      standardise_tier_variation: [
        { variation_name: 'Hương', variation_option_list: [{ variation_option_name: 'Sả' }] },
      ],
    };
    const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
    expect((await client.write(initPath, body, { ...permit(), stepId: 'init' })).kind).toBe(
      'success',
    );
    expect(authorizeMutation.mock.calls[0]![0]).toMatchObject({
      path: initPath,
      fingerprint: productionPilotWriteFingerprint(initPath, body),
    });
  });

  it('uploads exact original bytes with public signing and no token in multipart/query', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]),
      options = { scene: 'normal' as const, ratio: '3:4' as const },
      proof = { ...permit(), stepId: 'gallery-1' };
    const authorizeMutation = allow();
    const transport = response({
      ...envelope,
      response: { image_info: { image_id: 'fixture-image-id' } },
    });
    const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
    expect((await client.upload(bytes, 'image/png', options, proof)).kind).toBe('success');
    expect(authorizeMutation.mock.calls[0]![0]).toEqual({
      ...proof,
      path: '/api/v2/media_space/upload_image',
      fingerprint: productionPilotUploadFingerprint(bytes, 'image/png', options),
    });
    const [address, init] = transport.mock.calls[0]!,
      url = new URL(String(address));
    expect(url.origin).toBe('https://partner.shopeemobile.com');
    expect(url.searchParams.has('access_token')).toBe(false);
    expect(url.searchParams.has('shop_id')).toBe(false);
    expect(url.searchParams.get('sign')).toBe(
      signRequest({
        partnerId: credentials.partnerId,
        partnerKey: credentials.partnerKey,
        path: url.pathname,
        timestamp: Number(url.searchParams.get('timestamp')),
      }),
    );
    const form = init!.body as FormData;
    expect([...form.keys()].sort()).toEqual(['image', 'ratio', 'scene']);
    expect(form.get('scene')).toBe('normal');
    expect(form.get('ratio')).toBe('3:4');
    expect(new Uint8Array(await (form.get('image') as Blob).arrayBuffer())).toEqual(bytes);
    expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
  });

  it('omits ratio for original description assets, and distinguishes bytes/scene/ratio/mime in upload fingerprints', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const transport = response({
      ...envelope,
      response: {
        image_info_list: [{ id: 0, error: '', image_info: { image_id: 'fixture-image-id' } }],
      },
    });
    const client = new ProductionPilotTransport(credentials, {
      transport,
      authorizeMutation: allow(),
    });
    expect((await client.upload(bytes, 'image/png', { scene: 'desc' }, permit())).kind).toBe(
      'success',
    );
    expect((transport.mock.calls[0]![1]?.body as FormData).has('ratio')).toBe(false);
    const digest = productionPilotUploadFingerprint(bytes, 'image/png', { scene: 'desc' });
    expect(
      new Set([
        digest,
        productionPilotUploadFingerprint(new Uint8Array([1, 2, 4]), 'image/png', { scene: 'desc' }),
        productionPilotUploadFingerprint(bytes, 'image/jpeg', { scene: 'desc' }),
        productionPilotUploadFingerprint(bytes, 'image/png', { scene: 'desc', ratio: '3:4' }),
        productionPilotUploadFingerprint(bytes, 'image/png', { scene: 'normal', ratio: '1:1' }),
      ]).size,
    ).toBe(5);
  });

  it.each([
    { bytes: new Uint8Array(), mime: 'image/png', options: { scene: 'desc' } },
    { bytes: new Uint8Array(10_000_001), mime: 'image/png', options: { scene: 'desc' } },
    { bytes: new Uint8Array([1]), mime: 'image/webp', options: { scene: 'desc' } },
    { bytes: new Uint8Array([1]), mime: 'image/png', options: { scene: 'normal' } },
    { bytes: new Uint8Array([1]), mime: 'image/png', options: { scene: 'normal', ratio: '9:16' } },
  ])('rejects unsupported upload before authorizing case %#', async ({ bytes, mime, options }) => {
    const transport = response(),
      authorizeMutation = allow();
    await expect(
      new ProductionPilotTransport(credentials, { transport, authorizeMutation }).upload(
        bytes,
        mime as any,
        options as any,
        permit(),
      ),
    ).rejects.toThrow('PRODUCTION_PILOT_MEDIA_INVALID');
    expect(authorizeMutation).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { image_info_list: [{ id: 0, error: 'error_tier_img_partial' }] },
    {
      image_info: { image_id: 'first' },
      image_info_list: [{ id: 0, error: '', image_info: { image_id: 'other' } }],
    },
    { image_info_list: [] },
    {},
  ])('does not acknowledge an unsuccessful or ambiguous single image upload (%j)', async (body) => {
    const client = new ProductionPilotTransport(credentials, {
      transport: response({ ...envelope, response: body }),
      authorizeMutation: allow(),
    });
    expect(
      (await client.upload(new Uint8Array([1]), 'image/png', { scene: 'desc' }, permit())).kind,
    ).not.toBe('success');
  });

  it.each([
    'invalid_acceess_token',
    'error_partner_key_expired',
    'error_rate_limit',
    'product.error_busi',
  ])('preserves safe API error %s, redacts secrets, and does not retry', async (error) => {
    const transport = response({
      error,
      request_id: 'failure-1',
      message: `${credentials.partnerKey} ${encodeURIComponent(credentials.accessToken)}`,
      access_token: 'unrelated-token',
      response: { partial: true },
    });
    const client = new ProductionPilotTransport(credentials, {
      transport,
      authorizeMutation: allow(),
    });
    const result = await client.write(addPath, payload, permit());
    expect(result).toMatchObject({ kind: 'rejected', code: error, requestId: 'failure-1' });
    expect(result.envelope?.response).toEqual({ partial: true });
    expect(JSON.stringify(result)).not.toContain(credentials.partnerKey);
    expect(JSON.stringify(result)).not.toContain(credentials.accessToken);
    expect(JSON.stringify(result)).not.toContain('unrelated-token');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not expose arbitrary error text as a returned code', async () => {
    const client = new ProductionPilotTransport(credentials, {
      transport: response({
        error: 'untrusted-upstream-secret',
        request_id: 'failure-1',
        message: 'detail',
      }),
      authorizeMutation: allow(),
    });
    expect(await client.write(addPath, payload, permit())).toMatchObject({
      kind: 'rejected',
      code: 'PRODUCTION_PILOT_API_REJECTED',
    });
  });

  it.each([
    {
      status: 500,
      body: { error: 'error_server', request_id: 'uncertain', response: { item_id: 9001 } },
    },
    { status: 200, body: { error: 'product.error_busi_add_item_failed', request_id: 'uncertain' } },
    { status: 502, body: envelope },
    { status: 200, body: {} },
    { status: 200, body: { ...envelope, request_id: '' } },
  ])('classifies uncertain writes without replay (%j)', async ({ status, body }) => {
    const transport = response(body, status),
      proof = permit();
    const client = new ProductionPilotTransport(credentials, {
      transport,
      authorizeMutation: allow(),
    });
    expect((await client.write(addPath, payload, proof)).kind).toBe('unknown');
    await expect(client.write(addPath, payload, proof)).rejects.toThrow(
      'PRODUCTION_PILOT_PERMIT_CONSUMED',
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it('retains composite logistics request IDs and supports top-level shop response', async () => {
    const request_id = 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':';
    const client = new ProductionPilotTransport(credentials, {
      transport: response({ error: '', request_id, shop_name: 'Fixture shop' }),
    });
    expect(await client.read('/api/v2/shop/get_shop_info')).toMatchObject({
      kind: 'success',
      requestId: request_id,
      response: { shop_name: 'Fixture shop' },
    });
  });

  it.each([
    { warehouses: [] },
    {
      warehouses: [
        { warehouse_id: 601, warehouse_type: 1, location_id: 'VN1', address_id: 701, region: 'VN' },
      ],
    },
  ])(
    'preserves a documented warehouse array and its original envelope (%j)',
    async ({ warehouses }) => {
      const raw = { error: '', request_id: 'warehouse-request', response: warehouses };
      const client = new ProductionPilotTransport(credentials, { transport: response(raw) });
      expect(await client.read('/api/v2/shop/get_warehouse_detail')).toEqual({
        kind: 'success',
        requestId: 'warehouse-request',
        response: { warehouses },
        envelope: raw,
      });
    },
  );

  it.each([{}, null, [null], ['warehouse'], [[{}]]].map((warehouses) => ({ warehouses })))(
    'does not acknowledge malformed warehouse rows and retains safe evidence (%j)',
    async ({ warehouses }) => {
      const raw = { error: '', request_id: 'warehouse-request', response: warehouses };
      const client = new ProductionPilotTransport(credentials, { transport: response(raw) });
      expect(await client.read('/api/v2/shop/get_warehouse_detail')).toEqual({
        kind: 'unknown',
        code: 'PRODUCTION_PILOT_INVALID_RESPONSE',
        requestId: 'warehouse-request',
        envelope: raw,
      });
    },
  );

  it('does not accept warehouse-shaped arrays for unrelated read endpoints', async () => {
    const client = new ProductionPilotTransport(credentials, {
      transport: response({ error: '', request_id: 'wrong-shape', response: [] }),
    });
    expect((await client.read('/api/v2/product/get_category')).kind).toBe('unknown');
  });

  it.each([9001, '9001'])(
    'publishes only the immutable single-item intent and checks exact receipt (%j)',
    async (receiptId) => {
      const raw = {
        ...envelope,
        response: { failure_list: [], success_list: [{ item_id: receiptId, unlist: false }] },
      };
      const transport = response(raw),
        authorizeMutation = allow(),
        proof = permit();
      const body = { item_list: [{ item_id: 9001, unlist: false }] };
      const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
      expect(await client.write(publishPath, body, proof)).toEqual({
        kind: 'success',
        requestId: 'fixture-request',
        response: raw.response,
        envelope: raw,
      });
      expect(authorizeMutation.mock.calls[0]![0]).toMatchObject({
        ...proof,
        path: publishPath,
        fingerprint: productionPilotWriteFingerprint(publishPath, body),
      });
      expect(JSON.parse(String(transport.mock.calls[0]![1]?.body))).toEqual(body);
      expect(new URL(String(transport.mock.calls[0]![0])).pathname).toBe(publishPath);
      await expect(client.write(publishPath, body, proof)).rejects.toThrow(
        'PRODUCTION_PILOT_PERMIT_CONSUMED',
      );
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {},
    { item_list: [] },
    { item_list: [{ item_id: 9001, unlist: true }] },
    {
      item_list: [
        { item_id: 9001, unlist: false },
        { item_id: 9002, unlist: false },
      ],
    },
    { item_list: [{ item_id: '9001', unlist: false }] },
    { item_list: [{ item_id: 0, unlist: false }] },
    { item_list: [{ item_id: Number.MAX_SAFE_INTEGER + 1, unlist: false }] },
    { item_list: [{ item_id: 9001, unlist: false, item_name: 'override' }] },
    { item_list: [{ item_id: 9001, unlist: false }], item_status: 'NORMAL' },
  ])('does not authorize broader publication payloads or their fingerprints (%j)', async (body) => {
    const transport = response(),
      authorizeMutation = allow();
    const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
    await expect(client.write(publishPath, body, permit())).rejects.toThrow(
      'PRODUCTION_PILOT_WRITE_FORBIDDEN',
    );
    expect(() => productionPilotWriteFingerprint(publishPath, body)).toThrow(
      'PRODUCTION_PILOT_WRITE_FORBIDDEN',
    );
    expect(authorizeMutation).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { success_list: [{ item_id: 9001, unlist: false }] },
    { failure_list: [], success_list: [] },
    { failure_list: [], success_list: [{ item_id: 9002, unlist: false }] },
    { failure_list: [], success_list: [{ item_id: '09001', unlist: false }] },
    { failure_list: [], success_list: [{ item_id: 9001, unlist: true }] },
    {
      failure_list: [],
      success_list: [
        { item_id: 9001, unlist: false },
        { item_id: 9001, unlist: false },
      ],
    },
    {
      failure_list: [{ item_id: 9001, failed_reason: 'blocked' }],
      success_list: [{ item_id: 9001, unlist: false }],
    },
    { failure_list: [{ item_id: 9002, failed_reason: 'blocked' }], success_list: [] },
    { failure_list: [{ item_id: 9001 }], success_list: [] },
  ])(
    'holds incomplete, conflicting or wrong-item publication receipts without replay (%j)',
    async (data) => {
      const raw = { ...envelope, response: data },
        transport = response(raw),
        proof = permit();
      const client = new ProductionPilotTransport(credentials, {
        transport,
        authorizeMutation: allow(),
      });
      const body = { item_list: [{ item_id: 9001, unlist: false }] };
      expect(await client.write(publishPath, body, proof)).toEqual({
        kind: 'unknown',
        code: 'PRODUCTION_PILOT_PUBLISH_RESPONSE_UNVERIFIED',
        requestId: 'fixture-request',
        envelope: raw,
      });
      await expect(client.write(publishPath, body, proof)).rejects.toThrow(
        'PRODUCTION_PILOT_PERMIT_CONSUMED',
      );
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it('reports an exact item publication failure using a safe code, preserving the sanitized envelope', async () => {
    const raw = {
      ...envelope,
      response: {
        failure_list: [{ item_id: 9001, failed_reason: 'Blocked ' + credentials.accessToken }],
        success_list: [],
      },
    };
    const client = new ProductionPilotTransport(credentials, {
      transport: response(raw),
      authorizeMutation: allow(),
    });
    const result = await client.write(
      publishPath,
      { item_list: [{ item_id: 9001, unlist: false }] },
      permit(),
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'PRODUCTION_PILOT_PUBLISH_REJECTED',
      requestId: 'fixture-request',
      envelope: {
        response: {
          failure_list: [{ item_id: 9001, failed_reason: 'Blocked [redacted]' }],
          success_list: [],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(credentials.accessToken);
  });

  it.each([
    { error: 'product.error_unlist_item_failed' },
    { error: 'error_get_shop_fail' },
    {
      error: 'product.error_param',
      response: { failure_list: [], success_list: [{ item_id: 9001, unlist: false }] },
    },
  ])('treats uncertain publication envelopes as unknown (%j)', async (data) => {
    const raw = { request_id: 'uncertain-publish', ...data };
    const client = new ProductionPilotTransport(credentials, {
      transport: response(raw),
      authorizeMutation: allow(),
    });
    expect(
      await client.write(publishPath, { item_list: [{ item_id: 9001, unlist: false }] }, permit()),
    ).toMatchObject({ kind: 'unknown', requestId: 'uncertain-publish', envelope: raw });
  });

  it('requires a publication permit accepted by the durable coordinator before any network', async () => {
    const body = { item_list: [{ item_id: 9001, unlist: false }] },
      transport = response();
    await expect(
      new ProductionPilotTransport(credentials, { transport }).write(publishPath, body, permit()),
    ).rejects.toThrow('PRODUCTION_PILOT_PERMIT_REQUIRED');
    await expect(
      new ProductionPilotTransport(credentials, {
        transport,
        authorizeMutation: async () => false,
      }).write(publishPath, body, permit()),
    ).rejects.toThrow('PRODUCTION_PILOT_PERMIT_DENIED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('bounds streaming response bytes and cancels oversized bodies', async () => {
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
          },
          cancel,
        }),
      ),
    );
    const result = await new ProductionPilotTransport(credentials, { transport }).read(
      '/api/v2/product/get_category',
    );
    expect(result).toEqual({ kind: 'unknown', code: 'PRODUCTION_PILOT_INVALID_RESPONSE' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts at 12 seconds, drops exception text, and never resends unknown mutation', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error(credentials.accessToken));
    const proof = permit(),
      client = new ProductionPilotTransport(credentials, { transport, authorizeMutation: allow() });
    expect(await client.write(addPath, payload, proof)).toEqual({
      kind: 'unknown',
      code: 'PRODUCTION_PILOT_TRANSPORT',
    });
    expect(timeout).toHaveBeenCalledWith(12000);
    await expect(client.write(addPath, payload, proof)).rejects.toThrow(
      'PRODUCTION_PILOT_PERMIT_CONSUMED',
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it('honors cancellation before authorizing or sending', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = response(),
      authorizeMutation = allow();
    const client = new ProductionPilotTransport(credentials, { transport, authorizeMutation });
    expect(await client.write(addPath, payload, permit(), controller.signal)).toEqual({
      kind: 'unknown',
      code: 'PRODUCTION_PILOT_CANCELLED',
    });
    expect(authorizeMutation).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});
