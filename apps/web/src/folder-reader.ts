import { api, type ImportRecord } from './api.js';
import type { UploadedFolderFile } from './folder-source.js';
import { folderManifestSchema } from '../../../packages/domain/src/folder-manifest.js';
import { readPendingListingMapping } from './pending-listing-mapping.js';

export type FolderReadProgress = { completed: number; total: number; filename?: string };
type ReaderOptions = {
  request?: (path: string, init?: RequestInit) => Promise<ImportRecord>;
  known?: () => ImportRecord[];
  concurrency?: number;
  maxPolls?: number;
  pause?: () => Promise<void>;
};

// This queue only uploads source bytes to our local app; it never writes a listing or calls Shopee.
export function createFolderReader(options: ReaderOptions = {}) {
  const request = options.request ?? ((path, init) => api<ImportRecord>(path, init));
  const received = new Map<string, ImportRecord>();
  const pending = new Map<string, Promise<ImportRecord>>();
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 500)));
  async function receive(file: File, sha: string): Promise<ImportRecord> {
    const expectedKind = /\.docx$/i.test(file.name)
      ? 'docx'
      : /\.xlsx$/i.test(file.name)
        ? 'xlsx'
        : 'image';
    function validate(record: ImportRecord, id?: string) {
      if (
        !record.id ||
        (id && record.id !== id) ||
        record.sha256 !== sha ||
        record.bytes !== file.size ||
        record.kind !== expectedKind
      )
        throw new Error(
          'Kết quả nhận tệp chưa khớp tệp gốc. Chưa dùng tệp này; thử đọc lại hoặc báo người hỗ trợ.',
        );
      return record;
    }
    const sameRequest = pending.get(sha);
    if (sameRequest) return validate(await sameRequest);
    const task = (async () => {
      let record = received.get(sha) ?? options.known?.().find((r) => r.sha256 === sha);
      if (!record) {
        record = validate(
          await request('/v1/imports', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-File-Name': encodeURIComponent(file.name),
            },
            body: file,
          }),
        );
        received.set(sha, record);
      }
      validate(record);
      for (let attempt = 0; attempt < (options.maxPolls ?? 120); attempt++) {
        if ((record.status === 'ready' && record.body != null) || record.status === 'failed') break;
        if (attempt > 0) await pause();
        record = validate(await request('/v1/imports/' + encodeURIComponent(record.id)), record.id);
        received.set(sha, record);
      }
      return record;
    })();
    pending.set(sha, task);
    try {
      return await task;
    } finally {
      pending.delete(sha);
    }
  }
  return async function readFolders(
    files: File[],
    onProgress?: (progress: FolderReadProgress) => void,
  ): Promise<UploadedFolderFile[]> {
    const output: UploadedFolderFile[] = new Array(files.length);
    let next = 0,
      completed = 0;
    onProgress?.({ completed, total: files.length });
    async function worker() {
      while (next < files.length) {
        const index = next++,
          file = files[index];
        const relativePath = file.webkitRelativePath || file.name;
        let sha: string | undefined;
        try {
          const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
          sha = Array.from(new Uint8Array(digest), (value) =>
            value.toString(16).padStart(2, '0'),
          ).join('');
          if (file.name === 'listing-mapping.pending.json') {
            if (file.size > 5_000_000) throw new Error('Hồ sơ phân loại vượt 5 MB.');
            const pendingMapping = readPendingListingMapping(
              new TextDecoder('utf-8', { fatal: true })
                .decode(await file.arrayBuffer())
                .replace(/^\uFEFF/, ''),
              { relativePath, sha256: sha },
            );
            output[index] = { relativePath, sha256: sha, record: null, pendingMapping };
            continue;
          }
          if (file.name === 'listing-source.json') {
            if (file.size > 2 * 1024 * 1024) throw new Error('Hồ sơ phân loại vượt 2 MB.');
            const manifest = folderManifestSchema.safeParse(
              JSON.parse(
                new TextDecoder('utf-8', { fatal: true })
                  .decode(await file.arrayBuffer())
                  .replace(/^\uFEFF/, ''),
              ),
            );
            if (!manifest.success)
              throw new Error(
                'Hồ sơ listing-source.json chưa hợp lệ. Giữ tệp gốc và kiểm tra cấu trúc phân loại, đường dẫn ảnh.',
              );
            output[index] = { relativePath, sha256: sha, record: null, manifest: manifest.data };
            continue;
          }
          if (!/\.(docx|xlsx|png|jpe?g|webp)$/i.test(file.name))
            throw new Error('Loại tệp này chưa hỗ trợ. Giữ trong thư mục gốc để đối chiếu.');
          const record = await receive(file, sha);
          output[index] = { relativePath, sha256: sha, record };
        } catch (error) {
          output[index] = {
            relativePath,
            sha256: sha,
            record: null,
            error: error instanceof Error ? error.message : 'Chưa nhận được tệp này. Thử đọc lại.',
          };
        } finally {
          completed++;
          onProgress?.({ completed, total: files.length, filename: relativePath });
        }
      }
    }
    const concurrency = Math.min(4, Math.max(1, Math.floor(options.concurrency ?? 3)));
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
    return output;
  };
}
