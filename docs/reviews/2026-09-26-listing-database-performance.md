# Đánh giá chỉ mục listing và tốc độ tra cứu (26/09/2026)

## Kết luận

Ý tưởng lưu bản đầy đủ đã đọc và một bản rút gọn để tra cứu nhanh là đúng, nhưng ứng dụng đã có cấu trúc này trong PostgreSQL. Không nên tạo thêm DB hoặc di chuyển dữ liệu lúc này. Vấn đề thực tế là phạm vi dữ liệu được đồng bộ, trạng thái kết nối, và việc phân biệt bản chụp lịch sử với trạng thái Shopee hiện tại.

## Bằng chứng tại máy

- `seller_knowledge_observations` giữ bằng chứng đọc Shopee bất biến, có hash nội dung và thời điểm đọc. `seller_knowledge_items` giữ một chỉ mục hiện hành theo `(connection_id, item_id)` gồm tên, SKU, ngành, trạng thái và liên kết đến bằng chứng đầy đủ.
- Shop `1423724897` có 130 listing trong chỉ mục, lần đọc mới nhất ngày 16/09/2026. Shop vinatuoi.vn `1126307464` hiện có **0 listing** trong chỉ mục này. Các operation production được kiểm tra không có bản ghi của shop `1126307464`, nên không thể coi chúng là nguồn thay thế cho bản đọc Shopee của shop đó.
- Với một kết nối DB cố định, truy vấn chỉ mục 40 dòng có trung vị **1,72 ms**, truy vấn kèm bằng chứng đầy đủ **3,18 ms**; PostgreSQL tự thực thi truy vấn kèm bằng chứng khoảng **0,70 ms**. Hai bảng chỉ mục và bằng chứng chiếm khoảng **2,8 MB** tổng cộng. Đo tại dữ liệu hiện có, không phải dự báo khi dữ liệu tăng lớn.
- Kết nối shop `1126307464` đang `refresh_unknown`; token lưu có thời hạn đã qua tại thời điểm đo. Không chạy lượt đồng bộ Shopee khi chưa xác định kết quả làm mới token.

## Hướng triển khai

1. Giữ PostgreSQL. Khi kết nối shop hợp lệ, chạy đồng bộ **chỉ đọc**, có checkpoint và tăng dần, để đưa listing của đúng shop vào hai bảng hiện có. Hiển thị số listing đã lưu và `last_seen_at`, không gọi bản chụp cũ là dữ liệu đang có trên Shopee.
2. Dùng chỉ mục cho tìm kiếm, lọc, mở lại công việc và gợi ý đối chiếu; chỉ tải bằng chứng đầy đủ khi mở chi tiết. Không dùng dữ liệu của shop khác để tự điền SKU, giá, ảnh hoặc phân loại.
3. Mọi thao tác ghi Shopee vẫn phải đọc mới đúng item/shop ngay trước ghi, so phiên bản/trạng thái, ghi có mã thao tác, rồi đọc lại toàn bộ trường liên quan. Chỉ mục không thay thế bước này.
4. Sau khi có dữ liệu thực của vinatuoi.vn, đo thời gian từng chặng: tra cứu DB, đọc Shopee, upload ảnh, validation, ghi và QC. Chỉ thêm index hoặc điều chỉnh truy vấn khi số đo chỉ ra nút thắt. Không thêm tầng cache, hàng đợi hoặc công nghệ lưu trữ mới chỉ để tránh vài mili giây DB.

## Giới hạn

Một bản chụp nhanh giúp tìm lại dữ liệu từng thấy, không thể chứng minh listing chưa bị nhân viên sửa trên Shopee. Giá, SKU, ảnh, video, trạng thái hiển thị và cấu trúc phân loại phải lấy từ bản đọc hiện tại khi chuẩn bị ghi. Không tự nạp hồ sơ lịch sử thành “trạng thái shop hiện tại” nếu chưa có bằng chứng đọc trực tiếp của chính item đó.
