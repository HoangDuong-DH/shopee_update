import { z } from 'zod';
import {
  canonicalJson,
  preparedWeightKilograms,
  validatePreparedModelShipping,
  type PreparedDocument,
  type PreparedField,
  type PreparedMedia,
  type PreparedRemote,
} from '@shopee/domain';
import type { FieldSnapshot } from './field-client.js';
import { isMissingPendingSku } from '../../domain/src/pending-listing-mapping.js';

export const PREPARED_CREATED_ITEM_ID = '$created_item_id' as const;
export type PreparedWireImageRole = 'cover' | 'gallery' | 'description' | 'variation';
export type ResolvedPreparedImage = {
  importId: string;
  sha256: string;
  role: PreparedWireImageRole;
  imageId: string;
};
export type PreparedWireContext = {
  images: ResolvedPreparedImage[];
  brandName?: string;
  condition?: 'NEW' | 'USED';
  preOrder?: { is_pre_order: boolean; days_to_ship?: number };
  gtinBySku?: Record<string, string>;
  /** Values resolved from category metadata; must exactly match the source's selected IDs. */
  attributeList?: {
    attribute_id: number;
    attribute_value_list: { value_id: number; original_value_name?: string; value_unit?: string }[];
  }[];
  /** Own property with null means a confirmed shop without seller warehouses. */
  stockLocationBySku: Record<string, string | null>;
  limits: Record<string, any>;
  capabilities: { gallery34: boolean; extendedDescription: boolean };
  /** Explicitly selected only when fresh shop evidence says extended descriptions are unsupported. */
  descriptionMode?: 'plain_fallback';
  channelInfoById?: Record<string, Record<string, any>>;
  baseline?: FieldSnapshot;
  /** Full get_item_promotion envelope, required for an original-price update. */
  promotionSnapshot?: unknown;
};
export type PreparedWireStep = {
  path: `/api/v2/product/${'add_item' | 'init_tier_variation' | 'update_item' | 'update_tier_variation' | 'update_price' | 'update_stock'}`;
  method: 'POST';
  payload: Record<string, any>;
  group: PreparedField | 'create' | 'variations';
  minDelayAfterCreateMs?: number;
  expectedModelIds?: string[];
};
export type PreparedWireIssue = { code: string; field: string };
export type PreparedWirePlan =
  | { kind: 'ready'; operation: 'create' | 'update'; steps: PreparedWireStep[] }
  | { kind: 'blocked'; issues: PreparedWireIssue[] };
export type PreparedWireAcknowledgement = {
  success: boolean;
  kind: 'acknowledged' | 'rejected' | 'unknown';
  createdItemId?: string;
  issues: PreparedWireIssue[];
  successModelIds: string[];
  failureModelIds: string[];
};
const int = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1);
const imageId = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
const record = z.record(z.string(), z.any());
class WireProblem extends Error {
  constructor(
    readonly code: string,
    readonly field: string,
  ) {
    super(code);
  }
}
function fail(code: string, field: string): never {
  throw new WireProblem('PREPARED_WIRE_' + code, field);
}
function id(value: unknown, field: string, zero = false): number {
  const s = String(value);
  if (!/^(0|[1-9]\d*)$/.test(s) || !Number.isSafeInteger(Number(s)) || (!zero && Number(s) === 0))
    fail('ID_INVALID', field);
  return Number(s);
}
function positiveInt(value: unknown, field: string) {
  const n = int.safeParse(value);
  if (!n.success || n.data < 1) fail('INTEGER_INVALID', field);
  return n.data;
}
function price(value: string) {
  if (typeof value !== 'string') fail('PRICE_INVALID', 'originalPrice');
  return id(value, 'originalPrice');
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function blocked(error: unknown): PreparedWirePlan {
  return {
    kind: 'blocked',
    issues: [
      error instanceof WireProblem
        ? { code: error.code, field: error.field }
        : { code: 'PREPARED_WIRE_INVALID_SOURCE', field: 'source' },
    ],
  };
}
function step(
  path: PreparedWireStep['path'],
  group: PreparedWireStep['group'],
  payload: Record<string, any>,
): PreparedWireStep {
  return { path, group, method: 'POST', payload };
}

export function preparedWireMediaRequirements(
  document: PreparedDocument,
  options: { includeDescription?: boolean } = {},
) {
  const entries: {
    media: PreparedMedia;
    role: PreparedWireImageRole;
    scene: 'normal' | 'desc';
    ratio?: '1:1' | '3:4';
  }[] = [
    { media: document.cover, role: 'cover', scene: 'normal', ratio: '1:1' },
    ...document.gallery.map((media) => ({
      media,
      role: 'gallery' as const,
      scene: 'normal' as const,
      ratio: '3:4' as const,
    })),
    ...(options.includeDescription === false
      ? []
      : document.description.flatMap((block) =>
          block.type === 'image'
            ? [
                {
                  media: block.image,
                  role: 'description' as const,
                  scene: 'desc' as const,
                },
              ]
            : [],
        )),
    ...document.models.flatMap((model) =>
      model.image
        ? [
            {
              media: model.image,
              role: 'variation' as const,
              scene: 'normal' as const,
              ratio: '1:1' as const,
            },
          ]
        : [],
    ),
  ];
  return [
    ...new Map(entries.map((entry) => [entry.role + ':' + entry.media.importId, entry])).values(),
  ];
}
function resolve(media: PreparedMedia, role: PreparedWireImageRole, context: PreparedWireContext) {
  if (
    !z.string().uuid().safeParse(media.importId).success ||
    !/^[a-f0-9]{64}$/.test(media.sha256) ||
    !['image/png', 'image/jpeg'].includes(media.mime)
  )
    fail('MEDIA_INVALID', role);
  positiveInt(media.width, role + '.width');
  positiveInt(media.height, role + '.height');
  if ((role === 'cover' || role === 'variation') && media.width !== media.height)
    fail('MEDIA_RATIO', role);
  if (role === 'gallery' && media.width * 4 !== media.height * 3) fail('MEDIA_RATIO', role);
  const found = context.images.filter(
    (r) => r.importId === media.importId && r.sha256 === media.sha256 && r.role === role,
  );
  if (found.length !== 1 || !imageId.safeParse(found[0]!.imageId).success)
    fail('MEDIA_BINDING_REQUIRED', role);
  return found[0]!.imageId;
}
function range(value: number, name: string, context: PreparedWireContext) {
  const bounds = context.limits[name];
  if (
    !bounds ||
    typeof bounds.min_limit !== 'number' ||
    typeof bounds.max_limit !== 'number' ||
    !Number.isFinite(bounds.min_limit) ||
    !Number.isFinite(bounds.max_limit) ||
    bounds.min_limit > bounds.max_limit
  )
    fail('LIMIT_UNVERIFIED', name);
  if (value < bounds.min_limit || value > bounds.max_limit) fail('LIMIT_EXCEEDED', name);
}
function stringLimit(value: string, name: string, context: PreparedWireContext) {
  // Conservative across code-point/UTF-16 interpretations; no content rewriting.
  range([...value].length, name, context);
  range(value.length, name, context);
}
function structure(document: PreparedDocument) {
  text.parse(document.sourceKey);
  text.parse(document.title);
  if (
    document.publication !== 'unlisted' ||
    !Array.isArray(document.models) ||
    !document.models.length ||
    document.models.length > 50 ||
    document.tierNames.length > 2
  )
    fail('STRUCTURE_UNSUPPORTED', 'models');
  if (!document.tierNames.length && (document.models.length !== 1 || document.models[0]!.image))
    fail('UNTIERED_IMAGE_OR_MODELS_UNSUPPORTED', 'models');
  if (
    new Set(document.models.map((m) => m.sku)).size !== document.models.length ||
    new Set(document.models.map((m) => canonicalJson(m.tierIndex))).size !==
      document.models.length ||
    new Set(document.tierNames).size !== document.tierNames.length
  )
    fail('DUPLICATE_IDENTITY', 'models');
  for (const [index, model] of document.models.entries()) {
    if (isMissingPendingSku(model.sku)) fail('MISSING_VARIANT_SKU', `models.${index}.sku`);
    if (
      !model.sku ||
      model.sku.length > 100 ||
      model.tierIndex.length !== document.tierNames.length ||
      model.optionLabels.length !== document.tierNames.length
    )
      fail('MODEL_MAPPING_INVALID', model.sku);
    model.tierIndex.forEach((i) => int.parse(i));
    price(model.originalPrice);
    int.parse(model.stock);
    const modelShipping = validatePreparedModelShipping(model);
    if (
      !document.tierNames.length &&
      (modelShipping.weightGrams !== undefined || modelShipping.dimensionCm !== undefined)
    )
      fail('UNTIERED_MODEL_SHIPPING_UNSUPPORTED', model.sku);
  }
  return document.tierNames.map((name, tier) => {
    const options = new Map<number, { label: string; image?: PreparedMedia }>();
    for (const model of document.models) {
      const index = model.tierIndex[tier]!,
        label = model.optionLabels[tier]!;
      text.parse(label);
      const prior = options.get(index);
      if (prior && prior.label !== label) fail('MODEL_MAPPING_INVALID', 'tierIndex');
      if (tier === 0 && prior && !same(prior.image ?? null, model.image ?? null))
        fail('OPTION_IMAGE_CONFLICT', model.sku);
      options.set(index, { label, ...(tier === 0 && model.image ? { image: model.image } : {}) });
    }
    const sorted = [...options].sort(([a], [b]) => a - b);
    if (
      sorted.some(([index], i) => index !== i) ||
      new Set(sorted.map(([, o]) => o.label)).size !== sorted.length
    )
      fail('MODEL_MAPPING_INVALID', 'tierIndex');
    const withImage = sorted.filter(([, o]) => !!o.image).length;
    if (withImage && withImage !== sorted.length)
      fail('OPTION_IMAGE_INCOMPLETE', 'variationImages');
    return { name, options: sorted.map(([, option]) => option) };
  });
}
function description(document: PreparedDocument, context: PreparedWireContext) {
  if (!document.description.length) fail('DESCRIPTION_REQUIRED', 'description');
  const images = document.description.filter((b) => b.type === 'image');
  const value = document.description
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!images.length) {
    stringLimit(value, 'item_description_length_limit', context);
    return { description_type: 'normal', description: value };
  }
  if (!context.capabilities.extendedDescription) {
    if (context.descriptionMode === 'plain_fallback') {
      stringLimit(value, 'item_description_length_limit', context);
      return { description_type: 'normal', description: value };
    }
    fail('CAPABILITY_UNVERIFIED', 'extendedDescription');
  }
  const limits = context.limits.extended_description_limit;
  const keys = [
    'description_text_length_min',
    'description_text_length_max',
    'description_image_num_min',
    'description_image_num_max',
    'description_image_width_min',
    'description_image_height_min',
    'description_image_aspect_ratio_min',
    'description_image_aspect_ratio_max',
  ];
  if (
    !limits ||
    keys.some(
      (key) => typeof limits[key] !== 'number' || !Number.isFinite(limits[key]) || limits[key] < 0,
    )
  )
    fail('LIMIT_UNVERIFIED', 'extended_description_limit');
  if (
    [...value].length < limits.description_text_length_min ||
    value.length > limits.description_text_length_max ||
    images.length < limits.description_image_num_min ||
    images.length > limits.description_image_num_max
  )
    fail('LIMIT_EXCEEDED', 'extended_description_limit');
  for (const image of images)
    if (
      image.image.width < limits.description_image_width_min ||
      image.image.height < limits.description_image_height_min ||
      image.image.width / image.image.height < limits.description_image_aspect_ratio_min ||
      image.image.width / image.image.height > limits.description_image_aspect_ratio_max
    )
      fail('LIMIT_EXCEEDED', 'description.image');
  return {
    description_type: 'extended',
    description_info: {
      extended_description: {
        field_list: document.description.map((block) =>
          block.type === 'text'
            ? { field_type: 'text', text: block.text }
            : {
                field_type: 'image',
                image_info: { image_id: resolve(block.image, 'description', context) },
              },
        ),
      },
    },
  };
}
function gallery(document: PreparedDocument, context: PreparedWireContext) {
  if (!context.capabilities.gallery34) fail('CAPABILITY_UNVERIFIED', 'gallery34');
  range(document.gallery.length, 'item_image_count_limit', context);
  const ids = document.gallery.map((media) => resolve(media, 'gallery', context));
  if (new Set(ids).size !== ids.length) fail('DUPLICATE_IDENTITY', 'gallery');
  return { image_ratio: '3:4', image_id_list: ids };
}
function attributes(document: PreparedDocument, context: PreparedWireContext) {
  const selected = Object.entries(document.attributes).map(([attribute, values]) => {
    if (!values.length || new Set(values).size !== values.length)
      fail('ATTRIBUTE_INVALID', attribute);
    return {
      attribute_id: id(attribute, 'attribute_id'),
      attribute_value_list: values.map((value) => ({ value_id: id(value, 'value_id', true) })),
    };
  });
  if (!selected.length && context.attributeList === undefined) return [];
  const schema = z.array(
    z
      .object({
        attribute_id: int.min(1),
        attribute_value_list: z
          .array(
            z
              .object({
                value_id: int,
                original_value_name: z.string().optional(),
                value_unit: z.string().optional(),
              })
              .strict()
              .refine(
                (value) => value.value_id !== 0 || Boolean(value.original_value_name?.trim()),
                'Custom value_id 0 requires original_value_name',
              ),
          )
          .min(1),
      })
      .strict(),
  );
  const resolved = schema.safeParse(context.attributeList);
  if (!resolved.success) fail('ATTRIBUTE_CONTEXT_REQUIRED', 'attributeList');
  const identity = (rows: typeof selected) =>
    rows
      .map((row) => ({
        attribute_id: row.attribute_id,
        attribute_value_list: row.attribute_value_list.map((value) => ({
          value_id: value.value_id,
        })),
      }))
      .sort((a, b) => a.attribute_id - b.attribute_id);
  if (!same(identity(resolved.data), identity(selected)))
    fail('ATTRIBUTE_SELECTION_MISMATCH', 'attributeList');
  return resolved.data;
}
function stock(sku: string, amount: number, context: PreparedWireContext) {
  int.parse(amount);
  range(amount, 'stock_limit', context);
  if (!Object.hasOwn(context.stockLocationBySku, sku)) fail('STOCK_LOCATION_REQUIRED', sku);
  const location = context.stockLocationBySku[sku];
  if (location !== null && (typeof location !== 'string' || !location))
    fail('STOCK_LOCATION_REQUIRED', sku);
  return [{ stock: amount, ...(location === null ? {} : { location_id: location }) }];
}
function channelRelationRules(value: unknown, channelId: string): Record<string, number[]>[] {
  if (value === undefined) return [];
  // The API documents an array; actual channel metadata can contain one object.
  const candidates = Array.isArray(value) ? value : [value];
  const known = new Set([
    'related_enabled_channels',
    'related_disabled_channels',
    'related_dependent_block_channels',
  ]);
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      fail('LOGISTICS_RELATION_UNVERIFIED', channelId);
    const rule: Record<string, number[]> = {};
    for (const [key, ids] of Object.entries(candidate)) {
      if (!Array.isArray(ids)) fail('LOGISTICS_RELATION_UNVERIFIED', channelId);
      if (!known.has(key)) {
        if (ids.length) fail('LOGISTICS_RELATION_UNVERIFIED', channelId);
        continue;
      }
      if (
        ids.some(
          (entry) => typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry <= 0,
        ) ||
        new Set(ids).size !== ids.length
      )
        fail('LOGISTICS_RELATION_UNVERIFIED', channelId);
      rule[key] = ids;
    }
    return rule;
  });
}
function shipping(document: PreparedDocument, context: PreparedWireContext) {
  const dimensions = {
    package_length: positiveInt(document.dimensionCm.length, 'length'),
    package_width: positiveInt(document.dimensionCm.width, 'width'),
    package_height: positiveInt(document.dimensionCm.height, 'height'),
  };
  if (!Number.isFinite(document.weightGrams) || document.weightGrams <= 0)
    fail('WEIGHT_INVALID', 'weightGrams');
  if (
    !document.logistics.some((c) => c.enabled) ||
    new Set(document.logistics.map((c) => c.channelId)).size !== document.logistics.length
  )
    fail('LOGISTICS_INVALID', 'logistics');
  const prior = (context.baseline?.item.logistic_info ?? []) as Record<string, any>[];
  const logistics = document.logistics.map((channel) => {
    const metadata = context.channelInfoById?.[channel.channelId];
    if (
      !metadata ||
      !['SIZE_SELECTION', 'SIZE_INPUT', 'FIXED_DEFAULT_PRICE', 'CUSTOM_PRICE'].includes(
        metadata.fee_type,
      )
    )
      fail('LOGISTICS_CONTEXT_REQUIRED', channel.channelId);
    if (channel.enabled && metadata.enabled !== true)
      fail('CHANNEL_UNAVAILABLE', channel.channelId);
    // Product creation preparation, section 7: fulfillment IDs are not product choices.
    if (channel.enabled && metadata.mask_channel_id !== 0)
      fail('CHANNEL_NOT_PRODUCT_SELECTABLE', channel.channelId);
    if (!channel.enabled && metadata.force_enable === true)
      fail('CHANNEL_FORCE_ENABLED', channel.channelId);
    const rules = channelRelationRules(metadata.channel_relation_rules, channel.channelId);
    const isEnabled = (related: number) =>
      document.logistics.some(
        (candidate) => candidate.enabled && candidate.channelId === String(related),
      );
    for (const rule of rules) {
      if (channel.enabled) {
        if ((rule.related_enabled_channels ?? []).some((related) => !isEnabled(related)))
          fail('LOGISTICS_RELATED_CHANNEL_REQUIRED', channel.channelId);
        if ((rule.related_disabled_channels ?? []).some(isEnabled))
          fail('LOGISTICS_RELATED_CHANNEL_MUST_BE_DISABLED', channel.channelId);
      } else if ((rule.related_dependent_block_channels ?? []).some(isEnabled)) {
        fail('LOGISTICS_DEPENDENT_CHANNEL_MUST_BE_DISABLED', channel.channelId);
      }
    }
    const previous = prior.find((row) => String(row.logistic_id) === channel.channelId);
    const preserved = Object.fromEntries(
      ['is_free', 'size_id', 'shipping_fee'].flatMap((key) =>
        previous && Object.hasOwn(previous, key) ? [[key, previous[key]]] : [],
      ),
    );
    if (metadata.fee_type === 'SIZE_SELECTION' && !Object.hasOwn(preserved, 'size_id'))
      fail('LOGISTICS_SIZE_REQUIRED', channel.channelId);
    if (metadata.fee_type === 'CUSTOM_PRICE' && !Object.hasOwn(preserved, 'shipping_fee'))
      fail('LOGISTICS_FEE_REQUIRED', channel.channelId);
    const weight = preparedWeightKilograms(document.weightGrams);
    if (channel.enabled) {
      const max = metadata.weight_limit?.item_max_weight,
        min = metadata.weight_limit?.item_min_weight;
      if (
        (typeof max === 'number' && max > 0 && weight > max) ||
        (typeof min === 'number' && min > 0 && weight < min)
      )
        fail('LOGISTICS_WEIGHT_LIMIT', channel.channelId);
      const limit = metadata.item_max_dimension;
      if (
        limit &&
        limit.unit &&
        limit.unit.toLowerCase() !== 'cm' &&
        !['height', 'width', 'length', 'dimension_sum'].every((key) => limit[key] === 0)
      )
        fail('LOGISTICS_UNIT_UNVERIFIED', channel.channelId);
      if (
        limit &&
        (['length', 'width', 'height'] as const).some(
          (key) =>
            typeof limit[key] === 'number' &&
            limit[key] > 0 &&
            document.dimensionCm[key] > limit[key],
        )
      )
        fail('LOGISTICS_DIMENSION_LIMIT', channel.channelId);
      if (
        limit?.dimension_sum > 0 &&
        Object.values(document.dimensionCm).reduce((a, b) => a + b, 0) > limit.dimension_sum
      )
        fail('LOGISTICS_DIMENSION_LIMIT', channel.channelId);
      if (
        metadata.volume_limit &&
        Object.values(metadata.volume_limit).some((n) => typeof n === 'number' && n > 0)
      )
        fail('LOGISTICS_VOLUME_UNIT_UNVERIFIED', channel.channelId);
    }
    return {
      logistic_id: id(channel.channelId, 'logistic_id'),
      enabled: channel.enabled,
      ...preserved,
    };
  });
  return {
    weight: preparedWeightKilograms(document.weightGrams),
    dimension: dimensions,
    logistic_info: logistics,
  };
}
function gtin(sku: string, context: PreparedWireContext) {
  const rule =
    context.limits.gtin_limit?.gtin_validation_rule ?? context.limits.gtin_validation_rule;
  if (!['Optional', 'Flexible', 'Mandatory'].includes(rule))
    fail('LIMIT_UNVERIFIED', 'gtin_validation_rule');
  const value = context.gtinBySku?.[sku];
  if (value === undefined) {
    if (rule !== 'Optional') fail('GTIN_REQUIRED', sku);
    return {};
  }
  if (!/^\d{8,14}$/.test(value) && !(value === '00' && rule !== 'Mandatory'))
    fail('GTIN_INVALID', sku);
  return { gtin_code: value };
}
export function planPreparedWireCreate(
  document: PreparedDocument,
  context: PreparedWireContext,
): PreparedWirePlan {
  try {
    const tiers = structure(document);
    if (
      !context.brandName ||
      !['NEW', 'USED'].includes(context.condition ?? '') ||
      !context.preOrder ||
      typeof context.preOrder.is_pre_order !== 'boolean'
    )
      fail('BUSINESS_CHOICE_REQUIRED', 'brandName/condition/preOrder');
    const sizeChart = context.limits.size_chart_limit;
    const sizeChartUnsupported =
      sizeChart &&
      typeof sizeChart === 'object' &&
      !Array.isArray(sizeChart) &&
      !Object.hasOwn(sizeChart, 'size_chart_mandatory') &&
      sizeChart.support_image_size_chart === false &&
      sizeChart.support_template_size_chart === false;
    if (sizeChart?.size_chart_mandatory !== false && !sizeChartUnsupported)
      fail('SIZE_CHART_UNVERIFIED', 'size_chart_limit');
    if (context.preOrder.is_pre_order) {
      positiveInt(context.preOrder.days_to_ship, 'days_to_ship');
      const dts = context.limits.dts_limit?.days_to_ship_limit;
      if (
        !dts ||
        context.preOrder.days_to_ship! < dts.min_limit ||
        context.preOrder.days_to_ship! > dts.max_limit
      )
        fail('DTS_LIMIT_UNVERIFIED', 'days_to_ship');
    }
    stringLimit(document.title, 'item_name_length_limit', context);
    const models = document.models.map((model) => {
      range(price(model.originalPrice), 'price_limit', context);
      const modelShipping = validatePreparedModelShipping(model);
      const resolvedShipping =
        modelShipping.weightGrams === undefined
          ? undefined
          : shipping(
              {
                ...document,
                weightGrams: modelShipping.weightGrams,
                dimensionCm: modelShipping.dimensionCm ?? document.dimensionCm,
              },
              context,
            );
      return {
        tier_index: [...model.tierIndex],
        model_sku: model.sku,
        original_price: price(model.originalPrice),
        seller_stock: stock(model.sku, model.stock, context),
        ...gtin(model.sku, context),
        ...(resolvedShipping ? { weight: resolvedShipping.weight } : {}),
        ...(modelShipping.dimensionCm ? { dimension: resolvedShipping!.dimension } : {}),
      };
    });
    const first = models[0]!;
    const payload = {
      item_name: document.title,
      item_sku: tiers.length ? document.sourceKey : first.model_sku,
      item_status: 'UNLIST',
      category_id: id(document.categoryId, 'category_id'),
      original_price: first.original_price,
      seller_stock: first.seller_stock,
      ...gtin(first.model_sku, context),
      ...description(document, context),
      image: gallery(document, context),
      promotion_images: { image_id_list: [resolve(document.cover, 'cover', context)] },
      brand: {
        brand_id: id(document.brandId, 'brand_id', true),
        original_brand_name: context.brandName,
      },
      condition: context.condition,
      pre_order: z
        .object({ is_pre_order: z.boolean(), days_to_ship: int.min(1).optional() })
        .strict()
        .parse(context.preOrder),
      attribute_list: attributes(document, context),
      ...shipping(document, context),
    };
    const steps = [step('/api/v2/product/add_item', 'create', payload)];
    if (tiers.length) {
      const standard = tiers.map((tier) => {
        stringLimit(tier.name, 'tier_variation_name_length_limit', context);
        return {
          variation_id: 0,
          variation_name: tier.name,
          variation_option_list: tier.options.map((option) => {
            stringLimit(option.label, 'tier_variation_option_length_limit', context);
            return {
              variation_option_id: 0,
              variation_option_name: option.label,
              ...(option.image ? { image_id: resolve(option.image, 'variation', context) } : {}),
            };
          }),
        };
      });
      steps.push({
        ...step('/api/v2/product/init_tier_variation', 'variations', {
          item_id: PREPARED_CREATED_ITEM_ID,
          standardise_tier_variation: standard,
          model: models,
        }),
        minDelayAfterCreateMs: 5000,
      });
    }
    return { kind: 'ready', operation: 'create', steps };
  } catch (error) {
    return blocked(error);
  }
}

function checkUpdateSelection(
  baseline: PreparedRemote,
  expected: PreparedRemote,
  fields: PreparedField[],
  selected: string[],
) {
  if (
    !fields.length ||
    new Set(fields).size !== fields.length ||
    new Set(selected).size !== selected.length ||
    selected.some((sku) => !baseline.document.models.some((m) => m.sku === sku))
  )
    fail('SELECTION_INVALID', 'fields/selectedSkus');
  const copy = structuredClone(baseline);
  for (const field of fields) {
    if (['price', 'stock', 'variationImages'].includes(field))
      for (const sku of selected) {
        const before = copy.document.models.find((m) => m.sku === sku)!,
          after = expected.document.models.find((m) => m.sku === sku);
        if (!after) fail('MODEL_MAPPING_INVALID', sku);
        if (field === 'price') before.originalPrice = after.originalPrice;
        if (field === 'stock') before.stock = after.stock;
        if (field === 'variationImages') {
          if (after.image) before.image = structuredClone(after.image);
          else delete before.image;
        }
      }
    else if (field === 'logistics') {
      copy.document.logistics = expected.document.logistics;
      copy.document.weightGrams = expected.document.weightGrams;
      copy.document.dimensionCm = expected.document.dimensionCm;
    } else if (['title', 'description', 'cover', 'gallery', 'attributes'].includes(field))
      (copy.document as any)[field] = (expected.document as any)[field];
    else fail('SELECTION_INVALID', field);
  }
  if (!same(copy, expected)) fail('UNSELECTED_CHANGE', 'expected');
}
export function planPreparedWireUpdate(
  baseline: PreparedRemote,
  expected: PreparedRemote,
  fields: PreparedField[],
  selectedSkus: string[],
  context: PreparedWireContext,
): PreparedWirePlan {
  try {
    checkUpdateSelection(baseline, expected, fields, selectedSkus);
    const tiers = structure(expected.document);
    // update_item weight/dimension overwrites all model shipping (announcement908).
    // A dedicated model update plan is required before permitting this group on overrides.
    if (
      fields.includes('logistics') &&
      baseline.document.models.some(
        (model) => model.weightGrams !== undefined || model.dimensionCm !== undefined,
      )
    )
      fail('MODEL_SHIPPING_UPDATE_UNSUPPORTED', 'logistics');
    const itemId = id(baseline.itemId, 'item_id');
    const raw = context.baseline;
    if (!raw || id(raw.item.item_id, 'baseline.item_id') !== itemId)
      fail('BASELINE_REQUIRED', 'baseline');
    normalizePreparedWireSnapshot(raw);
    if (fields.includes('price')) {
      // Wholesale prices impose additional ratio and cross-model requirements. This codec
      // does not yet model those rules; do not dispatch a price change under an unknown rule.
      // get_item_base_info reports the tier list as `wholesales` (plural), never `wholesale`.
      if (
        raw.item.wholesales !== undefined &&
        (!Array.isArray(raw.item.wholesales) || raw.item.wholesales.length)
      )
        fail('WHOLESALE_PRICE_UNSUPPORTED', 'wholesales');
      const promotions = z
        .object({
          error: z.literal(''),
          response: z
            .object({
              success_list: z
                .array(
                  z
                    .object({
                      item_id: z.union([int.min(1), z.string()]),
                      promotion: z.array(record),
                    })
                    .passthrough(),
                )
                .length(1),
              failure_list: z.array(record).optional(),
            })
            .passthrough(),
        })
        .passthrough()
        .safeParse(context.promotionSnapshot);
      if (
        !promotions.success ||
        (promotions.data.response.failure_list?.length ?? 0) !== 0 ||
        id(promotions.data.response.success_list[0]!.item_id, 'promotion.item_id') !== itemId ||
        promotions.data.response.success_list[0]!.promotion.length !== 0
      )
        fail('PROMOTION_UNRESOLVED', 'get_item_promotion');
    }
    if (raw.item.has_model !== tiers.length > 0) fail('MODEL_MAPPING_INVALID', 'has_model');
    for (const binding of baseline.modelBindings) {
      const source = baseline.document.models.find((m) => m.sku === binding.sku);
      if (!source || !same(source.tierIndex, binding.tierIndex))
        fail('MODEL_MAPPING_INVALID', binding.sku);
      if (tiers.length) {
        const model = raw.models.model.find((m) => String(m.model_id) === binding.modelId);
        if (!model || model.model_sku !== binding.sku || !same(model.tier_index, binding.tierIndex))
          fail('MODEL_MAPPING_INVALID', binding.sku);
      } else if (binding.modelId !== '0' || raw.item.item_sku !== binding.sku)
        fail('MODEL_MAPPING_INVALID', binding.sku);
    }
    if (
      baseline.modelBindings.length !== baseline.document.models.length ||
      new Set(baseline.modelBindings.map((m) => m.modelId)).size !==
        baseline.modelBindings.length ||
      new Set(baseline.modelBindings.map((m) => m.sku)).size !== baseline.modelBindings.length
    )
      fail('MODEL_MAPPING_INVALID', 'modelBindings');
    const steps: PreparedWireStep[] = [];
    for (const field of fields) {
      const document = expected.document;
      let payload: Record<string, any> = { item_id: itemId };
      if (field === 'title') {
        stringLimit(document.title, 'item_name_length_limit', context);
        payload.item_name = document.title;
      }
      if (field === 'description') Object.assign(payload, description(document, context));
      if (field === 'gallery') {
        payload.image = gallery(document, context);
        const cover = (raw.item.promotion_image as any)?.image_id_list;
        const oldImage = raw.item.image as any;
        // Live sandbox evidence on 14 September replaced the cover content during a
        // 1:1 -> 3:4 transition despite the exact old promotion_images ID in the request.
        // Keep that transition blocked until a dedicated recovery workflow is accepted.
        if (!Array.isArray(cover) || cover.length !== 1 || oldImage?.image_ratio !== '3:4')
          fail('COVER_BASELINE_REQUIRED', 'promotion_image');
        payload.promotion_images = {
          image_id_list:
            fields.indexOf('cover') < fields.indexOf('gallery') && fields.includes('cover')
              ? [resolve(document.cover, 'cover', context)]
              : [...cover],
        };
      }
      if (field === 'cover') {
        if ((raw.item.image as any)?.image_ratio !== '3:4')
          fail('COVER_BASELINE_REQUIRED', 'image_ratio');
        payload.promotion_images = { image_id_list: [resolve(document.cover, 'cover', context)] };
      }
      if (field === 'attributes') payload.attribute_list = attributes(document, context);
      if (field === 'logistics') Object.assign(payload, shipping(document, context));
      if (field === 'variationImages') {
        if (!tiers.length || !selectedSkus.length)
          fail('VARIATION_IMAGE_UNSUPPORTED', 'variationImages');
        // update_tier_variation sends the complete model_list. Omitting a remote model can
        // delete it, so local source bindings must cover the entire observed remote listing.
        if (
          !same(
            raw.models.model.map((m) => String(m.model_id)).sort(),
            baseline.modelBindings.map((m) => m.modelId).sort(),
          )
        )
          fail('MODEL_COVERAGE_INCOMPLETE', 'modelBindings');
        const standard = z.array(record).safeParse(raw.models.standardise_tier_variation);
        if (!standard.success || standard.data.length !== tiers.length)
          fail('STANDARD_TIERS_REQUIRED', 'standardise_tier_variation');
        const serialized = standard.data.map((tier, index) => {
          if (
            tier.variation_name !== tiers[index]!.name ||
            !Array.isArray(tier.variation_option_list) ||
            tier.variation_option_list.length !== tiers[index]!.options.length
          )
            fail('MODEL_MAPPING_INVALID', 'standardise_tier_variation');
          return {
            variation_id: id(tier.variation_id, 'variation_id', true),
            variation_name: tier.variation_name,
            ...(tier.variation_group_id === undefined
              ? {}
              : { variation_group_id: id(tier.variation_group_id, 'variation_group_id', true) }),
            variation_option_list: tier.variation_option_list.map((option: any, i: number) => {
              const source = tiers[index]!.options[i]!;
              if (source.label !== option.variation_option_name)
                fail('MODEL_MAPPING_INVALID', 'option');
              const selected =
                index === 0 &&
                document.models.some((m) => m.tierIndex[0] === i && selectedSkus.includes(m.sku));
              const selectedId = selected
                ? source.image
                  ? resolve(source.image, 'variation', context)
                  : fail('IMAGE_REMOVAL_UNVERIFIED', 'variationImages')
                : option.image_id;
              return {
                variation_option_id: id(option.variation_option_id, 'variation_option_id', true),
                variation_option_name: option.variation_option_name,
                ...(selectedId === undefined ? {} : { image_id: imageId.parse(selectedId) }),
              };
            }),
          };
        });
        payload = {
          item_id: itemId,
          standardise_tier_variation: serialized,
          model_list: baseline.modelBindings.map((m) => ({
            model_id: id(m.modelId, 'model_id'),
            tier_index: [...m.tierIndex],
          })),
        };
        steps.push(step('/api/v2/product/update_tier_variation', field, payload));
        continue;
      }
      if (field === 'price' || field === 'stock') {
        if (!selectedSkus.length) fail('SELECTION_INVALID', 'selectedSkus');
        const list = selectedSkus.map((sku) => {
          const binding = baseline.modelBindings.find((b) => b.sku === sku)!,
            desired = document.models.find((m) => m.sku === sku)!;
          const remote = tiers.length
            ? raw.models.model.find((m) => String(m.model_id) === binding.modelId)!
            : raw.item;
          if (field === 'price') {
            if (remote.has_promotion !== false || raw.item.has_promotion !== false)
              fail('PROMOTION_UNRESOLVED', sku);
            range(price(desired.originalPrice), 'price_limit', context);
            return {
              model_id: id(binding.modelId, 'model_id', true),
              original_price: price(desired.originalPrice),
            };
          }
          const rows = (remote.stock_info_v2 as any)?.seller_stock;
          if (
            !Array.isArray(rows) ||
            rows.length !== 1 ||
            ((remote.stock_info_v2 as any)?.shopee_stock ?? []).some(
              (r: any) => Number(r.stock) !== 0,
            )
          )
            fail('STOCK_STRUCTURE_UNSUPPORTED', sku);
          const seller = stock(sku, desired.stock, context);
          if ((rows[0].location_id || null) !== context.stockLocationBySku[sku])
            fail('STOCK_LOCATION_CHANGED', sku);
          const reserved = (remote.stock_info_v2 as any)?.summary_info?.total_reserved_stock;
          if (!Number.isSafeInteger(reserved) || reserved < 0 || desired.stock < reserved)
            fail('RESERVED_STOCK_UNRESOLVED', sku);
          return { model_id: id(binding.modelId, 'model_id', true), seller_stock: seller };
        });
        steps.push({
          ...step(
            field === 'price' ? '/api/v2/product/update_price' : '/api/v2/product/update_stock',
            field,
            { item_id: itemId, [field === 'price' ? 'price_list' : 'stock_list']: list },
          ),
          expectedModelIds: selectedSkus.map(
            (sku) => baseline.modelBindings.find((m) => m.sku === sku)!.modelId,
          ),
        });
        continue;
      }
      steps.push(step('/api/v2/product/update_item', field, payload));
    }
    return { kind: 'ready', operation: 'update', steps };
  } catch (error) {
    return blocked(error);
  }
}
export function bindPreparedWireItem(step: PreparedWireStep, itemId: string): PreparedWireStep {
  const copy = structuredClone(step);
  if (copy.payload.item_id === PREPARED_CREATED_ITEM_ID)
    copy.payload.item_id = id(itemId, 'item_id');
  return copy;
}

/** Decodes acknowledgement only. It never treats a receipt as readback verification. */
export function inspectPreparedWireAcknowledgement(
  step: PreparedWireStep,
  response: unknown,
): PreparedWireAcknowledgement {
  const out: PreparedWireAcknowledgement = {
    success: false,
    kind: 'unknown',
    issues: [],
    successModelIds: [],
    failureModelIds: [],
  };
  try {
    if (
      ![
        '/api/v2/product/add_item',
        '/api/v2/product/init_tier_variation',
        '/api/v2/product/update_item',
        '/api/v2/product/update_tier_variation',
        '/api/v2/product/update_price',
        '/api/v2/product/update_stock',
      ].includes(step.path)
    )
      fail('ACK_PATH_INVALID', 'path');
    const envelope = z
      .object({ error: z.string(), request_id: text, response: z.unknown().optional() })
      .passthrough()
      .parse(response);
    if (envelope.error) out.kind = 'rejected';
    if (step.path.endsWith('/update_price') || step.path.endsWith('/update_stock')) {
      const body = z
        .object({
          success_list: z.array(record),
          failure_list: z.array(record).optional().default([]),
        })
        .parse(envelope.response);
      out.successModelIds = body.success_list.map((r) =>
        String(id(r.model_id, 'success.model_id', true)),
      );
      out.failureModelIds = body.failure_list.map((r) =>
        String(id(r.model_id, 'failure.model_id', true)),
      );
      const union = [...out.successModelIds, ...out.failureModelIds],
        expected = step.expectedModelIds;
      if (
        !expected?.length ||
        new Set(union).size !== union.length ||
        !same([...union].sort(), [...expected].sort())
      )
        fail('ACK_COVERAGE', 'model_ids');
      for (const success of body.success_list) {
        const request = (step.payload.price_list ?? step.payload.stock_list).find(
          (r: any) => String(r.model_id) === String(success.model_id),
        );
        if (
          step.path.endsWith('/update_price') &&
          success.original_price !== request.original_price
        )
          fail('ACK_VALUE_MISMATCH', 'original_price');
        if (
          step.path.endsWith('/update_stock') &&
          (success.stock !== request.seller_stock[0].stock ||
            (success.location_id || null) !== (request.seller_stock[0].location_id || null))
        )
          fail('ACK_VALUE_MISMATCH', 'seller_stock');
      }
      if (out.failureModelIds.length) {
        out.kind = 'rejected';
        return out;
      }
    } else if (
      step.path.endsWith('/add_item') ||
      step.path.endsWith('/init_tier_variation') ||
      step.path.endsWith('/update_item')
    ) {
      const body = record.parse(envelope.response),
        actual = String(id(body.item_id, 'response.item_id'));
      if (step.path.endsWith('/add_item')) out.createdItemId = actual;
      else if (actual !== String(step.payload.item_id)) fail('ACK_ITEM_MISMATCH', 'item_id');
      if (step.path.endsWith('/init_tier_variation')) {
        const models = z
          .array(
            z
              .object({ model_id: int.min(1), model_sku: text, tier_index: z.array(int) })
              .passthrough(),
          )
          .parse(body.model);
        const identity = (rows: { model_sku: string; tier_index: number[] }[]) =>
          rows
            .map((row) => ({ model_sku: row.model_sku, tier_index: row.tier_index }))
            .sort((a, b) => a.model_sku.localeCompare(b.model_sku));
        if (
          !same(identity(models), identity(step.payload.model)) ||
          new Set(models.map((m) => m.model_id)).size !== models.length
        )
          fail('ACK_COVERAGE', 'model');
        out.successModelIds = models.map((m) => String(m.model_id));
      }
    }
    if (envelope.error) return out;
    out.success = true;
    out.kind = 'acknowledged';
  } catch (error) {
    out.issues = (blocked(error) as Extract<PreparedWirePlan, { kind: 'blocked' }>).issues;
  }
  return out;
}

/** Comparable raw evidence, retaining every unknown field. Only known generated URL paths and
 * item.update_time are excluded. create_time, IDs, derived prices and stock summaries stay protected. */
export function normalizePreparedWireSnapshot(raw: FieldSnapshot): FieldSnapshot {
  const parsed = z
    .object({
      item: record,
      models: z.object({ model: z.array(record), tier_variation: z.array(record) }).passthrough(),
    })
    .strict()
    .parse(raw);
  const snapshot = structuredClone(parsed) as FieldSnapshot;
  const item: any = snapshot.item;
  id(item.item_id, 'item_id');
  if (typeof item.has_model !== 'boolean') fail('READBACK_INVALID', 'has_model');
  if (
    item.has_model !== snapshot.models.model.length > 0 ||
    (!item.has_model && snapshot.models.tier_variation.length)
  )
    fail('READBACK_INVALID', 'models');
  delete item.update_time;
  for (const key of ['image', 'promotion_image'])
    if (item[key]) {
      const image = record.parse(item[key]);
      if (image.image_id_list) z.array(imageId).parse(image.image_id_list);
      delete item[key].image_url_list;
    }
  for (const block of item.description_info?.extended_description?.field_list ?? [])
    if (block.field_type === 'image' && block.image_info) delete block.image_info.image_url;
  const models = snapshot.models.model as any[];
  if (new Set(models.map((m) => String(m.model_id))).size !== models.length)
    fail('READBACK_DUPLICATE', 'model_id');
  for (const model of models) {
    id(model.model_id, 'model_id');
    if (
      !Array.isArray(model.tier_index) ||
      model.tier_index.length !== snapshot.models.tier_variation.length
    )
      fail('READBACK_INVALID', 'tier_index');
    model.tier_index.forEach((i: unknown, tier: number) => {
      int.parse(i);
      if (!(snapshot.models.tier_variation[tier] as any)?.option_list?.[i as number])
        fail('READBACK_INVALID', 'tier_index');
    });
  }
  models.sort((a, b) => String(a.model_id).localeCompare(String(b.model_id)));
  for (const tier of snapshot.models.tier_variation as any[]) {
    text.parse(tier.name);
    if (!Array.isArray(tier.option_list)) fail('READBACK_INVALID', 'option_list');
    for (const option of tier.option_list) {
      text.parse(option.option);
      if (option.image) delete option.image.image_url;
    }
  }
  for (const tier of (snapshot.models.standardise_tier_variation ?? []) as any[])
    for (const option of tier.variation_option_list ?? []) delete option.image_url;
  for (const [key, identity] of [
    ['attribute_list', 'attribute_id'],
    ['logistic_info', 'logistic_id'],
  ] as const)
    if (item[key]) {
      if (!Array.isArray(item[key])) fail('READBACK_INVALID', key);
      if (new Set(item[key].map((r: any) => String(r[identity]))).size !== item[key].length)
        fail('READBACK_DUPLICATE', key);
      item[key].sort((a: any, b: any) => String(a[identity]).localeCompare(String(b[identity])));
    }
  return snapshot;
}
