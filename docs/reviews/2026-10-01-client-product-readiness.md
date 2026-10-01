# Nghiệm thu sản phẩm nội bộ và phương án tích hợp — 01/10/2026

> **Mốc tiếp nối 01/10:** bản nâng cấp đã kiểm tổng và triển khai tại `2ba212d`. Đọc [review release](2026-10-01-product-integration.md) cho trạng thái cuối, bảo toàn dữ liệu và giới hạn. Các nhận định chưa merge/chưa thử phục hồi bên dưới thuộc baseline trước sửa.

## Kết luận dùng để bàn giao

Ứng viên `codex/internal-operations` có một luồng thao tác nối được từ ZIP/Excel đến nháp, chỉnh phân loại, chuẩn bị theo shop, tạo link ẩn mô phỏng và xuất báo cáo. Đây là phần có thể tiếp tục hoàn thiện thành sản phẩm cho nhân viên dùng hằng ngày. Chưa có bằng chứng đủ để thay bản đang vận hành, mở ghi Shopee, hay gọi toàn bộ các shop/ngành/cập nhật là đã nghiệm thu.

Lượt rà soát này đọc mã, tài liệu, biên nhận kiểm thử và trạng thái cổng tại máy; không chạy kiểm thử, migrate, truy vấn database vận hành, restart dịch vụ, merge hay gọi API Shopee. Mọi thao tác đăng hàng tiếp tục nghỉ. Những lỗi giao diện/trạng thái bên dưới là quan sát trên baseline trước các sửa đổi ngày 01/10; chủ sở hữu triển khai phải gắn kết quả kiểm mới với bản mã cuối, rồi cập nhật trạng thái nghiệm thu.

## Hai bản mã và bằng chứng thực sự có

| Phần | Checkout vận hành `C:/shopee_product_uploader` | Ứng viên `.local/worktrees/internal-operations` | Ranh giới sử dụng |
| --- | --- | --- | --- |
| Điểm Git | `feat/internal-app`, tại `f315bba` trong lần đọc | `codex/internal-operations`, tại `0eebc2a`; hơn một commit về projection listing | Hai checkout đều còn thay đổi chưa commit; lịch sử một commit không thể hiện toàn bộ nâng cấp. |
| Nhập nguồn | Word/ảnh/Excel, folder mapping, nguồn pending, thư viện và nháp | Thêm ZIP nhiều thư mục, ghép Excel nội dung theo STT, sửa phân loại hàng loạt và tiếp tục nguồn | Luồng ứng viên có kiểm UI/API/worker/PG thật với tệp ZIP/XLSX/PNG tự tạo; nội dung sản phẩm là fixture. |
| Ghi production | Có executor/journal/readback, các phép create/publication riêng đã ghi nhận trong checkpoint cũ; thêm chốt nguồn mới | Service graph theo shop, so phiên bản nguồn, giữ nguồn lỗi riêng, phục hồi job và báo cáo | Việc có executor không đồng nghĩa được phép chạy lại job hay mọi đường cập nhật đã hoàn chỉnh. |
| Chốt nguồn | Có `production-source-contract.ts`, `production-batch-provenance.ts` và runbook chốt nguồn ngày 25–26/09 | Chưa có các file/cổng tương ứng trong baseline ứng viên | Phải giữ cổng của vận hành khi tích hợp; kiểm payload khớp readback không thay cho đúng nguồn. |
| Listing đã đọc | Có journal/bằng chứng lịch sử, mapping giá, archive/media/clone code trong thay đổi local | Có projection listing nhỏ và trigger giữ đúng khi code cũ ghi sau rollback | Có code archive/clone chưa đủ để kết luận chức năng đó đã được nghiệm thu. Bản chụp lịch sử phải có shop và ngày đọc. |
| Nghiệm thu regression | Biên nhận `.local/verification.json` ngày 30/09 ghi sáu bước exit 0; `.local/test-results.json` ghi 2.477 passed, 146 file, 0 failed/skip | Biên nhận `run-k86nfU` ngày 26/09 ghi sáu bước exit 0; 2.445 passed, 143 file, 0 failed/skip | Hai số này thuộc hai bộ mã khác nhau; không cộng và không coi là chứng cứ bản đã tích hợp ngày 01/10. |
| Trình duyệt | Các checkpoint sandbox/production lịch sử có phạm vi riêng | Ngày 23/09 có hành trình liên tục 1/1: nguồn → nháp → bỏ phân loại → chuẩn bị → chạy ẩn → refresh → XLSX | API, worker nhập và PG là thật cách ly; Shopee là `PreparedWirePlatform`. Kết thúc `UNLIST`, operation `acknowledged`, ảnh chưa QC. |
| Backup | Dữ liệu/khóa/nguồn riêng, không nằm trong Git | Công cụ selected-roots-only và rehearsal 74 bảng, một dòng giả lập, một blob, ba file | Chưa phục hồi toàn bộ app, journal, nguồn doanh nghiệp và token production. |

Bằng chứng ứng viên: [biên bản QA 23/09](internal-acceptance-20260923.md), [handoff ứng viên](../handoffs/INTERNAL_OPERATIONS.md:5), [test trình duyệt:39](../../tests/e2e/internal-acceptance-intake.spec.ts:39), [ranh giới transport fixture:51](../../tests/e2e/internal-acceptance-server.mts:51), [cấu hình Vitest:17](../../vitest.config.mts:17). Các biên nhận `.local` nêu ở đây chỉ tồn tại trên máy này, không phải tài liệu public. Không có báo cáo đo coverage được dùng trong kết luận; số ca xanh là regression, không phải tỷ lệ phủ mã hay số listing đã gửi.

## Mười khoảng trống cần xử lý hoặc giữ rõ trong bàn giao

| Ưu tiên | Phát hiện, trigger và hậu quả | Tiêu chí chấp nhận | Bằng chứng baseline |
| --- | --- | --- | --- |
| P0 | **Tích hợp có thể bỏ chốt nguồn mới.** Copy trọn ứng viên sẽ mất cổng đối chiếu độc lập số tầng/tên tầng/nhãn/SKU/giá/vai trò ảnh của vận hành. Nguồn bị ghép sai nhưng khớp chính payload đã gửi vẫn có thể được đánh giá tốt ở phần ghi. | Mọi đường prepare/register/start/writer giữ hợp đồng nguồn và bảng ánh xạ bất biến. Thiếu hợp đồng, đổi cấu trúc hoặc thiếu/đảo ảnh phải chặn đúng listing trước POST; nguồn đủ tiếp tục. Không dùng script lịch sử bỏ qua cổng. | [LIVE runner:708](C:/shopee_product_uploader/apps/api/src/production-pilot-runner.ts:708), [LIVE batch service:676](C:/shopee_product_uploader/apps/api/src/production-batch-service.ts:676), [LIVE runbook](C:/shopee_product_uploader/docs/runbooks/source-provenance-guard.md:17). Các module tương ứng chưa có trong baseline ứng viên. |
| P0 | **Byte migration đã áp dụng khác nhau.** `035_production_qc_wait.sql` ở vận hành có một dấu cách cuối dòng mà ứng viên không có. Logic SQL nhìn giống nhau nhưng SHA khác. Probe/migrate so raw SQL; thay file có thể trả 503 hoặc `MIGRATION_CHECKSUM_CHANGED`. | Giữ nguyên byte/checksum đã áp dụng của từng môi trường. Không format, cập nhật checksum trong DB, đổi tên hay chạy lại migration cũ. Logic mới dùng migration bổ sung. Rehearsal trên bản sao offline phải kiểm toàn bộ schema mà bản mã cuối yêu cầu. | [checksum/probe:15](../../packages/persistence/src/db.ts:15), [migrate:58](../../packages/persistence/src/db.ts:58), [LIVE ghi nhận sự cố:56](C:/shopee_product_uploader/docs/runbooks/local-development.md:56), [035 ứng viên:39](../../packages/persistence/migrations/035_production_qc_wait.sql:39). |
| P0 | **Không có một bộ mã tích hợp đã chốt.** Lần đọc có 30 đường dirty trùng giữa hai checkout, 27 file khác nội dung, gồm app, compiler, runner, UI và contracts. Ứng viên có `038/039_seller_knowledge_*`; vận hành có `036`–`046` mapping/archive/media khác. | Snapshot riêng hai bộ dirty, chọn từng hunk theo hành vi và chạy lại toàn bộ trên commit/bộ SHA cuối. Xem các file migration có cùng số đầu như các tên đầy đủ khác nhau; review thứ tự/phụ thuộc, không tự rename migration đã áp dụng. Không merge trực tiếp vào checkout đang phục vụ. | Kết quả read-only `git status`, `git rev-list --left-right --count feat/internal-app...codex/internal-operations` = `0 1`, so SHA file và danh sách migration ngày 01/10. Bổ sung sau đối chiếu: tên hiện tại [projection 047](../../packages/persistence/migrations/047_seller_knowledge_compact_projection.sql:1), [trigger 048](../../packages/persistence/migrations/048_seller_knowledge_summary_trigger.sql:1); 038/039 ở đoạn này là tên trong baseline. |
| P1 | **Shop đã chọn có thể bị đổi âm thầm.** UI lọc chỉ shop `connected`, rồi dùng shop đầu khi shop được chọn không còn trong danh sách. Khi shop chuyển sang `refresh_unknown`, người dùng có thể thấy một shop khác thành đích thay vì lý do giữ riêng shop cũ. | Giữ shop đã chọn cho đến khi người dùng đổi rõ; hiện expired/refreshing/refresh_unknown/disconnected đúng dữ liệu. Ghi bị khóa theo shop đó; kho/nhật ký của shop khác không thay thế. Kiểm đổi trạng thái trong khi đang mở preview/job. | [Workspace lọc và fallback:154](../../apps/web/src/Workspace.tsx:154), [bằng chứng index nhiều shop hiện có](C:/shopee_product_uploader/docs/reviews/2026-09-26-listing-database-performance.md:10). |
| P1 | **Một endpoint lỗi làm mất toàn bộ cold load.** Sáu GET nằm trong một `Promise.all`; nếu `/v1/jobs` hoặc `/v1/plans` lỗi, các kết quả imports/products/shops thành công chưa được set. Người dùng có thể thấy kho trống và chỉ một lỗi chung. | Dữ liệu thành công vẫn hiện; phần lỗi có nhãn, ngày đọc và nút thử riêng. Không biến lỗi/timeout thành số 0. Giữ dữ liệu lần trước với nhãn cũ; kiểm cold load và poll bị lỗi độc lập. | [refresh:196](../../apps/web/src/Workspace.tsx:196). Đây là hành vi cần sửa, chưa có test cold load lỗi một slice trong nghiệm thu 23/09. |
| P1 | **Deep link và lịch sử trình duyệt chưa tương ứng navigation.** `restoredPage` chỉ nhận URL `page=shops`; các màn khác dựa sessionStorage. Link mở job/kho và Back/Forward có thể mở màn cũ của phiên. | URL biểu đạt được màn đích; reload/deep link/Back/Forward mở đúng màn. Navigation giữ cảnh báo đang upload/chưa lưu, không làm mất nội dung hay tự submit. | [restoredPage:76](../../apps/web/src/Workspace.tsx:76), [lưu navigation:148](../../apps/web/src/Workspace.tsx:148). |
| P1 | **Chỉ báo hoạt động chưa đủ để nhân viên quyết định.** `/v1/status` là `legacy_worker`, vẫn trả `productionWrites:false` và `listingExecutor:not_configured`; heartbeat chỉ chứng minh bộ đọc file, dù service graph production theo shop có tồn tại. | Tổng quan tách API/DB/nhập nguồn/kết nối/công việc/QC; trường không đọc được là chưa xác định. Mỗi lỗi ghi tên sản phẩm/shop, lý do và bước tiếp theo. Không suy trạng thái listing hoặc quyền đăng từ heartbeat/ID/ACK. | [status:766](../../apps/api/src/app.ts:766), [workflow graph:18](../../apps/api/src/production-workflows.ts:18), [quy tắc ID/QC test:71](../../tests/unit/manual-operation-reliability.test.ts:71). |
| P1 | **Chưa có đường khởi động và release khách hàng đã kiểm trên máy đích.** Cổng được yêu cầu cho thử là API 4410/UI 5273, nhưng script, runbook và cấu hình lưu đang là API 4430/UI 5273. Launcher cách ly là công cụ developer; launcher cũ dùng cổng 4310 và bật `PRODUCTION_PILOT_ENABLED=1`. | Chốt đúng cổng của rehearsal, proxy, CORS và link hỗ trợ; cold start/stop/restart chỉ một API và worker. Kiểm Node/dependency/DB/migration/health trên máy dùng thật. Hướng dẫn nhân viên không dẫn sang launcher vận hành cho thử nghiệm. | [default:62](../../scripts/internal-environment.mjs:62), [proxy:137](../../scripts/internal-environment.mjs:137), [launcher cũ:24](../../scripts/start-local.mjs:24), [giới hạn launcher:19](../runbooks/internal-development.md:19). |
| P1 | **Nguồn doanh nghiệp, chỉnh nháp và QC ảnh chưa nghiệm thu đầy đủ.** Case liên tục dùng ZIP/XLSX/PNG tạo từ test và metadata/shop có sẵn. Kết thúc ảnh chưa QC. Ánh xạ lại/thêm SKU tổng quát trên nháp đã lưu chưa hỗ trợ; chữ Editor chưa lưu mất sau forced refresh. | Dùng một lô do người dùng chọn, chỉ nhập/preview khi đăng đang nghỉ; đối chiếu mỗi ô SKU/giá, cấu trúc và toàn bộ ảnh đã duyệt. Test văn bản/tên Việt/nguồn lớn/ID update/thiếu source. Chốt hành vi phục hồi chữ và đường bổ sung SKU; hoàn tất QC riêng trước mở bán. | [giới hạn:15](../handoffs/INTERNAL_OPERATIONS.md:15), [tệp test tự tạo:45](../../tests/e2e/internal-acceptance-intake.spec.ts:45), [kết thúc pending ảnh:155](../../tests/e2e/internal-acceptance-intake.spec.ts:155). |
| P1/P2 | **Phục hồi toàn bộ và vận hành dài hạn chưa được chứng minh.** Backup chọn root thủ công, key giữ riêng, `--quiesced` chỉ là xác nhận; rehearsal mới phục hồi DB nhỏ. Đăng nhập/phân quyền được để sau theo phạm vi, nên chưa đủ cho LAN/nhiều nhân viên. Không có nghiệm thu tải dài/24h. | Trước release thật: đối chiếu toàn bộ DB↔blob↔manifest/journal↔source paths, kiểm preview sau restore và key trong môi trường kín; ghi RPO/RTO/chủ backup. Trước LAN/nhiều nhân viên: auth/authorization/audit actor. Với tải: đo theo quy mô người dùng chọn, restart giữa các chặng, token hết hạn và bounded polling không replay. | [backup completeness:106](../../scripts/internal-backup.mjs:106), [restore chỉ DB:190](../../scripts/internal-backup.mjs:190), [giới hạn rehearsal:56](../runbooks/internal-backup-restore.md:56), [scope nhân viên:7](../handoffs/INTERNAL_OPERATIONS.md:7), [yêu cầu LAN:101](../handoffs/INTERNAL_OPERATIONS.md:101). |

P0 là điều kiện giữ an toàn và tính toàn vẹn khi tích hợp; P1 là điều kiện bàn giao thao tác nội bộ dùng thật; P2 chỉ áp dụng trước khi mở thêm quy mô. Việc user để phần đăng nhập/kết nối mới sang sau không phải lý do dừng các sửa P0/P1 độc lập hoặc tự mở phạm vi LAN.

## Ma trận nghiệm thu theo thao tác nhân viên

| Ca | Điều nhân viên phải làm được | Bằng chứng hiện có | Kiểm mới cần đạt / artifact |
| --- | --- | --- | --- |
| 1. Mở app và tổng quan | Biết dữ liệu nào đã đọc, dữ liệu nào lỗi; tên shop và tình trạng ghi đúng | Build/typecheck và heartbeat; status legacy có giới hạn nêu trên | Cold load thành công + một endpoint hỏng + một timeout. Chụp UI/JSON; phần thành công dùng được, không báo 0 giả. |
| 2. Chọn shop | Shop đang chờ đối chiếu token vẫn thấy rõ; không đổi đích âm thầm | Unit scope chạy xen kẽ; browser switching shop dùng intercepted routes | Chọn A → A refresh_unknown → reload: vẫn A và giữ quyền ghi. Chọn B rõ ràng mới đổi; không lộ batch/capability của A ở B. |
| 3. Nhập ZIP/thư mục + Excel | Chọn vai trò ảnh, sheet/bộ giá/cột nội dung, lưu bộ thiếu riêng | UI/API/worker/PG thật cách ly; byte nguồn có thật nhưng nội dung fixture | Lô nguồn user chọn: tên Việt, ZIP/thư mục, trùng STT, thiếu SKU, SKU đa bộ giá, nguồn có ID update. Lưu đầy đủ receipt tệp/sheet/ô/SHA; không POST Shopee. |
| 4. Mở lại nguồn / chống trùng | Sau refresh còn nguồn lỗi, bộ đã lưu mở đúng nháp | Integration thật và case browser liên tục | Upload/mở lại/bấm đôi/mất phản hồi lưu: một nguồn chỉ một nháp; không tạo danh tính mới bằng cách đổi tên thư mục. |
| 5. Chỉnh nháp và phân loại | Xem trước bỏ/sắp tầng, giữ đúng SKU/giá/ảnh/tồn ngoài phạm vi | Bulk edit → compiler thật, concurrency một revision | Hai tầng, một tầng, loại nguồn không dùng ml, nhiều sibling; so bản trước/sau toàn bộ trường. Chỉnh nháp sau chuẩn bị buộc chuẩn bị/xác nhận lại. |
| 6. Chốt nguồn | Thấy và xác nhận đúng cấu trúc, từng SKU/giá và toàn bộ vai trò ảnh | Gate mới của vận hành, chưa có trong ứng viên baseline | Tích hợp gate; sai một nhãn/tầng/giá/ảnh, thiếu ảnh hoặc đổi thứ tự đều chặn riêng bộ trước writer. Readback khớp payload nhưng payload sai source phải thất bại. |
| 7. Chuẩn bị đợt / nguồn đổi | Nguồn hợp lệ đi tiếp, nguồn đổi/thiếu có lý do và mở bản mới | Real PG compiler/source-change/recovery; một số UI routes fixture | Preview/register/start giữa các lần đổi revision; sibling đủ tiếp tục. Fingerprint và scope không đổi; job cũ giữ immutable, không tự sửa manifest. |
| 8. Link ẩn và mất phản hồi | ACK/unknown đang chờ phải đọc lại, không đăng lại | Actual runner/journal trên raw Shopee fixture; một create/init, hai core readback | Khi chưa được mở đăng: chỉ transport fixture. Test mất response sau accept, restart, busy, crash reserve/binding. Không có POST lặp; reservation không đủ proof giữ manual review. |
| 9. QC và báo cáo | Báo tên sản phẩm, link/shop, source version, lý do/việc tiếp theo; ACK khác verified | Browser XLSX và audit độc lập; final pending image QC | Xuất báo cáo đợt selected shop, unsent ID null, chữ bắt đầu `=`, lỗi exporter, stale/partial status. Không token/raw secret; pending ảnh không được counted verified. |
| 10. URL / reload / Back | Link hỗ trợ mở đúng màn và quay lại không mất việc | Chưa có bằng chứng đầy đủ cho URL ngoài shops | Tất cả màn chính có deep link; Back/Forward/reload; cảnh báo chữ chưa lưu/upload. Không tự gửi sau reload. |
| 11. Backup và phục hồi | Mở lại nguồn/preview/journal sau phục hồi, biết thiếu gì và ai xử lý | 74 bảng + một dòng giả lập + blob + ba file; app restore chưa kiểm | Bản sao doanh nghiệp offline: SHA/table/revision/job counts, source paths/key, kiểm readiness và preview có kiểm soát. Không bật worker trên bản sao có job/token thật. |
| 12. Máy đích / tải | Một lần mở app, dừng/restart có kiểm soát, queue không bị nhân đôi | Launcher đã có, chưa phải nghiệm thu máy khách hoặc 24h | Ghi Node/OS/lockfile/migrations/ports, thời gian cold start/import/preview/QC và dung lượng; workload user chọn. LAN/auth giữ gate riêng. |

Các ca 1–7, 9–12 có thể tiến hành với nguồn/DB cách ly và posting tắt. Ca 8 chỉ fixture trong phạm vi hiện tại. Nghiệm thu Shopee thật phải có lô/item/shop và quyền riêng, đọc mới toàn trường trước ghi, rồi so cả trường mục tiêu và trường giữ nguyên; không dùng listing bán thật để thử tùy tiện hoặc replay checkpoint cũ.

## Tái sử dụng và tích hợp an toàn

| Nhóm | Tái sử dụng được | Cách tích hợp |
| --- | --- | --- |
| Nhập liệu | ZIP bounds, content-workbook resolver, input persistence, source identity/claims, bulk edit preview/apply | Giữ dữ liệu nguồn bất biến; nối qua compiler và gate live. Kiểm receipt `localBulkEdit` đúng shape thay vì bỏ validation. |
| Theo shop | `production-scope.ts`, `ProductionWorkflows`, callback binding/cache/admission tách shop | Duy trì scope rõ trong route và mọi async callback. Đưa trạng thái kết nối thật vào UI; không mặc định `connected` hay chọn shop khác khi không đủ điều kiện. |
| Phục hồi | Bounded polling, recovery/successor receipts, lease cleanup, source revision comparison | Giữ giới hạn reserve/chưa binding cần review; kết hợp provenance guard live trước dispatch. Không mở nút chỉ vì historical absence receipt. |
| Báo cáo | Scope-bound JSON/XLSX, report grouping, formula-as-string và redaction | Đọc local journal; giữ ACK/unknown/pending image riêng. Ngày dữ liệu và lý do phải thấy rõ. |
| Công cụ môi trường | Isolation verifier, fetch preload, backup checksum và restore target guards | Giữ môi trường lọc, literal loopback và PG 5443. Preload chỉ chặn fetch, không phải firewall; transport mới cần kiểm riêng. |
| Vận hành live | Source contract, mapping proof, ảnh đủ/đúng thứ tự, raw QC, trạng thái và journal cũ | Đây là điều kiện nền; giữ khi đưa UX mới vào. Không dùng fixture hoặc projection để ghi lại nguồn/token/job cũ. |

Trình tự đề nghị: lưu snapshot/SHA hai bộ dirty → dựng bản tích hợp riêng → giữ migration bytes và cổng nguồn live → nối UX/overview/routing → focused tests → full isolated verifier + continuous browser → đối chiếu lô nguồn user chọn ở chế độ nhập/preview → backup/restore rehearsal → chọn cửa sổ release. Không có bước merge, restart hoặc bật posting tự động trong biên bản này.

## Giữ kiến trúc modular monolith ở lượt này

Đây là khuyến nghị thiết kế dựa trên mã hiện có. Giữ web + một API + worker nhập + PostgreSQL, nhưng chia controller/service theo nhập nguồn, listing, workflow, QC/report, kết nối và tra cứu. `ProductionWorkflows` đã tạo graph/cache theo shop; khóa, revision, journal và transaction đang dùng cùng cơ sở dữ liệu. [Graph:18](../../apps/api/src/production-workflows.ts:18), [app composition:995](../../apps/api/src/app.ts:995), [transaction:34](../../packages/persistence/src/db.ts:34).

Tách thêm microservice lúc này sẽ phải giải lại dispatch một lần, scope, lock order, crash recovery và đồng bộ DB↔filesystem qua nhiều tiến trình/network. Nó không sửa các lỗi người dùng thấy như nguồn thiếu, shop sai, trạng thái không rõ hay cold load bị mất. Số đo hiện có còn cho thấy index 40 dòng khoảng 1,72ms và query kèm evidence khoảng 3,18ms; vấn đề đã ghi nhận là phạm vi đồng bộ và trạng thái token, không phải cần thêm DB/cache. [Số đo và giới hạn](C:/shopee_product_uploader/docs/reviews/2026-09-26-listing-database-performance.md:10).

Có thể tách khi đã đo được một tải cần scale độc lập, có chủ vận hành riêng hoặc yêu cầu cô lập lỗi riêng, cùng hợp đồng message/idempotency và nghiệm thu phục hồi cho ranh giới mới. Trước đó, giảm app/controller tập trung bằng module nội bộ và đo từng chặng là thay đổi có thể kiểm chứng hơn.

## Prerequisite và khởi động thử an toàn

Lần đọc ngày 01/10 xác minh Node riêng `C:/shopee_product_uploader/.local/runtime/node-v24.20.0-win-x64/node.exe` trả `v24.20.0`. Bốn junction `node_modules/@shopee/*` của ứng viên trỏ đúng các package trong worktree. Marker/secrets/empty.env/Compose/data cách ly đã tồn tại; không đọc hoặc in giá trị secret. Cấu hình lưu: API **4430**, UI **5273**, PostgreSQL **5443**, DB `shopee_internal_test`.

`netstat` tại thời điểm rà soát thấy live 4310/PID25240, 5173/PID16636 và 5442/PID4984; không thấy listener 4410/4430/5273/5443. Đây chỉ là ảnh chụp cổng, không chứng minh các job đã nghỉ. Docker CLI có trên máy nhưng kiểm daemon bị từ chối quyền truy cập pipe/config; không suy từ đó daemon đã dừng. `pg_dump`/`pg_restore` không tìm thấy qua PATH ở phiên này. Không thực hiện escalation hay thay đổi Docker.

Người điều phối cần chốt API4410 theo kế hoạch hiện tại hoặc chấp nhận4430 và sửa hướng dẫn nhất quán. Nếu chọn4410, chỉ cập nhật marker/default rehearsal và proxy/CORS tương ứng; không init lại hay thay khóa. Database/username vẫn phải là mục tiêu5443 cách ly. Launcher đọc port từ marker và tự kiểm cổng; verifier bắt buộc DB literal loopback, writing/maintenance tắt. [Validation:16](../../scripts/internal-environment.mjs:16), [allowlist:31](../../scripts/internal-environment.mjs:31), [empty connections precheck:132](../../scripts/internal-environment.mjs:132).

Sau khi người phụ trách có quyền Docker và đã kiểm đúng Compose/db thử, có thể dùng chuỗi dưới đây trong worktree. Đây là lệnh đề nghị, chưa được thực hiện trong lượt rà soát:

```powershell
Set-Location 'C:/shopee_product_uploader/.local/worktrees/internal-operations'
$internalNode = 'C:/shopee_product_uploader/.local/runtime/node-v24.20.0-win-x64/node.exe'
& $internalNode scripts/internal-environment.mjs inspect
docker compose --env-file .local/internal/docker.env -f .local/internal/compose.yaml up -d postgres
& $internalNode scripts/internal-environment.mjs migrate
& $internalNode scripts/internal-environment.mjs dev
```

Chỉ migrate database thử theo config đã kiểm; không dùng chuỗi này cho restore target phải trống. Không chạy `npm run dev`, `MO_WEB_APP.cmd` hoặc `scripts/start-local.mjs` để giả định có rehearsal đúng cổng. Không chép `.env`, token hoặc `.local` vận hành sang ứng viên. Không chạy worker trên bản restore chứa kết nối/job production. Ctrl+C dừng launcher thử; Compose thử giữ dữ liệu. Chỉ một lượt nghiệm thu dùng DB thử tại một thời điểm.

## Lệnh và file mục tiêu để kiểm chứng bản cuối

Ba entry point được hỗ trợ, chạy từ worktree bằng Node24 đã nêu:

```powershell
& $internalNode scripts/verify-internal.mjs --dry-run
& $internalNode scripts/verify-internal.mjs
& $internalNode scripts/verify-internal.mjs --browser
```

`--dry-run` kiểm config/dependency và liệt kê bước, không kiểm sức khỏe DB. Lượt mặc định kiểm kiểu → repository skills → TS build → web build → legacy → unit/integration; Playwright không được tính vào tổng. `--browser` chỉ chạy `internal-acceptance-intake.spec.ts`, với API/UI random loopback và schema riêng. Các browser intercepted khác không tự được chạy theo tùy chọn này. [Verifier:48](../../scripts/verify-internal.mjs:48), [browser:64](../../scripts/verify-internal.mjs:64), [Playwright mặc định live5173:11](../../playwright.config.ts:11).

| Phạm vi focused sau thay đổi | File mục tiêu hiện có / cần nối |
| --- | --- |
| Isolation/config/backup | `tests/unit/internal-operations.test.ts`, `tests/unit/internal-verifier.test.ts` |
| Source intake/content/bulk | `tests/unit/content-workbook.test.ts`, `tests/unit/bulk-product-edit.test.ts`, `tests/integration/content-workbook-intake.test.ts`, `tests/integration/bulk-product-edit.test.ts`, `tests/integration/internal-acceptance-workflow.test.ts` |
| Scope/source revision/manual recovery | `tests/unit/production-scope-isolation.test.ts`, `tests/unit/manual-operation-reliability.test.ts`, `tests/unit/production-preparation-changes.test.ts`, `tests/unit/production-batch-service.test.ts`, `tests/unit/pass1-production-batch-runner.test.ts`, `tests/integration/production-batch-recovery.test.ts` |
| Cổng nguồn/ảnh/giá live sau tích hợp | `tests/unit/production-source-contract.test.ts`, `tests/unit/production-batch-provenance.test.ts`, `tests/unit/prepared-wire.test.ts`, `tests/unit/prepared-wire-qc.test.ts`, `tests/integration/production-draft-preparation.test.ts`, `tests/integration/production-pilot-runner.test.ts`; hai file contract/provenance chưa có trong baseline ứng viên |
| Continuous browser thật local | `tests/e2e/internal-acceptance-intake.spec.ts` qua `verify-internal --browser` |
| Các UI fixture riêng | `tests/e2e/manual-operation-isolation.spec.ts`, `tests/e2e/manual-source-continuation.spec.ts`, `tests/e2e/content-workbook-intake.spec.ts`; phải dùng host thử riêng, không Playwright baseURL5173 mặc định |
| Sửa ngày01/10 | Thêm ca tổng quan, trạng thái shop, lỗi một data slice, URL/Back/Forward vào test của đúng owner; ghi tên file/command và kết quả vào biên nhận cuối. Không suy đạt từ các ca cũ. |

Nếu cần chọn vài file Vitest trước lượt toàn bộ, dùng môi trường từ `readIsolated` và `verifierEnvironment`, không gọi trực tiếp Vitest với env kế thừa có thể đọc `.env` vận hành. Ví dụ focused không ghi báo cáo tự động; đổi danh sách file rõ ràng và lưu kết quả riêng theo chuẩn release:

```powershell
& $internalNode --input-type=module -e 'import { spawnSync } from "node:child_process"; import { readFile } from "node:fs/promises"; import { readIsolated } from "./scripts/internal-environment.mjs"; import { verifierEnvironment } from "./scripts/verify-internal.mjs"; const { env } = await readIsolated(); const safeEnv = verifierEnvironment(env, process.cwd(), await readFile(env.DOTENV_CONFIG_PATH, "utf8")); const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--configLoader", "runner", ...process.argv.slice(1)], { cwd: process.cwd(), env: safeEnv, stdio: "inherit", windowsHide: true }); process.exitCode = result.status ?? 1;' tests/unit/internal-operations.test.ts tests/unit/internal-verifier.test.ts
```

Không chạy test có live DB hoặc external transport để lấp chứng cứ fixture. Sau các sửa ngày01/10 cần một biên nhận mới chứa commit hoặc SHA bundle của bộ mã cuối, target DB/ports, test totals riêng, browser totals riêng, ảnh/UI report, migration audit và những giới hạn còn lại. Các kết quả2445/2477 cũ vẫn giữ nguyên lịch sử; không thêm số mới vào chúng.
