import { expect, it } from 'vitest';
import { sellerFactTargetFingerprint } from '../../apps/api/src/seller-knowledge-facts.js';
const target = {
  scope: { environment: 'production', partnerId: '1', shopId: '2' },
  itemId: '3',
  categoryId: '4',
  brandId: '5',
  modelSkus: ['A', 'B'],
};
it('product fact scope is stable over SKU order but changes across item, shop, category, brand or SKU coverage', () => {
  const original = sellerFactTargetFingerprint(target);
  expect(sellerFactTargetFingerprint({ ...target, modelSkus: ['B', 'A'] })).toBe(original);
  expect(
    sellerFactTargetFingerprint({ ...target, scope: { ...target.scope, connectionRevision: 3 } }),
  ).toBe(original);
  for (const change of [
    { itemId: '9' },
    { categoryId: '9' },
    { brandId: '9' },
    { modelSkus: ['A'] },
    { scope: { ...target.scope, shopId: '9' } },
  ])
    expect(sellerFactTargetFingerprint({ ...target, ...change })).not.toBe(original);
});
it('binds confirmations to all remote model identities including blank and duplicate merchant SKUs', () => {
  const models = [
    { model_id: 1, model_sku: 'A', tier_index: [0] },
    { model_id: 2, model_sku: '', tier_index: [1] },
  ];
  const fingerprint = sellerFactTargetFingerprint({ ...target, models, modelSkus: ['A'] });
  expect(
    sellerFactTargetFingerprint({ ...target, models: [...models].reverse(), modelSkus: ['A'] }),
  ).toBe(fingerprint);
  for (const changed of [
    models.slice(0, 1),
    [...models, { model_id: 3, model_sku: '', tier_index: [2] }],
    [models[0], { ...models[1], tier_index: [2] }],
  ])
    expect(sellerFactTargetFingerprint({ ...target, models: changed, modelSkus: ['A'] })).not.toBe(
      fingerprint,
    );
});
