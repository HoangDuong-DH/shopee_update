import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../packages/domain/src/index.js';
import { Pool, transaction } from '../packages/persistence/src/db.js';
import {
  attachSourceCatalogEvidence,
  type SourceCatalogEvidenceBody,
} from '../packages/persistence/src/source-catalog-evidence.js';
import { buildSourceCatalog } from '../apps/api/src/source-catalog-build.js';
import type { CatalogSnapshot } from '../packages/persistence/src/source-catalogs.js';

const workspace = await realpath(process.cwd());
const directory = await realpath(
  resolve(
    process.argv.slice(2).find((v) => !v.startsWith('--')) ??
      '.local/input-catalog/vina-tuoi-20260914',
  ),
);
const checkOnly = process.argv.includes('--check');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const canonicalHash = (value: unknown) => hash(canonicalJson(value));
function inside(base: string, target: string) {
  const rel = relative(base, target);
  assert.ok(
    !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep),
    'EVIDENCE_PATH_ESCAPES_ROOT',
  );
  return rel.split(sep).join('/');
}
inside(workspace, directory);
async function file(path: string, role: string, expected?: string, observedAt?: string) {
  const actual = await realpath(resolve(directory, path));
  inside(directory, actual);
  const bytes = await readFile(actual),
    sha256 = hash(bytes);
  if (expected !== undefined) assert.equal(sha256, expected, 'EVIDENCE_FILE_HASH_CHANGED:' + role);
  return {
    bytes,
    ref: {
      role,
      path: inside(workspace, actual),
      sha256,
      bytes: bytes.length,
      ...(observedAt ? { observedAt } : {}),
    },
  };
}
async function json(path: string, role: string, expected?: string) {
  const entry = await file(path, role, expected);
  return { ...entry, value: JSON.parse(entry.bytes.toString()) };
}
const receipt = await json('import-receipt.json', 'import_receipt');
const snapshotFile = await json('catalog-snapshot.json', 'catalog_snapshot');
const snapshot = snapshotFile.value as CatalogSnapshot;
const profile = await json('workbook-profile.json', 'workbook_profile');
const rows = await json('workbook-rows.json', 'workbook_raw_rows');
const central = await json('canva-pages/all-design-pages.json', 'canva_page_inventory');
const rootInventory = await json(
  'canva-inventory-complete.json',
  'canva_folder_inventory',
  central.value.sourceInventory.sha256,
);
const manifest = await json('canva-pages/manifest.json', 'canva_pages_manifest');
const validation = await json('canva-pages/validation.json', 'canva_pages_validation');
const seller = await json('seller-observations.json', 'seller_readonly_observations');
const archived = await file(
  profile.value.source.archivedPath,
  'original_workbook',
  profile.value.source.sha256,
  profile.value.source.observedAt,
);
assert.equal(rows.value.source.sha256, archived.ref.sha256);
assert.equal(rows.value.source.sizeBytes, archived.bytes.length);
assert.equal(profile.value.source.sizeBytes, archived.bytes.length);
assert.equal(central.value.complete, true);
assert.equal(manifest.value.complete, true);
assert.equal(validation.value.passed, true);
assert.equal(validation.value.centralSha256, central.ref.sha256);
assert.equal(manifest.value.sourceInventory.sha256, rootInventory.ref.sha256);
assert.equal(receipt.value.id, snapshot.catalog.id);
assert.deepEqual(receipt.value.counts, snapshot.catalog.counts);
assert.equal(snapshot.catalog.publishable, false);
assert.equal(snapshot.catalog.originalAssetsDownloaded, false);
const folder = snapshot.catalog.sources.find((s) => s.kind === 'canva_folder')?.url;
assert.ok(folder);
assert.equal(
  canonicalJson(buildSourceCatalog(profile.value, central.value, folder, seller.value)),
  canonicalJson(snapshot),
  'CATALOG_REBUILD_CHANGED',
);
const fileRefs = [
  receipt.ref,
  snapshotFile.ref,
  profile.ref,
  rows.ref,
  central.ref,
  rootInventory.ref,
  manifest.ref,
  validation.ref,
  seller.ref,
  archived.ref,
];
const designEvidence: SourceCatalogEvidenceBody['designs'] = [];
for (const design of central.value.designs) {
  assert.match(design.id, /^DA[A-Za-z0-9_-]+$/);
  assert.equal(design.evidenceFile, design.id + '.json');
  const evidence = await json(
    'canva-pages/' + design.evidenceFile,
    'canva_design_pages',
    design.evidenceSha256,
  );
  const listed = manifest.value.files.find((f: any) => f.designId === design.id);
  assert.equal(listed?.sha256, evidence.ref.sha256);
  assert.equal(evidence.value.design.id, design.id);
  assert.equal(evidence.value.pages.length, design.pages.length);
  for (const [index, p] of design.pages.entries()) {
    const actual = evidence.value.pages[index];
    assert.equal(p.id, actual.id);
    assert.equal(p.index, index + 1);
    assert.equal(p.pageNumber, actual.page_number);
    assert.equal(p.width, actual.dimensions.width);
    assert.equal(p.height, actual.dimensions.height);
  }
  const metadata = {
    id: design.id,
    title: design.title,
    folderId: design.folderId,
    metadataCreatedAt: design.metadataCreatedAt,
    metadataUpdatedAt: design.metadataUpdatedAt,
    expectedPageCount: design.expectedPageCount,
    currentPageCount: design.currentPageCount,
    ...(design.metadataRecheck
      ? {
          currentMetadataUpdatedAt: design.currentMetadataUpdatedAt,
          metadataRecheck: design.metadataRecheck,
        }
      : {}),
    pages: design.pages,
  };
  assert.equal(
    hash(JSON.stringify(metadata)),
    design.metadataSha256,
    'CANVA_METADATA_HASH_CHANGED',
  );
  let recheck: SourceCatalogEvidenceBody['designs'][number]['recheck'];
  if (design.metadataRecheck) {
    assert.equal(design.metadataRecheck.path, design.id + '-recheck.json');
    const repeated = await json(
      'canva-pages/' + design.metadataRecheck.path,
      'canva_page_count_recheck',
      design.metadataRecheck.sha256,
    );
    assert.equal(repeated.value.metadata.design.id, design.id);
    assert.equal(repeated.value.check.stablePageMetadata, true);
    assert.equal(repeated.value.metadata.design.page_count, design.currentPageCount);
    const stripped = (pages: any[]) => pages.map(({ thumbnail, ...p }) => p);
    assert.equal(
      canonicalJson(stripped(repeated.value.pagesObservation.response.items)),
      canonicalJson(stripped(evidence.value.pages)),
    );
    recheck = {
      file: repeated.ref,
      observedAt: repeated.value.metadata.observedAt,
      sourceDesignId: design.id,
    };
  }
  designEvidence.push({
    designId: design.id,
    sourceFile: evidence.ref,
    metadataSha256: design.metadataSha256,
    expectedPageCount: design.expectedPageCount,
    currentPageCount: design.currentPageCount ?? design.expectedPageCount,
    observedAt: design.observedAt,
    metadataUpdatedAt: design.metadataUpdatedAt,
    ...(design.currentMetadataUpdatedAt
      ? { currentMetadataUpdatedAt: design.currentMetadataUpdatedAt }
      : {}),
    ...(recheck ? { recheck } : {}),
  });
}
const snapshotChecksum = canonicalHash(snapshot),
  body: SourceCatalogEvidenceBody = {
    schemaVersion: 'source-catalog-evidence/v1',
    catalogId: snapshot.catalog.id,
    importFingerprint: snapshot.catalog.importFingerprint,
    snapshotChecksum,
    publishable: false,
    originalAssetsExported: false,
    counts: {
      listings: snapshot.listings.length,
      designs: snapshot.designs.length,
      pages: snapshot.pages.length,
    },
    files: fileRefs,
    designs: designEvidence,
    observation: { sourceSnapshotAtomic: false, ...validation.value.primaryObservationRange },
  };
const sqlitePath = await realpath(
  resolve(directory, 'catalog-' + snapshot.catalog.importFingerprint.slice(0, 12) + '.sqlite'),
);
inside(directory, sqlitePath);
function sameRows(actual: any[], expected: any[]) {
  assert.equal(
    canonicalJson(actual.map(canonicalJson).sort()),
    canonicalJson(expected.map(canonicalJson).sort()),
    'CATALOG_ROWS_CHANGED',
  );
}
const catalogId = snapshot.catalog.id;
const listingBodies = snapshot.listings.map(({ designCandidates, ...body }) => body);
const expectedCandidates = snapshot.listings.flatMap((l) =>
  l.designCandidates.map((d) => ({
    listing_id: l.id,
    design_id: d.id,
    reason: d.reason,
    status: d.status,
  })),
);
function verifySqlite(db: DatabaseSync) {
  const catalog = db
    .prepare('SELECT id,fingerprint,body FROM catalogs WHERE id=?')
    .get(catalogId) as any;
  assert.ok(catalog);
  assert.equal(catalog.fingerprint, snapshot.catalog.importFingerprint);
  assert.equal(canonicalJson(JSON.parse(catalog.body)), canonicalJson(snapshot.catalog));
  for (const [table, expected] of [
    ['sources', snapshot.catalog.sources],
    ['designs', snapshot.designs],
    ['listings', listingBodies],
  ] as const)
    sameRows(
      db
        .prepare(`SELECT body FROM ${table} WHERE catalog_id=?`)
        .all(catalogId)
        .map((r: any) => JSON.parse(r.body)),
      expected,
    );
  sameRows(
    db
      .prepare(
        'SELECT design_id AS "designId",id,page_number AS "pageNumber",width,height FROM pages WHERE catalog_id=?',
      )
      .all(catalogId),
    snapshot.pages,
  );
  sameRows(
    db
      .prepare('SELECT listing_id,design_id,reason,status FROM candidates WHERE catalog_id=?')
      .all(catalogId),
    expectedCandidates,
  );
  assert.equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
}
const sqliteRead = new DatabaseSync(sqlitePath, { readOnly: true });
try {
  verifySqlite(sqliteRead);
} finally {
  sqliteRead.close();
}
const dbUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(
  ['localhost', '127.0.0.1'].includes(dbUrl.hostname) && dbUrl.port === '5442',
  'LOCAL_DATABASE_REQUIRED',
);
const pool = new Pool({ connectionString: dbUrl.href });
try {
  const catalog = (
    await pool.query('SELECT fingerprint,snapshot_checksum,body FROM source_catalogs WHERE id=$1', [
      catalogId,
    ])
  ).rows[0];
  assert.ok(catalog);
  assert.equal(catalog.fingerprint, snapshot.catalog.importFingerprint);
  assert.equal(catalog.snapshot_checksum, snapshotChecksum);
  assert.equal(canonicalJson(catalog.body), canonicalJson(snapshot.catalog));
  for (const [table, expected] of [
    ['source_catalog_files', snapshot.catalog.sources],
    ['source_catalog_designs', snapshot.designs],
    ['source_catalog_pages', snapshot.pages],
    ['source_catalog_listings', listingBodies],
  ] as const)
    sameRows(
      (await pool.query(`SELECT body FROM ${table} WHERE catalog_id=$1`, [catalogId])).rows.map(
        (r) => r.body,
      ),
      expected,
    );
  sameRows(
    (
      await pool.query(
        'SELECT listing_key AS listing_id,design_id,reason,status FROM source_catalog_candidates WHERE catalog_id=$1',
        [catalogId],
      )
    ).rows,
    expectedCandidates,
  );
  const evidenceSha256 = canonicalHash(body);
  const verified = {
    catalogId,
    importFingerprint: snapshot.catalog.importFingerprint,
    evidenceSha256,
    snapshotChecksum,
    verifiedFiles:
      fileRefs.length + designEvidence.length + designEvidence.filter((d) => d.recheck).length,
    counts: body.counts,
    rechecks: designEvidence.filter((d) => d.recheck).length,
    sqlitePath: inside(workspace, sqlitePath),
    catalogTablesVerifiedUnchanged: true,
    publishable: false,
    originalAssetsExported: false,
  };
  if (checkOnly) {
    console.log(JSON.stringify({ mode: 'read_only_check', ...verified }));
  } else {
    // Register only the explicitly authorized new migration. No unrelated pending migration is run.
    const migrationName = '020_source_catalog_evidence.sql',
      sql = await readFile(
        resolve(workspace, 'packages/persistence/migrations', migrationName),
        'utf8',
      ),
      checksum = hash(sql);
    await transaction(pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(24091001)');
      const old = (
        await c.query('SELECT checksum FROM schema_migrations WHERE name=$1', [migrationName])
      ).rows[0];
      if (old) {
        assert.equal(old.checksum, checksum, 'MIGRATION_CHECKSUM_CHANGED');
        return;
      }
      assert.ok(
        (await c.query("SELECT 1 FROM schema_migrations WHERE name='019_source_catalog.sql'"))
          .rowCount,
      );
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
        migrationName,
        checksum,
      ]);
    });
    const attached = await attachSourceCatalogEvidence(pool, { catalogId, body });
    assert.equal(attached.evidenceSha256, evidenceSha256);
    const sqlite = new DatabaseSync(sqlitePath);
    let sqliteInserted = false;
    try {
      sqlite.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
      verifySqlite(sqlite);
      sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_evidence(catalog_id TEXT NOT NULL REFERENCES catalogs(id),evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(catalog_id,evidence_sha256));
CREATE TRIGGER IF NOT EXISTS immutable_catalog_evidence_update BEFORE UPDATE ON catalog_evidence BEGIN SELECT RAISE(ABORT,'CATALOG_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS immutable_catalog_evidence_delete BEFORE DELETE ON catalog_evidence BEGIN SELECT RAISE(ABORT,'CATALOG_EVIDENCE_IMMUTABLE'); END;`);
      const existing = sqlite
        .prepare('SELECT body FROM catalog_evidence WHERE catalog_id=? AND evidence_sha256=?')
        .get(catalogId, evidenceSha256) as any;
      if (existing)
        assert.equal(
          canonicalJson(JSON.parse(existing.body)),
          canonicalJson(body),
          'SQLITE_EVIDENCE_CONFLICT',
        );
      else {
        sqlite
          .prepare('INSERT INTO catalog_evidence VALUES(?,?,?,?)')
          .run(catalogId, evidenceSha256, JSON.stringify(body), new Date().toISOString());
        sqliteInserted = true;
      }
      verifySqlite(sqlite);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    } finally {
      sqlite.close();
    }
    const report = {
      schemaVersion: 'source-catalog-provenance-attachment/v1',
      ...verified,
      postgresInserted: attached.inserted,
      sqliteInserted,
      attachedAt: new Date().toISOString(),
      body,
    };
    await writeFile(resolve(directory, 'catalog-provenance.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        ...verified,
        postgresInserted: attached.inserted,
        sqliteInserted,
        artifact: inside(workspace, resolve(directory, 'catalog-provenance.json')),
      }),
    );
  }
} finally {
  await pool.end();
}
