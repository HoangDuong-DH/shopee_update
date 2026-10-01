# Phát triển song song với bản vận hành

Mục đích: dùng một worktree và một database riêng để nâng cấp trong khi nhân viên tiếp tục sử dụng bản đang chạy. Không chuyển nhánh trong thư mục đang phục vụ API/worker. Không dùng database vận hành để chạy test, migrate thử hoặc nạp fixture.

## Hai môi trường

| Thành phần | Vận hành hiện có | Phát triển cách ly mặc định |
|---|---|---|
| Thư mục mã | Checkout đang chạy | Worktree của nhánh nâng cấp |
| API | 4310 | 4430 |
| Giao diện dev | 5173 | 5273 |
| PostgreSQL | 5442 | 5443 |
| Database | Theo cấu hình vận hành | `shopee_internal_test` |
| Dữ liệu tệp | Theo `DATA_ROOT` vận hành | Worktree `.local/internal/data` |
| Khóa mã hóa | Khóa hiện có | Khóa mới, không giải mã token thật |
| Ghi production / tự refresh | Theo cấu hình vận hành | Tắt |
| Gọi HTTP bằng fetch ra ngoài | Theo quyền vận hành | Chặn, kể cả redirect |

Launcher là công cụ dành cho developer, không phải nút khởi động dành cho nhân viên. Không có bước nào tự khởi động lại bản vận hành hoặc merge nhánh.

## Khởi tạo một lần

Chạy trong worktree bằng Node 24 theo `engines` của repository. Không chép `.env`, `.local`, thư mục `node_modules` hay token từ checkout vận hành. Cần Docker Desktop đang sẵn sàng cho database thử; không thao tác xóa volume cũ.

```powershell
npm ci
node scripts/internal-environment.mjs init
node scripts/internal-environment.mjs inspect
docker compose --env-file .local/internal/docker.env -f .local/internal/compose.yaml up -d postgres
node scripts/internal-environment.mjs migrate
node scripts/internal-environment.mjs dev
```

Mở `http://127.0.0.1:5273`. Dừng launcher bằng Ctrl+C sẽ dừng API, worker nhập và Vite của phiên này. Container PostgreSQL thử vẫn giữ dữ liệu; nếu cần dừng, dùng đúng file Compose ở trên với `stop`, không dùng file của bản vận hành.

`init` chỉ sinh cấu hình, Compose và khóa riêng; không chạy service. Chạy lại khi đã có cấu hình sẽ báo lỗi thay vì thay khóa hoặc ghi đè. Tệp trong `.local/internal` không được commit. Quyền file `0600` trên Windows không thay cho ACL: hạn chế quyền thư mục bằng tài khoản Windows quản trị môi trường.

`inspect` in địa chỉ/cổng/đường dẫn, không in URL database chứa mật khẩu hay khóa. `dev` từ chối khởi động nếu cổng thử đã bị chiếm, workspace packages trỏ về checkout khác, chưa migrate hoặc database chứa kết nối shop. Với worktree mới, `npm ci` là cần thiết để workspace packages trỏ đúng mã nâng cấp.

Không dùng `scripts/start-local.mjs` cho rehearsal: launcher vận hành này có thể bật production. Không chạy `npm run dev` rồi cho rằng các cổng đã tự đổi; Vite mặc định vẫn trỏ API 4310. Launcher mới ghi đè riêng các cổng và proxy bằng API của Vite.

## Kiểm chứng lặp lại được

Sau khi cài dependency, khởi tạo và migrate database thử ở trên, chạy từ đúng thư mục gốc của worktree:

```powershell
node scripts/verify-internal.mjs --help
node scripts/verify-internal.mjs --dry-run
node scripts/verify-internal.mjs
```

Lệnh [verify-internal.mjs](../../scripts/verify-internal.mjs) đọc cấu hình cách ly, kiểm workspace dependency trỏ đúng checkout, bắt buộc PostgreSQL `127.0.0.1:5443/shopee_internal_test`, tắt ghi production và bảo trì kết nối, rồi chạy tuần tự kiểm kiểu → skill repository → build TypeScript → build web → legacy → unit/integration. Mỗi bước dùng môi trường được lọc; preload chặn fetch ra ngoài được truyền xuống tiến trình con. `empty.env` chỉ được chứa dòng trống hoặc chú thích. Không dùng `scripts/verify.mjs` thay thế rồi giả định đã được cách ly.

Kết quả JSON nằm trong thư mục riêng cho mỗi lượt `.local/internal/verification/run-*/`: `verification.json` ghi tiến độ và bước lỗi đầu tiên; `unit-integration.json` ghi báo cáo test nếu bước đó đã chạy. Dừng ở lỗi đầu tiên; các bước chưa chạy không được coi là đạt. Báo cáo/ảnh/trace giữ riêng, không commit vì có thể chứa dữ liệu fixture hoặc thông tin vận hành. `--dry-run` chỉ kiểm cấu hình/dependency và in tên các bước; không chạy kiểm thử, không ghi báo cáo và không kiểm sức khỏe database.

Muốn thêm nghiệm thu thao tác tay bằng trình duyệt, chạy rõ ràng:

```powershell
node scripts/verify-internal.mjs --browser
```

Tùy chọn này chạy các bước trên trước, sau đó **chỉ** `tests/e2e/internal-acceptance-intake.spec.ts`: ZIP và Excel fixture → chỉnh nháp/phân loại → chuẩn bị → tạo link ẩn mô phỏng → refresh → xuất QC. Spec tự tạo schema/API/UI thử và dọn sau chạy; cần Microsoft Edge có sẵn. Cấu hình riêng không kế thừa `baseURL` 5173 hoặc khởi động bản vận hành; kết quả là `browser-intake.json` và `browser-artifacts/`. Nó không chạy toàn bộ Playwright và không chứng minh đăng Shopee thật, quyền nhiều nhân viên hay vận hành liên tục đã đạt. Không chạy nhiều lượt nghiệm thu dùng chung database thử cùng lúc.

## Giới hạn cách ly

Preload `internal-network-guard.mjs` chặn `globalThis.fetch` tới địa chỉ ngoài loopback và chặn redirect. Nó không phải firewall cho mọi giao thức/thư viện. Khi thêm transport sử dụng `http`, `https`, socket hay thư viện riêng, phải bổ sung chặn tại transport hoặc dùng chính sách mạng của máy/container. Không import token thật và không cho người thử kết nối shop production trong rehearsal.

Không khởi động worker trên database vừa phục hồi từ vận hành: database ấy có thể chứa công việc và kết nối thật. Dùng nó để kiểm tra phục hồi offline; dùng database fixture sạch khác để nghiệm thu UI. Khóa mã hóa mới không phải cơ chế đủ để bảo vệ các worker ngoài phạm vi đã kiểm.

## Cập nhật sang bản vận hành

1. Ghi nhận commit đang vận hành, phiên bản migration và phạm vi kiểm chứng. Chốt một người điều phối release.
2. Kiểm thử bản nâng cấp với nguồn fixture, kể cả đổi shop, refresh, bấm đôi và mất phản hồi; không tạo listing thật chỉ để thử.
3. Chọn cửa sổ bảo trì. Ngừng nhận lệnh ghi mới; kiểm tra từng công việc đang gửi/đang xác minh. Không coi đóng trình duyệt là worker đã dừng và không cưỡng bức giải phóng khóa.
4. Hoàn thành backup và xác minh theo [hướng dẫn phục hồi](internal-backup-restore.md). Giữ khóa mã hóa riêng an toàn.
5. Hợp nhất commit đã duyệt, cài dependency theo lockfile, build, rồi áp dụng migration đã review. Ưu tiên migration bổ sung tương thích bản cũ; không tự chạy down migration.
6. Khởi động một API và một worker của bản mới. Kiểm `/health/ready`, heartbeat, công việc cũ và màn hình thao tác. Không bật song song hai writer trên database vận hành để kiểm nhanh.
7. Nếu rollback, đánh giá schema có tương thích code cũ không. Không đơn giản restore database cũ sau khi đã có lệnh Shopee mới: phải đối chiếu các lệnh đã gửi để tránh mất nhật ký và tạo trùng.

## Bằng chứng tối thiểu cho release

Ghi commit, môi trường, lệnh kiểm, kết quả và ngày vào biên bản release. Test công cụ cách ly/hàm bảo vệ chỉ xác minh cơ chế đó; chưa chứng minh database restore, UI E2E, ghi Shopee, quyền nhiều nhân viên hay vận hành 24 giờ đã đạt.
