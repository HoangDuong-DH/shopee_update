import type { ListingDraft, SourceSelection } from '@shopee/domain';
import { z } from 'zod';
import { contentBindingSchema } from '../../../packages/domain/src/content-workbook.js';
import { compileDescription } from '../../../packages/domain/src/source/normalize.js';
export type EditorSavePayload = Omit<SourceSelection, 'mappingConfirmation'> & { productKey: string; expectedRevision: number };
export type PendingEditorSave = { payload: EditorSavePayload; variants: { sku: string; originalPrice?: string }[]; sourceFiles: { id: string; sha256: string }[]; submittedAt: string };
export type EditorRecovery = { version: 1; productKey: string; expectedRevision: number; seed: EditorSavePayload; form: EditorSavePayload; layout: string; section: 'content' | 'images' | 'structure'; sourceImportIds: string[] | null; pending?: PendingEditorSave; updatedAt: string };
export type EditorRecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
type RecoveryState = Pick<EditorRecovery, 'form' | 'layout' | 'section' | 'sourceImportIds' | 'pending'>;
const payloadSchema = z.object({
  productKey: z.string().min(1).max(1024), expectedRevision: z.number().int().nonnegative(),
  title: z.string().max(10000), headline: z.string().max(50000), body: z.string().max(100000),
  sourceListingId: z.string().max(200).nullable().optional(), contentBinding: contentBindingSchema.optional(),
  folderBinding: z.object({ batchId: z.string().uuid(), revision: z.number().int().positive(), groupKey: z.string().min(1).max(1024) }).strict().optional(),
  coverId: z.string().uuid().optional(), galleryIds: z.array(z.string().uuid()).max(100), descriptionImageIds: z.array(z.string().uuid()).max(100),
  tierNames: z.array(z.string().max(200)).max(2),
  variants: z.array(z.object({ importId: z.string().uuid(), rowKey: z.string().max(5000), optionLabels: z.array(z.string().max(200)).max(2), imageId: z.string().uuid().optional() }).strict()).min(1).max(2000),
}).strict();
const sourceFileSchema = z.object({ id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const pendingSchema = z.object({ payload: payloadSchema, variants: z.array(z.object({ sku: z.string().max(4000), originalPrice: z.string().regex(/^\d*$/).optional() }).strict()).max(2000), sourceFiles: z.array(sourceFileSchema).max(5000), submittedAt: z.string().max(40) }).strict();
const recoverySchema = z.object({
  version: z.literal(1), productKey: z.string().min(1).max(1024), expectedRevision: z.number().int().nonnegative(),
  seed: payloadSchema, form: payloadSchema, layout: z.enum(['', 'headline-images-body', 'other']),
  section: z.enum(['content', 'images', 'structure']), sourceImportIds: z.array(z.string().uuid()).max(5000).nullable(),
  pending: pendingSchema.optional(), updatedAt: z.string().max(40),
}).strict().refine(value => [value.seed, value.form, ...(value.pending ? [value.pending.payload] : [])]
  .every(payload => payload.productKey === value.productKey && payload.expectedRevision === value.expectedRevision));
const prefix = 'shopee:editor-working-copy:v1:';
const canonical = (value: unknown): string => JSON.stringify(value, (_, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);

/** Whitelist the edit scope, keep SKU row identities fixed, and never forward an approval receipt. */
export function buildEditorPayload(seed: SourceSelection & { productKey?: string; expectedRevision: number }, form: SourceSelection & { productKey?: string; expectedRevision: number }): EditorSavePayload {
  return structuredClone({
    productKey: seed.productKey!, expectedRevision: seed.expectedRevision,
    title: form.title, headline: form.headline, body: form.body,
    ...(form.contentBinding ? { contentBinding: form.contentBinding } : {}),
    ...(seed.folderBinding ? { folderBinding: seed.folderBinding } : {}),
    ...(seed.sourceListingId !== undefined ? { sourceListingId: seed.sourceListingId } : {}),
    ...(form.coverId ? { coverId: form.coverId } : {}), galleryIds: [...form.galleryIds], descriptionImageIds: [...form.descriptionImageIds],
    tierNames: [...seed.tierNames], variants: seed.variants.map((variant, index) => ({
      importId: variant.importId, rowKey: variant.rowKey, optionLabels: [...variant.optionLabels],
      ...(form.variants[index]?.imageId ? { imageId: form.variants[index]!.imageId } : {}),
    })),
  });
}
export function editorRecoveryKey(productKey: string, revision: number): string { return prefix + encodeURIComponent(productKey) + ':' + revision; }
export function makeEditorRecovery(seed: SourceSelection & { productKey?: string; expectedRevision: number }, state: RecoveryState): EditorRecovery {
  const seedPayload = buildEditorPayload(seed, seed);
  return structuredClone({
    version: 1, productKey: seedPayload.productKey, expectedRevision: seed.expectedRevision, seed: seedPayload,
    form: buildEditorPayload(seed, state.form), layout: state.layout, section: state.section,
    sourceImportIds: state.sourceImportIds ? [...state.sourceImportIds] : null,
    ...(state.pending ? { pending: { payload: buildEditorPayload(state.pending.payload, state.pending.payload), variants: state.pending.variants.map(variant => ({ sku: variant.sku, ...(variant.originalPrice !== undefined ? { originalPrice: variant.originalPrice } : {}) })), sourceFiles: state.pending.sourceFiles.map(file => ({ id: file.id, sha256: file.sha256 })), submittedAt: state.pending.submittedAt } } : {}),
    updatedAt: new Date().toISOString(),
  });
}
function decode(raw: string | null): EditorRecovery | null {
  if (!raw || raw.length > 4_000_000) return null;
  try { return recoverySchema.parse(JSON.parse(raw)); } catch { return null; }
}
export function readEditorRecovery(raw: string | null, seed: SourceSelection & { productKey?: string; expectedRevision: number }): { state: 'none' | 'restored' | 'stale' | 'invalid'; copy?: EditorRecovery } {
  if (!raw) return { state: 'none' };
  const copy = decode(raw);
  if (!copy || copy.productKey !== seed.productKey) return { state: 'invalid' };
  return { state: canonical(copy.seed) === canonical(buildEditorPayload(seed, seed)) ? 'restored' : 'stale', copy };
}
export function writeEditorRecovery(storage: EditorRecoveryStorage, copy: EditorRecovery): boolean {
  try {
    const safe = recoverySchema.parse(copy), serialized = JSON.stringify(safe);
    if (serialized.length > 4_000_000) return false;
    storage.setItem(editorRecoveryKey(safe.productKey, safe.expectedRevision), serialized);
    return true;
  } catch { return false; }
}
export function findEditorRecoveries(storage: EditorRecoveryStorage, productKey: string): EditorRecovery[] {
  const copies: EditorRecovery[] = [], productPrefix = prefix + encodeURIComponent(productKey) + ':';
  try {
    for (let index = 0; index < Math.min(storage.length, 10000); index++) {
      const key = storage.key(index);
      if (!key?.startsWith(productPrefix)) continue;
      const copy = decode(storage.getItem(key));
      if (copy?.productKey === productKey && key === editorRecoveryKey(productKey, copy.expectedRevision)) copies.push(copy);
    }
  } catch { /* Storage may be disabled; callers also show the failed read/write explicitly. */ }
  return copies.sort((a, b) => b.expectedRevision - a.expectedRevision || b.updatedAt.localeCompare(a.updatedAt));
}
export function compareEditorSaveResult(pending: PendingEditorSave, draft: ListingDraft): { state: 'saved' | 'unchanged' | 'conflict' | 'unknown' } {
  try {
    if (draft.productKey !== pending.payload.productKey || !Number.isInteger(draft.revision) || !draft.sourceSelection ||
        !Array.isArray(draft.variants) || !Array.isArray(draft.description) || !Array.isArray(draft.galleryKeys)) return { state: 'unknown' };
    const selection = buildEditorPayload({ ...draft.sourceSelection, productKey: draft.productKey, expectedRevision: pending.payload.expectedRevision }, { ...draft.sourceSelection, productKey: draft.productKey, expectedRevision: pending.payload.expectedRevision });
    payloadSchema.parse(selection);
    if (draft.revision === pending.payload.expectedRevision) return { state: 'unchanged' };
    if (pending.variants.length !== pending.payload.variants.length || pending.variants.some(variant => variant.originalPrice === undefined)) return { state: 'unknown' };
    if (draft.revision !== pending.payload.expectedRevision + 1 || canonical(selection) !== canonical(pending.payload) ||
        draft.title.value !== pending.payload.title || canonical(draft.description) !== canonical(compileDescription(pending.payload.headline, pending.payload.body, pending.payload.descriptionImageIds)) ||
        draft.coverKey !== (pending.payload.coverId || '') || canonical(draft.galleryKeys) !== canonical(pending.payload.galleryIds) ||
        canonical(draft.tierNames) !== canonical(pending.payload.tierNames) ||
        canonical(draft.description.flatMap(block => block.type === 'image' ? [block.assetKey] : [])) !== canonical(pending.payload.descriptionImageIds) ||
        draft.variants.length !== pending.payload.variants.length ||
        draft.variants.some((variant, index) => canonical(variant.optionLabels) !== canonical(pending.payload.variants[index]!.optionLabels) ||
          (variant.imageKey || '') !== (pending.payload.variants[index]!.imageId || '') ||
          pending.variants[index] && (variant.sku.value !== pending.variants[index]!.sku ||
            pending.variants[index]!.originalPrice !== undefined && variant.originalPrice.value !== pending.variants[index]!.originalPrice))) return { state: 'conflict' };
    const selectedImages = new Set([...(pending.payload.coverId ? [pending.payload.coverId] : []), ...pending.payload.galleryIds,
      ...pending.payload.descriptionImageIds, ...pending.payload.variants.flatMap(variant => variant.imageId ? [variant.imageId] : [])]);
    for (const id of selectedImages) {
      const files = pending.sourceFiles.filter(file => file.id === id), assets = draft.assets?.filter(asset => asset.key === id) ?? [];
      if (files.length !== 1 || !/^[a-f0-9]{64}$/.test(files[0]!.sha256) || assets.length !== 1) return { state: 'unknown' };
      const asset = assets[0]!, file = files[0]!;
      if (asset.sha256 !== file.sha256 || asset.source.fileSha256 !== file.sha256 || asset.source.kind !== 'product_file' ||
          !asset.source.locator.trim() || !asset.mime.startsWith('image/')) return { state: 'conflict' };
    }
    for (const file of pending.sourceFiles) {
      const asset = draft.assets?.find(asset => asset.key === file.id);
      if (asset && (asset.sha256 !== file.sha256 || asset.source.fileSha256 !== file.sha256)) return { state: 'conflict' };
    }
    return { state: 'saved' };
  } catch { return { state: 'unknown' }; }
}
