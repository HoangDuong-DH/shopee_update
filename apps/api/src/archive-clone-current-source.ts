import { canonicalJson } from '@shopee/domain';
import type { ArchiveItem } from '../../../packages/domain/src/archive-clone.js';

export type CurrentArchiveSource = {
  shopId: string;
  itemId: string;
  observedAt: string;
  requestIds: string[];
  rawItem: Record<string, any>;
  rawModels: Record<string, any> | null;
};
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sortable = (rows: unknown[], key: (row: any) => string) =>
  [...rows].sort((a, b) => key(a).localeCompare(key(b)));
const copy = <T>(value: T): T => structuredClone(value);

/** Only order-insensitive API collections and reserved stock are normalized. Available
 * stock, SKU, price, tiers, image order, logistics contents and all unknown fields remain exact. */
export function normalizeArchiveSource(item: Record<string, any>, models: Record<string, any> | null) {
  const i = copy(item), m = models === null ? {} : copy(models);
  // Shopee alternates null and a known empty model envelope for zero-tier items.
  for (const key of ['model','tier_variation','standardise_tier_variation'])
    if (Array.isArray(m[key]) && m[key].length === 0) delete m[key];
  if (Array.isArray(i.logistic_info))
    i.logistic_info = sortable(i.logistic_info, (row) => String(row.logistic_id));
  if (Array.isArray(i.attribute_list))
    i.attribute_list = sortable(i.attribute_list, (row) => String(row.attribute_id)).map((row: any) => ({
      ...row,
      attribute_value_list: Array.isArray(row.attribute_value_list)
        ? sortable(row.attribute_value_list, (value) =>
            canonicalJson([value.value_id, value.original_value_name ?? '', value.value_unit ?? '']))
        : row.attribute_value_list,
    }));
  const normalizeStock = (row: any) => {
    const stock = row?.stock_info_v2;
    if (!object(stock)) return;
    if (object(stock.summary_info)) delete stock.summary_info.total_reserved_stock;
    if (Array.isArray(stock.seller_stock))
      stock.seller_stock = sortable(stock.seller_stock,
        (value) => String(value.location_id ?? value.stock_location_id ?? ''));
  };
  normalizeStock(i);
  if (Array.isArray(m.model)) {
    m.model = sortable(m.model, (row) => String(row.model_id));
    for (const model of m.model) normalizeStock(model);
  }
  return { item: i, models: m };
}

export function compareCurrentArchiveSource(
  archived: ArchiveItem,
  current: CurrentArchiveSource,
  sourceShopId: string,
): { equal: boolean; changedPaths: string[] } {
  const changedPaths: string[] = [];
  if (current.shopId !== sourceShopId || current.itemId !== archived.sourceItemId ||
    String(current.rawItem.item_id) !== archived.sourceItemId ||
    !Number.isFinite(Date.parse(current.observedAt)) ||
    !Array.isArray(current.requestIds) || current.requestIds.length < 2 ||
    current.requestIds.some((id) => typeof id !== 'string' || !id))
    changedPaths.push('identity');
  const expected = normalizeArchiveSource(archived.rawItem, archived.rawModels);
  const actual = normalizeArchiveSource(current.rawItem, current.rawModels);
  for (const [left, right, root] of [
    [expected.item, actual.item, 'item'],
    [expected.models, actual.models, 'models'],
  ] as const) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key) ||
          canonicalJson(left[key]) !== canonicalJson(right[key]))
        changedPaths.push(root + '.' + key);
  }
  return { equal: changedPaths.length === 0, changedPaths };
}
