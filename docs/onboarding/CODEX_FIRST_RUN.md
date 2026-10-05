# Giao dự án cho Codex

Mở cả thư mục dự án bằng Codex, rồi dán nội dung dưới đây. Nếu chuyển máy, nói rõ vị trí bộ dữ liệu/key riêng được người bàn giao cung cấp; không dán token hoặc khóa vào chat. Chọn cài ứng dụng trống hoặc chuyển dữ liệu đang có trước khi chạy. Khi bàn giao ứng dụng đầy đủ, cung cấp cả vị trí `REFERENCE_LIBRARY`; chỉ tải source chưa có thư viện tham chiếu.

```text
Hãy thiết lập ListingStudio trong thư mục dự án này để tôi dùng trên Windows.

Đọc AGENTS.md, docs/onboarding/START_HERE.md và
docs/handoffs/PROJECT_HANDOFF.md trước. Chỉ đọc thêm tài liệu liên quan
đến bước đang làm; không cần đọc toàn bộ Markdown hay checkpoint lịch sử.

Kiểm tra phiên bản mã, Node/npm, Docker engine Linux/Compose v2, cổng,
cấu hình, dữ liệu và tiến trình hiện có. Nếu Node sẵn sàng, chạy
node scripts/bootstrap.mjs để xem kế hoạch. Không in nội dung .env,
token hoặc khóa. Khi thiếu Node, kiểm launcher SETUP_LISTINGSTUDIO.cmd
để tải runtime portable có xác minh SHA-256. Khi dùng portable, dùng
node.exe/npm.cmd trong đúng runtime cho các bước sau; PATH của terminal
mới có thể chưa có Node/npm.

Nếu chỉ kiểm source/build, ghi rõ phạm vi đó và phần thư viện còn thiếu.
Ứng dụng đầy đủ cần REFERENCE_LIBRARY với cả hai bộ tài liệu.
Trước START, dùng reference-library.mjs verify --library PATH, rồi
import --library PATH để kiểm và import --library PATH --apply để nhập.
Chỉ nhập khi knowledge-base của checkout chưa tồn tại; giữ nguyên thư
viện có sẵn, không ghi đè hoặc tự tải thay nguồn bàn giao.

Nếu muốn ứng dụng trống mới, thực hiện onboarding:setup,
onboarding:check và start:local. Chỉ migrate database local mới do
công cụ tạo cho chính bản sao này. Nếu thiếu Docker Desktop,
chỉ rõ phần chủ máy cần cài/bật và tiếp tục các kiểm tra còn làm được.

Nếu đang chuyển dữ liệu cũ, đọc
docs/onboarding/TRANSFER_AND_RECOVERY.md trước.
Nhận đủ bộ database/keys riêng và REFERENCE_LIBRARY đã kiểm.
Thiết lập bản sao mới riêng nhưng chưa khởi động app, rồi dùng
transfer-local.mjs verify, plan và restore --apply cho đúng bộ đã nhận.
Giữ mật khẩu database/cổng máy nhận, nhận đúng khóa giải mã nguồn,
kiểm blob và biên nhận chuyển đường dẫn. Không sửa raw source,
journal/payload hoặc fingerprint. Giữ transfer-hold; chỉ mở API/UI
để kiểm tra, không chạy worker hoặc tự tiếp tục công việc cũ.
Không gọi kết nối/ghi Shopee để thử các key đã được chuyển.

Nếu đã có cấu hình, database, dữ liệu hoặc tiến trình đang chạy,
giữ nguyên chúng, đọc docs/onboarding/TRANSFER_AND_RECOVERY.md
và kiểm tra trước khi tiếp tục. Không tạo lại khóa mã hóa, ghi đè
cấu hình, xóa volume, tự dừng bản vận hành hoặc chạy job cũ.

Giữ ghi production, pilot và bảo trì kết nối tự động tắt.
Không gọi ghi Shopee, sao chép listing hoặc tự mở bán trong lượt thiết lập.
Hoàn thành docs/onboarding/ACCEPTANCE.md bằng kiểm tra local/fixture,
rồi báo địa chỉ mở app, các bước đã đạt, việc còn thiếu và phạm vi kiểm.
Kết nối mới cần chủ shop nhập khóa và tự cấp quyền đúng tài khoản;
kết nối đã chuyển vẫn cần kiểm quyền hiện tại khi được giao tiếp tục.
```

## Lệnh dành cho Codex

Chạy ở thư mục chứa `package.json`:

| Lệnh | Tác dụng |
| --- | --- |
| `node scripts/bootstrap.mjs` hoặc `npm run onboarding:plan` | Kiểm tra và xem kế hoạch; không tạo cấu hình. |
| `npm run onboarding:setup` | Áp dụng kế hoạch cho bản sao mới thuộc quyền công cụ. |
| `npm run onboarding:check` | Kiểm tra điều kiện local; không chứng minh quyền Shopee. |
| `npm run start:local` | Chạy app với ghi/bảo trì tắt; khi có transfer hold, chỉ mở API/UI. |
| `node scripts/transfer-local.mjs verify --bundle DIR` | Kiểm bộ dữ liệu/key riêng, không in secrets. |
| `node scripts/transfer-local.mjs plan --bundle DIR` | Xem điều kiện chuyển vào đích, chưa restore. |
| `node scripts/transfer-local.mjs restore --bundle DIR --apply` | Nhập vào đích mới đã xác minh, giữ hold và biên nhận. |
| `node scripts/reference-library.mjs verify --library DIR` | Kiểm thư viện và các tệp tham chiếu, chưa chép. |
| `node scripts/reference-library.mjs import --library DIR` | Kiểm điều kiện nhập vào checkout này. |
| `node scripts/reference-library.mjs import --library DIR --apply` | Chép thư viện khi `knowledge-base/` chưa tồn tại, trước START. |
| `npm run test:onboarding` | Kiểm tra cơ chế onboarding; không đăng sản phẩm thật. |

Chọn cổng khác trước khi thiết lập nếu các cổng mặc định đang được dùng:

```powershell
node scripts/bootstrap.mjs --api-port 4430 --web-port 5273 --db-port 5444
node scripts/bootstrap.mjs --apply --api-port 4430 --web-port 5273 --db-port 5444
```

`--apply` chỉ nhận bản sao mới hoặc lần thử lại mà cấu hình, khóa và volume vẫn đúng biên nhận do công cụ tạo. Không sửa cấu hình có sẵn để biến một máy đang vận hành thành máy mới. `setup:local` chỉ tạo cấu hình, không thay cho quy trình cài đặt đầy đủ.

## Dùng skill đúng việc

Các skill nằm ngay trong repository; Codex có thể đọc trực tiếp `SKILL.md`, không cần cài plugin mới để đọc hướng dẫn.

| Việc tiếp theo | Đọc |
| --- | --- |
| Nhập nguồn, chuẩn bị, đọc lại hoặc phục hồi listing | [Skill vận hành](../../skills/shopee-uploader-operator/SKILL.md) và runbook của đúng thao tác. |
| Báo tiến độ hoặc bàn giao phiên làm việc | [Skill bàn giao](../../skills/shopee-uploader-handoff/SKILL.md). |
| Sửa mã, kiểm thử trên máy có dữ liệu vận hành | [Môi trường phát triển cách ly](../runbooks/internal-development.md). |
| Xem giới hạn trợ lý AI | [Model management harness](../ai/MODEL_MANAGEMENT_HARNESS.md). |

Harness hiện hướng dẫn phạm vi và kiểm chứng bằng quy tắc xác định. Nó không tự gọi LLM, không tự cài Codex/MCP và không cấp quyền ghi Shopee. `test:eval` kiểm fixture, không đo độ chính xác model.

Khi làm nghiệp vụ, chọn rõ chế độ: **kiểm tra**, **chuẩn bị**, **đăng ẩn được giao**, **phục hồi** hoặc **bàn giao**. Kết quả gửi chưa rõ phải đọc lại từ journal và Shopee trước khi cân nhắc thử lại.

Cơ chế đọc hướng dẫn tham chiếu [tài liệu AGENTS.md của OpenAI](https://learn.chatgpt.com/docs/agent-configuration/agents-md). Skill cục bộ tự phát hiện nằm trong [.agents/skills theo tài liệu OpenAI](https://learn.chatgpt.com/docs/build-skills); các skill trong thư mục skills/ của dự án được đọc trực tiếp theo AGENTS.md.
