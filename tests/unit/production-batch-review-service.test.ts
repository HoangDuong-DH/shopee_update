import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson, preparedWeightKilograms, type PreparedDocument } from '@shopee/domain';
import { expect, it, vi } from 'vitest';
import {
  ProductionBatchReviewService,
  previewObservedWeightMapping,
} from '../../apps/api/src/production-batch-review-service.js';
import { reconcileProductionPilotWeights } from '../../apps/api/src/production-pilot-weight-review.js';
import { preparedWireMediaRequirements } from '../../packages/shopee/src/prepared-wire.js';
import { productionPilotWriteFingerprint } from '../../packages/shopee/src/production-pilot-transport.js';
import { checkPreparedWireCreate } from '../../packages/shopee/src/prepared-wire-qc.js';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
async function fixture() {
  const root = await mkdtemp(resolve('.local', 'weight-review-test-')),
    batchId = randomUUID(),
    operationId = randomUUID(),
    sourceIdentity = 'prepared:row-1';
  const image = {
    importId: randomUUID(),
    sha256: 'c'.repeat(64),
    width: 1024,
    height: 1024,
    mime: 'image/png',
  };
  const document: PreparedDocument = {
    sourceKey: sourceIdentity,
    title: 'Bộ nguồn nguyên văn',
    cover: image,
    gallery: [{ ...image, importId: randomUUID(), width: 768 }],
    description: [{ type: 'text', text: 'Nội dung đã chuẩn bị\n\nGiữ nguyên.' }],
    categoryId: '700',
    brandId: '9',
    attributes: {},
    logistics: [{ channelId: '55', enabled: true }],
    weightGrams: 503.8,
    dimensionCm: { length: 10, width: 8, height: 4 },
    publication: 'unlisted',
    tierNames: ['Dung tích'],
    models: [322.3, 130.9, 503.8].map((grams, index) => ({
      sku: 'SKU-' + index,
      tierIndex: [index],
      optionLabels: ['Loại ' + index],
      originalPrice: '150000',
      stock: 100,
      weightGrams: grams,
      image,
    })),
  };
  const images = preparedWireMediaRequirements(document).map((r, index) => ({
    ...r.media,
    role: r.role,
    imageId: 'image-' + index,
  }));
  const source: any = {
    sourceKey: 'row-1',
    sourceIdentity,
    sourceRevision: 1,
    document,
    proposedAttributeList: [],
    brandName: 'Brand',
    condition: 'NEW',
    preOrder: { is_pre_order: false },
    stockLocation: {
      writeLocationBySku: Object.fromEntries(document.models.map((m) => [m.sku, null])),
      expectedLocationBySku: Object.fromEntries(document.models.map((m) => [m.sku, 'VNZ'])),
    },
  };
  const context: any = {
    images,
    attributeList: [],
    brandName: 'Brand',
    condition: 'NEW',
    preOrder: source.preOrder,
    stockLocationBySku: source.stockLocation.expectedLocationBySku,
    limits: {},
    capabilities: { gallery34: true, extendedDescription: false },
  };
  const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
    loaded: any = {
      manifestPath: resolve(root, 'manifest.json'),
      sha256: 'a'.repeat(64),
      value: {
        version: 1,
        batchId,
        scope,
        assets: {},
        authorizationReference: 'Authorized exact sources',
        listings: [source],
      },
    };
  const sourcePayload = {
    sourceIdentity,
    sourceRevision: 1,
    connectionId: 'connection-1',
    connectionRevision: 2,
    document,
    assets: {},
    context: { ...context, stockLocationBySku: source.stockLocation.writeLocationBySku },
    stockLocationEvidence: { expectedLocationBySku: source.stockLocation.expectedLocationBySku },
    metadata: scope,
    batchAuthorization: {
      batchId,
      manifestSha256: loaded.sha256,
      authorizationReference: loaded.value.authorizationReference,
      sources: [{ sourceIdentity, sourceRevision: 1, documentSha256: hash(document) }],
    },
  };
  const op: any = {
    id: operationId,
    owner_key: 'production:2010476:1423724897',
    source_identity: sourceIdentity,
    source_revision: 1,
    source_payload: sourcePayload,
    expected_projection: { status: 'UNLIST' },
    connection_id: 'connection-1',
    connection_revision: 2,
    revision: 20,
    state: 'acknowledged',
    item_id: '5001',
  };
  op.source_fingerprint = hash({
    scope,
    sourceIdentity,
    sourceRevision: 1,
    sourcePayload,
    expectedProjection: op.expected_projection,
  });
  const now = Date.parse('2026-09-15T12:00:00.000Z');
  const steps: any[] = images.map((image, index) => ({
    step_key: 'media-' + index,
    kind: 'media',
    state: 'acknowledged',
    receipt: {
      kind: 'success',
      response: { image_info: { image_id: image.imageId } },
      requestId: 'upload-' + index,
    },
    recorded_at: new Date(now - 120000).toISOString(),
  }));
  for (const [step_key, path, payload] of [
    [
      'create',
      '/api/v2/product/add_item',
      {
        item_status: 'UNLIST',
        logistic_info: [{ logistic_id: 55, enabled: true, is_free: false }],
      },
    ],
    [
      'variations',
      '/api/v2/product/init_tier_variation',
      { item_id: 5001, tier_variation: [], model: [] },
    ],
  ] as const)
    steps.push({
      step_key,
      path,
      payload,
      kind: step_key,
      state: 'acknowledged',
      fingerprint: productionPilotWriteFingerprint(path, payload),
      receipt: { kind: 'success', response: { item_id: 5001 }, requestId: step_key },
      recorded_at: new Date(now - 120000).toISOString(),
    });
  steps.forEach((step) => (step.outcome_fingerprint = hash(step.receipt)));
  const view: any = {
    operation: op,
    steps,
    publications: 0,
    current_connection: {
      id: 'connection-1',
      revision: 3,
      state: 'connected',
      environment: 'production',
      partner_id: '2010476',
      shop_id: '1423724897',
    },
  };
  const stock = {
    seller_stock: [{ location_id: 'VNZ', stock: 100, if_saleable: true }],
    shopee_stock: [],
    summary_info: { total_reserved_stock: 0, total_available_stock: 100 },
  };
  const raw: any = {
    item: {
      item_id: 5001,
      item_name: document.title,
      item_sku: sourceIdentity,
      item_status: 'UNLIST',
      category_id: 700,
      brand: { brand_id: 9, original_brand_name: 'Brand' },
      condition: 'NEW',
      pre_order: { is_pre_order: false, days_to_ship: 2 },
      weight: '0.504',
      dimension: { package_length: 10, package_width: 8, package_height: 4 },
      attribute_list: [],
      logistic_info: [{ logistic_id: 55, enabled: true, is_free: false }],
      has_model: true,
      has_promotion: false,
      image: {
        image_id_list: [images.find((i) => i.role === 'gallery')!.imageId],
        image_ratio: '3:4',
      },
      promotion_image: {
        image_id_list: [images.find((i) => i.role === 'cover')!.imageId],
        image_ratio: '1:1',
      },
      description_type: 'normal',
      description: document.description.map((d: any) => d.text).join(''),
    },
    models: {
      tier_variation: [
        {
          name: 'Dung tích',
          option_list: document.models.map((m) => ({
            option: m.optionLabels[0],
            image: { image_id: images.find((i) => i.role === 'variation')!.imageId },
          })),
        },
      ],
      model: document.models.map((m, index) => ({
        model_id: 100 + index,
        model_sku: m.sku,
        tier_index: m.tierIndex,
        weight: preparedWeightKilograms(Math.round(m.weightGrams!)),
        price_info: [
          {
            currency: 'VND',
            original_price: 150000,
            current_price: 150000,
            inflated_price_of_original_price: 150000,
            inflated_price_of_current_price: 150000,
          },
        ],
        stock_info_v2: structuredClone(stock),
        has_promotion: false,
        promotion_id: 0,
      })),
    },
  };
  function evidence(index: number) {
    const wrap = (response: any, requestId: string) => ({
      kind: 'success',
      response,
      requestId,
      envelope: { error: '', request_id: requestId, response },
    });
    return {
      observedAt: new Date(now - (2 - index) * 10000).toISOString(),
      base: wrap({ item_list: [structuredClone(raw.item)] }, 'base-' + index),
      models: wrap(structuredClone(raw.models), 'models-' + index),
    };
  }
  const records = [evidence(0), evidence(1)],
    directory = resolve(root, 'wire-evidence', batchId, operationId),
    paths = [
      resolve(directory, randomUUID() + '.json'),
      resolve(directory, randomUUID() + '.json'),
    ];
  await mkdir(directory, { recursive: true });
  await mkdir(resolve(root, 'web-registry'), { recursive: true });
  await writeFile(
    resolve(root, 'web-registry', batchId + '.json'),
    JSON.stringify({
      version: 1,
      batchId,
      manifestPath: loaded.manifestPath,
      expectedSha256: loaded.sha256,
      executionEnabled: true,
    }),
  );
  const save = async () => {
    for (let index = 0; index < records.length; index++)
      await writeFile(paths[index]!, JSON.stringify(records[index]));
  };
  await save();
  const query = vi.fn(async () => ({ rows: [view] })),
    db: any = { query },
    load = vi.fn(async () => loaded),
    options: any = { root, load, now: () => now, withLock: async (work: any) => work(db) };
  const service = new ProductionBatchReviewService({ pool: db } as any, {} as any, options);
  return {
    root,
    batchId,
    op,
    view,
    steps,
    source,
    document,
    raw,
    context,
    records,
    paths,
    save,
    service,
    options,
    load,
    query,
  };
}
it('shows only source-backed observed rounding, saves no receipt on GET, then records one exact local approval', async () => {
  const f = await fixture(),
    before = structuredClone(f.raw),
    qc = previewObservedWeightMapping(f.document, f.raw);
  expect(checkPreparedWireCreate(f.document, f.context, qc.projected)).toEqual({
    verified: true,
    mismatchedPaths: [],
  });
  expect(f.raw).toEqual(before);
  const preview = await f.service.review(f.batchId, 'row-1');
  expect(preview).toMatchObject({
    eligible: true,
    approved: false,
    modelCount: 3,
    groups: [
      { sourceGrams: 322.3, observedGrams: 322, count: 1 },
      { sourceGrams: 130.9, observedGrams: 131, count: 1 },
      { sourceGrams: 503.8, observedGrams: 504, count: 1 },
    ],
  });
  const file = resolve(f.root, 'weight-reviews', f.op.id + '.json');
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  const result = await f.service.approve(f.batchId, {
    sourceKey: 'row-1',
    expectedReviewFingerprint: preview.reviewFingerprint,
  });
  expect(result.approved).toBe(true);
  const bytes = await readFile(file),
    review = JSON.parse(bytes.toString());
  expect(review.models).toEqual(qc.models);
  expect(
    (
      await reconcileProductionPilotWeights(
        {
          operationId: f.op.id,
          itemId: f.op.item_id,
          sourceFingerprint: f.op.source_fingerprint,
          document: f.document,
          raw: f.raw,
        },
        { now: f.options.now, findReview: async () => bytes },
      )
    ).qcSnapshot,
  ).toEqual(qc.projected);
  await f.service.approve(f.batchId, {
    sourceKey: 'row-1',
    expectedReviewFingerprint: preview.reviewFingerprint,
  });
  expect(await readFile(file)).toEqual(bytes);
  expect(f.op.state).toBe('acknowledged');
});
it.each([10_000, 90_000])('expires a two-read review when its first sample expires (oldest age %i ms)', async (oldestAge) => {
  const f = await fixture(), now = f.options.now();
  f.records[0]!.observedAt = new Date(now - oldestAge).toISOString();
  f.records[1]!.observedAt = new Date(now - 1_000).toISOString();
  await f.save();
  const preview = await f.service.review(f.batchId, 'row-1');
  const expires = now - oldestAge + 15 * 60 * 1000;
  expect(preview.eligible).toBe(true);
  expect(preview.expiresAt).toBe(new Date(expires).toISOString());
  f.options.now = () => expires + 1;
  expect(await f.service.review(f.batchId, 'row-1')).toMatchObject({
    eligible: false, reason: 'PRODUCTION_BATCH_REVIEW_READS_EXPIRED',
  });
  await expect(f.service.approve(f.batchId, {
    sourceKey: 'row-1', expectedReviewFingerprint: preview.reviewFingerprint,
  })).rejects.toThrow('PRODUCTION_BATCH_REVIEW_READS_EXPIRED');
  await expect(readFile(resolve(f.root, 'weight-reviews', f.op.id + '.approval.json')))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  'price',
  'stock',
  'logistics',
  'cover',
  'source-weight',
  'duplicate-model',
  'partial-models',
  'unstable',
  'expired',
  'one-read',
  'wrong-source',
  'partial-ACK',
  'receipt',
  'published',
])('does not make %s eligible or write approval', async (fault) => {
  const f = await fixture();
  if (fault === 'price')
    for (const r of f.records) r.models.response.model[0].price_info[0].original_price = 123;
  if (fault === 'stock')
    for (const r of f.records)
      r.models.response.model[0].stock_info_v2.summary_info.total_reserved_stock = 1;
  if (fault === 'logistics')
    for (const r of f.records) r.base.response.item_list[0].logistic_info[0].is_free = true;
  if (fault === 'cover')
    for (const r of f.records)
      r.base.response.item_list[0].promotion_image.image_id_list = ['unproven'];
  if (fault === 'source-weight')
    for (const r of f.records) r.models.response.model[0].weight = 0.333;
  if (fault === 'duplicate-model')
    for (const r of f.records) r.models.response.model[1].model_id = 100;
  if (fault === 'partial-models') for (const r of f.records) r.models.response.model.pop();
  if (fault === 'unstable') f.records[1]!.base.response.item_list[0].unexpected_new_field = 1;
  if (fault === 'expired') f.options.now = () => Date.parse('2026-09-15T13:00:00.000Z');
  if (fault === 'wrong-source') f.op.source_payload.document.title = 'Changed';
  if (fault === 'partial-ACK') f.steps.pop();
  if (fault === 'receipt') f.steps[0].receipt.response.image_info.image_id = 'changed';
  if (fault === 'published') f.view.publications = 1;
  await f.save();
  if (fault === 'one-read') await unlink(f.paths[0]!);
  const result = await f.service.review(f.batchId, 'row-1');
  expect(result.eligible).toBe(false);
  await expect(
    f.service.approve(f.batchId, { sourceKey: 'row-1', expectedReviewFingerprint: 'a'.repeat(64) }),
  ).rejects.toThrow();
  await expect(
    readFile(resolve(f.root, 'weight-reviews', f.op.id + '.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects unknown POST fields and stale preview fingerprints', async () => {
  const f = await fixture();
  const p = await f.service.review(f.batchId, 'row-1');
  await expect(
    f.service.approve(f.batchId, {
      sourceKey: 'row-1',
      expectedReviewFingerprint: p.reviewFingerprint,
      acceptedGrams: 1,
    }),
  ).rejects.toThrow();
  f.op.revision++;
  await expect(
    f.service.approve(f.batchId, {
      sourceKey: 'row-1',
      expectedReviewFingerprint: p.reviewFingerprint,
    }),
  ).rejects.toThrow('REVIEW_CHANGED');
});
it('recovers only the same immutable approval after interruption between approval and helper files', async () => {
  const f = await fixture(),
    p = await f.service.review(f.batchId, 'row-1');
  await f.service.approve(f.batchId, {
    sourceKey: 'row-1',
    expectedReviewFingerprint: p.reviewFingerprint,
  });
  const file = resolve(f.root, 'weight-reviews', f.op.id + '.json'),
    bytes = await readFile(file);
  await unlink(file);
  await f.service.approve(f.batchId, {
    sourceKey: 'row-1',
    expectedReviewFingerprint: p.reviewFingerprint,
  });
  expect(await readFile(file)).toEqual(bytes);
  await expect(
    f.service.approve(f.batchId, { sourceKey: 'row-1', expectedReviewFingerprint: 'b'.repeat(64) }),
  ).rejects.toThrow('REVIEW_CONFLICT');
});
it('does not claim a corrupted existing approval is approved on GET', async () => {
  const f = await fixture(),
    p = await f.service.review(f.batchId, 'row-1');
  await f.service.approve(f.batchId, {
    sourceKey: 'row-1',
    expectedReviewFingerprint: p.reviewFingerprint,
  });
  await writeFile(resolve(f.root, 'weight-reviews', f.op.id + '.json'), '{}');
  const result = await f.service.review(f.batchId, 'row-1');
  expect(result.approved).toBe(false);
  expect(result.eligible).toBe(false);
});
it('rechecks the owner-bound operation after obtaining the approval lock', async () => {
  const f = await fixture(),
    p = await f.service.review(f.batchId, 'row-1');
  f.options.withLock = async (work: any) => {
    f.steps[0].state = 'unknown';
    return work({ query: f.query });
  };
  await expect(
    f.service.approve(f.batchId, {
      sourceKey: 'row-1',
      expectedReviewFingerprint: p.reviewFingerprint,
    }),
  ).rejects.toThrow('ALL_ACK_REQUIRED');
});
