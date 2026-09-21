import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import {
  ProductionPilotJournal,
  type ProductionPilotReadback,
} from '../../apps/api/src/production-pilot-journal.js';
import {
  ProductionPilotPublicationJournal,
  inspectProductionPilotPublicationAcknowledgement,
  type ProductionPilotPublicationMetadata,
} from '../../apps/api/src/production-pilot-publication-journal.js';

const schema = 'test_prod_publication_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
it('accepts distinct authorized revisions of one source but never repeats an identity/revision pair', () => {
  const allowedSources = [
    { sourceIdentity: 'versioned-source', sourceRevision: 2 },
    { sourceIdentity: 'versioned-source', sourceRevision: 3 },
  ];
  expect(() => new ProductionPilotPublicationJournal(repo, { allowedSources })).not.toThrow();
  expect(
    () =>
      new ProductionPilotPublicationJournal(repo, {
        allowedSources: [allowedSources[0]!, allowedSources[0]!],
      }),
  ).toThrow('SOURCE_ALLOWLIST_INVALID');
});
it('bounds revision history per source separately from the number of distinct production listings', () => {
  const allowedSources = [2, 3, 4].map((sourceRevision) => ({
    sourceIdentity: 'source-row2',
    sourceRevision,
  }));
  allowedSources.push({ sourceIdentity: 'source-row65', sourceRevision: 4 });
  expect(() => new ProductionPilotPublicationJournal(repo, { allowedSources })).not.toThrow();
  expect(
    () =>
      new ProductionPilotPublicationJournal(repo, {
        allowedSources: [...allowedSources, { sourceIdentity: 'source-row2', sourceRevision: 5 }],
      }),
  ).toThrow('SOURCE_ALLOWLIST_INVALID');
  expect(
    () =>
      new ProductionPilotPublicationJournal(repo, {
        allowedSources: [
          ...allowedSources,
          { sourceIdentity: 'source-third', sourceRevision: 4 },
          { sourceIdentity: 'source-fourth', sourceRevision: 4 },
        ],
      }),
  ).toThrow('SOURCE_ALLOWLIST_INVALID');
});
const sources = [
  { sourceIdentity: 'publication-a', sourceRevision: 2 },
  { sourceIdentity: 'publication-b', sourceRevision: 2 },
];
let journal: ProductionPilotPublicationJournal,
  createJournal: ProductionPilotJournal,
  connectionId: string;
const pause = () => new Promise((resolve) => setTimeout(resolve, 4));
const desired = {
  status: 'UNLIST',
  title: 'Untouched source title',
  models: [{ sku: 'SKU-A', stock: 100, originalPrice: '235998' }],
};
function raw(itemId: string, status = 'UNLIST') {
  return {
    base: {
      error: '',
      request_id: randomUUID(),
      response: {
        item_list: [
          {
            item_id: Number(itemId),
            has_model: true,
            item_status: status,
            item_name: desired.title,
            protected: { content: ['keep'], flag: true },
          },
        ],
      },
    },
    models: {
      error: '',
      request_id: randomUUID(),
      response: {
        tier_variation: [{ name: 'Dung tích', option_list: [{ option: '100ml' }] }],
        model: [
          {
            model_id: 987654,
            model_sku: 'SKU-A',
            tier_index: [0],
            price_info: [{ original_price: 235998 }],
            weight: '0.1309',
            stock_info_v2: { seller_stock: [{ stock: 100 }] },
          },
        ],
      },
    },
  };
}
async function reads(
  itemId = '123456789',
  status = 'UNLIST',
  revision = 1,
): Promise<ProductionPilotReadback[]> {
  const result: ProductionPilotReadback[] = [];
  for (let i = 0; i < 2; i++) {
    await pause();
    const body = raw(itemId, status);
    result.push({
      shopId: '1423724897',
      partnerId: '2010476',
      itemId,
      connectionRevision: revision,
      observedAt: new Date().toISOString(),
      requestIds: [body.base.request_id, body.models.request_id],
      raw: body,
      projection: { ...structuredClone(desired), status },
    });
  }
  return result;
}
async function created(sourceIdentity = 'publication-a', itemId = '123456789') {
  const prepared = await createJournal.authorizeOperation({
    sourceIdentity,
    sourceRevision: 2,
    connectionId,
    expectedConnectionRevision: 1,
    sourcePayload: {
      metadata: { expiresAt: new Date(Date.now() + 600000).toISOString() },
      document: { original: 'source unchanged', categoryId: '101128' },
    },
    expectedProjection: desired,
  });
  const step = await createJournal.authorizeWrite({
    operationId: prepared.operation.id,
    expectedRevision: prepared.operation.revision,
    stepKey: 'create',
    kind: 'create',
    payload: {
      item_sku: sourceIdentity,
      item_name: desired.title,
      category_id: 101128,
      item_status: 'UNLIST',
    },
  });
  await createJournal.markSent({
    operationId: prepared.operation.id,
    stepId: step.step.id,
    path: step.step.path,
    fingerprint: step.step.fingerprint,
  });
  const ack = await createJournal.recordOutcome({
    operationId: prepared.operation.id,
    expectedRevision: 3,
    stepId: step.step.id,
    result: { kind: 'success', requestId: randomUUID(), response: { item_id: Number(itemId) } },
  });
  return createJournal.recordVerification({
    operationId: prepared.operation.id,
    expectedRevision: ack.operation.revision,
    phase: 'created_unlisted',
    readbacks: await reads(itemId),
  });
}
async function authorize(createOperationId: string, readbacks?: ProductionPilotReadback[]) {
  const proof = readbacks ?? (await reads()),
    preflightExpiresAt = new Date(Date.now() + 600000).toISOString();
  return journal.authorizePublication({
    createOperationId,
    connectionId,
    expectedConnectionRevision: 1,
    preflightExpiresAt,
    metadata: metadata(preflightExpiresAt, proof),
    readbacks: proof,
  });
}
function metadata(
  expiresAt: string,
  proof: ProductionPilotReadback[],
): ProductionPilotPublicationMetadata {
  return {
    environment: 'production',
    partnerId: '2010476',
    shopId: '1423724897',
    connectionRevision: 1,
    categoryId: '101128',
    observedAt: new Date(Date.parse(proof[0]!.observedAt) - 1).toISOString(),
    expiresAt,
    requestIds: ['metadata-fixture'],
  };
}
const intent = (view: any) => ({
  operationId: view.operation.id,
  stepId: view.operation.id,
  path: view.operation.path,
  fingerprint: view.operation.fingerprint,
});
const acknowledgement = (itemId = 123456789) => ({
  kind: 'success' as const,
  requestId: randomUUID(),
  response: { success_list: [{ item_id: itemId, unlist: false }], failure_list: [] },
});

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE production_pilot_qc_wait_receipts,production_pilot_deferred_image_verifications,production_pilot_rejection_closures,production_pilot_publication_verifications,production_pilot_publications,production_pilot_verifications,production_pilot_lanes,production_pilot_steps,production_pilot_operations',
  );
  await pool.query('DELETE FROM connections');
  connectionId = randomUUID();
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at) VALUES($1,'production','2010476','1423724897','Publication fixture','connected',now()+interval '1 hour')",
    [connectionId],
  );
  createJournal = new ProductionPilotJournal(repo, { allowedSources: sources });
  journal = new ProductionPilotPublicationJournal(repo, { allowedSources: sources });
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

it('binds the one-item publication intent to the immutable verified create and deduplicates restart lookup', async () => {
  const source = await created(),
    before = JSON.stringify(await createJournal.get(source.operation.id));
  const proof = await reads(),
    first = await authorize(source.operation.id, proof),
    second = await authorize(source.operation.id, proof);
  expect(first.operation.id).toBe(second.operation.id);
  expect((await journal.getForCreate(source.operation.id))!.operation.id).toBe(first.operation.id);
  expect(first.operation.payload).toEqual({ item_list: [{ item_id: 123456789, unlist: false }] });
  expect(first.operation.state).toBe('authorized');
  expect(JSON.stringify(await createJournal.get(source.operation.id))).toBe(before);
  expect((await pool.query('SELECT * FROM jobs')).rows).toHaveLength(0);
});
it('does not accept arbitrary old item IDs, unverified creates, wrong sources or changed shop scope', async () => {
  await expect(authorize(randomUUID())).rejects.toThrow();
  const source = await created();
  journal = new ProductionPilotPublicationJournal(repo, {
    allowedSources: [{ sourceIdentity: 'other-source', sourceRevision: 2 }],
  });
  await expect(authorize(source.operation.id)).rejects.toThrow('SOURCE_FORBIDDEN');
  journal = new ProductionPilotPublicationJournal(repo, { allowedSources: sources });
  await pool.query("UPDATE connections SET shop_id='227418363' WHERE id=$1", [connectionId]);
  await expect(authorize(source.operation.id)).rejects.toThrow('SCOPE_FORBIDDEN');
});
it('rejects changed raw source fields even when the caller projection still claims a match', async () => {
  const source = await created(),
    proof = await reads();
  (proof[0]!.raw as any).models.response.model[0].stock_info_v2.seller_stock[0].stock = 99;
  await expect(authorize(source.operation.id, proof)).rejects.toThrow('READBACK_MISMATCH');
  expect(await journal.getForCreate(source.operation.id)).toBeNull();
});
it('rejects a create that has not received its immutable UNLIST verification', async () => {
  const pending = await createJournal.authorizeOperation({
    ...sources[0]!,
    connectionId,
    expectedConnectionRevision: 1,
    sourcePayload: { document: { categoryId: '101128' } },
    expectedProjection: desired,
  });
  await expect(authorize(pending.operation.id)).rejects.toThrow('CREATE_UNVERIFIED');
});
it('freezes matching current metadata and rejects another category or connection revision', async () => {
  const source = await created(),
    proof = await reads(),
    expiresAt = new Date(Date.now() + 600000).toISOString();
  for (const patch of [
    { categoryId: 'other' },
    { connectionRevision: 2 },
    { expiresAt: new Date(Date.now() + 610000).toISOString() },
  ]) {
    await expect(
      journal.authorizePublication({
        createOperationId: source.operation.id,
        connectionId,
        expectedConnectionRevision: 1,
        preflightExpiresAt: expiresAt,
        metadata: { ...metadata(expiresAt, proof), ...patch },
        readbacks: proof,
      }),
    ).rejects.toThrow('METADATA_STALE_OR_MISMATCHED');
  }
  const accepted = await authorize(source.operation.id, proof);
  expect(accepted.operation.preflight_metadata.categoryId).toBe('101128');
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  await expect(journal.markSent(intent(accepted))).rejects.toThrow('CONNECTION_CHANGED');
  expect((await journal.get(accepted.operation.id)).operation.state).toBe('authorized');
});
it('requires fresh distinct scope-bound request IDs and matching API envelope IDs', async () => {
  const source = await created();
  for (const change of [
    (proof: ProductionPilotReadback[]) => {
      proof[1]!.requestIds = [...proof[0]!.requestIds];
    },
    (proof: ProductionPilotReadback[]) => {
      proof[0]!.observedAt = '2020-01-01T00:00:00.000Z';
    },
    (proof: ProductionPilotReadback[]) => {
      proof[1]!.itemId = '999';
    },
    (proof: ProductionPilotReadback[]) => {
      (proof[0]!.raw as any).base.request_id = 'different-request';
    },
  ]) {
    const proof = await reads();
    change(proof);
    await expect(authorize(source.operation.id, proof)).rejects.toThrow();
  }
});
it('claims the exact durable publication only once and refuses a forged payload fingerprint', async () => {
  const source = await created(),
    view = await authorize(source.operation.id);
  expect(await journal.markSent({ ...intent(view), fingerprint: 'f'.repeat(64) })).toBe(false);
  expect(
    (await Promise.all([journal.markSent(intent(view)), journal.markSent(intent(view))])).sort(),
  ).toEqual([false, true]);
  expect((await journal.get(view.operation.id)).operation.state).toBe('sent');
});
it('uses the shared create lane to block another listing during a pending publication', async () => {
  const source = await created();
  await authorize(source.operation.id);
  const other = await createJournal.authorizeOperation({
    ...sources[1]!,
    connectionId,
    expectedConnectionRevision: 1,
    sourcePayload: { metadata: { expiresAt: new Date(Date.now() + 600000).toISOString() } },
    expectedProjection: desired,
  });
  await expect(
    createJournal.authorizeWrite({
      operationId: other.operation.id,
      expectedRevision: 1,
      stepKey: 'create',
      kind: 'create',
      payload: { item_status: 'UNLIST' },
    }),
  ).rejects.toThrow('SHOP_BUSY');
  await expect(pool.query('DELETE FROM production_pilot_lanes')).rejects.toThrow('PUBLICATION');
});
it('keeps an acknowledged publication pending until two NORMAL reads preserve all other raw fields', async () => {
  const source = await created(),
    before = JSON.stringify(await createJournal.get(source.operation.id));
  const view = await authorize(source.operation.id);
  await journal.markSent(intent(view));
  const ack = await journal.recordOutcome({
    operationId: view.operation.id,
    expectedRevision: 2,
    result: acknowledgement(),
  });
  expect(ack.operation.state).toBe('acknowledged');
  const changed = await reads('123456789', 'NORMAL');
  (changed[1]!.raw as any).base.response.item_list[0].protected.flag = false;
  await expect(
    journal.recordVerification({
      operationId: view.operation.id,
      expectedRevision: 3,
      readbacks: changed,
    }),
  ).rejects.toThrow('READBACK_MISMATCH');
  const verified = await journal.recordVerification({
    operationId: view.operation.id,
    expectedRevision: 3,
    readbacks: await reads('123456789', 'NORMAL'),
  });
  expect(verified.operation.state).toBe('verified');
  expect(verified.verification.phase).toBe('published');
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(0);
  expect(JSON.stringify(await createJournal.get(source.operation.id))).toBe(before);
});
it('reconciles an unknown publish only by reads using renewed same-shop credentials without replay', async () => {
  const source = await created(),
    view = await authorize(source.operation.id);
  await journal.markSent(intent(view));
  await journal.recordOutcome({
    operationId: view.operation.id,
    expectedRevision: 2,
    result: { kind: 'unknown', code: 'LOST_RESPONSE' },
  });
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  expect(await journal.markSent(intent(view))).toBe(false);
  const result = await journal.recordVerification({
    operationId: view.operation.id,
    expectedRevision: 3,
    readbacks: await reads('123456789', 'NORMAL', 2),
  });
  expect(result.operation.state).toBe('verified');
  expect(result.operation.receipt.kind).toBe('unknown');
  expect(result.verification.basis).toBe('read_reconciliation');
});
it('never verifies or releases the lane while the publication request is still sent', async () => {
  const source = await created(),
    view = await authorize(source.operation.id);
  await journal.markSent(intent(view));
  await expect(
    journal.recordVerification({
      operationId: view.operation.id,
      expectedRevision: 2,
      readbacks: await reads('123456789', 'NORMAL'),
    }),
  ).rejects.toThrow('RECONCILIATION_REQUIRED');
  expect((await journal.get(view.operation.id)).operation.state).toBe('sent');
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
  await journal.recordOutcome({
    operationId: view.operation.id,
    expectedRevision: 2,
    result: acknowledgement(),
  });
  expect((await journal.get(view.operation.id)).operation.state).toBe('acknowledged');
});
it('persists a successful envelope with incorrect per-item coverage as unknown, not acknowledged', async () => {
  const source = await created(),
    view = await authorize(source.operation.id);
  await journal.markSent(intent(view));
  const result = await journal.recordOutcome({
    operationId: view.operation.id,
    expectedRevision: 2,
    result: acknowledgement(999),
  });
  expect(result.operation.state).toBe('unknown');
  expect(await journal.markSent(intent(view))).toBe(false);
});
it.each(['UNLIST', 'REVIEWING', 'BANNED'])(
  'does not verify a publication while actual status remains %s',
  async (status) => {
    const source = await created(),
      view = await authorize(source.operation.id);
    await journal.markSent(intent(view));
    await journal.recordOutcome({
      operationId: view.operation.id,
      expectedRevision: 2,
      result: acknowledgement(),
    });
    const proof = await reads('123456789', status);
    for (const read of proof) read.projection.status = 'NORMAL';
    await expect(
      journal.recordVerification({
        operationId: view.operation.id,
        expectedRevision: 3,
        readbacks: proof,
      }),
    ).rejects.toThrow('READBACK_MISMATCH');
    expect((await journal.get(view.operation.id)).operation.state).toBe('acknowledged');
  },
);
it('enforces expiry after acquiring the transaction lock before granting a send', async () => {
  const source = await created(),
    proof = await reads();
  const preflightExpiresAt = new Date(Date.now() + 500).toISOString();
  const view = await journal.authorizePublication({
    createOperationId: source.operation.id,
    connectionId,
    expectedConnectionRevision: 1,
    preflightExpiresAt,
    metadata: metadata(preflightExpiresAt, proof),
    readbacks: proof,
  });
  const lock = await pool.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'production-pilot:production:2010476:1423724897',
  ]);
  const pending = journal.markSent(intent(view));
  await new Promise((resolve) => setTimeout(resolve, 600));
  await lock.query('COMMIT');
  lock.release();
  await expect(pending).rejects.toThrow('PREFLIGHT_EXPIRED');
  expect((await journal.get(view.operation.id)).operation.state).toBe('authorized');
});
it('rejects direct source/receipt mutation and replay even after a process restart', async () => {
  const source = await created(),
    view = await authorize(source.operation.id);
  await expect(
    pool.query(
      "UPDATE production_pilot_publications SET payload='{}',revision=revision+1 WHERE id=$1",
      [view.operation.id],
    ),
  ).rejects.toThrow('IMMUTABLE');
  await journal.markSent(intent(view));
  await journal.recordOutcome({
    operationId: view.operation.id,
    expectedRevision: 2,
    result: acknowledgement(),
  });
  journal = new ProductionPilotPublicationJournal(repo, { allowedSources: sources });
  expect(await journal.markSent(intent(view))).toBe(false);
  await expect(
    pool.query(
      "UPDATE production_pilot_publications SET state='authorized',revision=revision+1 WHERE id=$1",
      [view.operation.id],
    ),
  ).rejects.toThrow();
});

it.each([
  [{ success_list: [{ item_id: '123456789', unlist: false }], failure_list: [] }, 'acknowledged'],
  [
    { success_list: [], failure_list: [{ item_id: 123456789, failed_reason: 'Rejected' }] },
    'rejected',
  ],
  [{ success_list: [{ item_id: 123456789, unlist: true }], failure_list: [] }, 'unknown'],
  [{ success_list: [{ item_id: 123456789, unlist: false }] }, 'unknown'],
  [
    {
      success_list: [
        { item_id: 123456789, unlist: false },
        { item_id: 123456789, unlist: false },
      ],
      failure_list: [],
    },
    'unknown',
  ],
  [
    { success_list: [{ item_id: 123456789, unlist: false }], failure_list: [{ item_id: 999 }] },
    'unknown',
  ],
  [{ success_list: [{ item_id: '0123456789', unlist: false }], failure_list: [] }, 'unknown'],
])('decodes exact singleton per-item publication acknowledgement %j', (response, expected) => {
  expect(inspectProductionPilotPublicationAcknowledgement(response, '123456789')).toBe(expected);
});
