# Kết quả nghiệm thu bộ nguồn 80 listing — 14/09/2026

**Luồng 80 thư mục → 80 listing đã đạt trong môi trường mô phỏng có trạng thái. Production chưa được nghiệm thu.** Trình duyệt, API nội bộ, PostgreSQL, bộ đọc tệp, lưu bản nguồn/WorkOrder, hàng đợi và đọc đối chiếu là mã ứng dụng thật. Phía nhận listing là bộ mô phỏng riêng, không phải Shopee.

## Kết quả đã đo

| Phép thử | Kết quả |
|---|---|
| Nhập 80 thư mục | 80 Word, 440 ảnh, một Excel chung; 521 tệp, 13.707.590 byte |
| Tạo mới | 80 bản nguồn đầy đủ, 80 WorkOrder, 80 listing mô phỏng; 80/80 đọc lại đúng |
| Phạm vi | 200 SKU; ba shop với 27/27/26 listing; bốn ngành; 32 listing không tầng, 24 một tầng, 24 hai tầng |
| Cập nhật từng nhóm | 9/9 nhóm đạt: tiêu đề, mô tả, bìa, gallery, ảnh phân loại, giá gốc, tồn bán, thuộc tính, vận chuyển |
| Cập nhật giá và tồn cùng lúc | 12 listing ở ba shop; 12 model đổi đúng, 24 model không chọn và 68 listing khác giữ nguyên |
| Nguồn lỗi | Sáu thư mục bị chặn riêng; thư mục hợp lệ bên cạnh vẫn thực thi thành công; cả lô vẫn báo còn lỗi |
| Ghi thiếu model | Giữ `unknown` sau hai lần đọc đối chiếu; không gửi lại lệnh và không báo thành công giả |
| Gửi lại / mở lại | Không tạo listing trùng; giữ định danh nguồn và biên nhận |
| Kiểm tra độc lập | 521 tệp gốc không đổi; 544 blob đã lưu khớp hash; không có yêu cầu ra mạng ngoài |

Nguồn cập nhật là các Word/ảnh/Excel phiên bản mới có dữ liệu thực sự khác. Kết quả được so với các tệp này, đồng thời so toàn bộ phần không chọn và mã model, không chỉ với payload do bộ thực thi tự dựng.

Phép thử thư mục hợp lệ cạnh sáu thư mục lỗi tạo **một listing mô phỏng bổ sung**, tách khỏi lô chính. Tổng cuối của bộ kiểm thử là 81 listing mô phỏng; không dùng số này để thay kết luận 80/80 của lô chính.

Luồng chính mất **90,425 giây**, gồm nhập, xử lý, thao tác giao diện, tạo mô phỏng và kiểm tra kết quả. Toàn bộ 15 ca browser/API/DB mất **172,152 giây**. Đây là thời gian tại máy trên bộ nguồn khoảng 13,7 MB, không phải tốc độ Shopee, thử tải ảnh lớn hoặc ước lượng công suất đăng 24 giờ.

## Các lỗi đã phát hiện và sửa

- Nhóm vận chuyển từng bỏ sót cân nặng/kích thước. Phép so với Excel mới phát hiện dù bộ thực thi từng báo `verified`; nay cả nhóm được áp dụng và đối chiếu đủ.
- Trạng thái bền `unknown` được lưu trước khi gửi từng làm giao diện dừng theo dõi quá sớm. Nay yêu cầu còn giữ lượt xử lý hiện `running`; chỉ báo `unknown` khi thực sự cần đối chiếu.
- Yêu cầu không trả lời từng có thể giữ worker vô hạn. Đã giới hạn thời gian chờ; shop khác tiếp tục, không gửi lại yêu cầu có khả năng đã ghi. Việc giới hạn chờ không đồng nghĩa đã hủy một yêu cầu mạng ở phía nhận.
- Việc giữ một kết nối DB rồi lấy thêm kết nối trong cùng luồng từng có thể cạn pool khi nhiều người bấm chạy. Đã bỏ truy cập pool lồng nhau; kiểm tra phiên bản nguồn nằm cùng giao dịch đưa việc vào hàng đợi. Bốn lần gửi đồng thời đã qua thử với pool chỉ một kết nối.
- Sự cố giữa lưu đặt chỗ và lưu biên nhận từng có thể để lại phần việc không mở lại được. Nay lưu nguồn trước, phục hồi theo cùng mã lô và bản nguồn đã chốt; có thao tác hủy phần chưa gửi.
- Bổ sung kiểm tra từng thư mục trước khi lập lô, giữ dấu thời gian nguồn ổn định, kiểm đúng phạm vi thư mục, phân biệt tồn 0/ô trống và không tin kết quả công thức Excel cũ.

## Bằng chứng và kiểm tra

- 15/15 ca trình duyệt dùng API/DB/worker thật tại máy và bộ nhận mô phỏng đều đạt; không bỏ qua ca nào.
- Root kiểm mới: **490 unit/integration + 7 legacy đạt**, TypeScript và build đạt. Trong đó có 27 ca bộ thực thi, năm ca phục hồi nguồn/concurrency và năm ca đọc bảng điều phối.
- Sau sửa tràn ngang, **65/65 ca hồi quy trình duyệt cũ đạt** (tổng hợp lần đầu và lần chạy lại các file bị ảnh hưởng). **3/3 ca UI fixture** cho hủy, tạm dừng/tiếp tục và phục hồi mất phản hồi đạt. Cùng 15 ca mới, có 83 ca browser đã đạt ở các phạm vi riêng; không nhập bằng chứng fixture UI vào số lượng listing đã tạo. Báo cáo tổng hợp: `.local/acceptance-20260914/prepared-verification/final-verification.json`.
- Snapshot độc lập trước/sau cho thấy các bảng nguồn, phiên bản nguồn, WorkOrder, lần ghi Lamy và đợt nhập của ứng dụng chính không đổi. Migrations 012–013 chỉ bổ sung cấu trúc lưu cho luồng mới. Ứng dụng chính đang `mode: unavailable` cho bộ thực thi này; chưa có quyền ghi production.

Bằng chứng chính tại `.local/acceptance-20260914/business-batch/run-Mi6iLo/`:

- `browser-acceptance.json`, `final-audit.json`, `80-create-readback.json`.
- `80-verified-viewport.png`: ảnh giao diện từ lần chạy đạt.
- Các thư mục `update-*`: tệp nguồn mới và `before-desired-after.json`.
- `exception-execution.json`: một nguồn hợp lệ thực thi trong lô còn sáu lỗi.
- `database-before-cleanup.json`, `cleanup.json`: trạng thái riêng của bộ thử và xác nhận đã dọn schema/blob thử.

Bộ dữ liệu tải dùng lại: `.local/acceptance-20260914/prepared-delivery/Bo-du-lieu-thu-80-listing.zip`. Có hướng dẫn và Excel điều phối; toàn bộ là dữ liệu giả lập, không phải dữ liệu kinh doanh để đăng vào shop thật.

## Phần chưa được chứng minh

- `PreparedGateway` hiện là giao diện dữ liệu nghiệp vụ **chỉ cho mô phỏng**. Chưa có bộ chuyển đổi OpenAPI tổng quát cho luồng này; không suy ra rằng 80 payload đã được Shopee nhận. Bằng chứng sandbox backend trước đó nằm riêng ở `2026-09-14-live-backend-acceptance.md`.
- Chưa nghiệm thu live nhiều ngành/nhiều shop, upload ảnh/định danh ảnh qua OpenAPI tổng quát, quyền bìa/gallery/mô tả ảnh, QC và policy hiện hành của từng shop. Fixture metadata không phải chính sách Shopee.
- Bộ Excel/Word thử có cấu trúc rõ ràng. Chưa nghiệm thu mọi bố cục Word bất kỳ, mọi loại thuộc tính, video, thay ngành/thương hiệu/cấu trúc phân loại hoặc mọi trường listing. Chín nhóm cập nhật trong bảng trên là phạm vi được kiểm thử.
- Chưa nghiệm thu refresh token thực tế, worker chạy bền 24 giờ, triển khai nhiều máy, khuyến mại/Flash Sale hoặc tính sẵn sàng production.

Thiết kế và điều kiện nghiệm thu: `docs/superpowers/specs/2026-09-14-prepared-business-acceptance.md`. Không đổi nguồn sản phẩm hoặc giới hạn kiểm tra để ép các ca đạt.

Phản biện độc lập và các lỗi đã khắc phục: `docs/reviews/2026-09-14-prepared-business-review.md`.
