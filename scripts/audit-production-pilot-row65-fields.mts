import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson } from '@shopee/domain';

// Offline field-by-field evidence audit. Keeps the original raw response and source intact.
const directory = resolve('.local/production-pilot-1423724897');
const audit = JSON.parse(await readFile(resolve(directory, 'row65-initial-source-audit.json'), 'utf8'));
const request = audit.requestedCreate, raw = audit.rawItem, source = audit.frozenDocument;
const checks: { path: string; equal: boolean; expected: unknown; actual: unknown }[] = [];
const check = (path: string, expected: unknown, actual: unknown) => checks.push({ path, equal: canonicalJson(expected ?? null) === canonicalJson(actual ?? null), expected: expected ?? null, actual: actual ?? null });
for (const key of ['item_name', 'description', 'item_sku', 'category_id', 'item_status', 'condition', 'description_type']) check('item.' + key, request[key], raw[key]);
for (const key of Object.keys(request.brand)) check('item.brand.' + key, request.brand[key], raw.brand[key]);
for (const key of Object.keys(request.pre_order)) check('item.pre_order.' + key, request.pre_order[key], raw.pre_order[key]);
for (const key of Object.keys(request.dimension)) check('item.dimension.' + key, request.dimension[key], raw.dimension[key]);
check('item.weight', request.weight, Number(raw.weight));
check('item.image.image_id_list', request.image.image_id_list, raw.image.image_id_list);
check('item.image.image_ratio', request.image.image_ratio, raw.image.image_ratio);
check('item.attribute_list.ids', request.attribute_list.map((a: any) => a.attribute_id).sort(), raw.attribute_list.map((a: any) => a.attribute_id).sort());
for (const expected of request.attribute_list) {
  const observed = raw.attribute_list.find((a: any) => a.attribute_id === expected.attribute_id);
  check('item.attribute.' + expected.attribute_id + '.value_ids', expected.attribute_value_list.map((v: any) => v.value_id).sort(), observed?.attribute_value_list.map((v: any) => v.value_id).sort());
  for (const value of expected.attribute_value_list) {
    const actual = observed?.attribute_value_list.find((v: any) => v.value_id === value.value_id);
    for (const key of Object.keys(value)) check('item.attribute.' + expected.attribute_id + '.' + value.value_id + '.' + key, value[key], actual?.[key]);
  }
}
for (const channel of request.logistic_info) {
  const observed = raw.logistic_info.find((c: any) => c.logistic_id === channel.logistic_id);
  for (const key of Object.keys(channel)) check('item.logistic_info.' + channel.logistic_id + '.' + key, channel[key], observed?.[key]);
}
check('tier.names', source.tierNames, audit.rawTierVariation.map((t: any) => t.name));
for (let index = 0; index < source.tierNames.length; index++) {
  const options = new Map<number, string>();
  for (const model of source.models) options.set(model.tierIndex[index], model.optionLabels[index]);
  check('tier.' + index + '.ordered_options', [...options.entries()].sort((a, b) => a[0] - b[0]).map(([, label]) => label), audit.rawTierVariation[index].option_list.map((option: any) => option.option));
}
const variantImageIds = [...new Set(audit.rawTierVariation[0].option_list.map((option: any) => option.image?.image_id))];
// All three source rows explicitly share one asset. Its received uploaded ID is preserved by tier.
const originalRead = JSON.parse(await readFile(audit.evidencePath, 'utf8'));
for (const entry of audit.modelAudit) {
  const observed = entry.observed;
  check('model.' + entry.sku + '.original_price', Number(entry.expectedPrice), observed?.price_info?.[0]?.original_price);
  check('model.' + entry.sku + '.weight', entry.requested.weight, observed ? Number(observed.weight) : null);
  check('model.' + entry.sku + '.dimension', entry.requested.dimension, observed?.dimension);
  check('model.' + entry.sku + '.sku_present', entry.sku, observed?.model_sku);
  check('model.' + entry.sku + '.tier_index_present', entry.sourceTierIndex, observed?.tier_index);
  check('model.' + entry.sku + '.stock', entry.expectedStock, observed?.stock_info_v2?.seller_stock?.[0]?.stock);
  check('model.' + entry.sku + '.stock_location', 'VNZ', observed?.stock_info_v2?.seller_stock?.[0]?.location_id);
}
const output = {
  operationId: audit.operationId, itemId: audit.itemId, sourceFingerprint: audit.sourceFingerprint,
  observedAt: audit.observedAt, rawReadHashIsPreserved: true, sourceModified: false,
  baseRequestId: originalRead.base.requestId, modelsRequestId: originalRead.models.requestId,
  totalChecks: checks.length, matched: checks.filter(c => c.equal).length,
  differences: checks.filter(c => !c.equal), checks,
  variantImageIds, rawQc: audit.qc,
  note: 'This reports each independently checkable field even when generic QC rejects the incomplete initial snapshot. Receipt-ID mapping is not proof that omitted SKU/tier fields were returned. Weight differences are actual; no normalization is accepted. Cover quality is a separate review.',
};
const outputPath = resolve(directory, 'row65-initial-field-audit.json');
await writeFile(outputPath, JSON.stringify(output, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ outputPath, totalChecks: output.totalChecks, matched: output.matched, differences: output.differences, variantImageIds }, null, 2));
