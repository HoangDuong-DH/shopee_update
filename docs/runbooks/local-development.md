# Chạy và kiểm tra tại máy

## Máy phát triển hiện tại

- Node riêng: `C:/shopee_product_uploader/.local/runtime/node-v24.20.0-win-x64/node.exe`. Đã xác minh SHA-256 theo SHASUMS256 chính thức khi cài. Không thay Node toàn máy.
- PostgreSQL: Docker Compose `infra/local/compose.yaml`, image `postgres:17.11-alpine`, cổng loopback 5442. Named volume giữ dữ liệu qua restart container.
- `.env` / `.local/docker.env`: cấu hình và khóa riêng tại máy; không commit.
- `.local/data/blobs`: bản gốc theo hash; tệp nhập không bị ghi đè. Worker kiểm hash trước khi đọc.

Trong PowerShell tại root dự án:

```powershell
$env:Path=(Join-Path (Get-Location) '.local/runtime/node-v24.20.0-win-x64')+';'+$env:Path
npm ci
npm run setup:local
docker compose --env-file .local/docker.env -f infra/local/compose.yaml up -d postgres
npm run db:migrate
npm run dev
```

`npm run dev` chạy API, worker nhập và Vite. Dừng tiến trình cha để dừng ba tiến trình con. Không phải dịch vụ autostart hoặc bằng chứng chạy bền 24h. Khởi động lại không xóa nguồn/bản nháp trong DB. Tránh chạy hai bản trên cùng cổng.

Sau `npm run build`, API cũng phục vụ giao diện build tại cổng 4310. Cấu hình hiện chỉ bind `127.0.0.1`; mở cho mạng nội bộ là bước triển khai có chọn máy chủ/origin cụ thể. Không mở cổng ra Internet.

## Sử dụng

1. **Listing của tôi:** mỗi dòng là một bộ đã lưu. Bấm tên để xem, không cần nhập lại bộ Lamy.
2. **Tệp nguồn:** thêm workbook, Word và ảnh. Chờ Đã đọc tệp. Tab **Tra bảng giá** chỉ để tra SKU/giá theo sheet, không có thao tác ghép hàng.
3. **Nhập listing có sẵn:** nhập mã bộ cố định, chọn đúng file/sheet/bộ giá và dán bảng SKU/phân loại đã chuẩn bị. Thiếu hoặc trùng dòng phù hợp phải làm rõ; không tự chọn nguồn. Tiếp tục tới nội dung/ảnh sau khi đối chiếu danh sách. Đây chưa phải trình nhập trọn bộ tự động.
4. **Kiểm tra listing / Đối chiếu nguồn:** bản đã lưu mặc định chỉ xem. Chọn điều chỉnh rõ ràng để sửa nội dung/ảnh; cấu trúc SKU/phân loại được giữ cố định tại UI và transaction lưu. Bộ mô tả mới cần chọn rõ bố trí đang hỗ trợ; bố trí khác chưa thể lưu. Xem [hướng dẫn thao tác](listing-workspace.md).
5. **Kết nối shop:** với sandbox đã khai báo, nhập Test Partner Key / Access Token của đúng app/shop. Lệnh kiểm tra chỉ đọc `v2.shop.get_shop_info`. Không gửi khóa qua chat. Cấp quyền và refresh tự động còn đang làm; token nhập thủ công không có thời điểm hết hạn đã được xác minh.
6. **Kết quả:** xem bản kiểm tra theo shop và hàng đợi ở hai tab riêng. Shop đích phải được chọn rõ; lưu bản kiểm tra đăng mới chỉ lưu nội bộ. Executor chưa phát hành, không có nút gửi hàng loạt khả dụng hoặc bằng chứng đã đăng từ đường này.
7. **Tra cứu & kiểm tra:** tìm từ khóa trong hai kho tài liệu Shopee, mở bản đầy đủ hoặc kiểm một kế hoạch đã lưu. Kết quả/nguồn/lịch sử giữ trong PostgreSQL; chưa dùng model AI và chưa xác nhận đã đăng/QC. Đọc [hướng dẫn harness](agent-evaluation.md) về nguồn thiếu, deadline và bộ đánh giá.

## Kiểm tra và điều tra lỗi

- `GET /health/live`: API còn sống. `GET /health/ready`: truy cập DB và xác minh đầy đủ phiên bản/checksum migration mà bản app yêu cầu.
- `GET /v1/status`: heartbeat worker gần đây. Heartbeat không chứng minh mọi công việc đều hoàn tất.
- `node scripts/verify.mjs`: chạy các kiểm tra theo thứ tự và dừng khi có lỗi; báo cáo tại `.local/verification.json` và `.local/test-results.json`.
- `npm run test:e2e`: đọc bộ Lamy local, kiểm desktop/mobile, lưu ảnh tại `.local/e2e-artifacts/`. Không chạy trên shop thật.
- Nguồn parser lỗi không có cached formula sẽ báo thiếu giá; không tự đánh giá công thức hoặc mở link ngoài.
- `SOURCE_REVISION_CHANGED` / `PRODUCT_REVISION_CONFLICT`: tải bản mới rồi tạo lại mapping/kế hoạch. Không ép ghi đè.
- `error_auth` từ sandbox: kiểm đúng TEST partner/shop và token còn hiệu lực; đừng thay bằng LIVE key để thử.
- [Lấy thông tin TEST](sandbox-connection.md): thao tác trên Console đã đối chiếu ngày 11/09/2026.

## Nhập lại bộ nguồn có công thức ghép đã kiểm

`scripts/import-recipe.mts` nhận đường dẫn recipe local do người vận hành chuẩn bị; upload qua chính HTTP API, chờ worker, đối chiếu hash và giá mong đợi trước khi lưu draft. Không nhận đường dẫn tùy ý từ trình duyệt. Recipe Lamy riêng ở `.local/recipes/lamy.json`; không nằm trong Git.

```powershell
node --conditions=development --import tsx scripts/import-recipe.mts .local/recipes/lamy.json
```

Script không gọi Shopee. Nếu productKey đã có, không tạo thêm bản nháp; chỉnh mapping tạo revision mới qua UI. Đây là công cụ nhập nguồn, không phải cơ chế chống trùng listing trên sàn.

## Trước khi dùng chung cho doanh nghiệp

Hoàn tất B–E trong kế hoạch: kết nối/cấp quyền/token, discovery quyền theo shop, executor/checkpoint/reconcile, chọn trường cập nhật, tồn thủ công, lô/QC/khuyến mại, sao lưu và phục hồi thử, kiểm tải và soak thật, cuối cùng pilot production đúng phạm vi được phép. Không lấy các kiểm tra nền tảng hiện tại thay cho các bước này.
