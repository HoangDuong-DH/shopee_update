# Kiểm nối ba bộ nguồn thật vào luồng tạo ẩn

Hoàn tất lúc **18:19:15 ngày 16/09/2026 (UTC+7)**. Đây là kiểm cô lập tại máy: byte nguồn thật, PostgreSQL schema riêng và OpenAPI mô phỏng trong bộ nhớ. Không dùng DB, API hoặc token ứng dụng chính; không gửi Shopee thật và không sửa runtime.

Nguồn được khóa theo gói **12 hồ sơ / 387 SKU** đã đóng băng, SHA ZIP `f1bab1ee52f94df236ff6bddaa83548679f4536b7ab0151783a142d58b6b7a8b`. Sau đó kho nguồn có thêm hồ sơ, nhưng chúng không nằm trong lượt kiểm này.

| Sản phẩm được kiểm | Nguồn thực | Kết quả nối dữ liệu | Kết quả với metadata giả lập |
| --- | --- | --- | --- |
| Xịt Tủ Giày Và Túi Đồ Tập VINA TƯƠI | 48 SKU, 10 ảnh gallery | Nhận nguyên byte → lưu intake → claim → draft → preview → manifest; giữ đủ 48 SKU và 10 ảnh | Planner chặn `item_image_count_limit` vì fixture cho tối đa 9 ảnh. Không cắt ảnh, không execute. |
| Nến Thơm Tinh Dầu Thơm Phòng VINA TƯƠI | 12 SKU, 9 ảnh gallery | Đạt cùng đường lưu và nạp manifest; giữ cấu trúc, giá và ảnh | Planner ready theo fixture; không execute mẫu này. |
| Xịt Thơm Hoa Lài VINA TƯƠI | 3 SKU, 9 ảnh gallery | Đạt đường lưu và nạp manifest, đúng thứ tự nguồn 500/300/100 ml | Đã tạo UNLIST trong mô phỏng, có hai core readback và phiếu hoãn QC ảnh; không mở bán. |

**Cả ba bộ vẫn bị chặn nếu chỉ dùng các lựa chọn vận hành hiện có.** Các trường còn phải chọn gồm ngành, thương hiệu, vận chuyển, kích thước, tình trạng hàng, preorder, kho và cân kiện. Cân từng SKU từ DORIS được giữ nguyên; nó không tự trở thành quyết định cân/kích thước kiện. Các giá trị dùng cho nhánh thử dương được ghi riêng trong `fixtureChoices`, không bổ sung vào Word, sidecar hay nháp nguồn thật.

## Những gì đã chứng minh

- **116 kiểm tra đạt**, lượt thành công mất khoảng 118 giây. Ba product và ba claim được tạo trong schema thử; lưu lại cùng nguồn trả đúng bản nháp cũ, không thêm revision.
- Worker nhập nguyên DORIS/Word/ảnh; app assembler, InputService, saveAssembledProduct, compiler, preparation và manifest loader chạy bằng mã thật. Khi thiếu lựa chọn, preview chặn 3/3; preview không tự đăng ký hoặc gửi.
- **37/37 đối chiếu artifact bổ sung đạt**: title, đoạn văn/khoảng xuống dòng, thứ tự tầng và chỉ số tầng, toàn bộ SKU/giá gốc, cân từng SKU, bìa/gallery/ảnh phân loại đều khớp nguồn và manifest. Hash tệp nguồn không đổi.
- Mẫu Hoa Lài qua ProductionPilotRunner và transport có ký request, được tiêm fixture không có network fallback: **11 upload ảnh + 1 create + 1 init**, sau đó **2 base reads + 2 model reads**. Có 13 bước ACK và một phiếu core readback hoãn ảnh; **không có phiếu QC ảnh đầy đủ, không publication**. Gọi tiếp operation không tăng số POST.
- Sau cùng schema thử được xóa; phần bằng chứng/tệp kết quả riêng được giữ lại. Không có DB main hoặc remote call.

## Giới hạn của kết luận

Đây là kiểm nối dữ liệu của **ba bộ/63SKU**, không phải12 bộ hoặc toàn46 bộ đã được đăng. Browser tương tác, collector metadata live, kiểm quyền thật và batch coordinator HTTP không chạy trong smoke này: phần đầu gọi trực tiếp app assembler/service; phần cuối nạp đúng listing từ manifest vào runner. Metadata ngành/brand/giới hạn/kho/quyền gallery và lựa chọn kích thước được ghi rõ là fixture. Giới hạn9 ảnh của fixture không được tuyên bố là giới hạn hiện hành của mọi shop/ngành.

Mẫu Hoa Lài hoàn tất phần tạo ẩn với **ảnh chưa QC** trong mô phỏng, không phải production verified hay được phép mở bán. Mẫu 48 SKU cần người dùng xử lý lựa chọn ảnh theo giới hạn thật nếu gặp cùng chặn; phần mềm không tự bỏ ảnh. Không phát hiện thêm P0/P1 trong lượt thành công; mã ứng dụng giữ nguyên.

**P2 về thông báo còn giữ:** preview ready của ba mẫu vẫn có 144/36/9 issue `DUPLICATE_SKU` mức `warn`, lấy từ cảnh báo parser về cùng mã xuất hiện trong nhiều bộ giá. Lựa chọn SHOP MALL đã được claim/compiler đối chiếu chính xác, nên các cảnh báo này không làm sai giá hoặc chặn chuẩn bị nhưng có thể gây hiểu nhầm sau khi đã chọn nguồn. Đã báo root; chưa sửa hoặc xóa issue nguồn trong lượt smoke.

**Bổ sung sau smoke — bản sửa thông báo:** đã thêm phép chiếu cảnh báo ở nháp mới, API đọc nháp, danh sách chọn nguồn chuẩn bị và kết quả compiler. Chỉ cảnh báo trùng đã được giải quyết bằng đúng import/dòng/sheet/bộ giá, dữ kiện có nguồn xác nhận và giá hợp lệ mới được bỏ khỏi phần hiển thị. Trùng trong cùng bộ giá, dòng/giá sai, nguồn chưa khớp hoặc cảnh báo khác vẫn giữ. Raw bảng giá, nháp lịch sử và `sourceSnapshot` không bị sửa. Kiểm lại ba hồ sơ smoke bằng byte gốc và repository fixture chỉ đọc đạt **168/168**: cảnh báo preview về0, document/SKU/giá/nội dung không đổi; thiếu lựa chọn vận hành vẫn có8 lỗi chặn mỗi mẫu. Hồ sơ tại `.local/vina-input-712-836-20260916/price-warning-smoke-recheck.json`; đây không phải chạy lại đăng hoặc đọc Shopee.

**Ngoại lệ nội dung do phản biện phát hiện:** mô tả **Xịt Thơm Hoa Lài** tại ô nguồn E194 có câu “Thành phần: cồn thực phẩm và tinh dầu tạo hương Hoa Hồng.” trong khi tên/SKU/ảnh là Hoa Lài. Smoke đã giữ nguyên câu này đúng mục tiêu bảo toàn nguồn; kết quả giữ đúng nguồn không chứng minh nội dung đủ điều kiện đăng. Chưa tự sửa thành phần, thay tên hương hoặc coi mẫu là publication-ready; cần xử lý quyết định nội dung có phiên bản riêng.

Lượt đầu đã đi qua49 đối chiếu nhưng dừng vì script kiểm riêng truyền thừa `documentSha256` vào `allowedSources` của runner. Zod strict từ chối đúng. Đã sửa shape trong script riêng, giữ report lỗi, rồi chạy lại toàn đường trong schema mới. Đây không phải sửa/nới guard runtime.

## Hồ sơ kỹ thuật

- Snapshot frozen: `.local/vina-input-712-836-20260916/ready-inputs-12-v1-receipt.json`.
- Kết quả chính: `.local/vina-input-712-836-20260916/backend-real-source-smoke-0d5db897-824a-4263-871d-376548184015.json`.
- Đối chiếu trường: `.local/vina-input-712-836-20260916/backend-real-source-field-preservation.json`.
- Log: `.local/vina-input-712-836-20260916/backend-real-source-smoke-rerun.log`.
- Tệp manifest, snapshot và raw fixture: `.local/production-batch-pass1-20260915/real-source-smoke-0d5db897-824a-4263-871d-376548184015/`.
- Lượt lỗi harness được giữ tại `backend-real-source-smoke-859726f0-dfc9-4452-a004-e75a620da9f0.json` trong cùng thư mục báo cáo.

Đọc cùng [kiểm chéo backend](2026-09-16-backend-crossflow-review.md) và [hướng dẫn vận hành](../operator-guides/dang-hang-tu-bo-listing-da-luu.md). Các kết quả fixture này không thay cho checkpoint triển khai/migration và biên nhận đăng thật trong ứng dụng.
