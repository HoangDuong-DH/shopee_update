# Kết nối shop và API

Thiết lập local xong vẫn có thể nhập nguồn, sửa bản nháp và kiểm thử fixture mà chưa kết nối Shopee. Muốn đọc hoặc ghi dữ liệu shop thật, chủ shop cần có ứng dụng Open Platform hợp lệ và cấp quyền cho đúng shop.

## Hai loại API

| Loại | Ai cung cấp | Khi nào cần |
| --- | --- | --- |
| API ListingStudio | Backend chạy local, mặc định `http://127.0.0.1:4310` | Giao diện và worker dùng để lưu/đọc dữ liệu. Không phải khóa Shopee. |
| Shopee OpenAPI | Shopee Open Platform và shop cấp quyền | Đọc thông tin shop/metadata, hoặc thực hiện thao tác đã được giao. |

Không cần API key của OpenAI để chạy chức năng hiện có. Server AI và MCP không phải phần được cài tự động bởi onboarding.

## Những gì chủ shop cần chuẩn bị

- Chọn **sandbox** (shop thử) hoặc **production** (shop thật).
- Partner ID và Partner Key của đúng ứng dụng/môi trường; Shop ID của đúng shop.
- Tài khoản có quyền cấp quyền cho shop; quyền API phù hợp các chức năng cần dùng.
- Địa chỉ callback được cấu hình phù hợp với địa chỉ mà ListingStudio hiển thị.

Codex có thể kiểm cấu hình và hướng dẫn thao tác. Đăng nhập, chấp nhận quyền và lấy khóa cần chủ tài khoản thực hiện hợp lệ. Đăng nhập Kênh Người bán chưa thay cho bước cấp quyền Open Platform.

## Kết nối từ giao diện

1. Với shop thật, giữ API và giao diện local chạy. Mở **Shop → Kết nối shop mới**.
2. Nhập Partner ID và Shop ID production, bấm **Chọn shop này**. Đối chiếu với phạm vi người dùng giao; tên shop được xác nhận bằng lần đọc API sau cấp quyền.
3. Nhập Partner Key của đúng môi trường vào ô riêng trên ứng dụng. Không đưa khóa/token vào chat, ảnh chụp, Git hoặc tài liệu công khai.
4. Với luồng production, chuẩn bị liên kết cấp quyền, kiểm địa chỉ callback đang hiển thị rồi mở Shopee. Chủ shop đăng nhập và cấp quyền đúng shop.
5. Trở lại ListingStudio, tải lại trạng thái và kiểm kết quả đọc shop mới. Nếu callback chưa về, kiểm phiên cấp quyền đang chờ trước khi tạo phiên khác.
6. Chỉ gọi kết nối đạt khi backend xác nhận đúng shop/môi trường bằng lần đọc mới. Thông báo đã lưu hoặc HTTP thành công riêng lẻ chưa đủ.

Sandbox dùng khóa/token TEST và shop sandbox tương ứng. Mở chi tiết kết nối TEST đã được quản trị cấu hình để dùng biểu mẫu sandbox; nút kết nối mới hiện dẫn tới luồng production. Nếu máy mới chưa có kết nối TEST, nhờ Codex đối chiếu cấu hình và quyền tài khoản trước, không nạp shop giả để lấp danh sách. Không trộn khóa/token hoặc Shop ID production vào sandbox. Thao tác thử ghi sandbox cũng cần phạm vi riêng, không thuộc lượt thiết lập local.

## Cổng, callback và cloud

Với cổng mặc định, web ở `http://127.0.0.1:5173` và API ở `http://127.0.0.1:4310`. Khi chọn cổng khác, kiểm lại địa chỉ nhận cấp quyền. `PUBLIC_API_ORIGIN` và `PUBLIC_WEB_ORIGIN` phục vụ callback/quay về ứng dụng; `ALLOWED_ORIGINS` quy định origin được phép gọi backend.

Địa chỉ `127.0.0.1` thuộc chính máy đang chạy. Một deployment cloud cần địa chỉ public, callback được chấp nhận, cấu hình mạng/TLS và cách giữ secrets riêng. Cài local thành công không chứng minh luồng cấp quyền cloud đã hoạt động; không tự mở API/database local ra Internet để thử.

## Sau kết nối

Nếu partner/shop chưa thuộc phạm vi mà luồng hiện có hỗ trợ, giữ riêng và báo phần cần bổ sung; không đổi ID để vượt kiểm tra. Lưu trạng thái và kiểm mới khi token hết hạn, quyền bị thu hồi hoặc thay shop. Credentials được mã hóa trong database bằng `APP_ENCRYPTION_KEY`; giữ khóa này cùng vòng đời database, qua kênh bảo mật riêng.

Onboarding và launcher local giữ ghi production/pilot và bảo trì kết nối tự động **tắt**. Kết nối thành công không tự cho phép chạy đợt đăng, gia hạn tự động hay mở bán. Trước một thao tác ghi thật phải có phạm vi người dùng giao, đúng shop, nguồn đã chốt và operation đã đăng ký; sau ghi phải đọc lại để QC.

Xem [hướng dẫn chốt nguồn](../runbooks/source-provenance-guard.md), [skill vận hành](../../skills/shopee-uploader-operator/SKILL.md) và [handoff hiện hành](../handoffs/PROJECT_HANDOFF.md) để biết giới hạn đang áp dụng. Chưa có nghiệm thu chung cho mọi shop, ngành hàng hoặc chạy liên tục 24 giờ.
