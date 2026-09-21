# Nối kho kiến thức với bản nháp — 16/09/2026

Mốc kiểm riêng lúc **09:03 UTC / 16:03 UTC+7**: đã nối gợi ý thuộc tính vào màn hình chuẩn bị lô, qua API, cơ sở dữ liệu và phiếu chấp nhận bất biến. Lượt này không đọc hoặc ghi Shopee, không đọc/ghi dữ liệu ứng dụng chính; kiểm tích hợp dùng schema riêng và phản hồi Shopee giả lập. Việc áp dụng migration030 vào ứng dụng chính do điều phối viên thực hiện riêng, không phải bằng chứng tính năng đã dùng trên shop thật.

Người vận hành đọc gợi ý cho đúng bản nháp/phiên bản/shop/ngành/thương hiệu, xem nguồn và hạn metadata, rồi chọn rõ trường đã xác nhận để dùng trong bản xem trước. Lịch sử listing không tự trở thành thông tin sản phẩm. Nguồn Word, ảnh và ListingDraft không bị sửa bởi các endpoint mới.

Phiếu chấp nhận khóa phiên bản và hash bản nháp, kết nối/revision, shop, ngành, thương hiệu, hash đề xuất, nguồn xác nhận, metadata và giá trị được chọn. Bản xem trước lưu cả phiếu trong tệp nguồn bất biến; trước khi tạo bản xem trước và đăng ký nhóm đều kiểm lại phiếu. Thay dữ liệu, hết hạn, đổi nguồn xác nhận hoặc thay giá trị đã chọn đều bị chặn. Mất phản hồi lưu có thể lấy lại đúng phiếu bằng cùng request, không tạo lệnh Shopee.

Thông tin xác nhận gắn listing có sẵn chỉ được xét nếu cả ID nguồn ghi ở bản nháp và lựa chọn nguồn thống nhất, toàn bộ SKU/model đủ và đúng, cùng shop/ngành/thương hiệu. Bản nháp ID trống không nhận các xác nhận này chỉ vì trùng SKU. Hai nguồn xác nhận mâu thuẫn bị chặn. Thuộc tính phụ thuộc được kiểm bằng đúng tập đã chọn, không dùng một trường chưa được chọn để giả định đủ điều kiện.

Kiểm riêng ổn định trước lượt kiểm tổng của điều phối viên:

- **69/69 unit/integration**, gồm 14 ca bridge mới, HTTP thực trong ứng dụng kiểm thử, 16 ca chuẩn bị lô, bộ biên dịch nguồn thật và các hồi quy KB hiện có.
- **10/10 browser fixture** cho màn hình chuẩn bị lô; gồm chọn nguồn rõ ràng, không chọn sẵn, lịch sử không được điền, phiếu đi vào preview và phản hồi chậm không ghi đè số đo mới sửa.
- Kiểm kiểu TypeScript đạt. Đây không phải số listing đã đăng, kiểm nhiều shop production hoặc nghiệm thu chạy 24 giờ.

Các giới hạn giữ nguyên: luồng đăng production hiện vẫn giới hạn shop pilot; KB có cách ly nhiều shop được kiểm bằng fixture. Không có lịch tự đồng bộ sau khi đăng. Sau mốc bridge, bước kiểm trước đăng đã được nối bộ kiểm chung cho cây thuộc tính con và free-text loại 3; xem [kiểm thuộc tính theo ngành hiện tại](2026-09-16-current-attribute-validation.md) để biết kết quả riêng. Bộ biên dịch nguồn chưa nhận mọi dạng object thuộc tính có nhãn hoặc nhiều giá trị tự nhập cùng ID 0; các dạng này vẫn bị chặn. Bằng chứng khả năng hỗ trợ media đang tái dùng operation đã verified, chưa phải một phép đo quyền whitelist mới. Bridge không nới các kiểm tra đó hoặc thay quyền của writer.

API nội bộ mới:

- `POST /v1/seller-knowledge/draft-recommendations`: `productKey`, `expectedRevision`, `connectionId`, `categoryId`, `brandId`; trả binding, đề xuất có giải thích, nguồn, coverage, metadata và fingerprint.
- `POST /v1/seller-knowledge/draft-acceptances`: cùng mục tiêu, thêm `requestId`, `recommendationFingerprint`, `attributeIds`; chỉ nhận đề xuất `product_source` đã xác nhận và đủ điều kiện.
- Entry chuẩn bị lô nhận `knowledgeAcceptanceId` tùy chọn. Phiếu không thay full live preflight của runner và không cấp quyền phát lệnh.

Tài liệu thao tác: [Gợi ý thuộc tính cho bản nháp](../operator-guides/goi-y-thuoc-tinh-cho-ban-nhap.md). Bằng chứng riêng: `.local/knowledge-draft-final-tests.json`, `.local/knowledge-draft-final-tests.log`, `.local/knowledge-draft-final-ui.log`, `.local/knowledge-draft-final-type.log`. Các log `*-red.log` giữ lỗi hồi quy trước khi sửa; không gộp lượt đỏ vào kết quả đạt. Kiểm bổ sung A→B→A của người rà soát được báo riêng sau mốc này.
