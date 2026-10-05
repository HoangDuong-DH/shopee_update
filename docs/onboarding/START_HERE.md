# Bắt đầu với ListingStudio

Tải dự án, mở cả thư mục bằng Codex rồi dán [lời nhờ thiết lập](CODEX_FIRST_RUN.md). Codex có thể kiểm tra máy, cài thư viện và dựng ứng dụng local. Chủ máy cần cài/chạy Docker Desktop; chủ shop cần tự cấp quyền Shopee khi muốn kết nối thật.

## Chọn đúng việc

| Bạn muốn | Bắt đầu ở đâu |
| --- | --- |
| Dùng ứng dụng mới, chưa có dữ liệu cũ | Theo các bước bên dưới. |
| Chuyển tiếp dữ liệu và công việc từ máy khác | Nhận thêm bộ dữ liệu/key riêng và `REFERENCE_LIBRARY`; theo [Chuyển máy và phục hồi](TRANSFER_AND_RECOVERY.md), chưa mở app trước bước nhập. |
| Thư mục đã có `.env`, database hoặc dữ liệu | Nhờ Codex kiểm tra hiện trạng; không tạo lại cấu hình. |

Repository và ZIP mã nguồn không chứa database, Word/Excel/ảnh riêng, token hay khóa của máy vận hành. Tải mã không khôi phục các dữ liệu này. Khi chuyển máy, người nhận cần bộ riêng có database, nguồn/hồ sơ và đúng khóa giải mã; các key/token đã lưu có thể được bàn giao bằng file riêng có dấu kiểm, không dán vào chat.

Thư viện `knowledge-base/` cũng được bàn giao riêng bằng thư mục `REFERENCE_LIBRARY`. Nó có tài liệu Open Platform và hướng dẫn người bán Việt Nam phục vụ tra cứu/đối chiếu. Nếu chỉ kiểm mã hoặc build, ghi rõ thư viện chưa có; bản bàn giao ứng dụng đầy đủ cần nhận và nhập thư viện trước khi START.

## 1. Nhận đúng bản mã

Trên [GitHub của dự án](https://github.com/HoangDuong-DH/shopee_update), chọn đúng nhánh hoặc mốc được người bàn giao chỉ định, rồi **Code → Download ZIP**. Hoặc nhận `LISTINGSTUDIO_SOURCE.zip` kèm biên nhận và dấu kiểm SHA-256 từ người bàn giao. Gói mã có `RELEASE_MANIFEST.json` ghi danh sách/dấu kiểm các tệp.

Giải nén vào một thư mục riêng có quyền ghi. Mở thư mục chứa `package.json` và `AGENTS.md` trong Codex. Giữ thông tin phiên bản của gói: một ZIP lấy từ thư mục đang sửa có thể khác bản trên GitHub; chỉ commit/push thành công mới cập nhật GitHub.

## 2. Chuẩn bị máy Windows

- Node.js **từ 24.20.0 đến trước 25**, kèm npm; xem [`.node-version`](../../.node-version). `SETUP_LISTINGSTUDIO.cmd` có thể tải Node portable 24.20.0 và kiểm SHA-256 chính thức khi chưa có bản phù hợp.
- Chủ máy cài và mở Docker Desktop, engine dùng **Linux containers**, Docker Compose **v2** hoạt động. Các bước quyền hệ thống cần tài khoản hợp lệ của chủ máy; Codex tiếp tục được khi Docker sẵn sàng.
- Kết nối mạng để tải thư viện và image PostgreSQL trong lần cài đầu.

Ứng dụng chạy API, giao diện và worker trên máy bằng Node. Docker chạy PostgreSQL **17.11** theo [cấu hình đã ghim](../../infra/local/compose.yaml). Không cần tách thành microservices hoặc tự cài thêm server AI/MCP để bắt đầu.

## 3. Kiểm tra và thiết lập lần đầu

Nếu Node đã sẵn sàng, mở terminal tại thư mục dự án để xem kế hoạch trước:

```powershell
node scripts/bootstrap.mjs
```

Với bản sao mới, mở **`SETUP_LISTINGSTUDIO.cmd`** để tải runtime nếu cần và thực hiện thiết lập. Khi Node/npm đã có, có thể dùng:

```powershell
npm run onboarding:setup
```

Nếu SETUP dùng Node portable, runtime nằm trong `.local/runtime/`; nó không đổi PATH của toàn máy. Nhờ Codex dùng Node/npm trong runtime này cho các lệnh terminal tiếp theo.

Thiết lập kiểm điều kiện, tạo cấu hình và khóa ngẫu nhiên, cài đúng thư viện từ lockfile, khởi động database riêng, áp dụng migration rồi build. Nó không khởi động ứng dụng hoặc gọi Shopee. Ghi production, pilot và bảo trì kết nối tự động mặc định **tắt**.

Nếu phát hiện cấu hình/dữ liệu đã tồn tại, ổ dữ liệu Docker (volume) không thuộc bản sao này hoặc cổng bị chiếm, script dừng để kiểm tra. Không xóa `.env`, khóa, volume hay tiến trình khác để vượt bước này.

Nếu đang chuyển dữ liệu cũ, dừng ở đây để làm bước `verify → plan → restore` trong [hướng dẫn chuyển máy](TRANSFER_AND_RECOVERY.md). Máy nhận giữ mật khẩu database và cổng riêng; công cụ nhận đúng khóa giải mã đi cùng database cũ, không chép `.env` máy cũ đè lên.

Trước khi mở app đầy đủ, thay đường ví dụ bằng thư mục thư viện đã nhận và chạy trong terminal của checkout:

```powershell
$referenceLibrary = 'D:/ListingStudio-transfer/REFERENCE_LIBRARY'
$nodeRuntime = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  '.local/runtime/node-v24.20.0-win-arm64/node.exe'
} else { '.local/runtime/node-v24.20.0-win-x64/node.exe' }
if (!(Test-Path -LiteralPath $nodeRuntime)) { $nodeRuntime = 'node' }
& $nodeRuntime scripts/reference-library.mjs verify --library "$referenceLibrary"
& $nodeRuntime scripts/reference-library.mjs import --library "$referenceLibrary"
& $nodeRuntime scripts/reference-library.mjs import --library "$referenceLibrary" --apply
```

Lệnh import mặc định chỉ kiểm; `--apply` mới chép vào `knowledge-base/` của checkout này và chỉ khi thư mục đích chưa tồn tại. Nếu đã có thư viện, giữ nguyên để Codex đối chiếu; không xóa hoặc ghi đè để vượt chặn. Việc nhập thư viện không đổi database, cấu hình hay quyền shop.

## 4. Mở ứng dụng

Mở **`START_LISTINGSTUDIO.cmd`** hoặc chạy `npm run start:local`. Dùng **`STOP_LISTINGSTUDIO.cmd`** để dừng đúng các tiến trình của bản cài, giữ database và tệp. Với cổng mặc định:

| Thành phần | Địa chỉ |
| --- | --- |
| Giao diện | `http://127.0.0.1:5173` |
| API | `http://127.0.0.1:4310` |
| PostgreSQL | `127.0.0.1:5442` |

Launcher chỉ nhận cấu hình có biên nhận hợp lệ và giữ đúng database riêng; nó không migrate lại khi mở app. Sau chuyển dữ liệu, `transfer-hold` giữ worker/công việc cũ; launcher chỉ mở API và giao diện để kiểm tra. Không tự gỡ hold hoặc resume batch. Nếu chọn cổng riêng, dùng địa chỉ mà công cụ kiểm tra báo. Không chạy hai bản ứng dụng trên cùng database để thử.

## 5. Kiểm tra trước khi dùng

Làm [kiểm tra bàn giao](ACCEPTANCE.md), sau đó đọc [Kết nối shop](SHOP_CONNECTIONS.md). Luồng sử dụng là: **nguồn → bản nháp → chọn đúng shop → chốt bản chuẩn bị → đăng ẩn khi được giao → đọc lại → QC**.

Ảnh, từng tầng phân loại, SKU và giá phải truy về đúng tệp/dòng/ô nguồn. Bộ thiếu nguồn được giữ riêng để bổ sung. Xem [chốt nguồn](../runbooks/source-provenance-guard.md) và [hướng dẫn đăng từ bộ listing đã lưu](../operator-guides/dang-hang-tu-bo-listing-da-luu.md).

Nếu Docker chưa sẵn sàng, chủ máy mở Docker Desktop và xử lý yêu cầu cài đặt/quyền hệ thống. Nếu cổng bị chiếm, Codex đọc tiến trình đang dùng cổng hoặc lập kế hoạch với cổng khác. Nếu lỗi kết nối shop, kiểm tra quyền trong [hướng dẫn kết nối](SHOP_CONNECTIONS.md).

Docker Desktop gồm Engine và Compose; hướng dẫn cài đặt nằm tại [tài liệu Docker chính thức](https://docs.docker.com/compose/install/).
