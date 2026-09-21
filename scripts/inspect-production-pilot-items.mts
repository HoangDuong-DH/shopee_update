import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from '@shopee/persistence';
import { SecretBox, signRequest } from '@shopee/gateway';

// Bounded, read-only audit of the 53 UNLIST IDs already observed, plus BANNED/REVIEWING.
// Sources read in full: get_item_base_info (2026-04-03), get_model_list (2026-07-31),
// get_item_list (2024-10-18). Deleted statuses are never requested.
// This file has no generic URL input, mutation endpoint, token refresh or DB write.
const target = Object.freeze({ partnerId: '2010476', shopId: '1423724897',
  connectionId: '2bb497e4-a306-4b1e-85ba-5ee7a814fdaf', revision: 1 });
const scope = `production:${target.partnerId}:${target.shopId}`;
const sourceFile = resolve('.local/production-pilot-1423724897/read-207d727b-a717-47f1-b38e-e263cffbc598/items-unlist.json');
const normalSourceFile = resolve('.local/production-pilot-1423724897/read-207d727b-a717-47f1-b38e-e263cffbc598/items-normal.json');
const output = resolve('.local/production-pilot-1423724897', 'items-' + randomUUID());
const basePath = '/api/v2/product/get_item_base_info';
const modelPath = '/api/v2/product/get_model_list';
const listPath = '/api/v2/product/get_item_list';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const fingerprint = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const candidates = [
  { sourceKey: 'row-2', sourceCell: '01 VINA TUOI!F5', canvaId: 'DAHUmT4_SaQ',
    skus: ['VTSJC5L', 'VTHLC5L', 'VTBHLC5L', 'VTBDCC5L', 'VTBHC5L', 'VTHTC5L',
      'VTCSC5L', 'VTVQC5L', 'VTRTC5L', 'VTSCC5L', 'VTOHC5L', 'VTTTC5L'] },
  { sourceKey: 'row-11', sourceCell: '01 VINA TUOI!F14', canvaId: 'DAHUmfQj44c',
    skus: ['VTTHL50', 'VTTHL30'] },
  { sourceKey: 'row-65', sourceCell: '01 VINA TUOI!F68', canvaId: 'DAHUwEfYi4I',
    skus: ['VTTDNLT300', 'VTTDNLT100', 'VTTDNLT500'] },
];
const fail = (code: string): never => { throw new Error(code); };
const idOf = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  return fail('INVALID_ITEM_ID');
};
let stage = 'source', createdOutput = false;
let redact = (value: unknown): unknown => value;
const reads: Record<string, unknown>[] = [];
const items: Record<string, any>[] = [];
const models = new Map<string, Record<string, any>>();
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
async function boundedText(response: Response) {
  if (!response.body) return fail('RESPONSE_BODY_MISSING');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) {
        await reader.cancel().catch(() => undefined);
        return fail('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

try {
  const sourceBytes = await readFile(sourceFile), source = JSON.parse(sourceBytes.toString('utf8'));
  if (source.scope?.partnerId !== target.partnerId || source.scope?.shopId !== target.shopId ||
    source.scope?.connectionId !== target.connectionId || source.scope?.revision !== target.revision ||
    source.endpoint !== '/api/v2/product/get_item_list' || source.method !== 'GET' ||
    source.query?.item_status !== 'UNLIST' || source.status !== 200 || source.body?.error !== '' ||
    source.body?.response?.has_next_page !== false || source.body?.response?.total_count !== 53 ||
    !Array.isArray(source.body.response.item)) fail('UNEXPECTED_SOURCE_INVENTORY');
  const ids = source.body.response.item.map((item: any) => {
    if (item.item_status !== 'UNLIST') fail('UNEXPECTED_SOURCE_STATUS');
    return idOf(item.item_id);
  }) as string[];
  if (ids.length !== 53 || new Set(ids).size !== 53) fail('UNEXPECTED_SOURCE_INVENTORY');
  const normalBytes = await readFile(normalSourceFile), normal = JSON.parse(normalBytes.toString('utf8'));
  if (normal.scope?.partnerId !== target.partnerId || normal.scope?.shopId !== target.shopId ||
    normal.scope?.connectionId !== target.connectionId || normal.scope?.revision !== target.revision ||
    normal.endpoint !== listPath || normal.method !== 'GET' || normal.query?.item_status !== 'NORMAL' ||
    normal.status !== 200 || normal.body?.error !== '' || normal.body?.response?.has_next_page !== false ||
    normal.body?.response?.total_count !== 0 || (normal.body?.response?.item?.length ?? 0) !== 0)
    fail('UNEXPECTED_SOURCE_INVENTORY');
  const allowedIds = new Set(ids);
  const sourceCatalogFile = resolve('.local/input-catalog/vina-tuoi-20260914/catalog-snapshot.json');
  const sourceCatalogBytes = await readFile(sourceCatalogFile);
  const catalog = JSON.parse(sourceCatalogBytes.toString('utf8'));
  if (catalog.catalog?.id !== 'fd983d71-dbe4-4980-a3d6-d2f90d9f117c') fail('UNEXPECTED_SOURCE_CATALOG');
  const dorisFile = resolve('.local/input-catalog/doris-20260914/audit/relevant-products.json');
  const dorisBytes = await readFile(dorisFile), doris = JSON.parse(dorisBytes.toString('utf8'));
  if (!Array.isArray(doris)) fail('UNEXPECTED_DORIS_SOURCE');
  for (const candidate of candidates) {
    if (!catalog.listings?.some((entry: any) => entry.id === candidate.sourceKey &&
      entry.brand === 'VINA TƯƠI' && entry.designCandidates?.some((design: any) => design.id === candidate.canvaId)))
      fail('CANDIDATE_SOURCE_CHANGED');
    for (const sku of candidate.skus) if (doris.filter((entry: any) => entry.fields?.sku?.value === sku &&
      entry.fields?.brand?.value === 'VINA TƯƠI').length !== 1) fail('CANDIDATE_SKU_SOURCE_CHANGED');
  }
  stage = 'connection';
  const row = await connection();
  stage = 'credentials';
  const box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? '');
  const key = box.open(row.partner_key_ciphertext, scope) as { partnerKey?: unknown };
  const token = box.open(row.token_ciphertext, scope) as { accessToken?: unknown; refreshToken?: unknown };
  if (typeof key.partnerKey !== 'string' || key.partnerKey.length < 8 ||
    typeof token.accessToken !== 'string' || token.accessToken.length < 8) fail('CREDENTIALS_UNAVAILABLE');
  const partnerKey = key.partnerKey as string, accessToken = token.accessToken as string;
  const secretValues = [partnerKey, accessToken, token.refreshToken, process.env.APP_ENCRYPTION_KEY]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let safe = value;
      for (const secret of secretValues) safe = safe.replaceAll(secret, '[REDACTED]')
        .replaceAll(encodeURIComponent(secret), '[REDACTED]');
      return safe.replace(/([?&](?:access_token|refresh_token|partner_key|sign)=)[^&\s"<>]*/gi, '$1[REDACTED]');
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, child]) =>
      [name, /^(?:access_token|refresh_token|partner_key|sign|authorization|cookie|set-cookie)$/i.test(name)
        ? '[REDACTED]' : redact(child)]));
    return value;
  };
  await mkdir(output, { recursive: true }); createdOutput = true;
  await save('source-inventory', { sourceFile, sourceSha256: fingerprint(sourceBytes),
    normalSourceFile, normalSourceSha256: fingerprint(normalBytes),
    sourceCatalogFile, sourceCatalogSha256: fingerprint(sourceCatalogBytes),
    dorisFile, dorisSha256: fingerprint(dorisBytes), target, itemIds: ids, candidates,
    scope: 'Read 53 observed UNLIST items, plus paged BANNED/REVIEWING IDs and their models. No deleted-status query or permission to reuse facts.' });

  async function get(path: string, query: Record<string, string>, name: string) {
    if (path === basePath) {
      const queried = query.item_id_list?.split(',') ?? [];
      if (Object.keys(query).length !== 1 || !queried.length || queried.length > 50 ||
        queried.some(id => !allowedIds.has(id))) fail('UNALLOWED_READ');
    } else if (path === modelPath) {
      if (Object.keys(query).length !== 1 || !allowedIds.has(query.item_id ?? '')) fail('UNALLOWED_READ');
    } else if (path === listPath) {
      if (Object.keys(query).length !== 3 || !['BANNED', 'REVIEWING'].includes(query.item_status ?? '') ||
        query.page_size !== '100' || !/^\d+$/.test(query.offset ?? '') ||
        !Number.isSafeInteger(Number(query.offset))) fail('UNALLOWED_READ');
    } else fail('UNALLOWED_READ');
    await connection();
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = signRequest({ partnerId: target.partnerId, shopId: target.shopId, partnerKey,
      accessToken, path, timestamp });
    secretValues.push(sign);
    const url = new URL(path, 'https://partner.shopeemobile.com');
    for (const [name, value] of Object.entries({ ...query, partner_id: target.partnerId,
      shop_id: target.shopId, access_token: accessToken, timestamp: String(timestamp), sign })) url.searchParams.set(name, value);
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
    const raw = await boundedText(response);
    let body: any;
    try { body = JSON.parse(raw); } catch { fail('INVALID_JSON_RESPONSE'); }
    const observedAt = new Date().toISOString();
    await save(name, { observedAt, scope: target, method: 'GET', endpoint: path, query,
      httpStatus: response.status, body });
    reads.push({ name, observedAt, endpoint: path, method: 'GET', query, httpStatus: response.status,
      requestId: body?.request_id, success: response.ok && body?.error === '' });
    if (!response.ok || body?.error !== '' || !body.response || typeof body.response !== 'object')
      fail('SHOPEE_READ_REJECTED');
    return body.response;
  }
  const inventoryCoverage: Record<string, unknown>[] = [
    { status: 'UNLIST', mode: 'prior_snapshot', count: ids.length, observedAt: source.observedAt, sourceFile },
    { status: 'NORMAL', mode: 'prior_snapshot', count: 0, observedAt: normal.observedAt, sourceFile: normalSourceFile },
  ];
  for (const status of ['BANNED', 'REVIEWING']) {
    let offset = 0, finished = false, expectedCount: number | undefined;
    const observed = new Set<string>(), visitedOffsets = new Set<number>();
    // Operational scan cap, not a Shopee limit. Hitting it fails coverage instead of reporting complete.
    for (let page = 0; page < 10; page++) {
      if (visitedOffsets.has(offset)) fail('INVALID_LIST_PAGINATION');
      visitedOffsets.add(offset); stage = 'items-' + status.toLowerCase() + '-' + page;
      const data = await get(listPath, { offset: String(offset), page_size: '100', item_status: status }, stage);
      if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 || typeof data.has_next_page !== 'boolean' ||
        (data.item !== undefined && !Array.isArray(data.item))) fail('INVALID_LIST_RESPONSE');
      if (expectedCount !== undefined && data.total_count !== expectedCount) fail('INVENTORY_CHANGED_DURING_READ');
      expectedCount = data.total_count;
      const pageItems = data.item ?? [];
      if (pageItems.length > 100 || (!pageItems.length && data.has_next_page)) fail('INVALID_LIST_PAGINATION');
      for (const item of pageItems) {
        if (item.item_status !== status) fail('UNEXPECTED_SOURCE_STATUS');
        const itemId = idOf(item.item_id);
        if (observed.has(itemId)) fail('INVENTORY_CHANGED_DURING_READ');
        observed.add(itemId);
        if (!allowedIds.has(itemId)) { allowedIds.add(itemId); ids.push(itemId); }
      }
      if (!data.has_next_page) {
        if (observed.size !== expectedCount) fail('INCOMPLETE_LIST_RESPONSE');
        finished = true; break;
      }
      // next_offset is the documented continuation; never synthesize an offset or
      // silently interpret the undocumented next field as an offset/cursor.
      if (!Number.isSafeInteger(data.next_offset) || data.next_offset <= offset) fail('UNDOCUMENTED_LIST_CONTINUATION');
      offset = data.next_offset;
    }
    if (!finished) fail('INVENTORY_SCAN_LIMIT_REACHED');
    inventoryCoverage.push({ status, mode: 'fresh_paginated_read', count: observed.size,
      itemIds: [...observed], pages: visitedOffsets.size });
  }
  await save('expanded-inventory', { target, itemIds: ids, inventoryCoverage,
    deletedStatusesRequested: false, snapshotAtomic: false });
  for (let offset = 0; offset < ids.length; offset += 50) {
    stage = 'base-' + (offset / 50 + 1);
    const batch = ids.slice(offset, offset + 50);
    const data = await get(basePath, { item_id_list: batch.join(',') }, stage);
    if (!Array.isArray(data.item_list)) fail('INVALID_BASE_RESPONSE');
    const found = data.item_list.map((item: any) => idOf(item.item_id));
    if (found.length !== batch.length || new Set(found).size !== batch.length ||
      found.some((id: string) => !batch.includes(id))) fail('INCOMPLETE_BASE_RESPONSE');
    for (const item of data.item_list) {
      if (typeof item.has_model !== 'boolean' || typeof item.item_name !== 'string' ||
        typeof item.item_sku !== 'string') fail('INVALID_BASE_RESPONSE');
      if (!['UNLIST', 'NORMAL', 'BANNED', 'REVIEWING'].includes(item.item_status)) fail('UNEXPECTED_CURRENT_STATUS');
      items.push(item);
    }
  }
  for (const item of items.filter(item => item.has_model === true)) {
    const itemId = idOf(item.item_id);
    stage = 'models-' + itemId;
    const data = await get(modelPath, { item_id: itemId }, stage);
    if (!Array.isArray(data.model) || !Array.isArray(data.tier_variation) || !data.model.length)
      fail('INVALID_MODEL_RESPONSE');
    const modelIds = data.model.map((model: any) => idOf(model.model_id));
    if (new Set(modelIds).size !== modelIds.length) fail('INVALID_MODEL_RESPONSE');
    models.set(itemId, data);
    // Operational pacing only; this is not an asserted Shopee rate limit.
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const references = items.map(item => {
    const itemId = idOf(item.item_id), modelData = models.get(itemId);
    return { itemId, itemStatus: item.item_status, title: item.item_name, itemSku: item.item_sku,
      categoryId: item.category_id, brand: item.brand, attributeList: item.attribute_list,
      logistics: item.logistic_info, weight: item.weight, dimension: item.dimension,
      preOrder: item.pre_order, condition: item.condition, wholesales: item.wholesales,
      modelData, apiVerified: true, approvedForReuse: false,
      note: 'Observed item facts only. Match the physical SKU, product purpose, size and packaging before reuse.' };
  });
  await save('observed-references', references);
  const matching = candidates.map(candidate => {
    const source = catalog.listings.find((entry: any) => entry.id === candidate.sourceKey);
    return { ...candidate, sourceTitle: source.title, matchingIsNotReuseApproval: true,
      exactTitleItems: items.filter(item => item.item_name === source.title).map(item => idOf(item.item_id)),
      skuMatches: candidate.skus.map(sku => {
        const sourceSku = doris.find((entry: any) => entry.fields.sku.value === sku);
        return { sku, sourceTitle: sourceSku.fields.title.value, dorisRow: sourceSku.row,
          matches: items.flatMap(item => {
            const itemId = idOf(item.item_id);
            const parentMatch = item.item_sku === sku ? [{ itemId, basis: 'exact_item_sku', itemSku: sku,
              needsPhysicalProductReview: true }] : [];
            const modelMatches = (models.get(itemId)?.model ?? []).filter((model: any) => model.model_sku === sku)
              .map((model: any) => ({ itemId, basis: 'exact_model_sku', modelId: idOf(model.model_id),
                modelSku: sku, tierIndex: model.tier_index, needsPhysicalProductReview: true }));
            return [...parentMatch, ...modelMatches];
          }) };
      }) };
  });
  await save('candidate-matches', matching);
  const summary = items.map(item => ({ itemId: idOf(item.item_id), title: item.item_name,
    itemSku: item.item_sku, categoryId: item.category_id, hasModel: item.has_model,
    imageCounts: { gallery: item.image?.image_id_list?.length ?? null,
      cover: item.promotion_image?.image_id_list?.length ?? null,
      description: item.description_info?.extended_description?.field_list?.filter((field: any) => field.field_type === 'image').length ?? null } }));
  await save('manifest', { output, target, observedAt: new Date().toISOString(), readOnly: true,
    mutations: 0, complete: true, inventoryCoverage, deletedStatusesRequested: false, snapshotAtomic: false,
    expectedItems: ids.length, receivedItems: items.length, receivedModelLists: models.size,
    referencesApprovedForReuse: false, reads, summary });
  console.log(JSON.stringify(redact({ output, readOnly: true, complete: true, summary })));
} catch (error) {
  const known = new Set(['UNEXPECTED_SOURCE_INVENTORY', 'UNEXPECTED_SOURCE_STATUS', 'INVALID_ITEM_ID',
    'UNEXPECTED_SOURCE_CATALOG', 'UNEXPECTED_DORIS_SOURCE', 'CANDIDATE_SOURCE_CHANGED',
    'CANDIDATE_SKU_SOURCE_CHANGED', 'CONNECTION_NOT_READY', 'CREDENTIALS_UNAVAILABLE',
    'RESPONSE_BODY_MISSING', 'RESPONSE_TOO_LARGE', 'UNALLOWED_READ', 'INVALID_JSON_RESPONSE',
    'SHOPEE_READ_REJECTED', 'INVALID_BASE_RESPONSE', 'INCOMPLETE_BASE_RESPONSE', 'INVALID_MODEL_RESPONSE',
    'INVALID_LIST_PAGINATION', 'INVALID_LIST_RESPONSE', 'INVENTORY_CHANGED_DURING_READ',
    'INCOMPLETE_LIST_RESPONSE', 'UNDOCUMENTED_LIST_CONTINUATION', 'INVENTORY_SCAN_LIMIT_REACHED',
    'UNEXPECTED_CURRENT_STATUS']);
  const code = error instanceof Error && known.has(error.message) ? error.message : 'READ_FAILED';
  if (createdOutput) await save('failure', { output, stage, code, readOnly: true, complete: false,
    mutations: 0, reads, receivedItems: items.length, receivedModelLists: models.size }).catch(() => undefined);
  console.error(JSON.stringify({ output, stage, code, readOnly: true, complete: false }));
  process.exitCode = 1;
} finally { await pool.end(); }
