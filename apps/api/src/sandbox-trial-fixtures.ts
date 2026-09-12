import sharp from 'sharp';
import { createUnlistedSchema, initTiersSchema } from '@shopee/gateway';
import type { SandboxCreateTrialManifest } from '@shopee/persistence';
import { z } from 'zod';

export const trialPreparationInput = z
  .object({
    trialKey: z.string().regex(/^SBX-BULK-[A-Za-z0-9_-]{1,50}$/),
    connectionId: z.string().uuid(),
    connectionRevision: z.number().int().positive(),
    count: z.number().int().min(1).max(80),
    logisticId: z.number().int().positive(),
    shippingFee: z.number().finite().nonnegative().optional(),
    sizeId: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TrialPreparationInput = z.infer<typeof trialPreparationInput>;

/** New artificial test sources. Never consumes, changes, or imitates a business listing. */
export function syntheticTrial(
  input: TrialPreparationInput,
  imageIds: string[],
): SandboxCreateTrialManifest {
  if (imageIds.length !== 3) throw new Error('SANDBOX_TRIAL_IMAGES_REQUIRED');
  return {
    trialKey: input.trialKey,
    connectionId: input.connectionId,
    connectionRevision: input.connectionRevision,
    items: Array.from({ length: input.count }, (_, index) => {
      const number = String(index + 1).padStart(3, '0'),
        sourceKey = input.trialKey + '-' + number,
        tierCount = index % 3;
      const create = createUnlistedSchema.parse({
        item_sku: sourceKey,
        item_name: `SANDBOX QA So tay gia lap ${number} ${input.trialKey.slice(9)}`,
        description: `SANDBOX ONLY. Synthetic notebook fixture ${sourceKey}. This is technical test data, not an actual product offered for sale. Paper notebook for testing exact source transfer, prices, stock and variants. No commercial claims.`,
        description_type: 'normal',
        item_status: 'UNLIST',
        category_id: 301378,
        original_price: 20000 + index * 100,
        seller_stock: [{ stock: 3 }],
        weight: 0.2,
        dimension: { package_height: 2, package_width: 15, package_length: 21 },
        brand: { brand_id: 0, original_brand_name: 'No Brand' },
        condition: 'NEW',
        pre_order: { is_pre_order: false },
        attribute_list: [{ attribute_id: 200134, attribute_value_list: [{ value_id: 101205 }] }],
        image: { image_ratio: '1:1', image_id_list: imageIds },
        logistic_info: [
          {
            logistic_id: input.logisticId,
            enabled: true,
            is_free: false,
            ...(input.shippingFee !== undefined ? { shipping_fee: input.shippingFee } : {}),
            ...(input.sizeId !== undefined ? { size_id: input.sizeId } : {}),
          },
        ],
      });
      if (tierCount === 0) return { sourceKey, create };
      const tierNames = ['Mau bia', 'So trang'],
        options = [
          ['Cam', 'Xanh'],
          ['80 trang', '120 trang'],
        ];
      const tiers = initTiersSchema.parse({
        item_id: 1,
        standardise_tier_variation: Array.from({ length: tierCount }, (_, t) => ({
          variation_id: 0,
          variation_name: tierNames[t],
          variation_option_list: options[t].map((name, o) => ({
            variation_option_id: 0,
            variation_option_name: name,
            ...(t === 0 ? { image_id: imageIds[o + 1] } : {}),
          })),
        })),
        model: Array.from({ length: 2 ** tierCount }, (_, model) => ({
          tier_index: tierCount === 1 ? [model] : [Math.floor(model / 2), model % 2],
          model_sku: sourceKey + '-M' + String(model + 1),
          original_price: create.original_price + model * 1000,
          seller_stock: [{ stock: 3 + model }],
        })),
      });
      const { item_id: placeholderItemId, ...withoutBinding } = tiers;
      return { sourceKey, create, tiers: withoutBinding };
    }),
  };
}

export async function syntheticTrialImages(trialKey: string): Promise<Buffer[]> {
  return Promise.all(
    ['#e5e7eb', '#f4b16b', '#80bfad'].map((colour, index) =>
      sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="${colour}"/><rect x="270" y="250" width="460" height="480" rx="12" fill="white" stroke="#334155" stroke-width="8"/><path d="M320 250V730" stroke="#334155" stroke-width="6"/><text x="500" y="130" text-anchor="middle" font-family="sans-serif" font-size="55">SANDBOX QA</text><text x="520" y="410" text-anchor="middle" font-family="sans-serif" font-size="34">SYNTHETIC NOTEBOOK</text><text x="520" y="480" text-anchor="middle" font-family="sans-serif" font-size="30">${['TEST COVER', 'CAM', 'XANH'][index]}</text><text x="500" y="830" text-anchor="middle" font-family="sans-serif" font-size="27">${trialKey}</text><text x="500" y="895" text-anchor="middle" font-family="sans-serif" font-size="30">TEST DATA - NOT FOR SALE</text></svg>`,
        ),
      )
        .png()
        .toBuffer(),
    ),
  );
}
