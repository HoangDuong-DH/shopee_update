# Review độc lập backend nhập patch — 12/09/2026

Phạm vi: Task 1 trong `docs/superpowers/plans/2026-09-12-import-patch-plan.md`; mã trước thay đổi `da5e934`. Review mã domain/parser/API/persistence và test, không sửa implementation/test, không gọi Shopee. Đây là review lát nhập/preview/lưu/khôi phục nội bộ, không nghiệm thu executor hoặc toàn dự án.

**Verdict Task 1: đạt review tuân thủ spec và chất lượng cho lát chuẩn bị patch nội bộ.** Đã đọc báo cáo cuối `.local/import-patch-review/task-1-report.md`, diff package cuối và bản sửa parent/range. Không còn finding chặn Task 1 trong phạm vi đã review. Đây chưa phải nghiệm thu Task 2/3, executor hoặc production.

## Findings đã trao đổi và sửa

| ID | Phát hiện độc lập | Kết quả kiểm lại |
| --- | --- | --- |
| R1 | `patch-workbook.ts` bỏ dòng SKU trống dù giá/tồn có giá trị, không có issue | Đã thêm `PATCH_SKU_REQUIRED` và test riêng; dòng trống hoàn toàn vẫn bỏ qua |
| R2 | Cột tồn duy nhất thuộc profile Mall bị sao chép sang profile Thường | Đã tái hiện in-memory: hai profile cùng stock 10, issues rỗng. Bản sửa phân scope riêng; test không copy single stock sang profile khác |
| R3 | Stock parent/range mâu thuẫn có thể bị loại khỏi mọi profile mà không có issue | Đã tái hiện in-memory với parent `["", "Mall", "Thường", "Mall"]`, header `[SKU, GIÁ GỐC, GIÁ GỐC, TỒN ĐĂNG BÁN]`. Bản cuối trả `PATCH_COLUMN_SCOPE_REQUIRED`; regression test bao phủ dữ liệu tái hiện. Đã đóng |
| R4 | `ImportPatchService.source()` nhận ảnh/Word/workbook không thuộc `fileRefs`; manifest trùng đường dẫn chưa bị chặn | Đã kiểm `PATCH_SOURCE_OUTSIDE_MANIFEST`, `PATCH_MANIFEST_INVALID` và tests. Cùng bytes có thể có alias đường dẫn khác nhau; không bắt ảnh cũ được giữ nguyên phải nhập lại vào manifest |
| R5 | Ảnh/Word chỉ kiểm ready metadata; bytes gốc thiếu hoặc sai vẫn có thể chuẩn bị receipt | `imported()` đã đọc BlobStore (kiểm SHA) và so byte count. Corrupted image test chặn `PATCH_SOURCE_INTEGRITY` |
| R6 | File chỉ có các cột chưa hỗ trợ bị báo thiếu header chung chung | Đã có diagnostics `PATCH_UNSUPPORTED_COLUMN` với tên cột dù không có trường cập nhật đã hỗ trợ |
| R7 | Word mới với ảnh mô tả cũ dễ bị ghép theo paragraph đầu mặc định | Code hiện yêu cầu explicit `images_after_first_paragraph`; image-only chỉ reuse bố cục khi `sourceSelection` được compile khớp chính xác bản nguồn. Test có cả nhánh blocked và explicit |

## Các điểm hợp đồng đã kiểm trong mã

- Giá/tồn là patch theo work order/shop; `preview`/`save` không gọi `saveProduct`, không cập nhật cấu hình WorkOrder, không tạo `stock_instructions` hoặc Shopee job.
- Giá trị do server đọc từ Excel/Word/ảnh; schema strict không nhận arbitrary giá/nội dung do client gửi ngoài selection.
- Ô/tệp thiếu giữ nguyên; tồn 0 tồn tại trong operation; blank text không được suy ra xóa. Gallery/image replacement rỗng không được hỗ trợ ngầm.
- WorkOrder/source/item/shop/connection revision được pin; source mới hơn hoặc work order đổi phải xem lại.
- Save tái tính preview fingerprint; chỉ selected operations có trạng thái changed và không blocked được lưu. Xung đột hai nguồn cùng field/đích được đánh dấu, không “file cuối thắng”.
- Repository dùng transaction, khóa request và semantic fingerprint, khóa đọc WorkOrder/product/connection để kiểm revision tại biên lưu; receipt/association/request có immutable triggers.
- Exact replay có thể trả receipt cũ sau khi scope công việc đã đổi. Đây là khôi phục biên nhận lịch sử, không phải xác nhận bản cũ vẫn phù hợp để thực thi.
- `comparisonBasis:'saved_source'`, `remoteRead:false`, receipt `state:'prepared'`, `PATCH_EXECUTOR_NOT_RELEASED` và không có execute endpoint giúp giữ đúng giới hạn lát này.

## Quyết định sau phản biện hai chiều

**Credential revision:** Không đưa revision chỉ thay token vào semantic business-intent key, để token refresh không tạo thêm ý định tồn. Receipt trả lại là historical preparation. Executor về sau bắt buộc kiểm lại connection/capabilities/snapshot trước ghi; không gửi một receipt lịch sử chỉ vì thao tác replay thành công. Chấp nhận quyết định này, không xếp thành blocker của Task 1.

**Cùng bytes ảnh, ID mới:** Finding sơ bộ về dedupe description image qua importId được rút lại sau khi đối chiếu `Repository.createImport` và `UNIQUE(sha256,kind)`: cùng bytes cùng loại được trả cùng source ID trong storage hiện tại. Không mở rộng scope sửa một lỗi chưa tái hiện được. Nếu đổi kiến trúc định danh ảnh sau này, cần kiểm lại semantic dedupe.

**Lưu đề xuất khi remote unknown:** Được phép lưu proposal nội bộ; không được xóa recovery lock hoặc làm như đã có thể thực thi. Các blocker được giữ trong receipt. Không yêu cầu gọi lại Lamy hay sửa trạng thái unknown để test đạt.

## Bằng chứng kiểm thử

Reviewer tự chạy `tests/unit/import-patch-parser.test.ts` và `tests/integration/import-patch.test.ts` lúc **16:45:47 ICT**, kết quả **25/25 đạt**, duration 6,51 giây. PostgreSQL dùng schema test riêng; API integration dùng `createApp`; không Shopee. Sau mốc này implementer bổ sung test/bản sửa, số cuối phải lấy từ báo cáo cuối của chính diff đó, không gán 25/25 cho mã đã đổi tiếp.

Báo cáo cuối implementer ghi **28/28** lúc **16:49 ICT** và full typecheck đạt sau đó. Đã đọc các ca bổ sung cho stock scope và replay alias trong mã cuối; không chạy lại suite trùng lặp. Compatibility **78/78** trước bản sửa diagnostic cuối được ghi riêng, không cộng vào 28.

Đã đọc bộ test: price-only không tên/full listing, stock zero, malformed/formula/numeric SKU, duplicate headers/SKU, profile isolation, cover-only, Word exact text/layout, field conflict, manifest membership, blob integrity, scope/source drift, save replay, HTTP preview/save/get/list và thiếu execute route. Đây chưa phải bằng chứng browser UI → HTTP upload/worker → PostgreSQL của Task 2/3.

## Giới hạn còn lại không được đổi nhãn

- Chỉ chuẩn bị theo WorkOrder đã có liên kết. Chưa phải registry tự tìm listing/model trên mọi shop.
- Before là bản đã lưu ở ứng dụng, không phải dữ liệu sàn hiện tại. Source unchanged không chứng minh remote unchanged.
- Receipt nhập/lưu không phải execution ledger cho tồn; không claim đã bảo đảm chống bù tồn sau đơn trong hệ thống thực thi hoàn chỉnh.
- Không có executor patch, model/location reconciliation, refresh tự động, QC hoặc production acceptance trong lát này.
- Ma trận đầy đủ và các cổng còn lại nằm trong `2026-09-12-e2e-acceptance-audit.md`.
