import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from '@shopee/persistence';
import { canonicalJson } from '@shopee/domain';
import { preparedWireMediaRequirements, planPreparedWireCreate, bindPreparedWireItem, normalizePreparedWireSnapshot } from '../packages/shopee/src/prepared-wire.js';
import { checkPreparedWireCreate } from '../packages/shopee/src/prepared-wire-qc.js';
import type { ProductionPilotPreparedInput } from '../apps/api/src/production-pilot-runner.js';
import type { FieldSnapshot } from '../packages/shopee/src/field-client.js';

// Offline only: two supplied live GET receipts plus immutable source/journal, no outbound API.
const operationId = '007738be-04ec-4ead-88d2-825062b29056', itemId = '51267858328';
const directory = resolve('.local/production-pilot-1423724897/created-read-589e89ee-2ad5-41e2-abf1-5b41e09bb133');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const client = await pool.connect();
  let op: any, steps: any[];
  try {
    await client.query('BEGIN READ ONLY');
    op = (await client.query('SELECT * FROM production_pilot_operations WHERE id=$1', [operationId])).rows[0];
    steps = (await client.query('SELECT * FROM production_pilot_steps WHERE operation_id=$1 ORDER BY ordinal', [operationId])).rows;
    await client.query('COMMIT');
  } finally { client.release(); }
  if (!op || op.owner_key !== 'production:2010476:1423724897' || op.item_id !== itemId || op.source_revision !== 4) throw Error('AUDIT_SCOPE_MISMATCH');
  const input = op.source_payload as ProductionPilotPreparedInput;
  const context = structuredClone(input.context);
  context.capabilities.gallery34 = true; // Rebuild acknowledged, source-bound probe only; not new metadata.
  context.images = preparedWireMediaRequirements(input.document).map((required, index) => {
    const step = steps.find(s => s.step_key === 'media-' + index);
    const imageId = step?.receipt?.response?.image_info?.image_id ?? step?.receipt?.response?.image_info_list?.[0]?.image_info?.image_id;
    if (step?.state !== 'acknowledged' || step.media?.sourceAssetIdentity !== required.media.importId || step.media?.sha256 !== required.media.sha256 || typeof imageId !== 'string') throw Error('AUDIT_MEDIA_BINDING_INVALID');
    return { importId: required.media.importId, sha256: required.media.sha256, role: required.role, imageId };
  });
  const plan = planPreparedWireCreate(input.document, context);
  if (plan.kind !== 'ready') throw Error('AUDIT_PLAN_INVALID');
  const create = steps.find(s => s.kind === 'create'), init = steps.find(s => s.kind === 'variations');
  const qcContext = { ...context, stockLocationBySku: structuredClone(input.stockLocationEvidence!.expectedLocationBySku) };
  const normalized: FieldSnapshot[] = [];
  const results = await Promise.all([1, 2].map(async index => {
    const read = JSON.parse(await readFile(resolve(directory, 'read-' + index + '.json'), 'utf8'));
    if (read.operationId !== operationId || read.itemId !== itemId || read.base.kind !== 'success' || read.models.kind !== 'success') throw Error('AUDIT_READ_INVALID');
    const raw = { item: read.base.response.item_list[0], models: read.models.response } as FieldSnapshot;
    normalized[index - 1] = normalizePreparedWireSnapshot(raw);
    const qc = checkPreparedWireCreate(input.document, qcContext, raw);
    const logisticsDifferences: string[] = [];
    for (const expected of create.payload.logistic_info) {
      const actual = (raw.item.logistic_info as any[])?.find(row => row.logistic_id === expected.logistic_id);
      for (const [key, value] of Object.entries(expected)) if (!actual || canonicalJson(actual[key]) !== canonicalJson(value)) logisticsDifferences.push('logistic_info.' + expected.logistic_id + '.' + key);
    }
    const requestedTiers = init.payload.standardise_tier_variation.map((t: any) => ({ name: t.variation_name, options: t.variation_option_list.map((o: any) => ({ label: o.variation_option_name, imageId: o.image_id ?? null })) }));
    const actualTiers = (raw.models.tier_variation as any[]).map(t => ({ name: t.name, options: t.option_list.map((o: any) => ({ label: o.option, imageId: o.image?.image_id ?? null })) }));
    const modelAudit = input.document.models.map(source => {
      const actual = (raw.models.model as any[]).find(m => m.model_sku === source.sku);
      const sent = init.payload.model.find((m: any) => m.model_sku === source.sku);
      return { sku: source.sku, modelId: actual?.model_id, tierIndexExpected: source.tierIndex, tierIndexActual: actual?.tier_index, sourceWeightGrams: source.weightGrams, requestedWeightKg: sent?.weight, observedWeightKg: actual?.weight, observedWeightGrams: Number(actual?.weight) * 1000, expectedPrice: source.originalPrice, observedOriginalPrice: actual?.price_info?.[0]?.original_price, expectedStock: source.stock, observedStock: actual?.stock_info_v2, requestedDimension: sent?.dimension, observedDimension: actual?.dimension };
    });
    return { observedAt: read.observedAt, baseRequestId: read.base.requestId, modelsRequestId: read.models.requestId, qc, logisticsDifferences, exactTierNamesOrderAndImages: canonicalJson(requestedTiers) === canonicalJson(actualTiers), modelAudit, itemWeightExpected: create.payload.weight, itemWeightObserved: raw.item.weight, nonCoverNonWeightMismatches: qc.mismatchedPaths.filter(path => !path.startsWith('item.promotion_image.') && path !== 'item.weight' && !/^models\.model\.\d+\.weight$/.test(path)) };
  }));
  const output = {
    operationId, itemId, sourceRevision: op.source_revision, sourceFingerprint: op.source_fingerprint,
    exactCreatePayload: canonicalJson(create.payload) === canonicalJson(plan.steps[0]!.payload),
    exactVariationPayload: canonicalJson(init.payload) === canonicalJson(bindPreparedWireItem(plan.steps[1]!, itemId).payload),
    allNormalizedRawFieldsStable: canonicalJson(normalized[0]) === canonicalJson(normalized[1]),
    originalStrictQcVerified: results.every(result => result.qc.verified),
    results, mutations: 0,
    note: 'Original source, original wire payloads and raw responses remain unchanged. This report separately enumerates actual weight differences. Root reported explicit user acceptance of322g/131g/504g; that is not implemented or silently applied by this audit. Cover QA is separate. No new API reads or writes were issued.'
  };
  const outputPath = resolve(directory, 'row65-fresh-source-audit.json');
  await writeFile(outputPath, JSON.stringify(output, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ outputPath, ...output }, null, 2));
} finally { await pool.end(); }
