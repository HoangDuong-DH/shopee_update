import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeProductionAuthorization } from '../../packages/shopee/src/authorization.js';

const credentials = {
  partnerId: '2010476',
  partnerKey: 'fixture-partner-key',
  code: 'fixture-one-use-code',
  shopId: '1423724897',
};
const success = {
  error: '',
  access_token: 'fixture-access-token',
  refresh_token: 'fixture-refresh-token',
  expire_in: 14400,
  request_id: 'request-fixture-1',
};
const reply = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));

afterEach(() => vi.useRealTimers());

describe('bounded production authorization exchange', () => {
  it('signs a public POST to the fixed production endpoint and returns only token contract fields', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T10:00:00Z'));
    const transport = reply({ ...success, message: 'ignored', unused: 'ignored' });
    const result = await exchangeProductionAuthorization(credentials, transport);
    expect(result).toEqual({
      kind: 'success',
      accessToken: success.access_token,
      refreshToken: success.refresh_token,
      expiresIn: 14400,
      requestId: success.request_id,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [address, init] = transport.mock.calls[0]!;
    const url = new URL(String(address));
    expect(url.origin).toBe('https://partner.shopeemobile.com');
    expect(url.pathname).toBe('/api/v2/auth/token/get');
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      partner_id: credentials.partnerId,
      timestamp,
      sign: createHmac('sha256', credentials.partnerKey)
        .update(`${credentials.partnerId}/api/v2/auth/token/get${timestamp}`)
        .digest('hex'),
    });
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      partner_id: 2010476,
      code: credentials.code,
      shop_id: 1423724897,
    });
    expect(String(address)).not.toContain(credentials.code);
    expect(String(address)).not.toContain(credentials.partnerKey);
  });

  it('handles main-account response and preserves shop identifiers as exact strings', async () => {
    const transport = reply({ ...success, shop_id_list: [1423724897, 227418363] });
    const result = await exchangeProductionAuthorization(
      { ...credentials, shopId: undefined, mainAccountId: '12345' },
      transport,
    );
    expect(result).toMatchObject({ kind: 'success', shopIdList: ['1423724897', '227418363'] });
    expect(JSON.parse(String(transport.mock.calls[0]![1]?.body))).toEqual({
      partner_id: 2010476,
      code: credentials.code,
      main_account_id: 12345,
    });
  });

  it.each([
    { shopId: undefined },
    { mainAccountId: '123' },
    { shopId: '0' },
    { shopId: '-1' },
    { shopId: '00123' },
    { shopId: '9007199254740992' },
    { shopId: '1e3' },
    { partnerId: '4294967296' },
    { partnerId: '0' },
    { code: '' },
    { code: 'x'.repeat(4097) },
    { code: 'has\nnewline' },
    { partnerKey: '' },
  ])('rejects malformed account/credential input before network (%j)', async (overrides) => {
    const transport = reply(success);
    expect(
      await exchangeProductionAuthorization({ ...credentials, ...overrides }, transport),
    ).toEqual({ kind: 'rejected', code: 'INVALID_AUTHORIZATION_INPUT' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    'invalid_code',
    'invalid_shop_id',
    'invalid_main_acount_id',
    'error_partner_key_expired',
    'error_auth',
    'error_sign',
    'error_rate_limit',
    'source_ip_undeclared',
  ])('returns documented error %s without arbitrary upstream details or retry', async (code) => {
    const transport = reply({
      error: code,
      message: credentials.code,
      request_id: credentials.partnerKey,
    });
    expect(await exchangeProductionAuthorization(credentials, transport)).toEqual({
      kind: 'rejected',
      code,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('redacts an unrecognized upstream error even on HTTP 400', async () => {
    const transport = reply(
      { error: `secret-${credentials.code}`, message: credentials.partnerKey },
      400,
    );
    expect(await exchangeProductionAuthorization(credentials, transport)).toEqual({
      kind: 'rejected',
      code: 'AUTHORIZATION_REJECTED',
    });
  });

  it('does not treat a successful body on HTTP error as success', async () => {
    expect(await exchangeProductionAuthorization(credentials, reply(success, 500))).toEqual({
      kind: 'unknown',
      reason: 'transport',
    });
  });

  it.each([
    null,
    [],
    {},
    { ...success, error: undefined },
    { ...success, access_token: '' },
    { ...success, refresh_token: undefined },
    { ...success, expire_in: 0 },
    { ...success, expire_in: -1 },
    { ...success, expire_in: 1767001812 },
    { ...success, expire_in: '14400' },
    { ...success, expire_in: 12.3 },
    { ...success, access_token: 'bad\ntoken' },
    { ...success, shop_id_list: [9007199254740992] },
    { ...success, request_id: 'bad\nrequest' },
    { ...success, shop_id_list: ['1423724897'] },
  ])('refuses incomplete or ambiguous success responses (%j)', async (body) => {
    expect(await exchangeProductionAuthorization(credentials, reply(body))).toEqual({
      kind: 'unknown',
      reason: 'invalid_response',
    });
  });

  it.each([undefined, []])(
    'requires usable shop membership for a main-account response (%j)',
    async (shop_id_list) => {
      expect(
        await exchangeProductionAuthorization(
          { ...credentials, shopId: undefined, mainAccountId: '12345' },
          reply({ ...success, shop_id_list }),
        ),
      ).toEqual({ kind: 'unknown', reason: 'invalid_response' });
    },
  );

  it.each(['merchant_id_list', 'supplier_id_list', 'user_id_list', 'principal_id_list'])(
    'rejects additional grant types in %s for this shop-only connector',
    async (field) => {
      expect(
        await exchangeProductionAuthorization(credentials, reply({ ...success, [field]: [12345] })),
      ).toEqual({ kind: 'unknown', reason: 'invalid_response' });
    },
  );

  it('classifies malformed JSON as invalid_response', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{'));
    expect(await exchangeProductionAuthorization(credentials, transport)).toEqual({
      kind: 'unknown',
      reason: 'invalid_response',
    });
  });

  it('bounds streaming response bytes and cancels oversized responses', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65537));
      },
      cancel,
    });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    expect(await exchangeProductionAuthorization(credentials, transport)).toEqual({
      kind: 'unknown',
      reason: 'invalid_response',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts once after 12 seconds and never retries a single-use code', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('fixture only', 'TimeoutError'));
    expect(await exchangeProductionAuthorization(credentials, transport)).toEqual({
      kind: 'unknown',
      reason: 'transport',
    });
    expect(timeout).toHaveBeenCalledWith(12000);
    expect(transport).toHaveBeenCalledOnce();
    timeout.mockRestore();
  });
});
