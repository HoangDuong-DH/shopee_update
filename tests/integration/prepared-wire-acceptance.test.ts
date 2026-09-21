import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import { SandboxPreparedTransport } from '../../packages/shopee/src/prepared-transport.js';
import {
  planPreparedWireCreate,
  planPreparedWireUpdate,
  preparedWireMediaRequirements,
  type PreparedWireContext,
  type PreparedWireImageRole,
  type PreparedWirePlan,
} from '../../packages/shopee/src/prepared-wire.js';
import { PreparedWireRunner } from '../../apps/api/src/prepared-wire-runner.js';
import type {
  PreparedDocument,
  PreparedField,
  PreparedMedia,
  PreparedRemote,
  Scope,
} from '../../packages/domain/src/index.js';
import type { FieldSnapshot } from '../../packages/shopee/src/field-client.js';
import {
  createBusinessBatchFixture,
  type BusinessBatchFixture,
  type BusinessListingFixture,
} from '../fixtures/business-batch-fixtures.js';
import { PreparedWirePlatform, type WireObject } from '../fixtures/prepared-wire-platform.js';

const schema = 'test_wire_accept_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema}`,
});
const repo = new Repository(pool),
  key = Buffer.alloc(32, 37).toString('hex');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const p = (name: string) => '/api/v2/' + name;
let fixture: BusinessBatchFixture,
  platform: PreparedWirePlatform,
  runner: PreparedWireRunner,
  clock: number;
const connections = new Map<
  string,
  { id: string; scope: Scope; client: SandboxPreparedTransport }
>();
type Case = {
  listing: BusinessListingFixture;
  document: PreparedDocument;
  context: PreparedWireContext;
  files: Map<string, string>;
  original?: PreparedRemote;
  raw?: FieldSnapshot;
  operationId?: string;
};
const cases: Case[] = [];
const proof: WireObject = {
  kind: 'local-http-wire-simulation',
  schema,
  externalRequests: 0,
  created: [],
  updates: [],
  faults: [],
  sourceBlocks: [],
  sourceFilesUnchanged: false,
  acknowledgedIsNotQc: true,
};
let restoredNow: (() => void) | undefined;
const successful = (value: any): Record<string, any> => {
  expect(value.kind, JSON.stringify(value)).toBe('success');
  if (value.kind !== 'success') throw new Error(JSON.stringify(value));
  return value.response;
};
const ready = (plan: PreparedWirePlan) => {
  expect(plan.kind, JSON.stringify(plan)).toBe('ready');
  if (plan.kind !== 'ready') throw new Error(JSON.stringify(plan));
  return plan;
};
async function persistProof() {
  if (fixture)
    await writeFile(join(fixture.root, 'wire-acceptance.json'), JSON.stringify(proof, null, 2));
}
async function media(file: string, files: Map<string, string>): Promise<PreparedMedia> {
  const bytes = await readFile(file),
    meta = await sharp(bytes).metadata(),
    importId = randomUUID();
  files.set(importId, file);
  return {
    importId,
    sha256: sha(bytes),
    width: meta.width!,
    height: meta.height!,
    mime: 'image/png',
  };
}
async function extraSquare(index: number, option: number, files: Map<string, string>, version = 1) {
  const file = join(
    fixture.root,
    'wire-explicit-option-images',
    `${index}-${option}-v${version}.png`,
  );
  await mkdir(resolve(file, '..'), { recursive: true });
  const label = Buffer.from(
    `<svg width="96" height="96"><text x="3" y="28" font-size="9" fill="white">QA WIRE ${index}</text><text x="3" y="47" font-size="9" fill="white">OPTION ${option} V${version}</text></svg>`,
  );
  const bytes = await sharp({
    create: {
      width: 96,
      height: 96,
      channels: 3,
      background: { r: (index * 13 + 70) % 220, g: (option * 65 + 50) % 220, b: version * 60 },
    },
  })
    .composite([{ input: label }])
    .png()
    .toBuffer();
  await writeFile(file, bytes);
  return media(file, files);
}
async function uploadRequirements(entry: Case) {
  const client = connections.get(entry.listing.shopId)!.client;
  for (const required of preparedWireMediaRequirements(entry.document)) {
    if (
      entry.context.images.some(
        (binding) => binding.importId === required.media.importId && binding.role === required.role,
      )
    )
      continue;
    const bytes = await readFile(entry.files.get(required.media.importId)!);
    expect(sha(bytes)).toBe(required.media.sha256);
    const response = successful(
      await client.upload(bytes, 'image/png', required.scene === 'desc' ? { scene: 'desc' } : { scene: 'normal', ratio: required.ratio! }),
    );
    const imageId = response.image_info?.image_id;
    expect(typeof imageId).toBe('string');
    entry.context.images.push({
      importId: required.media.importId,
      sha256: required.media.sha256,
      role: required.role,
      imageId,
    });
    const stored = platform.snapshot().images.find((image) => image.imageId === imageId)!;
    expect(stored.sha256).toBe(required.media.sha256);
  }
}
const imageId = (entry: Case, value: PreparedMedia, role: PreparedWireImageRole) => {
  const binding = entry.context.images.find(
    (binding) =>
      binding.importId === value.importId &&
      binding.sha256 === value.sha256 &&
      binding.role === role,
  );
  expect(binding).toBeDefined();
  return binding!.imageId;
};
async function read(entry: Case, itemId: string): Promise<FieldSnapshot> {
  const client = connections.get(entry.listing.shopId)!.client;
  const base = successful(
    await client.read(p('product/get_item_base_info'), { item_id_list: itemId }),
  );
  expect(base.item_list).toHaveLength(1);
  const models = successful(await client.read(p('product/get_model_list'), { item_id: itemId }));
  const promotions = await client.read(p('product/get_item_promotion'), { item_id_list: itemId });
  const promotionResponse = successful(promotions);
  entry.context.promotionSnapshot = { error: '', request_id: promotions.requestId, response: promotionResponse };
  return { item: base.item_list[0], models: models as FieldSnapshot['models'] };
}
/** Expected values come from authored source fields, never from the request plan. */
function checkRaw(entry: Case, itemId: string, raw: FieldSnapshot): PreparedRemote {
  const doc = entry.document,
    base: WireObject = raw.item;
  expect(String(base.item_id)).toBe(itemId);
  expect(base.item_name).toBe(doc.title);
  expect(base.category_id).toBe(Number(doc.categoryId));
  expect(base.brand).toEqual({
    brand_id: Number(doc.brandId),
    original_brand_name: entry.context.brandName,
  });
  expect(base.weight).toBe(String(doc.weightGrams / 1000));
  expect(base.dimension).toEqual({
    package_length: doc.dimensionCm.length,
    package_width: doc.dimensionCm.width,
    package_height: doc.dimensionCm.height,
  });
  expect(
    base.logistic_info.map((channel: WireObject) => ({
      channelId: String(channel.logistic_id),
      enabled: channel.enabled,
    })),
  ).toEqual(doc.logistics);
  expect(
    base.attribute_list.map((attr: WireObject) => [
      String(attr.attribute_id),
      attr.attribute_value_list.map((value: WireObject) => String(value.value_id)),
    ]),
  ).toEqual(Object.entries(doc.attributes));
  expect(base.image).toEqual({
    image_id_list: doc.gallery.map((value) => imageId(entry, value, 'gallery')),
    image_ratio: '3:4',
  });
  expect(base.promotion_image.image_id_list).toEqual([imageId(entry, doc.cover, 'cover')]);
  expect(base.description_type).toBe('extended');
  expect(base.description_info.extended_description.field_list).toEqual(
    doc.description.map((block) =>
      block.type === 'text'
        ? { field_type: 'text', text: block.text }
        : {
            field_type: 'image',
            image_info: { image_id: imageId(entry, block.image, 'description') },
          },
    ),
  );
  expect(base.item_status).toBe('UNLIST');
  expect(base.condition).toBe(entry.context.condition);
  expect(base.pre_order).toEqual(entry.context.preOrder);
  expect(base.has_model).toBe(doc.tierNames.length > 0);
  const rawModels = raw.models.model as WireObject[];
  expect(rawModels).toHaveLength(doc.tierNames.length ? doc.models.length : 0);
  expect(raw.models.tier_variation.map((tier) => tier.name)).toEqual(doc.tierNames);
  const modelBindings = doc.models.map((model) => {
    const found = doc.tierNames.length
      ? rawModels.find((candidate) => candidate.model_sku === model.sku)!
      : base;
    expect(found, model.sku).toBeDefined();
    expect(found.price_info).toEqual([
      {
        currency: 'VND',
        original_price: Number(model.originalPrice),
        current_price: Number(model.originalPrice),
      },
    ]);
    expect(found.stock_info_v2.seller_stock).toEqual([{ stock: model.stock, if_saleable: true }]);
    expect(found.stock_info_v2.summary_info).toEqual({
      total_available_stock: model.stock,
      total_reserved_stock: 0,
    });
    if (doc.tierNames.length) {
      expect(found.tier_index).toEqual(model.tierIndex);
      expect(
        model.tierIndex.map(
          (optionIndex, tierIndex) =>
            (raw.models.tier_variation[tierIndex]!.option_list as WireObject[])[optionIndex]!
              .option,
        ),
      ).toEqual(model.optionLabels);
      if (model.image)
        expect(
          (raw.models.tier_variation[0]!.option_list as WireObject[])[model.tierIndex[0]!]!.image
            .image_id,
        ).toBe(imageId(entry, model.image, 'variation'));
    } else expect(base.item_sku).toBe(model.sku);
    return {
      sku: model.sku,
      modelId: doc.tierNames.length ? String(found.model_id) : '0',
      tierIndex: [...model.tierIndex],
    };
  });
  return { itemId, document: structuredClone(doc), modelBindings, extra: {} };
}
async function execute(entry: Case, plan: PreparedWirePlan, version: string) {
  const { id: connectionId, scope } = connections.get(entry.listing.shopId)!;
  const intent = {
    id: randomUUID(),
    connectionId,
    scope,
    sourceKey: entry.document.sourceKey,
    sourceFingerprint: sha(JSON.stringify({ document: entry.document, version })),
    plan: ready(plan),
  };
  await runner.prepare(intent);
  return runner.run(intent.id);
}

beforeAll(async () => {
  clock = Date.now();
  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  restoredNow = () => nowSpy.mockRestore();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    proof.externalRequests++;
    throw new Error('WIRE_ACCEPTANCE_OUTBOUND_FORBIDDEN');
  });
  fixture = await createBusinessBatchFixture({ root: '.local/acceptance-20260914/prepared-wire' });
  proof.root = fixture.root;
  proof.startedAt = new Date().toISOString();
  proof.sourceManifestSha256 = fixture.manifestSha256;
  await writeFile(
    resolve('.local/acceptance-20260914/prepared-wire-latest.json'),
    JSON.stringify({ root: fixture.root, report: join(fixture.root, 'wire-acceptance.json') }),
  );
  platform = new PreparedWirePlatform({ now: () => clock });
  const allowedShops = platform.shops.map((shop) => ({
    partnerId: shop.credentials.partnerId,
    shopId: shop.credentials.shopId,
  }));
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const box = new SecretBox(key);
  for (const shop of platform.shops) {
    const c = shop.credentials,
      id = randomUUID(),
      owner = `sandbox:${c.partnerId}:${c.shopId}`;
    await pool.query(
      "INSERT INTO connections(id,environment,partner_id,shop_id,name,revision,capability_revision,state,partner_key_ciphertext,token_ciphertext) VALUES($1,'sandbox',$2,$3,$4,1,1,'connected',$5,$6)",
      [
        id,
        c.partnerId,
        c.shopId,
        shop.profile.name,
        box.seal({ partnerKey: c.partnerKey }, owner),
        box.seal({ accessToken: c.accessToken }, owner),
      ],
    );
    connections.set(c.shopId, {
      id,
      scope: {
        environment: 'sandbox',
        partnerId: c.partnerId,
        shopId: c.shopId,
        connectionRevision: 1,
        capabilityRevision: 1,
      },
      client: new SandboxPreparedTransport(c, allowedShops, platform.fetch),
    });
  }
  runner = new PreparedWireRunner(repo, {
    allowedShops,
    encryptionKey: key,
    transport: platform.fetch,
    now: () => new Date(clock),
    pause: async (ms) => {
      clock += ms;
    },
  });
  for (const listing of fixture.listings) {
    const files = new Map<string, string>(),
      lookup = async (filename: string) => media(join(listing.folderPath, filename), files);
    const cover = await lookup(listing.media.coverPath),
      galleries = new Map<string, PreparedMedia>();
    for (const filename of listing.media.galleryPaths)
      galleries.set(filename, await lookup(filename));
    const options = new Map<number, PreparedMedia>();
    for (const variant of listing.variants)
      if (listing.tierNames.length && !options.has(variant.tierIndex[0]!))
        options.set(
          variant.tierIndex[0]!,
          await extraSquare(listing.index, variant.tierIndex[0]!, files),
        );
    const document: PreparedDocument = {
      sourceKey: listing.productKey,
      title: listing.title,
      description: listing.expectedDescription.blocks.map((block) =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'image', image: galleries.get(block.path)! },
      ),
      cover,
      gallery: listing.media.galleryPaths.map((filename) => galleries.get(filename)!),
      tierNames: listing.tierNames,
      models: listing.variants.map((variant) => ({
        sku: variant.sku,
        optionLabels: variant.optionLabels,
        tierIndex: variant.tierIndex,
        originalPrice: variant.originalPrice,
        stock: variant.stock,
        ...(listing.tierNames.length ? { image: options.get(variant.tierIndex[0]!)! } : {}),
      })),
      categoryId: listing.categoryId,
      brandId: listing.brandId,
      attributes: Object.fromEntries(
        listing.attributes.map((attribute) => [attribute.attributeId, [attribute.valueId]]),
      ),
      logistics: [{ channelId: listing.logistics.channelId, enabled: true }],
      weightGrams: listing.logistics.weightGrams,
      dimensionCm: {
        length: listing.logistics.lengthCm,
        width: listing.logistics.widthCm,
        height: listing.logistics.heightCm,
      },
      publication: 'unlisted',
    };
    const client = connections.get(listing.shopId)!.client;
    const limits = successful(
      await client.read(p('product/get_item_limit'), { category_id: listing.categoryId }),
    );
    const brands = successful(
      await client.read(p('product/get_brand_list'), {
        category_id: listing.categoryId,
        offset: '0',
        page_size: '100',
        status: '1',
      }),
    );
    const attributes = successful(
      await client.read(p('product/get_attribute_tree'), { category_id_list: listing.categoryId }),
    );
    const channels = successful(await client.read(p('logistics/get_channel_list')));
    const context: PreparedWireContext = {
      images: [],
      brandName: brands.brand_list.find(
        (brand: WireObject) => String(brand.brand_id) === listing.brandId,
      )!.original_brand_name,
      condition: 'NEW',
      preOrder: { is_pre_order: false },
      gtinBySku: Object.fromEntries(listing.variants.map((variant) => [variant.sku, '00'])),
      stockLocationBySku: Object.fromEntries(
        listing.variants.map((variant) => [variant.sku, null]),
      ),
      limits,
      attributeList: listing.attributes.map((selected) => {
        const attribute = attributes.list[0].attribute_tree.find(
          (attribute: WireObject) => String(attribute.attribute_id) === selected.attributeId,
        );
        const value = attribute.attribute_value_list.find(
          (value: WireObject) => String(value.value_id) === selected.valueId,
        );
        return {
          attribute_id: Number(selected.attributeId),
          attribute_value_list: [
            { value_id: Number(selected.valueId), original_value_name: value.name },
          ],
        };
      }),
      capabilities: { gallery34: true, extendedDescription: true },
      channelInfoById: Object.fromEntries(
        channels.logistics_channel_list.map((channel: WireObject) => [
          String(channel.logistics_channel_id),
          channel,
        ]),
      ),
    };
    cases.push({ listing, document, context, files });
  }
  proof.inputDocuments = cases.map((entry) => ({
    shopId: entry.listing.shopId,
    document: entry.document,
    explicitSource: {
      condition: entry.context.condition,
      preOrder: entry.context.preOrder,
      gtinBySku: entry.context.gtinBySku,
      stockLocationBySku: entry.context.stockLocationBySku,
    },
    optionImages: [...entry.files].filter(([, path]) =>
      path.includes('wire-explicit-option-images'),
    ),
  }));
  await persistProof();
}, 120000);

afterAll(async () => {
  if (platform) {
    proof.platform = platform.snapshot();
    proof.logicalClockAdvancedMs = clock - (proof.initialLogicalClock ?? clock);
  }
  if (fixture) {
    proof.originalHashes = await Promise.all(
      fixture.files.map(async (file) => ({
        path: file.path,
        expected: file.sha256,
        actual: sha(await readFile(file.path)),
      })),
    );
    proof.sourceFilesUnchanged = proof.originalHashes.every(
      (file: WireObject) => file.actual === file.expected,
    );
    proof.finishedAt = new Date().toISOString();
  }
  try {
    proof.database = (
      await pool.query(
        'SELECT state,count(*)::int count FROM prepared_wire_operations GROUP BY state ORDER BY state',
      )
    ).rows;
  } catch {}
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  proof.schemaRemoved = true;
  await persistProof();
  restoredNow?.();
  vi.restoreAllMocks();
});

it('executes80 source documents through signed multipart/JSON, actual codec and durable PG runner; independently reads all80', async () => {
  const started = performance.now();
  proof.initialLogicalClock = clock;
  for (const entry of cases) {
    await uploadRequirements(entry);
    const result = await execute(
      entry,
      planPreparedWireCreate(entry.document, entry.context),
      'create-v1',
    );
    expect(result.state, JSON.stringify(result.result)).toBe('acknowledged');
    const raw = await read(entry, result.itemId);
    entry.original = checkRaw(entry, result.itemId, raw);
    entry.raw = raw;
    entry.operationId = result.id;
    const stepsBefore = platform.calls.filter((call) => call.committed).length;
    expect((await runner.run(result.id)).state).toBe('acknowledged');
    expect(platform.calls.filter((call) => call.committed)).toHaveLength(stepsBefore);
    if (entry.document.tierNames.length)
      expect(
        new Date(result.steps[1].sentAt).getTime() -
          new Date(result.steps[0].acknowledgedAt).getTime(),
      ).toBeGreaterThanOrEqual(5000);
    proof.created.push({
      shopId: entry.listing.shopId,
      sourceKey: entry.document.sourceKey,
      operationId: result.id,
      itemId: result.itemId,
      steps: result.steps,
      independentReadback: raw,
      matched: true,
    });
  }
  expect(proof.created).toHaveLength(80);
  expect(platform.snapshot().items).toHaveLength(80);
  expect(
    platform.calls.filter((call) => call.path === p('product/add_item') && call.committed),
  ).toHaveLength(80);
  expect(
    platform.calls.filter(
      (call) => call.path === p('product/init_tier_variation') && call.committed,
    ),
  ).toHaveLength(48);
  expect(cases.reduce((sum, entry) => sum + entry.document.models.length, 0)).toBe(200);
  proof.create = {
    count: 80,
    modelCountIncludingZeroTier: 200,
    tierCounts: fixture.expected.tierCounts,
    shopCounts: fixture.expected.shopCounts,
    categoryCounts: fixture.expected.categoryCounts,
    wallDurationMs: performance.now() - started,
    independentRawComparisonsPassed: 80,
    acknowledgedOperations: 80,
  };
  await persistProof();
}, 120000);

const groups: PreparedField[] = [
  'title',
  'description',
  'cover',
  'gallery',
  'variationImages',
  'price',
  'stock',
  'attributes',
  'logistics',
];
it.each(groups)(
  'applies real changed source %s and compares the complete raw remainder unchanged',
  async (field) => {
    const index = groups.indexOf(field),
      entry = cases[12 + index]!;
    expect(entry.original).toBeDefined();
    const baseline = structuredClone(entry.original!),
      desired = structuredClone(baseline),
      before = await read(entry, baseline.itemId);
    const selectedSkus = [desired.document.models[0]!.sku],
      target = desired.document.models[0]!;
    if (field === 'title') desired.document.title += ' V2';
    if (field === 'description')
      (desired.document.description[0] as { type: 'text'; text: string }).text +=
        'Dòng nguồn phiên bản 2\n';
    if (field === 'cover')
      desired.document.cover = await extraSquare(entry.listing.index, 90, entry.files, 2);
    if (field === 'gallery') desired.document.gallery.reverse();
    if (field === 'variationImages')
      target.image = await extraSquare(entry.listing.index, 91, entry.files, 2);
    if (field === 'price') target.originalPrice = String(Number(target.originalPrice) + 1700);
    if (field === 'stock') target.stock += 17;
    if (field === 'attributes') {
      const category = fixture.categories.find(
        (category) => category.categoryId === desired.document.categoryId,
      )!;
      const attrId = category.requiredAttribute.attributeId,
        previous = desired.document.attributes[attrId]![0];
      const next = category.requiredAttribute.values.find((value) => value.valueId !== previous)!;
      desired.document.attributes[attrId] = [next.valueId];
      entry.context.attributeList = [
        {
          attribute_id: Number(attrId),
          attribute_value_list: [
            { value_id: Number(next.valueId), original_value_name: next.name },
          ],
        },
      ];
    }
    if (field === 'logistics') {
      desired.document.weightGrams += 51;
      desired.document.dimensionCm.height += 1;
    }
    entry.document = desired.document;
    await uploadRequirements(entry);
    entry.context.baseline = before;
    const plan = planPreparedWireUpdate(baseline, desired, [field], selectedSkus, entry.context);
    const result = await execute(entry, plan, 'update-' + field);
    expect(result.state, JSON.stringify(result.result)).toBe('acknowledged');
    const after = await read(entry, baseline.itemId),
      expected: WireObject = structuredClone(before);
    if (field === 'title') expected.item.item_name = desired.document.title;
    if (field === 'description')
      expected.item.description_info.extended_description.field_list[0].text = (
        desired.document.description[0] as any
      ).text;
    if (field === 'cover')
      expected.item.promotion_image.image_id_list = [
        imageId(entry, desired.document.cover, 'cover'),
      ];
    if (field === 'gallery')
      expected.item.image.image_id_list = desired.document.gallery.map((image) =>
        imageId(entry, image, 'gallery'),
      );
    if (field === 'variationImages') {
      const id = imageId(entry, target.image!, 'variation');
      expected.models.tier_variation[0].option_list[0].image.image_id = id;
      expected.models.tier_variation[0].option_list[0].image.image_url =
        'https://fixture.invalid/file/' + id;
      expected.models.standardise_tier_variation[0].variation_option_list[0].image_id = id;
    }
    if (field === 'price' || field === 'stock') {
      const model = expected.models.model.find(
        (model: WireObject) => model.model_sku === target.sku,
      );
      if (field === 'price')
        model.price_info = [
          {
            currency: 'VND',
            original_price: Number(target.originalPrice),
            current_price: Number(target.originalPrice),
          },
        ];
      else {
        model.stock_info_v2.seller_stock[0].stock = target.stock;
        model.stock_info_v2.summary_info.total_available_stock = target.stock;
      }
    }
    if (field === 'attributes') expected.item.attribute_list = entry.context.attributeList;
    if (field === 'logistics') {
      expected.item.weight = String(desired.document.weightGrams / 1000);
      expected.item.dimension.package_height = desired.document.dimensionCm.height;
    }
    if (!['variationImages', 'price', 'stock'].includes(field))
      expected.item.update_time = Math.floor(clock / 1000);
    expect(after).not.toEqual(before);
    expect(after).toEqual(expected);
    entry.original = checkRaw(entry, baseline.itemId, after);
    entry.raw = after;
    proof.updates.push({
      field,
      selectedSkus,
      sourceKey: entry.document.sourceKey,
      before,
      desired,
      after,
      result,
      completeRemainderEqual: true,
    });
    await persistProof();
  },
);

it('updatesprice+stock in12 selected folders across three shops, preserving unselected models and all other listings', async () => {
  const selected = cases.slice(24, 36),
    beforeAll = platform.snapshot().items,
    receipts = [];
  for (const entry of selected) {
    const baseline = structuredClone(entry.original!),
      desired = structuredClone(baseline),
      before = await read(entry, baseline.itemId),
      sku = desired.document.models[0]!.sku;
    desired.document.models[0]!.originalPrice = String(
      Number(desired.document.models[0]!.originalPrice) + 2300,
    );
    desired.document.models[0]!.stock += 23;
    entry.document = desired.document;
    entry.context.baseline = before;
    const result = await execute(
      entry,
      planPreparedWireUpdate(baseline, desired, ['price', 'stock'], [sku], entry.context),
      'bulk-price-stock-v2',
    );
    expect(result.state).toBe('acknowledged');
    const after = await read(entry, baseline.itemId),
      expected: WireObject = structuredClone(before),
      model = expected.models.model.find((model: WireObject) => model.model_sku === sku),
      source = desired.document.models[0]!;
    model.price_info = [
      {
        currency: 'VND',
        original_price: Number(source.originalPrice),
        current_price: Number(source.originalPrice),
      },
    ];
    model.stock_info_v2.seller_stock[0].stock = source.stock;
    model.stock_info_v2.summary_info.total_available_stock = source.stock;
    expect(after).not.toEqual(before);
    expect(after).toEqual(expected);
    entry.original = checkRaw(entry, baseline.itemId, after);
    entry.raw = after;
    receipts.push({
      shopId: entry.listing.shopId,
      sku,
      itemId: baseline.itemId,
      before,
      desired,
      after,
      operationId: result.id,
    });
  }
  const selectedIds = new Set(selected.map((entry) => entry.original!.itemId));
  expect(
    platform.snapshot().items.filter((item) => !selectedIds.has(String(item.base.item_id))),
  ).toEqual(beforeAll.filter((item) => !selectedIds.has(String(item.base.item_id))));
  expect(new Set(receipts.map((entry) => entry.shopId)).size).toBe(3);
  expect(receipts).toHaveLength(12);
  proof.bulkUpdate = {
    listingCount: 12,
    changedModels: 12,
    untouchedModels: 36,
    unaffectedListings: 68,
    receipts,
  };
  await persistProof();
}, 60000);

it('blocksoriginal portrait variation sources and conflicting per-SKU first-option images without executing writes', async () => {
  const entry = cases[24]!,
    doc = structuredClone(entry.document),
    before = platform.calls.length;
  doc.models[0]!.image = { ...doc.gallery[0]! };
  const conflict = planPreparedWireCreate(doc, entry.context);
  expect(conflict.kind).toBe('blocked');
  const oneTier = structuredClone(cases[12]!.document);
  oneTier.models[0]!.image = oneTier.gallery[0];
  const portrait = planPreparedWireCreate(oneTier, cases[12]!.context);
  expect(portrait.kind).toBe('blocked');
  expect(platform.calls).toHaveLength(before);
  proof.sourceBlocks = [
    { name: 'first-option-per-SKU-conflict', result: conflict },
    { name: 'original-portrait-variant', result: portrait },
  ];
  await persistProof();
});

it('stopsa partial model write as unknown and never sends the next field or retries after runner reload', async () => {
  const entry = cases[26]!,
    baseline = structuredClone(entry.original!),
    desired = structuredClone(baseline),
    before = await read(entry, baseline.itemId);
  for (const model of desired.document.models) {
    model.stock += 19;
    model.originalPrice = String(Number(model.originalPrice) + 1900);
  }
  entry.document = desired.document;
  entry.context.baseline = before;
  const plan = ready(
    planPreparedWireUpdate(
      baseline,
      desired,
      ['stock', 'price'],
      desired.document.models.map((model) => model.sku),
      entry.context,
    ),
  );
  platform.faults.push({
    path: p('product/update_stock'),
    shopId: entry.listing.shopId,
    itemId: baseline.itemId,
    kind: 'partial',
    successCount: 1,
  });
  const writeCount = platform.calls.filter((call) => call.method === 'POST').length;
  const result = await execute(entry, plan, 'intentional-partial-fault');
  expect(result.state).toBe('unknown');
  expect(result.steps).toHaveLength(1);
  const after = await read(entry, baseline.itemId),
    expected: WireObject = structuredClone(before),
    first = desired.document.models[0]!;
  const changed = expected.models.model.find((model: WireObject) => model.model_sku === first.sku);
  changed.stock_info_v2.seller_stock[0].stock = first.stock;
  changed.stock_info_v2.summary_info.total_available_stock = first.stock;
  expect(after).toEqual(expected);
  expect(after).not.toEqual(before);
  const reloaded = new PreparedWireRunner(repo, runner.options);
  await reloaded.run(result.id);
  await reloaded.run(result.id);
  expect(platform.calls.filter((call) => call.method === 'POST')).toHaveLength(writeCount + 1);
  proof.faults.push({
    kind: 'partial-stock-stops-before-price',
    before,
    desired,
    after,
    result,
    repeatedRunDidNotResend: true,
  });
  await persistProof();
});

it('reloadspersisted80 create receipts without resending and retains original fixture hashes', async () => {
  const reloaded = new PreparedWireRunner(repo, runner.options),
    before = platform.calls.length;
  for (const entry of cases)
    expect((await reloaded.get(entry.operationId!)).state).toBe('acknowledged');
  expect(platform.calls).toHaveLength(before);
  expect(proof.externalRequests).toBe(0);
  for (const file of fixture.files)
    expect(sha(await readFile(file.path)), file.relativePath).toBe(file.sha256);
  expect(platform.snapshot().items).toHaveLength(80);
  proof.finalCounts = {
    rawItems: 80,
    createOperations: 80,
    successfulSingleGroupUpdates: proof.updates.length,
    successfulBulkListingUpdates: proof.bulkUpdate.listingCount,
    expectedUnknownPartialOperations: 1,
  };
  await persistProof();
});
