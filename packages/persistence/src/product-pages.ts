import { productPageQuerySchema, productKeysSchema, type ProductPage, type ListingDraft } from '@shopee/domain';
import type { PoolClient } from 'pg';
type Query = Pick<PoolClient,'query'>;
const pattern = (q:string)=>`%${q.replace(/[\\%_]/g,'\\$&')}%`;
const draft = (row:any):ListingDraft=>({...row.body,archived:!!row.archived_at,
  archivedAt:row.archived_at ? new Date(row.archived_at).toISOString() : null});

/** The count and selected bodies share one PostgreSQL snapshot. No unbounded JSON read. */
export async function readProductPage(db:Query, raw:unknown = {}):Promise<ProductPage> {
  const query=productPageQuerySchema.parse(raw);
  const rows=(await db.query(`WITH matching AS NOT MATERIALIZED (
    SELECT p.product_key,p.updated_at,r.body,a.archived_at
    FROM products p JOIN product_revisions r ON r.product_key=p.product_key AND r.revision=p.latest_revision
    LEFT JOIN local_resource_archives a ON a.kind='product' AND a.resource_id=p.product_key
    WHERE ($1='all' OR (a.archived_at IS NOT NULL)=($1='archived'))
    AND ($2='' OR p.product_key ILIKE $3 ESCAPE '\\' OR r.body->'title'->>'value' ILIKE $3 ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(r.body->'variants') v WHERE v->'sku'->>'value' ILIKE $3 ESCAPE '\\'))
  ), selected AS (
    SELECT p.* FROM matching p ORDER BY p.updated_at DESC,p.product_key DESC LIMIT $4 OFFSET $5
  ) SELECT tally.total,selected.body,selected.archived_at
    FROM (SELECT count(*) AS total FROM matching) tally LEFT JOIN selected ON true
    ORDER BY selected.updated_at DESC,selected.product_key DESC`,
    [query.lifecycle,query.q,pattern(query.q),query.limit,(query.page-1)*query.limit])).rows;
  const total=Number(rows[0]?.total ?? 0);
  return {items:rows.filter(row=>row.body!==null && row.body!==undefined).map(draft),total,
    page:query.page,limit:query.limit,hasMore:query.page*query.limit<total};
}
export async function readProductsByKeys(db:Query, raw:unknown):Promise<ListingDraft[]> {
  const keys=[...new Set(productKeysSchema.parse(raw))];
  if (!keys.length) return [];
  const rows=(await db.query(`SELECT r.body,a.archived_at FROM products p
    JOIN product_revisions r ON r.product_key=p.product_key AND r.revision=p.latest_revision
    LEFT JOIN local_resource_archives a ON a.kind='product' AND a.resource_id=p.product_key
    WHERE p.product_key=ANY($1::text[]) ORDER BY p.product_key`,[keys])).rows;
  return rows.map(draft);
}
