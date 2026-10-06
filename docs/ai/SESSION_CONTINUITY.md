# Tiếp nối công việc với context gọn

Mỗi phiên bắt đầu từ **AGENTS → bản đồ → contract → chức năng đang làm → checkpoint đúng task**. Không cần đọc mọi lịch sử. Những tệp lớn chỉ được tham chiếu; agent tìm đúng hàm, bảng, test hoặc biên nhận khi công việc cần.

## Dùng thường ngày

```powershell
npm run session:status
npm run session:brief -- --feature shop-connections
npm run session:brief -- --task ten-cong-viec
npm run session:brief -- --feature session-continuity --runtime
npm run session:changes -- --since-revision 4
npm run session:verify -- --task ten-cong-viec
npm run session:history -- --task ten-cong-viec --limit 3
```

Nếu npm/Node trong PATH khác bản đã ghim, dùng Node portable của checkout với `scripts/session-context.mjs` và subcommand tương ứng. Lệnh không cần app, Docker hay DB để đọc context. Bản clone chưa cài dependencies có hướng dẫn tối thiểu; không báo giả rằng đã khôi phục trạng thái. `--runtime` chỉ GET `/v1/status` tại API loopback cổng 4310; nếu app dùng cổng khác thì phần này báo chưa biết, không tự tìm mọi API/shop.

Mỗi yêu cầu: đọc status ngắn. Nếu là phiên mới, sau compaction, đổi chức năng hoặc tài liệu/bằng chứng đã đổi, đọc brief. Nếu vẫn cùng chức năng và còn giữ brief gần nhất, đọc changes từ revision đã đọc; changes luôn kiểm độ mới của code/bằng chứng. Đọc hết các trang hasMore trước kết luận. Không nạp lại cùng tài liệu dài hoặc đổ toàn bộ payload vào chat.

Trước nghỉ/chuyển phiên: ghi mục tiêu, scope, quyết định người dùng, kết quả đã kiểm, câu hỏi còn mở, bước tiếp và phần không được phát lại. Sau một phản hồi có side effect, lưu tham chiếu biên nhận thật trước khi chuyển sang việc khác. Khi nền tảng compaction bất chợt, checkpoint gần nhất giúp tiếp nối; những việc chưa được ghi không thể bảo đảm tự nhớ.

## Lưu checkpoint

Viết JSON riêng trong `.local/` rồi dùng revision hiện tại từ status:

```json
{
  "id": "ket-noi-shop",
  "title": "Kiểm tra kết nối shop",
  "featureIds": ["shop-connections"],
  "status": "active",
  "goal": "Xác minh shop người dùng vừa cấp quyền",
  "scope": { "description": "Chỉ kiểm tra kết nối; chưa giao đăng sản phẩm" },
  "decisions": ["Người dùng chỉ giao kiểm tra kết nối"],
  "observations": ["Chưa đọc trạng thái mới nhất"],
  "openQuestions": [],
  "nextSteps": ["Đọc kết quả lưu và đúng shop ID"],
  "doNotReplay": ["Không tự chạy batch cũ"],
  "evidence": []
}
```

```powershell
npm run session:checkpoint -- --input .local/checkpoint.json --expected-revision 0
```

Đây là ví dụ, không chạy để ghi đè task thật. Schema có giới hạn chuỗi/mảng, từ chối trường ngoài hợp đồng, đường dẫn ngoài repo, liên kết và credential rõ dạng. Không ghi token, key, mật khẩu hoặc callback code/state vào checkpoint. Bộ lọc chỉ giảm rủi ro, không thay thế kiểm tra nội dung của người lưu.

Quyết định và `doNotReplay` cũ được giữ khi ghi tiếp. Câu hỏi chỉ gỡ bằng `resolvedQuestions` chứa đúng câu cũ. Chuyển task paused/needs_input sang active cần `resumeDecision` ghi chỉ dẫn tiếp tục của người dùng; trường này không cấp quyền thực thi cho backend. Done cần ít nhất một bằng chứng và không còn câu hỏi mở. Hash tệp không tự xác minh nội dung đúng: người ghi phải dùng biên nhận phù hợp.

## Dung lượng và độ mới

Mặc định brief tối đa **32 KiB UTF-8**, có thể chọn `--max-bytes` từ 4096 đến 131072. Đây là giới hạn đầu ra, không phải phép đo token trong Codex. Không có ngưỡng token chung bảo đảm mô hình luôn chính xác. Nếu quá giới hạn, lệnh dừng có mã lỗi; chọn đúng `--task`/feature hoặc rút gọn nội dung, không cắt âm thầm quyết định.

Registry mở rộng tại `docs/context/features.json`, kiểm ID, dependency, cycle và tệp tồn tại. Brief ưu tiên đúng task đang tập trung; nếu chọn chức năng khác, chỉ lấy các việc còn mở hoặc một việc hoàn tất gần nhất. Các task chưa nạp vẫn có tên/trạng thái trong index; task tạm dừng luôn xuất hiện cùng scope/doNotReplay. Có thể truy đúng task/history mà không nạp lại mọi lô đã hoàn tất.

Fingerprint chức năng lấy byte tài liệu chung, registry, tài liệu chức năng và các code entry points được khai báo. Dấu kiểm working tree bổ sung phát hiện tệp public đã sửa/chưa commit (kể cả staged/đổi tên) ngoài entrypoints theo ignore rules của checkout, không phụ thuộc file Git ignore riêng của máy; Git HEAD phát hiện phiên bản commit đổi. Chúng không nạp nội dung code vào chat. Thiếu Git, metadata cũ chưa có dấu kiểm hoặc vượt giới hạn đọc thì báo `not_recorded`, không giả là code mới nhất. Bằng chứng báo riêng matches/changed/missing/unreadable. Khi mở rộng chức năng cần cập nhật manifest; dấu kiểm không xác định thay agent mọi dependency hoặc chứng minh dữ liệu đúng nguồn.

## Lưu trữ và phục hồi

`.local/session-context/state.json` là projection gọn. `journal/` chứa sự kiện thay đổi bất biến theo revision; một sự kiện lưu task thay đổi, không chép tất cả task hoặc payload Shopee. Checkpoint dùng khóa và expected revision, đồng bộ tệp trước thay current bằng rename. Sự kiện mới có digest kiểm hư hỏng khi đọc current/history/delta; projection cuối được đối chiếu với task trong sự kiện. Journal cũ chưa có digest vẫn đọc được với `integrity: not_recorded`, không sửa lại byte lịch sử. Digest không phải chữ ký bảo mật hay bằng chứng dữ liệu đúng. Không ghi DB nghiệp vụ hoặc thay đổi migrations.

- `REVISION_CONFLICT`: đọc trạng thái mới, đối chiếu thay đổi, viết patch phù hợp. Không sửa số revision để thắng xung đột.
- `RECOVERY_REQUIRED`: một sự kiện đã ghi nhưng current chưa thay. Chạy `recover --expected-revision N` sau đối chiếu; công cụ kiểm digest trước hoàn tất local checkpoint, không phát lại Shopee.
- `LOCKED`: kiểm PID chủ khóa. `unlock --expected-owner-pid N` chỉ bỏ khóa khi PID đó đã chết; nếu không xác định được thì giữ khóa, không tự hết hạn theo thời gian.
- `JOURNAL_MISMATCH`/JSON sai: giữ tệp để điều tra hoặc khôi phục từ bản sao đáng tin; không tự reset thành phiên trắng.

Store giữ tối đa 64 task và mảng có giới hạn; khi đầy phải tổ chức/bàn giao kho riêng có dấu kiểm, không tự bỏ lịch sử. Journal giữ lâu trên đĩa nhưng không tự nạp vào chat. CLI này không phải ứng dụng multi-user/server distributed; khóa/revision phục vụ nhiều phiên local trên cùng checkout.

## Chuyển máy và giới hạn

Git/public release chỉ chứa code, registry và hướng dẫn, không chứa checkpoint/receipts. Dùng `session:export`, `session:verify-bundle` và `session:import` theo [hướng dẫn chuyển context](../onboarding/SESSION_CONTEXT_TRANSFER.md); import mặc định chỉ xem kế hoạch, `--apply` mới chép tệp private đã kiểm, không ghi đè nội dung khác. Nếu bàn giao công việc, chuyển riêng `.local/session-context` cùng đúng bằng chứng và dữ liệu nghiệp vụ theo quy trình private transfer; verify lại trên máy nhận. Thiếu tệp vẫn báo thiếu, không lấy Git làm quyền gửi lại.

Repo không can thiệp cửa sổ context, xóa lịch sử chat hoặc cài hook cho mọi tin nhắn của nền tảng. AGENTS và CLI tạo quy trình có thể lặp/kiểm; agent cần tuân thủ. Không hứa tuyệt đối không quên, không tự xác minh trạng thái shop bằng checkpoint, không tự kết nối/gia hạn hoặc resume công việc. Bảo vệ quyền ghi và source contract hiện tại vẫn là chốt bắt buộc.
