import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Pool } from '../packages/persistence/src/index.js';
import { Repository } from '../packages/persistence/src/index.js';
import { PreparedWireRunner } from '../apps/api/src/prepared-wire-runner.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const directory = '.local/acceptance-20260914/wire-bridge/verification';
try {
  const prior = JSON.parse(
    await readFile('.local/acceptance-20260914/prepared-verification/protected-after.json', 'utf8'),
  );
  const protectedTables: Record<string, unknown> = {};
  for (const table of [
    'products',
    'product_revisions',
    'work_orders',
    'work_order_revisions',
    'sandbox_listing_runs',
    'input_batches',
    'input_batch_revisions',
  ]) {
    const rows = (
      await pool.query(
        `SELECT row_to_json(t)::text AS value FROM public.${table} t ORDER BY row_to_json(t)::text`,
      )
    ).rows;
    const sha256 = createHash('sha256')
      .update(JSON.stringify(rows.map((r) => r.value)))
      .digest('hex');
    protectedTables[table] = {
      rows: rows.length,
      sha256,
      unchanged: rows.length === prior.tables[table].rows && sha256 === prior.tables[table].sha256,
    };
  }
  const operations = (
    await pool.query(
      'SELECT id,owner_key,source_key,item_id,state FROM public.prepared_wire_operations ORDER BY created_at',
    )
  ).rows;
  const steps = (
    await pool.query(
      'SELECT operation_id,ordinal,path,state FROM public.prepared_wire_steps ORDER BY operation_id,ordinal',
    )
  ).rows;
  const testConnections = (
    await pool.query(
      "SELECT id,name,display_name,shop_id,revision,capability_revision FROM public.connections WHERE environment='sandbox' ORDER BY shop_id",
    )
  ).rows;
  const report = {
    observedAt: new Date().toISOString(),
    protectedTables,
    operations,
    steps,
    testConnections,
  };
  if (Object.values(protectedTables).some((v: any) => !v.unchanged))
    throw new Error('PROTECTED_DATA_CHANGED');
  if (
    operations.length !== 1 ||
    operations[0].id !== '8bb19101-220b-4693-af7b-4fcf85aca6c3' ||
    operations[0].state !== 'acknowledged' ||
    steps.length !== 1
  )
    throw new Error('WIRE_SCOPE_CHANGED');
  const runner = new PreparedWireRunner(new Repository(pool), {
    allowedShops: [{ partnerId: '1232297', shopId: '227418363' }],
  });
  await writeFile(
    '.local/acceptance-20260914/wire-bridge/title-canary/journal.json',
    JSON.stringify(await runner.get(operations[0].id), null, 2),
  );
  await mkdir(directory, { recursive: true });
  await writeFile(directory + '/main-data-audit.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      directory,
      protectedTablesUnchanged: true,
      operations: operations.length,
      mutatingRequests: steps.length,
      sandboxConnections: testConnections.length,
    }),
  );
} finally {
  await pool.end();
}
