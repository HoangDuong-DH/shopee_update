import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@shopee/domain';
import type { FieldSnapshot } from './field-client.js';
import { normalizePreparedWireSnapshot } from './prepared-wire.js';

const identifier = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((v) => Number.isSafeInteger(Number(v)));
const text = z
  .string()
  .min(1)
  .refine((v) => !/[\u0000-\u001f\u007f]/u.test(v));
const integer = z.number().int().nonnegative().safe();
const index = z.array(integer).max(2);
const addedSchema = z
  .object({
    sku: text.max(100),
    tierIndex: index,
    originalPrice: integer.positive(),
    stock: integer,
    locationId: text.nullable(),
    gtin: text.optional(),
  })
  .strict();
export const variationMutationSchema = z
  .object({
    version: z.literal(1),
    itemId: identifier.refine((v) => v !== '0'),
    baselineFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    source: z
      .object({ key: text, digest: z.string().regex(/^[a-f0-9]{64}$/), refs: z.array(text).min(1) })
      .strict(),
    tiers: z
      .array(
        z
          .object({
            name: text,
            options: z
              .array(
                z
                  .object({
                    previousIndex: integer.nullable(),
                    name: text,
                    imageId: text.optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(50),
          })
          .strict(),
      )
      .max(2),
    retained: z
      .array(z.object({ modelId: identifier.refine((v) => v !== '0'), tierIndex: index }).strict())
      .max(50),
    removedModelIds: z.array(identifier).max(50),
    added: z.array(addedSchema).max(50),
    replaceAllModels: z.literal(true).optional(),
  })
  .strict();
export type VariationMutationIntent = z.infer<typeof variationMutationSchema>;
export type VariationMutationContext = {
  baseline: FieldSnapshot;
  scope: { environment: string; partnerId: string; shopId: string };
  promotionSnapshot: unknown;
  itemLimits: Record<string, any>;
  allowedLocationIds: (string | null)[];
  resolvedImageIds: string[];
  maxVariationPriceRatio: { value: number; source: string };
};
export type VariationMutationStep = {
  ordinal: number;
  method: 'POST';
  group: 'variationStructure';
  path:
    | '/api/v2/product/update_tier_variation'
    | '/api/v2/product/add_model'
    | '/api/v2/product/delete_model'
    | '/api/v2/product/init_tier_variation';
  payload: Record<string, any>;
  expectedBeforeFingerprint: string;
};
export type VariationMutationPlan = {
  kind: 'ready';
  intent: VariationMutationIntent;
  baseline: FieldSnapshot;
  fingerprint: string;
  steps: VariationMutationStep[];
};
export type VariationMutationIssue = { code: string; field: string };
export type VariationModelBinding = { sku: string; modelId: string; tierIndex: number[] };
export type VariationMutationCheck = {
  verified: boolean;
  mismatchedPaths: string[];
  addedModelBindings: VariationModelBinding[];
};
const clone = <T>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const numericId = (v: unknown) =>
  (typeof v === 'number' || typeof v === 'string') &&
  identifier.safeParse(String(v)).success &&
  Number(v) > 0;
const location = (v: unknown) => (v === '' || v === undefined || v === null ? null : v);
class Invalid extends Error {
  constructor(
    readonly code: string,
    readonly field: string,
  ) {
    super(code);
  }
}
function requireThat(ok: unknown, code: string, field: string): asserts ok {
  if (!ok) throw new Invalid(code, field);
}
function normalized(raw: FieldSnapshot): FieldSnapshot {
  const snapshot = normalizePreparedWireSnapshot(raw);
  // get_model_list is not called for default-model items. Its empty standardized
  // tier list and the service's absent list represent the same known empty state.
  if (snapshot.item.has_model === false && snapshot.models.standardise_tier_variation !== undefined) {
    requireThat(
      Array.isArray(snapshot.models.standardise_tier_variation) &&
        snapshot.models.standardise_tier_variation.length === 0,
      'DEFAULT_TIER_READBACK_INVALID',
      'models.standardise_tier_variation',
    );
    delete snapshot.models.standardise_tier_variation;
  }
  return snapshot;
}
export function variationBaselineFingerprint(raw: FieldSnapshot): string {
  return hash(normalized(raw));
}

function limits(value: number, rule: any, field: string) {
  requireThat(
    rule &&
      Number.isFinite(rule.min_limit) &&
      Number.isFinite(rule.max_limit) &&
      rule.min_limit <= rule.max_limit,
    'LIMIT_UNVERIFIED',
    field,
  );
  requireThat(value >= rule.min_limit && value <= rule.max_limit, 'LIMIT_EXCEEDED', field);
}
function unchangedPriceStock(row: any, field: string) {
  requireThat(
    row.has_promotion === false && (row.promotion_id === undefined || row.promotion_id === 0),
    'PROMOTION_STATE_UNVERIFIED',
    field,
  );
  requireThat(row.is_fulfillment_by_shopee === false, 'FULFILLMENT_STATE_UNVERIFIED', field);
  requireThat(
    Array.isArray(row.price_info) && row.price_info.length === 1,
    'PRICE_STATE_UNVERIFIED',
    field,
  );
  const p = row.price_info[0];
  requireThat(
    p.currency === 'VND' &&
      Number.isSafeInteger(p.original_price) &&
      p.original_price > 0 &&
      p.current_price === p.original_price,
    'PRICE_STATE_UNVERIFIED',
    field,
  );
  for (const key of ['inflated_price_of_original_price', 'inflated_price_of_current_price'])
    requireThat(
      p[key] === undefined || p[key] === p.original_price,
      'PRICE_STATE_UNVERIFIED',
      `${field}.${key}`,
    );
  const s = row.stock_info_v2;
  requireThat(
    s &&
      Array.isArray(s.seller_stock) &&
      s.seller_stock.length === 1 &&
      Number.isSafeInteger(s.seller_stock[0].stock) &&
      s.seller_stock[0].stock >= 0,
    'STOCK_STATE_UNVERIFIED',
    field,
  );
  requireThat(
    s.summary_info?.total_reserved_stock === 0 &&
      s.summary_info?.total_available_stock === s.seller_stock[0].stock,
    'RESERVED_STOCK_UNVERIFIED',
    field,
  );
  requireThat(
    Array.isArray(s.shopee_stock) && s.shopee_stock.every((r: any) => r.stock === 0),
    'SHOPEE_STOCK_UNVERIFIED',
    field,
  );
  const advance = s.advance_stock;
  requireThat(
    advance === undefined ||
      (Array.isArray(advance)
        ? advance.length === 0
        : advance &&
          advance.sellable_advance_stock === 0 &&
          advance.in_transit_advance_stock === 0),
    'ADVANCE_STOCK_UNVERIFIED',
    field,
  );
}
function validatePromotion(snapshot: unknown, itemId: string, complete: boolean) {
  const p: any = snapshot;
  if (!complete && p === undefined) return;
  requireThat(
    p?.error === '' &&
      Array.isArray(p.response?.success_list) &&
      p.response.success_list.length === 1 &&
      String(p.response.success_list[0].item_id) === itemId &&
      (p.response.failure_list === undefined ||
        (Array.isArray(p.response.failure_list) && p.response.failure_list.length === 0)),
    'PROMOTION_SNAPSHOT_UNVERIFIED',
    'promotionSnapshot',
  );
  const rows = p.response.success_list[0].promotion;
  if (!complete && rows === undefined) return;
  requireThat(
    Array.isArray(rows) && rows.length === 0,
    'PROMOTION_DETAIL_UNVERIFIED',
    'promotionSnapshot',
  );
}
function baselineTiers(raw: FieldSnapshot) {
  const legacy: any[] = raw.models.tier_variation;
  const standard = raw.models.standardise_tier_variation as any[] | undefined;
  requireThat(legacy.length <= 2, 'TIER_COUNT_UNSUPPORTED', 'baseline.tiers');
  requireThat(
    !legacy.length || standard !== undefined,
    'STANDARD_TIER_IDENTITY_UNVERIFIED',
    'baseline.standardise_tier_variation',
  );
  if (standard !== undefined) {
    requireThat(
      Array.isArray(standard) && standard.length === legacy.length,
      'TIER_READBACK_CONFLICT',
      'baseline.standardise_tier_variation',
    );
    standard.forEach((s, t) => {
      requireThat(
        Number.isSafeInteger(s.variation_id) &&
          s.variation_id >= 0 &&
          (s.variation_group_id === undefined ||
            (Number.isSafeInteger(s.variation_group_id) && s.variation_group_id >= 0)),
        'STANDARD_TIER_IDENTITY_UNVERIFIED',
        `baseline.tiers.${t}`,
      );
      requireThat(
        s.variation_name === legacy[t].name &&
          Array.isArray(s.variation_option_list) &&
          s.variation_option_list.length === legacy[t].option_list.length,
        'TIER_READBACK_CONFLICT',
        `baseline.tiers.${t}`,
      );
      s.variation_option_list.forEach((o: any, i: number) => {
        requireThat(
          Number.isSafeInteger(o.variation_option_id) && o.variation_option_id >= 0,
          'STANDARD_OPTION_IDENTITY_UNVERIFIED',
          `baseline.tiers.${t}.${i}`,
        );
        requireThat(
          o.variation_option_name === legacy[t].option_list[i].option &&
            (o.image_id ?? '') === (legacy[t].option_list[i].image?.image_id ?? ''),
          'TIER_READBACK_CONFLICT',
          `baseline.tiers.${t}.${i}`,
        );
      });
    });
  }
  return { legacy, standard };
}
function plannedTiers(intent: VariationMutationIntent, baseline: FieldSnapshot) {
  const old = baselineTiers(baseline),
    replacing = intent.replaceAllModels === true;
  const legacy = intent.tiers.map((tier, t) => {
    const prior = replacing ? undefined : old.legacy[t];
    return {
      ...(prior ? clone(prior) : {}),
      name: tier.name,
      option_list: tier.options.map((option) => {
        const previous =
          option.previousIndex === null || replacing
            ? undefined
            : prior?.option_list[option.previousIndex];
        const out: any = { ...(previous ? clone(previous) : {}), option: option.name };
        if (option.imageId !== undefined)
          out.image = { ...(out.image ?? {}), image_id: option.imageId };
        return out;
      }),
    };
  });
  const standard = intent.tiers.map((tier, t) => {
    const prior = replacing ? undefined : old.standard?.[t];
    return {
      ...(prior ? clone(prior) : { variation_id: 0, variation_group_id: 0 }),
      variation_name: tier.name,
      variation_option_list: tier.options.map((option) => {
        const previous =
          option.previousIndex === null || replacing
            ? undefined
            : prior?.variation_option_list[option.previousIndex];
        const out: any = {
          ...(previous ? clone(previous) : { variation_option_id: 0 }),
          variation_option_name: option.name,
        };
        const imageId =
          option.imageId ??
          (option.previousIndex === null || replacing
            ? undefined
            : old.legacy[t]?.option_list[option.previousIndex]?.image?.image_id);
        if (imageId) out.image_id = imageId;
        return out;
      }),
    };
  });
  return { legacy, standard };
}
function wireTiers(intent: VariationMutationIntent, baseline: FieldSnapshot) {
  return plannedTiers(intent, baseline).standard.map((s) => ({
    variation_id: s.variation_id,
    variation_name: s.variation_name,
    ...(s.variation_group_id === undefined ? {} : { variation_group_id: s.variation_group_id }),
    variation_option_list: s.variation_option_list.map((o: any) => ({
      variation_option_id: o.variation_option_id,
      variation_option_name: o.variation_option_name,
      ...(o.image_id ? { image_id: o.image_id } : {}),
    })),
  }));
}
function sourceModel(m: VariationMutationIntent['added'][number]) {
  return {
    model_sku: m.sku,
    tier_index: clone(m.tierIndex),
    original_price: m.originalPrice,
    seller_stock: [
      { stock: m.stock, ...(m.locationId === null ? {} : { location_id: m.locationId }) },
    ],
    ...(m.gtin === undefined ? {} : { gtin_code: m.gtin }),
  };
}
function deterministicAfter(
  intent: VariationMutationIntent,
  original: FieldSnapshot,
  before: FieldSnapshot,
  step: VariationMutationStep,
) {
  const after = clone(before);
  if (step.path.endsWith('/delete_model'))
    after.models.model = after.models.model.filter(
      (m) => String(m.model_id) !== String(step.payload.model_id),
    );
  else if (step.path.endsWith('/update_tier_variation')) {
    const tiers = plannedTiers(intent, original);
    after.models.tier_variation = tiers.legacy;
    if (after.models.standardise_tier_variation !== undefined)
      after.models.standardise_tier_variation = tiers.standard;
    after.models.model = intent.retained.map((kept) => {
      const m: any = clone(before.models.model.find((m) => String(m.model_id) === kept.modelId)!);
      m.tier_index = clone(kept.tierIndex);
      if (m.model_name !== undefined)
        m.model_name = kept.tierIndex.map((i, t) => intent.tiers[t]!.options[i]!.name).join(',');
      return m;
    });
  }
  return after;
}
function planHash(plan: Omit<VariationMutationPlan, 'fingerprint'>) {
  return hash(plan);
}

export function planVariationMutation(
  input: unknown,
  context: VariationMutationContext,
): VariationMutationPlan | { kind: 'blocked'; issues: VariationMutationIssue[] } {
  try {
    const intent = variationMutationSchema.parse(input),
      baseline = normalized(context.baseline);
    const { scope } = context;
    requireThat(
      scope.environment === 'sandbox' &&
        scope.partnerId === '1232297' &&
        scope.shopId === '227418363',
      'OWNER_SCOPE_UNSUPPORTED',
      'scope',
    );
    requireThat(!['803934364', '846056124'].includes(intent.itemId), 'PROTECTED_LISTING', 'itemId');
    requireThat(
      String(baseline.item.item_id) === intent.itemId &&
        variationBaselineFingerprint(baseline) === intent.baselineFingerprint,
      'BASELINE_MISMATCH',
      'baselineFingerprint',
    );
    requireThat(
      baseline.item.has_promotion === false,
      'PROMOTION_STATE_UNVERIFIED',
      'item.has_promotion',
    );
    const old = baselineTiers(baseline),
      oldModels = baseline.models.model as any[],
      oldIds = baseline.item.has_model ? oldModels.map((m) => String(m.model_id)) : ['0'];
    const allDecisions = [...intent.retained.map((m) => m.modelId), ...intent.removedModelIds];
    requireThat(
      new Set(allDecisions).size === allDecisions.length &&
        same([...allDecisions].sort(), [...oldIds].sort()),
      'MODEL_DECISION_COVERAGE',
      'retained/removedModelIds',
    );
    const replacing = intent.replaceAllModels === true;
    requireThat(
      !replacing || intent.tiers.length !== old.legacy.length,
      'SAME_TIER_REINITIALIZATION_UNSUPPORTED',
      'replaceAllModels',
    );
    requireThat(
      (intent.tiers.length === old.legacy.length && !replacing) ||
        (replacing &&
          intent.retained.length === 0 &&
          intent.added.length > 0 &&
          intent.tiers.every((t) => t.options.every((o) => o.previousIndex === null))),
      'REPLACE_ALL_AUTHORIZATION_REQUIRED',
      'replaceAllModels',
    );
    requireThat(
      intent.retained.length + intent.added.length > 0 &&
        intent.retained.length + intent.added.length <= 50,
      'MODEL_COUNT_INVALID',
      'models',
    );
    if (intent.tiers.length === 0)
      requireThat(
        replacing && intent.added.length === 1 && intent.added[0]!.sku === baseline.item.item_sku,
        'SKU_TRANSFER_UNVERIFIED',
        'added.0.sku',
      );
    const destructive = intent.removedModelIds.length > 0 || intent.added.length > 0 || replacing;
    validatePromotion(context.promotionSnapshot, intent.itemId, destructive);
    for (const [i, m] of (baseline.item.has_model ? oldModels : [baseline.item]).entries())
      unchangedPriceStock(m, `baseline.models.${i}`);
    requireThat(
      new Set(oldModels.map((m) => m.model_sku)).size === oldModels.length &&
        oldModels.every((m) => typeof m.model_sku === 'string' && m.model_sku.length > 0),
      'MODEL_SKU_UNVERIFIED',
      'baseline.models',
    );
    intent.tiers.forEach((t, ti) => {
      limits(
        [...t.name].length,
        context.itemLimits.tier_variation_name_length_limit,
        `tiers.${ti}.name`,
      );
      requireThat(
        new Set(t.options.map((o) => o.name)).size === t.options.length,
        'DUPLICATE_OPTION_NAME',
        `tiers.${ti}`,
      );
      const previous = t.options
        .filter((o) => o.previousIndex !== null)
        .map((o) => o.previousIndex);
      requireThat(
        new Set(previous).size === previous.length,
        'DUPLICATE_OPTION_IDENTITY',
        `tiers.${ti}`,
      );
      const standard = old.standard?.[ti];
      if (!replacing && standard?.variation_id)
        requireThat(
          t.name === standard.variation_name,
          'STANDARD_VARIATION_RENAME_UNVERIFIED',
          `tiers.${ti}.name`,
        );
      t.options.forEach((o, oi) => {
        limits(
          [...o.name].length,
          context.itemLimits.tier_variation_option_length_limit,
          `tiers.${ti}.${oi}.name`,
        );
        requireThat(
          o.previousIndex === null || (!replacing && old.legacy[ti]?.option_list[o.previousIndex]),
          'OPTION_IDENTITY_INVALID',
          `tiers.${ti}.${oi}`,
        );
        const prior =
          o.previousIndex === null ? undefined : old.legacy[ti]?.option_list[o.previousIndex];
        const priorStandard =
          o.previousIndex === null ? undefined : standard?.variation_option_list[o.previousIndex];
        if (priorStandard?.variation_option_id)
          requireThat(
            priorStandard.variation_option_name === o.name,
            'STANDARD_OPTION_RENAME_UNVERIFIED',
            `tiers.${ti}.${oi}.name`,
          );
        requireThat(
          ti === 0 || o.imageId === undefined,
          'SECOND_TIER_IMAGE_UNSUPPORTED',
          `tiers.${ti}.${oi}.imageId`,
        );
        if (prior && o.imageId !== undefined)
          requireThat(
            o.imageId === prior.image?.image_id,
            'KEPT_IMAGE_CHANGE_UNSUPPORTED',
            `tiers.${ti}.${oi}.imageId`,
          );
        if (!prior && o.imageId !== undefined)
          requireThat(
            context.resolvedImageIds.includes(o.imageId),
            'IMAGE_SOURCE_UNRESOLVED',
            `tiers.${ti}.${oi}.imageId`,
          );
      });
    });
    const finalTiers = plannedTiers(intent, baseline);
    const firstImages = (finalTiers.legacy[0]?.option_list ?? []).map(
      (o: any) => o.image?.image_id,
    );
    requireThat(
      !firstImages.some(Boolean) || firstImages.every(Boolean),
      'VARIATION_IMAGE_COVERAGE',
      'tiers.0',
    );
    const positions = [...intent.retained, ...intent.added].map((m) => m.tierIndex);
    requireThat(
      new Set(positions.map((p) => canonicalJson(p))).size === positions.length,
      'DUPLICATE_MODEL_POSITION',
      'models.tierIndex',
    );
    positions.forEach((position, i) =>
      requireThat(
        position.length === intent.tiers.length &&
          position.every((v, t) => intent.tiers[t]?.options[v]),
        'MODEL_INDEX_INVALID',
        `models.${i}.tierIndex`,
      ),
    );
    intent.tiers.forEach((t, ti) =>
      t.options.forEach((_, oi) =>
        requireThat(
          positions.some((p) => p[ti] === oi),
          'UNUSED_OPTION',
          `tiers.${ti}.${oi}`,
        ),
      ),
    );
    intent.retained.forEach((m, i) => {
      const prior = oldModels.find((old) => String(old.model_id) === m.modelId)!;
      requireThat(
        m.tierIndex.every(
          (o, t) => intent.tiers[t]!.options[o]!.previousIndex === prior.tier_index[t],
        ),
        'KEPT_MODEL_IDENTITY_CHANGED',
        `retained.${i}`,
      );
      const priorName = prior.tier_index
        .map((o: number, t: number) => old.legacy[t].option_list[o].option)
        .join(',');
      requireThat(
        prior.model_name === undefined || prior.model_name === priorName,
        'MODEL_NAME_FORMAT_UNVERIFIED',
        `retained.${i}`,
      );
    });
    const keptSkus = intent.retained.map(
        (m) => oldModels.find((old) => String(old.model_id) === m.modelId)!.model_sku,
      ),
      addedSkus = intent.added.map((m) => m.sku);
    requireThat(
      new Set([...keptSkus, ...addedSkus]).size === keptSkus.length + addedSkus.length,
      'DUPLICATE_MODEL_SKU',
      'models.sku',
    );
    if (intent.added.length) {
      requireThat(
        baseline.item.wholesales === undefined ||
          (Array.isArray(baseline.item.wholesales) && baseline.item.wholesales.length === 0),
        'WHOLESALE_PRICE_UNSUPPORTED',
        'item.wholesales',
      );
      const ratio = context.maxVariationPriceRatio;
      requireThat(
        ratio &&
          Number.isFinite(ratio.value) &&
          ratio.value >= 1 &&
          typeof ratio.source === 'string' &&
          ratio.source.length > 0,
        'PRICE_RATIO_UNVERIFIED',
        'maxVariationPriceRatio',
      );
      const prices = [
        ...intent.retained.map(
          (m) =>
            oldModels.find((old) => String(old.model_id) === m.modelId)!.price_info[0]
              .original_price,
        ),
        ...intent.added.map((m) => m.originalPrice),
      ];
      requireThat(
        Math.max(...prices) / Math.min(...prices) <= ratio.value,
        'PRICE_RATIO_EXCEEDED',
        'added.originalPrice',
      );
      const rule = context.itemLimits.gtin_limit?.gtin_validation_rule;
      requireThat(
        ['Optional', 'Mandatory', 'Flexible'].includes(rule),
        'GTIN_RULE_UNVERIFIED',
        'gtin',
      );
      intent.added.forEach((m, i) => {
        limits(m.originalPrice, context.itemLimits.price_limit, `added.${i}.originalPrice`);
        limits(m.stock, context.itemLimits.stock_limit, `added.${i}.stock`);
        requireThat(
          context.allowedLocationIds.includes(m.locationId),
          'LOCATION_UNVERIFIED',
          `added.${i}.locationId`,
        );
        requireThat(
          rule === 'Optional' || m.gtin !== undefined,
          'GTIN_SOURCE_REQUIRED',
          `added.${i}.gtin`,
        );
        if (m.gtin !== undefined)
          requireThat(
            /^\d{8,14}$/.test(m.gtin) || (m.gtin === '00' && rule !== 'Mandatory'),
            'GTIN_INVALID',
            `added.${i}.gtin`,
          );
      });
    }
    const steps: VariationMutationStep[] = [];
    let current = clone(baseline);
    const push = (path: VariationMutationStep['path'], payload: Record<string, any>) => {
      const step: VariationMutationStep = {
        ordinal: steps.length,
        method: 'POST',
        group: 'variationStructure',
        path,
        payload,
        expectedBeforeFingerprint: variationBaselineFingerprint(current),
      };
      steps.push(step);
      current = deterministicAfter(intent, baseline, current, step);
    };
    if (replacing)
      push('/api/v2/product/init_tier_variation', {
        item_id: Number(intent.itemId),
        ...(intent.tiers.length ? {} : { tier_variation: [] }),
        standardise_tier_variation: wireTiers(intent, baseline),
        model: intent.added.map(sourceModel),
      });
    else {
      const tiersChanged = !same(finalTiers.legacy, old.legacy);
      if (tiersChanged)
        push('/api/v2/product/update_tier_variation', {
          item_id: Number(intent.itemId),
          standardise_tier_variation: wireTiers(intent, baseline),
          model_list: intent.retained.map((m) => ({
            model_id: Number(m.modelId),
            tier_index: m.tierIndex,
          })),
        });
      else
        for (const modelId of intent.removedModelIds)
          push('/api/v2/product/delete_model', {
            item_id: Number(intent.itemId),
            model_id: Number(modelId),
          });
      if (intent.added.length)
        push('/api/v2/product/add_model', {
          item_id: Number(intent.itemId),
          model_list: intent.added.map(sourceModel),
        });
    }
    requireThat(steps.length > 0, 'NO_CHANGE', 'intent');
    const plan = { kind: 'ready' as const, intent, baseline, steps };
    return { ...plan, fingerprint: planHash(plan) };
  } catch (error) {
    return {
      kind: 'blocked',
      issues:
        error instanceof Invalid
          ? [{ code: error.code, field: error.field }]
          : error instanceof z.ZodError
            ? error.issues.map((i) => ({ code: 'INTENT_INVALID', field: i.path.join('.') }))
            : [{ code: 'BASELINE_INVALID', field: 'baseline' }],
    };
  }
}

function differences(expected: any, actual: any, path = ''): string[] {
  if (same(expected, actual)) return [];
  if (
    Array.isArray(expected) !== Array.isArray(actual) ||
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object'
  )
    return [path || '$'];
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap((k) =>
    k in expected && k in actual
      ? differences(expected[k], actual[k], path ? `${path}.${k}` : k)
      : [path ? `${path}.${k}` : k],
  );
}
function newModelChecks(
  source: VariationMutationIntent['added'][number],
  row: any,
  item: any,
  path: string,
): string[] {
  const issues: string[] = [],
    check = (ok: unknown, suffix: string) => {
      if (!ok) issues.push(`${path}.${suffix}`);
    };
  check(row.model_sku === source.sku, 'model_sku');
  check(same(row.tier_index, source.tierIndex), 'tier_index');
  if (source.tierIndex.length) check(row.model_status === 'MODEL_NORMAL', 'model_status');
  try {
    unchangedPriceStock(row, path);
  } catch (error) {
    issues.push(error instanceof Invalid ? error.field : path);
  }
  check(row.price_info?.[0]?.original_price === source.originalPrice, 'price_info.original_price');
  check(
    row.stock_info_v2?.seller_stock?.length === 1 &&
      row.stock_info_v2.seller_stock[0].stock === source.stock &&
      location(row.stock_info_v2.seller_stock[0].location_id) === source.locationId,
    'stock_info_v2.seller_stock',
  );
  for (const key of ['weight', 'dimension', 'pre_order'])
    if (row[key] !== undefined) check(item[key] !== undefined && same(row[key], item[key]), key);
  if (source.gtin !== undefined) check(row.gtin_code === source.gtin, 'gtin_code');
  else check(row.gtin_code === undefined || row.gtin_code === '', 'gtin_code');
  return issues;
}
export function checkVariationMutationStage(
  plan: VariationMutationPlan,
  ordinal: number,
  beforeRaw: FieldSnapshot,
  afterRaw: FieldSnapshot,
  receipt?: unknown,
): VariationMutationCheck {
  const mismatchedPaths: string[] = [];
  const addedModelBindings: VariationModelBinding[] = [];
  try {
    const { fingerprint, ...body } = plan;
    requireThat(planHash(body) === fingerprint, 'PLAN_TAMPERED', 'plan.fingerprint');
    const step = plan.steps[ordinal];
    requireThat(step && step.ordinal === ordinal, 'STAGE_INVALID', 'ordinal');
    const before = normalized(beforeRaw),
      after = normalized(afterRaw);
    requireThat(
      variationBaselineFingerprint(before) === step.expectedBeforeFingerprint,
      'BASELINE_DRIFT',
      'before',
    );
    if (receipt !== undefined)
      requireThat(
        inspectVariationMutationAcknowledgement(step, receipt).success,
        'ACK_UNVERIFIED',
        'receipt',
      );
    if (step.path.endsWith('/update_tier_variation') || step.path.endsWith('/delete_model'))
      mismatchedPaths.push(
        ...differences(
          normalized(deterministicAfter(plan.intent, plan.baseline, before, step)),
          after,
        ),
      );
    else {
      const replacing = step.path.endsWith('/init_tier_variation'),
        expected = clone(before),
        desired = plannedTiers(plan.intent, plan.baseline);
      if (replacing) {
        expected.models.model = [];
        expected.models.tier_variation = desired.legacy;
        if (
          expected.models.standardise_tier_variation !== undefined ||
          after.models.standardise_tier_variation !== undefined
        )
          expected.models.standardise_tier_variation = desired.standard;
        expected.item.has_model = plan.intent.tiers.length > 0;
      }
      const oldIds = new Set(plan.baseline.models.model.map((m) => String(m.model_id)));
      if (plan.intent.tiers.length === 0) {
        const source = plan.intent.added[0]!;
        const defaultRow = { ...after.item, model_sku: after.item.item_sku, tier_index: [] };
        mismatchedPaths.push(...newModelChecks(source, defaultRow, before.item, 'item'));
        // Only these documented default-model fields transfer between model and item.
        for (const key of ['price_info', 'stock_info_v2', 'gtin_code']) {
          if (key in after.item) expected.item[key] = clone(after.item[key]);
          else delete expected.item[key];
        }
        requireThat(
          after.models.model.length === 0,
          'DEFAULT_MODEL_READBACK_INVALID',
          'models.model',
        );
        addedModelBindings.push({ sku: source.sku, modelId: '0', tierIndex: [] });
      } else {
        if (replacing && !before.item.has_model)
          for (const key of ['price_info', 'stock_info_v2', 'gtin_code']) delete expected.item[key];
        const existingIds = new Set(expected.models.model.map((m) => String(m.model_id)));
        const generated = after.models.model.filter(
          (m) => !existingIds.has(String(m.model_id)),
        ) as any[];
        requireThat(
          generated.length === plan.intent.added.length,
          'ADDED_MODEL_COVERAGE',
          'models.model',
        );
        const used = new Set<string>();
        for (const source of plan.intent.added) {
          const found = generated.filter(
            (m) => m.model_sku === source.sku && same(m.tier_index, source.tierIndex),
          );
          requireThat(found.length === 1, 'ADDED_MODEL_BINDING_INVALID', `models.${source.sku}`);
          const row = found[0];
          requireThat(
            numericId(row.model_id) &&
              !oldIds.has(String(row.model_id)) &&
              !used.has(String(row.model_id)),
            'GENERATED_MODEL_ID_INVALID',
            `models.${source.sku}.model_id`,
          );
          used.add(String(row.model_id));
          mismatchedPaths.push(...newModelChecks(source, row, before.item, `models.${source.sku}`));
          if (
            row.model_name !== undefined &&
            row.model_name !==
              source.tierIndex.map((i, t) => plan.intent.tiers[t]!.options[i]!.name).join(',')
          )
            mismatchedPaths.push(`models.${source.sku}.model_name`);
          expected.models.model.push(clone(row));
          addedModelBindings.push({
            sku: source.sku,
            modelId: String(row.model_id),
            tierIndex: clone(source.tierIndex),
          });
        }
      }
      mismatchedPaths.push(...differences(normalized(expected), after));
      if (receipt !== undefined) {
        const ack = inspectVariationMutationAcknowledgement(step, receipt);
        if (
          !same(
            ack.addedModelBindings,
            [...addedModelBindings].sort((a, b) => a.sku.localeCompare(b.sku)),
          )
        )
          mismatchedPaths.push('receipt.model_bindings');
      }
    }
  } catch (error) {
    mismatchedPaths.push(error instanceof Invalid ? error.field : 'readback.invalid');
  }
  return {
    verified: mismatchedPaths.length === 0,
    mismatchedPaths: [...new Set(mismatchedPaths)],
    addedModelBindings: mismatchedPaths.length
      ? []
      : addedModelBindings.sort((a, b) => a.sku.localeCompare(b.sku)),
  };
}

export function inspectVariationMutationAcknowledgement(
  step: VariationMutationStep,
  response: unknown,
): {
  success: boolean;
  kind: 'acknowledged' | 'rejected' | 'unknown';
  addedModelBindings: VariationModelBinding[];
  issues: VariationMutationIssue[];
} {
  const r: any = response;
  const bindings: VariationModelBinding[] = [];
  if (typeof r?.error === 'string' && r.error !== '')
    return {
      success: false,
      kind: 'rejected',
      addedModelBindings: [],
      issues: [{ code: 'API_REJECTED', field: 'error' }],
    };
  try {
    requireThat(
      r?.error === '' && typeof r.request_id === 'string' && r.request_id.length > 0,
      'ACK_INCOMPLETE',
      'response',
    );
    if (step.path.endsWith('/add_model') || step.path.endsWith('/init_tier_variation')) {
      const sources: any[] = step.payload.model_list ?? step.payload.model;
      requireThat(
        r.response &&
          (r.response.item_id === undefined ||
            String(r.response.item_id) === String(step.payload.item_id)) &&
          Array.isArray(r.response.model) &&
          r.response.model.length === sources.length,
        'ACK_MODEL_COVERAGE',
        'response.model',
      );
      const seen = new Set<string>();
      for (const source of sources) {
        const matches = r.response.model.filter(
          (m: any) => m.model_sku === source.model_sku && same(m.tier_index, source.tier_index),
        );
        requireThat(matches.length === 1, 'ACK_MODEL_BINDING_INVALID', 'response.model');
        const row = matches[0];
        const zero = source.tier_index.length === 0 && step.path.endsWith('/init_tier_variation');
        requireThat(
          (zero ? String(row.model_id) === '0' : numericId(row.model_id)) &&
            !seen.has(String(row.model_id)),
          'ACK_MODEL_ID_INVALID',
          'response.model.model_id',
        );
        seen.add(String(row.model_id));
        requireThat(
          Array.isArray(row.price_info) &&
            row.price_info.length === 1 &&
            row.price_info[0].original_price === source.original_price,
          'ACK_PRICE_INVALID',
          'response.model.price_info',
        );
        requireThat(
          Array.isArray(row.seller_stock) &&
            row.seller_stock.length === 1 &&
            row.seller_stock[0].stock === source.seller_stock[0].stock &&
            location(row.seller_stock[0].location_id) ===
              location(source.seller_stock[0].location_id),
          'ACK_STOCK_INVALID',
          'response.model.seller_stock',
        );
        bindings.push({
          sku: source.model_sku,
          modelId: String(row.model_id),
          tierIndex: clone(source.tier_index),
        });
      }
    } else
      requireThat(
        step.path.endsWith('/update_tier_variation') || step.path.endsWith('/delete_model'),
        'ACK_PATH_UNSUPPORTED',
        'path',
      );
    return {
      success: true,
      kind: 'acknowledged',
      addedModelBindings: bindings.sort((a, b) => a.sku.localeCompare(b.sku)),
      issues: [],
    };
  } catch (error) {
    return {
      success: false,
      kind: 'unknown',
      addedModelBindings: [],
      issues: [
        {
          code: error instanceof Invalid ? error.code : 'ACK_INVALID',
          field: error instanceof Invalid ? error.field : 'response',
        },
      ],
    };
  }
}
