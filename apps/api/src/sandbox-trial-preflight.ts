export type TrialMetadata = {
  category: Record<string, unknown>;
  attributes: Record<string, unknown>;
  brands: Record<string, unknown>;
  channels: Record<string, unknown>;
  limits: Record<string, unknown>;
  existing: Record<string, unknown>[];
};
const rec = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
const rows = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? v.map(rec) : []);
const numeric = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

function relationRules(value: unknown): Record<string, number[]>[] | null {
  if (value === undefined) return [];
  const candidates = Array.isArray(value) ? value : [value];
  const known = new Set([
    'related_enabled_channels',
    'related_disabled_channels',
    'related_dependent_block_channels',
  ]);
  const result: Record<string, number[]>[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const rule: Record<string, number[]> = {};
    for (const [key, ids] of Object.entries(candidate)) {
      if (!Array.isArray(ids)) return null;
      if (!known.has(key)) {
        if (ids.length) return null;
        continue;
      }
      if (
        ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) ||
        new Set(ids).size !== ids.length
      )
        return null;
      rule[key] = ids;
    }
    result.push(rule);
  }
  return result;
}

// This validator intentionally supports the bounded synthetic pilot, not arbitrary business sources.
// An unsupported or incomplete rule becomes an exception; no source value is rewritten.
export function validateTrialMetadata(items: unknown[], m: TrialMetadata): string[] {
  const issues: string[] = [];
  const add = (code: string) => {
    if (!issues.includes(code)) issues.push(code);
  };
  const range = (key: string, value: number, code: string) => {
    const limit = rec(m.limits[key]);
    if (!numeric(limit.min_limit) || !numeric(limit.max_limit) || limit.min_limit > limit.max_limit)
      add('LIMIT_UNVERIFIED:' + key);
    else if (value < limit.min_limit || value > limit.max_limit) add(code);
  };
  const maxItems = rec(m.limits.item_count_limit).max_limit;
  if (!numeric(maxItems) || maxItems < 1) add('LIMIT_UNVERIFIED:item_count_limit');
  else if (m.existing.length + items.length > maxItems) add('ITEM_COUNT_LIMIT');
  if (m.category.has_children !== false) add('LEAF_CATEGORY_UNVERIFIED');
  if (!Array.isArray(m.channels.logistics_channel_list)) add('CHANNEL_METADATA_MISSING');
  if (typeof m.brands.is_mandatory !== 'boolean') add('BRAND_RULE_UNVERIFIED');
  for (const input of items) {
    const item = rec(input),
      p = rec(item.create),
      sku = String(p.item_sku);
    if (String(p.category_id) !== String(m.category.category_id)) add('CATEGORY_MISMATCH');
    if (m.existing.some((x) => x.item_sku === sku)) add('EXISTING_SOURCE_SKU:' + sku);
    range('item_name_length_limit', [...String(p.item_name)].length, 'TITLE_LENGTH:' + sku);
    range(
      'item_description_length_limit',
      [...String(p.description)].length,
      'DESCRIPTION_LENGTH:' + sku,
    );
    range('item_image_count_limit', rec(p.image).image_id_list?.length ?? 0, 'IMAGE_COUNT:' + sku);
    const models = [p, ...rows(rec(item.tiers).model)];
    for (const model of models) {
      range('price_limit', model.original_price, 'PRICE_OUT_OF_RANGE:' + sku);
      range(
        'stock_limit',
        rows(model.seller_stock).reduce((n, x) => n + x.stock, 0),
        'STOCK_OUT_OF_RANGE:' + sku,
      );
    }
    for (const tier of rows(rec(item.tiers).standardise_tier_variation)) {
      range(
        'tier_variation_name_length_limit',
        [...String(tier.variation_name)].length,
        'TIER_NAME_LENGTH:' + sku,
      );
      for (const opt of rows(tier.variation_option_list))
        range(
          'tier_variation_option_length_limit',
          [...String(opt.variation_option_name)].length,
          'OPTION_LENGTH:' + sku,
        );
    }
    const gtin = rec(m.limits.gtin_limit).gtin_validation_rule;
    if (!['Mandatory', 'Flexible', 'Optional'].includes(gtin)) add('GTIN_RULE_UNVERIFIED');
    if (gtin === 'Mandatory' || (gtin === 'Flexible' && models.some((x) => x.gtin_code !== '00')))
      add('GTIN_REQUIRED:' + sku);
    if (rec(m.limits.size_chart_limit).size_chart_mandatory === true)
      add('SIZE_CHART_REQUIRED:' + sku);
    const brand = rec(p.brand),
      brands = rows(m.brands.brand_list);
    if (brand.brand_id === 0) {
      if (m.brands.is_mandatory !== false && !brands.some((b) => b.brand_id === 0))
        add('NO_BRAND_NOT_VERIFIED');
    } else if (
      !brands.some(
        (b) => b.brand_id === brand.brand_id && b.original_brand_name === brand.original_brand_name,
      )
    )
      add('BRAND_NOT_FOUND');
    const tree = rows(m.attributes.list).find(
      (x) => String(x.category_id) === String(p.category_id),
    );
    if (!tree || !Array.isArray(tree.attribute_tree)) add('ATTRIBUTE_TREE_UNVERIFIED');
    const selected = rows(p.attribute_list),
      visited = new Set<string>();
    const checkTree = (nodes: Record<string, any>[], depth = 0) => {
      if (depth > 10) {
        add('ATTRIBUTE_TREE_DEPTH');
        return;
      }
      for (const node of nodes) {
        const id = String(node.attribute_id),
          chosen = selected.find((x) => String(x.attribute_id) === id);
        visited.add(id);
        if (node.mandatory === true && !chosen?.attribute_value_list?.length)
          add('ATTRIBUTE_REQUIRED:' + id);
        if (!chosen) continue;
        const info = rec(node.attribute_info),
          values = rows(chosen.attribute_value_list);
        if (info.support_search_value === true) add('ATTRIBUTE_SEARCH_REQUIRED:' + id);
        if (numeric(info.max_value_count) && values.length > info.max_value_count)
          add('ATTRIBUTE_VALUE_COUNT:' + id);
        if ([1, 2, 3].includes(info.input_type) && values.length > 1)
          add('ATTRIBUTE_SINGLE_VALUE:' + id);
        for (const value of values) {
          const allowed = rows(node.attribute_value_list).find(
            (x) => String(x.value_id) === String(value.value_id),
          );
          if (!allowed || Number(value.value_id) === 0) {
            add('ATTRIBUTE_VALUE_UNVERIFIED:' + id);
            continue;
          }
          if (allowed.value_unit && value.value_unit !== allowed.value_unit)
            add('ATTRIBUTE_UNIT_MISMATCH:' + id);
          checkTree(rows(allowed.child_attribute_list), depth + 1);
        }
      }
    };
    checkTree(rows(tree?.attribute_tree));
    for (const attribute of selected)
      if (!visited.has(String(attribute.attribute_id)))
        add('ATTRIBUTE_NOT_APPLICABLE:' + attribute.attribute_id);
    const available = rows(m.channels.logistics_channel_list),
      enabled = rows(p.logistic_info).filter((x) => x.enabled === true);
    if (!enabled.length) add('CHANNEL_REQUIRED');
    const compulsory = available.filter(
      (x) => x.enabled === true && x.mask_channel_id === 0 && x.compulsory_channel === true,
    );
    if (
      compulsory.length &&
      !enabled.some((x) =>
        compulsory.some((c) => String(c.logistics_channel_id) === String(x.logistic_id)),
      )
    )
      add('COMPULSORY_CHANNEL_REQUIRED');
    for (const must of available.filter(
      (x) => x.enabled === true && x.mask_channel_id === 0 && x.force_enable === true,
    ))
      if (!enabled.some((x) => String(x.logistic_id) === String(must.logistics_channel_id)))
        add('FORCED_CHANNEL_REQUIRED:' + must.logistics_channel_id);
    for (const c of enabled) {
      const channel = available.find(
          (x) => String(x.logistics_channel_id) === String(c.logistic_id),
        ),
        id = String(c.logistic_id);
      if (!channel || channel.enabled !== true || channel.mask_channel_id !== 0) {
        add('CHANNEL_NOT_ELIGIBLE:' + id);
        continue;
      }
      if (channel.block_seller_cover_shipping_fee === true && c.is_free === true)
        add('FREE_SHIPPING_NOT_ALLOWED:' + id);
      const dim = rec(p.dimension),
        weight = rec(channel.weight_limit),
        limits = rec(channel.item_max_dimension);
      if (
        (weight.item_min_weight > 0 && p.weight < weight.item_min_weight) ||
        (weight.item_max_weight > 0 && p.weight > weight.item_max_weight)
      )
        add('CHANNEL_WEIGHT:' + id);
      if (
        channel.fee_type === 'SIZE_INPUT' &&
        !['package_height', 'package_width', 'package_length'].every(
          (k) => numeric(dim[k]) && dim[k] > 0,
        )
      )
        add('CHANNEL_DIMENSIONS_REQUIRED:' + id);
      if (
        channel.fee_type === 'SIZE_SELECTION' &&
        !rows(channel.size_list).some((s) => String(s.size_id) === String(c.size_id))
      )
        add('CHANNEL_SIZE_REQUIRED:' + id);
      if (channel.fee_type === 'CUSTOM_PRICE' && (!numeric(c.shipping_fee) || c.shipping_fee < 0))
        add('CHANNEL_FEE_REQUIRED:' + id);
      if (
        !['SIZE_INPUT', 'SIZE_SELECTION', 'FIXED_DEFAULT_PRICE', 'CUSTOM_PRICE'].includes(
          channel.fee_type,
        )
      )
        add('CHANNEL_FEE_TYPE_UNVERIFIED:' + id);
      const noDimensionLimit = ['height', 'width', 'length', 'dimension_sum'].every(
        (key) => limits[key] === 0,
      );
      // The official channel example uses UNKNOWN with four explicit zero limits.
      if (Object.keys(limits).length && limits.unit !== 'cm' && !noDimensionLimit)
        add('CHANNEL_DIMENSION_UNIT_UNVERIFIED:' + id);
      for (const k of ['height', 'width', 'length'])
        if (limits[k] > 0 && dim['package_' + k] > limits[k]) add('CHANNEL_DIMENSIONS:' + id);
      if (
        limits.dimension_sum > 0 &&
        dim.package_height + dim.package_width + dim.package_length > limits.dimension_sum
      )
        add('CHANNEL_DIMENSION_SUM:' + id);
      const volume = rec(channel.volume_limit);
      if (volume.item_max_volume > 0 || volume.item_min_volume > 0)
        add('CHANNEL_VOLUME_UNIT_UNVERIFIED:' + id);
      // The 2026-09-12 sandbox returns an object; the official schema documents an array.
      const relations = relationRules(channel.channel_relation_rules);
      if (relations === null) add('CHANNEL_RELATION_RULE_UNVERIFIED:' + id);
      for (const rule of relations ?? []) {
        for (const related of rule.related_enabled_channels ?? [])
          if (!enabled.some((x) => String(x.logistic_id) === String(related)))
            add('RELATED_CHANNEL_MISSING:' + related);
        for (const related of rule.related_disabled_channels ?? [])
          if (enabled.some((x) => String(x.logistic_id) === String(related)))
            add('RELATED_CHANNEL_MUST_BE_DISABLED:' + related);
        // dependent_block applies when disabling the parent. This loop checks enabled parents only.
      }
    }
  }
  return issues;
}
