import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool, sandboxMutationLaneBusy } from '../packages/persistence/src/index.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const counts = await pool.query(
    `SELECT 'create' AS family,state,count(*)::int AS count FROM sandbox_create_trial_items GROUP BY state UNION ALL SELECT 'field',state,count(*)::int FROM sandbox_field_trials GROUP BY state UNION ALL SELECT 'listing',state,count(*)::int FROM sandbox_listing_runs GROUP BY state UNION ALL SELECT 'media',state,count(*)::int FROM sandbox_trial_preparations GROUP BY state UNION ALL SELECT 'wire',state,count(*)::int FROM prepared_wire_operations GROUP BY state UNION ALL SELECT 'variation',state,count(*)::int FROM variation_operations GROUP BY state ORDER BY family,state`,
  );
  const variations = (
    await pool.query(
      'SELECT id,owner_key,state,plan,result FROM variation_operations ORDER BY created_at',
    )
  ).rows;
  if (variations.some((r) => r.owner_key !== 'sandbox:1232297:227418363'))
    throw new Error('UNEXPECTED_VARIATION_OWNER');
  const cases = (
    await pool.query(
      "SELECT id,binding,comparison->>'state' AS state FROM image_qc_cases ORDER BY created_at",
    )
  ).rows;
  const reviews = (
    await pool.query(
      "SELECT request_id,case_id,body->>'reviewer' AS reviewer,result->>'state' AS state FROM image_qc_reviews",
    )
  ).rows;
  const live = [];
  for (const name of ['rename-one', 'reorder-one', 'rename-two', 'add-one', 'remove-combination']) {
    const result = JSON.parse(
      await readFile(
        '.local/acceptance-20260914/variation-qc/live/' + name + '/result.json',
        'utf8',
      ),
    );
    live.push({
      case: name,
      id: result.id,
      state: result.state,
      steps: result.steps.map((s: any) => ({
        path: s.path,
        state: s.state,
        requestId: s.receipt?.requestId,
        readbackObservations: s.qc?.observations.map((o: any) => ({
          verified: o.verified,
          requestId: o.requestId,
          mismatchedPaths: o.mismatchedPaths,
        })),
      })),
    });
  }
  const laneBusy = await sandboxMutationLaneBusy(pool, 'sandbox:1232297:227418363');
  const report = {
    observedAt: new Date().toISOString(),
    productionMutations: 0,
    scope: 'sandbox technical fixtures only; no production credentials used',
    counts: counts.rows,
    live,
    imageCases: cases,
    imageReviews: reviews,
    legacyUnresolvedHoldsShop: laneBusy,
    postCount: live.reduce((n, r) => n + r.steps.length, 0),
    unknownCasesNotOverwritten: true,
  };
  await writeFile(
    '.local/acceptance-20260914/variation-qc/delivery-audit.json',
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      live: live.map(({ case: name, state }) => ({ case: name, state })),
      legacyUnresolvedHoldsShop: laneBusy,
      imageCases: cases.length,
      imageReviews: reviews.length,
      counts: counts.rows,
    }),
  );
} finally {
  await pool.end();
}
