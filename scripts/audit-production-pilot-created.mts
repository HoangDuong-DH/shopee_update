import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from '@shopee/persistence';
import { canonicalJson } from '@shopee/domain';
import {
  preparedWireMediaRequirements,
  planPreparedWireCreate,
  bindPreparedWireItem,
  normalizePreparedWireSnapshot,
} from '../packages/shopee/src/prepared-wire.js';
import { checkPreparedWireCreate } from '../packages/shopee/src/prepared-wire-qc.js';
import type { ProductionPilotPreparedInput } from '../apps/api/src/production-pilot-runner.js';
import type { FieldSnapshot } from '../packages/shopee/src/field-client.js';

// Offline audit: reads saved source/journal/GET evidence only. No HTTP client or mutation service.
const operationId = 'ec195c1c-b2e1-44d9-a866-e14a39988a9b',
  itemId = '51467852283';
const directory = resolve(
  '.local/production-pilot-1423724897/created-read-92fecf18-0a95-49e3-9e1f-f81099b54ddf',
);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
try {
  const op = (
    await pool.query('SELECT * FROM production_pilot_operations WHERE id=$1', [operationId])
  ).rows[0];
  if (
    !op ||
    op.owner_key !== 'production:2010476:1423724897' ||
    op.item_id !== itemId ||
    op.source_revision !== 4
  )
    throw Error('AUDIT_SCOPE_MISMATCH');
  const input = op.source_payload as ProductionPilotPreparedInput;
  const steps = (
    await pool.query(
      'SELECT * FROM production_pilot_steps WHERE operation_id=$1 ORDER BY ordinal',
      [operationId],
    )
  ).rows;
  const requirements = preparedWireMediaRequirements(input.document);
  const context = structuredClone(input.context);
  // Rebuild the exact source-authorized gallery probe for the offline plan; this is not capability evidence.
  context.capabilities.gallery34 = true;
  context.images = requirements.map((required, index) => {
    const step = steps.find((s) => s.step_key === 'media-' + index),
      imageId =
        step?.receipt?.response?.image_info?.image_id ??
        step?.receipt?.response?.image_info_list?.[0]?.image_info?.image_id;
    if (
      step?.state !== 'acknowledged' ||
      step.media?.sourceAssetIdentity !== required.media.importId ||
      step.media?.sha256 !== required.media.sha256 ||
      typeof imageId !== 'string'
    )
      throw Error('AUDIT_MEDIA_BINDING_INVALID');
    return {
      importId: required.media.importId,
      sha256: required.media.sha256,
      role: required.role,
      imageId,
    };
  });
  const plan = planPreparedWireCreate(input.document, context);
  if (plan.kind !== 'ready') throw Error('AUDIT_PLAN_INVALID');
  const qcContext = {
    ...context,
    stockLocationBySku: structuredClone(input.stockLocationEvidence!.expectedLocationBySku),
  };
  const create = steps.find((s) => s.kind === 'create'),
    variations = steps.find((s) => s.kind === 'variations');
  const exactCreatePayload =
    canonicalJson(create.payload) === canonicalJson(plan.steps[0]!.payload);
  const exactVariationPayload =
    canonicalJson(variations.payload) ===
    canonicalJson(bindPreparedWireItem(plan.steps[1]!, itemId).payload);
  const reads = await Promise.all(
    [1, 2].map(async (index) =>
      JSON.parse(await readFile(resolve(directory, 'read-' + index + '.json'), 'utf8')),
    ),
  );
  const normalized: FieldSnapshot[] = [];
  const results = reads.map((read) => {
    if (read.itemId !== itemId || read.base.kind !== 'success' || read.models.kind !== 'success')
      throw Error('AUDIT_READ_INVALID');
    const raw = {
      item: read.base.response.item_list[0],
      models: read.models.response,
    } as FieldSnapshot;
    normalized.push(normalizePreparedWireSnapshot(raw));
    const qc = checkPreparedWireCreate(input.document, qcContext, raw);
    const nonCoverMismatches = qc.mismatchedPaths.filter(
      (path) => !path.startsWith('item.promotion_image.'),
    );
    // Check every requested logistical field independently of the shared create QC comparator.
    const logisticsDifferences: string[] = [];
    for (const expected of create.payload.logistic_info) {
      const actual = (raw.item.logistic_info as any[])?.find(
        (row) => row.logistic_id === expected.logistic_id,
      );
      for (const [key, value] of Object.entries(expected))
        if (!actual || canonicalJson(actual[key]) !== canonicalJson(value))
          logisticsDifferences.push('logistic_info.' + expected.logistic_id + '.' + key);
    }
    return {
      observedAt: read.observedAt,
      baseRequestId: read.base.requestId,
      modelsRequestId: read.models.requestId,
      rawQcVerified: qc.verified,
      mismatchedPaths: qc.mismatchedPaths,
      nonCoverMismatches,
      logisticsDifferences,
      coverExpected: create.payload.promotion_images,
      coverObserved: raw.item.promotion_image,
    };
  });
  const output = {
    operationId,
    itemId,
    sourceFingerprint: op.source_fingerprint,
    sourceRevision: 4,
    createRequestId: create.receipt.requestId,
    variationRequestId: variations.receipt.requestId,
    exactCreatePayload,
    exactVariationPayload,
    modelCount: input.document.models.length,
    galleryCount: input.document.gallery.length,
    requestedPayloadHashes: { create: hash(create.payload), variations: hash(variations.payload) },
    allNormalizedRawFieldsStable: canonicalJson(normalized[0]) === canonicalJson(normalized[1]),
    onlyCoverRemains:
      exactCreatePayload &&
      exactVariationPayload &&
      results.every(
        (result) => !result.nonCoverMismatches.length && !result.logisticsDifferences.length,
      ),
    note: 'Cover is still unverified. No cover ID, ratio or raw field was changed or exempted in QC; non-cover status is reported separately.',
    priorAuditCorrection:
      'The earlier offline audit reconstructed its writer plan with the read-location map. This audit separates the frozen null write locations and the VNZ QC map; no stored request was changed.',
    mutations: 0,
    results,
  };
  await writeFile(resolve(directory, 'source-qc-audit-v2.json'), JSON.stringify(output, null, 2), {
    flag: 'wx',
  });
  console.log(JSON.stringify(output, null, 2));
} finally {
  await pool.end();
}
