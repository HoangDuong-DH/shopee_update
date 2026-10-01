import type { Repository } from '@shopee/persistence';
import { SecretBox } from '@shopee/gateway';
import { z } from 'zod';
import { ProductionPilotTransport } from '../../../packages/shopee/src/production-pilot-transport.js';

const positive = z.string().regex(/^[1-9]\d{0,15}$/).refine(v => Number.isSafeInteger(Number(v)));
const querySchema = z.object({
  partnerId: z.string().regex(/^[1-9]\d{0,9}$/).refine(v => Number(v) <= 4294967295),
  shopId: positive,
  categories: z.array(z.object({ path: z.array(z.string().trim().min(1).max(256)).min(1).max(20),
    brandNames: z.array(z.string().trim().min(1).max(256)).max(20),
    brandRefs: z.array(z.object({ sourceId: positive, name: z.string().trim().min(1).max(256) }).strict()).max(20).optional(),
  }).strict()).max(30),
}).strict();
export type ArchiveTargetMetadataQuery = z.infer<typeof querySchema>;
type Json = Record<string, any>;
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (code: string): never => { throw Error('ARCHIVE_TARGET_' + code); };
const id = (v: unknown, zero = false): string => {
  const text = String(v);
  if ((zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(text) && Number.isSafeInteger(Number(text))) return text;
  return fail('RESPONSE_INVALID');
};
export type TargetReadEvidence = { path: string; query: Record<string, string>; requestId: string; observedAt: string };
export type ArchiveTargetMetadata = {
  scope: { environment: 'production'; partnerId: string; shopId: string };
  connectionRevision: number; observedAt: string;
  shop: { id: string; name: string; status: string; region: string };
  categories: { complete: true; rows: { id: string; path: string[]; leaf: boolean }[] };
  selected: { path: string[]; categoryId: string | null; itemLimits: Json | null;
    attributeTree: unknown[] | null; brands: { complete: true; requestedNames: string[];
      rows: { id: string; name: string }[] } | null }[];
  channels: { complete: true; rows: Json[] };
  warehouse: { status: 'available'; rows: Json[] } | { status: 'not_whitelisted' };
  evidence: TargetReadEvidence[];
};
function categories(data: Json): ArchiveTargetMetadata['categories'] {
  if (!Array.isArray(data.category_list) || data.category_list.length > 30_000) fail('CATEGORY_INVALID');
  const map = new Map<string, { parent: string; name: string; leaf: boolean }>();
  for (const row of data.category_list) {
    if (!object(row) || typeof row.has_children !== 'boolean') fail('CATEGORY_INVALID');
    const key = id(row.category_id), parent = id(row.parent_category_id, true);
    const name = row.display_category_name || row.original_category_name;
    if (map.has(key) || typeof name !== 'string' || !name.trim()) fail('CATEGORY_INVALID');
    map.set(key, { parent, name, leaf: !row.has_children });
  }
  const path = (key: string, visited = new Set<string>()): string[] => {
    if (visited.has(key) || visited.size > 20) return fail('CATEGORY_INVALID');
    const row = map.get(key);
    if (!row) return fail('CATEGORY_INVALID');
    visited.add(key);
    return row.parent === '0' ? [row.name] : [...path(row.parent, visited), row.name];
  };
  return { complete: true, rows: [...map].map(([key, row]) => ({ id: key, path: path(key), leaf: row.leaf })) };
}
/** GET-only metadata for a named connected shop. No write permit is supplied. */
export class ArchiveTargetMetadataReader {
  constructor(private readonly repo: Repository, private readonly options: {
    transport?: typeof fetch; encryptionKey?: string; now?: () => number;
  } = {}) {}
  async collect(raw: unknown, signal?: AbortSignal): Promise<ArchiveTargetMetadata> {
    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) return fail('QUERY_INVALID');
    const input = parsed.data, now = this.options.now ?? Date.now;
    const scope = { environment: 'production' as const, partnerId: input.partnerId, shopId: input.shopId };
    const current = async () => {
      signal?.throwIfAborted();
      const rows = (await this.repo.pool.query('SELECT * FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3',
        ['production', input.partnerId, input.shopId])).rows;
      if (rows.length !== 1) return fail('AUTH_REQUIRED');
      const row = rows[0];
      if (row.environment !== 'production' || String(row.partner_id) !== input.partnerId ||
        String(row.shop_id) !== input.shopId || row.state !== 'connected' ||
        !Number.isSafeInteger(row.revision) || row.revision <= 0 ||
        Date.parse(String(row.expires_at)) <= now() ||
        !Number.isFinite(Date.parse(String(row.expires_at))) ||
        ['unknown', 'reauth_required'].includes(row.refresh_status)) return fail('AUTH_REQUIRED');
      return row;
    };
    const connection = await current();
    const stillCurrent = async () => {
      const row = await current();
      if (row.id !== connection.id || row.revision !== connection.revision) fail('CONNECTION_CHANGED');
    };
    let partnerKey: string, accessToken: string;
    try {
      const box = new SecretBox(this.options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? '');
      const owner = `production:${input.partnerId}:${input.shopId}`;
      partnerKey = (box.open(connection.partner_key_ciphertext, owner) as { partnerKey: string }).partnerKey;
      accessToken = (box.open(connection.token_ciphertext, owner) as { accessToken: string }).accessToken;
    } catch { return fail('AUTH_REQUIRED'); }
    const client = new ProductionPilotTransport({ ...scope, partnerKey, accessToken }, { transport: this.options.transport });
    const evidence: TargetReadEvidence[] = [];
    const get = async (path: string, query: Record<string, string> = {}, allowedError?: string): Promise<Json> => {
      await stillCurrent();
      const response = await client.read(path, query, signal);
      await stillCurrent();
      if (response.kind === 'rejected' && allowedError === response.code && response.requestId) {
        evidence.push({ path, query, requestId: response.requestId, observedAt: new Date(now()).toISOString() });
        return { confirmedError: allowedError };
      }
      if (response.kind !== 'success') return fail('READ_FAILED_' + path.split('/').at(-1)!.toUpperCase() + '_' + response.code.replace(/[^A-Z0-9_]/gi, '_').slice(0, 100));
      evidence.push({ path, query, requestId: response.requestId, observedAt: new Date(now()).toISOString() });
      return response.response;
    };
    const shop = await get('/api/v2/shop/get_shop_info');
    if (shop.region !== 'VN' || shop.status !== 'NORMAL' || typeof shop.shop_name !== 'string' ||
      !shop.shop_name || (shop.shop_id !== undefined && String(shop.shop_id) !== input.shopId) ||
      (Number.isSafeInteger(shop.expire_time) && shop.expire_time * 1000 <= now()))
      fail('SHOP_IDENTITY_MISMATCH');
    const categoryTree = categories(await get('/api/v2/product/get_category', { language: 'vi' }));
    const selected: ArchiveTargetMetadata['selected'] = [];
    for (const source of input.categories) {
      const matches = categoryTree.rows.filter(row => row.leaf && row.path.length === source.path.length &&
        row.path.every((part, index) => part === source.path[index]));
      if (matches.length > 1) fail('CATEGORY_AMBIGUOUS');
      const categoryId = matches[0]?.id ?? null;
      const entry: ArchiveTargetMetadata['selected'][number] = {
        path: source.path, categoryId, itemLimits: null, attributeTree: null, brands: null,
      };
      selected.push(entry);
      if (!categoryId) continue;
      entry.itemLimits = await get('/api/v2/product/get_item_limit', { category_id: categoryId });
      const attributes = await get('/api/v2/product/get_attribute_tree', { category_id_list: categoryId, language: 'vn' });
      const trees = Array.isArray(attributes.list) ? attributes.list.filter((row: unknown) => object(row) && String(row.category_id) === categoryId) : [];
      if (trees.length !== 1 || !Array.isArray(trees[0].attribute_tree)) fail('ATTRIBUTE_INVALID');
      entry.attributeTree = trees[0].attribute_tree;
      const requestedNames = [...new Set(source.brandNames)];
      if (source.brandRefs?.length) {
        if (source.brandRefs.length !== requestedNames.length ||
          new Set(source.brandRefs.map(ref => ref.name)).size !== requestedNames.length ||
          source.brandRefs.some(ref => !requestedNames.includes(ref.name))) fail('BRAND_REFS_INVALID');
        const probed: { id: string; name: string }[] = [];
        for (const ref of source.brandRefs) {
          const page = await get('/api/v2/product/get_brand_list', {
            category_id: categoryId, status: '1', offset: String(Number(ref.sourceId) - 1),
            page_size: '100', language: 'vi',
          });
          if (!Array.isArray(page.brand_list) || page.brand_list.length > 100) fail('BRAND_INVALID');
          const matches = page.brand_list.filter((row: unknown) => object(row) &&
            id(row.brand_id, true) === ref.sourceId && row.original_brand_name === ref.name);
          if (matches.length && page.brand_list.some((row: unknown) => object(row) &&
            id(row.brand_id, true) === ref.sourceId && row.original_brand_name !== ref.name))
            fail('BRAND_ID_NAME_CONFLICT');
          if (matches.length) probed.push({ id: ref.sourceId, name: ref.name });
        }
        if (probed.length === requestedNames.length) {
          entry.brands = { complete: true, requestedNames, rows: probed };
          continue;
        }
      }
      const all = new Map<string, string>();
      const seenOffsets = new Set<number>();
      let offset = 0;
      for (let page = 0; page < 200; page++) {
        if (seenOffsets.has(offset)) fail('BRAND_CURSOR_INVALID');
        seenOffsets.add(offset);
        const brands = await get('/api/v2/product/get_brand_list', {
          category_id: categoryId, status: '1', offset: String(offset), page_size: '100', language: 'vi',
        });
        if (!Array.isArray(brands.brand_list) || brands.brand_list.length > 100 || typeof brands.has_next_page !== 'boolean')
          fail('BRAND_INVALID');
        const pageIds = new Set<string>();
        for (const row of brands.brand_list) {
          if (!object(row) || typeof row.original_brand_name !== 'string') fail('BRAND_INVALID');
          const key = id(row.brand_id, true);
          if (all.has(key) && all.get(key) !== row.original_brand_name) fail('BRAND_INVALID');
          pageIds.add(key); all.set(key, row.original_brand_name);
        }
        if (!brands.has_next_page) {
          entry.brands = { complete: true, requestedNames,
            rows: [...all].filter(([, name]) => requestedNames.includes(name)).map(([id, name]) => ({ id, name })) };
          break;
        }
        if (!Number.isSafeInteger(brands.next_offset) || brands.next_offset <= offset || !brands.brand_list.length)
          fail('BRAND_CURSOR_INVALID');
        offset = brands.next_offset;
      }
      if (!entry.brands) fail('BRAND_PAGINATION_LIMIT_REACHED');
    }
    const channelData = await get('/api/v2/logistics/get_channel_list');
    if (!Array.isArray(channelData.logistics_channel_list) || channelData.logistics_channel_list.length > 1000 ||
      channelData.logistics_channel_list.some((row: unknown) => !object(row) || typeof row.enabled !== 'boolean'))
      fail('LOGISTICS_INVALID');
    const channels = { complete: true as const, rows: channelData.logistics_channel_list as Json[] };
    const warehouseData = await get('/api/v2/shop/get_warehouse_detail', { warehouse_type: '1' }, 'warehouse.error_not_in_whitelist');
    const warehouse: ArchiveTargetMetadata['warehouse'] = warehouseData.confirmedError
      ? { status: 'not_whitelisted' }
      : Array.isArray(warehouseData.warehouses) && warehouseData.warehouses.every(object)
        ? { status: 'available', rows: warehouseData.warehouses }
        : fail('WAREHOUSE_INVALID');
    await stillCurrent();
    return { scope, connectionRevision: connection.revision, observedAt: new Date(now()).toISOString(),
      shop: { id: input.shopId, name: shop.shop_name, status: shop.status, region: shop.region },
      categories: categoryTree, selected, channels, warehouse, evidence };
  }
}
