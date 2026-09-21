import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@shopee/domain';
import { transaction, type Pool } from './db.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  date = z.string().datetime({ offset: true });
const path = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.includes('\\') &&
      !p.includes(':') &&
      !p.startsWith('/') &&
      !p.split('/').some((s) => s === '..' || s === '.' || s === ''),
  );
const file = z
  .object({
    role: z.string().min(1),
    path,
    sha256: sha,
    bytes: z.number().int().nonnegative(),
    observedAt: date.optional(),
  })
  .strict();
const schema = z
  .object({
    schemaVersion: z.literal('source-catalog-evidence/v1'),
    catalogId: z.string().uuid(),
    importFingerprint: sha,
    snapshotChecksum: sha,
    publishable: z.literal(false),
    originalAssetsExported: z.literal(false),
    counts: z
      .object({
        listings: z.number().int().nonnegative(),
        designs: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
      })
      .strict(),
    files: z.array(file).min(1),
    designs: z.array(
      z
        .object({
          designId: z.string().regex(/^[A-Za-z0-9_-]+$/),
          sourceFile: file,
          metadataSha256: sha,
          expectedPageCount: z.number().int().nonnegative(),
          currentPageCount: z.number().int().nonnegative(),
          observedAt: date,
          metadataUpdatedAt: date,
          currentMetadataUpdatedAt: date.optional(),
          recheck: z
            .object({ file, observedAt: date, sourceDesignId: z.string() })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    observation: z
      .object({ sourceSnapshotAtomic: z.literal(false), from: date, to: date })
      .strict(),
  })
  .strict();
export type SourceCatalogEvidenceBody = z.infer<typeof schema>;
export type SourceCatalogEvidence = {
  catalogId: string;
  evidenceSha256: string;
  body: SourceCatalogEvidenceBody;
  createdAt: string;
};
export async function attachSourceCatalogEvidence(
  pool: Pool,
  input: { catalogId: string; body: SourceCatalogEvidenceBody },
) {
  const parsed = schema.safeParse(input.body);
  if (!parsed.success) throw Error('CATALOG_EVIDENCE_INPUT_INVALID');
  const body = parsed.data;
  if (body.catalogId !== input.catalogId) throw Error('CATALOG_EVIDENCE_SCOPE_CHANGED');
  if (
    body.designs.length !== body.counts.designs ||
    new Set(body.designs.map((d) => d.designId)).size !== body.designs.length ||
    new Set(body.files.map((f) => f.path)).size !== body.files.length ||
    body.designs.reduce((n, d) => n + d.currentPageCount, 0) !== body.counts.pages ||
    body.designs.some((d) => d.recheck && d.recheck.sourceDesignId !== d.designId)
  )
    throw Error('CATALOG_EVIDENCE_INPUT_INVALID');
  const evidenceSha256 = createHash('sha256').update(canonicalJson(body)).digest('hex');
  return transaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [body.importFingerprint]);
    const catalog = (
      await c.query(
        'SELECT fingerprint,snapshot_checksum,body FROM source_catalogs WHERE id=$1 FOR SHARE',
        [input.catalogId],
      )
    ).rows[0];
    if (
      !catalog ||
      catalog.fingerprint !== body.importFingerprint ||
      catalog.snapshot_checksum !== body.snapshotChecksum ||
      catalog.body.publishable !== false ||
      catalog.body.originalAssetsDownloaded !== false ||
      Object.entries(body.counts).some(([k, v]) => catalog.body.counts[k] !== v)
    )
      throw Error('CATALOG_EVIDENCE_SNAPSHOT_CHANGED');
    const result = await c.query(
      'INSERT INTO source_catalog_evidence(catalog_id,evidence_sha256,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [input.catalogId, evidenceSha256, body],
    );
    const stored = (
      await c.query(
        'SELECT body FROM source_catalog_evidence WHERE catalog_id=$1 AND evidence_sha256=$2',
        [input.catalogId, evidenceSha256],
      )
    ).rows[0];
    if (canonicalJson(stored.body) !== canonicalJson(body))
      throw Error('CATALOG_EVIDENCE_CONFLICT');
    return { catalogId: input.catalogId, evidenceSha256, inserted: result.rowCount === 1 };
  });
}
export async function listSourceCatalogEvidence(
  pool: Pool,
  catalogId: string,
): Promise<SourceCatalogEvidence[]> {
  const rows = (
    await pool.query(
      'SELECT * FROM source_catalog_evidence WHERE catalog_id=$1 ORDER BY created_at,evidence_sha256',
      [z.string().uuid().parse(catalogId)],
    )
  ).rows;
  return rows.map((r) => ({
    catalogId: r.catalog_id,
    evidenceSha256: r.evidence_sha256,
    body: r.body,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
