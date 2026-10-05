# Tập trung công việc — giao diện sáng/tối, 01/10/2026

Người dùng chọn hướng Tập trung công việc và yêu cầu hoàn thiện thiết kế từ bố cục đến nút, ô nhập, menu, responsive và chuyển động. Bản frontend đã đưa lên cổng 5173 từ build được kiểm tra riêng; không khởi động lại API/worker.

## Thay đổi

- Khung làm việc có thanh điều hướng trái trên desktop; điều hướng gọn trên màn hình nhỏ. Công cụ tải sẵn, không thay đổi bố cục khi CSS của trang khác được tải.
- Tổng quan dùng dải số liệu gọn, việc cần xử lý và tình trạng ứng dụng. Lý do kết nối được gom đúng theo connection/environment/partner/shop; không mất lý do hoặc thao tác xử lý.
- Sáng, Tối, Theo thiết bị; lưu lựa chọn local, đồng bộ giữa các tab, theo thay đổi thiết bị khi chọn Theo thiết bị. Trường hợp storage bị từ chối vẫn dùng được trong phiên.
- Hệ màu dùng chung cho các trang hiện có: lớp nền, viền, chữ, trạng thái và điều khiển. Nút có phân cấp, hover/pressed/focus/disabled; menu có Escape và đóng khi click ra ngoài. Chuyển palette là tức thời để tránh mất tương phản trong lúc nội suy; phản hồi tương tác vẫn có chuyển động ngắn. Tôn trọng reduced motion.
- Giao diện kết nối phân biệt quyền cho phép tự gia hạn với tình trạng dịch vụ thực sự đang chạy. Không thay đổi backend hoặc tự bật dịch vụ.

## Bằng chứng kiểm tra

`verification-O0G82K` tại thư mục bằng chứng private:

- Typecheck và build frontend đạt.
- 87/87 kiểm tra unit/integration liên quan đạt, 8 file.
- 11/11 kiểm tra browser đạt, không skip hoặc retry. Bao gồm luồng nhập ZIP/Excel→nháp→job→QC trên database riêng và Shopee fixture; không phải đăng thật.
- Các trang chính ở 320/390/768/1440px, cả sáng và tối: không tràn ngang, menu không đẩy toolbar, điều hướng vẫn làm việc sau tải CSS Kho nguồn/Theo dõi công việc.
- Kiểm tra contrast chữ thường của năm điều khiển/vùng đại diện ở cả hai palette đạt >=4.5; không phải chứng nhận toàn bộ app WCAG.
- Kiểm tra lựa chọn appearance sau tải lại, phản hồi thiết bị, Escape/focus, bàn phím và reduced motion đạt.
- Kiểm tra trực quan qua trình duyệt ứng dụng: Tổng quan sáng/tối, danh sách và chi tiết nguồn tối. Ảnh `live-overview-light.jpg` và `live-overview-dark.jpg` chụp từ cổng 5173 sau cập nhật. Thao tác viewport bổ sung của công cụ CUA bị timeout; kết quả responsive trên đây thuộc kiểm tra browser tự động.

## Triển khai và giới hạn

`deployment-receipt.json` ghi thời điểm 2026-10-01T10:37:45Z, hash index trước/sau và đường backup dist. Copy assets trước, index sau, giữ assets cũ để các tab đang mở vẫn tải được. API `/health/ready` xác nhận ready; productionWorkflowEnabled, productionWritesConfigured, connectionMaintenanceEnabled đều false trước/sau.

Không ghi Shopee, thay đổi dữ liệu nguồn/giá/SKU, migration, token hoặc tự tiếp tục đợt đăng. Các lỗi kết nối/nguồn được giữ hiển thị đúng trạng thái đã lưu; lượt frontend này không sửa hiệu lực token. Đây là nghiệm thu phạm vi giao diện trên local, chưa xác nhận toàn bộ production/mọi ngành hàng/24h.

Tab cũ của người dùng không nhận điều khiển reload; mở lại URL 5173 hoặc tải lại để nhận index mới. Mã đang là working changes trên feat/internal-app; chưa tạo commit hay merge mới trong lượt này.
