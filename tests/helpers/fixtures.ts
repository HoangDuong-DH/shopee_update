import type { ListingDraft, Scope, StockInstruction } from '../../packages/domain/src/contracts.js';
export const fixtureScope: Scope = {
  environment: 'sandbox',
  partnerId: '123',
  shopId: '456',
  connectionRevision: 1,
  capabilityRevision: 1,
};
export const source = {
  kind: 'user_decision' as const,
  fileSha256: 'fixture',
  locator: 'test',
  observedAt: '2026-09-10T00:00:00Z',
};
export const fact = <T>(value: T) => ({ value, confirmed: true, sources: [source] });
export const fixtureDraft = (): ListingDraft => ({
  productKey: 'test',
  revision: 1,
  title: fact('Supplied title'),
  description: [{ type: 'text', text: 'Supplied body' }],
  coverKey: 'a',
  galleryKeys: ['a', 'b'],
  tierNames: ['Type'],
  variants: [{ key: 'variant', sku: fact('A'), optionLabels: ['One'], originalPrice: fact('100') }],
  assets: [],
  attributes: {},
  logistics: {},
  issues: [],
});
export const stockCommand = (): StockInstruction => ({
  scope: fixtureScope,
  sku: 'A',
  quantity: 100,
  revision: 7,
  commandId: 'stock-7',
  decidedAt: source.observedAt,
  source,
});
