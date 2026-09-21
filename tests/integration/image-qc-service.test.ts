import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { BlobStore, Pool, Repository, migrate } from '../../packages/persistence/src/index.js';
import { ImageQcService } from '../../apps/api/src/image-qc-service.js';
import { createApp } from '../../apps/api/src/app.js';
import type { ImageQcBinding } from '../../packages/shopee/src/image-qc.js';
import { technicalImage } from '../fixtures/image-qc/technical-images.js';

const database = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '5442')
  throw new Error('Image QC tests require isolated local PostgreSQL 5442');
const schema = 'test_image_qc_' + randomUUID().replaceAll('-', '');
const directory = resolve('.local/acceptance-20260914/image-qc-service', schema);
const admin = new Pool({ connectionString: database.href });
const pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
const repo = new Repository(pool),
  blobs = new BlobStore(directory);
const outbound = vi
  .spyOn(globalThis, 'fetch')
  .mockRejectedValue(new Error('External network forbidden in image QC service acceptance'));
let now = new Date('2026-09-14T07:00:00.000Z');
const service = () => new ImageQcService(repo, blobs, { now: () => now });
let source: Buffer, jpeg: Buffer, app: Awaited<ReturnType<typeof createApp>>;
const headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
const call = (input: any) => app.getHttpAdapter().getInstance().inject(input);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const binding: ImageQcBinding = {
  environment: 'sandbox',
  partnerId: '980000001',
  shopId: '910000001',
  itemId: '970100001',
  operationId: 'qa-image-op',
  role: 'cover',
  position: 0,
  sourceAssetId: 'qa-source',
  outputImageId: 'qa-output',
};
const prepare = (output = jpeg) =>
  service().prepare({
    id: randomUUID(),
    binding: { ...binding },
    source,
    output,
    expiresAt: '2026-09-14T08:00:00.000Z',
  });
const request = (entry: Awaited<ReturnType<ImageQcService['prepare']>>) => ({
  id: entry.id,
  requestId: randomUUID(),
  expectedFingerprint: entry.fingerprint,
  binding: entry.binding,
  decision: 'accept_lossy_match' as const,
  reviewer: 'QA fixture operator',
  note: 'Fixture review explicitly checks the final SKU digit and the complete border.',
});

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await mkdir(directory, { recursive: true });
  source = await technicalImage();
  jpeg = await sharp(source).jpeg({ quality: 85 }).toBuffer();
  app = await createApp(repo, blobs, ['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
});
beforeEach(() => {
  now = new Date('2026-09-14T07:00:00.000Z');
});
afterAll(async () => {
  await app?.close();
  const tables = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'image_qc_%'",
  );
  const evidence: Record<string, unknown> = {
    mode: 'isolated-image-review-service',
    schema,
    externalRequests: outbound.mock.calls.length,
  };
  for (const row of tables.rows)
    evidence[row.tablename] = (await pool.query(`SELECT * FROM ${row.tablename}`)).rows;
  await pool.end();
  if (!/^test_image_qc_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema cleanup');
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  evidence.schemaRemoved = true;
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await writeFile(
    resolve('.local/acceptance-20260914/image-qc-service/latest.json'),
    JSON.stringify({ directory }),
  );
  const calls = outbound.mock.calls.length;
  outbound.mockRestore();
  expect(calls).toBe(0);
});

it('persists exact automatic evidence and immutable original hashes across service reload', async () => {
  const entry = await prepare(source);
  expect(entry.state).toBe('verified');
  const reloaded = await service().get(entry.id);
  expect(reloaded.result.verificationBasis).toBe('exact_bytes');
  expect(reloaded.sourceSha256).toBe(hash(source));
  expect(await blobs.read(reloaded.outputSha256)).toEqual(source);
  expect(reloaded.review).toBeUndefined();
});
it('persists pending lossy comparison and rejects an attestation injected into prepare', async () => {
  const entry = await prepare();
  expect(entry.state).toBe('review_required');
  await expect(
    service().prepare({
      id: randomUUID(),
      binding,
      source,
      output: jpeg,
      expiresAt: '2026-09-14T08:00:00.000Z',
      attestation: { decision: 'accept_lossy_match' },
    } as any),
  ).rejects.toThrow('IMAGE_QC_INPUT_INVALID');
});
it('generates a scoped manual receipt on the server while retaining original pending QC', async () => {
  const entry = await prepare(),
    input = request(entry);
  const result = await service().review(input);
  expect(result.state).toBe('verified');
  expect(result.comparison.state).toBe('review_required');
  expect(result.result.verificationBasis).toBe('manual_review');
  expect(result.review?.attestation).toEqual({
    version: 'image-review/v1',
    decision: 'accept_lossy_match',
    binding,
    sourceSha256: hash(source),
    outputSha256: hash(jpeg),
    reviewer: input.reviewer,
    note: input.note,
    reviewedAt: now.toISOString(),
  });
  expect((await service().get(entry.id)).result).toEqual(result.result);
});
it('records explicit rejection and cannot later upgrade that decided case', async () => {
  const entry = await prepare();
  const result = await service().review({ ...request(entry), decision: 'reject' });
  expect(result.state).toBe('mismatch');
  expect(result.review?.attestation).toBeUndefined();
  await expect(service().review(request(entry))).rejects.toThrow('IMAGE_QC_REVIEW_ALREADY_DECIDED');
});
it('rejects changing either source bytes or output bytes under an existing case ID', async () => {
  const entry = await prepare();
  for (const patch of [{ output: source }, { source: await technicalImage('8') }]) {
    await expect(
      service().prepare({
        id: entry.id,
        binding,
        source,
        output: jpeg,
        expiresAt: entry.expiresAt,
        ...patch,
      }),
    ).rejects.toThrow('IMAGE_QC_IDEMPOTENCY_CONFLICT');
  }
  expect((await service().get(entry.id)).outputSha256).toBe(hash(jpeg));
});
it('rejects a stale fingerprint without recording a review', async () => {
  const entry = await prepare();
  await expect(
    service().review({ ...request(entry), expectedFingerprint: '0'.repeat(64) }),
  ).rejects.toThrow('IMAGE_QC_FINGERPRINT_CHANGED');
  expect((await service().get(entry.id)).review).toBeUndefined();
});
it('rejects a review bound to another shop, item, operation, source or role', async () => {
  const entry = await prepare();
  for (const patch of [
    { shopId: '910000002' },
    { itemId: '970100002' },
    { operationId: 'other' },
    { sourceAssetId: 'other' },
    { role: 'gallery' as const },
  ]) {
    await expect(
      service().review({ ...request(entry), binding: { ...binding, ...patch } }),
    ).rejects.toThrow('IMAGE_QC_BINDING_CHANGED');
  }
});
it('rejects new acceptance of an expired case and expired applicability checks', async () => {
  const entry = await prepare();
  now = new Date('2026-09-14T08:00:00.000Z');
  await expect(service().review(request(entry))).rejects.toThrow('IMAGE_QC_EXPIRED');
  await expect(
    service().check({
      id: entry.id,
      binding,
      sourceSha256: hash(source),
      outputSha256: hash(jpeg),
    }),
  ).rejects.toThrow('IMAGE_QC_EXPIRED');
});
it('replays the same review request idempotently after expiry but rejects changed request content', async () => {
  const entry = await prepare(),
    input = request(entry);
  const first = await service().review(input);
  now = new Date('2026-09-14T09:00:00.000Z');
  const replay = await service().review(input);
  expect(replay.review).toEqual(first.review);
  await expect(service().review({ ...input, note: 'changed' })).rejects.toThrow(
    'IMAGE_QC_IDEMPOTENCY_CONFLICT',
  );
});
it('allows one decision when accept and reject race on the same pending case', async () => {
  const entry = await prepare();
  const results = await Promise.allSettled([
    service().review(request(entry)),
    service().review({ ...request(entry), decision: 'reject' }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(
    (await pool.query('SELECT count(*) FROM image_qc_reviews WHERE case_id=$1', [entry.id])).rows[0]
      .count,
  ).toBe('1');
});
it('cannot use manual approval to override a wrong image or corrupt file', async () => {
  const wrong = await sharp({
    create: { width: 128, height: 128, channels: 3, background: '#ff00ff' },
  })
    .png()
    .toBuffer();
  for (const output of [wrong, Buffer.from('corrupt')]) {
    const entry = await prepare(output);
    expect(entry.state).not.toBe('review_required');
    await expect(service().review(request(entry))).rejects.toThrow('IMAGE_QC_REVIEW_NOT_ALLOWED');
  }
});
it('checks fresh hashes and scope before an approved case can be reused', async () => {
  const entry = await prepare();
  await service().review(request(entry));
  const input = { id: entry.id, binding, sourceSha256: hash(source), outputSha256: hash(jpeg) };
  expect((await service().check(input)).state).toBe('verified');
  await expect(service().check({ ...input, outputSha256: hash(source) })).rejects.toThrow(
    'IMAGE_QC_BYTES_CHANGED',
  );
  await expect(
    service().check({ ...input, binding: { ...binding, outputImageId: 'new-output' } }),
  ).rejects.toThrow('IMAGE_QC_BINDING_CHANGED');
});
it('rejects a review after persisted blob bytes have been tampered with', async () => {
  const uniqueSource = await technicalImage('8'),
    output = await sharp(uniqueSource).jpeg({ quality: 71 }).toBuffer();
  const entry = await service().prepare({
    id: randomUUID(),
    binding,
    source: uniqueSource,
    output,
    expiresAt: '2026-09-14T08:00:00.000Z',
  });
  await writeFile(
    join(directory, 'blobs', entry.outputSha256.slice(0, 2), entry.outputSha256),
    Buffer.from('tampered'),
  );
  await expect(service().review(request(entry))).rejects.toThrow('IMAGE_QC_BLOB_CHANGED');
});
it('rejects mutation of persisted evidence and review records at the database boundary', async () => {
  const entry = await prepare();
  await service().review(request(entry));
  await expect(
    pool.query("UPDATE image_qc_cases SET binding='{}' WHERE id=$1", [entry.id]),
  ).rejects.toThrow('IMAGE_QC_IMMUTABLE');
  await expect(
    pool.query('DELETE FROM image_qc_reviews WHERE case_id=$1', [entry.id]),
  ).rejects.toThrow('IMAGE_QC_IMMUTABLE');
});
it('lists saved summaries without loading binary image contents', async () => {
  const entry = await prepare();
  const list = await service().list();
  expect(list.some((item) => item.id === entry.id && item.state === 'review_required')).toBe(true);
  expect(list.length).toBeLessThanOrEqual(100);
  expect(list.every((item) => !('source' in item) && !('output' in item))).toBe(true);
});
it('rejects reuse of one review request ID for a different case', async () => {
  const first = await prepare(),
    second = await prepare(),
    input = request(first);
  await service().review(input);
  await expect(
    service().review({ ...request(second), requestId: input.requestId }),
  ).rejects.toThrow('IMAGE_QC_IDEMPOTENCY_CONFLICT');
});

it('serves saved cases and exact source/output bytes through the real HTTP endpoints', async () => {
  const entry = await new ImageQcService(repo, blobs).prepare({
    id: randomUUID(),
    binding,
    source,
    output: jpeg,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const list = await call({ method: 'GET', url: '/v1/image-qc', headers });
  expect(list.statusCode).toBe(200);
  expect(
    list.json().some((item: any) => item.id === entry.id && item.state === 'review_required'),
  ).toBe(true);
  const detail = await call({ method: 'GET', url: '/v1/image-qc/' + entry.id, headers });
  expect(detail.statusCode).toBe(200);
  expect(detail.json().fingerprint).toBe(entry.fingerprint);
  for (const [side, original, mime] of [
    ['source', source, 'image/png'],
    ['output', jpeg, 'image/jpeg'],
  ] as const) {
    const response = await call({
      method: 'GET',
      url: `/v1/image-qc/${entry.id}/image/${side}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain(mime);
    expect(hash(response.rawPayload)).toBe(hash(original));
  }
  expect(
    (await call({ method: 'POST', url: '/v1/image-qc', headers, payload: {} })).statusCode,
  ).toBe(404);
});
it('rejects HTTP review proof injection and stale CAS, then saves one explicit ordinary-operator decision', async () => {
  const entry = await new ImageQcService(repo, blobs).prepare({
    id: randomUUID(),
    binding,
    source,
    output: jpeg,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const { id: _id, ...payload } = request(entry);
  const url = '/v1/image-qc/' + entry.id + '/review';
  const injected = await call({
    method: 'POST',
    url,
    headers,
    payload: { ...payload, attestation: { decision: 'accept_lossy_match' } },
  });
  expect(injected.statusCode).toBe(409);
  expect(injected.json().code).toBe('IMAGE_QC_INPUT_INVALID');
  const stale = await call({
    method: 'POST',
    url,
    headers,
    payload: { ...payload, expectedFingerprint: '0'.repeat(64) },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('IMAGE_QC_FINGERPRINT_CHANGED');
  const accepted = await call({ method: 'POST', url, headers, payload });
  expect(accepted.statusCode).toBe(201);
  expect(accepted.json().result.verificationBasis).toBe('manual_review');
  expect(accepted.json().comparison.state).toBe('review_required');
  const replay = await call({ method: 'POST', url, headers, payload });
  expect(replay.json().review).toEqual(accepted.json().review);
});
