# Bàn giao kỹ thuật và vận hành nội bộ

Tài liệu này mô tả cốt lõi hệ thống và điều kiện để bàn giao. Bắt đầu từ [PROJECT_HANDOFF](PROJECT_HANDOFF.md) để biết phạm vi đang được xác nhận. Những mục bên dưới ghi rõ yêu cầu nghiệm thu; sự tồn tại của tài liệu hoặc test fixture không có nghĩa tất cả tính năng đã hoàn tất. Không có chức năng AI mới trong phạm vi nâng cấp này.

## Phạm vi bàn giao của nhánh ngày 23/09

Ứng viên nằm trên nhánh `codex/internal-operations`, tách riêng database/cổng/dữ liệu với bản vận hành. Các mục kết nối, đăng nhập và phân quyền nhiều nhân viên được để sau theo yêu cầu. Bản này chưa được merge hoặc khởi động thay bản vận hành; không công bố là hệ thống đã nghiệm thu mọi shop hoặc đưa qua LAN an toàn.

Các đường dùng trực tiếp đã nối: ZIP/thư mục + Excel nội dung/giá → chọn SKU thật → lưu bản nháp → bỏ/sắp phân loại → chuẩn bị theo shop → tạo link ẩn → đối chiếu/giữ mục cần QC → báo cáo Excel. Luồng trình duyệt liên tục đã chạy trên API, worker nhập và PostgreSQL thật cách ly; riêng phản hồi Shopee dùng fixture. Trường hợp chưa có SKU được giữ lại trong kho nguồn. Mã nguồn, nguyên tắc và bằng chứng chi tiết nằm trong [biên bản QA](../reviews/internal-acceptance-20260923.md).

Những lỗi thực tế được sửa gồm: biên nhận sửa hàng loạt bị compiler hiểu nhầm là trường sản phẩm lạ; nguồn thay đổi sau đăng ký vẫn nhận lệnh chạy; nút tiếp tục bật trước khi khóa được nhả; tải lại làm đợt còn chờ QC bị ẩn khỏi danh sách mặc định. Không sửa nguồn hoặc hạ tiêu chuẩn SKU/giá để làm kiểm thử đạt.

Báo cáo chỉ xuất dữ liệu được chọn rõ từ nhật ký, gắn shop/partner và phiên bản nguồn, giữ tên sản phẩm, lý do và việc tiếp theo. ACK không được đếm thành link đã xác minh. Báo cáo không gọi Shopee để làm mới và không thay thế QC của nhân viên. Giá trị Excel bắt đầu bằng dấu `=` vẫn là chữ; token và phản hồi thô không được đưa vào file.

Giới hạn còn phải biết: chỉnh thêm/ánh xạ lại SKU tổng quát trên nháp đã lưu chưa được hỗ trợ; hãy hoàn thiện ánh xạ tại bước nhập. Nội dung gõ chưa lưu trong Editor chưa có phục hồi sau forced refresh. Khởi tạo kho của shop hoàn toàn mới, mọi loại ảnh/ngành, tải kéo dài và backup dữ liệu doanh nghiệp thật cần nghiệm thu riêng. Phục hồi khi đã reserve nhưng chưa kịp ghi binding/checkpoint vẫn giữ lại để kiểm tra thay vì tự gửi lại.

## Hệ thống làm gì

Mục tiêu sử dụng: nhân viên tự nhập nguồn, ghép ảnh/SKU/giá, chỉnh sửa, chọn shop, tạo link ẩn, theo dõi và QC. Tạo link ẩn và mở bán là hai hành động khác nhau. Một sản phẩm thiếu dữ liệu phải có lý do và đường sửa; không khiến người dùng mất dấu các sản phẩm còn lại.

```text
Ảnh / Word / Excel
        ↓
API nhận tệp → Blob theo SHA + hồ sơ nhập trong PostgreSQL
        ↓                         ↓
Worker phân tích nguồn → bản nháp có phiên bản
        ↓
Người dùng xem, chọn giá/SKU/ảnh và shop
        ↓
Chuẩn bị / kiểm tra → manifest bất biến của đợt
        ↓
Điều phối thực thi → journal từng bước → Shopee OpenAPI
        ↓                              ↓
Theo dõi / đối chiếu ← đọc lại trạng thái thật
        ↓
Link ẩn + danh sách QC → mở bán bằng hành động riêng
```

Đây là cấu trúc chức năng. Nhập thư mục tổng quát, luồng cập nhật và các công cụ legacy có thể có mức hoàn thiện khác nhau; xem từng route và biên bản nghiệm thu, không coi mọi nút hoặc script trong repository là một đường production đã duyệt.

## Công nghệ và ranh giới

| Khu vực | Công nghệ / nơi đọc code | Trách nhiệm |
|---|---|---|
| Web | React, TypeScript, Vite; `apps/web/src` | Biểu mẫu, chọn nguồn/shop, hiển thị tiến độ và lỗi |
| API | Node 24, NestJS trên Fastify; `apps/api/src` | Xác thực dữ liệu, điều phối, quản lý kết nối, phục vụ HTTP |
| Worker | `apps/worker/src` | Nhận công việc nhập và phân tích, heartbeat; không đồng nghĩa mọi tác vụ production đều ở worker này |
| Nghiệp vụ | `packages/domain` | Hợp đồng dữ liệu, kiểm tra và quy tắc xác định |
| Lưu trữ | PostgreSQL, `packages/persistence` | Nguồn, phiên bản, trạng thái, migration và cạnh tranh cập nhật |
| Tệp | `BlobStore`, thư mục `DATA_ROOT/blobs` | Giữ byte nguồn theo hash; tên thư mục Desktop không phải định danh |
| Tích hợp | `packages/shopee`, export `@shopee/gateway` | Ký/gửi/đọc API và mã hóa secret; đối chiếu tài liệu chính thức khi đổi hợp đồng |
| Harness có sẵn | `packages/agent-runtime` | Corridor kiểm tra và điều phối xác định; không mặc định có model AI |
| Kiểm chứng | Vitest, Playwright, `scripts/verify.mjs` | Unit/integration, kiểm UI và build; phân biệt fixture và Shopee thật |

Giữ PostgreSQL và các cơ chế hiện có. Không thêm message broker, Snowflake hoặc AI chỉ để đổi kiến trúc. Trước tối ưu, đo số request/dung lượng/thời gian API, truy vấn và render; ưu tiên điểm đang gây nghẽn thực tế.

Luồng production đang nâng cấp dùng `production-scope.ts` để giữ shop/partner bất biến trong ngữ cảnh bất đồng bộ và `ProductionWorkflows` tạo service graph riêng từng shop. Route phải có scope rõ; promise, cache và admission gate không dùng chung giữa shop. Các entry point runner/loader và đọc preparation kiểm scope của dữ liệu đã lưu; mặc định pilot lịch sử chỉ dành cho công cụ cũ chưa truyền scope. Unit test đã kiểm chạy xen kẽ, callback nền, cache và từ chối UUID/manifest khác shop. Đây chưa phải nghiệm thu đăng thật nhiều shop hoặc bootstrap capability cho mọi shop.

## Những điều developer phải giữ

- **Shop là một phần của phạm vi dữ liệu:** lựa chọn, metadata, token, khóa thực thi, manifest và readback phải cùng shop/partner/môi trường. Hỗ trợ nhiều shop phải được kiểm xuyên suốt; đổi dropdown hoặc bỏ một literal không đủ.
- **Hash không phải idempotency:** hash cho biết dữ liệu đổi; mã thao tác nhận diện lần gửi. Unknown sau timeout có thể đã tạo sản phẩm: đọc lại trước retry, không tạo mới chỉ vì thiếu phản hồi.
- **ACK không phải verified:** có item ID chưa chắc đủ phân loại, giá, tồn và ảnh. Đối chiếu đạt dữ liệu gửi cũng không chứng minh kích thước tạm hoặc nội dung đã QC đúng nghiệp vụ.
- **Bản chuẩn bị là snapshot:** sửa nháp phải hiện khác biệt và tạo/cập nhật preparation đúng phiên bản; không âm thầm sửa manifest đã thực thi.
- **Không tự chế SKU/giá/ảnh:** mọi ánh xạ phải có tệp/ô dữ liệu hoặc lựa chọn đã xác nhận. Thiếu dữ liệu có vấn đề riêng, không âm thầm thay từ nguồn khác.
- **Lỗi có phạm vi:** lỗi một listing giữ listing đó; lỗi quyền/token dừng shop liên quan; DB không ghi được thì ngừng nhận lệnh ghi. Không bắt mọi lỗi rồi tiếp tục ghi.
- **Không ghi đè QC trên sàn:** trước cập nhật phải có bản đọc lại mới và nhận biết khác biệt. Không sửa state DB để làm nút chạy sáng.
- **Chỉnh sửa đồng thời:** đối chiếu revision/fingerprint tại server, giữ bản người dùng đang sửa và báo xung đột; khóa nút phía client không đủ.

## Quy trình nhân viên cần nghiệm thu

| Bước | Kết quả nhân viên nhìn thấy |
|---|---|
| Chọn shop | Tên, ID, kết nối và khả năng thao tác rõ ràng |
| Nhập nguồn | Các bộ đã nhận; bộ thiếu, nguồn ảnh và bộ giá được chọn |
| Kiểm tra/sửa | SKU/giá/ảnh đúng nguồn; lỗi mở đúng trường; preview thao tác hàng loạt |
| Tạo link ẩn | Xác nhận đúng shop và số bộ; tiến độ riêng từng bộ |
| Theo dõi | Tiến độ xử lý, trạng thái trên shop và việc tiếp theo tách riêng |
| QC | Link sàn, dữ liệu đối chiếu, thông tin tạm và người chịu trách nhiệm |
| Bàn giao | Báo cáo thành công/đang xác minh/cần sửa có lý do; không cộng ACK thành thành công |

Một phiên đóng trình duyệt, refresh hoặc API tạm mất kết nối không được làm mất công việc đã nhận. Retry phải gắn công việc cũ và không tự phát lại mutation chưa rõ kết quả.

## Vận hành và chuyển phiên bản

- [Phát triển cách ly và cập nhật](../runbooks/internal-development.md): worktree, cổng/database/data riêng, khởi động rehearsal không đụng bản đang dùng.
- [Sao lưu và diễn tập phục hồi](../runbooks/internal-backup-restore.md): dump, blob, receipt root, key giữ riêng và giới hạn của công cụ.
- [Khởi động hiện có](../runbooks/local-development.md): đọc đối chiếu checkpoint với runtime thật. PID hoặc số test lịch sử không phải tình trạng hiện tại.

Luôn có người sở hữu release, backup và xử lý job unknown. `/health/live` chỉ nói API còn sống; `/health/ready` nói database/schema sẵn sàng; heartbeat không chứng minh công việc đã xong. Không chia sẻ token qua ticket, file report hoặc Git.

## Điều kiện bàn giao doanh nghiệp

Chỉ đánh dấu từng điều kiện đạt khi có ngày, commit, môi trường, kết quả và người nghiệm thu:

1. Luồng thao tác tay từ nguồn tới link ẩn/QC/báo cáo hoàn thành bằng UI, không cần script riêng hoặc Codex.
2. Chọn shop, revision, dữ liệu nguồn và quyền gửi được kiểm tại server; nhiều shop được kiểm bằng dữ liệu có chủ đích, không suy từ một pilot.
3. Refresh/bấm đôi/mất phản hồi/khởi động lại/sửa đồng thời và một bộ lỗi giữa lô không gây mất việc hoặc tạo trùng.
4. Backup được diễn tập phục hồi đủ database, blob, manifest/journal và khả năng lấy lại kết nối; có mục tiêu thời gian phục hồi và mức mất dữ liệu chấp nhận được.
5. Có phạm vi tải đã đo: số người dùng, shop, listing/lô, số ảnh, tổng dung lượng và thời gian chờ. Không tuyên bố tải không giới hạn.
6. Nếu triển khai cho nhiều nhân viên hoặc qua LAN, có đăng nhập, quyền hành động theo shop, audit actor/before/after và bảo vệ endpoint; không coi ứng dụng bind loopback là hệ thống phân quyền đã hoàn thiện.
7. Release có cách ngừng nhận ghi, drain công việc và phương án rollback phù hợp migration. Rollback DB không hoàn tác được ghi trên Shopee.

**Trạng thái của bộ công cụ vận hành này:** có launcher cách ly, công cụ backup theo gốc được chọn, checksum và restore-rehearsal vào database trống. Ngày 23/09/2026 đã migrate và diễn tập PostgreSQL thật trong container riêng cổng 5443: backup/restore 74 bảng, một dòng giả lập và blob tham chiếu khớp, ba tệp snapshot kiểm SHA đạt; restore lần hai bị chặn vì đích có dữ liệu. Chưa khởi động API/worker trên bản restore, chưa dùng dữ liệu/token production và chưa chứng minh phục hồi toàn bộ dữ liệu doanh nghiệp. Quyền nhiều nhân viên, phạm vi nhiều shop, cập nhật production tổng quát và tải dài hạn cần biên bản riêng trước khi công bố đạt.

## Nhập nguồn được bổ sung trong worktree

- FolderIntake dùng cùng importer gốc cho thư mục và ZIP; ZIP lồng có giới hạn, bìa riêng ghép bằng STT duy nhất, không sinh ảnh/SKU. Xem [hướng dẫn nhập](../runbooks/internal-source-intake.md).
- ContentWorkbookService đọc XLSX nguyên theo cấu hình sheet/header/cột rõ ràng; không dùng kết quả bộ đọc giá làm nội dung. ContentWorkbookIntake cho preview và xử lý STT trùng trước áp dụng theo lô.
- InputBatchState.contentSelections giữ binding ô và SHA; InputService kiểm lại bytes, InputLibraryRepository giữ source reference và revision. Content folder claim nối bản nháp với batch revision; server kiểm đúng giá và ảnh thuộc bộ.
- Kiểm tập trung đã chạy:5 unit nội dung,1 integration PostgreSQL cách ly,1 browser fixture; cùng32 ca nguồn/ZIP/lưu lô liên quan. Không là bằng chứng nghiệm thu production hoặc mọi workbook doanh nghiệp. Kiểm kiểu toàn worktree đạt sau bổ sung.
- Chưa tự suy ra SKU/phân loại từ Excel nội dung. Hồ sơ đủ membership mới lưu tự động cả lô; phần chưa rõ đi luồng chọn tay hiện có. Không có model AI.

### Hoàn tất nối API nội dung

ContentWorkbookController đã đăng ký vào ứng dụng chung; InputService nhận cùng bộ đọc nội dung, POST sản phẩm truyền kho byte vào bước xác minh. Lỗi nội dung có phản hồi 400/404/409 cùng hướng xử lý tiếng Việt. Compiler chuẩn bị đăng đọc lại nội dung từ XLSX nguyên dù bộ đọc giá của tệp đó thất bại; nếu chữ lệch, chặn riêng bản chuẩn bị và giữ nguyên nguồn. Snapshot ghi thêm biên nhận tệp nội dung.

Lượt kiểm cuối riêng cho phần nối: 54 ca trong ba tệp (48 compiler nguồn, 5 nội dung, 1 integration PostgreSQL/API) đạt; kiểm kiểu đạt. Integration đi HTTP thật tại máy cho đọc workbook, chọn cột, lưu đợt và lưu sản phẩm; fixture không gọi Shopee. Vite thử riêng 5273 đã dừng sau kiểm.

### Listing đầu tiên của shop mới

Worktree bổ sung bootstrap quyền ảnh bằng đúng listing ẩn được chọn, permission gắn scope/manifest/source/revision/document và chỉ thử phần chưa biết. Không tạo listing tổng hợp để thử quyền; không coi ACK hoặc hoãn QC là capability verified. Selector bằng chứng cùng shop ưu tiên đúng feature, collector không mặc định tên shop pilot. Trusted inventory có giới hạn khai báo1.000, pilot lịch sử200; mọi trang và model phải đầy đủ. Thiếu tham chiếu kho vẫn bị chặn có field/scope, không tự tạo location.

Chi tiết, kiểm chứng và giới hạn latency ở [khởi tạo listing ẩn](../runbooks/internal-first-hidden-listing.md). Đây là code + fixture/PostgreSQL cách ly, chưa chứng minh onboarding mọi shop live hoặc quét kho lớn không bị chậm. Codec1:1, kho shop hoàn toàn mới và inventory resumable chưa nằm trong phạm vi hoàn tất.

### Giữ bộ lỗi riêng và so sánh phiên bản nguồn

Runner đã phân biệt lỗi nguồn ở bước kiểm trước đăng với lỗi dùng chung của shop: nguồn thiếu thuộc tính/brand hoặc trùng SKU chưa reserve được giữ riêng, bộ độc lập tiếp tục. Lỗi đọc metadata không đầy đủ, xác thực hoặc journal unknown vẫn dừng; một lỗi local không được che lỗi hệ thống xuất hiện sau đó. Nguồn đổi trong lúc đợi khóa cũng được giữ đúng phiên bản, không tự thay vào manifest.

Service có `sourceChanges(id)` để giao diện đối chiếu snapshot đã chốt với nguồn mới, chỉ đọc dữ liệu local theo scope; có trạng thái thiếu/lưu trữ và before/after cho trường nghiệp vụ. Parent từ chối ngay khi chỉ còn nguồn chưa gửi đã lỗi thời, nhưng vẫn cho nguồn độc lập còn hợp lệ đi tiếp. Đã kiểm 109 ca batch/parent ở mốc đầu và 21 ca source-diff/parent ở mốc bổ sung (có phần trùng, không cộng thành tổng độc lập); typecheck đạt. Không sửa kết nối/đăng nhập hay gọi Shopee.

Xem [batch resilience](../runbooks/internal-batch-resilience.md) cho contract API và kiểm nghiệm. Bổ sung tiếp: recovery v3 đã xử lý crash sau claim trước reservation bằng bằng chứng lịch sử journal trống dưới đúng khóa, và gắn lần execute kế tiếp tới operation trước mọi API write. Biên nhận lịch sử vẫn hợp lệ sau khi successor hoàn tất. Crash sau reserve trước binding/checkpoint, sent/unknown hoặc dữ liệu mâu thuẫn vẫn giữ chặn an toàn; không xóa biên nhận để ép chạy.

Mốc kiểm phục hồi cuối: **100/100 focused tests** (41 runner, 50 service, 3 lifecycle, 6 PostgreSQL recovery) và typecheck đạt. File recovery/successor được sync rồi publish nguyên tử, không ghi đè biên nhận; đã kiểm trực tiếp filesystem Windows và khóa PostgreSQL cách ly. Nút execute chỉ bật sau khi lease coordinator thực sự được nhả. Chưa gọi đây là nghiệm thu toàn bộ manual UI, mất điện phần cứng hoặc mọi trường hợp phục hồi.
