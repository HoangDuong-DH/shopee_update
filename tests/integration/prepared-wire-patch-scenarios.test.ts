import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type {
  PreparedDocument,
  PreparedField,
  PreparedMedia,
  PreparedRemote,
  Scope,
} from '../../packages/domain/src/index.js';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import { SandboxPreparedTransport } from '../../packages/shopee/src/prepared-transport.js';
import {
  planPreparedWireCreate,
  planPreparedWireUpdate,
  type PreparedWireContext,
  type PreparedWirePlan,
} from '../../packages/shopee/src/prepared-wire.js';
import {
  checkPreparedWireCreate,
  checkPreparedWireUpdate,
} from '../../packages/shopee/src/prepared-wire-qc.js';
import type { FieldSnapshot } from '../../packages/shopee/src/field-client.js';
import {
  PreparedWireRunner,
  type PreparedWireInput,
} from '../../apps/api/src/prepared-wire-runner.js';
import { PreparedWirePlatform, type WireObject } from '../fixtures/prepared-wire-platform.js';

const runId = randomUUID(),
  schema = 'test_patch_matrix_' + runId.replaceAll('-', '');
const directory = resolve('.local/acceptance-20260914/patch-matrix', 'run-' + runId);
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema}`,
});
const repo = new Repository(pool),
  encryptionKey = Buffer.alloc(32, 41).toString('hex');
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const api = (name: string) => '/api/v2/product/' + name;
const connectionIds = new Map<string, string>();
let platform: PreparedWirePlatform, runner: PreparedWireRunner, now: number, restoreNow: () => void;
let scenario: WireObject = {},
  sequence = 0;
const report: WireObject = {
  mode: 'local-http-wire-patch-matrix',
  directory,
  schema,
  scenarios: [],
  externalRequests: 0,
  gaps: [],
  files: [],
  startedAt: new Date().toISOString(),
};
type Listing = {
  shopId: string;
  scope: Scope;
  client: SandboxPreparedTransport;
  document: PreparedDocument;
  context: PreparedWireContext;
  remote: PreparedRemote;
  raw: FieldSnapshot;
};
const clone = <T>(value: T): T => structuredClone(value);
const ready = (plan: PreparedWirePlan) => {
  expect(plan.kind, JSON.stringify(plan)).toBe('ready');
  if (plan.kind !== 'ready') throw new Error(JSON.stringify(plan));
  return plan;
};
function success(result: any): WireObject {
  expect(result.kind, JSON.stringify(result)).toBe('success');
  if (result.kind !== 'success') throw new Error(JSON.stringify(result));
  return result.response;
}
function owner(shopIndex: number) {
  const shop = platform.shops[shopIndex]!,
    c = shop.credentials;
  const scope: Scope = {
    environment: 'sandbox',
    partnerId: c.partnerId,
    shopId: c.shopId,
    connectionRevision: 1,
    capabilityRevision: 1,
  };
  const client = new SandboxPreparedTransport(
    c,
    platform.shops.map((entry) => entry.credentials),
    platform.fetch,
  );
  return { shop, scope, client };
}
async function asset(
  listing: Pick<Listing, 'client' | 'context'>,
  role: 'cover' | 'gallery' | 'description' | 'variation',
) {
  const unique = sequence++,
    square = role === 'cover' || role === 'variation',
    width = 96,
    height = square ? 96 : 128;
  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: {
        r: 40 + ((unique * 17) % 180),
        g: 30 + ((unique * 23) % 190),
        b: 50 + ((unique * 37) % 150),
      },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="96" height="96"><text x="3" y="26" font-size="10" fill="white">QA ${unique} ${role}</text></svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();
  const importId = randomUUID(),
    sha256 = digest(bytes),
    source: PreparedMedia = { importId, sha256, width, height, mime: 'image/png' };
  const filename = join(directory, 'qa-assets', importId + '.png');
  await writeFile(filename, bytes);
  const uploaded = success(
    await listing.client.upload(
      bytes,
      'image/png',
      role === 'description'
        ? { scene: 'desc' }
        : { scene: 'normal', ratio: square ? '1:1' : '3:4' },
    ),
  );
  const imageId = uploaded.image_info.image_id as string;
  expect(platform.snapshot().images.find((image) => image.imageId === imageId)!.sha256).toBe(
    sha256,
  );
  listing.context.images.push({ importId, sha256, imageId, role });
  report.files.push({ path: filename, sha256, width, height, role, imageId });
  return source;
}
function mediaId(listing: Listing, media: PreparedMedia, role: string) {
  return listing.context.images.find(
    (image) =>
      image.importId === media.importId && image.sha256 === media.sha256 && image.role === role,
  )!.imageId;
}
async function read(
  listing: Pick<Listing, 'client' | 'remote' | 'context'>,
): Promise<FieldSnapshot> {
  const base = success(
    await listing.client.read(api('get_item_base_info'), { item_id_list: listing.remote.itemId }),
  );
  expect(base.item_list).toHaveLength(1);
  expect(String(base.item_list[0].item_id)).toBe(listing.remote.itemId);
  const models = success(
    await listing.client.read(api('get_model_list'), { item_id: listing.remote.itemId }),
  );
  const promotions = await listing.client.read(api('get_item_promotion'), {
    item_id_list: listing.remote.itemId,
  });
  success(promotions);
  listing.context.promotionSnapshot = promotions.envelope;
  return { item: base.item_list[0], models: models as FieldSnapshot['models'] };
}
function input(listing: Listing, plan: PreparedWirePlan, suffix: string): PreparedWireInput {
  return {
    id: randomUUID(),
    connectionId: connectionIds.get(listing.shopId)!,
    scope: listing.scope,
    sourceKey: listing.document.sourceKey,
    sourceFingerprint: digest(JSON.stringify({ suffix, source: listing.document, plan })),
    plan: ready(plan),
  };
}
async function execute(listing: Listing, plan: PreparedWirePlan, suffix: string) {
  const request = input(listing, plan, suffix),
    prepared = await runner.prepare(request),
    result = await runner.run(prepared.id);
  return { request, result };
}
async function create(shopIndex = 0, tiers = 2): Promise<Listing> {
  const { shop, scope, client } = owner(shopIndex),
    category = shop.profile.categories[shopIndex % 4]!,
    attribute = category.requiredAttribute,
    value = attribute.values[shopIndex]!;
  const context: PreparedWireContext = {
    images: [],
    brandName: category.brandName,
    condition: 'NEW',
    preOrder: { is_pre_order: false },
    capabilities: { gallery34: true, extendedDescription: true },
    stockLocationBySku: {},
    limits: success(await client.read(api('get_item_limit'), { category_id: category.categoryId })),
    attributeList: [
      {
        attribute_id: Number(attribute.attributeId),
        attribute_value_list: [
          { value_id: Number(value.valueId), original_value_name: value.name },
        ],
      },
    ],
    channelInfoById: Object.fromEntries(
      success(await client.read('/api/v2/logistics/get_channel_list')).logistics_channel_list.map(
        (channel: WireObject) => [String(channel.logistics_channel_id), channel],
      ),
    ),
  };
  const temporary = { client, context },
    cover = await asset(temporary, 'cover'),
    gallery = await asset(temporary, 'gallery'),
    description = await asset(temporary, 'description'),
    options: PreparedMedia[] = [];
  if (tiers)
    for (let option = 0; option < 2; option++) options.push(await asset(temporary, 'variation'));
  const document: PreparedDocument = {
    sourceKey: `QA-PATCH-${sequence}`,
    title: 'QA nguyên văn  · giá/bìa/phân loại',
    description: [
      { type: 'text', text: 'Dòng đầu\n\n' },
      { type: 'image', image: description },
      { type: 'text', text: '\n\nDòng cuối & nội dung  nguyên văn.' },
    ],
    cover,
    gallery: [gallery],
    tierNames: ['Màu  sắc', 'Quy cách'].slice(0, tiers),
    models: Array.from({ length: tiers ? 2 ** tiers : 1 }, (_, index) => ({
      sku: 'SHARED-QA-SKU-' + index,
      tierIndex: tiers === 2 ? [Math.floor(index / 2), index % 2] : tiers ? [index] : [],
      optionLabels:
        tiers === 2
          ? [['Trắng', 'Đen'][Math.floor(index / 2)]!, ['Gói 1', 'Gói 3'][index % 2]!]
          : tiers
            ? [['Trắng', 'Đen'][index]!]
            : [],
      originalPrice: String(23000 + shopIndex * 4000 + index * 1100),
      stock: 18 + shopIndex * 10 + index * 2,
      ...(tiers ? { image: options[tiers === 2 ? Math.floor(index / 2) : index]! } : {}),
    })),
    categoryId: category.categoryId,
    brandId: category.brandId,
    attributes: { [attribute.attributeId]: [value.valueId] },
    logistics: [{ channelId: shop.profile.logisticsChannelId, enabled: true }],
    weightGrams: 215,
    dimensionCm: { length: 12, width: 8, height: 4 },
    publication: 'unlisted',
  };
  context.stockLocationBySku = Object.fromEntries(
    document.models.map((model) => [model.sku, null]),
  );
  context.gtinBySku = Object.fromEntries(document.models.map((model) => [model.sku, '00']));
  const listing: Listing = {
    shopId: shop.profile.shopId,
    scope,
    client,
    context,
    document,
    remote: { itemId: '0', document, modelBindings: [], extra: {} },
    raw: { item: {}, models: { model: [], tier_variation: [] } },
  };
  const created = await execute(listing, planPreparedWireCreate(document, context), 'create');
  expect(created.result.state).toBe('acknowledged');
  listing.remote.itemId = created.result.itemId;
  listing.raw = await read(listing);
  expect(checkPreparedWireCreate(document, context, listing.raw)).toEqual({
    verified: true,
    mismatchedPaths: [],
  });
  listing.remote.document = clone(document);
  listing.remote.modelBindings = document.models.map((model) => ({
    sku: model.sku,
    modelId: tiers
      ? String(listing.raw.models.model.find((actual) => actual.model_sku === model.sku)!.model_id)
      : '0',
    tierIndex: [...model.tierIndex],
  }));
  scenario.creates ??= [];
  scenario.creates.push({
    shopId: listing.shopId,
    document,
    request: created.request,
    result: created.result,
    raw: listing.raw,
  });
  return listing;
}
async function planned(
  listing: Listing,
  fields: PreparedField[],
  selected: string[],
  mutate: (desired: PreparedRemote) => Promise<void> | void,
) {
  const before = await read(listing),
    baseline = clone(listing.remote),
    desired = clone(baseline);
  await mutate(desired);
  listing.context.baseline = before;
  const plan = ready(planPreparedWireUpdate(baseline, desired, fields, selected, listing.context));
  return { before, baseline, desired, plan };
}
const postCalls = () => platform.calls.filter((call) => call.method === 'POST');
function record(value: unknown) {
  scenario.evidence ??= [];
  scenario.evidence.push(value);
}

beforeAll(async () => {
  await mkdir(join(directory, 'qa-assets'), { recursive: true });
  await writeFile(
    resolve('.local/acceptance-20260914/patch-matrix/latest.json'),
    JSON.stringify({ directory, report: join(directory, 'matrix.json') }),
  );
  now = Date.now();
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  restoreNow = () => spy.mockRestore();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    report.externalRequests++;
    throw new Error('PATCH_MATRIX_OUTBOUND_FORBIDDEN');
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const box = new SecretBox(encryptionKey),
    defaults = new PreparedWirePlatform();
  for (const shop of defaults.shops) {
    const c = shop.credentials,
      id = randomUUID(),
      ownerKey = `sandbox:${c.partnerId}:${c.shopId}`;
    connectionIds.set(c.shopId, id);
    await pool.query(
      "INSERT INTO connections(id,environment,partner_id,shop_id,name,revision,capability_revision,state,partner_key_ciphertext,token_ciphertext) VALUES($1,'sandbox',$2,$3,$4,1,1,'connected',$5,$6)",
      [
        id,
        c.partnerId,
        c.shopId,
        shop.profile.name,
        box.seal({ partnerKey: c.partnerKey }, ownerKey),
        box.seal({ accessToken: c.accessToken }, ownerKey),
      ],
    );
  }
});
beforeEach(async (context) => {
  await pool.query('TRUNCATE prepared_wire_operations CASCADE');
  await pool.query("UPDATE connections SET revision=1,capability_revision=1,state='connected'");
  platform = new PreparedWirePlatform({ now: () => now });
  runner = new PreparedWireRunner(repo, {
    allowedShops: platform.shops.map((shop) => shop.credentials),
    encryptionKey,
    transport: platform.fetch,
    now: () => new Date(now),
    pause: async (ms) => {
      now += ms;
    },
  });
  scenario = { name: context.task.name, started: performance.now() };
});
afterEach(async (context) => {
  scenario.durationMs = performance.now() - scenario.started;
  delete scenario.started;
  scenario.testState = context.task.result?.state;
  scenario.platform = platform.snapshot();
  scenario.journal = (
    await pool.query(
      'SELECT id,owner_key,source_key,state,item_id,result FROM prepared_wire_operations ORDER BY created_at,id',
    )
  ).rows;
  scenario.steps = (
    await pool.query(
      'SELECT operation_id,ordinal,path,payload,state,receipt FROM prepared_wire_steps ORDER BY operation_id,ordinal',
    )
  ).rows;
  report.scenarios.push(scenario);
  await writeFile(join(directory, 'matrix.json'), JSON.stringify(report, null, 2));
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  report.schemaRemoved = true;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'matrix.json'), JSON.stringify(report, null, 2));
  restoreNow?.();
  vi.restoreAllMocks();
});

it('updates nonadjacent model prices across three shops with shared SKUs and reversed model responses', async () => {
  const listings = await Promise.all([create(0, 2), create(1, 2), create(2, 2)]),
    initial = platform.snapshot().items;
  for (const listing of listings) {
    const otherShopsBefore = platform
      .snapshot()
      .items.filter((item) => item.shopId !== listing.shopId);
    expect(listing.raw.models.model.map((model) => model.model_sku)).toEqual(
      listing.document.models.map((model) => model.sku).reverse(),
    );
    const selected = [listing.document.models[3]!.sku, listing.document.models[0]!.sku];
    const patch = await planned(listing, ['price'], selected, (desired) => {
      desired.document.models[0]!.originalPrice = String(
        Number(desired.document.models[0]!.originalPrice) - 2300,
      );
      desired.document.models[3]!.originalPrice = String(
        Number(desired.document.models[3]!.originalPrice) + 6700,
      );
    });
    const execution = await execute(listing, patch.plan, 'multi-price');
    expect(execution.result.state).toBe('acknowledged');
    const after = await read(listing);
    expect(checkPreparedWireUpdate(patch.before, after, patch.plan.steps).verified).toBe(true);
    for (const model of after.models.model as WireObject[]) {
      const source = patch.desired.document.models.find(
        (candidate) => candidate.sku === model.model_sku,
      )!;
      expect(model.price_info[0].original_price).toBe(Number(source.originalPrice));
      const old = patch.before.models.model.find(
        (candidate) => candidate.model_id === model.model_id,
      )! as WireObject;
      if (!selected.includes(model.model_sku)) expect(model).toEqual(old);
    }
    expect((after.item as WireObject).image).toEqual(patch.before.item.image);
    expect(platform.snapshot().items.filter((item) => item.shopId !== listing.shopId)).toEqual(
      otherShopsBefore,
    );
    record({ shopId: listing.shopId, selected, ...patch, execution, after });
  }
  expect(platform.snapshot().items).toHaveLength(3);
  expect(new Set(initial.map((item) => item.shopId)).size).toBe(3);
  expect(
    new Set(
      listings.flatMap((listing) => listing.remote.modelBindings.map((model) => model.modelId)),
    ).size,
  ).toBe(12);
});

it.each([0, 2])(
  'sets explicit zero stock for a %i-tier listing without changing unselected models or price',
  async (tiers) => {
    const listing = await create(0, tiers),
      selected = tiers
        ? [listing.document.models[0]!.sku, listing.document.models[2]!.sku]
        : [listing.document.models[0]!.sku];
    const patch = await planned(listing, ['stock'], selected, (desired) => {
      for (const model of desired.document.models)
        if (selected.includes(model.sku)) model.stock = 0;
    });
    const execution = await execute(listing, patch.plan, 'zero-stock');
    expect(execution.result.state).toBe('acknowledged');
    const after = await read(listing);
    expect(checkPreparedWireUpdate(patch.before, after, patch.plan.steps).verified).toBe(true);
    const targets = tiers ? (after.models.model as WireObject[]) : [after.item as WireObject];
    expect(targets.filter((model) => model.stock_info_v2.seller_stock[0].stock === 0)).toHaveLength(
      selected.length,
    );
    expect(patch.plan.steps[0]!.payload.stock_list.map((row: WireObject) => row.model_id)).toEqual(
      selected.map((sku) =>
        Number(listing.remote.modelBindings.find((binding) => binding.sku === sku)!.modelId),
      ),
    );
    record({ ...patch, execution, after });
  },
);

it.each([
  ['cover', 'gallery'],
  ['gallery', 'cover'],
] as PreparedField[][])(
  'preserves the correct cover through ordered %s then %s image updates',
  async (first, second) => {
    const listing = await create(0, 1),
      cover = await asset(listing, 'cover'),
      gallery = await asset(listing, 'gallery');
    const patch = await planned(listing, [first, second], [], (desired) => {
      desired.document.cover = cover;
      desired.document.gallery = [gallery, desired.document.gallery[0]!];
    });
    const execution = await execute(listing, patch.plan, 'combined-images');
    expect(execution.result.state).toBe('acknowledged');
    const after = await read(listing),
      qc = checkPreparedWireUpdate(patch.before, after, patch.plan.steps);
    expect(qc).toEqual({ verified: true, mismatchedPaths: [] });
    expect((after.item.promotion_image as WireObject).image_id_list).toEqual([
      mediaId(listing, cover, 'cover'),
    ]);
    expect((after.item.image as WireObject).image_id_list).toEqual(
      patch.desired.document.gallery.map((image) => mediaId(listing, image, 'gallery')),
    );
    expect(after.models).toEqual(patch.before.models);
    record({ ...patch, execution, after, qc });
  },
);

it('updates one first-tier option image for both selected combinations, retaining the other option and all model identities', async () => {
  const listing = await create(0, 2),
    selected = listing.document.models
      .filter((model) => model.tierIndex[0] === 0)
      .map((model) => model.sku),
    image = await asset(listing, 'variation');
  const patch = await planned(listing, ['variationImages'], selected, (desired) => {
    for (const model of desired.document.models)
      if (selected.includes(model.sku)) model.image = image;
  });
  const execution = await execute(listing, patch.plan, 'option-image');
  expect(execution.result.state).toBe('acknowledged');
  const after = await read(listing);
  expect(checkPreparedWireUpdate(patch.before, after, patch.plan.steps).verified).toBe(true);
  expect(after.models.model).toEqual(patch.before.models.model);
  expect((after.models.tier_variation[0]!.option_list as WireObject[])[0]!.image.image_id).toBe(
    mediaId(listing, image, 'variation'),
  );
  expect((after.models.tier_variation[0]!.option_list as WireObject[])[1]).toEqual(
    (patch.before.models.tier_variation[0]!.option_list as WireObject[])[1],
  );
  expect(after.item).toEqual(patch.before.item);
  record({ selected, ...patch, execution, after });
});

it('blocks a source image conflict when only one SKU of a shared first-tier option is changed', async () => {
  const listing = await create(0, 2),
    image = await asset(listing, 'variation'),
    before = await read(listing),
    desired = clone(listing.remote),
    writes = postCalls().length;
  desired.document.models[0]!.image = image;
  listing.context.baseline = before;
  const plan = planPreparedWireUpdate(
    listing.remote,
    desired,
    ['variationImages'],
    [desired.document.models[0]!.sku],
    listing.context,
  );
  expect(plan).toMatchObject({
    kind: 'blocked',
    issues: [expect.objectContaining({ code: 'PREPARED_WIRE_OPTION_IMAGE_CONFLICT' })],
  });
  expect(postCalls()).toHaveLength(writes);
  record({ before, desired, plan });
});

it('stops a price-stock-cover plan after a partial price write and never replays any stage', async () => {
  const listing = await create(0, 2),
    cover = await asset(listing, 'cover'),
    selected = listing.document.models.slice(0, 2).map((model) => model.sku);
  const patch = await planned(listing, ['price', 'stock', 'cover'], selected, (desired) => {
    desired.document.cover = cover;
    for (const model of desired.document.models)
      if (selected.includes(model.sku)) {
        model.originalPrice = String(Number(model.originalPrice) + 3100);
        model.stock += 7;
      }
  });
  platform.faults.push({
    path: api('update_price'),
    itemId: listing.remote.itemId,
    kind: 'partial',
    successCount: 1,
  });
  const writes = postCalls().length,
    execution = await execute(listing, patch.plan, 'partial-multifield');
  expect(execution.result.state).toBe('unknown');
  expect(execution.result.steps).toHaveLength(1);
  const after = await read(listing);
  expect(checkPreparedWireUpdate(patch.before, after, patch.plan.steps).verified).toBe(false);
  expect(after.item.promotion_image).toEqual(patch.before.item.promotion_image);
  for (const model of after.models.model)
    expect(model.stock_info_v2).toEqual(
      patch.before.models.model.find((old) => old.model_id === model.model_id)!.stock_info_v2,
    );
  const reloaded = new PreparedWireRunner(repo, runner.options);
  await reloaded.run(execution.result.id);
  await reloaded.run(execution.result.id);
  expect(postCalls()).toHaveLength(writes + 1);
  record({ ...patch, execution, after, replayPrevented: true });
});

it('reads a committed cover after lost response while keeping the journal unknown and preventing replay', async () => {
  const listing = await create(0, 1),
    cover = await asset(listing, 'cover');
  const patch = await planned(listing, ['cover'], [], (desired) => {
    desired.document.cover = cover;
  });
  platform.faults.push({
    path: api('update_item'),
    itemId: listing.remote.itemId,
    kind: 'drop_response',
  });
  const writes = postCalls().length,
    execution = await execute(listing, patch.plan, 'cover-lost-response');
  expect(execution.result.state).toBe('unknown');
  const after = await read(listing),
    qc = checkPreparedWireUpdate(patch.before, after, patch.plan.steps);
  expect(qc.verified).toBe(true);
  expect((after.item.promotion_image as WireObject).image_id_list).toEqual([
    mediaId(listing, cover, 'cover'),
  ]);
  const reloaded = new PreparedWireRunner(repo, runner.options);
  await reloaded.run(execution.result.id);
  expect((await reloaded.get(execution.result.id)).state).toBe('unknown');
  expect(postCalls()).toHaveLength(writes + 1);
  record({
    ...patch,
    execution,
    after,
    qc,
    journalRemainsUnknownUntilExplicitReconciliation: true,
  });
});

it('times out through the real transport AbortSignal after the fixture commits and never replays the write', async () => {
  const listing = await create(0, 0),
    patch = await planned(listing, ['stock'], [listing.document.models[0]!.sku], (desired) => {
      desired.document.models[0]!.stock = 0;
    });
  let intercepted = false,
    abortName = '';
  const delayed: typeof fetch = async (request, init) => {
    const response = await platform.fetch(request, init);
    if (!intercepted && new URL(String(request)).pathname === api('update_stock')) {
      intercepted = true;
      const signal = init?.signal;
      expect(signal).toBeDefined();
      await new Promise<never>((_, reject) => {
        const abort = () => {
          abortName = signal!.reason?.name ?? '';
          reject(signal!.reason);
        };
        if (signal!.aborted) abort();
        else signal!.addEventListener('abort', abort, { once: true });
      });
    }
    return response;
  };
  runner = new PreparedWireRunner(repo, { ...runner.options, transport: delayed });
  const started = performance.now(),
    count = postCalls().length,
    execution = await execute(listing, patch.plan, 'real-deadline-after-commit'),
    elapsed = performance.now() - started;
  expect(abortName).toBe('TimeoutError');
  expect(elapsed).toBeGreaterThanOrEqual(11000);
  expect(execution.result.state).toBe('unknown');
  const after = await read(listing);
  expect(checkPreparedWireUpdate(patch.before, after, patch.plan.steps).verified).toBe(true);
  expect((after.item.stock_info_v2 as WireObject).seller_stock[0].stock).toBe(0);
  await new PreparedWireRunner(repo, runner.options).run(execution.result.id);
  expect(postCalls()).toHaveLength(count + 1);
  record({
    ...patch,
    execution,
    after,
    abortName,
    realWallElapsedMs: elapsed,
    replayPrevented: true,
  });
}, 20000);

it('rejects one stale read then matches a fresh read without repeating the acknowledged write', async () => {
  const listing = await create(0, 2),
    patch = await planned(listing, ['title'], [], (desired) => {
      desired.document.title += ' · nguồn v2';
    });
  const execution = await execute(listing, patch.plan, 'stale-response');
  expect(execution.result.state).toBe('acknowledged');
  const writes = postCalls().length;
  platform.faults.push({
    path: api('get_item_base_info'),
    itemId: listing.remote.itemId,
    kind: 'response',
    body: {
      error: '',
      message: '',
      request_id: 'qa-stale-once',
      response: { item_list: [patch.before.item] },
    },
  });
  const stale = await read(listing),
    fresh = await read(listing);
  expect(checkPreparedWireUpdate(patch.before, stale, patch.plan.steps).verified).toBe(false);
  expect(checkPreparedWireUpdate(patch.before, fresh, patch.plan.steps).verified).toBe(true);
  expect(postCalls()).toHaveLength(writes);
  record({ ...patch, execution, stale, fresh, mutationRepeated: false });
});

it('holds another item of an unknown shop while an independent shop continues', async () => {
  const one = await create(0, 0),
    sameShop = await create(0, 0),
    otherShop = await create(1, 0);
  const first = await planned(one, ['stock'], [one.document.models[0]!.sku], (desired) => {
    desired.document.models[0]!.stock = 0;
  });
  platform.faults.push({ path: api('update_stock'), shopId: one.shopId, kind: 'drop_response' });
  const lost = await execute(one, first.plan, 'quarantine');
  expect(lost.result.state).toBe('unknown');
  const heldPlan = await planned(sameShop, ['title'], [], (desired) => {
    desired.document.title += ' · held';
  });
  const count = postCalls().length,
    held = await execute(sameShop, heldPlan.plan, 'same-owner-held');
  expect(held.result.state).toBe('prepared');
  expect(postCalls()).toHaveLength(count);
  const otherPlan = await planned(
    otherShop,
    ['price'],
    [otherShop.document.models[0]!.sku],
    (desired) => {
      desired.document.models[0]!.originalPrice = '39000';
    },
  );
  const other = await execute(otherShop, otherPlan.plan, 'other-owner-progress');
  expect(other.result.state).toBe('acknowledged');
  expect(
    checkPreparedWireUpdate(otherPlan.before, await read(otherShop), otherPlan.plan.steps).verified,
  ).toBe(true);
  record({ lost, held, other, unknownBlocksOnlyExactOwner: true });
});

it('blocks a changed connection revision after prepare before any mutation', async () => {
  const listing = await create(0, 0),
    patch = await planned(listing, ['price'], [listing.document.models[0]!.sku], (desired) => {
      desired.document.models[0]!.originalPrice = '45000';
    });
  const request = input(listing, patch.plan, 'connection-cas'),
    prepared = await runner.prepare(request),
    count = postCalls().length;
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [request.connectionId]);
  const result = await runner.run(prepared.id);
  expect(result.state).toBe('blocked');
  expect(result.steps).toEqual([]);
  expect(postCalls()).toHaveLength(count);
  record({ ...patch, request, result, stoppedBeforeDispatch: true });
});

it('sends an update once when two runners race the same persisted intent', async () => {
  const listing = await create(0, 1),
    patch = await planned(listing, ['stock'], [listing.document.models[1]!.sku], (desired) => {
      desired.document.models[1]!.stock = 1;
    });
  const request = input(listing, patch.plan, 'parallel-runners'),
    prepared = await runner.prepare(request),
    count = postCalls().length;
  const second = new PreparedWireRunner(repo, runner.options),
    results = await Promise.all([runner.run(prepared.id), second.run(prepared.id)]),
    final = await runner.get(prepared.id);
  expect(final.state).toBe('acknowledged');
  expect(final.steps).toHaveLength(1);
  expect(postCalls()).toHaveLength(count + 1);
  expect(
    checkPreparedWireUpdate(patch.before, await read(listing), patch.plan.steps).verified,
  ).toBe(true);
  record({ ...patch, request, results, final, mutationCount: 1 });
});

it('detects unselected drift after an old plan but records that the raw journal has no automatic preflight or QC state transition', async () => {
  const listing = await create(0, 0),
    patch = await planned(listing, ['title'], [], (desired) => {
      desired.document.title += ' · planned earlier';
    });
  const request = input(listing, patch.plan, 'stale-baseline'),
    prepared = await runner.prepare(request);
  success(
    await listing.client.write(api('update_stock'), {
      item_id: Number(listing.remote.itemId),
      stock_list: [{ model_id: 0, seller_stock: [{ stock: 77 }] }],
    }),
  );
  const result = await runner.run(prepared.id);
  expect(result.state).toBe('acknowledged');
  const after = await read(listing),
    qc = checkPreparedWireUpdate(patch.before, after, patch.plan.steps);
  expect(qc.verified).toBe(false);
  expect((after.item.stock_info_v2 as WireObject).seller_stock[0].stock).toBe(77);
  const gap = {
    code: 'WIRE_JOURNAL_HAS_NO_REMOTE_BASELINE_PREFLIGHT',
    source: 'observed integration behavior',
    operationId: result.id,
    journalState: result.state,
    qcVerified: false,
    implication:
      'Caller must check a fresh remote baseline and explicitly consume QC before presenting the operation as verified.',
  };
  report.gaps.push(gap);
  record({ ...patch, request, result, after, qc, gap });
});
