import type { FolderManifest } from './folder-manifest.js';
import type { ListingDraft } from './contracts.js';

export type FolderSourceBinding = { batchId: string; revision: number; groupKey: string };
export type FolderSourceProof = { productKey: string; fingerprint: string };

/** Stable source identity: paths and import/batch IDs are aliases, never new listing identities. */
export function folderSourceIdentity(manifest: FolderManifest, priceProfile: string | null) {
  const range = (value: { start: number; end: number } | undefined) =>
    value ? { start: value.start, end: value.end } : null;
  return {
    version: 1,
    productKey: manifest.product.productKey,
    sourceListingId: manifest.sourceListingId
      ? {
          value: manifest.sourceListingId.value,
          fileSha256: manifest.sourceListingId.source.fileSha256,
          locator: manifest.sourceListingId.source.locator,
        }
      : null,
    word: {
      sha256: manifest.word.sha256,
      title: range(manifest.word.title),
      headline: range(manifest.word.headline),
      body: range(manifest.word.body),
      paragraphSeparator: manifest.word.paragraphSeparator,
    },
    priceSource: {
      sha256: manifest.priceSource.sha256,
      sheet: manifest.priceSource.sheet,
      priceProfile,
    },
    media: {
      cover: manifest.media.cover?.sha256 ?? null,
      gallery: manifest.media.gallery.map((f) => f.sha256),
      description: manifest.media.description.map((f) => f.sha256),
    },
    tierNames: manifest.tierNames,
    variants: manifest.variants.map((v) => ({
      sku: v.sku,
      optionLabels: v.optionLabels,
      image: v.image?.sha256 ?? null,
      rowKey: v.rowKey ?? null,
    })),
  };
}

export function folderDraftSelection(draft: ListingDraft) {
  const sha = (key: string | undefined) =>
    key ? (draft.assets.find((a) => a.key === key)?.sha256 ?? null) : null;
  return {
    sourceListingId: draft.sourceListingId?.value ?? null,
    title: draft.title.value,
    description: draft.description.map((b) =>
      b.type === 'text' ? b : { type: 'image', sha256: sha(b.assetKey) },
    ),
    cover: sha(draft.coverKey),
    gallery: draft.galleryKeys.map(sha),
    tierNames: draft.tierNames,
    variants: draft.variants.map((v) => ({
      rowKey: v.key,
      sku: v.sku.value,
      optionLabels: v.optionLabels,
      originalPrice: v.originalPrice.value,
      image: sha(v.imageKey),
    })),
  };
}
