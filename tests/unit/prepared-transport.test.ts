import { describe, expect, it, vi } from 'vitest';
import { SandboxPreparedTransport } from '../../packages/shopee/src/prepared-transport.js';
import { signRequest } from '../../packages/shopee/src/sign.js';
const credentials = {
  environment: 'sandbox' as const,
  partnerId: '1232297',
  shopId: '227418363',
  partnerKey: 'fixture-key',
  accessToken: 'fixture-token',
};
const allowed = [{ partnerId: credentials.partnerId, shopId: credentials.shopId }];
describe('prepared sandbox HTTP boundary', () => {
  it('rejects production and unlisted owners before touching transport', () => {
    const fetcher = vi.fn();
    expect(
      () =>
        new SandboxPreparedTransport(
          { ...credentials, environment: 'production' },
          allowed,
          fetcher,
        ),
    ).toThrow();
    expect(
      () => new SandboxPreparedTransport({ ...credentials, shopId: '999' }, allowed, fetcher),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('signs the fixed sandbox shop endpoint and disables redirects', async () => {
    let observed: any;
    const client = new SandboxPreparedTransport(credentials, allowed, async (url, init) => {
      observed = { url: new URL(String(url)), init };
      return new Response(
        JSON.stringify({ error: '', request_id: 'fixture-1', response: { item_list: [] } }),
      );
    });
    const result = await client.read('/api/v2/product/get_item_base_info', { item_id_list: '10' });
    expect(result.kind).toBe('success');
    expect(observed.url.origin).toBe('https://openplatform.sandbox.test-stable.shopee.sg');
    expect(observed.init.redirect).toBe('error');
    expect(observed.url.searchParams.get('sign')).toBe(
      signRequest({
        ...credentials,
        path: observed.url.pathname,
        timestamp: Number(observed.url.searchParams.get('timestamp')),
      }),
    );
    expect(observed.url.searchParams.get('shop_id')).toBe(credentials.shopId);
  });
  it('does not allow injected auth query or arbitrary endpoints', async () => {
    const fetcher = vi.fn();
    const client = new SandboxPreparedTransport(credentials, allowed, fetcher);
    await expect(
      client.read('/api/v2/product/get_item_list', { shop_id: '999' }),
    ).rejects.toThrow();
    await expect(client.write('/api/v2/product/delete_item', { item_id: 10 })).rejects.toThrow();
    await expect(
      client.write('/api/v2/product/update_item', { item_id: 803934364, item_name: 'bad' }),
    ).rejects.toThrow();
    await expect(
      client.write('/api/v2/product/add_item', { item_status: 'NORMAL' }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('HTTP200 business errors are not acknowledged and never retried', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_acceess_token',
            request_id: 'fixture-2',
            message: credentials.accessToken,
          }),
        ),
    );
    const result = await new SandboxPreparedTransport(credentials, allowed, fetcher).write(
      '/api/v2/product/update_item',
      { item_id: 10, item_name: 'test' },
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'invalid_acceess_token',
      requestId: 'fixture-2',
    });
    expect(JSON.stringify(result)).not.toContain(credentials.accessToken);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('propagates cancellation, redacts exceptions, and never retries ambiguous writes', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => {
      throw new Error(credentials.accessToken);
    });
    const client = new SandboxPreparedTransport(credentials, allowed, fetcher);
    expect(
      (await client.write('/api/v2/product/update_item', { item_id: 10 }, controller.signal)).kind,
    ).toBe('unknown');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await client.write('/api/v2/product/update_item', { item_id: 10 })).toEqual({
      kind: 'unknown',
      code: 'PREPARED_WIRE_TRANSPORT',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uploads original bytes with Public signing and explicit scene/ratio', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const client = new SandboxPreparedTransport(credentials, allowed, async (input, init) => {
      const url = new URL(String(input));
      expect(url.searchParams.has('shop_id')).toBe(false);
      expect(url.searchParams.has('access_token')).toBe(false);
      expect(url.searchParams.get('sign')).toBe(
        signRequest({
          partnerId: credentials.partnerId,
          partnerKey: credentials.partnerKey,
          path: url.pathname,
          timestamp: Number(url.searchParams.get('timestamp')),
        }),
      );
      const form = init!.body as FormData;
      expect(form.get('scene')).toBe('desc');
      expect(form.get('ratio')).toBe('3:4');
      expect(new Uint8Array(await (form.get('image') as Blob).arrayBuffer())).toEqual(bytes);
      return new Response(
        JSON.stringify({
          error: '',
          request_id: 'fixture-upload',
          response: { image_info: { image_id: 'fixture-image' } },
        }),
      );
    });
    expect((await client.upload(bytes, 'image/png', { scene: 'desc', ratio: '3:4' })).kind).toBe(
      'success',
    );
  });
  it('accepts documented envelope-only acknowledgements without inventing response fields', async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ error: '', request_id: 'fixture-empty' }));
    const client = new SandboxPreparedTransport(credentials, allowed, fetcher);
    expect(
      await client.write('/api/v2/product/update_tier_variation', {
        item_id: 10,
        tier_variation: [],
      }),
    ).toMatchObject({ kind: 'success', response: {}, requestId: 'fixture-empty' });
    expect((await client.write('/api/v2/product/add_item', { item_status: 'UNLIST' })).kind).toBe(
      'unknown',
    );
  });
  it('retains composite request IDs returned by logistics', async () => {
    const requestId = 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':';
    const client = new SandboxPreparedTransport(
      credentials,
      allowed,
      async () =>
        new Response(
          JSON.stringify({
            error: '',
            request_id: requestId,
            response: { logistics_channel_list: [] },
          }),
        ),
    );
    expect(await client.read('/api/v2/logistics/get_channel_list')).toMatchObject({
      kind: 'success',
      requestId,
      response: { logistics_channel_list: [] },
    });
  });
  it('preserves redacted partial-error envelopes and treats server failures as uncertain', async () => {
    const envelope = {
      error: 'error_server',
      request_id: 'partial-1',
      message: credentials.accessToken,
      response: { success_list: [{ model_id: 11 }], failure_list: [{ model_id: 12 }] },
      warning: 'partial',
    };
    const client = new SandboxPreparedTransport(
      credentials,
      allowed,
      async () => new Response(JSON.stringify(envelope), { status: 500 }),
    );
    const result = await client.write('/api/v2/product/update_stock', {
      item_id: 10,
      stock_list: [],
    });
    expect(result.kind).toBe('unknown');
    expect(result.envelope).toMatchObject({
      response: envelope.response,
      warning: 'partial',
      message: '[redacted]',
    });
  });
  it('omits the ratio parameter for source description uploads when no ratio was specified', async () => {
    const client = new SandboxPreparedTransport(credentials, allowed, async (_url, init) => {
      expect((init!.body as FormData).has('ratio')).toBe(false);
      return new Response(
        JSON.stringify({
          error: '',
          request_id: 'desc',
          response: { image_info: { image_id: 'original-desc' } },
        }),
      );
    });
    expect((await client.upload(new Uint8Array([1]), 'image/png', { scene: 'desc' })).kind).toBe(
      'success',
    );
  });
});
