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
  PRODUCTION_BATCH_SOURCE_CHANGED: 'Nguồn đã có phiên bản mới. Loại mục chưa gửi khỏi đợt cũ rồi chuẩn bị lại từ bản mới; không đăng bản cũ.',
  PRODUCTION_BATCH_SOURCE_ARCHIVED: 'Nguồn đã được lưu trữ. Loại mục chưa gửi khỏi đợt này hoặc khôi phục nguồn để chuẩn bị lại.',
  PRODUCTION_BATCH_EXCLUSION_NOT_ALLOWED: 'Chỉ loại được listing chưa có lần gửi và khi đợt đã dừng. Link đã tạo hoặc lần gửi chưa rõ kết quả cần đối chiếu trước.',
  PRODUCTION_BATCH_EXCLUSION_INVALID: 'Chưa xác nhận được hồ sơ loại listing khỏi đợt. Đọc lại trạng thái; chưa gửi thêm sản phẩm.',
  PRODUCTION_BATCH_STATUS_CHANGED: 'Đợt đã có trạng thái mới. Bấm Đọc lại đợt đăng để tiếp tục đúng trạng thái hiện tại.',
  FOLDER_SOURCE_CHANGED:
    'Bộ listing này đã có bản nháp nhưng nội dung, phân loại hoặc bộ giá đã khác. Mở bản đã lưu để đối chiếu; chưa tạo bản trùng.',
  FOLDER_SOURCE_BINDING_STALE:
    'Bộ đầu vào đã có phiên bản mới. Mở lại bản đã lưu trước khi tiếp tục.',
  FOLDER_SOURCE_BINDING_INVALID:
    'Chưa đối chiếu được đúng hồ sơ nguồn với bản nháp. Giữ nguyên tệp và mở lại bộ đầu vào; chưa tạo bản mới.',
  PENDING_SOURCE_INVALID:
    'Chưa đọc được đúng bảng phân loại đã lưu. Giữ phần đang làm và mở lại đúng bộ đầu vào để đối chiếu.',
  PENDING_SOURCE_BINDING_STALE:
    'Bảng phân loại đã có bản lưu mới hơn. Mở lại đúng bộ đầu vào để đối chiếu; không tạo bản nháp trùng.',
  PENDING_SOURCE_BINDING_INVALID:
    'Bản nháp chưa khớp bảng phân loại và tệp nguồn đã lưu. Mở lại đúng bộ đầu vào để đối chiếu; chưa tạo listing mới.',
  PENDING_SOURCE_INCOMPLETE:
    'Bảng phân loại còn SKU hoặc giá chưa khớp. Điền đủ từng ô và xác nhận dùng đủ phân loại trước khi tạo bản nháp.',
  PENDING_SOURCE_PRICE_INVALID:
    'Bảng giá hoặc bộ giá chưa khớp hồ sơ phân loại đã lưu. Mở SKU & giá, chọn lại đúng nguồn giá rồi kiểm tra trước khi tiếp tục.',
  PENDING_SOURCE_IMAGE_INVALID:
    'Ảnh đã chọn chưa khớp tệp nguồn đã lưu. Mở đúng bộ đầu vào và chọn ảnh thuộc bộ đó; chưa tạo bản nháp mới.',
  INPUT_BATCH_PENDING_SOURCE_CHANGED:
    'Hồ sơ phân loại gốc đã khác bản đang bổ sung. Giữ nguyên nhãn và thứ tự; mở đúng bộ nguồn để tiếp tục.',
  LOCAL_ARCHIVE_IN_USE: 'Nguồn này đang gắn với công việc chưa kết thúc. Mở công việc để xem trạng thái trước khi lưu trữ; thao tác lưu trữ không hủy lần gửi.',
  LOCAL_RESOURCE_ARCHIVED: 'Nguồn đã được lưu trữ. Vào Kho đầu vào → Đã lưu trữ và khôi phục trước khi dùng tiếp.',
  LOCAL_ARCHIVE_NOT_FOUND: 'Không tìm thấy mục cần lưu trữ. Tải lại danh sách để kiểm tra.',
  LOCAL_ARCHIVE_INVALID: 'Lựa chọn lưu trữ chưa hợp lệ. Tải lại danh sách rồi chọn đúng mục.',
  PREPARED_INPUT_REVISION_CHANGED:
    'Bộ thư mục đã có phiên bản mới. Mở Quản lý phần chưa chạy để hủy phần cũ chưa gửi, rồi chọn nguồn mới và xem trước lại.',
  PREPARED_DISPATCH_SHEET_REQUIRED:
    'Excel chưa có sheet Điều phối listing để xác định thư mục, shop, ngành và vai trò ảnh. Chọn đúng bảng điều phối đã chuẩn bị.',
  PREPARED_EXECUTION_UNAVAILABLE:
    'Màn hình này chưa được cấu hình thực thi. Dữ liệu nguồn vẫn được giữ để đối chiếu.',
  PREPARED_INTENT_CONFLICT:
    'Mã lô đã gắn với một nội dung khác. Mở kết quả đã lưu để đối chiếu trước khi lập lô mới.',
  PREPARED_RECONCILIATION_REQUIRED:
    'Lần gửi này chưa rõ kết quả. Chọn Đọc đối chiếu; ứng dụng không gửi lại nội dung.',
  PREPARED_STILL_RUNNING:
    'Yêu cầu đang được xử lý. Đọc lại trạng thái trước khi thao tác tiếp.',
  PREPARED_FOLDER_SELECTION_INVALID:
    'Chọn ít nhất một thư mục thuộc đúng đợt nhập; không chọn trùng hoặc ghép thư mục từ đợt khác.',
  PREPARED_FORMULA_REQUIRES_VALUES:
    'Bảng điều phối có công thức. Xuất một bản Excel chứa giá trị đã kiểm tra rồi nhập bản đó.',
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
  CONNECTION_NAME_REVISION_CONFLICT:
    'Tên gợi nhớ đã có bản mới. Bấm Tải lại tên đã lưu để đối chiếu trước khi lưu tiếp.',
  CONNECTION_NAME_NOT_FOUND: 'Không tìm thấy kết nối shop này. Tải lại danh sách shop.',
  PRODUCTION_CONNECTION_REVISION_CONFLICT: 'Kết nối đã có phiên mới. Bấm Tải lại trạng thái kết nối rồi kiểm tra trước khi lưu lại.',
  PRODUCTION_CONNECTION_KEY_REQUIRED: 'Lần đầu cần Live Partner Key của đúng Partner ID đã chọn. Nhập khóa vào ô trên ứng dụng.',
  PRODUCTION_CONNECTION_SAVED_KEY_INVALID: 'Chưa đọc được khóa đã lưu. Nhập lại khóa và token đúng ứng dụng production.',
  PRODUCTION_CONNECTION_SHOP_NOT_READY: 'Shop trả về không thuộc VN hoặc chưa ở trạng thái NORMAL. Chưa lưu kết nối.',
  PRODUCTION_CONNECTION_AUTH_EXPIRED: 'Quyền truy cập shop đã hết hạn. Cần cấp quyền lại trong Open Platform.',
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
    // These error families are translated by our API; unknown payloads stay out of the UI.
    const knownTranslated =
      (code.startsWith('KNOWLEDGE_') || code.startsWith('PATCH_') || code.startsWith('PREPARED_') || code.startsWith('IMAGE_QC_') ||
        code.startsWith('PREPARATION_') || code.startsWith('PRODUCTION_PREPARATION_') || code.startsWith('PRODUCTION_BATCH_') ||
        code.startsWith('SELLER_KNOWLEDGE_') || code.startsWith('PRODUCTION_EXECUTION_POLICY_') ||
        code.startsWith('PRODUCTION_PILOT_') || code.startsWith('PRODUCTION_AUTHORIZATION_') || code.startsWith('PRODUCTION_CONNECTION_')) &&
      typeof body.message === 'string' &&
      /[À-ỹ]/u.test(body.message);
    throw new RequestError(
      requestMessages[code] ??
        (knownTranslated
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
