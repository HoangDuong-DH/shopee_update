# Chuyển máy và phục hồi

Muốn tiếp tục dữ liệu cũ trên máy khác, cần nhận **gói mã nguồn**, **bộ chuyển dữ liệu riêng** và **thư viện `REFERENCE_LIBRARY`** đi cùng nhau. ZIP mã nguồn/GitHub giúp cài ứng dụng; database, tệp nguồn và khóa nằm trong bộ riêng. Nếu cần tiếp nối trạng thái công việc, nhận thêm `SESSION_CONTEXT/` theo [Chuyển checkpoint](SESSION_CONTEXT_TRANSFER.md).

## Bộ người nhận cần có

| Thành phần                                      | Mục đích                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `LISTINGSTUDIO_SOURCE.zip` và biên nhận release | Mã đã duyệt, lockfile và manifest SHA-256.                                                                            |
| `REFERENCE_LIBRARY/` bàn giao riêng             | Hai bộ tài liệu Open Platform/người bán Việt Nam, manifest, chỉ mục tìm kiếm và toàn bộ Markdown được tham chiếu.     |
| `database.dump` trong bộ riêng                  | Bản nháp, kết nối mã hóa, công việc, journal và biên nhận trong database.                                             |
| `data/` và các thư mục `receipts-N/`            | Blob nguồn, manifest và hồ sơ ngoài database thuộc phạm vi đã chọn.                                                   |
| `secrets/app-key.json`                          | Đúng `APP_ENCRYPTION_KEY` giải mã database đã chuyển.                                                                 |
| `secrets/connection-keys.json`                  | Các trường key/token đã lưu, được xuất thành file riêng theo yêu cầu chủ hệ thống. Không suy khóa chưa từng được lưu. |
| `secrets/original-app.env`                      | CLI giữ bản môi trường nguồn để đối chiếu riêng; không chép đè `.env` của máy nhận.                                   |
| `SESSION_CONTEXT/` và manifest riêng            | Checkpoint, journal phiên và bằng chứng đúng đường dẫn; giữ quyết định, phần tạm dừng và việc không được phát lại.    |
| Manifest của bộ riêng và biên nhận kiểm         | Danh sách tệp, dấu kiểm và phần đã kiểm/chưa kiểm.                                                                    |

Database và khóa giải mã phải là cặp phù hợp. Các key/token xuất riêng có thể đọc được; giữ cả bộ trong thư mục hạn chế quyền, trao qua kênh riêng. Không đưa bộ này lên GitHub, ZIP công khai, chat hoặc ảnh chụp. Khóa/token được giữ không đồng nghĩa còn hiệu lực trên Shopee.

Người bàn giao chạy `npm run release:package` cho gói mã và `node scripts/reference-library.mjs export --output DIR` rồi `node scripts/reference-library.mjs verify --library DIR` cho thư viện riêng. Công cụ `transfer-local.mjs` tạo/kiểm bộ dữ liệu riêng; người bàn giao cung cấp đường dẫn gói và kết quả kiểm thực tế. Một gói tạo từ mã đang sửa chưa chứng minh GitHub đã được cập nhật.

## Máy nhận: cài môi trường trước, chưa chạy app

1. Giải nén đúng gói mã vào **thư mục mới**, không đè thư mục đang vận hành. Mở cả thư mục trong Codex; dùng [prompt lần đầu](CODEX_FIRST_RUN.md) và nói rõ đang **chuyển dữ liệu cũ**.
2. Chủ máy cài/mở Docker Desktop, chọn Linux containers và đợi engine sẵn sàng. Codex không thay chủ máy chấp nhận quyền hệ thống. Cần Compose v2 và PostgreSQL 17 theo cấu hình dự án.
3. Chạy `SETUP_LISTINGSTUDIO.cmd` hoặc `npm run onboarding:setup` để tạo database/cấu hình riêng cho máy nhận, cài thư viện, migrate và build. Chọn cổng trống từ đầu nếu cổng mặc định đã dùng.
4. **Chưa bấm START**. Bước restore chỉ nhận bản setup mới hoàn tất, database có đúng schema nhưng chưa có dữ liệu ứng dụng, thư mục dữ liệu trống và API/web/worker đã dừng. Không dùng database đang có công việc để thử nhập.
5. Chép nguyên bộ dữ liệu riêng và `REFERENCE_LIBRARY` đến một vị trí máy nhận có quyền đọc. Không mở file key để dán giá trị vào terminal; không chép `.env` của máy cũ đè cấu hình mới.

Mật khẩu database, cổng, đường checkout và quyền sở hữu Docker của **máy nhận** được giữ lại. Restore chỉ nhận khóa mã hóa nguồn cần để giải mã dữ liệu cũ, cập nhật biên nhận cấu hình tương ứng và giữ các cờ ghi/bảo trì tắt.

## Kiểm gói, xem kế hoạch rồi nhập

Trong terminal ở thư mục mã mới, thay đường ví dụ bằng vị trí bộ riêng vừa nhận:

```powershell
$transferBundle = 'D:/ListingStudio-transfer/PRIVATE_TRANSFER'
$referenceLibrary = 'D:/ListingStudio-transfer/REFERENCE_LIBRARY'
$nodeRuntime = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  '.local/runtime/node-v24.20.0-win-arm64/node.exe'
} else { '.local/runtime/node-v24.20.0-win-x64/node.exe' }
if (!(Test-Path -LiteralPath $nodeRuntime)) { $nodeRuntime = 'node' }
& $nodeRuntime scripts/transfer-local.mjs verify --bundle "$transferBundle"
& $nodeRuntime scripts/reference-library.mjs verify --library "$referenceLibrary"
& $nodeRuntime scripts/reference-library.mjs import --library "$referenceLibrary"
& $nodeRuntime scripts/transfer-local.mjs plan --bundle "$transferBundle"
```

Các lệnh chọn Node portable do SETUP tải nếu có; nếu dùng Node sẵn trên máy, cần đúng phiên bản đã kiểm. Giữ terminal này cho bước tiếp theo. `verify` kiểm danh sách/dấu kiểm trong manifest. `plan` đọc điều kiện máy nhận và kế hoạch; chưa nhập dữ liệu. Nếu thiếu file, key sai, schema khác, đích có dữ liệu hoặc còn tiến trình chạy, giữ nguyên và xử lý đúng lỗi. Không xóa database/volume để vượt chặn.

Khi kế hoạch đạt và đúng đích đã chọn:

```powershell
& $nodeRuntime scripts/transfer-local.mjs restore --bundle "$transferBundle" --apply
& $nodeRuntime scripts/reference-library.mjs import --library "$referenceLibrary" --apply
& $nodeRuntime scripts/doctor.mjs --json
```

Nếu nhận `SESSION_CONTEXT/`, kiểm và nhập theo [hướng dẫn context](SESSION_CONTEXT_TRANSFER.md) sau cài dependencies, trước START. Đọc status/brief sau nhập; không lấy checkpoint làm quyền gỡ hold. Ghi riêng mốc source, dump database và context: chúng có thể khác ngày; context mới không cập nhật dump cũ.

Thư viện phải nhập trước START. `reference-library import --apply` chỉ chép vào `knowledge-base/` khi thư mục đích chưa tồn tại; thư viện có sẵn cần đối chiếu, không xóa/ghi đè. Gói thư viện có cả manifest, `search.sqlite`, các Markdown được dẫn và hướng dẫn nhỏ; không cần mang lại kho raw/assets/downloads trùng lặp.

Công cụ nhập dữ liệu trong một transaction vào database riêng đã xác minh. Nó chép blob/hồ sơ tới vị trí được quản lý và ghi `source-root-map.json` trong thư mục hồ sơ đã nhập để đối chiếu đường cũ với đường mới. Chỉ cột `shop_listing_media_blobs.storage_path` được chuyển, có biên nhận `.local/onboarding/transfer-relocation.json`. Các bản nguồn, journal, payload và dấu kiểm lịch sử phải được giữ; không replace toàn cục JSON hay sửa fingerprint để làm một công việc cũ chạy được.

Kết quả thành công phải có `.local/onboarding/transfer-state.json` với `status: complete` và cả năm bước hoàn tất. Nếu kết quả restore chưa rõ hoặc bị dừng giữa chừng, giữ `transfer-hold` và biên nhận; kiểm trạng thái trước khi quyết định tiếp tục. Không chạy lại lệnh restore tự động hoặc tạo lại key.

## Mở dữ liệu để kiểm tra

Sau restore, giữ nguyên `.local/onboarding/transfer-hold.json`. Launcher chỉ mở API và giao diện để xem dữ liệu; **worker không chạy**, ghi production/pilot và bảo trì kết nối vẫn tắt. Không tự xóa file này để chạy các job cũ.

Mở `START_LISTINGSTUDIO.cmd` hoặc `npm run start:local`, rồi làm [kiểm tra bàn giao](ACCEPTANCE.md): đếm nguồn/bản nháp/công việc, đối chiếu blob và journal, kiểm preview và khả năng giải mã mà không in token. Bộ thiếu nguồn và kết quả ghi `unknown` tiếp tục giữ riêng. Đọc lại Shopee theo đúng shop/item trước mọi quyết định thử lại; chuyển database không hoàn tác thao tác đã xảy ra trên sàn.

Chỉ sau khi người điều phối đã đối chiếu các công việc chờ, quyền shop và nguồn mới xác định được phạm vi tiếp tục. Công cụ chuyển máy không tự giải phóng hold, replay create/init/upload/publication hay mở bán. API/UI xem được chưa phải nghiệm thu lại toàn bộ đăng hàng hoặc vận hành 24 giờ.

## Người bàn giao: tạo bộ riêng

Chạy export từ đúng checkout vận hành trên máy nguồn. Ngừng nhận ghi và kiểm mọi writer/job ở trạng thái an toàn; không cần khởi động lại API/worker nguồn chỉ để export. Dùng đúng file môi trường mà bản vận hành đang sử dụng và khai báo từng thư mục hồ sơ cần giữ. Thay đường ví dụ và tên container bằng thông tin đã xác minh:

```powershell
$operatingEnv = 'C:/ListingStudio-van-hanh/.env'
$transferDestination = 'D:/ListingStudio-transfer/PRIVATE_TRANSFER'
$receiptRoot = 'C:/ListingStudio-van-hanh/ho-so-van-hanh'
$sourceContainer = 'CONTAINER_POSTGRES_NGUON'
node scripts/transfer-local.mjs create --source-env "$operatingEnv" --output "$transferDestination" --source-container "$sourceContainer" --receipt-root "$receiptRoot" --quiesced
node scripts/transfer-local.mjs verify --bundle "$transferDestination"
```

Chọn thư mục output mới, ngoài nguồn. `--quiesced` là xác nhận của người điều phối; nó không tự dừng hay chứng minh mọi writer đã nghỉ. Khi export, công cụ dùng snapshot `REPEATABLE READ` và khóa `SHARE` trong lúc `pg_dump` chạy để bản kiểm kê database và dump cùng trạng thái. Nếu tệp nguồn thay đổi khi chép, export dừng để kiểm tra. Nếu database nguồn nằm trong Docker, Codex xác minh đúng container rồi thêm `--source-container TEN_CONTAINER` để dùng `pg_dump` trong container đó. Nếu dùng công cụ trên Windows, cần `pg_dump` phiên bản 17 và có thể chỉ rõ đường bằng `--pg-dump`. Nguồn ngoài `DATA_ROOT` và hồ sơ ngoài các thư mục đã chọn cần được kiểm riêng, không tự coi bộ riêng bao phủ mọi tệp trên máy.

Công cụ tạo cả `secrets/app-key.json` và `secrets/connection-keys.json`, đưa chúng vào manifest SHA-256 và kiểm phạm vi credentials đã lưu mà không in giá trị. Bản verify phải có đủ cả hai file. Không gọi “đã giữ toàn bộ key” nếu còn giá trị chưa đọc được hoặc chưa nằm trong gói đã kiểm.

[Runbook backup/restore cũ](../runbooks/internal-backup-restore.md) vẫn phục vụ sao lưu và diễn tập cách ly; riêng `internal-backup.mjs restore-rehearsal` chỉ phục hồi database thử, không thay quy trình chuyển máy ở trên.
