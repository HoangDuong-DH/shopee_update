# Phản biện nghiệm thu E2E — 12/09/2026

Người thực hiện: agent nghiệm thu độc lập, đối chiếu với agent UX và agent backend. Phạm vi: đọc mã, test, báo cáo đã lưu và kho kiến thức; không sửa implementation, không chạy thêm phép ghi Shopee hoặc đụng nguồn Lamy. Mốc mã đọc: `da5e934`. Báo cáo này phân biệt kết quả đã chạy, kiểm chứng cục bộ và yêu cầu còn phải triển khai; không phải giấy nghiệm thu production.

## Kết luận

**Ứng dụng chưa hoàn thành luồng doanh nghiệp từ nhập nguồn đến đăng/cập nhật và phục hồi kết quả.** Ba vấn đề ưu tiên là:

1. **Sai đơn vị đầu vào cho cập nhật.** Luồng hiện tại ghép một bộ listing đầy đủ; nhu cầu cập nhật là nhập một phần dữ liệu có chủ đích. Chỉ đổi nút thành “Import” vẫn bắt nhân viên làm lại phần đã có.
2. **Đầu vào, liên kết với listing trên shop và lệnh thực thi chưa nối thành một luồng chung.** WorkOrder đang lưu được lựa chọn, nhưng chỉ có đường thử ghi ba trường trên đúng Lamy; tồn chưa nối thành lệnh thực thi. Nhánh tạo kỹ thuật riêng không chứng minh đăng mới từ Word/ảnh/Excel doanh nghiệp.
3. **Bằng chứng kiểm thử chưa bao phủ lời hứa sản phẩm.** Test xanh và 76 listing sandbox thành công là tài sản hữu ích, nhưng chưa chứng minh cập nhật đa trường/đa shop, nhiều ngành, QC, refresh token hoặc vận hành 24 giờ.

Không cần bỏ các lớp blob bất biến, phiên bản, CAS, checkpoint, khóa đích và test đã có. Cần bổ sung mô hình cập nhật từ nguồn và nối các lớp này qua một hành trình người dùng được kiểm chứng.

## 1. Yêu cầu của người dùng và bằng chứng hiện có

| Năng lực người dùng cần | Bằng chứng hiện có | Giới hạn nghiệm thu |
| --- | --- | --- |
| Một thư mục mỗi listing, Word/ảnh chuẩn bị sẵn, bảng giá chung | `folder-source.ts`, input library; test HTTP import với PostgreSQL thật; xem nguồn Lamy local | Nguồn không rõ cần chọn lại; chưa có bộ nghiệm thu đầy đủ nhiều ngành và cách viết Word khác nhau |
| Nhập lại Excel chỉ có SKU + giá hoặc tồn | `readKini` nhận header theo khối và giữ provenance giá | Header hiện yêu cầu SKU + TÊN SẢN PHẨM; `CatalogRow` chưa có tồn. Không phải trình nhập patch tối giản |
| Nhập chỉ bìa mới hoặc chỉ Word mới | Blob giữ nguyên bytes; folder roles và mapping đã có | `assembleFolderListing` vẫn báo thiếu Word, bìa, gallery và membership nếu không có. Cần luồng delta riêng |
| Tự ghép vào đúng listing/shop đã biết | WorkOrder có connectionId/itemId; kiểm SKU/tier trên đường Lamy | Chưa có registry liên kết tổng quát nguồn ↔ shop/item/model; itemId còn nhập tay. Tên thư mục/SKU không đủ làm khóa |
| Thay một hoặc nhiều yếu tố bằng import | WorkOrder có `fieldMask`; preview cho title/description/gallery | Chưa có hành trình nhập delta → đối chiếu → per-field patch → kết quả. `DraftField` chưa có bìa độc lập |
| Giá gốc đúng bộ giá, GIÁ BÁN riêng khuyến mại | Parser và source facts đã tách hai cột | Chưa có executor cập nhật giá/phương án khuyến mại được nghiệm thu cho nguồn doanh nghiệp |
| Tồn ảo thủ công theo SKU/shop, không tự bù sau đơn | WorkOrder giữ số tồn và chấp nhận 0; helper `shouldApplyStock` kiểm revision | Chưa nối ledger lệnh tồn với upload mới, worker, readback và recovery. Test helper không chứng minh tồn không bị bù trong app |
| Đăng mới hàng loạt | 80 nguồn kỹ thuật đã gửi thật; 76 đọc lại đạt, 4 lỗi | Nhánh API thử riêng, 1 ngành, 9 ảnh dùng chung, mọi link UNLIST; `createEnabled=false` trong Workbench |
| Cập nhật nội dung/ảnh đúng nguồn | Backend đã ghi Lamy title/description/gallery; giữ giá/tồn/phân loại | Bìa bị Shopee đổi mã, run còn unknown; chưa nghiệm thu E2E hoàn toàn |
| Tiếp tục sau mất mạng/khởi động lại | Integration cho intent/checkpoint/lease/CAS/unknown; recovery UI Lamy | Chưa có luồng giải quyết unknown create qua UI; chưa có phục hồi đa trường doanh nghiệp |
| Dùng chung nội bộ, không cần tài khoản nhân viên | UI không auth nhân viên, token mã hóa server, production gate | Hiện bind loopback và chạy dev process; chưa có package triển khai LAN/autostart/backup-restore đã nghiệm thu |
| Chính sách theo ngành/shop và QC | Hai KB và metadata sandbox; harness chỉ đọc | Không phải LLM/SDK/MCP runtime; chưa refresh policy, chưa QC nhiều chiều hoặc xác minh quyền shop production |

Bằng chứng mã quan trọng:

- `apps/web/src/folder-source.ts`: thiếu Word ở `WORD_FILE_UNRESOLVED`, bìa ở `COVER_NOT_SELECTED`, gallery ở `GALLERY_NOT_SELECTED`, membership ở `MEMBERSHIP_NOT_MAPPED`.
- `packages/domain/src/source/kini.ts`: `fieldOf` chưa có stock; điều kiện phát hiện header cần cả SKU và tên. `packages/domain/src/contracts.ts`: `CatalogRow` chưa có trường tồn.
- `apps/api/src/product-service.ts`: input/assembly dùng title, headline, body, gallery và variants; attributes/logistics được khởi tạo rỗng. Type có một trường không có nghĩa import/executor đã hỗ trợ nó.
- `packages/persistence/migrations/004_input_batches.sql`: product_key được claim duy nhất trong một batch/folder; chưa phải liên kết một đợt cập nhật mới với listing cũ trên shop.
- `apps/api/src/workbench-service.ts`: `CREATE_NOT_RELEASED`, `UPDATE_FIELDS_UNSUPPORTED`, phạm vi Lamy cố định; trả `productionWrites:false`, `createEnabled:false`.
- `apps/worker/src/main.ts`: worker nhập nguồn và bounded sandbox create trials; không chạy hàng đợi công việc doanh nghiệp tổng quát.
- `apps/api/src/app.ts`: status trả `listingExecutor:'not_configured'`.

## 2. Hợp đồng nghiệm thu cho import và patch

Phân biệt ba dữ liệu: **nguồn đã chốt**, **đợt cập nhật vừa nhập**, **dữ liệu shop vừa đọc**. Không trộn chúng thành một bản listing “mới nhất” rồi ghi đè toàn bộ.

### Cách hiểu dữ liệu nhập

- Cột/tệp/giá trị không được cung cấp: giữ nguyên; không biến thành xóa hoặc số 0.
- Số tồn `0`: giá trị đặt tồn rõ ràng, vẫn phải qua kiểm tra điều kiện trên shop.
- Xóa, thay cả gallery, thêm ảnh, đổi thứ tự: là các ý định riêng; việc thiếu ảnh không tự cho phép xóa.
- Một hàng bảng giá là nguồn dữ liệu cho SKU; không tự trở thành một listing, không tự gộp/tách danh sách SKU.
- Cột GIÁ BÁN không tự trở thành original_price hoặc tự tạo chương trình giảm giá.
- Import một file chỉ có nội dung/ảnh phải sử dụng liên kết nguồn/đích đã xác nhận; không bắt nhập lại giá hay toàn bộ SKU chỉ để thay bìa.
- Unknown role/target/column được đưa vào ngoại lệ. Màu ảnh, tên gần giống, giá gần nhau không đủ để tự ghi lên đích.

### Định danh và lệnh tồn

Một đơn vị thực thi cần nhận diện ít nhất môi trường, shop, item, model (nếu có), trường và nguồn/phiên bản. Khi cấu trúc kho cần thiết thì location cũng là một phần đích; không tự chọn kho hoặc giả định một kho.

Hash tệp chỉ nhận diện bytes. Excel “Save As”, đổi format hoặc thứ tự dòng có thể tạo hash khác nhưng vẫn cùng ý định dữ liệu. Bởi vậy cần dấu vết nguồn đã áp dụng và lệnh có phiên bản, không chỉ dedupe upload. Ngược lại, hai lệnh có cùng giá trị cũng có thể là hai yêu cầu hợp lệ nếu người vận hành chủ động đặt lại; không chặn vĩnh viễn bằng hash nội dung.

Ca quyết định: đặt tồn 100 một lần, shop còn 98 sau đơn hàng, nhập lại cùng bảng hoặc bảng cùng nội dung nhưng bytes khác. Mặc định không gửi lại tồn 100. Muốn đặt lại phải tạo lệnh mới rõ ràng, có snapshot mới và kết quả riêng. File giá thay đổi nhưng cột tồn giữ nguyên cũng không được biến toàn bộ tồn thành lệnh mới.

### Kết quả và phục hồi

Một lô có thể có các trường/mẫu hoàn thành, bị từ chối hoặc chưa rõ cùng lúc. Mỗi trường/đích phải giữ được receipt và bằng chứng đọc lại. “Có phản hồi”, “đã đối chiếu dữ liệu”, “đang/đã kiểm duyệt” là các trạng thái khác nhau.

Mất phản hồi sau ghi không cho phép chạy lại toàn bộ lô. Đọc lại trước; phần đã xác định hoàn thành không tải/gửi lại. Một giá trị tồn thấp hơn mong muốn sau timeout có thể có nhiều nguyên nhân, không được đoán rằng ghi thất bại rồi bù tồn.

## 3. Ma trận lỗi và bằng chứng cần có

Ký hiệu: **đã có** là bằng chứng ở nhánh hiện tại; **một phần** là có nền tảng nhưng chưa đi xuyên luồng mới; **thiếu** là chưa tìm thấy bằng chứng nghiệm thu tương ứng trong mã/báo cáo đã đọc. Không dùng số test làm phần trăm hoàn thành.

| Ca | Kết quả phải đạt | Hiện tại / bằng chứng |
| --- | --- | --- |
| SKU + chỉ giá, không tên/Word/ảnh | Nhập được, preview chỉ giá | Thiếu; parser KINI và full folder không phù hợp |
| SKU + chỉ tồn, có 0 và ô trống | 0 được chọn; ô trống giữ nguyên | Một phần; WorkOrder zero/blank test, chưa parser/lệnh tồn |
| Nhập Excel có hai bộ giá Mall/thường | Chọn đúng profile/scope, không fallback | Một phần; KINI/input-library tests, chưa patch ↔ shop |
| Cùng SKU ở hai shop hoặc hai link | Đích rõ; mơ hồ thì không ghi | Một phần; scope Lamy có kiểm, thiếu registry tổng quát |
| Nhập chỉ một bìa mới | Giữ gallery/nội dung/SKU; không yêu cầu full folder | Thiếu; `DraftField` chưa bìa, full folder blockers |
| Thay gallery nhưng không chọn bìa | Bìa giữ đúng bằng chứng, kể cả ID chuyển đổi | Một phần; regression đã có, Lamy còn unknown |
| Chỉ đổi Word, bố cục khác Lamy | Giữ thứ tự text/ảnh/xuống dòng theo nguồn | Một phần; paragraph mapping tests, chưa mọi block layout |
| Ảnh không tên vai trò rõ | Ngoại lệ visual; mapping đã xác nhận dùng lại | Một phần; folder fixtures để numeric roles unresolved |
| Nhập lại file y hệt sau hoàn thành | Không có mutation mới | Một phần; blob/input save idempotency, chưa patch receipt |
| Save As hoặc đảo dòng nhưng cùng ý định | Không bù lại tồn hoặc gửi lại phần đã áp | Thiếu E2E; không thể suy từ SHA dedupe |
| Giá mới nhưng cột tồn cũ sau đơn hàng | Chỉ đề xuất giá, tồn giữ | Thiếu E2E stock command ledger |
| Người vận hành cố ý đặt lại cùng số tồn | Lệnh mới rõ ràng, không lẫn replay | Thiếu luồng UI → ledger → executor |
| Preview xong người khác sửa nguồn/đích | Chặn đúng phần drift, bảo toàn thao tác đã lưu | Một phần; CAS/source/drift tests nhánh Lamy |
| Hai nhân viên gửi cùng lệnh | Một intent duy nhất, cùng receipt | Một phần; generic job/WorkOrder/trial dedupe, chưa patch flow |
| HTTP 200 có lỗi hoặc success/failure theo model | Không tô xanh toàn request/lô; map đúng model/location | Một phần; gateway/error tests, chưa price/stock adapter E2E |
| Bìa thành công nhưng giá bị chặn | Giữ thành công bìa, giá có lỗi và hành động rõ | Thiếu business multi-field executor/recovery |
| Timeout sau ghi đã áp ở remote | Đọc đối chiếu; không gửi lại mù | Đã có mô phỏng Lamy/create; thiếu bulk patch acceptance |
| Worker chết trước/sau checkpoint | Lease/fencing bảo vệ; intent unknown được giữ | Đã có create-trial integration; thiếu general patch integration |
| Token hết hạn giữa lô | Giữ checkpoint, phục hồi đúng revision, không nhầm shop | Một phần; manual renewal/CAS/auth pause, chưa refresh tự động |
| Lỗi nghiệp vụ lặp lại | Dừng có lý do, không chạy vô hạn/đổi nguồn | Guard 3 lỗi có test mô phỏng sau lượt thật; chưa live guard |
| Metadata/quyền/điều kiện shop thay đổi | Kiểm lại, không hardcode/fallback để pass | Một phần sandbox preflight; chưa đa ngành/production |
| 50–80 bộ ảnh/Word riêng nhiều ngành | Đúng nguồn, đủ trường, đúng model và readback | Thiếu; live 76/80 là fixtures sổ tay dùng chung ảnh |
| Dữ liệu đọc lại đúng nhưng QC chưa xong | Hiện chờ QC, không “đã duyệt” | Thiếu QC pipeline, có cảnh báo scope trong docs |
| Máy/API/DB khởi động lại và khôi phục backup | Không mất nguồn/liên kết/receipt/khóa; người dùng tiếp tục được | Một phần restart tests; thiếu restore drill + service packaging |
| Chạy 24 giờ với upload thực và lỗi pha trộn | Đo hàng đợi, memory, token, recovery, không backlog vô hạn | Chưa có soak; không ngoại suy từ 389,846 giây lô C |

## 4. Giới hạn API cần phản ánh trong thiết kế

Đã đọc bản đầy đủ `update_price` và `update_stock` trong KB snapshot **08/09/2026**. Đây là căn cứ lịch sử cho hợp đồng adapter và test, không phải xác nhận quyền/giới hạn hiện hành của mọi shop. Không thực hiện cuộc gọi Shopee trong audit.

- [update_price](https://open.shopee.com/documents/v2/v2.product.update_price?module=89&type=1): mục response mô tả `success_list`/`failure_list` theo model; lỗi có khóa giá/khuyến mại, shipping price limit và item không thuộc shop. Trạng thái HTTP/top-level không đủ chứng minh cả danh sách model đã cập nhật.
- [update_stock](https://open.shopee.com/documents/v2/v2.product.update_stock?module=89&type=1): cập nhật seller stock theo item và model; có location theo cấu trúc/quyền, điều kiện reserved stock, response theo model/location. Không biến số tồn ảo do người dùng quyết định thành một nút bypass điều kiện sàn.
- Đặc biệt `update_stock` có nhiều lỗi mang tên `error_auth` nhưng mô tả là điều kiện kho, reserved stock hoặc holiday mode. Không được dùng quy tắc chung “mọi error_auth đều là token hết hạn”. Phân loại phải theo endpoint và bằng chứng đã xác minh; lỗi không rõ giữ ngoại lệ, không tự sửa giá/tồn hay tắt khuyến mại.
- Không lấy mảng rate limit `[0,0,0]` hoặc số ví dụ trong KB làm quota. Giá trị thực phải xác minh theo scope trước khi mở đường ghi tương ứng.

Tài liệu update_price không ghi `source_updated_at`; update_stock ghi **31/10/2022** trong snapshot. Cần đối chiếu nguồn chính thức và quyền thật của ứng dụng trước khi dùng làm cam kết release. Các lĩnh vực QC, Mall/chứng từ và promotion chưa được audit này xác nhận đủ policy.

## 5. Release blockers và công việc có thể làm ngay tại máy

### Có thể triển khai và nghiệm thu cục bộ ngay

1. Sparse import/patch model cho Excel, Word, ảnh; absence/clear/set; mapping có phiên bản và provenance. Giữ lối nhập bộ mới đầy đủ song song.
2. Định danh liên kết nguồn ↔ shop/item/model; matching có xác nhận, không tự gộp. Preview thay đổi so với snapshot, ngoại lệ đúng dòng.
3. Command identity/receipt theo trường/đích; no-op/replay/new reset phân biệt; CAS và khóa đích dùng lại.
4. Hàng đợi patch bền với lỗi một phần, adapter simulator có trạng thái, mất phản hồi và thay đổi đồng thời; giữ production disabled.
5. UI nhập → chỉ xem thay đổi/ngoại lệ → lô → kết quả; import file/ZIP/thư mục, progress theo đơn vị thật. Thử trên browser qua API local thật với PostgreSQL schema cô lập, không mock toàn HTTP như bằng chứng duy nhất.
6. Telemetry đã lọc secrets, trạng thái việc/capability rõ; package dịch vụ nội bộ, health, restore drill và soak giả lập có số liệu.

### Chưa thể gọi hoàn chỉnh chỉ bằng test local

- Các adapter/trường phát hành phải được kiểm qua đúng sandbox scope được cho phép, giữ bộ nguồn và bằng chứng. Không mở rộng nhánh `SANDBOX QA` để ghi nguồn doanh nghiệp tùy ý.
- Lamy unknown cover cần một bước giải quyết có audit và bằng chứng; không đặt verified bằng tay hoặc chạy lại request cũ.
- Bốn lỗi C055–C058 vẫn chưa rõ nguyên nhân. Cần chẩn đoán sạch dữ liệu nhạy cảm; không sửa nguồn/retry để làm đẹp 80/80.
- Refresh token, scope thật nhiều shop, media riêng, các ngành đưa vào release và QC phải có acceptance riêng. Một endpoint gọi thành công không xác nhận quyền các endpoint khác.
- Mạng nội bộ/hosting, backup restore và hoạt động bền phải thử trên môi trường triển khai đã chọn.
- Production pilot cần phạm vi ghi được người dùng cho phép rõ. Hiện shop thật chỉ đọc; không “nghiệm thu” bằng cách tự ghi shop thật.

## 6. Cách kết thúc mỗi lát triển khai

Mỗi lát phải có đủ: hợp đồng đầu vào → UI dùng được → API/persistence/worker → lỗi/khôi phục → đối chiếu đầu ra. Nghiệm thu riêng theo `chỉ local`, `sandbox thật`, `production được phép`. Một bước bị blocked không làm toàn bộ tính năng được gắn nhãn hoàn tất.

Ưu tiên lát đầu **nhập bảng giá/tồn → đúng đích → patch preview → lưu lệnh và mô phỏng end-to-end với receipt bền**, sau đó nối executor được kiểm đúng scope. Tiếp đến dùng cùng hợp đồng cho **bìa/Word/gallery**, rồi **đăng mới từ bộ nguồn đầy đủ**. Việc chia lát không loại bỏ các chức năng người dùng đã yêu cầu; chúng vẫn là backlog release có gate riêng.

Tiêu chí chống lặp lại vòng thiết kế: một nhân viên nhận bộ file, hoàn thành lô, đóng trang, mở lại và giải quyết lô dở **không cần sửa JSON, gọi API bằng tay, nhập lại các dữ liệu đã có hoặc nhờ agent điều khiển Console**. Agent có thể hỗ trợ tra cứu/giải thích, không được thay việc chứng minh hành trình sản phẩm.

## 7. Bằng chứng và trao đổi phản biện

- Báo cáo trước audit: `.local/verification.json` tại **2026-09-12T02:46:12.816Z**: typecheck/build/legacy/unit-integration đều exit 0; `.local/test-results.json` có **333/333**. Audit này đọc lại báo cáo, không chạy lại hoặc sửa kết quả.
- `tests/e2e/workbench.spec.ts` khai rõ mọi endpoint đều browser fixture. Đây là bằng chứng UX nhánh mô phỏng, không phải UI → API → DB → Shopee.
- `tests/integration/sandbox-create-trials.test.ts` dùng PostgreSQL thật nhưng `StatefulTransport` và đồng hồ giả; khác bằng chứng live 76/80.
- `tests/unit/plans.test.ts` ca chống bù tồn chỉ gọi helper với revision. Chưa chứng minh import lại Excel giữ đúng command identity.
- `docs/delivery/2026-09-12-backend-sandbox-trial.md`, `docs/runbooks/sandbox-backend-trials.md`: phạm vi live, 4 lỗi, thời điểm pause, guard sửa sau và giới hạn throughput.
- `README.md`, `docs/runbooks/local-development.md`, `docs/delivery/2026-09-10-foundation.md`, `docs/superpowers/plans/2026-09-10-shopee-execution-ledger.json`: trạng thái task và giới hạn release. Ledger đã có nội dung 12/09 nhưng `updated_at`/`latest_evidence` ở cuối còn mốc cũ; cần đồng bộ metadata khi cập nhật tiến độ tiếp theo.
- Đã hỏi chéo agent UX/backend về thiếu full folder, nhiều shop cùng SKU, Save As, stock replay, sparse media semantics. Hai agent độc lập xác nhận parser không có stock và folder full-source không đáp ứng delta. Backend được cảnh báo riêng về success/failure theo model và sự đa nghĩa của `error_auth`.

Không có yêu cầu mở production, thay policy, thay nguồn hoặc thêm tài khoản nhân viên/MFA trong báo cáo này. Những giới hạn ghi giữ nguyên theo yêu cầu người dùng.

## 8. Phản biện spec mới và kịch bản browser nghiệm thu lát cắt

Đã đọc `2026-09-12-import-patch-design.md` và `2026-09-12-import-patch-plan.md` sau khi lập audit. Thiết kế mới giải quyết đúng ba điểm: parser thưa riêng, before ghi đúng là bản nguồn đã lưu, và save receipt không đồng nghĩa đã ghi Shopee. Đây là nghiệm thu **nhập/lưu/khôi phục patch nội bộ**, chưa đóng cổng executor.

Các chi tiết cần kiểm trước khi nhận implementation:

1. Phạm vi chọn target là công việc đã lưu phải hiện được shop/item rõ; không ép người dùng nhập lại full listing cho bìa/Word. Nếu chưa có registry thì ghi giới hạn “chọn công việc đã liên kết”, không quảng cáo tự tìm mọi listing trên shop.
2. Cùng một field tới cùng đích từ nhiều file phải được báo xung đột hoặc chọn rõ nguồn. Không âm thầm “file sau thắng”. Không gửi/chốt candidate do client tự cung cấp nếu server không kiểm lại nguồn và fingerprint.
3. Cần phân biệt patch chỉ có mục tiêu GIÁ BÁN (chưa hỗ trợ thực thi khuyến mại) với patch không có thay đổi; không bỏ cột này rồi báo đã xong.
4. Semantic duplicate chỉ dedupe biên nhận nhập/lưu trong lát này. Không được gắn claim “đảm bảo không bù tồn sau đơn” trước khi có execution ledger và readback của lệnh tồn.
5. Khi preview bị đổi target/Word/ảnh/sheet hay source revision thì invalidate lựa chọn cũ; reload phải khôi phục đúng scope và receipt, không tự áp sang bản mới nhất.

### Bộ nghiệm thu browser qua dịch vụ thật tại máy

Harness đề xuất: tạo schema PostgreSQL `test_*` riêng, BlobStore riêng, `createApp(repo, blobs, origins)` trên cổng loopback khác 4310, vòng `importNext` dùng đúng repository cô lập. Dùng UI build/proxy tới API này. Không chạy worker `main.ts` với `.env` doanh nghiệp, không seed trong public schema và không dùng endpoint Shopee. Chỉ dùng transport chặn ngoại mạng nếu một đường ngoài dự kiến được gọi. Không mock `/v1/import*`, preview/save/get/list bằng `page.route().fulfill()`.

Seed qua repository/service trong schema riêng: hai shop giả, hai bộ đã chuẩn bị, SKU trùng ở shop khác và một SKU giữ số 0 đầu. Tệp Excel/Word/PNG được tạo bằng thư viện với nội dung kỹ thuật mới; đây là fixture được phép, không đổi KINI hoặc Lamy.

| ID | Thao tác người dùng thật trong browser | Assertion độc lập tại API/DB |
| --- | --- | --- |
| IP-E2E-01 | Upload Excel có `SKU, GIÁ GỐC`; chọn work order; xem diff; bỏ một thay đổi; lưu; reload/mở lại | Source blob đúng hash; patch chỉ có giá được chọn, đúng SKU/shop; một receipt; product revision không đổi; không có Shopee job |
| IP-E2E-02 | Upload Excel `SKU, TỒN ĐĂNG BÁN` với `0`, trống và số nguyên khác | Preview có 0, không có operation cho trống; receipt giữ nguồn ô; không lấy tồn từ source cũ mặc định |
| IP-E2E-03 | Upload thư mục chỉ có PNG bìa; xác nhận target/role qua thumbnail | Chỉ cover operation; giữ gallery/Word/SKU; không đòi đủ bộ; bytes không crop hoặc thay đổi |
| IP-E2E-04 | Upload chỉ Word với khoảng trắng/dòng trống; chọn đoạn nguồn cho mô tả | Text trong receipt khớp đoạn gốc; không viết lại tiêu đề/gallery và không tự ghép bố cục ngoài selection |
| IP-E2E-05 | Upload hai file cùng đưa giá khác nhau cho một SKU/đích | Ngoại lệ rõ; không chọn theo thứ tự file; không lưu phần mơ hồ như giá đã chốt |
| IP-E2E-06 | Chọn shop A trong khi shop B có cùng SKU; preview rồi đổi sang B | Preview cũ vô hiệu; receipt đích đúng B hoặc yêu cầu xem lại; không còn before/scope của A |
| IP-E2E-07 | Lưu double-click; đóng/mở lại; nhập lại cùng ý định | Biên nhận ổn định và không tăng product/job; không ghi nhãn executed. Test riêng Save As/đảo dòng kiểm identity semantics |
| IP-E2E-08 | Browser A preview; browser B cập nhật WorkOrder/source; A bấm lưu | HTTP conflict, phần người dùng đã chọn còn nhìn thấy; không ghi receipt mang revision cũ như hiện hành |
| IP-E2E-09 | Xem bảng diff/hộp xử lý lỗi trên viewport 390px | Không overflow toàn trang; shop/field/action còn đọc được; bảng được cuộn nội bộ khi cần |

Trong mỗi ca ghi thêm network assertion: không có request tới Shopee và không có mutation route ngoài import/patch dự kiến. Bằng chứng cần gồm tên ca, timestamp, API receipt ID, truy vấn số lượng bản ghi trước/sau, screenshot, test result và commit/diff tương ứng. Bộ test này không đo thông lượng Shopee hoặc xác nhận production.
