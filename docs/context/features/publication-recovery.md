# Đăng và phục hồi

Chỉ thực thi operation đã đăng ký, đúng quyền người dùng, source revision và scope. Khởi động app, đọc context hoặc phục hồi tệp context không resume batch. Các công việc đã tạm dừng vẫn tạm dừng.

Trước ghi đọc toàn bộ trường của đúng item; sau ghi đọc lại trường đổi và phần phải giữ. ACK không phải QC. Nếu phản hồi thiếu/trễ hoặc kết quả unknown, đối chiếu request receipt và trạng thái từ xa trước quyết định retry; không tạo lại hoặc bù tồn để đoán kết quả.

Lưu checkpoint với operation ID và đường biên nhận để phiên mới tìm đúng journal, không chứa raw credentials/payload. Chỉ tuyên bố hoàn tất khi có bằng chứng tương ứng, tách fixture với Shopee thật.
