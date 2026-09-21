# Luồng đăng hàng từ nguồn đã lưu đến kết quả Shopee

## Mục tiêu đã được người dùng giao

Hoàn thiện luồng hiện có để nhân viên nhập bộ listing đã chuẩn bị, dùng lại ánh xạ Word/ảnh/SKU và bảng giá chung, bổ sung đúng ngoại lệ rồi đăng bằng API. Không tạo lại nội dung, đổi sản phẩm, mặc định tồn hoặc chuyển ngành để vượt điều kiện. Ưu tiên giảm thao tác và giảm số lần đọc API lặp lại. Đây là phần tiếp nối thiết kế và việc triển khai đã được chấp thuận, không khởi tạo một hệ thống khác.

## Phương án

Tiếp tục dùng `ListingDraft` đã lưu có phiên bản làm nguồn chuẩn hóa. Một bước chuẩn bị production nhận ID nguồn, phiên bản và thông tin vận hành do nhân viên chọn; server đối chiếu tệp/giá rồi đóng băng hồ sơ thực thi. Không yêu cầu nhân viên làm JSON hoặc nhập lại nội dung Word. `PreparedBatch` mô phỏng và các pilot lịch sử giữ phạm vi cũ.

Không chọn phương án chỉ tăng số lượng trong manifest PASS1: nó vẫn để nguyên công việc ráp nguồn bằng script. Cũng chưa thay toàn bộ các journal bằng một framework hàng đợi mới: cần tận dụng biên nhận và chống gửi lặp đang được kiểm thực tế.

## Đường đi của dữ liệu

1. Kho đầu vào nhận thư mục và bảng giá; nhân viên xác định quan hệ SKU/ảnh chưa rõ. Lưu một `ListingDraft` cho mỗi bộ, giữ nguồn và thứ tự.
2. Chọn các nguồn đã lưu và đúng kết nối shop. Bước chuẩn bị dùng ID/revision và dữ kiện có nguồn; chỉ bổ sung nhóm thiếu như ngành, thuộc tính, kiện và tồn.
3. Server kiểm từng nguồn riêng, trả ngoại lệ có tên trường và nguyên nhân. Đóng băng nguồn đủ điều kiện với chữ ký băm và quyết định thao tác. Nguồn chưa đủ không được đánh dấu đã gửi.
4. Mỗi nhóm thực thi dùng journal hiện có. Metadata dùng bộ nhớ đệm hữu hạn đúng shop/phiên bản; giới hạn nhạy cảm luôn đọc mới. Phép ghi và đọc lại kết quả không dùng dữ liệu đệm.
5. Ảnh hoặc cân nặng Shopee xử lý khác được hiện trực tiếp để đối chiếu. Chấp nhận phải gắn đúng operation, nguồn và giá trị đã đọc, chỉ lưu phiếu nội bộ. Nút tiếp tục dùng lại operation, không tạo listing lần nữa.
6. Kết quả báo riêng đã tạo ẩn, đã mở bán đối chiếu đạt, chưa gửi, bị từ chối, chưa rõ kết quả và cần bổ sung.

## Ranh giới bắt buộc

- Production hiện được người dùng cấp quyền thử trên shop 1423724897 / partner 2010476. Cấu trúc nguồn mới không tự mở quyền ghi shop khác.
- PASS1 cũ, 28 ACK của item 53267854751 và hai pilot đã verified không được thay đổi hoặc phát lại.
- Phiếu cân nặng PASS1 đang chờ người dùng; triển khai màn chấp nhận không đồng nghĩa đã chấp nhận.
- 777/772 giữ yêu cầu bảng kích cỡ, không tạo bảng giả hoặc thay ngành.
- Giữ source fact và byte ảnh; so khớp bảng giá đúng SKU/sheet/bộ giá. Tồn 0 là giá trị hợp lệ, thiếu tồn là ngoại lệ, không bù tồn tự động sau đơn hàng.
- Các trường hiện chưa có codec (video, bảng kích cỡ, compliance hoặc định danh đặc biệt) phải được giữ và báo chưa hỗ trợ, không âm thầm bỏ khi chuyển nguồn.
- Sau timeout của phép ghi phải phục hồi bằng biên nhận/đọc lại; không dùng retry chung cho POST.

## Kiểm nghiệm

Kiểm độc lập lớp chuyển nguồn, nguồn bị sửa, sai ô giá, nhầm shop, thiếu ảnh, 0/1/2 tầng, tồn 0, nhóm thiếu thuộc tính, cache đổi revision/hết hạn, kết quả chấp nhận bị thay, bấm hai lần, mất phản hồi trước/sau server nhận. Chạy luồng HTTP/DB/worker với nguồn mô phỏng tách biệt và chặn mạng Shopee, sau đó đọc thật metadata để đo số request/thời gian. Mọi phép ghi production cần đúng nguồn đã được chốt. Không lấy số test phần mềm để tuyên bố nhiều shop hoặc chạy 24 giờ đã nghiệm thu.
