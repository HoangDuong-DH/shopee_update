import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  Pool,
  Repository,
  SandboxCreateTrialStore,
  migrate,
} from '../../packages/persistence/src/index.js';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import { VariationExecutionService } from '../../apps/api/src/variation-execution.js';
import { SandboxFieldTrialService } from '../../apps/api/src/sandbox-field-trial-service.js';
import {
  planVariationMutation,
  variationBaselineFingerprint,
  type VariationMutationIntent,
} from '../../packages/shopee/src/variation-mutations.js';
import {
  VariationPlatform,
  variationRawFixture,
  type VariationSnapshot,
} from '../fixtures/variation-platform.js';
import { fixtureDraft } from '../helpers/fixtures.js';

const schema = 'test_variation_accept_' + randomUUID().replaceAll('-', '');
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const admin = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: 4,
  connectionTimeoutMillis: 5000,
});
const repo = new Repository(pool),
  connectionId = randomUUID(),
  encryptionKey = Buffer.alloc(32, 49).toString('hex');
const scope = {
  environment: 'sandbox' as const,
  partnerId: '1232297',
  shopId: '227418363',
  connectionRevision: 1,
  capabilityRevision: 1,
};
let platform: VariationPlatform,
  service: VariationExecutionService,
  clock: number,
  schemaCreated = false;
const evidence: Record<string, any> = {
  kind: 'independent-stateful-http-pg-variation-acceptance',
  schema,
  externalRequests: 0,
  cases: [],
};
const artifact = '.local/acceptance-20260914/variation-qc/independent-variation-acceptance.json';

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await migrate(pool);
  await repo.saveProduct({ ...fixtureDraft(), productKey: 'isolated-protected-listing' }, 0);
  const box = new SecretBox(encryptionKey),
    owner = 'sandbox:1232297:227418363';
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,revision,capability_revision,partner_key_ciphertext,token_ciphertext) VALUES($1,'sandbox','1232297','227418363','Independent variation fixture','connected',1,1,$2,$3)",
    [
      connectionId,
      box.seal({ partnerKey: 'isolated-fixture-partner-key' }, owner),
      box.seal({ accessToken: 'isolated-fixture-access-token' }, owner),
    ],
  );
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE variation_operations, prepared_wire_operations, sandbox_field_trials, sandbox_create_trials, sandbox_listing_runs CASCADE',
  );
  await pool.query('UPDATE connections SET revision=1,capability_revision=1 WHERE id=$1', [
    connectionId,
  ]);
  clock = Date.now();
  reset(1);
});
afterAll(async () => {
  try {
    await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    evidence.schemaRemoved = true;
    await mkdir('.local/acceptance-20260914/variation-qc', { recursive: true });
    await writeFile(artifact, JSON.stringify(evidence, null, 2));
  } finally {
    await admin.end();
  }
});
function reset(tiers: 0 | 1 | 2) {
  platform = new VariationPlatform(variationRawFixture(tiers));
  service = new VariationExecutionService(repo, {
    allowedShops: [{ partnerId: scope.partnerId, shopId: scope.shopId }],
    encryptionKey,
    transport: platform.fetch,
    now: () => new Date(clock),
    pause: async (ms) => {
      clock += ms;
    },
    readbackDelaysMs: [0, 0],
  });
}
function context(raw = platform.read()): Parameters<typeof planVariationMutation>[1] {
  return {
    scope,
    baseline: raw,
    promotionSnapshot: {
      error: '',
      response: { success_list: [{ item_id: raw.item.item_id, promotion: [] }], failure_list: [] },
    },
    itemLimits: {
      price_limit: { min_limit: 1, max_limit: 999999 },
      stock_limit: { min_limit: 0, max_limit: 999 },
      tier_variation_name_length_limit: { min_limit: 1, max_limit: 100 },
      tier_variation_option_length_limit: { min_limit: 1, max_limit: 100 },
      gtin_limit: { gtin_validation_rule: 'Optional' },
    },
    allowedLocationIds: ['QA-W1'],
    resolvedImageIds: ['option-source-0', 'option-source-1', 'new-option-image'],
    maxVariationPriceRatio: { value: 5, source: 'fixture-authored-explicit-shop-ratio-limit' },
  };
}
function intent(raw = platform.read()): VariationMutationIntent {
  return {
    version: 1,
    itemId: String(raw.item.item_id),
    baselineFingerprint: variationBaselineFingerprint(raw),
    source: {
      key: 'QA-VARIATION-SOURCE',
      digest: 'd'.repeat(64),
      refs: ['fixture:explicit-variation-command-v1'],
    },
    tiers: raw.models.tier_variation.map((tier) => ({
      name: tier.name,
      options: tier.option_list.map((option: any, index: number) => ({
        previousIndex: index,
        name: option.option,
      })),
    })),
    retained: raw.models.model.map((model) => ({
      modelId: String(model.model_id),
      tierIndex: [...model.tier_index],
    })),
    removedModelIds: [],
    added: [],
  };
}
async function prepare(command: VariationMutationIntent) {
  const input = { id: randomUUID(), connectionId, scope, intent: command, context: context() };
  const job = await service.prepare(input);
  expect(job.state, JSON.stringify(job.plan)).toBe('prepared');
  return { input, job };
}
function sortedModels(raw: VariationSnapshot) {
  return [...raw.models.model].sort((a, b) => a.model_id - b.model_id);
}
function protectItem(before: VariationSnapshot, after: VariationSnapshot, allowHasModel = false) {
  const expected = structuredClone(before.item);
  if (allowHasModel) expected.has_model = after.item.has_model;
  expect(after.item).toEqual(expected);
}
function protectKeeper(
  before: Record<string, any>,
  after: Record<string, any>,
  expectedIndex: number[],
  expectedName: string,
) {
  expect(after).toEqual({ ...before, tier_index: expectedIndex, model_name: expectedName });
}
async function record(name: string, result: any, before: VariationSnapshot) {
  evidence.cases.push({
    name,
    operationId: result.id,
    state: result.state,
    before,
    after: platform.read(),
    steps: result.steps,
    writes: structuredClone(platform.writes),
  });
  await mkdir('.local/acceptance-20260914/variation-qc', { recursive: true });
  await writeFile(artifact, JSON.stringify(evidence, null, 2));
}

it.each([1, 2] as const)(
  'renames tier/option at %i tiers while preserving every keeper ID, price, stock and extra field',
  async (tierCount) => {
    reset(tierCount);
    const before = platform.read(),
      command = intent();
    command.tiers[0]!.name = 'Màu đã xác nhận';
    command.tiers[0]!.options[0]!.name = 'Cam nhạt';
    const { job } = await prepare(command),
      result = await service.run(job.id),
      after = platform.read();
    expect(result.state, JSON.stringify(result.result)).toBe('verified');
    protectItem(before, after);
    for (const old of before.models.model) {
      const current = after.models.model.find((model) => model.model_id === old.model_id)!;
      const labels = old.tier_index.map(
        (index: number, tier: number) => command.tiers[tier]!.options[index]!.name,
      );
      protectKeeper(old, current, old.tier_index, labels.join(','));
    }
    expect(platform.writes.map((write) => write.path)).toEqual([
      '/api/v2/product/update_tier_variation',
    ]);
    await service.run(job.id);
    expect(platform.writes).toHaveLength(1);
    await record(`rename-${tierCount}-tier`, result, before);
  },
);

it.each([1, 2] as const)(
  'reorders %i tiers by explicit retained IDs rather than response array positions',
  async (tierCount) => {
    reset(tierCount);
    const before = platform.read(),
      command = intent();
    for (const tier of command.tiers) tier.options.reverse();
    for (const kept of command.retained) kept.tierIndex = kept.tierIndex.map((index) => 1 - index);
    platform.state.models.model.reverse();
    const { job } = await prepare(command),
      result = await service.run(job.id),
      after = platform.read();
    expect(result.state).toBe('verified');
    protectItem(before, after);
    for (const old of before.models.model)
      protectKeeper(
        old,
        after.models.model.find((model) => model.model_id === old.model_id)!,
        old.tier_index.map((index: number) => 1 - index),
        old.model_name,
      );
    await record(`reorder-${tierCount}-tier`, result, before);
  },
);

function appendIntent() {
  const command = intent();
  command.tiers[0]!.options.splice(1, 0, {
    previousIndex: null,
    name: 'Tím từ nguồn',
    imageId: 'new-option-image',
  });
  for (const kept of command.retained) if (kept.tierIndex[0] === 1) kept.tierIndex[0] = 2;
  command.added =
    command.tiers.length === 1
      ? [
          {
            sku: 'QA-NEW-PURPLE',
            tierIndex: [1],
            originalPrice: 28700,
            stock: 0,
            locationId: 'QA-W1',
          },
        ]
      : [
          {
            sku: 'QA-NEW-PURPLE-80',
            tierIndex: [1, 0],
            originalPrice: 28700,
            stock: 0,
            locationId: 'QA-W1',
          },
          {
            sku: 'QA-NEW-PURPLE-120',
            tierIndex: [1, 1],
            originalPrice: 31900,
            stock: 17,
            locationId: 'QA-W1',
          },
        ];
  return command;
}
it.each([1, 2] as const)(
  'inserts a middle option at %i tiers and then adds only source-specified SKUs/prices/stock',
  async (tierCount) => {
    reset(tierCount);
    const before = platform.read(),
      command = appendIntent(),
      { job } = await prepare(command),
      result = await service.run(job.id),
      after = platform.read();
    expect(result.state, JSON.stringify(result)).toBe('verified');
    expect(platform.writes.map((write) => write.path)).toEqual([
      '/api/v2/product/update_tier_variation',
      '/api/v2/product/add_model',
    ]);
    protectItem(before, after);
    for (const old of before.models.model) {
      const kept = command.retained.find((entry) => entry.modelId === String(old.model_id))!;
      protectKeeper(
        old,
        after.models.model.find((model) => model.model_id === old.model_id)!,
        kept.tierIndex,
        old.model_name,
      );
    }
    for (const source of command.added) {
      const model = after.models.model.find((entry) => entry.model_sku === source.sku)!;
      expect(model).toBeDefined();
      expect(before.models.model.some((entry) => entry.model_id === model.model_id)).toBe(false);
      expect(model.tier_index).toEqual(source.tierIndex);
      expect(model.price_info[0]).toEqual({
        currency: 'VND',
        original_price: source.originalPrice,
        current_price: source.originalPrice,
      });
      expect(model.stock_info_v2.seller_stock[0]).toMatchObject({
        location_id: 'QA-W1',
        stock: source.stock,
      });
    }
    await service.run(job.id);
    expect(platform.writes).toHaveLength(2);
    await record(`append-${tierCount}-tier`, result, before);
  },
);

it.each([1, 2] as const)(
  'removes an explicit option at %i tiers and keeps remaining model records intact',
  async (tierCount) => {
    reset(tierCount);
    const before = platform.read(),
      command = intent();
    command.tiers[0]!.options.splice(0, 1);
    command.removedModelIds = command.retained
      .filter((entry) => entry.tierIndex[0] === 0)
      .map((entry) => entry.modelId);
    command.retained = command.retained
      .filter((entry) => entry.tierIndex[0] === 1)
      .map((entry) => ({ ...entry, tierIndex: [0, ...entry.tierIndex.slice(1)] }));
    const { job } = await prepare(command),
      result = await service.run(job.id),
      after = platform.read();
    expect(result.state, JSON.stringify(result.result)).toBe('verified');
    expect(sortedModels(after).map((model) => String(model.model_id))).toEqual(
      command.retained.map((entry) => entry.modelId).sort(),
    );
    protectItem(before, after);
    for (const kept of command.retained) {
      const old = before.models.model.find((model) => String(model.model_id) === kept.modelId)!;
      protectKeeper(
        old,
        after.models.model.find((model) => String(model.model_id) === kept.modelId)!,
        kept.tierIndex,
        old.model_name,
      );
    }
    await record(`remove-${tierCount}-tier`, result, before);
  },
);

it('blocks missing explicit removal and stale imported baseline before any write', async () => {
  const command = intent();
  command.tiers[0]!.options.pop();
  command.retained.pop();
  const invalid = await service.prepare({
    id: randomUUID(),
    connectionId,
    scope,
    intent: command,
    context: context(),
  });
  expect(invalid.state).toBe('blocked');
  expect(platform.writes).toHaveLength(0);
  const valid = intent();
  valid.tiers[0]!.options[0]!.name = 'Cam mới';
  const { job } = await prepare(valid);
  platform.state.models.model[0]!.stock_info_v2.seller_stock[0].stock -= 1;
  platform.state.models.model[0]!.stock_info_v2.summary_info.total_available_stock -= 1;
  const result = await service.run(job.id);
  expect(result.state).toBe('blocked');
  expect(result.result.code).toBe('VARIATION_BASELINE_CHANGED');
  expect(platform.writes).toHaveLength(0);
});

it('detects external stock drift after preflight without overwriting it or advancing the next stage', async () => {
  const before = platform.read(),
    command = appendIntent(),
    { job } = await prepare(command);
  platform.beforeWrite = async () => {
    platform.beforeWrite = undefined;
    platform.state.models.model[0]!.stock_info_v2.seller_stock[0].stock = 1;
    platform.state.models.model[0]!.stock_info_v2.summary_info.total_available_stock = 1;
  };
  const result = await service.run(job.id);
  expect(result.state).toBe('unknown');
  expect(platform.writes).toHaveLength(1);
  expect(
    platform.state.models.model.find((row) => row.model_id === 880001)!.stock_info_v2
      .seller_stock[0].stock,
  ).toBe(1);
  await service.run(job.id);
  expect(platform.writes).toHaveLength(1);
  await record('stock-drift-between-preflight-and-write', result, before);
});

it('keeps HTTP200 partial add unknown and never repeats the add or rewrites the first verified stage', async () => {
  reset(2);
  const before = platform.read(),
    command = appendIntent(),
    { job } = await prepare(command);
  platform.fault = { path: '/api/v2/product/add_model', kind: 'partial_add' };
  const result = await service.run(job.id);
  expect(result.state, JSON.stringify(result)).toBe('unknown');
  expect(result.steps.map((step: any) => step.state)).toEqual(['verified', 'unknown']);
  expect(platform.state.models.model).toHaveLength(5);
  expect(
    platform.state.models.model.filter((model) => String(model.model_sku).startsWith('QA-NEW-')),
  ).toHaveLength(1);
  platform.fault = undefined;
  await service.run(job.id);
  expect(platform.writes).toHaveLength(2);
  await record('partial-add-http200', result, before);
});

it('does not replay a committed structural write after its response is lost', async () => {
  const before = platform.read(),
    command = intent();
  command.tiers[0]!.options[0]!.name = 'Cam đổi có nguồn';
  const { job } = await prepare(command);
  platform.fault = { path: '/api/v2/product/update_tier_variation', kind: 'lose_after_commit' };
  const result = await service.run(job.id);
  expect(result.state).toBe('unknown');
  platform.fault = undefined;
  await service.run(job.id);
  expect(platform.writes).toHaveLength(1);
  expect(platform.state.models.tier_variation[0]!.option_list[0].option).toBe('Cam đổi có nguồn');
  await record('lost-response-after-structural-commit', result, before);
});

it('resumes only the never-sent add after a persisted crash between verified stages', async () => {
  const before = platform.read(),
    command = appendIntent(),
    { job } = await prepare(command);
  if (job.plan.kind !== 'ready') throw new Error('expected ready plan');
  const stage = job.plan.steps[0]!;
  const response = await platform.fetch(
    'https://openplatform.sandbox.test-stable.shopee.sg' + stage.path,
    { method: 'POST', body: JSON.stringify(stage.payload) },
  );
  const receipt = await response.json(),
    after = platform.read();
  protectItem(before, after);
  expect(after.models.model).toHaveLength(before.models.model.length);
  for (const old of before.models.model) {
    const retained = command.retained.find((entry) => entry.modelId === String(old.model_id))!;
    protectKeeper(
      old,
      after.models.model.find((entry) => entry.model_id === old.model_id)!,
      retained.tierIndex,
      old.model_name,
    );
  }
  expect(after.models.tier_variation[0]!.option_list.map((option: any) => option.option)).toEqual([
    'Cam',
    'Tím từ nguồn',
    'Xanh',
  ]);
  await pool.query(
    "INSERT INTO variation_steps(operation_id,ordinal,path,payload,before_snapshot,state,receipt,qc,after_snapshot,sent_at,verified_at) VALUES($1,0,$2,$3,$4,'verified',$5,$6,$7,$8,$8)",
    [
      job.id,
      stage.path,
      stage.payload,
      before,
      receipt,
      { state: 'verified' },
      after,
      new Date(clock),
    ],
  );
  await pool.query(
    "UPDATE variation_operations SET state='running',claim_id=$2,lease_until=$3 WHERE id=$1",
    [job.id, randomUUID(), new Date(clock - 1000)],
  );
  const result = await service.run(job.id);
  expect(result.state, JSON.stringify(result)).toBe('verified');
  expect(platform.writes.map((write) => write.path)).toEqual([
    '/api/v2/product/update_tier_variation',
    '/api/v2/product/add_model',
  ]);
  await record('persisted-between-stage-crash', result, before);
});

it('keeps an expired sent-stage crash quarantined without guessing whether the server committed', async () => {
  const command = intent();
  command.tiers[0]!.options[0]!.name = 'Cam sau gián đoạn';
  const { job } = await prepare(command);
  if (job.plan.kind !== 'ready') throw new Error('expected ready plan');
  const stage = job.plan.steps[0]!;
  await pool.query(
    "INSERT INTO variation_steps(operation_id,ordinal,path,payload,before_snapshot,state,sent_at) VALUES($1,0,$2,$3,$4,'sent',$5)",
    [job.id, stage.path, stage.payload, platform.read(), new Date(clock)],
  );
  await pool.query(
    "UPDATE variation_operations SET state='running',claim_id=$2,lease_until=$3 WHERE id=$1",
    [job.id, randomUUID(), new Date(clock - 1000)],
  );
  expect((await service.run(job.id)).state).toBe('unknown');
  expect(platform.writes).toHaveLength(0);
});

it('rejects protected target or mismatched shop and never touches a real transport', async () => {
  const command = intent();
  command.itemId = '803934364';
  await expect(
    service.prepare({ id: randomUUID(), connectionId, scope, intent: command, context: context() }),
  ).rejects.toThrow('VARIATION_PROTECTED_ITEM');
  command.itemId = '970001';
  await expect(
    service.prepare({
      id: randomUUID(),
      connectionId,
      scope: { ...scope, shopId: '1' },
      intent: command,
      context: context(),
    }),
  ).rejects.toThrow();
  assert.equal(platform.calls.length, 0);
});

it.each([
  [0, 1],
  [0, 2],
  [1, 2],
  [2, 1],
  [1, 0],
  [2, 0],
] as const)(
  'explicitly replaces %i tiers with %i tiers, rebinds every generated ID and retains item content',
  async (from, to) => {
    reset(from);
    const before = platform.read(),
      command = intent();
    command.replaceAllModels = true;
    command.removedModelIds =
      from === 0 ? ['0'] : before.models.model.map((model) => String(model.model_id));
    command.retained = [];
    command.tiers = ['Màu mới có nguồn', 'Quy cách mới có nguồn']
      .slice(0, to)
      .map((name, tier) => ({
        name,
        options: (tier === 0 ? ['Tím', 'Đỏ'] : ['Gói 1', 'Gói 2']).map((name, index) => ({
          previousIndex: null,
          name,
          ...(tier === 0 ? { imageId: `option-source-${index}` } : {}),
        })),
      }));
    command.added = Array.from({ length: to === 0 ? 1 : 2 ** to }, (_, index) => ({
      sku: to === 0 ? before.item.item_sku : `QA-REPLACED-${from}-${to}-${index}`,
      tierIndex: to === 0 ? [] : to === 1 ? [index] : [Math.floor(index / 2), index % 2],
      originalPrice: 26000 + index * 3100,
      stock: index === 0 ? 0 : 9 + index,
      locationId: 'QA-W1',
    }));
    const { job } = await prepare(command),
      result = await service.run(job.id),
      after = platform.read();
    expect(result.state, JSON.stringify(result)).toBe('verified');
    expect(platform.writes.map((write) => write.path)).toEqual([
      '/api/v2/product/init_tier_variation',
    ]);
    expect(after.item.has_model).toBe(to > 0);
    const itemBefore = structuredClone(before.item),
      itemAfter = structuredClone(after.item);
    for (const field of ['has_model', 'price_info', 'stock_info_v2', 'gtin_code']) {
      delete itemBefore[field];
      delete itemAfter[field];
    }
    expect(itemAfter).toEqual(itemBefore);
    if (to === 0) {
      expect(after.models.model).toEqual([]);
      expect(after.models.tier_variation).toEqual([]);
      expect(after.models.standardise_tier_variation).toBeUndefined();
      expect(after.item.price_info[0]).toEqual({
        currency: 'VND',
        original_price: 26000,
        current_price: 26000,
      });
      expect(after.item.stock_info_v2.seller_stock[0]).toMatchObject({
        stock: 0,
        location_id: 'QA-W1',
      });
    } else {
      expect(after.models.model).toHaveLength(command.added.length);
      expect(after.item.price_info).toBeUndefined();
      expect(after.item.stock_info_v2).toBeUndefined();
      for (const source of command.added) {
        const model = after.models.model.find((candidate) => candidate.model_sku === source.sku)!;
        expect(model).toBeDefined();
        expect(before.models.model.some((old) => old.model_id === model.model_id)).toBe(false);
        expect(model.tier_index).toEqual(source.tierIndex);
        expect(model.price_info[0]).toEqual({
          currency: 'VND',
          original_price: source.originalPrice,
          current_price: source.originalPrice,
        });
        expect(model.stock_info_v2.seller_stock[0]).toMatchObject({
          stock: source.stock,
          location_id: 'QA-W1',
        });
      }
    }
    await service.run(job.id);
    expect(platform.writes).toHaveLength(1);
    await record(`replace-${from}-to-${to}`, result, before);
  },
);

it('deletes one explicit model while leaving both option dimensions and every keeper unchanged', async () => {
  reset(2);
  const before = platform.read(),
    command = intent();
  command.removedModelIds = ['880001'];
  command.retained = command.retained.filter((model) => model.modelId !== '880001');
  const { job } = await prepare(command),
    result = await service.run(job.id),
    after = platform.read();
  expect(result.state, JSON.stringify(result)).toBe('verified');
  expect(platform.writes.map((write) => write.path)).toEqual(['/api/v2/product/delete_model']);
  const expected = structuredClone(before);
  expected.models.model = expected.models.model.filter((model) => model.model_id !== 880001);
  expect(after).toEqual(expected);
  await record('delete-one-model-options-retained', result, before);
});

it('blocks a newly scheduled promotion after preparation, even while current-price/ongoing flags remain unchanged', async () => {
  const command = appendIntent(),
    { job } = await prepare(command);
  platform.promotions = [
    { promotion_type: 'DiscountPromotion', start_time: Math.floor(clock / 1000) + 3600 },
  ];
  const result = await service.run(job.id);
  expect(result.state).toBe('blocked');
  expect(platform.writes).toHaveLength(0);
});

it('keeps a missing fulfillment flag unresolved instead of treating absence as false', async () => {
  delete platform.state.models.model[0]!.is_fulfillment_by_shopee;
  const command = intent();
  command.tiers[0]!.options[0]!.name = 'Cam từ nguồn';
  const result = await service.prepare({
    id: randomUUID(),
    connectionId,
    scope,
    intent: command,
    context: context(),
  });
  expect(result.state).toBe('blocked');
  expect(platform.writes).toHaveLength(0);
});

it('two concurrent workers cannot send the same operation twice', async () => {
  const command = intent();
  command.tiers[0]!.options[0]!.name = 'Cam đồng thời';
  const { job } = await prepare(command);
  await Promise.all([service.run(job.id), service.run(job.id)]);
  expect((await service.get(job.id)).state).toBe('verified');
  expect(platform.writes).toHaveLength(1);
});

async function legacyCreate() {
  const store = new SandboxCreateTrialStore(pool, { now: () => new Date(clock) });
  const key = 'SBX-BULK-LANE-' + randomUUID();
  const trial = await store.submit(
    {
      trialKey: key,
      connectionId,
      connectionRevision: 1,
      items: [
        {
          sourceKey: key,
          create: {
            item_sku: key,
            item_name: 'SANDBOX QA independent lane source',
            item_status: 'UNLIST',
            category_id: 301378,
            description_type: 'normal',
            description: 'SANDBOX ONLY exact source',
            original_price: 21000,
            seller_stock: [{ stock: 0, location_id: 'QA-W1' }],
          },
        },
      ],
    },
    { source: 'independent-cross-executor-fixture', observedAt: new Date(clock).toISOString() },
  );
  return { store, trial };
}

async function claimWhenReady(store: SandboxCreateTrialStore, workerId: string) {
  // Independent schemas still share database advisory locks. A worker's try-lock may miss
  // a short reservation held by another suite, so use its normal bounded polling behavior.
  const deadline = Date.now() + 8000;
  do {
    const claim = await store.claim(workerId);
    if (claim) return claim;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error('An otherwise-ready isolated legacy job could not claim its mutation lane');
}

async function legacyField() {
  const trialId = randomUUID(),
    trialItemId = randomUUID();
  platform.state.item.item_sku = 'SBX-BULK-FIELD-LANE';
  const snapshot = platform.read();
  await pool.query(
    'INSERT INTO sandbox_create_trials(id,trial_key,connection_id,connection_revision,fingerprint,manifest,evidence) VALUES($1,$2,$3,1,$4,$5,$6)',
    [
      trialId,
      'SBX-BULK-BOUND-' + trialId,
      connectionId,
      'fixture-binding',
      {},
      { source: 'historical-created-item-fixture' },
    ],
  );
  await pool.query(
    "INSERT INTO sandbox_create_trial_items(id,trial_id,connection_id,source_key,position,intent,state,stage,item_id,result) VALUES($1,$2,$3,$4,0,$5,'verified','done',$6,$7)",
    [
      trialItemId,
      trialId,
      connectionId,
      snapshot.item.item_sku,
      {
        create: {
          item_sku: snapshot.item.item_sku,
          category_id: snapshot.item.category_id,
          image: snapshot.item.image,
        },
        tiers: {
          model: snapshot.models.model.map((model) => ({
            model_sku: model.model_sku,
            tier_index: model.tier_index,
          })),
        },
      },
      String(snapshot.item.item_id),
      { evidence: { models: snapshot.models } },
    ],
  );
  const executor = new SandboxFieldTrialService(repo, {
    transport: platform.fetch,
    encryptionKey,
    pause: async () => {},
  });
  const job = await executor.prepare({
    id: randomUUID(),
    trialItemId,
    connectionRevision: 1,
    operation: { kind: 'title', value: 'SANDBOX QA title from the independent source' },
  });
  expect(job.state).toBe('prepared');
  return { executor, job };
}

function mutationBarrier(path: string) {
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let timer: ReturnType<typeof setTimeout>;
  const atWrite = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('The actual executor never reached the expected POST boundary')),
      5000,
    );
    reached = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  platform.beforeWrite = async (actual) => {
    if (actual !== path) return;
    reached();
    await held;
  };
  return {
    atWrite,
    release: () => {
      clearTimeout(timer);
      release();
    },
  };
}

it.each(['running', 'unknown'] as const)(
  'an actual legacy create %s reservation prevents the new variation executor from writing',
  async (state) => {
    const { store } = await legacyCreate(),
      claim = await claimWhenReady(store, 'legacy-lane-worker');
    expect(claim).not.toBeNull();
    const attemptId = await store.beginMutation(claim!, 'create_intent', claim!.intent.create);
    expect(attemptId).not.toBeNull();
    if (state === 'unknown')
      await store.finishMutation(claim!, attemptId!, {
        kind: 'unknown',
        code: 'FIXTURE_LOST_RESPONSE',
      });
    const command = intent();
    command.tiers[0]!.options[0]!.name = 'Cam lệnh mới';
    const { job } = await prepare(command),
      result = await service.run(job.id);
    expect(result.state).toBe('prepared');
    expect(result.steps).toEqual([]);
    expect(platform.writes).toHaveLength(0);
    expect((await store.get(claim!.trialId))!.items[0]!.state).toBe(state);
  },
);

it('a running new variation blocks actual legacy create claim, and verified completion releases it', async () => {
  const { store } = await legacyCreate();
  const command = intent();
  command.tiers[0]!.options[0]!.name = 'Cam riêng mới';
  const { job } = await prepare(command),
    barrier = mutationBarrier('/api/v2/product/update_tier_variation');
  const running = service.run(job.id);
  try {
    await barrier.atWrite;
    expect((await service.get(job.id)).state).toBe('running');
    expect(await store.claim('legacy-during-new-write')).toBeNull();
  } finally {
    barrier.release();
    await running;
  }
  expect((await service.get(job.id)).state).toBe('verified');
  expect(await claimWhenReady(store, 'legacy-after-new-verified')).not.toBeNull();
  expect(platform.writes).toHaveLength(1);
});

it('an unknown new variation prevents legacy create claim without replaying either write', async () => {
  const { store } = await legacyCreate();
  const command = intent();
  command.tiers[0]!.options[0]!.name = 'Cam phản hồi mất';
  const { job } = await prepare(command);
  platform.fault = { path: '/api/v2/product/update_tier_variation', kind: 'lose_after_commit' };
  expect((await service.run(job.id)).state).toBe('unknown');
  expect(await store.claim('legacy-after-unknown')).toBeNull();
  await service.run(job.id);
  expect(platform.writes).toHaveLength(1);
});

it('an actual legacy field write holds the lane before POST, then its terminal result releases the new path', async () => {
  const { executor, job: field } = await legacyField();
  const command = intent();
  command.tiers[0]!.options[0]!.name = 'Cam khi đổi tên';
  const { job } = await prepare(command),
    barrier = mutationBarrier('/api/v2/product/update_item');
  const running = executor.execute({ id: field.id, fingerprint: field.fingerprint });
  try {
    await barrier.atWrite;
    expect((await executor.get(field.id)).state).toBe('unknown');
    expect((await service.run(job.id)).state).toBe('prepared');
    expect(platform.writes).toHaveLength(0);
  } finally {
    barrier.release();
    await running;
  }
  expect((await executor.get(field.id)).state).toBe('verified');
  const fresh = intent();
  fresh.tiers[0]!.options[0]!.name = 'Cam sau tên nguồn mới';
  const next = await prepare(fresh);
  expect((await service.run(next.job.id)).state).toBe('verified');
  expect(platform.writes.map((write) => write.path)).toEqual([
    '/api/v2/product/update_item',
    '/api/v2/product/update_tier_variation',
  ]);
});

it('the new running variation prevents the actual legacy field execute boundary from sending', async () => {
  const { executor, job: field } = await legacyField();
  const command = intent();
  command.tiers[0]!.options[0]!.name = 'Cam mới đang chạy';
  const { job } = await prepare(command),
    barrier = mutationBarrier('/api/v2/product/update_tier_variation');
  const running = service.run(job.id);
  try {
    await barrier.atWrite;
    await expect(
      executor.execute({ id: field.id, fingerprint: field.fingerprint }),
    ).rejects.toThrow('FIELD_SHOP_BUSY');
    expect((await executor.get(field.id)).state).toBe('prepared');
    expect(platform.writes).toHaveLength(0);
  } finally {
    barrier.release();
    await running;
  }
  expect(platform.writes.map((write) => write.path)).toEqual([
    '/api/v2/product/update_tier_variation',
  ]);
});

it('a new unknown variation blocks the legacy field even when the source snapshot has not changed', async () => {
  const { executor, job: field } = await legacyField();
  const command = intent();
  command.tiers[0]!.options[0]!.name = 'Cam lỗi trước ghi';
  const { job } = await prepare(command);
  platform.fault = { path: '/api/v2/product/update_tier_variation', kind: 'reject_before_commit' };
  expect((await service.run(job.id)).state).toBe('unknown');
  await expect(executor.execute({ id: field.id, fingerprint: field.fingerprint })).rejects.toThrow(
    'FIELD_SHOP_BUSY',
  );
  expect((await executor.get(field.id)).state).toBe('prepared');
  expect(platform.writes).toHaveLength(0);
});

it('an unknown row owned by another shop blocks neither fixed TEST variation nor legacy create', async () => {
  const otherConnection = randomUUID();
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,revision,capability_revision) VALUES($1,'sandbox','1232297','99123456','Isolated other owner','connected',1,1)",
    [otherConnection],
  );
  await pool.query(
    "INSERT INTO variation_operations(id,connection_id,owner_key,fingerprint,input,plan,state,result) VALUES($1,$2,'sandbox:1232297:99123456',$3,$4,$5,'unknown',$6)",
    [
      randomUUID(),
      otherConnection,
      randomUUID(),
      { isolatedOtherShopCheckpoint: true },
      {},
      { code: 'OTHER_SHOP_CHECKPOINT' },
    ],
  );
  const { store } = await legacyCreate();
  const command = intent();
  command.tiers[0]!.options[0]!.name = 'Cam owner độc lập';
  const { job } = await prepare(command);
  expect((await service.run(job.id)).state).toBe('verified');
  expect(await claimWhenReady(store, 'legacy-independent-owner')).not.toBeNull();
  expect(platform.writes).toHaveLength(1);
});

it.each([
  ['in_flight', true],
  ['unknown', true],
  ['in_flight', false],
  ['unknown', false],
] as const)(
  'a persisted legacy listing %s checkpoint reserves only its actual owner (same owner: %s)',
  async (state, sameOwner) => {
    const listingRunId = randomUUID();
    let listingConnection = connectionId;
    if (!sameOwner) {
      listingConnection = randomUUID();
      await pool.query(
        "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,revision,capability_revision) VALUES($1,'sandbox','1232297',$2,'Authored historical checkpoint owner','connected',1,1)",
        [listingConnection, state === 'in_flight' ? '99123457' : '99123458'],
      );
    }
    const historical = {
      fixtureOnly: true,
      code: 'UNRESOLVED_HISTORICAL_LISTING',
      source: 'independent-private-schema',
    };
    await pool.query(
      "INSERT INTO sandbox_listing_runs(id,connection_id,item_id,product_key,source_revision,connection_revision,input_fingerprint,state,intent,body) VALUES($1,$2,'803934364','isolated-protected-listing',1,1,'independent-protected-checkpoint',$3,$4,$4)",
      [listingRunId, listingConnection, state, historical],
    );
    const protectedBefore = (
      await pool.query('SELECT * FROM sandbox_listing_runs WHERE id=$1', [listingRunId])
    ).rows[0];
    const { store } = await legacyCreate();
    const command = intent();
    command.tiers[0]!.options[0]!.name = 'Cam kiểm shop đang giữ';
    const { job } = await prepare(command),
      result = await service.run(job.id);
    if (sameOwner) {
      expect(result.state).toBe('prepared');
      expect(result.steps).toEqual([]);
      expect(await store.claim('legacy-protected-owner')).toBeNull();
      expect(platform.writes).toHaveLength(0);
    } else {
      expect(result.state).toBe('verified');
      expect(await claimWhenReady(store, 'legacy-other-checkpoint-owner')).not.toBeNull();
      expect(platform.writes).toHaveLength(1);
    }
    expect(
      (await pool.query('SELECT * FROM sandbox_listing_runs WHERE id=$1', [listingRunId])).rows[0],
    ).toEqual(protectedBefore);
  },
);
