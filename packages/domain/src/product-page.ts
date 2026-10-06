import { z } from 'zod';
import type { ListingDraft } from './contracts.js';

export const productPageQuerySchema = z.object({
  lifecycle: z.enum(['active','archived','all']).default('active'),
  q: z.string().max(200).refine(value=>!value.includes('\u0000')).default('').transform(value=>value.normalize('NFKC').trim()),
  page: z.coerce.number().int().min(1).max(100000000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ProductPageQuery = z.infer<typeof productPageQuerySchema>;
export type ProductPageInfo = { total: number; page: number; limit: number; hasMore: boolean };
export type ProductPage = ProductPageInfo & { items: ListingDraft[] };
/** Bounded exact lookups keep selected sources independent of the visible page. */
export const productKeysSchema = z.array(z.string().min(1).max(200).refine(value=>!value.includes('\u0000'))).max(240);
