import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  compareImageBytes,
  compareImageRoleSet,
  fetchObservedShopeeImage,
  type ImageQcBinding,
  type ImageReviewAttestation,
} from '../../packages/shopee/src/image-qc.js';
import { technicalImage } from '../fixtures/image-qc/technical-images.js';

const binding: ImageQcBinding = {
  environment: 'sandbox',
  partnerId: '980000001',
  shopId: '910000001',
  itemId: '970100001',
  operationId: 'qa-op-1',
  role: 'cover',
  position: 0,
  sourceAssetId: 'qa-source-cover',
  outputImageId: 'qa-returned-cover',
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const review = (source: Uint8Array, output: Uint8Array): ImageReviewAttestation => ({
  version: 'image-review/v1',
  decision: 'accept_lossy_match',
  binding: { ...binding },
  sourceSha256: digest(source),
  outputSha256: digest(output),
  reviewer: 'QA operator',
  reviewedAt: '2026-09-14T07:00:00.000Z',
  note: 'Side by side check of full card including the final SKU digit.',
});

describe('image byte comparison', () => {
  it('verifies valid identical bytes with both hashes and a role-bound receipt', async () => {
    const source = await technicalImage();
    const result = await compareImageBytes({ source, output: Buffer.from(source), binding });
    expect(result.state).toBe('verified');
    expect(result.reason).toBe('exact_bytes');
    expect(result.evidence?.source.sha256).toBe(digest(source));
    expect(result.evidence?.binding).toEqual(binding);
  });
  it('verifies lossless reencoding by decoded pixels even when IDs and byte hashes change', async () => {
    const source = await technicalImage();
    const output = await sharp(source).png({ compressionLevel: 0 }).toBuffer();
    expect(digest(output)).not.toBe(digest(source));
    const result = await compareImageBytes({ source, output, binding });
    expect(result.state).toBe('verified');
    expect(result.reason).toBe('exact_decoded_pixels');
  });
  it('requires review for lossy JPEG without calling a metric an accuracy probability', async () => {
    const source = await technicalImage();
    const output = await sharp(source).jpeg({ quality: 85 }).toBuffer();
    const result = await compareImageBytes({ source, output, binding });
    expect(result.state).toBe('review_required');
    expect(result.metrics?.changedPixelFraction).toBeGreaterThan(0);
    expect(result.metrics).not.toHaveProperty('accuracy');
  });
  it('never auto-accepts a tiny critical SKU digit change on otherwise identical pixels', async () => {
    const source = await technicalImage('0'),
      output = await technicalImage('8');
    const result = await compareImageBytes({ source, output, binding });
    expect(result.state).toBe('review_required');
    expect(result.metrics?.changedPixelFraction).toBeLessThan(0.001);
  });
  it('rejects an unrelated image even if an operator attestation is supplied', async () => {
    const source = await technicalImage();
    const output = await sharp({
      create: { width: 128, height: 128, channels: 3, background: '#ff00ff' },
    })
      .png()
      .toBuffer();
    expect(
      (await compareImageBytes({ source, output, binding, attestation: review(source, output) }))
        .state,
    ).toBe('mismatch');
  });
  it('rejects an aspect-changing crop and padding without silently resizing it to match', async () => {
    const source = await technicalImage();
    for (const output of [
      await sharp(source).extract({ left: 0, top: 0, width: 128, height: 110 }).png().toBuffer(),
      await sharp(source).extend({ bottom: 10, top: 10, background: 'white' }).png().toBuffer(),
    ])
      expect((await compareImageBytes({ source, output, binding })).state).toBe('mismatch');
  });
  it('keeps same-aspect resize a review candidate and never accepts invalid bytes even when identical', async () => {
    const source = await technicalImage();
    const output = await sharp(source).resize(64, 64).png().toBuffer();
    expect((await compareImageBytes({ source, output, binding })).state).toBe('review_required');
    expect(
      (await compareImageBytes({ source: Buffer.from('bad'), output: Buffer.from('bad'), binding }))
        .state,
    ).toBe('unresolved');
    expect((await compareImageBytes({ source, output: Buffer.alloc(0), binding })).state).toBe(
      'unresolved',
    );
  });
  it('accepts a lossy candidate only with explicit versioned full binding and hashes', async () => {
    const source = await technicalImage(),
      output = await sharp(source).jpeg({ quality: 85 }).toBuffer();
    const attestation = review(source, output);
    const result = await compareImageBytes({ source, output, binding, attestation });
    expect(result.state).toBe('verified');
    expect(result.reason).toBe('review_attested');
    expect(result.attestation).toEqual(attestation);
  });
  it.each([
    'shopId',
    'itemId',
    'operationId',
    'role',
    'position',
    'sourceAssetId',
    'outputImageId',
  ] as const)('rejects a review replayed against a different %s', async (field) => {
    const source = await technicalImage(),
      output = await sharp(source).jpeg({ quality: 85 }).toBuffer();
    const attestation = review(source, output);
    Object.assign(attestation.binding, { [field]: field === 'position' ? 1 : 'other' });
    expect((await compareImageBytes({ source, output, binding, attestation })).state).toBe(
      'review_required',
    );
  });
  it('rejects stale hashes, incomplete review, unknown review version and missing binding', async () => {
    const source = await technicalImage(),
      output = await sharp(source).jpeg({ quality: 85 }).toBuffer();
    for (const patch of [
      { sourceSha256: '0'.repeat(64) },
      { outputSha256: '0'.repeat(64) },
      { reviewer: '' },
      { note: '' },
      { version: 'image-review/v0' },
      { reviewedAt: 'bad' },
    ]) {
      const attestation = { ...review(source, output), ...patch } as ImageReviewAttestation;
      expect((await compareImageBytes({ source, output, binding, attestation })).state).toBe(
        'review_required',
      );
    }
    expect(
      (
        await compareImageBytes({
          source,
          output: source,
          binding: { ...binding, operationId: '' },
        })
      ).state,
    ).toBe('unresolved');
  });
});

it('checks complete ordered roles, detecting missing, duplicate and reordered gallery entries', async () => {
  const first = await technicalImage('0'),
    second = await technicalImage('8');
  const firstBinding: ImageQcBinding = { ...binding, role: 'gallery', position: 0 };
  const secondBinding: ImageQcBinding = {
    ...binding,
    role: 'gallery',
    position: 1,
    sourceAssetId: 'second-source',
    outputImageId: 'second-output',
  };
  const expected = [
    { binding: firstBinding, source: first },
    { binding: secondBinding, source: second },
  ];
  const observed = [
    { binding: firstBinding, output: first },
    { binding: secondBinding, output: second },
  ];
  expect((await compareImageRoleSet({ expected, observed })).state).toBe('verified');
  expect((await compareImageRoleSet({ expected, observed: observed.slice(0, 1) })).state).toBe(
    'mismatch',
  );
  expect((await compareImageRoleSet({ expected, observed: [...observed].reverse() })).state).toBe(
    'mismatch',
  );
  expect(
    (await compareImageRoleSet({ expected, observed: [observed[0]!, observed[0]!] })).state,
  ).toBe('mismatch');
  expect(
    (
      await compareImageRoleSet({
        expected,
        observed: [
          { ...observed[0]!, output: second },
          { ...observed[1]!, output: first },
        ],
      })
    ).state,
  ).not.toBe('verified');
  expect((await compareImageRoleSet({ expected: [], observed: [] })).state).toBe('unresolved');
});

describe('bounded API-observed image fetch', () => {
  const url = 'https://cf.shopee.vn/file/qa-image';
  it('fetches an exact observed URL once with no credentials and no redirects', async () => {
    const source = await technicalImage();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      expect(init?.headers).toEqual({ Accept: 'image/png,image/jpeg,image/webp' });
      return new Response(new Uint8Array(source), { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof globalThis.fetch;
    const result = await fetchObservedShopeeImage({ url, observedUrls: [url], fetch });
    expect(result.state).toBe('fetched');
    if (result.state === 'fetched') expect(digest(result.bytes)).toBe(digest(source));
  });
  it.each([
    'http://cf.shopee.vn/file/qa',
    'https://cf.shopee.vn.evil.test/file/qa',
    'https://127.0.0.1/qa',
    'https://user:password@cf.shopee.vn/qa',
    'https://cf.shopee.vn:444/qa',
    'https://cf.shopee.vn/qa#fragment',
  ])('blocks unsafe observed URL %s before dispatch', async (unsafe) => {
    const fetch = vi.fn(() => {
      throw new Error('must not be called');
    });
    const result = await fetchObservedShopeeImage({ url: unsafe, observedUrls: [unsafe], fetch });
    expect(result.state).toBe('unresolved');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a safe host URL absent from API evidence before dispatch', async () => {
    const fetch = vi.fn(() => {
      throw new Error('must not be called');
    });
    expect((await fetchObservedShopeeImage({ url, observedUrls: [], fetch })).state).toBe(
      'unresolved',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects redirects, nonimage content and byte overflow regardless of declared size', async () => {
    for (const response of [
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1' } }),
      new Response('html', { headers: { 'content-type': 'text/html' } }),
      new Response(Buffer.alloc(65), {
        headers: { 'content-type': 'image/png', 'content-length': '1' },
      }),
      new Response('a', { headers: { 'content-type': 'image/png', 'content-length': '65' } }),
    ])
      expect(
        (
          await fetchObservedShopeeImage({
            url,
            observedUrls: [url],
            maxBytes: 64,
            fetch: async () => response,
          })
        ).state,
      ).toBe('unresolved');
  });
  it('terminates a stalled body within a bounded deadline without retrying', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(new ReadableStream({ start() {} }), {
          headers: { 'content-type': 'image/png' },
        }),
    );
    const result = await fetchObservedShopeeImage({
      url,
      observedUrls: [url],
      timeoutMs: 20,
      fetch,
    });
    expect(result.state).toBe('unresolved');
    expect(result.reason).toBe('image_fetch_timeout');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
