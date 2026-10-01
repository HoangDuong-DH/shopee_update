import { RequestError } from './api.js';

/** Read-only export; bound both headers and body, and never download an error response as Excel. */
export async function downloadWorkbook(path: string, signal?: AbortSignal, timeoutMs = 60_000): Promise<Blob> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const timer = setTimeout(() => controller.abort(new RequestError('Xuất báo cáo quá thời gian chờ. Thử tải lại; dữ liệu công việc vẫn giữ nguyên.', 'REPORT_TIMEOUT')), timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    return await Promise.race([interrupted, (async () => {
      controller.signal.throwIfAborted();
      const response = await fetch(path, { signal: controller.signal, headers: { 'X-App-Client': 'internal-workspace' } });
      if (!response.ok) throw new RequestError('Chưa lấy được báo cáo của đợt này. Đọc lại trạng thái rồi xuất lại.', 'REPORT_UNAVAILABLE', response.status);
      if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
        throw new RequestError('Ứng dụng chưa trả về tệp Excel hợp lệ. Chưa tải tệp; thử xuất lại báo cáo.', 'REPORT_INVALID_RESPONSE');
      const blob = await response.blob();
      if (!blob.size) throw new RequestError('Báo cáo trả về trống. Thử xuất lại báo cáo.', 'REPORT_EMPTY');
      return blob;
    })()]);
  } catch (error) {
    controller.signal.throwIfAborted();
    if (error instanceof RequestError) throw error;
    throw new RequestError('Mất kết nối khi tải báo cáo. Thử tải lại; chưa thay đổi công việc.', 'REPORT_NETWORK_UNAVAILABLE');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
  }
}
