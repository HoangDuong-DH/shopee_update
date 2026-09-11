import { describe, expect, it } from 'vitest';
import {
  handoffDocumentSchema,
  handoffImageIds,
  handoffMembership,
} from '../../packages/domain/src/source/handoff.js';
import { createHandoffFixture } from '../fixtures/handoff-factory.js';

describe('prepared listing handoff v1', () => {
  it.each([0, 1, 2] as const)(
    'round-trips %i tiers while preserving source text, exact SKU order, spaces and sparse combinations',
    (tiers) => {
      const input = createHandoffFixture(tiers).document;
      const output = handoffDocumentSchema.parse(JSON.parse(JSON.stringify(input)));
      expect(output).toEqual(input);
      expect(output.content.body).toBe('Dòng một\n\n  Dòng hai  \n\nDòng cuối');
      expect(output.variants).toHaveLength(tiers === 0 ? 1 : tiers === 1 ? 2 : 3);
      expect(handoffMembership(output).variants.map((variant) => variant.optionLabels)).toEqual(
        input.variants.map((variant) => variant.optionLabels),
      );
      expect(handoffImageIds(output)).toHaveLength(3);
    },
  );
  it('rejects extra fields, foreign media references and invented empty tier combinations', () => {
    const source = createHandoffFixture(2).document;
    expect(
      handoffDocumentSchema.safeParse({ ...source, serverPath: 'C:/foreign/file' }).success,
    ).toBe(false);
    const foreign = structuredClone(source);
    foreign.media.galleryIds = ['00000000-0000-4000-8000-000000000001'];
    expect(handoffDocumentSchema.safeParse(foreign).success).toBe(false);
    const empty = structuredClone(source);
    empty.variants[0].optionLabels = [' ', '100 cái'];
    expect(handoffDocumentSchema.safeParse(empty).success).toBe(false);
  });
  it('rejects duplicate SKU, duplicate role image, repeated tuple and inconsistent zero-tier membership', () => {
    const source = createHandoffFixture(1).document;
    const duplicate = structuredClone(source);
    duplicate.variants[1].price.sku = duplicate.variants[0].price.sku;
    expect(handoffDocumentSchema.safeParse(duplicate).success).toBe(false);
    const repeated = structuredClone(source);
    repeated.variants[1].optionLabels = repeated.variants[0].optionLabels;
    expect(handoffDocumentSchema.safeParse(repeated).success).toBe(false);
    const media = structuredClone(source);
    media.media.galleryIds.push(media.media.galleryIds[0]);
    expect(handoffDocumentSchema.safeParse(media).success).toBe(false);
    const untiered = structuredClone(source);
    untiered.tierNames = [];
    untiered.variants.forEach((variant) => (variant.optionLabels = []));
    expect(handoffDocumentSchema.safeParse(untiered).success).toBe(false);
  });
  it('does not accept unconfirmed image roles or claim a Word range for an existing user selection', () => {
    const source = createHandoffFixture(0).document;
    expect(
      handoffDocumentSchema.safeParse({
        ...source,
        confirmed: { ...source.confirmed, imageRoles: false },
      }).success,
    ).toBe(false);
    expect(
      handoffDocumentSchema.safeParse({
        ...source,
        content: { ...source.content, origin: { kind: 'word_range', start: 1, end: 5 } },
      }).success,
    ).toBe(false);
  });
});
