import type { Pool } from 'pg';

type ItemListRow = { item_id: string | number; item_status: string; update_time: string | number };
type CachedRow = { item_id: string; item_status: string; item_sku: string;
  model_skus: string[]; remote_updated_at: string | number; title: string };
type ReadResult = { response: any; requestId: string };

/** Hydrates only newly cloned items absent from the seller-knowledge cache.
 * Every delta must have a durable, acknowledged clone intent for this exact
 * destination. Unrelated missing/stale items block the whole inventory proof. */
export async function verifyCloneTargetInventoryDelta(input: {
  pool: Pick<Pool, 'query'>;
  connectionId: string; partnerId: string; shopId: string;
  live: ItemListRow[]; cached: CachedRow[];
  reviewedHeldIntentIds?: readonly string[];
  read: (path: string, query: Record<string, string>) => Promise<ReadResult>;
}) {
  const { pool, connectionId, partnerId, shopId, live, cached, read } = input;
  const liveIds = live.map(row => String(row.item_id));
  const cachedIds = cached.map(row => String(row.item_id));
  if (new Set(liveIds).size !== liveIds.length ||
      new Set(cachedIds).size !== cachedIds.length)
    throw Error('TARGET_INVENTORY_DUPLICATE_ID');
  const liveById = new Map(live.map(row => [String(row.item_id), row]));
  if (cached.some(row => !liveById.has(String(row.item_id))))
    throw Error('TARGET_INVENTORY_CACHE_EXTRA');
  const cachedById = new Map(cached.map(row => [String(row.item_id), row]));
  for (const row of live) {
    const prior = cachedById.get(String(row.item_id));
    if (prior && (String(prior.remote_updated_at) !== String(row.update_time) ||
        prior.item_status !== row.item_status))
      throw Error('TARGET_INVENTORY_CACHE_STALE');
  }
  const missing = liveIds.filter(id => !cachedById.has(id));
  if (!missing.length) return { rows: cached, requestIds: [] as string[], deltaItemIds: [] as string[] };
  if (missing.length > 32) throw Error('TARGET_INVENTORY_DELTA_TOO_LARGE');
  const intents = (await pool.query(
    'SELECT i.id,i.state,i.target_item_id,i.target_connection_id,i.target_partner_id,i.target_shop_id,' +
    'o.body,q.result AS initial_qc,' +
    '(SELECT r.result FROM shop_listing_clone_qc_rechecks r WHERE r.intent_id=i.id ' +
    ' ORDER BY r.attempt_no DESC LIMIT 1) AS latest_recheck,' +
    '(SELECT count(*)::integer FROM shop_listing_clone_steps s WHERE s.intent_id=i.id ' +
    " AND s.kind='create' AND s.state='acknowledged') AS ack_create," +
    '(SELECT count(*)::integer FROM shop_listing_clone_steps s WHERE s.intent_id=i.id ' +
    " AND s.state<>'acknowledged') AS unresolved_steps " +
    'FROM shop_listing_clone_intents i ' +
    'JOIN seller_knowledge_observations o ON o.id=i.source_evidence_id ' +
    'LEFT JOIN shop_listing_clone_qc q ON q.intent_id=i.id ' +
    'WHERE i.target_item_id=ANY($1::text[]) AND i.target_connection_id=$2 ' +
    'AND i.target_partner_id=$3 AND i.target_shop_id=$4',
    [missing,connectionId,partnerId,shopId])).rows as any[];
  const intentsByItem = new Map<string, any[]>();
  for (const intent of intents) {
    const id = String(intent.target_item_id);
    intentsByItem.set(id,[...(intentsByItem.get(id) ?? []),intent]);
  }
  const approved = new Set(input.reviewedHeldIntentIds ?? []);
  const evidenceById = new Map<string, any>();
  for (const id of missing) {
    const matches = intentsByItem.get(id) ?? [];
    if (matches.length !== 1) throw Error('TARGET_INVENTORY_DELTA_INTENT_MISSING');
    const intent = matches[0]!;
    const verified = intent.state === 'verified' &&
      (intent.initial_qc === 'verified' || intent.latest_recheck === 'verified');
    const reviewedHeld = intent.state === 'held' && approved.has(intent.id) &&
      intent.initial_qc === 'mismatch';
    if ((!verified && !reviewedHeld) || intent.ack_create !== 1 ||
        intent.unresolved_steps !== 0)
      throw Error('TARGET_INVENTORY_DELTA_INTENT_UNVERIFIED');
    evidenceById.set(id,intent.body);
  }
  const base = await read('/api/v2/product/get_item_base_info',
    { item_id_list: missing.join(',') });
  const rawItems = base.response?.item_list;
  if (!base.requestId || !Array.isArray(rawItems) || rawItems.length !== missing.length ||
      new Set(rawItems.map((row: any) => String(row.item_id))).size !== rawItems.length)
    throw Error('TARGET_INVENTORY_DELTA_BASE_INVALID');
  const rawById = new Map(rawItems.map((row: any) => [String(row.item_id),row]));
  const rows: CachedRow[] = [...cached];
  const requestIds = [base.requestId];
  for (const id of missing) {
    const header = liveById.get(id)!;
    const raw = rawById.get(id) as any;
    const source = evidenceById.get(id);
    const sourceItem = source?.rawItem;
    if (!raw || !sourceItem || String(raw.item_id) !== id ||
        raw.item_status !== header.item_status || raw.item_status !== 'UNLIST' ||
        String(raw.update_time) !== String(header.update_time) ||
        raw.item_name !== sourceItem.item_name ||
        String(raw.item_sku ?? '') !== String(sourceItem.item_sku ?? '') ||
        raw.has_model !== sourceItem.has_model)
      throw Error('TARGET_INVENTORY_DELTA_SOURCE_IDENTITY_MISMATCH');
    let modelSkus: string[] = [];
    if (sourceItem.has_model) {
      const models = await read('/api/v2/product/get_model_list', { item_id: id });
      if (!models.requestId || !Array.isArray(models.response?.model))
        throw Error('TARGET_INVENTORY_DELTA_MODELS_INVALID');
      modelSkus = models.response.model.map((row: any) => String(row.model_sku ?? ''));
      const expected = (source.rawModels?.model ?? []).map((row: any) => String(row.model_sku ?? ''));
      if (!modelSkus.length || modelSkus.some(sku => !sku) ||
          modelSkus.length !== expected.length ||
          modelSkus.slice().sort().join('|') !== expected.slice().sort().join('|'))
        throw Error('TARGET_INVENTORY_DELTA_SKU_MISMATCH');
      requestIds.push(models.requestId);
    }
    rows.push({ item_id:id, item_status:raw.item_status,
      item_sku:raw.item_sku ?? '', model_skus:modelSkus,
      remote_updated_at:raw.update_time, title:raw.item_name });
  }
  return { rows, requestIds, deltaItemIds: missing };
}
