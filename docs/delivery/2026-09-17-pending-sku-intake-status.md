# 17/09/2026 — Hiển thị đúng bảng SKU đã nhập và hướng dẫn vai trò ảnh

## Vấn đề và thay đổi

Người dùng nhập lại Nhap_01 từ bộ nguồn v4. Đọc chỉ trạng thái local của đợt `d8665ab1-8a79-4a17-b375-ef846c55cf47` xác nhận bộ Nước Lau Sàn Hương Quế có đủ sáu SKU trong bảng chờ, nhưng chưa xác nhận cấu trúc. Giao diện vẫn lấy lỗi thiếu membership của bộ ghép thông thường để hiển thị, tạo hai thông báo thiếu SKU không đúng: trên đầu bộ và trong tab SKU.

- Khi đã nhận bảng pending, hiển thị số phân loại và số ô thiếu SKU thật; không hiển thị hai thông báo fallback của đường không có bảng.
- Nút “Xem bảng phân loại” mở đúng tab. Vẫn phải xác nhận cấu trúc và khớp đúng bảng giá trước khi tiếp tục.
- Đổi nhãn “Ảnh sản phẩm” trong phần nhập thư mục thành “Bộ ảnh đầu trang”. Giải thích riêng ảnh phân loại được gắn với SKU trong trình soạn listing.
- Nêu rõ tên file mới là gợi ý: nút “Điền vị trí trống theo tên” mới áp dụng các gợi ý vào phần chưa chọn. Không tự thay lựa chọn tay hoặc tự gán số ảnh thành số thứ tự SKU.

Không tự điền ảnh, xác nhận cấu trúc, sửa bộ nguồn, lưu đợt của người dùng hoặc gửi Shopee. Không reload tab người dùng; Vite cập nhật giao diện.

## Kiểm tra

- 11/11 ca giao diện nhập thư mục đạt sau thay nhãn, gồm giữ chọn tay, bỏ chọn/lưu/mở lại, thứ tự, lỗi lưu, xung đột và mất phản hồi.
- 2/2 ca bảng pending đạt: đủ sáu SKU không báo thiếu nguồn; thiếu một SKU vẫn chặn đúng, kể cả sau mở lại. Test mới bắt được nhánh fallback trong tab SKU còn sót và đã kiểm lại sau sửa.
- Typecheck và build web đạt ngày 17/09. Build còn cảnh báo kích thước bundle; không phải lỗi build.
- Toàn bộ phép ghi trong các ca UI được fixture chặn, không đi đến DB ứng dụng hoặc Shopee.

## Giới hạn còn đúng

18 hồ sơ ghép sẵn khác với 27 bảng chờ xác nhận. Đủ SKU không chứng minh đủ ảnh, thuộc tính, quyền ngành hoặc điều kiện vận chuyển. `variationImageCandidates` trong các bảng nguồn hiện chưa được chuyển thành ảnh từng SKU bởi parser pending; không nói rằng chức năng này đã tự điền toàn bộ. Hướng dẫn đăng lô phải phân biệt chuẩn bị bản nháp với thực thi API, và nêu rõ ngoại lệ cần xử lý.
## Hướng dẫn bằng ảnh đã giao

- `output/huong-dan-dang-hang-loat-api/HUONG_DAN_DANG_LO_API.html`: 15 bước, ảnh giao diện thật, mũi tên đỏ dựng bằng SVG trong tài liệu, phóng to và đánh dấu tiến độ; tự chứa ảnh để mở ngoại tuyến.
- `Anh_huong_dan/01.png` đến `15.png` và `HUONG_DAN_DANG_LO_API.zip`.
- Nguồn nhập trong ảnh là Nhap_01 thật, DORIS thật. Các bước lưu của phiên chụp bị chặn vào bộ nhớ; không thay đợt đang dùng của người dùng. Ảnh chuẩn bị/gửi lô là fixture 3 listing có nhãn minh họa, không phải kết quả đăng thật.
- Kiểm 15 ảnh tải đủ, phóng to/đánh dấu/điều hướng đạt, không tràn ngang ở 390px, không có lỗi JavaScript. Ảnh 05–09 đã chụp lại đúng chế độ chỉ dùng g ở bộ ảnh đầu trang; mô tả không có ảnh.
- Hướng dẫn phục vụ tại `http://127.0.0.1:5184/` bằng tiến trình Node 80104 (chỉ bind loopback); bản HTML/ZIP vẫn dùng độc lập được. Helper `.local/operator-guide-20260917/serve-guide.mjs`.
- Phân biệt rõ: nhập bộ nguồn và lưu từng bản nháp; chọn nhiều bản nháp; kiểm tra và đăng ký lô; cuối cùng người dùng bấm “Đăng ẩn các listing đã chuẩn bị” để ghi qua API. Các bộ chưa đủ ảnh/thuộc tính/quyền chưa thể tự động vượt điều kiện.
- Đã đọc 45 sidecar hiện tại: tất cả ID nguồn trống/null. Nguồn có ID phải là luồng cập nhật; đường đăng mới chặn. Đường cập nhật chưa có production executor tương đương, không hướng dẫn người dùng xóa ID để tạo mới.
- Audit `.local/operator-guide-20260917/pending-variation-image-audit.md`: 880 vị trí có một ảnh ứng viên, 192 có hai, 14 chưa có. Parser đang bỏ các ứng viên này; hướng dẫn nêu đúng giới hạn, chưa triển khai gắn ảnh hàng loạt từ candidate.
