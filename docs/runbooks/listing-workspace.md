# Sử dụng không gian listing nội bộ

Giao diện cập nhật ngày 11/09/2026 theo yêu cầu tiếp nhận listing đã chuẩn bị. Địa chỉ tại máy: http://127.0.0.1:5173/. Bản hiện tại hỗ trợ nhập và đối chiếu nguồn; bước gửi/cập nhật Shopee chưa mở.

## Với bộ Lamy đã nhập

1. Mở **Listing của tôi**, bấm tên bộ Lamy.
2. Xem ảnh bìa, ảnh sản phẩm, bảng sáu SKU cùng GIÁ GỐC và giá bán mục tiêu. Phần mô tả giữ chín ảnh đã chọn.
3. Bấm **Đối chiếu nguồn** để xem nội dung và phân loại. Mặc định chỉ đọc. Tab **Bộ ảnh** cho xem vai trò và thứ tự ảnh.
4. Nếu có thay đổi nội dung/ảnh cụ thể, bấm **Điều chỉnh nội dung và ảnh**, sửa đúng phần rồi **Lưu & xem trước**. Lưu tạo phiên bản nội bộ, không thay listing trên Shopee. Danh sách SKU và cấu trúc phân loại vẫn bị khóa.
5. Chọn **Shop đích** tại màn kiểm tra chỉ khi cần lưu bản kiểm tra theo shop. Đây là ngữ cảnh cho đăng mới, chưa phải lệnh đăng. Cập nhật link đang có cần luồng định danh item/model riêng chưa phát hành.

## Với listing mới bên bạn đã chuẩn bị

1. Trong **Tệp nguồn**, thêm Excel, Word và ảnh gốc. Có thể chọn nhiều tệp. Chờ thông báo đọc xong; nếu upload bị ngắt, ứng dụng chỉ rõ tệp dừng và số tệp còn lại.
2. Về **Listing của tôi → Nhập listing có sẵn**. Dùng mã bộ ổn định do bên bạn quản lý; không đặt mã khác để nhập lại cùng bộ.
3. Chọn đúng file giá, sheet và bộ giá. KINI có dòng trùng SKU theo bộ giá; không mặc định mọi dòng cùng tên là cùng listing.
4. Chọn cấu trúc không phân loại/một nhóm/hai nhóm theo nguồn. Dán bảng gồm SKU và nhãn phân loại nguyên văn từ tài liệu listing, mỗi SKU một dòng, cột cách nhau bằng Tab. Không dán hàng tiêu đề. Ứng dụng không tự tạo tổ hợp hoặc đặt tên phân loại từ tên sản phẩm trong bảng giá.
5. Bấm **Đối chiếu với bảng giá**. Đọc các dòng khớp và giá nguồn, làm rõ các lỗi, xác nhận danh sách đầy đủ rồi tiếp tục.
6. Dán nội dung đã chuẩn bị, gán ảnh theo đúng vai trò/thứ tự. Hiện mô tả nhận bố trí câu mở đầu → dòng trống → ảnh mô tả → dòng trống → chữ còn lại. Chỉ chọn bố trí đó khi đúng nguồn. Bố trí khác cần bổ sung cách nhập, không ép dữ liệu vào mẫu này.
7. **Lưu & xem trước**. Mỗi bộ được lưu độc lập; giá đăng mới từ GIÁ GỐC, GIÁ BÁN chỉ là mục tiêu khuyến mại riêng.

## Khi có lỗi hoặc cần kiểm tra thêm

- SKU không có/khớp nhiều dòng: kiểm file, sheet, bộ giá và mã nguyên văn. Ứng dụng không chọn đại dòng đầu.
- Mã bộ đã tồn tại: mở bộ đã lưu; không ghi đè bằng một lần nhập mới. Mã khác vẫn có thể đại diện cùng sản phẩm thực tế, nên đây chưa phải chống trùng link trên sàn.
- Muốn thay thành phần SKU hoặc đổi cấu trúc bộ đã lưu: baseline hiện chặn. Cần bổ sung luồng thay đổi cấu trúc có đối chiếu riêng; không dùng sửa nội dung để làm việc này.
- Nguồn/giá thiếu, bố trí khác, ngành/thuộc tính/tồn/vận chuyển chưa kiểm: giữ trạng thái cần xử lý. Không sửa dữ kiện sản phẩm hoặc thay ảnh để vượt kiểm tra.
- Rời màn hình có dữ liệu chưa lưu: chọn **Ở lại** để tiếp tục hoặc **Bỏ thay đổi và rời đi**. Trong khi gửi yêu cầu lưu/tải tệp, đợi kết quả trước khi đổi màn hình.
- **Kết quả** tách bản kiểm tra nội bộ và hàng đợi. Một job đang chờ chưa chứng minh đã gửi API hoặc đã QC.
- Nút quyển sách mở **Tra cứu & kiểm tra**. Kết quả tra kho bản chụp không tự thành chính sách hiện hành hoặc xác nhận quyền shop.

Chưa có đăng hàng loạt, nhập trọn bộ tự động cho mọi cấu trúc, thuộc tính ngành động đầy đủ, cập nhật item/model, tồn thủ công trên UI, QC, Flash Sale hoặc vận hành 24h. Các phần đó thuộc kế hoạch thực thi tiếp theo.
