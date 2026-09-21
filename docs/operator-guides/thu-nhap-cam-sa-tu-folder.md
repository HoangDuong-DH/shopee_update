# Tự thử Cam Sả từ thư mục đến đăng ẩn

Mở http://127.0.0.1:5173/. Bộ này đã có bản nguồn và nhóm đăng thử trong ứng dụng; nhập lại sẽ mở bản đã lưu, không tạo thêm bản sao. Chưa gửi Cam Sả lên Shopee tại mốc kiểm 16/09/2026 lúc 16:54 UTC+7.

1. Chọn **Kho listing → Nhập Word / ảnh / bảng giá → Nhập thư mục listing**.
2. Chọn **FILE GIÁ DORIS.xlsx → FILE GIÁ DORIS → SHOP MALL** ở ba ô bảng giá, sheet và bộ giá.
3. Bấm **Chọn thư mục listing**. Trong cửa sổ chọn thư mục, dán đường dẫn sau vào thanh địa chỉ rồi chọn thư mục:

   `C:\shopee_product_uploader\.local\Thu_nhap_Cam_Sa\10 Xịt Cam Sả`

4. Giữ **Thư mục này là một listing**. Bấm **Đọc các thư mục**.
5. Kiểm kết quả nhận diện:

   | Thứ tự | Phân loại | SKU |
   | --- | --- | --- |
   | 1 | 300ml | VTTDCS300 |
   | 2 | 100ml | VTTDCS100 |
   | 3 | 500ml | VTTDCS500 |

   Có một Word, một bìa, chín ảnh nội dung và ba tệp ảnh phân loại. Hồ sơ trong thư mục giữ sẵn cách ghép; không cần gõ lại SKU hoặc chọn lại ảnh đã được nhận đúng. Nếu báo sai tệp hoặc sai phiên bản, giữ thông báo để xử lý, không xóa hồ sơ để vượt kiểm tra.

6. Bấm **Mở bộ đã lưu**. Có thể xem Nội dung, Phân loại, Ảnh và nguồn giá. Nhập thư mục chưa đăng lên shop.
7. Sang **Đăng hàng → Đợt đang làm → Có thể tiếp tục**, tìm **Xịt Thơm Tinh Dầu Cam Sả** trong nhóm cùng Hoa Lài. Kiểm đúng shop **vuatinhdau.vn / 1423724897**, chế độ **Đăng ẩn để QC** và đã chọn hoãn QC ảnh.
8. Bấm **Kiểm tra listing này**, chờ kết quả. Sau đó tự bấm **Đăng ẩn listing này** để gửi API thật. Các lựa chọn lô thử đã lưu: GIÁ GỐC SHOP MALL, tồn 100/SKU, kích thước thử 12×12×28cm; cân nặng từ DORIS.
9. Nếu hiện chênh lệch làm tròn cân nặng, bấm **Xem chênh lệch cân nặng**, đọc bảng rồi chấp nhận nếu đúng. Bấm **Tiếp tục listing này** để hoàn tất chế độ đăng ẩn. Không tạo lại nhóm khi mất phản hồi.
10. Kết quả mục tiêu là **Đã tạo ẩn · Ảnh chưa QC**, có mã Shopee. Việc mở bán là bước riêng sau QC; bộ này không tự công khai.

Nếu kết nối hết hạn, làm mới tại **Kết nối shop** rồi tiếp tục chính nhóm cũ. Không gửi khóa hoặc token vào chat.

Đối với bộ hoàn toàn mới, sau khi đọc và hoàn thiện nguồn sẽ dùng **Đăng hàng → Chuẩn bị lô mới** để chọn shop, giá/tồn, ngành và thông tin chi tiết rồi xem trước/đăng ký nhóm. Cam Sả ở trên dùng nhóm đã chuẩn bị sẵn để tránh tạo trùng. Thư mục này chỉ dành cho Cam Sả; chín thư mục khác trong bộ V2 có vấn đề đối chiếu ID lịch sử và không thuộc bài thử nhập này.
