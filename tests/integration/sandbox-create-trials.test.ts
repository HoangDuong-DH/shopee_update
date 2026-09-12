import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  Pool,
  Repository,
  SandboxCreateTrialStore,
  migrate,
  type SandboxCreateTrialManifest,
} from '../../packages/persistence/src/index.js';
import {
  SandboxCreateClient,
  SecretBox,
  type CreateUnlistedPayload,
  type InitTiersPayload,
  type ShopCredentials,
} from '../../packages/shopee/src/index.js';
import {
  runSandboxCreateTrialOnce,
  compareSandboxCreateReadback,
} from '../../apps/worker/src/sandbox-create-trials.js';
import { fixtureDraft } from '../helpers/fixtures.js';

const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool),
  connectionId = randomUUID(),
  productionId = randomUUID(),
  lamyRunId = randomUUID();
const key = '82'.repeat(32),
  box = new SecretBox(key),
  scope = 'sandbox:1232297:227418363';
const credentials: ShopCredentials = {
  environment: 'sandbox',
  partnerId: '1232297',
  shopId: '227418363',
  partnerKey: 'fixture-partner',
  accessToken: 'fixture-token',
};
let clock: number, store: SandboxCreateTrialStore, remote: StatefulTransport;
const now = () => new Date(clock);
function evidence() {
  return {
    validatedAt: now().toISOString(),
    scope: { environment: 'sandbox', partnerId: '1232297', shopId: '227418363' },
    source: 'isolated-stateful-gateway-fixture',
  };
}
function prepared(
  index: number,
  tierCount = index % 3,
): SandboxCreateTrialManifest['items'][number] {
  const sourceKey = `SBX-BULK-T${index}`;
  const create: CreateUnlistedPayload = {
    item_name: `SANDBOX QA Bộ ${index}  thử`,
    item_sku: sourceKey,
    item_status: 'UNLIST',
    category_id: 301378,
    description_type: 'normal',
    description: `Nội dung  ${index}\n\nGiữ nguyên từng dòng.`,
    weight: 0.1,
    dimension: { package_height: 3, package_length: 15, package_width: 10 },
    brand: { brand_id: 0, original_brand_name: 'No Brand' },
    condition: 'NEW',
    pre_order: { is_pre_order: false, days_to_ship: 2 },
    gtin_code: '00',
    image: { image_ratio: '1:1', image_id_list: [`mock-cover-${index}`, `mock-gallery-${index}`] },
    logistic_info: [{ logistic_id: 50040, enabled: true, is_free: false }],
    attribute_list: [
      {
        attribute_id: 101,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Giấy  thử' }],
      },
    ],
    original_price: 10000 + index,
    seller_stock: [{ stock: 10 + index }],
  };
  if (!tierCount) return { sourceKey, create };
  const tiers: Omit<InitTiersPayload, 'item_id'> = {
    standardise_tier_variation: [
      {
        variation_id: 0,
        variation_name: 'Màu  sắc',
        variation_option_list: [
          {
            variation_option_id: 0,
            variation_option_name: 'Trắng ',
            image_id: `mock-white-${index}`,
          },
          { variation_option_id: 0, variation_option_name: 'Đen', image_id: `mock-black-${index}` },
        ],
      },
      ...(tierCount === 2
        ? [
            {
              variation_id: 0 as const,
              variation_name: 'Số lượng',
              variation_option_list: [
                { variation_option_id: 0 as const, variation_option_name: 'Một' },
                { variation_option_id: 0 as const, variation_option_name: 'Hai' },
              ],
            },
          ]
        : []),
    ],
    model: (tierCount === 1
      ? [[0], [1]]
      : [
          [0, 0],
          [0, 1],
          [1, 0],
          [1, 1],
        ]
    ).map((tier_index, model) => ({
      tier_index,
      model_sku: `${sourceKey}-M${model}`,
      original_price: 15000 + model,
      seller_stock: [{ stock: 20 + model }],
      gtin_code: '00',
    })),
  };
  return { sourceKey, create, tiers };
}
function manifest(count = 1, start = 0): SandboxCreateTrialManifest {
  return {
    trialKey: `SBX-BULK-${randomUUID()}`,
    connectionId,
    connectionRevision: 1,
    items: Array.from({ length: count }, (_, index) => prepared(start + index)),
  };
}
function readMoneyStock(price: number, stocks: { stock: number }[]) {
  return {
    price_info: [{ currency: 'VND', original_price: price, current_price: price }],
    stock_info_v2: {
      seller_stock: structuredClone(stocks),
      summary_info: {
        total_available_stock: stocks.reduce((sum, stock) => sum + stock.stock, 0),
        total_reserved_stock: 0,
      },
    },
  };
}
class StatefulTransport {
  items = new Map<
    string,
    { create: CreateUnlistedPayload; tiers?: InitTiersPayload; createdAt: number }
  >();
  requests: { path: string; body: any; at: number }[] = [];
  loseCreateFor?: string;
  rejectFor?: string;
  authFor?: string;
  loseInit = false;
  badReadback = false;
  inFlight = 0;
  maxInFlight = 0;
  base(itemId: string): any {
    const source = this.items.get(itemId)!;
    return {
      ...structuredClone(source.create),
      item_id: Number(itemId),
      has_model: !!source.tiers?.standardise_tier_variation.length,
      ...readMoneyStock(source.create.original_price, source.create.seller_stock),
      ...(this.badReadback ? { description: 'Không khớp nguồn' } : {}),
    };
  }
  models(itemId: string): any {
    const source = this.items.get(itemId)!;
    return {
      tier_variation: source.tiers!.standardise_tier_variation.map((tier) => ({
        name: tier.variation_name,
        option_list: tier.variation_option_list.map((option) => ({
          option: option.variation_option_name,
          ...(option.image_id ? { image: { image_id: option.image_id } } : {}),
        })),
      })),
      // Shopee can return models in another order; identity must use SKU and tier_index.
      model: source
        .tiers!.model.map((model, index) => ({
          model_id: 700000 + index,
          model_sku: model.model_sku,
          tier_index: model.tier_index,
          gtin_code: model.gtin_code,
          ...readMoneyStock(model.original_price, model.seller_stock),
        }))
        .reverse(),
    };
  }
  fetch: typeof fetch = async (raw, init) => {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const url = new URL(String(raw)),
        body = init?.body ? JSON.parse(String(init.body)) : null;
      expect(url.hostname).toBe('openplatform.sandbox.test-stable.shopee.sg');
      expect(url.searchParams.get('shop_id')).toBe('227418363');
      this.requests.push({ path: url.pathname, body, at: clock });
      const success = (response: unknown) =>
        new Response(
          JSON.stringify({ error: '', request_id: 'fixture-' + this.requests.length, response }),
        );
      if (url.pathname.endsWith('/add_item')) {
        if (body.item_sku === this.authFor)
          return new Response(JSON.stringify({ error: 'error_auth', request_id: 'mock-auth' }));
        if (body.item_sku === this.rejectFor)
          return new Response(
            JSON.stringify({ error: 'error_param', request_id: 'mock-rejected' }),
          );
        const id = String(910000000 + this.items.size);
        this.items.set(id, { create: body, createdAt: clock });
        if (body.item_sku === this.loseCreateFor)
          throw new Error('Simulated remote success with lost response');
        return success({ item_id: Number(id) });
      }
      if (url.pathname.endsWith('/init_tier_variation')) {
        const target = this.items.get(String(body.item_id));
        expect(target).toBeDefined();
        expect(clock - target!.createdAt).toBeGreaterThanOrEqual(5000);
        target!.tiers = body;
        if (this.loseInit) throw new Error('Simulated tier write with lost response');
        return success({ item_id: body.item_id });
      }
      if (url.pathname.endsWith('/get_item_base_info'))
        return success({
          item_list: url.searchParams
            .get('item_id_list')!
            .split(',')
            .map((id) => this.base(id)),
        });
      if (url.pathname.endsWith('/get_model_list'))
        return success(this.models(url.searchParams.get('item_id')!));
      throw new Error('Unexpected fixture endpoint');
    } finally {
      this.inFlight--;
    }
  };
}
const run = (workerId = 'worker-1', targetStore = store) =>
  runSandboxCreateTrialOnce({
    store: targetStore,
    repo,
    workerId,
    encryptionKey: key,
    clientFactory: (credentials) => new SandboxCreateClient(credentials, remote.fetch),
  });
// Advisory locks are cluster-wide, including other concurrently running isolated test schemas.
// A busy lane is a normal no-work result; assertions needing ownership wait boundedly for it.
async function claimReady(workerId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const claim = await store.claim(workerId);
    if (claim) return claim;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Fixture shop lane did not become available');
}
async function runReady(workerId = 'worker-1', targetStore = store) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await run(workerId, targetStore)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Fixture due stage did not become available');
}
async function drain(id: string, twoWorkers = false) {
  for (let step = 0; step < 400; step++) {
    const trial = (await store.get(id))!;
    if (trial.paused || trial.items.every((item) => ['verified', 'failed'].includes(item.state)))
      return trial;
    if (twoWorkers) await Promise.all([run('worker-a'), run('worker-b')]);
    else await run();
    clock += 1000;
  }
  throw new Error('Fixture did not drain');
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await repo.saveProduct({ ...fixtureDraft(), productKey: 'lamy-5d' }, 0);
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,partner_key_ciphertext,token_ciphertext) VALUES($1,'sandbox','1232297','227418363','MOCK TEST','connected',$2,$3),($4,'production','1232297','227418363','MOCK production','connected',NULL,NULL)",
    [
      connectionId,
      box.seal({ partnerKey: credentials.partnerKey }, scope),
      box.seal({ accessToken: credentials.accessToken }, scope),
      productionId,
    ],
  );
  await pool.query(
    "INSERT INTO sandbox_listing_runs(id,connection_id,item_id,product_key,source_revision,connection_revision,input_fingerprint,state,intent,body) VALUES($1,$2,'803934364','lamy-5d',1,1,'protected-mock','unknown',$3,$3)",
    [lamyRunId, connectionId, { protectedFixture: true }],
  );
});
beforeEach(async () => {
  await pool.query('TRUNCATE sandbox_create_trials CASCADE');
  await pool.query('UPDATE connections SET revision=1,state=$2,expires_at=NULL WHERE id=$1', [
    connectionId,
    'connected',
  ]);
  clock = Date.parse('2026-09-12T01:00:00Z');
  store = new SandboxCreateTrialStore(pool, { now });
  remote = new StatefulTransport();
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

it('atomically deduplicates trial replay and prevents source reuse or production scope', async () => {
  const input = manifest(2),
    proof = evidence();
  const [a, b] = await Promise.all([store.submit(input, proof), store.submit(input, proof)]);
  expect(a.id).toBe(b.id);
  expect((await store.get(a.id))!.items).toHaveLength(2);
  await expect(store.submit({ ...input, items: [prepared(77)] }, proof)).rejects.toThrow(
    'IDEMPOTENCY_CONFLICT',
  );
  await expect(store.submit({ ...input, trialKey: 'SBX-BULK-OTHER' }, proof)).rejects.toThrow(
    'SOURCE_EXISTS',
  );
  await expect(store.submit({ ...manifest(), connectionId: productionId }, proof)).rejects.toThrow(
    'SCOPE_NOT_ALLOWED',
  );
  await expect(
    store.submit(
      {
        ...manifest(),
        items: [{ ...prepared(2), create: { ...prepared(2).create, item_status: 'NORMAL' } }],
      },
      proof,
    ),
  ).rejects.toThrow();
  await expect(store.submit(manifest(81), proof)).rejects.toThrow();
  expect(await store.list()).toHaveLength(1);
});

it('processes 80 zero/one/two-tier fixtures through real gateway+PG worker with two competing workers, without touching Lamy', async () => {
  const sourceBefore = await repo.getProduct('lamy-5d'),
    lamyBefore = (await pool.query('SELECT * FROM sandbox_listing_runs WHERE id=$1', [lamyRunId]))
      .rows[0];
  const trial = await store.submit(manifest(80), evidence()),
    result = await drain(trial.id, true);
  expect(result.state).toBe('verified');
  expect(result.items).toHaveLength(80);
  expect(remote.items.size).toBe(80);
  expect(remote.maxInFlight).toBe(1);
  expect(remote.requests.filter((request) => request.path.endsWith('/add_item'))).toHaveLength(80);
  expect(new Set(result.items.map((item) => item.itemId)).size).toBe(80);
  for (const item of result.items) {
    expect(item.state).toBe('verified');
    expect(item.attemptCount).toBe(item.intent.tiers ? 2 : 1);
    expect(item.events?.some((event) => event.code === 'READBACK_VERIFIED')).toBe(true);
  }
  expect(await repo.getProduct('lamy-5d')).toEqual(sourceBefore);
  expect(
    (await pool.query('SELECT * FROM sandbox_listing_runs WHERE id=$1', [lamyRunId])).rows[0],
  ).toEqual(lamyBefore);
  expect(await repo.listJobs()).toEqual([]);
  expect(
    remote.requests.every(
      (request) => !['803934364', '846056124'].includes(String(request.body?.item_id)),
    ),
  ).toBe(true);
}, 120000);

it('recovers a recorded create after restart, waits five seconds and never sends create again', async () => {
  const trial = await store.submit(manifest(1, 1), evidence());
  await runReady();
  const created = (await store.get(trial.id))!.items[0]!;
  expect(created.stage).toBe('created');
  expect(created.itemId).toBeTruthy();
  const restarted = new SandboxCreateTrialStore(pool, { now });
  expect(await run('worker-restarted', restarted)).toBe(false);
  clock += 5000;
  expect(await runReady('worker-restarted', restarted)).toBe(true);
  clock += 5000;
  expect(await runReady('worker-restarted', restarted)).toBe(true);
  expect((await store.get(trial.id))!.state).toBe('verified');
  expect(remote.requests.filter((request) => request.path.endsWith('/add_item'))).toHaveLength(1);
  expect(
    remote.requests.filter((request) => request.path.endsWith('/init_tier_variation')),
  ).toHaveLength(1);
});

it('keeps remote-created/lost-response unknown and blocks blind duplicate retries across restart and another batch', async () => {
  const trial = await store.submit(manifest(2), evidence());
  remote.loseCreateFor = 'SBX-BULK-T0';
  await runReady();
  expect(remote.items.size).toBe(1);
  expect((await store.get(trial.id))!.state).toBe('unknown');
  await store.submit(manifest(1, 50), evidence());
  clock += 120000;
  expect(await run('restarted', new SandboxCreateTrialStore(pool, { now }))).toBe(false);
  expect(remote.requests).toHaveLength(1);
  const item = (await store.get(trial.id))!.items[0]!;
  expect(item.state).toBe('unknown');
  expect(item.itemId).toBeNull();
  expect(item.attemptCount).toBe(1);
});

it('fences expired mutation leases and stores late receipt without advancing or duplicating the item', async () => {
  const trial = await store.submit(manifest(), evidence()),
    claim = await claimReady('old');
  const payload = claim.intent.create as CreateUnlistedPayload;
  const attemptId = (await store.beginMutation(claim, 'create_intent', payload))!;
  const outcome = await new SandboxCreateClient(credentials, remote.fetch).createUnlisted(payload);
  expect(outcome.kind).toBe('success');
  clock += 60001;
  // A null claim can mean another schema briefly owns the cluster-wide advisory lock.
  // Confirm the recovery checkpoint itself before testing the stale owner's receipt.
  let recovered = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    expect(await store.claim('new')).toBeNull();
    if ((await store.get(trial.id))!.items[0]!.state === 'unknown') {
      recovered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(recovered).toBe(true);
  const itemId = outcome.kind === 'success' ? outcome.data.itemId : '';
  expect(await store.finishMutation(claim, attemptId, { kind: 'success', itemId })).toBe(false);
  const item = (await store.get(trial.id))!.items[0]!;
  expect(item.state).toBe('unknown');
  expect(item.itemId).toBeNull();
  expect(item.events?.some((event) => event.code === 'LATE_RECEIPT')).toBe(true);
  expect(
    (await pool.query('SELECT outcome FROM sandbox_create_trial_attempts WHERE id=$1', [attemptId]))
      .rows[0].outcome.itemId,
  ).toBe(itemId);
  expect(await run('new')).toBe(false);
  expect(remote.items.size).toBe(1);
});

it('recovers an expired claim before intent as safe work and rejects the stale owner before any write', async () => {
  await store.submit(manifest(), evidence());
  const old = await claimReady('old');
  clock += 60001;
  const fresh = await claimReady('new');
  expect(fresh.leaseEpoch).toBe(old.leaseEpoch + 1);
  expect(await store.beginMutation(old, 'create_intent', old.intent.create)).toBeNull();
  expect(remote.requests).toHaveLength(0);
});

it('rejects modified intent payload and a connection version changed at the durable boundary', async () => {
  await store.submit(manifest(), evidence());
  const claim = await claimReady('worker');
  await expect(
    store.beginMutation(claim, 'create_intent', {
      ...claim.intent.create,
      item_name: 'SANDBOX QA changed',
    }),
  ).rejects.toThrow('PAYLOAD_CHANGED');
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  await expect(store.beginMutation(claim, 'create_intent', claim.intent.create)).rejects.toThrow(
    'CONNECTION_CHANGED',
  );
  expect(
    (await pool.query('SELECT count(*)::int AS count FROM sandbox_create_trial_attempts')).rows[0]
      .count,
  ).toBe(0);
  expect(remote.requests).toHaveLength(0);
});

it('treats HTTP 200 business rejection as failure and continues other independent items', async () => {
  const trial = await store.submit(manifest(2), evidence());
  remote.rejectFor = 'SBX-BULK-T0';
  const result = await drain(trial.id);
  expect(result.state).toBe('failed');
  expect(result.paused).toBe(false);
  expect(result.items.map((item) => item.state)).toEqual(['failed', 'verified']);
  expect(remote.items.size).toBe(1);
  expect(result.items[0]!.result).toMatchObject({ kind: 'rejected', code: 'error_param' });
});

it('pauses the whole trial on authentication failure and rejects stale preflight before mutation intent', async () => {
  const trial = await store.submit(manifest(2), evidence());
  remote.authFor = 'SBX-BULK-T0';
  await runReady();
  expect((await store.get(trial.id))!.paused).toBe(true);
  expect(await run()).toBe(false);
  expect(remote.requests).toHaveLength(1);
  const stale = await store.submit(manifest(1, 11), evidence());
  clock += 15 * 60000 + 1;
  await runReady();
  const item = (await store.get(stale.id))!.items[0]!;
  expect(item.attemptCount).toBe(0);
  expect(item.result).toEqual({ code: 'SANDBOX_TRIAL_PREFLIGHT_EXPIRED' });
  expect(remote.requests).toHaveLength(1);
});

it('does not retry a tier initialization whose response was lost', async () => {
  const trial = await store.submit(manifest(1, 1), evidence());
  await runReady();
  clock += 5000;
  remote.loseInit = true;
  await runReady();
  const item = (await store.get(trial.id))!.items[0]!;
  expect(item.state).toBe('unknown');
  expect(item.stage).toBe('tiers_intent');
  expect(item.itemId).toBeTruthy();
  clock += 120000;
  expect(await run('restarted')).toBe(false);
  expect(
    remote.requests.filter((request) => request.path.endsWith('/init_tier_variation')),
  ).toHaveLength(1);
});

it('readback mismatch retries reads only, then pauses with field-level evidence', async () => {
  const trial = await store.submit(manifest(), evidence());
  remote.badReadback = true;
  const result = await drain(trial.id);
  expect(result.state).toBe('unknown');
  expect(result.items[0]!.readCount).toBe(4);
  expect(result.items[0]!.result).toMatchObject({ verified: false, issues: ['description'] });
  expect(remote.requests.filter((request) => request.path.endsWith('/add_item'))).toHaveLength(1);
  expect(
    remote.requests.filter((request) => request.path.endsWith('/get_item_base_info')),
  ).toHaveLength(4);
});

it('QC catches changed source roles, prices, stocks, labels and model identities without using acknowledgement as success', () => {
  const input = prepared(2),
    id = '910000099',
    create = input.create as CreateUnlistedPayload,
    tiers = input.tiers as Omit<InitTiersPayload, 'item_id'>;
  remote.items.set(id, { create, tiers: { ...tiers, item_id: Number(id) }, createdAt: clock });
  const base = remote.base(id),
    models = remote.models(id);
  expect(compareSandboxCreateReadback(create, tiers, id, base, models)).toEqual([]);
  const changes: [string, (base: any, models: any) => void][] = [
    [
      'item_name',
      (base) => {
        base.item_name = base.item_name.trim().replace(/ {2}/g, ' ');
      },
    ],
    [
      'item_sku',
      (base) => {
        base.item_sku = 'SBX-BULK-WRONG';
      },
    ],
    [
      'image',
      (base) => {
        base.image.image_id_list.reverse();
      },
    ],
    [
      'category_id',
      (base) => {
        base.category_id = 300018;
      },
    ],
    [
      'brand',
      (base) => {
        base.brand.brand_id = 7;
      },
    ],
    [
      'attribute_list',
      (base) => {
        base.attribute_list[0].attribute_value_list[0].original_value_name = 'Other';
      },
    ],
    [
      'logistic_info',
      (base) => {
        base.logistic_info[0].enabled = false;
      },
    ],
    [
      'tier_variation',
      (_base, models) => {
        models.tier_variation[0].option_list[0].option = 'Trắng';
      },
    ],
    [
      'tier_variation',
      (_base, models) => {
        models.tier_variation[0].option_list[0].image.image_id = 'another';
      },
    ],
    [
      'model_membership',
      (_base, models) => {
        models.model[0].tier_index = [0, 0];
      },
    ],
    [
      'SBX-BULK-T2-M3.price',
      (_base, models) => {
        models.model[0].price_info[0].original_price++;
      },
    ],
    [
      'SBX-BULK-T2-M3.stock',
      (_base, models) => {
        models.model[0].stock_info_v2.summary_info.total_available_stock--;
      },
    ],
  ];
  for (const [field, change] of changes) {
    const changedBase = structuredClone(base),
      changedModels = structuredClone(models);
    change(changedBase, changedModels);
    expect(compareSandboxCreateReadback(create, tiers, id, changedBase, changedModels)).toContain(
      field,
    );
  }
});
