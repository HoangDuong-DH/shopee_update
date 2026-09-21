import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type CatalogRow,
  type WorkbookImport,
  type WordImport,
} from '@shopee/domain';
import { folderManifestSchema } from '../../../packages/domain/src/folder-manifest.js';
import { folderSourceIdentity } from '../../../packages/domain/src/folder-source-identity.js';
import { InputLibraryRepository, type Repository } from '@shopee/persistence';
import type { ProductInput } from './product-service.js';
import { resolvePendingSourceClaim } from './pending-source-claim.js';

const fail = (code = 'FOLDER_SOURCE_SELECTION_MISMATCH'): never => {
  throw new Error(code);
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Resolve the persisted intake, never a browser-provided fingerprint or replacement source. */
export async function resolveFolderSourceClaim(repo: Repository, input: ProductInput) {
  const binding = input.folderBinding;
  if (!binding || input.expectedRevision !== 0) return fail('FOLDER_SOURCE_BINDING_INVALID');
  const batch = await new InputLibraryRepository(repo.pool).get(binding.batchId);
  if (!batch || batch.revision !== binding.revision) return fail('FOLDER_SOURCE_BINDING_STALE');
  const pending = batch.state.pendingMappings?.[binding.groupKey];
  if (pending && !batch.state.manifests?.[binding.groupKey])
    return resolvePendingSourceClaim(repo, input, batch, pending);
  const stored = batch.state.manifests?.[binding.groupKey];
  if (!stored) return fail('FOLDER_SOURCE_BINDING_INVALID');
  const manifest = folderManifestSchema.parse(stored.document);
  const selection = batch.state.priceSelection;
  if (
    manifest.product.sourceRevision !== 0 ||
    manifest.product.productKey !== input.productKey ||
    !batch.state.productKeys[binding.groupKey] ||
    !selection
  )
    return fail('FOLDER_SOURCE_BINDING_INVALID');
  const price = await repo.getImport(selection.importId);
  const workbook = price?.body as WorkbookImport | undefined;
  if (
    !price ||
    price.status !== 'ready' ||
    price.kind !== 'xlsx' ||
    price.sha256 !== manifest.priceSource.sha256 ||
    selection.sheet !== manifest.priceSource.sheet ||
    (manifest.priceSource.selectionMode === 'operator_choice'
      ? !selection.priceProfile?.trim()
      : selection.priceProfile !== manifest.priceSource.priceProfile) ||
    !Array.isArray(workbook?.rows)
  )
    return fail();
  const readFile = async (ref: { path: string; sha256: string }, kind: 'docx' | 'image') => {
    const files = batch.state.files.filter(
      (f) => f.relativePath === binding.groupKey + '/' + ref.path,
    );
    if (files.length !== 1 || !files[0].importId || files[0].sha256 !== ref.sha256) return fail();
    const record = await repo.getImport(files[0].importId);
    if (
      !record ||
      record.status !== 'ready' ||
      record.kind !== kind ||
      record.sha256 !== ref.sha256 ||
      record.bytes !== files[0].size
    )
      return fail();
    return record;
  };
  const word = (await readFile(manifest.word, 'docx')).body as WordImport;
  if (!Array.isArray(word.paragraphs) || word.paragraphs.some((p) => typeof p !== 'string'))
    return fail();
  const text = (range: { start: number; end: number } | undefined) => {
    if (!range) return '';
    if (range.end > word.paragraphs.length) return fail();
    return word.paragraphs.slice(range.start - 1, range.end).join(manifest.word.paragraphSeparator);
  };
  if (
    input.title !== text(manifest.word.title) ||
    input.headline !== text(manifest.word.headline) ||
    input.body !== text(manifest.word.body) ||
    !same(input.tierNames, manifest.tierNames) ||
    (input.sourceListingId ?? null) !== (manifest.sourceListingId?.value ?? null)
  )
    return fail();
  const imageIds = async (refs: { path: string; sha256: string }[]) => {
    const result: string[] = [];
    for (const ref of refs) result.push((await readFile(ref, 'image')).id);
    return result;
  };
  const cover = manifest.media.cover
    ? (await readFile(manifest.media.cover, 'image')).id
    : undefined;
  if (
    input.coverId !== cover ||
    !same(input.galleryIds, await imageIds(manifest.media.gallery)) ||
    !same(input.descriptionImageIds, await imageIds(manifest.media.description)) ||
    input.variants.length !== manifest.variants.length
  )
    return fail();
  for (let i = 0; i < manifest.variants.length; i++) {
    const desired = manifest.variants[i],
      actual = input.variants[i];
    const rows = workbook.rows.filter(
      (row: CatalogRow) =>
        row.sku.value === desired.sku &&
        row.sheet === selection.sheet &&
        (row.priceProfile ?? null) === selection.priceProfile &&
        (!desired.rowKey || row.key === desired.rowKey),
    );
    if (
      rows.length !== 1 ||
      actual.importId !== price.id ||
      actual.rowKey !== rows[0].key ||
      !same(actual.optionLabels, desired.optionLabels) ||
      actual.imageId !== (desired.image ? (await readFile(desired.image, 'image')).id : undefined)
    )
      return fail();
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(folderSourceIdentity(manifest, selection.priceProfile)))
    .digest('hex');
  return { ...binding, fingerprint };
}
