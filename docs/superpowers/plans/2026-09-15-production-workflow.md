# Production Workflow Implementation Plan

> For agentic workers: dùng superpowers:subagent-driven-development hoặc executing-plans để triển khai từng phần và đối chiếu độc lập.

**Goal:** Nối nguồn đã lưu với luồng production và đưa ngoại lệ vào app, giảm các thao tác và lượt API dư thừa.

**Architecture:** Tái dùng ListingDraft, BlobStore, journal và coordinator hiện có. Thêm bước chuẩn bị có phiên bản và bộ nhớ đệm đọc theo phiên thực thi; không bỏ kiểm soát nguồn/biên nhận.

**Tech Stack:** Node 24.20.0, TypeScript, Nest/Fastify, React, PostgreSQL, Zod, Vitest/Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-production-workflow-design.md`.

## Global Constraints

- Không sửa tệp gốc, source revision hoặc operation lịch sử để làm kết quả đạt.
- Không ghi Shopee qua giao diện; không đăng nguồn chưa đủ hoặc chưa có quyết định vận hành.
- Không mặc định tồn, giá Mall hoặc tự chuyển ngành; shop production hiện chỉ 1423724897.
- Kiểm thử mô phỏng phải tách dữ liệu app chính, giữ bằng chứng riêng với phép API thật.

## Task 1: Giảm lượt đọc lặp

Files: `production-pilot-source.ts`, `production-pilot-read-scheduler.ts`, `production-pilot-read-session.ts`, wrapper `collectProductionBatchInput`, tests tương ứng.

Interfaces: `ProductionPilotReadSession({batchId, manifestSha256, maxAgeMs?})`; collector nhận `readSession`, `purpose` và `trustedExistingOperation` chứa operation/item/source/revision/fingerprint.

- [x] Viết ca cache đúng scope/revision/TTL, giữ ngày và request nguồn.
- [x] Giữ item_limit, shop identity, inventory/model và QC ngoài cache.
- [x] Đối chiếu đủ ACK từ DB trước đường đọc có mục tiêu; chỉ bỏ kiểm trùng cho nguồn có quyết định miễn riêng.
- [x] Giữ giới hạn nhịp đọc và retry có giới hạn cho lỗi rate-limit rõ ràng.
- [x] Đo số request bằng fixture và kiểm đọc thật; không suy ra tốc độ 24 giờ từ một lần chạy.

## Task 2: Xử lý cân nặng trên giao diện

Files: `production-batch-review-service.ts`, `ProductionBatches.tsx`, routes trong `app.ts`, unit/browser tests.

Interfaces: `review(batchId, sourceKey)` và `approve(batchId,{sourceKey, expectedReviewFingerprint})`. POST chỉ lưu quyết định nội bộ, không nhận modelID/giá trị/path do browser dựng.

- [x] Chỉ đề nghị chấp nhận khi hai raw read ổn định và QC toàn bộ trường khác khớp sau đúng phép ánh xạ gram.
- [x] Đọc lại binding khi xác nhận; lưu phiếu bất biến theo operation và hỗ trợ cùng yêu cầu khi mất phản hồi.
- [x] Hiện nhóm số gram nguồn/đang lưu/số SKU; nhân viên chủ động bấm chấp nhận.
- [x] Nối lại các nút tiếp tục, kiểm ảnh và kết quả; không tự mở bán sau chấp nhận.

## Task 3: Chuyển nguồn đã lưu sang hồ sơ production

Files: `production-draft-source.ts`, service chuẩn bị mới, schema manifest phiên bản mới, routes và phần chuẩn bị trong màn Đăng hàng.

- [x] Chuyển từ ID/revision của ListingDraft, tái dùng sourceSelection/ảnh/phân loại.
- [x] Đối chiếu đúng workbook/rowKey/SKU/giá và byte ảnh ở server; giữ tồn 0 và giá trị thiếu riêng.
- [x] Lưu dữ kiện vận hành bổ sung có nguồn/phiên bản; trường chưa hỗ trợ phải là ngoại lệ.
- [x] Lưu preview và nguồn đóng băng bất biến; tạo registry từ server, không nhận đường dẫn file hay quyền writer do browser cung cấp.
- [x] Kiểm request trùng, thay đổi nguồn/giá sau preview, mất phản hồi và nhiều nguồn có ngoại lệ.

## Task 4: Nghiệm thu và bàn giao

- [x] Phản biện các thay đổi từ agent khác trước khi mở app.
- [x] Kiểm toàn bộ kiểu/build/unit/integration và browser của luồng mới.
- [x] Kiểm trên app thật, tách việc còn cần nguồn hoặc quyết định của người dùng.
- [x] Ghi số request và thời gian đo được, cập nhật README/handoff/ledger với đúng phạm vi đã triển khai.

## Kết quả triển khai

Hoàn tất phạm vi code và kiểm chứng trong kế hoạch này ngày 15/09. Xem docs/delivery/2026-09-15-production-workflow.md: 1751 unit/integration + 7 legacy, 17 browser fixture, typecheck/build đạt. Đây không phải nghiệm thu 80 listing production, nhiều shop, mọi patch hoặc 24h. PASS1 còn ngoại lệ nguồn/quyết định được nêu rõ trong delivery.
