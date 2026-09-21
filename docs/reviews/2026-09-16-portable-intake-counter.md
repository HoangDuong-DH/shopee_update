# Bộ đếm thư mục mở lại bản nháp đã lưu

Ngày 16/09/2026. Xịt thơm Cam Sả có hồ sơ trỏ đến bản nháp phiên bản 1, nhưng Kho đầu vào hiển thị 0/1 vì bộ đếm tìm mã tạm của đợt nhập. Việc đối chiếu và mở bản đã lưu vẫn hoạt động; lỗi nằm ở số lượng hiển thị.

Bản sửa chỉ tính bộ có hồ sơ phiên bản lớn hơn 0 khi bản nháp mới nhất có đúng danh tính, phiên bản, ID listing nguồn, Word, ảnh và thứ tự, tầng/phân loại, SKU, ô giá và nguồn workbook. Chỉ tên mã bộ hoặc giá bằng nhau không đủ. Nguồn khác, thiếu ảnh, giá chưa xác nhận hoặc phiên bản đã đổi cho kết quả 0; không ghi đè nguồn, sửa nháp hay tạo biên nhận thực thi. Hồ sơ nguồn mới phiên bản 0 vẫn dùng claim hiện có, không suy hoàn tất từ mã tự khai.

GET danh sách dùng dữ liệu đã phân tích và hash lưu trong DB. Tối đa ba truy vấn: danh sách đợt, các import cần thiết được gom mã duy nhất, và các nháp mới nhất. Không đọc lại byte Word/Excel/ảnh trên đĩa; truy vấn ảnh không lấy body. Hai đợt dùng chung workbook chỉ nạp metadata workbook một lần trong yêu cầu.

Đã tái hiện ba lỗi trước sửa: bộ đúng bị tính 0, giá bằng nhau từ workbook khác bị tính 1, và ảnh gallery thiếu làm so sánh ném lỗi. Kiểm cuối chạy tuần tự: 12/12 hồi quy bộ đếm, 11/11 Kho đầu vào, 7/7 claim nguồn; kiểm kiểu và diff đạt. Một lượt chạy gộp trung gian gặp lỗi tệp cache Vitest trước khi hai suite bắt đầu; hai suite này đã được chạy lại riêng và đạt. Agent backend đọc độc lập hai guard nguồn giá/ảnh thiếu và cách gom truy vấn, không phát hiện blocker còn lại trong phạm vi này.

Các hồi quy trên dùng PostgreSQL cô lập. Kiểm tổng do root chốt lúc 12:03:33 UTC đạt 2057/2057 unit/integration, 7 legacy, typecheck và build. Biên nhận triển khai lúc 12:17:45 UTC ghi API PID 6608, health ready và 5 batch không bận. GET Kho đầu vào trả bộ Xịt Cam Sả có giá SHOP MALL là 1/1, trong khi bản chọn SHOP THƯỜNG vẫn 0/1; bản nháp giữ phiên bản 1. Bằng chứng `.local/hidden-manual-20260916/{verification-final-frozen.json,runtime-final-frozen.json}`. Lượt triển khai không ghi Shopee.

Những bằng chứng này chưa phải nhập toàn bộ thư mục 46 sản phẩm hoặc nghiệm thu hiệu năng trình duyệt với gói gần 3 GB. Agent review không gọi Shopee hoặc sửa DB ứng dụng chính.
