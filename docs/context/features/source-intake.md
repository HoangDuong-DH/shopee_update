# Nhận và đối chiếu nguồn

Tệp Word, ảnh và bảng giá được nhập thành nguồn có provenance. Giữ ánh xạ đúng bộ, dòng/ô và revision; dữ liệu lịch sử chỉ hỗ trợ tìm nguồn, không tự duyệt dữ liệu mới.

Không mượn ảnh, suy SKU/giá hoặc lấp nguồn thiếu. Kiểm vai trò bìa/gallery/mô tả/ảnh phân loại độc lập. Những chỗ thiếu/mâu thuẫn giữ riêng theo tên sản phẩm, phần còn lại tiếp tục.

Source contract dùng khai báo cấu trúc riêng: số tầng, tên tầng, nhãn và tổ hợp. Thay cấu trúc phải tạo mapping và price proof phù hợp revision mới; không ghép SKU bằng vị trí UI. Cơ chế dùng chung mọi ngành hàng.

Worker giới hạn chung 120 giây cho đọc blob/phân tích, tách CPU vào thread cố định và chờ dừng thread trước chuyển tệp. Giới hạn byte/kết quả không cắt bớt nội dung. Mất hoặc không xác minh lease thì không ghi hoàn tất bằng quyền cũ. Deadline database cho claim/finish là giới hạn riêng.
