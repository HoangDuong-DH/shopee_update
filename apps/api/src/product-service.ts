import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  compileDescription,
  canonicalJson,
  validateDraft,
  type AssetRef,
  type CatalogRow,
  type Fact,
  type ListingDraft,
  type WorkbookImport,
} from '@shopee/domain';
import { Repository } from '@shopee/persistence';
import { resolveFolderSourceClaim } from './folder-source-claim.js';
import {
  projectResolvedPriceIssues,
  resolvedDuplicatePriceIssueKeys,
} from '../../../packages/domain/src/source/selected-price-issues.js';
export const productInput = z.object({
  folderBinding: z
    .object({
      batchId: z.string().uuid(),
      revision: z.number().int().positive(),
      groupKey: z.string().min(1).max(1024),
    })
    .strict()
    .optional(),
  sourceListingId: z.string().max(200).nullable().optional(),
  productKey: z.string().min(1).optional(),
  expectedRevision: z.number().int().min(0),
  title: z.string().max(10000),
  headline: z.string().max(50000),
  body: z.string().max(100000),
  coverId: z.string().uuid().optional(),
  galleryIds: z.array(z.string().uuid()).max(100),
  descriptionImageIds: z.array(z.string().uuid()).max(100),
  tierNames: z.array(z.string().max(200)).max(2),
  variants: z
    .array(
      z.object({
        importId: z.string().uuid(),
        rowKey: z.string(),
        optionLabels: z.array(z.string().max(200)),
        imageId: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(2000),
});
export type ProductInput = z.infer<typeof productInput>;

/** Read-only presentation of saved drafts. Authoritative draft revisions and import issues
 * remain intact for source fingerprints, auditing and the compiler's fresh-byte checks. */
export async function projectProductPriceIssues(
  repo: Pick<Repository, 'getImport'>,
  drafts: readonly ListingDraft[],
): Promise<ListingDraft[]> {
  const imports = new Map<string, Awaited<ReturnType<Repository['getImport']>>>();
  const projected: ListingDraft[] = [];
  for (const draft of drafts) {
    const resolved = new Set<string>();
    const selection = draft.sourceSelection;
    if (
      selection &&
      selection.variants.length === draft.variants.length &&
      draft.issues.some((issue) => issue.code === 'DUPLICATE_SKU' && issue.severity === 'warn')
    ) {
      for (const [index, selected] of selection.variants.entries()) {
        if (!imports.has(selected.importId)) {
          try {
            imports.set(selected.importId, await repo.getImport(selected.importId));
          } catch {
            imports.set(selected.importId, null);
          }
        }
        const record = imports.get(selected.importId),
          variant = draft.variants[index]!;
        if (record?.status !== 'ready' || record.kind !== 'xlsx') continue;
        const rows = (record.body as WorkbookImport)?.rows;
        if (!Array.isArray(rows)) continue;
        const matches = rows.filter((row) => row.key === selected.rowKey);
        if (matches.length !== 1) continue;
        const row = matches[0]!;
        if (
          variant.key !== selected.rowKey ||
          !row.originalPrice ||
          canonicalJson(variant.sku) !== canonicalJson(row.sku) ||
          canonicalJson(variant.originalPrice) !== canonicalJson(row.originalPrice) ||
          row.sku.sources.some((source) => source.fileSha256 !== record.sha256)
        )
          continue;
        for (const key of resolvedDuplicatePriceIssueKeys(rows, selected.rowKey)) resolved.add(key);
      }
    }
    projected.push({ ...draft, issues: projectResolvedPriceIssues(draft.issues, resolved) });
  }
  return projected;
}

export async function assembleProduct(
  repo: Repository,
  input: ProductInput,
): Promise<ListingDraft> {
  const previous =
    input.expectedRevision > 0 && input.productKey ? await repo.getProduct(input.productKey) : null;
  if (input.expectedRevision > 0 && previous?.revision !== input.expectedRevision)
    throw new Error('PRODUCT_REVISION_CONFLICT');
  const source = {
    kind: 'user_decision' as const,
    fileSha256: 'user-selection',
    locator: 'Nguồn và mapping được chọn trong ứng dụng',
    observedAt: new Date().toISOString(),
  };
  const fact = <T>(value: T): Fact<T> => ({ value, confirmed: true, sources: [source] });
  const assets: AssetRef[] = [];
  const assetIds = [
    ...new Set([
      ...(input.coverId ? [input.coverId] : []),
      ...input.galleryIds,
      ...input.descriptionImageIds,
      ...input.variants.flatMap((v) => (v.imageId ? [v.imageId] : [])),
    ]),
  ];
  for (const id of assetIds) {
    const record = await repo.getImport(id);
    if (record?.status !== 'ready' || record.kind !== 'image') throw new Error('ASSET_NOT_READY');
    assets.push({ ...(record.body as AssetRef), key: id });
  }
  // The content/image editor cannot replace video or size-chart metadata.
  // Keep the associated source assets as well as the preserved reference keys.
  const retainedAssetKeys = new Set([
    ...(previous?.videoKeys ?? []),
    ...(previous?.sizeChartKey ? [previous.sizeChartKey] : []),
  ]);
  for (const asset of previous?.assets ?? [])
    if (retainedAssetKeys.has(asset.key) && !assets.some((selected) => selected.key === asset.key))
      assets.push(structuredClone(asset));
  const catalog = new Map<string, CatalogRow[]>();
  for (const id of new Set(input.variants.map((v) => v.importId))) {
    const record = await repo.getImport(id);
    if (record?.status !== 'ready' || record.kind !== 'xlsx') throw new Error('SOURCE_NOT_READY');
    catalog.set(id, (record.body as WorkbookImport).rows);
  }
  const unexposedIssueFields = new Set([
    'category',
    'brand',
    'attributes',
    'logistics',
    'video',
    'sizeChart',
    'identifiers',
    'compliance',
    'fulfillment',
    'publication',
    'sourceListingId',
  ]);
  const issues: ListingDraft['issues'] = structuredClone(
    (previous?.issues ?? []).filter((issue) =>
      [...unexposedIssueFields].some(
        (field) =>
          issue.field === field ||
          issue.field.startsWith(field + '.') ||
          issue.field.startsWith(field + '['),
      ),
    ),
  );
  const variants = input.variants.map((v) => {
    const row = catalog.get(v.importId)!.find((r) => r.key === v.rowKey);
    if (!row) throw new Error('SOURCE_ROW_NOT_FOUND');
    issues.push(
      ...projectResolvedPriceIssues(
        row.issues,
        resolvedDuplicatePriceIssueKeys(catalog.get(v.importId)!, v.rowKey),
      ),
    );
    return {
      key: row.key,
      sku: row.sku,
      optionLabels: v.optionLabels,
      originalPrice: row.originalPrice ?? { value: '', confirmed: false, sources: row.sku.sources },
      promotionTarget: row.promotionTarget,
      declaredWeightGrams: row.declaredWeightGrams,
      imageKey: v.imageId,
    };
  });
  const draft: ListingDraft = {
    ...(previous?.folderSource ? { folderSource: structuredClone(previous.folderSource) } : {}),
    productKey: input.productKey ?? randomUUID(),
    revision: input.expectedRevision + 1,
    ...(previous?.sourceListingId &&
    (input.sourceListingId === undefined ||
      input.sourceListingId === previous.sourceListingId.value)
      ? { sourceListingId: structuredClone(previous.sourceListingId) }
      : input.sourceListingId !== undefined
        ? { sourceListingId: fact(input.sourceListingId) }
        : {}),
    title: fact(input.title),
    description: compileDescription(input.headline, input.body, input.descriptionImageIds),
    coverKey: input.coverId ?? '',
    galleryKeys: input.galleryIds,
    tierNames: input.tierNames,
    variants,
    assets,
    // Existing metadata is outside ProductInput's edit scope. New drafts still
    // leave unknown fields unset; a workbook category name is not a category ID.
    ...(previous?.categoryId ? { categoryId: structuredClone(previous.categoryId) } : {}),
    ...(previous?.brandId ? { brandId: structuredClone(previous.brandId) } : {}),
    attributes: structuredClone(previous?.attributes ?? {}),
    logistics: structuredClone(previous?.logistics ?? {}),
    ...(previous?.videoKeys ? { videoKeys: [...previous.videoKeys] } : {}),
    ...(previous?.sizeChartKey !== undefined ? { sizeChartKey: previous.sizeChartKey } : {}),
    ...(previous?.identifiers ? { identifiers: structuredClone(previous.identifiers) } : {}),
    ...(previous?.compliance ? { compliance: structuredClone(previous.compliance) } : {}),
    ...(previous?.fulfillment ? { fulfillment: structuredClone(previous.fulfillment) } : {}),
    ...(previous?.publication ? { publication: structuredClone(previous.publication) } : {}),
    issues,
  };
  draft.sourceSelection = {
    ...(input.folderBinding ? { folderBinding: input.folderBinding } : {}),
    ...(draft.sourceListingId ? { sourceListingId: draft.sourceListingId.value } : {}),
    title: input.title,
    headline: input.headline,
    body: input.body,
    coverId: input.coverId,
    galleryIds: input.galleryIds,
    descriptionImageIds: input.descriptionImageIds,
    tierNames: input.tierNames,
    variants: input.variants,
  };
  draft.issues = [...issues, ...validateDraft(draft)];
  return draft;
}

export async function saveAssembledProduct(
  repo: Repository,
  input: ProductInput,
): Promise<ListingDraft> {
  const claim =
    input.expectedRevision === 0 && input.folderBinding
      ? await resolveFolderSourceClaim(repo, input)
      : undefined;
  if (input.expectedRevision === 0 && !claim && input.productKey) {
    // Reserved sidecar aliases cannot be used to evade their portable identity by omitting the binding.
    const reserved = await repo.pool.query(
      `SELECT 1 FROM input_batch_products p
      JOIN input_batch_revisions r ON r.batch_id=p.batch_id
      WHERE p.product_key=$1 AND (r.state->'manifests'->p.group_key->'document'->'product'->>'sourceRevision'='0'
        OR r.state->'pendingMappings'->p.group_key IS NOT NULL) LIMIT 1`,
      [input.productKey],
    );
    if (reserved.rowCount) throw new Error('FOLDER_SOURCE_BINDING_REQUIRED');
    const portable = await repo.pool.query(
      `SELECT 1 FROM input_batch_revisions r,
      jsonb_each(COALESCE(r.state->'manifests','{}'::jsonb) || COALESCE(r.state->'pendingMappings','{}'::jsonb)) m WHERE m.value->'document'->'product'->>'productKey'=$1
      AND m.value->'document'->'product'->>'sourceRevision'='0' LIMIT 1`,
      [input.productKey],
    );
    if (portable.rowCount) throw new Error('FOLDER_SOURCE_BINDING_REQUIRED');
  }
  const draft = await assembleProduct(repo, input);
  if (claim) draft.folderSource = { productKey: draft.productKey, fingerprint: claim.fingerprint };
  return repo.saveProduct(draft, input.expectedRevision, claim);
}
