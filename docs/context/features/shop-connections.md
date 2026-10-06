# Kết nối shop

Theo dõi từng scope partner/shop và đúng phiên callback. Kết quả cấp quyền từ Shopee chưa chứng minh app lưu đúng credentials. Kiểm kết quả lưu, shop thực đã xác minh và revision kết nối; không dùng một kết quả chung cho mọi shop.

Chưa rõ kết quả gia hạn phải đối chiếu journal trước retry. Tự gia hạn/cấp quyền có side effect, không chạy trong lệnh đọc context. 365 ngày cấp quyền không đồng nghĩa access token có cùng hạn. Quyền cần do chủ shop cung cấp.

UI dùng projection từ server và sự kiện cập nhật. Kiểm shop đích, callback, lỗi hiển thị và trạng thái stale ở cấp từng shop. Tài liệu kết nối và runbook refresh có hướng xử lý; checkpoint không lưu token hoặc URL callback có code/state.

Gia hạn độc lập với pause đăng: đọc docs/runbooks/connection-maintenance.md và scripts/connection-maintenance-policy.mjs. Opt-in riêng mặc định tắt; launcher/supervisor giữ flag khi phục hồi API. Transfer/isolated hold luôn chặn. Không lấy nhãn Cần gia hạn làm bằng chứng quyền shop đã hết; unknown vẫn phải đối chiếu journal.
