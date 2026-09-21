import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { inspectPass1Recommendations } from '../../scripts/inspect-pass1-category-recommendations.mjs';
import type { PreparedWireResponse } from '../../packages/shopee/src/prepared-transport.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' };
const definitions = [
  ['row-119', '510', 'DAHUwW7ykRA'], ['row-193', '775', 'DAHUw7s0-JQ'],
  ['row-194', '777', 'DAHUw9nu-fA'], ['row-192', '772', 'DAHUw8fpWQM'],
];
function fixture() {
  const markdown = Buffer.from('Original source title');
  const receipt = { version: 1, batchId: 'production-batch-pass1-20260915', scope: { ...scope },
    sourceFiles: definitions.map(([, number]) => ({ id: 'markdown-' + number, role: 'listing-markdown',
      path: '/fixture/' + number + '.md', sha256: hash(markdown) })),
    listings: definitions.map(([sourceKey, sourceNumber, canvaId]) => ({ sourceKey, sourceNumber, canvaId,
      sourceFileId: 'markdown-' + sourceNumber, title: '  Tiêu đề ' + sourceNumber + '  ' })),
  };
  const categories = [{ category_id: 1, parent_category_id: 0, has_children: true,
    original_category_name: 'Home', display_category_name: 'Nhà cửa' },
  { category_id: 2, parent_category_id: 1, has_children: false,
    original_category_name: 'Fragrance', display_category_name: 'Hương thơm' }];
  const read = vi.fn<(path: string, query: Record<string, string>) => Promise<PreparedWireResponse>>(async (path: string) => ({ kind: 'success' as const, requestId: 'fixture-request',
    response: path.endsWith('get_shop_info') ? { shop_name: 'Shop fixture', region: 'VN', status: 'NORMAL' }
      : path.endsWith('get_category') ? { category_list: categories } : { category_id: [2] },
    envelope: { error: '', request_id: 'fixture-request' },
  }));
  const save = vi.fn(async () => undefined);
  const bytes = () => Buffer.from(JSON.stringify(receipt));
  const options = () => ({ receiptBytes: bytes(), expectedSha256: hash(bytes()),
    readMarkdown: vi.fn(async () => markdown), read, save });
  return { receipt, markdown, categories, read, save, options };
}
describe('exact four-source category recommendation inspection', () => {
  it('sends only six GETs, keeps source titles verbatim and returns candidates without authority or selection', async () => {
    const data = fixture();
    const result = await inspectPass1Recommendations(data.options());
    expect(data.read.mock.calls.map(call => call[0])).toEqual([
      '/api/v2/shop/get_shop_info', '/api/v2/product/get_category',
      ...Array(4).fill('/api/v2/product/category_recommend'),
    ]);
    expect(data.read.mock.calls[2]).toEqual(['/api/v2/product/category_recommend', { item_name: '  Tiêu đề 510  ' }]);
    expect(result).toMatchObject({ readOnly: true, mutations: 0, categorySelection: null,
      categoryAuthorizationVerified: false });
    expect(result.listings).toHaveLength(4);
    expect(result.listings[0]).toMatchObject({ sourceKey: 'row-119', candidates: [
        { categoryId: 2, path: 'Nhà cửa > Hương thơm', leaf: true, inShopTree: true },
      ] });
    expect(data.save).toHaveBeenCalledTimes(7);
  });
  it.each(['digest', 'scope', 'duplicate', 'missing', 'canva', 'markdown'])('rejects %s source changes before any GET', async kind => {
    const data = fixture();
    if (kind === 'scope') data.receipt.scope.shopId = '999';
    if (kind === 'duplicate') data.receipt.listings[1] = { ...data.receipt.listings[0]! };
    if (kind === 'missing') data.receipt.listings.pop();
    if (kind === 'canva') data.receipt.listings[0]!.canvaId = 'other';
    const options = data.options();
    if (kind === 'digest') options.expectedSha256 = 'f'.repeat(64);
    if (kind === 'markdown') options.readMarkdown.mockResolvedValue(Buffer.from('changed'));
    await expect(inspectPass1Recommendations(options)).rejects.toThrow(/^PASS1_CATEGORY_/);
    expect(data.read).not.toHaveBeenCalled();
  });
  it('stops after a shop identity response with a different explicit shop ID', async () => {
    const data = fixture();
    data.read.mockResolvedValueOnce({ kind: 'success', requestId: 'shop-request', envelope: {},
      response: { shop_name: 'Other', shop_id: 999, region: 'VN', status: 'NORMAL' } } as any);
    await expect(inspectPass1Recommendations(data.options())).rejects.toThrow('PASS1_CATEGORY_SHOP_UNVERIFIED');
    expect(data.read).toHaveBeenCalledTimes(1);
  });
  it('never picks a different category when a recommended ID is absent from the shop tree', async () => {
    const data = fixture();
    data.read.mockImplementation(async path => ({ kind: 'success', requestId: 'fixture-request', envelope: {},
      response: path.endsWith('get_shop_info') ? { shop_name: 'Shop', region: 'VN', status: 'NORMAL' }
        : path.endsWith('get_category') ? { category_list: data.categories } : { category_id: [999] } }));
    const result = await inspectPass1Recommendations(data.options());
    expect(result.listings[0]).toMatchObject({ candidates: [{ categoryId: 999, path: null, inShopTree: false }] });
    expect(result.categorySelection).toBeNull();
  });
  it('rejects ambiguous category-tree identities instead of using the first entry', async () => {
    const data = fixture();
    data.categories.push({ ...data.categories[1]! });
    await expect(inspectPass1Recommendations(data.options())).rejects.toThrow('PASS1_CATEGORY_TREE_INVALID');
    expect(data.read).toHaveBeenCalledTimes(2);
  });
  it('records denied recommendation receipts without inventing a candidate or exposing error messages', async () => {
    const data = fixture();
    data.read.mockImplementation(async path => path.endsWith('category_recommend')
      ? { kind: 'rejected', code: 'error_api_permission', requestId: 'permission-request',
        envelope: { message: 'Private diagnostic' } } as any
      : { kind: 'success', requestId: 'fixture-request', envelope: {}, response: path.endsWith('get_shop_info')
        ? { shop_name: 'Shop', region: 'VN', status: 'NORMAL' } : { category_list: data.categories } });
    const result = await inspectPass1Recommendations(data.options());
    expect(result.listings.every(entry => entry.state === 'rejected' && entry.candidates.length === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Private diagnostic');
  });
});
