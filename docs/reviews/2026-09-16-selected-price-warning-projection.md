# Cảnh báo SKU sau khi đã chọn đúng nguồn giá

Ngày16/09/2026, smoke ba bộ nguồn thật phát hiện preview vẫn lặp144/36/9 cảnh báo trùng SKU mặc dù từng phân loại đã chọn đúng dòng SHOP MALL. Parser cảnh báo đúng ở cấp toàn workbook; lỗi hiển thị nằm ở việc chép nguyên cảnh báo này vào nháp rồi lặp lại trong preview.

Bản sửa chỉ bỏ cảnh báo đã được giải quyết khỏi phần hiển thị. Điều kiện là đúng import và row key, SKU duy nhất trong sheet/bộ giá đã chọn, SKU/giá có nguồn đã xác nhận, giá nguyên dương và dòng không có lỗi chặn. Cảnh báo cùng mã nhưng thuộc nguồn khác, trùng trong cùng bộ giá, row key mơ hồ, giá sai hoặc fact chưa khớp vẫn giữ. Các cảnh báo khác không bị lọc.

Các điểm đã nối: lắp nháp mới, GET danh sách/chi tiết nháp, thẻ chọn nguồn ở Chuẩn bị lô, và kết quả compiler sau khi kiểm lại workbook/ô giá nguyên. Không sửa bảng giá gốc, nháp lịch sử, source snapshot, fingerprint nguồn đã đăng ký hoặc quyền ghi Shopee.

Kiểm cuối sau hook context đạt **89/89 trong6 file**; gồm47 ca compiler/assembler/view,2 ca HTTP với PostgreSQL riêng,4 ca giữ dữ kiện khi sửa nháp,17 ca sidecar,14 ca folder và5 ca JSONB/Cam Sả. Typecheck và TypeScript build đạt. Hai ca HTTP đọc cả danh sách, chi tiết và context; sau đọc, draft/import trong DB riêng giữ nguyên. Reviewer độc lập đã đọc helper và toàn bộ chỗ hiển thị liên quan, không phát hiện blocker. Không cộng số này vào checkpoint kiểm tổng2026/2026 trước bản sửa.

Kiểm lại artifact của Xịt Tủ Giày Và Túi Đồ Tập, Nến Thơm và Xịt Thơm Hoa Lài đạt **168/168**, chỉ đọc file và dùng repository fixture tái dựng từ byte nguồn nguyên cùng thời điểm quan sát gốc. Preview hết cảnh báo đã giải quyết; thứ tự SKU, giá và document/source snapshot giữ nguyên. Mỗi mẫu vẫn có8 lỗi chặn khi thiếu lựa chọn vận hành. Không chạy DB chính, runner, API Shopee hoặc gửi listing.

Ngoại lệ nội dung Hoa Lài nhắc “Hoa Hồng” trong thành phần vẫn giữ nguyên để xử lý bằng quyết định nội dung riêng. Việc ánh xạ đúng không làm nội dung này trở thành sẵn sàng đăng.

Hồ sơ kiểm riêng:

- `.local/price-warning-red.json`, `price-warning-projection-red.json`, `price-warning-context-red.json`: tái hiện trước mỗi hook tương ứng.
- `.local/price-warning-final-reviewed.json`:89/89 sau review/context cuối.
- `.local/price-warning-typecheck-final.log`, `price-warning-build-final.log`: kiểm kiểu/build sau hook context.
- `.local/vina-input-712-836-20260916/price-warning-smoke-recheck.json`:168 đối chiếu artifact.

Xem [smoke nguồn thật](2026-09-16-real-source-hidden-smoke.md) để biết giới hạn fixture và checkpoint dữ liệu nguồn. Việc nạp API chính do root phối hợp sau khi cả bản sửa cảnh báo và bản sửa bộ đếm intake được chốt.
