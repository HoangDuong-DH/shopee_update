# Shopee Workspace

Ứng dụng nội bộ để tiếp nhận bộ listing đã chuẩn bị, đối chiếu SKU/giá/nội dung/ảnh và chuẩn bị đăng/cập nhật cho nhiều shop. Bảng giá là nguồn tra cứu, không phải nơi tự ghép các SKU thành listing.

**Trạng thái 12/09/2026: bản phát triển chạy tại máy; chưa nghiệm thu production.** Trang chính là **Công việc đăng hàng**, gắn bản nguồn đã chuẩn bị với từng shop. Backend cập nhật Lamy sandbox cũ vẫn chờ đối chiếu mã bìa. Nhánh tạo thử riêng đã gửi **80 nguồn kỹ thuật qua API backend/worker: 76 listing đọc lại đạt, 4 bị Shopee từ chối**, tất cả link tạo được giữ UNLIST. Không gửi lại bốn nguồn lỗi hoặc nhân bản Lamy. Đây là phép thử thật trên sandbox với dữ liệu giả, tách khỏi ca mô phỏng 80 nguồn trong integration. Đăng hàng loạt từ nguồn doanh nghiệp, làm mới token tự động, khuyến mại, QC và vận hành bền 24 giờ chưa nghiệm thu. Shop thật chỉ đọc.

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

`npm run test:e2e` là phép nghiệm thu đọc trên app local đang chạy và bộ Lamy đã nhập; cần Edge trên Windows. Nó không tự seed dữ liệu riêng và không gửi lệnh Shopee. CI chỉ chạy fixture unit/integration, không tải dữ liệu doanh nghiệp.

## Tài liệu và phạm vi

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
