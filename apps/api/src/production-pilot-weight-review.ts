import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson, preparedWeightKilograms, type PreparedDocument } from '@shopee/domain';
import type { FieldSnapshot } from '../../../packages/shopee/src/field-client.js';

const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' } as const;
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const tier = z.array(z.number().int().nonnegative()).max(2);
const reviewSchema = z
  .object({
    version: z.literal(1),
    scope: z
      .object({
        environment: z.literal('production'),
        partnerId: z.literal('2010476'),
        shopId: z.literal('1423724897'),
      })
      .strict(),
    operationId: z.string().uuid(),
    itemId: id,
    sourceFingerprint: hash,
    sourceKey: z.string().min(1),
    authorizationReference: z.string().min(1).max(4000),
    authorizedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    models: z
      .array(
        z
          .object({
            modelId: id,
            sku: z.string().min(1),
            tierIndex: tier,
            sourceGrams: z.number().finite().positive(),
            acceptedGrams: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type ProductionPilotWeightReview = z.infer<typeof reviewSchema>;
type Binding = { operationId: string; itemId: string; sourceFingerprint: string };
export type ProductionPilotWeightReviewOptions = {
  /** Trusted server-only lookup. HTTP callers cannot submit review records or nominate paths. */
  findReview: (binding: Binding) => Promise<Uint8Array | null>;
  now?: () => number;
};
const fail = (code: string): never => {
  throw Error('PRODUCTION_PILOT_WEIGHT_' + code);
};
function numericId(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return fail('MODEL_BINDING_INVALID');
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    return fail('MODEL_BINDING_INVALID');
  const result = id.safeParse(String(value));
  if (!result.success) return fail('MODEL_BINDING_INVALID');
  return result.data;
}
function kilograms(value: unknown) {
  // Shopee returns decimal strings. Only explicit decimal strings or finite positive numbers count.
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (
    typeof value === 'string' &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0
  )
    return Number(value);
  return fail('OBSERVED_VALUE_INVALID');
}

/** Read an operator-created append-only receipt. This module never creates/updates a review. */
export function productionPilotWeightReviewFileLookup(
  productionRoot: string,
): ProductionPilotWeightReviewOptions['findReview'] {
  if (!isAbsolute(productionRoot)) fail('LOCAL_ROOT_REQUIRED');
  const directory = resolve(productionRoot, 'weight-reviews');
  return async ({ operationId }) => {
    z.string().uuid().parse(operationId);
    try {
      const root = await realpath(directory),
        path = await realpath(resolve(directory, operationId + '.json'));
      const child = relative(root, path);
      if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child))
        fail('REVIEW_PATH_INVALID');
      const bytes = await readFile(path);
      if (bytes.length > 65536) fail('REVIEW_INVALID');
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
}

/** The original snapshot is retained. This is an exact, approved per-model mapping, not rounding
 * tolerance and not a change to the source or generic Shopee comparator. */
export async function reconcileProductionPilotWeights(
  input: Binding & {
    document: PreparedDocument;
    raw: FieldSnapshot;
  },
  options?: ProductionPilotWeightReviewOptions,
) {
  if (!options) return { qcSnapshot: input.raw };
  const bytes = await options.findReview({
    operationId: input.operationId,
    itemId: input.itemId,
    sourceFingerprint: input.sourceFingerprint,
  });
  if (bytes === null) return { qcSnapshot: input.raw };
  if (!(bytes instanceof Uint8Array) || bytes.length > 65536) return fail('REVIEW_INVALID');
  let review: ProductionPilotWeightReview;
  try {
    review = reviewSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch {
    return fail('REVIEW_INVALID');
  }
  const now = options.now?.() ?? Date.now();
  if (
    !Number.isFinite(now) ||
    Date.parse(review.authorizedAt) > now ||
    Date.parse(review.expiresAt) <= now ||
    Date.parse(review.expiresAt) <= Date.parse(review.authorizedAt)
  )
    return fail('REVIEW_EXPIRED');
  if (
    review.operationId !== input.operationId ||
    review.itemId !== input.itemId ||
    review.sourceFingerprint !== input.sourceFingerprint ||
    review.sourceKey !== input.document.sourceKey ||
    numericId(input.raw.item.item_id) !== input.itemId
  )
    return fail('SOURCE_BINDING_INVALID');
  const models = input.document.models,
    observed = input.raw.models.model;
  if (
    !Array.isArray(observed) ||
    review.models.length !== models.length ||
    observed.length !== models.length ||
    new Set(review.models.map((model) => model.modelId)).size !== models.length ||
    new Set(review.models.map((model) => model.sku)).size !== models.length ||
    new Set(review.models.map((model) => canonicalJson(model.tierIndex))).size !== models.length ||
    new Set(models.map((model) => model.sku)).size !== models.length ||
    new Set(observed.map((model) => numericId(model.model_id))).size !== models.length
  )
    return fail('MODEL_BINDING_INVALID');
  const mappings = review.models.map((accepted) => {
    const source = models.find((model) => model.sku === accepted.sku);
    const rows = observed.filter((model) => numericId(model.model_id) === accepted.modelId);
    const row = rows[0];
    if (
      !source ||
      source.weightGrams === undefined ||
      source.weightGrams !== accepted.sourceGrams ||
      rows.length !== 1 ||
      row?.model_sku !== accepted.sku ||
      canonicalJson(source.tierIndex) !== canonicalJson(accepted.tierIndex) ||
      !Array.isArray(row.tier_index) ||
      !tier.safeParse(row.tier_index).success ||
      canonicalJson(row.tier_index) !== canonicalJson(accepted.tierIndex)
    )
      return fail('MODEL_BINDING_INVALID');
    const observedKg = kilograms(row.weight),
      acceptedKg = preparedWeightKilograms(accepted.acceptedGrams);
    if (observedKg !== acceptedKg) return fail('OBSERVED_VALUE_MISMATCH');
    return { ...accepted, observedKg, sourceKg: preparedWeightKilograms(accepted.sourceGrams) };
  });
  if (input.document.weightGrams !== Math.max(...mappings.map((entry) => entry.sourceGrams)))
    return fail('ITEM_SOURCE_WEIGHT_INVALID');
  const observedItemKg = kilograms(input.raw.item.weight);
  if (
    observedItemKg !==
    preparedWeightKilograms(Math.max(...mappings.map((entry) => entry.acceptedGrams)))
  )
    return fail('ITEM_WEIGHT_MISMATCH');
  const qcSnapshot = structuredClone(input.raw);
  qcSnapshot.item.weight = preparedWeightKilograms(input.document.weightGrams);
  for (const row of qcSnapshot.models.model)
    row.weight = mappings.find((entry) => entry.modelId === numericId(row.model_id))!.sourceKg;
  const proof = {
    version: 1 as const,
    scope,
    operationId: input.operationId,
    itemId: input.itemId,
    sourceFingerprint: input.sourceFingerprint,
    sourceKey: review.sourceKey,
    reviewSha256: createHash('sha256').update(bytes).digest('hex'),
    authorizationReference: review.authorizationReference,
    authorizedAt: review.authorizedAt,
    expiresAt: review.expiresAt,
    observedAt: new Date(now).toISOString(),
    models: mappings,
    item: {
      observedKg: observedItemKg,
      sourceKg: preparedWeightKilograms(input.document.weightGrams),
    },
  };
  return { qcSnapshot, proof };
}
