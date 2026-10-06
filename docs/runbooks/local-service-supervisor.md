# Giám sát dịch vụ local

Launcher chính thức khởi động một tiến trình giám sát riêng sau khi API/giao diện sẵn sàng. Monitor chờ tối đa 25 giây để launcher ghi claim của đúng PID; trong lúc chờ phải giữ enabled, thư mục/runtime và identity không đổi. Claim của PID khác, timeout hoặc receipt hỏng chặn mọi vòng phục hồi. Biên nhận `.local/onboarding/supervisor.json` tách khỏi `runtime.json.roles`, nên kiểm tra launcher vẫn đếm đúng API, worker và giao diện. Không có bước migrate, gọi Shopee, resume batch hoặc thay đổi `.env` trong giám sát. Worker mới do launcher mở chạy `apps/worker/dist/main.js` bằng default exports đã build, không dùng development condition, TSX loader hoặc TSX config; IPC preload vẫn chứng minh sở hữu. API giữ entry hiện tại. Setup receipt đã khóa source/build và bao gồm worker/domain/persistence dist.

- Vòng kiểm tra cách nhau 5 giây. API/giao diện chỉ được khởi động lại khi PID cũ đã chết; IPC phải chứng minh PID, Node, đường dẫn lệnh, thời điểm tạo và đúng thư mục dự án khi nhận tiến trình còn sống.
- Tiến trình còn sống nhưng kênh sở hữu không trả lời hoặc danh tính khác được giữ `unknown`. Không kill, không chạy bản thứ hai. API còn sống nhưng readiness lỗi được giữ `degraded`; mất database không gây restart storm.
- Backoff 1, 2, 4 giây, trần 30 giây; tối đa 3 lần thử mỗi 10 phút. Vượt giới hạn chuyển `held`; hết cửa sổ không tự bỏ hold. Mỗi lần thử được ghi bền trước spawn. Receipt chứa ngân sách/lịch sử vai trò không hợp lệ hoặc runtime không đọc được chuyển held trước spawn. Spawn chưa xác minh được giữ `restart_unverified`, không thử phát lại.
- Worker nhập nguồn khi chết luôn giữ `worker_queue_review_required`. Cần người duy trì kiểm hàng đợi `queued/running`, trial intents và phạm vi công việc trước khi khởi động worker. Bản này không tự phục hồi worker, kể cả hàng đợi từng được ghi là rỗng. Transfer hold tiếp tục giữ mọi bước phục hồi.
- `.env`, source/lockfile, build hoặc Node executable đổi thì giám sát tự tắt và giữ dịch vụ còn sống. Kiểm source/build là hash mới trên máy; không dùng hash lịch sử làm bằng chứng chất lượng nguồn.
- Lịch sử tối đa 100 sự kiện chỉ có thời điểm, vai trò, PID, trạng thái/lý do cố định và mã thoát. Kênh sở hữu riêng có token trong biên nhận private; không đưa biên nhận hoặc log vào Git. `process_exit` có mã thoát từ tiến trình con; kill/crash không ghi được receipt chỉ được báo `exit_unknown`, không suy nguyên nhân.

Khóa `launch.lock` dùng chung cho start/stop/adopt và mỗi vòng giám sát; ghi JSON bằng tệp tạm độc nhất rồi đổi tên. STOP lưu `enabled:false` trước kiểm/dừng dịch vụ, sau đó chỉ dừng monitor/dịch vụ đã chứng minh sở hữu. Tiến trình unknown được giữ. Khóa cũ không tự phá chỉ vì PID đã chết: cần kiểm biên nhận/job và nguyên nhân trước xử lý lock. Bộ giám sát không phải Windows service và không tự chạy lại sau reboot hoặc khi chính monitor chết.

## Máy vận hành có helper cũ

Không áp bootstrap/setup để chuyển máy đang có dữ liệu sang receipt mới. Đường vận hành ngày 05/10 dùng `.local/project-start-20261005/runtime.json`; public module hỗ trợ riêng `--mode legacy`, giữ khóa/receipt giám sát trong cùng thư mục. Nó không kiểm/kích hoạt lại batch hoặc hàng đợi.

Đường legacy yêu cầu private `.local/project-start-20261005/build-receipt.json` trước start/adopt và mỗi kiểm identity. Người điều phối chỉ ghi receipt sau build và kiểm thử tương ứng thành công; helper không tự tạo hoặc đoán từ thời gian sửa file. Schema: version 1, kind `listingstudio-tested-local-build`, projectRoot tuyệt đối, sourceSha256/buildSha256 tính mới từ sourceIdentity/buildIdentity, executable là Node đã kiểm và verifiedAt là ISO. Thiếu hoặc hash/Node khác thì hold. Helper kiểm lại trước mỗi start; worker receipt cũ trỏ source entry phải qua dừng có kiểm trước khi chuyển compiled, không tự thay hoặc reuse worker đó.

Trước áp dụng: đọc fresh PID/IPC, nguồn/build và `.env` giữ nguyên; kiểm journal/unknown operation, queued/running và trial intents; backup source/build/receipt theo quy trình triển khai. Không chạy các bước sau khi còn in-flight work hoặc quyền chưa rõ. Khi dịch vụ đã chạy đủ và đã được duyệt, lệnh đầu chỉ kiểm đọc:

```powershell
& .local/runtime/node-v24.20.0-win-x64/node.exe scripts/local-supervisor.mjs adopt --mode legacy
& .local/runtime/node-v24.20.0-win-x64/node.exe scripts/local-supervisor.mjs adopt --mode legacy --apply
```

`--apply` chỉ tạo monitor cho các dịch vụ đã xác minh sống, không khởi động API/web/worker đang thiếu. Lặp lại dùng đúng monitor còn sống; monitor unknown hoặc identity đổi bị chặn. Khi monitor chết, áp dụng lại giữ ngân sách retry/hold của receipt còn enabled, không làm mới giới hạn tự động.

Helper private `start.mjs` ngày 05/10 đã được nối với cùng khóa, ghi runtime atomic và bật monitor sau readiness. Helper vẫn kiểm database `5442/shopee_uploader`, chỉ mở worker khi fresh queued/running và trial intents đều bằng 0; giữ production/pilot/workflow/maintenance tắt. Helper không nằm trong gói public; máy khác dùng launcher chính thức. Không chạy bản helper cũ không có khóa sau khi adopt.

Dừng đúng đường legacy trước một lần triển khai đã được duyệt:

```powershell
& .local/runtime/node-v24.20.0-win-x64/node.exe scripts/local-supervisor.mjs stop --mode legacy --apply
```

Giữ database/tệp; disable monitor trước dừng dịch vụ. Launcher chính thức dùng `STOP_LISTINGSTUDIO.cmd` hoặc `npm run stop:local`. Nếu ownership unknown hoặc lock bận, kiểm receipt/log riêng; không xóa receipt, kill PID theo tên hoặc tạo lại dịch vụ để vượt chặn.

Kiểm thử: `node --test tests/local-supervisor.test.mjs tests/onboarding-launcher.test.mjs tests/onboarding-managed-process.test.mjs tests/onboarding-release.test.mjs`. Các kiểm Node gồm thời gian giả, khóa filesystem, tiến trình con sở hữu thật và adoption trên checkout giả; không chứng minh deployment production, reboot hay vận hành 24 giờ.

Sau build trong checkout cách ly, chạy `node --test tests/onboarding-compiled-runtime.test.mjs`. Kiểm này tải toàn bộ graph dependency của worker với default exports, không dùng TSX/development conditions và không chạy vòng lặp worker hoặc query database. Nó phát hiện đường runtime trỏ nhầm sang `src/*.js`; kiểm parser riêng không thay thế kiểm graph này.
