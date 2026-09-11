# Bàn làm việc đăng hàng theo ngoại lệ

Người dùng ngày 11/09 cho phép triển khai lại theo đánh giá thẳng thắn đã thống nhất; tiếp tục giữ nội dung/ảnh/SKU đã chuẩn bị. Cho phép tạo mock data để kiểm thử. Không cần hỏi lại lựa chọn thiết kế đã giao cho agent.

Màn chính là các công việc theo bộ nguồn và shop. Một nguồn có mã ổn định và phiên bản; một công việc chọn rõ bản nguồn, shop, đăng mới hay cập nhật link có sẵn và những trường sẽ thay đổi. Kho dữ liệu là nơi hỗ trợ, không dẫn nhân viên qua một chuỗi chọn tệp lặp lại.

Ngoại lệ phân biệt: dữ kiện nguồn chưa có; dữ kiện có nhưng cần xác định mapping; kết nối cần xử lý; tính năng chưa hỗ trợ; nguồn hoặc bản Shopee đã thay đổi. Không biến tính năng thiếu trong app thành việc yêu cầu người dùng nhập lại nguồn.

Luồng nhận chính là thư mục Word/ảnh cùng bảng giá dùng chung, đúng cách bàn giao hiện tại của công ty. Hồ sơ bàn giao là lựa chọn phụ do ứng dụng xuất từ bộ đã xác nhận, giúp dùng lại nhãn, thứ tự, SKU, vai trò ảnh, cách lấy nội dung và nguồn giá. Không yêu cầu nhân viên tự soạn JSON; không suy SKU từ hình, gộp/tách listing hoặc thay nguồn để đạt test. Cập nhật nguồn gắn với mã listing cũ bằng quyết định rõ và bản xem khác biệt. Hồ sơ hiện chỉ tham chiếu tệp trên cùng máy chủ, không chứa nguyên bộ ảnh/Word.

Luồng sandbox dùng lại Lamy 803934364 trên shop 227418363: lấy thông tin listing/model bằng backend, kiểm đối chiếu nguồn, xem trước đúng trường yêu cầu, lưu ý định bất biến và cập nhật có kiểm baseline; đọc lại để đối chiếu. Chỉ bật phạm vi đã triển khai và kiểm được. Production giữ chỉ đọc. Tạo mới cần nguồn khác được phép và đủ dữ liệu; dữ liệu mô phỏng chỉ là fixture, không được đăng vào shop.

Nghiệm thu: dữ liệu doanh nghiệp hiện có giữ nguyên, không yêu cầu nhập lại thông tin rõ; nguồn mới không tự tạo trùng bộ; công việc thiếu bị phân loại đúng; chọn rõ shop và trường cập nhật; phát hiện drift và xử lý kết quả ghi chưa biết; không tuyên bố QC hoặc toàn bộ ngành đã đạt. Mẫu giả lập đại diện không phân loại/một tầng/hai tầng, ảnh trùng tên, nguồn thiếu, mapping mơ hồ, thay phiên bản, nhiều shop, gián đoạn. Đo thao tác bằng bài kiểm thử task thực tế và ghi rõ chưa có thử với nhân viên nếu chưa thực hiện.
