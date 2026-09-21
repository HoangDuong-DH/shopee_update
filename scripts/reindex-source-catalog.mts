import 'dotenv/config';
import { Pool, transaction, catalogSearchText } from '../packages/persistence/src/index.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  let count = 0;
  await transaction(pool, async (c) => {
    const rows = (await c.query('SELECT catalog_id,listing_key,body FROM source_catalog_listings'))
      .rows;
    for (const row of rows) {
      // Only the derived search index changes. The immutable source body and its checksum stay intact.
      await c.query(
        'UPDATE source_catalog_listings SET search_text=$3 WHERE catalog_id=$1 AND listing_key=$2',
        [row.catalog_id, row.listing_key, catalogSearchText(row.body)],
      );
      count++;
    }
  });
  console.log(JSON.stringify({ indexed: count, sourceBodyChanged: false }));
} finally {
  await pool.end();
}
