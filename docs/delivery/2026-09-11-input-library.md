# Kho đầu vào và phục hồi đợt nhập — 11/09/2026

## Kết quả theo yêu cầu

Thay trang Tệp nguồn và nút thêm tệp hỗn hợp bằng **Kho đầu vào**. Bảng giá dùng chung được quản lý riêng; Word và ảnh được nhận theo thư mục của từng listing. Nhân viên nhập một hoặc nhiều thư mục, chọn nguồn giá một lần, đối chiếu hình rồi mở lại đúng đợt để làm tiếp. Giữ nguyên nội dung, ảnh, SKU và cấu trúc do doanh nghiệp chuẩn bị.

### Giao diện

- **Bộ listing:** các đợt đã lưu kèm số thư mục/tệp/bộ hoàn thiện, nút Tiếp tục xử lý; bên dưới là những bộ listing đã tiếp nhận. Tìm theo tên đợt hoặc tên/SKU của bộ đã hoàn thiện.
- **Bảng giá chung:** chỉ nhận `.xlsx`, có tải nhiều workbook và thử lại từng tệp. Tra giá theo trang tính/bộ giá/SKU, phân trang 50 dòng thay vì cắt mất các dòng sau giới hạn hiển thị cũ. Nút Dùng cho đợt mới giữ rõ workbook đã chọn; không tự đổi nguồn của đợt cũ.
- Các tệp cũ chưa biết quan hệ nằm trong mục thu gọn để đối chiếu. Không đoán chúng thuộc listing nào và không tự chuyển nguồn Lamy sang cấu trúc thư mục giả định.
- Lựa chọn ảnh, Word, cách đọc Word và nguồn giá được lưu tự động sau khi nhận nguồn. Chờ **Đã lưu vào Kho đầu vào** trước khi đóng trang. Mở lại không tải lại tệp đã nhận; tệp còn thiếu phải chọn đúng thư mục gốc để xác minh.
- Nút nhập mới tạo một đợt mới. Quay về đợt đang xử lý và mở lại bản đã lưu là thao tác riêng. Mất mạng hoặc xung đột có trạng thái rõ, không hiển thị đã lưu khi kết quả chưa xác nhận.

### Lưu dữ liệu

Migration `004_input_batches.sql` thêm đợt nhập, phiên bản bất biến, quan hệ với tệp gốc và định danh listing ổn định trong đợt. Metadata của tệp giữ đường dẫn tương đối, tên, số byte, SHA-256 và mã tệp đã nhận; không lưu File giả hoặc thay bytes gốc để phục hồi.

Một lần lưu là một transaction. Phiên bản mong đợi bảo vệ sửa đồng thời; cùng yêu cầu gửi lại không tạo thêm phiên bản, yêu cầu cũ khác nội dung nhận xung đột. Khi mất phản hồi, client gửi lại đúng yêu cầu chưa biết kết quả trước khi gửi lựa chọn mới. Lỗi xác thực 400/422 cho phép sửa dữ liệu rồi thử lại; 409 giữ trạng thái xung đột, không tự ghi đè.

Máy chủ kiểm nguồn tồn tại, SHA/kích thước/loại tệp, Word/ảnh thuộc đúng thư mục, bộ giá thật trong workbook, tính ổn định và duy nhất của mã listing. Khóa ngoại giữ nguồn của lịch sử đợt. Danh sách chỉ lấy số lượng/metadata; mở đợt mới tải các nội dung đã đọc. Bộ đọc tệp cũng được sửa để lấy nội dung đầy đủ khi danh sách bản nhập trả `body:null`, và giữ SHA của tệp lỗi để thử lại đúng bản gốc.

API nội bộ mới: `GET /v1/input-library`, `GET /v1/input-batches`, `GET /v1/input-batches/:id`, `POST /v1/input-batches`. Không thêm lời gọi Shopee hoặc quyền ghi shop.

## Kiểm chứng

- `scripts/verify.mjs` hoàn tất **2026-09-11T05:59:01.979Z**: kiểm kiểu, build, **7 legacy**, **163 unit/integration** trên 21 tệp đạt. Có 11 kiểm thử kho đầu vào trên PostgreSQL thật với schema cô lập, 7 kiểm thử hàng đợi lưu/phục hồi, kiểm nội dung đầy đủ của tệp đã nhận. Sau chỉnh đồng bộ nguồn vừa nhập, kiểm kiểu được chạy lại và E2E tiếp tục đạt; build cuối được cập nhật trước bàn giao.
- **32/32 E2E**, bắt đầu **2026-09-11T05:59:34Z**, thời gian **93,55 giây**, không fail/skip/flaky. Gồm **12 ca đọc local thật** và **20 ca fixture trình duyệt chặn ghi**. Phục hồi hai thư mục kiểm đúng Word, giá, thứ tự ảnh và định danh; không upload lại. Có thử lỗi lưu, xung đột và server lưu thành công nhưng trình duyệt mất phản hồi.
- Ảnh desktop 1440px/mobile 390px của kho đầu vào và đợt phục hồi đã kiểm không tràn ngang; tại `.local/e2e-artifacts/input-library-*` và `input-batch-restored-*`. Các đợt trong ảnh phục hồi là fixture, không phải nguồn sản phẩm doanh nghiệp.
- Migration 004 đã áp vào DB phát triển. API được khởi động lại; lúc **13:00 UTC+7**, readiness đạt, worker online, một bộ `lamy-5d` revision 1 với 6 SKU, 8 ảnh sản phẩm và 9 ảnh mô tả. Kho thật có một workbook, chưa có đợt mới và một tệp cũ chưa gắn quan hệ. `productionWrites:false`, executor chưa cấu hình.

## Giới hạn còn lại

- Lưu đợt chưa thay thế việc lưu riêng màn hoàn thiện SKU/nội dung/ảnh. Phần sửa trong Editor chưa lưu vẫn không phục hồi sau tải lại trang.
- Không tự nhìn ảnh để suy ra SKU/phân loại; không nhận diện mọi bố cục Word, gộp/tách listing hoặc tự sửa nguồn.
- Mã bộ ổn định khi mở lại cùng đợt. Nhập cùng sản phẩm vào một đợt mới vẫn có thể trùng về mặt nghiệp vụ; chưa có đối chiếu toàn cục qua mọi lần đổi nguồn. Chưa có giao diện thay toàn bộ thư mục bằng phiên bản nguồn mới.
- Chưa có chạy lại worker cho nguồn đã xử lý thất bại, lưu tất cả listing bằng một nút, phân trang danh sách toàn kho hoặc đo tải 24 giờ. Mức tối đa 5.000 tệp trong hợp đồng lưu không phải kết quả benchmark.
- Ngành/thuộc tính/tồn/vận chuyển, executor, cập nhật, QC, Flash Sale và production vẫn chưa nghiệm thu. A4 tiếp tục `in_progress`.

Cơ sở: yêu cầu trực tiếp của người dùng về thư mục listing/bảng giá chung; `AGENTS.md` và hai `AGENT_GUIDE.md` Shopee tại máy. Đợt này không đưa ra kết luận chính sách Shopee mới. Xem [hướng dẫn nhân viên](../runbooks/listing-workspace.md).
