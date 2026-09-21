import { createHash } from 'node:crypto';
import sharp from 'sharp';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_FETCH_MS = 12_000;
const COMPARISON_VERSION = 'image-qc/v1' as const;
const hosts = new Set(['cf.shopee.vn', 'cf.shopee.sg']);

export type ImageQcBinding = {
  environment: 'sandbox' | 'production';
  partnerId: string;
  shopId: string;
  itemId: string;
  operationId: string;
  role: 'cover' | 'gallery' | 'description' | 'variation';
  position: number;
  sourceAssetId: string;
  outputImageId: string;
};
export type ImageReviewAttestation = {
  version: 'image-review/v1';
  decision: 'accept_lossy_match';
  binding: ImageQcBinding;
  sourceSha256: string;
  outputSha256: string;
  reviewer: string;
  reviewedAt: string;
  note: string;
};
export type ImageQcResult = {
  state: 'verified' | 'mismatch' | 'review_required' | 'unresolved';
  reason: string;
  verificationBasis?: 'exact_bytes' | 'exact_pixels' | 'manual_review';
  metrics?: {
    sameDimensions: boolean;
    sameAspectRatio: boolean;
    changedPixelFraction?: number;
    meanAbsoluteChannelDifference?: number;
    thumbnailMeanAbsoluteChannelDifference: number;
  };
  evidence?: {
    version: typeof COMPARISON_VERSION;
    binding: ImageQcBinding;
    source: ImageByteEvidence;
    output: ImageByteEvidence;
  };
  attestation?: ImageReviewAttestation;
};
export type ImageByteEvidence = {
  sha256: string;
  decodedSha256: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 500 && value === value.trim();
const bindingKeys: (keyof ImageQcBinding)[] = [
  'environment',
  'partnerId',
  'shopId',
  'itemId',
  'operationId',
  'role',
  'position',
  'sourceAssetId',
  'outputImageId',
];
export function isImageQcBinding(value: unknown): value is ImageQcBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as ImageQcBinding;
  return (
    Object.keys(binding).length === bindingKeys.length &&
    bindingKeys.every((key) => Object.hasOwn(binding, key)) &&
    ['sandbox', 'production'].includes(binding.environment) &&
    ['cover', 'gallery', 'description', 'variation'].includes(binding.role) &&
    Number.isSafeInteger(binding.position) &&
    binding.position >= 0 &&
    (binding.role !== 'cover' || binding.position === 0) &&
    ['partnerId', 'shopId', 'itemId', 'operationId', 'sourceAssetId', 'outputImageId'].every(
      (key) => nonempty(binding[key as keyof ImageQcBinding]),
    )
  );
}
function validReview(
  attestation: ImageReviewAttestation | undefined,
  binding: ImageQcBinding,
  sourceSha256: string,
  outputSha256: string,
): attestation is ImageReviewAttestation {
  return (
    !!attestation &&
    attestation.version === 'image-review/v1' &&
    attestation.decision === 'accept_lossy_match' &&
    isImageQcBinding(attestation.binding) &&
    bindingKeys.every((key) => attestation.binding[key] === binding[key]) &&
    attestation.sourceSha256 === sourceSha256 &&
    attestation.outputSha256 === outputSha256 &&
    nonempty(attestation.reviewer) &&
    nonempty(attestation.note) &&
    nonempty(attestation.reviewedAt) &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(attestation.reviewedAt) &&
    Number.isFinite(Date.parse(attestation.reviewedAt))
  );
}
async function decode(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_BYTES)
    throw new Error('image_byte_limit_or_missing');
  // A copy prevents a caller from changing the evidence buffer during async decoding.
  const copied = Buffer.from(bytes);
  const decoder = sharp(copied, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).timeout({
    seconds: 5,
  });
  const metadata = await decoder.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
    throw new Error('unsupported_image');
  const { data, info } = await decoder
    .rotate()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const thumbnail = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer();
  return {
    pixels: data,
    thumbnail,
    evidence: {
      sha256: digest(copied),
      decodedSha256: digest(data),
      bytes: copied.length,
      width: info.width,
      height: info.height,
      format: metadata.format!,
    },
  };
}
function difference(a: Uint8Array, b: Uint8Array) {
  let absolute = 0,
    changedPixels = 0;
  for (let pixel = 0; pixel < a.length; pixel += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const diff = Math.abs(a[pixel + channel]! - b[pixel + channel]!);
      absolute += diff;
      changed ||= diff !== 0;
    }
    if (changed) changedPixels++;
  }
  return {
    changedPixelFraction: changedPixels / (a.length / 4),
    meanAbsoluteChannelDifference: absolute / a.length,
  };
}

/** No network or inferred equivalence: thumbnails only route candidates to explicit review. */
export async function compareImageBytes(input: {
  source: Uint8Array;
  output: Uint8Array;
  binding: ImageQcBinding;
  attestation?: ImageReviewAttestation;
}): Promise<ImageQcResult> {
  if (!isImageQcBinding(input.binding))
    return { state: 'unresolved', reason: 'image_binding_invalid' };
  const binding = structuredClone(input.binding);
  let source: Awaited<ReturnType<typeof decode>>, output: Awaited<ReturnType<typeof decode>>;
  try {
    [source, output] = await Promise.all([decode(input.source), decode(input.output)]);
  } catch {
    return { state: 'unresolved', reason: 'image_decode_failed_or_limit' };
  }
  const evidence = {
    version: COMPARISON_VERSION,
    binding,
    source: source.evidence,
    output: output.evidence,
  };
  const sameDimensions =
    source.evidence.width === output.evidence.width &&
    source.evidence.height === output.evidence.height;
  const sameAspectRatio =
    source.evidence.width * output.evidence.height ===
    output.evidence.width * source.evidence.height;
  const metrics = {
    sameDimensions,
    sameAspectRatio,
    ...(sameDimensions ? difference(source.pixels, output.pixels) : {}),
    thumbnailMeanAbsoluteChannelDifference: difference(source.thumbnail, output.thumbnail)
      .meanAbsoluteChannelDifference,
  };
  if (source.evidence.sha256 === output.evidence.sha256)
    return {
      state: 'verified',
      reason: 'exact_bytes',
      verificationBasis: 'exact_bytes',
      evidence,
      metrics,
    };
  if (sameDimensions && source.pixels.equals(output.pixels))
    return {
      state: 'verified',
      reason: 'exact_decoded_pixels',
      verificationBasis: 'exact_pixels',
      evidence,
      metrics,
    };
  if (!sameAspectRatio)
    return { state: 'mismatch', reason: 'image_aspect_ratio_changed', evidence, metrics };
  // A conservative rejection threshold, not a probability or an automatic approval threshold.
  if (metrics.thumbnailMeanAbsoluteChannelDifference > 35)
    return { state: 'mismatch', reason: 'image_visually_different', evidence, metrics };
  if (validReview(input.attestation, binding, source.evidence.sha256, output.evidence.sha256)) {
    return {
      state: 'verified',
      reason: 'review_attested',
      verificationBasis: 'manual_review',
      evidence,
      metrics,
      attestation: structuredClone(input.attestation),
    };
  }
  return {
    state: 'review_required',
    reason: input.attestation ? 'image_review_binding_invalid' : 'image_pixels_differ',
    evidence,
    metrics,
  };
}

export type ObservedImageFetchResult =
  | {
      state: 'fetched';
      reason: 'api_observed_image';
      bytes: Uint8Array;
      sha256: string;
      url: string;
      contentType: string;
    }
  | { state: 'unresolved'; reason: string };
export async function compareImageRoleSet(input: {
  expected: readonly { binding: ImageQcBinding; source: Uint8Array }[];
  observed: readonly { binding: ImageQcBinding; output: Uint8Array }[];
  attestations?: readonly ImageReviewAttestation[];
}): Promise<{ state: ImageQcResult['state']; reason: string; results: ImageQcResult[] }> {
  if (
    !Array.isArray(input.expected) ||
    !Array.isArray(input.observed) ||
    input.expected.length === 0 ||
    input.expected.length > 100 ||
    input.observed.length > 100
  )
    return { state: 'unresolved', reason: 'image_role_set_invalid', results: [] };
  if (input.expected.length !== input.observed.length)
    return { state: 'mismatch', reason: 'image_role_count_changed', results: [] };
  const slots = new Set<string>();
  for (let index = 0; index < input.expected.length; index++) {
    const expected = input.expected[index]!,
      observed = input.observed[index]!;
    if (!isImageQcBinding(expected.binding) || !isImageQcBinding(observed.binding))
      return { state: 'unresolved', reason: 'image_binding_invalid', results: [] };
    const slot = JSON.stringify(
      ['environment', 'partnerId', 'shopId', 'itemId', 'operationId', 'role', 'position'].map(
        (key) => expected.binding[key as keyof ImageQcBinding],
      ),
    );
    if (
      slots.has(slot) ||
      !bindingKeys.every((key) => expected.binding[key] === observed.binding[key])
    )
      return { state: 'mismatch', reason: 'image_role_order_or_binding_changed', results: [] };
    slots.add(slot);
  }
  const results: ImageQcResult[] = [];
  // Sequential decoding limits peak memory regardless of the number of gallery entries.
  for (let index = 0; index < input.expected.length; index++) {
    const expected = input.expected[index]!,
      observed = input.observed[index]!;
    const reviews =
      input.attestations?.filter(
        (review) =>
          isImageQcBinding(review.binding) &&
          bindingKeys.every((key) => review.binding[key] === expected.binding[key]),
      ) ?? [];
    if (reviews.length > 1)
      return { state: 'unresolved', reason: 'image_review_ambiguous', results };
    results.push(
      await compareImageBytes({
        source: expected.source,
        output: observed.output,
        binding: expected.binding,
        ...(reviews[0] ? { attestation: reviews[0] } : {}),
      }),
    );
  }
  const state =
    (['mismatch', 'unresolved', 'review_required'] as const).find((candidate) =>
      results.some((result) => result.state === candidate),
    ) ?? 'verified';
  return {
    state,
    reason: state === 'verified' ? 'image_role_set_verified' : 'image_role_set_incomplete',
    results,
  };
}
function withinDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('image_fetch_timeout'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('image_fetch_timeout'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
/** observedUrls must come from the caller's trusted, persisted OpenAPI readback. */
export async function fetchObservedShopeeImage(input: {
  url: string;
  observedUrls: readonly string[];
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<ObservedImageFetchResult> {
  const maxBytes = input.maxBytes ?? MAX_BYTES,
    timeoutMs = input.timeoutMs ?? MAX_FETCH_MS;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_BYTES ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_FETCH_MS
  )
    return { state: 'unresolved', reason: 'image_fetch_limits_invalid' };
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { state: 'unresolved', reason: 'image_url_invalid' };
  }
  if (
    !Array.isArray(input.observedUrls) ||
    !input.observedUrls.includes(input.url) ||
    input.url !== input.url.trim() ||
    url.protocol !== 'https:' ||
    !hosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    return { state: 'unresolved', reason: 'image_url_not_allowed_or_unobserved' };
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await withinDeadline(
      (input.fetch ?? globalThis.fetch)(input.url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'image/png,image/jpeg,image/webp' },
      }),
      controller.signal,
    );
    if (
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== url.href)
    )
      return { state: 'unresolved', reason: 'image_fetch_status_or_redirect' };
    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType))
      return { state: 'unresolved', reason: 'image_fetch_content_type' };
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
      return { state: 'unresolved', reason: 'image_fetch_byte_limit' };
    if (!response.body) return { state: 'unresolved', reason: 'image_fetch_body_missing' };
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await withinDeadline(reader.read(), controller.signal);
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maxBytes) return { state: 'unresolved', reason: 'image_fetch_byte_limit' };
      chunks.push(chunk.value);
    }
    if (length === 0) return { state: 'unresolved', reason: 'image_fetch_body_missing' };
    const bytes = Buffer.concat(chunks);
    return {
      state: 'fetched',
      reason: 'api_observed_image',
      bytes,
      sha256: digest(bytes),
      url: input.url,
      contentType,
    };
  } catch {
    return {
      state: 'unresolved',
      reason: controller.signal.aborted ? 'image_fetch_timeout' : 'image_fetch_failed',
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}
