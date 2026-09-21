# Kết nối shop và gia hạn — 18/09/2026

## Phạm vi

Sửa kết nối production, cấp quyền qua main account, kiểm tra quyền và bảo trì token. Không chạy đăng, cập nhật, mở bán hoặc đối chiếu sản phẩm. Không sửa Bo_nguon. Không mở rộng allowlist của production writer.

## Hành vi mới

- Màn hình chọn Partner ID / Shop ID hoặc kết nối đã lưu. Shop mới dùng lại Partner Key đã mã hóa của cùng ứng dụng production; không dùng khóa sandbox hoặc ứng dụng khác.
- API enrollment tổng quát `/v1/connections/production` và `/authorize`; endpoint pilot cũ vẫn giữ scope tương thích.
- Callback gắn state + cookie HttpOnly + phạm vi shop trong bản ghi server; mã chỉ đổi một lần. Main account có nhiều shop được chấp nhận khi danh sách cấp quyền chứa shop yêu cầu. Chỉ shop được chọn được ghi vào connections.
- Theo dõi phiên qua refresh trang, hủy phiên pending có kiểm tra cookie; không hủy token exchange đang chạy. Link trở về app dùng cổng phục vụ hiện tại, không dẫn sang dev 5173.
- Shop hết hạn không còn hiện trạng thái connected trong API danh sách. Hiển thị thời hạn, tự gia hạn, cần cấp quyền lại, chờ hoặc chưa rõ kết quả.
- API process kiểm tra bảo trì mỗi phút, gia hạn trước hạn 10 phút; không chạy khi app tắt. Sau mở lại tiếp tục kiểm tra. Có nút kiểm tra thật, gia hạn/phục hồi và bật/tắt tự gia hạn.
- Refresh dùng khóa shop/enrollment, CAS revision, intent và biên nhận mã hóa trước khi lưu DB. Không phát lại refresh nếu đã có intent; chỉ phục hồi từ receipt. Timeout không có receipt chuyển unknown và cần cấp quyền lại.
- Không hủy lane/journal để gia hạn. Reservation chưa có bước gửi, chưa có item, không sở hữu lane không giữ việc gia hạn vô hạn: writer bắt buộc kiểm revision hiện hành dưới cùng khóa trước cấp phép gửi.

## Xác minh

- 120 test liên quan kết nối/authorization/refresh/lifecycle đạt trước bổ sung main-account nhiều shop; kiểm riêng trường hợp nhiều shop và hủy phiên trong lượt cuối.
- Typecheck và build đã chạy; Vite vẫn có cảnh báo kích thước bundle, không thuộc thay đổi kết nối.
- Thật: vuatinhdau.vn 1423724897 gia hạn revision 6 → 7; TTL mới 2026-09-18T07:22:16.532Z (14:22 giờ VN). Sau đó POST kiểm tra shop trả success.
- Hash 14 operation, 239 step, 10 publication, 1 lane giữ nguyên. Bằng chứng `.local/connection-lifecycle-20260918/verification.json`; backup connection/auth/check mã hóa trước migration cùng thư mục.
- Migration 034 áp dụng; API khởi động bằng launcher. Chưa nghiệm thu vận hành 24 giờ hoặc đăng hàng đa shop.
- Browser kiểm tra giao diện bị auto-review chặn vì hết hạn mức; không tuyên bố đã thao tác UI thực tế sau sửa.

## Shop 1126307464

Lần cấp quyền gần nhất lưu ngày 18/09 trước sửa nhắm shop 1423724897 và rejected/UNEXPECTED_GRANT_SCOPE. Chưa có connection cho 1126307464. Mã đã đổi không được phát lại; cần cấp quyền phiên mới từ app.

Mở `http://127.0.0.1:4310/?page=shops&partnerId=2010476&connectShop=1126307464`, kiểm shop được chọn, bấm Chuẩn bị kết nối Shopee → Mở Shopee để cấp quyền. Dùng cùng trình duyệt, app giữ mở tại máy nhận callback. Chỉ báo thành công khi backend đổi mã, kiểm shop và lưu kết nối xong.
