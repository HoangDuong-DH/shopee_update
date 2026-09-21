import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ListingDraft } from '@shopee/domain';
import { transaction } from './db.js';

export const localArchiveKinds = [
  'catalog_listing',
  'input_batch',
  'product',
  'pricebook',
] as const;
export type LocalArchiveKind = (typeof localArchiveKinds)[number];
export type LocalLifecycle = 'active' | 'archived' | 'all';
export type LocalResourceRef = { kind: LocalArchiveKind; resourceId: string };
type Query = Pick<PoolClient, 'query'>;
export const localArchiveLock = 'local-resource-lifecycle';
const iso = (v: Date | string) => new Date(v).toISOString();
const view = (r: any) => ({
  kind: r.kind as LocalArchiveKind,
  resourceId: r.resource_id as string,
  archived: r.archived_at !== null,
  archivedAt: r.archived_at ? iso(r.archived_at) : null,
  updatedAt: iso(r.updated_at),
});

/** Shared lock for a new source selection; archive/restore takes the exclusive counterpart. */
export async function lockLocalSourceSelection(query: Query) {
  await query.query(
    'SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema() || chr(58) || $1,0))',
    [localArchiveLock],
  );
}
export async function localArchiveFlags(query: Query, kind: LocalArchiveKind, resourceId: string) {
  const r = (
    await query.query(
      'SELECT archived_at FROM local_resource_archives WHERE kind=$1 AND resource_id=$2',
      [kind, resourceId],
    )
  ).rows[0];
  return { archived: !!r?.archived_at, archivedAt: r?.archived_at ? iso(r.archived_at) : null };
}
export async function localArchiveList<T>(
  query: Query,
  kind: LocalArchiveKind,
  rows: T[],
  key: (row: T) => string,
  lifecycle: LocalLifecycle = 'active',
) {
  const archived = new Map<string, string>(
    (
      await query.query(
        'SELECT resource_id,archived_at FROM local_resource_archives WHERE kind=$1 AND archived_at IS NOT NULL',
        [kind],
      )
    ).rows.map((r) => [r.resource_id, iso(r.archived_at)]),
  );
  return rows
    .map((r) => ({
      ...r,
      archived: archived.has(key(r)),
      archivedAt: archived.get(key(r)) ?? null,
    }))
    .filter((r) => lifecycle === 'all' || r.archived === (lifecycle === 'archived'));
}
export async function assertLocalResourcesActive(query: Query, refs: LocalResourceRef[]) {
  if (!refs.length) return;
  const archived = await query.query(
    `SELECT 1 FROM local_resource_archives a JOIN jsonb_to_recordset($1::jsonb) r(kind text,"resourceId" text)
    ON a.kind=r.kind AND a.resource_id=r."resourceId" WHERE a.archived_at IS NOT NULL LIMIT 1`,
    [JSON.stringify(refs)],
  );
  if (archived.rowCount) throw Error('LOCAL_RESOURCE_ARCHIVED');
}
function exactStrings(value: unknown, keys: Set<string>): boolean {
  if (typeof value === 'string') return keys.has(value);
  if (Array.isArray(value)) return value.some((v) => exactStrings(v, keys));
  return (
    !!value && typeof value === 'object' && Object.values(value).some((v) => exactStrings(v, keys))
  );
}
export async function draftLocalResourceRefs(
  query: Query,
  draft: Pick<ListingDraft, 'productKey'> & Partial<ListingDraft>,
): Promise<LocalResourceRef[]> {
  const refs: LocalResourceRef[] = [{ kind: 'product', resourceId: draft.productKey }];
  for (const v of draft.sourceSelection?.variants ?? [])
    refs.push({ kind: 'pricebook', resourceId: v.importId });
  if (draft.sourceSelection?.folderBinding)
    refs.push({ kind: 'input_batch', resourceId: draft.sourceSelection.folderBinding.batchId });
  const batches = await query.query(
    `SELECT batch_id FROM input_batch_products WHERE product_key=$1 UNION SELECT batch_id FROM folder_source_claims WHERE product_key=$1`,
    [draft.productKey],
  );
  for (const r of batches.rows) refs.push({ kind: 'input_batch', resourceId: r.batch_id });
  // Older drafts can refer to the price source through exact file hashes instead of import IDs.
  const prices = await query.query("SELECT id,sha256 FROM source_files WHERE kind='xlsx'");
  for (const r of prices.rows)
    if (exactStrings(draft, new Set([r.sha256])))
      refs.push({ kind: 'pricebook', resourceId: r.id });
  return refs;
}
export async function assertDraftLocalSourcesActive(
  query: Query,
  draft: Pick<ListingDraft, 'productKey'> & Partial<ListingDraft>,
) {
  await assertLocalResourcesActive(query, await draftLocalResourceRefs(query, draft));
}
export async function assertPreparationLocalSourcesActive(
  query: Query,
  entries: {
    productKey: string;
    priceSelection?: { importId?: string };
    priceProof?: { importId: string }[];
    sourceSnapshot?: { draft?: ListingDraft };
  }[],
) {
  for (const entry of entries) {
    const current = (
      await query.query(
        'SELECT r.body FROM products p JOIN product_revisions r ON r.product_key=p.product_key AND r.revision=p.latest_revision WHERE p.product_key=$1',
        [entry.productKey],
      )
    ).rows[0]?.body;
    await assertDraftLocalSourcesActive(query, current ?? { productKey: entry.productKey });
    if (entry.sourceSnapshot?.draft)
      await assertDraftLocalSourcesActive(query, entry.sourceSnapshot.draft);
    await assertLocalResourcesActive(query, [
      ...(entry.priceSelection?.importId
        ? [{ kind: 'pricebook' as const, resourceId: entry.priceSelection.importId }]
        : []),
      ...(entry.priceProof ?? []).map((p) => ({
        kind: 'pricebook' as const,
        resourceId: p.importId,
      })),
    ]);
  }
}
async function assertExists(query: Query, ref: LocalResourceRef) {
  let found;
  if (ref.kind === 'catalog_listing') {
    const slash = ref.resourceId.indexOf('/'),
      catalog = ref.resourceId.slice(0, slash),
      row = ref.resourceId.slice(slash + 1);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(catalog) ||
      !row ||
      row.length > 150
    )
      throw Error('LOCAL_ARCHIVE_INVALID');
    found = await query.query(
      'SELECT 1 FROM source_catalog_listings WHERE catalog_id=$1 AND listing_key=$2',
      [catalog, row],
    );
  } else if (ref.kind === 'product')
    found = await query.query('SELECT 1 FROM products WHERE product_key=$1', [ref.resourceId]);
  else {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ref.resourceId))
      throw Error('LOCAL_ARCHIVE_INVALID');
    found =
      ref.kind === 'input_batch'
        ? await query.query('SELECT 1 FROM input_batches WHERE id=$1', [ref.resourceId])
        : await query.query("SELECT 1 FROM source_files WHERE id=$1 AND kind='xlsx'", [
            ref.resourceId,
          ]);
  }
  if (!found.rowCount) throw Error('LOCAL_ARCHIVE_NOT_FOUND');
}
async function assertNotInUse(query: Query, ref: LocalResourceRef) {
  const keys = new Set([ref.resourceId]);
  if (ref.kind === 'input_batch') {
    for (const row of (
      await query.query(
        'SELECT product_key FROM input_batch_products WHERE batch_id=$1 UNION SELECT product_key FROM folder_source_claims WHERE batch_id=$1',
        [ref.resourceId],
      )
    ).rows)
      keys.add(row.product_key);
  }
  if (ref.kind === 'pricebook') {
    const source = (
      await query.query('SELECT sha256 FROM source_files WHERE id=$1', [ref.resourceId])
    ).rows[0];
    keys.add(source.sha256);
    for (const row of (await query.query('SELECT product_key,body FROM product_revisions')).rows)
      if (exactStrings(row.body, keys)) keys.add(row.product_key);
  }
  const preparations =
    await query.query(`SELECT p.request,p.body FROM production_source_preparations p LEFT JOIN production_preparation_executions e ON e.preparation_id=p.id
    WHERE (p.approved_at IS NOT NULL OR p.registration IS NOT NULL OR e.preparation_id IS NOT NULL)
      AND COALESCE(e.body->>'state','pending')<>'completed'`);
  if (preparations.rows.some((r) => exactStrings(r, keys))) throw Error('LOCAL_ARCHIVE_IN_USE');
  const operations =
    await query.query(`SELECT o.source_identity,o.source_payload FROM production_pilot_operations o
    WHERE o.state IN ('authorized','sent','acknowledged','unknown') OR EXISTS(SELECT 1 FROM production_pilot_lanes l WHERE l.operation_id=o.id)
      OR EXISTS(SELECT 1 FROM production_pilot_publications p WHERE p.create_operation_id=o.id AND p.state IN ('authorized','sent','acknowledged','unknown'))`);
  if (operations.rows.some((r) => exactStrings(r, keys))) throw Error('LOCAL_ARCHIVE_IN_USE');
}
export async function setLocalArchive(pool: Pool, ref: LocalResourceRef, archived: boolean) {
  return transaction(pool, async (c) => {
    await c.query(
      'SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || chr(58) || $1,0))',
      [localArchiveLock],
    );
    await assertExists(c, ref);
    const prior = (
      await c.query('SELECT * FROM local_resource_archives WHERE kind=$1 AND resource_id=$2', [
        ref.kind,
        ref.resourceId,
      ])
    ).rows[0];
    if (prior && !!prior.archived_at === archived) return view(prior);
    if (archived) await assertNotInUse(c, ref);
    const row = (
      await c.query(
        `INSERT INTO local_resource_archives(kind,resource_id,archived_at) VALUES($1,$2,CASE WHEN $3 THEN now() END)
      ON CONFLICT(kind,resource_id) DO UPDATE SET archived_at=EXCLUDED.archived_at,updated_at=now() RETURNING *`,
        [ref.kind, ref.resourceId, archived],
      )
    ).rows[0];
    await c.query(
      'INSERT INTO local_resource_archive_events(id,kind,resource_id,archived) VALUES($1,$2,$3,$4)',
      [randomUUID(), ref.kind, ref.resourceId, archived],
    );
    return view(row);
  });
}
export async function listLocalArchives(pool: Pool, lifecycle: LocalLifecycle = 'archived') {
  const rows = await pool.query(
    "SELECT * FROM local_resource_archives WHERE $1='all' OR (archived_at IS NOT NULL)=($1='archived') ORDER BY updated_at DESC,kind,resource_id",
    [lifecycle],
  );
  return { entries: rows.rows.map(view) };
}
