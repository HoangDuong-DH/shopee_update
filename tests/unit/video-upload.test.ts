import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  VIDEO_UPLOAD_PART_BYTES,
  VideoUploadTransport,
  prepareVideoUpload,
  runVideoUpload,
  type VideoJournalEntry,
  type VideoUploadJournal,
  type VideoTarget,
} from '../../packages/shopee/src/video-upload.js';

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 1, 2, 3]);
const target = (source: Uint8Array = bytes): VideoTarget => ({
  environment: 'sandbox',
  partnerId: '2010476',
  shopId: '966101536',
  sourceItemId: '123456789',
  sourceSha256: sha256(source),
  expectedMd5: md5(source),
  durationSeconds: 15,
});
const credentials = {
  environment: 'sandbox' as const,
  partnerId: '2010476',
  shopId: '966101536',
  partnerKey: 'fixture-key',
  accessToken: 'fixture-token',
};
const ok = (response?: Record<string, unknown>) =>
  new Response(
    JSON.stringify({ error: '', request_id: 'req-1', ...(response ? { response } : {}) }),
  );
const memoryJournal = () => {
  let row: VideoJournalEntry | null = null;
  const saved: VideoJournalEntry[] = [];
  const journal: VideoUploadJournal = {
    async load() {
      return row ? { ...row } : null;
    },
    async save(key, expected, next) {
      if (next.key !== key || (row?.revision ?? null) !== expected) throw new Error('CAS_CONFLICT');
      row = { ...next };
      saved.push({ ...next });
    },
  };
  return { journal, saved, row: () => row };
};

describe('isolated Shopee video upload adapter', () => {
  it('checks exact bytes and target identity; partitions at 4 MiB with per-part MD5', () => {
    const source = new Uint8Array(VIDEO_UPLOAD_PART_BYTES * 2 + 7);
    source.fill(7);
    source.set([102, 116, 121, 112], 4);
    const plan = prepareVideoUpload(source, target(source));
    expect(plan.parts.map((part) => [part.seq, part.offset, part.length])).toEqual([
      [0, 0, VIDEO_UPLOAD_PART_BYTES],
      [1, VIDEO_UPLOAD_PART_BYTES, VIDEO_UPLOAD_PART_BYTES],
      [2, VIDEO_UPLOAD_PART_BYTES * 2, 7],
    ]);
    expect(plan.parts[2]?.md5).toBe(md5(source.subarray(VIDEO_UPLOAD_PART_BYTES * 2)));
    expect(plan.key).toContain(':966101536:123456789:');
    expect(() =>
      prepareVideoUpload(source, { ...target(source), expectedMd5: md5(bytes) }),
    ).toThrow('VIDEO_SOURCE_HASH_MISMATCH');
    expect(() => prepareVideoUpload(source, { ...target(source), durationSeconds: 61 })).toThrow(
      'VIDEO_SOURCE_INVALID',
    );
    expect(() => prepareVideoUpload(new Uint8Array(30_000_000), target(source))).toThrow(
      'VIDEO_SIZE_INVALID',
    );
  });

  it('uses Shop signature for init/status and Public signature for part/complete', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ video_upload_id: 'upload-1' }))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok({ status: 'TRANSCODING' }));
    const client = new VideoUploadTransport(credentials, fetcher);
    const plan = prepareVideoUpload(bytes, target());
    expect((await client.init(plan)).kind).toBe('success');
    expect((await client.part(plan, bytes, plan.parts[0]!, 'upload-1')).kind).toBe('success');
    expect((await client.complete(plan, 'upload-1', 123)).kind).toBe('success');
    expect((await client.result(plan, 'upload-1')).kind).toBe('success');
    const steps = [
      'init_video_upload',
      'upload_video_part',
      'complete_video_upload',
      'get_video_upload_result',
    ];
    for (let n = 0; n < 4; n++) {
      const [address, init] = fetcher.mock.calls[n]!;
      const url = new URL(String(address));
      const path = '/api/v2/media_space/' + steps[n];
      const shopApi = n === 0 || n === 3;
      const stamp = url.searchParams.get('timestamp')!;
      expect(url.origin).toBe('https://partner.test-stable.shopeemobile.com');
      expect(url.pathname).toBe(path);
      expect(url.searchParams.has('access_token')).toBe(shopApi);
      expect(url.searchParams.has('shop_id')).toBe(shopApi);
      const base =
        credentials.partnerId +
        path +
        stamp +
        (shopApi ? credentials.accessToken + credentials.shopId : '');
      expect(url.searchParams.get('sign')).toBe(
        createHmac('sha256', credentials.partnerKey).update(base).digest('hex'),
      );
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const partForm = fetcher.mock.calls[1]![1]?.body as FormData;
    expect(partForm.get('video_upload_id')).toBe('upload-1');
    expect(partForm.get('part_seq')).toBe('0');
    expect(partForm.get('content_md5')).toBe(md5(bytes));
    expect(new Uint8Array(await (partForm.get('part_content') as Blob).arrayBuffer())).toEqual(
      bytes,
    );
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toEqual({
      video_upload_id: 'upload-1',
      part_seq_list: [0],
      report_data: { upload_cost: 123 },
    });
    expect(fetcher.mock.calls[3]![1]?.method).toBe('GET');
    expect(new URL(String(fetcher.mock.calls[3]![0])).searchParams.get('video_upload_id')).toBe(
      'upload-1',
    );
  });

  it('journals mutation attempts before network and never replays ambiguous init', async () => {
    const plan = prepareVideoUpload(bytes, target());
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('lost response'));
    const client = new VideoUploadTransport(credentials, fetcher);
    const { journal, saved, row } = memoryJournal();
    const first = await runVideoUpload(plan, bytes, client, journal);
    expect(first.kind).toBe('held');
    expect(row()?.phase).toBe('init_pending');
    expect(saved.map((entry) => entry.phase)).toEqual(['planned', 'init_pending', 'init_pending']);
    expect(row()?.lastError).toBe('VIDEO_TRANSPORT_UNKNOWN');
    await runVideoUpload(plan, bytes, client, journal);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('resumes acknowledged parts and completes only after all parts; reads status without mutation replay', async () => {
    const plan = prepareVideoUpload(bytes, target());
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ video_upload_id: 'upload-1' }))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok({ status: 'TRANSCODING' }))
      .mockResolvedValueOnce(
        ok({
          status: 'SUCCEEDED',
          video_info: {
            duration: 15,
            video_url_list: [{ video_url: 'https://example.com/v' }],
            thumbnail_url_list: [{ image_url: 'https://example.com/t' }],
          },
        }),
      );
    const { journal, saved } = memoryJournal();
    const client = new VideoUploadTransport(credentials, fetcher);
    expect((await runVideoUpload(plan, bytes, client, journal)).kind).toBe('processing');
    expect(saved.map((entry) => entry.phase)).toEqual([
      'planned',
      'init_pending',
      'init_ack',
      'part_pending',
      'part_ack',
      'complete_pending',
      'complete_ack',
      'processing',
    ]);
    const second = await runVideoUpload(plan, bytes, client, journal);
    expect(second).toMatchObject({ kind: 'succeeded', uploadId: 'upload-1' });
    expect(fetcher).toHaveBeenCalledTimes(5);
    await runVideoUpload(plan, bytes, client, journal);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('holds ambiguous complete and only reconciles via the Shop result endpoint', async () => {
    const plan = prepareVideoUpload(bytes, target());
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ video_upload_id: 'upload-1' }))
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error('complete response lost'))
      .mockResolvedValueOnce(ok({ status: 'INITIATED' }));
    const { journal, row } = memoryJournal();
    const client = new VideoUploadTransport(credentials, fetcher);
    expect((await runVideoUpload(plan, bytes, client, journal)).kind).toBe('held');
    expect(row()?.phase).toBe('complete_pending');
    const followup = await runVideoUpload(plan, bytes, client, journal);
    expect(followup).toMatchObject({ kind: 'held', reason: 'VIDEO_COMPLETE_AMBIGUOUS' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects cross-shop scope before network', async () => {
    const plan = prepareVideoUpload(bytes, { ...target(), shopId: '978266921' });
    const fetcher = vi.fn<typeof fetch>();
    const client = new VideoUploadTransport(credentials, fetcher);
    await expect(runVideoUpload(plan, bytes, client, memoryJournal().journal)).rejects.toThrow(
      'VIDEO_TARGET_SCOPE_MISMATCH',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
