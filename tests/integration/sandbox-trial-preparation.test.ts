import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { SecretBox } from '../../packages/shopee/src/index.js';
import { SandboxTrialService } from '../../apps/api/src/sandbox-trial-service.js';

const schema = 'test_' + randomUUID().replaceAll('-', ''),
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const connectionId = randomUUID(),
  key = 'a'.repeat(64),
  box = new SecretBox(key),
  calls: string[] = [];
const service = new SandboxTrialService(
  new Repository(pool),
  new BlobStore('.local/test-trial-blobs'),
  {
    encryptionKey: key,
    transport: async (input) => {
      calls.push(new URL(String(input)).pathname);
      return new Response(
        JSON.stringify({ error: 'invalid_acceess_token', request_id: 'TEST-auth' }),
        { status: 403 },
      );
    },
  },
);
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await pool.query(
    `INSERT INTO connections(id,environment,partner_id,shop_id,name,state,partner_key_ciphertext,token_ciphertext) VALUES($1,'sandbox','1232297','227418363','TEST only','connected',$2,$3)`,
    [
      connectionId,
      box.seal({ partnerKey: 'test-key' }, 'sandbox:1232297:227418363'),
      box.seal({ accessToken: 'test-token' }, 'sandbox:1232297:227418363'),
    ],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
it('expired token blocks preparation before any upload or product write and never persists credentials', async () => {
  await expect(
    service.prepare({
      trialKey: 'SBX-BULK-AUTH',
      connectionId,
      connectionRevision: 1,
      count: 1,
      logisticId: 51022,
    }),
  ).rejects.toThrow('SANDBOX_API_REJECTED:invalid_acceess_token');
  expect(calls).toEqual(['/api/v2/shop/get_shop_info']);
  const saved = (await pool.query('SELECT * FROM sandbox_trial_preparations')).rows;
  expect(saved).toHaveLength(1);
  expect(saved[0].state).toBe('blocked');
  expect(JSON.stringify(saved)).not.toMatch(/test-token|test-key/);
  expect((await pool.query('SELECT count(*)::int n FROM sandbox_create_trials')).rows[0].n).toBe(0);
});
it('cannot submit an unprepared trial or manufacture readiness in client input', async () => {
  const saved = (await pool.query('SELECT id FROM sandbox_trial_preparations')).rows[0];
  await expect(service.submit(saved.id, { fingerprint: '0'.repeat(64) })).rejects.toThrow(
    'SANDBOX_TRIAL_NOT_PREPARED',
  );
  await expect(
    service.prepare({
      trialKey: 'SBX-BULK-FAKE',
      connectionId,
      connectionRevision: 1,
      count: 1,
      logisticId: 51022,
      evidence: { validatedAt: new Date().toISOString() },
    }),
  ).rejects.toThrow();
});
