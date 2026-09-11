# Mốc triển khai ứng dụng — 10/09/2026

## Kết quả thực tế

Đã chạy React/Vite, NestJS/Fastify, worker nhập nguồn và PostgreSQL 17 tại máy. Đã nhập workbook KINI và Word/16 ảnh Lamy qua HTTP API của app, xử lý nền, lưu revision 1 và kiểm trong trình duyệt. Chưa gửi yêu cầu ghi Shopee từ ứng dụng mới.

KINI đọc được 625 dòng theo khối/bộ giá, không phải 625 sản phẩm khác nhau: FILE 329, HIPP 56 (hai bộ giá), AVENTMALL 86, LAMY 69, RITEX 27, BEBE GROW 58. SHOP AVENT MALL chưa ánh xạ vì cấu trúc khác. Cột cân nặng lặp ở AVENTMALL vẫn bị đánh dấu mơ hồ; chưa có màn hình chọn lại cột cho trường hợp này.

Lamy giữ sáu SKU và giá gốc/mục tiêu từ LAMY K23:L28, 16 ảnh gốc, bìa 1:1, tám ảnh bộ listing 3:4 và chín ảnh content. Phần Word đọc nguyên bản có **một ký tự xuống dòng cuối cùng nhiều hơn** payload sandbox cũ; đã giữ nguyên nguồn Word, không âm thầm cắt để làm phép so sánh bằng nhau. Nội dung chữ và thứ tự ảnh đã đối chiếu. Không coi đây là đọc lại listing hiện tại trên sàn.

## Bằng chứng kiểm tra

- `.local/verification.json`: kiểm kiểu/build/legacy/unit/integration, gồm thời gian và mã thoát.
- `.local/test-results.json`: kết quả test dùng fixture; PostgreSQL thật với schema riêng.
- `.local/e2e-results.json`: ba phép thử đọc bộ Lamy trên Edge desktop/mobile.
- `.local/e2e-artifacts/lamy-preview-desktop.png`, `lamy-preview-mobile.png`: ảnh ứng dụng thực tế.
- `.local/source-import-verification.json`: nguồn, hash, vị trí ô, sáu SKU và số ảnh.
- Clean `npm ci` đã thực hiện trong `.local/clean-install` từ manifest/lockfile tại thời điểm kiểm. Bản cài báo 0 vulnerabilities; đây là kết quả audit dependency, không phải chứng nhận an toàn production.

Báo cáo chứa đường dẫn/tên tài liệu doanh nghiệp ở `.local` được giữ tại máy. CI dùng fixture và không yêu cầu bộ dữ liệu riêng.

## Những quyết định triển khai khác mô tả ban đầu

- Nest **Fastify adapter** thay Express/Multer: audit của adapter Express kéo Multer có cảnh báo chưa được khắc phục tại lúc cài. Upload dùng `application/octet-stream`, kiểm loại file ở worker. Đã kiểm qua HTTP thật trong integration.
- `readKini` trả **catalog rows với provenance**, không tự trả một listing mỗi hàng. Người vận hành nhóm các dòng bằng UI. HIPP giữ SHOP THƯỜNG / SHOP MALL riêng, không mặc định lấy cột đầu.
- Blob được công bố nguyên tử sau khi ghi đủ bytes; các lần nhập cùng hash dùng chung nội dung, kiểm hash khi đọc.
- UI không có đăng nhập nhân viên. Vẫn kiểm origin cho mutation, giữ scope, lưu token mã hóa ở server và chặn production write.
- Gateway hiện chỉ có API đọc shop; form token thủ công là cầu nối cho thử backend đầu tiên. Chưa hoàn tất callback authorization, refresh/CAS/recovery hay registry listing.

## Phần còn lại trước production

A2/A4 còn chọn cột mơ hồ/sheet tùy chỉnh và nhập tồn theo SKU/shop. A3 đã có transaction/idempotency nhưng lease/checkpoint của **listing worker** thuộc C1 chưa triển khai. Gói B phải hoàn tất gateway/token/capability, media và listing create/update/readback. Gói C–E chưa qua gate: phục hồi timeout/partial, QC, Flash/discount, agent/harness, backup restore, tải 10→30→80, soak 24h và pilot.

Mã trạng thái và nút bị khóa trong UI phản ánh đúng giới hạn này. Không có số liệu công suất đăng/ngày của app ở mốc hiện tại.

## Nguồn quyết định Shopee

- [API calls — Guide 16](https://open.shopee.com/developer-guide/16), cập nhật 21/11/2025, snapshot 08/09/2026: host, chữ ký HMAC, loại API và HTTP 200/error nghiệp vụ.
- [Authorization — Guide 20](https://open.shopee.com/developer-guide/20), cập nhật 24/07/2026 theo giờ VN, đối chiếu live trong nghiên cứu 10/09: scope/token, callback và refresh. App chưa triển khai toàn bộ hướng dẫn.
- [get_shop_info](https://open.shopee.com/documents/v2/v2.shop.get_shop_info?module=92&type=1), cập nhật 19/05/2026, đọc đầy đủ snapshot: dữ liệu shop ở cấp cao nhất của response, quyền/lỗi tương ứng. Một lần đọc thành công chỉ xác nhận khả năng đọc API này.
- Quy tắc giá, nội dung và tồn theo xác nhận người dùng trong [AGENTS.md](../../AGENTS.md); không tự áp mức tồn sandbox cho sản phẩm/shop khác.
