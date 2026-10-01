import { expect, it } from 'vitest';
import type { ListingDraft } from '../../packages/domain/src/index.js';
import { sourceContractFromApprovedDraft } from '../../apps/api/src/production-source-contract.js';

function draft(): ListingDraft {
  const image = (key: string, hex: string) => ({ key, sha256: hex.repeat(64) });
  return {
    productKey: 'chair-42',
    revision: 3,
    assets: [image('cover', 'a'), image('gallery', 'b'), image('red', 'c')] as any,
    sourceSelection: {
      title: 'Office chair',
      headline: '',
      body: '',
      coverId: 'cover',
      galleryIds: ['gallery'],
      descriptionImageIds: [],
      tierNames: ['Màu', 'Kích cỡ'],
      variants: [
        { importId: 'price', rowKey: '12', optionLabels: ['Đỏ', 'S'], imageId: 'red' },
        { importId: 'price', rowKey: '13', optionLabels: ['Đỏ', 'M'], imageId: 'red' },
      ],
    },
    variants: [
      { sku: { value: 'CHAIR-RED-S' }, originalPrice: { value: '100000' } },
      { sku: { value: 'CHAIR-RED-M' }, originalPrice: { value: '110000' } },
    ],
  } as unknown as ListingDraft;
}

it('builds a category-neutral source contract with per-role media from the approved selection', () => {
  const contract = sourceContractFromApprovedDraft(draft());
  expect(contract.tierNames).toEqual(['Màu', 'Kích cỡ']);
  expect(contract.optionLabelsBySku['CHAIR-RED-M']).toEqual(['Đỏ', 'M']);
  expect(contract.originalPriceBySku['CHAIR-RED-S']).toBe('100000');
  expect(contract.approvedMediaSequenceByRole).toEqual({
    cover: ['a'.repeat(64)],
    gallery: ['b'.repeat(64)],
    description: [],
  });
  expect(contract.approvedMediaByRole).toEqual({
    cover: ['a'.repeat(64)],
    gallery: ['b'.repeat(64)],
    description: [],
    variation: ['c'.repeat(64)],
  });
});

it('does not invent a contract when the approved source or image identity is missing', () => {
  const missing = draft();
  delete missing.sourceSelection;
  expect(() => sourceContractFromApprovedDraft(missing)).toThrow('PRODUCTION_SOURCE_CONTRACT_REQUIRED');
  const wrongImage = draft();
  wrongImage.sourceSelection!.variants[0]!.imageId = 'from-another-listing';
  expect(() => sourceContractFromApprovedDraft(wrongImage)).toThrow('PRODUCTION_SOURCE_MEDIA_REQUIRED');
});

it.each([0,100,1000])('preserves explicit stock %i from a separate operating decision', amount => {
  const stocks={'CHAIR-RED-S':amount,'CHAIR-RED-M':0};
  const contract=sourceContractFromApprovedDraft(draft(),stocks);
  expect(contract.stockBySku).toEqual(stocks);
  stocks['CHAIR-RED-S']=999;
  expect(contract.stockBySku?.['CHAIR-RED-S']).toBe(amount);
});

const invalidStockDecisions:Record<string,number>[]=[{}, {'CHAIR-RED-S':100}, {'CHAIR-RED-S':100,'CHAIR-RED-M':0,OTHER:1},
  {'CHAIR-RED-S':-1,'CHAIR-RED-M':0}, {'CHAIR-RED-S':1.5,'CHAIR-RED-M':0}];
it.each(invalidStockDecisions)
 ('rejects incomplete, extra or invalid stock decisions without defaults', stocks => {
  expect(()=>sourceContractFromApprovedDraft(draft(),stocks)).toThrow('PRODUCTION_SOURCE_STOCK_DECISION_REQUIRED');
});
