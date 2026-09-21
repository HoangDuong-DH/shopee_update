# Rà soát độc lập luồng nhập và cập nhật cho người vận hành

Ngày: 12/09/2026. Phạm vi: đọc mã hiện có, hợp đồng dữ liệu và yêu cầu người dùng; không chạy thao tác Shopee, không thay nguồn sản phẩm. Đây là kết quả rà soát và đề xuất, không phải biên bản nghiệm thu giao diện hay production.

## Kết luận

Điểm nghẽn chính là ứng dụng hiện coi việc nhập là chuẩn bị **một bộ nguồn đầy đủ**, rồi yêu cầu người dùng tạo/cấu hình từng công việc. Người dùng lại cần **nhập một đợt thay đổi**, tự đối chiếu với những bộ và đích đã xác nhận, chỉ xử lý phần mơ hồ. Thay nhãn nút hoặc thêm một form nhập Excel vào WorkOrder chưa giải quyết được khoảng cách này.

Nên giữ kho tệp bất biến, nguồn có phiên bản, input batch và WorkOrder CAS hiện có; thêm hợp đồng nhập thay đổi tách biệt, rồi nối nó vào một hành trình thật trong app. Không mở executor doanh nghiệp chỉ để hoàn thành màn hình: nhánh hiện có chỉ thực thi phạm vi sandbox được ghi trong AGENTS.md.

## 8 phát hiện có bằng chứng mã

### 1. P1 — Bộ kiểm nhập đầy đủ không thể dùng cho bản cập nhật chỉ một trường

`apps/web/src/folder-source.ts:416` yêu cầu duy nhất một Word; `:549` trở đi kiểm bìa/gallery và `:570` trở đi cần membership, giá. `FolderIntake.tsx:442` chỉ bắt đầu assemble sau khi đã có bảng giá; `:691` đưa một assembly đủ sang Editor. Vì vậy một thư mục chỉ chứa bìa mới, hoặc một Word mới giữ giá cũ, không có đường tạo thay đổi độc lập.

**Hậu quả:** nhân viên phải mang lại toàn bộ tài nguyên hoặc dựng lại bộ trước khi sửa một phần. Dễ vô tình thay những phần không có trong yêu cầu.

**Sửa tối thiểu:** tạo `ImportedChangeBatch` bên cạnh `InputBatchState`; chế độ cập nhật cho phép chỉ có Excel, chỉ Word, chỉ ảnh hoặc kết hợp. Nạp baseline của bộ đã xác nhận; chỉ trường có dữ liệu và quyết định ánh xạ mới xuất hiện trong patch. Giữ bộ kiểm nguồn đầy đủ cho đăng mới.

### 2. P1 — Excel hiện là bộ đọc bảng KINI, chưa là đầu vào giá/tồn cập nhật

`packages/domain/src/source/kini.ts:29` và `:48` chỉ nhận các cột catalog đã liệt kê; không có tồn. Header phải có cả SKU và TÊN SẢN PHẨM (`:98`); `CatalogRow` trong `packages/domain/src/contracts.ts` cũng không có tồn. `Workbench.tsx:650` nhập tồn lần lượt vào `stocks[sku]` qua từng ô.

**Hậu quả:** bảng cập nhật tối giản `SKU | GIÁ GỐC | TỒN ĐĂNG BÁN` chưa thể đi đầu-cuối, dù nhân viên đã có đầy đủ giá trị.

**Sửa tối thiểu:** bộ đọc delta độc lập, chọn sheet/khối/bộ giá và xác nhận ánh xạ cột một lần; không bắt tên sản phẩm khi mapping SKU/đích đã rõ. GIÁ BÁN vẫn tách mục tiêu khuyến mại theo xác nhận người dùng. Cột tồn có thể vắng; ô trống là keep, số 0 là set 0. Công thức không có giá trị tính sẵn và ô lỗi phải là ngoại lệ, không được biến thành blank/keep âm thầm.

### 3. P1 — Định danh đợt mới chưa tái sử dụng định danh listing hoặc shop/model

`FolderIntake.tsx:573` sinh `input-${crypto.randomUUID()}` cho từng thư mục ở đợt mới. Định danh ổn định khi mở lại **cùng đợt**, nhưng cùng thư mục được nhập đợt khác có thể thành bộ mới. `Workbench.tsx:599` vẫn nhập `itemId` bằng tay. `WorkOrderConfig` có itemId và stocks keyed SKU nhưng chưa phải sổ liên kết variant → model dùng chung (`packages/domain/src/workbench.ts:13`).

**Hậu quả:** “nhập lại và tự biết cập nhật đâu” chưa có. Tên thư mục giống nhau hoặc SKU trùng giữa các shop dễ tạo lựa chọn sai đích nếu triển khai auto match giản đơn.

**Sửa tối thiểu:** registry liên kết có phiên bản `productKey → environment/connection/shop/itemId`, và `variantKey → modelId + sku + tierIndex`. Tự điền chỉ từ liên kết đã xác nhận còn hợp lệ. Thư mục mới chưa có liên kết hiển thị các ứng viên để xác nhận; không tự gộp theo tên, SKU hay hash. Dùng lại lựa chọn đã xác nhận cho lần sau, vẫn kiểm xung đột.

### 4. P1 — Hợp đồng hiện chủ yếu là ảnh chụp toàn bộ nguồn + fieldMask, chưa thể diễn tả patch chi tiết

`ListingDraft` giữ bộ đầy đủ; `WorkOrderConfig.fieldMask` chọn nhóm trường. `DraftField` chỉ có `gallery`, chưa tách bìa/ảnh mô tả/ảnh phân loại thành phạm vi thao tác độc lập. `handoffDocumentSchema` yêu cầu content/media/variants đầy đủ (`packages/domain/src/source/handoff.ts:21`), và `handoffChanges` so bản nguồn đầy đủ, không phải diff với dữ liệu shop.

**Hậu quả:** bỏ tệp khỏi bộ nhập có thể bị diễn giải sai thành xóa nếu tái dùng full replacement; chọn “giá” có thể không biểu đạt được chỉ hai SKU. Chỉ đổi bìa không được kéo theo gallery, ảnh mô tả hoặc ảnh phân loại.

**Sửa tối thiểu:** patch theo trường/variant với presence rõ: omitted = keep, set = giá trị có nguồn; clear chỉ nhận yêu cầu xóa rõ ràng và kiểm hỗ trợ riêng. Với mảng ảnh, biểu đạt vai trò + vị trí/định danh + thao tác thay cả bộ hoặc thay vị trí đã chọn; không suy “replace gallery” từ một ảnh vừa nhập. `fieldMask` có thể là kết quả biên dịch phía sau, không phải toàn bộ ý định nghiệp vụ.

### 5. P1 — “Nhìn ảnh là biết phân loại” không cung cấp định danh đủ để tự đăng

`folder-source.ts:465` dùng explicit selection hoặc quy ước tên ảnh; `:577` nhận diện SKU trong tên chỉ làm ứng viên và luôn giữ `MEMBERSHIP_NOT_MAPPED` khi chưa có mapping. Đây là hành vi bảo toàn đúng. `FolderIntake.tsx:614` lưu bìa/gallery/mô tả theo group nhưng `InputBatchState.visual` chưa chứa ánh xạ ảnh phân loại hoặc membership để dùng lại xuyên đợt.

**Hậu quả:** một thiết kế hứa tự nhận mọi ảnh từ hình thức sẽ phải đoán combo/SKU, nhất là ảnh giống nhau, màu gần nhau, tên ảnh chung và ảnh dùng ở nhiều vai trò. Ngược lại, bắt nhân viên gán lại tất cả ảnh mỗi đợt cũng không đáp ứng năng suất.

**Sửa tối thiểu:** tái sử dụng mapping đã xác nhận theo productKey + vai trò + vị trí/variant + hash tệp; ảnh mới/mapping thay đổi hiện trong hàng ngoại lệ với thumbnail. Có thể gợi ý từ tên/kích thước/nội dung nhìn thấy nhưng phải giữ nhãn chưa xác nhận; không suy thông tin thương mại. Một tệp có thể chủ ý dùng nhiều vai trò; hash giống nhau không có nghĩa chỉ được giữ một vai trò.

### 6. P2 — Giao diện hiện khiến người dùng khó phân biệt nguồn, đề xuất và dữ liệu đã lên shop

`Workspace.tsx:50` gọi danh sách nguồn là “Listing của tôi”, trong khi dòng `:569` thực tế là “Bản nguồn ... Đã lưu trong ứng dụng”. `Workbench.tsx:338` nút lưu công việc chưa gửi Shopee; các bước Handoff, Editor, Preview và WorkOrder đều có trạng thái “lưu/kiểm tra” khác nhau. `Workbench.tsx:632` hiện toàn bộ nhóm trường để chọn trước khi biết file mang thay đổi gì.

**Hậu quả:** nhân viên khó biết mình đang lưu bản nguồn hay đã cập nhật shop; nhiều form lặp và liên tục mở từng bộ. Việc tên là “Công việc đăng hàng” còn làm cập nhật hàng loạt thành nhánh phụ khó tìm.

**Sửa tối thiểu:** danh mục chính “Bộ nguồn”, “Nhập thay đổi”, “Công việc”. Trong bảng diff ghi rõ ba ý: nguồn cũ → dữ liệu vừa nhập; dữ liệu trên shop lúc kiểm tra → dự kiến gửi. Checkbox nhóm trường chỉ lọc/bỏ chọn patch đã phát hiện. Không trình một form trống mặc định cho 16 nhóm trường.

### 7. P1 — Contract có thuộc tính/ngành nhưng đường nhập nguồn chưa thực sự nhận đủ chúng

`apps/api/src/product-service.ts:85` tạo title/description/variants; `:92` và `:93` đặt `attributes: {}` và `logistics: {}`. Bảng nguồn có category/brand dưới dạng dữ kiện nhưng không tự tạo mapping ngành/thuộc tính đích. `workbench-service.ts:177` chỉ hỗ trợ cập nhật title/description/gallery cho nhánh thử giới hạn; các trường khác trả unsupported.

**Hậu quả:** UI cho chọn nhiều trường hoặc nhập đủ Excel không tự biến thành ứng dụng cập nhật mọi ngành. Không được ẩn vấn đề bằng cách ghi “sẵn sàng” ở cấp lô hoặc bỏ những trường chưa hỗ trợ.

**Sửa tối thiểu:** giữ giá trị nguồn và bảng coverage theo trường/scope. Chặn hoặc đánh dấu cần bước riêng cho trường chưa có adapter/kiểm thử; cho hoàn thành chuẩn bị dữ liệu có nguồn nhưng không hiển thị như đã gửi. Khả năng API động thuộc audit backend/KB, không suy từ type TypeScript.

### 8. P1 — Chưa có bằng chứng UI cho một lô patch với no-op, xung đột và kết quả từng phần

Workbench hiện tạo nhiều order trong vòng lặp nhưng cấu hình và SandboxReview xử lý từng order. Nhánh create 80 nguồn kỹ thuật là phép thử riêng, không kiểm hành trình nhập patch doanh nghiệp. Không có trải nghiệm: nhập file mới → chỉ dòng khác → tái nhập file không làm lại lệnh tồn → resume sau mất kết nối → chỉ xử lý phần chưa rõ.

**Hậu quả:** giao diện có thể trông hoàn chỉnh nhưng staff vẫn phải thao tác tay theo từng listing và không thể tự kết thúc công việc bị lỗi. “Đã nhận phản hồi” không đủ để gộp cả lô thành thành công.

**Sửa tối thiểu:** trạng thái batch cộng từ trạng thái từng target/field; no-op, chưa hỗ trợ, cần ánh xạ, xung đột, đang kiểm, đã chuẩn bị, đã xác nhận sau đọc lại. Lệnh tồn có command identity/phiên bản gắn đợt áp dụng; nhập lại cùng dữ liệu sau đơn hàng không tự đưa tồn về mức cũ. Chỉ tạo lệnh mới khi người dùng chủ động yêu cầu đặt lại.

## Hành trình tối thiểu có thể nối vào mã hiện tại

1. **Nhập thay đổi:** chọn cập nhật link đã có hoặc đăng bộ mới; nhận Excel hoặc một/nhiều thư mục. Chọn shop rõ ràng, dùng bảng giá chung theo sheet/khối/bộ giá. Hệ thống giữ nguyên byte và vị trí nguồn. Không bắt file không liên quan với phần cập nhật.
2. **Kiểm tra thay đổi:** mặc định chỉ dòng thay đổi/ngoại lệ, gom theo listing/shop. Mỗi dòng có nguồn ô/tệp, giá trị cũ ở nguồn, giá trị trên shop nếu đã đọc, giá trị nhập, phạm vi ảnh/SKU và lý do chặn. Tái sử dụng mapping đã xác nhận; sửa ngoại lệ ngay tại hàng thay vì quay lại toàn bộ wizard.
3. **Lưu công việc:** chốt phiên bản patch, target mapping và selected changes bất biến. Lưu bằng CAS trên server. Tải lại app mở đúng công việc và các tệp đã nhận. Không gọi “đăng/cập nhật thành công” ở bước này.
4. **Thực hiện và kết quả:** chỉ hiện hành động thực thi khi backend xác nhận adapter/quyền/phạm vi có sẵn. Giữ rào production/read-only và Lamy unknown hiện có. Một lô có thể có phần đã xác nhận, phần chặn và phần cần đọc lại; không gửi lại bừa phần đã thành công.

Không nên gộp bước 3 và 4 bằng một nút giả lập. Việc nối trọn hành trình local được nghiệm thu riêng với việc ghi Shopee, và phần live phải có bằng chứng API/readback riêng.

## Hợp đồng đầu vào đề xuất để đối chiếu với backend

| Thành phần | Nội dung cần giữ |
| --- | --- |
| Đợt nhập | ID đợt, revision, mục đích create/update, người dùng chọn scope, thời điểm |
| Tệp | importId, hash, đường dẫn tương đối, loại, trạng thái đọc; không trộn chỉ vì tên giống nhau |
| Ánh xạ bảng | phiên bản mapping, sheet/khối/bộ giá, cột SKU/giá/tồn/thông tin, dấu phân cách/đơn vị có nguồn |
| Định danh bộ | productKey hiện có hoặc unresolved; danh sách ứng viên không phải quyết định |
| Đích | environment + connection/shop + itemId; mỗi variant chỉ rõ modelId/tier và phiên bản liên kết |
| Thay đổi | trường/role/variant, keep/set/clear, giá trị nguồn, SourceRef, quyết định chọn/bỏ và lý do |
| Baseline | source revision + fingerprint snapshot shop + thời gian đọc; không đánh đồng hai baseline |
| Trạng thái | unchanged, proposed, needs_mapping, blocked, selected, prepared; executor bổ sung trạng thái gửi/đọc lại |
| Tồn | giá trị nguyên không âm, scope/variant, ID lệnh đặt tồn; import lại không tự tạo lệnh mới |

### Cần phản biện trước khi triển khai tự động

- SKU là khóa tra nguồn, chưa đủ là khóa đích. Cùng SKU có thể xuất hiện ở nhiều bộ giá/shop hoặc nhiều link; tự chọn dòng đầu là lỗi nghiệp vụ.
- Tên thư mục không phải ID bất biến. Mapping theo tên cần scope và xác nhận khi có trùng; tệp đổi hash có thể là revision mới, không phải sản phẩm mới.
- Cùng hash ảnh có thể nằm ở bìa và mô tả theo chủ ý; dedupe upload không được xóa vai trò.
- Không có Word trong đợt cập nhật nghĩa là giữ nội dung; không có ảnh mới nghĩa là giữ ảnh. Chuỗi trống/xóa phải yêu cầu riêng và được backend kiểm.
- Giá/tồn so với snapshot shop cần đọc lại trước thực thi nếu đã thay đổi; tuyệt đối không “đồng bộ liên tục file” thành tự bù tồn sau đơn.
- Tên trường có trong Excel nhưng chưa có mapper/endpoint phải giữ ngoại lệ; không im lặng bỏ cột.

## Ca nghiệm thu bắt buộc cho luồng nhập mới

1. Excel chỉ giá của ba SKU: hai dòng đổi, một dòng không đổi; không có trường tồn hoặc nội dung trong patch.
2. Excel có tồn `0`, tồn trống, công thức lỗi: lần lượt set 0, keep, blocked; không đồng hóa cả ba.
3. Nhập lại file đã áp dụng sau khi tồn shop giảm bởi đơn: không tự sinh lệnh bù tồn.
4. Một thư mục chỉ bìa mới cho bộ đã liên kết: không đòi Word/gallery/bảng giá, chỉ có patch bìa.
5. Hai thư mục ảnh có tên giống nhau: tệp không bị trộn giữa hai listing; ảnh chưa rõ vai trò hiện một ngoại lệ có thumbnail.
6. Cùng SKU trên hai shop/hai link: chọn đúng scope + item/model, không tự fan-out.
7. Một Word thay nội dung, giữ nguyên xuống dòng; không đổi title nếu chỉ chọn phần mô tả.
8. Reload sau khi import/mapping/preview: dữ liệu đã lưu phục hồi; sửa đồng thời ở tab khác báo CAS conflict.
9. Bỏ trường khỏi file hoặc bỏ chọn khỏi đề xuất: trường đó không xuất hiện trong payload.
10. Batch có unsupported/conflict/unknown/verified: tổng trạng thái không báo cả lô hoàn tất; chỉ cho readback trước retry với unknown.

Các ca mock, local integration, UI E2E và sandbox thật phải ghi riêng. Audit này không suy chính sách Shopee mới; đã đọc hai AGENT_GUIDE và dùng phạm vi đã ghi trong AGENTS.md, README và spec nguồn 11/09. Mọi giới hạn API mới cần đối chiếu tài liệu đầy đủ/current và response shop trước khi mở thực thi.
