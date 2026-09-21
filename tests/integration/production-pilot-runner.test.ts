import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { ImageQcService } from '../../apps/api/src/image-qc-service.js';
import { ProductionExecutionPolicyService } from '../../apps/api/src/production-execution-policy.js';
import { productionPilotImageService } from '../../apps/api/src/production-pilot-image-service.js';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import { ProductionPilotTransport } from '../../packages/shopee/src/production-pilot-transport.js';
import {
  ProductionPilotRunner,
  type ProductionPilotPreparedInput,
} from '../../apps/api/src/production-pilot-runner.js';
import { PreparedWirePlatform } from '../fixtures/prepared-wire-platform.js';
import {
  businessCategoryFixtures,
  businessShopFixtures,
} from '../fixtures/business-batch-fixtures.js';
import { canonicalJson, type PreparedMedia } from '../../packages/domain/src/index.js';

// Independent raw OpenAPI fixture remains in memory. Only its test URL origin is translated;
// the production transport still builds/signs production requests and has no real-network fallback.
const credentials = {
  environment: 'production' as const,
  partnerId: '2010476',
  shopId: '1423724897',
  partnerKey: 'QA-PROD-FIXTURE-KEY',
  accessToken: 'QA-PROD-FIXTURE-TOKEN',
};
const schema = 'test_prod_pilot_runner_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool),
  encryptionKey = '92'.repeat(32),
  box = new SecretBox(encryptionKey);
const sources = [0, 1, 2].map((i) => ({
  sourceIdentity: 'production-fixture-' + i,
  sourceRevision: 1,
}));
let directory: string,
  connectionId: string,
  platform: PreparedWirePlatform,
  runner: ProductionPilotRunner;
let cases: ProductionPilotPreparedInput[] = [];
let responseTransform: ((path: string, body: Record<string, any>) => void) | undefined;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const profile = {
  ...structuredClone(businessShopFixtures[0]!),
  shopId: credentials.shopId,
  ownerId: credentials.partnerId,
};
const transport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  expect(url.origin).toBe('https://partner.shopeemobile.com');
  url.hostname = 'openplatform.sandbox.test-stable.shopee.sg';
  const response = await platform.fetch(url, init);
  if (!responseTransform) return response;
  const body = await response.json();
  responseTransform(url.pathname, body);
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
const mutationCalls = () => platform.calls.filter((call) => call.method === 'POST');
const creates = () => platform.calls.filter((call) => call.path.endsWith('/add_item'));
const prepareSource = (source: ProductionPilotPreparedInput) => {
  // Each independent fixture case declares its own one-source user-authorized experiment.
  runner = new ProductionPilotRunner(repo, {
    ...runner.options,
    capabilityProbe: {
      sourceIdentity: source.sourceIdentity,
      sourceRevision: source.sourceRevision,
      authorizationReference: 'fixture-user-instruction',
    },
  });
  return runner.prepare(source);
};
const ready = async (index = 0) => {
  const result = await prepareSource(cases[index]!);
  expect(result.kind, JSON.stringify(result)).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Fixture invalid');
  return result.operationId;
};
async function makeCase(index: number): Promise<ProductionPilotPreparedInput> {
  const assets: Record<string, string> = {},
    folder = join(directory, 'source-' + index);
  await mkdir(folder, { recursive: true });
  const media = async (name: string, square: boolean): Promise<PreparedMedia> => {
    const file = join(folder, name + '.png'),
      bytes = await sharp({
        create: {
          width: 90,
          height: square ? 90 : 120,
          channels: 3,
          background: { r: 60 + index * 20, g: name.length * 10, b: 160 },
        },
      })
        .png()
        .toBuffer();
    await writeFile(file, bytes);
    const importId = randomUUID();
    assets[importId] = file;
    return {
      importId,
      sha256: sha(bytes),
      width: 90,
      height: square ? 90 : 120,
      mime: 'image/png',
    };
  };
  const cover = await media('cover', true),
    gallery = await media('gallery', false),
    option = await media('option', true);
  const category = businessCategoryFixtures[0]!,
    attr = category.requiredAttribute,
    value = attr.values[0]!;
  const tiers = index === 0 ? [] : index === 1 ? [' Mùi  '] : [' Mùi  ', 'Dung tích'];
  const models = Array.from({ length: index === 0 ? 1 : index === 1 ? 2 : 4 }, (_, i) => ({
    sku: `SKU-${index}-${i}`,
    originalPrice: String(20000 + i * 100),
    stock: 100,
    tierIndex: index === 0 ? [] : index === 1 ? [i] : [Math.floor(i / 2), i % 2],
    optionLabels:
      index === 0
        ? []
        : index === 1
          ? [[' Sả ', 'Quế'][i]!]
          : [[' Sả ', 'Quế'][Math.floor(i / 2)]!, ['100 ml', '500 ml'][i % 2]!],
    ...(tiers.length ? { image: option } : {}),
  }));
  const client = new ProductionPilotTransport(credentials, { transport });
  const read = async (path: string, query: Record<string, string> = {}) => {
    const result = await client.read('/api/v2/' + path, query);
    if (result.kind !== 'success') throw new Error(result.code);
    return { ...result, response: result.response as Record<string, any> };
  };
  const limits = await read('product/get_item_limit', { category_id: category.categoryId });
  const brands = await read('product/get_brand_list', {
    category_id: category.categoryId,
    offset: '0',
    page_size: '100',
    status: '1',
  });
  const attributes = await read('product/get_attribute_tree', {
    category_id_list: category.categoryId,
  });
  const channels = await read('logistics/get_channel_list');
  const attribute = attributes.response.list[0].attribute_tree.find(
    (a: any) => String(a.attribute_id) === attr.attributeId,
  );
  const selected = attribute.attribute_value_list.find(
    (v: any) => String(v.value_id) === value.valueId,
  );
  return {
    ...sources[index]!,
    connectionId,
    connectionRevision: 1,
    assets,
    issues: [],
    capabilityEvidence: {
      environment: 'production',
      partnerId: '2010476',
      shopId: '1423724897',
      connectionRevision: 1,
      gallery34: {
        state: 'unknown',
        observedAt: new Date().toISOString(),
        references: ['fixture-original-portrait-assets'],
      },
      extendedDescription: {
        state: 'unknown',
        observedAt: new Date().toISOString(),
        references: ['fixture-api-whitelist-unknown'],
      },
    },
    capabilityProbe: {
      ...sources[index]!,
      authorizationReference: 'fixture-user-instruction',
      capabilities: ['gallery34', 'extendedDescription'],
    },
    metadata: {
      environment: 'production',
      partnerId: '2010476',
      shopId: '1423724897',
      connectionRevision: 1,
      categoryId: category.categoryId,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      requestIds: [limits.requestId, brands.requestId, attributes.requestId, channels.requestId],
    },
    document: {
      sourceKey: sources[index]!.sourceIdentity,
      title: `  QA ${index} original  title `,
      description: [
        { type: 'text', text: 'Original head\n\n' },
        { type: 'image', image: gallery },
        { type: 'text', text: '\n\n Original  tail' },
      ],
      cover,
      gallery: [gallery],
      tierNames: tiers,
      models,
      categoryId: category.categoryId,
      brandId: category.brandId,
      attributes: { [attr.attributeId]: [value.valueId] },
      logistics: [{ channelId: profile.logisticsChannelId, enabled: true }],
      weightGrams: 180,
      dimensionCm: { length: 12, width: 8, height: 3 },
      publication: 'unlisted',
    },
    context: {
      images: [],
      brandName: brands.response.brand_list.find(
        (b: any) => String(b.brand_id) === category.brandId,
      ).original_brand_name,
      condition: 'NEW',
      preOrder: { is_pre_order: false },
      stockLocationBySku: Object.fromEntries(models.map((m) => [m.sku, null])),
      limits: limits.response,
      capabilities: { gallery34: false, extendedDescription: false },
      attributeList: [
        {
          attribute_id: Number(attr.attributeId),
          attribute_value_list: [
            { value_id: Number(value.valueId), original_value_name: selected.name },
          ],
        },
      ],
      channelInfoById: Object.fromEntries(
        channels.response.logistics_channel_list.map((c: any) => [
          String(c.logistics_channel_id),
          c,
        ]),
      ),
    },
  };
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const parent = resolve('.local/production-pilot-runner-tests');
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(join(parent, 'run-'));
});
beforeEach(async () => {
  vi.restoreAllMocks();
  responseTransform = undefined;
  await pool.query(
    'TRUNCATE production_pilot_qc_wait_receipts,production_pilot_deferred_image_verifications,production_pilot_rejection_closures,production_pilot_publication_verifications,production_pilot_publications,production_pilot_verifications,production_pilot_lanes,production_pilot_steps,production_pilot_operations',
  );
  await pool.query('DELETE FROM connections');
  connectionId = randomUUID();
  await pool.query(
    `INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at,partner_key_ciphertext,token_ciphertext)
    VALUES($1,'production','2010476','1423724897','Production-scope fixture','connected',now()+interval '1 hour',$2,$3)`,
    [
      connectionId,
      box.seal({ partnerKey: credentials.partnerKey }, 'production:2010476:1423724897'),
      box.seal({ accessToken: credentials.accessToken }, 'production:2010476:1423724897'),
    ],
  );
  platform = new PreparedWirePlatform({
    shops: [
      {
        profile,
        credentials: { ...credentials, environment: 'sandbox' },
        allowPortrait: true,
        allowExtendedDescription: true,
        gtinRule: 'Optional',
      },
    ],
  });
  runner = new ProductionPilotRunner(repo, {
    allowedSources: sources,
    assetRoot: directory,
    evidenceRoot: join(directory, 'evidence'),
    encryptionKey,
    transport,
    capabilityProbe: { ...sources[0]!, authorizationReference: 'fixture-user-instruction' },
    pause: async (ms) => {
      platform.advance(ms);
      await new Promise((resolve) => setTimeout(resolve, 3));
    },
  });
  cases = [];
  for (let i = 0; i < 3; i++) cases.push(await makeCase(i));
});

function enableDeferredImages() {
  runner=new ProductionPilotRunner(repo,{...runner.options,deferImageQc:true,batchAuthorization:{
    batchId:randomUUID(),manifestSha256:'c'.repeat(64),authorizationReference:'Explicit hidden trial, image review deferred',
    publicationMode:'hidden_for_review',imageQcPolicy:'defer_image_qc',
    sources:cases.map(source=>({sourceIdentity:source.sourceIdentity,sourceRevision:source.sourceRevision,
      documentSha256:createHash('sha256').update(canonicalJson(source.document)).digest('hex')})),
  }} as any);
}
it('renews expired zero-step metadata with current credentials without rewriting or duplicating the original operation', async () => {
  const id = await ready(), before = await runner.journal.get(id);
  const now = Date.now() + 11 * 60 * 1000;
  platform.advance(11 * 60 * 1000);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await expect(runner.run(id)).rejects.toThrow('METADATA_STALE');
  expect(mutationCalls()).toHaveLength(0);
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  const fresh = structuredClone(cases[0]!);
  fresh.connectionRevision = 2;
  fresh.metadata = { ...fresh.metadata, connectionRevision: 2,
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
    requestIds: ['fixture-fresh-schema', 'fixture-fresh-capabilities'] };
  fresh.capabilityEvidence.connectionRevision = 2;
  fresh.capabilityEvidence.gallery34.observedAt = fresh.metadata.observedAt;
  fresh.capabilityEvidence.extendedDescription.observedAt = fresh.metadata.observedAt;
  const receipt = await runner.renewUndispatched(id, before.operation.source_fingerprint, fresh);
  const renewed = await runner.journal.get(id);
  expect(renewed.operation).toEqual(before.operation);
  expect(renewed.steps).toHaveLength(0);
  expect((await runner.journal.getPreflightRenewal(id)).id).toBe(receipt.renewalId);
  const executed = await runner.run(id);
  expect(executed, JSON.stringify(executed)).toMatchObject({ state: 'verified' });
  expect(creates()).toHaveLength(1);
  const after = await runner.journal.get(id);
  expect(after.operation.item_id).toBeTruthy();
  expect(after.operation.source_payload).toEqual(before.operation.source_payload);
  expect(after.operation.source_fingerprint).toBe(before.operation.source_fingerprint);
  expect((await pool.query('SELECT id FROM production_pilot_operations')).rows).toHaveLength(1);
  await expect(runner.renewUndispatched(id, before.operation.source_fingerprint, fresh)).rejects.toThrow('REVISION_CONFLICT');
});
it('rejects changed source/projection and stale renewal IDs before dispatch', async () => {
  const id = await ready(), before = await runner.journal.get(id), fresh = structuredClone(cases[0]!);
  const changed = structuredClone(fresh); changed.document.title += ' changed';
  await expect(runner.renewUndispatched(id, before.operation.source_fingerprint, changed)).rejects.toThrow('PREFLIGHT_SOURCE_CHANGED');
  const changedContext = structuredClone(fresh); changedContext.context.brandName = 'Different brand';
  await expect(runner.renewUndispatched(id, before.operation.source_fingerprint, changedContext)).rejects.toThrow('PREFLIGHT_SOURCE_CHANGED');
  const first = await runner.renewUndispatched(id, before.operation.source_fingerprint, fresh);
  const second = await runner.renewUndispatched(id, before.operation.source_fingerprint, fresh);
  const media = fresh.document.cover, bytes = await readFile(fresh.assets[media.importId]!);
  const step = { operationId: id, expectedRevision: 1, stepKey: 'media-0', sourceAssetIdentity: media.importId,
    bytes, mime: 'image/png' as const, options: { scene: 'normal' as const, ratio: '1:1' as const } };
  await expect(runner.journal.authorizeMedia({ ...step, renewalId: first.renewalId })).rejects.toThrow('PREFLIGHT_RENEWAL_CHANGED');
  const accepted = await runner.journal.authorizeMedia({ ...step, renewalId: second.renewalId });
  const intent = { operationId: id, stepId: accepted.step.id, path: accepted.step.path, fingerprint: accepted.step.fingerprint };
  await expect(runner.journal.markSent(intent)).rejects.toThrow('PREFLIGHT_RENEWAL_CHANGED');
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  await expect(runner.journal.markSent(intent, second.renewalId)).rejects.toThrow('CONNECTION_CHANGED');
  expect((await runner.journal.get(id)).steps[0].state).toBe('authorized');
  expect(mutationCalls()).toHaveLength(0);
});
it('checks an occupied shop lane before inserting another source reservation', async () => {
  const id = await ready(), input = cases[0]!, media = input.document.cover;
  await runner.journal.authorizeMedia({ operationId: id, expectedRevision: 1, stepKey: 'media-0',
    sourceAssetIdentity: media.importId, bytes: await readFile(input.assets[media.importId]!),
    mime: 'image/png', options: { scene: 'normal', ratio: '1:1' } });
  await expect(prepareSource(cases[1]!)).rejects.toThrow('SHOP_BUSY');
  expect((await pool.query('SELECT id FROM production_pilot_operations')).rows.map(r => r.id)).toEqual([id]);
  expect(mutationCalls()).toHaveLength(0);
});
it('explicit hidden image deferral records two core reads, leaves image QC pending and permits the next source without publishing',async()=>{
  enableDeferredImages();
  responseTransform=(path,body)=>{if(path.endsWith('get_item_base_info'))body.response.item_list[0].promotion_image.image_id_list=['unreviewed-transformed-cover'];};
  const id=await ready(1),result=await runner.run(id);
  expect(result.state).toBe('hidden_image_qc_deferred');
  const view=await runner.journal.get(id) as any;
  expect(view.operation.state).toBe('acknowledged');expect(view.verification).toBeNull();
  expect(view.deferredImageVerification).toMatchObject({operation_id:id,source_fingerprint:view.operation.source_fingerprint,basis:'image_qc_deferred_by_operator'});
  expect(view.deferredImageVerification.readbacks).toHaveLength(2);
  expect(view.deferredImageVerification.readbacks[0].raw.base.response.item_list[0].promotion_image.image_id_list).toEqual(['unreviewed-transformed-cover']);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(0);
  const before=mutationCalls().length;expect((await runner.run(id)).state).toBe('hidden_image_qc_deferred');expect(mutationCalls()).toHaveLength(before);
  await expect(runner.publish(id,cases[1]!.metadata)).rejects.toThrow('PUBLICATION_REQUIRES_VERIFIED_CREATE');
  const next=await ready(0);expect((await runner.run(next)).state).toBe('hidden_image_qc_deferred');
  expect(platform.calls.filter(c=>c.path.endsWith('/unlist_item'))).toHaveLength(0);
});
it.each(['price','stock','title','status'])('deferred images never excuse a %s mismatch or release its lane',async(field)=>{
  enableDeferredImages();
  responseTransform=(path,body)=>{if(!path.endsWith('get_item_base_info'))return;
    const item=body.response.item_list[0];item.promotion_image.image_id_list=['unreviewed-cover'];
    if(field==='price'){item.price_info[0].original_price++;item.price_info[0].current_price++;}
    if(field==='stock'){item.stock_info_v2.seller_stock[0].stock--;item.stock_info_v2.summary_info.total_available_stock--;}
    if(field==='title')item.item_name='Changed without source';
    if(field==='status')item.item_status='NORMAL';
  };
  const id=await ready(0),result=await runner.run(id);
  expect(result.state).toBe('unresolved');
  expect((await runner.journal.get(id) as any).deferredImageVerification).toBeNull();
  expect((await pool.query('SELECT operation_id FROM production_pilot_lanes')).rows).toEqual([{operation_id:id}]);
});
it('reconciles deferred images strictly later without replaying any creation step',async()=>{
  enableDeferredImages();
  responseTransform=(path,body)=>{if(path.endsWith('get_item_base_info'))body.response.item_list[0].promotion_image.image_id_list=['unreviewed-cover'];};
  const id=await ready(0);expect((await runner.run(id)).state).toBe('hidden_image_qc_deferred');
  const before=mutationCalls().length;
  const strict=new ProductionPilotRunner(repo,{...runner.options,deferImageQc:false});
  expect((await strict.run(id)).state).toBe('unresolved');
  expect((await strict.journal.get(id)).verification).toBeNull();
  responseTransform=undefined;
  expect((await strict.run(id)).state).toBe('verified');
  expect(mutationCalls()).toHaveLength(before);
  const view=await strict.journal.get(id);expect(view.verification).not.toBeNull();expect(view.deferredImageVerification).not.toBeNull();
});
it('converts an original all-ACK automatic operation to hidden image deferral without rewriting it or replaying POST',async()=>{
  enableDeferredImages();
  const originalAuthorization=structuredClone(runner.options.batchAuthorization!) as any;
  delete originalAuthorization.publicationMode;delete originalAuthorization.imageQcPolicy;
  runner=new ProductionPilotRunner(repo,{...runner.options,deferImageQc:false,batchAuthorization:originalAuthorization});
  responseTransform=(path,body)=>{if(path.endsWith('get_item_base_info'))body.response.item_list[0].promotion_image.image_id_list=['unreviewed-transformed-cover'];};
  const id=await ready(1);expect((await runner.run(id)).state).toBe('unresolved');
  const before=await runner.journal.get(id),postCount=mutationCalls().length;
  const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
  const preparationId=randomUUID(),body={entries:cases.map(c=>({sourceIdentity:c.sourceIdentity}))},preparationFingerprint=digest(body);
  const batchId=originalAuthorization.batchId,manifestSha256=originalAuthorization.manifestSha256;
  await pool.query('INSERT INTO production_source_preparations(id,request_hash,request,body,fingerprint,registration) VALUES($1,$2,$3,$4,$5,$6)',[preparationId,digest({}),{},body,preparationFingerprint,{batches:[{batchId,manifestSha256}]}]);
  const manifest={version:2,batchId,preparation:{id:preparationId,fingerprint:preparationFingerprint},scope:{environment:'production',partnerId:'2010476',shopId:'1423724897'},authorizationReference:originalAuthorization.authorizationReference,
    listings:cases.map((c,i)=>({sourceKey:'source-'+i,sourceIdentity:c.sourceIdentity,sourceRevision:c.sourceRevision,document:c.document}))};
  const policyService=new ProductionExecutionPolicyService(repo,{loadManifest:async()=>({value:manifest,sha256:manifestSha256}),batchStatus:async()=>({manifestSha256,statusFingerprint:'d'.repeat(64),busy:false,interrupted:false,
    listings:manifest.listings.map((s,i)=>({sourceKey:s.sourceKey,state:i===1?'created_readback_pending':'not_sent'}))})});
  const policy=await policyService.convert(preparationId,{id:randomUUID(),expectedFingerprint:preparationFingerprint,publicationMode:'hidden_for_review',imageQcPolicy:'defer_image_qc',batches:[{batchId,expectedStatusFingerprint:'d'.repeat(64),sourceKeys:manifest.listings.map(s=>s.sourceKey)}]});
  runner=new ProductionPilotRunner(repo,{...runner.options,deferImageQc:true,executionPolicy:policy});
  expect((await runner.run(id)).state).toBe('hidden_image_qc_deferred');
  const after=await runner.journal.get(id);
  expect(after.operation).toEqual(before.operation);expect(after.steps).toEqual(before.steps);expect(after.verification).toBeNull();
  expect(after.deferredImageVerification.execution_policy_id).toBe(policy.id);
  expect(mutationCalls()).toHaveLength(postCount);expect(platform.calls.some(c=>c.path.endsWith('/unlist_item'))).toBe(false);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(0);
  await expect(runner.publish(id,cases[1]!.metadata)).rejects.toThrow('PUBLICATION_REQUIRES_VERIFIED_CREATE');
});
function stockLocationSource() {
  const source = structuredClone(cases[1]!);
  const requestId = 'fixture-stock-location-observation';
  source.metadata.requestIds.push(requestId);
  source.stockLocationEvidence = {
    environment: 'production',
    partnerId: '2010476',
    shopId: '1423724897',
    connectionRevision: 1,
    observedAt: source.metadata.observedAt,
    observations: [
      {
        requestId,
        path: '/api/v2/product/get_model_list',
        response: {
          model: [
            {
              stock_info_v2: {
                seller_stock: [{ location_id: 'VNZ', stock: 1004, if_saleable: true }],
                summary_info: { total_reserved_stock: 0, total_available_stock: 1004 },
                shopee_stock: [],
                advance_stock: { sellable_advance_stock: 0, in_transit_advance_stock: 0 },
              },
            },
          ],
        },
      },
    ],
    expectedLocationBySku: Object.fromEntries(source.document.models.map((m) => [m.sku, 'VNZ'])),
  };
  return source;
}

it('accepts proven internal VNZ read location while keeping the null write location omitted', async () => {
  const source = stockLocationSource();
  const prepared = await prepareSource(source);
  if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
  responseTransform = (path, body) => {
    if (path.endsWith('/get_model_list'))
      for (const model of body.response?.model ?? [])
        model.stock_info_v2.seller_stock[0].location_id = 'VNZ';
  };
  const result = await runner.run(prepared.operationId);
  expect(result.state, JSON.stringify(result)).toBe('verified');
  const init = platform.calls.find((call) => call.path.endsWith('/init_tier_variation'))!;
  expect(JSON.stringify(init.body)).not.toContain('location_id');
  expect(source.context.stockLocationBySku).toEqual(
    Object.fromEntries(source.document.models.map((m) => [m.sku, null])),
  );
});

it.each(['shop', 'revision', 'request', 'location', 'sellerRows', 'reservation', 'fbs', 'advance'])(
  'blocks invalid stock location evidence: %s',
  async (fault) => {
    const source = stockLocationSource();
    const proof = source.stockLocationEvidence!;
    const stock = (proof.observations[0]!.response.model as any[])[0].stock_info_v2;
    if (fault === 'shop') (proof as any).shopId = 'other';
    if (fault === 'revision') proof.connectionRevision = 2;
    if (fault === 'request') proof.observations[0]!.requestId = 'unregistered';
    if (fault === 'location') proof.expectedLocationBySku[source.document.models[0]!.sku] = 'OTHER';
    if (fault === 'sellerRows')
      stock.seller_stock.push({ location_id: 'OTHER', stock: 0, if_saleable: true });
    if (fault === 'reservation') stock.summary_info.total_reserved_stock = 1;
    if (fault === 'fbs') stock.shopee_stock.push({ stock: 1 });
    if (fault === 'advance') stock.advance_stock.sellable_advance_stock = 1;
    await expect(prepareSource(source)).rejects.toThrow();
    expect(mutationCalls()).toHaveLength(0);
  },
);

it.each([
  'location',
  'sellerRows',
  'reservation',
  'fbs',
  'advance',
  'notSaleable',
  'missingSaleable',
])('never loosens stock safety checks with read location proof: %s', async (fault) => {
  const source = stockLocationSource();
  const prepared = await prepareSource(source);
  if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
  responseTransform = (path, body) => {
    if (!path.endsWith('/get_model_list')) return;
    for (const row of body.response?.model ?? []) {
      const stock = row.stock_info_v2;
      stock.seller_stock[0].location_id = fault === 'location' ? 'OTHER' : 'VNZ';
      if (fault === 'sellerRows')
        stock.seller_stock.push({ location_id: 'OTHER', stock: 0, if_saleable: true });
      if (fault === 'reservation') stock.summary_info.total_reserved_stock = 1;
      if (fault === 'fbs') stock.shopee_stock.push({ stock: 1 });
      if (fault === 'advance')
        stock.advance_stock = { sellable_advance_stock: 1, in_transit_advance_stock: 0 };
      if (fault === 'notSaleable') stock.seller_stock[0].if_saleable = false;
      if (fault === 'missingSaleable') delete stock.seller_stock[0].if_saleable;
    }
  };
  expect((await runner.run(prepared.operationId)).state).toBe('unresolved');
  expect((await runner.journal.get(prepared.operationId)).verification).toBeNull();
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
});

it('revalidates metadata at the transport permit boundary before marking an upload sent', async () => {
  const id = await ready();
  const upload = ProductionPilotTransport.prototype.upload;
  const expired = Date.parse(cases[0]!.metadata.expiresAt) + 1;
  vi.spyOn(ProductionPilotTransport.prototype, 'upload').mockImplementation(function (
    this: ProductionPilotTransport,
    ...args
  ) {
    vi.spyOn(Date, 'now').mockReturnValue(expired);
    return upload.apply(this, args);
  });
  try {
    await expect(runner.run(id)).rejects.toThrow('PRODUCTION_PILOT');
    expect(mutationCalls()).toHaveLength(0);
    const view = await runner.journal.get(id);
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]!.state).toBe('authorized');
    expect(view.steps[0]!.sent_at).toBeNull();
  } finally {
    vi.restoreAllMocks();
  }
});

it.each(['is_free', 'size_id', 'shipping_fee'])(
  'compares requested logistics %s in both readbacks',
  async (field) => {
    const source = structuredClone(cases[0]!);
    source.context.baseline = {
      item: {
        logistic_info: [
          {
            logistic_id: Number(profile.logisticsChannelId),
            enabled: true,
            is_free: false,
            size_id: 7,
            shipping_fee: 24000,
          },
        ],
      },
      models: { model: [], tier_variation: [] },
    } as any;
    const prepared = await prepareSource(source);
    if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
    responseTransform = (path, body) => {
      if (path.endsWith('/get_item_base_info')) {
        const channel = body.response?.item_list?.[0]?.logistic_info?.find(
          (row: any) => String(row.logistic_id) === profile.logisticsChannelId,
        );
        if (channel) channel[field] = field === 'is_free' ? true : 999;
      }
    };
    const result = await runner.run(prepared.operationId);
    expect(result.state, JSON.stringify(result)).toBe('unresolved');
    expect(result.mismatchedPaths?.join(' ')).toContain(field);
    expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
  },
);

it('reconciles only by reads after all writes acknowledged, even after metadata expiry and same-shop token rotation', async () => {
  const id = await ready(1);
  responseTransform = (path, body) => {
    if (path.endsWith('/get_item_base_info') && body.response?.item_list?.[0])
      body.response.item_list[0].promotion_image.image_id_list = ['wrong-cover'];
  };
  expect((await runner.run(id)).state).toBe('unresolved');
  const writes = mutationCalls().length;
  const before = await runner.journal.get(id);
  const future = Date.now() + 11 * 60 * 1000;
  platform.advance(11 * 60 * 1000);
  await pool.query('UPDATE connections SET revision=2 WHERE id=$1', [connectionId]);
  await writeFile(
    cases[1]!.assets[cases[1]!.document.cover.importId]!,
    'changed after acknowledged; no upload allowed',
  );
  responseTransform = undefined;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => future);
  try {
    const result = await runner.run(id);
    expect(result.state, JSON.stringify(result)).toBe('verified');
    expect(mutationCalls()).toHaveLength(writes);
    const saved = await runner.journal.get(id);
    expect(saved.operation.source_payload).toEqual(before.operation.source_payload);
    expect(saved.verification.readbacks.every((r: any) => r.connectionRevision === 2)).toBe(true);
  } finally {
    clock.mockRestore();
  }
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

it('runs three independently prepared sources, 0/1/2 tiers and 7 SKUs through media/API/journal/two complete readbacks', async () => {
  const sourceBefore = JSON.stringify(cases),
    originals = new Map<string, string>();
  for (const entry of cases)
    for (const file of Object.values(entry.assets)) originals.set(file, sha(await readFile(file)));
  for (let i = 0; i < 3; i++) {
    const id = await ready(i),
      result = await runner.run(id);
    expect(result.state, JSON.stringify(result)).toBe('verified');
    expect(result.evidenceFiles).toHaveLength(2);
    const saved = await runner.journal.get(id);
    expect(saved.verification.phase).toBe('created_unlisted');
    expect(saved.verification.readbacks).toHaveLength(2);
    expect(saved.verification.readbacks[0].projection.models).toHaveLength(
      cases[i]!.document.models.length,
    );
    expect(saved.steps.every((step) => step.state === 'acknowledged')).toBe(true);
    const before = mutationCalls().length;
    expect((await runner.run(id)).state).toBe('verified');
    expect(mutationCalls()).toHaveLength(before);
  }
  expect(creates()).toHaveLength(3);
  expect(platform.snapshot().items.every((item) => item.base.item_status === 'UNLIST')).toBe(true);
  expect(platform.snapshot().items.reduce((sum, item) => sum + (item.models.length || 1), 0)).toBe(
    7,
  );
  expect(JSON.stringify(mutationCalls())).not.toContain('LOCAL_ONLY_VALIDATION');
  for (const init of platform.calls.filter((call) => call.path.endsWith('/init_tier_variation'))) {
    const prior = platform.calls
      .filter((call) => call.path.endsWith('/add_item') && call.sequence < init.sequence)
      .at(-1)!;
    expect(init.at - prior.at).toBeGreaterThanOrEqual(5000);
  }
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(0);
  expect(JSON.stringify(cases)).toBe(sourceBefore);
  for (const [file, hash] of originals) expect(sha(await readFile(file))).toBe(hash);
}, 30000);
it('validates missing metadata and source issues before any image upload', async () => {
  const missing = structuredClone(cases[0]!);
  delete missing.context.limits.size_chart_limit;
  const result = await prepareSource(missing);
  expect(result.kind).toBe('blocked');
  expect(mutationCalls()).toHaveLength(0);
  await expect(
    prepareSource({ ...cases[0]!, issues: [{ code: 'PRICE_UNMAPPED', field: 'price' }] }),
  ).rejects.toThrow('SOURCE_ISSUES');
  expect((await pool.query('SELECT * FROM production_pilot_operations')).rows).toHaveLength(0);
});
it('supports normal description text blocks while preserving exact combined spacing', async () => {
  const source = structuredClone(cases[0]!);
  source.document.description = [
    { type: 'text', text: '  First\n\n' },
    { type: 'text', text: '  Second  ' },
  ];
  source.capabilityProbe!.capabilities = ['gallery34'];
  const prepared = await prepareSource(source);
  if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
  const result = await runner.run(prepared.operationId);
  expect(result.state, JSON.stringify(result)).toBe('verified');
  expect(platform.snapshot().items[0]!.base.description).toBe('  First\n\n  Second  ');
  expect(source.document.description).toHaveLength(2);
});
it.each(['aggregate', 'omitted'])(
  'verifies exact sourced model shipping with %s item shipping',
  async (mode) => {
    const source = structuredClone(cases[1]!);
    Object.assign(source.document.models[0]!, {
      weightGrams: 182.5,
      dimensionCm: { length: 12, width: 8, height: 4 },
    });
    Object.assign(source.document.models[1]!, {
      weightGrams: 500,
      dimensionCm: { length: 20, width: 10, height: 3 },
    });
    const prepared = await prepareSource(source);
    if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
    responseTransform = (path, body) => {
      if (
        mode === 'omitted' &&
        path.endsWith('/get_item_base_info') &&
        body.response?.item_list?.[0]
      ) {
        delete body.response.item_list[0].weight;
        delete body.response.item_list[0].dimension;
      }
    };
    const result = await runner.run(prepared.operationId);
    expect(result.state, JSON.stringify(result)).toBe('verified');
    const projection = (await runner.journal.get(prepared.operationId)).verification.readbacks[0]
      .projection;
    expect(projection.models[0].weightKg).toBe(0.1825);
    expect(projection.models[1].dimensionCm).toEqual({ length: 20, width: 10, height: 3 });
  },
);
it.each(['roundedWeight', 'missingWeight', 'wrongDimensions', 'missingDimensions'])(
  'does not forgive %s on explicitly sourced model shipping',
  async (fault) => {
    const source = structuredClone(cases[1]!);
    for (const model of source.document.models)
      Object.assign(model, {
        weightGrams: 182.5,
        dimensionCm: { length: 12, width: 8, height: 4 },
      });
    const prepared = await prepareSource(source);
    if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
    responseTransform = (path, body) => {
      if (path.endsWith('/get_model_list'))
        for (const model of body.response?.model ?? []) {
          if (fault === 'roundedWeight') model.weight = 0.183;
          if (fault === 'missingWeight') delete model.weight;
          if (fault === 'wrongDimensions')
            model.dimension = { package_length: 1, package_width: 1, package_height: 1 };
          if (fault === 'missingDimensions') delete model.dimension;
        }
    };
    expect((await runner.run(prepared.operationId)).state).toBe('unresolved');
    expect((await runner.journal.get(prepared.operationId)).verification).toBeNull();
  },
);
it('checks inherited model shipping alongside explicit overrides rather than comparing every model with item maximum', async () => {
  const source = structuredClone(cases[1]!);
  Object.assign(source.document.models[0]!, {
    weightGrams: 500,
    dimensionCm: { length: 20, width: 10, height: 3 },
  });
  const prepared = await prepareSource(source);
  if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
  const result = await runner.run(prepared.operationId);
  expect(result.state, JSON.stringify(result)).toBe('verified');
  const models = (await runner.journal.get(prepared.operationId)).verification.readbacks[0]
    .projection.models;
  expect(models.map((m: any) => m.weightKg)).toEqual([0.5, 0.18]);
  expect(models[1].dimensionCm).toEqual({ length: 12, width: 8, height: 3 });
});
it('does not invent a tie-break for item dimensions with equal volumes and different sourced model tuples', async () => {
  const source = structuredClone(cases[1]!);
  Object.assign(source.document.models[0]!, {
    weightGrams: 500,
    dimensionCm: { length: 20, width: 10, height: 3 },
  });
  Object.assign(source.document.models[1]!, {
    weightGrams: 500,
    dimensionCm: { length: 10, width: 10, height: 6 },
  });
  const prepared = await prepareSource(source);
  if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
  const result = await runner.run(prepared.operationId);
  expect(result.state).toBe('unresolved');
  expect(result.mismatchedPaths?.join(' ')).toContain('ambiguous_volume');
});
it('does not ignore unknown remote fields that change between the two readbacks', async () => {
  const id = await ready();
  let read = 0;
  responseTransform = (path, body) => {
    if (path.endsWith('/get_item_base_info') && body.response?.item_list?.[0])
      body.response.item_list[0].unselected_new_metadata = ++read;
  };
  const result = await runner.run(id);
  expect(result.state).toBe('unresolved');
  expect(result.code).toBe('READBACK_NOT_STABLE');
  expect(result.evidenceFiles).toHaveLength(2);
  expect((await runner.journal.get(id)).verification).toBeNull();
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
});
it('rejects wrong shop/connection revision and expired metadata without transport mutations', async () => {
  await expect(
    prepareSource({ ...cases[0]!, metadata: { ...cases[0]!.metadata, shopId: 'wrong' } as any }),
  ).rejects.toThrow();
  await expect(prepareSource({ ...cases[0]!, connectionRevision: 2 })).rejects.toThrow(
    'CONNECTION_CHANGED',
  );
  await expect(
    prepareSource({
      ...cases[0]!,
      metadata: { ...cases[0]!.metadata, expiresAt: '2000-01-01T00:00:00.000Z' },
    }),
  ).rejects.toThrow('METADATA_STALE');
  expect(mutationCalls()).toHaveLength(0);
});
it('verifies hashes and actual dimensions again when source files change after preparation', async () => {
  const id = await ready();
  await writeFile(cases[0]!.assets[cases[0]!.document.cover.importId]!, 'changed after prepare');
  await expect(runner.run(id)).rejects.toThrow('ASSET_CHANGED');
  expect(mutationCalls()).toHaveLength(0);
});
it('rejects files outside the explicitly supplied source root before upload', async () => {
  const entry = structuredClone(cases[0]!);
  entry.assets[entry.document.cover.importId] = resolve('package.json');
  await expect(prepareSource(entry)).rejects.toThrow('ASSET_OUTSIDE_ROOT');
  expect(mutationCalls()).toHaveLength(0);
});
it('never resends a committed create whose response was lost, including after runner reconstruction', async () => {
  const id = await ready();
  platform.faults.push({ path: '/api/v2/product/add_item', kind: 'drop_response' });
  const first = await runner.run(id);
  expect(first.state).toBe('unknown');
  expect(creates()).toHaveLength(1);
  expect(platform.snapshot().items).toHaveLength(1);
  expect((await runner.journal.get(id)).operation.state).toBe('unknown');
  const fresh = new ProductionPilotRunner(repo, {
    allowedSources: sources,
    assetRoot: directory,
    evidenceRoot: join(directory, 'evidence'),
    encryptionKey,
    transport,
  });
  expect((await fresh.run(id)).state).toBe('unknown');
  expect(creates()).toHaveLength(1);
  await expect(ready(1)).rejects.toThrow('SHOP_BUSY');
  expect((await pool.query('SELECT id FROM production_pilot_operations')).rows).toHaveLength(1);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
});
it('stops a business rejection and does not attempt a second source or create retry', async () => {
  const id = await ready();
  platform.faults.push({
    path: '/api/v2/product/add_item',
    kind: 'business_error',
    code: 'product.error_busi',
  });
  expect((await runner.run(id)).state).toBe('rejected');
  expect(platform.snapshot().items).toHaveLength(0);
  expect(creates()).toHaveLength(1);
  expect((await runner.run(id)).state).toBe('rejected');
  expect(creates()).toHaveLength(1);
});
it('records partial model acknowledgement as unknown and never repeats initialization', async () => {
  const id = await ready(1);
  responseTransform = (path, body) => {
    if (path.endsWith('/init_tier_variation') && body.response?.model)
      body.response.model = body.response.model.slice(0, 1);
  };
  const result = await runner.run(id);
  expect(result.state, JSON.stringify(result)).toBe('unknown');
  const writes = mutationCalls().length;
  expect((await runner.run(id)).state).toBe('unknown');
  expect(mutationCalls()).toHaveLength(writes);
  expect((await runner.journal.get(id)).verification).toBeNull();
});
it('keeps the lane and complete raw evidence when cover readback changes despite successful acknowledgements', async () => {
  const id = await ready(1);
  responseTransform = (path, body) => {
    if (path.endsWith('/get_item_base_info') && body.response?.item_list?.[0])
      body.response.item_list[0].promotion_image = {
        image_id_list: ['unproven-cover'],
        image_ratio: '1:1',
      };
  };
  const result = await runner.run(id);
  expect(result.state, JSON.stringify(result)).toBe('unresolved');
  expect(result.mismatchedPaths?.join(' ')).toContain('promotion_image');
  expect(result.evidenceFiles).toHaveLength(1);
  const evidence = JSON.parse(await readFile(result.evidenceFiles![0]!, 'utf8'));
  expect(evidence.base.response.item_list[0].promotion_image.image_id_list).toEqual([
    'unproven-cover',
  ]);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
  expect((await runner.journal.get(id)).verification).toBeNull();
});
const publishMetadata = (index = 0) => ({
  ...cases[index]!.metadata,
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
});
it('waits for acknowledged stock propagation without repeating create, variations or stock writes', async () => {
  const id = await ready(1);
  runner = new ProductionPilotRunner(repo, { ...runner.options, readbackDelaysMs: [1, 2] });
  let reads = 0;
  responseTransform = (path, body) => {
    if (path.endsWith('/get_model_list') && ++reads === 1) {
      for (const model of body.response.model) {
        model.stock_info_v2.seller_stock[0].stock = 0;
        model.stock_info_v2.summary_info.total_available_stock = 0;
      }
    }
  };
  const result = await runner.run(id);
  expect(result.state, JSON.stringify(result)).toBe('verified');
  expect(reads).toBe(3);
  expect(creates()).toHaveLength(1);
  expect(mutationCalls().filter((c) => c.path.endsWith('/init_tier_variation'))).toHaveLength(1);
  expect(mutationCalls().filter((c) => c.path.endsWith('/update_stock'))).toHaveLength(0);
  expect(result.evidenceFiles).toHaveLength(4);
  expect((await runner.journal.get(id)).verification.readbacks).toHaveLength(2);
});
it('keeps stable source mismatches unresolved when the bounded read schedule is exhausted', async () => {
  const id = await ready();
  runner = new ProductionPilotRunner(repo, { ...runner.options, readbackDelaysMs: [1, 2] });
  let reads = 0;
  responseTransform = (path, body) => {
    if (path.endsWith('/get_item_base_info')) {
      reads++;
      body.response.item_list[0].item_name = 'Incorrect remote title';
    }
  };
  const result = await runner.run(id);
  expect(result.state).toBe('unresolved');
  expect(reads).toBe(3);
  expect(creates()).toHaveLength(1);
  expect((await runner.journal.get(id)).verification).toBeNull();
});
it('settles an acknowledged publication using only fresh reads after its first stale status', async () => {
  const id = await ready(1);
  expect((await runner.run(id)).state).toBe('verified');
  runner = new ProductionPilotRunner(repo, { ...runner.options, readbackDelaysMs: [1, 2] });
  let staleSent = false;
  responseTransform = (path, body) => {
    const item = body.response?.item_list?.[0];
    if (path.endsWith('/get_item_base_info') && item?.item_status === 'NORMAL' && !staleSent) {
      item.item_status = 'UNLIST';
      staleSent = true;
    }
  };
  const result = await runner.publish(id, publishMetadata(1));
  expect(result.state, JSON.stringify(result)).toBe('published');
  expect(mutationCalls().filter((c) => c.path.endsWith('/unlist_item'))).toHaveLength(1);
  expect(result.evidenceFiles).toHaveLength(7);
  expect((await runner.publications.getForCreate(id))!.operation.state).toBe('verified');
});
it('never turns a lost write response into a retry even with reconciliation enabled', async () => {
  const id = await ready();
  expect((await runner.run(id)).state).toBe('verified');
  runner = new ProductionPilotRunner(repo, { ...runner.options, readbackDelaysMs: [1, 2] });
  platform.faults.push({ path: '/api/v2/product/unlist_item', kind: 'drop_response' });
  expect((await runner.publish(id, publishMetadata())).state).toBe('unknown');
  expect(mutationCalls().filter((c) => c.path.endsWith('/unlist_item'))).toHaveLength(1);
});
it('publishes only its verified UNLIST create with two before and after readbacks and all other raw fields unchanged', async () => {
  const id = await ready(1);
  expect((await runner.run(id)).state).toBe('verified');
  const original = await runner.journal.get(id);
  const result = await (runner as any).publish(id, publishMetadata(1));
  expect(result.state).toBe('published');
  expect(result.evidenceFiles).toHaveLength(4);
  expect(platform.snapshot().items[0]!.base.item_status).toBe('NORMAL');
  const after = await runner.journal.get(id);
  expect(after.operation).toEqual(original.operation);
  expect(after.verification).toEqual(original.verification);
  expect((await runner.publications.getForCreate(id))!.operation.state).toBe('verified');
  const before = mutationCalls().length;
  expect((await (runner as any).publish(id, publishMetadata(1))).state).toBe('published');
  expect(mutationCalls()).toHaveLength(before);
});
it('does not publish if complete fresh before readback changed beyond source expectations', async () => {
  const id = await ready();
  expect((await runner.run(id)).state).toBe('verified');
  responseTransform = (path, body) => {
    if (path.endsWith('/get_item_base_info'))
      body.response.item_list[0].unselected_new_field = 'changed';
  };
  const writes = mutationCalls().length;
  const result = await (runner as any).publish(id, publishMetadata());
  expect(result.state).toBe('unresolved');
  expect(mutationCalls()).toHaveLength(writes);
});
it('records unknown after lost publish response and never sends unlist:false twice', async () => {
  const id = await ready();
  expect((await runner.run(id)).state).toBe('verified');
  platform.faults.push({ path: '/api/v2/product/unlist_item', kind: 'drop_response' });
  expect((await (runner as any).publish(id, publishMetadata())).state).toBe('unknown');
  const writes = mutationCalls().length;
  expect((await (runner as any).publish(id, publishMetadata())).state).toBe('unknown');
  expect(mutationCalls()).toHaveLength(writes);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
});
it('requires explicit capability evidence instead of accepting context booleans alone', async () => {
  const source = structuredClone(cases[0]!);
  delete (source as any).capabilityEvidence;
  await expect(runner.prepare(source)).rejects.toThrow('CAPABILITY');
  expect(mutationCalls()).toHaveLength(0);
});
it('does not let an unapproved source probe unknown whitelist access', async () => {
  const source = structuredClone(cases[1]!);
  (source as any).capabilityEvidence = {
    environment: 'production',
    partnerId: '2010476',
    shopId: '1423724897',
    connectionRevision: 1,
    gallery34: {
      state: 'unknown',
      observedAt: source.metadata.observedAt,
      references: ['fixture-ui-observation'],
    },
    extendedDescription: {
      state: 'unknown',
      observedAt: source.metadata.observedAt,
      references: ['fixture-api-doc-whitelist'],
    },
  };
  (source as any).capabilityProbe = {
    ...sources[1],
    authorizationReference: 'fixture-user-instruction',
    capabilities: ['gallery34', 'extendedDescription'],
  };
  await expect(runner.prepare(source)).rejects.toThrow('CAPABILITY');
  expect(mutationCalls()).toHaveLength(0);
});
it('uses actual verified feature evidence for a second source without granting another probe', async () => {
  const first = await ready();
  expect((await runner.run(first)).state).toBe('verified');
  const second = structuredClone(cases[1]!);
  const observedAt = new Date().toISOString();
  second.metadata.observedAt = observedAt;
  second.capabilityEvidence = await runner.capabilityEvidenceFromVerified(first, 1, observedAt, [
    'fixture-first-create-proof',
  ]);
  delete second.capabilityProbe;
  // The current runner is still authorized to probe source 0 only.
  const prepared = await runner.prepare(second);
  if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
  expect((await runner.run(prepared.operationId)).state).toBe('verified');
  const source = (await runner.journal.get(first)).operation.source_payload;
  expect(source.capabilityEvidence.gallery34.state).toBe('unknown');
  expect(source.context.capabilities.gallery34).toBe(false);
});
it('uses an explicitly nominated legacy capability only for reads while a new manifest source completes creation and publication', async () => {
  const first = await ready();
  expect((await runner.run(first)).state).toBe('verified');
  const old = await runner.journal.get(first);
  const second = structuredClone(cases[1]!);
  const batchAuthorization = { batchId: randomUUID(), manifestSha256: 'a'.repeat(64),
    authorizationReference: 'Fixture new manifest approved independently', sources: [{
      sourceIdentity: second.sourceIdentity, sourceRevision: second.sourceRevision,
      documentSha256: createHash('sha256').update(canonicalJson(second.document)).digest('hex'),
    }] };
  const options = { ...runner.options, allowedSources: [sources[1]!], batchAuthorization, capabilityProbe: undefined,
    capabilityProofOperationIds: [first] };
  runner = new ProductionPilotRunner(repo, options);
  const observedAt = new Date().toISOString(); second.metadata.observedAt = observedAt;
  second.capabilityEvidence = await runner.capabilityEvidenceFromVerified(first, 1, observedAt, ['old verified fixture']);
  delete second.capabilityProbe;
  const beforeSource = canonicalJson(second);
  const prepared = await runner.prepare(second);
  if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
  expect(canonicalJson(second)).toBe(beforeSource);
  expect((await runner.journal.get(prepared.operationId)).operation.source_payload.batchAuthorization).toEqual(batchAuthorization);
  await expect(runner.run(first)).rejects.toThrow('SOURCE_FORBIDDEN');
  await expect(runner.publish(first, publishMetadata())).rejects.toThrow('SOURCE_FORBIDDEN');
  expect((await runner.run(prepared.operationId)).state).toBe('verified');
  expect((await runner.publish(prepared.operationId, publishMetadata(1))).state).toBe('published');
  const oldAgain = (await pool.query('SELECT * FROM production_pilot_operations WHERE id=$1', [first])).rows[0];
  expect(oldAgain).toEqual(old.operation);
  const foreign = new ProductionPilotRunner(repo, { ...options, capabilityProofOperationIds: [] });
  await expect(foreign.capabilityEvidenceFromVerified(first, 1, observedAt, ['not nominated']))
    .rejects.toThrow('SOURCE_FORBIDDEN');
  const changed = new ProductionPilotRunner(repo, { ...options,
    batchAuthorization: { ...batchAuthorization, manifestSha256: 'b'.repeat(64) } });
  await expect(changed.publications.getForCreate(prepared.operationId)).rejects.toThrow('BATCH_AUTHORIZATION_CHANGED');
});
it.each(['missing variation receipt', 'altered verification readback'])(
  'rejects nominated capability evidence with %s without granting mutation access', async fault => {
    const first = await ready(1);
    expect((await runner.run(first)).state).toBe('verified');
    const readsOnly = new ProductionPilotRunner(repo, { ...runner.options, allowedSources: [sources[2]!],
      capabilityProofOperationIds: [first], capabilityProbe: undefined });
    const callsBefore = mutationCalls().length;
    const originalQuery = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
    const spy = vi.spyOn(pool, 'query').mockImplementation((async (...args: any[]) => {
      const result = await originalQuery(...args);
      if (fault === 'missing variation receipt' && String(args[0]).startsWith('SELECT * FROM production_pilot_steps'))
        return { ...result, rows: result.rows.filter((row: any) => row.kind !== 'variations') };
      if (fault === 'altered verification readback' && String(args[0]).startsWith('SELECT * FROM production_pilot_verifications')) {
        const altered = { ...result, rows: structuredClone(result.rows) };
        altered.rows[0].readbacks[0].raw.tampered = true;
        return altered;
      }
      return result;
    }) as any);
    try {
      await expect(readsOnly.capabilityEvidenceFromVerified(first, 1, new Date().toISOString(), ['fixture']))
        .rejects.toThrow('CAPABILITY_PROOF_UNVERIFIED');
      expect(mutationCalls()).toHaveLength(callsBefore);
    } finally { spy.mockRestore(); }
  },
);
it('blocks a known unsupported feature even with a matching probe authorization', async () => {
  const source = structuredClone(cases[0]!);
  source.capabilityEvidence.extendedDescription.state = 'unsupported';
  await expect(runner.prepare(source)).rejects.toThrow('CAPABILITY_UNSUPPORTED');
  expect(mutationCalls()).toHaveLength(0);
});
it('retains a known description denial while proving only gallery access from a verified plaintext source', async () => {
  const source = structuredClone(cases[0]!);
  source.document.description = source.document.description.filter(
    (block) => block.type === 'text',
  );
  source.capabilityEvidence.extendedDescription = {
    state: 'unsupported',
    observedAt: source.metadata.observedAt,
    references: ['fixture-definitive-description-rejection'],
  };
  source.capabilityProbe!.capabilities = ['gallery34'];
  const prepared = await prepareSource(source);
  if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
  expect((await runner.run(prepared.operationId)).state).toBe('verified');
  const proof = await runner.capabilityEvidenceFromVerified(
    prepared.operationId,
    1,
    new Date().toISOString(),
    ['fixture-gallery-proof'],
  );
  expect(proof.gallery34.state).toBe('supported');
  expect(proof.gallery34.verifiedOperationId).toBe(prepared.operationId);
  expect(proof.extendedDescription).toEqual(source.capabilityEvidence.extendedDescription);
});
async function createWithReencodedCover(fault?: string) {
  const id = await ready(1),
    outputId = 'verified-reencoded-cover',
    url = 'https://cf.shopee.vn/file/' + outputId;
  responseTransform = (path, body) => {
    if (path.endsWith('/get_item_base_info') && body.response?.item_list?.[0]) {
      const promotion = body.response.item_list[0].promotion_image;
      promotion.image_id_list = [outputId];
      promotion.image_url_list = [url];
      delete promotion.image_ratio;
    }
  };
  const first = await runner.run(id);
  expect(first.state).toBe('unresolved');
  expect(
    first.mismatchedPaths?.some((path) => path.startsWith('item.promotion_image.image_id_list')),
  ).toBe(true);
  const created = await runner.journal.get(id),
    itemId = created.operation.item_id;
  const source = await readFile(cases[1]!.assets[cases[1]!.document.cover.importId]!);
  const manual = fault === 'manual accept' || fault === 'manual reject';
  const output = manual
    ? await sharp(source).modulate({ brightness: 1.02 }).jpeg({ quality: 85 }).toBuffer()
    : await sharp(source).png({ compressionLevel: 0 }).toBuffer();
  const service = new ImageQcService(repo, new BlobStore(join(directory, 'image-cases')));
  const binding = {
    ...credentials,
    environment: 'production' as const,
    itemId,
    operationId: id,
    role: 'cover' as const,
    position: 0,
    sourceAssetId: cases[1]!.document.cover.importId,
    outputImageId: outputId,
  };
  delete (binding as any).partnerKey;
  delete (binding as any).accessToken;
  const caseId = randomUUID();
  const entry = await service.prepare({
    id: caseId,
    binding: { ...binding, ...(fault === 'wrong binding' ? { operationId: randomUUID() } : {}) },
    source: fault === 'wrong source' ? output : source,
    output,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (manual) {
    expect(entry.state).toBe('review_required');
    await service.review({
      id: caseId,
      requestId: randomUUID(),
      expectedFingerprint: entry.fingerprint,
      binding,
      decision: fault === 'manual accept' ? 'accept_lossy_match' : 'reject',
      reviewer: 'Synthetic fixture reviewer',
      note: 'Test-only inspection attestation; no real image or product involved.',
    });
  } else {
    expect(entry.state).toBe('verified');
    expect(entry.result.verificationBasis).toBe(
      fault === 'wrong source' ? 'exact_bytes' : 'exact_pixels',
    );
  }
  let fetched = 0;
  const fetchImage: typeof fetch = async (input) => {
    expect(String(input)).toBe(url);
    fetched++;
    return new Response(Uint8Array.from(fault === 'changed bytes' ? source : output), {
      status: 200,
      headers: { 'Content-Type': manual ? 'image/jpeg' : 'image/png' },
    });
  };
  runner = new ProductionPilotRunner(repo, {
    ...runner.options,
    coverImageQc: {
      service,
      findCase: async (input) => {
        expect(input.sourceSha256).toBe(cases[1]!.document.cover.sha256);
        expect(input.sourceFingerprint).toBe(created.operation.source_fingerprint);
        return fault === 'missing case' ? null : { caseId };
      },
      fetch: fetchImage,
    },
  });
  return { id, caseId, outputId, created, fetched: () => fetched, service, output, source };
}
it('reconciles a reencoded square cover through an immutable pixel proof and rechecks bytes before and after publication', async () => {
  const setup = await createWithReencodedCover(),
    writes = mutationCalls().length;
  const result = await runner.run(setup.id);
  expect(result.state, JSON.stringify(result)).toBe('verified');
  expect(mutationCalls()).toHaveLength(writes);
  const verified = await runner.journal.get(setup.id);
  for (const read of verified.verification.readbacks) {
    expect(read.raw.base.response.item_list[0].promotion_image.image_id_list).toEqual([
      setup.outputId,
    ]);
    expect(read.raw.base.response.item_list[0].promotion_image).not.toHaveProperty('image_ratio');
    expect(read.raw.coverImageQc).toMatchObject({
      caseId: setup.caseId,
      basis: 'exact_pixels',
      width: 90,
      height: 90,
      sourceSha256: cases[1]!.document.cover.sha256,
      sourceFingerprint: setup.created.operation.source_fingerprint,
    });
    expect(read.projection.cover).toBe('cover:' + cases[1]!.document.cover.sha256);
  }
  expect(setup.fetched()).toBe(2);
  const published = await runner.publish(setup.id, publishMetadata(1));
  expect(published.state, JSON.stringify(published)).toBe('published');
  expect(setup.fetched()).toBe(6);
  expect((await runner.journal.get(setup.id)).operation).toEqual(verified.operation);
  expect(mutationCalls()).toHaveLength(writes + 1);
});
it('captures a pending production cover case from actual output bytes and resumes after an explicit image review', async () => {
  const setup = await createWithReencodedCover('wrong binding');
  // This source now has a real lossy transformation: capture must not auto-approve it.
  const lossy = await sharp(setup.source).modulate({ brightness: 1.02 }).jpeg({ quality: 85 }).toBuffer();
  const qc = productionPilotImageService(repo, new BlobStore(join(directory, 'captured-image-cases')), directory);
  const fetchImage: typeof fetch = async () => new Response(Uint8Array.from(lossy), { headers: { 'Content-Type': 'image/jpeg' } });
  runner = new ProductionPilotRunner(repo, { ...runner.options, coverImageQc: { ...qc, fetch: fetchImage } });
  const writes = mutationCalls().length;
  const unresolved = await runner.run(setup.id);
  expect(unresolved.code).toBe('PRODUCTION_PILOT_COVER_CASE_UNVERIFIED');
  const casesForItem = (await qc.service.list()).filter((c) => c.binding.operationId === setup.id);
  expect(casesForItem).toHaveLength(1);
  const captured = casesForItem[0]!;
  expect(captured.state).toBe('review_required');
  expect(captured.review).toBeUndefined();
  expect((await runner.run(setup.id)).state).toBe('unresolved');
  expect((await qc.service.list()).filter((c) => c.binding.operationId === setup.id)).toHaveLength(1);
  await qc.service.review({ id: captured.id, requestId: randomUUID(), expectedFingerprint: captured.fingerprint,
    binding: captured.binding, decision: 'accept_lossy_match', reviewer: 'Synthetic fixture reviewer',
    note: 'Test-only reviewed lossy output. No real product or image used.' });
  expect((await runner.run(setup.id)).state).toBe('verified');
  expect(mutationCalls()).toHaveLength(writes);
});
it('server cover lookup rejects another source fingerprint or product binding', async () => {
  const setup = await createWithReencodedCover();
  const qc = productionPilotImageService(repo, new BlobStore(join(directory, 'server-image-cases')), directory);
  const binding = (await setup.service.get(setup.caseId)).binding;
  const input = { binding, sourceSha256: cases[1]!.document.cover.sha256, sourceFingerprint: setup.created.operation.source_fingerprint };
  expect(await qc.findCase(input)).toEqual({ caseId: setup.caseId });
  await expect(qc.findCase({ ...input, sourceFingerprint: 'f'.repeat(64) })).rejects.toThrow('SOURCE_CHANGED');
  await expect(qc.findCase({ ...input, binding: { ...binding, itemId: '999999' } })).rejects.toThrow('SOURCE_CHANGED');
  await expect(qc.findCase({ ...input, binding: { ...binding, shopId: '99' } })).rejects.toThrow('SCOPE_INVALID');
});
it('reconciles only explicitly accepted model weights and preserves original raw through publication', async () => {
  const source = structuredClone(cases[1]!);
  source.document.weightGrams = 322.3;
  source.document.models[0]!.weightGrams = 322.3;
  source.document.models[1]!.weightGrams = 130.9;
  const prepared = await prepareSource(source);
  if (prepared.kind !== 'ready') throw Error(JSON.stringify(prepared));
  responseTransform = (path, body) => {
    if (path.endsWith('/get_item_base_info')) body.response.item_list[0].weight = '0.322';
    if (path.endsWith('/get_model_list')) for (const model of body.response.model)
      model.weight = model.model_sku === source.document.models[0]!.sku ? '0.322' : '0.131';
  };
  const first = await runner.run(prepared.operationId);
  expect(first.state).toBe('unresolved');
  expect(first.mismatchedPaths?.some((p) => p.includes('weight'))).toBe(true);
  const raw = JSON.parse(await readFile(first.evidenceFiles![0]!, 'utf8'));
  const view = await runner.journal.get(prepared.operationId);
  const review = { version: 1, scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
    operationId: prepared.operationId, itemId: view.operation.item_id,
    sourceFingerprint: view.operation.source_fingerprint, sourceKey: source.document.sourceKey,
    authorizationReference: 'Explicit synthetic fixture acceptance only', authorizedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(), models: source.document.models.map((m, i) => ({
      sku: m.sku, modelId: String(raw.models.response.model.find((r: any) => r.model_sku === m.sku).model_id),
      tierIndex: m.tierIndex, sourceGrams: m.weightGrams, acceptedGrams: i === 0 ? 322 : 131,
    })) };
  runner = new ProductionPilotRunner(repo, { ...runner.options, weightReview: { findReview: async () => Buffer.from(JSON.stringify(review)) } });
  const writes = mutationCalls().length;
  expect((await runner.run(prepared.operationId)).state).toBe('verified');
  expect(mutationCalls()).toHaveLength(writes);
  const verified = await runner.journal.get(prepared.operationId);
  expect(verified.operation.source_payload).toEqual(view.operation.source_payload);
  expect(verified.operation.source_fingerprint).toBe(view.operation.source_fingerprint);
  for (const read of verified.verification.readbacks) {
    expect(read.raw.base.response.item_list[0].weight).toBe('0.322');
    expect(read.raw.weightReview.models.map((m: any) => m.acceptedGrams)).toEqual([322, 131]);
    expect(read.projection.models.map((m: any) => m.weightKg)).toEqual([0.3223, 0.1309]);
  }
  expect((await runner.publish(prepared.operationId, publishMetadata(1))).state).toBe('published');
  expect(mutationCalls().filter((c) => c.path.endsWith('/unlist_item'))).toHaveLength(1);
});
it.each(['missing case', 'wrong binding', 'changed bytes', 'wrong source', 'manual reject'])(
  'keeps the created listing unresolved with %s cover evidence',
  async (fault) => {
    const setup = await createWithReencodedCover(fault),
      writes = mutationCalls().length;
    expect((await runner.run(setup.id)).state).toBe('unresolved');
    expect(mutationCalls()).toHaveLength(writes);
    expect((await runner.journal.get(setup.id)).verification).toBeNull();
    expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
  },
);
it('uses an existing explicit review for a lossy cover while retaining the reviewer evidence reference', async () => {
  const setup = await createWithReencodedCover('manual accept');
  expect((await runner.run(setup.id)).state).toBe('verified');
  const proof = (await runner.journal.get(setup.id)).verification.readbacks[0].raw.coverImageQc;
  expect(proof).toMatchObject({ caseId: setup.caseId, basis: 'manual_review' });
  expect((await setup.service.get(proof.caseId)).review?.reviewer).toBe(
    'Synthetic fixture reviewer',
  );
});
it.each(['wrong ratio', 'null ratio', 'missing URL', 'wrong item title', 'expired proof'])(
  'keeps source QC strict with %s despite an image match',
  async (fault) => {
    const setup = await createWithReencodedCover(),
      writes = mutationCalls().length,
      previous = responseTransform!;
    responseTransform = (path, body) => {
      previous(path, body);
      if (!path.endsWith('/get_item_base_info') || !body.response?.item_list?.[0]) return;
      const item = body.response.item_list[0];
      if (fault === 'wrong ratio') item.promotion_image.image_ratio = '3:4';
      if (fault === 'null ratio') item.promotion_image.image_ratio = null;
      if (fault === 'missing URL') delete item.promotion_image.image_url_list;
      if (fault === 'wrong item title') item.item_name = 'Unexpected changed title';
    };
    if (fault === 'expired proof')
      runner = new ProductionPilotRunner(repo, {
        ...runner.options,
        coverImageQc: {
          ...runner.options.coverImageQc!,
          service: new ImageQcService(repo, setup.service.blobs, {
            now: () => new Date(Date.now() + 60 * 60 * 1000),
          }),
        },
      });
    expect((await runner.run(setup.id)).state).toBe('unresolved');
    expect(mutationCalls()).toHaveLength(writes);
    expect((await runner.journal.get(setup.id)).verification).toBeNull();
  },
);
it('blocks publication when cover bytes change after create verification even if the image ID stays identical', async () => {
  const setup = await createWithReencodedCover();
  expect((await runner.run(setup.id)).state).toBe('verified');
  const writes = mutationCalls().length;
  runner = new ProductionPilotRunner(repo, {
    ...runner.options,
    coverImageQc: {
      ...runner.options.coverImageQc!,
      fetch: async () =>
        new Response(Uint8Array.from(setup.source), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
    },
  });
  expect((await runner.publish(setup.id, publishMetadata(1))).state).toBe('unresolved');
  expect(mutationCalls()).toHaveLength(writes);
  expect(await runner.publications.getForCreate(setup.id)).toBeNull();
});
it.each(['unchanged', 'text', 'unit'])(
  'preserves custom attribute value 0 text and unit: %s',
  async (fault) => {
    const source = structuredClone(cases[0]!);
    const attributeId = Object.keys(source.document.attributes)[0]!;
    platform.shops[0]!.profile.categories[0]!.requiredAttribute.values.push({
      valueId: '0',
      name: '500',
    });
    source.document.attributes[attributeId] = ['0'];
    source.context.attributeList = [
      {
        attribute_id: Number(attributeId),
        attribute_value_list: [{ value_id: 0, original_value_name: '500', value_unit: 'ml' }],
      },
    ];
    const prepared = await prepareSource(source);
    if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
    responseTransform = (path, body) => {
      if (path.endsWith('/get_item_base_info') && body.response?.item_list?.[0]) {
        const value = body.response.item_list[0].attribute_list[0].attribute_value_list[0];
        if (fault === 'text') value.original_value_name = '50';
        if (fault === 'unit') value.value_unit = 'l';
      }
    };
    const result = await runner.run(prepared.operationId);
    expect(result.state, JSON.stringify(result)).toBe(
      fault === 'unchanged' ? 'verified' : 'unresolved',
    );
    if (fault === 'unchanged') {
      const proof = (await runner.journal.get(prepared.operationId)).verification.readbacks[0]
        .projection;
      expect(proof.attributeValues[0].attribute_value_list[0]).toEqual({
        value_id: 0,
        original_value_name: '500',
        value_unit: 'ml',
      });
    } else
      expect(result.mismatchedPaths?.join(' ')).toContain(
        fault === 'text' ? 'original_value_name' : 'value_unit',
      );
  },
);
it('parks fully acknowledged creation for QC without approving it or blocking another source', async () => {
  const id = await ready();
  responseTransform = (path, body) => {
    if (path.endsWith('/get_item_base_info') && body.response?.item_list?.[0]) body.response.item_list[0].weight = '9';
  };
  const result = await runner.run(id);
  expect(result.state).toBe('unresolved');
  expect(await runner.journal.waitForQc(id)).toBe(true);
  expect((await runner.journal.get(id)).verification).toBeNull();
  expect((await runner.journal.get(id)).operation.state).toBe('acknowledged');
  expect((await pool.query('SELECT * FROM production_pilot_qc_wait_receipts')).rows).toHaveLength(1);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(0);
  const count=mutationCalls().length;
  const nextId=await ready(1);
  await pool.query('INSERT INTO production_pilot_lanes(owner_key,operation_id) VALUES($1,$2)',['production:2010476:1423724897',nextId]);
  expect(mutationCalls()).toHaveLength(count);
  expect(await runner.journal.waitForQc(id)).toBe(true);
  expect((await pool.query('SELECT * FROM production_pilot_lanes')).rows).toHaveLength(1);
});
