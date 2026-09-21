import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  compareImageBytes,
  type ImageQcBinding,
  type ImageReviewAttestation,
} from '../../packages/shopee/src/image-qc.js';

// Independently authored technical pixels; no user asset, network or OCR model.
// The tiny bitmap labels intentionally occupy far less than 1% of the canvas.
const digits: Record<string, string[]> = {
  '0': ['11111', '10001', '10011', '10101', '11001', '10001', '11111'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
};
const binding: ImageQcBinding = {
  environment: 'sandbox',
  partnerId: '1232297',
  shopId: '910000011',
  itemId: '920000011',
  operationId: 'b35a3b4f-88e0-4c3f-99f5-1f2508c5d98e',
  role: 'cover',
  position: 0,
  sourceAssetId: '6e8f289b-3c4f-41c1-9c27-3115a2a4e4a9',
  outputImageId: 'fixture-original-image',
};
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

async function productLabel(label: string, width = 640, height = 480) {
  const pixels = Buffer.alloc(width * height * 3, 245);
  const draw = (x: number, y: number, rgb: number[]) => {
    const index = (y * width + x) * 3;
    pixels.set(rgb, index);
  };
  // Shared package body/background makes whole-image similarity misleading.
  for (let y = 70; y < height - 50; y++)
    for (let x = 100; x < width - 100; x++) draw(x, y, [44, 94, 144]);
  for (let char = 0; char < label.length; char++) {
    const glyph = digits[label[char]!]!;
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 5; x++)
        if (glyph[y]![x] === '1') draw(18 + char * 6 + x, 20 + y, [12, 12, 12]);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

function attest(
  source: Uint8Array,
  output: Uint8Array,
  scope: ImageQcBinding = binding,
): ImageReviewAttestation {
  return {
    version: 'image-review/v1',
    decision: 'accept_lossy_match',
    binding: structuredClone(scope),
    sourceSha256: sha(source),
    outputSha256: sha(output),
    reviewer: 'Independent fixture reviewer',
    reviewedAt: '2026-09-14T08:00:00.000Z',
    note: 'Explicitly inspected this exact fixture pair; not a reusable image alias.',
  };
}

describe('image QC adversarial boundary — synthetic pixels only, no Shopee requests', () => {
  it('verifies exact bytes and exact decoded pixels under a different PNG encoding', async () => {
    const source = await productLabel('SKU-A100');
    expect((await compareImageBytes({ source, output: source, binding })).state).toBe('verified');
    const encoded = await sharp(source).png({ compressionLevel: 0 }).toBuffer();
    expect(sha(encoded)).not.toBe(sha(source));
    const [a, b] = await Promise.all([
      sharp(source).ensureAlpha().raw().toBuffer(),
      sharp(encoded).ensureAlpha().raw().toBuffer(),
    ]);
    expect(a.equals(b)).toBe(true);
    expect((await compareImageBytes({ source, output: encoded, binding })).state).toBe('verified');
  });

  it.each([
    ['quantity', 'SKU-A100', 'SKU-A500'],
    ['SKU', 'SKU-A100', 'SKU-B100'],
  ])(
    'never auto-verifies a tiny changed %s label on the same package/background',
    async (_, original, changed) => {
      const [source, output] = await Promise.all([productLabel(original), productLabel(changed)]);
      expect(sha(source)).not.toBe(sha(output));
      const result = await compareImageBytes({ source, output, binding });
      expect(['review_required', 'mismatch']).toContain(result.state);
      expect(result.state).not.toBe('verified');
    },
  );

  it('never auto-verifies a one-pixel border crop followed by resizing to original dimensions', async () => {
    const source = await productLabel('SKU-A100');
    const output = await sharp(source)
      .extract({ left: 1, top: 0, width: 639, height: 480 })
      .resize(640, 480)
      .png()
      .toBuffer();
    expect((await compareImageBytes({ source, output, binding })).state).not.toBe('verified');
  });

  it('rejects substituting portrait media padded into a square cover', async () => {
    const source = await productLabel('SKU-A100', 480, 480);
    const portrait = await productLabel('SKU-B500', 360, 480);
    const output = await sharp(portrait)
      .extend({ left: 60, right: 60, top: 0, bottom: 0, background: '#ffffff' })
      .png()
      .toBuffer();
    expect((await compareImageBytes({ source, output, binding })).state).not.toBe('verified');
  });

  it('requires review of lossy JPEG recompression rather than using a similarity score as acceptance', async () => {
    const source = await productLabel('SKU-A100');
    const output = await sharp(source).jpeg({ quality: 85 }).toBuffer();
    const result = await compareImageBytes({ source, output, binding });
    expect(result.state).not.toBe('verified');
    expect(['review_required', 'mismatch']).toContain(result.state);
  });

  it('labels an explicit exact-pair lossy review as manual and leaves the source/binding untouched', async () => {
    const source = await productLabel('SKU-A100');
    const output = await sharp(source).jpeg({ quality: 95 }).toBuffer();
    const sourceHash = sha(source),
      outputHash = sha(output),
      originalBinding = structuredClone(binding);
    expect((await compareImageBytes({ source, output, binding })).state).toBe('review_required');
    const review = attest(source, output);
    const originalReview = structuredClone(review);
    const result = await compareImageBytes({ source, output, binding, attestation: review });
    expect(result.state).toBe('verified');
    expect(result.verificationBasis).toBe('manual_review');
    expect(sha(source)).toBe(sourceHash);
    expect(sha(output)).toBe(outputHash);
    expect(binding).toEqual(originalBinding);
    expect(review).toEqual(originalReview);
  });

  it.each([
    'shopId',
    'itemId',
    'operationId',
    'role',
    'position',
    'sourceAssetId',
    'outputImageId',
  ] as const)('does not reuse a review attestation for a different %s', async (field) => {
    const source = await productLabel('SKU-A100');
    const output = await sharp(source).jpeg({ quality: 95 }).toBuffer();
    expect((await compareImageBytes({ source, output, binding })).state).toBe('review_required');
    const wrong = structuredClone(binding);
    if (field === 'position') wrong.position = 1;
    else if (field === 'role') wrong.role = 'variation';
    else
      wrong[field] =
        field === 'operationId'
          ? '0b17c5bc-6896-4d78-9029-8332b669dc91'
          : `different-${binding[field]}`;
    const result = await compareImageBytes({
      source,
      output,
      binding,
      attestation: attest(source, output, wrong),
    });
    expect(result.state).not.toBe('verified');
  });

  it.each(['sourceSha256', 'outputSha256'] as const)(
    'does not reuse a review after the %s changes',
    async (field) => {
      const source = await productLabel('SKU-A100');
      const output = await sharp(source).jpeg({ quality: 95 }).toBuffer();
      const review = attest(source, output);
      review[field] = 'f'.repeat(64);
      expect(
        (await compareImageBytes({ source, output, binding, attestation: review })).state,
      ).not.toBe('verified');
    },
  );

  it('does not let a matching attestation override strong content mismatch or invalid bytes', async () => {
    const source = await productLabel('SKU-A100');
    const wrong = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#ee2222' },
    })
      .png()
      .toBuffer();
    const plain = await compareImageBytes({ source, output: wrong, binding });
    expect(plain.state).toBe('mismatch');
    expect(
      (
        await compareImageBytes({
          source,
          output: wrong,
          binding,
          attestation: attest(source, wrong),
        })
      ).state,
    ).toBe('mismatch');
    const corrupt = new Uint8Array([137, 80, 78, 71]);
    expect(
      (
        await compareImageBytes({
          source,
          output: corrupt,
          binding,
          attestation: attest(source, corrupt),
        })
      ).state,
    ).toBe('unresolved');
  });

  it('keeps missing input unresolved even when both empty byte arrays have the same hash', async () => {
    expect(
      (await compareImageBytes({ source: new Uint8Array(), output: new Uint8Array(), binding }))
        .state,
    ).toBe('unresolved');
  });

  it('does not accept identical bytes without a complete binding to the intended listing and role', async () => {
    const source = await productLabel('SKU-A100');
    expect(
      (await compareImageBytes({ source, output: source, binding: { ...binding, itemId: '' } }))
        .state,
    ).toBe('unresolved');
  });
});
