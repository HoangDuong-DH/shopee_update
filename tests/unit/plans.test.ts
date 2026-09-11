import { expect, it } from 'vitest';
import { makePlan, shouldApplyStock, planFingerprint } from '../../packages/domain/src/index.js';
import { fixtureDraft, fixtureScope, stockCommand } from '../helpers/fixtures.js';
it('fingerprints semantic input including scope, order and stock revisions', () => {
  const plan = makePlan(
    {
      revision: 1,
      scope: fixtureScope,
      productKey: 'test',
      sourceRevision: 1,
      operation: 'create',
      fieldMask: ['title'],
      desired: fixtureDraft(),
      stocks: [],
      issues: [],
    },
    { now: () => new Date('2026-09-10T00:00:00Z') },
  );
  expect(planFingerprint({ ...plan, id: 'another', createdAt: 'later' })).toBe(plan.fingerprint);
  expect(planFingerprint({ ...plan, scope: { ...plan.scope, shopId: 'other' } })).not.toBe(
    plan.fingerprint,
  );
  expect(
    planFingerprint({ ...plan, desired: { ...plan.desired, galleryKeys: ['b', 'a'] } }),
  ).not.toBe(plan.fingerprint);
});
it('never replenishes consumed stock by reapplying an old manual command', () => {
  expect(shouldApplyStock(stockCommand(), 7)).toBe(false);
  expect(shouldApplyStock(stockCommand(), 6)).toBe(true);
  expect(() => shouldApplyStock({ ...stockCommand(), quantity: 1.5 }, 6)).toThrow('INVALID_STOCK');
});
