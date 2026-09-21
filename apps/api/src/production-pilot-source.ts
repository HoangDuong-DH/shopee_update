import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Repository } from '@shopee/persistence';
import { SecretBox } from '@shopee/gateway';
import { ProductionPilotTransport } from '../../../packages/shopee/src/production-pilot-transport.js';
import type { ProductionPilotPreparedInput } from './production-pilot-runner.js';
import { readProductionPilotWithBackoff } from './production-pilot-read-scheduler.js';
import { canonicalJson } from '@shopee/domain';
import { z } from 'zod';
import { preparedWireMediaRequirements } from '../../../packages/shopee/src/prepared-wire.js';
import {
  ProductionPilotReadSession,
  type ProductionPilotReadEvidence,
} from './production-pilot-read-session.js';
import { validateAttributeSelection } from '../../../packages/shopee/src/attribute-validation.js';

export const productionPilotSourceRoot = resolve('.local/production-pilot-1423724897');
export const productionPilotSources = ['row-2', 'row-65'] as const;
export const productionPilotScope = {
  environment: 'production',
  partnerId: '2010476',
  shopId: '1423724897',
} as const;
export const pilotProbeAuthorization =
  'User 2026-09-15: đã kết nối được rồi, giờ đăng thử hàng loạt đi; ok làm đi rồi nối luồng rồi chủ động thực thi việc đăng hàng loạt sản phẩm thực tế đi';
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
function fail(code: string): never {
  throw Error('PRODUCTION_PILOT_' + code);
}
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): string => {
  if (!/^[1-9]\d*$/.test(String(v)) || !Number.isSafeInteger(Number(v)))
    return fail('RESPONSE_ID_INVALID');
  return String(v);
};
export function decodeProductionPilotInventoryPage(
  pageData: Record<string, any>,
  status: string,
  offset: number,
) {
  if (
    !Number.isSafeInteger(pageData.total_count) ||
    pageData.total_count < 0 ||
    typeof pageData.has_next_page !== 'boolean'
  )
    fail('INVENTORY_RESPONSE_INVALID');
  const items =
    pageData.item === undefined && pageData.total_count === 0 && pageData.has_next_page === false
      ? []
      : pageData.item;
  if (
    !Array.isArray(items) ||
    items.length > pageData.total_count ||
    (pageData.total_count === 0 && items.length)
  )
    fail('INVENTORY_RESPONSE_INVALID');
  const ids = items.map((item: any) => {
    if (!object(item) || item.item_status !== status) return fail('INVENTORY_STATUS_CHANGED');
    return id(item.item_id);
  });
  if (new Set(ids).size !== ids.length) fail('INVENTORY_RESPONSE_INVALID');
  if (!pageData.has_next_page && offset + ids.length !== pageData.total_count)
    fail('INVENTORY_INCOMPLETE');
  if (
    pageData.has_next_page &&
    (!Number.isSafeInteger(pageData.next_offset) ||
      pageData.next_offset <= offset ||
      ids.length === 0)
  )
    fail('INVENTORY_CURSOR_INVALID');
  return {
    ids,
    complete: !pageData.has_next_page,
    nextOffset: pageData.next_offset as number | undefined,
  };
}
export async function loadProductionPilotSource() {
  let bytes: Buffer;
  try {
    bytes = await readFile(resolve(productionPilotSourceRoot, 'source-authorized-v4.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      bytes = await readFile(resolve(productionPilotSourceRoot, 'source-authorized-v3.json'));
    } catch (previousError) {
      if ((previousError as NodeJS.ErrnoException).code !== 'ENOENT') throw previousError;
      bytes = await readFile(resolve(productionPilotSourceRoot, 'source-authorized-v2.json'));
    }
  }
  const value = JSON.parse(bytes.toString('utf8'));
  if (
    value.scope?.shopId !== productionPilotScope.shopId ||
    value.scope?.partnerId !== productionPilotScope.partnerId ||
    value.scope?.environment !== 'production' ||
    value.listingCount !== 2 ||
    value.modelCount !== 15 ||
    JSON.stringify(value.listings.map((s: any) => s.sourceKey)) !==
      JSON.stringify(productionPilotSources) ||
    value.listings.some(
      (s: any) =>
        ![2, 3, 4].includes(s.sourceRevision) ||
        s.sourceIdentity !== `fd983d71-dbe4-4980-a3d6-d2f90d9f117c:${s.sourceKey}` ||
        s.document.models.some((m: any) => m.stock !== 100),
    )
  )
    fail('SOURCE_RECEIPT_INVALID');
  // Verify both original business files again. No stale source version silently enters a live request.
  for (const [path, expected] of [
    [
      'C:/Users/Admin/Downloads/Copy of SHOP VINA TƯƠI(AutoRecovered).xlsx',
      value.sourceHashes.workbook,
    ],
    ['C:/Users/Admin/Desktop/FILE GIÁ DORIS.xlsx', value.sourceHashes.priceWorkbook],
  ])
    if (hash(await readFile(path)) !== expected) fail('WORKBOOK_CHANGED');
  return { value, sha256: hash(bytes) };
}

type ReadSourceMetadata = (
  path: string,
  query: Record<string, string>,
  label: string,
) => Promise<Record<string, any>>;
/** get_brand_list: offset starts at zero, then uses the response next_offset (KB 2026-09-08,
 * v2.product.get_brand_list). A cursor observed for another category is never transferable. */
export async function findProductionSourceBrand(
  get: ReadSourceMetadata,
  categoryId: string,
  brandId: string,
  brandName: string,
) {
  // get_brand_list includes the actual NoBrand entry with brand_id=0; item IDs remain positive-only.
  const brandIdentifier = (value: unknown) => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      return String(value);
    if (
      typeof value === 'string' &&
      /^(0|[1-9]\d*)$/.test(value) &&
      Number.isSafeInteger(Number(value))
    )
      return value;
    return fail('BRAND_RESPONSE_INVALID');
  };
  let offset = 0;
  const seen = new Set<number>();
  for (let page = 0; page < 200; page++) {
    if (seen.has(offset)) fail('BRAND_CURSOR_INVALID');
    seen.add(offset);
    const response = await get(
      '/api/v2/product/get_brand_list',
      {
        category_id: categoryId,
        status: '1',
        offset: String(offset),
        page_size: '100',
        language: 'vi',
      },
      'brands-' + page,
    );
    if (
      !Array.isArray(response.brand_list) ||
      response.brand_list.length > 100 ||
      typeof response.has_next_page !== 'boolean' ||
      response.brand_list.some(
        (brand: any) => !object(brand) || typeof brand.original_brand_name !== 'string',
      ) ||
      new Set(response.brand_list.map((brand: any) => brandIdentifier(brand.brand_id))).size !==
        response.brand_list.length
    )
      fail('BRAND_RESPONSE_INVALID');
    const matching = response.brand_list.filter(
      (brand: any) => brandIdentifier(brand.brand_id) === brandId,
    );
    if (matching.length === 1) {
      if (matching[0].original_brand_name !== brandName) fail('BRAND_REVALIDATION_REQUIRED');
      return matching[0] as Record<string, any>;
    }
    if (!response.has_next_page) fail('BRAND_REVALIDATION_REQUIRED');
    if (
      !Number.isSafeInteger(response.next_offset) ||
      response.next_offset <= offset ||
      !response.brand_list.length
    )
      fail('BRAND_CURSOR_INVALID');
    offset = response.next_offset;
  }
  return fail('BRAND_PAGINATION_LIMIT_REACHED');
}

export type ProductionPilotCollectOptions = {
  transport?: typeof fetch;
  encryptionKey?: string;
  priorCapabilityEvidence?: ProductionPilotPreparedInput['capabilityEvidence'];
  allowExistingListings?: boolean;
  purpose?: 'create' | 'existing_readback' | 'publish';
  descriptionFallbackPolicy?: 'plain_text_when_unsupported';
  readSession?: ProductionPilotReadSession;
  trustedExistingOperation?: {
    operationId: string;
    itemId: string;
    sourceIdentity: string;
    sourceRevision: number;
    sourceFingerprint: string;
  };
  /** A server-created source loader only. No HTTP route accepts this hook or arbitrary paths. */
  trustedSource?: {
    load: () => Promise<{
      value: { assets: Record<string, string>; listings: any[] };
      sha256: string;
    }>;
    sourceKeys: readonly string[];
    evidenceRoot: string;
    shopName: string;
  };
};

/** Fresh, bounded GET-only collector. There is no upload/write capability in this class. */
export async function collectProductionPilotInput(
  repo: Repository,
  sourceKey: string,
  options: ProductionPilotCollectOptions = {},
) {
  if (!(options.trustedSource?.sourceKeys ?? productionPilotSources).includes(sourceKey as any))
    fail('SOURCE_NOT_ALLOWED');
  const loaded = await (options.trustedSource?.load ?? loadProductionPilotSource)();
  options.readSession?.assertManifest(loaded.sha256);
  const matches = loaded.value.listings.filter((s: any) => s.sourceKey === sourceKey);
  if (matches.length !== 1) fail('SOURCE_NOT_ALLOWED');
  const source = matches[0],
    evidenceRoot = options.trustedSource?.evidenceRoot ?? productionPilotSourceRoot;
  const stockLocation = options.trustedSource
    ? source.stockLocation
    : {
        referenceItemId: '42476682098',
        expectedLocationBySku: Object.fromEntries(
          source.document.models.map((m: any) => [m.sku, 'VNZ']),
        ),
        writeLocationBySku: Object.fromEntries(
          source.document.models.map((m: any) => [m.sku, null]),
        ),
      };
  const rows = (
    await repo.pool.query(
      `SELECT * FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3`,
      ['production', productionPilotScope.partnerId, productionPilotScope.shopId],
    )
  ).rows;
  if (
    rows.length !== 1 ||
    rows[0].state !== 'connected' ||
    new Date(rows[0].expires_at).getTime() <= Date.now()
  )
    fail('AUTH_REQUIRED');
  const connection = rows[0],
    owner = `production:${productionPilotScope.partnerId}:${productionPilotScope.shopId}`;
  const purpose = options.purpose ?? 'create';
  if (!['create', 'existing_readback', 'publish'].includes(purpose))
    fail('COLLECTION_PURPOSE_INVALID');
  if (purpose !== 'create') {
    const proof = z
      .object({
        operationId: z.string().uuid(),
        itemId: z.string().regex(/^[1-9]\d*$/),
        sourceIdentity: z.string().min(1),
        sourceRevision: z.number().int().positive(),
        sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .safeParse(options.trustedExistingOperation);
    if (!options.trustedSource || !proof.success) fail('EXISTING_OPERATION_REQUIRED');
    const trusted = proof.data;
    const saved = (
      await repo.pool.query(
        `SELECT o.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('step_key',s.step_key,'state',s.state)) FROM production_pilot_steps s WHERE s.operation_id=o.id),'[]'::jsonb) AS evidence_steps FROM production_pilot_operations o WHERE o.id=$1`,
        [trusted.operationId],
      )
    ).rows;
    const op = saved[0],
      keys = [
        ...preparedWireMediaRequirements(source.document).map((_, index) => 'media-' + index),
        'create',
        ...(source.document.tierNames.length ? ['variations'] : []),
      ];
    if (
      saved.length !== 1 ||
      !op ||
      op.id !== trusted.operationId ||
      op.owner_key !== owner ||
      op.connection_id !== connection.id ||
      op.item_id !== trusted.itemId ||
      trusted.sourceIdentity !== source.sourceIdentity ||
      trusted.sourceRevision !== source.sourceRevision ||
      op.source_identity !== trusted.sourceIdentity ||
      op.source_revision !== trusted.sourceRevision ||
      op.source_fingerprint !== trusted.sourceFingerprint ||
      !['acknowledged', 'verified'].includes(op.state) ||
      (purpose === 'publish' && op.state !== 'verified') ||
      !object(op.source_payload) ||
      op.source_payload.sourceIdentity !== source.sourceIdentity ||
      op.source_payload.sourceRevision !== source.sourceRevision ||
      op.source_payload.connectionId !== connection.id ||
      canonicalJson(op.source_payload.document) !== canonicalJson(source.document) ||
      op.source_payload.batchAuthorization?.manifestSha256 !== loaded.sha256 ||
      op.source_fingerprint !==
        hash(
          canonicalJson({
            scope: productionPilotScope,
            sourceIdentity: source.sourceIdentity,
            sourceRevision: source.sourceRevision,
            sourcePayload: op.source_payload,
            expectedProjection: op.expected_projection,
          }),
        ) ||
      !Array.isArray(op.evidence_steps) ||
      op.evidence_steps.length !== keys.length ||
      !keys.every(
        (key) =>
          op.evidence_steps.filter(
            (step: any) => step.step_key === key && step.state === 'acknowledged',
          ).length === 1,
      )
    )
      fail('EXISTING_OPERATION_UNVERIFIED');
  }
  const explicitSourceWaiver = Boolean(
    options.trustedSource &&
    source.existingListingAuthorization?.reason === 'distinct_prepared_listing_test' &&
    typeof source.existingListingAuthorization.authorizationReference === 'string' &&
    source.existingListingAuthorization.authorizationReference.trim(),
  );
  const scanInventory = purpose === 'create' && !explicitSourceWaiver;
  if (
    options.trustedSource &&
    (!options.priorCapabilityEvidence ||
      options.priorCapabilityEvidence.connectionRevision !== connection.revision)
  )
    fail('CAPABILITY_EVIDENCE_CHANGED');
  const box = new SecretBox(options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? '');
  const key = box.open(connection.partner_key_ciphertext, owner) as { partnerKey: string };
  const token = box.open(connection.token_ciphertext, owner) as { accessToken: string };
  const client = new ProductionPilotTransport(
    { ...productionPilotScope, partnerKey: key.partnerKey, accessToken: token.accessToken },
    { transport: options.transport },
  );
  const preflightId = randomUUID(),
    directory = resolve(evidenceRoot, 'preflight', preflightId);
  await mkdir(directory, { recursive: true });
  const evidence: {
    path: string;
    requestId: string;
    observedAt: string;
    response: Record<string, any>;
    file: string;
  }[] = [];
  async function get(
    path: string,
    query: Record<string, string>,
    label: string,
    allowedError?: string,
  ): Promise<Record<string, any>> {
    const load = async (): Promise<ProductionPilotReadEvidence> => {
      let observedAt = '',
        file = '';
      const result = await readProductionPilotWithBackoff(
        client,
        path,
        query,
        async (result, attempt) => {
          observedAt = new Date().toISOString();
          file = resolve(directory, label + (attempt ? '.attempt-' + attempt : '') + '.json');
          await writeFile(
            file,
            JSON.stringify(
              {
                scope: productionPilotScope,
                connectionId: connection.id,
                connectionRevision: connection.revision,
                method: 'GET',
                path,
                query,
                observedAt,
                attempt,
                result,
              },
              null,
              2,
            ),
            { flag: 'wx' },
          );
        },
      );
      return { result, observedAt, file };
    };
    const read = options.readSession
      ? await options.readSession.read(
          { ...productionPilotScope, connectionRevision: connection.revision },
          path,
          query,
          load,
        )
      : { ...(await load()), cacheHit: false };
    const { result, observedAt, file } = read;
    if (read.cacheHit)
      await writeFile(
        resolve(directory, label + '.cache.json'),
        JSON.stringify(
          {
            kind: 'reused_metadata_read',
            scope: productionPilotScope,
            connectionRevision: connection.revision,
            path,
            query,
            originalObservedAt: observedAt,
            originalEvidenceFile: file,
            requestId: result.requestId,
            reusedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    if (result.kind !== 'success') {
      if (allowedError && result.envelope?.error === allowedError && result.requestId) {
        evidence.push({
          path,
          requestId: result.requestId,
          observedAt,
          response: { confirmedError: allowedError },
          file,
        });
        return { confirmedError: allowedError };
      }
      fail('PREFLIGHT_READ_FAILED_' + label.toUpperCase().replace(/[^A-Z0-9]/g, '_'));
    }
    evidence.push({
      path,
      requestId: result.requestId,
      observedAt,
      response: result.response,
      file,
    });
    return result.response;
  }
  const shop = await get('/api/v2/shop/get_shop_info', {}, 'shop');
  if (
    shop.shop_name !== (options.trustedSource?.shopName ?? 'Vuatinhdau - Đại Lý Chính Hãng') ||
    shop.region !== 'VN' ||
    shop.status !== 'NORMAL'
  )
    fail('SHOP_IDENTITY_MISMATCH');
  const inventoryIds = new Set<string>();
  const existingMatches: { itemId: string; kind: string }[] = [];
  let stockObservation: (typeof evidence)[number] | undefined;
  if (scanInventory) {
    for (const status of ['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING']) {
      let offset = 0,
        complete = false;
      for (let page = 0; page < 10; page++) {
        const pageData = await get(
          '/api/v2/product/get_item_list',
          { offset: String(offset), page_size: '100', item_status: status },
          `inventory-${status}-${page}`,
        );
        const decoded = decodeProductionPilotInventoryPage(pageData, status, offset);
        for (const itemId of decoded.ids) inventoryIds.add(itemId);
        if (decoded.complete) {
          complete = true;
          break;
        }
        offset = decoded.nextOffset!;
      }
      if (!complete) fail('INVENTORY_LIMIT_REACHED');
    }
    if (inventoryIds.size > 200) fail('PILOT_INVENTORY_SCOPE_EXCEEDED');
    const candidateSkus = new Set(source.document.models.map((m: any) => m.sku));
    const allItems: Record<string, any>[] = [];
    const ids = [...inventoryIds];
    for (let index = 0; index < ids.length; index += 20) {
      const requested = ids.slice(index, index + 20);
      const base = await get(
        '/api/v2/product/get_item_base_info',
        { item_id_list: requested.join(',') },
        `base-${index}`,
      );
      if (
        !Array.isArray(base.item_list) ||
        base.item_list.length !== requested.length ||
        new Set(base.item_list.map((i: any) => id(i.item_id))).size !== requested.length ||
        base.item_list.some((i: any) => !requested.includes(id(i.item_id)))
      )
        fail('BASE_INVENTORY_INCOMPLETE');
      allItems.push(...base.item_list);
    }
    for (const item of allItems) {
      if (
        item.item_sku === source.sourceIdentity ||
        item.item_name === source.document.title ||
        candidateSkus.has(item.item_sku)
      ) {
        existingMatches.push({ itemId: id(item.item_id), kind: 'listing' });
        if (!options.allowExistingListings) fail('DUPLICATE_LISTING_OR_SKU');
      }
      const models = await get(
        '/api/v2/product/get_model_list',
        { item_id: id(item.item_id) },
        `models-${item.item_id}`,
      );
      if (!Array.isArray(models.model)) fail('MODELS_INVENTORY_INCOMPLETE');
      if (models.model.some((m: any) => candidateSkus.has(m.model_sku))) {
        existingMatches.push({ itemId: id(item.item_id), kind: 'modelSku' });
        if (!options.allowExistingListings) fail('DUPLICATE_LISTING_OR_SKU');
      }
      if (String(item.item_id) === stockLocation.referenceItemId)
        stockObservation = evidence[evidence.length - 1];
    }
  } else {
    const models = await get(
      '/api/v2/product/get_model_list',
      { item_id: id(stockLocation.referenceItemId) },
      'stock-reference-' + id(stockLocation.referenceItemId),
    );
    if (!Array.isArray(models.model)) fail('MODELS_INVENTORY_INCOMPLETE');
    stockObservation = evidence[evidence.length - 1];
  }
  if (!stockObservation) fail('STOCK_LOCATION_REFERENCE_MISSING');
  const category = await get('/api/v2/product/get_category', { language: 'vi' }, 'category');
  const leaves = category.category_list?.filter(
    (c: any) => String(c.category_id) === source.document.categoryId,
  );
  if (!Array.isArray(leaves) || leaves.length !== 1 || leaves[0].has_children !== false)
    fail('CATEGORY_UNVERIFIED');
  const limits = await get(
    '/api/v2/product/get_item_limit',
    { category_id: source.document.categoryId },
    'limits',
  );
  const attributes = await get(
    '/api/v2/product/get_attribute_tree',
    { category_id_list: source.document.categoryId, language: 'vn' },
    'attributes',
  );
  const matchingTrees = attributes.list?.filter(
    (c: any) => String(c.category_id) === source.document.categoryId,
  );
  if (
    !Array.isArray(matchingTrees) ||
    matchingTrees.length !== 1 ||
    !Array.isArray(matchingTrees[0].attribute_tree)
  )
    fail('ATTRIBUTE_TREE_UNVERIFIED');
  const tree = matchingTrees[0].attribute_tree;
  const attributeList = structuredClone(source.proposedAttributeList);
  const attributeValidation = validateAttributeSelection(tree, attributeList);
  if (!attributeValidation.valid) fail(attributeValidation.issues[0]!.code);
  // DATE writes use Unix seconds, but Shopee returns formatted dates. The current
  // exact-label readback comparator cannot verify that round trip; stop before writes.
  const selectedAttributes = new Map<number, { attribute_value_list: { value_id: number }[] }>();
  for (const entry of attributeList) selectedAttributes.set(entry.attribute_id, entry);
  const requireSupportedAttributeReadback = (nodes: any[]) => {
    for (const node of nodes) {
      const selected = selectedAttributes.get(node.attribute_id);
      if (!selected) continue;
      if (node.attribute_info.input_validation_type === 4)
        fail('ATTRIBUTE_DATE_READBACK_UNSUPPORTED');
      for (const value of selected.attribute_value_list) {
        const actual = node.attribute_value_list?.find(
          (entry: any) => entry.value_id === value.value_id,
        );
        if (actual?.child_attribute_list)
          requireSupportedAttributeReadback(actual.child_attribute_list);
      }
    }
  };
  requireSupportedAttributeReadback(tree);
  // Cursor is from this exact category's earlier successful page, never a guessed SKU/brand alias.
  const brands = options.trustedSource
    ? undefined
    : await get(
        '/api/v2/product/get_brand_list',
        {
          category_id: source.document.categoryId,
          status: '1',
          offset: '1243729',
          page_size: '100',
          language: 'vi',
        },
        'brands',
      );
  const brand = options.trustedSource
    ? await findProductionSourceBrand(
        get,
        source.document.categoryId,
        source.document.brandId,
        source.brandName,
      )
    : brands?.brand_list?.find(
        (b: any) =>
          String(b.brand_id) === source.document.brandId && b.original_brand_name === 'VINA TƯƠI',
      );
  if (!brand) fail('BRAND_REVALIDATION_REQUIRED');
  const channels = await get('/api/v2/logistics/get_channel_list', {}, 'channels');
  if (!Array.isArray(channels.logistics_channel_list)) fail('CHANNELS_UNVERIFIED');
  const warehouse = await get(
    '/api/v2/shop/get_warehouse_detail',
    { warehouse_type: '1' },
    'warehouses',
    'warehouse.error_not_in_whitelist',
  );
  if (warehouse.confirmedError !== 'warehouse.error_not_in_whitelist')
    fail('WAREHOUSE_MAPPING_REVIEW_REQUIRED');
  const evidenceTimes = evidence.map((entry) => Date.parse(entry.observedAt));
  // The aggregate must include its latest stock read. Its lifetime still starts at the
  // oldest receipt, including cached receipts whose original timestamp is preserved.
  const observedAt = new Date(Math.max(...evidenceTimes)).toISOString();
  const expiresAt = new Date(Math.min(...evidenceTimes) + 15 * 60 * 1000).toISOString();
  const refs = [resolve(evidenceRoot, 'seller-capability-observation.json')];
  if (options.trustedSource && !options.priorCapabilityEvidence)
    fail('CAPABILITY_EVIDENCE_REQUIRED');
  const capabilityEvidence = options.priorCapabilityEvidence ?? {
    ...productionPilotScope,
    connectionRevision: connection.revision,
    gallery34: { state: 'unknown' as const, observedAt, references: refs },
    extendedDescription: {
      state: source.sourceRevision >= 3 ? ('unsupported' as const) : ('unknown' as const),
      observedAt,
      references:
        source.sourceRevision >= 3
          ? [resolve(productionPilotSourceRoot, 'operation-85c09451.json')]
          : refs,
    },
  };
  const input: ProductionPilotPreparedInput = {
    sourceIdentity: source.sourceIdentity,
    sourceRevision: source.sourceRevision,
    connectionId: connection.id,
    connectionRevision: connection.revision,
    document: source.document,
    assets: loaded.value.assets,
    issues: [],
    metadata: {
      ...productionPilotScope,
      connectionRevision: connection.revision,
      categoryId: source.document.categoryId,
      observedAt,
      expiresAt,
      requestIds: evidence.map((e) => e.requestId),
    },
    capabilityEvidence,
    ...(options.descriptionFallbackPolicy
      ? { descriptionFallbackPolicy: options.descriptionFallbackPolicy }
      : {}),
    ...(source.supersedesOperationId
      ? { supersedesOperationId: source.supersedesOperationId }
      : {}),
    ...(!options.trustedSource && sourceKey === 'row-2'
      ? {
          capabilityProbe: {
            sourceIdentity: source.sourceIdentity,
            sourceRevision: source.sourceRevision,
            authorizationReference: pilotProbeAuthorization,
            capabilities: (source.sourceRevision >= 3
              ? ['gallery34']
              : ['gallery34', 'extendedDescription']) as ('gallery34' | 'extendedDescription')[],
          },
        }
      : {}),
    stockLocationEvidence: {
      ...productionPilotScope,
      connectionRevision: connection.revision,
      observedAt: stockObservation.observedAt,
      observations: [
        {
          requestId: stockObservation.requestId,
          path: '/api/v2/product/get_model_list',
          response: stockObservation.response,
        },
      ],
      expectedLocationBySku: structuredClone(stockLocation.expectedLocationBySku),
    },
    context: {
      images: [],
      brandName: brand.original_brand_name,
      condition: options.trustedSource ? source.condition : 'NEW',
      preOrder: options.trustedSource ? structuredClone(source.preOrder) : { is_pre_order: false },
      limits,
      attributeList,
      capabilities: {
        gallery34: capabilityEvidence.gallery34.state === 'supported',
        extendedDescription: capabilityEvidence.extendedDescription.state === 'supported',
      },
      stockLocationBySku: structuredClone(stockLocation.writeLocationBySku),
      channelInfoById: Object.fromEntries(
        channels.logistics_channel_list.map((c: any) => [String(c.logistics_channel_id), c]),
      ),
    },
  };
  const current = (
    await repo.pool.query('SELECT revision,state FROM connections WHERE id=$1', [connection.id])
  ).rows[0];
  if (current?.revision !== connection.revision || current.state !== 'connected')
    fail('CONNECTION_CHANGED');
  if (options.trustedSource && (await options.trustedSource.load()).sha256 !== loaded.sha256)
    fail('SOURCE_CHANGED');
  const output = {
    preflightId,
    sourceKey,
    sourceReceiptSha256: loaded.sha256,
    input,
    evidenceFiles: evidence.map((e) => e.file),
    inventoryCount: scanInventory ? inventoryIds.size : null,
    inventoryScanned: scanInventory,
    duplicateMatches: scanInventory ? existingMatches.length : null,
    existingMatches,
    duplicatePolicy: !scanInventory
      ? purpose === 'create'
        ? 'explicit_source_waiver_not_scanned'
        : 'verified_existing_operation_not_scanned'
      : options.allowExistingListings
        ? 'Existing matches observed; in-flight request replay remains prohibited'
        : 'block_existing_matches',
    purpose,
    mutations: 0,
  };
  await writeFile(resolve(directory, 'input.json'), JSON.stringify(output, null, 2), {
    flag: 'wx',
  });
  return output;
}
