import { expect, it, vi } from 'vitest';
import { SellerKnowledgeTransport } from '../../apps/api/src/seller-knowledge-transport.js';
const credentials = {
  environment: 'production' as const,
  partnerId: '99',
  shopId: '456',
  partnerKey: 'private-partner-key',
  accessToken: 'private-access-token',
};
it('uses only GET with signed scope, denies mutations and rejects caller-supplied credentials', async () => {
  const transport = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ request_id: 'r1', response: { item: [], has_next_page: false } }),
      ),
  );
  const reader = new SellerKnowledgeTransport(credentials, transport as typeof fetch);
  await expect(reader.read('/api/v2/product/add_item', {})).rejects.toThrow(
    'KNOWLEDGE_ENDPOINT_FORBIDDEN',
  );
  await expect(reader.read('/api/v2/product/get_item_list', { access_token: 'x' })).rejects.toThrow(
    'KNOWLEDGE_ENDPOINT_FORBIDDEN',
  );
  await reader.read('/api/v2/product/get_item_list', {
    offset: '0',
    page_size: '100',
    item_status: 'NORMAL',
  });
  const args = transport.mock.calls[0] as any;
  expect(args[1].method).toBe('GET');
  expect(new URL(args[0]).searchParams.get('shop_id')).toBe('456');
  expect(transport).toHaveBeenCalledTimes(1);
});
it('removes secret keys and credential values from durable responses', async () => {
  const reader = new SellerKnowledgeTransport(
    credentials,
    (async () =>
      new Response(
        JSON.stringify({
          request_id: 'private-access-token',
          response: {
            access_token: 'x',
            note: 'private-partner-key',
            nested: { refresh_token: 'x' },
          },
        }),
      )) as typeof fetch,
  );
  const result = JSON.stringify(await reader.read('/api/v2/product/get_category', {}));
  expect(result).not.toContain('private-access-token');
  expect(result).not.toContain('private-partner-key');
  expect(result).not.toContain('refresh_token');
});
it.each([
  { status: 200, error: 'error_param' },
  { status: 429, error: 'error_rate_limit' },
])(
  'redacts a credential reflected in request IDs on error paths: $status',
  async ({ status, error }) => {
    const reader = new SellerKnowledgeTransport(
      credentials,
      (async () =>
        new Response(JSON.stringify({ error, request_id: credentials.accessToken }), {
          status,
        })) as typeof fetch,
    );
    expect(JSON.stringify(await reader.read('/api/v2/product/get_item_list', {}))).not.toContain(
      credentials.accessToken,
    );
  },
);
