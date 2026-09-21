import { describe, expect, it, vi } from 'vitest';
import { SandboxPreparedTransport } from '../../packages/shopee/src/prepared-transport.js';
import {
  inspectPreparedWireAcknowledgement,
  type PreparedWireStep,
} from '../../packages/shopee/src/prepared-wire.js';

const credentials = {
  environment: 'sandbox' as const,
  partnerId: '910001',
  shopId: '920001',
  partnerKey: 'only-a-test-partner-secret',
  accessToken: 'only-a-test-access-secret',
};
const allowed = [{ partnerId: credentials.partnerId, shopId: credentials.shopId }];
const price: PreparedWireStep = {
  path: '/api/v2/product/update_price',
  method: 'POST',
  group: 'price',
  payload: { item_id: 930001, price_list: [{ model_id: 940001, original_price: 25000 }] },
  expectedModelIds: ['940001'],
};

describe('patch transport failures do not turn into successful updates', () => {
  it.each([
    ['HTML gateway failure', 502, '<html>Bad gateway</html>'],
    ['truncated success JSON', 200, '{"error":"","request_id":"broken","response":'],
    [
      'missing business error field',
      200,
      JSON.stringify({ request_id: 'missing-error', response: {} }),
    ],
    [
      'missing receipt identity',
      200,
      JSON.stringify({
        error: '',
        response: { success_list: [{ model_id: 940001, original_price: 25000 }] },
      }),
    ],
    [
      'HTTP failure with success-shaped body',
      503,
      JSON.stringify({
        error: '',
        request_id: 'bad-http',
        response: { success_list: [{ model_id: 940001, original_price: 25000 }] },
      }),
    ],
  ])('%s leaves a price update uncertain and never retries', async (_name, status, body) => {
    const fetcher = vi.fn(async () => new Response(body, { status }));
    const client = new SandboxPreparedTransport(credentials, allowed, fetcher);
    const result = await client.write(price.path, price.payload);
    expect(result.kind).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(inspectPreparedWireAcknowledgement(price, result.envelope).success).toBe(false);
  });

  it.each(['error_rate_limit', 'error_limit', 'invalid_acceess_token', 'error_api_permission'])(
    '%s on a cover change is recorded without an automatic second write',
    async (error) => {
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error, request_id: 'cover-fault', message: 'not accepted' }),
            {
              status: error === 'error_rate_limit' ? 429 : 200,
              headers: { 'Retry-After': '1' },
            },
          ),
      );
      const client = new SandboxPreparedTransport(credentials, allowed, fetcher);
      const result = await client.write('/api/v2/product/update_item', {
        item_id: 930001,
        promotion_images: { image_id_list: ['fixture-cover-new'] },
      });
      expect(result).toMatchObject({ kind: 'rejected', code: error, requestId: 'cover-fault' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('retains partial model evidence when the HTTP layer reports a server failure', async () => {
    const expected = {
      success_list: [{ model_id: 940001, original_price: 25000 }],
      failure_list: [{ model_id: 940002, failed_reason: 'promotion locked' }],
    };
    const client = new SandboxPreparedTransport(
      credentials,
      allowed,
      async () =>
        new Response(
          JSON.stringify({
            error: 'error_server',
            request_id: 'partial-price-server',
            response: expected,
          }),
          { status: 500 },
        ),
    );
    const result = await client.write(price.path, {
      ...price.payload,
      price_list: [...price.payload.price_list, { model_id: 940002, original_price: 26000 }],
    });
    expect(result.kind).toBe('unknown');
    expect(result.envelope?.response).toEqual(expected);
  });

  it('a disconnected response body cannot acknowledge a cover or leak credentials', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"error":"","response":'));
              controller.error(new Error('socket disconnected ' + credentials.accessToken));
            },
          }),
        ),
    );
    const client = new SandboxPreparedTransport(credentials, allowed, fetcher);
    const result = await client.write('/api/v2/product/update_item', {
      item_id: 930001,
      promotion_images: { image_id_list: ['fixture-cover-new'] },
    });
    expect(result.kind).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(credentials.accessToken);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('an image upload with an unreadable reply remains unresolved and never uploads again itself', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetcher = vi.fn(async (_url, init) => {
      const form = init!.body as FormData;
      expect(new Uint8Array(await (form.get('image') as Blob).arrayBuffer())).toEqual(bytes);
      return new Response('connection lost after upload');
    });
    const client = new SandboxPreparedTransport(credentials, allowed, fetcher);
    expect((await client.upload(bytes, 'image/png', { scene: 'normal', ratio: '1:1' })).kind).toBe(
      'unknown',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
