# Trải nghiệm và đồng bộ giao diện

Giao diện React dùng server làm nguồn trạng thái nghiệp vụ. Tóm tắt ngắn, nhóm thao tác theo mục tiêu và chỉ mở chi tiết khi người dùng cần. Bộ lọc, lựa chọn nhiều shop, bulk result và navigation phải giữ đúng scope và cập nhật khi server đổi.

Không tô trạng thái thành công dựa trên lựa chọn UI hoặc ACK. Các chức năng phải nối luồng nguồn → chuẩn bị → operation → readback; lỗi chỉ ra việc tiếp theo. Kiểm responsive, keyboard, contrast, light/dark và reduced motion tương xứng thay đổi.

Trên máy vận hành, sửa/test/build ở checkout riêng. Không build đè web dist đang phục vụ hoặc restart khi chưa kiểm PID/job. Browser fixture kiểm trải nghiệm, không chứng minh Shopee production.

Đọc bộ listing dùng /v1/products với envelope items/total/page/limit/hasMore; tìm kiếm/lifecycle chạy trên SQL trước giới hạn. Không coi không có trong trang hiện tại là bị mất nguồn. Khôi phục lựa chọn dùng exact key và revision; cập nhật giao diện phải chặn phản hồi đọc cũ.
