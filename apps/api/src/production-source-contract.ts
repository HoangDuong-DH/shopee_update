import type { ListingDraft } from '@shopee/domain';
import type { PreparedWireContext, PreparedWireImageRole } from '../../../packages/shopee/src/prepared-wire.js';

/** Use the approved source selection, not the compiled wire document, as the comparison side. */
export function sourceContractFromApprovedDraft(
  draft: ListingDraft,
  stocks?: Record<string,number>,
): NonNullable<PreparedWireContext['sourceContract']> {
  const selection = draft.sourceSelection;
  if (!selection || selection.variants.length !== draft.variants.length)
    throw Error('PRODUCTION_SOURCE_CONTRACT_REQUIRED');
  const assetHash = (id: string | undefined) => {
    if (!id) return null;
    const matches = draft.assets.filter((asset) => asset.key === id);
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0]!.sha256))
      throw Error('PRODUCTION_SOURCE_MEDIA_REQUIRED');
    return matches[0]!.sha256;
  };
  const media: Record<PreparedWireImageRole, string[]> = {
    cover: [], gallery: [], description: [], variation: [],
  };
  const cover = assetHash(selection.coverId);
  if (!cover) throw Error('PRODUCTION_SOURCE_MEDIA_REQUIRED');
  media.cover.push(cover);
  for (const id of selection.galleryIds) media.gallery.push(assetHash(id)!);
  for (const id of selection.descriptionImageIds) media.description.push(assetHash(id)!);
  const optionLabelsBySku: Record<string, string[]> = Object.create(null);
  const originalPriceBySku: Record<string, string> = Object.create(null);
  for (const [index, variant] of draft.variants.entries()) {
    const selected = selection.variants[index]!;
    const sku = variant.sku.value;
    if (!sku || Object.hasOwn(optionLabelsBySku, sku))
      throw Error('PRODUCTION_SOURCE_MODEL_DUPLICATE');
    optionLabelsBySku[sku] = [...selected.optionLabels];
    originalPriceBySku[sku] = variant.originalPrice.value;
    if (selected.imageId) media.variation.push(assetHash(selected.imageId)!);
  }
  if(stocks!==undefined && (stocks===null || typeof stocks!=='object' || Array.isArray(stocks)
    || Object.keys(stocks).length!==draft.variants.length
    || draft.variants.some(variant=>!Object.hasOwn(stocks,variant.sku.value)
      || !Number.isSafeInteger(stocks[variant.sku.value]) || stocks[variant.sku.value]!<0)))
    throw Error('PRODUCTION_SOURCE_STOCK_DECISION_REQUIRED');
  return {
    tierNames: [...selection.tierNames],
    optionLabelsBySku,
    originalPriceBySku,
    ...(stocks!==undefined?{stockBySku:{...stocks}}:{}),
    approvedMediaSha256: [...new Set(Object.values(media).flat())],
    approvedMediaByRole: Object.fromEntries(
      Object.entries(media).map(([role, hashes]) => [role, [...new Set(hashes)]]),
    ) as Record<PreparedWireImageRole, string[]>,
    approvedMediaSequenceByRole: {
      cover: media.cover,
      gallery: media.gallery,
      description: media.description,
    },
  };
}
