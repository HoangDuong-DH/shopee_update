import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { PreparedDocument } from '@shopee/domain';
import type { FieldSnapshot } from '../../packages/shopee/src/field-client.js';
import {
  reconcileProductionPilotWeights,
  type ProductionPilotWeightReview,
} from '../../apps/api/src/production-pilot-weight-review.js';
const operationId = '007738be-04ec-4ead-88d2-825062b29056',
  itemId = '51267858328',
  sourceFingerprint = 'a'.repeat(64);
function fixture() {
  const rows = [
    [322.3, 322],
    [130.9, 131],
    [503.8, 504],
  ];
  const document = {
    sourceKey: 'row-65',
    weightGrams: 503.8,
    models: rows.map(([source], index) => ({
      sku: 'SKU-' + index,
      tierIndex: [index],
      weightGrams: source,
    })),
  } as PreparedDocument;
  const raw: FieldSnapshot = {
    item: {
      item_id: Number(itemId),
      weight: '0.504',
      description: 'unchanged',
      image: { image_id_list: ['original'] },
    },
    models: {
      tier_variation: [{ name: 'Size' }],
      model: rows
        .map(([, accepted], index) => ({
          model_id: 100 + index,
          model_sku: 'SKU-' + index,
          tier_index: [index],
          weight: String(accepted! / 1000),
          original_price: 123000,
        }))
        .reverse(),
    },
  };
  const review: ProductionPilotWeightReview = {
    version: 1,
    scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
    operationId,
    itemId,
    sourceFingerprint,
    sourceKey: 'row-65',
    authorizationReference: 'User explicitly accepted these three observed SKU weights',
    authorizedAt: '2026-09-15T08:20:00.000Z',
    expiresAt: '2026-09-15T09:00:00.000Z',
    models: rows.map(([sourceGrams, acceptedGrams], index) => ({
      modelId: String(100 + index),
      sku: 'SKU-' + index,
      tierIndex: [index],
      sourceGrams: sourceGrams!,
      acceptedGrams: acceptedGrams!,
    })),
  };
  const input = { operationId, itemId, sourceFingerprint, document, raw };
  const options = {
    now: () => Date.parse('2026-09-15T08:25:00.000Z'),
    findReview: async () => Buffer.from(JSON.stringify(review)),
  };
  return { input, options, review };
}
it('keeps the original strict snapshot with no optional review or no matching file', async () => {
  const { input } = fixture();
  expect((await reconcileProductionPilotWeights(input)).qcSnapshot).toBe(input.raw);
  expect(
    (await reconcileProductionPilotWeights(input, { findReview: async () => null })).qcSnapshot,
  ).toBe(input.raw);
});
it('projects only exact approved weights and retains independent raw bytes/proof', async () => {
  const { input, options, review } = fixture(),
    original = structuredClone(input);
  const result = await reconcileProductionPilotWeights(input, options);
  expect(input).toEqual(original);
  expect(result.qcSnapshot.item.weight).toBe(0.5038);
  expect(result.qcSnapshot.models.model.map((row) => row.weight)).toEqual([0.5038, 0.1309, 0.3223]);
  const restored = structuredClone(result.qcSnapshot);
  restored.item.weight = input.raw.item.weight;
  restored.models.model.forEach(
    (row, index) => (row.weight = input.raw.models.model[index]!.weight),
  );
  expect(restored).toEqual(input.raw);
  expect(result.proof?.reviewSha256).toBe(
    createHash('sha256').update(JSON.stringify(review)).digest('hex'),
  );
  expect(result.proof?.models).toHaveLength(3);
});
it.each([
  (f: ReturnType<typeof fixture>) => {
    f.review.operationId = '11111111-1111-4111-8111-111111111111';
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.itemId = '1234';
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.sourceFingerprint = 'b'.repeat(64);
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.sourceKey = 'other';
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.scope.shopId = 'other' as any;
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.expiresAt = '2026-09-15T08:21:00.000Z';
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.authorizedAt = '2026-09-15T08:26:00.000Z';
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.models.pop();
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.models[1] = structuredClone(f.review.models[0]!);
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.models[0]!.sourceGrams = 322;
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.models[0]!.acceptedGrams = 323;
  },
  (f: ReturnType<typeof fixture>) => {
    f.review.models[0]!.tierIndex = [1];
  },
  (f: ReturnType<typeof fixture>) => {
    f.input.raw.models.model[0]!.model_sku = 'other';
  },
  (f: ReturnType<typeof fixture>) => {
    f.input.raw.models.model[0]!.model_id = 999;
  },
  (f: ReturnType<typeof fixture>) => {
    f.input.raw.models.model[0]!.weight = null;
  },
  (f: ReturnType<typeof fixture>) => {
    f.input.raw.models.model[0]!.weight = ' 0.504';
  },
  (f: ReturnType<typeof fixture>) => {
    f.input.raw.models.model[0]!.weight = true;
  },
  (f: ReturnType<typeof fixture>) => {
    f.input.raw.item.weight = '0.503';
  },
  (f: ReturnType<typeof fixture>) => {
    f.input.document.weightGrams = 504;
  },
])(
  'fails closed for a different, incomplete, expired or contradictory approval %#',
  async (alter) => {
    const f = fixture();
    alter(f);
    await expect(reconcileProductionPilotWeights(f.input, f.options)).rejects.toThrow(
      'PRODUCTION_PILOT_WEIGHT_',
    );
  },
);
