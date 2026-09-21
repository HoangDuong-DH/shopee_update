import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from '@shopee/persistence';
import { SecretBox, signRequest } from '@shopee/gateway';

// Read-only metadata evidence for the three supplied VINA listings. No write route,
// credential refresh, DB update, generic URL or automatic reuse of old listing facts.
// Full source docs read: get_category/get_brand_list 2021-10-29,
// get_attribute_tree/get_warehouse_detail 2025-01-13, get_item_limit 2025-01-08,
// get_channel_list 2026-05-22. Fresh responses are saved; missing fields stay unknown.
const target = Object.freeze({ partnerId: '2010476', shopId: '1423724897',
  connectionId: '2bb497e4-a306-4b1e-85ba-5ee7a814fdaf', revision: 1 });
const categoryId = 101128;
const scope = `production:${target.partnerId}:${target.shopId}`;
const prior = resolve('.local/production-pilot-1423724897/items-f7c5c0e1-41a8-4174-8341-d1666a20a321');
const output = resolve('.local/production-pilot-1423724897', 'metadata-' + randomUUID());
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (code: string): never => { throw new Error(code); };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const nameKey = (value: unknown) => typeof value === 'string' ? value.normalize('NFC').trim().toLocaleLowerCase('vi') : '';
const paths = {
  category: '/api/v2/product/get_category', attributes: '/api/v2/product/get_attribute_tree',
  brand: '/api/v2/product/get_brand_list', limit: '/api/v2/product/get_item_limit',
  channels: '/api/v2/logistics/get_channel_list', warehouse: '/api/v2/shop/get_warehouse_detail',
} as const;
let stage = 'source', createdOutput = false;
let redact = (value: unknown): unknown => value;
const reads: Record<string, unknown>[] = [];
async function save(name: string, value: unknown) {
  await writeFile(resolve(output, name + '.json'), JSON.stringify(redact(value), null, 2), { flag: 'wx' });
}
async function connection() {
  const row = (await pool.query(`SELECT id,environment,partner_id,shop_id,revision,state,expires_at,
    partner_key_ciphertext,token_ciphertext FROM connections WHERE id=$1`, [target.connectionId])).rows[0];
  if (!row || row.environment !== 'production' || row.partner_id !== target.partnerId ||
    row.shop_id !== target.shopId || row.revision !== target.revision || row.state !== 'connected' ||
    !row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) fail('CONNECTION_NOT_READY');
  return row;
}
async function boundedBody(response: Response) {
  if (!response.body) return fail('RESPONSE_BODY_MISSING');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 8 * 1024 * 1024) {
        await reader.cancel().catch(() => undefined); return fail('RESPONSE_TOO_LARGE');
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
try {
  const priorBytes = await readFile(resolve(prior, 'manifest.json'));
  const manifest = JSON.parse(priorBytes.toString('utf8'));
  if (manifest.complete !== true || manifest.readOnly !== true || manifest.mutations !== 0 ||
    manifest.target?.partnerId !== target.partnerId || manifest.target?.shopId !== target.shopId ||
    manifest.target?.connectionId !== target.connectionId || manifest.target?.revision !== target.revision ||
    manifest.receivedItems !== 53 || manifest.receivedModelLists !== 53) fail('SOURCE_AUDIT_MISMATCH');
  const refsBytes = await readFile(resolve(prior, 'observed-references.json'));
  const refs = JSON.parse(refsBytes.toString('utf8'));
  if (!Array.isArray(refs)) fail('SOURCE_REFERENCES_INVALID');
  const referenceIds = ['42476682098', '43902288627', '29336954435'];
  const candidateRefs = referenceIds.map(id => {
    const found = refs.filter((entry: any) => entry.itemId === id);
    if (found.length !== 1 || found[0].categoryId !== categoryId ||
      found[0].brand?.original_brand_name !== 'vuatinhdau') fail('SOURCE_REFERENCE_CHANGED');
    return { itemId: id, title: found[0].title, categoryId, brand: found[0].brand,
      physicallyIdenticalSkuProven: false, approvedForReuse: false };
  });
  stage = 'connection';
  const row = await connection();
  stage = 'credentials';
  const box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? '');
  const key = box.open(row.partner_key_ciphertext, scope) as { partnerKey?: unknown };
  const token = box.open(row.token_ciphertext, scope) as { accessToken?: unknown; refreshToken?: unknown };
  if (typeof key.partnerKey !== 'string' || key.partnerKey.length < 8 ||
    typeof token.accessToken !== 'string' || token.accessToken.length < 8) fail('CREDENTIALS_UNAVAILABLE');
  const partnerKey = key.partnerKey as string, accessToken = token.accessToken as string;
  const secrets = [partnerKey, accessToken, token.refreshToken, process.env.APP_ENCRYPTION_KEY]
    .filter((value): value is string => typeof value === 'string' && !!value);
  redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let safe = value;
      for (const secret of secrets) safe = safe.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]');
      return safe.replace(/([?&](?:access_token|refresh_token|partner_key|sign)=)[^&\s"<>]*/gi, '$1[REDACTED]');
    }
    if (Array.isArray(value)) return value.map(redact);
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, /^(?:access_token|refresh_token|partner_key|sign|authorization|cookie|set-cookie)$/i.test(key)
        ? '[REDACTED]' : redact(child)]));
    return value;
  };
  await mkdir(output, { recursive: true }); createdOutput = true;
  await save('source', { target, prior, manifestSha256: hash(priorBytes), referencesSha256: hash(refsBytes),
    sourceKeys: ['row-2', 'row-11', 'row-65'], candidateCategoryId: categoryId,
    categoryIsCandidateOnly: true, references: candidateRefs });

  async function get(endpoint: string, query: Record<string, string>, name: string) {
    const allowed = endpoint === paths.category ? JSON.stringify(query) === JSON.stringify({ language: 'vi' })
      : endpoint === paths.attributes ? JSON.stringify(query) === JSON.stringify({ category_id_list: String(categoryId), language: 'vn' })
      : endpoint === paths.limit ? JSON.stringify(query) === JSON.stringify({ category_id: String(categoryId) })
      : endpoint === paths.channels ? Object.keys(query).length === 0
      : endpoint === paths.warehouse ? JSON.stringify(query) === JSON.stringify({ warehouse_type: '1' })
      : endpoint === paths.brand && Object.keys(query).length === 5 && query.category_id === String(categoryId) &&
        query.page_size === '100' && query.language === 'vi' && ['1', '2'].includes(query.status ?? '') &&
        /^\d+$/.test(query.offset ?? '') && Number.isSafeInteger(Number(query.offset));
    if (!allowed) fail('UNALLOWED_METADATA_READ');
    await connection();
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = signRequest({ partnerId: target.partnerId, shopId: target.shopId, partnerKey, accessToken, path: endpoint, timestamp });
    secrets.push(sign);
    const url = new URL(endpoint, 'https://partner.shopeemobile.com');
    for (const [key, value] of Object.entries({ ...query, partner_id: target.partnerId, shop_id: target.shopId,
      access_token: accessToken, timestamp: String(timestamp), sign })) url.searchParams.set(key, value);
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json' } });
    const rawText = await boundedBody(response);
    let body: unknown;
    try { body = JSON.parse(rawText); } catch { fail('NON_JSON_RESPONSE'); }
    const observedAt = new Date().toISOString();
    const receipt = { observedAt, target, endpoint, method: 'GET', query, httpStatus: response.status, body };
    await save(name, receipt);
    if (!record(body) || typeof body.error !== 'string') fail('METADATA_ENVELOPE_INVALID');
    const envelope = body as Record<string, any>;
    const requestId = typeof envelope.request_id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(envelope.request_id)
      ? envelope.request_id : null;
    const success = response.ok && envelope.error === '' && !!requestId;
    reads.push({ name, observedAt, endpoint, method: 'GET', query, httpStatus: response.status, requestId, success });
    if (endpoint === paths.warehouse && response.ok && requestId && envelope.error === 'warehouse.error_not_in_whitelist')
      return { warehouseUnavailable: true, error: envelope.error };
    if (!success) fail('METADATA_READ_FAILED');
    if (endpoint === paths.warehouse ? !Array.isArray(envelope.response) : !record(envelope.response)) fail('METADATA_RESPONSE_SHAPE_INVALID');
    await new Promise(done => setTimeout(done, 100)); // Operational pacing, not a documented quota.
    return envelope.response;
  }

  stage = 'category';
  const categories = await get(paths.category, { language: 'vi' }, 'categories');
  if (!Array.isArray(categories.category_list)) fail('CATEGORY_LIST_MISSING');
  const allCategories = categories.category_list as Record<string, any>[];
  const category = allCategories.filter(entry => entry.category_id === categoryId);
  if (category.length !== 1 || typeof category[0].has_children !== 'boolean') fail('CATEGORY_UNVERIFIED');
  const categoryPath: Record<string, any>[] = [];
  const seen = new Set<number>();
  let cursor: Record<string, any> | undefined = category[0];
  while (cursor) {
    if (seen.has(cursor.category_id)) fail('CATEGORY_PARENT_CYCLE');
    seen.add(cursor.category_id); categoryPath.unshift(cursor);
    if (!cursor.parent_category_id) break;
    const parents = allCategories.filter(entry => entry.category_id === cursor!.parent_category_id);
    if (parents.length !== 1) fail('CATEGORY_PARENT_UNVERIFIED');
    cursor = parents[0];
  }
  stage = 'item-limit';
  const limits = await get(paths.limit, { category_id: String(categoryId) }, 'item-limit');
  stage = 'attributes';
  const attributes = await get(paths.attributes, { category_id_list: String(categoryId), language: 'vn' }, 'attributes');
  if (!Array.isArray(attributes.list) || attributes.list.filter((entry: any) => entry.category_id === categoryId).length !== 1)
    fail('ATTRIBUTE_CATEGORY_UNVERIFIED');
  stage = 'channels';
  const channels = await get(paths.channels, {}, 'channels');
  if (!Array.isArray(channels.logistics_channel_list)) fail('CHANNEL_LIST_MISSING');
  stage = 'brands';
  const brandScans: Record<string, any>[] = [];
  for (const status of ['1', '2']) {
    let offset = 0, finished = false;
    const visited = new Set<number>();
    const scan: Record<string, any> = { status, pages: 0, exhausted: false, exactNameMatches: [], similarUnaccentedNames: [],
      fieldsObserved: [] };
    for (let page = 0; page < 50; page++) {
      if (visited.has(offset)) fail('BRAND_PAGINATION_CYCLE');
      visited.add(offset);
      const data = await get(paths.brand, { offset: String(offset), page_size: '100', category_id: String(categoryId), status, language: 'vi' },
        `brands-${status}-${offset}`);
      if (!Array.isArray(data.brand_list) || typeof data.has_next_page !== 'boolean') fail('BRAND_PAGINATION_UNVERIFIED');
      scan.pages++;
      scan.fieldsObserved.push({ offset, is_mandatory: data.is_mandatory ?? null, input_type: data.input_type ?? null });
      for (const brand of data.brand_list) {
        if (!record(brand) || !Number.isSafeInteger(brand.brand_id)) fail('BRAND_ENTRY_INVALID');
        const names = [nameKey(brand.original_brand_name), nameKey(brand.display_brand_name)];
        if (names.includes(nameKey('VINA TƯƠI'))) scan.exactNameMatches.push(brand);
        else if (names.some(value => value.normalize('NFD').replace(/\p{M}/gu, '') === 'vina tuoi'))
          scan.similarUnaccentedNames.push(brand);
      }
      if (!data.has_next_page) { scan.exhausted = true; finished = true; break; }
      if (scan.exactNameMatches.length) { finished = true; break; }
      if (!Number.isSafeInteger(data.next_offset) || data.next_offset <= offset) fail('BRAND_PAGINATION_UNVERIFIED');
      offset = data.next_offset;
    }
    scan.operationalPageCapReached = !finished;
    brandScans.push(scan);
    if (!finished) break;
    if (status === '1' && scan.exactNameMatches.length) break;
  }
  stage = 'warehouse';
  // Current parameter table contains warehouse_type only; stale examples mention region.
  // No guessed region fallback/retry: preserve errors if the live endpoint requires more.
  const warehouses = await get(paths.warehouse, { warehouse_type: '1' }, 'warehouses');
  stage = 'save';
  const result = { output, target, observedAt: new Date().toISOString(), readOnly: true, mutations: 0, complete: true,
    snapshotAtomic: false, reads, candidateCategoryId: categoryId, categoryPath, categoryIsLeaf: category[0].has_children === false,
    categoryProductSuitabilityApproved: false, limits, attributes, brandScans,
    logistics: { channels, pauseStateVerified: false, chosenChannel: null },
    stockWarehouses: warehouses, stockLocationSelected: false, referencesApprovedForReuse: false,
    notes: ['VINA source brand is not the vuatinhdau brand on existing references.',
      'Do not copy manufacturer address from a company-name-only reference.',
      'Missing size chart/GTIN/weight/dimension flags are unknown, not false.',
      'Brand pagination may stop after an exact name; inspect exhausted and operationalPageCapReached.',
      'Stock location must follow warehouse response and shop support; no default location is invented.'] };
  await save('manifest', result);
  console.log(JSON.stringify({ output, readOnly: true, mutations: 0, complete: true, categoryId,
    categoryPath: categoryPath.map(entry => entry.display_category_name), categoryIsLeaf: result.categoryIsLeaf,
    exactVinaBrands: brandScans.flatMap(scan => scan.exactNameMatches.map((brand: any) =>
      ({ status: scan.status, id: brand.brand_id, name: brand.original_brand_name }))),
    enabledChannelCount: channels.logistics_channel_list.filter((entry: any) => entry.enabled === true).length,
    warehouseCount: Array.isArray(warehouses) ? warehouses.length : null,
    warehouseUnavailable: record(warehouses) && warehouses.warehouseUnavailable === true }, null, 2));
} catch (error) {
  const candidate = error instanceof Error ? error.message : '';
  const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(candidate) ? candidate : 'METADATA_INSPECTION_FAILED';
  if (createdOutput) await save('failure', { output, target, stage, code, complete: false, readOnly: true, mutations: 0, reads });
  console.log(JSON.stringify({ output: createdOutput ? output : null, stage, code, complete: false, readOnly: true, mutations: 0 }));
  process.exitCode = 1;
} finally { await pool.end(); }
