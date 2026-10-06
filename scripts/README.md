# Công cụ duy trì

- `bootstrap.mjs`: kế hoạch/cài mới có biên nhận quyền sở hữu; không gọi Shopee.
- `doctor.mjs`: kiểm tra máy, source/dependencies/build/database của bản cài và hướng xử lý; không in secrets.
- `local-launcher.mjs` và `managed-process.mjs`: mở/dừng đúng tiến trình của bản cài; không tự bật ghi Shopee. Khi có transfer hold, chỉ mở API/UI, giữ worker.
- `transfer-local.mjs` cùng `transfer-files.mjs`, `transfer-database.mjs`, `transfer-restore.mjs`: `create`, `verify`, `plan`, `restore`; chuyển dữ liệu riêng vào đích mới thuộc quyền công cụ, giữ cấu hình database/cổng của đích và nhận đúng khóa giải mã nguồn. Không tự mở app, giải phóng hold hoặc tiếp tục job cũ.
- `reference-library.mjs`: `export --output DIR`, `verify --library DIR`, `import --library DIR`; `--apply` mới chép hai bộ tài liệu vào `knowledge-base/` của checkout khi thư mục đích chưa tồn tại. Thư viện bàn giao riêng cần cho app đầy đủ; công cụ không đổi DB/env hoặc gọi Shopee.
- `release-package.mjs`: ZIP mã nguồn có manifest SHA-256; loại dữ liệu riêng, credentials và các script thực thi theo đợt lịch sử.
- `verify.mjs`, `verify-internal.mjs`: kiểm tổng trên máy mới/CI hoặc môi trường cách ly.
- `internal-environment.mjs`, `internal-backup.mjs`: môi trường thử riêng và sao lưu có phạm vi. Restore rehearsal không phải công cụ đưa dữ liệu vào bản vận hành mới.
- `migrate.mts`: áp migrations trên database được chỉ định rõ; không sửa migration đã chạy.

Máy mới chưa có dữ liệu: [START_HERE](../docs/onboarding/START_HERE.md). Chuyển dữ liệu từ máy cũ: [TRANSFER_AND_RECOVERY](../docs/onboarding/TRANSFER_AND_RECOVERY.md). Docker Desktop cần chủ máy cài/bật; keys trong bộ riêng không thuộc Git hoặc ZIP source.

Các script có tên pilot/pass1/sandbox/audit còn trong checkout phục vụ lịch sử hoặc kiểm thử. Không chạy để thử kết nối, thiết lập máy mới hoặc tiếp tục công việc chưa đối chiếu journal. Chỉ một số module có unit tests được giữ trong gói source; chúng không nằm trong luồng thiết lập/khởi động.

- local-supervisor.mjs: giám sát có quyền sở hữu, restart hữu hạn API/web, giữ worker chết và không tự resume. Xem runbook local-service-supervisor.
- runtime-endurance.mts: tải đọc trong database thử riêng, có biên nhận độ trễ/bộ nhớ và thời gian thực; không gọi Shopee. Xem runbook runtime-endurance.
