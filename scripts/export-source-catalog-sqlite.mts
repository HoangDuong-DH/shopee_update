import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CatalogSnapshot } from '../packages/persistence/src/source-catalogs.js';

const root = resolve(process.argv[2] ?? '.local/input-catalog/vina-tuoi-20260914');
const snapshot: CatalogSnapshot = JSON.parse(
  await readFile(resolve(root, 'catalog-snapshot.json'), 'utf8'),
);
// New file per immutable source fingerprint; existing exports are reopened without destructive overwrite.
const file = resolve(
  root,
  'catalog-' + snapshot.catalog.importFingerprint.slice(0, 12) + '.sqlite',
);
const db = new DatabaseSync(file);
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS catalogs(id TEXT PRIMARY KEY,fingerprint TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(catalog_id TEXT REFERENCES catalogs(id),id TEXT,body TEXT NOT NULL,PRIMARY KEY(catalog_id,id));
CREATE TABLE IF NOT EXISTS listings(catalog_id TEXT REFERENCES catalogs(id),id TEXT,brand TEXT,item_id TEXT,title TEXT,body TEXT NOT NULL,PRIMARY KEY(catalog_id,id));
CREATE TABLE IF NOT EXISTS designs(catalog_id TEXT REFERENCES catalogs(id),id TEXT,title TEXT,page_count INTEGER,body TEXT NOT NULL,PRIMARY KEY(catalog_id,id));
CREATE TABLE IF NOT EXISTS pages(catalog_id TEXT,design_id TEXT,id TEXT,page_number INTEGER,width INTEGER,height INTEGER,
PRIMARY KEY(catalog_id,design_id,id),UNIQUE(catalog_id,design_id,page_number),FOREIGN KEY(catalog_id,design_id) REFERENCES designs(catalog_id,id));
CREATE TABLE IF NOT EXISTS candidates(catalog_id TEXT,listing_id TEXT,design_id TEXT,reason TEXT,status TEXT CHECK(status='suggested'),
PRIMARY KEY(catalog_id,listing_id,design_id),FOREIGN KEY(catalog_id,listing_id) REFERENCES listings(catalog_id,id),FOREIGN KEY(catalog_id,design_id) REFERENCES designs(catalog_id,id));`);
try {
  db.exec('BEGIN');
  if (
    !db
      .prepare('SELECT id FROM catalogs WHERE fingerprint=?')
      .get(snapshot.catalog.importFingerprint)
  ) {
    const c = snapshot.catalog;
    db.prepare('INSERT INTO catalogs VALUES(?,?,?)').run(
      c.id,
      c.importFingerprint,
      JSON.stringify(c),
    );
    const source = db.prepare('INSERT INTO sources VALUES(?,?,?)');
    for (const s of c.sources) source.run(c.id, s.id, JSON.stringify(s));
    const design = db.prepare('INSERT INTO designs VALUES(?,?,?,?,?)');
    for (const d of snapshot.designs)
      design.run(c.id, d.id, d.title, d.pageCount, JSON.stringify(d));
    const page = db.prepare('INSERT INTO pages VALUES(?,?,?,?,?,?)');
    for (const p of snapshot.pages)
      page.run(c.id, p.designId, p.id, p.pageNumber, p.width, p.height);
    const listing = db.prepare('INSERT INTO listings VALUES(?,?,?,?,?,?)');
    const candidate = db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?)');
    for (const l of snapshot.listings) {
      const { designCandidates, ...body } = l;
      listing.run(c.id, l.id, l.brand, l.itemId, l.title, JSON.stringify(body));
      for (const d of designCandidates) candidate.run(c.id, l.id, d.id, d.reason, d.status);
    }
  }
  db.exec('COMMIT');
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
  console.log(
    JSON.stringify({
      file,
      integrity,
      foreignKeyErrors,
      counts: snapshot.catalog.counts,
      publishable: false,
    }),
  );
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
