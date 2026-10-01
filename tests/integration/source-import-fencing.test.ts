import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { assertLocalIntegrationDatabase } from '../helpers/integration-database.js';

const database = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/invalid');
if (process.env.INTERNAL_ISOLATED_MODE !== '1') throw Error('IMPORT_FENCING_REQUIRES_ISOLATED_DATABASE');
assertLocalIntegrationDatabase(database);
const schema = 'import_fencing_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const first = new Repository(pool), second = new Repository(pool);
const create = () => first.createImport({ sha256: randomUUID().replaceAll('-', '').repeat(2),
  filename: 'Nguồn gốc.png', kind: 'image', bytes: 100 });

beforeAll(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
beforeEach(async () => { await pool.query('DELETE FROM source_files'); });
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

it('fences stale success, stale failure and renewal after another worker reclaims the import', async () => {
  const source = await create(), a = (await first.claimImport('worker-a'))!;
  expect(a.id).toBe(source.id);
  await pool.query("UPDATE source_files SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [source.id]);
  const b = (await second.claimImport('worker-b'))!;
  expect(b.id).toBe(source.id); expect(b.leaseEpoch).toBe(a.leaseEpoch + 1);
  expect(await first.finishClaimedImport(a, { stale: 'success' })).toBe(false);
  expect(await first.finishClaimedImport(a, null, 'ASSET_STALE_FAILURE')).toBe(false);
  expect(await first.renewImportLease(a)).toBe(false);
  await expect(first.finishImport(source.id, { bypass: true })).rejects.toThrow('IMPORT_CURRENT_LEASE_REQUIRED');
  expect((await first.getImport(source.id))?.body).toBeNull();
  expect(await second.finishClaimedImport(b, { verifiedLocalParse: true })).toBe(true);
  expect(await first.getImport(source.id)).toMatchObject({ status: 'ready', body: { verifiedLocalParse: true } });
});

it('renews only its unexpired lease without changing evidence or epoch', async () => {
  const source = await create(), claim = (await first.claimImport('worker-own'))!;
  await pool.query("UPDATE source_files SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [source.id]);
  expect(await first.renewImportLease({ ...claim, workerId: 'worker-spoof' })).toBe(false);
  expect(await first.renewImportLease(claim)).toBe(true);
  const row = (await pool.query('SELECT *,lease_until>clock_timestamp()+interval \'4 minutes\' AS extended FROM source_files WHERE id=$1', [source.id])).rows[0];
  expect(row.extended).toBe(true); expect(row.lease_epoch).toBe(claim.leaseEpoch);
  expect(row.sha256).toBe(source.sha256); expect(row.body).toBeNull();
  expect(await first.finishClaimedImport(claim, null, 'ASSET_INVALID_DIMENSIONS')).toBe(true);
  expect(await first.getImport(source.id)).toMatchObject({ status: 'failed', message: 'ASSET_INVALID_DIMENSIONS' });
});

it('does not revive an expired lease even before reclamation', async () => {
  const source = await create(), claim = (await first.claimImport('worker-expired'))!;
  await pool.query("UPDATE source_files SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [source.id]);
  expect(await first.renewImportLease(claim)).toBe(false);
  expect(await first.finishClaimedImport(claim, { stale: true })).toBe(false);
  expect(await first.getImport(source.id)).toMatchObject({ status: 'running', body: null });
});

it('lets only one competing worker claim a queued source', async () => {
  const source = await create();
  const claimed = (await Promise.all([first.claimImport('worker-1'), second.claimImport('worker-2')])).filter(Boolean);
  expect(claimed).toHaveLength(1); expect(claimed[0]!.id).toBe(source.id);
  expect(claimed[0]!.leaseEpoch).toBe(1);
});

it('rejects an unfenced legacy worker completion at the database boundary', async () => {
  const source = await create(); await first.claimImport('worker-current');
  await expect(pool.query("UPDATE source_files SET status='ready',body='{}',lease_until=NULL WHERE id=$1", [source.id]))
    .rejects.toThrow('IMPORT_CURRENT_LEASE_REQUIRED');
  expect((await first.getImport(source.id))?.status).toBe('running');
});
