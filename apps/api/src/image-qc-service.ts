import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@shopee/domain';
import { BlobStore, Repository, transaction } from '@shopee/persistence';
import {
  compareImageBytes,
  isImageQcBinding,
  type ImageQcBinding,
  type ImageQcResult,
  type ImageReviewAttestation,
} from '../../../packages/shopee/src/image-qc.js';

const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const uuid = z.string().uuid(),
  sha = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.custom<ImageQcBinding>(isImageQcBinding);
const bytes = z.instanceof(Uint8Array).refine((value) => value.length <= 10 * 1024 * 1024);
const prepareSchema = z
  .object({
    id: uuid,
    binding: bindingSchema,
    source: bytes,
    output: bytes,
    expiresAt: z.string().datetime(),
  })
  .strict();
const reviewSchema = z
  .object({
    id: uuid,
    requestId: uuid,
    expectedFingerprint: sha,
    binding: bindingSchema,
    decision: z.enum(['accept_lossy_match', 'reject']),
    reviewer: z.string().trim().min(1).max(200),
    note: z.string().trim().min(1).max(500),
  })
  .strict();
const checkSchema = z
  .object({ id: uuid, binding: bindingSchema, sourceSha256: sha, outputSha256: sha })
  .strict();
function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('IMAGE_QC_INPUT_INVALID');
  return result.data;
}
export type ImageQcReview = {
  requestId: string;
  decision: 'accept_lossy_match' | 'reject';
  reviewer: string;
  note: string;
  reviewedAt: string;
  attestation?: ImageReviewAttestation;
};
export type ImageQcCase = {
  id: string;
  fingerprint: string;
  binding: ImageQcBinding;
  sourceSha256: string;
  outputSha256: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  comparison: ImageQcResult;
  result: ImageQcResult;
  state: ImageQcResult['state'];
  review?: ImageQcReview;
};
type Queryable = Pick<Repository['pool'], 'query'>;

/** prepare/check accept trusted internal source/readback evidence. No public byte/attestation import. */
export class ImageQcService {
  constructor(
    readonly repo: Repository,
    readonly blobs: BlobStore,
    readonly options: { now?: () => Date } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private view(row: Record<string, any>): ImageQcCase {
    const result = row.review_result ?? row.comparison;
    return structuredClone({
      id: row.id,
      fingerprint: row.fingerprint,
      binding: row.binding,
      sourceSha256: row.source_sha256,
      outputSha256: row.output_sha256,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      expired: new Date(row.expires_at).getTime() <= this.now().getTime(),
      comparison: row.comparison,
      result,
      state: result.state,
      ...(row.review_body ? { review: row.review_body } : {}),
    });
  }
  private async read(id: string, db: Queryable = this.repo.pool): Promise<ImageQcCase> {
    const row = (
      await db.query(
        'SELECT c.*,r.body AS review_body,r.result AS review_result FROM image_qc_cases c LEFT JOIN image_qc_reviews r ON r.case_id=c.id WHERE c.id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('IMAGE_QC_NOT_FOUND');
    return this.view(row);
  }
  async prepare(raw: {
    id: string;
    binding: ImageQcBinding;
    source: Uint8Array;
    output: Uint8Array;
    expiresAt: string;
  }): Promise<ImageQcCase> {
    const input = parse(prepareSchema, raw);
    const source = Buffer.from(input.source),
      output = Buffer.from(input.output),
      binding = structuredClone(input.binding);
    const sourceSha256 = hashBytes(source),
      outputSha256 = hashBytes(output);
    const fingerprint = hash({
      version: 'image-qc-case/v1',
      binding,
      sourceSha256,
      outputSha256,
      expiresAt: input.expiresAt,
    });
    return transaction(this.repo.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['image-qc-case:' + input.id]);
      const existing = (
        await db.query('SELECT fingerprint FROM image_qc_cases WHERE id=$1', [input.id])
      ).rows[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('IMAGE_QC_IDEMPOTENCY_CONFLICT');
        return this.read(input.id, db);
      }
      const now = this.now(),
        duration = Date.parse(input.expiresAt) - now.getTime();
      if (duration <= 0 || duration > 24 * 60 * 60 * 1000)
        throw new Error('IMAGE_QC_EXPIRY_INVALID');
      const comparison = await compareImageBytes({ source, output, binding });
      await Promise.all([this.blobs.put(source), this.blobs.put(output)]);
      await db.query(
        'INSERT INTO image_qc_cases(id,fingerprint,binding,source_sha256,output_sha256,comparison,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          input.id,
          fingerprint,
          binding,
          sourceSha256,
          outputSha256,
          comparison,
          now,
          input.expiresAt,
        ],
      );
      return this.read(input.id, db);
    });
  }
  async get(id: string): Promise<ImageQcCase> {
    return this.read(parse(uuid, id));
  }
  async list(): Promise<ImageQcCase[]> {
    const rows = (
      await this.repo.pool.query(
        'SELECT c.*,r.body AS review_body,r.result AS review_result FROM image_qc_cases c LEFT JOIN image_qc_reviews r ON r.case_id=c.id ORDER BY c.created_at DESC,c.id LIMIT 100',
      )
    ).rows;
    return rows.map((row) => this.view(row));
  }
  private binding(entry: ImageQcCase, binding: ImageQcBinding) {
    if (canonicalJson(entry.binding) !== canonicalJson(binding))
      throw new Error('IMAGE_QC_BINDING_CHANGED');
  }
  async review(raw: {
    id: string;
    requestId: string;
    expectedFingerprint: string;
    binding: ImageQcBinding;
    decision: 'accept_lossy_match' | 'reject';
    reviewer: string;
    note: string;
  }): Promise<ImageQcCase> {
    const input = parse(reviewSchema, raw),
      requestFingerprint = hash(input);
    return transaction(this.repo.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'image-qc-request:' + input.requestId,
      ]);
      const previous = (
        await db.query(
          'SELECT case_id,request_fingerprint FROM image_qc_reviews WHERE request_id=$1',
          [input.requestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_fingerprint !== requestFingerprint)
          throw new Error('IMAGE_QC_IDEMPOTENCY_CONFLICT');
        return this.read(previous.case_id, db);
      }
      await db.query('SELECT id FROM image_qc_cases WHERE id=$1 FOR UPDATE', [input.id]);
      const entry = await this.read(input.id, db);
      this.binding(entry, input.binding);
      if (entry.fingerprint !== input.expectedFingerprint)
        throw new Error('IMAGE_QC_FINGERPRINT_CHANGED');
      if (entry.review) throw new Error('IMAGE_QC_REVIEW_ALREADY_DECIDED');
      if (entry.expired) throw new Error('IMAGE_QC_EXPIRED');
      if (entry.comparison.state !== 'review_required')
        throw new Error('IMAGE_QC_REVIEW_NOT_ALLOWED');
      let source: Buffer, output: Buffer;
      try {
        [source, output] = await Promise.all([
          this.blobs.read(entry.sourceSha256),
          this.blobs.read(entry.outputSha256),
        ]);
      } catch {
        throw new Error('IMAGE_QC_BLOB_CHANGED');
      }
      const current = await compareImageBytes({ source, output, binding: entry.binding });
      if (canonicalJson(current) !== canonicalJson(entry.comparison))
        throw new Error('IMAGE_QC_COMPARISON_CHANGED');
      const reviewedAt = this.now().toISOString();
      if (Date.parse(reviewedAt) >= Date.parse(entry.expiresAt))
        throw new Error('IMAGE_QC_EXPIRED');
      const review: ImageQcReview = {
        requestId: input.requestId,
        decision: input.decision,
        reviewer: input.reviewer,
        note: input.note,
        reviewedAt,
      };
      let result: ImageQcResult;
      if (input.decision === 'accept_lossy_match') {
        review.attestation = {
          version: 'image-review/v1',
          decision: 'accept_lossy_match',
          binding: entry.binding,
          sourceSha256: entry.sourceSha256,
          outputSha256: entry.outputSha256,
          reviewer: input.reviewer,
          note: input.note,
          reviewedAt,
        };
        result = await compareImageBytes({
          source,
          output,
          binding: entry.binding,
          attestation: review.attestation,
        });
        if (result.state !== 'verified' || result.verificationBasis !== 'manual_review')
          throw new Error('IMAGE_QC_REVIEW_NOT_ALLOWED');
      } else result = { ...current, state: 'mismatch', reason: 'operator_rejected' };
      await db.query(
        'INSERT INTO image_qc_reviews(request_id,case_id,request_fingerprint,body,result) VALUES($1,$2,$3,$4,$5)',
        [input.requestId, input.id, requestFingerprint, review, result],
      );
      return this.read(input.id, db);
    });
  }
  async check(raw: {
    id: string;
    binding: ImageQcBinding;
    sourceSha256: string;
    outputSha256: string;
  }): Promise<ImageQcCase> {
    const input = parse(checkSchema, raw),
      entry = await this.read(input.id);
    this.binding(entry, input.binding);
    if (entry.expired) throw new Error('IMAGE_QC_EXPIRED');
    if (entry.sourceSha256 !== input.sourceSha256 || entry.outputSha256 !== input.outputSha256)
      throw new Error('IMAGE_QC_BYTES_CHANGED');
    return entry;
  }
}
