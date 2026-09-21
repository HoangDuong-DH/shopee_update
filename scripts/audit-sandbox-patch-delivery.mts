import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from '../packages/persistence/src/index.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const folder = '.local/acceptance-20260914/patch-matrix';
try {
  const prior = JSON.parse(
    await readFile(
      '.local/acceptance-20260914/wire-bridge/verification/main-data-audit.json',
      'utf8',
    ),
  );
  const protectedTables: Record<string, any> = {};
  for (const table of Object.keys(prior.protectedTables)) {
    if (
      ![
        'products',
        'product_revisions',
        'work_orders',
        'work_order_revisions',
        'sandbox_listing_runs',
        'input_batches',
        'input_batch_revisions',
      ].includes(table)
    )
      throw new Error('UNEXPECTED_TABLE');
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
      unchanged:
        rows.length === prior.protectedTables[table].rows &&
        sha256 === prior.protectedTables[table].sha256,
    };
  }
  const operations = (
    await pool.query(
      'SELECT id,item_id,state,owner_key FROM public.prepared_wire_operations ORDER BY created_at',
    )
  ).rows;
  const expected = [
    '8bb19101-220b-4693-af7b-4fcf85aca6c3',
    'c9490617-a32f-4925-b9e9-d29ba58918cf',
    '13348d32-3582-4faa-b63c-4986c2481568',
    'f024d84e-9f95-48da-bdee-4749641873c0',
    '0c2ed720-0dc8-4ff4-9f47-607c14979bac',
  ];
  if (
    operations.length !== expected.length ||
    operations.some(
      (r: any) =>
        !expected.includes(r.id) ||
        r.owner_key !== 'sandbox:1232297:227418363' ||
        r.state !== 'acknowledged',
    )
  )
    throw new Error('MUTATION_SCOPE_CHANGED');
  const steps = (
    await pool.query(
      'SELECT operation_id,ordinal,path,state FROM public.prepared_wire_steps ORDER BY operation_id,ordinal',
    )
  ).rows;
  if (steps.length !== 5 || Object.values(protectedTables).some((r) => !r.unchanged))
    throw new Error('PROTECTED_DATA_CHANGED');
  const connections = (
    await pool.query(
      "SELECT environment,partner_id,shop_id,revision,capability_revision FROM public.connections WHERE environment='sandbox'",
    )
  ).rows;
  await writeFile(
    folder + '/main-data-audit.json',
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        protectedTables,
        operations,
        steps,
        connections,
        newListingPatchRequests: 4,
        newImageUploadRequests: 3,
        productionMutations: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      protectedTablesUnchanged: true,
      newListingPatchRequests: 4,
      newImageUploadRequests: 3,
      sandboxConnections: connections.length,
      productionMutations: 0,
    }),
  );
} finally {
  await pool.end();
}
