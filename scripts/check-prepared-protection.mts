import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from '@shopee/persistence';
const label = process.argv[2];
if (!['before', 'after'].includes(label)) throw new Error('Use before or after.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const tables: Record<string, { rows: number; sha256: string }> = {};
  for (const table of [
    'products', 'product_revisions', 'work_orders', 'work_order_revisions',
    'sandbox_listing_runs', 'input_batches', 'input_batch_revisions',
  ]) {
    const rows = (await pool.query(`SELECT row_to_json(t)::text AS value FROM public.${table} t ORDER BY row_to_json(t)::text`)).rows;
    tables[table] = {
      rows: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows.map(row => row.value))).digest('hex'),
    };
  }
  await mkdir('.local/acceptance-20260914/prepared-verification', { recursive: true });
  await writeFile(`.local/acceptance-20260914/prepared-verification/protected-${label}.json`, JSON.stringify({ observedAt: new Date().toISOString(), tables }, null, 2));
  console.log(JSON.stringify({ label, tables }));
} finally {
  await pool.end();
}
