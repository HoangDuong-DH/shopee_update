# Shopee Workspace

**Checkpoint hiện tại — 16/09/2026:** đã đăng qua backend OpenAPI và đối chiếu đạt **xịt thơm ô tô / 48 phân loại** và **xịt khử mùi thảm / 48 phân loại** trên shop **1423724897 / vuatinhdau.vn**. Cùng can 5L và Ngọc Lan Tây của lượt trước, GET mới xác nhận **4 listing đều NORMAL**. Xịt khử mùi tủ giày và giày da nam chưa gửi vì ngành yêu cầu bảng kích cỡ; đã có [phiếu xử lý tay](docs/operator-guides/pass1-viec-can-xu-ly-tay.md). Đọc [bằng chứng và giới hạn mới nhất](docs/delivery/2026-09-16-pass1-continuation.md).

Kiểm mới **1753 unit/integration + 7 legacy, typecheck/build đạt**; một browser fixture gọi tên sản phẩm đạt riêng. 17 browser fixture của workflow thuộc ngày 15/09. Đã nối **listing đã lưu → kiểm nguồn/metadata → chuẩn bị lô → hàng đợi API → đọc lại/QC** trong phạm vi được cho phép; xem [hướng dẫn nhân viên](docs/operator-guides/dang-hang-tu-bo-listing-da-luu.md). Chưa nghiệm thu 80 listing thật, nhiều shop, mọi nhóm cập nhật hoặc chạy liên tục 24h. 80 bộ ở test chỉ chứng minh chuẩn bị nguồn/manifest tại máy. Các mốc bên dưới là lịch sử, không thay thế checkpoint mới.

## Các mốc trước ngày 15/09

Bổ sung 14/09: **Kho listing** là trang đầu; đã nhận bộ nội dung Vina Tươi gồm 604 dòng và danh mục 227 thiết kế Canva/5.961 trang vào database nội bộ. Mỗi phần giữ nguồn theo ô; ảnh và tham khảo shop cũ chưa tự áp dụng. Xem [bàn giao kho nguồn và giao diện](docs/delivery/2026-09-14-source-catalog-and-ux.md). Chưa có ảnh gốc, giá/tồn/SKU đầy đủ hoặc luồng xác nhận catalog thành bộ đăng.

Ứng dụng nội bộ để tiếp nhận bộ listing đã chuẩn bị, đối chiếu SKU/giá/nội dung/ảnh và chuẩn bị đăng/cập nhật cho nhiều shop. Bảng giá là nguồn tra cứu, không phải nơi tự ghép các SKU thành listing.

**Trạng thái 14/09/2026: bản phát triển chạy tại máy; chưa nghiệm thu production.** Luồng nhập 80 thư mục đã đạt tại tầng ứng dụng với gateway mô phỏng. Lớp gửi OpenAPI mới có nhật ký từng yêu cầu, kiểm metadata/nguồn và đối chiếu sau ghi; 80 sản phẩm / 200 SKU / 3 shop / 4 ngành giả lập đã được kiểm ở lớp HTTP. Một patch tiêu đề mới trên mẫu kỹ thuật sandbox 803935036 đã gửi thật và đọc lại đúng, giữ nguyên phần không chọn. Xem [bàn giao OpenAPI](docs/delivery/2026-09-14-openapi-wire-bridge.md) để phân biệt phạm vi. Worker cho nguồn doanh nghiệp vẫn chưa nối trọn với lớp gửi này; refresh token, production và vận hành 24h chưa nghiệm thu. Shop thật chỉ đọc.

Lượt sandbox kỹ thuật trước đó tạo 76/80 nguồn và có 4 nguồn bị từ chối; đó không phải 80 listing doanh nghiệp đã được nghiệm thu. Không gửi lại 4 nguồn lỗi, không nhân bản Lamy 803934364 hoặc chạy lại phép ghi bìa đang `unknown`.

Bổ sung kiểm thử cập nhật 14/09: tồn 0 và ảnh phân loại hai tầng đạt trên sandbox. Phép chuyển gallery 1:1 → 3:4 phát hiện Shopee thay bìa ngoài yêu cầu; bìa mẫu đã khôi phục bằng lệnh riêng, QC ảnh tự động chưa được nghiệm thu. Luồng tự động chuyển tỷ lệ bị chặn. Xem [kết quả từng tình huống](docs/delivery/2026-09-14-patch-scenarios.md) trước khi chạy thêm; không phát lại intent cũ.

## Chạy tại máy

Cần Node **24.20.0**, npm và Docker Desktop chạy Linux containers. Bản Node riêng của dự án đang ở `.local/runtime/` trên máy phát triển; thư mục này không nằm trong Git.

```powershell
npm ci
npm run setup:local
docker compose --env-file .local/docker.env -f infra/local/compose.yaml up -d postgres
npm run db:migrate
npm run dev
```

Mở **http://127.0.0.1:5173/**. PostgreSQL phát triển dùng cổng **5442**, API dùng **4310**. `setup:local` tạo khóa/password ngẫu nhiên và giữ `.env` đã có. Không cần tài khoản nhân viên để sử dụng app.

## Phần đã triển khai

- **Nhập bộ cập nhật** nhận riêng Excel giá/tồn, Word và ảnh, không bắt nhập lại bộ listing đầy đủ. Mỗi sheet/bộ giá có nhóm công việc/shop riêng; SKU được ghép chính xác, ô trống giữ nguyên và tồn 0 được nhận diện. Xem trước theo bản nguồn đã lưu, chọn/bỏ chọn nhóm thay đổi, lưu biên nhận qua API/PostgreSQL rồi mở lại. Cùng ảnh có thể dùng nhiều vai trò với thứ tự riêng; không tự viết/crop nguồn. Luồng này chỉ chuẩn bị nội bộ, chưa đọc trạng thái hiện tại hoặc gửi patch lên Shopee. Xem [cách nhập cập nhật](docs/runbooks/import-updates.md).
- Bảng công việc tách bộ nguồn khỏi nơi đăng: chọn nhiều bộ, shop đích, đăng mới/cập nhật và trường cần cập nhật. Lưu cấu hình có phiên bản; phân biệt thiếu nguồn, cần ánh xạ, lỗi kết nối, xung đột và tính năng chưa hỗ trợ. Tồn đăng bán nhập riêng theo SKU/shop, để trống không được hiểu là 0.
- Hồ sơ bàn giao tùy chọn được xuất từ nguồn đã lưu, dùng lại ánh xạ nội dung/ảnh/SKU/giá. Nhập lại cần xem khác biệt trước khi lưu; không thay thế các tệp nguồn và không yêu cầu nhân viên tự viết JSON. Luồng đầu vào chính vẫn là thư mục Word/ảnh với bảng giá chung.
- Luồng sandbox trực tiếp chỉ cho phép partner `1232297`, shop `227418363`, item `803934364`; các trường `title`, `description`, `gallery`. Giữ byte ảnh và bố cục nguồn; kiểm SKU/nhãn, giới hạn thật từ API, phiên bản công việc và dữ liệu trước khi gửi. Ghi checkpoint, khóa mục tiêu, đọc lại cả trường được chọn và trường giữ nguyên. Kết quả chưa rõ được phục hồi từ server để đối chiếu, không tự gửi lại.
- Nhập Excel KINI, Word và ảnh PNG/JPEG/WebP qua HTTP; xử lý bằng worker riêng và lưu tệp theo SHA-256.
- Ánh xạ theo nhãn của từng khối, hỗ trợ khối cạnh nhau và bộ giá có tiêu đề phân nhóm. Cột mơ hồ được đánh dấu; sheet chưa có mapping được hiển thị rõ.
- **Kho đầu vào** tách bảng giá dùng chung khỏi các bộ Word/ảnh theo thư mục listing. Nhận nhiều thư mục trong một đợt, lưu đường dẫn, nguồn giá, cách đọc Word và thứ tự ảnh vào PostgreSQL; mở lại đợt sau khi tải lại trang mà không tải lại tệp đã nhận. Phiên bản bất biến và kiểm tra xung đột bảo vệ lựa chọn của người khác.
- Luồng nhập thư mục giữ riêng nguồn của từng listing. Phần SKU/nhãn chưa rõ có bước bổ sung bằng bảng hoặc dán Excel; không suy danh sách SKU từ KINI. Định danh bộ trong đợt đã lưu ổn định; nhập cùng sản phẩm vào một đợt mới vẫn cần đối chiếu trùng.
- Nội dung Word có chọn đoạn và xem trước trước khi áp dụng. Ảnh chọn riêng theo vai trò, hình thu nhỏ và thứ tự; có tải tệp ngay trong luồng và thử lại từng tệp lỗi. Ba tab Nội dung / Bộ ảnh / SKU & phân loại giúp xem từng phần. Chưa tự đọc trọn mọi bộ listing hoặc phục hồi nội dung/ảnh chưa lưu sau tải lại trang.
- Bản đã lưu mở ở chế độ xem; điều chỉnh nội dung/ảnh phải được chọn rõ. Máy chủ khóa thứ tự SKU, tên tầng và nhãn phân loại của cùng mã bộ, giữ cả hai tầng và khoảng trắng. Khóa này chưa xác minh quan hệ SKU trên Shopee.
- Lưu bản nháp có phiên bản, xem trước và lưu kế hoạch cho từng shop. GIÁ GỐC và mục tiêu khuyến mại tách riêng.
- PostgreSQL giữ kế hoạch bất biến, giao dịch job/outbox và ràng buộc chống gửi trùng. Có phép thử đồng thời, xung đột phiên bản và rollback.
- Kết nối sandbox bằng Test Partner Key / Access Token nhập ở UI, gọi `get_shop_info` trực tiếp. Khóa/token mã hóa tại server và không được trả lại UI.
- Bổ sung 11/09: **Tra cứu & kiểm tra** dùng hai kho Shopee tại máy, mở toàn bài có metadata/hash, kiểm scope/phiên bản kế hoạch và lưu lịch sử vào PostgreSQL. Harness chỉ có công cụ đọc, giới hạn lượt/thời gian; chưa cấu hình LLM hoặc MCP. Đây chưa phải bộ kiểm chính sách ngành đầy đủ hoặc QC Shopee.

Mức tồn đã có chỗ nhập trong cấu hình công việc; chưa nối sang lệnh cập nhật tồn Shopee và không tự bù sau đơn hàng. Chưa tự suy ngành, thương hiệu, chứng từ, logistics hoặc quyền API từ ví dụ tài liệu. Nhánh thử kỹ thuật đã đối chiếu phân loại/giá/tồn/vận chuyển trên sandbox; executor cho nguồn doanh nghiệp và các trường còn lại vẫn chưa nghiệm thu. Giới hạn sandbox không áp làm mặc định production.

## Kiểm tra

```powershell
node scripts/verify.mjs
```

Kiểm kiểu, build, test extension cũ và unit/integration dùng PostgreSQL thật. Test tự tạo schema riêng. Không thay DB bằng mock để báo đạt.

`npm run test:e2e` cần Edge trên Windows và app local đang chạy. Suite gồm kiểm tra chỉ đọc với Lamy, các fixture trình duyệt và luồng nhập cập nhật chạy API/worker nhập/PostgreSQL thật trong schema và blob riêng. Runner cập nhật giới hạn DB localhost:5442, chặn fetch ra ngoài localhost và dọn fixture khi kết thúc. Không gửi lệnh Shopee hoặc seed bộ cập nhật vào dữ liệu doanh nghiệp chính. CI hiện chỉ chạy fixture unit/integration, không tải dữ liệu doanh nghiệp.

## Tài liệu và phạm vi

- [Bàn giao và nghiệm thu luồng nhập cập nhật](docs/delivery/2026-09-12-import-patch-workflow.md)
- [Hướng dẫn nhập giá, tồn, Word và ảnh cập nhật](docs/runbooks/import-updates.md)
- [Phản biện UX/API luồng cập nhật](docs/reviews/2026-09-12-import-patch-ui-backend-review.md)
- [Thử hàng loạt bằng API backend sandbox](docs/runbooks/sandbox-backend-trials.md)
- [Kết quả backend ngày 12/09](docs/delivery/2026-09-12-backend-sandbox-trial.md)
- [Hướng dẫn chạy](docs/runbooks/local-development.md)
- [Cách dùng giao diện listing](docs/runbooks/listing-workspace.md)
- [Công việc theo shop và phép thử backend](docs/delivery/2026-09-11-operation-workbench.md)
- [Kho đầu vào và phục hồi đợt nhập](docs/delivery/2026-09-11-input-library.md)
- [Mốc thực thi và giới hạn](docs/delivery/2026-09-10-foundation.md)
- [Kiểm tra tiếp nối 11/09](docs/delivery/2026-09-11-checkpoint.md)
- [Hướng dẫn lấy thông tin TEST](docs/runbooks/sandbox-connection.md)
- [Harness và bộ đánh giá](docs/runbooks/agent-evaluation.md)
- [Kế hoạch E2E](docs/superpowers/plans/2026-09-10-shopee-execution-plan.md)
- [Quy tắc tra cứu Shopee](AGENTS.md)

Kho kiến thức, workbook, Word, ảnh Canva và bằng chứng shop riêng nằm tại máy, không được đưa vào repository tự động. Các file extension ở root được giữ nguyên như một baseline riêng; ứng dụng mới ở `apps/` và `packages/`.
