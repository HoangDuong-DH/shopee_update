import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  compileDescription,
  validateDraft,
  type AssetRef,
  type CatalogRow,
  type Fact,
  type ListingDraft,
  type WorkbookImport,
} from '@shopee/domain';
import { Repository } from '@shopee/persistence';
export const productInput = z.object({
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
export async function assembleProduct(
  repo: Repository,
  input: ProductInput,
): Promise<ListingDraft> {
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
  const catalog = new Map<string, CatalogRow[]>();
  for (const id of new Set(input.variants.map((v) => v.importId))) {
    const record = await repo.getImport(id);
    if (record?.status !== 'ready' || record.kind !== 'xlsx') throw new Error('SOURCE_NOT_READY');
    catalog.set(id, (record.body as WorkbookImport).rows);
  }
  const issues: ListingDraft['issues'] = [];
  const variants = input.variants.map((v) => {
    const row = catalog.get(v.importId)!.find((r) => r.key === v.rowKey);
    if (!row) throw new Error('SOURCE_ROW_NOT_FOUND');
    issues.push(...row.issues);
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
    productKey: input.productKey ?? randomUUID(),
    revision: input.expectedRevision + 1,
    title: fact(input.title),
    description: compileDescription(input.headline, input.body, input.descriptionImageIds),
    coverKey: input.coverId ?? '',
    galleryKeys: input.galleryIds,
    tierNames: input.tierNames,
    variants,
    assets,
    attributes: {},
    logistics: {},
    issues,
  };
  draft.sourceSelection = {
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
