import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Repository } from '@shopee/persistence';
import { SecretBox } from '@shopee/gateway';
import { canonicalJson } from '@shopee/domain';
import { z } from 'zod';
import {
  ProductionPilotTransport,
  productionPilotWriteFingerprint,
} from '../../../packages/shopee/src/production-pilot-transport.js';
import { preparedWireMediaRequirements } from '../../../packages/shopee/src/prepared-wire.js';
import { checkVerification } from './production-batch-runner.js';
import {
  productionPilotScope,
  decodeProductionPilotInventoryPage,
} from './production-pilot-source.js';
import { readProductionPilotWithBackoff } from './production-pilot-read-scheduler.js';

function fail(code: string): never {
  throw Error('PRODUCTION_PREPARATION_' + code);
}
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
export const productionPreparationMetadataQuerySchema = z
  .object({
    categoryId: identifier.optional(),
    brandOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    brandName: z.string().min(1).max(256).optional(),
    inventoryOffset: z.number().int().min(0).max(1_000_000).optional(),
    inventoryStatus: z.enum(['NORMAL', 'UNLIST']).optional(),
    includeInventory: z.boolean().optional(),
    referenceItemId: identifier.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.brandName !== undefined || value.brandOffset !== undefined) && !value.categoryId)
      ctx.addIssue({ code: 'custom', message: 'Category is required' });
    if (value.brandName !== undefined && value.brandOffset !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Exact-name search starts at the first page' });
  });
export type ProductionPreparationMetadataQuery = z.infer<
  typeof productionPreparationMetadataQuerySchema
>;
export type PreparationReadEvidence = {
  id: string;
  path: string;
  requestId: string;
  observedAt: string;
  cacheHit: boolean;
};
export type PreparationAttribute = {
  id: string;
  label: string;
  mandatory: boolean;
  inputType:
    | 'single_dropdown'
    | 'single_combobox'
    | 'free_text'
    | 'multi_dropdown'
    | 'multi_combobox'
    | 'unsupported';
  inputTypeCode: number | null;
  validationType: number | null;
  formatType: number | null;
  dateFormatType: number | null;
  units: string[];
  maxValueCount: number | null;
  searchRequired: boolean | null;
  introduction: string | null;
  values: { id: string; label: string; unit: string | null; children: PreparationAttribute[] }[];
};
export type PreparationBrandPage = {
  items: { id: string; name: string; label: string }[];
  hasNextPage: boolean;
  nextOffset: number | null;
  mandatory: boolean | null;
  inputType: string | null;
  searchComplete: boolean;
  exactName?: string;
  anomalies: { code: 'DUPLICATE_IDENTICAL_BRAND'; brandId: string; offset: number }[];
};
type Range = { min: number | null; max: number | null };
export type PreparationItemLimits = {
  price: Range;
  stock: Range;
  titleLength: Range;
  descriptionLength: Range;
  galleryCount: Range;
  tierNameLength: Range;
  tierOptionLength: Range;
  itemCount: Range;
  weightMandatory: boolean | null;
  dimensionMandatory: boolean | null;
  sizeChart: {
    mandatory: boolean | null;
    supportImage: boolean | null;
    supportTemplate: boolean | null;
  };
  daysToShip: Range;
  nonPreOrderDaysToShip: number | null;
};
export type PreparationChannel = {
  id: string;
  name: string;
  enabled: boolean;
  forceEnabled: boolean | null;
  compulsory: boolean | null;
  feeType: string | null;
  parentId: string | null;
  weightKg: Range;
  maxDimension: {
    height: number | null;
    width: number | null;
    length: number | null;
    sum: number | null;
    unit: string | null;
  };
  volume: Range;
  relatedEnabledChannelIds: string[];
  dependentBlockChannelIds: string[];
  relatedDisabledChannelIds?: string[];
  relationsKnown: boolean;
};
export type PreparationInventoryItem = {
  itemId: string;
  title: string;
  itemSku: string;
  status: 'NORMAL' | 'UNLIST';
};
export type PreparationStockWriteMapping = {
  expectedLocationId: string;
  writeLocationId: string | null;
  verifiedOperationId: string;
  verificationFingerprint: string;
  referenceRequestId: string;
  warehouseRequestId: string;
};
export type ProductionPreparationMetadata = {
  scope: typeof productionPilotScope;
  connectionRevision: number;
  observedAt: string;
  shop: { id: string; name: string };
  categoryAuthorizationVerified: false;
  categories: { id: string; label: string; path: string; isLeaf: true }[];
  attributes?: PreparationAttribute[];
  brands?: PreparationBrandPage;
  channels: PreparationChannel[];
  itemLimits?: PreparationItemLimits;
  inventory?: {
    items: PreparationInventoryItem[];
    hasNextPage: boolean;
    nextOffset: number | null;
    totalCount: number;
    status: 'NORMAL' | 'UNLIST';
  };
  reference?: {
    itemId: string;
    title: string;
    modelCount: number;
    writeMappingVerified: boolean;
    writeMapping?: PreparationStockWriteMapping;
    stockLocations: { id: string; saleable: boolean | null; modelIds: string[] }[];
  };
  evidence: PreparationReadEvidence[];
};
type StoredRead = {
  id: string;
  path: string;
  requestId: string;
  observedAt: string;
  response: Record<string, any>;
  bytes: number;
};
type Options = {
  transport?: typeof fetch;
  encryptionKey?: string;
  evidenceRoot?: string;
  now?: () => number;
  cacheTtlMs?: number;
};
const cachePaths = new Set([
  '/api/v2/product/get_category',
  '/api/v2/product/get_attribute_tree',
  '/api/v2/product/get_brand_list',
  '/api/v2/logistics/get_channel_list',
]);
const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const id = (value: unknown, zero = false): string => {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !(zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  )
    return fail('RESPONSE_INVALID');
  return String(value);
};
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const booleanOrNull = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const label = (value: unknown, fallback: unknown): string => {
  const result = typeof value === 'string' && value.length ? value : fallback;
  return typeof result === 'string' && result.length ? result : fail('RESPONSE_INVALID');
};
function categories(data: Record<string, any>): ProductionPreparationMetadata['categories'] {
  if (!Array.isArray(data.category_list) || data.category_list.length > 30_000)
    fail('CATEGORY_TREE_INVALID');
  const all = new Map<string, { id: string; parent: string; label: string; leaf: boolean }>();
  for (const row of data.category_list) {
    if (!record(row) || typeof row.has_children !== 'boolean') fail('CATEGORY_TREE_INVALID');
    const key = id(row.category_id);
    if (all.has(key)) fail('CATEGORY_TREE_INVALID');
    all.set(key, {
      id: key,
      parent: id(row.parent_category_id, true),
      label: label(row.display_category_name, row.original_category_name),
      leaf: !row.has_children,
    });
  }
  const path = (key: string, seen = new Set<string>()): string => {
    if (seen.has(key) || seen.size > 20) fail('CATEGORY_TREE_INVALID');
    const row = all.get(key);
    if (!row) fail('CATEGORY_TREE_INVALID');
    seen.add(key);
    return row.parent === '0' ? row.label : path(row.parent, seen) + ' > ' + row.label;
  };
  // Validate parent cycles even for non-leaf branches; no fabricated root or fallback category.
  for (const key of all.keys()) path(key);
  return [...all.values()]
    .filter((row) => row.leaf)
    .map((row) => ({ id: row.id, label: row.label, path: path(row.id), isLeaf: true as const }));
}
function attributes(data: Record<string, any>, categoryId: string): PreparationAttribute[] {
  const trees = Array.isArray(data.list)
    ? data.list.filter((row: any) => record(row) && String(row.category_id) === categoryId)
    : [];
  if (trees.length !== 1 || !Array.isArray(trees[0].attribute_tree)) fail('ATTRIBUTES_INVALID');
  let nodes = 0;
  const parse = (rows: unknown, depth: number): PreparationAttribute[] => {
    if (!Array.isArray(rows) || depth > 10) fail('ATTRIBUTES_INVALID');
    const seen = new Set<string>();
    return rows.map((row) => {
      if (
        ++nodes > 20_000 ||
        !record(row) ||
        typeof row.mandatory !== 'boolean' ||
        !record(row.attribute_info)
      )
        fail('ATTRIBUTES_INVALID');
      const key = id(row.attribute_id);
      if (seen.has(key)) fail('ATTRIBUTES_INVALID');
      seen.add(key);
      const info = row.attribute_info,
        values = row.attribute_value_list ?? [];
      if (
        !Array.isArray(values) ||
        (info.attribute_unit_list !== undefined &&
          (!Array.isArray(info.attribute_unit_list) ||
            info.attribute_unit_list.some((unit: unknown) => typeof unit !== 'string')))
      )
        fail('ATTRIBUTES_INVALID');
      const names = Array.isArray(row.multi_lang) ? row.multi_lang : [],
        translated = names.find((v: any) => v?.language === 'vn' || v?.language === 'vi')?.value;
      const types: Record<number, PreparationAttribute['inputType']> = {
        1: 'single_dropdown',
        2: 'single_combobox',
        3: 'free_text',
        4: 'multi_dropdown',
        5: 'multi_combobox',
      };
      const valueSeen = new Set<string>();
      return {
        id: key,
        label: label(translated, row.name),
        mandatory: row.mandatory,
        inputType: types[info.input_type] ?? 'unsupported',
        inputTypeCode: numberOrNull(info.input_type),
        validationType: numberOrNull(info.input_validation_type),
        formatType: numberOrNull(info.format_type),
        dateFormatType: numberOrNull(info.date_format_type),
        units: info.attribute_unit_list ?? [],
        maxValueCount: numberOrNull(info.max_value_count),
        searchRequired: booleanOrNull(info.support_search_value),
        introduction: stringOrNull(info.introduction),
        values: values.map((value: any) => {
          if (!record(value) || ++nodes > 20_000) fail('ATTRIBUTES_INVALID');
          const valueId = id(value.value_id, true);
          if (valueSeen.has(valueId)) fail('ATTRIBUTES_INVALID');
          valueSeen.add(valueId);
          const valueNames = Array.isArray(value.multi_lang) ? value.multi_lang : [],
            text = valueNames.find((v: any) => v?.language === 'vn' || v?.language === 'vi')?.value;
          return {
            id: valueId,
            label: label(text, value.name),
            unit: stringOrNull(value.value_unit),
            children: parse(value.child_attribute_list ?? [], depth + 1),
          };
        }),
      };
    });
  };
  return parse(trees[0].attribute_tree, 0);
}
function brandPage(data: Record<string, any>, offset: number): PreparationBrandPage {
  if (
    !Array.isArray(data.brand_list) ||
    data.brand_list.length > 100 ||
    typeof data.has_next_page !== 'boolean'
  )
    fail('BRANDS_INVALID');
  if (
    data.has_next_page &&
    (!Number.isSafeInteger(data.next_offset) ||
      data.next_offset <= offset ||
      !data.brand_list.length)
  )
    fail('BRAND_CURSOR_INVALID');
  const seen = new Map<string, PreparationBrandPage['items'][number]>();
  const anomalies: PreparationBrandPage['anomalies'] = [];
  for (const row of data.brand_list) {
    if (!record(row)) fail('BRANDS_INVALID');
    const key = id(row.brand_id, true);
    const brand = {
      id: key,
      name: label(row.original_brand_name, undefined),
      label: label(row.display_brand_name, row.original_brand_name),
    };
    const previous = seen.get(key);
    if (previous) {
      if (canonicalJson(previous) !== canonicalJson(brand)) fail('BRANDS_INVALID');
      anomalies.push({ code: 'DUPLICATE_IDENTICAL_BRAND', brandId: key, offset });
    } else seen.set(key, brand);
  }
  return {
    items: [...seen.values()],
    anomalies,
    hasNextPage: data.has_next_page,
    nextOffset: data.has_next_page ? data.next_offset : null,
    mandatory: booleanOrNull(data.is_mandatory),
    inputType: stringOrNull(data.input_type),
    searchComplete: !data.has_next_page,
  };
}
function channels(data: Record<string, any>): PreparationChannel[] {
  if (!Array.isArray(data.logistics_channel_list) || data.logistics_channel_list.length > 1000)
    fail('CHANNELS_INVALID');
  const seen = new Set<string>();
  return data.logistics_channel_list.map((row: any) => {
    if (!record(row) || typeof row.enabled !== 'boolean') fail('CHANNELS_INVALID');
    const key = id(row.logistics_channel_id);
    if (seen.has(key)) fail('CHANNELS_INVALID');
    seen.add(key);
    const rules = row.channel_relation_rules,
      ruleList = Array.isArray(rules) ? rules : record(rules) ? [rules] : [];
    const known =
      (Array.isArray(rules) || record(rules)) &&
      ruleList.every(
        (rule) =>
          record(rule) &&
          Array.isArray(rule.related_enabled_channels) &&
          Array.isArray(rule.related_dependent_block_channels) &&
          (rule.related_disabled_channels === undefined || Array.isArray(rule.related_disabled_channels)) &&
          Object.entries(rule).every(([key, value]) =>
            ['related_enabled_channels', 'related_dependent_block_channels', 'related_disabled_channels'].includes(key) ||
            (Array.isArray(value) && value.length === 0)),
      );
    if (rules !== undefined && rules !== null && !known) fail('CHANNEL_RELATIONS_INVALID');
    const dimension = row.item_max_dimension;
    return {
      id: key,
      name: label(row.logistics_channel_name, undefined),
      enabled: row.enabled,
      forceEnabled: booleanOrNull(row.force_enable),
      compulsory: booleanOrNull(row.compulsory_channel),
      feeType: stringOrNull(row.fee_type),
      parentId: row.mask_channel_id == null ? null : id(row.mask_channel_id, true),
      weightKg: {
        min: numberOrNull(row.weight_limit?.item_min_weight),
        max: numberOrNull(row.weight_limit?.item_max_weight),
      },
      maxDimension: {
        height: numberOrNull(dimension?.height),
        width: numberOrNull(dimension?.width),
        length: numberOrNull(dimension?.length),
        sum: numberOrNull(dimension?.dimension_sum),
        unit: stringOrNull(dimension?.unit),
      },
      volume: {
        min: numberOrNull(row.volume_limit?.item_min_volume),
        max: numberOrNull(row.volume_limit?.item_max_volume),
      },
      relationsKnown: known,
      relatedDisabledChannelIds: [...new Set<string>(ruleList.flatMap(rule =>
        (rule.related_disabled_channels ?? []).map((value: unknown) => id(value))))],
      relatedEnabledChannelIds: [
        ...new Set<string>(
          ruleList.flatMap((rule) =>
            rule.related_enabled_channels.map((value: unknown) => id(value)),
          ),
        ),
      ],
      dependentBlockChannelIds: [
        ...new Set<string>(
          ruleList.flatMap((rule) =>
            rule.related_dependent_block_channels.map((value: unknown) => id(value)),
          ),
        ),
      ],
    };
  });
}
function itemLimits(data: Record<string, any>): PreparationItemLimits {
  const range = (v: any): Range => ({
    min: numberOrNull(v?.min_limit),
    max: numberOrNull(v?.max_limit),
  });
  return {
    price: range(data.price_limit),
    stock: range(data.stock_limit),
    titleLength: range(data.item_name_length_limit),
    descriptionLength: range(data.item_description_length_limit),
    galleryCount: range(data.item_image_count_limit),
    tierNameLength: range(data.tier_variation_name_length_limit),
    tierOptionLength: range(data.tier_variation_option_length_limit),
    itemCount: range(data.item_count_limit),
    weightMandatory: booleanOrNull(data.weight_limit?.weight_mandatory),
    dimensionMandatory: booleanOrNull(data.dimension_limit?.dimension_mandatory),
    sizeChart: {
      mandatory: booleanOrNull(data.size_chart_limit?.size_chart_mandatory),
      supportImage: booleanOrNull(data.size_chart_limit?.support_image_size_chart),
      supportTemplate: booleanOrNull(data.size_chart_limit?.support_template_size_chart),
    },
    daysToShip: range(data.dts_limit?.days_to_ship_limit),
    nonPreOrderDaysToShip: numberOrNull(data.dts_limit?.non_pre_order_days_to_ship),
  };
}
function observedSingleLocation(rows: unknown): string | undefined {
  if (!Array.isArray(rows) || !rows.length) return;
  const locations = new Set<string>();
  for (const row of rows) {
    const stock = row?.stock_info_v2,
      seller = stock?.seller_stock;
    if (
      !Array.isArray(seller) ||
      seller.length !== 1 ||
      seller[0]?.if_saleable !== true ||
      typeof seller[0]?.location_id !== 'string' ||
      !seller[0].location_id ||
      !Number.isSafeInteger(seller[0].stock) ||
      seller[0].stock < 0 ||
      stock.summary_info?.total_reserved_stock !== 0 ||
      stock.summary_info?.total_available_stock !== seller[0].stock ||
      !Array.isArray(stock.shopee_stock) ||
      stock.shopee_stock.some((s: any) => !s || Number(s.stock) !== 0) ||
      row.is_fulfillment_by_shopee === true ||
      (stock.advance_stock &&
        !(Array.isArray(stock.advance_stock) && !stock.advance_stock.length) &&
        canonicalJson(stock.advance_stock) !==
          canonicalJson({ sellable_advance_stock: 0, in_transit_advance_stock: 0 }))
    )
      return;
    locations.add(seller[0].location_id);
  }
  return locations.size === 1 ? [...locations][0] : undefined;
}
/** A previous success is a scoped mapping proof, not a general warehouse capability claim. */
function verifiedStockMapping(
  view: any,
  connection: any,
  expectedLocation: string,
):
  | Pick<
      PreparationStockWriteMapping,
      'expectedLocationId' | 'writeLocationId' | 'verifiedOperationId' | 'verificationFingerprint'
    >
  | undefined {
  try {
    const op = view.operation,
      payload = op?.source_payload,
      document = payload?.document,
      proof = payload?.stockLocationEvidence;
    if (
      !op ||
      op.state !== 'verified' ||
      !op.item_id ||
      op.owner_key !==
        `production:${productionPilotScope.partnerId}:${productionPilotScope.shopId}` ||
      op.connection_id !== connection.id ||
      !Number.isSafeInteger(op.connection_revision) ||
      op.connection_revision < 1 ||
      op.connection_revision > connection.revision ||
      payload?.connectionId !== op.connection_id ||
      payload?.connectionRevision !== op.connection_revision ||
      payload?.sourceIdentity !== op.source_identity ||
      payload?.sourceRevision !== op.source_revision ||
      !document ||
      !Array.isArray(document.models) ||
      !document.models.length ||
      !Array.isArray(document.tierNames) ||
      op.source_fingerprint !==
        fingerprint({
          scope: productionPilotScope,
          sourceIdentity: op.source_identity,
          sourceRevision: op.source_revision,
          sourcePayload: payload,
          expectedProjection: op.expected_projection,
        }) ||
      proof?.environment !== 'production' ||
      proof?.partnerId !== productionPilotScope.partnerId ||
      proof?.shopId !== productionPilotScope.shopId ||
      proof?.connectionRevision !== op.connection_revision
    )
      return;
    checkVerification(
      view.verification,
      op.id,
      op.revision,
      op.item_id,
      'created_unlisted',
      op.expected_projection,
    );
    const expected = proof.expectedLocationBySku,
      writes = payload.context?.stockLocationBySku,
      skus = document.models.map((m: any) => m.sku).sort();
    if (
      !record(expected) ||
      !record(writes) ||
      canonicalJson(Object.keys(expected).sort()) !== canonicalJson(skus) ||
      canonicalJson(Object.keys(writes).sort()) !== canonicalJson(skus) ||
      Object.values(expected).some((location) => location !== expectedLocation)
    )
      return;
    const writeLocations = new Set(Object.values(writes));
    if (writeLocations.size !== 1) return;
    const writeLocation = [...writeLocations][0];
    if (writeLocation !== null && writeLocation !== expectedLocation) return;
    const required = [
      ...preparedWireMediaRequirements(document).map((_, i) => ({
        key: 'media-' + i,
        kind: 'media',
        path: '/api/v2/media_space/upload_image',
      })),
      { key: 'create', kind: 'create', path: '/api/v2/product/add_item' },
      ...(document.tierNames.length
        ? [{ key: 'variations', kind: 'variations', path: '/api/v2/product/init_tier_variation' }]
        : []),
    ];
    if (
      !Array.isArray(view.steps) ||
      view.steps.length !== required.length ||
      !required.every((wanted, index) => {
        const step = view.steps[index];
        return (
          step?.step_key === wanted.key &&
          step.kind === wanted.kind &&
          step.path === wanted.path &&
          step.state === 'acknowledged'
        );
      })
    )
      return;
    for (const step of view.steps.filter((s: any) => s.kind !== 'media'))
      if (
        step.fingerprint !== productionPilotWriteFingerprint(step.path, step.payload) ||
        step.receipt?.kind !== 'success' ||
        step.outcome_fingerprint !== fingerprint(step.receipt)
      )
        return;
    const mutation = document.tierNames.length
      ? view.steps.find((s: any) => s.kind === 'variations')
      : view.steps.find((s: any) => s.kind === 'create');
    const sentModels = document.tierNames.length
      ? mutation.payload.model
      : [{ ...mutation.payload, model_sku: document.models[0].sku }];
    if (!Array.isArray(sentModels) || sentModels.length !== document.models.length) return;
    for (const model of document.models) {
      const matching = sentModels.filter((row: any) => row.model_sku === model.sku),
        stock = matching[0]?.seller_stock;
      const projected = op.expected_projection?.models?.filter((row: any) => row.sku === model.sku);
      if (
        matching.length !== 1 ||
        !Array.isArray(stock) ||
        stock.length !== 1 ||
        stock[0].stock !== model.stock ||
        (writeLocation === null
          ? Object.hasOwn(stock[0], 'location_id')
          : stock[0].location_id !== writeLocation) ||
        !Array.isArray(projected) ||
        projected.length !== 1 ||
        projected[0].stockLocation !== expectedLocation ||
        projected[0].stock !== model.stock
      )
        return;
    }
    return {
      expectedLocationId: expectedLocation,
      writeLocationId: writeLocation,
      verifiedOperationId: op.id,
      verificationFingerprint: view.verification.evidence_fingerprint,
    };
  } catch {
    return;
  }
}

/** Read-only form choices. These observations neither authorize a category nor change listing sources.
 * KB: get_attribute_tree 2025-01-13; get_channel_list 2026-05-22; get_model_list 2026-07-31.
 * Limits are deliberately uncached and must still be revalidated by the writer preflight. */
export class ProductionPreparationMetadataService {
  private readonly cache = new Map<string, StoredRead>();
  private readonly pending = new Map<string, Promise<StoredRead>>();
  private readonly now: () => number;
  private readonly ttl: number;
  constructor(
    private readonly repo: Repository,
    private readonly options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttl = options.cacheTtlMs ?? 120_000;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 300_000)
      fail('CACHE_TTL_INVALID');
  }
  async get(
    input: ProductionPreparationMetadataQuery = {},
    signal?: AbortSignal,
  ): Promise<ProductionPreparationMetadata> {
    signal?.throwIfAborted();
    const parsed = productionPreparationMetadataQuerySchema.safeParse(input);
    if (!parsed.success) fail('QUERY_INVALID');
    const query = parsed.data;
    const rows = (
      await this.repo.pool.query(
        'SELECT * FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3',
        ['production', productionPilotScope.partnerId, productionPilotScope.shopId],
      )
    ).rows;
    const connection = rows[0];
    const valid = (row: any) =>
      row &&
      row.environment === 'production' &&
      String(row.partner_id) === productionPilotScope.partnerId &&
      String(row.shop_id) === productionPilotScope.shopId &&
      row.state === 'connected' &&
      Number.isSafeInteger(row.revision) &&
      row.revision > 0 &&
      Date.parse(String(row.expires_at)) > this.now();
    if (rows.length !== 1 || !valid(connection)) fail('AUTH_REQUIRED');
    const stillCurrent = async () => {
      signal?.throwIfAborted();
      const current = (
        await this.repo.pool.query(
          'SELECT * FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3',
          ['production', productionPilotScope.partnerId, productionPilotScope.shopId],
        )
      ).rows;
      if (
        current.length !== 1 ||
        !valid(current[0]) ||
        current[0].id !== connection.id ||
        current[0].revision !== connection.revision
      )
        fail('CONNECTION_CHANGED');
    };
    let partnerKey: string, accessToken: string;
    try {
      const box = new SecretBox(this.options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? ''),
        owner = `production:${productionPilotScope.partnerId}:${productionPilotScope.shopId}`;
      partnerKey = (box.open(connection.partner_key_ciphertext, owner) as { partnerKey: string })
        .partnerKey;
      accessToken = (box.open(connection.token_ciphertext, owner) as { accessToken: string })
        .accessToken;
    } catch {
      return fail('AUTH_REQUIRED');
    }
    const client = new ProductionPilotTransport(
      { ...productionPilotScope, partnerKey, accessToken },
      { transport: this.options.transport },
    );
    const directory = resolve(
      this.options.evidenceRoot ?? '.local/production-preparation-metadata',
      randomUUID(),
    );
    await mkdir(directory, { recursive: true });
    const evidence: PreparationReadEvidence[] = [];
    const get = async (
      path: string,
      params: Record<string, string>,
      allowedError?: string,
    ): Promise<Record<string, any>> => {
      await stillCurrent();
      const key = canonicalJson({
        scope: productionPilotScope,
        connectionId: connection.id,
        connectionRevision: connection.revision,
        path,
        query: params,
      });
      const saved = this.cache.get(key),
        cacheable = cachePaths.has(path),
        age = saved ? this.now() - Date.parse(saved.observedAt) : Infinity;
      let result: StoredRead,
        cacheHit = false;
      const load = async (): Promise<StoredRead> => {
        let receiptId = '',
          observedAt = '';
        const outcome = await readProductionPilotWithBackoff(
          { read: (path, params) => {
            signal?.throwIfAborted();
            return client.read(path, params, signal);
          } },
          path,
          params,
          async (outcome, attempt) => {
            receiptId = randomUUID();
            observedAt = new Date(this.now()).toISOString();
            await writeFile(
              resolve(directory, receiptId + '.json'),
              JSON.stringify(
                {
                  id: receiptId,
                  scope: productionPilotScope,
                  connectionId: connection.id,
                  connectionRevision: connection.revision,
                  method: 'GET',
                  path,
                  query: params,
                  observedAt,
                  attempt,
                  result: outcome,
                },
                null,
                2,
              ),
              { flag: 'wx' },
            );
          },
        );
        await stillCurrent();
        if (outcome.kind !== 'success') {
          if (allowedError && outcome.envelope?.error === allowedError && outcome.requestId)
            return {
              id: receiptId,
              path,
              requestId: outcome.requestId,
              observedAt,
              response: { confirmedError: allowedError },
              bytes: 0,
            };
          fail('READ_FAILED');
        }
        return {
          id: receiptId,
          path,
          requestId: outcome.requestId,
          observedAt,
          response: outcome.response,
          bytes: Buffer.byteLength(JSON.stringify(outcome.response)),
        };
      };
      if (cacheable && saved && age >= 0 && age < this.ttl) {
        result = saved;
        cacheHit = true;
      } else if (cacheable) {
        let pending = this.pending.get(key);
        cacheHit = !!pending;
        if (!pending) {
          pending = load();
          this.pending.set(key, pending);
        }
        try {
          result = await pending;
          if (result.bytes <= 16 * 1024 * 1024) {
            this.cache.set(key, result);
            while (
              this.cache.size > 128 ||
              [...this.cache.values()].reduce((n, e) => n + e.bytes, 0) > 16 * 1024 * 1024
            )
              this.cache.delete(this.cache.keys().next().value!);
          }
        } finally {
          if (this.pending.get(key) === pending) this.pending.delete(key);
        }
      } else result = await load();
      await stillCurrent();
      evidence.push({
        id: result.id,
        path,
        requestId: result.requestId,
        observedAt: result.observedAt,
        cacheHit,
      });
      return structuredClone(result.response);
    };
    const shop = await get('/api/v2/shop/get_shop_info', {});
    if (
      shop.region !== 'VN' ||
      shop.status !== 'NORMAL' ||
      typeof shop.shop_name !== 'string' ||
      !shop.shop_name.length ||
      (shop.shop_id !== undefined && String(shop.shop_id) !== productionPilotScope.shopId)
    )
      fail('SHOP_IDENTITY_MISMATCH');
    const choices = categories(await get('/api/v2/product/get_category', { language: 'vi' }));
    if (query.categoryId && !choices.some((category) => category.id === query.categoryId))
      fail('CATEGORY_NOT_SELECTABLE');
    const result: ProductionPreparationMetadata = {
      scope: { ...productionPilotScope },
      connectionRevision: connection.revision,
      observedAt: new Date(this.now()).toISOString(),
      shop: { id: productionPilotScope.shopId, name: shop.shop_name },
      categoryAuthorizationVerified: false,
      categories: choices,
      channels: [],
      evidence,
    };
    if (query.categoryId) {
      result.itemLimits = itemLimits(
        await get('/api/v2/product/get_item_limit', { category_id: query.categoryId }),
      );
      result.attributes = attributes(
        await get('/api/v2/product/get_attribute_tree', {
          category_id_list: query.categoryId,
          language: 'vn',
        }),
        query.categoryId,
      );
      const page = async (offset: number) =>
        brandPage(
          await get('/api/v2/product/get_brand_list', {
            category_id: query.categoryId!,
            offset: String(offset),
            page_size: '100',
            status: '1',
            language: 'vi',
          }),
          offset,
        );
      result.brands = await page(query.brandOffset ?? 0);
      if (query.brandName !== undefined) {
        const matches: PreparationBrandPage['items'] = [],
          seen = new Map<string, PreparationBrandPage['items'][number]>(),
          anomalies: PreparationBrandPage['anomalies'] = [];
        let count = 0, offset = 0;
        while (true) {
          anomalies.push(...result.brands.anomalies);
          for (const brand of result.brands.items) {
            const previous = seen.get(brand.id);
            if (previous) {
              if (canonicalJson(previous) !== canonicalJson(brand)) fail('BRANDS_INVALID');
              anomalies.push({ code: 'DUPLICATE_IDENTICAL_BRAND', brandId: brand.id, offset });
              continue;
            }
            seen.set(brand.id, brand);
            if (brand.name === query.brandName) matches.push(brand);
          }
          if (!result.brands.hasNextPage) break;
          if (++count >= 200) fail('BRAND_SEARCH_LIMIT_REACHED');
          offset = result.brands.nextOffset!;
          result.brands = await page(offset);
        }
        result.brands = {
          ...result.brands,
          items: matches,
          anomalies,
          exactName: query.brandName,
          searchComplete: true,
        };
      }
    }
    result.channels = channels(await get('/api/v2/logistics/get_channel_list', {}));
    if (query.includeInventory !== false) {
      const status = query.inventoryStatus ?? 'NORMAL',
        offset = query.inventoryOffset ?? 0;
      const response = await get('/api/v2/product/get_item_list', {
        item_status: status,
        offset: String(offset),
        page_size: '20',
      });
      const decoded = decodeProductionPilotInventoryPage(response, status, offset);
      if (decoded.ids.length > 20) fail('INVENTORY_INVALID');
      const base = decoded.ids.length
        ? await get('/api/v2/product/get_item_base_info', { item_id_list: decoded.ids.join(',') })
        : { item_list: [] };
      if (
        !Array.isArray(base.item_list) ||
        base.item_list.length !== decoded.ids.length ||
        new Set(base.item_list.map((row: any) => id(row.item_id))).size !== decoded.ids.length ||
        base.item_list.some(
          (row: any) =>
            !record(row) || !decoded.ids.includes(id(row.item_id)) || row.item_status !== status,
        )
      )
        fail('INVENTORY_INVALID');
      result.inventory = {
        items: base.item_list.map((row: any) => ({
          itemId: id(row.item_id),
          title: label(row.item_name, undefined),
          itemSku: typeof row.item_sku === 'string' ? row.item_sku : '',
          status,
        })),
        hasNextPage: !decoded.complete,
        nextOffset: decoded.complete ? null : decoded.nextOffset!,
        totalCount: response.total_count,
        status,
      };
    }
    if (query.referenceItemId) {
      const base = await get('/api/v2/product/get_item_base_info', {
        item_id_list: query.referenceItemId,
      });
      if (
        !Array.isArray(base.item_list) ||
        base.item_list.length !== 1 ||
        !record(base.item_list[0]) ||
        String(base.item_list[0].item_id) !== query.referenceItemId ||
        !['NORMAL', 'UNLIST'].includes(base.item_list[0].item_status)
      )
        fail('REFERENCE_INVALID');
      const item = base.item_list[0];
      if (item.shop_id !== undefined && String(item.shop_id) !== productionPilotScope.shopId)
        fail('REFERENCE_INVALID');
      const models = await get('/api/v2/product/get_model_list', {
        item_id: query.referenceItemId,
      });
      if (!Array.isArray(models.model) || models.model.length > 1000) fail('REFERENCE_INVALID');
      const locations = new Map<
          string,
          { id: string; saleable: boolean | null; modelIds: string[] }
        >(),
        modelIds = new Set<string>();
      for (const model of models.model.length
        ? models.model
        : [{ model_id: 0, stock_info_v2: item.stock_info_v2 }]) {
        if (!record(model)) fail('REFERENCE_INVALID');
        const modelId = id(model.model_id, true);
        if (modelIds.has(modelId)) fail('REFERENCE_INVALID');
        modelIds.add(modelId);
        const stocks = model.stock_info_v2?.seller_stock;
        if (!Array.isArray(stocks)) continue;
        const ownLocations = new Set<string>();
        for (const stock of stocks) {
          if (
            !record(stock) ||
            typeof stock.location_id !== 'string' ||
            stock.location_id.length > 128 ||
            ownLocations.has(stock.location_id)
          )
            fail('REFERENCE_INVALID');
          ownLocations.add(stock.location_id);
          const saleable = booleanOrNull(stock.if_saleable),
            previous = locations.get(stock.location_id);
          if (previous) {
            previous.saleable = previous.saleable === saleable ? saleable : null;
            previous.modelIds.push(modelId);
          } else
            locations.set(stock.location_id, {
              id: stock.location_id,
              saleable,
              modelIds: [modelId],
            });
        }
      }
      result.reference = {
        itemId: query.referenceItemId,
        title: label(item.item_name, undefined),
        modelCount: models.model.length,
        writeMappingVerified: false,
        stockLocations: [...locations.values()],
      };
      const location = observedSingleLocation(models.model.length ? models.model : [item]);
      if (location) {
        const referenceRequestId = evidence[evidence.length - 1]!.requestId;
        const warehouse = await get(
          '/api/v2/shop/get_warehouse_detail',
          { warehouse_type: '1' },
          'warehouse.error_not_in_whitelist',
        );
        if (warehouse.confirmedError === 'warehouse.error_not_in_whitelist') {
          const candidates = (
            await this.repo.pool.query(
              `SELECT to_jsonb(o) AS operation,
            (SELECT to_jsonb(v) FROM production_pilot_verifications v WHERE v.operation_id=o.id) AS verification,
            COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.ordinal) FROM production_pilot_steps s WHERE s.operation_id=o.id),'[]'::jsonb) AS steps
            FROM production_pilot_operations o WHERE o.connection_id=$1 AND o.owner_key=$2 AND o.state='verified' ORDER BY o.created_at DESC LIMIT 100`,
              [
                connection.id,
                `production:${productionPilotScope.partnerId}:${productionPilotScope.shopId}`,
              ],
            )
          ).rows;
          const verified = candidates
            .map((view) => verifiedStockMapping(view, connection, location))
            .filter((value): value is NonNullable<typeof value> => !!value);
          if (
            verified.length &&
            new Set(
              verified.map((value) =>
                canonicalJson([value.expectedLocationId, value.writeLocationId]),
              ),
            ).size === 1
          ) {
            const mapping = {
              ...verified[0]!,
              referenceRequestId,
              warehouseRequestId: evidence[evidence.length - 1]!.requestId,
            };
            await writeFile(
              resolve(directory, 'stock-mapping-proof.json'),
              canonicalJson({
                scope: productionPilotScope,
                connectionId: connection.id,
                connectionRevision: connection.revision,
                referenceItemId: query.referenceItemId,
                observedAt: new Date(this.now()).toISOString(),
                mapping,
              }),
              { flag: 'wx' },
            );
            result.reference.writeMappingVerified = true;
            result.reference.writeMapping = mapping;
          }
        }
      }
    }
    await stillCurrent();
    return result;
  }
}
