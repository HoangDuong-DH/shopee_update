/** Historical seller data is evidence for review, never authorization to publish. */
export interface SellerKnowledgeScope {
  environment: string;
  partnerId: string;
  shopId: string;
}
export interface SellerKnowledgeValue {
  valueId: number;
  originalValueName?: string;
  valueUnit?: string;
}
export interface SellerKnowledgeAttribute {
  attributeId: number;
  values: SellerKnowledgeValue[];
}
export interface SellerKnowledgeSourceFact extends SellerKnowledgeAttribute {
  sourceId: string;
  sourceLocator: string;
  /** A source declaration for local preview; not a Shopee publication approval. */
  confirmed: boolean;
}
export interface SellerKnowledgeTarget {
  scope: SellerKnowledgeScope;
  categoryId: number;
  brandId: number;
  skus?: string[];
  skuIdentityComplete?: boolean;
  modelCount?: number;
  sourceFacts?: SellerKnowledgeSourceFact[];
  currentAttributes?: SellerKnowledgeAttribute[];
  inapplicableAttributeIds?: number[];
  excludeItemId?: string;
}
export interface SellerKnowledgeObservation {
  evidenceId: string;
  scope: SellerKnowledgeScope;
  itemId: string;
  title: string;
  categoryId: number;
  brandId: number;
  modelSkus: string[];
  skuIdentityComplete?: boolean;
  modelCount?: number;
  attributes: SellerKnowledgeAttribute[];
  observedAt: string;
  status: string;
  approvedForReuse?: boolean;
}
export interface SellerKnowledgeAttributeMetadata {
  attributeId: number;
  name: string;
  mandatory: boolean;
  inputType: number;
  inputValidationType: number;
  formatType: number;
  maxValueCount?: number;
  units?: string[];
  values?: Array<{ valueId: number; name: string; valueUnit?: string }>;
  applicable?: boolean;
  /** Every ancestor selection must match; requirements are combined with AND. */
  dependsOn?: Array<{ attributeId: number; valueId: number }>;
}
export interface SellerKnowledgeMetadata {
  scope: SellerKnowledgeScope;
  categoryId: number;
  observedAt: string;
  expiresAt?: string;
  attributes: SellerKnowledgeAttributeMetadata[];
}
export type SellerKnowledgeSourceClass =
  'product_source' | 'exact_sku' | 'same_shop' | 'external_context';
export interface SellerKnowledgeCoverage {
  matchedSkuCount: number;
  targetSkuCount: number;
  partial: boolean;
}
export interface SellerKnowledgeSuggestion {
  attributeId: number;
  name: string;
  values: SellerKnowledgeValue[];
  evidenceIds: string[];
  sourceClass: SellerKnowledgeSourceClass;
  reasons: string[];
  /** Eligible only for local preview prefill, never permission to mutate Shopee. */
  canPrefill: boolean;
  confidence: 'confirmed' | 'reference' | 'blocked';
  coverage: SellerKnowledgeCoverage;
  alternatives?: Array<{ values: SellerKnowledgeValue[]; evidenceIds: string[] }>;
}
export interface SellerKnowledgeIssue {
  attributeId?: number;
  code: string;
  detail: string;
  evidenceId?: string;
}
export interface SellerKnowledgeResult {
  suggestions: SellerKnowledgeSuggestion[];
  issues: SellerKnowledgeIssue[];
  missingMandatoryAttributeIds: number[];
  consideredObservationCount: number;
  truncatedObservationCount: number;
}

const METADATA_MAX_AGE_MS = 15 * 60 * 1000;
const OBSERVATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OBSERVATIONS = 50;
const MAX_ATTRIBUTES = 100;
const sensitiveAttributeIds = new Set([
  100010, 100037, 100133, 100370, 101067, 101068, 101386, 102560,
]);
const variationAttributeIds = new Set([100025, 100248]);
const sourceRank: Record<SellerKnowledgeSourceClass, number> = {
  product_source: 0,
  exact_sku: 1,
  same_shop: 2,
  external_context: 3,
};
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const sameScope = (left: SellerKnowledgeScope, right: SellerKnowledgeScope): boolean =>
  left.environment === right.environment &&
  left.partnerId === right.partnerId &&
  left.shopId === right.shopId;
const present = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const unique = (values: string[]): string[] => [...new Set(values)].sort(compareText);
const fingerprint = (values: SellerKnowledgeValue[]): string => JSON.stringify(values);

interface Candidate {
  attributeId: number;
  values: SellerKnowledgeValue[];
  evidenceId: string;
  sourceClass: SellerKnowledgeSourceClass;
  confirmed: boolean;
  coverage: SellerKnowledgeCoverage;
  skuIdentityComplete: boolean;
}

function hasCompleteSkuIdentity(skus: string[], declared?: boolean, modelCount?: number): boolean {
  const known = unique(skus.filter(present));
  return (
    declared !== false &&
    known.length > 0 &&
    known.length === skus.length &&
    (modelCount === undefined ||
      (Number.isSafeInteger(modelCount) &&
        modelCount >= 0 &&
        (modelCount === 0 || known.length === modelCount)))
  );
}

function validateValues(
  attribute: SellerKnowledgeAttributeMetadata,
  values: SellerKnowledgeValue[],
): { values: SellerKnowledgeValue[]; error?: undefined } | { values?: undefined; error: string } {
  if (
    ![1, 2, 3, 4, 5].includes(attribute.inputType) ||
    ![0, 1, 2, 3, 4].includes(attribute.inputValidationType) ||
    ![1, 2].includes(attribute.formatType)
  )
    return { error: 'UNSUPPORTED_METADATA' };
  const multi = attribute.inputType === 4 || attribute.inputType === 5;
  if (
    multi &&
    (!Number.isSafeInteger(attribute.maxValueCount) || (attribute.maxValueCount ?? 0) <= 0)
  )
    return { error: 'UNSUPPORTED_METADATA' };
  const limit = multi ? Math.min(attribute.maxValueCount!, 5) : 1;
  if (!values.length) return { error: 'EMPTY_VALUE' };
  if (values.length > limit) return { error: 'TOO_MANY_VALUES' };
  const normalized: SellerKnowledgeValue[] = [];
  for (const value of values) {
    if (!Number.isSafeInteger(value.valueId) || value.valueId < 0)
      return { error: 'INVALID_VALUE_ID' };
    if (value.valueId > 0) {
      if (attribute.inputType === 3) return { error: 'INVALID_VALUE_ID' };
      const allowed = attribute.values?.find((option) => option.valueId === value.valueId);
      if (!allowed) return { error: 'INVALID_VALUE_ID' };
      if (present(value.originalValueName) && value.originalValueName !== allowed.name)
        return { error: 'VALUE_NAME_MISMATCH' };
      if (present(value.valueUnit) && value.valueUnit !== allowed.valueUnit)
        return { error: 'INVALID_VALUE_UNIT' };
      normalized.push({
        valueId: value.valueId,
        originalValueName: allowed.name,
        ...(present(allowed.valueUnit) ? { valueUnit: allowed.valueUnit } : {}),
      });
      continue;
    }
    if (attribute.inputType === 1 || attribute.inputType === 4)
      return { error: 'INVALID_VALUE_ID' };
    if (!present(value.originalValueName) || value.originalValueName.length > 2000)
      return { error: 'INVALID_VALUE_TYPE' };
    const name = value.originalValueName.trim();
    if (
      attribute.inputValidationType === 1 &&
      (!/^[+-]?\d+$/.test(name) || !Number.isSafeInteger(Number(name)))
    )
      return { error: 'INVALID_VALUE_TYPE' };
    if (
      attribute.inputValidationType === 3 &&
      (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(name) || !Number.isFinite(Number(name)))
    )
      return { error: 'INVALID_VALUE_TYPE' };
    if (
      attribute.inputValidationType === 4 &&
      (!/^\d+$/.test(name) ||
        !Number.isSafeInteger(Number(name)) ||
        Number(name) <= 0 ||
        !Number.isFinite(new Date(Number(name) * 1000).getTime()))
    )
      return { error: 'INVALID_VALUE_TYPE' };
    if (
      attribute.formatType === 2 &&
      (!present(value.valueUnit) || !attribute.units?.includes(value.valueUnit))
    )
      return { error: 'INVALID_VALUE_UNIT' };
    if (attribute.formatType === 1 && present(value.valueUnit))
      return { error: 'INVALID_VALUE_UNIT' };
    normalized.push({
      valueId: 0,
      originalValueName: name,
      ...(attribute.formatType === 2 ? { valueUnit: value.valueUnit } : {}),
    });
  }
  normalized.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  if (new Set(normalized.map((value) => JSON.stringify(value))).size !== normalized.length)
    return { error: 'DUPLICATE_VALUE' };
  return { values: normalized };
}

export function recommendSellerKnowledge(
  target: SellerKnowledgeTarget,
  observations: SellerKnowledgeObservation[],
  metadata: SellerKnowledgeMetadata,
  now: string | Date,
): SellerKnowledgeResult {
  const result: SellerKnowledgeResult = {
    suggestions: [],
    issues: [],
    missingMandatoryAttributeIds: [],
    consideredObservationCount: 0,
    truncatedObservationCount: 0,
  };
  const issue = (code: string, detail: string, attributeId?: number, evidenceId?: string): void => {
    result.issues.push({
      code,
      detail,
      ...(attributeId === undefined ? {} : { attributeId }),
      ...(evidenceId ? { evidenceId } : {}),
    });
  };
  const nowMs = new Date(now).getTime();
  const metadataTime = Date.parse(metadata.observedAt);
  const expiry =
    metadata.expiresAt === undefined
      ? metadataTime + METADATA_MAX_AGE_MS
      : Math.min(Date.parse(metadata.expiresAt), metadataTime + METADATA_MAX_AGE_MS);
  const validScope = [target.scope.environment, target.scope.partnerId, target.scope.shopId].every(
    present,
  );
  if (
    !validScope ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(metadataTime) ||
    !Number.isFinite(expiry) ||
    metadataTime > nowMs ||
    expiry <= nowMs ||
    metadata.categoryId !== target.categoryId ||
    !sameScope(metadata.scope, target.scope) ||
    metadata.attributes.length > MAX_ATTRIBUTES ||
    new Set(metadata.attributes.map((attribute) => attribute.attributeId)).size !==
      metadata.attributes.length
  ) {
    issue(
      'METADATA_UNAVAILABLE',
      'Current metadata must belong to the exact target shop/category and remain within its freshness window.',
    );
    return result;
  }
  const attributes = new Map(
    metadata.attributes.map((attribute) => [attribute.attributeId, attribute]),
  );
  const dependencyVisited = new Set<number>();
  const dependencyPath = new Set<number>();
  const validDependencies = (attribute: SellerKnowledgeAttributeMetadata): boolean => {
    if (dependencyPath.has(attribute.attributeId)) return false;
    if (dependencyVisited.has(attribute.attributeId)) return true;
    dependencyPath.add(attribute.attributeId);
    for (const dependency of attribute.dependsOn ?? []) {
      const parent = attributes.get(dependency.attributeId);
      if (
        !parent ||
        !Number.isSafeInteger(dependency.valueId) ||
        dependency.valueId <= 0 ||
        !parent.values?.some((value) => value.valueId === dependency.valueId) ||
        !validDependencies(parent)
      )
        return false;
    }
    dependencyPath.delete(attribute.attributeId);
    dependencyVisited.add(attribute.attributeId);
    return true;
  };
  if (metadata.attributes.some((attribute) => !validDependencies(attribute))) {
    issue(
      'INVALID_ATTRIBUTE_DEPENDENCY',
      'Conditional metadata has an unknown parent/value or a dependency cycle.',
    );
    return result;
  }
  result.missingMandatoryAttributeIds = metadata.attributes
    .filter((attribute) => attribute.mandatory)
    .map((attribute) => attribute.attributeId)
    .sort((a, b) => a - b);
  const targetSkus = unique((target.skus ?? []).filter(present));
  const targetSkuCount =
    target.modelCount !== undefined &&
    Number.isSafeInteger(target.modelCount) &&
    target.modelCount > 0
      ? target.modelCount
      : targetSkus.length;
  const targetSkuIdentityComplete = hasCompleteSkuIdentity(
    target.skus ?? [],
    target.skuIdentityComplete,
    target.modelCount,
  );
  const candidates: Candidate[] = [];
  const invalidSourceAttributes = new Set<number>();
  const historicalValues = new Map<number, Map<SellerKnowledgeSourceClass, Set<string>>>();
  const addCandidate = (
    attributeValue: SellerKnowledgeAttribute,
    basis: Omit<Candidate, 'attributeId' | 'values'>,
    retain = true,
  ): void => {
    const attribute = attributes.get(attributeValue.attributeId);
    if (!attribute) {
      issue(
        'UNKNOWN_ATTRIBUTE',
        'Attribute is absent from current category metadata.',
        attributeValue.attributeId,
        basis.evidenceId,
      );
      return;
    }
    if (
      attribute.applicable === false ||
      target.inapplicableAttributeIds?.includes(attribute.attributeId)
    ) {
      issue(
        'INAPPLICABLE_ATTRIBUTE',
        'Attribute is marked inapplicable for this product.',
        attribute.attributeId,
        basis.evidenceId,
      );
      return;
    }
    const validated = validateValues(attribute, attributeValue.values);
    if (validated.error !== undefined) {
      issue(
        validated.error,
        'Attribute value does not satisfy current Shopee metadata.',
        attribute.attributeId,
        basis.evidenceId,
      );
      if (basis.sourceClass === 'product_source')
        invalidSourceAttributes.add(attribute.attributeId);
      return;
    }
    if (basis.sourceClass !== 'product_source') {
      const byClass =
        historicalValues.get(attribute.attributeId) ??
        new Map<SellerKnowledgeSourceClass, Set<string>>();
      const signatures = byClass.get(basis.sourceClass) ?? new Set<string>();
      signatures.add(fingerprint(validated.values));
      byClass.set(basis.sourceClass, signatures);
      historicalValues.set(attribute.attributeId, byClass);
    }
    if (retain)
      candidates.push({ ...basis, attributeId: attribute.attributeId, values: validated.values });
  };
  if ((target.sourceFacts?.length ?? 0) > MAX_ATTRIBUTES) {
    issue(
      'SOURCE_FACT_LIMIT',
      'Too many source facts; no source declarations were used to avoid hiding conflicts.',
    );
  } else
    for (const fact of target.sourceFacts ?? []) {
      if (!present(fact.sourceId) || !present(fact.sourceLocator)) {
        issue(
          'SOURCE_PROVENANCE_REQUIRED',
          'A product source and exact locator are required.',
          fact.attributeId,
        );
        invalidSourceAttributes.add(fact.attributeId);
        continue;
      }
      addCandidate(fact, {
        evidenceId: fact.sourceId,
        sourceClass: 'product_source',
        confirmed: fact.confirmed === true,
        skuIdentityComplete: true,
        coverage: {
          targetSkuCount,
          matchedSkuCount: targetSkuCount,
          partial: false,
        },
      });
    }
  const eligible = observations
    .flatMap((observation) => {
      if (
        observation.scope.environment !== target.scope.environment ||
        observation.categoryId !== target.categoryId ||
        observation.brandId !== target.brandId ||
        (target.excludeItemId === observation.itemId && sameScope(target.scope, observation.scope))
      )
        return [];
      if (!present(observation.evidenceId) || !present(observation.itemId)) {
        issue('EVIDENCE_REQUIRED', 'Historical observation has no evidence identity.');
        return [];
      }
      if (observation.status !== 'NORMAL') {
        issue(
          'OBSERVATION_STATUS',
          'Only a normal listing can be used as historical reference.',
          undefined,
          observation.evidenceId,
        );
        return [];
      }
      const observed = Date.parse(observation.observedAt);
      if (
        !Number.isFinite(observed) ||
        observed > nowMs ||
        nowMs - observed > OBSERVATION_MAX_AGE_MS
      ) {
        issue(
          'STALE_OBSERVATION',
          'Observation is stale or has an invalid timestamp.',
          undefined,
          observation.evidenceId,
        );
        return [];
      }
      if (observation.attributes.length > MAX_ATTRIBUTES) {
        issue(
          'OBSERVATION_ATTRIBUTE_LIMIT',
          'Observation contains too many attributes.',
          undefined,
          observation.evidenceId,
        );
        return [];
      }
      const matchedSkuCount = targetSkus.filter((sku) =>
        observation.modelSkus.includes(sku),
      ).length;
      const skuIdentityComplete =
        targetSkuIdentityComplete &&
        hasCompleteSkuIdentity(
          observation.modelSkus,
          observation.skuIdentityComplete,
          observation.modelCount,
        );
      const sourceClass: SellerKnowledgeSourceClass = !sameScope(target.scope, observation.scope)
        ? 'external_context'
        : matchedSkuCount > 0 && skuIdentityComplete
          ? 'exact_sku'
          : 'same_shop';
      return [
        {
          observation,
          sourceClass,
          skuIdentityComplete,
          observed,
          coverage: {
            matchedSkuCount,
            targetSkuCount,
            partial:
              !skuIdentityComplete || (targetSkuCount > 0 && matchedSkuCount < targetSkuCount),
          },
        },
      ];
    })
    .sort(
      (a, b) =>
        sourceRank[a.sourceClass] - sourceRank[b.sourceClass] ||
        b.coverage.matchedSkuCount - a.coverage.matchedSkuCount ||
        b.observed - a.observed ||
        compareText(a.observation.evidenceId, b.observation.evidenceId) ||
        compareText(JSON.stringify(a.observation), JSON.stringify(b.observation)),
    );
  result.consideredObservationCount = Math.min(MAX_OBSERVATIONS, eligible.length);
  result.truncatedObservationCount = Math.max(0, eligible.length - MAX_OBSERVATIONS);
  // Scan all eligible records for contradictions; retain only bounded evidence in output.
  eligible.forEach(({ observation, sourceClass, coverage, skuIdentityComplete }, index) => {
    for (const attribute of observation.attributes)
      addCandidate(
        attribute,
        {
          evidenceId: observation.evidenceId,
          sourceClass,
          confirmed: false,
          coverage,
          skuIdentityComplete,
        },
        index < MAX_OBSERVATIONS,
      );
  });
  if (result.truncatedObservationCount)
    issue(
      'EVIDENCE_TRUNCATED',
      'Only the highest-ranked 50 observations are returned; conflicts were checked across eligible observations.',
    );
  for (const attribute of [...attributes.values()].sort((a, b) => a.attributeId - b.attributeId)) {
    const available = candidates
      .filter((candidate) => candidate.attributeId === attribute.attributeId)
      .sort(
        (a, b) =>
          sourceRank[a.sourceClass] - sourceRank[b.sourceClass] ||
          b.coverage.matchedSkuCount - a.coverage.matchedSkuCount ||
          compareText(a.evidenceId, b.evidenceId),
      );
    if (!available.length) continue;
    const bestClass = available[0]!.sourceClass;
    // A weaker same-shop observation can still contradict an exact-SKU observation.
    const selected = available.filter((candidate) =>
      bestClass === 'product_source'
        ? candidate.sourceClass === bestClass
        : bestClass === 'external_context'
          ? candidate.sourceClass === bestClass
          : candidate.sourceClass !== 'product_source' &&
            candidate.sourceClass !== 'external_context',
    );
    const variants = new Map<string, { values: SellerKnowledgeValue[]; evidenceIds: string[] }>();
    for (const candidate of selected) {
      const key = fingerprint(candidate.values);
      const variant = variants.get(key) ?? { values: candidate.values, evidenceIds: [] };
      variant.evidenceIds.push(candidate.evidenceId);
      variants.set(key, variant);
    }
    const historical = historicalValues.get(attribute.attributeId);
    const relevantSignatures = new Set<string>();
    for (const [sourceClass, signatures] of historical ?? []) {
      if ((bestClass === 'external_context') !== (sourceClass === 'external_context')) continue;
      for (const signature of signatures) relevantSignatures.add(signature);
    }
    const conflict =
      variants.size > 1 || (bestClass !== 'product_source' && relevantSignatures.size > 1);
    const incompleteIdentity =
      bestClass !== 'product_source' &&
      selected.some((candidate) => !candidate.skuIdentityComplete);
    const coverage = {
      ...selected[0]!.coverage,
      partial: selected[0]!.coverage.partial || incompleteIdentity,
    };
    const partialVariation =
      bestClass !== 'product_source' &&
      variationAttributeIds.has(attribute.attributeId) &&
      (coverage.partial || coverage.targetSkuCount === 0);
    const confirmed =
      bestClass === 'product_source' && selected.every((candidate) => candidate.confirmed);
    const reasons = [
      bestClass === 'product_source' ? 'PRODUCT_SOURCE_DECLARATION' : 'HISTORICAL_REFERENCE_ONLY',
    ];
    if (incompleteIdentity) reasons.push('SKU_IDENTITY_INCOMPLETE');
    if (bestClass === 'external_context') reasons.push('CROSS_SHOP_CONTEXT_ONLY');
    if (sensitiveAttributeIds.has(attribute.attributeId) && !confirmed)
      reasons.push('PRODUCT_SOURCE_CONFIRMATION_REQUIRED');
    if (partialVariation) {
      reasons.push('PARTIAL_SKU_COVERAGE');
      issue(
        'PARTIAL_SKU_COVERAGE',
        'Partial SKU overlap cannot establish a common scent or volume for the complete target listing.',
        attribute.attributeId,
      );
    }
    if (conflict) {
      reasons.push('CONFLICTING_VALUES');
      issue(
        'CONFLICTING_VALUES',
        'Evidence disagrees; no majority vote or representative value was selected.',
        attribute.attributeId,
      );
    }
    const firstVariant = [...variants.values()].sort((a, b) =>
      compareText(fingerprint(a.values), fingerprint(b.values)),
    )[0]!;
    if (
      bestClass === 'product_source' &&
      historical &&
      [...historical.values()].some((signatures) =>
        [...signatures].some((signature) => signature !== fingerprint(firstVariant.values)),
      )
    )
      issue(
        'HISTORICAL_DISAGREEMENT',
        'Product-source facts take precedence over contradictory historical listings.',
        attribute.attributeId,
      );
    const invalidSource = invalidSourceAttributes.has(attribute.attributeId);
    if (invalidSource) {
      reasons.push('INVALID_SOURCE_FACT');
      issue(
        'INVALID_SOURCE_FACT',
        'An invalid or untraceable source declaration for this field requires resolution before prefill.',
        attribute.attributeId,
      );
    }
    const blocked = conflict || partialVariation || invalidSource;
    const suggestion: SellerKnowledgeSuggestion = {
      attributeId: attribute.attributeId,
      name: attribute.name,
      values: blocked ? [] : firstVariant.values,
      evidenceIds: unique(selected.map((candidate) => candidate.evidenceId)).slice(
        0,
        MAX_OBSERVATIONS,
      ),
      sourceClass: bestClass,
      reasons,
      canPrefill: confirmed && !blocked,
      confidence: blocked ? 'blocked' : confirmed ? 'confirmed' : 'reference',
      coverage,
      ...(blocked
        ? {
            alternatives: [...variants.values()]
              .map((variant) => ({
                values: variant.values,
                evidenceIds: unique(variant.evidenceIds).slice(0, MAX_OBSERVATIONS),
              }))
              .sort((a, b) => compareText(fingerprint(a.values), fingerprint(b.values)))
              .slice(0, 10),
          }
        : {}),
    };
    result.suggestions.push(suggestion);
  }
  const currentValues = new Map<number, SellerKnowledgeValue[]>();
  const invalidCurrentIds = new Set<number>();
  if ((target.currentAttributes?.length ?? 0) > MAX_ATTRIBUTES) {
    issue(
      'CURRENT_ATTRIBUTE_LIMIT',
      'Current target attributes exceed the supported bound and were not used.',
    );
  } else
    for (const current of target.currentAttributes ?? []) {
      const attribute = attributes.get(current.attributeId);
      const validated = attribute && validateValues(attribute, current.values);
      if (
        !attribute ||
        attribute.applicable === false ||
        target.inapplicableAttributeIds?.includes(current.attributeId) ||
        !validated ||
        validated.error !== undefined ||
        (currentValues.has(current.attributeId) &&
          fingerprint(currentValues.get(current.attributeId)!) !== fingerprint(validated.values))
      ) {
        invalidCurrentIds.add(current.attributeId);
        issue(
          'INVALID_CURRENT_ATTRIBUTE',
          'Current target attribute is unknown, invalid or contradictory.',
          current.attributeId,
        );
        continue;
      }
      currentValues.set(current.attributeId, validated.values);
    }
  for (const attributeId of invalidCurrentIds) currentValues.delete(attributeId);

  const activeIn = (
    attributeId: number,
    values: Map<number, SellerKnowledgeValue[]>,
    cache: Map<number, boolean>,
  ): boolean => {
    const cached = cache.get(attributeId);
    if (cached !== undefined) return cached;
    const active = (attributes.get(attributeId)?.dependsOn ?? []).every(
      (dependency) =>
        activeIn(dependency.attributeId, values, cache) &&
        values.get(dependency.attributeId)?.some((value) => value.valueId === dependency.valueId),
    );
    cache.set(attributeId, active);
    return active;
  };
  const currentActive = new Map<number, boolean>();
  const inactiveCurrentIds = [...currentValues.keys()].filter(
    (attributeId) => !activeIn(attributeId, currentValues, currentActive),
  );
  for (const attributeId of inactiveCurrentIds) {
    currentValues.delete(attributeId);
    issue(
      'INACTIVE_CURRENT_ATTRIBUTE',
      'A current value from an inactive branch cannot satisfy a newly selected branch.',
      attributeId,
    );
  }
  // Only validated, unambiguous, confirmed source facts can alter branch activation.
  const proposedValues = new Map(currentValues);
  for (const suggestion of result.suggestions) {
    if (suggestion.canPrefill) proposedValues.set(suggestion.attributeId, suggestion.values);
  }
  const proposedActive = new Map<number, boolean>();
  result.suggestions = result.suggestions.filter((suggestion) => {
    if (activeIn(suggestion.attributeId, proposedValues, proposedActive)) return true;
    issue(
      'INACTIVE_ATTRIBUTE',
      'The target does not select every parent value required by this attribute.',
      suggestion.attributeId,
    );
    return false;
  });
  result.missingMandatoryAttributeIds = metadata.attributes
    .filter(
      (attribute) =>
        attribute.mandatory &&
        activeIn(attribute.attributeId, proposedValues, proposedActive) &&
        !proposedValues.has(attribute.attributeId),
    )
    .map((attribute) => attribute.attributeId)
    .sort((a, b) => a - b);

  const ancestorCache = new Map<number, Set<number>>();
  const ancestorIds = (attributeId: number): Set<number> => {
    const cached = ancestorCache.get(attributeId);
    if (cached) return cached;
    const ancestors = new Set<number>();
    for (const dependency of attributes.get(attributeId)?.dependsOn ?? []) {
      ancestors.add(dependency.attributeId);
      for (const ancestor of ancestorIds(dependency.attributeId)) ancestors.add(ancestor);
    }
    ancestorCache.set(attributeId, ancestors);
    return ancestors;
  };
  for (const missingId of result.missingMandatoryAttributeIds) {
    const ancestors = ancestorIds(missingId);
    for (const suggestion of result.suggestions) {
      if (!suggestion.canPrefill || !ancestors.has(suggestion.attributeId)) continue;
      suggestion.canPrefill = false;
      suggestion.confidence = 'blocked';
      suggestion.reasons.push('DEPENDENT_MANDATORY_ATTRIBUTE_MISSING');
      issue(
        'DEPENDENT_MANDATORY_ATTRIBUTE_MISSING',
        `Parent selection requires unresolved mandatory attribute ${missingId}.`,
        suggestion.attributeId,
      );
    }
  }
  // A child may not prefill independently when its new parent selection is blocked.
  for (let pass = 0; pass < metadata.attributes.length; pass++) {
    let changed = false;
    for (const suggestion of result.suggestions) {
      if (!suggestion.canPrefill) continue;
      const blockedParent = (attributes.get(suggestion.attributeId)?.dependsOn ?? []).some(
        (dependency) => {
          const alreadySelected =
            activeIn(dependency.attributeId, currentValues, currentActive) &&
            currentValues
              .get(dependency.attributeId)
              ?.some((value) => value.valueId === dependency.valueId);
          return (
            !alreadySelected &&
            result.suggestions.some(
              (parent) => parent.attributeId === dependency.attributeId && !parent.canPrefill,
            )
          );
        },
      );
      if (!blockedParent) continue;
      suggestion.canPrefill = false;
      suggestion.confidence = 'blocked';
      suggestion.reasons.push('DEPENDENCY_NOT_PREFILLABLE');
      issue(
        'DEPENDENCY_NOT_PREFILLABLE',
        'The child requires a new parent selection that cannot be prefetched safely.',
        suggestion.attributeId,
      );
      changed = true;
    }
    if (!changed) break;
  }
  result.issues = [
    ...new Map(result.issues.map((entry) => [JSON.stringify(entry), entry])).values(),
  ]
    .sort(
      (a, b) =>
        (a.attributeId ?? -1) - (b.attributeId ?? -1) ||
        compareText(a.code, b.code) ||
        compareText(a.evidenceId ?? '', b.evidenceId ?? ''),
    )
    .slice(0, 100);
  return result;
}
