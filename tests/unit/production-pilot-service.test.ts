import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@shopee/domain';
import { productionPilotWriteFingerprint } from '../../packages/shopee/src/production-pilot-transport.js';
import type { Repository } from '../../packages/persistence/src/index.js';

const mocks = vi.hoisted(() => ({ load: vi.fn(), collect: vi.fn(), write: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  writeFile: mocks.write,
}));
vi.mock('../../apps/api/src/production-pilot-source.js', () => ({
  loadProductionPilotSource: mocks.load,
  collectProductionPilotInput: mocks.collect,
  pilotProbeAuthorization: 'fixture-source-bound-probe',
  productionPilotSourceRoot: '/fixture-only',
  productionPilotScope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
}));
import { ProductionPilotService } from '../../apps/api/src/production-pilot-service.js';
import { ProductionPilotRunner } from '../../apps/api/src/production-pilot-runner.js';

const sourceIdentity = 'fd983d71-dbe4-4980-a3d6-d2f90d9f117c:row-2';
const oldId = '85c09451-42b1-4927-b819-7a30dd21a602';
const source = (revision = 3) => ({
  sha256: 'a'.repeat(64),
  value: {
    assets: {},
    listings: [
      {
        sourceIdentity,
        sourceRevision: revision,
        sourceKey: 'row-2',
        supersedesOperationId: oldId,
        proposedAttributeList: [],
        document: {
          title: 'Nguồn gốc giữ nguyên',
          cover: { importId: 'cover' },
          gallery: [],
          description: [],
          tierNames: [],
          models: [
            {
              sku: 'VTSJC5L',
              optionLabels: ['Sả Java 5L'],
              originalPrice: '2179998',
              stock: 100,
              weightGrams: 5225,
            },
          ],
        },
      },
    ],
  },
});
const oldOperation = (patch: Record<string, unknown> = {}) => ({
  id: oldId,
  source_identity: sourceIdentity,
  source_revision: 2,
  item_id: null as string | null,
  state: 'rejected',
  total: 32,
  acknowledged: 31,
  sent: 0,
  unknown: 0,
  rejected: 1,
  upload_acknowledged: 31,
  create_acknowledged: 0,
  model_acknowledged: 0,
  failure_code: 'product.error_param',
  failure_message:
    'Parameter is not match the constraints, . : You are not in the whitelist to add images in description, can only upload plain text',
  failure_request_id: 'request-whitelist',
  failure_path: '/api/v2/product/add_item',
  closure_operation_id: null as string | null,
  supersedes_operation_id: null as string | null,
  ...patch,
});
function service(operations: any[], enabled = true, repo = {} as Repository) {
  const instance = new ProductionPilotService(repo, { enabled });
  vi.spyOn(instance as any, 'operations').mockResolvedValue(operations);
  const execution = vi.spyOn(instance as any, 'execute').mockResolvedValue(undefined);
  return { instance, execution };
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(source());
});
it('queries only the original pilot identities while retaining their complete revision history',async()=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[{operations:'production_pilot_operations'}]}).mockResolvedValueOnce({rows:[]});
 const instance=new ProductionPilotService({pool:{query}} as any,{enabled:true});
 await (instance as any).operations(source());
 expect(query.mock.calls[1]?.[0]).toContain('o.source_identity=ANY($2::text[])');
 expect(query.mock.calls[1]?.[1]).toEqual(['production:2010476:1423724897',[sourceIdentity]]);
 expect(query.mock.calls[1]?.[0]).not.toContain('o.source_revision=$');
});

it.each([
  (op: any) => {
    op.source_payload.document.models[0].stock = 99;
  },
  (op: any) => {
    op.source_fingerprint = 'f'.repeat(64);
  },
  (op: any) => {
    op.owner_key = 'production:2010476:other';
  },
  (op: any) => {
    op.current_connection.shop_id = 'other';
  },
  (op: any) => {
    op.current_connection.id = 'replacement-connection';
  },
  (op: any) => {
    op.current_connection.revision = 2;
  },
  (op: any) => {
    op.current_connection.state = 'disconnected';
  },
  (op: any) => {
    op.create_verification = null;
  },
  (op: any) => {
    op.create_verification.expected_fingerprint = 'b'.repeat(64);
  },
  (op: any) => {
    op.create_verification.readbacks[0].raw.status = 'BANNED';
  },
  (op: any) => {
    op.publication_verification.item_id = '51467852284';
  },
  (op: any) => {
    op.publication_verification.operation_revision -= 1;
  },
  (op: any) => {
    op.publication_verification.readbacks[0].projection.status = 'UNLIST';
  },
  (op: any) => {
    op.publication.source_fingerprint = 'b'.repeat(64);
  },
  (op: any) => {
    op.publication.create_verification_id = 'other-proof';
  },
  (op: any) => {
    op.publication.connection_id = 'other-connection';
  },
  (op: any) => {
    op.publication.payload.item_list[0].item_id += 1;
  },
  (op: any) => {
    op.publication.fingerprint = 'b'.repeat(64);
  },
  (op: any) => {
    op.publication.receipt.requestId = 'altered';
  },
  (op: any) => {
    op.step_states[0].state = 'unknown';
  },
  (op: any) => {
    op.step_states.push({ step_key: 'media-extra', state: 'acknowledged' });
  },
])('blocks continuation when completed source evidence is altered %#', async (alter) => {
  mocks.load.mockResolvedValue(twoSources());
  const op = publishedCurrent();
  alter(op);
  const { instance, execution } = service([oldOperation({ closure_operation_id: oldId }), op]);
  expect((await instance.status()).canStart).toBe(false);
  await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).rejects.toThrow(
    'RECONCILIATION_REQUIRED',
  );
  expect(execution).not.toHaveBeenCalled();
});

function resumable(stage: 'create' | 'publish' | 'publication') {
  const op: any = publishedCurrent();
  op.publication_state = stage === 'publication' ? 'acknowledged' : null;
  op.publication_verification = null;
  if (stage === 'publication') {
    op.publication.state = 'acknowledged';
    op.publication.revision = 3;
  } else op.publication = null;
  if (stage === 'create') {
    op.state = 'acknowledged';
    op.revision = 6;
    op.create_verification = null;
  }
  return op;
}
it.each(['create', 'publish', 'publication'] as const)(
  'allows only the proven readback/publication continuation for %s',
  async (stage) => {
    const { instance } = service([oldOperation({ closure_operation_id: oldId }), resumable(stage)]);
    const status = await instance.status();
    expect(status).toMatchObject({
      canStart: true,
      remainingCount: 1,
      continuationKind: 'reconcile',
    });
  },
);
it.each(['authorized', 'sent', 'unknown', 'rejected'])(
  'does not resume a publication in %s',
  async (state) => {
    const op = resumable('publication');
    op.publication.state = state;
    op.publication_state = state;
    const { instance } = service([oldOperation({ closure_operation_id: oldId }), op]);
    expect((await instance.status()).canStart).toBe(false);
  },
);
it('does not resume a create which only uploaded its media', async () => {
  const op = resumable('create');
  op.item_id = null;
  op.step_states.pop();
  op.total -= 1;
  op.acknowledged -= 1;
  const { instance } = service([oldOperation({ closure_operation_id: oldId }), op]);
  expect((await instance.status()).canStart).toBe(false);
});
it('rejects a stale remaining-work key before starting', async () => {
  mocks.load.mockResolvedValue(twoSources());
  const { instance, execution } = service([
    oldOperation({ closure_operation_id: oldId }),
    publishedCurrent(),
  ]);
  await expect(
    instance.start({ sourceReceiptSha256: 'a'.repeat(64), continuationKey: 'b'.repeat(64) }),
  ).rejects.toThrow('CONTINUATION_CHANGED');
  expect(execution).not.toHaveBeenCalled();
});
it('execution bootstraps verified capabilities and never replays the already published source', async () => {
  const loaded = twoSources();
  mocks.load.mockResolvedValue(loaded);
  const repo = {
    pool: { query: vi.fn().mockResolvedValue({ rows: [{ revision: 4 }] }) },
  } as unknown as Repository;
  const { instance, execution } = service(
    [oldOperation({ closure_operation_id: oldId }), publishedCurrent()],
    true,
    repo,
  );
  execution.mockRestore();
  const capabilities = {
    gallery34: { state: 'supported' },
    extendedDescription: { state: 'unsupported' },
  };
  const capability = vi
    .spyOn(ProductionPilotRunner.prototype, 'capabilityEvidenceFromVerified')
    .mockResolvedValue(capabilities as any);
  const prepare = vi
    .spyOn(ProductionPilotRunner.prototype, 'prepare')
    .mockResolvedValue({ kind: 'ready', operationId: 'remaining-operation' } as any);
  const run = vi
    .spyOn(ProductionPilotRunner.prototype, 'run')
    .mockResolvedValue({ state: 'verified', operationId: 'remaining-operation' } as any);
  const publish = vi
    .spyOn(ProductionPilotRunner.prototype, 'publish')
    .mockResolvedValue({ state: 'published', operationId: 'remaining-operation' } as any);
  mocks.collect.mockResolvedValue({
    sourceReceiptSha256: loaded.sha256,
    preflightId: 'fixture',
    input: { metadata: { fixture: true } },
  });
  await (instance as any).execute(loaded);
  expect(capability).toHaveBeenCalledWith(
    'published-current',
    4,
    expect.any(String),
    expect.any(Array),
  );
  expect(mocks.collect.mock.calls.every((call) => call[1] === 'row-65')).toBe(true);
  expect(mocks.collect).toHaveBeenCalledWith(
    repo,
    'row-65',
    expect.objectContaining({ priorCapabilityEvidence: capabilities }),
  );
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledExactlyOnceWith('remaining-operation');
  expect(publish).toHaveBeenCalledExactlyOnceWith('remaining-operation', { fixture: true });
  const runner = prepare.mock.instances[0]! as ProductionPilotRunner;
  expect(runner.options.allowedSources).toHaveLength(3);
  expect(runner.options.readbackDelaysMs).toEqual([1000, 3000, 7000, 15000]);
});
it.each(['create', 'publish', 'publication'] as const)(
  'execution never prepares again when resuming %s',
  async (stage) => {
    const { instance, execution } = service([
      oldOperation({ closure_operation_id: oldId }),
      resumable(stage),
    ]);
    execution.mockRestore();
    const prepare = vi.spyOn(ProductionPilotRunner.prototype, 'prepare');
    const run = vi
      .spyOn(ProductionPilotRunner.prototype, 'run')
      .mockResolvedValue({ state: 'verified', operationId: 'published-current' } as any);
    const publish = vi
      .spyOn(ProductionPilotRunner.prototype, 'publish')
      .mockResolvedValue({ state: 'published', operationId: 'published-current' } as any);
    mocks.collect.mockResolvedValue({
      sourceReceiptSha256: 'a'.repeat(64),
      preflightId: 'fixture',
      input: { metadata: { fixture: true } },
    });
    await (instance as any).execute(source());
    expect(prepare).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledExactlyOnceWith('published-current');
    expect(publish).toHaveBeenCalledExactlyOnceWith('published-current', { fixture: true });
  },
);

it('shows the active source revision separately from a rejected historical attempt', async () => {
  const { instance } = service([oldOperation()]);
  const status = await instance.status();
  expect(status.listings[0]).toMatchObject({
    sourceRevision: 3,
    state: 'not_sent',
    operationId: undefined,
  });
  expect(status.historicalAttempts).toHaveLength(1);
  expect(status.historicalAttempts[0]).toMatchObject({
    operationId: oldId,
    sourceRevision: 2,
    state: 'rejected',
    reasonCode: 'DESC_IMAGES_NOT_ALLOWED',
    stepCounts: { uploadsAcknowledged: 31, createsAcknowledged: 0, modelsAcknowledged: 0 },
  });
  expect(status.canStart).toBe(false);
});

it('selects a matching current revision even if the oldest attempt is returned first', async () => {
  const current = oldOperation({
    id: 'new-v3',
    source_revision: 3,
    state: 'verified',
    item_id: '9001',
    publication_state: 'verified',
  });
  const { instance } = service([oldOperation(), current]);
  const status = await instance.status();
  expect(status.listings[0]).toMatchObject({
    sourceRevision: 3,
    state: 'verified',
    operationId: 'new-v3',
    itemId: '9001',
  });
  expect(status.historicalAttempts.map((op: any) => op.operationId)).toEqual([oldId]);
  expect(status.canStart).toBe(false);
});

it('does not mislabel a generic parameter error as the description whitelist failure', async () => {
  const { instance } = service([oldOperation({ failure_message: 'Invalid weight' })]);
  const status = await instance.status();
  expect(status.historicalAttempts[0].reasonCode).toBe('product.error_param');
});

it.each(['sent', 'unknown', 'acknowledged', 'verified'])(
  'blocks a previous %s attempt even with a claimed closure',
  async (state) => {
    const { instance, execution } = service([oldOperation({ state, closure_operation_id: oldId })]);
    await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).rejects.toThrow(
      'RECONCILIATION_REQUIRED',
    );
    expect(execution).not.toHaveBeenCalled();
  },
);

it('blocks an unclosed rejection and never starts an outgoing task', async () => {
  const { instance, execution } = service([oldOperation()]);
  await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).rejects.toThrow(
    'RECONCILIATION_REQUIRED',
  );
  expect(execution).not.toHaveBeenCalled();
});

it('rejects a stale source receipt before any work begins', async () => {
  const { instance, execution } = service([]);
  await expect(instance.start({ sourceReceiptSha256: 'b'.repeat(64) })).rejects.toThrow(
    'SOURCE_CHANGED',
  );
  expect(execution).not.toHaveBeenCalled();
});

it('keeps the write entry disabled unless explicitly enabled', async () => {
  const { instance, execution } = service([], false);
  await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).rejects.toThrow('DISABLED');
  expect(execution).not.toHaveBeenCalled();
});

it('allows only one asynchronous start in this process while journals arbitrate other processes', async () => {
  const { instance, execution } = service([oldOperation({ closure_operation_id: oldId })]);
  execution.mockImplementation(() => new Promise(() => {}));
  const results = await Promise.all([
    instance.start({ sourceReceiptSha256: 'a'.repeat(64) }),
    instance.start({ sourceReceiptSha256: 'a'.repeat(64) }),
  ]);
  expect(results).toEqual([{ started: true }, { started: true }]);
  expect(execution).toHaveBeenCalledTimes(1);
});

it('starts a new version only when its explicitly linked rejected predecessor is definitively closed', async () => {
  const { instance, execution } = service([oldOperation({ closure_operation_id: oldId })]);
  expect((await instance.status()).canStart).toBe(true);
  await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).resolves.toEqual({
    started: true,
  });
  expect(execution).toHaveBeenCalledTimes(1);
});

it.each([
  { item_id: '9001' },
  { sent: 1 },
  { unknown: 1 },
  { create_acknowledged: 1 },
  { model_acknowledged: 1 },
  { source_revision: 3 },
  { source_revision: 4 },
  { source_identity: 'foreign-source' },
  { closure_operation_id: 'different-op' },
])('does not grant start through a misleading historical closure %#', async (patch) => {
  const { instance, execution } = service([
    oldOperation({ closure_operation_id: oldId, ...patch }),
  ]);
  await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).rejects.toThrow(
    'RECONCILIATION_REQUIRED',
  );
  expect(execution).not.toHaveBeenCalled();
});

it('never treats missing predecessor history as permission to recreate', async () => {
  const { instance, execution } = service([]);
  await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).rejects.toThrow(
    'RECONCILIATION_REQUIRED',
  );
  expect(execution).not.toHaveBeenCalled();
});

it('does not accept a changed source receipt during an active run', async () => {
  const { instance, execution } = service([oldOperation({ closure_operation_id: oldId })]);
  execution.mockImplementation(() => new Promise(() => {}));
  await instance.start({ sourceReceiptSha256: 'a'.repeat(64) });
  await expect(instance.start({ sourceReceiptSha256: 'b'.repeat(64) })).rejects.toThrow(
    'SOURCE_CHANGED',
  );
  expect(execution).toHaveBeenCalledTimes(1);
});

it('does not display normal in-progress ownership as a recovery error', async () => {
  const { instance, execution } = service([oldOperation({ closure_operation_id: oldId })]);
  execution.mockImplementation(() => new Promise(() => {}));
  await instance.start({ sourceReceiptSha256: 'a'.repeat(64) });
  vi.mocked((instance as any).operations).mockResolvedValue([
    oldOperation({ closure_operation_id: oldId }),
    oldOperation({ id: 'current-v3', source_revision: 3, state: 'sent', sent: 1 }),
  ]);
  const status = await instance.status();
  expect(status.active).toBe(true);
  expect(status.canStart).toBe(false);
  expect(status.startBlockedCode).toBeUndefined();
});

it('keeps completed publication non-replayable without claiming it still needs reconciliation', async () => {
  const { instance, execution } = service([
    oldOperation({ closure_operation_id: oldId }),
    publishedCurrent(),
  ]);
  const status = await instance.status();
  expect(status.canStart).toBe(false);
  expect(status.startBlockedCode).toBeUndefined();
  expect(status.phase).toBe('complete');
  await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).rejects.toThrow(
    'RECONCILIATION_REQUIRED',
  );
  expect(execution).not.toHaveBeenCalled();
});
function twoSources() {
  const loaded = source();
  loaded.value.listings.push({
    ...structuredClone(loaded.value.listings[0]!),
    sourceIdentity: 'catalog:row-65',
    sourceKey: 'row-65',
    supersedesOperationId: undefined as any,
  });
  return loaded;
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
function publishedCurrent() {
  const listing = source().value.listings[0]!;
  const connection = {
    id: 'connection-a',
    environment: 'production',
    partner_id: '2010476',
    shop_id: '1423724897',
    revision: 4,
    state: 'connected',
  };
  const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' };
  const payload = {
    sourceIdentity,
    sourceRevision: 3,
    supersedesOperationId: oldId,
    connectionId: connection.id,
    connectionRevision: 3,
    document: listing.document,
    assets: {},
    context: { attributeList: [] },
    metadata: { ...scope, connectionRevision: 3 },
    capabilityEvidence: { ...scope, connectionRevision: 3 },
  };
  const projection = { status: 'UNLIST', title: listing.document.title };
  const reads = (expected: Record<string, unknown>, prefix: string) =>
    [0, 1].map((n) => ({
      shopId: '1423724897',
      partnerId: '2010476',
      itemId: '51467852283',
      connectionRevision: 3,
      observedAt: new Date(1750000000000 + n * 1000).toISOString(),
      requestIds: [prefix + n],
      raw: { item: 'fixture', status: expected.status },
      projection: expected,
      rawSha256: fingerprint({ item: 'fixture', status: expected.status }),
      projectionSha256: fingerprint(expected),
    }));
  const sourceHash = fingerprint({
    scope,
    sourceIdentity,
    sourceRevision: 3,
    sourcePayload: payload,
    expectedProjection: projection,
  });
  const createReads = reads(projection, 'create');
  const createVerification = {
    id: 'create-proof',
    operation_id: 'published-current',
    operation_revision: 6,
    phase: 'created_unlisted',
    item_id: '51467852283',
    expected_fingerprint: fingerprint(projection),
    readbacks: createReads,
    evidence_fingerprint: fingerprint(createReads),
  };
  const publishReads = reads({ ...projection, status: 'NORMAL' }, 'publish');
  const receipt = {
    kind: 'success',
    requestId: 'publish-ack',
    response: { success_list: [{ item_id: 51467852283, unlist: false }], failure_list: [] },
  };
  return oldOperation({
    id: 'published-current',
    owner_key: 'production:2010476:1423724897',
    revision: 7,
    connection_id: connection.id,
    connection_revision: 3,
    current_connection: connection,
    source_revision: 3,
    source_payload: payload,
    source_fingerprint: sourceHash,
    expected_projection: projection,
    create_verification: createVerification,
    state: 'verified',
    item_id: '51467852283',
    publication_state: 'verified',
    supersedes_operation_id: oldId,
    total: 2,
    acknowledged: 2,
    rejected: 0,
    upload_acknowledged: 1,
    create_acknowledged: 1,
    step_states: [
      { step_key: 'media-0', state: 'acknowledged' },
      { step_key: 'create', state: 'acknowledged' },
    ],
    publication: {
      id: 'publication-a',
      revision: 4,
      owner_key: 'production:2010476:1423724897',
      state: 'verified',
      create_operation_id: 'published-current',
      create_verification_id: createVerification.id,
      source_identity: sourceIdentity,
      source_revision: 3,
      source_fingerprint: sourceHash,
      item_id: '51467852283',
      connection_id: connection.id,
      connection_revision: 3,
      path: '/api/v2/product/unlist_item',
      payload: { item_list: [{ item_id: 51467852283, unlist: false }] },
      expected_projection: projection,
      fingerprint: productionPilotWriteFingerprint('/api/v2/product/unlist_item', {
        item_list: [{ item_id: 51467852283, unlist: false }],
      }),
      receipt,
      outcome_fingerprint: fingerprint(receipt),
    },
    publication_verification: {
      operation_id: 'publication-a',
      operation_revision: 3,
      phase: 'published',
      item_id: '51467852283',
      readbacks: publishReads,
      evidence_fingerprint: fingerprint(publishReads),
    },
  });
}
it('reports a durable partial completion after external publication and clears only the stale batch error', async () => {
  mocks.load.mockResolvedValue(twoSources());
  const { instance, execution } = service([
    oldOperation({ closure_operation_id: oldId }),
    publishedCurrent(),
  ]);
  (instance as any).phase = 'stopped';
  (instance as any).code = 'READBACK_MISMATCH';
  const status = await instance.status();
  expect(status.phase).toBe('partial_complete');
  expect(status.code).toBeUndefined();
  expect(status.startBlockedCode).toBeUndefined();
  expect(status.canStart).toBe(true);
  expect(status.remainingCount).toBe(1);
  expect(status.continuationKey).toMatch(/^[a-f0-9]{64}$/);
  expect(status.listings.map((listing: any) => [listing.state, listing.publicationState])).toEqual([
    ['verified', 'verified'],
    ['not_sent', undefined],
  ]);
  await expect(
    instance.start({
      sourceReceiptSha256: 'a'.repeat(64),
      continuationKey: status.continuationKey,
    }),
  ).resolves.toEqual({ started: true });
  expect(execution).toHaveBeenCalledTimes(1);
});
it.each([
  'unclosed history',
  'pending other source',
  'unknown other source',
  'unverified publication',
  'running',
])('retains the existing issue instead of claiming partial completion with %s', async (fault) => {
  mocks.load.mockResolvedValue(twoSources());
  const operations: any[] = [
    oldOperation({ closure_operation_id: fault === 'unclosed history' ? null : oldId }),
    publishedCurrent(),
  ];
  if (fault === 'unverified publication') operations[1]!.publication_state = 'acknowledged';
  if (fault === 'pending other source' || fault === 'unknown other source')
    operations.push(
      oldOperation({
        id: 'other-current',
        source_identity: 'catalog:row-65',
        source_revision: 3,
        state: fault === 'pending other source' ? 'authorized' : 'unknown',
        supersedes_operation_id: null,
      }),
    );
  const { instance } = service(operations);
  (instance as any).phase = 'stopped';
  (instance as any).code = 'READBACK_MISMATCH';
  if (fault === 'running') (instance as any).active = true;
  const status = await instance.status();
  expect(status.phase).not.toBe('partial_complete');
  expect(status.code).toBe('READBACK_MISMATCH');
  expect(status.canStart).toBe(false);
});

it('still requires reconciliation for a created but not published listing after a process restart', async () => {
  const { instance } = service([
    oldOperation({ closure_operation_id: oldId }),
    oldOperation({
      id: 'current-v3',
      source_revision: 3,
      state: 'verified',
      item_id: '9001',
      publication_state: 'unknown',
    }),
  ]);
  expect((await instance.status()).startBlockedCode).toBe(
    'PRODUCTION_PILOT_RECONCILIATION_REQUIRED',
  );
});

it('identifies the actual forced-shipping rejection without classifying every business error alike', async () => {
  const forced = oldOperation({
    source_revision: 3,
    failure_code: 'product.error_busi',
    failure_message: 'Invalid product setting. Please verify.',
    failure_debug_message:
      'Failed to create product : validation: [Rule Type: logistics.channel.force_enable_forbid_disable, Detail: {"code":1326,"msg":"cannot disable a force-enabled channel"}] ',
  });
  const { instance } = service([forced]);
  expect((await instance.status()).listings[0]?.reasonCode).toBe(
    'LOGISTICS_FORCE_CHANNEL_REQUIRED',
  );
  vi.mocked((instance as any).operations).mockResolvedValue([
    { ...forced, failure_debug_message: 'Other validation failed' },
  ]);
  expect((await instance.status()).listings[0]?.reasonCode).toBe('product.error_busi');
});

const secondId = 'dfa64457-dd7d-4ca2-9354-c89482b4fd38';
function versionFour() {
  const current = source(4);
  current.value.listings[0]!.supersedesOperationId = secondId;
  return current;
}
const twoClosedAncestors = () => [
  oldOperation({ closure_operation_id: oldId }),
  oldOperation({
    id: secondId,
    source_revision: 3,
    closure_operation_id: secondId,
    supersedes_operation_id: oldId,
  }),
];
it('permits v4 only through its exact closed v3 to v2 ancestry, retaining both historical attempts', async () => {
  mocks.load.mockResolvedValue(versionFour());
  const { instance, execution } = service(twoClosedAncestors());
  const status = await instance.status();
  expect(status.canStart).toBe(true);
  expect(status.historicalAttempts).toHaveLength(2);
  await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).resolves.toEqual({
    started: true,
  });
  expect(execution).toHaveBeenCalledTimes(1);
});
it.each([
  { closure_operation_id: null },
  { supersedes_operation_id: 'unobserved-predecessor' },
  { supersedes_operation_id: secondId },
  { source_identity: 'different-listing' },
  { source_revision: 4 },
  { state: 'unknown' },
  { item_id: 'created-item' },
])('refuses an invalid v4 predecessor chain %#', async (patch) => {
  mocks.load.mockResolvedValue(versionFour());
  const ancestors = twoClosedAncestors();
  ancestors[1] = { ...ancestors[1]!, ...patch };
  const { instance, execution } = service(ancestors);
  await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).rejects.toThrow(
    'RECONCILIATION_REQUIRED',
  );
  expect(execution).not.toHaveBeenCalled();
});
it('refuses an older closed operation omitted from the declared chain', async () => {
  mocks.load.mockResolvedValue(versionFour());
  const ancestors = twoClosedAncestors();
  ancestors[1]!.supersedes_operation_id = null;
  const { instance, execution } = service(ancestors);
  await expect(instance.start({ sourceReceiptSha256: 'a'.repeat(64) })).rejects.toThrow(
    'RECONCILIATION_REQUIRED',
  );
  expect(execution).not.toHaveBeenCalled();
});
