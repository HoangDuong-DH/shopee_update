import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { sandboxTryoutContext } from '../../apps/api/src/sandbox-tryout-context.js';

const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
const connectionId = randomUUID(),
  trialId = randomUUID();
const trialItemId = 'b53c59ec-fec6-4554-a770-c5db3a660907';
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,display_name,state,revision,token_ciphertext,partner_key_ciphertext) VALUES($1,'sandbox','1232297','227418363','remote technical','Shop thử nội bộ','connected',7,'sealed','sealed')",
    [connectionId],
  );
  await pool.query(
    "INSERT INTO sandbox_create_trials(id,trial_key,connection_id,connection_revision,fingerprint,manifest,evidence) VALUES($1,'SBX-BULK-TRYOUT',$2,7,'fixture','{}','{}')",
    [trialId, connectionId],
  );
});
async function seedItem(itemId = '803935036', sourceKey = 'SBX-BULK-TRYOUT-001') {
  await pool.query('DELETE FROM sandbox_create_trial_items WHERE id=$1', [trialItemId]);
  await pool.query(
    "INSERT INTO sandbox_create_trial_items(id,trial_id,connection_id,source_key,position,intent,state,stage,item_id) VALUES($1,$2,$3,$4,0,'{}','verified','done',$5)",
    [trialItemId, trialId, connectionId, sourceKey, itemId],
  );
}
beforeEach(async () => {
  await pool.query(
    "UPDATE connections SET environment='sandbox',shop_id='227418363',state='connected',token_ciphertext='sealed',revision=7,expires_at=NULL WHERE id=$1",
    [connectionId],
  );
  await pool.query('DELETE FROM sandbox_field_trials');
  await seedItem();
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
it('offers only the proven technical TEST target and returns no credentials', async () => {
  const result = await sandboxTryoutContext(repo);
  expect(result).toMatchObject({
    available: true,
    connectionRevision: 7,
    shopName: 'Shop thử nội bộ',
    itemId: '803935036',
    fields: ['title', 'stock'],
    scope: { environment: 'sandbox', partnerId: '1232297', shopId: '227418363' },
  });
  expect(JSON.stringify(result)).not.toContain('sealed');
});
it.each([
  'production',
  'other-shop',
  'protected-item',
  'unknown-item',
  'business-source',
  'missing-token',
  'disconnected',
])('blocks invalid context: %s', async (mode) => {
  if (mode === 'production')
    await pool.query("UPDATE connections SET environment='production' WHERE id=$1", [connectionId]);
  if (mode === 'other-shop')
    await pool.query("UPDATE connections SET shop_id='100' WHERE id=$1", [connectionId]);
  if (mode === 'protected-item') await seedItem('803934364');
  if (mode === 'unknown-item')
    await pool.query("UPDATE sandbox_create_trial_items SET state='unknown' WHERE id=$1", [
      trialItemId,
    ]);
  if (mode === 'business-source') await seedItem('803935036', 'lamy-5d');
  if (mode === 'missing-token')
    await pool.query('UPDATE connections SET token_ciphertext=NULL WHERE id=$1', [connectionId]);
  if (mode === 'disconnected')
    await pool.query("UPDATE connections SET state='disconnected' WHERE id=$1", [connectionId]);
  expect(await sandboxTryoutContext(repo)).toMatchObject({ available: false });
});
it('holds the test button while another field write outcome is unknown', async () => {
  await pool.query(
    "INSERT INTO sandbox_field_trials(id,trial_item_id,connection_id,connection_revision,item_id,fingerprint,input,baseline,operation,state) VALUES($1,$2,$3,7,'803935036',$4,'{}','{}','{}','unknown')",
    [randomUUID(), trialItemId, connectionId, 'a'.repeat(64)],
  );
  expect(await sandboxTryoutContext(repo)).toMatchObject({ available: false });
});
it('does not advertise an expired connection as ready', async () => {
  await pool.query("UPDATE connections SET expires_at=now()-interval '1 hour' WHERE id=$1", [
    connectionId,
  ]);
  expect(await sandboxTryoutContext(repo)).toMatchObject({ available: false });
});
it('holds the test button while a legacy create is waiting to run', async () => {
  await pool.query(
    "INSERT INTO sandbox_create_trial_items(id,trial_id,connection_id,source_key,position,intent,state,stage) VALUES($1,$2,$3,'SBX-BULK-TRYOUT-QUEUED',1,'{}','queued','queued')",
    [randomUUID(), trialId, connectionId],
  );
  expect(await sandboxTryoutContext(repo)).toMatchObject({ available: false });
});
