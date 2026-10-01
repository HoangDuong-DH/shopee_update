import type { ListingDraft, ShopConnection } from '@shopee/domain';
import { compileDescription } from '../../../packages/domain/src/source/normalize.js';
import type { EditorSavePayload } from '../../../apps/web/src/editor-recovery.js';
import type { ImportRecord } from '../../../apps/web/src/api.js';

// Test-only source data. Never loaded by the application entry point or a database importer.
export const priceId = '11111111-1111-4111-8111-111111111111';
export const coverId = '22222222-2222-4222-8222-222222222222';
export const galleryId = '33333333-3333-4333-8333-333333333333';
export const foreignImageId = '44444444-4444-4444-8444-444444444444';
export const shopId = '55555555-5555-4555-8555-555555555555';
export const productKey = 'fixture-editor-exact-source';
export const sourceIds = [priceId, coverId, galleryId];
export const seed: EditorSavePayload = {
  productKey, expectedRevision: 2, title: 'Listing thử giao diện · Bộ nguồn riêng', headline: 'Câu mở đầu từ nguồn thử', body: 'Nội dung nguồn thử giữ nguyên.',
  coverId, galleryIds: [galleryId], descriptionImageIds: [], tierNames: ['Loại'],
  variants: [{ importId: priceId, rowKey: 'Sheet1!A2:P2', optionLabels: ['Lựa chọn nguyên văn'], imageId: galleryId }],
};
export const variants = [{ sku: 'FIXTURE-SKU-EXACT', originalPrice: '125000' }];
export const imports: ImportRecord[] = [
  { id: priceId, filename: 'TEST/Bộ riêng/Giá.xlsx', kind: 'xlsx', status: 'ready', sha256: '1'.repeat(64), bytes: 1500, createdAt: '2026-10-01T00:00:00Z', message: '' },
  { id: coverId, filename: 'TEST/Bộ riêng/Ảnh bìa.png', kind: 'image', status: 'ready', sha256: '2'.repeat(64), bytes: 80, createdAt: '2026-10-01T00:00:00Z', message: '' },
  { id: galleryId, filename: 'TEST/Bộ riêng/Ảnh sản phẩm.png', kind: 'image', status: 'ready', sha256: '3'.repeat(64), bytes: 80, createdAt: '2026-10-01T00:00:00Z', message: '' },
  { id: foreignImageId, filename: 'TEST/Bộ khác/Không được chọn.png', kind: 'image', status: 'ready', sha256: '4'.repeat(64), bytes: 80, createdAt: '2026-10-01T00:00:00Z', message: '' },
];
export const shops: ShopConnection[] = [{
  id: shopId, name: 'Shop thử giao diện', region: 'VN', state: 'connected', capabilities: [], updatedAt: '2026-10-01T00:00:00Z',
  scope: { environment: 'production', partnerId: 'FIXTURE-PARTNER', shopId: 'FIXTURE-SHOP', connectionRevision: 1, capabilityRevision: 1 },
}];
export function draftFromPayload(payload: EditorSavePayload, revision = payload.expectedRevision + 1): ListingDraft {
  const { productKey, expectedRevision: _, ...sourceSelection } = structuredClone(payload);
  const source = { kind: 'product_file' as const, fileSha256: '1'.repeat(64), locator: 'TEST/Bộ riêng/Giá.xlsx!Sheet1!A2:P2', observedAt: '2026-10-01T00:00:00Z' };
  const fact = (value: string) => ({ value, confirmed: false, sources: [source] });
  const imageIds = new Set([...(payload.coverId ? [payload.coverId] : []), ...payload.galleryIds, ...payload.descriptionImageIds, ...payload.variants.flatMap(v => v.imageId ? [v.imageId] : [])]);
  return { productKey, revision, sourceSelection, title: fact(payload.title), description: compileDescription(payload.headline, payload.body, payload.descriptionImageIds),
    coverKey: payload.coverId ?? '', galleryKeys: [...payload.galleryIds], tierNames: [...payload.tierNames],
    variants: payload.variants.map((v, i) => ({ key: v.rowKey, sku: fact(variants[i]!.sku), originalPrice: fact(variants[i]!.originalPrice), optionLabels: [...v.optionLabels], imageKey: v.imageId })),
    assets: imports.filter(record => imageIds.has(record.id)).map(record => ({ key: record.id, sha256: record.sha256, bytes: record.bytes, width: 1, height: 1, mime: 'image/png', source: { kind: 'product_file', fileSha256: record.sha256, locator: record.filename, observedAt: record.createdAt } })),
    attributes: {}, logistics: {}, issues: [],
  };
}
export function mappingReviewFor(draft: ListingDraft, requiresConfirmation: boolean) {
  return { productKey: draft.productKey, revision: draft.revision, fingerprint: String(draft.revision).repeat(64),
    requiresConfirmation, approvalBasis: requiresConfirmation ? 'unconfirmed' as const : draft.sourceSelection?.folderBinding ? 'stored_folder' as const : 'current_decision' as const,
    sourceHashes: imports.filter(record => sourceIds.includes(record.id)).map(record => ({ importId: record.id, sha256: record.sha256, kind: record.kind })),
    mapping: { title: draft.title.value, tierNames: draft.tierNames, variants: draft.variants.map(variant => ({ sku: variant.sku.value, optionLabels: variant.optionLabels, originalPrice: variant.originalPrice.value })) },
    imageRoles: { cover: imports.find(record => record.id === draft.coverKey)?.filename ?? null, gallery: draft.galleryKeys.map(id => imports.find(record => record.id === id)?.filename ?? null),
      variants: draft.variants.map(variant => imports.find(record => record.id === variant.imageKey)?.filename ?? null) } };
}
export function priceReviewFor(draft: ListingDraft) {
  return { productKey: draft.productKey, revision: draft.revision, title: draft.title.value, fingerprint: 'f'.repeat(64), confirmed: false, tierNames: draft.tierNames, issues: [],
    rows: draft.variants.map((variant, index) => ({ slotKey: String(index), optionLabels: variant.optionLabels, sourceName: 'Nhãn nguồn thử chính xác', sourceFilename: imports[0]!.filename,
      sourceImportedAt: imports[0]!.createdAt, fileSha256: imports[0]!.sha256, sku: variant.sku.value, sheetName: 'Sheet1', skuCell: 'A2', priceCell: 'O2', originalPrice: variant.originalPrice.value, priceProfile: 'TEST' })) };
}
