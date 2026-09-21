import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Pool,
  migrate,
  storeSourceCatalog,
  getSourceCatalog,
} from '../packages/persistence/src/index.js';
import { buildSourceCatalog } from '../apps/api/src/source-catalog-build.js';

const root = resolve(process.argv[2] ?? '.local/input-catalog/vina-tuoi-20260914');
const profile = JSON.parse(await readFile(resolve(root, 'workbook-profile.json'), 'utf8'));
const inventory = JSON.parse(
  await readFile(resolve(root, 'canva-pages/all-design-pages.json'), 'utf8'),
);
const references = JSON.parse(await readFile(resolve(root, 'seller-observations.json'), 'utf8'));
const snapshot = buildSourceCatalog(
  profile,
  inventory,
  'https://www.canva.com/folder/FAHUmIOUUyk',
  references,
);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(pool);
  const result = await storeSourceCatalog(pool, snapshot);
  if (!result.inserted) snapshot.catalog = (await getSourceCatalog(pool, result.id))!;
  await writeFile(resolve(root, 'catalog-snapshot.json'), JSON.stringify(snapshot, null, 2));
  const evidence = {
    ...result,
    counts: snapshot.catalog.counts,
    brands: snapshot.catalog.brands,
    issueCounts: Object.fromEntries(
      ['no_design', 'multiple_designs', 'missing_item_id', 'source_review'].map((code) => [
        code,
        snapshot.listings.filter((l) => l.issues.some((i) => i.code === code)).length,
      ]),
    ),
    listingsWithOneCandidate: snapshot.listings.filter((l) => l.designCandidateCount === 1).length,
    persistedAt: new Date().toISOString(),
    publishable: false,
    originalAssetsDownloaded: false,
  };
  await writeFile(
    resolve(root, result.inserted ? 'import-receipt.json' : 'import-repeat-receipt.json'),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  await pool.end();
}
