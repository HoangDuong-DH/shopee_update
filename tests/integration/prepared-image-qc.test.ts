import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { BlobStore, Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { ImageQcService } from '../../apps/api/src/image-qc-service.js';
import {
  checkPreparedWireUpdateWithImageQc,
  type PreparedImageQcInput,
} from '../../apps/api/src/prepared-image-qc.js';
import { checkPreparedWireUpdate } from '../../packages/shopee/src/prepared-wire-qc.js';
import type { FieldSnapshot } from '../../packages/shopee/src/field-client.js';
import { technicalImage } from '../fixtures/image-qc/technical-images.js';

const database = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '5442')
  throw new Error('Bridge test requires local isolated PostgreSQL');
const schema = 'test_prepared_image_qc_' + randomUUID().replaceAll('-', '');
const directory = resolve('.local/acceptance-20260914/prepared-image-qc', schema);
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const repo = new Repository(pool),
  blobs = new BlobStore(directory);
const outbound = vi
  .spyOn(globalThis, 'fetch')
  .mockRejectedValue(
    new Error('External network forbidden in prepared image QC bridge acceptance'),
  );
let now = new Date('2026-09-14T08:00:00.000Z'),
  source: Buffer,
  output: Buffer;
const service = new ImageQcService(repo, blobs, { now: () => now });
const scope = { environment: 'sandbox' as const, partnerId: '980000001', shopId: '910000001' };
const operationId = randomUUID();
const receipts: unknown[] = [];
const before: FieldSnapshot = {
  item: {
    item_id: 970100001,
    has_model: true,
    item_name: 'Source exact title',
    description: 'Untouched source body',
    category_id: 99001001,
    brand: { brand_id: 99002001 },
    has_promotion: false,
    image: { image_ratio: '3:4', image_id_list: ['old-gallery-0', 'old-gallery-1'] },
    promotion_image: { image_ratio: '1:1', image_id_list: ['original-cover'] },
    protected_extra: { list: [], flag: false },
  },
  models: {
    tier_variation: [{ name: 'Pack', option_list: [{ option: 'Small' }, { option: 'Large' }] }],
    model: [
      {
        model_id: 9900002,
        model_sku: 'SKU-LARGE',
        tier_index: [1],
        price_info: [{ original_price: 27000, current_price: 27000 }],
        stock_info_v2: { seller_stock: [{ stock: 23 }] },
        protected_extra: { a: [] },
      },
      {
        model_id: 9900001,
        model_sku: 'SKU-SMALL',
        tier_index: [0],
        price_info: [{ original_price: 15000, current_price: 15000 }],
        stock_info_v2: { seller_stock: [{ stock: 17 }] },
        protected_extra: { a: [] },
      },
    ],
  },
};
async function sample(auto = false) {
  const binding = {
    ...scope,
    itemId: '970100001',
    operationId,
    role: 'cover' as const,
    position: 0,
    sourceAssetId: 'source-cover-import',
    outputImageId: 'recompressed-cover',
  };
  const entry = await service.prepare({
    id: randomUUID(),
    binding,
    source,
    output: auto ? source : output,
    expiresAt: '2026-09-14T09:00:00.000Z',
  });
  const after = structuredClone(before);
  (after.item.image as any).image_id_list = ['new-gallery-0', 'new-gallery-1'];
  (after.item.promotion_image as any).image_id_list = ['recompressed-cover'];
  after.models.model.reverse();
  const input: PreparedImageQcInput = {
    operationId,
    scope,
    before: structuredClone(before),
    after,
    steps: [
      {
        method: 'POST',
        path: '/api/v2/product/update_item',
        group: 'gallery',
        payload: {
          item_id: 970100001,
          image: { image_ratio: '3:4', image_id_list: ['new-gallery-0', 'new-gallery-1'] },
          promotion_images: { image_id_list: ['original-cover'] },
        },
      },
    ],
    cover: {
      caseId: entry.id,
      sourceAssetId: binding.sourceAssetId,
      sourceBaselineImageId: 'original-cover',
      source: { imageId: 'original-cover', bytes: source },
      output: { imageId: 'recompressed-cover', bytes: auto ? source : output },
    },
  };
  const approve = () =>
    service.review({
      id: entry.id,
      requestId: randomUUID(),
      expectedFingerprint: entry.fingerprint,
      binding,
      decision: 'accept_lossy_match',
      reviewer: 'QA fixture operator',
      note: 'Explicit fixture-only review, including tiny SKU digit.',
    });
  return { entry, input, approve };
}
async function check(input: PreparedImageQcInput) {
  const result = await checkPreparedWireUpdateWithImageQc(service, input);
  receipts.push({
    input: {
      ...input,
      cover: input.cover
        ? {
            ...input.cover,
            source: { imageId: input.cover.source.imageId },
            output: { imageId: input.cover.output.imageId },
          }
        : undefined,
    },
    result,
  });
  return result;
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await mkdir(directory, { recursive: true });
  source = await technicalImage();
  output = await sharp(source).jpeg({ quality: 85 }).toBuffer();
});
beforeEach(() => {
  now = new Date('2026-09-14T08:00:00.000Z');
});
afterAll(async () => {
  const cases = (await pool.query('SELECT * FROM image_qc_cases')).rows,
    reviews = (await pool.query('SELECT * FROM image_qc_reviews')).rows;
  await pool.end();
  if (!/^test_prepared_image_qc_[a-f0-9]{32}$/.test(schema))
    throw new Error('Unsafe schema cleanup');
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await writeFile(
    join(directory, 'evidence.json'),
    JSON.stringify(
      {
        mode: 'local-trusted-image-bridge',
        schema,
        schemaRemoved: true,
        externalRequests: outbound.mock.calls.length,
        cases,
        reviews,
        receipts,
      },
      null,
      2,
    ),
  );
  await writeFile(
    resolve('.local/acceptance-20260914/prepared-image-qc/latest.json'),
    JSON.stringify({ directory }),
  );
  const calls = outbound.mock.calls.length;
  outbound.mockRestore();
  expect(calls).toBe(0);
});

it('reruns full protected QC with only the exact accepted cover slot projected and leaves raw evidence unchanged', async () => {
  const { input, approve } = await sample();
  await approve();
  const original = structuredClone(input);
  expect(checkPreparedWireUpdate(input.before, input.after, input.steps).verified).toBe(false);
  const result = await check(input);
  expect(result.verified).toBe(true);
  expect(result.basis).toBe('image_manual_review');
  expect(result.rawQc.verified).toBe(false);
  expect(result.projectedQc?.verified).toBe(true);
  expect(structuredClone(input)).toEqual(original);
});
it('accepts exact bytes with the automatic evidence basis and never labels them manual review', async () => {
  const { input } = await sample(true);
  expect((await check(input)).basis).toBe('image_exact_bytes');
  expect((await check(input)).verified).toBe(true);
});
it('keeps a lossy pending review unverified without creating an attestation', async () => {
  const { input, entry } = await sample();
  expect((await check(input)).verified).toBe(false);
  expect((await service.get(entry.id)).review).toBeUndefined();
});
it('does not let accepted cover evidence approve a wrong or reordered gallery', async () => {
  const { input, approve } = await sample();
  await approve();
  for (const gallery of [
    ['wrong-gallery', 'new-gallery-1'],
    ['new-gallery-1', 'new-gallery-0'],
  ]) {
    const next = structuredClone(input);
    (next.after.item.image as any).image_id_list = gallery;
    const result = await check(next);
    expect(result.verified).toBe(false);
    expect(result.mismatchedPaths.some((path) => path.startsWith('item.image.image_id_list'))).toBe(
      true,
    );
  }
});
it('retains unselected stock and unknown nested fields in the full readback comparison', async () => {
  const { input, approve } = await sample();
  await approve();
  const stockDrift = structuredClone(input);
  (stockDrift.after.models.model[0] as any).stock_info_v2.seller_stock[0].stock = 99;
  expect((await check(stockDrift)).verified).toBe(false);
  const unknownDrift = structuredClone(input);
  unknownDrift.after.item.protected_extra = { list: {}, flag: false };
  expect((await check(unknownDrift)).mismatchedPaths).toContain('item.protected_extra.list');
});
it('rejects a stale observed source hash or output hash despite an accepted case', async () => {
  const { input, approve } = await sample();
  await approve();
  for (const side of ['source', 'output'] as const) {
    const next = structuredClone(input);
    next.cover![side].bytes = await technicalImage('8');
    const result = await check(next);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('IMAGE_QC_BYTES_CHANGED');
  }
});
it('rejects substituted source and output IDs even when their supplied bytes match the saved hashes', async () => {
  const { input, approve } = await sample();
  await approve();
  for (const patch of [
    { sourceBaselineImageId: 'other' },
    { source: { ...input.cover!.source, imageId: 'other' } },
    { output: { ...input.cover!.output, imageId: 'other' } },
  ]) {
    expect((await check({ ...input, cover: { ...input.cover!, ...patch } })).verified).toBe(false);
  }
});
it('rejects cross-shop, cross-operation, cross-item and cross-asset reuse of the same case', async () => {
  const { input, approve } = await sample();
  await approve();
  for (const next of [
    { ...input, scope: { ...scope, shopId: '910000002' } },
    { ...input, operationId: randomUUID() },
    { ...input, cover: { ...input.cover!, sourceAssetId: 'other-source' } },
  ])
    expect((await check(next)).reason).toBe('IMAGE_QC_BINDING_CHANGED');
  const changedItem = structuredClone(input);
  changedItem.after.item.item_id = 970100002;
  expect((await check(changedItem)).verified).toBe(false);
});
it('rejects an expired approved case and missing or duplicate current cover slots', async () => {
  const { input, approve } = await sample();
  await approve();
  now = new Date('2026-09-14T09:00:00.000Z');
  expect((await check(input)).reason).toBe('IMAGE_QC_EXPIRED');
  now = new Date('2026-09-14T08:00:00.000Z');
  for (const ids of [[], ['recompressed-cover', 'recompressed-cover']]) {
    const next = structuredClone(input);
    (next.after.item.promotion_image as any).image_id_list = ids;
    expect((await check(next)).verified).toBe(false);
  }
});
it('rejects arbitrary attestation JSON rather than treating it as a saved service decision', async () => {
  const { input } = await sample();
  const result = await check({
    ...input,
    cover: { ...input.cover!, attestation: { decision: 'accept_lossy_match' } },
  } as any);
  expect(result.verified).toBe(false);
  expect(result.reason).toBe('IMAGE_QC_INPUT_INVALID');
});
it('leaves ordinary raw QC available without an image case and cannot resolve an uncovered cover mismatch', async () => {
  const { input } = await sample();
  const noCover = { ...input, cover: undefined };
  expect((await check(noCover)).verified).toBe(false);
  (noCover.after.item.promotion_image as any).image_id_list = ['original-cover'];
  const result = await check(noCover);
  expect(result.verified).toBe(true);
  expect(result.basis).toBe('raw_fields_exact');
});
it('resolves a requested cover restore against the exact source ID in its payload', async () => {
  const { input, approve } = await sample();
  await approve();
  (input.before.item.promotion_image as any).image_id_list = ['wrong-cover-before-restore'];
  input.after.item.image = structuredClone(input.before.item.image);
  input.steps = [
    {
      method: 'POST',
      path: '/api/v2/product/update_item',
      group: 'cover',
      payload: { item_id: 970100001, promotion_images: { image_id_list: ['original-cover'] } },
    },
  ];
  expect((await check(input)).verified).toBe(true);
});
it('cannot substitute a verified gallery-position case for cover position zero', async () => {
  const { input } = await sample(true);
  const other = await service.prepare({
    id: randomUUID(),
    binding: {
      ...scope,
      itemId: '970100001',
      operationId,
      role: 'gallery',
      position: 1,
      sourceAssetId: 'source-cover-import',
      outputImageId: 'recompressed-cover',
    },
    source,
    output: source,
    expiresAt: '2026-09-14T09:00:00.000Z',
  });
  input.cover!.caseId = other.id;
  expect((await check(input)).reason).toBe('IMAGE_QC_BINDING_CHANGED');
});
it('still rejects duplicate model identities and a payload attempting an unsupported extra field', async () => {
  const { input, approve } = await sample();
  await approve();
  const duplicate = structuredClone(input);
  duplicate.after.models.model[1]!.model_id = duplicate.after.models.model[0]!.model_id;
  expect((await check(duplicate)).verified).toBe(false);
  const unsupported = structuredClone(input);
  unsupported.steps[0]!.payload.weight = 0.9;
  unsupported.after.item.weight = 0.9;
  expect((await check(unsupported)).verified).toBe(false);
});
