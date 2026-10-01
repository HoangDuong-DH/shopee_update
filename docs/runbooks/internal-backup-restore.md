# Sao lưu và diễn tập phục hồi

Backup phải bao phủ **database + blob nguồn + manifest/journal/biên nhận ngoài database + khóa giải mã được giữ riêng**. Git không chứa dữ liệu vận hành và không thay thế backup. Một file dump tạo thành công chưa chứng minh hệ thống khôi phục được.

`scripts/internal-backup.mjs` có bốn thao tác: `plan`, `create`, `verify`, `restore-rehearsal`. Nó không xóa dữ liệu, không dùng `pg_restore --clean`, không dừng dịch vụ và không sửa database vận hành. Developer cần PostgreSQL client `pg_dump`/`pg_restore` tương thích server; có thể chỉ định đường dẫn bằng `--pg-dump` và `--pg-restore`.

## Xác định đủ dữ liệu

Trong PowerShell, đặt đường checkout vận hành và thư mục backup mới bằng giá trị thực tế trên máy. Ví dụ dưới đây dùng biến, không chứa thông tin đăng nhập:

```powershell
$operatingRoot = 'C:/duong-dan-checkout-van-hanh'
$backupDestination = 'D:/SaoLuuShopee/ban-sao-moi'
node scripts/internal-backup.mjs plan --source-env "$operatingRoot/.env" --receipt-root "$operatingRoot/.local/production-batch-pass1-20260915" --receipt-root "$operatingRoot/.local/connection-refresh"
```

`plan` chỉ đọc cấu hình và in danh sách dự định, không kết nối database hoặc in secret. `DATA_ROOT` tương đối được tính từ thư mục chứa file cấu hình. Phải chỉ định rõ file môi trường thực sự được runtime sử dụng; script không tự đoán biến môi trường ngoài file.

**Các receipt root ở ví dụ không phải danh sách đầy đủ cho mọi máy.** Kiểm đường dẫn manifest, evidence, authorization, journal, ghi nhận publish/QC và các lô đăng trực tiếp đang tham chiếu trong phiên vận hành. Thêm mỗi gốc cần giữ bằng `--receipt-root`. Nguồn còn tham chiếu Desktop/ổ ngoài cũng phải giữ hoặc đưa vào kho quản lý trước bàn giao. Không backup cả `.local` vào thư mục con của chính nó.

Manifest ghi `completeness: selected-roots-only`: công cụ không giả định đã tìm được mọi file ngoài DB. Khóa `APP_ENCRYPTION_KEY` không được đưa vào manifest hoặc log. Người quản trị giữ bản sao khóa và cấu hình cần thiết trong kho secret/backup bảo mật riêng; mất khóa sẽ không đọc được token cũ. Toàn bộ dump và journal được coi là dữ liệu nhạy cảm, không đẩy GitHub, không gửi chat công khai.

## Tạo và xác minh

Ngừng nhận ghi và chờ các writer/API job đang chạy dừng ở trạng thái an toàn trước khi chạy. Cờ `--quiesced` là xác nhận của người vận hành đã làm việc này, **không phải công cụ tự kiểm chứng toàn hệ thống đã nghỉ**. `pg_dump` chụp database trong transaction nhưng không tạo transaction chung với filesystem.

```powershell
node scripts/internal-backup.mjs create --source-env "$operatingRoot/.env" --output "$backupDestination" --receipt-root "$operatingRoot/.local/production-batch-pass1-20260915" --receipt-root "$operatingRoot/.local/connection-refresh" --quiesced
node scripts/internal-backup.mjs verify --backup "$backupDestination"
```

Mỗi lần dùng thư mục output mới. Công cụ từ chối ghi đè, từ chối output nằm trong nguồn, từ chối symlink/junction và kiểm SHA-256 của từng tệp. Nếu nguồn thay đổi trong lúc copy hoặc dump thất bại, không có `manifest.json` hoàn tất; giữ riêng lần lỗi để điều tra, không coi là backup dùng được. SHA-256 phát hiện hỏng dữ liệu; nó không xác thực người tạo manifest.

## Diễn tập khôi phục database

Tạo môi trường cách ly theo [hướng dẫn developer](internal-development.md), chỉ chạy `init` và khởi động database thử. **Không chạy migrate trước restore** vì mục tiêu phải trống. Không tái sử dụng database thử đã có dữ liệu. Nếu đã tồn tại, yêu cầu người quản trị chuẩn bị một môi trường rehearsal sạch; script không tự xóa giúp.

```powershell
node scripts/internal-backup.mjs restore-rehearsal --backup "$backupDestination" --confirm-rehearsal
```

Chỉ nhận mục tiêu từ cấu hình cách ly: `127.0.0.1:5443/shopee_internal_test`. Khi diễn tập backup ngay từ database thử này, dùng `--rehearsal-database shopee_internal_restore` để chọn đích khác đã được quản trị tạo trống. Đây là hai tên duy nhất được cho phép, không nhận tên database tùy ý. Script từ chối database nguồn trùng đích, từ chối database đích có bảng/view/sequence người dùng; chạy restore một transaction, không owner/privileges và dừng khi lỗi. Credentials chỉ truyền vào môi trường tiến trình con, không vào tham số command hoặc output.

Nếu máy chưa cài PostgreSQL client, riêng rehearsal có thể thêm `--isolated-docker <đường-dẫn-docker.exe>` vào `create` và `restore-rehearsal`. Cơ chế này dùng pg tools trong đúng container `shopee-internal-rehearsal-postgres-1`, chỉ chấp nhận database thử ở cổng 5443; không được dùng để sao lưu database vận hành. Dữ liệu dump truyền qua file descriptor, không hiển thị trong terminal. Có thể cần cấp quyền truy cập Docker cho tài khoản đang chạy.

Restore thành công sinh biên nhận `rehearsal-*.json` gồm đích và số bảng. **Biên nhận này chỉ xác minh bước phục hồi database**, không gọi API, không khởi động app/worker, không chép blob/journal sang runtime và không tự giải mã token. Các file vẫn nằm trong backup đã kiểm SHA.

Người phụ trách cần hoàn tất các bước sau mới đánh dấu diễn tập toàn hệ thống đạt:

- So số nguồn, bản nháp, công việc và journal với báo cáo tại thời điểm backup.
- Kiểm các SHA blob được database tham chiếu có trong `data/blobs`; kiểm manifest ngoài DB và source paths còn giải quyết được. Không sửa trực tiếp JSON bằng replace toàn cục.
- Thử đọc một bộ nguồn và dựng preview trong môi trường đã loại kết nối/công việc production một cách kiểm soát, hoặc dùng fixture riêng. Không chạy worker trên bản sao production chưa xử lý.
- Kiểm khóa giải mã bằng công cụ được duyệt trong môi trường kín, không in token; nếu không có khóa thì ghi rõ phải cấp quyền lại shop.
- Ghi thời gian backup/phục hồi, thiếu sót, chủ sở hữu bản sao và nơi lưu bản sao ngoài ổ máy vận hành. Chốt tần suất và thời hạn lưu phù hợp mức mất dữ liệu doanh nghiệp chấp nhận.

Kiểm chứng developer ngày 23/09/2026: đã chạy migrate, dump và restore thật trên PostgreSQL thử cổng 5443. Hai database có 74 bảng, một dòng giả lập khớp, blob được dòng đó tham chiếu khớp SHA, ba tệp snapshot xác minh đạt; thử restore lần hai bị chặn vì đích không trống. Đây là diễn tập schema và dữ liệu giả lập nhỏ, chưa phải backup dữ liệu doanh nghiệp đầy đủ hoặc phục hồi ứng dụng/token production.

## Khi sự cố thật xảy ra

Ngừng thao tác gửi mới. Giữ log/journal mới nhất ngoài backup cũ. Xác định các lệnh đã gửi nhưng chưa rõ kết quả, đọc lại Shopee trước khi tiếp tục. Phục hồi database cũ không hoàn tác được sản phẩm đã tạo trên sàn. Việc chuyển database thật và khôi phục key cần một người điều phối, biên bản và xác nhận backup; công cụ rehearsal không thực hiện bước này.
