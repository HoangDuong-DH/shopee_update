# Review tích hợp ListingStudio — 01/10/2026

## Trạng thái release

Bản nâng cấp nội bộ và các sửa chữa đang vận hành đã được kết hợp trên nhánh `codex/product-integration`. Đây là bản ListingStudio dùng để kiểm và chuẩn bị release. Sao lưu, phục hồi offline, xác minh migration và triển khai sang checkout vận hành đang tiến hành; chưa công bố hoàn tất triển khai hoặc commit release cuối khi chưa có biên nhận. Đăng hàng, sao chép, sửa listing thật và tự tiếp tục các đợt vẫn tạm dừng.

Không thay toàn bộ thư mục vận hành bằng một bản sao checkout. Mã release và các migration bổ sung được review riêng; cấu hình, khóa mã hóa, dữ liệu nguồn, kho blob, manifests và journal riêng phải được bảo toàn. Không xóa dữ liệu local hoặc đầu vào bên ngoài deployment.

## Công việc người vận hành

| Mục | Hành vi trong bản tích hợp | Ranh giới |
| --- | --- | --- |
| **Tổng quan** | Hiện trạng thái công việc/dữ liệu và shop được chọn; lỗi từng nguồn dữ liệu được báo riêng. | Không hiển thị số 0 thay cho kết quả chưa đọc được. |
| **Bộ listing** | Tìm kiếm và phân trang summary; mở có giới hạn đúng nháp/revision; chỉnh hàng loạt, giữ biên nhận và phục hồi. | Summary là projection hiển thị, không thay nguồn gốc hoặc bản nháp có thẩm quyền. |
| **Đăng hàng** | Chuẩn bị từ bản đã lưu, xem đợt, journal, link ẩn và xuất Excel QC. | Mapping và giá phải được xác nhận cho đúng nguồn/revision trước khi chuẩn bị. |
| **Shop** | Chọn đúng partner/shop, cấp quyền, xem trạng thái và phục hồi sau lỗi đọc. | Không tự chuyển sang kết nối khác khi scope đã chọn không tồn tại hoặc chưa đủ quyền. |
| **Công cụ** | Giữ Kho nguồn, nhập bộ cập nhật, workbench và kho lưu trữ. | Các luồng cũ giữ journal và giới hạn riêng; không dùng để vượt chốt nguồn. |

Navigation giữ URL và Back; các trang được tải khi cần. Kiểm giao diện bao gồm desktop, mobile và thao tác bàn phím. Callback cấp quyền lấy địa chỉ API từ cấu hình; trang kết quả quay lại đúng origin giao diện. Đọc lại trạng thái lỗi có thể thử lại mà không tạo một lần cấp quyền mới hoặc chuyển shop.

## Chốt nguồn và phục hồi

[Chốt nguồn](../runbooks/source-provenance-guard.md) áp dụng cho mọi ngành: số tầng, tên tầng, nhãn lựa chọn, tổ hợp SKU/giá, vai trò và thứ tự ảnh phải khớp khai báo độc lập của đúng bộ nguồn. Tên file, dữ liệu lịch sử hoặc phản hồi khớp payload không thay thế bằng chứng này.

Sau chỉnh phân loại hàng loạt, folder lineage và biên nhận chỉnh gốc được giữ. Server yêu cầu người vận hành xem và xác nhận mapping ràng buộc source hashes/revision; thao tác xác nhận tạo revision mới. Giá phải được xem và xác nhận theo revision mới đó. Thiếu hoặc mâu thuẫn giữ bộ ở trạng thái chờ; không tự gán SKU/giá/ảnh để làm kiểm tra xanh.

Scope production được ràng buộc với kết nối, partner/shop, nguồn, revision, fingerprint, operation và mục tiêu đã đăng ký. Mã hỗ trợ shop tổng quát thay cho giới hạn shop pilot cố định; điều này không phải nghiệm thu mọi shop hoặc cấp quyền gửi. Metadata lịch sử không khai báo scope vẫn phải thuộc đúng owner/connection; metadata có scope thiếu hoặc sai bị từ chối. Kết quả unknown phải reconcile trước retry; không replay create/init/publication đã có biên nhận. Trạng thái listing và các trường ngoài phạm vi cần được đọc lại và bảo toàn.

Một đợt chuẩn bị cũ đang hiển thị có **bốn bộ nguồn thiếu tệp chuẩn bị**. Đây là thiếu hụt đã có trước release, không được gọi là nguồn fixture hoặc bộ sẵn sàng. Giữ đợt tạm dừng, yêu cầu đúng nguồn trước khi phục hồi; không dựng lại bằng phỏng đoán, tạo receipt giả hoặc tự resume.

## Migration và dữ liệu

Tất cả migration **001–046** của bản vận hành giữ nguyên raw bytes, gồm **035** và kiểu xuống dòng của nó. Không sửa checksum đã áp dụng hoặc format SQL cũ để vượt readiness. Hai projection mới từng mang số 038/039 trong nhánh nâng cấp được đổi thành **047/048**, tránh đè lịch sử bản vận hành.

| Migration bổ sung | Mục đích |
| --- | --- |
| [047](../../packages/persistence/migrations/047_seller_knowledge_compact_projection.sql) | Summary seller knowledge bỏ phần raw khỏi đường đọc danh sách; observations gốc vẫn bất biến. |
| [048](../../packages/persistence/migrations/048_seller_knowledge_summary_trigger.sql) | Giữ summary khớp evidence cùng kết nối, kể cả khi code phiên bản trước ghi sau rollback. |
| [049](../../packages/persistence/migrations/049_dynamic_production_scope.sql) | Owner/scope production tổng quát; kiểm quan hệ connection, lane, operation và publication mà không đổi journal lịch sử. |
| [050](../../packages/persistence/migrations/050_source_import_fencing.sql) | Lease epoch/worker và kiểm hoàn tất import; worker cũ không được hoàn tất lease mới bằng ID riêng. |
| [051](../../packages/persistence/migrations/051_local_library_projections.sql) | Projection local library có tìm kiếm, phân trang và backfill; revisions nguồn vẫn là thẩm quyền. |

Giữ kiến trúc modular application với API, worker và các package hiện có: source guards, khóa, transaction và journal đang cần cùng một ranh giới dữ liệu. Projection có chỉ mục và tải có giới hạn giải quyết đường đọc lớn mà không tách thêm microservice trước khi có bằng chứng về nút thắt vận hành.

## Kiểm chứng ngày 01/10

| Phạm vi | Kết quả | Đã chứng minh / chưa chứng minh |
| --- | --- | --- |
| Full isolated `run-1bwVTX` | **2740/2740 unit/integration**, **7/7 legacy**, typecheck, repository skills, build TypeScript/web đạt. | Kiểm mã tích hợp với PostgreSQL thử; không chạy trên DB vận hành. |
| Intake browser trong cùng full run | **1/1 đạt**. | ZIP + Excel → worker nhập → nháp → chỉnh phân loại → mapping/giá theo revision → chuẩn bị → parent/child journal → link ẩn fixture → refresh → Excel QC. |
| Workspace browser chạy riêng | **7/7 đạt**. | Bốn mục chính và Back, đúng shop/không fallback, hai scope cách ly, lỗi từng resource, archive route, số đếm chưa biết khi DB lỗi, mobile/keyboard. |

Ca intake và workspace dùng UI/API/worker/PostgreSQL thật tại máy với nguồn tổng hợp do test tạo. Không fulfill toàn bộ API ứng dụng trong trình duyệt để thay kiểm backend. Metadata và phản hồi Shopee là fixture; không có fetch hoặc lệnh ghi Shopee thật trong các ca nghiệm thu này. Bảy ca workspace không được cộng vào số ca của full run. Kết quả không chứng minh mọi shop/ngành, mọi cập nhật production, quyền nhiều nhân viên hay vận hành liên tục 24 giờ.

Entry points: [intake spec](../../tests/e2e/internal-acceptance-intake.spec.ts), [workspace spec](../../tests/e2e/product-workspace.spec.ts) và [verifier cách ly](../../scripts/verify-internal.mjs). Sau khi khởi tạo dependencies/database cách ly theo [runbook](../runbooks/internal-development.md), chạy từ root của checkout thử bằng Node 24:

```powershell
node scripts/verify-internal.mjs --dry-run
node scripts/verify-internal.mjs --browser
```

Verifier bắt buộc loopback PostgreSQL 5443/database thử, tắt writer và bảo trì kết nối, dùng dotenv rỗng và fixture browser tự chọn schema/cổng. Đây không phải lệnh migrate, deploy hoặc khởi động lại bản vận hành. Schema đã có migration history không tương thích phải được giữ riêng; không ghi lại checksum để dùng nó như schema sạch.

## Điều kiện hoàn tất triển khai

Người điều phối release cần ghi biên nhận backup và phục hồi offline, đối chiếu byte các migration cũ, dữ liệu bảng và hash tệp, rồi xác minh migration 047–051 trên bản phục hồi. Backup phải gồm dump database, blob nguồn, media/manifest/journal/receipt ngoài `DATA_ROOT` đang được tham chiếu và bản cấu hình/khóa được bảo vệ riêng. Tệp đã thiếu không thể được backup bằng cách lập manifest mới; phạm vi các roots được chọn không chứng minh toàn bộ lịch sử riêng đã đủ, backup offsite hoặc chính sách lưu 24 giờ.

Sau khi xác minh backup/restore và chốt release commit, mới chuyển mã, áp migration bổ sung và kiểm readiness/heartbeat/giao diện. Không chạy API/worker trên database phục hồi có kết nối/công việc thật để kiểm nhanh. Không bật hai writer, tự resume lô cũ hoặc tự gửi Shopee khi khởi động lại. Trạng thái triển khai trong review và handoff sẽ được cập nhật theo biên nhận thực tế.
