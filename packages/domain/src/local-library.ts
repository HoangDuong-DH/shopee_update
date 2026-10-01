import { z } from 'zod';

export const localLibraryQuerySchema = z.object({
  lifecycle: z.enum(['active', 'archived', 'all']).default('active'),
  q: z.string().max(200).refine(value=>!value.includes('\u0000')).default('').transform(value => value.normalize('NFKC').trim()),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
export type LocalLibraryQuery = z.infer<typeof localLibraryQuerySchema>;
export type LocalLibraryPage<T> = {
  observedAt: string; items: T[]; hasMore: boolean; nextCursor: string | null;
};
export type LocalProductShopAssignment = {
  workOrderId: string; revision: number; connectionId: string | null;
  scope: { environment: 'production' | 'sandbox'; partnerId: string; shopId: string } | null;
  name: string | null; sourceRevision: number; sourceChanged: boolean;
};
/** A dated display projection of a saved draft, never an execution approval. */
export type LocalProductSummary = {
  productKey: string; revision: number; title: string | null; coverKey: string | null;
  variantCount: number | null; assetCount: number | null; galleryCount: number | null;
  savedIssueCount: number | null; savedBlockingIssueCount: number | null; issueBasis: 'saved_draft';
  updatedAt: string; archived: boolean; archivedAt: string | null;
  shopAssignments: LocalProductShopAssignment[]; shopAssignmentCount: number; shopAssignmentsTruncated: boolean;
};
export type LocalImportSummary = {
  id: string; importId: string; sha256: string; sourceSha: string;
  filename: string; originalName: string; kind: 'xlsx' | 'docx' | 'image'; dataType: 'xlsx' | 'docx' | 'image';
  bytes: number; status: string; message: string; createdAt: string; updatedAt: string;
  archived: boolean; archivedAt: string | null;
  /** Import identity is content-addressed. No source revision is stored for it. */
  revision: null; bodyState: 'not_loaded';
};
