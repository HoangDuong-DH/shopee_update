# Giao diện vận hành cho nhân viên nội bộ — 11/09/2026

## Kết quả

Tiếp nối bản redesign cùng ngày, thay phần nhập dài và lựa chọn ảnh toàn kho bằng quy trình theo công việc. Nhân viên tiếp nhận bộ listing đã chuẩn bị; không phải tự đặt mã nội bộ, hiểu định dạng TSV hoặc tìm chức năng trên nhiều màn hình.

- Ba bước tiếp nhận: **Nguồn giá → Phân loại đã chuẩn bị → Kiểm tra**. Nhập SKU/nhãn từng ô; dán Excel là lựa chọn phụ. Dữ liệu được đối chiếu đúng nguồn giá, giữ nguyên chữ, khoảng trắng, thứ tự và cấu trúc 0–2 nhóm. Không tự sinh tổ hợp hoặc suy SKU thuộc một listing từ bảng KINI.
- Mã theo dõi tự sinh một lần cho bộ đang nhập; giữ cùng mã khi quay lại và phục hồi. Lưu phần tiếp nhận chưa xong trong `sessionStorage` có phiên bản, với lựa chọn tiếp tục hoặc nhập bộ khác. Không lưu khóa/token hoặc tệp gốc trong bộ nhớ này. Việc khôi phục chỉ áp dụng phần nguồn giá/SKU của bước tiếp nhận; nội dung/ảnh đang sửa vẫn phải lưu trước khi rời trang.
- Nội dung, Bộ ảnh và SKU/phân loại thành ba mục riêng. Bộ đã lưu vẫn mở chỉ đọc. Cấu trúc bộ đã nhận được khóa như bản trước; chỉ mở sửa nội dung/ảnh bằng hành động rõ ràng.
- Chọn ảnh qua hình thu nhỏ theo vai trò bìa, gallery, mô tả hoặc từng SKU. Chỉ ảnh đã gán được hiện mặc định; người dùng tự mở kho để chọn thêm, sắp xếp hoặc bỏ ảnh. Không crop, viết lại, thay nguồn hoặc tự gán theo tên tệp.
- Word cho chọn khoảng đoạn cụ thể và xem trước trước/sau trước khi áp dụng vào tiêu đề/câu mở đầu/phần chữ. Giữ chữ và dòng trống bằng phép nối LF; không biến đoạn nhiều dòng thành tiêu đề một dòng. Bố cục/ảnh nhúng Word và liên kết provenance theo từng đoạn chưa được hỗ trợ đầy đủ.
- Tải Excel/Word/ảnh tại đúng bước. Theo dõi từng tệp, tải tiếp các tệp khác khi một tệp lỗi và thử lại riêng tệp chưa nhận bằng đúng bytes đã chọn. Tệp được nhận và tệp đã được worker đọc xong là hai trạng thái khác nhau. Retry có chốt chặn trùng thao tác và khóa hai chiều với việc lưu nguồn.
- Màn kiểm tra có **Việc tiếp theo** dẫn thẳng đến Nội dung/Bộ ảnh/SKU. “Đã có nguồn” không phải đạt chính sách hoặc sẵn sàng đăng; phần ngành/tồn/vận chuyển/thực thi chưa có được ghi riêng.
- Lỗi yêu cầu có thông báo tiếng Việt hướng đến việc cần làm. Mất kết nối không được diễn giải chắc chắn là thao tác ghi thất bại; nhắc kiểm tra bản đã lưu. Mã lỗi tải tệp nằm trong phần dành cho người hỗ trợ.
- Có **Hướng dẫn sử dụng** ngay trong app, với nút bắt đầu nhập bộ mới hoặc mở listing đã có, cùng cách xử lý tệp lỗi và phần chưa lưu.

## Kiểm chứng

- `scripts/verify.mjs` đạt: typecheck, build, **7/7 legacy** và **125/125 unit/integration** trên 17 tệp kiểm thử; dùng PostgreSQL thật với schema cô lập. Báo cáo riêng tại `.local/verification.json` và `.local/test-results.json`.
- **22/22 E2E trình duyệt** đạt, 63,914 giây, bắt đầu 2026-09-11T03:18:44.673Z. Không fail, skip hoặc flaky. Gồm **12 ca trên workspace/kho kiến thức local thật** (chỉ đọc server, có sửa chưa lưu trong trình duyệt) và **10 ca fixture** có phản hồi/ghi bị chặn trong trình duyệt. Fixture không đi tới backend hoặc Shopee.
- Đã kiểm luồng ba bước, bảng hai tầng giữ đúng SKU/giá/nhãn nguyên văn, thay bảng qua dán Excel, khôi phục sau tải lại, quay lại từ nội dung giữ nguồn/SKU, bỏ sửa bộ đã lưu không xóa bộ khác, lỗi lưu giữ nội dung, khóa lưu khi retry tệp, gửi lại đúng bytes của riêng tệp lỗi, Word bắt buộc xem trước/ap dụng và giữ dòng trống, nhảy đúng phần từ bảng kiểm.
- Đã nhìn ảnh chụp desktop 1440px/mobile 390px của bước nhập, bảng kiểm, phần ảnh và hướng dẫn. Chín góc chụp không tràn ngang trang; thêm E2E kiểm hình phân loại hiển thị trên mobile. Đã sửa lỗi tên tệp dài làm thẻ ảnh rộng quá khung. Bằng chứng riêng: `.local/ux-capture-evidence.json` và `.local/e2e-artifacts/`.
- Đọc cuối từ local API: `lamy-5d` vẫn **revision 1, 6 SKU, 8 gallery, 9 ảnh mô tả**. Worker online; `productionWrites:false`, `listingExecutor:not_configured`. Không thay nguồn hoặc đăng thêm sản phẩm để làm phép thử UI đạt.

Phép thử local và browser fixture không phải bằng chứng đã đăng backend Shopee, kiểm QC hoặc chạy tải production.

## Phạm vi còn lại

Không thay nguồn Lamy, dữ liệu giá/tồn hoặc shop thật. Không thêm gọi OpenAPI, không mở executor và không thay bảo vệ server ở đợt này. App vẫn chạy tại `127.0.0.1:5173`, không phải triển khai LAN/production hoặc chạy tự động 24 giờ.

Cần tiếp tục các task A2–A4/B/C/E: nhập trọn bộ đa cấu trúc, ánh xạ cột/ngành/thuộc tính theo shop, nhập tồn và vận chuyển, đối chiếu item/model, token rotation, đăng/cập nhật hàng loạt, đọc lại kết quả, QC và đo tải. A4 vẫn `in_progress`.

Mã nội bộ không phải chứng minh duy nhất một sản phẩm trên Shopee: bộ mới có mã khác vẫn có thể là cùng sản phẩm thực tế. Nhân viên nên mở bộ đã có trong danh sách thay vì nhập lại. Cơ chế chống trùng link trên sàn thuộc phần executor chưa hoàn tất.

## Cơ sở

- Yêu cầu người dùng: ứng dụng nội bộ dành cho cả nhân viên nontech; bộ listing/nội dung/ảnh do doanh nghiệp chuẩn bị, giữ nguyên.
- `AGENTS.md` và `docs/superpowers/specs/2026-09-11-prepared-listing-publishing.md`.
- Đã đối chiếu hai `AGENT_GUIDE.md` trong kho Open Platform và Học viện VN (bản chụp 08/09). Đợt này chỉ thay UX và giữ dữ liệu local, không đưa ra giới hạn/policy Shopee mới hoặc suy quyền shop từ ví dụ tài liệu.
- [Hướng dẫn nhân viên](../runbooks/listing-workspace.md).
