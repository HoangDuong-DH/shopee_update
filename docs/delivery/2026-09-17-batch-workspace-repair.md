# Sửa luồng Đợt đang làm — 17/09/2026

Phạm vi: sửa code và nạp API local, không đăng, đối chiếu hay mở bán Shopee. Người dùng tự thực thi.

## Đã thay đổi

- Workspace không tải toàn bộ imports/products/shops/plans/jobs mỗi 5 giây. Chỉ heartbeat nhẹ, parser đang chạy và hàng đợi đang xem; nguồn tải lại khi điều hướng/lưu. Đo cũ products 3.52 MB/lần.
- Tab đợt đang làm chỉ đọc khi đang mở; panel lịch sử cũ chỉ tải khi mở. Đọc batch không chồng yêu cầu, có timeout; backend gộp request danh sách đang chạy và đọc tối đa hai đợt cùng lúc.
- Điền nhanh có thời gian chờ, hủy tra cứu giữ input, giới hạn 6 phút. Hủy kết nối dừng các lần đọc Shopee tiếp theo, không liên quan hủy phép ghi.
- Giữ trang/tab sau reload; kết quả kiểm tra đặt nút chuẩn bị đợt ngay đầu kết quả và giải thích nút đăng ở cùng màn hình.
- Batch nhận biết nguồn hiện hành/cũ/lưu trữ, kiểm lại revision khi bắt đầu gửi với khóa nguồn/lifecycle. Nguồn cũ chưa gửi không được chạy; các mục hợp lệ khác có thể tiếp tục, trừ khóa shop hoặc yêu cầu chưa rõ kết quả.
- Có receipt bất biến loại từng mục CHƯA CÓ operation khỏi đợt; kiểm CAS/coordinator/lifecycle. Không xóa nguồn, manifest, journal hoặc link. Mục đã gửi/unknown không được loại. `excludedCount` tách khỏi hoàn tất; parent nhận `completed_with_exclusions`.
- Frontend có nút loại, mở nguồn mới để sửa, mặc định xem đợt chưa hoàn tất. Nguồn đã lưu trữ ở catalog không tự xóa bản nháp hoặc lịch sử đăng đã tạo.
- Trạng thái `/v1/status` giữ field legacy tương thích, thêm `statusScope` và `productionBatchWorkflow`; không đổi quyền executor cũ.

## Kiểm có giới hạn

- 60 ca unit autofill/metadata đạt, gồm hủy giữa lần đọc.
- 3 ca lifecycle tập trung đạt; 3 ca UI fixture mới đạt: không poll nguồn nặng, giữ trang sau reload, hủy giữ lựa chọn, loại nguồn cũ không publish.
- Typecheck/build đạt. Quan sát UI thật đã có nút Loại khỏi đợt này và Mở nguồn mới nhất để sửa.
- API local đọc được 12 đợt, không unavailable; 30 mục có thể loại tại thời điểm kiểm, không mục đang chạy. Không thực hiện loại thật hoặc dispatch để kiểm thử.

## Giới hạn còn thực tế

- Công việc Hương Thảo / 45417908562 đã tạo link, chưa đối chiếu xong, vẫn giữ lane shop. Không tự xóa hoặc coi đã hoàn tất; người dùng tiếp tục công việc cũ ở ứng dụng.
- Ảnh/nguồn đã bị giữ vì thiếu đúng dữ liệu vẫn giữ cảnh báo. Lưu trữ nguồn không hủy lịch sử bất biến; loại khỏi đợt là thao tác riêng cho mục chưa gửi.
- Guard lưu trữ trong persistence chưa giải phóng quan hệ preparation đã đăng ký khi chỉ loại một mục; nút loại khỏi hàng đợi hoạt động, nguồn gốc vẫn được giữ.
- Chưa nghiệm thu đăng thật sau bản sửa này. Không báo mọi listing đã đủ điều kiện đăng.
