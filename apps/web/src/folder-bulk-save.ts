import type { InputBatchRecord, ListingDraft } from '@shopee/domain';
import { z } from 'zod';
import { RequestError } from './api.js';
import type { FolderAssembly } from './folder-source.js';

const requestSchema = z.object({
  productKey: z.string().min(1), expectedRevision: z.literal(0),
  folderBinding: z.object({ batchId: z.string().uuid(), revision: z.number().int().positive(), groupKey: z.string().min(1) }),
  sourceListingId: z.string().nullable().optional(),
  title: z.string().min(1), headline: z.string(), body: z.string(), coverId: z.string().uuid(),
  galleryIds: z.array(z.string().uuid()).min(1), descriptionImageIds: z.array(z.string().uuid()),
  tierNames: z.array(z.string()).max(2),
  variants: z.array(z.object({ importId: z.string().uuid(), rowKey: z.string().min(1), optionLabels: z.array(z.string()), imageId: z.string().uuid().optional() })).min(1),
});
const entrySchema = z.object({
  groupKey: z.string().min(1), title: z.string(), request: requestSchema,
  status: z.enum(['queued', 'saving', 'saved', 'failed', 'uncertain']), message: z.string().optional(),
});
export type FolderBulkEntry = z.infer<typeof entrySchema>;
export type FolderBulkRequest = FolderBulkEntry['request'];
export const folderBulkStorageKey = (batchId: string) => 'shopee.folder-bulk-save.v1:' + batchId;

export function readFolderBulkRecovery(raw: string | null, batchId: string): FolderBulkEntry[] {
  if (!raw) return [];
  const parsed = z.object({ version: z.literal(1), batchId: z.literal(batchId), entries: z.array(entrySchema).max(500) }).parse(JSON.parse(raw));
  const keys = new Set<string>();
  return parsed.entries.map(entry => {
    if (entry.request.folderBinding.batchId !== batchId || entry.request.folderBinding.groupKey !== entry.groupKey || keys.has(entry.request.productKey))
      throw Error('Biên nhận lưu bộ chưa khớp đợt nhập. Giữ biên nhận và mở lại đúng đợt.');
    keys.add(entry.request.productKey);
    return entry.status === 'saving' ? { ...entry, status: 'uncertain' } : entry;
  });
}

/** Only a validated portable source can be saved without a separate editor review. */
export function readyFolderBulkEntries(assemblies: FolderAssembly[], batch: InputBatchRecord | undefined, products: ListingDraft[]): FolderBulkEntry[] {
  if (!batch) return [];
  const existing = new Set(products.map(product => product.productKey));
  const counts = new Map<string, number>();
  for (const assembly of assemblies) counts.set(assembly.productKey, (counts.get(assembly.productKey) ?? 0) + 1);
  return assemblies.flatMap(assembly => {
    if (!assembly.seed || assembly.manifest?.product.sourceRevision !== 0 || assembly.seed.expectedRevision !== 0
      || assembly.issues.some(issue => issue.severity === 'block') || existing.has(assembly.productKey)
      || counts.get(assembly.productKey) !== 1) return [];
    const request = requestSchema.safeParse({ ...assembly.seed, productKey: assembly.productKey,
      folderBinding: { batchId: batch.id, revision: batch.revision, groupKey: assembly.key } });
    return request.success ? [{ groupKey: assembly.key, title: request.data.title, request: request.data, status: 'queued' as const }] : [];
  });
}

export function mergeFolderBulkEntries(previous: FolderBulkEntry[], fresh: FolderBulkEntry[]) {
  const result = previous.map(entry => structuredClone(entry));
  for (const next of fresh) {
    const index = result.findIndex(entry => entry.request.productKey === next.request.productKey);
    if (index < 0) result.push(structuredClone(next));
    else if (result[index].status === 'failed' || result[index].status === 'queued') result[index] = structuredClone(next);
    // An uncertain request and every successful receipt keep their original source identity.
  }
  return result;
}

export function folderBulkStateKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(folderBulkStateKey).join(',') + ']';
  return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + folderBulkStateKey(item)).join(',') + '}';
}
const normalized = (value: unknown) => folderBulkStateKey(JSON.parse(JSON.stringify(value)));
export function folderBulkDraftMatches(draft: ListingDraft, request: FolderBulkRequest) {
  if (draft.productKey !== request.productKey || !Number.isInteger(draft.revision) || draft.revision < 1 || !draft.sourceSelection) return false;
  const { productKey: _key, expectedRevision: _revision, folderBinding: _binding, ...selection } = request;
  const { folderBinding: _storedBinding, ...saved } = draft.sourceSelection;
  return normalized({ ...saved, sourceListingId: saved.sourceListingId ?? null }) === normalized({ ...selection, sourceListingId: selection.sourceListingId ?? null });
}

/** Sequential local saves. Unknown results stop the queue and retain the exact request for recovery. */
export async function runFolderBulkSave(entries: FolderBulkEntry[], options: {
  readBatch: (id: string) => Promise<InputBatchRecord>;
  readProduct: (key: string) => Promise<ListingDraft>;
  save: (request: FolderBulkRequest) => Promise<ListingDraft>;
  checkpoint: (entries: FolderBulkEntry[]) => void;
  onSaved?: (draft: ListingDraft) => void;
}) {
  const rows = structuredClone(entries);
  const checkpoint = () => options.checkpoint(structuredClone(rows));
  checkpoint();
  for (const entry of rows) {
    if (entry.status === 'saved') continue;
    const uncertain = entry.status === 'uncertain' || entry.status === 'saving';
    let sent = false;
    try {
      if (uncertain) {
        let saved: ListingDraft | undefined;
        try { saved = await options.readProduct(entry.request.productKey); }
        catch (cause) { if (!(cause instanceof RequestError && cause.status === 404)) throw cause; }
        if (saved) {
          if (!folderBulkDraftMatches(saved, entry.request)) throw new RequestError('Bản đã lưu khác yêu cầu trước. Mở bộ đã lưu để đối chiếu; chưa ghi đè.', 'FOLDER_SOURCE_CHANGED', 409);
          entry.status = 'saved'; entry.message = undefined; checkpoint(); options.onSaved?.(saved); continue;
        }
      }
      const batch = await options.readBatch(entry.request.folderBinding.batchId);
      if (batch.id !== entry.request.folderBinding.batchId || batch.revision !== entry.request.folderBinding.revision)
        throw new RequestError('Đợt nhập đã thay đổi. Mở bản mới nhất trước khi lưu các bộ còn lại.', 'FOLDER_SOURCE_BINDING_STALE', 409);
      entry.status = 'saving'; entry.message = undefined; checkpoint();
      sent = true;
      const saved = await options.save(structuredClone(entry.request));
      if (!folderBulkDraftMatches(saved, entry.request)) throw Error('Chưa xác nhận được bản đã lưu. Đọc lại kết quả trước khi tiếp tục.');
      entry.status = 'saved'; checkpoint(); options.onSaved?.(saved);
    } catch (cause) {
      const definite = cause instanceof RequestError && cause.status !== undefined && cause.status >= 400 && cause.status < 500;
      entry.status = definite || (!sent && !uncertain) ? 'failed' : 'uncertain';
      entry.message = cause instanceof Error ? cause.message : 'Chưa lưu được bộ listing. Thử đọc lại kết quả.';
      checkpoint();
      if (entry.status === 'uncertain') break;
    }
  }
  return rows;
}
