import { z } from 'zod';

export const shopListingCopyPolicySchema = z.object({
  targetStatus: z.literal('UNLIST'),
  stockStrategy: z.literal('source_saleable_snapshot'),
  priceStrategy: z.literal('source_original'),
  promotionStrategy: z.literal('record_exception'),
}).strict();

export type ShopListingCopyPolicy = z.infer<typeof shopListingCopyPolicySchema>;

export const defaultShopListingCopyPolicy: ShopListingCopyPolicy = Object.freeze({
  targetStatus: 'UNLIST',
  stockStrategy: 'source_saleable_snapshot',
  priceStrategy: 'source_original',
  promotionStrategy: 'record_exception',
});
