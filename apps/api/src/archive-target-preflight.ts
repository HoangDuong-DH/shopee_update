import { validateAttributeSelection } from '../../../packages/shopee/src/attribute-validation.js';

/** Pure read-only target assessment. A passing result is only an input to the writer preflight. */
export type Observation<T> = { shopId: string; revision: number; observedAt: string; value: T };
export type ArchiveTargetPreflightInput = {
  source: {
    shopId: string;
    itemId: string;
    categoryPath: string[];
    brandName: string | null;
    itemSku: string;
    modelSkus: string[];
    sourceContractRef: string | null;
  };
  target: {
    shopId: string;
    connection: {
      state: 'connected' | 'disconnected' | 'unknown';
      revision: number | null;
      expiresAt: string | null;
    };
    proposal: {
      categoryId: string | null;
      brandId: string | null;
      attributes: unknown;
      logisticIds: string[];
      mappingConfirmationRef: string | null;
    };
    shop?: Observation<{ shopId: string; status: string }>;
    categories?: Observation<{
      complete: boolean;
      rows: { id: string; path: string[]; leaf: boolean }[];
    }>;
    brands?: Observation<{
      categoryId: string;
      complete: boolean;
      rows: { id: string; name: string }[];
    }>;
    attributeTree?: Observation<{ categoryId: string; tree: unknown }>;
    logistics?: Observation<{
      complete: boolean;
      rows: {
        id: string;
        enabled: boolean;
        compulsory: boolean | null;
        relationsKnown: boolean;
        relatedEnabledIds: string[];
        blockedWithIds: string[];
      }[];
    }>;
    inventory?: Observation<{
      complete: boolean;
      statuses: string[];
      rows: { itemId: string; itemSku: string; modelSkus: string[] }[];
    }>;
  };
  now?: string;
  maxEvidenceAgeMs?: number;
};
export type ArchiveTargetPreflightResult = {
  targetShopId: string;
  sourceItemId: string;
  readyForWriterPreflight: boolean;
  blockers: { code: string; path: string; detail?: string }[];
};
const blank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const statuses = ['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING'];

export function assessArchiveTargetPreflight(
  input: ArchiveTargetPreflightInput,
): ArchiveTargetPreflightResult {
  const { source, target } = input;
  const blockers: ArchiveTargetPreflightResult['blockers'] = [];
  const block = (code: string, path: string, detail?: string) => {
    if (!blockers.some((entry) => entry.code === code && entry.path === path))
      blockers.push({ code, path, ...(detail === undefined ? {} : { detail }) });
  };
  const now = Date.parse(input.now ?? new Date().toISOString());
  const maxAge = input.maxEvidenceAgeMs ?? 900_000;
  if (!Number.isFinite(now) || !Number.isSafeInteger(maxAge) || maxAge <= 0)
    block('CLOCK_INVALID', 'now');
  if (!blank(source.sourceContractRef))
    block('SOURCE_CONTRACT_REQUIRED', 'source.sourceContractRef');
  if (!blank(target.proposal.mappingConfirmationRef))
    block('MAPPING_CONFIRMATION_REQUIRED', 'target.proposal.mappingConfirmationRef');
  if (!blank(target.shopId) || target.shopId === source.shopId)
    block('TARGET_SHOP_INVALID', 'target.shopId');
  const connected =
    target.connection.state === 'connected' &&
    Number.isSafeInteger(target.connection.revision) &&
    (target.connection.revision ?? 0) > 0 &&
    target.connection.expiresAt !== null &&
    Date.parse(target.connection.expiresAt) > now;
  if (!connected) block('TARGET_DISCONNECTED', 'target.connection');
  const read = <T>(entry: Observation<T> | undefined, path: string): T | undefined => {
    if (!entry) {
      block('EVIDENCE_MISSING', path);
      return undefined;
    }
    const at = Date.parse(entry.observedAt);
    if (
      !connected ||
      entry.shopId !== target.shopId ||
      entry.revision !== target.connection.revision ||
      !Number.isFinite(at) ||
      !Number.isFinite(now) ||
      at > now ||
      now - at > maxAge
    ) {
      block('EVIDENCE_STALE_OR_WRONG_SHOP', path);
      return undefined;
    }
    return entry.value;
  };
  const shop = read(target.shop, 'target.shop');
  if (shop && (shop.shopId !== target.shopId || shop.status !== 'NORMAL'))
    block('SHOP_UNAVAILABLE', 'target.shop');
  const categories = read(target.categories, 'target.categories');
  if (!source.categoryPath.length || source.categoryPath.some((part) => !blank(part)))
    block('SOURCE_CATEGORY_PATH_REQUIRED', 'source.categoryPath');
  if (categories) {
    if (!categories.complete) block('CATEGORY_SCAN_INCOMPLETE', 'target.categories');
    const matches = categories.rows.filter(
      (row) =>
        row.leaf &&
        row.path.length === source.categoryPath.length &&
        row.path.every((part, index) => part === source.categoryPath[index]),
    );
    if (matches.length !== 1 || matches[0]?.id !== target.proposal.categoryId)
      block('CATEGORY_UNRESOLVED', 'target.proposal.categoryId');
  }
  const brands = read(target.brands, 'target.brands');
  if (!blank(source.brandName)) block('SOURCE_BRAND_NAME_REQUIRED', 'source.brandName');
  if (brands) {
    if (!brands.complete || brands.categoryId !== target.proposal.categoryId)
      block('BRAND_SCAN_INCOMPLETE', 'target.brands');
    const matches = brands.rows.filter((row) => row.name === source.brandName);
    if (matches.length !== 1 || matches[0]?.id !== target.proposal.brandId)
      block('BRAND_UNRESOLVED', 'target.proposal.brandId');
  }
  const tree = read(target.attributeTree, 'target.attributeTree');
  if (tree) {
    if (tree.categoryId !== target.proposal.categoryId)
      block('ATTRIBUTE_CATEGORY_MISMATCH', 'target.attributeTree');
    else
      for (const issue of validateAttributeSelection(tree.tree, target.proposal.attributes).issues)
        block('ATTRIBUTE_' + issue.code, 'target.proposal.' + issue.path);
  }
  const logistics = read(target.logistics, 'target.logistics');
  if (logistics) {
    if (!logistics.complete) block('LOGISTICS_SCAN_INCOMPLETE', 'target.logistics');
    const selected = target.proposal.logisticIds;
    if (
      !selected.length ||
      selected.some((id) => !blank(id)) ||
      new Set(selected).size !== selected.length
    )
      block('LOGISTICS_SELECTION_INVALID', 'target.proposal.logisticIds');
    const channels = new Map(logistics.rows.map((row) => [row.id, row]));
    if (channels.size !== logistics.rows.length)
      block('LOGISTICS_CHANNELS_DUPLICATE', 'target.logistics');
    if (logistics.rows.some((row) => row.compulsory === null))
      block('LOGISTICS_REQUIREMENTS_UNKNOWN', 'target.logistics');
    for (const row of logistics.rows.filter((row) => row.compulsory && row.enabled))
      if (!selected.includes(row.id))
        block('LOGISTICS_COMPULSORY_MISSING', 'target.proposal.logisticIds', row.id);
    for (const id of selected) {
      const row = channels.get(id);
      if (!row?.enabled || !row.relationsKnown)
        block('LOGISTICS_CHANNEL_UNAVAILABLE', 'target.proposal.logisticIds', id);
      if (
        row?.relatedEnabledIds.some((other) => !selected.includes(other)) ||
        row?.blockedWithIds.some((other) => selected.includes(other))
      )
        block('LOGISTICS_RELATION_CONFLICT', 'target.proposal.logisticIds', id);
    }
  }
  const skuList = [source.itemSku, ...source.modelSkus].filter(blank);
  if (!skuList.length || source.modelSkus.some((sku) => !blank(sku)) || new Set(skuList).size !== skuList.length)
    block('SOURCE_SKUS_INVALID', 'source.modelSkus');
  const inventory = read(target.inventory, 'target.inventory');
  if (inventory) {
    if (!inventory.complete || statuses.some((status) => !inventory.statuses.includes(status)))
      block('INVENTORY_INCOMPLETE', 'target.inventory');
    const existing = new Map<string, string[]>();
    for (const row of inventory.rows)
      for (const sku of [row.itemSku, ...row.modelSkus].filter(blank))
        existing.set(sku, [...(existing.get(sku) ?? []), row.itemId]);
    for (const sku of skuList)
      if (existing.has(sku))
        block('SKU_EXISTS', 'target.inventory', sku + ': ' + existing.get(sku)!.join(','));
  }
  return {
    targetShopId: target.shopId,
    sourceItemId: source.itemId,
    readyForWriterPreflight: blockers.length === 0,
    blockers,
  };
}
