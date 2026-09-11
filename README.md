# Shopee Workspace

Ứng dụng nội bộ để nhập tài liệu sản phẩm có sẵn, ghép SKU, kiểm nguồn, xem trước và chuẩn bị kế hoạch đăng/cập nhật cho nhiều shop.

**Trạng thái 10/09/2026: bản phát triển chạy tại máy; chưa nghiệm thu production.** Luồng đăng/cập nhật Shopee, làm mới token tự động, khuyến mại, QC, đo tải và chạy bền 24 giờ còn trong kế hoạch. Không có lệnh ghi Shopee trong worker hiện tại. Kết nối sandbox mới hỗ trợ kiểm tra bằng API đọc shop.

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

- Nhập Excel KINI, Word và ảnh PNG/JPEG/WebP qua HTTP; xử lý bằng worker riêng và lưu tệp theo SHA-256.
- Ánh xạ theo nhãn của từng khối, hỗ trợ khối cạnh nhau và bộ giá có tiêu đề phân nhóm. Cột mơ hồ được đánh dấu; sheet chưa có mapping được hiển thị rõ.
- Chọn các dòng SKU, gán tiêu đề/nội dung và vai trò ảnh. Giữ nguyên nhãn phân loại, nội dung và bytes ảnh gốc.
- Lưu bản nháp có phiên bản, xem trước và lưu kế hoạch cho từng shop. GIÁ GỐC và mục tiêu khuyến mại tách riêng.
- PostgreSQL giữ kế hoạch bất biến, giao dịch job/outbox và ràng buộc chống gửi trùng. Có phép thử đồng thời, xung đột phiên bản và rollback.
- Kết nối sandbox bằng Test Partner Key / Access Token nhập ở UI, gọi `get_shop_info` trực tiếp. Khóa/token mã hóa tại server và không được trả lại UI.
- Bổ sung 11/09: **Tra cứu & kiểm tra** dùng hai kho Shopee tại máy, mở toàn bài có metadata/hash, kiểm scope/phiên bản kế hoạch và lưu lịch sử vào PostgreSQL. Harness chỉ có công cụ đọc, giới hạn lượt/thời gian; chưa cấu hình LLM hoặc MCP. Đây chưa phải bộ kiểm chính sách ngành đầy đủ hoặc QC Shopee.

Tồn thủ công đã có hợp đồng và quy tắc không tự bù sau đơn hàng; **màn hình nhập lệnh tồn và executor chưa hoàn tất**. Chưa tự suy ngành, thương hiệu, chứng từ, logistics, giới hạn ảnh hoặc quyền API từ ví dụ tài liệu.

## Kiểm tra

```powershell
node scripts/verify.mjs
```

Kiểm kiểu, build, test extension cũ và unit/integration dùng PostgreSQL thật. Test tự tạo schema riêng. Không thay DB bằng mock để báo đạt.

`npm run test:e2e` là phép nghiệm thu đọc trên app local đang chạy và bộ Lamy đã nhập; cần Edge trên Windows. Nó không tự seed dữ liệu riêng và không gửi lệnh Shopee. CI chỉ chạy fixture unit/integration, không tải dữ liệu doanh nghiệp.

## Tài liệu và phạm vi

- [Hướng dẫn chạy](docs/runbooks/local-development.md)
- [Mốc thực thi và giới hạn](docs/delivery/2026-09-10-foundation.md)
- [Kiểm tra tiếp nối 11/09](docs/delivery/2026-09-11-checkpoint.md)
- [Hướng dẫn lấy thông tin TEST](docs/runbooks/sandbox-connection.md)
- [Harness và bộ đánh giá](docs/runbooks/agent-evaluation.md)
- [Kế hoạch E2E](docs/superpowers/plans/2026-09-10-shopee-execution-plan.md)
- [Quy tắc tra cứu Shopee](AGENTS.md)

Kho kiến thức, workbook, Word, ảnh Canva và bằng chứng shop riêng nằm tại máy, không được đưa vào repository tự động. Các file extension ở root được giữ nguyên như một baseline riêng; ứng dụng mới ở `apps/` và `packages/`.
