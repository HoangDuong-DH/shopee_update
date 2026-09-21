import {
  productFingerprint,
  stableJson,
  type FieldOperation,
  type FieldSnapshot,
} from '@shopee/gateway';

// Only transport metadata is omitted. Unknown business fields remain part of the comparison.
function canonical(value: any, key = ''): any {
  if (Array.isArray(value)) {
    const values = value.map((v) => canonical(v));
    const identity = (
      { model: 'model_id', logistic_info: 'logistic_id', attribute_list: 'attribute_id' } as Record<
        string,
        string
      >
    )[key];
    if (identity) {
      if (
        values.some((v) => v?.[identity] === undefined) ||
        new Set(values.map((v) => String(v[identity]))).size !== values.length
      )
        throw new Error('FIELD_SNAPSHOT_AMBIGUOUS');
      values.sort((a, b) => String(a[identity]).localeCompare(String(b[identity])));
    }
    return values;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !['update_time', 'create_time', 'image_url', 'image_url_list'].includes(k))
        .map(([k, v]) => [k, canonical(v, k)]),
    );
  return value;
}
export function fieldSnapshotFingerprint(snapshot: FieldSnapshot) {
  return productFingerprint(canonical(snapshot));
}
function target(snapshot: FieldSnapshot, id: number): any {
  if (snapshot.item.has_model === false && id === 0) return snapshot.item;
  const found = snapshot.models.model.filter((m) => String(m.model_id) === String(id));
  if (snapshot.item.has_model !== true || found.length !== 1)
    throw new Error('FIELD_MODEL_MISMATCH');
  return found[0];
}
function priceOf(row: any) {
  if (
    !Array.isArray(row.price_info) ||
    row.price_info.length !== 1 ||
    row.price_info[0].currency !== 'VND'
  )
    throw new Error('FIELD_PRICE_AMBIGUOUS');
  return row.price_info[0];
}
function stockOf(row: any) {
  const s = row.stock_info_v2;
  if (
    !s ||
    !Array.isArray(s.seller_stock) ||
    s.seller_stock.length !== 1 ||
    !Number.isSafeInteger(s.seller_stock[0].stock) ||
    !s.summary_info ||
    s.summary_info.total_reserved_stock !== 0 ||
    s.summary_info.total_available_stock !== s.seller_stock[0].stock ||
    (s.shopee_stock ?? []).some((v: any) => v.stock !== 0) ||
    Object.values(s.advance_stock ?? {}).some((v) => v !== 0)
  )
    throw new Error('FIELD_STOCK_AMBIGUOUS');
  return s;
}
export function validateFieldBaseline(snapshot: FieldSnapshot, operation: FieldOperation) {
  canonical(snapshot);
  if (operation.kind === 'price')
    for (const value of operation.value) {
      const row = target(snapshot, value.model_id),
        price = priceOf(row);
      if (
        row.has_promotion !== false ||
        (row.promotion_id !== undefined && Number(row.promotion_id) !== 0) ||
        Number(price.current_price) !== Number(price.original_price) ||
        ['inflated_price_of_current_price', 'inflated_price_of_original_price'].some(
          (k) => price[k] !== undefined && Number(price[k]) !== Number(price.original_price),
        )
      )
        throw new Error('FIELD_PROMOTION_REQUIRES_REVIEW');
    }
  if (operation.kind === 'stock')
    for (const value of operation.value) {
      const s = stockOf(target(snapshot, value.model_id)),
        requested = value.seller_stock[0]!;
      if (
        value.seller_stock.length !== 1 ||
        (requested.location_id ?? '') !== (s.seller_stock[0].location_id ?? '')
      )
        throw new Error('FIELD_STOCK_LOCATION_MISMATCH');
    }
  if (operation.kind === 'gallery') {
    const cover = (snapshot.item.promotion_image as any)?.image_id_list ?? [];
    const originalRatio = (snapshot.item.image as any)?.image_ratio;
    if (originalRatio !== operation.value.image_ratio)
      throw new Error('FIELD_IMAGE_RATIO_CHANGE_REQUIRES_REVIEW');
    if (operation.value.image_ratio === '3:4') {
      if (stableJson(operation.preserveCover) !== stableJson(cover))
        throw new Error('FIELD_COVER_MISMATCH');
    } else if (
      operation.preserveCover.length ||
      cover.length !== 1 ||
      operation.value.image_id_list[0] !== cover[0]
    )
      throw new Error('FIELD_COVER_MISMATCH');
  }
  if (operation.kind === 'cover' && (snapshot.item.image as any)?.image_ratio !== '3:4')
    throw new Error('FIELD_COVER_RATIO_REQUIRES_REVIEW');
}
function expectedSnapshot(before: FieldSnapshot, operation: FieldOperation): FieldSnapshot {
  validateFieldBaseline(before, operation);
  const expected = structuredClone(before);
  if (operation.kind === 'title') expected.item.item_name = operation.value;
  if (operation.kind === 'description') {
    const value = operation.value;
    expected.item.description_type = value.description_type;
    if (value.description_type === 'normal') {
      expected.item.description = value.description;
      delete expected.item.description_info;
    } else {
      expected.item.description_info = value.description_info;
      // A normal fallback text is not specified by extended_description. Do not infer it.
      delete expected.item.description;
    }
  }
  if (operation.kind === 'gallery')
    expected.item.image = { ...(expected.item.image as object), ...operation.value };
  if (operation.kind === 'cover')
    expected.item.promotion_image = {
      ...(expected.item.promotion_image as object),
      image_id_list: operation.value,
    };
  if (operation.kind === 'price')
    for (const value of operation.value) {
      const price = priceOf(target(expected, value.model_id));
      for (const k of [
        'original_price',
        'current_price',
        'inflated_price_of_current_price',
        'inflated_price_of_original_price',
      ])
        if (price[k] !== undefined) price[k] = value.original_price;
    }
  if (operation.kind === 'stock')
    for (const value of operation.value) {
      const stock = stockOf(target(expected, value.model_id));
      stock.seller_stock[0].stock = value.seller_stock[0]!.stock;
      stock.summary_info.total_available_stock = value.seller_stock[0]!.stock;
    }
  return expected;
}
function withoutSelected(raw: FieldSnapshot, operation: FieldOperation): FieldSnapshot {
  const snapshot = structuredClone(raw);
  if (operation.kind === 'title') delete snapshot.item.item_name;
  if (operation.kind === 'description')
    for (const k of ['description', 'description_type', 'description_info'])
      delete snapshot.item[k];
  if (operation.kind === 'gallery') delete snapshot.item.image;
  if (operation.kind === 'cover') delete snapshot.item.promotion_image;
  if (operation.kind === 'price')
    for (const value of operation.value) {
      const row = target(snapshot, value.model_id),
        price = priceOf(row);
      for (const k of [
        'original_price',
        'current_price',
        'inflated_price_of_current_price',
        'inflated_price_of_original_price',
      ])
        delete price[k];
    }
  if (operation.kind === 'stock')
    for (const value of operation.value) {
      const row = target(snapshot, value.model_id),
        s = row.stock_info_v2;
      if (!s || !Array.isArray(s.seller_stock) || s.seller_stock.length !== 1 || !s.summary_info)
        throw new Error('FIELD_STOCK_AMBIGUOUS');
      delete s.seller_stock[0].stock;
      delete s.summary_info.total_available_stock;
    }
  return snapshot;
}
function differences(a: any, b: any, path = '', out: string[] = []): string[] {
  if (stableJson(a) === stableJson(b)) return out;
  if (Array.isArray(a) !== Array.isArray(b)) {
    if (out.length < 100) out.push(path);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      differences(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else if (out.length < 100) out.push(path);
  return out;
}
export function checkFieldReadback(
  before: FieldSnapshot,
  after: FieldSnapshot,
  operation: FieldOperation,
) {
  const expected = canonical(expectedSnapshot(before, operation)),
    observed = canonical(after);
  const selectedDiff = differences(expected, observed);
  const unchangedDiff = differences(
    canonical(withoutSelected(before, operation)),
    canonical(withoutSelected(after, operation)),
  );
  return {
    verified: selectedDiff.length === 0 && unchangedDiff.length === 0,
    selectedMatch: selectedDiff.every((path) => unchangedDiff.includes(path)),
    unchanged: unchangedDiff.length === 0,
    mismatchedPaths: selectedDiff,
    unselectedChangedPaths: unchangedDiff,
    beforeFingerprint: fieldSnapshotFingerprint(before),
    afterFingerprint: fieldSnapshotFingerprint(after),
  };
}
