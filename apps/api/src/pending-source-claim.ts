import { createHash } from 'node:crypto';
import { canonicalJson, type InputBatchRecord, type WorkbookImport } from '@shopee/domain';
import type { Repository } from '@shopee/persistence';
import {
  pendingListingMappingSchema,
  resolvePendingMappingRows,
  pendingSelectedVariationImage,
  type PendingListingMapping,
} from '../../../packages/domain/src/pending-listing-mapping.js';
import type { ProductInput } from './product-service.js';

const fail = (code = 'PENDING_SOURCE_SELECTION_MISMATCH'): never => {
  throw new Error(code);
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** A saved incomplete table is never promoted by dropping its unresolved rows. */
export async function resolvePendingSourceClaim(
  repo: Pick<Repository, 'getImport'>,
  input: ProductInput,
  batch: InputBatchRecord,
  raw: PendingListingMapping,
): Promise<{ batchId: string; revision: number; groupKey: string; fingerprint: string }> {
  const parsed = pendingListingMappingSchema.safeParse(raw);
  if (!parsed.success) return fail('PENDING_SOURCE_INVALID');
  const mapping = parsed.data,
    binding = input.folderBinding,
    source = batch.state.priceSelection;
  if (
    !binding ||
    input.expectedRevision !== 0 ||
    batch.id !== binding.batchId ||
    batch.revision !== binding.revision
  )
    return fail('PENDING_SOURCE_BINDING_STALE');
  if (
    batch.state.manifests?.[binding.groupKey] ||
    !same(batch.state.pendingMappings?.[binding.groupKey], mapping) ||
    input.productKey !== mapping.document.product.productKey ||
    !batch.state.productKeys[binding.groupKey] ||
    !source
  )
    return fail('PENDING_SOURCE_BINDING_INVALID');
  const worksheet = batch.state.files.filter((f) => f.relativePath === mapping.relativePath);
  if (
    mapping.relativePath !== binding.groupKey + '/listing-mapping.pending.json' ||
    worksheet.length !== 1 ||
    worksheet[0].sha256 !== mapping.sha256 ||
    worksheet[0].importId
  )
    return fail('PENDING_SOURCE_BINDING_INVALID');
  const price = await repo.getImport(source.importId),
    book = price?.body as WorkbookImport | undefined;
  if (
    !price ||
    price.kind !== 'xlsx' ||
    price.status !== 'ready' ||
    !/^[a-f0-9]{64}$/.test(price.sha256) ||
    !Array.isArray(book?.rows)
  )
    return fail('PENDING_SOURCE_PRICE_INVALID');
  const resolved = resolvePendingMappingRows(mapping, {
    sheet: source.sheet,
    priceProfile: source.priceProfile,
    rows: book.rows,
  });
  if (resolved.issues.length) return fail('PENDING_SOURCE_INCOMPLETE');
  if (
    !same(
      input.tierNames,
      mapping.document.tiers.map((t) => t.literalHeading),
    ) ||
    (input.sourceListingId ?? null) !== mapping.document.sourceListingId ||
    input.variants.length !== resolved.rows.length
  )
    return fail();
  for (const [index, row] of resolved.rows.entries()) {
    const chosen = input.variants[index]!;
    if (
      chosen.importId !== price.id ||
      chosen.rowKey !== row.row.key ||
      !same(chosen.optionLabels, row.optionLabels)
    )
      return fail();
    const selectedImage = pendingSelectedVariationImage(
      mapping,
      mapping.document.slots[index]!.slotId,
    );
    if (selectedImage) {
      // Bind by the selected slot/SKU and exact relative path, never by file order or image hash alone.
      const files = batch.state.files.filter(
        (file) => file.relativePath === binding.groupKey + '/' + selectedImage.path,
      );
      if (
        selectedImage.sku !== row.sku ||
        files.length !== 1 ||
        files[0].error ||
        !files[0].importId ||
        files[0].sha256 !== selectedImage.sha256 ||
        chosen.imageId !== files[0].importId
      )
        return fail('PENDING_SOURCE_IMAGE_INVALID');
      // The shared media checks below also require the persisted import to be a ready image
      // with matching SHA and byte count. Unselected legacy/manual images retain those checks.
    }
  }
  const hashes = new Map<string, string>();
  for (const id of new Set([
    ...(input.coverId ? [input.coverId] : []),
    ...input.galleryIds,
    ...input.descriptionImageIds,
    ...input.variants.flatMap((v) => (v.imageId ? [v.imageId] : [])),
  ])) {
    const files = batch.state.files.filter(
      (f) => f.importId === id && f.relativePath.startsWith(binding.groupKey + '/'),
    );
    const image = await repo.getImport(id);
    if (
      !files.length ||
      !image ||
      image.kind !== 'image' ||
      image.status !== 'ready' ||
      files.some((f) => f.sha256 !== image.sha256 || f.size !== image.bytes)
    )
      return fail('PENDING_SOURCE_IMAGE_INVALID');
    hashes.set(id, image.sha256);
  }
  const selectedHash = (id?: string) => (id ? (hashes.get(id) ?? null) : null);
  const fingerprint = createHash('sha256')
    .update(
      canonicalJson({
        version: 1,
        kind: 'pending_table_completed',
        productKey: mapping.document.product.productKey,
        sourceKey: mapping.document.sourceKey,
        worksheetSha256: mapping.sha256,
        sourceWorkbookSha256: mapping.document.sourceWorkbookSha256,
        sourceListingId: mapping.document.sourceListingId,
        sourceListingIdCell: mapping.document.sourceListingIdCell,
        structureConfirmed: mapping.structureConfirmed,
        tierNames: input.tierNames,
        priceSource: {
          sha256: price.sha256,
          sheet: source.sheet,
          priceProfile: source.priceProfile,
        },
        title: input.title,
        headline: input.headline,
        body: input.body,
        cover: selectedHash(input.coverId),
        gallery: input.galleryIds.map(selectedHash),
        descriptionImages: input.descriptionImageIds.map(selectedHash),
        variants: resolved.rows.map((r, i) => ({
          slotId: mapping.document.slots[i]!.slotId,
          sku: r.sku,
          optionLabels: r.optionLabels,
          rowKey: r.row.key,
          originalPrice: r.row.originalPrice!.value,
          image: selectedHash(input.variants[i]!.imageId),
        })),
      }),
    )
    .digest('hex');
  return { ...binding, fingerprint };
}
