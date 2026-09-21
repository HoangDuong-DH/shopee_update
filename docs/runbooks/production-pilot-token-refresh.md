# Làm mới kết nối production của pilot

## Phạm vi đã triển khai

Backend có CLI làm mới token cho đúng app/partner `2010476`, shop `1423724897` / `vuatinhdau.vn`. CLI dùng Partner Key và refresh token đang được mã hóa ở server. Không yêu cầu nhập lại token trong giao diện hoặc gửi token vào chat.

Đây là **một lệnh được gọi chủ động**, chưa có bộ lập lịch làm mới định kỳ, worker 24 giờ hoặc cơ chế tự làm mới cho mọi shop. Không gọi kết quả dưới đây là nghiệm thu tự vận hành 24 giờ.

## Kết quả thật ngày 15/09/2026

Phiên chính đã thực hiện một lần refresh qua backend vào khoảng **08:38:54 UTC** (**15:38:54 UTC+7**):

- Kết nối production chuyển **revision 1 → 2**; không cần người dùng nhập lại token.
- Backend lưu thời điểm hết hạn **2026-09-15T12:38:54.454Z** (**19:38:54.454 UTC+7**).
- Phản hồi chứa cặp token mới được lưu vào biên nhận mã hóa riêng trước khi ghi kết nối; không cần dùng `--recover` trong lần thật này.
- Khóa row65 đang giữ để QC được giữ nguyên trong lúc refresh. Tất cả 13 bước của lần tạo đã `acknowledged`, không có bước ghi đang chờ gửi hoặc chưa rõ kết quả.
- Sau khi backend khởi động lại, row65 tiếp tục đọc đối chiếu, lấy metadata mới rồi mở bán đúng một lần. Listing **51267858328**, operation **007738be-04ec-4ead-88d2-825062b29056**, đã đạt `publication verified`.
- Row2 đã đăng trước đó không bị ghi lại. Phiên chính đối chiếu snapshot DB trước/sau giống nhau, SHA-256 `4774b33d82dfb176bb6a7cb94e6536d23695874f9e3affdf12aaf8f37af31358`.

Đăng/mở bán thuộc runner production riêng; CLI refresh không gọi API sản phẩm. Các kết quả nghiệp vụ được ghi thêm trong [hồ sơ tiếp tục lô pilot](../delivery/2026-09-15-bulk-continuation.md).

Kiểm thử riêng refresh: **17 unit + 8 integration PostgreSQL = 25/25**, có transport giả lập; các bài kiểm này không gọi Shopee thật. Kiểm tổng do phiên chính ghi nhận lúc **2026-09-15T08:47:19Z**: **1.529/1.529 unit/integration, 7/7 legacy, typecheck và build đều đạt**. Kết quả thật một lần ở trên tách biệt với các phép kiểm giả lập này.

## Cách gọi

Chạy từ thư mục dự án, sau khi đối chiếu revision hiện tại của kết nối. Lệnh sau là lần đã thực hiện, **không chạy lại để thử**:

```powershell
.local/runtime/node-v24.20.0-win-x64/node.exe --conditions=development --import tsx scripts/refresh-production-pilot-connection.mts --expected-revision=1
```

Nếu lần gọi bị mất phản hồi hoặc lưu kết nối thất bại **sau khi đã nhận được biên nhận mã hóa**, dùng cùng revision của intent và thêm `--recover`:

```powershell
.local/runtime/node-v24.20.0-win-x64/node.exe --conditions=development --import tsx scripts/refresh-production-pilot-connection.mts --expected-revision=1 --recover
```

`--recover` đọc kết quả đã lưu; không gọi lại API refresh. Nếu kết nối đã được lưu đúng cặp token và revision, lệnh trả `already_saved`. Nếu chưa lưu, lệnh chỉ đọc thông tin shop để xác minh rồi cập nhật kết nối bằng CAS. Không tự đổi `expected-revision` hoặc xóa intent để vượt lỗi.

Lần refresh tiếp theo là một yêu cầu mới theo **revision hiện tại**, dùng refresh token mới đã lưu. Không tái sử dụng cặp token hoặc intent của lần trước.

## Nhật ký và phục hồi

Nhật ký riêng tại:

```text
.local/production-pilot-1423724897/credential-refresh/
  <connection-id>-r<expected-revision>/
    intent.json
    response.sealed.json
```

- `intent.json`: định danh lần gọi, connection/revision và thời điểm bắt đầu, không chứa khóa hoặc token.
- `response.sealed.json`: phản hồi được mã hóa, ràng buộc với đúng scope/connection/revision. Không commit, không đưa vào tài liệu hoặc chat.
- Tệp được tạo một lần và đồng bộ xuống ổ đĩa. Khi intent đã tồn tại, chế độ refresh không gửi lại.
- Nếu mạng mất phản hồi hoặc tiến trình dừng mà chưa có biên nhận đầy đủ, giữ kết quả chưa xác định. `--recover` không thể dựng lại token chưa nhận được; không xóa intent hay gửi lại refresh token cũ.

## Điều kiện chặn và bảo toàn

CLI giữ cùng khóa shop với journal create/publication, khóa enrollment và khóa hàng connection trong lúc xử lý. Lệnh chặn khi có operation/publication `authorized`, `sent`, `unknown`, hoặc phiên cấp quyền mới còn hiệu lực.

Một lane đã nhận **đủ toàn bộ bước media/create/variation theo nguồn** ở trạng thái `acknowledged` có thể được refresh để đọc QC. Chỉ trạng thái `acknowledged` trên operation chưa đủ: phải đối chiếu đúng toàn bộ khóa bước và số lượng. Lệnh không xóa lane, đổi trạng thái operation, sửa receipt, gửi lại sản phẩm hoặc ghi đè nguồn.

Sau refresh thành công:

- Xác minh scope từ phản hồi refresh và đọc `get_shop_info` đúng shop; yêu cầu vùng VN, trạng thái NORMAL và quyền shop chưa hết hạn.
- Tăng revision kết nối và capability revision; xóa snapshot capability cũ để thu thập metadata mới theo revision mới.
- Thời hạn token lấy từ thời điểm bắt đầu yêu cầu cộng `expire_in`, giới hạn thêm bởi hạn cấp quyền shop nếu API trả về. Không cộng TTL từ thời điểm lưu muộn hơn.
- Lưu token mới bằng CAS, giữ tên hiển thị và Partner Key hiện có. Không tái sử dụng receipt hoặc sửa bảng OAuth authorization attempts.

## Nguồn kỹ thuật

- [v2.public.refresh_access_token](https://open.shopee.com/documents/v2/v2.public.refresh_access_token?module=104&type=1), bản cập nhật **13/07/2026**, bản chụp kho **08/09/2026**: POST `/api/v2/auth/access_token/get`, chữ ký public, refresh token dùng một lần, phản hồi có cặp token mới và thời hạn tính bằng giây. Tài liệu có quyền `Seller In House System`.
- [Authorization and Authentication](https://open.shopee.com/developer-guide/20), bản cập nhật **23/07/2026**: lưu token riêng theo shop; lần refresh tiếp theo dùng refresh token mới.
- Lúc triển khai, công cụ web nhận HTTP 403 khi mở trang API chính thức; quyết định codec dựa vào tài liệu đầy đủ trong kho. Lần API production thành công ở trên là bằng chứng thực thi của đúng kết nối pilot, không chứng minh mọi app/shop đều có quyền.

Mã triển khai: `packages/shopee/src/production-refresh.ts`, `apps/api/src/production-refresh-service.ts`, `scripts/refresh-production-pilot-connection.mts`.
