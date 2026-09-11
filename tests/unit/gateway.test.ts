import { expect, it, vi } from 'vitest';
import { signRequest, readShopInfo, SecretBox } from '../../packages/shopee/src/index.js';
it('matches an independent HMAC-SHA256 shop request vector', () => {
  // Generated independently with .NET HMACSHA256; not by signRequest.
  expect(
    signRequest({
      partnerId: '123',
      path: '/api/v2/shop/get_shop_info',
      timestamp: 1600000000,
      accessToken: 'test-access',
      shopId: '456',
      partnerKey: 'test-key',
    }),
  ).toBe('6cc9351ef8129487d63158adbe2bbc00178844628556e0a70a235fcf12b9fa63');
});
it('pins sandbox host, rejects HTTP 200 business errors and does not follow redirects', async () => {
  const transport = vi.fn(async (url: URL, init: RequestInit) => {
    expect(url.hostname).toBe('openplatform.sandbox.test-stable.shopee.sg');
    expect(init.redirect).toBe('error');
    return new Response(JSON.stringify({ error: 'error_auth', request_id: 'r1' }), { status: 200 });
  });
  const r = await readShopInfo(
    {
      environment: 'sandbox',
      partnerId: '123',
      shopId: '456',
      partnerKey: 'key',
      accessToken: 'access',
    },
    transport as typeof fetch,
  );
  expect(r).toEqual({ kind: 'rejected', code: 'error_auth', requestId: 'r1' });
  expect(transport).toHaveBeenCalledTimes(1);
});
it('does not interpret malformed success or timeout as a verified connection', async () => {
  const input = {
    environment: 'sandbox' as const,
    partnerId: '123',
    shopId: '456',
    partnerKey: 'key',
    accessToken: 'access',
  };
  expect((await readShopInfo(input, async () => new Response('{}'))).kind).toBe('unknown');
  expect(
    (
      await readShopInfo(input, async () => {
        throw new Error('secret URL');
      })
    ).kind,
  ).toBe('unknown');
});
it('recognizes structured invalid token errors on HTTP403 rather than reporting a network failure', async () => {
  const result = await readShopInfo(
    {
      environment: 'sandbox',
      partnerId: '123',
      shopId: '456',
      partnerKey: 'test-key',
      accessToken: 'test-access',
    },
    async () =>
      new Response(JSON.stringify({ error: 'invalid_acceess_token', request_id: 'mock-auth' }), {
        status: 403,
      }),
  );
  expect(result).toEqual({
    kind: 'rejected',
    code: 'invalid_acceess_token',
    requestId: 'mock-auth',
  });
});
it('binds encrypted credentials to the intended connection and rejects tampering', () => {
  const box = new SecretBox('ab'.repeat(32));
  const encrypted = box.seal({ accessToken: 'private' }, 'sandbox:123:456');
  expect(encrypted).not.toContain('private');
  expect(box.open(encrypted, 'sandbox:123:456')).toEqual({ accessToken: 'private' });
  expect(() => box.open(encrypted, 'production:123:456')).toThrow();
});
