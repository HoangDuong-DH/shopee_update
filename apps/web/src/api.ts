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
  SANDBOX_PARTNER_KEY_REQUIRED:
    'Kết nối này chưa lưu Partner Key. Mở phần khóa TEST và nhập key của đúng ứng dụng.',
  SANDBOX_SAVED_CREDENTIAL_INVALID:
    'Khóa đã lưu chưa đọc được. Nhập lại khóa TEST trong phần cấu hình kết nối.',
  WORK_ORDER_ACTIVE_RUN:
    'Link này còn một lần gửi chưa rõ kết quả. Mở lần thực hiện đã lưu và đọc đối chiếu trước khi thay đổi công việc.',
  WORK_ORDER_REVISION_CONFLICT:
    'Công việc đã có bản mới hơn. Giữ lựa chọn đang sửa và mở lại bản đã lưu để đối chiếu.',
  WORK_ORDER_SOURCE_IDENTITY:
    'Công việc này đã gắn với một bộ nguồn. Tạo công việc riêng khi dùng bộ khác.',
  WORK_ORDER_TARGET_EXISTS:
    'Đã có công việc cho bộ nguồn hoặc link này tại shop đã chọn. Mở công việc hiện có để tiếp tục.',
  WORK_ORDER_STOCK_SOURCE:
    'Có mức tồn gắn với SKU không thuộc bộ nguồn. Kiểm tra danh sách SKU trước khi lưu.',
  WORK_ORDER_NOT_FOUND: 'Không tìm thấy công việc. Tải lại danh sách để mở bản đã lưu.',
  HANDOFF_SELECTION_MISSING: 'Bộ này chưa có đủ liên kết nguồn để xuất hồ sơ bàn giao.',
  HANDOFF_SOURCE_MISMATCH:
    'Một tệp trong hồ sơ không khớp bản gốc đã lưu tại ứng dụng. Giữ hồ sơ để đối chiếu nguồn.',
  HANDOFF_PRICE_MISMATCH: 'SKU hoặc giá trong hồ sơ không khớp đúng dòng và bộ giá đã nhận.',
  HANDOFF_SCOPE_MISMATCH:
    'Có tệp không thuộc đúng bộ listing trong hồ sơ. Kiểm tra lại bộ được bàn giao.',
  HANDOFF_TARGET_REQUIRED: 'Chọn rõ bộ nguồn cần cập nhật hoặc tạo bộ mới trước khi tiếp tục.',
  HANDOFF_PREVIEW_CHANGED:
    'Hồ sơ hoặc bản nguồn đã thay đổi sau khi xem trước. Xem lại khác biệt rồi mới áp dụng.',
  HANDOFF_BLOCKED: 'Hồ sơ còn phần chưa đủ điều kiện. Đối chiếu các vấn đề trong bản xem trước.',
  SANDBOX_AUTH_REQUIRED:
    'Token TEST đã lưu không còn được Shopee chấp nhận. Mở Kết nối shop và cập nhật token hợp lệ.',
  SANDBOX_API_REJECTED:
    'Shopee từ chối yêu cầu. Giữ nguyên nguồn và kiểm tra lại điều kiện của shop.',
  SANDBOX_API_UNKNOWN:
    'Chưa nhận được phản hồi xác nhận từ Shopee. Giữ công việc và đọc lại kết quả trước khi gửi tiếp.',
  SANDBOX_CONNECTION_REQUIRED: 'Chưa có kết nối TEST hợp lệ. Mở Kết nối shop để kiểm tra.',
  SANDBOX_SCOPE_NOT_ALLOWED:
    'Phạm vi này chưa được mở để ghi thử. Chỉ listing Lamy 803934364 trên sandbox shop 227418363 được phép trong đợt nghiệm thu này.',
  SANDBOX_BASELINE_CHANGED:
    'Listing trên Shopee đã thay đổi từ lúc đối chiếu. Đọc lại bản hiện tại trước khi chuẩn bị cập nhật.',
  SANDBOX_SOURCE_REVISION_CHANGED: 'Bộ nguồn đã có bản mới. Chọn rõ phiên bản nguồn trước khi gửi.',
  SANDBOX_RUN_REVISION_CONFLICT:
    'Lần thực hiện đã có trạng thái mới hơn. Đọc lại kết quả trước khi thao tác tiếp.',
  SANDBOX_IDEMPOTENCY_CONFLICT:
    'Mã lần thực hiện đã gắn với nội dung khác. Mở lại lần đã lưu để đối chiếu.',
  SANDBOX_TARGET_BUSY:
    'Link này đang có yêu cầu chưa xác định xong kết quả. Đọc lại lần trước trước khi tạo cập nhật khác.',
  SANDBOX_RUN_NOT_RECONCILABLE:
    'Yêu cầu còn đang xử lý. Đợi kết quả hoặc mở lại trạng thái; không gửi trùng.',
  SANDBOX_RUN_NOT_FOUND: 'Không tìm thấy lần thực hiện đã lưu.',
  SANDBOX_LIMITS_UNAVAILABLE:
    'Chưa đọc được giới hạn theo ngành của shop. Chưa thể xác nhận dữ liệu đủ điều kiện gửi.',
  SANDBOX_SKU_MISMATCH: 'Các SKU trên link khác bộ nguồn. Xác định đúng link trước khi cập nhật.',
  SANDBOX_VARIATION_MISMATCH:
    'Tên hoặc cấu trúc phân loại trên link khác bộ nguồn. Cần đối chiếu lại.',
  SANDBOX_TITLE_LIMIT_UNVERIFIED:
    'Tiêu đề chưa nằm trong giới hạn đã đọc được từ shop; giữ nguyên nguồn để đối chiếu.',
  SANDBOX_DESCRIPTION_LIMIT_UNVERIFIED:
    'Mô tả chưa xác minh được theo giới hạn của shop; giữ nguyên nội dung.',
  SANDBOX_DESCRIPTION_MEDIA_LIMIT:
    'Số ảnh mô tả chưa phù hợp giới hạn đã đọc; ứng dụng giữ nguyên ảnh để bạn xử lý.',
  SANDBOX_EXTENDED_DESCRIPTION_UNVERIFIED: 'Shop chưa xác nhận hỗ trợ bố cục mô tả có ảnh này.',
  SANDBOX_GALLERY_LIMIT_UNVERIFIED: 'Bộ ảnh sản phẩm chưa xác minh được theo giới hạn của shop.',
  SANDBOX_GALLERY_RATIO_UNVERIFIED:
    'Tỷ lệ ảnh sản phẩm chưa khớp khả năng đã xác minh. Ứng dụng giữ nguyên ảnh gốc.',
  SANDBOX_SOURCE_ASSET_MISMATCH: 'Nội dung tệp ảnh đã khác bản được chọn. Chưa gửi ảnh lên Shopee.',
  SANDBOX_SOURCE_ASSET_MISSING:
    'Không tìm thấy tệp ảnh gốc của bộ nguồn. Cần bổ sung đúng tệp đã chọn.',
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
