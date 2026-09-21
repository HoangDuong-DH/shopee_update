import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { SellerKnowledgeService } from '../../apps/api/src/seller-knowledge-service.js';

const schema = 'test_seller_knowledge_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function fixture(count = 3) {
  const connectionId = randomUUID(),
    calls: { path: string; query: Record<string, string> }[] = [];
  await pool.query(
    `INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at) VALUES($1,'production','9',$2,'Shop tri thức','connected',now()+interval '1 hour')`,
    [connectionId, String(Math.floor(Math.random() * 1e9))],
  );
  const read = async (_scope: unknown, path: string, query: Record<string, string>) => {
    calls.push({ path, query });
    let response: any = {};
    if (path.endsWith('get_item_list'))
      response = {
        item:
          query.item_status === 'NORMAL'
            ? Array.from({ length: count }, (_, i) => ({
                item_id: i + 1,
                item_status: 'NORMAL',
                update_time: 100,
              }))
            : [],
        has_next_page: false,
        total_count: count,
      };
    if (path.endsWith('get_item_base_info'))
      response = {
        item_list: query.item_id_list!.split(',').map((id) => ({
          item_id: Number(id),
          item_name: 'Tinh dầu ' + id,
          item_sku: 'P' + id,
          category_id: 12,
          brand: { brand_id: 3 },
          item_status: 'NORMAL',
          update_time: 100,
          has_model: true,
          attribute_list: [
            {
              attribute_id: 7,
              attribute_value_list: [{ value_id: 8, original_value_name: 'Việt Nam' }],
            },
          ],
        })),
      };
    if (path.endsWith('get_model_list'))
      response = {
        model: [{ model_id: 10, model_sku: 'SKU' + query.item_id }],
        tier_variation: [],
      };
    if (path.endsWith('get_category'))
      response = {
        category_list: [
          {
            category_id: 12,
            parent_category_id: 0,
            display_category_name: 'Tinh dầu',
            has_children: false,
          },
        ],
      };
    if (path.endsWith('get_attribute_tree'))
      response = {
        list: [
          {
            category_id: 12,
            attribute_tree: [
              {
                attribute_id: 7,
                mandatory: true,
                attribute_value_list: [{ value_id: 8, name: 'Việt Nam' }],
              },
            ],
          },
        ],
      };
    return { kind: 'success' as const, response, requestId: randomUUID() };
  };
  const options = { read, sleep: async () => {}, autoRun: false };
  return { connectionId, calls, options, service: new SellerKnowledgeService(repo, options) };
}
it('persists a bounded cursor, resumes after restart and caches unchanged model SKUs without a writer', async () => {
  const f = await fixture(),
    job = await f.service.startSync({
      connectionId: f.connectionId,
      requestId: randomUUID(),
      maxItems: 2,
    });
  await f.service.runSync(job.id);
  expect(await f.service.getSync(job.id)).toMatchObject({
    state: 'paused',
    code: 'KNOWLEDGE_BATCH_LIMIT',
    processedCount: 2,
    canResume: true,
  });
  const restarted = new SellerKnowledgeService(repo, f.options);
  await restarted.runSync(job.id);
  expect(await restarted.getSync(job.id)).toMatchObject({ state: 'complete', processedCount: 3 });
  const rows = await restarted.search({ connectionId: f.connectionId, query: 'tinh dau' });
  expect(rows).toHaveLength(3);
  expect(rows[0]!.modelSkus).toHaveLength(1);
  const modelReads = f.calls.filter((c) => c.path.endsWith('get_model_list')).length;
  const second = await restarted.startSync({
    connectionId: f.connectionId,
    requestId: randomUUID(),
  });
  await restarted.runSync(second.id);
  expect(f.calls.filter((c) => c.path.endsWith('get_model_list'))).toHaveLength(modelReads);
  expect((await restarted.getSync(second.id))!.reusedCount).toBe(3);
});
it('deduplicates the exact request and rejects request reuse with different scope or bounds', async () => {
  const f = await fixture(),
    requestId = randomUUID(),
    input = { connectionId: f.connectionId, requestId, maxItems: 2 };
  const job = await f.service.startSync(input);
  expect((await f.service.startSync(input)).id).toBe(job.id);
  await expect(f.service.startSync({ ...input, maxItems: 3 })).rejects.toThrow(
    'KNOWLEDGE_REQUEST_CONFLICT',
  );
});
it('keeps evidence immutable, excludes the target and never mixes another shop', async () => {
  const a = await fixture(),
    b = await fixture();
  const job = await a.service.startSync({ connectionId: a.connectionId, requestId: randomUUID() });
  await a.service.runSync(job.id);
  expect(await b.service.search({ connectionId: b.connectionId })).toEqual([]);
  const candidates = await a.service.getCandidates({
    connectionId: a.connectionId,
    categoryId: 12,
    excludeItemId: '1',
  });
  expect(candidates.map((c) => c.itemId)).not.toContain('1');
  await expect(
    pool.query('UPDATE seller_knowledge_observations SET body=body WHERE id=$1', [
      candidates[0]!.evidenceId,
    ]),
  ).rejects.toThrow('IMMUTABLE_REVISION');
});
it('caches category reads only for the same connection revision and fresh interval', async () => {
  const f = await fixture();
  const first = await f.service.getCategory({ connectionId: f.connectionId, categoryId: 12 });
  expect(first.attributeTree).toHaveLength(1);
  await f.service.getCategory({ connectionId: f.connectionId, categoryId: 12 });
  expect(f.calls.filter((c) => c.path.endsWith('get_attribute_tree'))).toHaveLength(1);
  await pool.query('UPDATE connections SET revision=revision+1 WHERE id=$1', [f.connectionId]);
  await f.service.getCategory({ connectionId: f.connectionId, categoryId: 12 });
  expect(f.calls.filter((c) => c.path.endsWith('get_attribute_tree'))).toHaveLength(2);
});
it('retains a partial checkpoint after bounded transient retries and resumes only unfinished items', async () => {
  const f = await fixture(3),
    original = f.options.read;
  let fail = true,
    attempts = 0;
  f.options.read = async (scope, path, query) => {
    if (path.endsWith('get_model_list') && query.item_id === '2' && fail) {
      attempts++;
      return { kind: 'unknown', code: 'error_rate_limit' } as any;
    }
    return original(scope, path, query);
  };
  const service = new SellerKnowledgeService(repo, f.options),
    job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(job.id);
  expect(attempts).toBe(3);
  expect(await service.getSync(job.id)).toMatchObject({
    state: 'paused',
    code: 'error_rate_limit',
    processedCount: 1,
  });
  fail = false;
  await service.runSync(job.id);
  expect(await service.getSync(job.id)).toMatchObject({ state: 'complete', processedCount: 3 });
  expect(
    f.calls.filter((c) => c.path.endsWith('get_model_list') && c.query.item_id === '1'),
  ).toHaveLength(1);
});
it('records a connection change during a GET and refuses to continue with the old revision', async () => {
  const f = await fixture(),
    original = f.options.read;
  let changed = false;
  f.options.read = async (scope, path, query) => {
    const result = await original(scope, path, query);
    if (!changed) {
      changed = true;
      await pool.query('UPDATE connections SET revision=revision+1 WHERE id=$1', [f.connectionId]);
    }
    return result;
  };
  const service = new SellerKnowledgeService(repo, f.options),
    job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(job.id);
  expect(await service.getSync(job.id)).toMatchObject({
    state: 'paused',
    code: 'KNOWLEDGE_CONNECTION_CHANGED',
    processedCount: 0,
  });
  expect(f.calls).toHaveLength(1);
});
it('prevents simultaneous scans of one connection and never deletes observations for an empty page', async () => {
  const f = await fixture(1),
    original = f.options.read;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  f.options.read = async (scope, path, query) => {
    if (first) {
      first = false;
      entered();
      await held;
    }
    return original(scope, path, query);
  };
  const service = new SellerKnowledgeService(repo, f.options),
    job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  const pending = service.runSync(job.id);
  await started;
  const second = new SellerKnowledgeService(repo, f.options);
  await second.runSync(job.id);
  expect(f.calls).toHaveLength(0);
  release();
  await pending;
  f.options.read = async () => ({
    kind: 'success',
    requestId: randomUUID(),
    response: { item: [], has_next_page: false },
  });
  const empty = new SellerKnowledgeService(repo, f.options),
    next = await empty.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await empty.runSync(next.id);
  expect(await empty.search({ connectionId: f.connectionId })).toHaveLength(1);
});
it('collects each used category once and exposes its human name beside the stored count', async () => {
  const f = await fixture(),
    job = await f.service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await f.service.runSync(job.id);
  expect(f.calls.filter((c) => c.path.endsWith('get_attribute_tree'))).toHaveLength(1);
  expect((await f.service.listShops()).find((s) => s.id === f.connectionId)?.categories).toEqual([
    { id: '12', name: 'Tinh dầu', count: 3 },
  ]);
});
it('does not treat contradictory duplicate item evidence as a valid observation', async () => {
  const f = await fixture(),
    original = f.options.read;
  f.options.read = async (scope, path, query) => {
    const response = await original(scope, path, query);
    if (path.endsWith('get_item_base_info'))
      response.response.item_list.push({ ...response.response.item_list[0], category_id: 999 });
    return response;
  };
  const service = new SellerKnowledgeService(repo, f.options),
    job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(job.id);
  expect(await service.getSync(job.id)).toMatchObject({
    state: 'paused',
    code: 'KNOWLEDGE_BASE_RESPONSE_INVALID',
    processedCount: 0,
  });
  expect(await service.search({ connectionId: f.connectionId })).toHaveLength(0);
});
it('keeps a listing whose status changes between list and base reads out of normal recommendations', async () => {
  const f = await fixture(1),
    original = f.options.read;
  f.options.read = async (scope, path, query) => {
    const response = await original(scope, path, query);
    if (path.endsWith('get_item_base_info')) response.response.item_list[0].item_status = 'BANNED';
    return response;
  };
  const service = new SellerKnowledgeService(repo, f.options),
    job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(job.id);
  expect(await service.getCandidates({ connectionId: f.connectionId, categoryId: 12 })).toEqual([]);
  expect((await service.search({ connectionId: f.connectionId }))[0]?.itemStatus).toBe('BANNED');
});
it('refreshes identical listings after a bounded age without laundering the prior immutable observation time', async () => {
  const f = await fixture(1);
  let now = Date.now();
  await pool.query("UPDATE connections SET expires_at=now()+interval '90 days' WHERE id=$1", [
    f.connectionId,
  ]);
  const service = new SellerKnowledgeService(repo, { ...f.options, now: () => now });
  const first = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(first.id);
  const old = (await service.search({ connectionId: f.connectionId }))[0]!;
  now += 31 * 86400000;
  const second = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(second.id);
  const fresh = (await service.search({ connectionId: f.connectionId }))[0]!;
  expect(f.calls.filter((c) => c.path.endsWith('get_model_list'))).toHaveLength(2);
  expect(fresh.evidenceId).not.toBe(old.evidenceId);
  expect(Date.parse(fresh.observedAt)).toBe(now);
  expect((await service.getEvidence(old.evidenceId))!.observedAt).toBe(old.observedAt);
  expect(
    await service.getCandidates({ connectionId: f.connectionId, categoryId: 12 }),
  ).toHaveLength(1);
});
it('expires combined category evidence at the oldest dependency rather than extending an older tree', async () => {
  const f = await fixture();
  let now = Date.now();
  const service = new SellerKnowledgeService(repo, { ...f.options, now: () => now });
  const first = await service.getCategory({ connectionId: f.connectionId, categoryId: 12 });
  now += 10 * 60000;
  const fresh = await service.getCategory({
    connectionId: f.connectionId,
    categoryId: 12,
    refresh: true,
  });
  expect(fresh.observedAt).toBe(first.observedAt);
  expect(fresh.expiresAt).toBe(first.expiresAt);
});
it('exposes retrieval coverage so an unseen conflict beyond the cap cannot be represented as fully checked', async () => {
  const f = await fixture(3),
    job = await f.service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await f.service.runSync(job.id);
  expect(
    await f.service.getCandidateCoverage({
      connectionId: f.connectionId,
      categoryId: 12,
      excludeItemId: '1',
    }),
  ).toEqual({ totalCount: 2, limit: 100, truncated: false });
});
it.each([
  ['blank', ''],
  ['duplicate', 'A'],
])(
  'preserves model identity when a %s SKU makes matching incomplete',
  async (_label, secondSku) => {
    const f = await fixture(1),
      original = f.options.read;
    f.options.read = async (scope, path, query) => {
      const result = await original(scope, path, query);
      if (path.endsWith('get_model_list'))
        result.response.model = [
          { model_id: 10, model_sku: 'A', tier_index: [0] },
          { model_id: 11, model_sku: secondSku, tier_index: [1] },
        ];
      return result;
    };
    const service = new SellerKnowledgeService(repo, f.options),
      job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
    await service.runSync(job.id);
    const listing = (await service.search({ connectionId: f.connectionId }))[0]!;
    expect(listing).toMatchObject({
      hasModel: true,
      modelCount: 2,
      skuIdentityComplete: false,
      modelSkus: ['A'],
      modelIdentities: [
        { modelId: '10', sku: 'A', tierIndex: [0] },
        { modelId: '11', sku: secondSku, tierIndex: [1] },
      ],
    });
    expect(listing.issues).toContain('MODEL_SKU_IDENTITY_INCOMPLETE');
    expect(listing.modelSkus).not.toContain('P1');
  },
);
it.each(['get_item_list', 'get_item_base_info', 'get_model_list'])(
  'persists and pauses a warned %s response without a clean listing observation',
  async (endpoint) => {
    const f = await fixture(1),
      original = f.options.read;
    f.options.read = async (scope, path, query) => {
      const result = await original(scope, path, query);
      return path.endsWith(endpoint)
        ? { ...result, envelope: { warning: 'Partial product data' } }
        : result;
    };
    const service = new SellerKnowledgeService(repo, f.options),
      job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
    await service.runSync(job.id);
    expect(await service.getSync(job.id)).toMatchObject({
      state: 'paused',
      code: 'KNOWLEDGE_API_WARNING',
      processedCount: 0,
    });
    expect(await service.search({ connectionId: f.connectionId })).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT body FROM seller_knowledge_observations WHERE connection_id=$1 AND kind='read' ORDER BY observed_at DESC LIMIT 1",
          [f.connectionId],
        )
      ).rows[0].body.result.envelope.warning,
    ).toBe('Partial product data');
  },
);
it('retains a precisely classified shipping-fee-only base warning while collecting independent attribute evidence', async () => {
  const f = await fixture(1),
    original = f.options.read;
  const warning =
    'fail to get channel estimated_shipping_fee for channel [5004];\nfail to get channel estimated_shipping_fee for channel [50052]';
  f.options.read = async (scope, path, query) => {
    const result = await original(scope, path, query);
    return path.endsWith('get_item_base_info') ? { ...result, envelope: { warning } } : result;
  };
  const service = new SellerKnowledgeService(repo, f.options),
    job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(job.id);
  expect(await service.getSync(job.id)).toMatchObject({ state: 'complete', processedCount: 1 });
  const listing = (await service.search({ connectionId: f.connectionId }))[0]!;
  expect(listing.attributes![0].attribute_id).toBe(7);
  expect(listing.issues).toContain('SHIPPING_FEE_UNAVAILABLE');
  const evidence = await service.getEvidence(listing.evidenceId),
    read = evidence!.rawEvidence.find((e: any) => e.path.endsWith('get_item_base_info'));
  expect(read.result.envelope.warning).toBe(warning);
  expect(read.warningCodes).toEqual(['SHIPPING_FEE_UNAVAILABLE']);
});
it.each([
  [
    'get_item_base_info',
    'fail to get channel estimated_shipping_fee for channel [5004];\nSome attributes unavailable',
  ],
  ['get_item_base_info', 'fail to get channel estimated_shipping_fee for channel [not-a-number]'],
  ['get_item_list', 'fail to get channel estimated_shipping_fee for channel [5004]'],
  ['get_model_list', 'fail to get channel estimated_shipping_fee for channel [5004]'],
])(
  'keeps mixed, malformed or unrelated endpoint warnings blocking: %s',
  async (endpoint, warning) => {
    const f = await fixture(1),
      original = f.options.read;
    f.options.read = async (scope, path, query) => {
      const result = await original(scope, path, query);
      return path.endsWith(endpoint) ? { ...result, envelope: { warning } } : result;
    };
    const service = new SellerKnowledgeService(repo, f.options),
      job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
    await service.runSync(job.id);
    expect(await service.getSync(job.id)).toMatchObject({
      state: 'paused',
      code: 'KNOWLEDGE_API_WARNING',
      processedCount: 0,
    });
    expect(await service.search({ connectionId: f.connectionId })).toEqual([]);
  },
);
it.each(['get_category', 'get_attribute_tree'])(
  'keeps even shipping-shaped warnings blocking on metadata: %s',
  async (endpoint) => {
    const f = await fixture(1),
      original = f.options.read;
    f.options.read = async (scope, path, query) => {
      const result = await original(scope, path, query);
      return path.endsWith(endpoint)
        ? {
            ...result,
            envelope: { warning: 'fail to get channel estimated_shipping_fee for channel [5004]' },
          }
        : result;
    };
    const service = new SellerKnowledgeService(repo, f.options),
      job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
    await service.runSync(job.id);
    expect(await service.getSync(job.id)).toMatchObject({
      state: 'paused',
      code: 'KNOWLEDGE_API_WARNING',
    });
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM seller_knowledge_categories WHERE connection_id=$1 AND category_id='12'",
          [f.connectionId],
        )
      ).rows[0].count,
    ).toBe('0');
    f.options.read = original;
    await service.runSync(job.id);
    expect(await service.getSync(job.id)).toMatchObject({ state: 'complete' });
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM seller_knowledge_categories WHERE connection_id=$1 AND category_id='12'",
          [f.connectionId],
        )
      ).rows[0].count,
    ).toBe('1');
    expect(f.calls.filter((c) => c.path.endsWith('get_model_list'))).toHaveLength(1);
  },
);
it('retains an omitted attribute list as unknown and continues inventory without admitting it as a recommendation source', async () => {
  const f = await fixture(2),
    original = f.options.read;
  f.options.read = async (scope, path, query) => {
    const result = await original(scope, path, query);
    if (path.endsWith('get_item_base_info')) delete result.response.item_list[0].attribute_list;
    return result;
  };
  const service = new SellerKnowledgeService(repo, f.options),
    job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(job.id);
  expect(await service.getSync(job.id)).toMatchObject({ state: 'complete', processedCount: 2 });
  const listing = (await service.search({ connectionId: f.connectionId })).find(
    (l) => l.itemId === '1',
  )!;
  expect(listing.attributes).toBeNull();
  expect(listing).toMatchObject({
    attributeEvidenceComplete: false,
    issues: expect.arrayContaining(['ATTRIBUTE_LIST_NOT_RETURNED']),
  });
  expect(
    (await service.getCandidates({ connectionId: f.connectionId, categoryId: 12 })).map(
      (l) => l.itemId,
    ),
  ).toEqual(['2']);
  expect((await service.getEvidence(listing.evidenceId))!.body.rawItem).not.toHaveProperty(
    'attribute_list',
  );
});
it('accepts an explicitly zero-count initial page with omitted item and preserves existing inventory', async () => {
  const f = await fixture(1),
    job = await f.service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await f.service.runSync(job.id);
  f.options.read = async () => ({
    kind: 'success',
    requestId: randomUUID(),
    response: { total_count: 0, has_next_page: false, next: '' },
  });
  const service = new SellerKnowledgeService(repo, f.options),
    next = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(next.id);
  expect(await service.getSync(next.id)).toMatchObject({ state: 'complete', processedCount: 0 });
  expect(await service.search({ connectionId: f.connectionId })).toHaveLength(1);
});
it.each([
  { has_next_page: false },
  { total_count: 1, has_next_page: false },
  { total_count: 0, has_next_page: true },
  { item: null, total_count: 0, has_next_page: false },
])('keeps missing or contradictory item-list evidence blocked: %o', async (response) => {
  const f = await fixture(1);
  f.options.read = async () => ({ kind: 'success', requestId: randomUUID(), response });
  const service = new SellerKnowledgeService(repo, f.options),
    job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(job.id);
  expect(await service.getSync(job.id)).toMatchObject({
    state: 'paused',
    code: 'KNOWLEDGE_LIST_RESPONSE_INVALID',
  });
});
it('puts named current listings before newly observed deletion markers and retains exact-ID access to history', async () => {
  const f = await fixture(1),
    original = f.options.read;
  f.options.read = async (scope, path, query) => {
    if (path.endsWith('get_item_list') && query.item_status === 'SELLER_DELETE')
      return {
        kind: 'success',
        requestId: randomUUID(),
        response: {
          item: [{ item_id: 99, item_status: 'SELLER_DELETE', update_time: 100 }],
          has_next_page: false,
          total_count: 1,
        },
      };
    return original(scope, path, query);
  };
  const service = new SellerKnowledgeService(repo, f.options),
    job = await service.startSync({ connectionId: f.connectionId, requestId: randomUUID() });
  await service.runSync(job.id);
  expect((await service.search({ connectionId: f.connectionId, limit: 1 }))[0]?.itemId).toBe('1');
  expect((await service.search({ connectionId: f.connectionId, query: '99' }))[0]).toMatchObject({
    itemId: '99',
    itemStatus: 'SELLER_DELETE',
    title: '',
  });
});
