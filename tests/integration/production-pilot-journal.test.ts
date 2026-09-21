import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@shopee/domain';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import {
  ProductionPilotJournal,
  type ProductionPilotReadback,
} from '../../apps/api/src/production-pilot-journal.js';
import {
  ProductionPilotTransport,
  productionPilotWriteFingerprint,
  productionPilotUploadFingerprint,
} from '../../packages/shopee/src/production-pilot-transport.js';

const schema = 'test_prod_pilot_journal_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
const sources = [
  { sourceIdentity: 'listing-a', sourceRevision: 1 },
  { sourceIdentity: 'listing-b', sourceRevision: 1 },
  { sourceIdentity: 'listing-c', sourceRevision: 1 },
];
let journal: ProductionPilotJournal, connectionId: string, metadataExpiresAt: string;
const desired = {
  item_status: 'UNLIST',
  item_name: 'Original supplied title',
  models: [{ sku: 'SOURCE-1', price: '2179998', stock: 100 }],
  cover: 'source-sha256',
  gallery: ['original-gallery-sha'],
};
const body = {
  category_id: 301378,
  item_status: 'UNLIST',
  item_name: 'Original supplied title',
  item_sku: 'SOURCE-1',
  original_price: 2179998,
  normal_stock: 100,
};
const whitelistMessage =
  'Parameter is not match the constraints, . : You are not in the whitelist to add images in description, can only upload plain text';
const whitelistDebug =
  'violated parameter constraints : You are not in the whitelist to add images in description, can only upload plain text';
const forceEnableDebug =
  'Failed to create product : validation: [Rule Type: logistics.channel.force_enable_forbid_disable, Detail: {"code":1326,"msg":"cannot disable a force-enabled channel"}] ';
const sourceDocument = {
  sourceKey: 'SOURCE-1',
  title: body.item_name,
  models: [{ sku: 'MODEL-1' }],
};
async function forceEnableRejected(
  op?: any,
  envelopePatch: Record<string, unknown> = {},
  requestPatch: Record<string, unknown> = {},
) {
  op ??= await prepare('listing-a', {
    sourcePayload: { metadata: { expiresAt: metadataExpiresAt }, document: sourceDocument },
  });
  const step = await journal.authorizeWrite({
    operationId: op.operation.id,
    expectedRevision: op.operation.revision,
    stepKey: 'create',
    kind: 'create',
    payload: {
      ...body,
      description_type: 'normal',
      description: 'Original plain text',
      logistic_info: [{ enabled: true, logistic_id: 5001 }],
      ...requestPatch,
    },
  });
  expect(await journal.markSent(intent(step))).toBe(true);
  return journal.recordOutcome({
    operationId: op.operation.id,
    stepId: step.step.id,
    expectedRevision: step.operation.revision + 1,
    result: {
      kind: 'rejected',
      code: 'product.error_busi',
      requestId: 'force-enable-rejected',
      envelope: {
        error: 'product.error_busi',
        message: 'Invalid product setting. Please verify.',
        warning: '',
        request_id: 'force-enable-rejected',
        debug_message: forceEnableDebug,
        ...envelopePatch,
      },
    },
  });
}
async function rejectedCreate(
  patch: Record<string, unknown> = {},
  mediaCount = 0,
  requestPatch: Record<string, unknown> = {},
) {
  let op = await prepare('listing-a', {
    sourcePayload: {
      metadata: { expiresAt: metadataExpiresAt },
      document: { sourceKey: 'SOURCE-1', title: body.item_name, models: [{ sku: 'MODEL-1' }] },
    },
  });
  for (let index = 0; index < mediaCount; index++) {
    const media = await journal.authorizeMedia({
      operationId: op.operation.id,
      expectedRevision: op.operation.revision,
      stepKey: `media-${index}`,
      sourceAssetIdentity: `original-page-${index}`,
      bytes: new Uint8Array([137, 80, 78, 71, index]),
      mime: 'image/png',
      options: { scene: 'normal', ratio: '3:4' },
    });
    expect(await journal.markSent(intent(media))).toBe(true);
    op = await journal.recordOutcome({
      operationId: op.operation.id,
      stepId: media.step.id,
      expectedRevision: media.operation.revision + 1,
      result: {
        kind: 'success',
        requestId: `media-ack-${index}`,
        response: { image_id: `image-${index}` },
      },
    });
  }
  const step = await journal.authorizeWrite({
    operationId: op.operation.id,
    expectedRevision: op.operation.revision,
    stepKey: 'create',
    kind: 'create',
    payload: {
      ...body,
      description_type: 'extended',
      description_info: {
        extended_description: {
          field_list: [{ field_type: 'image', image_info: { image_id: 'original-image' } }],
        },
      },
      ...requestPatch,
    },
  });
  expect(await journal.markSent(intent(step))).toBe(true);
  return journal.recordOutcome({
    operationId: op.operation.id,
    stepId: step.step.id,
    expectedRevision: step.operation.revision + 1,
    result: {
      kind: 'rejected',
      code: 'product.error_param',
      requestId: 'definitive-denial',
      envelope: {
        error: 'product.error_param',
        message: whitelistMessage,
        debug_message: whitelistDebug,
        request_id: 'definitive-denial',
        warning: '',
        ...patch,
      },
    },
  });
}
async function inventoryScans() {
  const result: any[] = [];
  for (let i = 0; i < 2; i++) {
    await pause();
    const pages = ['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING'].map((status) => ({
      request: { offset: 0, page_size: 100, item_status: status },
      envelope: {
        error: '',
        request_id: `scan-${i}-${status}`,
        response: {
          item: status === 'NORMAL' ? [{ item_id: 81, item_status: status }] : [],
          total_count: status === 'NORMAL' ? 1 : 0,
          has_next_page: false,
          next_offset: 0,
        },
      },
    }));
    const baseInfo = [
      {
        error: '',
        request_id: `scan-${i}-base`,
        response: {
          item_list: [
            {
              item_id: 81,
              item_status: 'NORMAL',
              item_sku: 'OLD-SKU',
              item_name: 'Old unrelated title',
              has_model: true,
            },
          ],
        },
      },
    ];
    const modelLists = [
      {
        itemId: '81',
        envelope: {
          error: '',
          request_id: `scan-${i}-models`,
          response: { model: [{ model_id: 91, model_sku: 'OLD-MODEL' }] },
        },
      },
    ];
    result.push({
      environment: 'production',
      partnerId: '2010476',
      shopId: '1423724897',
      connectionRevision: 1,
      observedAt: new Date().toISOString(),
      requestIds: [
        ...pages.map((p) => p.envelope.request_id),
        baseInfo[0]!.request_id,
        modelLists[0]!.envelope.request_id,
      ],
      pages,
      baseInfo,
      modelLists,
    });
  }
  return result;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 4));
const prepare = (sourceIdentity = 'listing-a', patch: Record<string, unknown> = {}) =>
  journal.authorizeOperation({
    sourceIdentity,
    sourceRevision: 1,
    connectionId,
    expectedConnectionRevision: 1,
    sourcePayload: {
      metadata: { expiresAt: metadataExpiresAt },
      originalWord: 'unchanged',
      sourcePrice: '2179998',
      stockInstruction: { quantity: 100, source: 'user pilot instruction' },
    },
    expectedProjection: desired,
    ...patch,
  });
const createStep = async (operationId: string, expectedRevision = 1) =>
  journal.authorizeWrite({
    operationId,
    expectedRevision,
    stepKey: 'create',
    kind: 'create',
    payload: body,
  });
const intent = (view: any) => ({
  operationId: view.operation.id,
  stepId: view.step.id,
  path: view.step.path,
  fingerprint: view.step.fingerprint,
});
async function createAcknowledged() {
  const op = await prepare(),
    step = await createStep(op.operation.id);
  expect(await journal.markSent(intent(step))).toBe(true);
  return journal.recordOutcome({
    operationId: op.operation.id,
    stepId: step.step.id,
    expectedRevision: 3,
    result: { kind: 'success', response: { item_id: 123456789 }, requestId: 'create-ack' },
  });
}
async function readbacks(): Promise<ProductionPilotReadback[]> {
  await pause();
  const first = new Date().toISOString();
  await pause();
  const second = new Date().toISOString();
  return [first, second].map((observedAt, index) => ({
    shopId: '1423724897',
    partnerId: '2010476',
    itemId: '123456789',
    connectionRevision: 1,
    observedAt,
    requestIds: ['base-read-' + index, 'models-read-' + index],
    raw: {
      item_id: 123456789,
      item_status: 'UNLIST',
      item_name: 'Original supplied title',
      models: [{ model_sku: 'SOURCE-1' }],
    },
    projection: structuredClone(desired),
  }));
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
beforeEach(async () => {
  metadataExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await pool.query(
    'TRUNCATE production_pilot_qc_wait_receipts,production_pilot_deferred_image_verifications,production_pilot_rejection_closures,production_pilot_publication_verifications,production_pilot_publications,production_pilot_verifications,production_pilot_lanes,production_pilot_steps,production_pilot_operations',
  );
  await pool.query('DELETE FROM connections');
  connectionId = randomUUID();
  await pool.query(
    `INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at)
    VALUES($1,'production','2010476','1423724897','Protected production fixture','connected',now()+interval '1 hour')`,
    [connectionId],
  );
  journal = new ProductionPilotJournal(repo, { allowedSources: sources });
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

it('snapshots source server-side, deduplicates by identity/revision and never creates jobs', async () => {
  const [a, b] = await Promise.all([prepare(), prepare()]);
  expect(a.operation.id).toBe(b.operation.id);
  expect(a.operation.source_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(a.operation.state).toBe('authorized');
  expect(a.steps).toHaveLength(0);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(0);
  expect((await pool.query('SELECT * FROM jobs')).rows).toHaveLength(0);
  expect((await pool.query('SELECT * FROM outbox')).rows).toHaveLength(0);
  await expect(
    prepare('listing-a', { sourcePayload: { originalWord: 'changed' } }),
  ).rejects.toThrow('SOURCE_ALREADY_RESERVED');
});

const batchSource = (index: number) => ({ sourceIdentity: 'new-batch-' + index, sourceRevision: 1 });
const batchDocument = (index: number) => ({ sourceKey: 'new-batch-' + index, title: 'Original ' + index });
const batchAuthorization = () => ({ batchId: randomUUID(), manifestSha256: 'a'.repeat(64),
  authorizationReference: 'User explicitly authorized these four fixture sources',
  sources: [0, 1, 2, 3].map(index => ({ ...batchSource(index), documentSha256:
    createHash('sha256').update(canonicalJson(batchDocument(index))).digest('hex') })) });
const prepareBatch = (instance: ProductionPilotJournal, index: number) => instance.authorizeOperation({
  ...batchSource(index), connectionId, expectedConnectionRevision: 1,
  sourcePayload: { document: batchDocument(index), metadata: { expiresAt: metadataExpiresAt } },
  expectedProjection: desired,
});
it('reserves four exact manifest sources independently of legacy history, preserving every old row', async () => {
  for (const source of sources) await prepare(source.sourceIdentity);
  const before = (await pool.query('SELECT * FROM production_pilot_operations ORDER BY id')).rows;
  const authorization = batchAuthorization();
  const instance = new ProductionPilotJournal(repo, { allowedSources: [0, 1, 2, 3].map(batchSource),
    batchAuthorization: authorization } as any);
  for (let index = 0; index < 4; index++) {
    const result = await prepareBatch(instance, index);
    expect(result.operation.source_payload.batchAuthorization).toEqual(authorization);
    expect((await prepareBatch(instance, index)).operation.id).toBe(result.operation.id);
  }
  expect((await pool.query('SELECT * FROM production_pilot_operations WHERE id=ANY($1::uuid[]) ORDER BY id',
    [before.map(row => row.id)])).rows).toEqual(before);
  expect((await pool.query('SELECT * FROM production_pilot_operations')).rows).toHaveLength(7);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(0);
  await expect(prepareBatch(instance, 4)).rejects.toThrow('SOURCE_FORBIDDEN');
});
it('pins batch authorization across independent one-source coordinators and rejects widening/rebinding', async () => {
  const authorization = batchAuthorization();
  const first = new ProductionPilotJournal(repo, { allowedSources: [batchSource(0)], batchAuthorization: authorization } as any);
  const saved = await prepareBatch(first, 0);
  const second = new ProductionPilotJournal(repo, { allowedSources: [batchSource(1)], batchAuthorization: authorization } as any);
  await prepareBatch(second, 1);
  const changed = new ProductionPilotJournal(repo, { allowedSources: [batchSource(2)], batchAuthorization:
    { ...authorization, manifestSha256: 'b'.repeat(64) } } as any);
  await expect(prepareBatch(changed, 2)).rejects.toThrow('BATCH_AUTHORIZATION_CHANGED');
  const reopen = new ProductionPilotJournal(repo, { allowedSources: [batchSource(0)], batchAuthorization:
    { ...authorization, manifestSha256: 'b'.repeat(64) } } as any);
  await expect(reopen.get(saved.operation.id)).rejects.toThrow('BATCH_AUTHORIZATION_CHANGED');
  const legacy = new ProductionPilotJournal(repo, { allowedSources: [batchSource(0)] });
  await expect(legacy.get(saved.operation.id)).rejects.toThrow('BATCH_AUTHORIZATION_CHANGED');
});
it('blocks altered documents, caller-injected proof, fifth identities and sources outside the manifest before persistence', async () => {
  const authorization = batchAuthorization();
  expect(() => new ProductionPilotJournal(repo, { allowedSources: [batchSource(4)], batchAuthorization: authorization } as any))
    .toThrow('SOURCE_ALLOWLIST_INVALID');
  expect(() => new ProductionPilotJournal(repo, { allowedSources: [batchSource(0)], batchAuthorization:
    { ...authorization, sources: [...authorization.sources, { ...batchSource(4), documentSha256: 'c'.repeat(64) }] } } as any))
    .toThrow();
  const instance = new ProductionPilotJournal(repo, { allowedSources: [batchSource(0)], batchAuthorization: authorization } as any);
  await expect(instance.authorizeOperation({ ...batchSource(0), connectionId, expectedConnectionRevision: 1,
    sourcePayload: { document: { ...batchDocument(0), title: 'Changed without manifest' } }, expectedProjection: desired }))
    .rejects.toThrow('BATCH_DOCUMENT_CHANGED');
  await expect(prepare('listing-a', { sourcePayload: { batchAuthorization: authorization } }))
    .rejects.toThrow('BATCH_AUTHORIZATION_CHANGED');
  expect((await pool.query('SELECT * FROM production_pilot_operations')).rows).toHaveLength(0);
});
it('closes only a definitive no-create rejection with two complete inventories, retaining all old rows', async () => {
  const rejected = await rejectedCreate({}, 2);
  const scans = await inventoryScans();
  const closed = await journal.closeRejectedCreate({
    operationId: rejected.operation.id,
    expectedRevision: rejected.operation.revision,
    connectionRevision: 1,
    scans,
  });
  expect(closed.operation).toEqual(rejected.operation);
  expect(closed.steps).toEqual(rejected.steps);
  expect(closed.rejectionClosure.operation_id).toBe(rejected.operation.id);
  expect(closed.rejectionClosure.scans).toEqual(scans);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(0);
  await expect(pool.query('DELETE FROM production_pilot_rejection_closures')).rejects.toThrow();
  await expect(
    pool.query("UPDATE production_pilot_rejection_closures SET scans='[]'"),
  ).rejects.toThrow();
  expect(
    (
      await journal.closeRejectedCreate({
        operationId: rejected.operation.id,
        expectedRevision: rejected.operation.revision,
        connectionRevision: 1,
        scans,
      })
    ).rejectionClosure.id,
  ).toBe(closed.rejectionClosure.id);
});
it('requires the rejected immutable request to have actually attempted description images', async () => {
  const rejected = await rejectedCreate({}, 0, {
    description_type: 'normal',
    description: 'Plain text',
  });
  await expect(
    journal.closeRejectedCreate({
      operationId: rejected.operation.id,
      expectedRevision: rejected.operation.revision,
      connectionRevision: 1,
      scans: await inventoryScans(),
    }),
  ).rejects.toThrow('REJECTION_NOT_DEFINITIVE');
});
it('follows every pagination cursor and accepts complete base coverage of items without models', async () => {
  const rejected = await rejectedCreate(),
    scans = await inventoryScans();
  for (const [index, scan] of scans.entries()) {
    scan.pages[0].request.page_size = 1;
    Object.assign(scan.pages[0].envelope.response, {
      total_count: 2,
      has_next_page: true,
      next_offset: 1,
    });
    const next = {
      request: { offset: 1, page_size: 1, item_status: 'NORMAL' },
      envelope: {
        error: '',
        request_id: `scan-${index}-normal-next`,
        response: {
          total_count: 2,
          has_next_page: false,
          item: [{ item_id: 82, item_status: 'NORMAL' }],
        },
      },
    };
    scan.pages.splice(1, 0, next);
    scan.requestIds.push(next.envelope.request_id);
    scan.baseInfo[0].response.item_list.push({
      item_id: 82,
      item_status: 'NORMAL',
      has_model: false,
      item_sku: '',
      item_name: 'Another old item',
    });
  }
  expect(
    (
      await journal.closeRejectedCreate({
        operationId: rejected.operation.id,
        expectedRevision: rejected.operation.revision,
        connectionRevision: 1,
        scans,
      })
    ).rejectionClosure,
  ).not.toBeNull();
});
it('requires explicit proven supersession for a higher source revision without replaying the rejected create', async () => {
  const rejected = await rejectedCreate();
  journal = new ProductionPilotJournal(repo, {
    allowedSources: [sources[0]!, { sourceIdentity: 'listing-a', sourceRevision: 2 }, sources[1]!],
  });
  const next = {
    sourceRevision: 2,
    supersedesOperationId: rejected.operation.id,
    sourcePayload: {
      metadata: { expiresAt: metadataExpiresAt },
      description: 'User authorized plain text',
    },
  };
  await expect(prepare('listing-a', next)).rejects.toThrow('SUPERSESSION_UNPROVEN');
  await journal.closeRejectedCreate({
    operationId: rejected.operation.id,
    expectedRevision: rejected.operation.revision,
    connectionRevision: 1,
    scans: await inventoryScans(),
  });
  await expect(prepare('listing-a', { ...next, supersedesOperationId: undefined })).rejects.toThrow(
    'SOURCE_ALREADY_RESERVED',
  );
  const [a, b] = await Promise.all([prepare('listing-a', next), prepare('listing-a', next)]);
  expect(a.operation.id).toBe(b.operation.id);
  expect(a.operation.supersedes_operation_id).toBe(rejected.operation.id);
  expect(a.operation.source_payload.supersedesOperationId).toBe(rejected.operation.id);
  expect(a.operation.state).toBe('authorized');
  expect((await journal.get(rejected.operation.id)).operation).toEqual(rejected.operation);
  await expect(
    journal.authorizeWrite({
      operationId: rejected.operation.id,
      expectedRevision: rejected.operation.revision,
      stepKey: 'retry-create',
      kind: 'create',
      payload: body,
    }),
  ).rejects.toThrow('RECONCILIATION_REQUIRED');
});
it('closes only the exact force-enable validation rejection, including an omitted required channel', async () => {
  const rejected = await forceEnableRejected();
  const closed = await journal.closeRejectedCreate({
    operationId: rejected.operation.id,
    expectedRevision: rejected.operation.revision,
    connectionRevision: 1,
    scans: await inventoryScans(),
  });
  expect(closed.operation).toEqual(rejected.operation);
  expect(closed.steps).toEqual(rejected.steps);
  expect(closed.rejectionClosure.rejected_request.logistic_info).toEqual([
    { enabled: true, logistic_id: 5001 },
  ]);
  expect(closed.rejectionClosure.rejected_receipt.envelope.debug_message).toBe(forceEnableDebug);
});
it.each([
  { debug_message: forceEnableDebug.replace('1326', '9999') },
  { debug_message: forceEnableDebug.replace('force_enable_forbid_disable', 'another_rule') },
  { debug_message: 'Failed to create product : unknown' },
  { message: 'Another product error' },
  { warning: 'Partial result' },
  { response: { item_id: 12345 } },
  { request_id: 'another-request' },
])('does not treat an unproven logistics rejection as safe to supersede: %j', async (patch) => {
  const rejected = await forceEnableRejected(undefined, patch);
  await expect(
    journal.closeRejectedCreate({
      operationId: rejected.operation.id,
      expectedRevision: rejected.operation.revision,
      connectionRevision: 1,
      scans: await inventoryScans(),
    }),
  ).rejects.toThrow('REJECTION_NOT_DEFINITIVE');
  expect((await journal.get(rejected.operation.id)).rejectionClosure).toBeNull();
});
it.each([
  { logistic_info: [] },
  { logistic_info: [{ logistic_id: 5001, enabled: 'true' }] },
  {
    logistic_info: [
      { logistic_id: 5001, enabled: true },
      { logistic_id: 5001, enabled: false },
    ],
  },
])('requires the exact rejected logistics request to be well formed: %j', async (patch) => {
  const rejected = await forceEnableRejected(undefined, {}, patch);
  await expect(
    journal.closeRejectedCreate({
      operationId: rejected.operation.id,
      expectedRevision: rejected.operation.revision,
      connectionRevision: 1,
      scans: await inventoryScans(),
    }),
  ).rejects.toThrow('REJECTION_NOT_DEFINITIVE');
});
it('caps explicit identity and revision tuples without allowing duplicates or a fourth source revision', () => {
  expect(
    () => new ProductionPilotJournal(repo, { allowedSources: [sources[0]!, sources[0]!] }),
  ).toThrow('SOURCE_ALLOWLIST_INVALID');
  expect(
    () =>
      new ProductionPilotJournal(repo, {
        allowedSources: [1, 2, 3, 4].map((sourceRevision) => ({
          sourceIdentity: 'listing-a',
          sourceRevision,
        })),
      }),
  ).toThrow('SOURCE_ALLOWLIST_INVALID');
  expect(
    () =>
      new ProductionPilotJournal(repo, {
        allowedSources: ['a', 'b', 'c', 'd'].map((sourceIdentity) => ({
          sourceIdentity,
          sourceRevision: 1,
        })),
      }),
  ).toThrow('SOURCE_ALLOWLIST_INVALID');
});
it('supports bounded explicit source revisions only through the complete closed linear rejection ancestry', async () => {
  journal = new ProductionPilotJournal(repo, {
    allowedSources: [
      sources[0]!,
      { sourceIdentity: 'listing-a', sourceRevision: 2 },
      { sourceIdentity: 'listing-a', sourceRevision: 3 },
      sources[1]!,
    ],
  });
  const first = await rejectedCreate();
  await journal.closeRejectedCreate({
    operationId: first.operation.id,
    expectedRevision: first.operation.revision,
    connectionRevision: 1,
    scans: await inventoryScans(),
  });
  const next = await prepare('listing-a', {
    sourceRevision: 2,
    supersedesOperationId: first.operation.id,
    sourcePayload: {
      metadata: { expiresAt: metadataExpiresAt },
      document: sourceDocument,
      revisionReason: 'User authorized plain text',
    },
  });
  const second = await forceEnableRejected(next);
  const thirdInput = {
    sourceRevision: 3,
    supersedesOperationId: second.operation.id,
    sourcePayload: {
      metadata: { expiresAt: metadataExpiresAt },
      document: sourceDocument,
      revisionReason: 'Explicit new channel source',
    },
  };
  await expect(prepare('listing-a', thirdInput)).rejects.toThrow('SUPERSESSION_UNPROVEN');
  await journal.closeRejectedCreate({
    operationId: second.operation.id,
    expectedRevision: second.operation.revision,
    connectionRevision: 1,
    scans: await inventoryScans(),
  });
  await expect(
    prepare('listing-a', { ...thirdInput, supersedesOperationId: first.operation.id }),
  ).rejects.toThrow('SUPERSESSION_UNPROVEN');
  const fullJournal = journal;
  journal = new ProductionPilotJournal(repo, {
    allowedSources: [
      { sourceIdentity: 'listing-a', sourceRevision: 2 },
      { sourceIdentity: 'listing-a', sourceRevision: 3 },
    ],
  });
  await expect(prepare('listing-a', thirdInput)).rejects.toThrow('SOURCE_FORBIDDEN');
  journal = fullJournal;
  const third = await prepare('listing-a', thirdInput);
  expect(third.operation.supersedes_operation_id).toBe(second.operation.id);
  expect((await prepare('listing-b')).operation.state).toBe('authorized');
  expect((await pool.query('SELECT * FROM production_pilot_operations')).rows).toHaveLength(4);
  expect((await journal.get(first.operation.id)).operation).toEqual(first.operation);
  expect((await journal.get(second.operation.id)).operation).toEqual(second.operation);
});
it.each([
  [
    'missing status',
    (scans: any[]) => {
      scans[0].pages.pop();
    },
  ],
  [
    'truncated pagination',
    (scans: any[]) => {
      scans[0].pages[0].envelope.response.has_next_page = true;
      scans[0].pages[0].envelope.response.next_offset = 100;
    },
  ],
  [
    'wrong initial offset',
    (scans: any[]) => {
      scans[0].pages[0].request.offset = 100;
    },
  ],
  [
    'partial count',
    (scans: any[]) => {
      scans[0].pages[0].envelope.response.total_count = 2;
    },
  ],
  [
    'empty null array',
    (scans: any[]) => {
      scans[0].pages[1].envelope.response.item = null;
    },
  ],
  [
    'missing base item',
    (scans: any[]) => {
      scans[0].baseInfo = [];
    },
  ],
  [
    'base identity mismatch',
    (scans: any[]) => {
      scans[0].baseInfo[0].response.item_list[0].item_id = 82;
    },
  ],
  [
    'base missing model marker',
    (scans: any[]) => {
      delete scans[0].baseInfo[0].response.item_list[0].has_model;
    },
  ],
  [
    'missing model list',
    (scans: any[]) => {
      scans[0].modelLists = [];
    },
  ],
  [
    'missing model SKU',
    (scans: any[]) => {
      delete scans[0].modelLists[0].envelope.response.model[0].model_sku;
    },
  ],
  [
    'wrong model target',
    (scans: any[]) => {
      scans[0].modelLists[0].itemId = '82';
    },
  ],
  [
    'source item SKU',
    (scans: any[]) => {
      scans[0].baseInfo[0].response.item_list[0].item_sku = 'SOURCE-1';
    },
  ],
  [
    'source title',
    (scans: any[]) => {
      scans[0].baseInfo[0].response.item_list[0].item_name = body.item_name;
    },
  ],
  [
    'source model SKU',
    (scans: any[]) => {
      scans[0].modelLists[0].envelope.response.model[0].model_sku = 'MODEL-1';
    },
  ],
  [
    'empty title',
    (scans: any[]) => {
      scans[0].baseInfo[0].response.item_list[0].item_name = '';
    },
  ],
  [
    'reused request ID',
    (scans: any[]) => {
      scans[1].pages[0].envelope.request_id = scans[0].pages[0].envelope.request_id;
      scans[1].requestIds[0] = scans[0].requestIds[0];
    },
  ],
  [
    'extra claimed request ID',
    (scans: any[]) => {
      scans[0].requestIds.push('not-in-raw');
    },
  ],
  [
    'raw API error',
    (scans: any[]) => {
      scans[0].baseInfo[0].error = 'system_error';
    },
  ],
  [
    'raw API warning',
    (scans: any[]) => {
      scans[0].baseInfo[0].warning = 'partial';
    },
  ],
  [
    'inventory changed',
    (scans: any[]) => {
      scans[1].modelLists[0].envelope.response.model[0].model_sku = 'DIFFERENT-SKU';
    },
  ],
  [
    'wrong connection revision',
    (scans: any[]) => {
      scans[0].connectionRevision = 2;
    },
  ],
  [
    'future timestamp',
    (scans: any[]) => {
      scans[1].observedAt = new Date(Date.now() + 100000).toISOString();
    },
  ],
  [
    'old timestamp',
    (scans: any[]) => {
      scans[0].observedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    },
  ],
  [
    'same timestamp',
    (scans: any[]) => {
      scans[1].observedAt = scans[0].observedAt;
    },
  ],
  [
    'wrong shop',
    (scans: any[]) => {
      scans[0].shopId = '227418363';
    },
  ],
])('holds the rejected lane when closure inventory has %s', async (_label, mutate) => {
  const rejected = await rejectedCreate(),
    scans = await inventoryScans();
  mutate(scans);
  await expect(
    journal.closeRejectedCreate({
      operationId: rejected.operation.id,
      expectedRevision: rejected.operation.revision,
      connectionRevision: 1,
      scans,
    }),
  ).rejects.toThrow();
  const read = await journal.get(rejected.operation.id);
  expect(read.operation).toEqual(rejected.operation);
  expect(read.steps).toEqual(rejected.steps);
  expect(read.rejectionClosure).toBeNull();
  expect((await pool.query('SELECT operation_id FROM production_pilot_lanes')).rows).toEqual([
    { operation_id: rejected.operation.id },
  ]);
});
it('accepts only the observed omitted-array empty page without changing stored raw evidence', async () => {
  const rejected = await rejectedCreate(),
    scans = await inventoryScans();
  for (const scan of scans)
    for (const page of scan.pages.slice(1)) delete page.envelope.response.item;
  const closed = await journal.closeRejectedCreate({
    operationId: rejected.operation.id,
    expectedRevision: rejected.operation.revision,
    connectionRevision: 1,
    scans,
  });
  expect(closed.rejectionClosure.scans).toEqual(scans);
  expect(closed.rejectionClosure.scans[0].pages[1].envelope.response).not.toHaveProperty('item');
});
const shippingEstimateWarning =
  'fail to get channel estimated_shipping_fee for channel [50052];\nfail to get channel estimated_shipping_fee for channel [5012]';
it('retains the exact base-info shipping-estimate warning while proving full item/model identity coverage', async () => {
  const rejected = await rejectedCreate(),
    scans = await inventoryScans();
  for (const scan of scans) scan.baseInfo[0].warning = shippingEstimateWarning;
  const closed = await journal.closeRejectedCreate({
    operationId: rejected.operation.id,
    expectedRevision: rejected.operation.revision,
    connectionRevision: 1,
    scans,
  });
  expect(closed.rejectionClosure.scans).toEqual(scans);
  expect(closed.rejectionClosure.scans[0].baseInfo[0].warning).toBe(shippingEstimateWarning);
});
it.each(['mixed warning', 'model warning', 'page warning', 'source still present'])(
  'does not broaden census acceptance for %s',
  async (fault) => {
    const rejected = await rejectedCreate(),
      scans = await inventoryScans();
    for (const scan of scans) scan.baseInfo[0].warning = shippingEstimateWarning;
    if (fault === 'mixed warning') scans[0].baseInfo[0].warning += ';\nfailed to retrieve item';
    if (fault === 'model warning')
      scans[0].modelLists[0].envelope.warning = shippingEstimateWarning;
    if (fault === 'page warning') scans[0].pages[0].envelope.warning = shippingEstimateWarning;
    if (fault === 'source still present')
      scans[0].modelLists[0].envelope.response.model[0].model_sku = 'MODEL-1';
    await expect(
      journal.closeRejectedCreate({
        operationId: rejected.operation.id,
        expectedRevision: rejected.operation.revision,
        connectionRevision: 1,
        scans,
      }),
    ).rejects.toThrow();
    expect((await journal.get(rejected.operation.id)).rejectionClosure).toBeNull();
  },
);
it('preserves a complete two-scan evidence bundle above the write-snapshot node ceiling', async () => {
  const rejected = await rejectedCreate(),
    scans = await inventoryScans();
  // Complete item/model envelopes can exceed100k nodes across two censuses, even at modest byte size.
  scans[0].baseInfo[0].response.additional_raw_details = [
    Array.from({ length: 50_100 }, (_, index) => index),
    Array.from({ length: 50_100 }, (_, index) => `raw-${index}`),
  ];
  const closed = await journal.closeRejectedCreate({
    operationId: rejected.operation.id,
    expectedRevision: rejected.operation.revision,
    connectionRevision: 1,
    scans,
  });
  expect(closed.rejectionClosure.scans).toEqual(scans);
  expect(
    closed.rejectionClosure.scans[0].baseInfo[0].response.additional_raw_details[1],
  ).toHaveLength(50_100);
});
it('keeps write snapshots at100k nodes and rejects inventory evidence above its own bounded ceiling', async () => {
  const details = Array.from({ length: 6 }, () =>
    Array.from({ length: 90_000 }, (_, index) => index),
  );
  await expect(
    prepare('listing-a', { sourcePayload: { details: details.slice(0, 2) } }),
  ).rejects.toThrow('INVALID_SNAPSHOT');
  const rejected = await rejectedCreate(),
    scans = await inventoryScans();
  scans[0].baseInfo[0].response.additional_raw_details = details;
  await expect(
    journal.closeRejectedCreate({
      operationId: rejected.operation.id,
      expectedRevision: rejected.operation.revision,
      connectionRevision: 1,
      scans,
    }),
  ).rejects.toThrow('INVALID_SNAPSHOT');
  expect((await journal.get(rejected.operation.id)).rejectionClosure).toBeNull();
});
it.each([
  { message: 'Other business rejection' },
  { debug_message: 'Unknown constraints' },
  { error: 'product.error_busi' },
  { request_id: 'wrong-request' },
  { response: { item_id: 99 } },
  { item_id: 99 },
  { warning: 'Partial success' },
])('does not close a different or ambiguous rejection %j', async (patch) => {
  const rejected = await rejectedCreate(patch);
  await expect(
    journal.closeRejectedCreate({
      operationId: rejected.operation.id,
      expectedRevision: rejected.operation.revision,
      connectionRevision: 1,
      scans: await inventoryScans(),
    }),
  ).rejects.toThrow('REJECTION_NOT_DEFINITIVE');
  expect((await journal.get(rejected.operation.id)).rejectionClosure).toBeNull();
});
it('cannot release the rejected lane using direct SQL without a closure proof', async () => {
  const rejected = await rejectedCreate();
  await expect(
    pool.query('DELETE FROM production_pilot_lanes WHERE operation_id=$1', [rejected.operation.id]),
  ).rejects.toThrow('LANE_NEEDS_VERIFICATION');
});
it.each(['sent', 'unknown', 'acknowledged'] as const)(
  'cannot close a %s create even with complete absence scans',
  async (state) => {
    const op = await prepare(),
      step = await createStep(op.operation.id);
    await journal.markSent(intent(step));
    let current = await journal.get(op.operation.id);
    if (state !== 'sent')
      current = await journal.recordOutcome({
        operationId: op.operation.id,
        stepId: step.step.id,
        expectedRevision: 3,
        result:
          state === 'unknown'
            ? { kind: 'unknown', code: 'TIMEOUT' }
            : { kind: 'success', requestId: 'created', response: { item_id: 12345 } },
      });
    await expect(
      journal.closeRejectedCreate({
        operationId: op.operation.id,
        expectedRevision: current.operation.revision,
        connectionRevision: 1,
        scans: await inventoryScans(),
      }),
    ).rejects.toThrow('REJECTION_CLOSURE_FORBIDDEN');
  },
);
it('closes with fresh same-shop credentials after rotation while retaining old connection revision', async () => {
  const rejected = await rejectedCreate();
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  const scans = (await inventoryScans()).map((scan) => ({ ...scan, connectionRevision: 2 }));
  const closed = await journal.closeRejectedCreate({
    operationId: rejected.operation.id,
    expectedRevision: rejected.operation.revision,
    connectionRevision: 2,
    scans,
  });
  expect(closed.operation).toEqual(rejected.operation);
  expect(closed.operation.connection_revision).toBe(1);
  expect(closed.rejectionClosure.connection_revision).toBe(2);
});
it('does not take caller fingerprints or credentials into the immutable source', async () => {
  await expect(prepare('listing-a', { sourceFingerprint: 'f'.repeat(64) })).rejects.toThrow();
  await expect(
    prepare('listing-a', { sourcePayload: { access_token: 'secret-must-not-persist' } }),
  ).rejects.toThrow('INVALID_SNAPSHOT');
  expect((await pool.query('SELECT * FROM production_pilot_operations')).rows).toHaveLength(0);
});
it('requires an explicit at-most-three source allowlist and blocks a second revision clone', async () => {
  expect(
    () =>
      new ProductionPilotJournal(repo, {
        allowedSources: [...sources, { sourceIdentity: 'listing-d', sourceRevision: 1 }],
      }),
  ).toThrow();
  await expect(prepare('other-listing')).rejects.toThrow('SOURCE_FORBIDDEN');
  await prepare();
  journal = new ProductionPilotJournal(repo, {
    allowedSources: [{ sourceIdentity: 'listing-a', sourceRevision: 2 }],
  });
  await expect(prepare('listing-a', { sourceRevision: 2 })).rejects.toThrow(
    'SOURCE_ALREADY_RESERVED',
  );
});
it('rejects sparse arrays and array getters without executing them before source hashing', async () => {
  const sparse = new Array(2);
  sparse[1] = 'image';
  await expect(prepare('listing-a', { sourcePayload: { images: sparse } })).rejects.toThrow(
    'INVALID_SNAPSHOT',
  );
  let invoked = false;
  const getterArray: string[] = [];
  Object.defineProperty(getterArray, '0', {
    get() {
      invoked = true;
      return 'image';
    },
  });
  await expect(prepare('listing-a', { sourcePayload: { images: getterArray } })).rejects.toThrow(
    'INVALID_SNAPSHOT',
  );
  expect(invoked).toBe(false);
  expect((await pool.query('SELECT * FROM production_pilot_operations')).rows).toHaveLength(0);
});
it.each(['[redacted]', '[REDACTED]'])(
  'preserves sanitized receipts with exact transport sentinel %s',
  async (sentinel) => {
    const op = await prepare(),
      step = await createStep(op.operation.id);
    await journal.markSent(intent(step));
    const result = await journal.recordOutcome({
      operationId: op.operation.id,
      stepId: step.step.id,
      expectedRevision: 3,
      result: {
        kind: 'rejected',
        code: 'error_auth',
        envelope: { access_token: sentinel, partner_key: sentinel, error: 'error_auth' },
      },
    });
    expect(result.steps[0].receipt.envelope.access_token).toBe(sentinel);
    expect(result.operation.state).toBe('rejected');
  },
);
it.each([{ environment: 'sandbox' }, { shop_id: '227418363' }, { partner_id: '1232297' }])(
  'rejects wrong connection scope %j',
  async (patch) => {
    const [key, value] = Object.entries(patch)[0]!;
    await pool.query(`UPDATE connections SET ${key}=$2 WHERE id=$1`, [connectionId, value]);
    await expect(prepare()).rejects.toThrow('SCOPE_FORBIDDEN');
  },
);
it('blocks unknown or expired token lifetimes and changed connection revisions', async () => {
  await pool.query('UPDATE connections SET expires_at=NULL WHERE id=$1', [connectionId]);
  await expect(prepare()).rejects.toThrow('AUTH_REQUIRED');
  await pool.query("UPDATE connections SET expires_at=now()-interval '1 second' WHERE id=$1", [
    connectionId,
  ]);
  await expect(prepare()).rejects.toThrow('AUTH_REQUIRED');
  await pool.query(
    "UPDATE connections SET expires_at=now()+interval '1 hour',revision=2 WHERE id=$1",
    [connectionId],
  );
  await expect(prepare()).rejects.toThrow('CONNECTION_CHANGED');
});
it('records sent durably before transport and refuses the same step after process recreation', async () => {
  const op = await prepare(),
    step = await createStep(op.operation.id);
  let calls = 0;
  const transport = new ProductionPilotTransport(
    {
      environment: 'production',
      partnerId: '2010476',
      shopId: '1423724897',
      partnerKey: 'fixture-key',
      accessToken: 'fixture-token',
    },
    {
      authorizeMutation: (i) => journal.markSent(i),
      transport: async () => {
        calls++;
        const current = await journal.get(op.operation.id);
        expect(current.operation.state).toBe('sent');
        expect(current.steps[0].state).toBe('sent');
        return new Response(
          JSON.stringify({
            error: '',
            request_id: 'remote-create',
            response: { item_id: 123456789 },
          }),
        );
      },
    },
  );
  const result = await transport.write('/api/v2/product/add_item', body, {
    operationId: op.operation.id,
    stepId: step.step.id,
  });
  expect(result.kind).toBe('success');
  expect(calls).toBe(1);
  const fresh = new ProductionPilotJournal(repo, { allowedSources: sources });
  expect(await fresh.markSent(intent(step))).toBe(false);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
});
it('rechecks the immutable metadata deadline after waiting for the shop advisory lock', async () => {
  const original = {
    metadata: { expiresAt: new Date(Date.now() + 350).toISOString() },
    originalWord: 'immutable',
  };
  const op = await prepare('listing-a', { sourcePayload: original });
  const step = await createStep(op.operation.id);
  const holder = await pool.connect();
  let pending: Promise<boolean> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'production-pilot:production:2010476:1423724897',
    ]);
    let settled = false;
    pending = journal.markSent(intent(step)).then((value) => {
      settled = true;
      return value;
    });
    // Extending the caller object is not a metadata refresh; the authorized snapshot is immutable.
    original.metadata.expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    await holder.query('COMMIT');
    expect(await pending).toBe(false);
    const saved = await journal.get(op.operation.id);
    expect(saved.operation.revision).toBe(2);
    expect(saved.operation.state).toBe('authorized');
    expect(saved.steps[0].state).toBe('authorized');
    expect(saved.steps[0].sent_at).toBeNull();
    expect(saved.operation.source_payload.metadata.expiresAt).not.toBe(original.metadata.expiresAt);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    if (pending) await pending;
  }
});
it.each([
  {},
  { metadata: {} },
  { metadata: { expiresAt: 'not-a-date' } },
  { metadata: { expiresAt: '2000-01-01T00:00:00.000Z' } },
])(
  'never permits dispatch with missing, invalid or expired metadata deadline: %j',
  async (payload) => {
    const op = await prepare('listing-a', {
      sourcePayload: { originalWord: 'source', ...payload },
    });
    const step = await createStep(op.operation.id);
    expect(await journal.markSent(intent(step))).toBe(false);
    expect((await journal.get(op.operation.id)).steps[0].sent_at).toBeNull();
  },
);
it('accepts only one concurrent exact payload permit and CAS disallows stale plan stages', async () => {
  const op = await prepare(),
    step = await createStep(op.operation.id);
  expect(
    await journal.markSent({
      ...intent(step),
      fingerprint: productionPilotWriteFingerprint(step.step.path, {
        ...body,
        item_name: 'tampered',
      }),
    }),
  ).toBe(false);
  const results = await Promise.all([
    journal.markSent(intent(step)),
    journal.markSent(intent(step)),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await expect(createStep(op.operation.id)).rejects.toThrow('REVISION_CONFLICT');
});
it('retains shop lane through acknowledgement and unknown; another source cannot start', async () => {
  const ack = await createAcknowledged();
  await expect(prepare('listing-b')).rejects.toThrow('SHOP_BUSY');
  expect((await pool.query('SELECT id FROM production_pilot_operations')).rows).toHaveLength(1);
  expect(ack.operation.state).toBe('acknowledged');
  const variations = await journal.authorizeWrite({
    operationId: ack.operation.id,
    expectedRevision: ack.operation.revision,
    stepKey: 'variations',
    kind: 'variations',
    payload: { item_id: 123456789, tier_variation: [], model: [] },
  });
  expect(await journal.markSent(intent(variations))).toBe(true);
  const unknown = await journal.recordOutcome({
    operationId: ack.operation.id,
    stepId: variations.step.id,
    expectedRevision: variations.operation.revision + 1,
    result: { kind: 'unknown', code: 'PRODUCTION_PILOT_TRANSPORT' },
  });
  expect(unknown.operation.state).toBe('unknown');
  expect(await journal.markSent(intent(variations))).toBe(false);
  await expect(prepare('listing-b')).rejects.toThrow('SHOP_BUSY');
  await expect(pool.query('DELETE FROM production_pilot_lanes')).rejects.toThrow(
    'LANE_NEEDS_VERIFICATION',
  );
});
it('retains rejected outcome and lane without treating HTTP acknowledgement as publication', async () => {
  const op = await prepare(),
    step = await createStep(op.operation.id);
  await journal.markSent(intent(step));
  const result = { kind: 'rejected' as const, code: 'product.error_busi', requestId: 'reject-one' };
  const rejected = await journal.recordOutcome({
    operationId: op.operation.id,
    stepId: step.step.id,
    expectedRevision: 3,
    result,
  });
  expect(rejected.operation.state).toBe('rejected');
  expect(rejected.operation.item_id).toBeNull();
  expect(
    (
      await journal.recordOutcome({
        operationId: op.operation.id,
        stepId: step.step.id,
        expectedRevision: 3,
        result,
      })
    ).operation.revision,
  ).toBe(4);
  await expect(
    journal.recordOutcome({
      operationId: op.operation.id,
      stepId: step.step.id,
      expectedRevision: 4,
      result: { kind: 'unknown', code: 'different' },
    }),
  ).rejects.toThrow('REPLAY_FORBIDDEN');
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
});
it('stores exact media bytes and options fingerprints; another asset cannot borrow its permit', async () => {
  const op = await prepare(),
    bytes = new Uint8Array([137, 80, 78, 71]);
  const input = {
    operationId: op.operation.id,
    expectedRevision: 1,
    stepKey: 'cover',
    sourceAssetIdentity: 'canva:page-1',
    bytes,
    mime: 'image/png' as const,
    options: { scene: 'normal' as const, ratio: '1:1' as const },
  };
  const step = await journal.authorizeMedia(input);
  expect(step.step.fingerprint).toBe(
    productionPilotUploadFingerprint(bytes, input.mime, input.options),
  );
  expect(step.step.media).toMatchObject({
    bytes: 4,
    sourceAssetIdentity: 'canva:page-1',
    scene: 'normal',
    ratio: '1:1',
  });
  bytes[0] = 0;
  expect(
    await journal.markSent({
      ...intent(step),
      fingerprint: productionPilotUploadFingerprint(bytes, input.mime, input.options),
    }),
  ).toBe(false);
  expect(step.step.media.sha256).toMatch(/^[a-f0-9]{64}$/);
});
it('rejects publication and variation targets that do not belong to the acknowledged create', async () => {
  const op = await prepare();
  await expect(
    journal.authorizeWrite({
      operationId: op.operation.id,
      expectedRevision: 1,
      stepKey: 'bad',
      kind: 'create',
      payload: { ...body, item_status: 'NORMAL' },
    }),
  ).rejects.toThrow('CREATE_FORBIDDEN');
  await expect(
    journal.authorizeWrite({
      operationId: op.operation.id,
      expectedRevision: 1,
      stepKey: 'bad',
      kind: 'variations',
      payload: { item_id: 888 },
    }),
  ).rejects.toThrow('ITEM_MISMATCH');
  await expect(
    journal.authorizeWrite({
      operationId: op.operation.id,
      expectedRevision: 1,
      stepKey: 'bad',
      kind: 'create',
      payload: { ...body, shop_id: 888 },
    }),
  ).rejects.toThrow('SCOPE_FORBIDDEN');
});
it('preserves post-send receipt when connection was renewed, but blocks any new write', async () => {
  const op = await prepare(),
    step = await createStep(op.operation.id);
  await journal.markSent(intent(step));
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  const ack = await journal.recordOutcome({
    operationId: op.operation.id,
    stepId: step.step.id,
    expectedRevision: 3,
    result: { kind: 'success', response: { item_id: 123456789 }, requestId: 'late-ack' },
  });
  expect(ack.operation.state).toBe('acknowledged');
  await expect(
    journal.authorizeWrite({
      operationId: op.operation.id,
      expectedRevision: 4,
      stepKey: 'vars',
      kind: 'variations',
      payload: { item_id: 123456789 },
    }),
  ).rejects.toThrow('CONNECTION_CHANGED');
});
it('requires two distinct fresh readbacks and verifies every projected field before releasing lane', async () => {
  const ack = await createAcknowledged(),
    reads = await readbacks();
  const input = {
    operationId: ack.operation.id,
    expectedRevision: ack.operation.revision,
    phase: 'created_unlisted' as const,
    readbacks: reads,
  };
  await expect(
    journal.recordVerification({ ...input, readbacks: reads.slice(0, 1) }),
  ).rejects.toThrow();
  await expect(
    journal.recordVerification({
      ...input,
      readbacks: [reads[0]!, { ...reads[1]!, requestIds: reads[0]!.requestIds }],
    }),
  ).rejects.toThrow('READBACK_MISMATCH');
  await expect(
    journal.recordVerification({
      ...input,
      readbacks: [
        reads[0]!,
        { ...reads[1]!, projection: { ...desired, cover: 'different-cover' } },
      ],
    }),
  ).rejects.toThrow('READBACK_MISMATCH');
  await expect(
    journal.recordVerification({
      ...input,
      readbacks: reads.map((r) => ({ ...r, observedAt: '2000-01-01T00:00:00.000Z' })),
    }),
  ).rejects.toThrow('READBACK_SCOPE_INVALID');
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
  const done = await journal.recordVerification(input);
  expect(done.operation.state).toBe('verified');
  expect(done.verification.phase).toBe('created_unlisted');
  expect(done.verification.readbacks[0].rawSha256).toMatch(/^[a-f0-9]{64}$/);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(0);
  const second = await prepare('listing-b');
  expect((await createStep(second.operation.id)).step.state).toBe('authorized');
});
it('cannot release a lane from readback while a transport call is still in flight', async () => {
  const ack = await createAcknowledged();
  const step = await journal.authorizeWrite({
    operationId: ack.operation.id,
    expectedRevision: ack.operation.revision,
    stepKey: 'vars-in-flight',
    kind: 'variations',
    payload: { item_id: 123456789 },
  });
  await journal.markSent(intent(step));
  await expect(
    journal.recordVerification({
      operationId: ack.operation.id,
      expectedRevision: step.operation.revision + 1,
      phase: 'created_unlisted',
      readbacks: await readbacks(),
    }),
  ).rejects.toThrow('RECONCILIATION_REQUIRED');
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
});
it('rejects wrong shop, item, future or non-increasing read evidence', async () => {
  const ack = await createAcknowledged(),
    reads = await readbacks();
  const verify = (next: ProductionPilotReadback[]) =>
    journal.recordVerification({
      operationId: ack.operation.id,
      expectedRevision: ack.operation.revision,
      phase: 'created_unlisted',
      readbacks: next,
    });
  await expect(verify([reads[0]!, { ...reads[1]!, itemId: '9' }])).rejects.toThrow(
    'READBACK_SCOPE_INVALID',
  );
  await expect(
    verify([reads[0]!, { ...reads[1]!, observedAt: reads[0]!.observedAt }]),
  ).rejects.toThrow('READBACK_SCOPE_INVALID');
  await expect(
    verify([reads[0]!, { ...reads[1]!, observedAt: '2099-01-01T00:00:00.000Z' }]),
  ).rejects.toThrow('READBACK_SCOPE_INVALID');
  await expect(
    verify([reads[0]!, { ...reads[1]!, shopId: 'wrong' } as unknown as ProductionPilotReadback]),
  ).rejects.toThrow();
});
it('database guards forbid editing source/steps, deleting history, rewinding sent and unproved release', async () => {
  const op = await prepare(),
    step = await createStep(op.operation.id);
  await journal.markSent(intent(step));
  await expect(
    pool.query(
      "UPDATE production_pilot_operations SET source_payload='{}',revision=revision+1 WHERE id=$1",
      [op.operation.id],
    ),
  ).rejects.toThrow('IMMUTABLE');
  await expect(
    pool.query("UPDATE production_pilot_steps SET payload='{}' WHERE id=$1", [step.step.id]),
  ).rejects.toThrow('REPLAY_FORBIDDEN');
  await expect(
    pool.query("UPDATE production_pilot_steps SET state='authorized',sent_at=NULL WHERE id=$1", [
      step.step.id,
    ]),
  ).rejects.toThrow('REPLAY_FORBIDDEN');
  await expect(
    pool.query(
      "UPDATE production_pilot_operations SET state='verified',revision=revision+1 WHERE id=$1",
      [op.operation.id],
    ),
  ).rejects.toThrow('REPLAY_FORBIDDEN');
  await expect(
    pool.query('DELETE FROM production_pilot_steps WHERE id=$1', [step.step.id]),
  ).rejects.toThrow('IMMUTABLE');
});
