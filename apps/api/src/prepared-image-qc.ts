import type { Scope } from '@shopee/domain';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FieldSnapshot } from '../../../packages/shopee/src/field-client.js';
import type { PreparedWireStep } from '../../../packages/shopee/src/prepared-wire.js';
import {
  checkPreparedWireUpdate,
  type PreparedWireQc,
} from '../../../packages/shopee/src/prepared-wire-qc.js';
import type { ImageQcResult } from '../../../packages/shopee/src/image-qc.js';
import type { ImageQcService } from './image-qc-service.js';
export type PreparedImageQcInput = {
  operationId: string;
  scope: Pick<Scope, 'environment' | 'partnerId' | 'shopId'>;
  before: FieldSnapshot;
  after: FieldSnapshot;
  steps: PreparedWireStep[];
  cover?: {
    caseId: string;
    sourceAssetId: string;
    sourceBaselineImageId: string;
    source: { imageId: string; bytes: Uint8Array };
    output: { imageId: string; bytes: Uint8Array };
  };
};
export type PreparedImageQcResult = {
  verified: boolean;
  reason: string;
  basis:
    | 'raw_fields_exact'
    | 'image_exact_bytes'
    | 'image_exact_pixels'
    | 'image_manual_review'
    | 'unresolved';
  mismatchedPaths: string[];
  rawQc: PreparedWireQc;
  projectedQc?: PreparedWireQc;
  image?: ImageQcResult;
  imageCaseId?: string;
};
const text = z.string().trim().min(1).max(500);
const observedImage = z
  .object({
    imageId: text,
    bytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.length > 0 && bytes.length <= 10 * 1024 * 1024),
  })
  .strict();
const inputSchema = z
  .object({
    operationId: text,
    scope: z
      .object({
        environment: z.enum(['sandbox', 'production']),
        partnerId: text,
        shopId: text,
        connectionRevision: z.number().int().positive().optional(),
        capabilityRevision: z.number().int().nonnegative().optional(),
      })
      .strict(),
    before: z.custom<FieldSnapshot>(),
    after: z.custom<FieldSnapshot>(),
    steps: z.array(z.custom<PreparedWireStep>()).min(1).max(20),
    cover: z
      .object({
        caseId: z.string().uuid(),
        sourceAssetId: text,
        sourceBaselineImageId: text,
        source: observedImage,
        output: observedImage,
      })
      .strict()
      .optional(),
  })
  .strict();
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function singleImageId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ids = (value as Record<string, unknown>).image_id_list;
  return Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string' && ids[0].length > 0
    ? ids[0]
    : undefined;
}
/** Internal reconciliation only. Fresh byte observations must come from trusted API-observed image
 * fetches. Historical snapshots and journal states are never modified by this projection. */
export async function checkPreparedWireUpdateWithImageQc(
  service: ImageQcService,
  raw: PreparedImageQcInput,
): Promise<PreparedImageQcResult> {
  const parsed = inputSchema.safeParse(raw);
  const rawQc = checkPreparedWireUpdate(raw?.before, raw?.after, raw?.steps);
  const failure = (reason: string): PreparedImageQcResult => ({
    verified: false,
    reason,
    basis: 'unresolved',
    rawQc,
    mismatchedPaths: [...rawQc.mismatchedPaths],
  });
  if (!parsed.success) return failure('IMAGE_QC_INPUT_INVALID');
  const input = structuredClone(parsed.data);
  if (!input.cover)
    return {
      verified: rawQc.verified,
      reason: rawQc.verified ? 'raw_fields_verified' : 'raw_fields_mismatch',
      basis: rawQc.verified ? 'raw_fields_exact' : 'unresolved',
      rawQc,
      mismatchedPaths: [...rawQc.mismatchedPaths],
    };
  const cover = input.cover;
  try {
    const itemId = String(input.before.item.item_id);
    if (!/^[1-9]\d*$/.test(itemId) || String(input.after.item.item_id) !== itemId)
      return failure('IMAGE_QC_ITEM_CHANGED');
    let sourceId = singleImageId(input.before.item.promotion_image);
    for (const step of input.steps) {
      if (step.payload && Object.hasOwn(step.payload, 'promotion_images'))
        sourceId = singleImageId(step.payload.promotion_images);
    }
    const outputId = singleImageId(input.after.item.promotion_image);
    if (
      !sourceId ||
      !outputId ||
      cover.sourceBaselineImageId !== sourceId ||
      cover.source.imageId !== sourceId ||
      cover.output.imageId !== outputId
    )
      return failure('IMAGE_QC_SLOT_CHANGED');
    const entry = await service.check({
      id: cover.caseId,
      binding: {
        environment: input.scope.environment,
        partnerId: input.scope.partnerId,
        shopId: input.scope.shopId,
        itemId,
        operationId: input.operationId,
        role: 'cover',
        position: 0,
        sourceAssetId: cover.sourceAssetId,
        outputImageId: outputId,
      },
      sourceSha256: digest(cover.source.bytes),
      outputSha256: digest(cover.output.bytes),
    });
    const basis = entry.result.verificationBasis;
    if (entry.result.state !== 'verified' || !basis)
      return {
        ...failure('IMAGE_QC_REVIEW_NOT_VERIFIED'),
        image: entry.result,
        imageCaseId: entry.id,
      };
    const projected = structuredClone(input.after);
    (projected.item.promotion_image as { image_id_list: string[] }).image_id_list[0] = sourceId;
    const projectedQc = checkPreparedWireUpdate(input.before, projected, input.steps);
    return {
      verified: projectedQc.verified,
      reason: projectedQc.verified
        ? 'scoped_cover_reconciliation_verified'
        : 'protected_fields_mismatch',
      basis: projectedQc.verified
        ? basis === 'manual_review'
          ? 'image_manual_review'
          : basis === 'exact_bytes'
            ? 'image_exact_bytes'
            : 'image_exact_pixels'
        : 'unresolved',
      rawQc,
      projectedQc,
      mismatchedPaths: [...projectedQc.mismatchedPaths],
      image: entry.result,
      imageCaseId: entry.id,
    };
  } catch (error) {
    return failure(
      error instanceof Error && /^IMAGE_QC_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'IMAGE_QC_RECONCILIATION_UNRESOLVED',
    );
  }
}
