import { describe, expect, it } from 'vitest';
import {
  recommendSellerKnowledge,
  type SellerKnowledgeMetadata,
  type SellerKnowledgeAttributeMetadata,
  type SellerKnowledgeObservation,
  type SellerKnowledgeTarget,
} from '../../packages/domain/src/seller-knowledge.js';

const now = '2026-09-16T02:25:00.000Z';
const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' };
const target: SellerKnowledgeTarget = {
  scope,
  categoryId: 101127,
  brandId: 1252097,
  skus: ['A', 'B'],
};
const metadata: SellerKnowledgeMetadata = {
  scope,
  categoryId: 101127,
  observedAt: '2026-09-16T02:20:00.000Z',
  attributes: [
    {
      attributeId: 100016,
      name: 'pack type',
      mandatory: true,
      inputType: 1,
      inputValidationType: 0,
      formatType: 1,
      values: [
        { valueId: 394, name: 'Single' },
        { valueId: 358, name: 'Multipack' },
      ],
    },
    {
      attributeId: 100025,
      name: 'Scent',
      mandatory: false,
      inputType: 5,
      inputValidationType: 2,
      formatType: 1,
      maxValueCount: 5,
      values: [{ valueId: 871, name: 'Lavender' }],
    },
    {
      attributeId: 100248,
      name: 'Volume',
      mandatory: false,
      inputType: 2,
      inputValidationType: 3,
      formatType: 2,
      units: ['ml', 'L'],
      values: [{ valueId: 533, name: '100ml', valueUnit: 'ml' }],
    },
    {
      attributeId: 101067,
      name: 'Manufacturer/trader name',
      mandatory: false,
      inputType: 5,
      inputValidationType: 2,
      formatType: 1,
      maxValueCount: 5,
      values: [{ valueId: 6700, name: 'Updating' }],
    },
    {
      attributeId: 102560,
      name: 'country of origins',
      mandatory: false,
      inputType: 3,
      inputValidationType: 0,
      formatType: 1,
    },
    {
      attributeId: 777,
      name: 'Options',
      mandatory: false,
      inputType: 4,
      inputValidationType: 0,
      formatType: 1,
      maxValueCount: 2,
      values: [
        { valueId: 1, name: 'One' },
        { valueId: 2, name: 'Two' },
      ],
    },
    {
      attributeId: 778,
      name: 'Expiry',
      mandatory: false,
      inputType: 3,
      inputValidationType: 4,
      formatType: 1,
    },
    {
      attributeId: 779,
      name: 'Count',
      mandatory: false,
      inputType: 3,
      inputValidationType: 1,
      formatType: 1,
    },
  ],
};
const obs = (changes: Partial<SellerKnowledgeObservation> = {}): SellerKnowledgeObservation => ({
  evidenceId: 'read-1',
  scope,
  itemId: 'item-1',
  title: 'Carpet spray',
  categoryId: 101127,
  brandId: 1252097,
  modelSkus: ['A', 'B'],
  status: 'NORMAL',
  observedAt: '2026-09-16T02:15:00.000Z',
  attributes: [{ attributeId: 100016, values: [{ valueId: 394 }] }],
  ...changes,
});

describe('conditional seller knowledge attributes', () => {
  const child: SellerKnowledgeAttributeMetadata = {
    attributeId: 900,
    name: 'Units in multipack',
    mandatory: true,
    inputType: 3,
    inputValidationType: 1,
    formatType: 1,
    dependsOn: [{ attributeId: 100016, valueId: 358 }],
  };
  const conditionalMetadata = { ...metadata, attributes: [...metadata.attributes, child] };
  const parentSingle = { attributeId: 100016, values: [{ valueId: 394 }] };
  const parentMulti = { attributeId: 100016, values: [{ valueId: 358 }] };
  const childCurrent = { attributeId: 900, values: [{ valueId: 0, originalValueName: '2' }] };

  it('does not suggest or require a conditional child when its parent is absent', () => {
    const result = recommendSellerKnowledge(
      { ...target, sourceFacts: [fact(900, childCurrent.values)] },
      [obs({ attributes: [parentMulti, childCurrent] })],
      conditionalMetadata,
      now,
    );
    expect(result.suggestions.some((suggestion) => suggestion.attributeId === 900)).toBe(false);
    expect(result.missingMandatoryAttributeIds).toEqual([100016]);
  });

  it('validates current parent and child values before counting active requirements as satisfied', () => {
    const result = recommendSellerKnowledge(
      { ...target, currentAttributes: [parentMulti, childCurrent] },
      [],
      conditionalMetadata,
      now,
    );
    expect(result.missingMandatoryAttributeIds).toEqual([]);
    const invalid = recommendSellerKnowledge(
      {
        ...target,
        currentAttributes: [
          parentMulti,
          { attributeId: 900, values: [{ valueId: 0, originalValueName: 'not a number' }] },
        ],
      },
      [],
      conditionalMetadata,
      now,
    );
    expect(invalid.missingMandatoryAttributeIds).toEqual([900]);
    expect(codes(invalid)).toContain('INVALID_CURRENT_ATTRIBUTE');
  });

  it('reports an active mandatory child but blocks the source parent that would introduce it', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        currentAttributes: [parentSingle],
        sourceFacts: [fact(100016, parentMulti.values)],
      },
      [],
      conditionalMetadata,
      now,
    );
    expect(
      result.suggestions.find((suggestion) => suggestion.attributeId === 100016),
    ).toMatchObject({ canPrefill: false, confidence: 'blocked' });
    expect(result.missingMandatoryAttributeIds).toEqual([900]);
    expect(codes(result)).toContain('DEPENDENT_MANDATORY_ATTRIBUTE_MISSING');
  });

  it('allows a confirmed parent and all required child facts to be prefetched together', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        currentAttributes: [parentSingle],
        sourceFacts: [fact(100016, parentMulti.values), fact(900, childCurrent.values)],
      },
      [],
      conditionalMetadata,
      now,
    );
    expect(
      result.suggestions
        .filter((suggestion) => suggestion.canPrefill)
        .map((suggestion) => suggestion.attributeId),
    ).toEqual([900, 100016]);
    expect(result.missingMandatoryAttributeIds).toEqual([]);
  });

  it('suppresses old children after the source fact switches the parent to another branch', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        currentAttributes: [parentMulti, childCurrent],
        sourceFacts: [fact(100016, parentSingle.values), fact(900, childCurrent.values)],
      },
      [obs({ attributes: [childCurrent] })],
      conditionalMetadata,
      now,
    );
    expect(result.suggestions.map((suggestion) => suggestion.attributeId)).toEqual([100016]);
    expect(result.missingMandatoryAttributeIds).toEqual([]);
  });

  it('does not recycle a stale inactive child when a new source parent activates its branch', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        currentAttributes: [parentSingle, childCurrent],
        sourceFacts: [fact(100016, parentMulti.values)],
      },
      [],
      conditionalMetadata,
      now,
    );
    expect(result.missingMandatoryAttributeIds).toEqual([900]);
    expect(
      result.suggestions.find((suggestion) => suggestion.attributeId === 100016)?.canPrefill,
    ).toBe(false);
  });

  it('does not prefill an optional child independently of its blocked new parent', () => {
    const optionalChild: SellerKnowledgeAttributeMetadata = {
      attributeId: 902,
      name: 'Pack detail',
      mandatory: false,
      inputType: 3,
      inputValidationType: 2,
      formatType: 1,
      dependsOn: [{ attributeId: 100016, valueId: 358 }],
    };
    const result = recommendSellerKnowledge(
      {
        ...target,
        currentAttributes: [parentSingle],
        sourceFacts: [
          fact(100016, parentMulti.values),
          fact(902, [{ valueId: 0, originalValueName: 'Source pack detail' }]),
        ],
      },
      [],
      { ...conditionalMetadata, attributes: [...conditionalMetadata.attributes, optionalChild] },
      now,
    );
    expect(result.suggestions.find((suggestion) => suggestion.attributeId === 902)).toMatchObject({
      canPrefill: false,
      confidence: 'blocked',
    });
    expect(codes(result)).toContain('DEPENDENCY_NOT_PREFILLABLE');
  });

  it('does not use an unconfirmed or conflicting parent fact to activate a child', () => {
    for (const parentFacts of [
      [fact(100016, parentMulti.values, { confirmed: false })],
      [
        fact(100016, parentMulti.values),
        fact(100016, parentSingle.values, { sourceId: 'conflicting' }),
      ],
    ]) {
      const result = recommendSellerKnowledge(
        {
          ...target,
          currentAttributes: [parentSingle],
          sourceFacts: [...parentFacts, fact(900, childCurrent.values)],
        },
        [],
        conditionalMetadata,
        now,
      );
      expect(result.suggestions.some((suggestion) => suggestion.attributeId === 900)).toBe(false);
      expect(result.missingMandatoryAttributeIds).not.toContain(900);
    }
  });

  it('requires every ancestor condition and never lets a detached child activate grandchildren', () => {
    const grandchild: SellerKnowledgeAttributeMetadata = {
      attributeId: 901,
      name: 'Conditional detail',
      mandatory: true,
      inputType: 3,
      inputValidationType: 2,
      formatType: 1,
      dependsOn: [
        { attributeId: 100016, valueId: 358 },
        { attributeId: 777, valueId: 1 },
      ],
    };
    const nextMetadata = {
      ...conditionalMetadata,
      attributes: [...conditionalMetadata.attributes, grandchild],
    };
    const oneAncestor = recommendSellerKnowledge(
      { ...target, currentAttributes: [parentMulti, childCurrent] },
      [],
      nextMetadata,
      now,
    );
    expect(oneAncestor.missingMandatoryAttributeIds).toEqual([]);
    const both = recommendSellerKnowledge(
      {
        ...target,
        currentAttributes: [
          parentMulti,
          childCurrent,
          { attributeId: 777, values: [{ valueId: 1 }] },
        ],
      },
      [],
      nextMetadata,
      now,
    );
    expect(both.missingMandatoryAttributeIds).toEqual([901]);
  });

  it('fails closed for unknown parent values and cyclic conditional metadata', () => {
    for (const dependsOn of [
      [{ attributeId: 100016, valueId: 999 }],
      [{ attributeId: 900, valueId: 1 }],
    ]) {
      const result = recommendSellerKnowledge(
        {
          ...target,
          currentAttributes: [parentMulti],
          sourceFacts: [fact(900, childCurrent.values)],
        },
        [],
        { ...metadata, attributes: [...metadata.attributes, { ...child, dependsOn }] },
        now,
      );
      expect(result.suggestions).toEqual([]);
      expect(codes(result)).toContain('INVALID_ATTRIBUTE_DEPENDENCY');
    }
  });
});
const fact = (
  attributeId: number,
  values: Array<{ valueId: number; originalValueName?: string; valueUnit?: string }>,
  changes = {},
) => ({
  attributeId,
  values,
  sourceId: 'source-v1',
  sourceLocator: 'Word:paragraph 8',
  confirmed: true,
  ...changes,
});
const codes = (result: ReturnType<typeof recommendSellerKnowledge>) =>
  result.issues.map((issue) => issue.code);

describe('seller knowledge recommendations', () => {
  it.each([
    { skus: ['A', ''], modelCount: 2, skuIdentityComplete: false },
    { skus: ['A', 'A'], modelCount: 2, skuIdentityComplete: true },
    { skus: ['A', 'B'], modelCount: 48, skuIdentityComplete: true },
  ])(
    'does not count incomplete target SKU identities as complete matching coverage: %j',
    (identity) => {
      const result = recommendSellerKnowledge({ ...target, ...identity }, [obs()], metadata, now);
      expect(result.suggestions[0]).toMatchObject({
        sourceClass: 'same_shop',
        canPrefill: false,
        coverage: { targetSkuCount: identity.modelCount, partial: true },
      });
      expect(result.suggestions[0]?.reasons).toContain('SKU_IDENTITY_INCOMPLETE');
    },
  );
  it.each([
    { modelSkus: ['A', 'B'], modelCount: 2, skuIdentityComplete: false },
    { modelSkus: ['A', 'B', ''], modelCount: 3, skuIdentityComplete: true },
    { modelSkus: ['A', 'B', 'B'], modelCount: 3, skuIdentityComplete: true },
  ])('does not promote historical evidence with incomplete model identity: %j', (identity) => {
    const result = recommendSellerKnowledge(
      { ...target, modelCount: 2, skuIdentityComplete: true },
      [obs(identity)],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      sourceClass: 'same_shop',
      coverage: { matchedSkuCount: 2, targetSkuCount: 2, partial: true },
    });
    expect(result.suggestions[0]?.reasons).toContain('SKU_IDENTITY_INCOMPLETE');
  });
  it('blocks productwide volume evidence when SKU names overlap but one identity set is incomplete', () => {
    const result = recommendSellerKnowledge(
      target,
      [
        obs({
          skuIdentityComplete: false,
          attributes: [{ attributeId: 100248, values: [{ valueId: 533 }] }],
        }),
      ],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      sourceClass: 'same_shop',
      values: [],
      confidence: 'blocked',
      coverage: { partial: true },
    });
    expect(result.suggestions[0]?.reasons).toContain('SKU_IDENTITY_INCOMPLETE');
  });
  it('keeps whole-product confirmed source facts independent of incomplete SKU identities', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        skus: ['A', ''],
        modelCount: 48,
        skuIdentityComplete: false,
        sourceFacts: [fact(100016, [{ valueId: 394 }])],
      },
      [],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      sourceClass: 'product_source',
      canPrefill: true,
      coverage: { matchedSkuCount: 48, targetSkuCount: 48, partial: false },
    });
  });
  it('prefills a valid product-source free-text manufacturer, never approves a publication', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        sourceFacts: [fact(101067, [{ valueId: 0, originalValueName: 'Công ty từ nhãn gốc' }])],
      },
      [],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      attributeId: 101067,
      sourceClass: 'product_source',
      canPrefill: true,
      confidence: 'confirmed',
      evidenceIds: ['source-v1'],
    });
    expect(result.missingMandatoryAttributeIds).toEqual([100016]);
  });
  it('accepts type 3 custom text using provenance and rejects predefined IDs for free text', () => {
    const good = recommendSellerKnowledge(
      { ...target, sourceFacts: [fact(102560, [{ valueId: 0, originalValueName: 'Việt Nam' }])] },
      [],
      metadata,
      now,
    );
    expect(good.suggestions[0]?.canPrefill).toBe(true);
    const bad = recommendSellerKnowledge(
      { ...target, sourceFacts: [fact(102560, [{ valueId: 6700 }])] },
      [],
      metadata,
      now,
    );
    expect(bad.suggestions).toEqual([]);
    expect(codes(bad)).toContain('INVALID_VALUE_ID');
  });
  it('does not treat same SKU or explicit historical reuse approval as source truth', () => {
    const result = recommendSellerKnowledge(
      target,
      [obs({ approvedForReuse: true })],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      sourceClass: 'exact_sku',
      canPrefill: false,
      confidence: 'reference',
      coverage: { matchedSkuCount: 2, targetSkuCount: 2, partial: false },
    });
    expect(result.missingMandatoryAttributeIds).toEqual([100016]);
  });
  it('excludes the target itself and listings from another category or brand', () => {
    const result = recommendSellerKnowledge(
      { ...target, excludeItemId: 'item-1' },
      [obs(), obs({ itemId: '2', categoryId: 1 }), obs({ itemId: '3', brandId: 1 })],
      metadata,
      now,
    );
    expect(result.suggestions).toEqual([]);
  });
  it('keeps different shop or partner evidence contextual and never prefillable', () => {
    const result = recommendSellerKnowledge(
      target,
      [obs({ scope: { ...scope, shopId: 'other' } })],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      sourceClass: 'external_context',
      canPrefill: false,
    });
    expect(
      recommendSellerKnowledge(
        target,
        [obs({ scope: { ...scope, environment: 'sandbox' } })],
        metadata,
        now,
      ).suggestions,
    ).toEqual([]);
  });
  it('reports a value conflict instead of majority voting or trusting input order', () => {
    const observations = [
      obs(),
      obs({ evidenceId: 'read-2', itemId: '2' }),
      obs({
        evidenceId: 'read-3',
        itemId: '3',
        attributes: [{ attributeId: 100016, values: [{ valueId: 358 }] }],
      }),
    ];
    const result = recommendSellerKnowledge(target, observations, metadata, now);
    expect(result.suggestions[0]).toMatchObject({
      canPrefill: false,
      confidence: 'blocked',
      values: [],
    });
    expect(codes(result)).toContain('CONFLICTING_VALUES');
    expect(recommendSellerKnowledge(target, [...observations].reverse(), metadata, now)).toEqual(
      result,
    );
  });
  it('lets validated source facts outrank contradictory historical listings', () => {
    const result = recommendSellerKnowledge(
      { ...target, sourceFacts: [fact(100016, [{ valueId: 358 }])] },
      [obs()],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      values: [{ valueId: 358, originalValueName: 'Multipack' }],
      canPrefill: true,
    });
    expect(result.missingMandatoryAttributeIds).toEqual([]);
    expect(codes(result)).toContain('HISTORICAL_DISAGREEMENT');
  });
  it('blocks conflicting source facts even when many copies agree', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        sourceFacts: [
          fact(100016, [{ valueId: 394 }]),
          fact(100016, [{ valueId: 358 }], { sourceId: 'another-source' }),
        ],
      },
      [],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      canPrefill: false,
      confidence: 'blocked',
      values: [],
    });
    expect(codes(result)).toContain('CONFLICTING_VALUES');
  });
  it('blocks more than five scents and multiple values for single-select volume', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        sourceFacts: [
          fact(
            100025,
            Array.from({ length: 6 }, (_, i) => ({ valueId: 0, originalValueName: `Scent ${i}` })),
          ),
          fact(100248, [
            { valueId: 533 },
            { valueId: 0, originalValueName: '300', valueUnit: 'ml' },
          ]),
        ],
      },
      [],
      metadata,
      now,
    );
    expect(result.suggestions).toEqual([]);
    expect(codes(result).filter((code) => code === 'TOO_MANY_VALUES')).toHaveLength(2);
  });
  it.each([
    { valueId: 0, originalValueName: '100/300/500', valueUnit: 'ml' },
    { valueId: 0, originalValueName: '300', valueUnit: 'kg' },
    { valueId: 0, originalValueName: 'Infinity', valueUnit: 'ml' },
    { valueId: 998, originalValueName: '300ml' },
  ])('rejects invalid numeric quantity or unit: %j', (value) => {
    const result = recommendSellerKnowledge(
      { ...target, sourceFacts: [fact(100248, [value])] },
      [],
      metadata,
      now,
    );
    expect(result.suggestions).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
  });
  it('accepts a single quantitative custom volume and preserves its allowed unit', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        sourceFacts: [fact(100248, [{ valueId: 0, originalValueName: '300', valueUnit: 'ml' }])],
      },
      [],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      canPrefill: true,
      values: [{ valueId: 0, originalValueName: '300', valueUnit: 'ml' }],
    });
  });
  it('does not turn one matching SKU into common productwide scent/volume evidence', () => {
    const result = recommendSellerKnowledge(
      target,
      [
        obs({
          modelSkus: ['A'],
          attributes: [{ attributeId: 100248, values: [{ valueId: 533 }] }],
        }),
      ],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      canPrefill: false,
      confidence: 'blocked',
      values: [],
      coverage: { matchedSkuCount: 1, targetSkuCount: 2, partial: true },
    });
    expect(codes(result)).toContain('PARTIAL_SKU_COVERAGE');
  });
  it('requires source confirmation for manufacturer even on complete matching SKUs', () => {
    const result = recommendSellerKnowledge(
      target,
      [
        obs({
          attributes: [
            {
              attributeId: 101067,
              values: [{ valueId: 0, originalValueName: 'Old manufacturer' }],
            },
          ],
        }),
      ],
      metadata,
      now,
    );
    expect(result.suggestions[0]?.canPrefill).toBe(false);
    expect(result.suggestions[0]?.reasons).toContain('PRODUCT_SOURCE_CONFIRMATION_REQUIRED');
  });
  it('marks old, invalid-time, non-normal and missing-evidence observations unusable', () => {
    for (const observation of [
      obs({ observedAt: '2026-08-01T00:00:00Z' }),
      obs({ observedAt: 'garbage' }),
      obs({ status: 'BANNED' }),
      obs({ evidenceId: '' }),
    ]) {
      const result = recommendSellerKnowledge(target, [observation], metadata, now);
      expect(result.suggestions).toEqual([]);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });
  it('fails closed on expired metadata or a mismatched metadata scope', () => {
    for (const current of [
      { ...metadata, observedAt: '2026-09-16T02:00:00Z' },
      { ...metadata, expiresAt: '2026-09-16T02:24:00Z' },
      { ...metadata, scope: { ...scope, shopId: 'other' } },
    ]) {
      const result = recommendSellerKnowledge(
        { ...target, sourceFacts: [fact(100016, [{ valueId: 394 }])] },
        [obs()],
        current,
        now,
      );
      expect(result.suggestions).toEqual([]);
      expect(codes(result)).toContain('METADATA_UNAVAILABLE');
    }
  });
  it('never suggests unknown or explicitly inapplicable attributes', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        inapplicableAttributeIds: [100016],
        sourceFacts: [
          fact(123456, [{ valueId: 0, originalValueName: 'unknown' }]),
          fact(100016, [{ valueId: 394 }]),
        ],
      },
      [],
      metadata,
      now,
    );
    expect(result.suggestions).toEqual([]);
    expect(codes(result)).toEqual(
      expect.arrayContaining(['UNKNOWN_ATTRIBUTE', 'INAPPLICABLE_ATTRIBUTE']),
    );
  });
  it('refuses declared source facts without a locator or without confirmation', () => {
    const missing = recommendSellerKnowledge(
      { ...target, sourceFacts: [fact(100016, [{ valueId: 394 }], { sourceLocator: '' })] },
      [],
      metadata,
      now,
    );
    expect(missing.suggestions).toEqual([]);
    const unconfirmed = recommendSellerKnowledge(
      { ...target, sourceFacts: [fact(100016, [{ valueId: 394 }], { confirmed: false })] },
      [],
      metadata,
      now,
    );
    expect(unconfirmed.suggestions[0]).toMatchObject({
      canPrefill: false,
      confidence: 'reference',
    });
  });
  it('rejects fake IDs in dropdowns and checks integer/date custom inputs', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        sourceFacts: [
          fact(777, [{ valueId: 0, originalValueName: 'anything' }]),
          fact(778, [{ valueId: 0, originalValueName: '16/09/2026' }]),
          fact(779, [{ valueId: 0, originalValueName: '1.5' }]),
        ],
      },
      [],
      metadata,
      now,
    );
    expect(result.suggestions).toEqual([]);
    expect(codes(result)).toEqual(
      expect.arrayContaining(['INVALID_VALUE_ID', 'INVALID_VALUE_TYPE']),
    );
  });
  it('bounds observations deterministically and detects conflicts before truncating evidence', () => {
    const observations = Array.from({ length: 60 }, (_, i) =>
      obs({ itemId: `i-${i}`, evidenceId: `e-${i}` }),
    );
    const result = recommendSellerKnowledge(target, observations, metadata, now);
    expect(result.consideredObservationCount).toBeLessThanOrEqual(50);
    expect(result.truncatedObservationCount).toBe(10);
    expect(result.suggestions[0]?.evidenceIds.length).toBeLessThanOrEqual(50);
    expect(recommendSellerKnowledge(target, [...observations].reverse(), metadata, now)).toEqual(
      result,
    );
  });
  it('does not silently prefill the valid half of contradictory source declarations', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        sourceFacts: [
          fact(100016, [{ valueId: 394 }]),
          fact(100016, [{ valueId: 999 }], { sourceId: 'conflicting-source' }),
        ],
      },
      [],
      metadata,
      now,
    );
    expect(result.suggestions[0]).toMatchObject({
      canPrefill: false,
      confidence: 'blocked',
      values: [],
    });
    expect(codes(result)).toContain('INVALID_SOURCE_FACT');
  });
  it('blocks the field when another source declaration for it lacks provenance', () => {
    const result = recommendSellerKnowledge(
      {
        ...target,
        sourceFacts: [
          fact(100016, [{ valueId: 394 }]),
          fact(100016, [{ valueId: 358 }], { sourceLocator: '' }),
        ],
      },
      [],
      metadata,
      now,
    );
    expect(result.suggestions[0]?.canPrefill).toBe(false);
  });
  it('detects a conflicting historical value beyond the retained top 50 records', () => {
    const observations = Array.from({ length: 60 }, (_, i) =>
      obs({
        itemId: `i-${i}`,
        evidenceId: `e-${String(i).padStart(3, '0')}`,
        ...(i === 59 ? { attributes: [{ attributeId: 100016, values: [{ valueId: 358 }] }] } : {}),
      }),
    );
    const result = recommendSellerKnowledge(target, observations, metadata, now);
    expect(result.suggestions[0]).toMatchObject({ confidence: 'blocked', values: [] });
    expect(codes(result)).toContain('CONFLICTING_VALUES');
  });
});
