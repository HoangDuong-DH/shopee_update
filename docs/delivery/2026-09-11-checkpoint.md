# Kiểm tra tiếp nối — 11/09/2026

Ứng dụng vẫn là bản phát triển; phạm vi tính năng và phần chưa hoàn tất tại [mốc nền tảng](2026-09-10-foundation.md) còn áp dụng.

- Khôi phục Docker/PostgreSQL từ volume cũ và khởi động lại API/worker. API đọc lại được bản nháp Lamy revision 1, sáu SKU, 16 ảnh; nguồn và nội dung vẫn còn. Đây là kiểm tra sau restart, không phải diễn tập phục hồi từ backup.
- Readiness kiểm tra tất cả migration/checksum cần thiết. Đã chứng minh test thất bại khi thiếu migration rồi đạt sau sửa. Worker lùi thời gian thử lại kết nối DB từ 1 lên tối đa 30 giây, giới hạn log lỗi lặp.
- Kiểm kiểu/build đạt; 7 test legacy, 31 unit/integration và 3 browser E2E đạt trong lần chạy mới ngày 11/09. Các test browser chỉ đọc app local và bộ nguồn Lamy, không gửi Shopee.
- Đường mạng đến host sandbox đã nhận HTTP 200 với lỗi tham số khi gọi không có credentials. Kết quả này chỉ chứng minh kết nối mạng, chưa chứng minh ứng dụng được cấp quyền.
- Đã đối chiếu Get Access Token trên Console đúng TEST 1232297 / shop 227418363. Console điền ô token; không đọc hoặc lưu giá trị trong báo cáo. Người dùng nhập key/token trực tiếp vào UI theo [hướng dẫn TEST](../runbooks/sandbox-connection.md).

Đến mốc ghi nhận này, descriptor sandbox trong app vẫn disconnected. Chưa có bằng chứng authenticated backend thành công, chưa có lệnh ghi Shopee từ ứng dụng mới. Executor, refresh tự động, QC, load/soak và pilot production chưa nghiệm thu. Báo cáo chi tiết có dữ liệu doanh nghiệp ở `.local/` không đưa vào Git.
