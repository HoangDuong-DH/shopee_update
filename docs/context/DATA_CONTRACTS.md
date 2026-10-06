# Hợp đồng dữ liệu cần nhớ

## Nghiệp vụ

- Scope = environment + partner + shop + connection/capability revision. Item/model ID chỉ có ý nghĩa trong đúng scope. Không lấy tên shop hoặc tab đang mở làm bằng chứng quyền ghi.
- Nguồn = đúng tệp/dòng/ô + revision/fingerprint. Cấu trúc tầng/lựa chọn/tổ hợp SKU và giá phải đối chiếu với khai báo độc lập; SKU không được ghép theo thứ tự hàng trên giao diện.
- Giá giữ chính xác theo nguồn; tồn, trạng thái, video, mô tả và vận chuyển ngoài phạm vi sửa phải được bảo toàn. Không suy giá từ nhãn SKU.
- Operation/batch có journal và trạng thái riêng. ACK, HTTP 200, created item, verified readback và QC đạt là các mốc khác nhau. Unknown phải đối chiếu trước retry.
- Archive giữ snapshot và bằng chứng gốc; không chuyển nguyên ID kho/khuyến mãi của shop nguồn sang shop đích. Các ngoại lệ cần báo cụ thể.

## Nơi định nghĩa

`packages/domain/src/contracts.ts`, `draft.ts`, `plans.ts`, `prepared-batch.ts` và `archive-clone.ts` giữ contract. `packages/persistence/src` cùng migrations hiện hành giữ schema DB; tìm bảng liên quan khi cần, không sửa migrations đã áp dụng. API/worker phải giữ transaction, locks và receipts nhất quán.

## Context của agent

`packages/agent-runtime/src/session-context.ts` định nghĩa schema version 1: registry chức năng, task patch và state. State lưu revision, task đang tập trung và các công việc; mỗi task có scope, quyết định, câu hỏi, bước tiếp, phần không được phát lại và hash bằng chứng. Journal bất biến giữ các lần thay đổi. Quyết định và doNotReplay được nối giữ; câu hỏi chỉ gỡ khi ghi resolvedQuestions; chuyển paused/needs_input sang active cần ghi quyết định tiếp tục.

Context là dữ liệu cục bộ, không đồng bộ quyền ghi về API, không tự tiếp tục batch. Hash khớp chỉ chứng minh byte tệp không đổi, không chứng minh nguồn đúng hoặc trạng thái Shopee hiện tại. Trường chưa biết phải để chưa biết.

## Đọc danh sách bộ listing

GET /v1/products nhận lifecycle, q, page, limit (tối đa100), trả items/total/page/limit/hasMore. Tìm kiếm được chuẩn hóa NFKC và trim, khớp tên, mã bộ hoặc SKU trước paging. GET theo productKey là đọc chính xác; chỉ404 mới chứng minh không có. Lựa chọn nguồn đang làm được ghim bằng key riêng, không phụ thuộc trang đang hiển thị và không dùng tổng của trang làm tổng toàn kho.
