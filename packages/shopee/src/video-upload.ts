import { createHash } from 'node:crypto';
import { signRequest } from './sign.js';

export const VIDEO_UPLOAD_PART_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 30_000_000; // Conservative interpretation of documented 30 MB.
const hosts = {
  production: 'https://partner.shopeemobile.com',
  sandbox: 'https://partner.test-stable.shopeemobile.com',
} as const;
const paths = {
  init: '/api/v2/media_space/init_video_upload',
  part: '/api/v2/media_space/upload_video_part',
  complete: '/api/v2/media_space/complete_video_upload',
  result: '/api/v2/media_space/get_video_upload_result',
} as const;
type Environment = keyof typeof hosts;
type Step = keyof typeof paths;
export type VideoTarget = {
  environment: Environment;
  partnerId: string;
  shopId: string;
  sourceItemId: string;
  sourceSha256: string;
  expectedMd5: string;
  durationSeconds: number;
};
export type VideoCredentials = Pick<VideoTarget, 'environment' | 'partnerId' | 'shopId'> & {
  partnerKey: string;
  accessToken: string;
};
export type VideoPart = { seq: number; offset: number; length: number; md5: string };
export type VideoPlan = {
  key: string;
  target: VideoTarget;
  fileSize: number;
  fileMd5: string;
  parts: VideoPart[];
};
export type VideoWireResult =
  | { kind: 'success'; requestId: string; value?: Record<string, unknown> }
  | { kind: 'rejected' | 'unknown'; code: string; requestId?: string };
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(x);
const numericId = (x: string) => /^[1-9]\d{0,15}$/.test(x) && Number.isSafeInteger(Number(x));
const hash = (algorithm: 'md5' | 'sha256', bytes: Uint8Array) =>
  createHash(algorithm).update(bytes).digest('hex');

/** Caller supplies actual local MP4 bytes and independently recorded hashes/duration. */
export function prepareVideoUpload(bytes: Uint8Array, target: VideoTarget): VideoPlan {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 12 ||
    bytes.length >= MAX_FILE_BYTES ||
    String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp'
  )
    throw new Error('VIDEO_SIZE_INVALID');
  if (
    !Object.hasOwn(hosts, target.environment) ||
    !numericId(target.partnerId) ||
    !numericId(target.shopId) ||
    !numericId(target.sourceItemId) ||
    !/^[a-f0-9]{64}$/i.test(target.sourceSha256) ||
    !/^[a-f0-9]{32}$/i.test(target.expectedMd5) ||
    !Number.isFinite(target.durationSeconds) ||
    target.durationSeconds < 10 ||
    target.durationSeconds > 60
  )
    throw new Error('VIDEO_SOURCE_INVALID');
  const sha256 = hash('sha256', bytes);
  const md5 = hash('md5', bytes);
  if (sha256 !== target.sourceSha256.toLowerCase() || md5 !== target.expectedMd5.toLowerCase())
    throw new Error('VIDEO_SOURCE_HASH_MISMATCH');
  const parts: VideoPart[] = [];
  for (let offset = 0, seq = 0; offset < bytes.length; offset += VIDEO_UPLOAD_PART_BYTES, seq++) {
    const length = Math.min(VIDEO_UPLOAD_PART_BYTES, bytes.length - offset);
    parts.push({ seq, offset, length, md5: hash('md5', bytes.subarray(offset, offset + length)) });
  }
  return {
    key: [target.environment, target.partnerId, target.shopId, target.sourceItemId, sha256].join(
      ':',
    ),
    target: { ...target, sourceSha256: sha256, expectedMd5: md5 },
    fileSize: bytes.length,
    fileMd5: md5,
    parts,
  };
}

/** Inject fetch explicitly. This class is not wired to any worker or production route. */
export class VideoUploadTransport {
  constructor(
    private readonly credentials: VideoCredentials,
    private readonly fetcher: typeof fetch,
  ) {
    if (
      !Object.hasOwn(hosts, credentials.environment) ||
      !numericId(credentials.partnerId) ||
      !numericId(credentials.shopId) ||
      !credentials.partnerKey ||
      !credentials.accessToken
    )
      throw new Error('VIDEO_CREDENTIAL_SCOPE_INVALID');
  }
  assertScope(plan: VideoPlan) {
    if (
      plan.target.environment !== this.credentials.environment ||
      plan.target.partnerId !== this.credentials.partnerId ||
      plan.target.shopId !== this.credentials.shopId
    )
      throw new Error('VIDEO_TARGET_SCOPE_MISMATCH');
  }
  init(plan: VideoPlan) {
    this.assertScope(plan);
    return this.call('init', { file_md5: plan.fileMd5, file_size: plan.fileSize });
  }
  part(plan: VideoPlan, bytes: Uint8Array, part: VideoPart, uploadId: string) {
    this.assertScope(plan);
    if (
      !id(uploadId) ||
      bytes.length !== plan.fileSize ||
      hash('sha256', bytes) !== plan.target.sourceSha256 ||
      plan.parts[part.seq]?.md5 !== part.md5 ||
      hash('md5', bytes.subarray(part.offset, part.offset + part.length)) !== part.md5
    )
      throw new Error('VIDEO_PART_SOURCE_MISMATCH');
    const form = new FormData();
    form.set('video_upload_id', uploadId);
    form.set('part_seq', String(part.seq));
    form.set('content_md5', part.md5);
    form.set(
      'part_content',
      new Blob([new Uint8Array(bytes.subarray(part.offset, part.offset + part.length))], {
        type: 'application/octet-stream',
      }),
      'part-' + part.seq + '.bin',
    );
    return this.call('part', form);
  }
  complete(plan: VideoPlan, uploadId: string, uploadCostMs: number) {
    this.assertScope(plan);
    if (!id(uploadId) || !Number.isSafeInteger(uploadCostMs) || uploadCostMs < 0)
      throw new Error('VIDEO_COMPLETE_INPUT_INVALID');
    return this.call('complete', {
      video_upload_id: uploadId,
      part_seq_list: plan.parts.map((part) => part.seq),
      report_data: { upload_cost: uploadCostMs },
    });
  }
  result(plan: VideoPlan, uploadId: string) {
    this.assertScope(plan);
    if (!id(uploadId)) throw new Error('VIDEO_UPLOAD_ID_INVALID');
    return this.call('result', undefined, uploadId);
  }
  private async call(
    step: Step,
    body?: Record<string, unknown> | FormData,
    uploadId?: string,
  ): Promise<VideoWireResult> {
    const path = paths[step];
    const { environment, partnerId, shopId, partnerKey, accessToken } = this.credentials;
    const timestamp = Math.floor(Date.now() / 1000);
    const shopApi = step === 'init' || step === 'result';
    const url = new URL(path, hosts[environment]);
    url.searchParams.set('partner_id', partnerId);
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set(
      'sign',
      signRequest({
        partnerId,
        partnerKey,
        path,
        timestamp,
        ...(shopApi ? { shopId, accessToken } : {}),
      }),
    );
    if (shopApi) {
      url.searchParams.set('shop_id', shopId);
      url.searchParams.set('access_token', accessToken);
    }
    if (uploadId) url.searchParams.set('video_upload_id', uploadId);
    try {
      const response = await this.fetcher(url, {
        method: step === 'result' ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: 'application/json',
          ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      if (text.length > 1_000_000) return { kind: 'unknown', code: 'VIDEO_RESPONSE_TOO_LARGE' };
      const raw: unknown = JSON.parse(text);
      if (!object(raw) || typeof raw.error !== 'string')
        return { kind: 'unknown', code: 'VIDEO_RESPONSE_INVALID' };
      const requestId = id(raw.request_id) ? raw.request_id : undefined;
      if (raw.error)
        return {
          kind:
            response.status >= 500 ||
            /(?:error_network|error_server|error_rate_limit)$/.test(raw.error)
              ? 'unknown'
              : 'rejected',
          code: /^[A-Za-z0-9_.-]{1,100}$/.test(raw.error) ? raw.error : 'VIDEO_API_ERROR',
          ...(requestId ? { requestId } : {}),
        };
      if (!response.ok || !requestId) return { kind: 'unknown', code: 'VIDEO_RESPONSE_INVALID' };
      if (step === 'init' && (!object(raw.response) || !id(raw.response.video_upload_id)))
        return { kind: 'unknown', code: 'VIDEO_INIT_ID_MISSING', requestId };
      if (
        step === 'result' &&
        (!object(raw.response) ||
          !['INITIATED', 'TRANSCODING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(
            String(raw.response.status),
          ))
      )
        return { kind: 'unknown', code: 'VIDEO_STATUS_INVALID', requestId };
      return {
        kind: 'success',
        requestId,
        ...(object(raw.response) ? { value: raw.response } : {}),
      };
    } catch {
      return { kind: 'unknown', code: 'VIDEO_TRANSPORT_UNKNOWN' };
    }
  }
}

export type VideoJournalPhase =
  | 'planned'
  | 'init_pending'
  | 'init_ack'
  | 'part_pending'
  | 'part_ack'
  | 'complete_pending'
  | 'complete_ack'
  | 'processing'
  | 'succeeded'
  | 'failed';
export type VideoJournalEntry = {
  key: string;
  revision: number;
  phase: VideoJournalPhase;
  uploadId?: string;
  nextPart: number;
  uploadStartedAt?: number;
  lastRequestId?: string;
  lastError?: string;
  videoInfo?: Record<string, unknown>;
};
/** save must be an atomic compare-and-swap, durable before resolving, with one writer per key. */
export interface VideoUploadJournal {
  load(key: string): Promise<VideoJournalEntry | null>;
  save(key: string, expectedRevision: number | null, next: VideoJournalEntry): Promise<void>;
}
export type VideoRunOutcome =
  | { kind: 'succeeded'; uploadId: string; videoInfo: Record<string, unknown> }
  | { kind: 'processing'; uploadId: string; status: string }
  | { kind: 'held'; reason: string; entry: VideoJournalEntry };

/** Mutation attempt recorded before request. Ambiguous mutations are held, never retried. */
export async function runVideoUpload(
  plan: VideoPlan,
  bytes: Uint8Array,
  client: VideoUploadTransport,
  journal: VideoUploadJournal,
  options: { now?: () => number; maxStatusReads?: number } = {},
): Promise<VideoRunOutcome> {
  client.assertScope(plan);
  if (JSON.stringify(prepareVideoUpload(bytes, plan.target)) !== JSON.stringify(plan))
    throw new Error('VIDEO_SOURCE_CHANGED');
  const now = options.now ?? Date.now;
  const maxStatusReads = options.maxStatusReads ?? 1;
  if (!Number.isSafeInteger(maxStatusReads) || maxStatusReads < 1 || maxStatusReads > 5)
    throw new Error('VIDEO_POLL_LIMIT_INVALID');
  let entry = await journal.load(plan.key);
  const save = async (patch: Partial<VideoJournalEntry>) => {
    const next = { ...entry!, ...patch, revision: entry!.revision + 1 };
    await journal.save(plan.key, entry!.revision, next);
    entry = next;
  };
  if (!entry) {
    entry = { key: plan.key, revision: 0, phase: 'planned', nextPart: 0 };
    await journal.save(plan.key, null, entry);
  }
  if (
    entry.key !== plan.key ||
    !Number.isSafeInteger(entry.revision) ||
    !Number.isSafeInteger(entry.nextPart) ||
    entry.nextPart < 0 ||
    entry.nextPart > plan.parts.length
  )
    throw new Error('VIDEO_JOURNAL_CORRUPT');
  if (entry.phase === 'succeeded') {
    if (!entry.uploadId || !entry.videoInfo) throw new Error('VIDEO_JOURNAL_CORRUPT');
    return { kind: 'succeeded', uploadId: entry.uploadId, videoInfo: entry.videoInfo };
  }
  if (entry.phase === 'failed' || entry.phase === 'init_pending' || entry.phase === 'part_pending')
    return { kind: 'held', reason: 'VIDEO_' + entry.phase.toUpperCase(), entry };
  if (entry.phase === 'planned') {
    await save({ phase: 'init_pending' });
    const response = await client.init(plan);
    if (response.kind !== 'success' || !id(response.value?.video_upload_id)) {
      const reason = response.kind === 'success' ? 'VIDEO_INIT_ID_MISSING' : response.code;
      await save({
        lastError: reason,
        ...(response.requestId ? { lastRequestId: response.requestId } : {}),
      });
      return { kind: 'held', reason, entry: entry! };
    }
    await save({
      phase: 'init_ack',
      uploadId: response.value.video_upload_id,
      lastRequestId: response.requestId,
    });
  }
  if (!entry.uploadId) throw new Error('VIDEO_JOURNAL_CORRUPT');
  if (entry.phase === 'init_ack' || entry.phase === 'part_ack') {
    while (entry.nextPart < plan.parts.length) {
      const part = plan.parts[entry.nextPart]!;
      await save({
        phase: 'part_pending',
        ...(entry.uploadStartedAt === undefined ? { uploadStartedAt: now() } : {}),
      });
      const response = await client.part(plan, bytes, part, entry.uploadId!);
      if (response.kind !== 'success') {
        await save({
          lastError: response.code,
          ...(response.requestId ? { lastRequestId: response.requestId } : {}),
        });
        return { kind: 'held', reason: response.code, entry: entry! };
      }
      await save({ phase: 'part_ack', nextPart: part.seq + 1, lastRequestId: response.requestId });
    }
    await save({ phase: 'complete_pending' });
    const response = await client.complete(
      plan,
      entry.uploadId,
      Math.max(0, Math.floor(now() - (entry.uploadStartedAt ?? now()))),
    );
    if (response.kind !== 'success') {
      await save({
        lastError: response.code,
        ...(response.requestId ? { lastRequestId: response.requestId } : {}),
      });
      return { kind: 'held', reason: response.code, entry: entry! };
    }
    await save({ phase: 'complete_ack', lastRequestId: response.requestId });
  }
  if (!['complete_pending', 'complete_ack', 'processing'].includes(entry.phase))
    throw new Error('VIDEO_JOURNAL_CORRUPT');
  for (let attempt = 0; attempt < maxStatusReads; attempt++) {
    const response = await client.result(plan, entry.uploadId);
    if (response.kind !== 'success' || !response.value)
      return {
        kind: 'held',
        reason: response.kind === 'success' ? 'VIDEO_STATUS_MISSING' : response.code,
        entry,
      };
    const status = response.value.status;
    if (status === 'SUCCEEDED') {
      const info = response.value.video_info;
      if (
        !object(info) ||
        !Number.isFinite(info.duration) ||
        !Array.isArray(info.video_url_list) ||
        info.video_url_list.length === 0 ||
        !Array.isArray(info.thumbnail_url_list) ||
        info.thumbnail_url_list.length === 0
      )
        return { kind: 'held', reason: 'VIDEO_RESULT_INFO_INVALID', entry };
      await save({ phase: 'succeeded', videoInfo: info, lastRequestId: response.requestId });
      return { kind: 'succeeded', uploadId: entry.uploadId, videoInfo: info };
    }
    if (status === 'FAILED' || status === 'CANCELLED') {
      await save({ phase: 'failed', lastError: String(status), lastRequestId: response.requestId });
      return { kind: 'held', reason: 'VIDEO_' + status, entry };
    }
    if (entry.phase === 'complete_pending' && status === 'INITIATED')
      return { kind: 'held', reason: 'VIDEO_COMPLETE_AMBIGUOUS', entry };
    await save({ phase: 'processing', lastRequestId: response.requestId });
    if (attempt === maxStatusReads - 1)
      return { kind: 'processing', uploadId: entry.uploadId, status: String(status) };
  }
  throw new Error('VIDEO_UNREACHABLE');
}
