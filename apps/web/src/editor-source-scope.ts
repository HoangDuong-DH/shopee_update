import type { ListingDraft } from '@shopee/domain';
import type { ImportRecord } from './api.js';

const importId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{64}$/;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Only actual source bindings are eligible. Names and matching SKU patterns are not evidence. */
export function deriveDraftSourceImportIds(draft: ListingDraft): string[] | null {
  const selection = draft.sourceSelection;
  if (!selection || selection.variants.length !== draft.variants.length ||
      (selection.coverId || '') !== draft.coverKey || !same(selection.galleryIds, draft.galleryKeys) ||
      !same(selection.descriptionImageIds, draft.description.flatMap(block => block.type === 'image' ? [block.assetKey] : [])) ||
      !same(selection.tierNames, draft.tierNames) ||
      selection.variants.some((variant, index) => !importId.test(variant.importId) ||
        !same(variant.optionLabels, draft.variants[index]?.optionLabels) ||
        (variant.imageId || '') !== (draft.variants[index]?.imageKey || ''))) return null;
  const images = [...new Set([
    ...(draft.coverKey ? [draft.coverKey] : []), ...draft.galleryKeys,
    ...draft.description.flatMap(block => block.type === 'image' ? [block.assetKey] : []),
    ...draft.variants.flatMap(variant => variant.imageKey ? [variant.imageKey] : []),
  ])];
  for (const key of images) {
    const evidence = draft.assets.filter(asset => asset.key === key);
    if (!importId.test(key) || !evidence.length || evidence.some(asset =>
      !asset.mime.startsWith('image/') || !sha.test(asset.sha256) ||
      asset.source.kind !== 'product_file' || asset.source.fileSha256 !== asset.sha256 ||
      !asset.source.locator.trim() || asset.sha256 !== evidence[0]!.sha256)) return null;
  }
  const content = selection.contentBinding?.mapping;
  if (content && (!importId.test(content.importId) || !sha.test(content.sha256))) return null;
  return [...new Set([...selection.variants.map(variant => variant.importId), ...(content ? [content.importId] : []), ...images])];
}

export function scopedImageRecords(images: ImportRecord[], sourceImportIds: string[] | null): ImportRecord[] {
  if (!sourceImportIds) return [];
  const scope = new Set(sourceImportIds);
  return images.filter((image, index) => {
    if (!scope.has(image.id) || !importId.test(image.id) || image.kind !== 'image' || image.status !== 'ready' || !sha.test(image.sha256)) return false;
    const body = image.body as { sha256?: unknown; source?: { fileSha256?: unknown } } | undefined;
    if (body?.sha256 !== undefined && body.sha256 !== image.sha256 ||
        body?.source?.fileSha256 !== undefined && body.source.fileSha256 !== image.sha256) return false;
    const duplicates = images.filter(record => record.id === image.id);
    return duplicates.every(record => record.sha256 === image.sha256 && record.kind === image.kind && record.status === image.status) &&
      images.findIndex(record => record.id === image.id) === index;
  });
}

export function initialPreparationSelection(
  products: Array<{ productKey: string; revision: number }>, productKey?: string, revision?: number, alreadyActive = false,
): { state: 'none' | 'ready' | 'missing' | 'changed' | 'held'; productKey?: string } {
  if (!productKey) return { state: 'none' };
  if (alreadyActive) return { state: 'held' };
  const matches = products.filter(product => product.productKey === productKey);
  if (matches.length !== 1) return { state: 'missing' };
  if (matches[0]!.revision !== revision) return { state: 'changed' };
  return { state: 'ready', productKey };
}
