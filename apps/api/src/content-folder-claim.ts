import { createHash } from 'node:crypto';
import { canonicalJson, type InputBatchRecord, type WorkbookImport } from '@shopee/domain';
import type { Repository } from '@shopee/persistence';
import type { ProductInput } from './product-service.js';
/** Bind manual SKU choices to the saved content intake and immutable group images. */
export async function resolveContentFolderClaim(
  repo: Pick<Repository, 'getImport'>,
  input: ProductInput,
  batch: InputBatchRecord,
) {
  const fail = (): never => {
    throw Error('CONTENT_SELECTION_MISMATCH');
  };
  const binding = input.folderBinding;
  if (!binding) return fail();
  const selection = batch.state.contentSelections?.[binding.groupKey],
    priceChoice = batch.state.priceSelection;
  if (
    !selection ||
    !priceChoice ||
    !input.contentBinding ||
    input.productKey !== batch.state.productKeys[binding.groupKey] ||
    canonicalJson(input.contentBinding) !== canonicalJson(selection.binding) ||
    input.title !== selection.title ||
    input.headline !== selection.headline ||
    input.body !== selection.body
  )
    return fail();
  const price = await repo.getImport(priceChoice.importId),
    workbook = price?.body as WorkbookImport;
  if (!price || price.kind !== 'xlsx' || price.status !== 'ready' || !Array.isArray(workbook?.rows))
    return fail();
  const identities = [];
  for (const chosen of input.variants) {
    const rows = workbook.rows.filter(
      (r) =>
        r.key === chosen.rowKey &&
        r.sheet === priceChoice.sheet &&
        (r.priceProfile ?? null) === priceChoice.priceProfile,
    );
    if (chosen.importId !== price.id || rows.length !== 1) return fail();
    identities.push({
      rowKey: chosen.rowKey,
      sku: rows[0]!.sku.value,
      price: rows[0]!.originalPrice?.value,
      options: chosen.optionLabels,
    });
  }
  const imageHashes = new Map<string, string>();
  for (const id of new Set([
    ...(input.coverId ? [input.coverId] : []),
    ...input.galleryIds,
    ...input.descriptionImageIds,
    ...input.variants.flatMap((v) => (v.imageId ? [v.imageId] : [])),
  ])) {
    const files = batch.state.files.filter(
        (f) => f.importId === id && f.relativePath.startsWith(binding.groupKey + '/'),
      ),
      image = await repo.getImport(id);
    if (
      !files.length ||
      !image ||
      image.kind !== 'image' ||
      image.status !== 'ready' ||
      files.some((f) => f.sha256 !== image.sha256 || f.size !== image.bytes)
    )
      return fail();
    imageHashes.set(id, image.sha256);
  }
  return {
    ...binding,
    fingerprint: createHash('sha256')
      .update(
        canonicalJson({
          kind: 'excel_content_intake_v1',
          productKey: input.productKey,
          content: selection.binding,
          priceSource: { sha256: price.sha256, ...priceChoice },
          variants: identities,
          selection: { ...input, folderBinding: undefined, expectedRevision: undefined },
          images: Object.fromEntries(imageHashes),
        }),
      )
      .digest('hex'),
  };
}
