import {
  canonicalJson,
  preparedWeightKilograms,
  type PreparedDocument,
  type PreparedMedia,
} from '@shopee/domain';
import type { FieldSnapshot } from './field-client.js';
import {
  normalizePreparedWireSnapshot,
  type PreparedWireContext,
  type PreparedWireImageRole,
  type PreparedWireStep,
} from './prepared-wire.js';

export type PreparedWireQc = { verified: boolean; mismatchedPaths: string[] };
type Row = Record<string, any>;
class Unsupported extends Error {
  constructor(readonly path: string) {
    super(path);
  }
}
const own = (o: any, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const object = (v: any): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
function requireQc(ok: unknown, path: string): asserts ok {
  if (!ok) throw new Unsupported(path);
}
function diff(a: any, b: any, path = '', out: string[] = [], ignore?: (path:string)=>boolean): string[] {
  if (ignore?.(path) || out.length >= 200 || Object.is(a, b)) return out;
  if (Array.isArray(a) !== Array.isArray(b) || object(a) !== object(b)) {
    out.push(path || 'snapshot');
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push((path ? path + '.' : '') + 'length');
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], path + '.' + i, out, ignore);
  } else if (object(a) && object(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = path ? path + '.' + key : key;
      if(ignore?.(p))continue;
      if (!own(a, key) || !own(b, key)) out.push(p);
      else diff(a[key], b[key], p, out, ignore);
    }
  } else out.push(path || 'snapshot');
  return out;
}
function finish(paths: string[]): PreparedWireQc {
  const mismatchedPaths = [...new Set(paths)];
  return { verified: !mismatchedPaths.length, mismatchedPaths };
}
function failure(error: unknown): PreparedWireQc {
  return finish([
    error instanceof Unsupported ? 'unsupported.' + error.path : 'unsupported.snapshot',
  ]);
}
function keys(row: any, allowed: string[], path: string) {
  requireQc(object(row) && Object.keys(row).every((k) => allowed.includes(k)), path);
}
function integer(n: any, min = 0): boolean {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
}
function numeric(value: any): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function numericLike(before: any, value: number) {
  return typeof before === 'string' ? String(value) : value;
}
function noPromotion(item: Row, target: Row, path: string) {
  requireQc(
    item.has_promotion === false &&
      target.has_promotion === false &&
      (!own(target, 'promotion_id') || numeric(target.promotion_id) === 0),
    path + '.promotion',
  );
}
function stockShape(target: Row, path: string): Row {
  requireQc(target.is_fulfillment_by_shopee !== true, path + '.is_fulfillment_by_shopee');
  const stock = target.stock_info_v2;
  requireQc(
    object(stock) && Array.isArray(stock.seller_stock) && stock.seller_stock.length === 1,
    path + '.stock_info_v2',
  );
  const seller = stock.seller_stock[0],
    summary = stock.summary_info;
  requireQc(
    object(seller) &&
      integer(seller.stock) &&
      seller.if_saleable !== false &&
      object(summary) &&
      summary.total_reserved_stock === 0 &&
      summary.total_available_stock === seller.stock,
    path + '.stock_info_v2.summary_info',
  );
  requireQc(
    Array.isArray(stock.shopee_stock) &&
      stock.shopee_stock.every((s: any) => object(s) && numeric(s.stock) === 0),
    path + '.stock_info_v2.shopee_stock',
  );
  // These two documented advance allocations must both be zero. Unknown allocation fields
  // cannot be silently treated as a zero balance.
  if (
    own(stock, 'advance_stock') &&
    !(Array.isArray(stock.advance_stock) && stock.advance_stock.length === 0)
  ) {
    keys(
      stock.advance_stock,
      ['sellable_advance_stock', 'in_transit_advance_stock'],
      path + '.stock_info_v2.advance_stock',
    );
    requireQc(
      stock.advance_stock.sellable_advance_stock === 0 &&
        stock.advance_stock.in_transit_advance_stock === 0,
      path + '.stock_info_v2.advance_stock',
    );
  }
  return stock;
}
function priceShape(item: Row, target: Row, path: string): Row {
  noPromotion(item, target, path);
  stockShape(target, path);
  requireQc(
    Array.isArray(target.price_info) && target.price_info.length === 1,
    path + '.price_info',
  );
  const p = target.price_info[0];
  requireQc(
    p.currency === 'VND' && integer(p.original_price, 1) && p.current_price === p.original_price,
    path + '.price_info',
  );
  for (const key of ['inflated_price_of_original_price', 'inflated_price_of_current_price'])
    requireQc(!own(p, key) || p[key] === p.original_price, path + '.price_info.' + key);
  return p;
}
function imageId(context: PreparedWireContext, media: PreparedMedia, role: PreparedWireImageRole) {
  const matches = context.images.filter(
    (i) => i.importId === media.importId && i.sha256 === media.sha256 && i.role === role,
  );
  requireQc(
    matches.length === 1 && typeof matches[0]!.imageId === 'string' && matches[0]!.imageId.length,
    'images.' + role,
  );
  return matches[0]!.imageId;
}
function sorted<T>(values: T[], key: (row: T) => string): T[] {
  return [...values].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Compares source fields against independently decoded raw API evidence. It does not use an
 * acknowledgement or a PreparedRemote echo as evidence. New server metadata has no create baseline. */
const imageComparisonPath=(path:string)=>
  /^item\.(image|promotion_image)\.(image_id_list|image_ratio)(\.|$)/.test(path)||
  /^item\.description_info\.extended_description\.field_list\.\d+\.image_info(\.|$)/.test(path)||
  /^models\.tier_variation\.\d+\.option_list\.\d+\.image(\.|$)/.test(path)||
  /^models\.standardise_tier_variation\.\d+\.variation_option_list\.\d+\.image_id$/.test(path);
export function checkPreparedWireCreate(document:PreparedDocument,context:PreparedWireContext,raw:FieldSnapshot):PreparedWireQc {
  return checkPreparedWireCreateFields(document,context,raw);
}
/** This intentionally cannot report full verification. Only a scoped hidden deferral may use it. */
export function checkPreparedWireCreateWithoutImages(document:PreparedDocument,context:PreparedWireContext,raw:FieldSnapshot) {
  const result=checkPreparedWireCreateFields(document,context,raw,true);
  return {coreVerified:result.verified,mismatchedPaths:result.mismatchedPaths};
}
function checkPreparedWireCreateFields(
  document: PreparedDocument,
  context: PreparedWireContext,
  raw: FieldSnapshot,
  deferImages = false,
): PreparedWireQc {
  try {
    const snapshot = normalizePreparedWireSnapshot(raw),
      item = snapshot.item as Row,
      paths: string[] = [];
    const check = (expected: any, actual: any, path: string) => {
      diff(expected, actual, path, paths, deferImages ? imageComparisonPath : undefined);
    };
    requireQc(
      document.models.length &&
        document.tierNames.length <= 2 &&
        (document.tierNames.length > 0 || document.models.length === 1),
      'source.models',
    );
    requireQc(
      context.brandName && context.condition && context.preOrder,
      'source.business_context',
    );
    check(document.title, item.item_name, 'item.item_name');
    check(document.categoryId, String(item.category_id), 'item.category_id');
    check(document.brandId, String(item.brand?.brand_id), 'item.brand.brand_id');
    check(context.brandName, item.brand?.original_brand_name, 'item.brand.original_brand_name');
    check(context.condition, item.condition, 'item.condition');
    for (const [key, value] of Object.entries(context.preOrder))
      check(value, item.pre_order?.[key], 'item.pre_order.' + key);
    check(
      document.publication === 'unlisted' ? 'UNLIST' : undefined,
      item.item_status,
      'item.item_status',
    );
    check(document.tierNames.length > 0, item.has_model, 'item.has_model');
    check(
      document.tierNames.length ? document.sourceKey : document.models[0]!.sku,
      item.item_sku,
      'item.item_sku',
    );
    const modelWeight = document.models.some((model) => model.weightGrams !== undefined);
    const modelDimensions = document.models.some((model) => model.dimensionCm !== undefined);
    // Announcement 908: with model-level shipping, transitional item fields represent the
    // maximum weight / whole largest-volume dimension tuple; later item fields may be omitted.
    if (!modelWeight || own(item, 'weight'))
      check(
        modelWeight
          ? Math.max(
              ...document.models.map((model) =>
                preparedWeightKilograms(model.weightGrams ?? document.weightGrams),
              ),
            )
          : preparedWeightKilograms(document.weightGrams),
        numeric(item.weight),
        'item.weight',
      );
    if (!modelDimensions || own(item, 'dimension')) {
      const choices = modelDimensions
        ? document.models.map((model) => model.dimensionCm ?? document.dimensionCm)
        : [document.dimensionCm];
      const volume = (d: typeof document.dimensionCm) => d.length * d.width * d.height;
      const maximum = Math.max(...choices.map(volume));
      const tuples = choices.filter((d) => volume(d) === maximum);
      requireQc(
        new Set(tuples.map((d) => canonicalJson(d))).size === 1,
        'item.dimension.ambiguous_volume',
      );
      for (const dimension of ['length', 'width', 'height'] as const)
        check(
          tuples[0]![dimension],
          item.dimension?.['package_' + dimension],
          'item.dimension.package_' + dimension,
        );
    }
    check(
      document.gallery.map((media) => imageId(context, media, 'gallery')),
      item.image?.image_id_list,
      'item.image.image_id_list',
    );
    check('3:4', item.image?.image_ratio, 'item.image.image_ratio');
    check(
      [imageId(context, document.cover, 'cover')],
      item.promotion_image?.image_id_list,
      'item.promotion_image.image_id_list',
    );
    check('1:1', item.promotion_image?.image_ratio, 'item.promotion_image.image_ratio');
    const extended = document.description.some((block) => block.type === 'image');
    check(extended ? 'extended' : 'normal', item.description_type, 'item.description_type');
    if (extended) {
      const fields = document.description.map((block) =>
        block.type === 'text'
          ? { field_type: 'text', text: block.text }
          : {
              field_type: 'image',
              image_info: { image_id: imageId(context, block.image, 'description') },
            },
      );
      const actual = item.description_info?.extended_description?.field_list;
      requireQc(Array.isArray(actual), 'item.description_info');
      check(
        fields,
        actual.map((block: any) =>
          block.field_type === 'text'
            ? { field_type: block.field_type, text: block.text }
            : {
                field_type: block.field_type,
                image_info: { image_id: block.image_info?.image_id },
              },
        ),
        'item.description_info.extended_description.field_list',
      );
    } else
      check(
        document.description.map((block) => (block.type === 'text' ? block.text : '')).join(''),
        item.description,
        'item.description',
      );
    const attrs = item.attribute_list;
    requireQc(Array.isArray(attrs), 'item.attribute_list');
    const identity = (rows: any[]) =>
      sorted(
        rows.map((row) => ({
          id: String(row.attribute_id),
          values: (row.attribute_value_list as Row[]).map((v) => String(v.value_id)).sort(),
        })),
        (row) => row.id,
      );
    check(
      sorted(
        Object.entries(document.attributes).map(([id, values]) => ({
          id,
          values: [...values].sort(),
        })),
        (row) => row.id,
      ),
      identity(attrs),
      'item.attribute_list',
    );
    if (Object.keys(document.attributes).length) {
      requireQc(context.attributeList, 'source.attributeList');
      check(identity(context.attributeList), identity(attrs), 'item.attribute_list');
      for (const attribute of context.attributeList)
        for (const value of attribute.attribute_value_list) {
          const actual = attrs
            .find((a) => a.attribute_id === attribute.attribute_id)
            ?.attribute_value_list.find((v: Row) => v.value_id === value.value_id);
          for (const key of ['original_value_name', 'value_unit'] as const)
            if (own(value, key))
              check(
                value[key],
                actual?.[key],
                `item.attribute_list.${attribute.attribute_id}.${value.value_id}.${key}`,
              );
        }
    }
    requireQc(Array.isArray(item.logistic_info), 'item.logistic_info');
    for (const channel of document.logistics)
      check(
        channel.enabled,
        item.logistic_info.find((l: Row) => String(l.logistic_id) === channel.channelId)?.enabled,
        'item.logistic_info.' + channel.channelId + '.enabled',
      );
    // Readback also lists disabled available channels. An extra enabled channel is an
    // unsourced setting, while disabled channel metadata is not a create-time mutation.
    for (const channel of item.logistic_info)
      if (!document.logistics.some((l) => l.channelId === String(channel.logistic_id)))
        check(false, channel.enabled, 'item.logistic_info.' + channel.logistic_id + '.enabled');
    const tiers = snapshot.models.tier_variation as Row[];
    check(
      document.tierNames,
      tiers.map((t) => t.name),
      'models.tier_variation.names',
    );
    if (own(snapshot.models, 'standardise_tier_variation')) {
      requireQc(
        Array.isArray(snapshot.models.standardise_tier_variation),
        'models.standardise_tier_variation',
      );
      check(
        document.tierNames.length,
        snapshot.models.standardise_tier_variation.length,
        'models.standardise_tier_variation.length',
      );
    }
    for (let t = 0; t < document.tierNames.length; t++) {
      const options = new Map<number, { label: string; image?: string }>();
      for (const model of document.models) {
        requireQc(
          model.tierIndex.length === document.tierNames.length &&
            model.optionLabels.length === document.tierNames.length,
          'source.tier_index',
        );
        const option = {
          label: model.optionLabels[t]!,
          ...(t === 0 && model.image ? { image: imageId(context, model.image, 'variation') } : {}),
        };
        if (options.has(model.tierIndex[t]!))
          requireQc(
            !diff(options.get(model.tierIndex[t]!), option).length,
            'source.variation_images',
          );
        options.set(model.tierIndex[t]!, option);
      }
      const ordered = [...options].sort((a, b) => a[0] - b[0]);
      requireQc(
        ordered.every(([index], i) => index === i),
        'source.tier_index',
      );
      check(
        ordered.map(([, o]) => o.label),
        tiers[t]?.option_list?.map((o: Row) => o.option),
        `models.tier_variation.${t}.option_list`,
      );
      ordered.forEach(([, o], i) =>
        check(
          o.image,
          tiers[t]?.option_list?.[i]?.image?.image_id,
          `models.tier_variation.${t}.option_list.${i}.image.image_id`,
        ),
      );
      const standard = (snapshot.models.standardise_tier_variation as Row[] | undefined)?.[t];
      if (standard) {
        check(
          document.tierNames[t],
          standard.variation_name,
          `models.standardise_tier_variation.${t}.variation_name`,
        );
        check(
          ordered.map(([, o]) => o.label),
          standard.variation_option_list?.map((o: Row) => o.variation_option_name),
          `models.standardise_tier_variation.${t}.variation_option_list`,
        );
        ordered.forEach(([, o], i) =>
          check(
            o.image,
            standard.variation_option_list?.[i]?.image_id,
            `models.standardise_tier_variation.${t}.variation_option_list.${i}.image_id`,
          ),
        );
      }
    }
    const actualModels = document.tierNames.length ? (snapshot.models.model as Row[]) : [item];
    requireQc(
      actualModels.length === document.models.length &&
        new Set(actualModels.map((m) => (document.tierNames.length ? m.model_sku : m.item_sku)))
          .size === actualModels.length,
      'models.coverage',
    );
    for (const model of document.models) {
      const actual = actualModels.find(
        (m) => (document.tierNames.length ? m.model_sku : m.item_sku) === model.sku,
      );
      requireQc(actual, 'models.' + model.sku);
      const path = document.tierNames.length ? 'models.model.' + actual.model_id : 'item';
      if (document.tierNames.length)
        check(model.tierIndex, actual.tier_index, path + '.tier_index');
      else requireQc(!model.image, 'source.zero_tier_image');
      if (modelWeight || own(actual, 'weight'))
        check(
          preparedWeightKilograms(model.weightGrams ?? document.weightGrams),
          numeric(actual.weight),
          path + '.weight',
        );
      if (modelDimensions || own(actual, 'dimension'))
        for (const d of ['length', 'width', 'height'] as const)
          check(
            (model.dimensionCm ?? document.dimensionCm)[d],
            actual.dimension?.['package_' + d],
            path + '.dimension.package_' + d,
          );
      if (own(actual, 'pre_order'))
        for (const [key, value] of Object.entries(context.preOrder))
          check(value, actual.pre_order?.[key], path + '.pre_order.' + key);
      const p = priceShape(item, actual, path);
      check(model.originalPrice, String(p.original_price), path + '.price_info.original_price');
      const stock = stockShape(actual, path);
      requireQc(
        own(context.stockLocationBySku, model.sku),
        'source.stockLocationBySku.' + model.sku,
      );
      check(
        context.stockLocationBySku[model.sku] || null,
        stock.seller_stock[0].location_id || null,
        path + '.stock_info_v2.seller_stock.location_id',
      );
      check(model.stock, stock.seller_stock[0].stock, path + '.stock_info_v2.seller_stock.stock');
      if (context.gtinBySku && own(context.gtinBySku, model.sku))
        check(context.gtinBySku[model.sku], actual.gtin_code, path + '.gtin_code');
    }
    return finish(paths);
  } catch (error) {
    return failure(error);
  }
}

function target(snapshot: FieldSnapshot, modelId: any): { row: Row; path: string } {
  requireQc(integer(modelId), 'model_id');
  if (snapshot.item.has_model === false) {
    requireQc(modelId === 0, 'model_id');
    return { row: snapshot.item, path: 'item' };
  }
  const row = snapshot.models.model.find((m) => m.model_id === modelId);
  requireQc(row, 'model_id.' + modelId);
  return { row, path: 'models.model.' + modelId };
}
function updateDescription(item: Row, payload: Row) {
  const type = payload.description_type;
  requireQc(
    type === item.description_type && (type === 'normal' || type === 'extended'),
    'description.type_transition',
  );
  if (type === 'normal') {
    requireQc(
      typeof payload.description === 'string' && !own(payload, 'description_info'),
      'description',
    );
    item.description = payload.description;
    return;
  }
  requireQc(!own(payload, 'description') && object(payload.description_info), 'description_info');
  keys(payload.description_info, ['extended_description'], 'description_info');
  keys(
    payload.description_info.extended_description,
    ['field_list'],
    'description_info.extended_description',
  );
  const fields = payload.description_info.extended_description.field_list,
    old = item.description_info?.extended_description?.field_list;
  requireQc(Array.isArray(fields) && Array.isArray(old), 'description_info.field_list');
  item.description_info.extended_description.field_list = fields.map((field: Row, i: number) => {
    keys(field, ['field_type', 'text', 'image_info'], 'description_info.field');
    if (field.field_type === 'text') {
      requireQc(
        typeof field.text === 'string' && !own(field, 'image_info'),
        'description_info.text',
      );
      return { ...(old[i]?.field_type === 'text' ? old[i] : {}), ...field };
    }
    requireQc(field.field_type === 'image' && !own(field, 'text'), 'description_info.field_type');
    keys(field.image_info, ['image_id'], 'description_info.image_info');
    requireQc(typeof field.image_info.image_id === 'string', 'description_info.image_id');
    const previous = old.find(
      (o: Row) => o.field_type === 'image' && o.image_info?.image_id === field.image_info.image_id,
    );
    return {
      ...(previous ?? {}),
      ...field,
      image_info: { ...(previous?.image_info ?? {}), ...field.image_info },
    };
  });
}
function updateItem(item: Row, payload: Row) {
  keys(
    payload,
    [
      'item_id',
      'item_name',
      'description_type',
      'description',
      'description_info',
      'image',
      'promotion_images',
      'attribute_list',
      'weight',
      'dimension',
      'logistic_info',
    ],
    'update_item.payload',
  );
  requireQc(Object.keys(payload).length > 1, 'update_item.empty');
  if (own(payload, 'item_name')) {
    requireQc(typeof payload.item_name === 'string', 'item_name');
    item.item_name = payload.item_name;
  }
  if (
    own(payload, 'description_type') ||
    own(payload, 'description') ||
    own(payload, 'description_info')
  )
    updateDescription(item, payload);
  for (const [request, read] of [
    ['image', 'image'],
    ['promotion_images', 'promotion_image'],
  ] as const)
    if (own(payload, request)) {
      keys(
        payload[request],
        request === 'image' ? ['image_id_list', 'image_ratio'] : ['image_id_list'],
        request,
      );
      requireQc(
        object(item[read]) &&
          Array.isArray(payload[request].image_id_list) &&
          payload[request].image_id_list.every((id: any) => typeof id === 'string' && id.length),
        request,
      );
      if (request === 'image') {
        const cover = item.promotion_image?.image_id_list;
        const explicitPortraitTransition =
          item.image.image_ratio === '1:1' &&
          payload.image.image_ratio === '3:4' &&
          Array.isArray(cover) &&
          cover.length === 1 &&
          cover[0] === item.image.image_id_list?.[0] &&
          object(payload.promotion_images) &&
          !diff(cover, payload.promotion_images.image_id_list).length;
        requireQc(
          payload.image.image_ratio === item.image.image_ratio || explicitPortraitTransition,
          'image.ratio_transition',
        );
      } else requireQc(item.image?.image_ratio === '3:4', 'promotion_image.ratio');
      item[read] = { ...item[read], ...structuredClone(payload[request]) };
    }
  if (own(payload, 'attribute_list')) {
    requireQc(
      Array.isArray(payload.attribute_list) && Array.isArray(item.attribute_list),
      'attribute_list',
    );
    requireQc(
      new Set(payload.attribute_list.map((a: Row) => a.attribute_id)).size ===
        payload.attribute_list.length,
      'attribute_list.duplicate',
    );
    item.attribute_list = payload.attribute_list.map((a: Row) => {
      keys(a, ['attribute_id', 'attribute_value_list'], 'attribute_list');
      const previous = item.attribute_list.find((p: Row) => p.attribute_id === a.attribute_id);
      requireQc(previous && Array.isArray(a.attribute_value_list), 'attribute_list.new_attribute');
      return {
        ...previous,
        attribute_value_list: a.attribute_value_list.map((v: Row) => {
          keys(v, ['value_id', 'original_value_name', 'value_unit'], 'attribute_list.value');
          const old = previous.attribute_value_list.find((p: Row) => p.value_id === v.value_id);
          requireQc(old, 'attribute_list.new_value');
          return { ...old, ...v };
        }),
      };
    });
  }
  if (own(payload, 'weight')) {
    requireQc(numeric(payload.weight) !== undefined, 'weight');
    item.weight = numericLike(item.weight, Number(payload.weight));
  }
  if (own(payload, 'dimension')) {
    keys(payload.dimension, ['package_length', 'package_width', 'package_height'], 'dimension');
    requireQc(object(item.dimension), 'dimension');
    item.dimension = { ...item.dimension, ...payload.dimension };
  }
  if (own(payload, 'logistic_info')) {
    requireQc(
      Array.isArray(payload.logistic_info) && Array.isArray(item.logistic_info),
      'logistic_info',
    );
    requireQc(
      new Set(payload.logistic_info.map((l: Row) => l.logistic_id)).size ===
        payload.logistic_info.length,
      'logistic_info.duplicate',
    );
    for (const l of payload.logistic_info as Row[]) {
      keys(l, ['logistic_id', 'enabled', 'is_free', 'size_id', 'shipping_fee'], 'logistic_info');
      const old = item.logistic_info.find((p: Row) => p.logistic_id === l.logistic_id);
      requireQc(old, 'logistic_info.new_channel');
      Object.assign(old, l);
    }
  }
}
function checkStepGroup(step: PreparedWireStep) {
  const itemFields: Partial<Record<PreparedWireStep['group'], string[]>> = {
    title: ['item_name'],
    description: ['description_type', 'description', 'description_info'],
    gallery: ['image', 'promotion_images'],
    cover: ['promotion_images'],
    attributes: ['attribute_list'],
    logistics: ['weight', 'dimension', 'logistic_info'],
  };
  if (step.path === '/api/v2/product/update_item') {
    const allowed = itemFields[step.group];
    requireQc(allowed, 'step.group');
    keys(step.payload, ['item_id', ...allowed], 'step.group');
  } else {
    const group =
      step.path === '/api/v2/product/update_price'
        ? 'price'
        : step.path === '/api/v2/product/update_stock'
          ? 'stock'
          : step.path === '/api/v2/product/update_tier_variation'
            ? 'variationImages'
            : undefined;
    requireQc(group && group === step.group, 'step.group');
  }
  if (step.expectedModelIds) {
    const rows = step.payload.price_list ?? step.payload.stock_list;
    requireQc(
      Array.isArray(rows) &&
        !diff([...step.expectedModelIds].sort(), rows.map((r: Row) => String(r.model_id)).sort())
          .length,
      'step.expectedModelIds',
    );
  }
}
function updateVariation(snapshot: FieldSnapshot, payload: Row) {
  keys(payload, ['item_id', 'standardise_tier_variation', 'model_list'], 'update_tier_variation');
  const standard = snapshot.models.standardise_tier_variation as Row[] | undefined;
  requireQc(
    Array.isArray(standard) &&
      Array.isArray(payload.standardise_tier_variation) &&
      standard.length === payload.standardise_tier_variation.length &&
      Array.isArray(payload.model_list),
    'standardise_tier_variation',
  );
  const modelIdentity = (rows: Row[]) =>
    sorted(
      rows.map((m) => ({ model_id: m.model_id, tier_index: m.tier_index })),
      (m) => String(m.model_id),
    );
  payload.model_list.forEach((m: Row) => keys(m, ['model_id', 'tier_index'], 'model_list'));
  requireQc(
    !diff(modelIdentity(snapshot.models.model), modelIdentity(payload.model_list)).length,
    'model_list.bindings',
  );
  payload.standardise_tier_variation.forEach((tier: Row, t: number) => {
    keys(
      tier,
      ['variation_id', 'variation_name', 'variation_group_id', 'variation_option_list'],
      'standardise_tier_variation',
    );
    const before = standard[t]!;
    requireQc(
      tier.variation_id === before.variation_id &&
        tier.variation_name === before.variation_name &&
        own(tier, 'variation_group_id') === own(before, 'variation_group_id') &&
        (!own(tier, 'variation_group_id') ||
          (integer(tier.variation_group_id) &&
            tier.variation_group_id === before.variation_group_id)) &&
        Array.isArray(tier.variation_option_list) &&
        tier.variation_option_list.length === before.variation_option_list.length,
      'standardise_tier_variation.identity',
    );
    tier.variation_option_list.forEach((option: Row, i: number) => {
      keys(
        option,
        ['variation_option_id', 'variation_option_name', 'image_id'],
        'variation_option',
      );
      const old = before.variation_option_list[i];
      requireQc(
        option.variation_option_id === old.variation_option_id &&
          option.variation_option_name === old.variation_option_name,
        'variation_option.identity',
      );
      if (own(option, 'image_id')) {
        requireQc(
          t === 0 && typeof option.image_id === 'string' && option.image_id.length,
          'variation_option.image_id',
        );
        old.image_id = option.image_id;
        const legacy = (snapshot.models.tier_variation[t] as Row).option_list[i];
        legacy.image = { ...(legacy.image ?? {}), image_id: option.image_id };
      } else requireQc(!own(old, 'image_id'), 'variation_option.image_removal');
    });
  });
}

/** Reconstructs only supported request effects over the entire raw baseline. Anything that cannot
 * be determined from the request (promotion, reservations, new attribute metadata) stays unverified. */
export function checkPreparedWireUpdate(
  before: FieldSnapshot,
  after: FieldSnapshot,
  steps: PreparedWireStep[],
): PreparedWireQc {
  try {
    const expected = normalizePreparedWireSnapshot(before),
      observed = normalizePreparedWireSnapshot(after);
    requireQc(Array.isArray(steps) && steps.length > 0, 'steps');
    for (const step of steps) {
      requireQc(
        step.method === 'POST' &&
          object(step.payload) &&
          step.payload.item_id === expected.item.item_id,
        'step.scope',
      );
      checkStepGroup(step);
      const payload = step.payload;
      if (step.path === '/api/v2/product/update_item') {
        if (step.group === 'gallery' && own(payload, 'promotion_images'))
          requireQc(
            !diff(
              (expected.item.promotion_image as Row | undefined)?.image_id_list,
              payload.promotion_images.image_id_list,
            ).length,
            'gallery.preserveCover',
          );
        updateItem(expected.item, payload);
        // update_item explicitly overwrites each model's weight/dimensions. Preserve unknown
        // model properties. Missing model shipping evidence cannot prove the overwrite.
        for (const model of expected.models.model as Row[]) {
          if (own(payload, 'weight')) {
            requireQc(
              numeric(model.weight) !== undefined,
              'models.model.' + model.model_id + '.weight',
            );
            model.weight = numericLike(model.weight, Number(payload.weight));
          }
          if (own(payload, 'dimension')) {
            requireQc(object(model.dimension), 'models.model.' + model.model_id + '.dimension');
            model.dimension = { ...model.dimension, ...payload.dimension };
          }
        }
      } else if (step.path === '/api/v2/product/update_tier_variation')
        updateVariation(expected, payload);
      else if (
        step.path === '/api/v2/product/update_price' ||
        step.path === '/api/v2/product/update_stock'
      ) {
        const price = step.path.endsWith('/update_price'),
          key = price ? 'price_list' : 'stock_list';
        keys(payload, ['item_id', key], key);
        const entries = payload[key];
        requireQc(
          Array.isArray(entries) &&
            entries.length &&
            new Set(entries.map((e: Row) => e.model_id)).size === entries.length,
          key,
        );
        for (const entry of entries) {
          keys(
            entry,
            price ? ['model_id', 'original_price'] : ['model_id', 'seller_stock'],
            key + '.entry',
          );
          const { row, path } = target(expected, entry.model_id);
          if (price) {
            requireQc(integer(entry.original_price, 1), 'original_price');
            const info = priceShape(expected.item, row, path);
            for (const field of [
              'original_price',
              'current_price',
              'inflated_price_of_original_price',
              'inflated_price_of_current_price',
            ])
              if (own(info, field)) info[field] = entry.original_price;
          } else {
            noPromotion(expected.item, row, path);
            const info = stockShape(row, path);
            requireQc(
              Array.isArray(entry.seller_stock) && entry.seller_stock.length === 1,
              'seller_stock',
            );
            const seller = entry.seller_stock[0];
            keys(seller, ['stock', 'location_id'], 'seller_stock');
            requireQc(
              integer(seller.stock) &&
                (seller.location_id || null) === (info.seller_stock[0].location_id || null),
              'seller_stock.location',
            );
            info.seller_stock[0].stock = seller.stock;
            info.summary_info.total_available_stock = seller.stock;
          }
        }
      } else throw new Unsupported('path');
    }
    return finish(diff(normalizePreparedWireSnapshot(expected), observed));
  } catch (error) {
    return failure(error);
  }
}
