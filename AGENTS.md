# ListingStudio — chỉ dẫn cho Codex và người duy trì

Bắt đầu tại [START_HERE](docs/onboarding/START_HERE.md). Nếu nhận repo lần đầu, đọc [CODEX_FIRST_RUN](docs/onboarding/CODEX_FIRST_RUN.md), sau đó chạy kế hoạch thiết lập trước khi thay đổi máy. Không đọc toàn bộ lịch sử theo mặc định.

## Nguyên tắc dữ liệu và listing

- Chỉ dùng ảnh, nội dung, cấu trúc phân loại, SKU và giá truy được về đúng tệp/dòng/ô người dùng cung cấp hoặc xác nhận. Không tự tìm ảnh, mượn listing khác, suy SKU/giá từ tên, tạo phân loại hay lấp dữ liệu thiếu. Lịch sử chỉ là gợi ý chưa được duyệt.
- Mọi ngành hàng dùng cùng hợp đồng nguồn: số tầng, tên tầng, nhãn lựa chọn, tổ hợp SKU/giá và vai trò ảnh được đối chiếu với khai báo độc lập của đúng bộ nguồn. Không hardcode theo mùi, màu, cỡ hoặc loại hàng. Thiếu/mâu thuẫn thì giữ riêng bộ đó, nêu tên sản phẩm và phần cần bổ sung; tiếp tục các bộ đủ nguồn.
- Trước mọi lần ghi Shopee, đọc trạng thái và toàn bộ trường của đúng partner/shop/item. Sau ghi, đọc lại cả trường thay đổi và phần cần giữ. Giữ NORMAL/UNLIST, SKU, giá, tồn, ảnh, video, nội dung, vận chuyển ngoài phạm vi người dùng giao.
- ACK/HTTP 200 không phải QC đạt. Payload đọc lại khớp không tự chứng minh payload đúng nguồn. Unknown phải đối chiếu journal/readback trước retry; không tạo lại, phát lại hay bù tồn chỉ vì phản hồi trễ.
- Với xóa kích thước, chỉ xóa R–D–C; không xóa/tạo lại phân loại hoặc trường khác. Chênh lệch phải giữ ngoại lệ và báo, không tự ghi đè để bù.
- Trước chuẩn bị/đăng, đọc [source-provenance-guard](docs/runbooks/source-provenance-guard.md) và [skill vận hành](skills/shopee-uploader-operator/SKILL.md). Không dùng script ghi trực tiếp bỏ chốt nguồn.
- Đăng ẩn, mở bán, sao chép và sửa link là các phạm vi riêng. Tôn trọng yêu cầu tạm dừng hiện tại; không tự chạy/resume batch khi cài đặt hoặc khởi động. Quyền đã được người dùng cấp trong phiên vẫn có hiệu lực; không hỏi lại vô cớ.

## Đọc đúng phần theo công việc

| Công việc | Điểm bắt đầu |
| --- | --- |
| Cài mới / khởi động | `docs/onboarding/START_HERE.md`, `CODEX_FIRST_RUN.md` |
| Cấp quyền nhiều shop | `docs/onboarding/SHOP_CONNECTIONS.md` |
| Chuyển dữ liệu / phục hồi | `docs/onboarding/TRANSFER_AND_RECOVERY.md`, `docs/runbooks/internal-backup-restore.md` |
| Sửa code / kiến trúc | `README.md`, `docs/handoffs/PROJECT_HANDOFF.md`, runbook liên quan |
| Làm việc với mô hình / harness | `docs/ai/MODEL_MANAGEMENT_HARNESS.md`, `packages/agent-runtime` |
| Bàn giao / báo cáo | `skills/shopee-uploader-handoff/SKILL.md`, `docs/onboarding/ACCEPTANCE.md` |

Hai skill trong `skills/` được đọc theo chỉ dẫn này; thư mục đó không mặc nhiên là kho skill tự phát hiện của Codex. Harness hiện xác định bằng chương trình, không tự gọi LLM, không tự cấp quyền ghi hoặc cài SDK/MCP.

## Thiết lập và kiểm chứng

- Node `>=24.20.0 <25`, npm lockfile, PostgreSQL 17 / Docker Compose 2. `npm run onboarding:plan` chỉ kiểm tra; `npm run onboarding:setup` cài cấu hình/database mới có biên nhận. Không áp setup mới lên `.env`/volume vận hành đã có.
- Bản cài mới tắt production pilot, ghi Shopee và bảo trì kết nối. Không bật bằng launcher. Tài khoản Open Platform, partner key và cấp quyền shop phải do chủ sở hữu cung cấp.
- Trên máy có dữ liệu vận hành, kiểm tra ở checkout/database riêng. Dùng môi trường cách ly theo `docs/runbooks/internal-development.md`; không chạy test integration lên DB vận hành, không build đè giao diện đang phục vụ hoặc restart khi chưa kiểm PID/job.
- Kiểm tương xứng thay đổi. Khi sửa code: typecheck, test liên quan, build; chạy kiểm tổng trong môi trường riêng nếu thay đổi luồng thiết lập hoặc contract chung. Browser fixture không chứng minh Shopee production/đa shop/24 giờ.
- Không sửa byte migrations đã áp dụng; tạo migration mới. Không in/commit `.env`, token, partner key, dữ liệu shop, workbook, ảnh nguồn, receipts hoặc khóa mã hóa.
- Ghi rõ điều đã kiểm, chưa kiểm, lỗi còn lại và bước tiếp theo. Báo tiến độ bằng tên sản phẩm/chức năng, không chỉ mã kỹ thuật.

## Lịch sử và hiện trạng máy vận hành

Public handoff là điểm bắt đầu chung; `docs/delivery/` có thể không tồn tại trên máy nhận. Khi thiếu không suy diễn nội dung từ tên đường dẫn/Git. Lịch sử dài trước khi rút gọn được giữ riêng trong `.local/packaging-handoff-20261002/AGENTS.before.md` tại máy vận hành, không có trong gói public. Khi tiếp tục công việc cũ phải đọc checkpoint/biên nhận thật tại máy và journal DB; không lấy dòng trong tài liệu cũ làm quyền gửi lại.

Repo chứa source và fixtures; clone không đem theo database, tệp riêng, token hay khóa giải mã. Khả năng production vẫn phụ thuộc metadata và capability thực của từng shop/ngành; không tuyên bố toàn bộ ngành hàng hoặc 24 giờ đã nghiệm thu.
