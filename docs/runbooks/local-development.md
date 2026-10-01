# Chạy và kiểm tra tại máy

**Mốc mã tích hợp ngày 01/10/2026:** ListingStudio có bốn mục **Tổng quan**, **Bộ listing**, **Đăng hàng**, **Shop**; các công cụ nhập nguồn, cập nhật và lưu trữ nằm trong **Công cụ**. Nhánh release đã kết hợp bản nâng cấp và các chốt nguồn của bản vận hành. Sao lưu, kiểm tra phục hồi và triển khai đang tiến hành; trạng thái hoàn tất phải dựa trên biên nhận release. Đăng hàng, sao chép, sửa listing thật và tự tiếp tục lô vẫn tạm dừng. Xem [review tích hợp](../reviews/2026-10-01-product-integration.md) và [handoff](../handoffs/PROJECT_HANDOFF.md).

**Kiểm chứng hiện tại:** lượt full `run-1bwVTX` đạt **2740/2740 unit/integration + 7/7 legacy + 1/1 intake browser**, typecheck và build. **7/7 workspace browser** đạt trong lượt riêng. UI, API, worker và PostgreSQL chạy thật tại máy; metadata và phản hồi Shopee là fixture. Không suy ra nghiệm thu Shopee thật, mọi shop/ngành hoặc vận hành 24 giờ.

**Phát triển trên máy có dữ liệu:** dùng [môi trường cách ly](internal-development.md), PostgreSQL loopback **5443**, database thử và schema riêng; API **4430**, UI **5273**, hoặc cổng trống do fixture tự chọn. Sau khi khởi tạo đúng môi trường, chạy `node scripts/verify-internal.mjs --dry-run` rồi `node scripts/verify-internal.mjs --browser`. Không chép token hoặc `.env` vận hành vào môi trường thử. Không dùng schema thử cũ có lịch sử migration khác để né kiểm checksum; dùng schema mới được quản lý riêng.

**Cấu hình vận hành:** API **4310**, UI dev **5173** và PostgreSQL **5442** là mặc định, không phải xác nhận dịch vụ đang chạy. API và worker phải đọc cùng `DATABASE_URL`, `DATA_ROOT` và khóa mã hóa hiện có. `DATA_ROOT` có thể nằm ngoài checkout; `.local/data` bên dưới chỉ là mặc định máy mới. Callback cấp quyền dùng `API_PORT`/`PUBLIC_API_ORIGIN`; link quay lại ứng dụng dùng `WEB_PORT`/`PUBLIC_WEB_ORIGIN`. Không suy địa chỉ callback từ cổng của bản cũ hoặc bật writer chỉ để kiểm giao diện.

**Migration và nguồn:** giữ nguyên raw bytes của 001–046, đặc biệt 035; chỉ áp dụng thêm 047–051 sau review và backup. Một đợt chuẩn bị cũ đang hiển thị có bốn bộ nguồn thiếu tệp: giữ tạm dừng, không tạo biên nhận giả hoặc tự resume. Trước đường chuẩn bị/gửi, đọc [chốt nguồn](source-provenance-guard.md). Chỉnh phân loại hàng loạt cần xác nhận mapping theo nguồn và revision mới, rồi xác nhận giá cho đúng revision đó.

## Máy phát triển hiện tại

- Node riêng: `C:/shopee_product_uploader/.local/runtime/node-v24.20.0-win-x64/node.exe`. Đã xác minh SHA-256 theo SHASUMS256 chính thức khi cài. Không thay Node toàn máy.
- PostgreSQL: Docker Compose `infra/local/compose.yaml`, image `postgres:17.11-alpine`, cổng loopback 5442. Named volume giữ dữ liệu qua restart container.
- `.env` / `.local/docker.env`: cấu hình và khóa riêng tại máy; không commit.
- `.local/data/blobs`: bản gốc theo hash; tệp nhập không bị ghi đè. Worker kiểm hash trước khi đọc.

Trên môi trường local mới, trong PowerShell tại root dự án:

```powershell
$env:Path=(Join-Path (Get-Location) '.local/runtime/node-v24.20.0-win-x64')+';'+$env:Path
npm ci
npm run setup:local
docker compose --env-file .local/docker.env -f infra/local/compose.yaml up -d postgres
npm run db:migrate
npm run dev
```

`npm run dev` chạy API, worker nhập và Vite. Dừng tiến trình cha để dừng ba tiến trình con. Không phải dịch vụ autostart hoặc bằng chứng chạy bền 24h. Khởi động lại không xóa nguồn/bản nháp trong DB. Tránh chạy hai bản trên cùng cổng.

Với máy đang có dữ liệu và công việc thật, kiểm tra trạng thái trước; chỉ migrate/restart ở mốc triển khai đã chọn. Không chạy lại chuỗi thiết lập mới trong lúc người dùng đang nhập hoặc job production còn xử lý.

Sau `npm run build`, API cũng phục vụ giao diện build tại cổng 4310. Cấu hình hiện chỉ bind `127.0.0.1`; mở cho mạng nội bộ là bước triển khai có chọn máy chủ/origin cụ thể. Không mở cổng ra Internet.

## Sử dụng

**Luồng production trong mã tích hợp:** **Đăng hàng → Chuẩn bị lô mới** dùng bộ listing đã lưu, nhận lựa chọn có nguồn rồi tạo manifest bất biến và chia nhóm. **Đợt đang làm** hiển thị công việc đã đăng ký. Mặc định lô mới là `hidden_for_review`; `defer_image_qc` phải được chọn rõ và chỉ dùng khi đăng ẩn. Lô cũ không có mode giữ nghĩa tự mở bán lịch sử, trừ khi có phiếu chuyển chế độ được ràng buộc riêng; không sửa manifest cũ hoặc mặc định đổi mọi lô thành hidden. Parent/child hiển thị cùng chính sách hiệu lực. Phạm vi được ràng buộc với partner/shop và kết nối thực sự được chọn; không tự chọn shop thay thế. Đã kiểm cách ly nhiều scope bằng fixture, chưa nghiệm thu ghi production trên mọi shop. Việc mã hỗ trợ scope tổng quát không cấp quyền thực thi hoặc tự tiếp tục các lô đang nghỉ.

**Công cụ sandbox/legacy:** **Công cụ → Thử sandbox** dùng listing kỹ thuật, TEST partner 1232297/shop 227418363; không phải production. Mục **Chuẩn bị lô mới → Công cụ chuẩn bị lô khác** dùng Excel có sheet `Điều phối listing` và PreparedGateway riêng; thông báo **CHƯA MỞ THỰC THI** ở đó không có nghĩa luồng production phía trên bị tắt. Màn **Bản kiểm tra nội bộ (luồng cũ)** lưu kế hoạch nguồn local, không đưa kế hoạch đó vào hàng đợi production. Không thêm shop giả hoặc bật consumer legacy để né chặn production. Bộ mô phỏng 80 nguồn ở [nghiệm thu business fixture](../delivery/2026-09-14-prepared-business-acceptance.md) dùng môi trường riêng, không chứng minh 80 listing đã đăng thật.

**Khóa thực thi và phục hồi:** job production dùng journal/khóa theo đúng kết nối và shop của nó. Các luồng thử TEST có khóa dùng chung trong phạm vi TEST; hồ sơ Lamy cũ và phiếu reconciliation phải giữ nguyên. Không xóa lane hoặc đổi unknown/ACK thành verified để làm nút chạy sáng. Đọc trạng thái đúng loại công việc và dùng đường reconcile của nó; khởi động lại không cấp quyền gửi lại request cũ. Worker nhập file vẫn hoạt động độc lập với việc bật writer production.

1. **Bộ listing:** tìm theo trang và mở đúng bản đã lưu; không tải toàn bộ nội dung các bộ chỉ để hiện danh sách.
2. **Công cụ → Kho nguồn:** tab **Bảng giá chung** nhận riêng Excel, tra giá theo trang tính/bộ giá và dùng cho một đợt mới. Tab **Bộ listing** mở các đợt đã lưu hoặc bộ hoàn thiện; Word/ảnh được nhận cùng thư mục listing. Tệp cũ chưa biết quan hệ được giữ để đối chiếu, không tự gắn vào bộ khác.

   Mục **Cách sắp xếp thư mục listing** hiển thị sẵn cây thư mục mẫu, có thể thu gọn. Mỗi thư mục con trực tiếp là một listing; Word và ảnh của bộ đó có thể cùng cấp hoặc ảnh ở thư mục con riêng. Bảng giá đặt ngoài thư mục được chọn để nhập nhiều listing và nhập riêng ở **Bảng giá chung**. Tên trong sơ đồ chỉ minh họa; vai trò, thứ tự ảnh và SKU vẫn được người vận hành xác định khi nhập.
3. **Nhập thư mục listing:** chọn một thư mục listing hoặc thư mục cha chứa nhiều listing, nguồn giá và vai trò ảnh. `listing-source.json` giữ cách ghép đầy đủ; `listing-mapping.pending.json` giữ đủ cấu trúc và ô SKU còn thiếu. Pending lưu riêng theo phiên bản, chỉ thành source selection khi đã xác nhận đủ cấu trúc và mọi SKU có dòng giá hợp lệ. Đợi **Đã lưu vào Kho đầu vào** trước khi đóng, mở lại đúng đợt để làm tiếp. Editor cần lưu riêng. Claim nguồn thư mục phía server dùng nhận diện và dấu vân tay nội dung, không lấy tên đường dẫn hay ID đợt mới làm bằng chứng cho phép tạo nháp khác; cùng nguồn mở lại bản đã lưu, khác nguồn báo xung đột.
4. **Kiểm tra listing / Đối chiếu nguồn:** bản đã lưu mặc định chỉ xem. Chọn điều chỉnh rõ ràng để sửa nội dung/ảnh; cấu trúc SKU/phân loại được giữ cố định tại UI và transaction lưu. Bộ mô tả mới cần chọn rõ bố trí đang hỗ trợ; bố trí khác chưa thể lưu. Xem [hướng dẫn thao tác](listing-workspace.md).
5. **Kết nối shop:** chọn đúng production hoặc TEST. Production đã có luồng cấp quyền và refresh backend; trạng thái revision/hết hạn cần đọc hiện tại. Không gửi khóa qua chat và không xem token thủ công thiếu expiry như một kết nối có hạn dùng đã được xác minh. Chưa nghiệm thu refresh theo lịch liên tục.
6. **Chuẩn bị và gửi:** preview/register lưu công việc local; execute có thể gọi Shopee thật. Hidden completion khác publication verified; deferred-image receipt chỉ chứng minh phần dữ liệu đã kiểm, không chứng minh ảnh đạt. Mở bán từng listing cần QC đầy đủ, xác nhận thao tác và status fingerprint mới. ID LISTING trống mang ý định create, ID có giá trị mang ý định update; compiler mới chặn create cho nguồn có ID. UI đã dẫn sang công việc cập nhật, nhưng production update tổng quát từ thư mục chưa nối đầy đủ.
7. **Tra cứu & kiểm tra:** công cụ tìm tài liệu/harness và gợi ý seller knowledge là các luồng khác nhau. Knowledge gợi ý có nguồn/metadata theo shop; lịch sử không tự thành thuộc tính đúng cho sản phẩm. Lựa chọn được xác nhận và receipt bị ràng buộc bản nguồn/ngành/shop trước khi vào preview. Manifest đã đăng ký giữ snapshot đã duyệt, không tự nhận thay đổi nguồn mới. Các công cụ này không phải bằng chứng đã đăng hoặc QC.

## Kiểm tra và điều tra lỗi

- `GET /health/live`: API còn sống. `GET /health/ready`: truy cập DB và xác minh đầy đủ phiên bản/checksum migration mà bản app yêu cầu.
- Ngày 25/09/2026, migration `035_production_qc_wait.sql` trên máy vận hành từng mất một dấu cách cuối dòng sau khi đã áp dụng, khiến checksum khác và `/health/ready` trả 503 dù PostgreSQL khỏe. Đã khôi phục đúng byte theo checksum trong DB; không cập nhật checksum trong DB hoặc chạy lại migration. Giữ nguyên byte của migration đã áp dụng khi format/merge; thay đổi logic phải là migration mới.
- `GET /v1/status`: heartbeat worker gần đây. Heartbeat không chứng minh mọi công việc đều hoàn tất.
- `node scripts/verify.mjs`: chạy các kiểm tra theo thứ tự và dừng khi có lỗi; báo cáo tại `.local/verification.json` và `.local/test-results.json`.
- `npm run test:e2e`: đọc bộ Lamy local, kiểm desktop/mobile, lưu ảnh tại `.local/e2e-artifacts/`. Không chạy trên shop thật.
- Nguồn parser lỗi không có cached formula sẽ báo thiếu giá; không tự đánh giá công thức hoặc mở link ngoài.
- `SOURCE_REVISION_CHANGED` / `PRODUCT_REVISION_CONFLICT`: tải bản mới rồi tạo lại mapping/kế hoạch. Không ép ghi đè.
- `FOLDER_SOURCE_CHANGED` hoặc xung đột claim: đối chiếu bản nháp, hồ sơ, bộ giá và ảnh hiện tại. Không đổi productKey để tạo bản trùng. Pending thiếu SKU vẫn lưu được để bổ sung nhưng không được chuyển thành payload gửi.
- `error_auth` từ sandbox: kiểm đúng TEST partner/shop và token còn hiệu lực; đừng thay bằng LIVE key để thử.
- [Lấy thông tin TEST](sandbox-connection.md): thao tác trên Console đã đối chiếu ngày 11/09/2026.

## Nhập lại bộ nguồn có công thức ghép đã kiểm

`scripts/import-recipe.mts` nhận đường dẫn recipe local do người vận hành chuẩn bị; upload qua chính HTTP API, chờ worker, đối chiếu hash và giá mong đợi trước khi lưu draft. Không nhận đường dẫn tùy ý từ trình duyệt. Recipe Lamy riêng ở `.local/recipes/lamy.json`; không nằm trong Git.

```powershell
node --conditions=development --import tsx scripts/import-recipe.mts .local/recipes/lamy.json
```

Script không gọi Shopee. Nếu productKey đã có, không tạo thêm bản nháp; chỉnh mapping tạo revision mới qua UI. Đây là công cụ nhập nguồn, không phải cơ chế chống trùng listing trên sàn.

## Trước khi dùng chung cho doanh nghiệp

Production pilot và một số create/publication thật đã có bằng chứng trong delivery tương ứng. Không gọi toàn bộ hệ thống là chưa có executor, cũng không suy từ pilot sang mọi luồng. Những phần còn phải nghiệm thu theo phạm vi gồm cập nhật production đầy đủ từ thư mục, nhiều shop/ngành, khuyến mại, sao lưu/phục hồi, tải và vận hành liên tục. Kiểm tổng tại máy hoặc fixture xanh không thay cho các nghiệm thu này.
