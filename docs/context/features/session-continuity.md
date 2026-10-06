# Tiếp nối phiên và harness

Mục tiêu: bắt đầu bằng bộ context nhỏ nhưng đủ biết phạm vi, quyết định, việc tạm dừng và bằng chứng. Đọc `AGENTS.md`, bản đồ, contract và đúng tài liệu chức năng; mã/tests/runbooks chỉ là references để đọc theo nhu cầu.

`session:brief` chỉ đọc trạng thái cục bộ. `--runtime` chỉ GET trạng thái API loopback; không gia hạn token, đọc listing hay gửi lệnh Shopee. Lưu checkpoint sau quyết định, mốc kết quả, thay đổi phạm vi và trước bàn giao. Hai phiên cùng ghi phải đối chiếu revision; không ghi đè để thắng xung đột.

Nếu bằng chứng thiếu/đổi hoặc code liên quan đổi, nhận định lưu trước đó cần kiểm lại đúng phần. Không tự chạy lại công việc. Phần context chưa nạp được liệt kê theo task ID, có thể truy đúng task/history.

Harness quản lý thao tác vẫn nằm ở `management.ts` và `harness.ts`; continuity không cấp thêm capabilities. Xem hướng dẫn SESSION_CONTINUITY để sử dụng, phục hồi checkpoint bị ngắt và giới hạn thực tế.
