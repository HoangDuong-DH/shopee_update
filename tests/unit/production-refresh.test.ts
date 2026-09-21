import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  exchangeProductionRefresh,
  parseProductionRefreshResponse,
} from '../../packages/shopee/src/production-refresh.js';
const credentials = {
  partnerId: '2010476',
  shopId: '1423724897',
  partnerKey: 'fixture-key',
  refreshToken: 'fixture-refresh-old',
};
const success = {
  error: '',
  partner_id: 2010476,
  shop_id: 1423724897,
  access_token: 'fixture-access-new',
  refresh_token: 'fixture-refresh-new',
  expire_in: 14400,
  request_id: 'request:refresh',
};
it('signs the fixed public production refresh endpoint, sends only the exact shop and captures encrypted-receipt input before returning tokens', async () => {
  const capture = vi.fn(async () => {});
  const fetcher = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(raw));
    expect(url.origin + url.pathname).toBe(
      'https://partner.shopeemobile.com/api/v2/auth/access_token/get',
    );
    expect(url.searchParams.get('sign')).toBe(
      createHmac('sha256', credentials.partnerKey)
        .update('2010476' + url.pathname + url.searchParams.get('timestamp'))
        .digest('hex'),
    );
    expect([...url.searchParams.keys()].sort()).toEqual(['partner_id', 'sign', 'timestamp']);
    expect(init?.redirect).toBe('error');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      partner_id: 2010476,
      shop_id: 1423724897,
      refresh_token: credentials.refreshToken,
    });
    return new Response(JSON.stringify(success));
  });
  const result = await exchangeProductionRefresh(credentials, { transport: fetcher, capture });
  expect(capture).toHaveBeenCalledExactlyOnceWith({ status: 200, body: JSON.stringify(success) });
  expect(result).toMatchObject({
    kind: 'success',
    expiresIn: 14400,
    accessToken: success.access_token,
    refreshToken: success.refresh_token,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { shopId: '1423724898' },
  { partnerId: '1232297' },
  { merchantId: '42' },
  { refreshToken: '' },
])('rejects altered scope/input before sending %j', async (patch) => {
  const transport = vi.fn();
  expect(
    (
      await exchangeProductionRefresh(
        { ...credentials, ...patch },
        { transport, capture: async () => {} },
      )
    ).kind,
  ).toBe('rejected');
  expect(transport).not.toHaveBeenCalled();
});
it.each([
  { shop_id: 9 },
  { partner_id: 2 },
  { principal_id: 55 },
  { merchant_id: 8 },
  { expire_in: 14401 },
  { expire_in: 0 },
  { expire_in: '14400' },
  { access_token: '' },
  { refresh_token: '' },
  { error: 'error_auth' },
])('does not accept incomplete/wrong scoped token output %j', (patch) => {
  expect(
    parseProductionRefreshResponse({ status: 200, body: JSON.stringify({ ...success, ...patch }) })
      .kind,
  ).toBe('unknown');
});
it('treats transient failures, unknown response and lost receipt as uncertain; never retries or leaks upstream exceptions', async () => {
  const transport = vi.fn(async () => {
    throw Error('secret signed url ' + credentials.refreshToken);
  });
  expect(
    await exchangeProductionRefresh(credentials, { transport, capture: async () => {} }),
  ).toEqual({ kind: 'unknown', reason: 'transport' });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(
    parseProductionRefreshResponse({
      status: 500,
      body: JSON.stringify({ error: 'error_server' }),
    }),
  ).toEqual({ kind: 'unknown', reason: 'invalid_response' });
  expect(
    await exchangeProductionRefresh(credentials, {
      transport: async () => new Response(JSON.stringify(success)),
      capture: async () => {
        throw Error('disk failed');
      },
    }),
  ).toEqual({ kind: 'unknown', reason: 'receipt' });
});
it('redacts rejected upstream messages and makes oversize responses unknown', async () => {
  expect(
    parseProductionRefreshResponse({
      status: 200,
      body: JSON.stringify({ error: 'refresh_token_expired', message: 'secret' }),
    }),
  ).toEqual({ kind: 'rejected', code: 'refresh_token_expired' });
  expect(
    parseProductionRefreshResponse({
      status: 200,
      body: JSON.stringify({ error: 'unsafe-secret-error', message: 'secret' }),
    }),
  ).toEqual({ kind: 'unknown', reason: 'invalid_response' });
  const capture = vi.fn();
  expect(
    await exchangeProductionRefresh(credentials, {
      transport: async () => new Response(' '.repeat(65537)),
      capture,
    }),
  ).toEqual({ kind: 'unknown', reason: 'invalid_response' });
  expect(capture).not.toHaveBeenCalled();
});
