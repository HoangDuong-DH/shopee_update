import { createHash } from 'node:crypto';
import { localLibraryQuerySchema, type LocalLibraryQuery, type LocalLibraryPage,
  type LocalProductSummary, type LocalProductShopAssignment, type LocalImportSummary } from '@shopee/domain';
import type { Pool } from 'pg';

type Kind = 'products' | 'imports';
type Cursor = { version: 1; kind: Kind; filter: string; at: string; key: string };
const filter = (kind: Kind, query: LocalLibraryQuery) => createHash('sha256')
  .update(JSON.stringify([kind, query.lifecycle, query.q])).digest('hex');
const iso = (value: Date | string) => new Date(value).toISOString();
const count = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);
const cursorTimeSql = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function decodeLocalLibraryCursor(raw: string | undefined, kind: Kind, query: LocalLibraryQuery): Cursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (value.version!==1 || value.kind!==kind || value.filter!==filter(kind,query)
      || typeof value.key!=='string' || !value.key || value.key.length>400 || value.key.includes('\u0000')
      || (kind==='imports' && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.key))
      || typeof value.at!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at)
      || !Number.isFinite(Date.parse(value.at)) || Number(value.at.slice(0,4))<1
      || new Date(value.at).toISOString().slice(0,19)!==value.at.slice(0,19)) throw Error();
    return value;
  } catch { throw Error('LOCAL_LIBRARY_CURSOR_INVALID'); }
}
function page<T>(rows: Record<string, any>[], kind: Kind, query: LocalLibraryQuery,
  items: T[]): LocalLibraryPage<T> {
  const hasMore = rows.length>query.limit, last = rows[Math.min(rows.length,query.limit)-1];
  return { observedAt: new Date().toISOString(), items, hasMore,
    nextCursor: hasMore ? Buffer.from(JSON.stringify({version:1,kind,filter:filter(kind,query),
      at:last!.cursor_at,key:last!.cursor_key} satisfies Cursor)).toString('base64url') : null };
}
const searchPattern = (query: string) => `%${query.replace(/[\\%_]/g, '\\$&')}%`;

/** Page metadata only. Immutable source JSON and media are loaded by detail routes. */
export class LocalLibraryRepository {
  constructor(readonly pool: Pool) {}
  async products(raw: unknown = {}): Promise<LocalLibraryPage<LocalProductSummary>> {
    const query=localLibraryQuerySchema.parse(raw), cursor=decodeLocalLibraryCursor(query.cursor,'products',query);
    const rows=(await this.pool.query(`SELECT p.product_key,p.latest_revision,p.updated_at,
      s.title,s.cover_key,s.variant_count,s.asset_count,s.gallery_count,s.saved_issue_count,s.saved_blocking_issue_count,
      a.archived_at,${cursorTimeSql('p.updated_at')} AS cursor_at,p.product_key AS cursor_key
      FROM products p LEFT JOIN local_product_summaries s ON s.product_key=p.product_key AND s.revision=p.latest_revision
      LEFT JOIN local_resource_archives a ON a.kind='product' AND a.resource_id=p.product_key
      WHERE ($1='all' OR (a.archived_at IS NOT NULL)=($1='archived'))
       AND ($2='' OR s.search_name LIKE local_library_search_key($3) ESCAPE '\\')
       AND ($4::timestamptz IS NULL OR (p.updated_at,p.product_key)<($4::timestamptz,$5::text))
      ORDER BY p.updated_at DESC,p.product_key DESC LIMIT $6`,
    [query.lifecycle,query.q,searchPattern(query.q),cursor?.at??null,cursor?.key??null,query.limit+1])).rows;
    const selected=rows.slice(0,query.limit), assignments=new Map<string,{items:LocalProductShopAssignment[];total:number}>();
    if(selected.length) {
      const assigned=(await this.pool.query(`WITH assignment AS (
        SELECT r.product_key,w.id AS order_id,w.latest_revision,r.connection_id,r.source_revision,
         c.environment,c.partner_id,c.shop_id,c.name,
         row_number() OVER(PARTITION BY r.product_key ORDER BY w.updated_at DESC,w.id) AS ordinal,
         count(*) OVER(PARTITION BY r.product_key) AS total
        FROM work_order_revisions r JOIN work_orders w ON w.id=r.order_id AND w.latest_revision=r.revision
        LEFT JOIN connections c ON c.id=r.connection_id WHERE r.product_key=ANY($1::text[])
       ) SELECT * FROM assignment WHERE ordinal<=20 ORDER BY product_key,ordinal`,
      [selected.map(row=>row.product_key)])).rows;
      const revisions=new Map(selected.map(row=>[row.product_key,row.latest_revision]));
      for(const row of assigned) {
        const group=assignments.get(row.product_key)??{items:[],total:Number(row.total)};
        group.items.push({workOrderId:row.order_id,revision:row.latest_revision,connectionId:row.connection_id,
          scope:row.environment ? {environment:row.environment,partnerId:row.partner_id,shopId:row.shop_id}:null,
          name:row.name??null,sourceRevision:row.source_revision,sourceChanged:row.source_revision!==revisions.get(row.product_key)});
        assignments.set(row.product_key,group);
      }
    }
    const items:LocalProductSummary[]=selected.map(row=>({productKey:row.product_key,revision:row.latest_revision,
      title:row.title??null,coverKey:row.cover_key??null,variantCount:count(row.variant_count),assetCount:count(row.asset_count),
      galleryCount:count(row.gallery_count),savedIssueCount:count(row.saved_issue_count),savedBlockingIssueCount:count(row.saved_blocking_issue_count),
      issueBasis:'saved_draft',updatedAt:iso(row.updated_at),archived:row.archived_at!==null,
      archivedAt:row.archived_at?iso(row.archived_at):null,shopAssignments:assignments.get(row.product_key)?.items??[],
      shopAssignmentCount:assignments.get(row.product_key)?.total??0,
      shopAssignmentsTruncated:(assignments.get(row.product_key)?.total??0)>20}));
    return page(rows,'products',query,items);
  }
  async imports(raw: unknown = {}): Promise<LocalLibraryPage<LocalImportSummary>> {
    const query=localLibraryQuerySchema.parse(raw), cursor=decodeLocalLibraryCursor(query.cursor,'imports',query);
    const rows=(await this.pool.query(`SELECT f.id,f.sha256,f.filename,f.kind,f.bytes,f.status,f.message,f.created_at,f.updated_at,
      a.archived_at,${cursorTimeSql('f.updated_at')} AS cursor_at,f.id::text AS cursor_key
      FROM source_files f LEFT JOIN local_resource_archives a ON a.kind='pricebook' AND a.resource_id=f.id::text AND f.kind='xlsx'
      WHERE ($1='all' OR (a.archived_at IS NOT NULL)=($1='archived'))
       AND ($2='' OR f.search_name LIKE local_library_search_key($3) ESCAPE '\\')
       AND ($4::timestamptz IS NULL OR (f.updated_at,f.id)<($4::timestamptz,$5::uuid))
      ORDER BY f.updated_at DESC,f.id DESC LIMIT $6`,
    [query.lifecycle,query.q,searchPattern(query.q),cursor?.at??null,cursor?.key??null,query.limit+1])).rows;
    const items:LocalImportSummary[]=rows.slice(0,query.limit).map(row=>({id:row.id,importId:row.id,sha256:row.sha256,sourceSha:row.sha256,
      filename:row.filename,originalName:row.filename,kind:row.kind,dataType:row.kind,bytes:Number(row.bytes),status:row.status,
      message:row.message,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),archived:row.archived_at!==null,
      archivedAt:row.archived_at?iso(row.archived_at):null,revision:null,bodyState:'not_loaded'}));
    return page(rows,'imports',query,items);
  }
}
