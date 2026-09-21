# PASS1 — việc cần người vận hành xử lý

Shop: **vuatinhdau.vn — 1423724897**. Cập nhật 16/09/2026. Đây là lô thử trên production; bộ nguồn vẫn được giữ nguyên.

## Hai bộ đang chờ

| Listing | Bộ nguồn để tra cứu | Tình trạng | Cần xử lý |
|---|---|---|---|
| Xịt Khử Mùi Tủ Giày VINA TƯƠI — 100ml, 300ml, 500ml | 777 / row-194 | Chưa tạo trên Shopee | Xác nhận ngành phù hợp và yêu cầu bảng kích cỡ |
| Xịt Khử Mùi Giày VINA TƯƠI — Giày Da Nam 100ml, 300ml, 500ml | 772 / row-192 | Chưa tạo trên Shopee | Cùng vấn đề với bộ xịt khử mùi tủ giày |

**Đã tìm được thương hiệu VINA TƯƠI, mã 1252097, trong ngành 100265 Khử mùi giày dép.** Vì vậy không cần đổi tên thương hiệu, chọn No Brand hoặc đổi ngành chỉ để tìm thương hiệu.

Lần đọc OpenAPI mới ngày 16/09 vẫn trả `size_chart_mandatory=true` cho ngành này; danh sách bảng của shop có **0 bảng**. Đây là yêu cầu bảng kích cỡ của ngành, khác với kích thước kiện hàng 12 × 12 × 28cm. Cho phép ước tính kiện hàng không giải quyết được yêu cầu này.

## Cách xử lý

1. Vào **Đăng hàng → Đợt đang làm → Đang giữ lại** để xem đúng hai bộ. Toàn bộ Word/nội dung, ảnh, 48 SKU, giá và tồn đã chuẩn bị; chưa có mã sản phẩm Shopee mới cho hai bộ này.
2. Kiểm tra ngành phù hợp với công dụng sản phẩm trong Seller Center. Nếu ngành đúng, kiểm tra yêu cầu bảng kích cỡ tại giao diện. Nếu giao diện và API khác nhau, ghi lại kết quả để đối chiếu với Shopee; không tự dùng bảng giày hoặc dung tích không phù hợp để vượt yêu cầu.
3. Nếu cần dùng ngành khác, xác nhận ngành theo sản phẩm thực tế và quyền shop. Ứng dụng phải tạo phiên bản quyết định ngành mới, tải lại thương hiệu/thuộc tính của ngành đó và kiểm lại trước khi đăng.
4. Nếu bạn hoàn tất đăng thủ công trên Seller Center, ghi **shop ID + item ID + bộ nguồn tương ứng** để đọc lại và đối chiếu. Không bấm đăng thêm cùng bộ trong ứng dụng. Hiện việc gắn kết quả đăng tay với bộ nguồn cần xử lý riêng; chưa có nút tự nhận mọi link đã đăng tay.

Bộ gửi API hiện chưa có codec bảng kích cỡ cho luồng PASS1. Có bảng hợp lệ vẫn cần bổ sung phần gửi và kiểm thử trước khi bật lại hai bộ. Ghi chú của người vận hành không tự bỏ qua điều kiện API.

## Dữ liệu đã chốt để giữ

- 16 mùi × 3 dung tích = 48 SKU mỗi bộ, đúng thứ tự nguồn.
- GIÁ GỐC trong bộ SHOP MALL của DORIS; tồn 100 mỗi SKU cho lô thử này.
- Cân nặng từ cột J: 130,9 / 322,3 / 503,8g. Cho phép Shopee lưu 131 / 322 / 504g trong phạm vi test đã được người dùng xác nhận ngày 16/09.
- Kiện hàng 12 × 12 × 28cm là ước tính cho test, sẽ bổ sung số đo sau; không phải dữ liệu từ DORIS.
- Bìa và ảnh phân loại giữ nguyên; gallery dùng trang Canva 2–10, trang 11 lưu riêng theo quyết định trước đó.

## Bằng chứng tại máy

- Đối chiếu DORIS: `.local/production-pass1-20260916/doris-weight-audit.json`.
- Yêu cầu ngành và số bảng đọc mới: `.local/production-batch-pass1-20260915/size-chart/4a8ca4d1-7645-420e-bf25-b66f707d522c/summary.json`.
- Request yêu cầu ngành: `e3e3e7f35b8fcb1764abd26c29e66100`.
- Bộ nguồn giữ lại: `.local/production-batch-pass1-20260915/manifest-held-777-772.json`, batch `4d653a20-c148-45de-b02f-dda6f2232e7b`.
