import { z } from 'zod';
import type { PreparedDocument } from '@shopee/domain';
import type { FieldSnapshot } from '../../../packages/shopee/src/field-client.js';
import type { PreparedWireContext } from '../../../packages/shopee/src/prepared-wire.js';
import {
  fetchObservedShopeeImage,
  type ImageQcBinding,
} from '../../../packages/shopee/src/image-qc.js';
import type { ImageQcService } from './image-qc-service.js';

type CoverLookup = { binding: ImageQcBinding; sourceSha256: string; sourceFingerprint: string };
export type ProductionPilotCoverQcOptions = {
  service: ImageQcService;
  /** Trusted server lookup only: an HTTP caller cannot nominate an image case. */
  findCase: (input: CoverLookup) => Promise<{ caseId: string } | null>;
  /** Optionally create a pending local QC case from fresh API-observed bytes. Never auto-review. */
  captureCase?: (input: CoverLookup & { output: Uint8Array }) => Promise<{ caseId: string }>;
  fetch?: typeof globalThis.fetch;
};
export type ProductionPilotCoverAlias = {
  outputImageId: string;
  sourceImageId: string;
  sourceSha256: string;
};
export type ProductionPilotCoverProof = ProductionPilotCoverAlias & {
  caseId: string;
  caseFingerprint: string;
  binding: ImageQcBinding;
  sourceFingerprint: string;
  outputSha256: string;
  observedUrl: string;
  fetchedAt: string;
  basis: 'exact_bytes' | 'exact_pixels' | 'manual_review';
  width: number;
  height: number;
};
const fail = (code: string): never => {
  throw new Error('PRODUCTION_PILOT_COVER_' + code);
};

/** A separate proof bridge, never a relaxed generic image comparator. API envelopes stay untouched.
 * Each read fetches bytes again; a prior case cannot authorize another URL output, item or operation. */
export async function reconcileProductionPilotCover(
  input: {
    operationId: string;
    itemId: string;
    sourceFingerprint: string;
    document: PreparedDocument;
    context: PreparedWireContext;
    raw: FieldSnapshot;
  },
  options?: ProductionPilotCoverQcOptions,
): Promise<{
  qcSnapshot: FieldSnapshot;
  alias?: ProductionPilotCoverAlias;
  proof?: ProductionPilotCoverProof;
}> {
  if (!options) return { qcSnapshot: input.raw }; // Existing strict behavior is the default.
  const promotion = input.raw.item.promotion_image as Record<string, unknown> | undefined;
  const source = input.context.images.filter(
    (image) =>
      image.role === 'cover' &&
      image.importId === input.document.cover.importId &&
      image.sha256 === input.document.cover.sha256,
  );
  if (source.length !== 1) return fail('SOURCE_BINDING_UNPROVEN');
  const ids = promotion?.image_id_list;
  if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string' || !ids[0])
    return fail('SLOT_INVALID');
  const outputId = ids[0],
    sourceId = source[0]!.imageId;
  if (outputId === sourceId && promotion?.image_ratio === '1:1') return { qcSnapshot: input.raw };
  if (promotion?.image_ratio !== undefined && promotion.image_ratio !== '1:1')
    return fail('RATIO_CONTRADICTORY');
  z.string().uuid().parse(input.operationId);
  z.string()
    .regex(/^[1-9]\d*$/)
    .parse(input.itemId);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.sourceFingerprint);
  if (String(input.raw.item.item_id) !== input.itemId) return fail('ITEM_CHANGED');
  const urls = promotion?.image_url_list;
  if (!Array.isArray(urls) || urls.length !== 1 || typeof urls[0] !== 'string')
    return fail('OBSERVED_URL_MISSING');
  const binding: ImageQcBinding = {
    environment: 'production',
    partnerId: '2010476',
    shopId: '1423724897',
    itemId: input.itemId,
    operationId: input.operationId,
    role: 'cover',
    position: 0,
    sourceAssetId: input.document.cover.importId,
    outputImageId: outputId,
  };
  let selected = await options.findCase({
    binding: structuredClone(binding),
    sourceSha256: input.document.cover.sha256,
    sourceFingerprint: input.sourceFingerprint,
  });
  if (!selected && !options.captureCase) return fail('CASE_MISSING');
  const output = await fetchObservedShopeeImage({
    url: urls[0],
    observedUrls: [urls[0]],
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (output.state !== 'fetched') return fail('FETCH_UNRESOLVED');
  if (!selected) selected = await options.captureCase!({ binding: structuredClone(binding),
    sourceSha256: input.document.cover.sha256, sourceFingerprint: input.sourceFingerprint, output: output.bytes });
  z.string().uuid().parse(selected.caseId);
  const entry = await options.service.check({
    id: selected.caseId,
    binding,
    sourceSha256: input.document.cover.sha256,
    outputSha256: output.sha256,
  });
  const evidence = entry.result.evidence,
    basis = entry.result.verificationBasis;
  if (
    entry.state !== 'verified' ||
    !basis ||
    !['exact_bytes', 'exact_pixels', 'manual_review'].includes(basis) ||
    !evidence ||
    evidence.source.sha256 !== input.document.cover.sha256 ||
    evidence.output.sha256 !== output.sha256
  )
    return fail('CASE_UNVERIFIED');
  if (
    evidence.source.width !== input.document.cover.width ||
    evidence.source.height !== input.document.cover.height ||
    evidence.source.width !== evidence.source.height ||
    evidence.output.width <= 0 ||
    evidence.output.width !== evidence.output.height
  )
    return fail('DECODED_RATIO_MISMATCH');
  const alias = {
    outputImageId: outputId,
    sourceImageId: sourceId,
    sourceSha256: input.document.cover.sha256,
  };
  const proof: ProductionPilotCoverProof = {
    ...alias,
    caseId: entry.id,
    caseFingerprint: entry.fingerprint,
    binding,
    sourceFingerprint: input.sourceFingerprint,
    outputSha256: output.sha256,
    observedUrl: output.url,
    fetchedAt: new Date().toISOString(),
    basis,
    width: evidence.output.width,
    height: evidence.output.height,
  };
  const qcSnapshot = structuredClone(input.raw);
  const projected = qcSnapshot.item.promotion_image as Record<string, unknown>;
  projected.image_id_list = [sourceId];
  if (projected.image_ratio === undefined) projected.image_ratio = '1:1';
  return { qcSnapshot, alias, proof };
}
