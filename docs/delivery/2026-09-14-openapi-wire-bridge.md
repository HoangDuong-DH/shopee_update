# Kết quả nối lớp OpenAPI — 14/09/2026

Đã bổ sung mã gửi HTTP sandbox trực tiếp, bộ dựng yêu cầu theo tài liệu Shopee, kiểm tra metadata, nhật ký lưu từng lần gửi và kiểm thử bằng phản hồi HTTP có trạng thái. **Chưa bật luồng đăng nguồn doanh nghiệp trong ứng dụng chính; chưa nghiệm thu production.**

## Bằng chứng đã có

| Mức kiểm thử | Kết quả | Phạm vi |
|---|---|---|
| Nhập thư mục qua giao diện, kết quả từ lượt trước | 80 Word + 440 ảnh + Excel → 80 nguồn + 80 WorkOrder + 80 listing mô phỏng | API/PG/worker nhập thật; gateway nghiệp vụ giả lập |
| Gửi qua lớp HTTP mới | 80 lệnh add_item, 48 init_tier_variation, 80 kết quả đọc lại khớp nguồn | 3 shop giả lập, 4 ngành giả lập, 200 SKU; thay fetch bằng bộ nhận OpenAPI giả lập, không gửi qua mạng |
| Cập nhật HTTP | 9 nhóm riêng; thêm 12 listing cập nhật giá/tồn ở nhiều shop | So cả phần không chọn và mã model bằng phản hồi thô |
| Cập nhật thiếu model | Một công việc unknown; bước giá phía sau không được gửi; chạy lại không gửi lại stock | Cố tình chỉ cho một phần model thành công |
| Đọc Shopee sandbox thật | Shop info, giới hạn ngành, thuộc tính, thương hiệu, vận chuyển đều trả thành công | Shop 227418363, kết nối revision 6, ngày 14/09 |
| Ghi Shopee sandbox thật qua journal mới | Một patch tiêu đề cho mẫu kỹ thuật 803935036 đang UNLIST; đọc lại khớp tiêu đề và toàn bộ phần còn lại | Không tạo mới, không ghi Lamy hoặc shop production |

Lượt 80 HTTP dùng nguồn thử tổng hợp riêng, bao gồm ảnh phân loại được tác giả fixture chuẩn bị theo lựa chọn tầng đầu. 521 tệp gốc được đối chiếu hash và giữ nguyên. Đây **không phải** bằng chứng đã nối nguyên một luồng 80 thư mục qua giao diện tới 80 listing trên Shopee thật. Không sử dụng 13,903 giây chạy mô phỏng để dự báo tốc độ Shopee.

## Những lỗi được phát hiện và xử lý

- HMAC khác nhau giữa API Shop và Public upload; host và chủ shop bị giới hạn rõ. Không có transport production hoặc cơ chế tự thử lại lệnh ghi.
- API vận chuyển trả request ID ghép có dấu `:`. Bộ đọc ban đầu từ chối phản hồi hợp lệ; đã sửa và xác minh lại bằng API thật.
- Cần lưu item_id của add_item trước init_tier_variation và chờ ít nhất năm giây theo tài liệu. Tiến trình dừng sau một bước đã xác nhận chỉ tiếp tục bước chưa gửi; bước đã gửi mà chưa rõ kết quả không được chạy lại.
- Trong journal mới, thay token/phiên bản quyền không cấp một danh tính tạo sản phẩm mới. Ràng buộc nguồn/shop và kiểm kết nối tại giao dịch ghi nhật ký ngăn đường tạo trùng; việc hợp nhất khóa với executor cũ vẫn còn ở mục tích hợp bên dưới.
- Giữ đầy đủ phản hồi đã loại bí mật, bao gồm cảnh báo và thành công/thất bại từng model. HTTP200 hoặc acknowledgement không tự trở thành QC thành công.
- Ảnh phân loại riêng cho các SKU chung lựa chọn tầng đầu có thể không biểu diễn được. Bộ dựng yêu cầu chặn và chỉ rõ nguồn; không đổi cấu trúc hoặc thay ảnh.
- Patch tiêu đề sandbox trả phản hồi ghi chứa tiêu đề cũ; lần đọc ngay sau ghi cũng cũ. Lần đọc tiếp theo xác nhận tiêu đề mới và phần không chọn giữ nguyên. Đã thêm bộ đối chiếu chỉ đọc có giới hạn, yêu cầu hai lần khớp liên tiếp; không gửi lại patch để xử lý độ trễ này.

## Phần còn thiếu để bật ứng dụng thật

1. Nối nguồn nhập với ngữ cảnh vận hành có phiên bản: tình trạng hàng, preorder, GTIN khi bắt buộc, kho và thông tin phí vận chuyển. Chỉ yêu cầu phần thiếu; patch một trường không được bắt khai lại toàn bộ listing.
2. Tích hợp journal HTTP với worker và nguồn/binding của pipeline doanh nghiệp. Hợp nhất quyền giữ shop với executor kỹ thuật cũ; chưa cho hai đường ghi chạy cạnh tranh.
3. Đọc đối chiếu nguồn và snapshot từ Shopee trong pipeline thật, gồm cache tải ảnh và xử lý ID ảnh do Shopee thay đổi mà vẫn giữ bằng chứng. Không lấy dữ liệu dự kiến làm kết quả đọc lại.
4. Xác minh ngoại lệ metadata: phản hồi get_item_limit thực tế của ngành 301378 không trả `size_chart_mandatory`. Hai cờ hỗ trợ false không được tự đổi thành quy tắc “không bắt buộc” để ép create đạt. Tính năng giá còn phụ thuộc dữ liệu khuyến mại đang chạy/sắp chạy.
5. Nghiệm thu bằng nhiều kết nối sandbox thực tế, nhiều ngành thật; sau đó mới đánh giá phát hành production, refresh token và vận hành liên tục.

## Kiểm tra cuối cùng

Lượt kiểm tra tổng hoàn tất lúc **13:32 ngày 14/09/2026 (UTC+7)**: **652/652 unit/integration, 7/7 kiểm tra extension cũ, kiểm kiểu và build đều đạt**; không có test bỏ qua. Bộ này chạy sau khi đã sửa lỗi timeout đọc lại, đối chiếu phần giữ nguyên và kiểm tra khóa cơ sở dữ liệu. Hai lượt kiểm tra trước có lỗi được giữ riêng trong hồ sơ; không dùng kết quả trước sửa để báo đạt.

Kiểm tra dữ liệu chính sau lượt tổng xác nhận hash của nguồn, các phiên bản, WorkOrder, đợt nhập và run sandbox cũ không đổi. Nhật ký HTTP mới có đúng **một operation, một yêu cầu ghi** tới canary nêu trên; workspace có **một kết nối sandbox thực tế**. API sẵn sàng và giao diện trả HTTP200 tại lần kiểm tra cuối. Các bài kiểm tra trình duyệt của lượt nhập thư mục trước được dẫn riêng, không cộng vào 652 hoặc gọi là đã chạy lại với bridge mới.

Kết quả này nghiệm thu các mô-đun và tình huống đã liệt kê. **Chưa nghiệm thu ứng dụng đăng hàng loạt hoàn chỉnh qua nguồn nhập → worker → Shopee thật.** Giới hạn đó vẫn hiện trong ứng dụng; không mở nút thực thi bằng cách bỏ các điều kiện còn thiếu.

## Hồ sơ

- [80 thư mục tại tầng ứng dụng](2026-09-14-prepared-business-acceptance.md).
- [Hợp đồng HTTP và giới hạn bộ giả lập](../reviews/2026-09-14-wire-fixture.md).
- [Phản biện bridge](../reviews/2026-09-14-direct-bridge-audit.md).
- [Đối chiếu API, ngày nguồn và các điều kiện](../research/2026-09-14-prepared-wire.md).
- HTTP80: `.local/acceptance-20260914/prepared-wire/run-mY5s0W/wire-acceptance.json`; có biên nhận, payload, đọc lại và hash tệp; schema thử đã dọn.
- Probe thật: `.local/acceptance-20260914/wire-bridge/2026-09-14T05-56-40.201Z/readonly-probe.json`.
- Patch thật: `.local/acceptance-20260914/wire-bridge/title-canary/intent.json`, `journal.json` và `result.json`; operation `8bb19101-220b-4693-af7b-4fcf85aca6c3`. `journal.json` lấy biên nhận từ cơ sở dữ liệu; `result.json` chứa hai lần đọc khớp liên tiếp. **Không gửi lại operation này.**
- Kiểm tra tổng: `.local/acceptance-20260914/wire-bridge/verification/final-verification.json` và `final-unit-results.json`; dữ liệu được bảo toàn tại `main-data-audit.json` cùng thư mục.

Migrations 014–015 đã áp dụng local. Các file trong `.local` chứa bằng chứng riêng của workspace, không commit tự động. Nguồn Shopee chính thức trả HTTP403 khi đọc bằng công cụ web ngày 14/09; không gọi lần đọc đó là xác minh lại policy. Metadata shop được xác minh riêng bằng các API đọc như trên.
