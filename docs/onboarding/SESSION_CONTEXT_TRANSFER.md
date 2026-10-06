# Chuyển checkpoint và context riêng

Dùng phần này khi cần tiếp nối công việc đã làm trên máy khác. **Gói source không chứa checkpoint.** Phần `SESSION_CONTEXT/` được bàn giao riêng cùng bộ dữ liệu; nó không thay database, khóa hoặc thư viện nguồn.

## Người bàn giao

Chốt quyết định/phạm vi và kết quả quan trọng vào checkpoint trước khi xuất. Tại checkout nguồn dùng Node đúng phiên bản (hoặc Node portable đã ghim):

```powershell
npm run session:export -- --output .local/context-handoff
npm run session:verify-bundle -- --bundle .local/context-handoff
```

Output phải là thư mục private mới trong checkout. Chép nguyên thư mục đã kiểm thành `SESSION_CONTEXT/` bên cạnh `LISTINGSTUDIO_SOURCE.zip`, `PRIVATE_TRANSFER/` và `REFERENCE_LIBRARY/`. Không đặt nó vào Git hoặc ZIP source công khai.

Gói gồm current state, toàn bộ journal theo revision và các tệp bằng chứng được tham chiếu trong checkpoint/lịch sử. Công cụ chỉ chép tệp khai báo, kiểm byte/SHA-256 và kiểm lại nguồn trước chốt manifest; không quét toàn bộ `.local`, không chép lock hoặc tự tìm token. Bằng chứng thuộc source public cần đúng gói mã. Tệp vốn thiếu và bằng chứng đã đổi được ghi thành ngoại lệ; không sửa hash lịch sử để làm chúng hợp lệ.

## Máy nhận

Sau khi giải nén source và cài dependencies ở checkout mới, kiểm rồi xem kế hoạch nhập. Có thể dùng Node portable với `scripts/session-context.mjs` thay npm nếu PATH khác phiên bản đã ghim.

```powershell
$contextBundle = 'D:/ListingStudio-transfer/SESSION_CONTEXT'
npm run session:verify-bundle -- --bundle "$contextBundle"
npm run session:import -- --bundle "$contextBundle"
```

Lệnh import mặc định chỉ xem kế hoạch. Nếu đúng gói/đích và không có xung đột:

```powershell
npm run session:import -- --bundle "$contextBundle" --apply
npm run session:status
npm run session:brief -- --feature setup-transfer
npm run session:verify
```

Công cụ giữ nguyên byte và đường dẫn tương đối của checkpoint/bằng chứng. Tệp đích đã có chỉ được giữ nếu cùng hash; khác nội dung hoặc có journal mới hơn thì dừng. Không xóa state, đổi revision hay chép đè để vượt xung đột. Bản nhập riêng bị ngắt có thể chạy lại theo đúng gói sau kiểm: chỉ các tệp còn thiếu được chép, không phát lại nghiệp vụ.

Biên nhận nhập nằm trong thư mục onboarding riêng của checkout, có digest manifest, revision, số tệp và ngoại lệ; không có lệnh Shopee, không sửa DB, không gỡ transfer hold hoặc resume batch. App/Docker không cần chạy để nhập context.

## Đối chiếu sau nhập

- Đúng revision và task; quyết định, câu hỏi, phạm vi và việc tạm dừng còn nguyên.
- Bằng chứng tồn tại có hash khớp; missing/changed phải giữ ngoại lệ và đọc đúng phần trước tiếp tục.
- Mốc source, database và context ghi riêng. Context mới hơn không làm database cũ trở thành dữ liệu mới nhất; thao tác sau snapshot có thể chưa có trong DB đó.
- Source ZIP không có Git metadata: `headChanged`/`repositoryChanged: not_recorded` là chưa biết; vẫn kiểm fingerprint tài liệu/code và hash bằng chứng. Không tự reset để biến trạng thái thành fresh.

Gói/manifest có dấu kiểm giúp phát hiện hư hỏng, không phải chữ ký hoặc quyền thực thi. Checkpoint không chứng minh tình trạng Shopee hiện tại. Trước lần ghi sau bàn giao vẫn cần đúng chỉ dẫn người dùng, nguồn và readback/journal thực. Chưa có `SESSION_CONTEXT` phải ghi rõ chưa chuyển trạng thái phiên, không đoán công việc cũ.
