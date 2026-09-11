# Shopee Bulk Listing — Implementation Plan tổng thể dự án

> **For agentic workers:** Use `superpowers:executing-plans` khi triển khai theo từng phần. Đây là bản tổng kết phạm vi, phụ thuộc và mốc nghiệm thu; mỗi phân hệ được phân rã thành kế hoạch kỹ thuật riêng trước khi sửa code. Các ô trống là công việc dự kiến, không phải kết quả đã kiểm thử.

**Goal:** Xây dựng ứng dụng nội bộ quản lý đăng mới và cập nhật listing Shopee hàng loạt cho nhiều shop VN, gồm Mall và shop thường, hướng tới 50–80 sản phẩm khác nhau mỗi ngày cho toàn hệ thống, có phân loại riêng, dùng nội dung và ảnh người dùng đã chuẩn bị.

**Architecture:** Web vận hành → backend nghiệp vụ → workflow/worker gọi OpenAPI → đọc lại và theo dõi QC. PostgreSQL giữ dữ liệu và tiến độ, hàng đợi phân phối công việc, kho tệp giữ nguồn; agent có harness hỗ trợ tra cứu, phân giải dữ liệu và điều tra lỗi qua các công cụ có phạm vi.

**Tech Stack:** Đề xuất React + TypeScript; NestJS/TypeScript; PostgreSQL; SQS; S3; OpenAI Agents SDK TypeScript; function tools và MCP nội bộ khi cần chia sẻ công cụ. Thiết kế hạ tầng tham chiếu AWS Singapore, ECS Fargate, RDS Multi-AZ, giám sát và sao lưu; vị trí triển khai và ngân sách chưa được người dùng chốt.

**Spec:** [Kiến trúc ứng dụng](../specs/2026-09-09-shopee-production-architecture-design.md), [logic/QC](../../research/shopee-production-2026-09-10-listing-logic-qc.md), [tốc độ/phục hồi](../../research/shopee-production-2026-09-10-performance-resilience.md), [agent/harness](../../research/shopee-production-2026-09-10-agent-harness.md).

**Ngày tổng hợp:** 10/09/2026. Lượt này chỉ tổng hợp tài liệu, không triển khai hạ tầng, cài SDK hoặc thao tác ghi shop.

**Kế hoạch thực thi chi tiết đã bổ sung:** [16 task trong 5 gói, audit môi trường, hợp đồng và gate nghiệm thu](2026-09-10-shopee-execution-plan.md). Dùng bản này khi bắt đầu code; bản tổng thể dưới đây giữ vai trò mô tả phạm vi. Audit mới xác nhận thư mục hiện tại chưa khởi tạo Git, Docker client có nhưng daemon chưa kết nối được; không coi đây là repository/backend đã sẵn sàng.

## Global Constraints — các quyết định đã chốt

- Công suất mục tiêu là 50–80 sản phẩm khác nhau/ngày cho toàn hệ thống; chưa chốt số lượng riêng từng shop.
- Ứng dụng nội bộ dùng chung qua mạng riêng; bản đầu không có đăng nhập ứng dụng, MFA, tài khoản nhân viên hay phân quyền nhân viên. Kết nối/cấp quyền Shopee và khóa/token ở server vẫn cần.
- Nội dung và ảnh đã tạo sẵn. Luồng chính nhập, ghép đúng SKU, kiểm và đăng/cập nhật; giữ nguyên nguồn đã chọn. Chỉnh chữ/ảnh chỉ theo yêu cầu cụ thể.
- File tổng KINI là nguồn dữ liệu sản phẩm do người dùng cung cấp. Ánh xạ theo tiêu đề từng sheet/khối; chọn đúng bộ giá shop, không áp vị trí cột của workbook khác.
- Đăng mới: GIÁ GỐC → original_price. GIÁ BÁN là mục tiêu cho bước khuyến mại riêng, không tự tạo chương trình hoặc hứa hiển thị giá gạch chỉ vì đã nhập giá gốc.
- Tồn đăng bán nhập thủ công theo SKU/shop, có thể là tồn ảo. Không tự đặt mức cho production, sao chép sang shop khác hoặc tự bù khi có đơn.
- Ảnh bìa nguồn 1:1, ảnh nội dung/gallery nguồn 3:4; kiểm vai trò và quyền của shop. Lamy đã xác nhận mô tả: tiêu đề mở đầu → dòng trống → g1–g9 → dòng trống → phần nội dung còn lại. Cấu trúc này là mẫu của Lamy, không ép số ảnh giống nhau cho mọi sản phẩm.
- Mọi quyết định Shopee tra kho Open Platform, Uni VN và quan sát seller có nguồn/ngày/phạm vi; xác minh nguồn chính thức khi cần tính hiện hành. Không suy giới hạn thật từ ví dụ hoặc sandbox.
- Shop thật hiện chỉ được research/đọc. Quyền thử sandbox không phải quyền ghi production; kế hoạch pilot chỉ thực hiện sau khi người dùng cho chạy đúng danh sách shop/listing.
- Chưa chứng minh OpenAPI bao phủ mọi trường/tính năng của Seller Center. Phần không có quyền/API phải hiển thị rõ bước cần người vận hành, giữ tiến độ để tiếp tục.

---

## 1. Sản phẩm bàn giao

Một web nội bộ có các khu vực: shop và trạng thái kết nối; nguồn và danh mục SKU; thư viện ảnh/nội dung; bản xem trước và lỗi dữ liệu; đăng/cập nhật theo lô; giá/khuyến mại; QC và việc cần xử lý; lịch sử và bằng chứng; trợ lý tra cứu.

Luồng sử dụng chính:

1. Chọn shop, chế độ đăng mới/cập nhật và đưa vào KINI, nội dung, ảnh hoặc bản xuất Canva được chọn.
2. Ứng dụng ghép SKU/nhóm phân loại, chỉ rõ phần thiếu hoặc mâu thuẫn và kiểm điều kiện theo shop/ngành.
3. Hiển thị bản xem trước và danh sách trường sẽ đổi. Người dùng khởi chạy lô trong phạm vi đã chọn.
4. Backend gọi OpenAPI trực tiếp, xử lý từng bước và cập nhật tiến độ trong khi người dùng tiếp tục làm việc khác.
5. Đọc lại dữ liệu đã lưu; nhận/đọc tín hiệu QC; hiển thị riêng thành công kỹ thuật, chờ Shopee, vi phạm hoặc cần xử lý.
6. Người dùng bổ sung/sửa phần có vấn đề; ứng dụng tiếp tục công việc phù hợp từ trạng thái đã lưu, kiểm lại trước ghi.

Đăng mới và cập nhật bao gồm tên/mô tả, ảnh theo vai trò, ngành/brand/thuộc tính, phân loại và ảnh phân loại, SKU, giá, tồn, thông tin vận chuyển cùng các trường được API/quyền shop hỗ trợ. Chứng từ/giấy phép, một số tính năng ảnh và chương trình cần kiểm khả năng thật trước cam kết tự động.

## 2. Hiện trạng có bằng chứng

| Hạng mục | Hiện trạng |
| --- | --- |
| Kho kiến thức | Có bản chụp Open Platform và Uni VN ngày 08/09 cùng chỉ mục/nguồn; có bổ sung nghiên cứu và quan sát ngày 09–10/09. Các tài liệu/link/tệp không truy cập được được ghi trong COVERAGE, không gọi là toàn bộ Internet Shopee đã tải đầy đủ. |
| Nguồn sản phẩm | Có KINI, Word Lamy và bộ Canva xuất; đã ghép và đối chiếu mẫu sáu SKU. Chưa chuẩn hóa toàn bộ workbook thành danh mục production. |
| Sandbox | Có listing Lamy 803934364 trên shop TEST 227418363, đã đăng và đọc lại; mô tả được cập nhật đủ g1–g9. Mẫu cũ 846056124 được đọc vẫn UNLIST. |
| QC | Lần đọc brand LAMY gần nhất pending QC; NORMAL sandbox không chứng minh duyệt production. Chưa thử luồng API vi phạm/chẩn đoán, push và phục hồi sau từ chối QC đầu cuối. |
| Giá/Flash | Đã xác nhận giá gốc theo KINI trên mẫu; API tiêu chí Flash sandbox lỗi server hai lần, chưa nghiệm thu tạo Flash Sale. |
| Code hiện có | Repository chủ yếu là extension điền form; chưa có backend OpenAPI trực tiếp, workflow bền vững, MCP và hệ thống agent production đã cấu hình. |
| Hiệu năng | Chưa benchmark tải 50–80 listing, gia hạn token tự động, lỗi đồng thời hoặc phục hồi hạ tầng. |

Nguồn: [hồ sơ Lamy](../../research/shopee-lamy-listing-2026-09-10/README.md), [cập nhật mô tả/giá](../../research/shopee-lamy-listing-2026-09-10/content-and-pricing.md), [Open Platform coverage](../../../knowledge-base/shopee-open-platform/COVERAGE.md), [Uni coverage](../../../knowledge-base/shopee-uni-vn/COVERAGE.md).

## 3. Cấu trúc triển khai dự kiến

Đây là bố trí thư mục đề xuất để lập các kế hoạch kỹ thuật, chưa phải các thư mục đã được tạo. Giữ code extension hiện có khi chưa có kế hoạch chuyển đổi cụ thể.

| Vị trí dự kiến | Trách nhiệm |
| --- | --- |
| `apps/web` | Giao diện nội bộ, xem trước, quản lý lô, QC và trợ lý. |
| `apps/api` | Kết nối shop, nguồn/danh mục, kế hoạch thay đổi và API cho UI/công cụ. |
| `apps/worker` | Import, thực thi Shopee, outbox, đối soát, nhận và xử lý QC. |
| `packages/domain` | Quy tắc SKU, giá, tồn, nguồn, kế hoạch và trạng thái; dùng chung cho UI API/MCP. |
| `packages/shopee` | Ký yêu cầu, token, adapter API, lỗi và capability theo app/shop/môi trường. |
| `packages/agent-runtime` | Agent, harness, công cụ và trace; output có cấu trúc, không tự ghi Shopee ngoài dịch vụ nghiệp vụ. |
| `packages/mcp-server` | Adapter công cụ MCP nội bộ dùng chung module; tạo khi cần nhiều client sử dụng. |
| `tests/fixtures`, `tests/integration`, `tests/e2e`, `tests/evals` | Nguồn mẫu đã kiểm, API mô phỏng, phép thử luồng và đánh giá agent. |
| `infra`, `docs/runbooks` | Hạ tầng, triển khai, backup/restore và xử lý sự cố. |

## 4. Các mốc triển khai và đầu ra nghiệm thu

### M1 — Kết nối trực tiếp và xác định khả năng từng shop

- [ ] Lập bảng shop pilot: loại Mall/thường, app, phạm vi quyền, thị trường, ngành dự kiến và dữ liệu nguồn.
- [ ] Thiết lập backend gọi OpenAPI, cấp quyền/đọc kết nối, token ở server và nhận biết TEST/LIVE; kiểm gia hạn và lỗi mất quyền.
- [ ] Kiểm khả năng theo tính năng: ảnh 3:4/extended description, variation, chứng từ, logistics, chẩn đoán/vi phạm, khuyến mại/Flash.
- [ ] Ghi rõ từng tính năng: dùng API được; thiếu quyền; cần bước Seller Center; hoặc chưa xác minh.

**Nghiệm thu:** gọi trực tiếp và đọc đúng shop; môi trường bị ràng buộc ở server; token không lộ ra UI/log; lỗi quyền được nhận diện. Chỉ đọc production trong phạm vi hiện tại.

### M2 — Nhập nguồn, ghép SKU và kiểm tra trước đăng

- [ ] Xây luồng nhập KINI/Word/ảnh, nhận diện khối dữ liệu và lưu nguồn/phiên bản; xuất lỗi theo ô/SKU.
- [ ] Ghép nội dung/ảnh theo SKU và vai trò; xem trước đủ biến thể và ảnh mô tả, giữ nguyên bản gốc.
- [ ] Áp giá gốc, tồn thủ công, ngành/brand/thuộc tính và yêu cầu hồ sơ theo phạm vi đã xác minh.
- [ ] Kiểm trùng lặp, thiếu tổ hợp, ảnh nhầm, giá sai bộ, sai đơn vị cân nặng, xung đột nội dung và trường thiếu.

**Nghiệm thu:** mẫu Lamy đúng sáu SKU/nguồn/ảnh/giá; lỗi có vị trí và lý do; nguồn thiếu không được tự điền thành sự thật. Mẫu ngành khác và mẫu sheet/khối khác phải qua kiểm riêng trước mở rộng workbook.

### M3 — Đăng mới và cập nhật listing đầu cuối qua API

- [ ] Luồng tạo lưu kế hoạch, tải ảnh đúng vai trò, tạo item/model và đọc lại; giữ ID qua các bước.
- [ ] Luồng cập nhật chỉ sửa trường đã chọn, kiểm lại dữ liệu/khuyến mại/trạng thái trước ghi.
- [ ] Lưu kết quả từng bước, xử lý phản hồi nghiệp vụ và lỗi từng model; chưa rõ kết quả thì đối soát.
- [ ] So nguồn với dữ liệu đọc lại và kiểm cách hiển thị thực; không ghép model theo thứ tự mảng trả về.

**Nghiệm thu:** hoàn tất qua backend trực tiếp trên sandbox; có bằng chứng request/readback và phép thử tiếp tục khi dừng giữa các bước. Không dùng thời gian thao tác Console làm benchmark backend. Quản lý fixture để không tạo lại vô tình listing đã có.

### M4 — Chạy lô, phục hồi lỗi và quản lý QC

- [ ] Hàng đợi, giới hạn theo app/endpoint/shop, khóa công việc cùng item; các shop/nhóm độc lập tiếp tục khi một phần lỗi.
- [ ] Kiểm lỗi mạng, API rate limit/server, token, worker khởi động lại, ghi một phần và thao tác đồng thời trên Seller Center.
- [ ] Nhận/lưu/loại trùng push và đối soát định kỳ; phân biệt trạng thái listing, vi phạm/deboost và chất lượng nội dung.
- [ ] Giao diện lọc lỗi, hạn xử lý, dữ liệu còn thiếu, tạm dừng các bước chưa chạy và tiếp tục phần đã giải quyết.

**Nghiệm thu:** không báo xong khi chưa đọc lại; không tạo trùng khi mất phản hồi; không tự bù tồn do đơn; nhận đúng NORMAL + deboost; push lặp/đảo thứ tự không làm sai trạng thái. Không tự đăng lại bản sao sản phẩm bị Shopee xóa.

### M5 — Giá, chương trình giảm giá và Flash Sale

- [ ] Tách giá gốc, giá mục tiêu, giá trong chương trình và lượng phân bổ khuyến mại.
- [ ] Đọc trạng thái/khóa giá, kiểm toàn bộ biến thể và trạng thái trung gian khi ghi một phần; tính bằng code.
- [ ] Kiểm điều kiện chương trình theo dữ liệu và quyền trả về; xử lý lỗi từng item/model, đọc lại kết quả tham gia.
- [ ] Luồng tạo/cập nhật khuyến mại chỉ chạy khi người dùng yêu cầu; giữ phần đăng listing độc lập.

**Nghiệm thu:** vượt các ca giá/khóa giá/điều kiện và đọc lại chương trình. Flash vẫn là phần chưa nghiệm thu cho tới khi API hoạt động và có phép thử đúng phạm vi; không dùng việc đăng giá gốc thành công để tuyên bố Flash khả dụng.

### M6 — Agent có harness, công cụ và đánh giá

- [ ] Tích hợp một agent điều phối với truy xuất nguồn có ngày/phạm vi, kết quả có cấu trúc và công cụ nội bộ.
- [ ] Áp ngữ cảnh theo job/shop, giới hạn vòng lặp/ngân sách, trace và điều kiện hoàn tất kiểm được.
- [ ] Bổ sung chuyên môn nguồn, policy/QC và điều tra lỗi khi bộ đánh giá chứng minh có lợi; không cho nhiều agent tự ghi cùng item.
- [ ] Cung cấp MCP nếu cần dùng chung qua nhiều client; mọi công cụ gọi cùng module kiểm tra và thực thi kế hoạch.
- [ ] So với baseline bằng code: lỗi bỏ sót/chặn nhầm, nguồn sai/ngày sai, chi phí, thời gian và mức cần người dùng bổ sung.

**Nghiệm thu:** agent không tự sửa nội dung/ảnh, bịa dữ kiện hoặc bỏ qua kiểm tra. AI lỗi thì nhóm đã đủ mọi điều kiện vẫn có thể chạy; nhóm cần phân giải giữ trạng thái chờ. Trace replay dùng công cụ ghi mô phỏng. Quy tắc mới được đối chiếu và kiểm thử trước áp rộng.

### M7 — Nghiệm thu vận hành và pilot production

- [ ] Cấu hình môi trường triển khai đã chọn, cơ sở dữ liệu/hàng đợi/kho tệp, giám sát, backup, khôi phục và hướng dẫn vận hành.
- [ ] Chạy mô phỏng lỗi và tải theo quy mô 10 → 30 → 80 listing khác nhau, phân biệt dữ liệu thật/synthetic và lớp hệ thống được kiểm thử. Chỉ ghi sandbox khi đúng phạm vi đã cho phép.
- [ ] Đo nhận job, độ mới tiến độ, tốc độ ghi và đọc lại, thời gian chờ QC; lấy quota thật vào cấu hình. Chưa đặt một thời gian hoàn tất toàn lô giả định thành cam kết.
- [ ] Chuẩn bị danh sách shop/listing/dữ liệu/phạm vi ghi production cụ thể; xin phép chạy pilot ở mốc này nếu chưa được người dùng cấp quyền.
- [ ] Pilot số lượng nhỏ với dữ liệu đủ hồ sơ, mở rộng shop thường/Mall theo khả năng đã kiểm chứng; ghi mọi ngoại lệ có bước web.

**Nghiệm thu:** lô không mất tiến độ, không ghi sai shop, không tạo trùng, không sai ánh xạ/giá/tồn trong bộ ca; khôi phục được sau sự cố; QC được thể hiện đúng; người vận hành có đủ bằng chứng và cách xử lý. Đánh giá 50–80 sản phẩm/ngày trên tải đại diện, ghi rõ cửa sổ chạy thực tế và thời gian chờ bên Shopee. Có tính năng chưa xác minh thì ghi là chưa nghiệm thu, không âm thầm loại khỏi phạm vi bàn giao.

## 5. Phụ thuộc và lịch dự án

M1 và M2 có thể tiến triển song song về mặt tổ chức công việc. M3 cần kết nối và nguồn hợp lệ. M4 hoàn thiện độ bền/QC trên luồng M3; kiểm tra an toàn cơ bản đã có từ M1–M3, không đợi cuối mới bổ sung. M5 dựa trên M3 và quyền chương trình. M6 có thể bắt đầu với dữ liệu đọc/mô phỏng sau M2, không bắt buộc chờ Flash Sale. M7 dựa trên những tính năng sẽ đưa vào pilot đã qua nghiệm thu.

Chưa chốt ngày go-live hoặc chi phí triển khai vì chưa có đội thực hiện, ngân sách hạ tầng và thời gian giải quyết quyền/giấy phép. Mốc lập lịch chi tiết đầu tiên là sau M1 và phép thử E2E trực tiếp đầu tiên của M3; khi đó phân rã từng phân hệ thành việc kỹ thuật và ước lượng dựa trên khối lượng đã rõ. Thời gian phát triển phần mềm, thời gian xử lý một lô và thời gian chờ QC được theo dõi riêng.

Theo yêu cầu ước tính bổ sung ngày 10/09: [dự trù thời gian và vận hành 24/7](../../research/shopee-production-2026-09-10-time-estimates.md) đề xuất 20–35 ngày công cho toàn phạm vi với một người kỹ thuật chính có coding agent và hỗ trợ nghiệm thu, chưa tính chờ bên ngoài. Đây là ước lượng sơ bộ cần hiệu chỉnh, không phải ngày go-live cam kết. Bảng thời gian xử lý lô trong báo cáo là mô hình giả định, chưa có benchmark backend; chưa bật automation phát triển 24 giờ.

Mục tiêu độ phản hồi kế thừa thiết kế: sau khi tệp đã upload, nhận và lưu job p95 dưới 2 giây. Đây là mục tiêu cần đo, không phải kết quả hiện có. Hệ thống giữ UI dùng được khi công việc nền tiếp tục.

## 6. Thông tin cần hoàn thiện theo từng mốc

| Thông tin/điều kiện | Khi nào cần | Ảnh hưởng nếu chưa có |
| --- | --- | --- |
| Cấu hình app và kết nối shop thực tế | M1 | Có thể xây và mô phỏng nhưng chưa chứng minh API của app hoạt động. Không yêu cầu gửi khóa vào chat. |
| Danh sách shop pilot và bộ giá tương ứng | M1–M2 | Chưa phân phối lô production hoặc kiểm đủ Mall/thường. |
| Nội dung, ảnh, giấy tờ và thuộc tính cho từng nhóm hàng | M2–M3 | Các SKU thiếu dữ kiện giữ trạng thái cần bổ sung; mẫu đủ dữ liệu tiếp tục. |
| Tồn đăng bán cụ thể theo SKU/shop | Trước mỗi lô thật | Chưa được tự điền mức tồn production. |
| Mục tiêu và phạm vi chương trình giá/Flash | M5 | Giá bán trong KINI chưa tự thành lệnh tạo chương trình. |
| Quyền API ảnh/chứng từ/QC/chương trình | M1 và mốc tính năng tương ứng | Ghi rõ cần quyền hoặc bước Seller Center; không kết luận API bao phủ toàn bộ. |
| Vị trí triển khai, mạng nội bộ và ngân sách | Trước M7 | Chưa đặt dịch vụ trả phí hoặc triển khai cloud. |
| Cho phép ghi đúng shop/listing pilot | Trước ghi production ở M7 | Production vẫn chỉ đọc/research. |

Đây là danh sách phụ thuộc để triển khai, không phải yêu cầu người dùng trả lời toàn bộ ngay trong lượt tổng kết.

## 7. Định nghĩa hoàn thành dự án

Ứng dụng được bàn giao khi các tính năng trong phạm vi được truy vết tới phép thử, dữ liệu nguồn và trạng thái shop thực tế; các mục chưa hỗ trợ có luồng xử lý và giới hạn rõ ràng. Bàn giao gồm mã nguồn, cấu hình triển khai, dữ liệu mẫu/ánh xạ, catalog capability, quy tắc có nguồn, báo cáo test/load/AI eval, log bằng chứng đã loại khóa/token và runbook vận hành/phục hồi.

Điều kiện cốt lõi: đúng shop, đúng sản phẩm/SKU, đúng phạm vi trường, giữ đúng nguồn, giá/tồn đúng quyết định người dùng, dữ liệu ghi được đối soát, công việc phục hồi được và QC được theo dõi trung thực. Không cam kết mọi sản phẩm sẽ được Shopee duyệt, mọi chức năng web có API hoặc mọi lỗi đều tự sửa được.

## 8. Thứ tự đọc nguồn khi triển khai

1. [AGENTS dự án](../../../AGENTS.md) — phạm vi và quyết định của người dùng.
2. [Open Platform AGENT_GUIDE](../../../knowledge-base/shopee-open-platform/AGENT_GUIDE.md) và [Uni VN AGENT_GUIDE](../../../knowledge-base/shopee-uni-vn/AGENT_GUIDE.md) — tra tài liệu đầy đủ theo tính năng, không chỉ lấy snippet.
3. [Quan sát Seller Center](../../../knowledge-base/shopee-seller-observations/AGENT_GUIDE.md) — phạm vi shop/ngày và điểm chưa xác minh.
4. Kiến trúc, báo cáo giá/QC, agent và bằng chứng sandbox đã liên kết phía trên.

Các bản nghiên cứu cũ có đề xuất chưa được người dùng chấp nhận; khi mâu thuẫn, các quyết định mới trong Global Constraints và AGENTS được ưu tiên. Kế hoạch này tổng hợp nghiên cứu hiện có ngày 10/09; không phải một lần xác minh lại toàn bộ tài liệu Shopee hoặc các quyền ứng dụng.
