import { useRef, useState } from 'react';
import { api, RequestError } from './api.js';

type Upload = {
  id: string;
  filename: string;
  file?: File;
  state: 'waiting' | 'uploading' | 'received' | 'failed';
  message?: string;
  code?: string;
};
export function useFileUploads(refresh: () => Promise<void>, blocked = false) {
  const [files, setFiles] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  async function run(batch: Upload[]) {
    if (inFlight.current || blocked || !batch.length) return;
    inFlight.current = true;
    setBusy(true);
    try {
      for (const item of batch) {
        setFiles((all) =>
          all.map((f) =>
            f.id === item.id
              ? { ...f, state: 'uploading', message: undefined, code: undefined }
              : f,
          ),
        );
        try {
          await api('/v1/imports', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-File-Name': encodeURIComponent(item.filename),
            },
            body: item.file,
          });
          setFiles((all) =>
            all.map((f) => (f.id === item.id ? { ...f, file: undefined, state: 'received' } : f)),
          );
        } catch (error) {
          setFiles((all) =>
            all.map((f) =>
              f.id === item.id
                ? {
                    ...f,
                    state: 'failed',
                    message: (error as Error).message,
                    code: error instanceof RequestError ? error.code : undefined,
                  }
                : f,
            ),
          );
        }
      }
      await refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function uploadFiles(chosen: FileList | null) {
    if (!chosen?.length || inFlight.current || blocked) return;
    const batch: Upload[] = Array.from(chosen, (file) => ({
      id: crypto.randomUUID(),
      file,
      filename: file.name,
      state: 'waiting',
    }));
    setFiles((all) => [...all.filter((f) => f.state === 'failed'), ...batch]);
    await run(batch);
  }
  const failed = files.filter((f) => f.state === 'failed');
  const progress = files.length ? (
    <section className="upload-progress panel" aria-label="Tiến độ nhập tệp">
      <div className="section-heading">
        <div>
          <h2>
            {busy ? 'Đang nhận tệp của bạn' : failed.length ? 'Có tệp cần tải lại' : 'Đã nhận tệp'}
          </h2>
          <p role="status">
            {files.filter((f) => f.state === 'received').length}/{files.length} tệp đã nhận. Tệp cần
            đọc thêm sẽ xuất hiện trong danh sách khi xử lý xong.
          </p>
        </div>
        {!busy && !failed.length && <button onClick={() => setFiles([])}>Đóng tiến độ</button>}
      </div>
      <ul>
        {files.map((f) => (
          <li key={f.id} data-testid="upload-file-row">
            <div>
              <strong>{f.filename}</strong>
              {f.message && <p className="error">{f.message}</p>}
              {f.code && (
                <details>
                  <summary>Chi tiết gửi người hỗ trợ</summary>
                  <code>{f.code}</code>
                </details>
              )}
            </div>
            <span className={'tag ' + (f.state === 'failed' ? 'danger' : 'neutral')}>
              {
                {
                  waiting: 'Chờ tải',
                  uploading: 'Đang tải',
                  received: 'Đã nhận',
                  failed: 'Chưa nhận',
                }[f.state]
              }
            </span>
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <button disabled={busy || blocked} onClick={() => void run(failed)}>
          Thử lại {failed.length} tệp chưa nhận
        </button>
      )}
      <p className="caption">
        Giữ trang này mở để tải lại tệp lỗi. Tệp đã nhận không cần chọn lại; việc nhập tệp chưa gán
        ảnh hoặc nội dung vào listing.
      </p>
    </section>
  ) : null;
  return { uploadFiles, busy, progress };
}
