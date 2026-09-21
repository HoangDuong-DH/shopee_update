import { z } from 'zod';
import type { Scope, SourceRef } from './contracts.js';

/** Source-complete business representation. This is not an OpenAPI wire payload. */
export type PreparedMedia = {
  importId: string;
  sha256: string;
  width: number;
  height: number;
  mime: string;
};
export type PreparedDescription =
  { type: 'text'; text: string } | { type: 'image'; image: PreparedMedia };
export type PreparedModel = {
  sku: string;
  optionLabels: string[];
  tierIndex: number[];
  originalPrice: string;
  stock: number;
  image?: PreparedMedia;
  /** Exact declared source weight. Omission keeps the item's weight as the API default. */
  weightGrams?: number;
  /** Source dimensions or an explicitly authorized estimate; requires a model weight. */
  dimensionCm?: { length: number; width: number; height: number };
};
const modelShippingSchema = z
  .object({
    weightGrams: z.number().finite().positive().optional(),
    dimensionCm: z
      .object({
        length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.dimensionCm !== undefined && value.weightGrams === undefined)
      context.addIssue({
        code: 'custom',
        path: ['weightGrams'],
        message: 'Model dimensions require an explicit model weight',
      });
  });
/** Validate and return only shipping fields, with no coercion, rounding, or source mutation. */
export function validatePreparedModelShipping(
  value: unknown,
): Pick<PreparedModel, 'weightGrams' | 'dimensionCm'> {
  return modelShippingSchema.parse(value);
}
/** Shift the source decimal unit without a floating-point division introducing extra digits.
 * This does not quantize to any platform precision or modify the original gram value. */
export function preparedWeightKilograms(weightGrams: number): number {
  z.number().finite().positive().parse(weightGrams);
  const [coefficient, exponent = '0'] = String(weightGrams).split('e');
  const kilograms = Number(coefficient + 'e' + (Number(exponent) - 3));
  return z.number().finite().positive().parse(kilograms);
}
export type PreparedDocument = {
  sourceKey: string;
  title: string;
  description: PreparedDescription[];
  cover: PreparedMedia;
  gallery: PreparedMedia[];
  tierNames: string[];
  models: PreparedModel[];
  categoryId: string;
  brandId: string;
  attributes: Record<string, string[]>;
  logistics: { channelId: string; enabled: boolean }[];
  weightGrams: number;
  dimensionCm: { length: number; width: number; height: number };
  publication: 'unlisted';
};
export type PreparedField =
  | 'title'
  | 'description'
  | 'cover'
  | 'gallery'
  | 'variationImages'
  | 'price'
  | 'stock'
  | 'attributes'
  | 'logistics';
export type PreparedEntry = {
  folderKey: string;
  connectionId: string;
  scope: Scope;
  sourceFingerprint: string;
  sourceRefs: SourceRef[];
  document: PreparedDocument;
};
export type PreparedRemote = {
  itemId: string;
  document: PreparedDocument;
  modelBindings: { sku: string; modelId: string; tierIndex: number[] }[];
  extra: Record<string, unknown>;
};
export type PreparedMetadata = {
  categoryId: string;
  supported: boolean;
  requiredAttributes: string[];
  allowedAttributeValues: Record<string, string[]>;
  brandIds: string[];
  channelIds: string[];
  maxGallery: number;
  maxModels: number;
  minPrice: number;
  maxPrice: number;
  maxStock: number;
};
export type PreparedOutcome<T> =
  | { kind: 'success'; data: T; requestId: string }
  | { kind: 'rejected'; code: string }
  | { kind: 'unknown'; code: string };
/** Injected at the application boundary. No default adapter or production write permission. */
export interface PreparedGateway {
  readonly mode: 'simulation';
  metadata(scope: Scope, categoryId: string): Promise<PreparedOutcome<PreparedMetadata>>;
  find(scope: Scope, sourceKey: string): Promise<PreparedOutcome<PreparedRemote[]>>;
  read(scope: Scope, itemId: string): Promise<PreparedOutcome<PreparedRemote>>;
  create(scope: Scope, document: PreparedDocument): Promise<PreparedOutcome<{ itemId: string }>>;
  update(
    scope: Scope,
    itemId: string,
    expected: PreparedRemote,
    fields: PreparedField[],
    selectedSkus: string[],
  ): Promise<PreparedOutcome<null>>;
}
