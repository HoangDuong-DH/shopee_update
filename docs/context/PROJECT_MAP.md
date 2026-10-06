# Bản đồ ListingStudio

ListingStudio là một ứng dụng modular: web React/Vite gọi API Nest/Fastify; worker xử lý nguồn; PostgreSQL lưu trạng thái nghiệp vụ; blob store giữ tệp riêng. Các package domain, persistence, shopee và agent-runtime dùng chung contract. Không cần thêm dịch vụ AI hoặc microservices để giữ context.

## Chọn tuyến công việc

`features.json` khai báo các chức năng, tài liệu ngắn, code, test và tài liệu chuyên sâu. Agent chọn feature theo yêu cầu thật, không suy từ một shop, brand hoặc ngành hàng cố định. Sửa manifest để mở rộng; dependencies được kiểm tra vòng lặp và đường dẫn.

- `shop-connections`: cấp quyền, callback, gia hạn và trạng thái từng shop.
- `source-intake`: nhận tệp và chứng minh nguồn ảnh/nội dung/SKU/giá.
- `listing-preparation`: phân loại, metadata và bản chuẩn bị.
- `publication-recovery`: đăng ẩn có journal, đọc lại và xử lý unknown.
- `archive-copy`: snapshot nguồn và sao chép theo shop đích.
- `media-quality`: sửa ảnh và đối chiếu phần phải giữ.
- `workspace-ui`: luồng sử dụng, đồng bộ UI với server.
- `setup-transfer`: cài mới, khởi động, chuyển máy và khóa riêng.
- `session-continuity`: ngữ cảnh, checkpoint và harness.

## Nguồn sự thật

Code/contract hiện tại → trạng thái nghiệp vụ trong DB → tệp nguồn và biên nhận → đọc lại Shopee khi thao tác từ xa. Checkpoint chỉ là chỉ mục công việc và quyết định, không thay thế các nguồn này. Tài liệu public không chứa dữ liệu vận hành; `.local/` là riêng cho máy này.

Chỉ đọc entry points/tests/runbooks được chọn khi câu hỏi cần chi tiết. Không đọc toàn bộ lịch sử, migrations, tài liệu Shopee hoặc tất cả payload API để bắt đầu.
