import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool, Repository, migrate, BlobStore } from '../../packages/persistence/src/index.js';
import { normalizeProductSnapshot } from '../../packages/shopee/src/product-client.js';
import { LegacyListingRecoveryService } from '../../apps/api/src/legacy-listing-recovery.js';
import { ImageQcService } from '../../apps/api/src/image-qc-service.js';
import { SandboxListingService } from '../../apps/api/src/sandbox-listing-service.js';
import sharp from 'sharp';
import { variationRawFixture } from '../fixtures/variation-platform.js';
import { fixtureDraft } from '../helpers/fixtures.js';
const schema = 'test_' + randomUUID().replaceAll('-', ''),
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool),
  connectionId = randomUUID(),
  runId = randomUUID();
const now = () => new Date('2026-09-14T10:00:00Z');
function sixModelFixture() {
  const snapshot = variationRawFixture(1);
  snapshot.item.item_id = 803934364;
  const model = snapshot.models.model[0]!,
    option = snapshot.models.tier_variation[0]!.option_list[0],
    standard = snapshot.models.standardise_tier_variation![0]!.variation_option_list[0];
  snapshot.models.model = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(model),
    model_id: 4258853357 + i,
    model_sku: `LAMY-FIXTURE-${i}`,
    model_name: `Option ${i}`,
    tier_index: [i],
  }));
  snapshot.models.tier_variation[0]!.option_list = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(option),
    option: `Option ${i}`,
  }));
  snapshot.models.standardise_tier_variation![0]!.variation_option_list = Array.from(
    { length: 6 },
    (_, i) => ({ ...structuredClone(standard), variation_option_name: `Option ${i}` }),
  );
  return snapshot;
}
let raw = sixModelFixture(),
  calls = 0,
  fault = '',
  cover:
    | { sourceImageId: string; outputImageId: string; sourceSha256: string; outputSha256: string }
    | undefined;
const image = new ImageQcService(repo, new BlobStore('.local/test-legacy-recovery'), { now });
const service = new LegacyListingRecoveryService(repo, image, {
  now,
  observe: async () => {
    calls++;
    const next = structuredClone(raw);
    if (fault === 'drift' && calls === 2) next.item.weight = '8';
    if (fault === 'standard-drift' && calls === 2)
      next.models.standardise_tier_variation![0]!.variation_id = 543;
    if (fault === 'cover-bytes' && calls === 2 && cover)
      cover = { ...cover, outputSha256: 'f'.repeat(64) };
    if (fault === 'revision' && calls === 2)
      await pool.query('UPDATE sandbox_listing_runs SET revision=revision+1 WHERE id=$1', [runId]);
    if (fault === 'connection' && calls === 2)
      await pool.query('UPDATE connections SET revision=revision+1 WHERE id=$1', [connectionId]);
    return {
      raw: next,
      observedAt: now().toISOString(),
      requestIds: ['base-' + calls, 'models-' + calls],
      ...(cover ? { cover: { ...cover } } : {}),
    };
  },
});
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await repo.saveProduct({ ...fixtureDraft(), productKey: 'lamy-5d' }, 0);
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,revision) VALUES($1,'sandbox','1232297','227418363','recovery fixture','connected',7)",
    [connectionId],
  );
});
beforeEach(async () => {
  await pool.query('TRUNCATE sandbox_listing_reconciliations');
  await pool.query('DELETE FROM sandbox_listing_run_events');
  await pool.query('DELETE FROM sandbox_listing_runs');
  await pool.query('UPDATE connections SET revision=7 WHERE id=$1', [connectionId]);
  calls = 0;
  fault = '';
  cover = undefined;
  raw = sixModelFixture();
  const snapshot = normalizeProductSnapshot(raw.item, raw.models, '803934364', [
    'old-base',
    'old-models',
  ]);
  const body = {
    phase: 'done',
    fieldMask: ['title'],
    baseline: snapshot,
    expected: snapshot,
    patch: { item_id: 803934364, item_name: raw.item.item_name },
    result: { code: 'COVER_READBACK_REVIEW', requestIds: ['old-write'] },
  };
  await pool.query(
    "INSERT INTO sandbox_listing_runs(id,connection_id,item_id,product_key,source_revision,connection_revision,input_fingerprint,revision,state,intent,body) VALUES($1,$2,'803934364','lamy-5d',1,1,'historical-intent',25,'unknown',$3,$4)",
    [runId, connectionId, { input: { fieldMask: ['title'] } }, body],
  );
  await pool.query(
    "INSERT INTO sandbox_listing_run_events(run_id,revision,state,code) VALUES($1,21,'in_flight','WRITE_ACKNOWLEDGED')",
    [runId],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
const input = () => ({ id: randomUUID(), runId, expectedRevision: 25 });
it('appends current-state evidence after two stable reads and leaves all historical rows unchanged', async () => {
  const prior = (await pool.query('SELECT * FROM sandbox_listing_runs WHERE id=$1', [runId]))
      .rows[0],
    request = input();
  const result = await service.reconcile(request);
  expect(result.verified).toBe(true);
  expect(calls).toBe(2);
  expect(
    (await pool.query('SELECT * FROM sandbox_listing_runs WHERE id=$1', [runId])).rows[0],
  ).toEqual(prior);
  expect(await service.reconcile(request)).toEqual(result);
  expect(calls).toBe(2);
});
it('does not resolve raw drift even when the historical projection would hide the changed field', async () => {
  fault = 'standard-drift';
  const result = await service.reconcile(input());
  expect(result.verified).toBe(false);
  expect(result.mismatchedPaths).toContain('fresh_raw_stability');
});
it('rejects CAS drift without appending successful evidence', async () => {
  fault = 'revision';
  await expect(service.reconcile(input())).rejects.toThrow('RECOVERY_RUN_CHANGED');
  expect(
    (await pool.query('SELECT count(*)::int n FROM sandbox_listing_reconciliations')).rows[0].n,
  ).toBe(0);
});
it('does not accept a cover ID change without bound byte proof', async () => {
  raw.item.promotion_image.image_id_list = ['other-cover'];
  expect((await service.reconcile(input())).verified).toBe(false);
});
it('requires historical acknowledgement and completed unknown phase', async () => {
  await pool.query('DELETE FROM sandbox_listing_run_events');
  await expect(service.reconcile(input())).rejects.toThrow('RECOVERY_ACK_REQUIRED');
  expect(calls).toBe(0);
});
async function proof(overrides: Record<string, unknown> = {}) {
  const bytes = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#a729db' },
  })
    .png()
    .toBuffer();
  const entry = await image.prepare({
    id: randomUUID(),
    binding: {
      environment: 'sandbox',
      partnerId: '1232297',
      shopId: '227418363',
      itemId: '803934364',
      operationId: runId,
      role: 'cover',
      position: 0,
      sourceAssetId: 'cover-source',
      outputImageId: 'other-cover',
      ...overrides,
    },
    source: bytes,
    output: bytes,
    expiresAt: '2026-09-14T11:00:00Z',
  });
  raw.item.promotion_image.image_id_list = ['other-cover'];
  cover = {
    sourceImageId: 'cover-source',
    outputImageId: 'other-cover',
    sourceSha256: entry.sourceSha256,
    outputSha256: entry.outputSha256,
  };
  return entry.id;
}
it('resolves only the two cover ID paths using exact bound image evidence and records current connection', async () => {
  const caseId = await proof();
  const result = await service.reconcile({ ...input(), coverCaseId: caseId });
  expect(result.verified).toBe(true);
  expect(result.image?.verificationBasis).toBe('exact_bytes');
  expect(result.connection).toMatchObject({ id: connectionId, revision: 7 });
});
it('a valid image proof cannot conceal unselected price changes', async () => {
  const caseId = await proof();
  raw.models.model[4]!.price_info[0].original_price = 9999;
  const result = await service.reconcile({ ...input(), coverCaseId: caseId });
  expect(result.verified).toBe(false);
  expect(result.mismatchedPaths.some((p) => p.includes('originalPrice'))).toBe(true);
});
it('rejects image proof from a different run', async () => {
  const caseId = await proof({ operationId: randomUUID() });
  const result = await service.reconcile({ ...input(), coverCaseId: caseId });
  expect(result.verified).toBe(false);
  expect(result.mismatchedPaths).toContain('IMAGE_QC_BINDING_CHANGED');
});
it('rejects output bytes changing between the two fresh observations', async () => {
  const caseId = await proof();
  fault = 'cover-bytes';
  const result = await service.reconcile({ ...input(), coverCaseId: caseId });
  expect(result.verified).toBe(false);
  expect(result.mismatchedPaths).toContain('RECOVERY_COVER_OBSERVATION_CHANGED');
});
it('rejects a connection rotating during the observation while allowing historical rotation before it', async () => {
  fault = 'connection';
  await expect(service.reconcile(input())).rejects.toThrow('RECOVERY_CONNECTION_CHANGED');
  expect(
    (await pool.query('SELECT count(*)::int n FROM sandbox_listing_reconciliations')).rows[0].n,
  ).toBe(0);
});
it('bounds a never-resolving readonly observer without appending evidence', async () => {
  const pending = new LegacyListingRecoveryService(repo, image, {
    now,
    requestTimeoutMs: 15,
    observe: () => new Promise(() => {}),
  });
  await expect(pending.reconcile(input())).rejects.toThrow('RECOVERY_READ_TIMEOUT');
  expect(
    (await pool.query('SELECT count(*)::int n FROM sandbox_listing_reconciliations')).rows[0].n,
  ).toBe(0);
});
it('keeps appended recovery evidence immutable', async () => {
  const result = await service.reconcile(input());
  await expect(
    pool.query('UPDATE sandbox_listing_reconciliations SET verified=false WHERE id=$1', [
      result.id,
    ]),
  ).rejects.toThrow('LEGACY_LISTING_RECOVERY_IMMUTABLE');
  await expect(
    pool.query('DELETE FROM sandbox_listing_reconciliations WHERE id=$1', [result.id]),
  ).rejects.toThrow('LEGACY_LISTING_RECOVERY_IMMUTABLE');
});
it('prevents the old reconcile endpoint from changing an already-reconciled historical run', async () => {
  const result = await service.reconcile(input());
  expect(result.verified).toBe(true);
  const before = (
    await pool.query('SELECT to_jsonb(r) AS row FROM sandbox_listing_runs r WHERE id=$1', [runId])
  ).rows[0].row;
  let requests = 0;
  const legacy = new SandboxListingService(repo, new BlobStore('.local/test-legacy-recovery'), {
    transport: async () => {
      requests++;
      throw Error('NETWORK_FORBIDDEN');
    },
  });
  await expect(legacy.reconcile({ id: runId, expectedRevision: before.revision })).rejects.toThrow(
    'SANDBOX_RUN_ALREADY_RECONCILED',
  );
  expect(requests).toBe(0);
  expect(
    (await pool.query('SELECT to_jsonb(r) AS row FROM sandbox_listing_runs r WHERE id=$1', [runId]))
      .rows[0].row,
  ).toEqual(before);
});
