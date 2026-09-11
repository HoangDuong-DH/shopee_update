import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  Pool,
  Repository,
  BlobStore,
  migrate,
  WorkOrderRepository,
} from '../../packages/persistence/src/index.js';
import { SecretBox } from '../../packages/shopee/src/index.js';
import { SandboxListingService } from '../../apps/api/src/sandbox-listing-service.js';
import { fact, fixtureDraft, source } from '../helpers/fixtures.js';
import type {
  ListingDraft,
  SandboxPrepareInput,
  WorkOrderConfig,
  SandboxScopeInput,
} from '../../packages/domain/src/index.js';

const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool),
  orders = new WorkOrderRepository(pool),
  key = '51'.repeat(32),
  box = new SecretBox(key),
  connectionId = randomUUID();
let root: string, blobs: BlobStore, service: SandboxListingService, draft: ListingDraft;
let workOrderId: string, workOrderRevision: number;
let limitHook: (() => Promise<void>) | undefined;
let uploadHook: (() => void) | undefined;
let remote: any, remoteModels: any, limits: any;
let updates: any[], uploads: { scene: string; bytes: Uint8Array }[];
let updateBehavior:
  | 'normal'
  | 'timeout_applied'
  | 'timeout_unapplied'
  | 'changed_stock'
  | 'changed_cover'
  | 'changed_cover_and_stock'
  | 'changed_cover_and_ratio'
  | 'rejected';
let uploadBehavior: 'normal' | 'missing_error' | 'rejected';
const scope = (): SandboxScopeInput => ({
  connectionId,
  itemId: '803934364',
  productKey: draft.productKey,
  sourceRevision: draft.revision,
});
const success = (response: unknown) =>
  new Response(JSON.stringify({ error: '', response, request_id: 'fixture-request' }));
const transport = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(raw));
  if (url.hostname !== 'openplatform.sandbox.test-stable.shopee.sg')
    throw new Error('Fixture forbids non-sandbox calls');
  if (url.pathname.endsWith('get_item_base_info')) return success({ item_list: [remote] });
  if (url.pathname.endsWith('get_model_list')) return success(remoteModels);
  if (url.pathname.endsWith('get_item_limit')) {
    await limitHook?.();
    return success(limits);
  }
  if (url.pathname.endsWith('upload_image')) {
    const form = init?.body as FormData;
    uploads.push({
      scene: String(form.get('scene')),
      bytes: new Uint8Array(await (form.get('image') as Blob).arrayBuffer()),
    });
    uploadHook?.();
    const image_info = { image_id: 'uploaded-' + uploads.length };
    return success({
      image_info,
      image_info_list: [
        uploadBehavior === 'missing_error'
          ? { image_info }
          : { image_info, error: uploadBehavior === 'rejected' ? 'invalid_image' : null },
      ],
    });
  }
  if (url.pathname.endsWith('update_item')) {
    const patch = JSON.parse(String(init?.body));
    updates.push(patch);
    if (updateBehavior === 'rejected')
      return new Response(
        JSON.stringify({ error: 'error_auth', message: 'fixture', request_id: 'fixture-reject' }),
      );
    if (updateBehavior === 'timeout_unapplied')
      throw new Error('Transport body must not enter records');
    const old = structuredClone(remote);
    if (patch.item_name !== undefined) remote.item_name = patch.item_name;
    if (patch.description !== undefined) remote.description = patch.description;
    if (patch.description_type !== undefined) remote.description_type = patch.description_type;
    if (patch.description_info !== undefined) remote.description_info = patch.description_info;
    if (patch.image !== undefined) {
      remote.image = patch.image;
      if (patch.image.image_ratio === '3:4' && !patch.promotion_images)
        remote.promotion_image.image_id_list = ['auto-cropped-' + patch.image.image_id_list[0]];
    }
    if (patch.promotion_images !== undefined)
      remote.promotion_image.image_id_list = patch.promotion_images.image_id_list;
    if (updateBehavior.startsWith('changed_cover'))
      remote.promotion_image.image_id_list = ['wrong-cover-id'];
    if (updateBehavior === 'changed_cover_and_ratio') remote.promotion_image.image_ratio = '3:4';
    if (updateBehavior === 'changed_stock' || updateBehavior === 'changed_cover_and_stock')
      remoteModels.model[0].stock_info_v2.summary_info.total_available_stock--;
    if (updateBehavior === 'timeout_applied')
      throw new Error('Connection dropped after remote apply');
    return success(old); // A real update response may contain the previous values.
  }
  throw new Error('Fixture forbids unknown endpoint');
}) as typeof fetch;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), 'shopee-sandbox-service-'));
  blobs = new BlobStore(root);
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,revision,token_ciphertext,partner_key_ciphertext) VALUES($1,'sandbox','1232297','227418363','Fixture TEST','connected',1,$2,$3)",
    [
      connectionId,
      box.seal({ accessToken: 'private-test-token' }, 'sandbox:1232297:227418363'),
      box.seal({ partnerKey: 'private-test-partner' }, 'sandbox:1232297:227418363'),
    ],
  );
  service = new SandboxListingService(repo, blobs, { transport, encryptionKey: key });
});
beforeEach(async () => {
  await pool.query('DELETE FROM sandbox_listing_run_events');
  await pool.query('DELETE FROM sandbox_listing_runs');
  await pool.query('TRUNCATE work_order_revisions,work_orders CASCADE');
  workOrderId = randomUUID();
  workOrderRevision = 0;
  limitHook = undefined;
  uploadHook = undefined;
  vi.mocked(transport).mockClear();
  updates = [];
  uploads = [];
  updateBehavior = 'normal';
  uploadBehavior = 'normal';
  draft = {
    ...fixtureDraft(),
    productKey: 'sandbox-fixture-' + randomUUID(),
    title: fact('Tiêu đề đã chuẩn bị'),
    description: [{ type: 'text', text: 'Đúng  nội dung\n\nđã chuẩn bị' }],
    galleryKeys: [],
    assets: [],
  };
  await repo.saveProduct(draft, 0);
  remote = {
    item_id: 803934364,
    item_name: 'Tiêu đề đang có',
    category_id: 300018,
    item_status: 'NORMAL',
    description_type: 'normal',
    description: 'Nội dung đang có',
    image: { image_id_list: ['old-gallery'], image_ratio: '3:4' },
    promotion_image: { image_id_list: ['untouched-cover'], image_ratio: '1:1' },
    brand: { brand_id: 9 },
    weight: '0.25',
    logistic_info: [{ logistic_id: 50040, enabled: true }],
  };
  remoteModels = {
    tier_variation: [
      {
        name: 'Type',
        option_list: [{ option: 'One', image: { image_id: 'variation-unchanged' } }],
      },
    ],
    model: [
      {
        model_id: 1001,
        model_sku: 'A',
        tier_index: [0],
        price_info: [{ currency: 'VND', original_price: 100, current_price: 50 }],
        stock_info_v2: {
          summary_info: { total_available_stock: 90, total_reserved_stock: 10 },
          seller_stock: [{ stock: 100 }],
        },
      },
    ],
  };
  limits = {
    item_name_length_limit: { min_limit: 1, max_limit: 150 },
    item_image_count_limit: { min_limit: 1, max_limit: 9 },
    item_description_length_limit: { min_limit: 1, max_limit: 5000 },
    extended_description_limit: {
      description_text_length_min: 1,
      description_text_length_max: 10000,
      description_image_num_min: 0,
      description_image_num_max: 10,
      description_image_width_min: 300,
      description_image_height_min: 300,
      description_image_aspect_ratio_min: 0.5,
      description_image_aspect_ratio_max: 2,
    },
  };
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (root?.startsWith(join(tmpdir(), 'shopee-sandbox-service-')))
    await rm(root, { recursive: true, force: true });
});
async function prepared(fields: SandboxPrepareInput['fieldMask'] = ['title']) {
  const read = await service.read(scope());
  const order = await orders.save(workOrderId, workOrderRevision, orderConfig(fields));
  workOrderRevision = order.revision;
  const input: SandboxPrepareInput = {
    ...scope(),
    id: randomUUID(),
    workOrderId,
    workOrderRevision,
    baselineFingerprint: read.snapshot.fingerprint,
    fieldMask: fields,
  };
  return { input, run: await service.prepare(input) };
}
function orderConfig(fields: SandboxPrepareInput['fieldMask'] = ['title']): WorkOrderConfig {
  return { ...scope(), operation: 'update', fieldMask: fields, stocks: {} };
}
async function asset(name: string, bytes: Uint8Array) {
  const sha = await blobs.put(bytes),
    file = await repo.createImport({
      sha256: sha,
      filename: name,
      bytes: bytes.length,
      kind: 'image',
    });
  await repo.finishImport(file.id, { mime: 'image/png', width: 900, height: 1200 });
  return {
    key: file.id,
    sha256: sha,
    bytes: bytes.length,
    mime: 'image/png',
    width: 900,
    height: 1200,
    source: { ...source, fileSha256: sha },
  };
}

it('reads real database source against mocked OpenAPI and shows prices, reserved stock, and exact text', async () => {
  const read = await service.read(scope());
  expect(read.snapshot.models[0]).toMatchObject({
    sku: 'A',
    originalPrice: '100',
    currentPrice: '50',
    reservedStock: 10,
    availableStock: 90,
  });
  expect(read.comparison[0]).toEqual({ field: 'title', state: 'different' });
  expect(read.checks).toEqual([]);
  expect(updates).toHaveLength(0);
});
it('pins immutable prepare input and returns identical run on retry, rejects conflicting reuse', async () => {
  const { input, run } = await prepared();
  expect(await service.prepare(input)).toEqual(run);
  await expect(service.prepare({ ...input, fieldMask: ['description'] })).rejects.toThrow(
    'SANDBOX_IDEMPOTENCY_CONFLICT',
  );
  await expect(
    pool.query("UPDATE sandbox_listing_runs SET intent='{}' WHERE id=$1", [run.id]),
  ).rejects.toThrow('IMMUTABLE_SANDBOX_INTENT');
  expect(updates).toHaveLength(0);
});
it('selective title update reads back instead of trusting old update response and preserves all other data', async () => {
  const { run } = await prepared();
  const before = structuredClone(remoteModels);
  const result = await service.execute({ id: run.id, expectedRevision: run.revision });
  expect(updates).toEqual([{ item_id: 803934364, item_name: draft.title.value }]);
  expect(result.state).toBe('verified');
  expect(result.result).toMatchObject({
    selectedFieldsMatch: true,
    unselectedFieldsMatch: true,
    code: 'READBACK_VERIFIED',
  });
  expect(remoteModels).toEqual(before);
  expect(remote.promotion_image.image_id_list).toEqual(['untouched-cover']);
  expect((await service.get(run.id)).state).toBe('verified');
  await service.execute({ id: run.id, expectedRevision: run.revision });
  expect(updates).toHaveLength(1);
  const stored = (
    await pool.query('SELECT body,intent FROM sandbox_listing_runs WHERE id=$1', [run.id])
  ).rows[0];
  expect(JSON.stringify(stored)).not.toContain('private-test');
});
it('blocks production, any other shop/item, unsupported field mask, and missing credentials before transport', async () => {
  await expect(service.read({ ...scope(), itemId: '846056124' })).rejects.toThrow(
    'SANDBOX_SCOPE_NOT_ALLOWED',
  );
  const productionId = randomUUID();
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state) VALUES($1,'production','999','999','Fixture real','connected')",
    [productionId],
  );
  await expect(service.read({ ...scope(), connectionId: productionId })).rejects.toThrow(
    'SANDBOX_SCOPE_NOT_ALLOWED',
  );
  await expect(
    service.prepare({
      ...scope(),
      id: randomUUID(),
      baselineFingerprint: 'a'.repeat(64),
      fieldMask: ['price'],
    }),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
it('blocks wrong source membership and different tier labels instead of pairing by model order', async () => {
  remoteModels.model[0].model_sku = 'OTHER';
  expect((await service.read(scope())).checks.some((c) => c.code === 'SANDBOX_SKU_MISMATCH')).toBe(
    true,
  );
  await expect(prepared()).rejects.toThrow('SANDBOX_SKU_MISMATCH');
  remoteModels.model[0].model_sku = 'A';
  remoteModels.tier_variation[0].option_list[0].option = 'Changed';
  await expect(prepared()).rejects.toThrow('SANDBOX_VARIATION_MISMATCH');
  expect(updates).toHaveLength(0);
});
it('fresh baseline drift and live limit changes stop before any item write', async () => {
  let { run } = await prepared();
  remote.description = 'Changed outside';
  const drift = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(drift.state).toBe('drift');
  expect(drift.result?.after?.description).toEqual([{ type: 'text', text: 'Changed outside' }]);
  expect(drift.result?.requestIds).toContain('fixture-request');
  expect(updates).toHaveLength(0);
  ({ run } = await prepared());
  limits.item_name_length_limit.max_limit = 3;
  const result = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(result.state).toBe('rejected');
  expect(updates).toHaveLength(0);
});
it('unknown write outcome is retained and reconciles with read only after remote apply', async () => {
  const { run } = await prepared();
  updateBehavior = 'timeout_applied';
  const unknown = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(unknown.state).toBe('unknown');
  expect(updates).toHaveLength(1);
  await service.execute({ id: run.id, expectedRevision: unknown.revision });
  expect(updates).toHaveLength(1);
  await repo.saveProduct({ ...draft, revision: 2, title: fact('A later local revision') }, 1);
  const verified = await service.reconcile({ id: run.id, expectedRevision: unknown.revision });
  expect(verified.state).toBe('verified');
  expect(updates).toHaveLength(1);
});
it('a timeout without remote apply stays unknown; another run cannot write this unresolved target', async () => {
  const { run } = await prepared();
  updateBehavior = 'timeout_unapplied';
  const unknown = await service.execute({ id: run.id, expectedRevision: 1 });
  expect((await service.reconcile({ id: run.id, expectedRevision: unknown.revision })).state).toBe(
    'unknown',
  );
  const second = await prepared();
  await expect(service.execute({ id: second.run.id, expectedRevision: 1 })).rejects.toThrow(
    'SANDBOX_TARGET_BUSY',
  );
  expect(updates).toHaveLength(1);
});
it('does not verify success if an unselected price/stock field differs on readback', async () => {
  const { run } = await prepared();
  updateBehavior = 'changed_stock';
  const result = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(result.state).toBe('unknown');
  expect(result.result).toMatchObject({ selectedFieldsMatch: true, unselectedFieldsMatch: false });
});
it.each([
  ['changed_cover', 'COVER_READBACK_REVIEW'],
  ['changed_cover_and_stock', 'READBACK_MISMATCH'],
  ['changed_cover_and_ratio', 'READBACK_MISMATCH'],
] as const)('keeps %s unknown without concealing other mismatches', async (behavior, code) => {
  const { run } = await prepared();
  updateBehavior = behavior;
  const result = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(result.state).toBe('unknown');
  expect(result.result).toMatchObject({
    code,
    selectedFieldsMatch: true,
    unselectedFieldsMatch: false,
    after: { coverImageIds: ['wrong-cover-id'] },
  });
  expect(result.baseline.coverImageIds).toEqual(['untouched-cover']);
  const reconciled = await service.reconcile({ id: run.id, expectedRevision: result.revision });
  expect(reconciled.state).toBe('unknown');
  expect(reconciled.result?.code).toBe(code);
  expect(updates).toHaveLength(1);
});
it('requires CAS revision and source revision to remain current before executing', async () => {
  const { run } = await prepared();
  await expect(service.execute({ id: run.id, expectedRevision: 2 })).rejects.toThrow(
    'SANDBOX_RUN_REVISION_CONFLICT',
  );
  await repo.saveProduct({ ...draft, revision: 2, title: fact('New local source revision') }, 1);
  await expect(service.execute({ id: run.id, expectedRevision: 1 })).rejects.toThrow(
    'SANDBOX_SOURCE_REVISION_CHANGED',
  );
  expect(updates).toHaveLength(0);
});
it('uploads exact source bytes with separate image roles, preserves block and gallery order, leaves cover alone', async () => {
  const bytesA = new Uint8Array([137, 80, 78, 71, 4, 1]),
    bytesB = new Uint8Array([137, 80, 78, 71, 5, 2]);
  const a = await asset('arbitrary-name.png', bytesA),
    b = await asset('other.png', bytesB);
  draft = {
    ...draft,
    revision: 2,
    assets: [a, b],
    galleryKeys: [b.key, a.key],
    description: [
      { type: 'text', text: 'Tiêu đề\n\n' },
      { type: 'image', assetKey: a.key },
      { type: 'image', assetKey: b.key },
      { type: 'text', text: '\n\nChữ  giữ nguyên' },
    ],
  };
  await repo.saveProduct(draft, 1);
  remote.description_type = 'extended';
  remote.description_info = {
    extended_description: { field_list: [{ field_type: 'text', text: 'Old extended' }] },
  };
  const { run } = await prepared(['description', 'gallery']);
  const result = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(result.state).toBe('verified');
  expect(uploads).toEqual([
    { scene: 'normal', bytes: bytesB },
    { scene: 'normal', bytes: bytesA },
    { scene: 'desc', bytes: bytesA },
    { scene: 'desc', bytes: bytesB },
  ]);
  expect(updates[0].image.image_id_list).toEqual(['uploaded-1', 'uploaded-2']);
  expect(updates[0].description_info.extended_description.field_list).toEqual([
    { field_type: 'text', text: 'Tiêu đề\n\n' },
    { field_type: 'image', image_info: { image_id: 'uploaded-3' } },
    { field_type: 'image', image_info: { image_id: 'uploaded-4' } },
    { field_type: 'text', text: '\n\nChữ  giữ nguyên' },
  ]);
  expect(Object.keys(updates[0]).sort()).toEqual([
    'description_info',
    'description_type',
    'image',
    'item_id',
    'promotion_images',
  ]);
  expect(updates[0].promotion_images).toEqual({ image_id_list: ['untouched-cover'] });
  expect(remote.promotion_image.image_id_list).toEqual(['untouched-cover']);
});
it('requires one verified original promotion cover before preparing a 3:4 gallery update', async () => {
  const a = await asset('prepared.png', new Uint8Array([137, 80, 78, 71, 88]));
  draft = { ...draft, revision: 2, assets: [a], galleryKeys: [a.key] };
  await repo.saveProduct(draft, 1);
  for (const imageIds of [[], ['one', 'two'], [' ']]) {
    remote.promotion_image.image_id_list = imageIds;
    await expect(prepared(['gallery'])).rejects.toThrow('SANDBOX_COVER_PRESERVATION_REQUIRED');
  }
  expect(uploads).toHaveLength(0);
  expect(updates).toHaveLength(0);
});
it('rejects mismatched source asset metadata and unsupported conversion without uploading', async () => {
  const a = await asset('source.png', new Uint8Array([137, 80, 78, 71, 6]));
  draft = {
    ...draft,
    revision: 2,
    assets: [{ ...a, sha256: 'a'.repeat(64) }],
    galleryKeys: [a.key],
  };
  await repo.saveProduct(draft, 1);
  await expect(prepared(['gallery'])).rejects.toThrow('SANDBOX_SOURCE_ASSET_MISMATCH');
  expect(uploads).toHaveLength(0);
});
it('reports Shopee rejection and same-value no-op honestly without retry or fake successful write', async () => {
  let { run } = await prepared();
  updateBehavior = 'rejected';
  expect((await service.execute({ id: run.id, expectedRevision: 1 })).state).toBe('rejected');
  remote.item_name = draft.title.value;
  ({ run } = await prepared());
  const result = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(result.state).toBe('verified');
  expect(result.result?.code).toBe('NO_CHANGE');
  expect(updates).toHaveLength(1);
});
it('binds preparation to exact work order target, selected fields and current revision', async () => {
  const read = await service.read(scope());
  await orders.save(workOrderId, 0, orderConfig());
  const input = {
    ...scope(),
    id: randomUUID(),
    workOrderId,
    workOrderRevision: 1,
    baselineFingerprint: read.snapshot.fingerprint,
    fieldMask: ['description'],
  };
  await expect(service.prepare(input)).rejects.toThrow('SANDBOX_WORK_ORDER_MISMATCH');
  await expect(
    service.prepare({ ...input, fieldMask: ['title'], workOrderRevision: 2 }),
  ).rejects.toThrow('SANDBOX_WORK_ORDER_CHANGED');
  const { workOrderId: _, ...unbound } = input;
  await expect(service.prepare(unbound)).rejects.toThrow();
  expect(updates).toHaveLength(0);
});
it('rejects a prepare that finishes after the work order changed while remote preflight was pending', async () => {
  const read = await service.read(scope());
  await orders.save(workOrderId, 0, orderConfig());
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  limitHook = async () => {
    started();
    await pending;
  };
  const preparing = service.prepare({
    ...scope(),
    id: randomUUID(),
    workOrderId,
    workOrderRevision: 1,
    baselineFingerprint: read.snapshot.fingerprint,
    fieldMask: ['title'],
  });
  const rejected = expect(preparing).rejects.toThrow('SANDBOX_WORK_ORDER_CHANGED');
  await entered;
  await orders.save(workOrderId, 1, orderConfig(['description']));
  release();
  await rejected;
  expect((await pool.query('SELECT count(*) FROM sandbox_listing_runs')).rows[0].count).toBe('0');
  expect(updates).toHaveLength(0);
});
it('a work order edit invalidates an old prepared run and execute never sends its earlier patch', async () => {
  const { run } = await prepared();
  await orders.save(workOrderId, workOrderRevision, orderConfig(['description']));
  const result = await service.execute({ id: run.id, expectedRevision: run.revision });
  expect(result.state).toBe('drift');
  expect(result.result?.code).toBe('WORK_ORDER_CONFIG_CHANGED');
  expect(updates).toHaveLength(0);
});
it('persists safe upload failure diagnostics while leaving the item untouched', async () => {
  const a = await asset('prepared.png', new Uint8Array([137, 80, 78, 71, 7]));
  draft = { ...draft, revision: 2, assets: [a], galleryKeys: [a.key] };
  await repo.saveProduct(draft, 1);
  for (const behavior of ['missing_error', 'rejected'] as const) {
    uploadBehavior = behavior;
    const { run } = await prepared(['gallery']);
    const result = await service.execute({ id: run.id, expectedRevision: run.revision });
    expect(result.state).toBe('rejected');
    expect(result.result).toMatchObject({
      code: 'MEDIA_UPLOAD_INCOMPLETE',
      requestIds: ['fixture-request'],
      failure: {
        stage: 'media_upload',
        outcome: behavior === 'missing_error' ? 'unknown' : 'rejected',
        ...(behavior === 'missing_error'
          ? { reason: 'invalid_response' }
          : { code: 'image_upload_rejected' }),
        httpStatus: 200,
        requestId: 'fixture-request',
      },
    });
    expect((await service.get(run.id)).result?.failure).toEqual(result.result?.failure);
    expect(JSON.stringify(result.result)).not.toContain('private-test');
  }
  expect(updates).toHaveLength(0);
});
it('retains the actual post-upload drift snapshot and reuses successful media from that stopped run', async () => {
  const a = await asset('source.png', new Uint8Array([137, 80, 78, 71, 8]));
  draft = { ...draft, revision: 2, assets: [a], galleryKeys: [a.key] };
  await repo.saveProduct(draft, 1);
  const { run } = await prepared(['gallery']);
  uploadHook = () => {
    remote.description = 'Transient external change';
  };
  const drift = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(drift.state).toBe('drift');
  expect(updates).toHaveLength(0);
  expect(drift.result?.after?.description).toEqual([
    { type: 'text', text: 'Transient external change' },
  ]);
  expect(drift.result?.after?.fingerprint).not.toBe(drift.baseline.fingerprint);
  expect(drift.result?.requestIds).toContain('fixture-request');
  remote.description = 'Nội dung đang có';
  uploadHook = undefined;
  expect((await service.get(run.id)).result?.after).toEqual(drift.result?.after);
  const next = await prepared(['gallery']);
  const result = await service.execute({ id: next.run.id, expectedRevision: 1 });
  expect(result.state).toBe('verified');
  expect(uploads).toHaveLength(1);
  expect(updates).toHaveLength(1);
  expect(result.uploads[0]).toMatchObject({
    assetKey: a.key,
    imageId: drift.uploads[0]!.imageId,
    reusedFromRunId: run.id,
  });
});
it('reuses all 17 confirmed media mappings without uploads, then uploads only a changed 18th source', async () => {
  const assets = await Promise.all(
    Array.from({ length: 9 }, (_, index) =>
      asset('source-' + index + '.png', new Uint8Array([137, 80, 78, 71, 30 + index])),
    ),
  );
  draft = {
    ...draft,
    revision: 2,
    assets,
    galleryKeys: assets.slice(0, 8).map((a) => a.key),
    description: [
      { type: 'text', text: 'Prepared headline\n\n' },
      ...assets.map((a) => ({ type: 'image' as const, assetKey: a.key })),
      { type: 'text', text: '\n\nPrepared body' },
    ],
  };
  await repo.saveProduct(draft, 1);
  remote.description_type = 'extended';
  remote.description_info = {
    extended_description: { field_list: [{ field_type: 'text', text: 'Old extended' }] },
  };
  let { run } = await prepared(['gallery', 'description']);
  const first = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(first.state).toBe('verified');
  expect(first.uploads).toHaveLength(17);
  expect(uploads).toHaveLength(17);
  ({ run } = await prepared(['gallery', 'description']));
  const second = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(second.state).toBe('verified');
  expect(second.result?.code).toBe('NO_CHANGE');
  expect(second.uploads.filter((u) => u.reusedFromRunId)).toHaveLength(17);
  expect(uploads).toHaveLength(17);
  const replacement = await asset(
    'new-description-image.png',
    new Uint8Array([137, 80, 78, 71, 90]),
  );
  draft = {
    ...draft,
    revision: 3,
    assets: [...assets, replacement],
    description: draft.description.map((b) =>
      b.type === 'image' && b.assetKey === assets[8]!.key
        ? { type: 'image', assetKey: replacement.key }
        : b,
    ),
  };
  await repo.saveProduct(draft, 2);
  ({ run } = await prepared(['gallery', 'description']));
  const third = await service.execute({ id: run.id, expectedRevision: 1 });
  expect(third.state).toBe('verified');
  expect(third.uploads).toHaveLength(17);
  expect(third.uploads.filter((u) => u.reusedFromRunId)).toHaveLength(16);
  expect(uploads).toHaveLength(18);
});
it.each(['scope', 'hash', 'scene', 'ratio', 'unconfirmed'] as const)(
  'does not reuse a cached mapping with mismatched %s',
  async (mismatch) => {
    const a = await asset('scope-source.png', new Uint8Array([137, 80, 78, 71, 99]));
    draft = { ...draft, revision: 2, assets: [a], galleryKeys: [a.key] };
    await repo.saveProduct(draft, 1);
    let cachedConnection = connectionId;
    if (mismatch === 'scope') {
      cachedConnection = randomUUID();
      await pool.query(
        "INSERT INTO connections(id,environment,partner_id,shop_id,name) VALUES($1,'sandbox','1232297',$2,'Other fixture')",
        [cachedConnection, String(Date.now())],
      );
    }
    const cachedRunId = randomUUID(),
      cachedBody = {
        baseline: { gallery: { ratio: mismatch === 'ratio' ? '1:1' : '3:4' } },
        uploads: [
          {
            assetKey: a.key,
            sha256: mismatch === 'hash' ? '0'.repeat(64) : a.sha256,
            scene: mismatch === 'scene' ? 'desc' : 'normal',
            imageId: 'must-not-reuse',
          },
        ],
      };
    await pool.query(
      "INSERT INTO sandbox_listing_runs(id,connection_id,item_id,product_key,source_revision,connection_revision,input_fingerprint,state,intent,body) VALUES($1,$2,'803934364',$3,2,1,'fixture','rejected','{}',$4)",
      [cachedRunId, cachedConnection, draft.productKey, JSON.stringify(cachedBody)],
    );
    if (mismatch !== 'unconfirmed')
      await pool.query(
        "INSERT INTO sandbox_listing_run_events(run_id,revision,state,code) VALUES($1,1,'rejected','UPLOAD_RECORDED')",
        [cachedRunId],
      );
    const { run } = await prepared(['gallery']);
    const result = await service.execute({ id: run.id, expectedRevision: 1 });
    expect(result.state).toBe('verified');
    expect(uploads).toHaveLength(1);
    expect(result.uploads[0]?.reusedFromRunId).toBeUndefined();
    expect(result.uploads[0]?.imageId).not.toBe('must-not-reuse');
  },
);
