import { describe, expect, it, vi } from 'vitest';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import { ArchiveTargetMetadataReader } from '../../apps/api/src/archive-target-metadata.js';
import type { Repository } from '@shopee/persistence';

const key = 'a'.repeat(64);
const scope = 'production:2010476:1293590748';
const box = new SecretBox(key);
const row = () => ({
  id: 'connection-1', environment: 'production', partner_id: '2010476', shop_id: '1293590748',
  state: 'connected', refresh_status: 'idle', revision: 4, expires_at: new Date(Date.now() + 600_000),
  partner_key_ciphertext: box.seal({ partnerKey: 'partner-secret' }, scope),
  token_ciphertext: box.seal({ accessToken: 'access-secret' }, scope),
});
const repo = (read: () => ReturnType<typeof row>) => ({ pool: { query: vi.fn(async () => ({ rows: [read()] })) } }) as unknown as Repository;
const data = (path: string, offset: string | null) => {
  if (path.endsWith('/get_shop_info')) return { shop_id: 1293590748, shop_name: 'Earth Choice', region: 'VN', status: 'NORMAL' };
  if (path.endsWith('/get_category')) return { response: { category_list: [
    { category_id: 1, parent_category_id: 0, display_category_name: 'Home', has_children: true },
    { category_id: 2, parent_category_id: 1, display_category_name: 'Cleaner', has_children: false },
  ] } };
  if (path.endsWith('/get_attribute_tree')) return { response: { list: [{ category_id: 2, attribute_tree: [] }] } };
  if (path.endsWith('/get_item_limit')) return { response: { stock_limit: { min_limit: 0, max_limit: 1000 } } };
  if (path.endsWith('/get_brand_list')) return { response: offset === '0'
    ? { brand_list: [{ brand_id: 3, original_brand_name: 'Other' }], has_next_page: true, next_offset: 1 }
    : { brand_list: [{ brand_id: 4, original_brand_name: 'Source Brand' }], has_next_page: false } };
  if (path.endsWith('/get_channel_list')) return { response: { logistics_channel_list: [
    { logistics_channel_id: 7, logistics_channel_name: 'Shopee Express', enabled: true, compulsory_channel: false },
  ] } };
  if (path.endsWith('/get_warehouse_detail')) return { response: [{ warehouse_id: 88 }] };
  throw Error(path);
};
const transport = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const body = data(url.pathname, url.searchParams.get('offset'));
  return new Response(JSON.stringify({ error: '', request_id: 'req-1', ...body }), { status: 200 });
}) as unknown as typeof fetch;

describe('archive target metadata', () => {
  it('reads the selected shop with full brand pagination and GET-only transport', async () => {
    const reader = new ArchiveTargetMetadataReader(repo(row), { encryptionKey: key, transport });
    const result = await reader.collect({ partnerId: '2010476', shopId: '1293590748',
      categories: [{ path: ['Home', 'Cleaner'], brandNames: ['Source Brand'] }] });
    expect(result.selected[0]?.brands).toEqual({ complete: true, requestedNames: ['Source Brand'],
      rows: [{ id: '4', name: 'Source Brand' }] });
    expect(result.selected[0]?.categoryId).toBe('2');
    expect(result.channels.rows[0]?.logistics_channel_name).toBe('Shopee Express');
    expect(result.warehouse.status).toBe('available');
    expect(result.evidence.filter(v => v.path.endsWith('/get_brand_list'))).toHaveLength(2);
    expect(vi.mocked(transport).mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('checks a supplied source brand ID and exact name with one cursor page', async () => {
    const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = data(url.pathname, url.searchParams.get('offset'));
      return new Response(JSON.stringify({ error: '', request_id: 'req-brand', ...body }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await new ArchiveTargetMetadataReader(repo(row), { encryptionKey: key, transport: request }).collect({
      partnerId: '2010476', shopId: '1293590748',
      categories: [{ path: ['Home', 'Cleaner'], brandNames: ['Source Brand'],
        brandRefs: [{ sourceId: '4', name: 'Source Brand' }] }],
    });
    expect(result.selected[0]?.brands?.rows).toEqual([{ id: '4', name: 'Source Brand' }]);
    expect(result.evidence.filter(v => v.path.endsWith('/get_brand_list'))).toHaveLength(1);
    expect(vi.mocked(request).mock.calls.some(([url]) => new URL(String(url)).searchParams.get('offset') === '3')).toBe(true);
  });
  it('records confirmed warehouse whitelist denial without guessing a location', async () => {
    const denied = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/get_warehouse_detail'))
        return new Response(JSON.stringify({ error: 'warehouse.error_not_in_whitelist', request_id: 'req-denied' }), { status: 200 });
      return new Response(JSON.stringify({ error: '', request_id: 'req-ok', ...data(url.pathname, url.searchParams.get('offset')) }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await new ArchiveTargetMetadataReader(repo(row), { encryptionKey: key, transport: denied }).collect({
      partnerId: '2010476', shopId: '1293590748', categories: [],
    });
    expect(result.warehouse).toEqual({ status: 'not_whitelisted' });
  });  it('rejects a connection revision change during reads', async () => {
    let calls = 0;
    const database = repo(() => ({ ...row(), revision: ++calls > 2 ? 5 : 4 }));
    await expect(new ArchiveTargetMetadataReader(database, { encryptionKey: key, transport }).collect({
      partnerId: '2010476', shopId: '1293590748', categories: [],
    })).rejects.toThrow('ARCHIVE_TARGET_CONNECTION_CHANGED');
  });
  it('rejects a cross-shop credential lookup before network access', async () => {
    const database = repo(row);
    await expect(new ArchiveTargetMetadataReader(database, { encryptionKey: key, transport }).collect({
      partnerId: '2010476', shopId: '966101536', categories: [],
    })).rejects.toThrow('ARCHIVE_TARGET_AUTH_REQUIRED');
  });
});

