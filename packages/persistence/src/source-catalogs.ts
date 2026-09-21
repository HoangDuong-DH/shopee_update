import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { localArchiveList, type LocalLifecycle } from './local-archives.js';
import { canonicalJson } from '@shopee/domain';
import type {
  CatalogDesign,
  CatalogListingDetail,
  CatalogListingPage,
  SourceCatalogDetail,
  SourceCatalogSummary,
} from '@shopee/domain';
import { transaction } from './db.js';

const foldSearch = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLocaleLowerCase('vi');
export const catalogSearchText = (listing: CatalogListingDetail) =>
  foldSearch(
    [
      listing.title,
      listing.itemId ?? '',
      listing.sourceNumber ?? '',
      listing.brand,
      ...listing.contents.map((x) => x.value),
      ...listing.variations.map((x) => x.value),
    ].join(' '),
  );

export interface CatalogSnapshot {
  catalog: SourceCatalogDetail;
  listings: CatalogListingDetail[];
  designs: CatalogDesign[];
  pages: { designId: string; id: string; pageNumber: number; width: number; height: number }[];
}
export const catalogSummary = ({
  id,
  name,
  revision,
  receivedAt,
  counts,
  brands,
}: SourceCatalogDetail): SourceCatalogSummary => ({
  id,
  name,
  revision,
  receivedAt,
  counts,
  brands,
});
export const listingSummary = ({
  titleSource: _titleSource,
  contents: _contents,
  variations: _variations,
  reviewNotes: _reviewNotes,
  designCandidates: _designCandidates,
  shopBinding: _shopBinding,
  priceSource: _priceSource,
  stockSource: _stockSource,
  attributeReference: _attributeReference,
  operationalReferences: _operationalReferences,
  ...summary
}: CatalogListingDetail) => ({
  ...summary,
  operationalConcernCount: (_operationalReferences ?? []).reduce(
    (total, reference) => total + reference.concerns.length,
    0,
  ),
});

/** Admin ingestion only. No HTTP write route, source parser replacement or publisher side effects. */
export async function storeSourceCatalog(
  pool: Pool,
  snapshot: CatalogSnapshot,
): Promise<{ id: string; inserted: boolean }> {
  const { catalog, listings, designs, pages } = snapshot;
  if (
    catalog.publishable !== false ||
    catalog.originalAssetsDownloaded !== false ||
    catalog.counts.listings !== listings.length ||
    catalog.counts.designs !== designs.length ||
    catalog.counts.pages !== pages.length ||
    new Set(listings.map((x) => x.id)).size !== listings.length ||
    new Set(designs.map((x) => x.id)).size !== designs.length ||
    new Set(pages.map((x) => `${x.designId}:${x.id}`)).size !== pages.length ||
    listings.some(
      (x) =>
        x.status !== 'needs_review' ||
        x.shopBinding !== null ||
        x.priceSource !== null ||
        x.stockSource !== null ||
        x.attributeReference !== null ||
        x.designCandidateCount !== x.designCandidates.length ||
        x.designCandidates.some((d) => d.status !== 'suggested'),
    )
  )
    throw new Error('CATALOG_INVALID_SNAPSHOT');
  const checksum = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
  return transaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      catalog.importFingerprint,
    ]);
    const existing = await c.query(
      'SELECT id,snapshot_checksum,body FROM source_catalogs WHERE fingerprint=$1',
      [catalog.importFingerprint],
    );
    if (existing.rowCount) {
      // A later read of identical material keeps the original receipt time.
      const comparable = {
        ...snapshot,
        catalog: { ...catalog, receivedAt: existing.rows[0].body.receivedAt },
      };
      const repeatedChecksum = createHash('sha256').update(canonicalJson(comparable)).digest('hex');
      if (existing.rows[0].snapshot_checksum !== repeatedChecksum)
        throw new Error('CATALOG_FINGERPRINT_CONFLICT');
      return { id: existing.rows[0].id, inserted: false };
    }
    await c.query(
      'INSERT INTO source_catalogs(id,fingerprint,snapshot_checksum,body,received_at) VALUES($1,$2,$3,$4,$5)',
      [catalog.id, catalog.importFingerprint, checksum, catalog, catalog.receivedAt],
    );
    for (const source of catalog.sources)
      await c.query(
        'INSERT INTO source_catalog_files(catalog_id,source_id,body) VALUES($1,$2,$3)',
        [catalog.id, source.id, source],
      );
    for (const d of designs)
      await c.query(
        'INSERT INTO source_catalog_designs(catalog_id,design_id,body) VALUES($1,$2,$3)',
        [catalog.id, d.id, d],
      );
    // A page ID may recur in a different Canva design. The key always includes design_id.
    for (const p of pages)
      await c.query(
        'INSERT INTO source_catalog_pages(catalog_id,design_id,page_id,page_number,body) VALUES($1,$2,$3,$4,$5)',
        [catalog.id, p.designId, p.id, p.pageNumber, p],
      );
    for (const [order, listing] of listings.entries()) {
      const { designCandidates, ...body } = listing;
      await c.query(
        'INSERT INTO source_catalog_listings(catalog_id,listing_key,brand,source_order,search_text,body) VALUES($1,$2,$3,$4,$5,$6)',
        [catalog.id, listing.id, listing.brand, order, catalogSearchText(listing), body],
      );
      for (const candidate of designCandidates)
        await c.query(
          'INSERT INTO source_catalog_candidates(catalog_id,listing_key,design_id,reason) VALUES($1,$2,$3,$4)',
          [catalog.id, listing.id, candidate.id, candidate.reason],
        );
    }
    return { id: catalog.id, inserted: true };
  });
}
export async function listSourceCatalogs(pool: Pool): Promise<SourceCatalogSummary[]> {
  const result = await pool.query('SELECT body FROM source_catalogs ORDER BY received_at DESC,id');
  return result.rows.map((r) => catalogSummary(r.body));
}
export async function getSourceCatalog(
  pool: Pool,
  id: string,
): Promise<SourceCatalogDetail | null> {
  return (
    (await pool.query('SELECT body FROM source_catalogs WHERE id=$1', [id])).rows[0]?.body ?? null
  );
}
export async function queryCatalogListings(
  pool: Pool,
  id: string,
  input: { brand?: string; q?: string; issue?: string; page: number; pageSize: number; lifecycle?: LocalLifecycle },
): Promise<CatalogListingPage> {
  const values = [id, input.brand ?? '', foldSearch(input.q ?? ''), input.issue ?? 'all', input.lifecycle ?? 'active'];
  const where = `catalog_id=$1 AND ($2='' OR brand=$2) AND ($3='' OR strpos(search_text,$3)>0)
    AND ($4='all'
      OR ($4='missing_item_id' AND btrim(COALESCE(body->>'itemId',''), E' \\t\\r\\n')='')
      OR ($4='existing_item_id' AND btrim(COALESCE(body->>'itemId',''), E' \\t\\r\\n')<>'')
      OR ($4 NOT IN ('missing_item_id','existing_item_id') AND EXISTS(SELECT 1 FROM jsonb_array_elements(body->'issues') issue WHERE issue->>'code'=$4)))
    AND ($5='all' OR EXISTS(SELECT 1 FROM local_resource_archives a WHERE a.kind='catalog_listing' AND a.resource_id=catalog_id::text || '/' || listing_key AND a.archived_at IS NOT NULL)=($5='archived'))`;
  const total = Number(
    (await pool.query(`SELECT count(*) FROM source_catalog_listings WHERE ${where}`, values))
      .rows[0].count,
  );
  const page = Math.min(input.page, Math.max(1, Math.ceil(total / input.pageSize)));
  const rows = await pool.query(
    `SELECT body FROM source_catalog_listings WHERE ${where} ORDER BY source_order LIMIT $6 OFFSET $7`,
    [...values, input.pageSize, (page - 1) * input.pageSize],
  );
  return {
    items: await localArchiveList(pool,'catalog_listing',rows.rows.map((r) => listingSummary(r.body)),r=>`${id}/${r.id}`,'all'),
    total,
    page,
    pageSize: input.pageSize,
  };
}
export async function getCatalogListing(
  pool: Pool,
  id: string,
  key: string,
): Promise<CatalogListingDetail | null> {
  const row = (
    await pool.query(
      'SELECT body FROM source_catalog_listings WHERE catalog_id=$1 AND listing_key=$2',
      [id, key],
    )
  ).rows[0];
  if (!row) return null;
  const candidates = await pool.query(
    `SELECT d.body,c.reason,c.status FROM source_catalog_candidates c JOIN source_catalog_designs d USING(catalog_id,design_id) WHERE c.catalog_id=$1 AND c.listing_key=$2 ORDER BY d.design_id`,
    [id, key],
  );
  return {
    ...row.body,
    designCandidates: candidates.rows.map((r) => ({
      ...r.body,
      reason: r.reason,
      status: r.status,
    })),
  };
}
