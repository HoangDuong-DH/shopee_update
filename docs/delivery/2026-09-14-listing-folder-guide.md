# Hướng dẫn thư mục tại Kho đầu vào — 14/09/2026

Theo yêu cầu người dùng, tab **Bộ listing** có thêm **Cách sắp xếp thư mục listing**, mở sẵn và thu gọn được. Cây thư mục minh họa các listing ngang cấp, Word, ảnh bìa, ảnh sản phẩm/mô tả và ảnh phân loại. Bảng giá chung hiển thị riêng, có nút mở đúng tab. Hướng dẫn phân biệt chọn một listing với chọn thư mục cha chứa nhiều listing.

Đã đối chiếu bằng agent đọc độc lập với `groupDirectoryFiles` và nhãn chọn trong `FolderIntake`: hỗ trợ Word/ảnh cùng cấp hoặc ảnh trong thư mục con; các listing phải nằm ngay dưới thư mục cha được chọn. Tên chỉ minh họa, không bắt đổi tên và không hứa tự nhận vai trò/thứ tự ảnh từ tên tệp.

Phạm vi mã: component `ListingFolderGuide.tsx`, CSS riêng và vị trí hiển thị trong `Resources.tsx`. Không đổi parser, API, cấu trúc dữ liệu hay tệp nguồn; không gọi Shopee.

Kiểm chứng cho thay đổi này:

- TypeScript check và web build đạt. Build vẫn có cảnh báo kích thước chunk đã tồn tại trước đó.
- Đã xem trực tiếp giao diện đang chạy, xác nhận hướng dẫn hiện sẵn, thu gọn/mở lại và nút **Mở Bảng giá chung** chuyển đúng tab.
- Đã quay lại **Bộ listing** và để sơ đồ mở. Viewport thực tế 677px, chiều rộng trang 677px: không tràn ngang ở kích thước được kiểm.
- Không viết thêm test tự động cho phần hướng dẫn tĩnh này; không lấy số kiểm thử ngày 12/09 làm kết quả chạy mới.
