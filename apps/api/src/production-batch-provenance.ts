import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@shopee/domain';
import type { Repository, BlobStore } from '@shopee/persistence';
import type { loadProductionBatchSource } from './production-batch-source.js';
import { productionImageQcPolicy, productionPublicationMode } from './production-batch-source.js';
import { buildProductionDraftSource } from './production-draft-source.js';
import { assertListingPriceMappingReceipt } from './listing-price-mapping.js';

type Loaded = Awaited<ReturnType<typeof loadProductionBatchSource>>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Gate future Shopee writes, without changing how historical batches are read or reconciled. */
export async function assertProductionBatchMappingProof(
  loaded: Loaded,
  sourceKeys: readonly string[],
  repo: Repository,
  blobs: BlobStore,
) {
  if (loaded.value.version !== 2) throw Error('PRODUCTION_SOURCE_MAPPING_PROOF_REQUIRED');
  // A source snapshot alone cannot prove who approved the batch's publication mode,
  // image-QC policy, or permission to create alongside an existing listing.
  const preparation = loaded.value.preparation;
  const rows = (await repo.pool.query(
    'SELECT body,fingerprint,approved_at,registration FROM production_source_preparations WHERE id=$1',
    [preparation.id],
  )).rows;
  const receipt = rows[0];
  if (rows.length !== 1 || !receipt.approved_at ||
    receipt.fingerprint !== preparation.fingerprint ||
    sha(Buffer.from(canonicalJson(receipt.body))) !== preparation.fingerprint ||
    !Array.isArray(receipt.registration?.batches) ||
    !receipt.registration.batches.some((batch: any) =>
      batch.batchId === loaded.value.batchId && batch.manifestSha256 === loaded.sha256) ||
    loaded.value.authorizationReference !==
      `operator-preparation:${preparation.id}:${preparation.fingerprint}` ||
    productionPublicationMode(receipt.body) !== productionPublicationMode(loaded.value) ||
    productionImageQcPolicy(receipt.body) !== productionImageQcPolicy(loaded.value))
    throw Error('PRODUCTION_SOURCE_MAPPING_PROOF_REQUIRED');
  for (const sourceKey of sourceKeys) {
    const listing = loaded.value.listings.find((entry) => entry.sourceKey === sourceKey);
    const file = loaded.value.sourceFiles.find((entry) => entry.id === listing?.sourceFileId);
    if (!listing || !file || file.role !== 'listing-snapshot')
      throw Error('PRODUCTION_SOURCE_MAPPING_PROOF_REQUIRED');
    const prepared = receipt.body.entries?.find((entry: any) =>
      entry.kind === 'ready' && entry.productKey === listing.sourceIdentity &&
      entry.sourceRevision === listing.sourceRevision);
    if (!prepared || !same(prepared.document, listing.document) ||
      !same(prepared.existingListingAuthorization ?? null, listing.existingListingAuthorization ?? null) ||
      !same(prepared.stockLocation, listing.stockLocation) ||
      prepared.sourceFile?.sha256 !== file.sha256)
      throw Error('PRODUCTION_SOURCE_MAPPING_PROOF_MISMATCH');
    const bytes = await readFile(file.path);
    if (sha(bytes) !== file.sha256) throw Error('PRODUCTION_SOURCE_MAPPING_PROOF_CHANGED');
    let snapshot: any;
    try { snapshot = JSON.parse(bytes.toString('utf8')); }
    catch { throw Error('PRODUCTION_SOURCE_MAPPING_PROOF_INVALID'); }
    if (!snapshot?.draft || !snapshot?.input || !snapshot?.decisionSource ||
      snapshot.draft.productKey !== listing.sourceIdentity ||
      snapshot.draft.revision !== listing.sourceRevision ||
      !same(prepared.sourceSnapshot?.draft, snapshot.draft))
      throw Error('PRODUCTION_SOURCE_MAPPING_PROOF_INVALID');
    const built = await buildProductionDraftSource(repo, blobs, snapshot.input, snapshot.decisionSource);
    if (built.kind !== 'ready' ||
      !same(built.sourceSnapshot.draft, snapshot.draft) ||
      !same(built.document, listing.document) ||
      !same(built.proposedAttributeList, listing.proposedAttributeList) ||
      built.brandName !== listing.brandName ||
      built.condition !== listing.condition ||
      !same(built.preOrder, listing.preOrder) ||
      !same(built.stockLocation, listing.stockLocation) ||
      !same(built.priceProof.map((proof) => ({
        sku: proof.sku,
        sourceFileId: proof.importId,
        sheetName: proof.sheetName,
        skuCell: proof.skuCell,
        priceCell: proof.priceCell,
        originalPrice: proof.originalPrice,
        priceSet: proof.priceProfile ?? '(Không phân bộ)',
      })), listing.priceProof))
      throw Error('PRODUCTION_SOURCE_MAPPING_PROOF_MISMATCH');
    await assertListingPriceMappingReceipt(repo, built.sourceSnapshot.draft, built.priceProof);
  }
}
