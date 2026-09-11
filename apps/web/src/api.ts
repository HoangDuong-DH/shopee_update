export class RequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}
const requestMessages: Record<string, string> = {
  INPUT_BATCH_REVISION_CONFLICT:
    'Đợt nhập này đã có bản mới hơn. Giữ lựa chọn đang xem và mở bản đã lưu để đối chiếu; không ghi đè tự động.',
  INPUT_BATCH_PRODUCT_KEY_CONFLICT:
    'Một bộ trong đợt đã gắn với đợt nhập khác. Mở bộ đã lưu để kiểm tra thay vì tạo lại.',
  INPUT_BATCH_SOURCE_MISMATCH:
    'Tệp nhận được chưa khớp bản gốc của đợt nhập. Chọn lại đúng thư mục gốc để đối chiếu.',
  INPUT_BATCH_PATH_INVALID:
    'Cấu trúc thư mục chưa hợp lệ. Giữ mỗi bộ listing trong thư mục riêng và nhận lại đúng cấp thư mục.',
  INPUT_BATCH_SELECTION_INVALID:
    'Một lựa chọn Word hoặc ảnh chưa thuộc đúng thư mục listing. Kiểm tra lại bộ đang chọn.',
  INPUT_BATCH_PRICE_INVALID:
    'Bảng giá, trang tính hoặc bộ giá chưa khớp nguồn đã đọc. Chọn lại đúng nguồn giá của đợt.',
  PRODUCT_REVISION_CONFLICT:
    'Thông tin này đã có bản mới hơn. Giữ lại phần đang sửa, mở bản mới nhất để đối chiếu trước khi lưu lại.',
  SOURCE_REVISION_CHANGED: 'Nguồn đã thay đổi. Mở bản mới nhất và đối chiếu lại phần đang chọn.',
  PRODUCT_MEMBERSHIP_LOCKED:
    'Bộ này đã cố định SKU và phân loại. Mở đúng bộ đã lưu để chỉnh nội dung hoặc ảnh; không thể ghép thêm SKU vào bộ.',
  INVALID_INPUT: 'Một số thông tin chưa hợp lệ. Kiểm tra các ô đang nhập và thử lại.',
  EMPTY_FILE: 'Tệp đang trống. Chọn bản tệp có nội dung để nhập lại.',
  UNSUPPORTED_FILE: 'Chọn tệp Excel (.xlsx), Word (.docx) hoặc ảnh PNG, JPG, WEBP.',
  INVALID_FILENAME: 'Tên tệp chưa hợp lệ. Kiểm tra lại tên tệp rồi chọn lại.',
  SOURCE_NOT_FOUND: 'Không tìm thấy nguồn đã chọn. Tải lại danh sách và chọn đúng tệp.',
  NOT_FOUND: 'Không tìm thấy dữ liệu này. Tải lại danh sách để mở bản hiện có.',
  PRODUCTION_READ_ONLY: 'Shop thật hiện chỉ được đọc thông tin. Chưa thể gửi thay đổi lên Shopee.',
  SERVICE_UNAVAILABLE:
    'Ứng dụng chưa xử lý được yêu cầu. Phần đang nhập vẫn ở màn hình này; kiểm tra kết nối và thử lại.',
};
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        'X-App-Client': 'internal-workspace',
        ...(init?.body && typeof init.body === 'string'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new RequestError(
      'Mất kết nối với ứng dụng; chưa xác nhận được kết quả. Giữ phần đang nhập, kiểm tra bản đã lưu trước khi thử lại.',
      'NETWORK_UNAVAILABLE',
    );
  }
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new RequestError(
      'Ứng dụng trả về kết quả chưa đọc được. Kiểm tra bản đã lưu trước khi thử lại.',
      'INVALID_RESPONSE',
      response.status,
    );
  }
  if (!response.ok) {
    const code =
      typeof body?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(body.code)
        ? body.code
        : `HTTP_${response.status}`;
    // Known knowledge errors are already translated by our API; unknown payloads stay out of the UI.
    const knownKnowledge =
      code.startsWith('KNOWLEDGE_') &&
      typeof body.message === 'string' &&
      /[À-ỹ]/u.test(body.message);
    throw new RequestError(
      requestMessages[code] ??
        (knownKnowledge
          ? body.message
          : 'Chưa xử lý được yêu cầu. Giữ phần đang nhập và thử lại; nếu vẫn lỗi, báo người phụ trách ứng dụng.'),
      code,
      response.status,
    );
  }
  return body;
}
export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const money = (value?: string) =>
  value === undefined || value === '' ? 'Chưa có' : BigInt(value).toLocaleString('vi-VN') + ' ₫';
export const date = (value: string) => new Date(value).toLocaleString('vi-VN');
export const media = (id: string) => '/v1/media/' + encodeURIComponent(id);
export type ImportRecord = {
  id: string;
  sha256: string;
  filename: string;
  kind: 'xlsx' | 'docx' | 'image';
  status: string;
  bytes: number;
  createdAt: string;
  message: string;
  body?: unknown;
};
