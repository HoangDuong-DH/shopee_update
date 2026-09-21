# Nghiệm thu bộ nguồn 80 listing bằng mô phỏng có trạng thái

Phạm vi được người dùng yêu cầu ngày 14/09/2026: tạo dữ liệu thử đa dạng và hoàn thành kiểm thử 80 thư mục → 80 listing, nhiều ngành/nhiều shop; cập nhật từng nhóm trường và kiểm cả phần giữ nguyên. Quyền ghi vẫn chỉ ở sandbox đã xác định. Luồng này không được ghi shop thật.

## Hợp đồng nguồn

- Mỗi thư mục là một listing do người dùng chuẩn bị, có Word và ảnh gốc. Không sinh lại hoặc sửa nội dung khi xử lý.
- Word có nhãn `TIÊU ĐỀ` và `BÀI MÔ TẢ ĐĂNG BÁN`. Giữ nguyên ký tự, khoảng trắng, dòng trống. Mẫu mô tả tuân theo yêu cầu đã xác nhận: dòng mở đầu → dòng trống → đủ ảnh mô tả đúng thứ tự → dòng trống → phần chữ còn lại.
- Excel chung có sheet `Điều phối listing`, chỉ rõ thư mục, shop, sheet giá, ngành, thương hiệu, thuộc tính, vận chuyển, cân nặng/kích thước và đường dẫn vai trò ảnh. Danh sách ảnh là mảng JSON để tránh đoán dấu phân cách/tên tệp.
- Sheet giá riêng từng shop có SKU, GIÁ GỐC, GIÁ BÁN, thư mục, tồn bán, nhãn phân loại và ảnh phân loại. GIÁ GỐC dùng cho giá niêm yết; GIÁ BÁN giữ làm nguồn, không tự tạo khuyến mại. Tồn bằng 0 khác ô bỏ trống. Công thức phải được xuất thành giá trị có chủ đích trước khi nhập.
- Bìa 1:1 và gallery 3:4 là hợp đồng bộ nguồn đã xác nhận trong dự án, không phải tuyên bố mọi ngành/shop Shopee đều áp cùng quy định. Các mã shop/ngành/thương hiệu/thuộc tính và giới hạn trong fixture đều giả lập.
- Định danh listing lấy từ đợt nhập đã lưu. SKU giống nhau ở hai shop không hợp nhất; không tìm theo tên gần giống hoặc gán nhầm file ngoài thư mục.

## Luồng ứng dụng

1. Nhập Excel chung và toàn bộ thư mục qua giao diện hiện có, dùng bộ đọc Word/Excel/ảnh thật và kho blob theo hash.
2. Trang **Đăng theo lô** chọn đợt nhập, Excel và các thư mục; chọn đăng mới hoặc nhóm trường cập nhật.
3. Backend đối chiếu nguồn từng thư mục, lưu bản xem trước bất biến cùng dấu vân tay. Dữ liệu thiếu/mơ hồ hiện lỗi riêng. Nguồn đổi phiên bản làm bản xem trước cũ mất hiệu lực.
4. Khi chạy, lưu đầy đủ bản nguồn và WorkOrder theo đúng shop, rồi đưa công việc vào hàng đợi riêng. Mỗi shop có một lượt ghi đang xử lý hoặc chưa rõ kết quả. Shop khác vẫn có thể tiếp tục.
5. Tạo mới hoặc cập nhật chỉ phạm vi đã chọn. Mô phỏng cấp item/model ID độc lập và giữ trạng thái riêng theo chủ shop. Sau ghi, đọc lại toàn bộ dữ liệu, đối chiếu trường chọn lẫn trường cần giữ nguyên và định danh model.
6. Mất phản hồi sau ghi giữ `unknown`; khôi phục bằng đọc, không gửi lại lệnh. Gửi lại cùng ý định không tạo bản trùng hoặc bù tồn đã giảm vì đơn hàng.

## Ranh giới bằng chứng

Luồng mới dùng `PreparedGateway` ở mức dữ liệu nghiệp vụ chuẩn hóa. Browser, API nội bộ, PostgreSQL, bộ đọc file, lưu nguồn/WorkOrder, hàng đợi và đối chiếu là mã ứng dụng thật. Phía nhận listing là một hệ thống giả lập có trạng thái độc lập.

Đây **chưa phải** nghiệm thu mã chuyển đổi payload OpenAPI đầy đủ, upload ảnh lên Shopee, quyền thật nhiều shop/ngành, kiểm duyệt Shopee, token refresh, khuyến mại/Flash Sale hoặc chạy bền 24h. Không suy ra tốc độ Shopee từ thời gian mô phỏng. Ứng dụng chính không có gateway này nếu không được khởi tạo rõ ràng; chế độ chưa cấu hình không cho ghi.

Nghiên cứu API tiếp nối từ `knowledge-base/shopee-open-platform/AGENT_GUIDE.md`; chính sách VN từ `knowledge-base/shopee-uni-vn/AGENT_GUIDE.md`. Bản chụp 08/09/2026 không biến metadata giả lập thành policy hiện hành. Bằng chứng live riêng tại `docs/delivery/2026-09-14-live-backend-acceptance.md` không được nhập vào số lượng bài thử này.

## Điều kiện đạt

- 80 Word + 440 ảnh + 200 SKU thực, nguồn được đối chiếu hash, nội dung và kích thước.
- 80 draft, 80 WorkOrder và 80 listing mô phỏng đọc lại đúng; đủ 3 shop, 4 ngành và cấu trúc 0/1/2 tầng.
- Các cập nhật sử dụng file nguồn phiên bản mới, có giá trị thực sự đổi; không tính phép ghi lại cùng giá trị là bằng chứng update.
- Nhóm lỗi nguồn riêng không ảnh hưởng thư mục hợp lệ. Lỗi thực thi có kiểm thử độc lập về idempotency, mất phản hồi, dữ liệu thay đổi đồng thời, quyền/kết nối đổi, ghi thiếu model và thay đổi ngoài phạm vi.
- Kết quả có biên nhận, kiểm đếm độc lập và ngày chạy; không đánh dấu cả lô đạt nếu vẫn có phần chưa hoàn tất.
