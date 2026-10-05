# Kiểm tra bàn giao trước khi dùng

Ghi **phiên bản mã, máy đã kiểm, ngày, người thực hiện và kết quả từng bước**. Phân biệt kiểm local/fixture (nguồn và phản hồi giả lập), chuyển dữ liệu thật, đọc API thật và ghi API thật. Bước chưa chạy ghi “chưa kiểm”; một biên nhận setup không thay biên nhận restore hoặc kiểm tại máy nhận.

## Máy mới chưa nhận dữ liệu cũ

| Kiểm tra | Bằng chứng cần có |
| --- | --- |
| Đúng gói mã | Phiên bản từ Git hoặc biên nhận ZIP; sửa chưa commit được ghi rõ. |
| Môi trường | Node từ 24.20.0 đến trước 25, npm, Docker Linux/Compose v2 sẵn sàng; chủ máy đã hoàn tất quyền hệ thống cần thiết. |
| Thiết lập | `onboarding:setup` hoàn tất trên database mới do công cụ sở hữu; không ghi đè cấu hình/dữ liệu cũ. |
| Thư viện tham chiếu | Với app đầy đủ: `REFERENCE_LIBRARY` verify/import đạt, có cả hai bộ tài liệu và biên nhận nhập. Nếu chỉ kiểm source/build và thiếu thư viện, ghi rõ phần chưa có. |
| Điều kiện local | `npm run onboarding:check` báo đúng source/dependencies/build/database/cổng. |
| API/database | `/health/ready` trả sẵn sàng; giao diện tải được dữ liệu. |
| Worker nhập | Bộ nguồn fixture được nhập xong; bản nháp và tệp còn đọc được sau tải lại. |
| Giao diện | Mở được Tổng quan, Bộ listing, Đăng hàng và Shop; dữ liệu thiếu hiển thị rõ. |
| Giới hạn ghi | Production/pilot và bảo trì tự động tắt; không có lệnh Shopee trong kiểm local. |

Cổng mặc định: readiness ở `http://127.0.0.1:4310/health/ready`, web ở `http://127.0.0.1:5173`. Nếu dùng cổng khác, lấy địa chỉ từ biên nhận của bản cài.

## Máy nhận đã chuyển dữ liệu cũ

Theo [Chuyển máy và phục hồi](TRANSFER_AND_RECOVERY.md). Kiểm riêng các mục sau; worker được giữ lại khi có transfer hold, nên không dùng tiêu chí worker online của cài trống để ép khởi động nó.

| Kiểm tra | Bằng chứng cần có |
| --- | --- |
| Phạm vi bộ riêng | Manifest SHA-256 và `verify` đạt; dump, blob, hồ sơ ngoài DB và các file key cần bàn giao có đủ. Nguồn ngoài phạm vi được ghi rõ. |
| Thư viện tham chiếu | `REFERENCE_LIBRARY` đã kiểm và nhập trước START: hai manifest, `search.sqlite`, các Markdown được tham chiếu và biên nhận nhập còn đọc được. |
| Đích restore | Bản setup mới có biên nhận; schema tương thích, dữ liệu ứng dụng trống trước nhập, API/web/worker đã dừng. |
| Cấu hình máy nhận | Database password/cổng/quyền sở hữu Docker giữ đúng đích; không chép `.env` máy nguồn đè lên. |
| Cặp database và key | `APP_ENCRYPTION_KEY` đi cùng dump giải mã được credentials; kiểm offline và chỉ báo số lượng/kết quả, không in token. |
| Toàn bộ key yêu cầu | `secrets/connection-keys.json` có trong manifest đã kiểm; đối chiếu phạm vi các trường credentials được lưu. Thiếu/không giải mã được phải ghi ngoại lệ. |
| Nguồn và hồ sơ | Số nguồn/bản nháp/công việc/journal khớp báo cáo lúc export; tệp mà DB tham chiếu đọc được và SHA đúng. |
| Chuyển đường dẫn | `source-root-map.json` và `transfer-relocation.json` ghi đường đã chuyển; chỉ storage paths được sửa, raw source, journal/payload và fingerprint lịch sử giữ nguyên. |
| Kết quả restore | `transfer-state.json` có `status: complete`, cả năm bước hoàn tất và dấu kiểm cấu hình khớp biên nhận; chưa tự mở app. |
| Trạng thái công việc | `transfer-hold` còn hiệu lực; production/pilot/bảo trì tắt, worker chưa chạy và job cũ chưa tự resume/replay. |
| API/UI xem dữ liệu | Mở được màn hình, preview một bộ nguồn và các ngoại lệ; kết nối/ghi Shopee chưa được thử trong bước phục hồi offline. |

Nếu chỉ diễn tập ở một thư mục/container khác trên cùng máy, ghi **diễn tập tại máy hiện tại**. Chỉ đánh dấu **đã kiểm máy nhận** khi đã chạy trên đúng máy đó, gồm điều kiện Docker, quyền truy cập tệp và cổng. Hướng dẫn này không tự xác nhận một lần restore hay vận hành 24 giờ đã đạt.

## Kiểm nguồn và quy trình

Với một bộ fixture có Word/ảnh/bảng giá rõ ràng:

1. Nhập nguồn, mở bản nháp và đối chiếu đúng tên sản phẩm.
2. So số tầng, tên tầng, từng nhãn lựa chọn và tổ hợp SKU/giá với chính nguồn đó; kiểm đúng bộ giá/sheet/ô.
3. So vai trò, số lượng, thứ tự và nội dung ảnh bìa/gallery/phân loại/mô tả.
4. Sửa rồi tải lại để kiểm lưu bền; mapping và giá phải gắn với phiên bản mới.
5. Bộ thiếu nguồn được giữ riêng, nêu phần cần bổ sung; không tự ghép ảnh, SKU hoặc giá.

Luồng đầy đủ: **nguồn → bản nháp → shop đúng → bản chuẩn bị đã chốt → link ẩn → đọc lại → QC**. Kiểm local dùng fixture/công cụ cách ly cho phần gửi và đọc lại. Trên bản restore đang giữ, chỉ xem/đối chiếu; dùng môi trường fixture riêng cho nhập và thực thi thử.

Developer dùng `npm run test:onboarding` cho cơ chế thiết lập. Kiểm UI/backend/database rộng hơn theo [môi trường cách ly](../runbooks/internal-development.md) và `node scripts/verify-internal.mjs --browser`; không chạy kiểm tổng vào database vừa chuyển từ vận hành.

## Kết nối và tiếp tục sau bàn giao

Key/token được lưu lại chưa chứng minh quyền Shopee còn hiệu lực. Khi được giao kiểm kết nối, chủ shop cấp quyền nếu cần và backend đọc mới xác nhận đúng partner/shop/môi trường. Công việc đã gửi hoặc kết quả `unknown` giữ operation identity và journal; đọc lại trước quyết định tiếp tục. Không tự xóa transfer hold.

Một thao tác ghi thật về sau cần chốt nguồn độc lập, đọc hiện trạng đúng item, đọc lại trường mục tiêu cùng phần phải giữ sau ghi; link mới giữ ẩn chờ QC. Ghi rõ phần chưa có nguồn/quyền hoặc chưa thử API thật. Cài local/restore đạt không chứng minh mọi shop, ngành hàng, kiểu cập nhật, cấp quyền cloud hay 24 giờ đều đạt.

## Biên bản ngắn

```text
Phiên bản/gói mã và bộ dữ liệu:
Máy, ngày và người kiểm:
Môi trường/cổng (không chứa mật khẩu):
Setup local/fixture đã đạt:
Export/manifest/restore đã đạt hoặc chưa kiểm:
REFERENCE_LIBRARY: hai bộ tài liệu/verify/import/biên nhận:
DB/key/blobs/journal/paths đã đối chiếu:
Transfer hold và worker:
Đọc/ghi Shopee thật đã thực hiện (nếu có):
Ngoại lệ, nguồn/quyền cần bổ sung:
Việc tiếp theo và người phụ trách:
```

Giữ biên nhận và bằng chứng riêng ngoài Git. Khi chưa có đủ biên nhận cuối, ghi phần thiếu; không báo toàn bộ bàn giao đã hoàn tất. Đối chiếu [handoff hiện hành](../handoffs/PROJECT_HANDOFF.md) trước khi báo phạm vi hoàn tất.
