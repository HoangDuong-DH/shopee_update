# Đối chiếu SKU và giá sau khi tạo listing

Áp dụng cho bản nháp đã lưu. Bước này không sửa file nội dung, file giá, SKU, giá hay listing trên Shopee. Nó lưu riêng quyết định của người vận hành rằng từng tổ hợp phân loại đang dùng đúng dòng giá.

## Cách dùng

1. Nhập đúng phiên bản file giá mới nhất mà người dùng muốn dùng. Mỗi lần nhập được giữ bằng dấu kiểm SHA-256; file có cùng tên nhưng khác nội dung là phiên bản khác. Không tự chuyển từ phiên bản cũ sang bản mới.
2. Mở **Kiểm tra listing → Xem bảng đối chiếu SKU và giá**. Đọc từng tổ hợp, tên hàng trong bảng giá, SKU, giá gốc, bộ giá, ô SKU, ô giá và dấu kiểm file. Đối chiếu cả loại sản phẩm, mùi, cỡ và combo với nguồn thật.
3. Nếu có vấn đề, sửa nguồn hoặc chọn lại đúng dòng bảng giá ở phần đối chiếu nguồn, rồi mở lại bảng. Nếu file giá có SKU trùng trong cùng sheet/bộ giá, hệ thống chặn để người dùng xử lý; không chọn dòng đầu tiên.
4. Khi tất cả dòng đúng và không còn vấn đề, bấm **Tôi đã đối chiếu từng phân loại, SKU và giá nguồn**. Biên nhận chỉ gắn với phiên bản listing hiện tại. Lưu phiên bản mới cần xác nhận lại.

## Khóa và kiểm trước đăng

`listing_price_mapping_receipts` nối `(product_key, product_revision)` tới một lần duyệt. `listing_price_mapping_rows` nối từng `slot_key` của tổ hợp phân loại tới `(price_import_id, price_row_key)` của file giá đã nhập. `slot_key` là định danh nội bộ từ tên tầng và lựa chọn; nó không phải SKU được tạo thêm. Các dòng lưu ô Excel và SHA-256 để truy vết. Hai bảng có khóa ngoại và không cho cập nhật hoặc xóa biên nhận cũ.

Chuẩn bị lô và lần gửi production đều yêu cầu đủ biên nhận. Bộ đọc so lại dòng đã chọn với bản nháp, phiên bản file giá và giá trị trực tiếp trong ô Excel. Thiếu, trùng, lệch hoặc không đọc được nguồn thì chặn riêng listing và báo lý do. Nguồn nhập cũ vẫn tồn tại để tra cứu; không được tự coi là phiên bản mới nhất chỉ vì tên file giống nhau.

Lớp chặn này áp dụng cho luồng **Đăng hàng → Chuẩn bị lô mới → Gửi lô production** từ ListingDraft. Công cụ pilot lịch sử và các phép thử sandbox có nguồn/cổng riêng; không dùng chúng để thay cho bước đối chiếu của lô mới.

Biên nhận xác nhận lựa chọn của người vận hành, không chứng minh rằng tên hay giá trong file do người dùng cung cấp vốn đã đúng. Khi thấy chính nguồn có mâu thuẫn, giữ nguyên và yêu cầu người dùng sửa hoặc xác nhận nguồn phù hợp trước khi tạo biên nhận mới.
