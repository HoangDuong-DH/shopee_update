import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { BlobStore, Repository, migrate } from '../../packages/persistence/src/index.js';
import { SecretBox } from '../../packages/shopee/src/index.js';
import { createApp } from '../../apps/api/src/app.js';

const schema = 'test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool),
  connectionId = randomUUID(),
  key = '64'.repeat(32);
const credentials = {
  partnerKey: 'fixture-http-partner-secret',
  accessToken: 'fixture-http-token-secret',
};
const headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
const baseUrl = '/v1/sandbox-create-trials';
let root: string, blobs: BlobStore, app: Awaited<ReturnType<typeof createApp>>;
let calls: string[], uploads: Buffer[], trialKey: string;
let uploadGate: (() => Promise<void>) | undefined;
let authFails: boolean, uploadUnknown: boolean, itemScanTruncated: boolean;
let fixtureMetadata: ReturnType<typeof metadata>;
const input = (count = 1, name = trialKey) => ({
  trialKey: name,
  connectionId,
  connectionRevision: 1,
  count,
  logisticId: 51022,
});
function metadata() {
  return {
    category: { category_id: 301378, has_children: false },
    attributes: {
      list: [
        {
          category_id: 301378,
          attribute_tree: [
            {
              attribute_id: 200134,
              mandatory: true,
              attribute_info: { input_type: 4, max_value_count: 5 },
              attribute_value_list: [{ value_id: 101205 }],
            },
          ],
        },
      ],
    },
    brands: { is_mandatory: false, brand_list: [], has_next_page: false, next_offset: 0 },
    channels: {
      logistics_channel_list: [
        {
          logistics_channel_id: 51022,
          enabled: true,
          mask_channel_id: 0,
          fee_type: 'SIZE_INPUT',
          weight_limit: { item_min_weight: 0.01, item_max_weight: 30 },
        },
      ],
    },
    limits: {
      price_limit: { min_limit: 1000, max_limit: 999999 },
      stock_limit: { min_limit: 0, max_limit: 10000 },
      item_name_length_limit: { min_limit: 10, max_limit: 120 },
      item_description_length_limit: { min_limit: 10, max_limit: 3000 },
      item_image_count_limit: { min_limit: 1, max_limit: 8 },
      item_count_limit: { max_limit: 1000 },
      tier_variation_name_length_limit: { min_limit: 1, max_limit: 14 },
      tier_variation_option_length_limit: { min_limit: 1, max_limit: 20 },
      gtin_limit: { gtin_validation_rule: 'Optional' },
      dts_limit: { non_pre_order_days_to_ship: 2 },
    },
  };
}
const success = (response: unknown) =>
  new Response(JSON.stringify({ error: '', response, request_id: 'http-fixture-' + calls.length }));
const transport: typeof fetch = async (raw, init) => {
  const url = new URL(String(raw));
  expect(url.origin).toBe('https://openplatform.sandbox.test-stable.shopee.sg');
  expect(url.searchParams.get('partner_id')).toBe('1232297');
  expect(init?.redirect).toBe('error');
  const path = url.pathname;
  calls.push(path);
  if (path.endsWith('get_shop_info'))
    return new Response(
      JSON.stringify(
        authFails
          ? {
              error: 'invalid_acceess_token',
              request_id: 'http-auth-rejected',
              message: credentials.accessToken,
            }
          : {
              error: '',
              request_id: 'http-shop',
              shop_name: 'Synthetic fixture TEST shop',
              region: 'VN',
              status: 'NORMAL',
            },
      ),
      { status: authFails ? 403 : 200 },
    );
  if (path.endsWith('get_category')) return success({ category_list: [fixtureMetadata.category] });
  if (path.endsWith('get_attribute_tree')) return success(fixtureMetadata.attributes);
  if (path.endsWith('get_brand_list')) return success(fixtureMetadata.brands);
  if (path.endsWith('get_channel_list')) return success(fixtureMetadata.channels);
  if (path.endsWith('get_item_limit')) return success(fixtureMetadata.limits);
  if (path.endsWith('get_item_list')) {
    expect(url.searchParams.getAll('item_status')).toEqual([
      'NORMAL',
      'BANNED',
      'UNLIST',
      'REVIEWING',
      'SELLER_DELETE',
      'SHOPEE_DELETE',
    ]);
    return success({
      item: itemScanTruncated ? [] : [{ item_id: 803934364, item_status: 'NORMAL' }],
      total_count: 1,
      has_next_page: false,
      next_offset: 0,
    });
  }
  if (path.endsWith('get_item_base_info'))
    return success({
      item_list: [
        { item_id: 803934364, item_sku: 'LMKT5D-READONLY', item_name: 'Existing protected source' },
      ],
    });
  if (path.endsWith('upload_image')) {
    const form = init?.body as FormData;
    expect(form.get('scene')).toBe('normal');
    expect(form.get('ratio')).toBe('1:1');
    uploads.push(Buffer.from(await (form.get('image') as Blob).arrayBuffer()));
    await uploadGate?.();
    if (uploadUnknown) throw new Error(credentials.accessToken);
    const image_info = { image_id: 'http-fixture-image-' + uploads.length };
    return success({ image_info, image_info_list: [{ image_info, error: null }] });
  }
  throw new Error('Fixture forbids unexpected Shopee endpoint: ' + path);
};
const call = (options: any) => app.getHttpAdapter().getInstance().inject(options);
const post = (path: string, payload: unknown) =>
  call({ method: 'POST', url: baseUrl + path, headers, payload });
const get = (path: string) => call({ method: 'GET', url: baseUrl + path });
function secretFree(raw: unknown) {
  const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
  expect(serialized).not.toContain(credentials.accessToken);
  expect(serialized).not.toContain(credentials.partnerKey);
  expect(serialized).not.toMatch(
    /token_ciphertext|partner_key_ciphertext|access_token|partner_key|[?&]sign=/,
  );
}
async function prepare(count = 1, name = trialKey) {
  const response = await post('/prepare', input(count, name));
  expect(response.statusCode).toBe(201);
  const body = response.json();
  expect(body.issues).toEqual([]);
  expect(body.state).toBe('prepared');
  secretFree(response.payload);
  return body;
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  root = await mkdtemp(join(tmpdir(), 'shopee-trial-http-'));
  blobs = new BlobStore(root);
  const box = new SecretBox(key);
  await pool.query(
    "INSERT INTO connections(id,environment,partner_id,shop_id,name,state,revision,partner_key_ciphertext,token_ciphertext) VALUES($1,'sandbox','1232297','227418363','HTTP TEST fixture','connected',1,$2,$3)",
    [
      connectionId,
      box.seal({ partnerKey: credentials.partnerKey }, 'sandbox:1232297:227418363'),
      box.seal({ accessToken: credentials.accessToken }, 'sandbox:1232297:227418363'),
    ],
  );
  app = await createApp(repo, blobs, ['http://localhost:5173'], {
    trialTransport: transport,
    trialEncryptionKey: key,
    trialPause: async () => {},
  });
  await app.getHttpAdapter().getInstance().ready();
});
beforeEach(async () => {
  await pool.query('TRUNCATE sandbox_trial_preparations,sandbox_create_trials CASCADE');
  await pool.query('UPDATE connections SET revision=1 WHERE id=$1', [connectionId]);
  trialKey = 'SBX-BULK-HTTP-' + randomUUID().slice(0, 8);
  calls = [];
  uploads = [];
  uploadGate = undefined;
  authFails = false;
  uploadUnknown = false;
  itemScanTruncated = false;
  fixtureMetadata = metadata();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (root && root.startsWith(join(tmpdir(), 'shopee-trial-http-')))
    await rm(root, { recursive: true, force: true });
});

it('inspects full live-shaped metadata through HTTP without upload, preparation or job writes', async () => {
  const response = await post('/inspect', input(3));
  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({
    issues: [],
    scope: { environment: 'sandbox', partnerId: '1232297', shopId: '227418363' },
    connectionRevision: 1,
  });
  expect(response.json().metadata.existing).toEqual([
    { item_id: 803934364, item_sku: 'LMKT5D-READONLY', item_name: 'Existing protected source' },
  ]);
  expect(uploads).toHaveLength(0);
  expect(
    (await pool.query('SELECT count(*)::int n FROM sandbox_trial_preparations')).rows[0].n,
  ).toBe(0);
  expect((await pool.query('SELECT count(*)::int n FROM sandbox_create_trials')).rows[0].n).toBe(0);
  secretFree(response.payload);
});

it('concurrent identical preparations upload exactly three images and keep one immutable preview', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atUpload = new Promise<void>((resolve) => {
    entered = resolve;
  });
  uploadGate = async () => {
    entered();
    await gate;
  };
  const first = post('/prepare', input(3)).then((response: any) => response);
  let duplicate: any;
  try {
    await atUpload;
    duplicate = await post('/prepare', input(3));
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().state).toBe('preparing');
    expect(uploads).toHaveLength(1);
  } finally {
    release();
  }
  const completed = await first;
  expect(completed.statusCode).toBe(201);
  const prepared = completed.json();
  expect(prepared.state).toBe('prepared');
  expect(prepared.id).toBe(duplicate.json().id);
  expect(uploads).toHaveLength(3);
  expect(
    prepared.manifest.items.map((item: any) => item.tiers?.standardise_tier_variation.length ?? 0),
  ).toEqual([0, 1, 2]);
  for (const [index, bytes] of uploads.entries()) {
    expect(await sharp(bytes).metadata()).toMatchObject({
      format: 'png',
      width: 1000,
      height: 1000,
    });
    expect(prepared.uploads[index]).toMatchObject({
      state: 'success',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  expect(
    new Set(uploads.map((bytes) => createHash('sha256').update(bytes).digest('hex'))).size,
  ).toBe(3);
  const repeated = await post('/prepare', input(3));
  expect(repeated.json().manifest).toEqual(prepared.manifest);
  expect(repeated.json().fingerprint).toBe(prepared.fingerprint);
  const conflict = await post('/prepare', input(2));
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().code).toBe('SANDBOX_TRIAL_PREPARATION_CONFLICT');
  expect(uploads).toHaveLength(3);
  expect(
    (await pool.query('SELECT count(*)::int n FROM sandbox_trial_preparations')).rows[0].n,
  ).toBe(1);
  expect(
    calls.some((path) => path.endsWith('add_item') || path.endsWith('init_tier_variation')),
  ).toBe(false);
  secretFree((await get('/preparations/' + prepared.id)).payload);
});

it('requires the internal client header and rejects forged preview before queue submission', async () => {
  const forbidden = await call({ method: 'POST', url: baseUrl + '/prepare', payload: input() });
  expect(forbidden.statusCode).toBe(403);
  expect(calls).toHaveLength(0);
  const prepared = await prepare();
  const mismatch = await post('/preparations/' + prepared.id + '/submit', {
    fingerprint: '0'.repeat(64),
  });
  expect(mismatch.statusCode).toBe(409);
  expect(mismatch.json().code).toBe('SANDBOX_TRIAL_FINGERPRINT_MISMATCH');
  expect((await pool.query('SELECT count(*)::int n FROM sandbox_create_trials')).rows[0].n).toBe(0);
});

it('accepts duplicate concurrent submissions with HTTP202 and a single durable queued item', async () => {
  const prepared = await prepare();
  const before = [...calls];
  const responses = await Promise.all([
    post('/preparations/' + prepared.id + '/submit', { fingerprint: prepared.fingerprint }),
    post('/preparations/' + prepared.id + '/submit', { fingerprint: prepared.fingerprint }),
  ]);
  responses.forEach((response) => expect(response.statusCode).toBe(202));
  const trial = responses[0].json();
  expect(responses[1].json().id).toBe(trial.id);
  expect(trial.state).toBe('queued');
  expect(trial.items).toHaveLength(1);
  expect(trial.items[0].intent.create).toEqual(prepared.manifest.items[0].create);
  expect(calls).toEqual(before); // Submission queues only; this test never starts a worker.
  expect((await pool.query('SELECT count(*)::int n FROM sandbox_create_trials')).rows[0].n).toBe(1);
  expect(
    (await pool.query('SELECT count(*)::int n FROM sandbox_create_trial_items')).rows[0].n,
  ).toBe(1);
  const events = (await pool.query('SELECT code FROM sandbox_create_trial_events')).rows;
  expect(events).toEqual([{ code: 'QUEUED' }]);
  secretFree(responses.map((response) => response.json()));
  secretFree((await get('')).payload);
  secretFree((await get('/' + trial.id)).payload);
});

it('holds a multi-item batch until a single-item trial on the same connection revision is verified', async () => {
  const batch = await prepare(3);
  const submitBatch = () =>
    post('/preparations/' + batch.id + '/submit', { fingerprint: batch.fingerprint });
  const blocked = await submitBatch();
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().code).toBe('SANDBOX_TRIAL_SINGLE_ITEM_REQUIRED');
  const single = await prepare(1, trialKey + '-SINGLE');
  const submitted = await post('/preparations/' + single.id + '/submit', {
    fingerprint: single.fingerprint,
  });
  expect(submitted.statusCode).toBe(202);
  expect((await submitBatch()).json().code).toBe('SANDBOX_TRIAL_SINGLE_ITEM_REQUIRED');
  // This is an isolated prerequisite fixture, not a claim of real Shopee verification.
  await pool.query(
    "UPDATE sandbox_create_trial_items SET state='verified',stage='done' WHERE trial_id=$1",
    [submitted.json().id],
  );
  const allowed = await submitBatch();
  expect(allowed.statusCode).toBe(202);
  expect(allowed.json().items).toHaveLength(3);
  expect(allowed.json().state).toBe('queued');
  expect(
    calls.some((path) => path.endsWith('add_item') || path.endsWith('init_tier_variation')),
  ).toBe(false);
});

it('rejects stale connection revisions after preview without inserting a runnable trial', async () => {
  const prepared = await prepare();
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  const response = await post('/preparations/' + prepared.id + '/submit', {
    fingerprint: prepared.fingerprint,
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe('SANDBOX_CONNECTION_REVISION_CHANGED');
  expect((await pool.query('SELECT count(*)::int n FROM sandbox_create_trials')).rows[0].n).toBe(0);
});

it('keeps an unknown upload receipt durable and never repeats it for the same preparation', async () => {
  uploadUnknown = true;
  const first = await post('/prepare', input());
  expect(first.statusCode).toBe(201);
  expect(first.json().state).toBe('unknown');
  expect(first.json().issues).toEqual(['MEDIA_RECEIPT_UNKNOWN']);
  expect(uploads).toHaveLength(1);
  uploadUnknown = false;
  const repeated = await post('/prepare', input());
  expect(repeated.json().id).toBe(first.json().id);
  expect(repeated.json().state).toBe('unknown');
  expect(uploads).toHaveLength(1);
  secretFree(first.payload);
  secretFree((await pool.query('SELECT * FROM sandbox_trial_preparations')).rows);
});

it('turns a structured authentication failure into a safe HTTP error before uploading', async () => {
  authFails = true;
  const response = await post('/prepare', input());
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe('SANDBOX_AUTH_REQUIRED');
  expect(calls).toEqual(['/api/v2/shop/get_shop_info']);
  expect(uploads).toHaveLength(0);
  secretFree(response.payload);
  secretFree((await pool.query('SELECT * FROM sandbox_trial_preparations')).rows);
});

it('blocks a truncated item scan before upload when the final page does not match total_count', async () => {
  itemScanTruncated = true;
  const response = await post('/prepare', input());
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe('SANDBOX_TRIAL_ITEM_SCAN_INCOMPLETE');
  expect(uploads).toHaveLength(0);
  expect(calls.some((path) => path.endsWith('get_item_base_info'))).toBe(false);
  const records = (await pool.query('SELECT * FROM sandbox_trial_preparations')).rows;
  expect(records).toHaveLength(1);
  expect(records[0].state).toBe('blocked');
  expect(records[0].issues).toEqual(['SANDBOX_TRIAL_ITEM_SCAN_INCOMPLETE']);
  expect((await pool.query('SELECT count(*)::int n FROM sandbox_create_trials')).rows[0].n).toBe(0);
  secretFree(response.payload);
  secretFree(records);
});
