# Phục hồi Lamy và màn hình thử sandbox — 14/09/2026

Lần gửi Lamy cũ đã được đối chiếu trạng thái hiện tại, giải phóng đúng khóa của lần đó bằng phiếu mới. Không sửa trạng thái hoặc nội dung bản ghi lịch sử, không gửi lại cập nhật Lamy. Production vẫn chỉ đọc.

## Bằng chứng phục hồi thật

- Shop TEST `227418363`, partner `1232297`, Lamy `803934364`.
- Run lịch sử `627e471b-2054-4af8-afc0-5a0a1cc63562` vẫn `unknown`, revision25, toàn bộ JSONB row không đổi.
- Phiếu `9e7a34b7-ad03-4248-b4d9-dba9cbf24c0a` lưu lúc **15:19:28 UTC+7**, verified; shared lane trả `false` cho busy.
- Hai lần đọc mới, mỗi lần gồm base/models; request IDs: `e3e3e7f35b6d17af0152ca4e0bdbf800`, `e3e3e7f35b6d17aed1c06722bc0bc800`, `e3e3e7f35b6d17b82a2f8473afdc5700`, `e3e3e7f35b6d17b83dc00f7ffc51e100`. Bước phục hồi không có POST Shopee.
- Mã bìa baseline `vn-11134201-81z1k-msxkncjjmayra9`; hiện tại `vn-11134201-81z1k-mszenf4uof0je1`. Phiếu ảnh `3d216c1a-dc86-40f3-b745-40175e095aa3`, hai agent xem đủ ảnh và lưu nhận xét nhãn **Codex QA (agent)**; không phải xác nhận của nhân viên hay khớp byte/pixel tự động.
- Baseline JPEG lấy từ bản lưu lịch sử, SHA-256 `93ce8de302bcfd98dd4cc6fe5a4c4714255c30dab4d2f699602a3cf0c07c5b7f`. URL lịch sử từng được dựng từ mã ảnh; không gọi đây là URL baseline API trả về. PNG nguồn gốc vẫn có SHA `71b9168ebeafab9d6426e855c9ebe3fdb4b2705a4efbbb5afacc6b028f4e4f13`. Ảnh hiện tại tải từ URL API vừa trả, SHA `cea37c559b0bf8729c43f91843ac4ff608b712a474ec64cdb52757009aa9eaf8`.

**Giới hạn bằng chứng:** basis `historical_projection_and_fresh_raw_stability`. So sánh các trường mà decoder lịch sử đã giữ, cộng độ ổn định raw của hai lần đọc mới; decoder cũ từng bỏ một số trường nên không tuyên bố đã chứng minh toàn bộ raw trước/sau của ngày11/09. Điều này không biến lần QC cũ thành pass.

Chi tiết riêng tại `.local/acceptance-20260914/legacy-recovery/`: `reconciliation-summary.json`, `reconciliation-result.json`, các observation/receipts/provenance và ảnh đầy đủ. Không chạy lại phép ghi lịch sử để tái tạo chứng cứ.

## Cơ chế và thao tác mới

Migration018 thêm bảng phiếu phục hồi chỉ ghi thêm. Khóa chung chỉ bỏ qua run có phiếu verified khớp **revision, input fingerprint và toàn bộ JSONB row**. Run khác hoặc bản bị thay đổi vẫn giữ khóa. CAS kiểm lại kết nối hiện tại, deadline đọc, ảnh đúng operation/shop/listing/vị trí/hash và thời hạn.

Ứng dụng có nút **Thử sandbox** ở đầu trang, dùng API backend thực tế cho listing kỹ thuật UNLIST `803935036`. Người dùng đọc sản phẩm → chọn tiêu đề hoặc tồn đăng bán → xem trước → xác nhận gửi một thay đổi → xem readback và kết quả các trường được giữ. Mở trang không gửi thay đổi. Chưa nối màn hình này với nguồn sản phẩm kinh doanh; đây là đường nghiệm thu kỹ thuật, không phải thay thế quy trình nhập theo thư mục/Excel.

Phiếu chuẩn bị lưu ID trước yêu cầu. Khôi phục bản xem trước dùng đúng ID/nội dung qua endpoint prepare idempotent. Bỏ bản xem trước dùng CAS chỉ chuyển prepared chưa gửi sang blocked, giữ lịch sử; không hủy hay gửi lại outcome unknown. Các bước gửi luôn kiểm lại baseline và khóa ở backend.

Không dùng trang **Đăng theo lô** để suy ra đã bật writer chính: pipeline đó chưa được nối PreparedGateway trong app chính. Đổi số tầng, thêm/bớt phân loại thật, refresh token tự động, chạy bền 24h và production nhiều shop vẫn cần nghiệm thu riêng.

## Vận hành local

Ảnh lỗi trình duyệt không phải bằng chứng Shopee khóa shop. Khi bắt đầu kiểm tra lại, API4310/UI5173 trả200 và worker online; tab lỗi cũ còn giữ trang báo lỗi. API đã được nạp lại cho chức năng mới. Khi chạy API bằng tsx riêng phải đặt `TSX_TSCONFIG_PATH=apps/api/tsconfig.json` như `scripts/dev.mjs`; thiếu biến này khiến decorator không biên dịch được. Các tiến trình local chưa phải dịch vụ autostart.

## Kiểm thử

Lượt **UI → API backend → Shopee sandbox → readback** đã đạt lúc **15:27:26 UTC+7**:

- Field trial `7c06ae31-6b38-48c1-86bf-a29047bd45f5`, listing803935036, operation title, state verified.
- Tiêu đề trước `SANDBOX QA WIRE 20260914 - kiem thu nhat ky API`; sau `SANDBOX QA 20260914 - thu truc tiep tu ung dung noi bo`.
- `selectedMatch=true`, `unchanged=true`, các mảng mismatched/unselectedChanged rỗng. Request `e3e3e7f35b6d34195dcb77030377ac00`.
- Từ startedAt08:27:23.626Z đến updatedAt08:27:26.054Z: **2,428giây**, không bao gồm đọc ban đầu, chuẩn bị preview và thời gian người dùng xem. Không suy ra thông lượng cả ngày từ một lượt.
- Biên nhận đầy đủ `.local/acceptance-20260914/legacy-recovery/live-ui-title-result.json`. Không chạy lại operation này. Trình duyệt thật hiển thị Đã đọc lại và đối chiếu; không giả lập phản hồi ở lượt này.

Audit7bảng nguồn/công việc/lịch sử tại15:25 và lần cuối15:33:49 xác nhận tất cả giữ nguyên hash so với bản cùng ngày10:46; `.local/acceptance-20260914/legacy-recovery/protected-data-audit.json`.

Kiểm tổng kết thúc **15:33:20 UTC+7: 892/892 unit/integration, 7/7 legacy, typecheck và hai build đạt, không skip**. Tăng27ca so với checkpoint865. Bằng chứng `final-verification.json` và `final-tests.json` trong thư mục riêng legacy-recovery.

UI có **6/6 ca trình duyệt đạt** với backend/PostgreSQL thật trong schema riêng, outbound Shopee giả lập: tiêu đề, tồn0, mất phản hồi sau gửi, mất yêu cầu prepare trước insert, bản chuẩn bị hết hạn và mất phản hồi hủy. Mở/reload không tự POST; khôi phục prepare giữ cùngID/payload; hủy chỉ CASprepared, không hủy unknown. Phản biện và bằng chứng `.local/acceptance-20260914/ui-live-readiness/tryout-ui-acceptance.md`, `browser-final.json`. Sáu ca này không phải sáu phép ghi Shopee thật; lượt live title phía trên được ghi riêng.

Kết thúc kiểm tra: health/ready trảready, UI5173 trả trang và các routeJSON, workeronline, contextTryoutavailabletrue; productionWritesfalse và listingExecutor chính vẫnnot_configured. Build có cảnh báo kích thước bundle hơn500kB, không phải lỗi build. Đây chưa phải nghiệm thu vận hành bền24h hoặc production.

Phản biện thiết kế: `docs/reviews/2026-09-14-legacy-listing-recovery.md`. Các phép thử phân loại/ảnh trước đó: `docs/delivery/2026-09-14-variation-and-image-qc.md`.
