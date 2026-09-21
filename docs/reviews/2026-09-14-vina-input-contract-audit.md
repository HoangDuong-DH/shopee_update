# Audit hợp đồng đầu vào Vina Tươi — 14/09/2026

Phạm vi: đọc mã, hợp đồng và thiết kế hiện có để đề xuất tiếp nhận Excel cùng thư mục Canva vào kho dữ liệu nội bộ. Không sửa ứng dụng, không chạy migration, không ghi DB chính, không gọi Shopee. Phân tích từng ô workbook và kiểm thư mục Canva là hai công việc riêng; báo cáo này không tự kết luận số SKU, mức giá, ý nghĩa tồn hoặc số listing từ tên nguồn.

## Kết luận

**Bổ sung sau khi đọc workbook thực:** nguồn Vina này là bảng nội dung/rà soát gồm 604 dòng của 4 nhãn, không có cột SKU vận hành, giá hoặc tồn đã được xác nhận. Có 57 ID listing và 547 ô ID trống; các số thứ tự không phải SKU. Vì vậy phần inventory và các bảng tổng quát trong đề xuất dưới đây là nhánh có điều kiện cho nguồn tương lai, không phải migration bắt buộc để nhận workbook này. Lát cắt hiện tại dùng `SourceCatalog` bất biến để lưu/tra cứu nội dung và bằng chứng, không tạo publication draft.

Đã đối chiếu thêm `workbook-profile.json`: `historicalNoteVsCurrentCells` giữ K7 (ghi chú cấu trúc cũ 15×4) và H7 (nhãn hiện tại 15×1) riêng, không tự coi phép đếm nhãn là cấu trúc model bán được; các ghi chú K70 so với H70 cũng không được tự xóa khi số nhãn khác nhau. `missingExecutionSeams` giữ riêng shop, ý định tạo/cập nhật, phiên bản nội dung, SKU/model, giá/tồn theo shop, vai trò ảnh, metadata ngành và nội dung các tệp Markdown chỉ được nhắc tới. UI phải giữ cả văn bản và ghi chú lịch sử với địa chỉ ô.

Nên thêm **tầng danh mục/tồn nguồn có phiên bản**, nằm trước bộ listing. Một dòng Excel có thể là một SKU, lô hàng, đơn vị đóng gói, bảng giá hoặc số liệu theo kho; một thư mục Canva cũng chưa tự chứng minh một listing. Cho phép lưu và tra cứu dữ liệu thiếu/mơ hồ ở tầng này. Chỉ liên kết vào bộ listing sau khi có bằng chứng về danh sách SKU, nội dung, vai trò ảnh và đích shop; không tự tạo `ListingDraft`, `PreparedDocument`, `WorkOrder` hay job khi nhập kho dữ liệu.

Đây là bổ sung một ranh giới còn thiếu, không cần thay toàn bộ hệ thống hay yêu cầu nhân viên nhập lại dữ liệu đã có.

## Phần có thể tái dùng và giới hạn thực tế

| Thành phần                                             | Có thể tái dùng                                                                                                                   | Giới hạn cần giữ                                                                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_files`, `BlobStore`, `Repository.createImport` | Upload gốc, SHA-256, loại tệp, hàng đợi đọc và chống lưu trùng bytes                                                              | Một `body` parser cho mỗi hash+kind; tên tệp đầu tiên được giữ khi dedup. Không ghi đè body KINI bằng kết quả inventory; mỗi lần nhận cần giữ tên/URL/đường dẫn riêng. `ready` chỉ nghĩa đã đọc tệp.              |
| `InputBatchState`, `InputLibraryRepository`            | Đợt nhận file, relative path, word/ảnh đã chọn, phiên bản bất biến, CAS, kiểm hash/kích thước                                     | Có giả định một nhóm thư mục là một bộ listing và claim `productKey` ổn định. Không dùng ngay cho thư mục Canva tổng chưa rõ membership. Giá chỉ chọn một sheet/profile cho cả đợt.                               |
| `SourceRef`, `Fact`, `CatalogRow`                      | Nguồn theo hash/ô/đoạn, giá dạng chuỗi, issue có nguồn                                                                            | `CatalogRow` chưa có inventory, đơn vị tồn, lô/hạn dùng/kho; `confirmed:true` từ parser không chứng minh ý nghĩa kinh doanh đã được xác nhận.                                                                     |
| `ImportPatchService`, `PatchSelection`, receipts       | Giá/tồn thưa theo block và đúng nhóm WorkOrder/shop, ô trống giữ nguyên, 0 rõ nghĩa, trước/sau có nguồn, cùng ý định có biên nhận | Chỉ nhận nhãn parser hiện tại; chỉ so với **bản nguồn đã lưu**, `remoteRead:false`. Không phải engine inventory và chưa phải ghi patch lên Shopee.                                                                |
| `handoffDocumentSchema`, `HandoffService`              | Bàn giao nguồn đã xác nhận, giữ scope, ảnh, Word và liên kết dòng giá                                                             | Yêu cầu membership/content/imageRoles đã xác nhận, SKU có giá dương. Không phù hợp để giữ candidate chưa đầy đủ.                                                                                                  |
| `buildPreparedSources`, `PreparedBatch`                | Kiểm file đã lưu, nguồn→listing hoàn chỉnh, snapshot/fingerprint, luồng xem trước/queue đã có                                     | Hiện yêu cầu sheet `Điều phối listing`, Word theo nhãn, giá/tồn đầy đủ, một ngành/thương hiệu/thuộc tính/kênh cụ thể; bìa 1:1/gallery 3:4; chỉ TEST. Đây là hợp đồng nghiệm thu hẹp, không phải parser mọi Excel. |
| `products/product_revisions`, `WorkOrderRepository`    | Bộ listing đã xác nhận và công việc theo shop có CAS                                                                              | Product revision khóa danh sách/thứ tự SKU và nhãn tầng. Không tạo product sớm rồi sửa nguồn để ép qua khóa; giá shop không ghi ngược vào bộ nguồn chung.                                                         |

Đường dẫn kiểm chính: `packages/domain/src/contracts.ts`, `input-library.ts`, `import-patch.ts`, `prepared-batch.ts`; `packages/domain/src/source/kini.ts`, `patch-workbook.ts`, `handoff.ts`; `packages/persistence/src/input-library.ts`, `repository.ts`, `work-orders.ts`; `apps/worker/src/imports.ts`; `apps/api/src/input-service.ts`, `import-patch-service.ts`, `prepared-source.ts`, `handoff-service.ts`; `apps/web/src/Resources.tsx`, `FolderIntake.tsx`, `folder-source.ts`, `PreparedBatch.tsx`.

## Hợp đồng dữ liệu nên tách

1. **Tệp/lần nhận nguồn:** file hash, tên khi nhận, URL nguồn nếu có, thời điểm lấy, phiên bản export, sheet/ô hoặc Canva design/page, kích thước ảnh và bytes. Dedup bytes không được làm mất việc cùng ảnh xuất hiện ở nhiều nơi.
2. **Dòng dữ liệu nguồn:** giữ giá trị raw, công thức và cached value riêng, kiểu ô, địa chỉ ô, tiêu đề cột và đơn vị. Kết quả chuẩn hóa chứa phép chuyển rõ ràng; phân biệt `observed`, `confirmed`, `needs_mapping`, `conflict`. Không đổi tên nguồn thành tiêu đề bán hàng.
3. **Danh tính SKU:** mã dạng chữ trong namespace nguồn/nhà cung cấp đã xác nhận. Barcode, SKU người bán, mã kho, mã combo và model ID là các khái niệm khác nhau. Dòng trùng mã vẫn được giữ như hai quan sát cho tới khi phân biệt kho/lô/bộ giá hoặc xác nhận trùng; không tự cộng hay gộp.
4. **Giá và tồn theo ngữ cảnh:** giữ nguyên nhãn giá, loại giá, tiền tệ, đơn vị bán, profile/bộ giá, ngày hiệu lực. Tồn nguồn có loại số liệu, đơn vị, kho/lô nếu nguồn có và thời điểm quan sát. **Tồn vật lý, tồn nguồn cung và lệnh tồn đăng bán tách riêng**. Thiếu scope shop hoặc ý nghĩa tồn thì chỉ tra cứu, không tạo lệnh.
5. **Bộ listing:** mã ổn định và membership có quyết định/nguồn riêng; giữ SKU, tên và thứ tự tầng/tổ hợp từ nguồn. Liên kết Word/text và ảnh theo vai trò; cùng ảnh có thể nhiều vai trò, thứ tự độc lập. Ảnh đẹp hoặc giống sản phẩm chỉ là gợi ý, không đủ xác nhận SKU.
6. **Đích shop và patch:** chỉ sau khi đã xác nhận liên kết bộ listing→shop/item/model. Giữ `environment/partnerId/shopId/itemId/modelId`, phiên bản nguồn/binding và snapshot đọc sàn riêng. Đối chiếu bằng ID và SKU đúng phạm vi, không ghép tên gần giống.

Đối với Canva: lưu URL/design/page và lần export; chỉ khi nhận bytes gốc mới có hash, kích thước và asset ID để dùng. Một URL Canva không phải file ảnh đã nhập, không tự chứng minh vai trò bìa/gallery/phân loại, cũng không cấp thêm quyền thực hiện hành động. Không ép bố cục mô tả Lamy lên Vina Tươi nếu nguồn không quy định như vậy.

## Migration/API/UI tối thiểu

Một migration mới có thể chứa năm bảng sau, không cần viết lại các bảng nguồn cũ:

| Bảng đề xuất               | Trách nhiệm                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_datasets`          | ID bộ dữ liệu ổn định, tên, namespace, loại `catalog/inventory/price/mixed/unclassified`, latest revision.                                                                        |
| `source_dataset_revisions` | Snapshot bất biến: source import IDs, tên/URL của lần nhận, mapping profile đã chọn, parser version, interpretation version, source/effective time, fingerprint và summary/issue. |
| `source_dataset_rows`      | Dòng có khóa trong revision, optional SKU chữ, kind, raw cells + facts + issues JSONB; FK revision. Index namespace/SKU cho tìm kiếm. Dòng không có SKU vẫn lưu được.             |
| `source_binding_sets`      | ID và latest revision của một tập liên kết đã đối chiếu.                                                                                                                          |
| `source_binding_revisions` | Liên kết bất biến theo nguồn: exact SKU/row→bundle, asset occurrence→role/order/variant, profile→shop nếu được xác nhận; giữ pending/conflict và nguồn quyết định.                |

Mapping profile có thể lưu trong dataset revision ở lát cắt đầu, không cần thêm hệ thống quản lý template lớn. Tái dùng trigger bất biến và CAS. Mọi foreign key revision phải đầy đủ. Dataset revision phải bao gồm **profile/phiên bản parser**, không chỉ hash file: cùng file có thể được đọc theo hai nghĩa khác nhau. Chỉ chuẩn hóa giá/tồn sang dạng gửi khi đã xác nhận nghĩa cột và đơn vị.

API đề xuất cho lát cắt lưu kho:

- Tái dùng `/v1/imports` cho bytes; thêm `POST /v1/source-datasets/preview` đọc raw blob với profile, trả coverage và ngoại lệ mà chưa tạo listing.
- `POST /v1/source-datasets` lưu exact preview bằng request ID/fingerprint/CAS; `GET /v1/source-datasets` và `GET /:id?revision=...` để tra cứu/mở lại.
- `POST /v1/source-datasets/:id/bindings/preview` và lưu binding phiên bản: cho phép chưa quyết định; không suy SKU hoặc role từ tên file thành confirmed.
- Chưa cần route publish/execute từ màn hình này. Khi nối cập nhật, bổ sung nhánh `datasetId + datasetRevision + bindingRevision + selectedFields` vào resolver patch, đọc facts từ DB và sinh `PatchOperation` có provenance. Không nhận raw price/stock từ UI để bỏ qua nguồn; không đổi tên cột qua một Excel trung gian mất dấu nguồn.

UI giữ một nơi **Kho đầu vào**: thêm vùng **Danh mục & tồn nguồn** bên cạnh bộ Word/ảnh. Luồng ngắn: **Nhận file → Đối chiếu cách hiểu cột → Lưu vào kho**. Hiện preview theo sheet/block, ngày nguồn, đơn vị, số dòng đọc được và ngoại lệ. Hỏi một lần ý nghĩa cột/profile rồi nhớ theo phiên bản nguồn; không bắt nhập lại từng SKU. Bộ chưa rõ linkage nằm ở **Chưa gắn listing**, không hiện `Sẵn sàng đăng`. Nguyên dòng có thể tra ô gốc; bộ lọc chỉ hiện phần thiếu/xung đột hoặc phần đã đổi.

Khi nhập file mới: chọn bộ dữ liệu cũ, hiển thị `mới/thay đổi/không đổi/không còn xuất hiện`; hàng thiếu không được xóa hay đặt tồn 0. Người dùng chọn phần cập nhật rồi lưu revision. Việc tồn trên Shopee giảm do bán hàng không tạo lệnh bù tồn từ import cũ.

## Bẫy cần tránh ngay với nguồn mới

- Worker hiện gọi `readKini` cho **mọi XLSX**. Nhãn `GIÁ BÁN` đang được hiểu là `promotionTarget` theo xác nhận KINI; không được tự áp nghĩa đó cho workbook Vina có quy ước riêng. Parser không có cột inventory. Giữ body cũ và thêm phân tích riêng, không sửa toàn bộ alias chung theo một file mới.
- Ba bộ đọc công thức khác nhau: `readKini` có thể dùng cached result và bỏ cell error; patch parser phân biệt lỗi/blank và nhận cached result; prepared dispatch từ chối công thức. Tầng kho cần giữ đủ raw formula/cache/freshness, không biến cached value thành số đã xác nhận. Lỗi ô không phải ô trống.
- Numeric SKU, số 0 đầu, đơn vị kiện/gói/cái/kg và combo không được sửa bằng suy đoán. Chuỗi tên chỉ là dữ liệu; không lấy nó làm khóa canonical khi SKU thiếu.
- Không tự lấy tồn vật lý để gửi `seller_stock`, không cộng lô/kho khi chưa có định nghĩa tổng, không lấy một bộ giá áp mọi shop. Bảng giá chung không xác định membership listing.
- `input_batch_products` claim lâu dài theo group; đổi tên/thư mục hoặc nhập lại trong đợt khác không thể được coi đơn giản là một listing mới. Cần binding ổn định dựa trên xác nhận, còn raw collection chưa cần productKey.
- `PreparedSource` hiện cứng một thuộc tính/một kênh và yêu cầu Word. Không bắt nguồn Vina tự chế đủ các cột này chỉ để lưu được vào database. Các thiếu hụt metadata/compliance nằm ở cổng chuẩn bị gửi sau.
- `source_files.status=ready`, dataset đã lưu, mapping đã xác nhận, publication metadata hợp lệ và remote QC verified là năm trạng thái khác nhau. Không gộp thành một dấu tích xanh.

## Cổng nghiệm thu lát cắt đề xuất

Nhập lại file không mất bytes/provenance và không tăng revision nếu cùng request; đổi parser/profile có revision riêng. Có SKU trùng, thiếu SKU, lỗi ô, công thức/0/blank, hai đơn vị, hai bộ giá/shop, cùng ảnh nhiều vai trò, nguồn ảnh chưa xuất và rename thư mục. Import cập nhật giữ các field không chọn; không có writes vào `products`, `work_orders`, jobs hay Shopee khi chỉ lưu dataset. Kiểm đếm độc lập hàng raw và hàng có thể diễn giải; không dùng số listing giả định làm đầu vào nghiệm thu.

## Cơ sở nghiệp vụ và tài liệu

Đã đọc `docs/superpowers/specs/2026-09-11-prepared-listing-publishing.md`, `2026-09-12-import-patch-design.md`, `2026-09-14-prepared-business-acceptance.md` và delivery input library. Các yêu cầu giữ nguyên listing, GIÁ GỐC/GIÁ BÁN KINI và tồn thủ công theo SKU/shop là xác nhận của người dùng, không phải giới hạn chung Shopee hay tự động áp cho mọi nguồn mới.

Đã đối chiếu đầy đủ bản chụp API ngày 08/09: [update_stock](https://open.shopee.com/documents/v2/v2.product.update_stock?module=89&type=1) và [update_price](https://open.shopee.com/documents/v2/v2.product.update_price?module=89&type=1). Hợp đồng API dùng item/model và seller stock/location; phản hồi có kết quả từng model, và điều kiện khuyến mại/địa điểm tồn cần đọc ở phạm vi thực thi. Vì vậy thiết kế nguồn phải giữ danh tính và ngữ cảnh riêng. Audit này không xác minh quyền/giới hạn hiện hành của shop Vina và không đưa con số mẫu thành policy. Khi nối ghi thật phải dùng metadata và readback hiện tại; chưa có hành động đó trong audit.
