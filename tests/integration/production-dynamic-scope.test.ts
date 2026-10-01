import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, migrate } from '../../packages/persistence/src/index.js';
import { assertLocalIntegrationDatabase } from '../helpers/integration-database.js';

const database = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/invalid');
if (process.env.INTERNAL_ISOLATED_MODE !== '1') throw Error('DYNAMIC_SCOPE_REQUIRES_ISOLATED_DATABASE');
assertLocalIntegrationDatabase(database);
const schema = 'dynamic_scope_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const a = { environment: 'production', partnerId: '987654', shopId: '8001001' };
const b = { environment: 'production', partnerId: '123456', shopId: '8001002' };
const owner = (scope: typeof a) => `${scope.environment}:${scope.partnerId}:${scope.shopId}`;
const connectionA = randomUUID(), connectionB = randomUUID();
const batchId = randomUUID(), docSha = 'a'.repeat(64), manifestSha = 'b'.repeat(64);
async function operation(scope: typeof a, connectionId: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID(), payload = { scope, metadata: scope,
    batchAuthorization: { batchId, manifestSha256: manifestSha,
      sources: [{ sourceIdentity: 'exact-source', sourceRevision: 1, documentSha256: docSha }] } };
  const values = { owner: owner(scope), payload, ...overrides };
  await pool.query(`INSERT INTO production_pilot_operations(id,owner_key,connection_id,connection_revision,
    source_identity,source_revision,source_payload,source_fingerprint,expected_projection,state,item_id)
    VALUES($1,$2,$3,1,'exact-source',1,$4,$5,'{}','unknown','9002001')`,
  [id, values.owner, connectionId, values.payload, 'c'.repeat(64)]);
  return id;
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
  for (const [id, scope] of [[connectionA, a], [connectionB, b]] as const)
    await pool.query('INSERT INTO connections(id,environment,partner_id,shop_id,name) VALUES($1,$2,$3,$4,$5)',
      [id, scope.environment, scope.partnerId, scope.shopId, 'Local scope fixture']);
});
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

it('accepts independent shop journals and keeps both unknown lanes locked', async () => {
  const operationA = await operation(a, connectionA), operationB = await operation(b, connectionB);
  for (const [scope, id] of [[a, operationA], [b, operationB]] as const)
    await pool.query('INSERT INTO production_pilot_lanes(owner_key,operation_id) VALUES($1,$2)', [owner(scope), id]);
  expect((await pool.query('SELECT count(*)::int AS count FROM production_pilot_lanes')).rows[0].count).toBe(2);
  await expect(pool.query('DELETE FROM production_pilot_lanes WHERE owner_key=$1', [owner(a)]))
    .rejects.toThrow('PRODUCTION_PILOT_LANE_NEEDS_VERIFICATION');
  await expect(pool.query('UPDATE production_pilot_operations SET state=\'authorized\',revision=revision+1 WHERE id=$1', [operationA]))
    .rejects.toThrow('PRODUCTION_PILOT_REPLAY_FORBIDDEN');
});

it('rejects a claimed owner, metadata or lane belonging to a different shop', async () => {
  await expect(operation(a, connectionA, { owner: owner(b) })).rejects.toThrow('PRODUCTION_SCOPE_CONNECTION_MISMATCH');
  await expect(operation(a, connectionA, { payload: { scope: a, metadata: b } })).rejects.toThrow('PRODUCTION_SCOPE_PAYLOAD_MISMATCH');
  await expect(operation(a, connectionA, { payload: { metadata: {shopId:a.shopId} } })).rejects.toThrow('PRODUCTION_SCOPE_PAYLOAD_MISMATCH');
  const id = (await pool.query('SELECT id FROM production_pilot_operations WHERE owner_key=$1', [owner(a)])).rows[0].id;
  await expect(pool.query('INSERT INTO production_pilot_lanes(owner_key,operation_id) VALUES($1,$2)', ['production:111:222', id]))
    .rejects.toThrow('PRODUCTION_SCOPE_LANE_MISMATCH');
});

it('binds deferred execution policy to the operation connection and exact source proof', async () => {
  const id = (await pool.query('SELECT id FROM production_pilot_operations WHERE owner_key=$1', [owner(a)])).rows[0].id;
  async function policy(scope: typeof a, sourceSha = docSha) {
    const preparationId = randomUUID(), policyId = randomUUID();
    await pool.query("INSERT INTO production_source_preparations(id,request_hash,request,body,fingerprint) VALUES($1,$2,'{}',$3,$2)",
      [preparationId, 'd'.repeat(64), { scope }]);
    await pool.query("INSERT INTO production_execution_policies(id,preparation_id,request_hash,request,body,fingerprint) VALUES($1,$2,$3,'{}',$4,$3)",
      [policyId, preparationId, 'e'.repeat(64), { scope, publicationMode: 'hidden_for_review', imageQcPolicy: 'defer_image_qc',
        batches: [{ batchId, manifestSha256: manifestSha, sources: [{ sourceIdentity: 'exact-source', sourceRevision: 1, documentSha256: sourceSha }] }] }]);
    return (await pool.query('SELECT production_execution_policy_matches_operation($1,$2) AS matches', [policyId, id])).rows[0].matches;
  }
  expect(await policy(a)).toBe(true); expect(await policy(b)).toBe(false);
  expect(await policy(a, 'f'.repeat(64))).toBe(false);
});
