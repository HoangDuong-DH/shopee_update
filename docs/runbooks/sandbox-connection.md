# Kết nối TEST tại máy

Đối chiếu giao diện Console ngày **11/09/2026**. Bản hiện tại chỉ gọi API đọc shop để kiểm tra và lưu thông tin kết nối; chưa tự refresh token hoặc đăng listing.

1. Vào [App List](https://open.shopee.com/console/app), mở app **TEST**, Test Partner ID **1232297**. App đã xác minh tại [trang chi tiết TEST](https://open.shopee.com/console/app/230442). Tại **APP Key**, sao chép **Test API Partner Key**. Không chọn app VestaPro hoặc Live API Partner Key.
2. Mở [API Test Tool](https://open.shopee.com/console/tools/api-test). Chọn **1232297 TEST → Shop → v2.shop.get_shop_info**. Kiểm tra Request URL thuộc `https://openplatform.sandbox.test-stable.shopee.sg`.
3. Trong **Common Parameters**, nhập **shop_id 227418363**, bấm **Get Access Token**. Console điền trực tiếp ô **access_token**, ngay dưới shop_id; có thể cần cuộn xuống. Bấm trong ô token, Ctrl+A, Ctrl+C. Sao chép giá trị tại máy, không gửi vào chat hoặc ảnh chụp. Không cần bấm Start Test để lấy giá trị đã hiện.
4. Mở [ứng dụng local](http://127.0.0.1:5173/), chọn **Kết nối shop → Cấu hình kết nối sandbox trực tiếp**. Dán key và token vào đúng hai ô. **Sandbox Refresh Token** là tùy chọn ở phép kiểm tra đầu tiên.
5. Bấm **Kiểm tra & lưu kết nối TEST**. Thành công phải có tên shop và mã yêu cầu đọc API trực tiếp. HTTP 200 hoặc ô token có dữ liệu chưa chứng minh bước này thành công.

Nếu Get Access Token báo thiếu authorization, cần cấp quyền đúng tài khoản sandbox qua Authorize; xem [hướng dẫn Sandbox V2](https://open.shopee.com/developer-guide/644) và [Authorization](https://open.shopee.com/developer-guide/20). Không đăng nhập shop thật vào luồng test, không tạo thêm shop hoặc listing Lamy để xử lý lỗi token. Callback/refresh tự động của ứng dụng còn trong gói B1.

Server mã hóa khóa/token và chỉ trả trạng thái, tên shop, scope và bằng chứng đọc API. Khi token bị từ chối, lấy token TEST còn hiệu lực từ Console rồi nhập lại. Không dùng trạng thái connected cũ làm bằng chứng token vẫn có hiệu lực.
