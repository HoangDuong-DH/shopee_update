import { z } from 'zod';
import type { ListingDraft } from '../contracts.js';

const id = z.string().uuid();
const key = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !!value.trim());
const money = z.string().regex(/^[1-9][0-9]*$/);
const hashes = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z.array(id).max(100);
const text = (max: number) => z.string().max(max);

/** An app handoff references immutable imported bytes. It contains no server paths or remote URLs. */
export const handoffDocumentSchema = z
  .object({
    format: z.literal('shopee-listing-handoff'),
    version: z.literal(1),
    product: z.object({ productKey: key, sourceRevision: z.number().int().min(0) }).strict(),
    scope: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('saved_product'),
          productKey: key,
          revision: z.number().int().min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal('input_batch'),
          batchId: id,
          batchRevision: z.number().int().min(1),
          groupKey: text(1024).min(1),
        })
        .strict(),
    ]),
    sources: z
      .array(
        z
          .object({
            importId: id,
            sha256: hashes,
            kind: z.enum(['image', 'xlsx', 'docx']),
            filename: text(255).min(1),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    content: z
      .object({
        origin: z
          .object({ kind: z.literal('user_selection'), sourceImportIds: z.array(id).max(20) })
          .strict(),
        title: text(10000),
        headline: text(50000),
        body: text(100000),
      })
      .strict(),
    media: z.object({ coverId: id.optional(), galleryIds: ids, descriptionImageIds: ids }).strict(),
    tierNames: z.array(text(200).min(1)).max(2),
    variants: z
      .array(
        z
          .object({
            price: z
              .object({
                importId: id,
                rowKey: text(500).min(1),
                sheet: text(255).min(1),
                priceProfile: text(255).nullable(),
                sku: text(500).min(1),
                originalPrice: money,
                promotionTarget: money.nullable(),
              })
              .strict(),
            optionLabels: z.array(text(200).min(1)).max(2),
            imageId: id.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
    confirmed: z
      .object({
        content: z.literal(true),
        imageRoles: z.literal(true),
        membership: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((document, ctx) => {
    const add = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (new Set(document.sources.map((source) => source.importId)).size !== document.sources.length)
      add(['sources'], 'A source import ID must occur exactly once.');
    for (const [name, list] of Object.entries({
      galleryIds: document.media.galleryIds,
      descriptionImageIds: document.media.descriptionImageIds,
    }))
      if (new Set(list).size !== list.length)
        add(['media', name], 'A role cannot repeat the same image.');
    if (!document.tierNames.length && document.variants.length !== 1)
      add(['variants'], 'An untiered listing has exactly one SKU.');
    if (
      document.tierNames.some((value) => !value.trim()) ||
      new Set(document.tierNames).size !== document.tierNames.length
    )
      add(['tierNames'], 'Tier names must be nonblank and distinct.');
    const skus = new Set<string>(),
      labels = new Set<string>();
    document.variants.forEach((variant, index) => {
      if (!variant.price.sku.trim() || skus.has(variant.price.sku))
        add(['variants', index, 'price', 'sku'], 'SKU must be nonblank and unique.');
      skus.add(variant.price.sku);
      const identity = JSON.stringify(variant.optionLabels);
      if (
        variant.optionLabels.length !== document.tierNames.length ||
        variant.optionLabels.some((value) => !value.trim()) ||
        labels.has(identity)
      )
        add(
          ['variants', index, 'optionLabels'],
          'Each prepared SKU needs one distinct, complete combination.',
        );
      labels.add(identity);
    });
    const sources = new Map(document.sources.map((source) => [source.importId, source]));
    const requireKind = (
      value: string,
      kind: 'image' | 'xlsx' | 'docx',
      path: (string | number)[],
    ) => {
      if (sources.get(value)?.kind !== kind)
        add(path, 'Reference is absent from the source manifest or has a different kind.');
    };
    for (const value of handoffImageIds(document)) requireKind(value, 'image', ['media']);
    document.content.origin.sourceImportIds.forEach((value) =>
      requireKind(value, 'docx', ['content', 'origin']),
    );
    document.variants.forEach((variant, index) =>
      requireKind(variant.price.importId, 'xlsx', ['variants', index, 'price']),
    );
  });

export type HandoffDocument = z.infer<typeof handoffDocumentSchema>;
export type HandoffMode = 'create_new' | 'update_source';
export type HandoffChange = { field: string; before: unknown; after: unknown };
export type HandoffRequest = {
  document: HandoffDocument;
  mode: HandoffMode;
  productKey?: string;
  expectedRevision?: number;
};
export type HandoffPreview = {
  document: HandoffDocument;
  mode: HandoffMode;
  productKey: string;
  expectedRevision: number;
  previewFingerprint: string;
  draft: ListingDraft;
  changes: HandoffChange[];
  issues: ListingDraft['issues'];
  canApply: boolean;
};
export function handoffImageIds(document: Pick<HandoffDocument, 'media' | 'variants'>): string[] {
  return [
    ...new Set([
      ...(document.media.coverId ? [document.media.coverId] : []),
      ...document.media.galleryIds,
      ...document.media.descriptionImageIds,
      ...document.variants.flatMap((variant) => (variant.imageId ? [variant.imageId] : [])),
    ]),
  ];
}
export function handoffMembership(document: Pick<HandoffDocument, 'tierNames' | 'variants'>) {
  return {
    tierNames: document.tierNames,
    variants: document.variants.map((variant) => ({
      sku: variant.price.sku,
      optionLabels: variant.optionLabels,
    })),
  };
}
export function draftMembership(draft: ListingDraft) {
  return {
    tierNames: draft.tierNames,
    variants: draft.variants.map((variant) => ({
      sku: variant.sku.value,
      optionLabels: variant.optionLabels,
    })),
  };
}
/** Diffs are direct value comparisons; arrays retain prepared order, spaces and paragraphs. */
export function handoffChanges(before: ListingDraft | null, after: ListingDraft): HandoffChange[] {
  const summarize = (draft: ListingDraft | null): Record<string, unknown> =>
    draft
      ? {
          'Tiêu đề': draft.sourceSelection?.title ?? draft.title.value,
          'Câu mở đầu': draft.sourceSelection?.headline ?? null,
          'Nội dung': draft.sourceSelection?.body ?? draft.description,
          'Ảnh bìa': draft.coverKey,
          'Ảnh sản phẩm': draft.galleryKeys,
          'Ảnh mô tả':
            draft.sourceSelection?.descriptionImageIds ??
            draft.description.filter((block) => block.type === 'image'),
          'SKU và phân loại': draftMembership(draft),
          'Giá và nguồn giá': draft.variants.map((variant, index) => ({
            sku: variant.sku.value,
            originalPrice: variant.originalPrice.value,
            promotionTarget: variant.promotionTarget?.value ?? null,
            source: draft.sourceSelection?.variants[index]
              ? {
                  importId: draft.sourceSelection.variants[index].importId,
                  rowKey: draft.sourceSelection.variants[index].rowKey,
                }
              : null,
          })),
          'Ảnh phân loại': draft.variants.map((variant) => ({
            sku: variant.sku.value,
            imageId: variant.imageKey ?? null,
          })),
        }
      : {};
  const old = summarize(before),
    next = summarize(after);
  return Object.keys(next)
    .filter((field) => JSON.stringify(old[field]) !== JSON.stringify(next[field]))
    .map((field) => ({ field, before: old[field] ?? null, after: next[field] }));
}
