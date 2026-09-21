# Tiếp tục lô PASS1 trên production — 16/09/2026

## Quyết định mới

Người dùng cho phép dùng cân nặng/kích thước thử hợp lý để hoàn tất lô trên shop **1423724897 / vuatinhdau.vn**, sẽ bổ sung số đo sau; ưu tiên cột cân nặng khai báo DORIS. Các mục ngành/thương hiệu chưa giải quyết được được ghi chú để người vận hành xử lý. Không thay đổi nguồn hoặc bỏ qua điều kiện API chỉ bằng ghi chú.

Đối chiếu lại workbook gốc, SHA vẫn `2642c4182a41a39cb01b0acde0f70d5b1c8d50c8daba640c942c281bf5930750`: **48/48 SKU** của bốn bộ dùng đúng **J: CÂN NẶNG KHAI BÁO (G)**, không dùng I cân thực. DORIS 130.9 / 322.3 / 503.8g → Shopee lưu 131 / 322 / 504g; chênh lớn nhất 0.3g. Giữ số nguồn, chấp nhận sai khác bằng phiếu riêng. Kiện **12 × 12 × 28cm** vẫn là ước tính cho test đã được cho phép, không phải số đo đọc từ workbook.

Đã dùng kỹ năng bảng tính để kiểm nguồn, quy trình systematic-debugging để xử lý lỗi thực thi. Không áp bố cục của skill FILE MUA HÀNG NV sang workbook DORIS.

## Xịt thơm ô tô đã mở bán (mã nguồn 510)

- Item **53267854751**, 48 SKU, category **102572 Nước hoa xe**, brand **1252097 VINA TƯƠI**.
- Create operation `2c492b36-39d3-4536-92fa-6232e0efeb4e` giữ nguyên 28 ACK; không gửi lại create/init/upload.
- Weight review mới SHA `906309591d2ff4b240f9289b3be79461818f1bda86ea8dd72e8155b42b9bbd7c`, hạn `2026-09-17T01:41:07.204Z`, đúng 48 model/SKU và xác nhận ngày 16/09.
- HTTP execute `d67e9520-3361-4a99-8acb-52e41bbadf12` hoàn tất `2026-09-16T01:41:49.716Z`.
- Publication `0b003112-4929-4191-8fc0-aea9d7a1fa49` **verified**, một request mở bán `e3e3e7f35b8fc53298447bb9540cb600` lúc `01:41:47.012Z`.
- Hai readback **01:41:48.463Z / 01:41:49.537Z**, trạng thái **NORMAL**, đủ 48 SKU. Audit độc lập **266/266 đạt**, mọi trường được bảo vệ giữ nguyên ngoài trạng thái; giá, tồn 100, nội dung, 9 gallery, phân loại, ngành/brand đúng nguồn. Lane riêng 510 đã giải phóng.

## Xịt khử mùi thảm: sửa lỗi trước khi ghi (mã nguồn 775)

HTTP request `f79a420a-f560-4a2b-80d1-85c8c9a9bbe3` bị chặn `PRODUCTION_PILOT_STOCK_LOCATION_EVIDENCE_INVALID`, không tạo operation hoặc upload. Metadata collector mới lấy thời điểm sớm nhất của các lần đọc làm `observedAt`, trong khi guard kho yêu cầu lần quan sát kho không nằm sau mốc này. Trong ca thật: metadata `01:42:28.892Z`, stock `01:42:29.295Z`, chênh 403ms, cùng revision3, request ID hợp lệ, 48 mapping đúng.

Lỗi thuộc mốc thời gian tổng hợp, không phải thiếu dữ liệu kho trong nguồn. Đã sửa collector: `observedAt` là lần đọc mới nhất, nhưng `expiresAt` vẫn theo lần đọc cũ nhất cộng 15 phút. Hai kiểm thử hồi quy cold/warm session đi qua guard thật; dữ liệu hết hạn vẫn bị chặn. Không nới guard hoặc chỉnh bằng chứng cũ. 72 kiểm thử mục tiêu đạt; API đã khởi động lại trước lần gửi mới.

Kiểm tổng lúc **2026-09-16T02:01:21.972Z** đạt **1753/1753 unit/integration + 7/7 legacy**, typecheck/TS build/web build đều đạt. Bằng chứng `full-verification.json`, `full-test-results.json`, `full-verify.log` tại thư mục riêng ngày 16/09. Không cộng 17 browser fixture ngày 15/09 thành kiểm mới ngày 16/09.

### Đã đăng và đối chiếu hoàn tất

- Item **45467915350**, đủ **48 SKU**, operation `7d712c1c-9c92-4e85-8ece-96bd6a4f4ee7`. 26 upload + create + init đều ACK; không phát lại.
- Bìa case `76630d8e-b500-4a6f-8857-c22b55097978` verified bằng manual review của **Codex QA (agent)** sau hai agent xem PNG gốc/JPEG Shopee cùng 1024², bố cục và chữ giữ nguyên; không phải người dùng duyệt hoặc kiểm tính đúng của tuyên bố trên nhãn.
- Weight review SHA `0637f3c24ab11e165dd20c7dbdc6869114f2940b80c1ab5f1ec63150dc605b4e`, hạn `2026-09-17T02:04:24.765Z`, chỉ đúng operation/SKU/model này và quyền dùng cân nặng thử ngày 16/09.
- HTTP execute `2b7af2ec-30ec-4310-acf1-a4a1c7fc2efd` hoàn tất `02:05:29.062Z`; publication `a0ae5d7d-1dd2-4a43-8b08-bdfb4a7c47a7` **verified**, một request mở bán `e3e3e7f35b9019a1aaff2f8d31517800`.
- Hai readback **02:05:27.992Z / 02:05:28.868Z** đều **NORMAL / 48 SKU**. Audit độc lập **266/266 đạt**, các trường được bảo vệ giữ nguyên ngoài trạng thái; lane giải phóng. Bằng chứng `carpet-publication-audit.json/md`.

Batch ready `e60446aa-8fed-45e6-8cd8-52b0eee04a47` hiện **2/2 published**, không còn cho execute. Đây là hai nguồn ô tô/thảm; không gọi toàn PASS1 bốn nguồn là 4/4.

## Xịt khử mùi tủ giày và giày da nam: phần người vận hành xử lý

Đọc mới ngày 16/09 vẫn xác nhận ngành **100265 Khử mùi giày dép** yêu cầu size chart, shop có **0 bảng**. Thương hiệu **VINA TƯƠI 1252097** đã có bằng chứng danh sách ngành; không phải lỗi không tìm được brand. Hai nguồn vẫn chưa gửi, registry giữ nguyên. Bảng kích cỡ không phải kích thước kiện.

Đã có [phiếu việc cần xử lý tay](../operator-guides/pass1-viec-can-xu-ly-tay.md), nêu rõ bộ nguồn, bằng chứng, lựa chọn ngành cần xác nhận và cách ghi item ID nếu người dùng đăng tay. Chưa có tự đồng bộ kết quả đăng tay hoặc codec size chart cho PASS1.

## Kết nối và bằng chứng

Token được refresh một lần từ revision **2 → 3**, hạn mới **2026-09-16T05:38:40.316Z**. Receipt mã hóa tại thư mục credential-refresh của pilot; không in khóa/token. Chưa có lịch tự refresh liên tục.

Bằng chứng riêng: `.local/production-pass1-20260916/`, gồm `user-test-decisions.md`, `doris-weight-audit.json/md`, `510-weight-approved.json`, `510-publication-audit.json/md` và các biên nhận HTTP. Size chart mới: `.local/production-batch-pass1-20260915/size-chart/4a8ca4d1-7645-420e-bf25-b66f707d522c/summary.json`.

Hai request trước root gửi bị chặn hoặc đọc lại do thao tác đồng thời đã được lưu riêng: `21688aab…` thiếu kết nối, `5373ccd8…` đọc lại 510 trước approval. Không suy ra ai bấm từ nhật ký không có thông tin người gọi. Root không phát lại hoặc xóa request cũ.

Đọc GET độc lập lúc **02:08:11.330Z**, connection revision3, xác nhận cả bốn item đã đăng qua các lượt đều **NORMAL**: can 5L **51467852283 / 12 SKU**, Ngọc Lan Tây **51267858328 / 3 SKU**, xịt thơm ô tô **53267854751 / 48 SKU**, xịt khử mùi thảm **45467915350 / 48 SKU**. Đây là **4 listing / 111 SKU-instance**, gồm hai listing cũ và hai mới, không phải 111 SKU sản phẩm duy nhất. Không có mutation trong lần đọc này. File `status-read/e30ae4bc-7029-4c74-b6d5-b032e29682bb/summary.json`.

Người dùng yêu cầu gọi tên sản phẩm thay vì chỉ mã bộ. UI đã dùng title; thêm kiểm browser riêng **1/1 đạt** để mã nguồn `775` vẫn chỉ dùng cho request, tên sản phẩm được hiển thị. Bằng chứng `.local/production-workflow-20260916/product-name-results.json`. Registry cũ giữ nguyên như bằng chứng, kể cả ghi chú lịch sử có mã nguồn; không hardcode bảng đổi mã vào React.

API4310 PID22356, UI5173 PID23320 tại checkpoint; kiểm PID/job trước restart. Không nghiệm thu 80 listing thật, nhiều shop, mọi nhóm cập nhật hoặc chạy 24h. Hai nguồn giày còn cần người vận hành, nhập catalog604 vẫn chưa tự thành bộ đủ điều kiện đăng.
