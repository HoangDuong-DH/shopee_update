import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { canonicalJson } from '@shopee/domain';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import {
  ProductionExecutionPolicyService,
  assertExecutionPolicySource,
} from '../../apps/api/src/production-execution-policy.js';

const schema = 'test_execution_policy_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
  max: 10,
});
const repo = new Repository(pool);
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function fixture() {
  const preparationId = randomUUID(),
    body = { entries: [{ title: 'Nguồn cũ nguyên vẹn' }] },
    fingerprint = digest(body);
  const batches = [randomUUID(), randomUUID()].map((batchId, index) => ({
    batchId,
    manifestSha256: String(index + 1).repeat(64),
  }));
  const manifests = batches.map((batch, index) => ({
    sha256: batch.manifestSha256,
    value: {
      version: 2,
      batchId: batch.batchId,
      preparation: { id: preparationId, fingerprint },
      scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
      authorizationReference: 'Original source approval',
      assets: [],
      listings: [0, 1].map((n) => ({
        sourceKey: `row-${index}-${n}`,
        sourceIdentity: preparationId + `-source-${index}-${n}`,
        sourceRevision: 1,
        document: {
          title: ['Hương Thảo', 'Hoa Hồng', 'Hoa Lài', 'Cam Sả'][index * 2 + n],
          models: [],
          tierNames: [],
        },
      })),
    },
  }));
  const statuses = manifests.map((m) => ({
    batchId: m.value.batchId,
    manifestSha256: m.sha256,
    statusFingerprint: 'a'.repeat(64),
    busy: false,
    interrupted: false,
    executionEnabled: true,
    listings: m.value.listings.map((s) => ({ sourceKey: s.sourceKey, state: 'not_sent' })),
  }));
  await pool.query(
    'INSERT INTO production_source_preparations(id,request_hash,request,body,fingerprint,registration) VALUES($1,$2,$3,$4,$5,$6)',
    [preparationId, digest({}), {}, body, fingerprint, { batches }],
  );
  await pool.query(
    'INSERT INTO production_preparation_executions(preparation_id,fingerprint,body) VALUES($1,$2,$3)',
    [preparationId, fingerprint, { state: 'paused' }],
  );
  const batchStatus = vi.fn(async (id: string) => statuses.find((s) => s.batchId === id)!);
  const service = new ProductionExecutionPolicyService(repo, {
    batchStatus,
    loadManifest: async (id) => manifests.find((m) => m.value.batchId === id)!,
  });
  const request = {
    id: randomUUID(),
    expectedFingerprint: fingerprint,
    publicationMode: 'hidden_for_review',
    imageQcPolicy: 'defer_image_qc',
    batches: statuses.map((s) => ({
      batchId: s.batchId,
      expectedStatusFingerprint: s.statusFingerprint,
      sourceKeys: s.listings.map((r) => r.sourceKey),
    })),
  };
  return { service, request, preparationId, body, statuses, manifests, batchStatus };
}
it('converts the exact remaining sources atomically without changing the original preparation or starting work', async () => {
  const f = await fixture(),
    receipt = await f.service.convert(f.preparationId, f.request);
  expect(receipt.batches.flatMap((b) => b.sources)).toHaveLength(4);
  expect(receipt).toMatchObject({
    publicationMode: 'hidden_for_review',
    imageQcPolicy: 'defer_image_qc',
  });
  expect(
    (
      await pool.query('SELECT body FROM production_source_preparations WHERE id=$1', [
        f.preparationId,
      ])
    ).rows[0].body,
  ).toEqual(f.body);
  expect(
    (
      await pool.query(
        'SELECT body FROM production_preparation_executions WHERE preparation_id=$1',
        [f.preparationId],
      )
    ).rows[0].body,
  ).toEqual({ state: 'paused' });
  expect((await pool.query('SELECT * FROM production_pilot_operations')).rows).toHaveLength(0);
  expect(
    await f.service.getForBatch(f.manifests[1]!.value.batchId, f.manifests[1]!.sha256),
  ).toEqual(receipt);
  await expect(
    pool.query('UPDATE production_execution_policies SET body=$2 WHERE id=$1', [receipt.id, {}]),
  ).rejects.toThrow();
  await expect(
    pool.query('DELETE FROM production_execution_policies WHERE id=$1', [receipt.id]),
  ).rejects.toThrow();
});
it('recovers the identical local request after response loss, but rejects a changed request', async () => {
  const f = await fixture(),
    first = await f.service.convert(f.preparationId, f.request);
  f.statuses[0]!.statusFingerprint = 'b'.repeat(64);
  expect(await f.service.convert(f.preparationId, f.request)).toEqual(first);
  expect(f.batchStatus).toHaveBeenCalledTimes(2);
  await expect(
    f.service.convert(f.preparationId, { ...f.request, id: randomUUID() }),
  ).rejects.toThrow('POLICY_CONFLICT');
});
it.each(['stale', 'partial', 'extra', 'busy', 'orphan', 'running', 'unknown'])(
  'blocks %s conversion without saving an override',
  async (kind) => {
    const f = await fixture();
    if (kind === 'stale') f.statuses[0]!.statusFingerprint = 'b'.repeat(64);
    if (kind === 'partial') f.request.batches.pop();
    if (kind === 'extra') f.request.batches[0]!.sourceKeys.push('foreign-source');
    if (kind === 'busy') f.statuses[0]!.busy = true;
    if (kind === 'orphan') f.statuses[0]!.interrupted = true;
    if (kind === 'unknown') f.statuses[0]!.listings[0]!.state = 'unknown';
    if (kind === 'running')
      await pool.query(
        'UPDATE production_preparation_executions SET body=$2 WHERE preparation_id=$1',
        [f.preparationId, { state: 'running' }],
      );
    await expect(f.service.convert(f.preparationId, f.request)).rejects.toThrow();
    expect(await f.service.getForPreparation(f.preparationId)).toBeNull();
  },
);
it('rejects a conversion while the preparation coordinator owns the shared lock', async () => {
  const f = await fixture(),
    client = await pool.connect();
  const key = 'production-preparation-owner:production:2010476:1423724897';
  await client.query("SELECT pg_advisory_lock(hashtextextended(current_schema()||':'||$1,0))", [
    key,
  ]);
  try {
    await expect(f.service.convert(f.preparationId, f.request)).rejects.toThrow(
      'POLICY_IN_PROGRESS',
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended(current_schema()||':'||$1,0))", [
      key,
    ]);
    client.release();
  }
});
it('source assertions reject cross-batch, changed document or foreign operation bindings', async () => {
  const f = await fixture(),
    receipt = await f.service.convert(f.preparationId, f.request),
    batch = receipt.batches[0]!,
    source = batch.sources[0]!;
  const binding = {
    batchId: batch.batchId,
    manifestSha256: batch.manifestSha256,
    sourceIdentity: source.sourceIdentity,
    sourceRevision: 1,
    documentSha256: source.documentSha256,
  };
  expect(assertExecutionPolicySource(receipt, binding)).toEqual(source);
  expect(() =>
    assertExecutionPolicySource(receipt, { ...binding, manifestSha256: 'f'.repeat(64) }),
  ).toThrow();
  expect(() =>
    assertExecutionPolicySource(receipt, { ...binding, documentSha256: 'f'.repeat(64) }),
  ).toThrow();
  expect(() =>
    assertExecutionPolicySource(receipt, { ...binding, sourceIdentity: 'foreign' }),
  ).toThrow();
});
it('binds an existing acknowledged operation without changing it or releasing its lane', async () => {
  const f = await fixture(),
    loaded = f.manifests[0]!,
    source = loaded.value.listings[0]!;
  Object.assign(source.document, {
    cover: {
      importId: randomUUID(),
      sha256: 'd'.repeat(64),
      mime: 'image/png',
      width: 100,
      height: 100,
    },
    gallery: [],
    description: [],
  });
  const connectionId = randomUUID(),
    operationId = randomUUID();
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at) VALUES($1,'production','2010476','1423724897','Policy test','connected',now()+interval '1 hour')",
    [connectionId],
  );
  const batchAuthorization = {
    batchId: loaded.value.batchId,
    manifestSha256: loaded.sha256,
    authorizationReference: loaded.value.authorizationReference,
    sources: loaded.value.listings.map((s) => ({
      sourceIdentity: s.sourceIdentity,
      sourceRevision: s.sourceRevision,
      documentSha256: digest(s.document),
    })),
  };
  const sourcePayload = { document: source.document, batchAuthorization },
    expectedProjection = { status: 'UNLIST' };
  const sourceFingerprint = digest({
    scope: loaded.value.scope,
    sourceIdentity: source.sourceIdentity,
    sourceRevision: 1,
    sourcePayload,
    expectedProjection,
  });
  await pool.query(
    `INSERT INTO production_pilot_operations(id,owner_key,connection_id,connection_revision,source_identity,source_revision,source_payload,source_fingerprint,expected_projection,state,item_id)
    VALUES($1,'production:2010476:1423724897',$2,1,$3,1,$4,$5,$6,'acknowledged','45417908562')`,
    [
      operationId,
      connectionId,
      source.sourceIdentity,
      sourcePayload,
      sourceFingerprint,
      expectedProjection,
    ],
  );
  for (const [index, kind] of ['media', 'create'].entries())
    await pool.query(
      `INSERT INTO production_pilot_steps(id,operation_id,step_key,ordinal,kind,path,payload,media,fingerprint,authorized_revision,state,receipt,outcome_fingerprint,sent_at,recorded_at)
    VALUES($1,$2,$3,$4,$5,$6,'{}',$7,$8,1,'acknowledged','{}',$8,now(),now())`,
      [
        randomUUID(),
        operationId,
        kind === 'media' ? 'media-0' : 'create',
        index + 1,
        kind,
        kind === 'media' ? '/api/v2/media_space/upload_image' : '/api/v2/product/add_item',
        kind === 'media' ? {} : null,
        'a'.repeat(64),
      ],
    );
  await pool.query(
    "INSERT INTO production_pilot_lanes(owner_key,operation_id) VALUES('production:2010476:1423724897',$1)",
    [operationId],
  );
  f.statuses[0]!.listings[0]!.state = 'created_readback_pending';
  const before = (
    await pool.query('SELECT to_jsonb(o) AS body FROM production_pilot_operations o WHERE id=$1', [
      operationId,
    ])
  ).rows[0].body;
  const receipt = await f.service.convert(f.preparationId, f.request),
    bound = receipt.batches[0]!.sources[0]!;
  expect(bound).toMatchObject({ operationId, itemId: '45417908562', sourceFingerprint });
  expect(
    (
      await pool.query(
        'SELECT to_jsonb(o) AS body FROM production_pilot_operations o WHERE id=$1',
        [operationId],
      )
    ).rows[0].body,
  ).toEqual(before);
  expect(
    (
      await pool.query('SELECT operation_id FROM production_pilot_lanes WHERE operation_id=$1', [
        operationId,
      ])
    ).rows,
  ).toHaveLength(1);
  await expect(
    pool.query('DELETE FROM production_pilot_lanes WHERE operation_id=$1', [operationId]),
  ).rejects.toThrow('LANE_NEEDS_VERIFICATION');
  expect(
    (
      await pool.query('SELECT production_execution_policy_matches_operation($1,$2) AS ok', [
        receipt.id,
        operationId,
      ])
    ).rows[0].ok,
  ).toBe(true);
  expect(
    (
      await pool.query('SELECT production_execution_policy_matches_operation($1,$2) AS ok', [
        randomUUID(),
        operationId,
      ])
    ).rows[0].ok,
  ).toBe(false);
  expect(
    (
      await pool.query('SELECT production_execution_policy_matches_operation($1,$2) AS ok', [
        receipt.id,
        randomUUID(),
      ])
    ).rows[0].ok,
  ).toBe(false);
  const binding = {
    batchId: loaded.value.batchId,
    manifestSha256: loaded.sha256,
    sourceIdentity: bound.sourceIdentity,
    sourceRevision: 1,
    documentSha256: bound.documentSha256,
    operationId,
    itemId: '45417908562',
    sourceFingerprint,
  };
  expect(assertExecutionPolicySource(receipt, binding)).toEqual(bound);
  expect(() =>
    assertExecutionPolicySource(receipt, { ...binding, operationId: randomUUID() }),
  ).toThrow('SOURCE_MISMATCH');
  expect(() =>
    assertExecutionPolicySource(receipt, { ...binding, sourceFingerprint: 'f'.repeat(64) }),
  ).toThrow('SOURCE_MISMATCH');
});
