import { assertAcceptanceDatabase } from './acceptance-database.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { Repository } from '../../packages/persistence/src/index.js';
import type { PreparedMedia } from '../../packages/domain/src/index.js';
import { SecretBox } from '../../packages/shopee/src/secret-box.js';
import { ProductionPilotTransport } from '../../packages/shopee/src/production-pilot-transport.js';
import { ProductionPilotRunner, type ProductionPilotPreparedInput } from '../../apps/api/src/production-pilot-runner.js';
import { PreparedWirePlatform } from './prepared-wire-platform.js';
import { businessCategoryFixtures, businessShopFixtures } from './business-batch-fixtures.js';

/** Existing, already-connected synthetic shop. Every prerequisite receipt is produced by the
 * real runner; only the external platform is a fixture. This does not test login/new-shop setup. */
export async function createInternalConnectedShop(repo: Repository, root: string, encryptionKey: string, installationRoot = process.cwd()) {
  await assertAcceptanceDatabase(installationRoot);
  const credentials = { environment: 'production' as const, partnerId: '2010476', shopId: '1423724897',
    partnerKey: 'INTERNAL-BROWSER-SYNTHETIC-KEY', accessToken: 'INTERNAL-BROWSER-SYNTHETIC-TOKEN' };
  const scope = { partnerId: credentials.partnerId, shopId: credentials.shopId };
  const profile = { ...structuredClone(businessShopFixtures[0]!), shopId: credentials.shopId, ownerId: credentials.partnerId };
  const category = businessCategoryFixtures[0]!, connectionId = randomUUID(), box = new SecretBox(encryptionKey);
  await repo.pool.query(`INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at,partner_key_ciphertext,token_ciphertext)
    VALUES($1,'production',$2,$3,$4,'connected',now()+interval '1 hour',$5,$6)`,
  [connectionId, scope.partnerId, scope.shopId, profile.name,
    box.seal({ partnerKey: credentials.partnerKey }, 'production:2010476:1423724897'),
    box.seal({ accessToken: credentials.accessToken }, 'production:2010476:1423724897')]);
  const platform = new PreparedWirePlatform({ shops: [{ profile,
    credentials: { ...credentials, environment: 'sandbox' }, allowPortrait: true, allowExtendedDescription: true, gtinRule: 'Optional' }] });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://partner.shopeemobile.com') throw Error('FIXTURE_EXTERNAL_ORIGIN_REJECTED');
    if (url.pathname === '/api/v2/shop/get_warehouse_detail') return new Response(JSON.stringify({
      error: 'warehouse.error_not_in_whitelist', message: 'Synthetic single-warehouse shop', request_id: randomUUID(),
    }), { headers: { 'content-type': 'application/json' } });
    url.hostname = 'openplatform.sandbox.test-stable.shopee.sg';
    const response = await platform.fetch(url, init), body = await response.json();
    if (url.pathname.endsWith('/get_channel_list')) for (const channel of body.response?.logistics_channel_list ?? [])
      channel.channel_relation_rules = [];
    // This independent platform models a single warehouse that is omitted in writes and
    // reported as VNZ on reads. The application must prove this mapping from verified history.
    const rows = url.pathname.endsWith('/get_model_list') ? body.response?.model
      : url.pathname.endsWith('/get_item_base_info') ? body.response?.item_list : [];
    for (const row of rows ?? []) for (const stock of row.stock_info_v2?.seller_stock ?? [])
      stock.location_id ??= 'VNZ';
    return new Response(JSON.stringify(body), { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  const client = new ProductionPilotTransport(credentials, { transport });
  const read = async (path: string, query: Record<string, string> = {}) => {
    const result = await client.read('/api/v2/' + path, query);
    if (result.kind !== 'success') throw Error('FIXTURE_READ_FAILED:' + path + ':' + result.code);
    return result as typeof result & { response: Record<string, any> };
  };
  const assets: Record<string, string> = {};
  await mkdir(resolve(root, 'existing-shop-assets'), { recursive: true });
  const media = async (name: string, height: number): Promise<PreparedMedia> => {
    const bytes = await sharp({ create: { width: 900, height, channels: 3, background: '#37685a' } }).png().toBuffer();
    const path = resolve(root, 'existing-shop-assets', name + '.png'), importId = randomUUID();
    await writeFile(path, bytes); assets[importId] = path;
    return { importId, sha256: createHash('sha256').update(bytes).digest('hex'), width: 900, height, mime: 'image/png' };
  };
  const cover = await media('cover', 900), gallery = await media('gallery', 1200), operationIds: string[] = [];
  let priorObservation: { requestId: string; path: '/api/v2/product/get_model_list'; response: Record<string, any> } | undefined;
  let referenceItemId = '';
  for (const stage of ['existing-reference', 'verified-warehouse-mapping']) {
    const sourceIdentity = 'internal-browser-' + stage, sourceRevision = 1;
    const limits = await read('product/get_item_limit', { category_id: category.categoryId });
    const brands = await read('product/get_brand_list', { category_id: category.categoryId, offset: '0', page_size: '100', status: '1' });
    const attributes = await read('product/get_attribute_tree', { category_id_list: category.categoryId });
    const channels = await read('logistics/get_channel_list');
    const now = new Date().toISOString(), attr = category.requiredAttribute, value = attr.values[0]!;
    const sku = sourceIdentity + '-SKU', source = { sourceIdentity, sourceRevision };
    const input: ProductionPilotPreparedInput = { ...source, connectionId, connectionRevision: 1, assets, issues: [],
      metadata: { environment: 'production', ...scope, connectionRevision: 1, categoryId: category.categoryId,
        observedAt: now, expiresAt: new Date(Date.now() + 600000).toISOString(),
        requestIds: [limits.requestId, brands.requestId, attributes.requestId, channels.requestId, ...(priorObservation ? [priorObservation.requestId] : [])] },
      capabilityEvidence: { environment: 'production', ...scope, connectionRevision: 1,
        gallery34: { state: 'unknown', observedAt: now, references: ['Explicit synthetic prior-shop fixture'] },
        extendedDescription: { state: 'unknown', observedAt: now, references: ['Explicit synthetic prior-shop fixture'] } },
      capabilityProbe: { ...source, authorizationReference: 'Synthetic prior-shop fixture, no network', capabilities: ['gallery34', 'extendedDescription'] },
      ...(priorObservation ? { stockLocationEvidence: { environment: 'production', ...scope, connectionRevision: 1,
        observedAt: now, observations: [priorObservation], expectedLocationBySku: { [sku]: 'VNZ' } } } : {}),
      document: { sourceKey: sourceIdentity, title: 'QA Kho tham khảo ' + stage,
        description: [{ type: 'text', text: 'Synthetic existing shop reference' }, { type: 'image', image: gallery }],
        cover, gallery: [gallery], tierNames: ['Quy cách'],
        models: [{ sku, originalPrice: '20000', stock: 100, tierIndex: [0], optionLabels: ['Mẫu QA'], image: cover }],
        categoryId: category.categoryId, brandId: category.brandId, attributes: { [attr.attributeId]: [value.valueId] },
        logistics: [{ channelId: profile.logisticsChannelId, enabled: true }], weightGrams: 180,
        dimensionCm: { length: 12, width: 8, height: 3 }, publication: 'unlisted' },
      context: { images: [], brandName: category.brandName, condition: 'NEW', preOrder: { is_pre_order: false },
        stockLocationBySku: { [sku]: priorObservation ? null : 'VNZ' }, limits: limits.response,
        capabilities: { gallery34: false, extendedDescription: false },
        attributeList: [{ attribute_id: Number(attr.attributeId), attribute_value_list: [{ value_id: Number(value.valueId), original_value_name: value.name }] }],
        channelInfoById: Object.fromEntries(channels.response.logistics_channel_list.map((channel: any) => [String(channel.logistics_channel_id), channel])) } };
    const runner = new ProductionPilotRunner(repo, { allowedSources: [source], assetRoot: root,
      evidenceRoot: resolve(root, 'existing-shop-evidence'), encryptionKey, transport, readbackDelaysMs: [1, 2],
      capabilityProbe: { ...source, authorizationReference: 'Synthetic prior-shop fixture, no network' },
      pause: async ms => { platform.advance(ms); } });
    const prepared = await runner.prepare(input);
    if (prepared.kind !== 'ready') throw Error('FIXTURE_PREPARE_FAILED:' + JSON.stringify(prepared));
    const result = await runner.run(prepared.operationId);
    if (result.state !== 'verified') throw Error('FIXTURE_RUN_FAILED:' + JSON.stringify(result));
    operationIds.push(prepared.operationId);
    referenceItemId = (await runner.journal.get(prepared.operationId)).operation.item_id!;
    const observed = await read('product/get_model_list', { item_id: referenceItemId });
    priorObservation = { requestId: observed.requestId, path: '/api/v2/product/get_model_list', response: observed.response };
  }
  const baselineCalls = platform.calls.length;
  return { platform, transport, scope, profile, category, referenceItemId, operationIds, baselineCalls };
}
