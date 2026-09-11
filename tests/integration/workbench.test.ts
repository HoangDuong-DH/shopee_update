import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  migrate,
  Pool,
  Repository,
  WorkOrderRepository,
} from '../../packages/persistence/src/index.js';
import { WorkbenchService } from '../../apps/api/src/workbench-service.js';
import type {
  WorkOrderConfig,
  SandboxRun,
  SandboxSnapshot,
} from '../../packages/domain/src/index.js';
import { fixtureDraft, fact } from '../helpers/fixtures.js';

const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool),
  service = new WorkbenchService(repo),
  orders = new WorkOrderRepository(pool);
const sandbox = randomUUID(),
  production = randomUUID();
const draft = { ...fixtureDraft(), productKey: 'MOCK-workbench-' + randomUUID() };
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await repo.saveProduct(draft, 0);
  for (const [id, env] of [
    [sandbox, 'sandbox'],
    [production, 'production'],
  ])
    await pool.query(
      `INSERT INTO connections(id,environment,partner_id,shop_id,name,state) VALUES($1,$2,'1232297','227418363',$3,'connected')`,
      [id, env, 'MOCK ' + env],
    );
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
function config(overrides: Partial<WorkOrderConfig> = {}): WorkOrderConfig {
  return {
    productKey: draft.productKey,
    sourceRevision: 1,
    connectionId: sandbox,
    operation: 'update',
    itemId: '803934364',
    fieldMask: ['title'],
    stocks: {},
    ...overrides,
  };
}
const save = (id: string, config: WorkOrderConfig, expectedRevision = 0) =>
  service.save({ id, expectedRevision, config });
it('pins exact source and shop without creating any product or platform job', async () => {
  const id = randomUUID();
  const result = await save(id, config());
  expect(result.config.sourceRevision).toBe(1);
  expect(result.shop?.scope.shopId).toBe('227418363');
  expect(result.state).toBe('ready_to_check');
  expect(result.config.stocks).toEqual({});
  expect(await repo.listProducts()).toHaveLength(1);
  expect(await repo.listJobs()).toHaveLength(0);
});
it('replays identical requests even after a newer version exists, but rejects divergent stale writes', async () => {
  const id = randomUUID(),
    first = config({ itemId: '803934365' });
  const saved = await save(id, first);
  const second = { ...first, fieldMask: ['description'] as WorkOrderConfig['fieldMask'] };
  await save(id, second, 1);
  const replay = await save(id, first);
  expect(replay.revision).toBe(2);
  expect(replay.config.fieldMask).toEqual(['description']);
  // The immutable receipt is still revision one; only the operational response is current.
  expect((await orders.save(id, 0, first)).revision).toBe(saved.revision);
  expect(
    (
      await pool.query('SELECT count(*)::int AS n FROM work_order_revisions WHERE order_id=$1', [
        id,
      ])
    ).rows[0].n,
  ).toBe(2);
  await expect(save(id, { ...first, fieldMask: ['gallery'] })).rejects.toThrow(
    'WORK_ORDER_REVISION_CONFLICT',
  );
  expect((await orders.get(id))?.config.fieldMask).toEqual(['description']);
});
it('protects a single target when two operators create work concurrently', async () => {
  const target = config({ itemId: '803934366' });
  const result = await Promise.allSettled([save(randomUUID(), target), save(randomUUID(), target)]);
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    (result.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message,
  ).toBe('WORK_ORDER_TARGET_EXISTS');
});
it('keeps missing source, mapping, connection and unsupported work distinct', async () => {
  const empty = await save(
    randomUUID(),
    config({ connectionId: null, operation: 'create', itemId: null }),
  );
  expect(empty.issues.find((i) => i.code === 'SHOP_REQUIRED')?.kind).toBe('connection');
  expect(empty.issues.find((i) => i.code === 'CREATE_NOT_RELEASED')?.kind).toBe('unsupported');
  expect(empty.issues.find((i) => i.code === 'STOCK_DECISION_REQUIRED')?.kind).toBe(
    'missing_source',
  );
  const update = await save(randomUUID(), config({ itemId: null, fieldMask: [] }));
  expect(update.issues.find((i) => i.code === 'ITEM_BINDING_REQUIRED')?.kind).toBe(
    'mapping_needed',
  );
  expect(update.issues.find((i) => i.code === 'FIELD_SELECTION_REQUIRED')?.kind).toBe(
    'mapping_needed',
  );
});
it('accepts explicit zero virtual stock and rejects stock for an unrelated SKU', async () => {
  const id = randomUUID();
  const quantities = Object.fromEntries(draft.variants.map((v) => [v.sku.value, 0]));
  const result = await save(id, config({ operation: 'create', itemId: null, stocks: quantities }));
  expect(result.issues.some((i) => i.code === 'STOCK_DECISION_REQUIRED')).toBe(false);
  await expect(
    save(id, config({ operation: 'create', itemId: null, stocks: { UNKNOWN: 100 } }), 1),
  ).rejects.toThrow('WORK_ORDER_STOCK_SOURCE');
  await expect(
    save(
      randomUUID(),
      config({ itemId: '803934367', stocks: { [draft.variants[0].sku.value]: -1 } }),
    ),
  ).rejects.toThrow();
});
it('does not present production or unimplemented updates as ready', async () => {
  const result = await save(
    randomUUID(),
    config({ connectionId: production, fieldMask: ['price'] }),
  );
  expect(result.state).toBe('needs_attention');
  expect(result.issues.map((i) => i.code)).toEqual(
    expect.arrayContaining(['PRODUCTION_READ_ONLY', 'UPDATE_FIELDS_UNSUPPORTED']),
  );
});
it('blocks create with an existing item and duplicate update masks', async () => {
  await expect(save(randomUUID(), config({ operation: 'create' }))).rejects.toThrow();
  await expect(save(randomUUID(), config({ fieldMask: ['title', 'title'] }))).rejects.toThrow();
});
it('never rewrites old work when a new source revision arrives', async () => {
  const id = randomUUID();
  await save(id, config({ itemId: '803934368' }));
  await repo.saveProduct({ ...draft, revision: 2, title: fact('MOCK revised exact title') }, 1);
  const current = await service.get(id);
  expect(current.source.title.value).toBe(draft.title.value);
  expect(current.latestSourceRevision).toBe(2);
  expect(current.issues.find((i) => i.code === 'SOURCE_REVISION_CHANGED')?.kind).toBe('conflict');
  const adopted = await save(id, config({ itemId: '803934368', sourceRevision: 2 }), 1);
  expect(adopted.source.title.value).toBe('MOCK revised exact title');
});
it('never leaks connection ciphertext in workbench responses', async () => {
  await pool.query(
    `UPDATE connections SET token_ciphertext='MOCK SECRET',partner_key_ciphertext='MOCK KEY'`,
  );
  const result = await service.list();
  expect(JSON.stringify(result)).not.toContain('MOCK SECRET');
  expect(JSON.stringify(result)).not.toContain('MOCK KEY');
  expect(result.execution).toEqual({
    productionWrites: false,
    sandboxUpdates: true,
    createEnabled: false,
  });
});

async function syntheticRun(
  workOrderId: string,
  config: WorkOrderConfig,
  state: SandboxRun['state'],
  workOrderRevision = 1,
) {
  const id = randomUUID();
  const baseline: SandboxSnapshot = {
    itemId: config.itemId!,
    title: 'MOCK remote title',
    descriptionType: 'normal',
    description: [],
    gallery: { imageIds: [], ratio: '3:4' },
    coverImageIds: [],
    categoryId: '123',
    status: 'NORMAL',
    tierNames: [],
    models: [],
    protectedFields: {},
    fingerprint: 'a'.repeat(64),
    observedAt: '2026-09-11T00:00:00Z',
    requestIds: [],
  };
  const input = {
    id,
    workOrderId,
    workOrderRevision,
    connectionId: config.connectionId,
    itemId: config.itemId,
    productKey: config.productKey,
    sourceRevision: config.sourceRevision,
    fieldMask: config.fieldMask,
    baselineFingerprint: baseline.fingerprint,
  };
  await pool.query(
    'INSERT INTO sandbox_listing_runs(id,connection_id,item_id,product_key,source_revision,connection_revision,input_fingerprint,state,intent,body) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9)',
    [
      id,
      config.connectionId,
      config.itemId,
      config.productKey,
      config.sourceRevision,
      'b'.repeat(64),
      state,
      { input },
      {
        fieldMask: config.fieldMask,
        baseline,
        preview: [],
        uploads: [],
        result: null,
        phase: state === 'prepared' ? 'prepared' : 'write_intent',
      },
    ],
  );
  return id;
}

it('restores an unresolved run from the server for another browser and blocks changing or retargeting work', async () => {
  const id = randomUUID(),
    current = config({ itemId: '803934381', sourceRevision: 2 });
  await save(id, current);
  const runId = await syntheticRun(id, current, 'unknown');
  const anotherBrowser = new WorkbenchService(new Repository(pool));
  const view = await anotherBrowser.get(id);
  expect(view.sandboxRun?.id).toBe(runId);
  expect(view.sandboxRun?.workOrderId).toBe(id);
  expect(view.sandboxRunMatchesConfig).toBe(true);
  expect(view.issues.find((issue) => issue.code === 'SANDBOX_RUN_NEEDS_RECOVERY')?.kind).toBe(
    'conflict',
  );
  expect(view.state).toBe('needs_attention');
  expect((await save(id, current, 1)).revision).toBe(1);
  for (const changed of [
    { ...current, itemId: '803934382' },
    { ...current, fieldMask: ['gallery'] as WorkOrderConfig['fieldMask'] },
    { ...current, stocks: { [draft.variants[0].sku.value]: 0 } },
  ])
    await expect(save(id, changed, 1)).rejects.toThrow('WORK_ORDER_ACTIVE_RUN');
  expect((await orders.get(id))?.revision).toBe(1);
  await pool.query(
    "UPDATE sandbox_listing_runs SET state='verified',revision=revision+1 WHERE id=$1",
    [runId],
  );
  expect((await save(id, { ...current, fieldMask: ['gallery'] }, 1)).revision).toBe(2);
});

it('shows active recovery with its real older source scope and never labels it as the current configuration', async () => {
  const id = randomUUID(),
    current = config({ itemId: '803934383', sourceRevision: 2 });
  await save(id, current);
  const latest = await syntheticRun(id, current, 'verified');
  const active = await syntheticRun(id, { ...current, sourceRevision: 1 }, 'in_flight');
  const view = await service.get(id);
  expect(view.sandboxRun?.id).toBe(active);
  expect(view.sandboxRun?.sourceRevision).toBe(1);
  expect(view.config.sourceRevision).toBe(2);
  expect(view.sandboxRunMatchesConfig).toBe(false);
  await pool.query("UPDATE sandbox_listing_runs SET state='rejected' WHERE id=$1", [active]);
  expect((await service.get(id)).sandboxRun?.id).toBe(latest);
});

it('invalidates only the prepared run linked to the old exact work revision and defeats a delayed execute CAS', async () => {
  const id = randomUUID(),
    current = config({ itemId: '803934384' });
  await save(id, current);
  const matching = await syntheticRun(id, current, 'prepared');
  const otherSource = await syntheticRun(id, { ...current, sourceRevision: 2 }, 'prepared');
  const otherFields = await syntheticRun(
    id,
    { ...current, fieldMask: ['description'] },
    'prepared',
  );
  const otherWork = await syntheticRun(randomUUID(), current, 'prepared');
  await save(id, { ...current, fieldMask: ['gallery'] }, 1);
  const changed = (
    await pool.query('SELECT state,revision,body FROM sandbox_listing_runs WHERE id=$1', [matching])
  ).rows[0];
  expect(changed.state).toBe('drift');
  expect(changed.revision).toBe(2);
  expect(changed.body.result.code).toBe('WORK_ORDER_CONFIG_CHANGED');
  expect(
    (
      await pool.query(
        'SELECT code FROM sandbox_listing_run_events WHERE run_id=$1 AND revision=2',
        [matching],
      )
    ).rows[0].code,
  ).toBe('WORK_ORDER_CONFIG_CHANGED');
  expect(
    (
      await pool.query(
        "UPDATE sandbox_listing_runs SET state='in_flight',revision=revision+1 WHERE id=$1 AND revision=1",
        [matching],
      )
    ).rowCount,
  ).toBe(0);
  for (const untouched of [otherSource, otherFields, otherWork]) {
    const row = (
      await pool.query('SELECT state,revision FROM sandbox_listing_runs WHERE id=$1', [untouched])
    ).rows[0];
    expect(row).toEqual({ state: 'prepared', revision: 1 });
  }
});

it('rejects a new order targeting an unresolved run and omits unrelated nonactive history', async () => {
  const target = config({ itemId: '803934385', sourceRevision: 2 });
  await syntheticRun(randomUUID(), target, 'unknown');
  await expect(save(randomUUID(), target)).rejects.toThrow('WORK_ORDER_ACTIVE_RUN');
  const id = randomUUID(),
    separate = config({ itemId: '803934386', sourceRevision: 2 });
  await save(id, separate);
  await syntheticRun(randomUUID(), separate, 'verified');
  await syntheticRun(id, { ...separate, fieldMask: ['description'] }, 'verified');
  const view = await service.get(id);
  expect(view.sandboxRun).toBeNull();
  expect(view.sandboxRunMatchesConfig).toBe(false);
});

it('keeps a variations source error visible when only title or content is selected', async () => {
  const source = {
    ...fixtureDraft(),
    productKey: 'MOCK-variation-issue-' + randomUUID(),
    issues: [
      {
        code: 'DUPLICATE_VARIANT_SKU',
        severity: 'block' as const,
        field: 'variations',
        message: 'MOCK source requires variant review',
        sources: [],
      },
    ],
  };
  await repo.saveProduct(source, 0);
  for (const [itemId, fieldMask] of [
    ['803934389', ['title']],
    ['803934390', ['description']],
  ] as const) {
    const view = await save(
      randomUUID(),
      config({ productKey: source.productKey, itemId, fieldMask: [...fieldMask] }),
    );
    expect(view.issues.find((issue) => issue.code === 'DUPLICATE_VARIANT_SKU')?.field).toBe(
      'variations',
    );
    expect(view.state).toBe('needs_attention');
  }
});
