import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from '@shopee/persistence';
import { canonicalJson } from '@shopee/domain';
import { preparedWireMediaRequirements, planPreparedWireCreate, bindPreparedWireItem } from '../packages/shopee/src/prepared-wire.js';
import { checkPreparedWireCreate } from '../packages/shopee/src/prepared-wire-qc.js';
import type { ProductionPilotPreparedInput } from '../apps/api/src/production-pilot-runner.js';
import type { FieldSnapshot } from '../packages/shopee/src/field-client.js';

// Read-only offline audit. No Shopee client, credential decryption, or mutation service.
const operationId = '007738be-04ec-4ead-88d2-825062b29056';
const itemId = '51267858328';
const directory = resolve('.local/production-pilot-1423724897');
const evidencePath = resolve(directory, 'wire-evidence', operationId, '9076e855-575b-45cb-baf2-4999560dbf06.json');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
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
  context.capabilities.gallery34 = true; // Reconstruct the frozen gallery probe only; no new capability proof.
  context.images = preparedWireMediaRequirements(input.document).map((required, index) => {
    const step = steps.find(s => s.step_key === 'media-' + index);
    const imageId = step?.receipt?.response?.image_info?.image_id ?? step?.receipt?.response?.image_info_list?.[0]?.image_info?.image_id;
    if (step?.state !== 'acknowledged' || step.media?.sourceAssetIdentity !== required.media.importId || step.media?.sha256 !== required.media.sha256 || typeof imageId !== 'string') throw Error('AUDIT_MEDIA_BINDING_INVALID');
    return { importId: required.media.importId, sha256: required.media.sha256, role: required.role, imageId };
  });
  const plan = planPreparedWireCreate(input.document, context);
  if (plan.kind !== 'ready') throw Error('AUDIT_PLAN_INVALID');
  const create = steps.find(s => s.kind === 'create'), init = steps.find(s => s.kind === 'variations');
  const read = JSON.parse(await readFile(evidencePath, 'utf8'));
  if (read.base?.kind !== 'success' || read.models?.kind !== 'success' || String(read.base.response.item_list?.[0]?.item_id) !== itemId) throw Error('AUDIT_READ_INVALID');
  const raw = { item: read.base.response.item_list[0], models: read.models.response } as FieldSnapshot;
  const qcContext = { ...context, stockLocationBySku: structuredClone(input.stockLocationEvidence!.expectedLocationBySku) };
  const qc = checkPreparedWireCreate(input.document, qcContext, raw);
  const ackModels = init.receipt?.response?.model ?? init.receipt?.envelope?.response?.model;
  const modelAudit = input.document.models.map((source, index) => {
    const request = init.payload.model[index];
    const ack = ackModels?.find((m: any) => canonicalJson(m.tier_index) === canonicalJson(source.tierIndex)) ?? ackModels?.find((m: any) => m.model_sku === source.sku);
    const observed = (raw.models.model as any[]).find(m => m.model_sku === source.sku) ?? (ack && (raw.models.model as any[]).find(m => m.model_id === ack.model_id));
    return {
      sku: source.sku, sourceTierIndex: source.tierIndex, sourceWeightGrams: source.weightGrams,
      sourceWeightKg: source.weightGrams === undefined ? null : source.weightGrams / 1000,
      sourceDimensionCm: source.dimensionCm, expectedPrice: source.originalPrice, expectedStock: source.stock,
      requested: request, acknowledgement: ack ?? null,
      observed: observed ?? null,
      mappingBasis: observed?.model_sku === source.sku ? 'raw_model_sku' : ack && observed ? 'init_receipt_model_id' : 'unresolved',
      weightDifferenceGrams: observed && source.weightGrams !== undefined ? Number((Number(observed.weight) * 1000 - source.weightGrams).toFixed(6)) : null,
    };
  });
  const logisticsDifferences: string[] = [];
  for (const expected of create.payload.logistic_info) {
    const observed = (raw.item.logistic_info as any[])?.find(row => row.logistic_id === expected.logistic_id);
    for (const [key, value] of Object.entries(expected)) if (!observed || canonicalJson(observed[key]) !== canonicalJson(value)) logisticsDifferences.push('logistic_info.' + expected.logistic_id + '.' + key);
  }
  const output = {
    operationId, itemId, sourceIdentity: op.source_identity, sourceRevision: op.source_revision, sourceFingerprint: op.source_fingerprint,
    evidencePath, observedAt: read.observedAt, baseRequestId: read.base.requestId, modelsRequestId: read.models.requestId,
    createState: create.state, initState: init.state, createRequestId: create.receipt.requestId, initRequestId: init.receipt.requestId,
    exactCreatePayload: canonicalJson(create.payload) === canonicalJson(plan.steps[0]!.payload),
    exactVariationPayload: canonicalJson(init.payload) === canonicalJson(bindPreparedWireItem(plan.steps[1]!, itemId).payload),
    requestedPayloadHashes: { create: hash(create.payload), init: hash(init.payload) },
    qc, logisticsDifferences, modelAudit,
    initReceiptResponseKeys: Object.keys(init.receipt?.response ?? {}),
    initReceiptEnvelopeResponseKeys: Object.keys(init.receipt?.envelope?.response ?? {}),
    frozenDocument: input.document,
    requestedCreate: create.payload,
    rawItem: raw.item, rawTierVariation: raw.models.tier_variation,
    singleReadOnly: true, stableReadPairVerified: false, mutations: 0,
    note: 'No source, raw response, price, weight, mapping, or acceptance criteria was modified. Initial missing SKU/index data remains unverified; receipt-ID matching is reported separately and is not a QC pass.'
  };
  const outputPath = resolve(directory, 'row65-initial-source-audit.json');
  await writeFile(outputPath, JSON.stringify(output, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ outputPath, operationId, itemId, exactCreatePayload: output.exactCreatePayload, exactVariationPayload: output.exactVariationPayload, qc, logisticsDifferences, initReceiptResponseKeys: output.initReceiptResponseKeys, initReceiptEnvelopeResponseKeys: output.initReceiptEnvelopeResponseKeys, modelAudit }, null, 2));
} finally { await pool.end(); }
