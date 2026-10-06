# Cài đặt và chuyển máy

Bản clone chứa source/fixtures, không chứa database, tệp riêng, token hoặc khóa giải mã. Kế hoạch onboarding là kiểm đọc; setup mới không được áp lên môi trường có dữ liệu. Docker Desktop cần sẵn sàng, Node được ghim và database riêng đúng ownership.

Chuyển máy cần bộ private và khóa tương ứng; kiểm hash/schema rồi plan/restore. Khởi động giữ transfer hold, không resume jobs. Public release không đưa `.local/session-context` vào Git; continuity cần bàn giao riêng nếu muốn tiếp nối task cũ. Hash bằng chứng trên máy mới phải kiểm lại, đường thiếu được giữ unknown.

Kiểm máy/backup trước sửa. Các receipt cũ ghi thời điểm nghiệm thu, không chứng minh runtime đang chạy hoặc token còn hợp lệ. Không nhận định đạt 24 giờ/mọi ngành từ fixture.

Giám sát local giữ receipt riêng, tự phục hồi API/web đã chết với retry hữu hạn; worker chết giữ chờ kiểm hàng đợi. Readiness lỗi khi PID sống không tạo restart storm. Xem runbook local-service-supervisor và runtime-endurance cho giới hạn và bằng chứng đo thực tế.
