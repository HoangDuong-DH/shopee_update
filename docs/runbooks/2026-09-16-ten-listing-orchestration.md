# Điều phối 10 listing mới VINA TƯƠI — 16/09/2026

Phạm vi: xịt thơm Trà Trắng, Sả Chanh, Phong Lữ, Rừng Thông, Oải Hương, Sả Java, Hương Thảo, Hoa Hồng, Hoa Lài và Cam Sả; mỗi listing ba SKU theo bộ nguồn đã chọn. Shop **1423724897 / partner2010476**, giá gốc **DORIS SHOP MALL**, tồn100/SKU, kiện12×12×28cm theo xác nhận thử nghiệm. Giữ cân nguồn130.9/322.3/503.8g. Chỉ dùng phiên bản nội dung100% đã được xác nhận, giữ cảnh báo; gallery gồm chín ảnh đầu nguyên bản, cho phép ảnh dùng chung; bìa Sả Java đổi vai trò sang ảnh vuông `21.png` đã được chấp thuận. Không sửa hình gốc.

Phiếu xác nhận chỉ áp dụng mười source identity trong `selected-10-source.json`. Cho phép SKU đã tồn tại trong phạm vi thử mười nguồn mới này; không phải quyền gửi lại operation, đổi nguồn hoặc bỏ kiểm metadata/QC. **Không động tới bốn listing đã published** (can5L51467852283, Ngọc Lan Tây51267858328, xịt thơm ô tô53267854751, xịt khử mùi thảm45467915350), hoặc hai nguồn tủ giày/giày da nam đang held.

Checkpoint chuẩn bị: assembler đã nhập10nháp/30SKU local, revision1; gói nguồn SHA`6a9c23d76531e24d46749d2fd7979cf072f224c1513ff8facacc40ba1dcd3b18`. Helper đã bind receipt thật vào `.local/vina-input-preparation-20260916/orchestration/a9b09646-bc43-4dc2-8c5f-53cd66f224d0/`; tại checkpoint này mới có `binding.json` và `preview.request.json`, chưa có kết quả preview/register hoặc Shopee. Phiếu mới `authorization-4895c26f57260d65.json`, SHA`8678cb4cdfbdcba0c1906c8682a0e62a223ff3a9c9ce21b9f6a49eacee604b97`, tham chiếu quyết định đã chốt SHA`d61f7242460c378460a0baf0061a0360a0d5791814c6844b1022741cf651ad8f`.

Kiểm độc lập phiếu mới 66/66 và binding thật 110/110 đạt; báo cáo tại `source-index/preflight/authorization-independent-audit.json` và `bound-ten-independent-audit.json`. Kiểm tổng mã app đã chốt hoàn tất 03:58:19.128 UTC: 1857/1857 unit/integration + 7/7 legacy, 0 skip, typecheck/TS build/web build đạt; lưu riêng ở `orchestration/verification-frozen-final.json`, `test-results-frozen-final.json`, `full-verify-frozen.log`. Không cộng 7 kiểm thử helper hoặc 5 browser KB thành số test của lượt tổng này; các kết quả đều tách khỏi biên nhận đăng thật.

## Helper chỉ tạo hồ sơ tại máy

`.local/vina-input-preparation-20260916/prepare-ten-orchestration.mts` không có HTTP client, DB client hoặc writer. Nó đọc tệp, kiểm scope/hash rồi sinh JSON yêu cầu cho root thực hiện riêng. Không có mã operation/item/biên nhận API giả. Bảy kiểm thử local đã đạt; kết quả tại `orchestration/helper-tests.log`.

```powershell
$tenNode = '.local/runtime/node-v24.20.0-win-x64/node.exe'
$tenHelper = '.local/vina-input-preparation-20260916/prepare-ten-orchestration.mts'
& $tenNode --conditions=development --import tsx $tenHelper decisions
```

Mỗi phiên bản quyết định sinh một `orchestration/authorization-<hash>.json` bất biến. Phiếu ghi đúng mười source key/product identity và30SKU, hash selection, quyết định, workbook và giới hạn. Chưa nhập nháp thì chưa có revision thực. Khi tệp quyết định thay đổi, giữ phiếu cũ và tạo phiếu mới; audit hash mới trước khi bind. Phiếu đầu `authorization-bf815deb17617d48.json` đã bị phát hiện tham chiếu quyết định cũ sau khi câu trích dẫn được sửa; **không dùng nó làm phiếu cuối**.

## Tạo preview và ba nhóm4–4–2

1. Assembler hoàn tất mười bộ ảnh thật và compiler; không lấy đủ mười bằng cách bỏ issue. Importer local riêng lưu nguồn, sinh `app-source-package/local-import-receipt.json` và `preparation-entries.json`. Đây là nhập nháp tại máy, chưa đăng. Helper không chạy importer.
2. Kiểm lựa chọn mới: chín listing ngành101127, Cam Sả102572; brand1252097 VINA TƯƠI có bằng chứng đúng ngành; NEW/non-preorder, kênh/kho có chứng cứ; không áp tên công ty/địa chỉ/hạn dùng của xịt khử mùi thảm sang mười sản phẩm mới.
3. Bind sau khi thực sự nhập:

```powershell
& $tenNode --conditions=development --import tsx $tenHelper bind
```

Helper yêu cầu đủ mười nguồn `source_ready`, receipt nhập đúng hash gói, đúng productKey/revision/SKU, import giá thật, giá trị tồn và lựa chọn đã chốt. ID import offline bị chặn. Nó thêm `existingListingAuthorization` riêng từng entry, trỏ phiếu xác nhận/hash và exact productKey+revision, rồi sinh `binding.json` cùng `preview.request.json`. Thứ tự giữ theo selection; không lấy các batch cũ từ danh sách toàn shop. Đặt `$boundDirectory` bằng đường dẫn thực mà helper vừa in, không tự tạo ID/fingerprint.

Các bước HTTP dưới đây **chỉ root thực hiện**, sử dụng JSON vừa được kiểm. Hàm tiện ích không tự gọi; mỗi lần gọi phải chỉ định đúng tệp yêu cầu và nơi giữ phản hồi:

```powershell
$tenHeaders = @{ Origin='http://127.0.0.1:5173'; 'X-App-Client'='internal-workspace' }
function Send-TenRequest([string]$requestPath, [string]$responsePath) {
  $request = Get-Content -Raw -LiteralPath $requestPath | ConvertFrom-Json
  $response = Invoke-RestMethod -Uri ('http://127.0.0.1:4310'+$request.route) -Method $request.method -Headers $tenHeaders -ContentType 'application/json' -Body ($request.body | ConvertTo-Json -Depth 100)
  $response | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $responsePath -Encoding utf8
  return $response
}
$preview = Send-TenRequest "$boundDirectory/preview.request.json" "$boundDirectory/http-preview.json"
& $tenNode --conditions=development --import tsx $tenHelper preview $boundDirectory "$boundDirectory/http-preview.json"
$registered = Send-TenRequest "$boundDirectory/register.request.json" "$boundDirectory/http-register.json"
& $tenNode --conditions=development --import tsx $tenHelper registered $boundDirectory "$boundDirectory/http-register.json"
```

`preview` POST chỉ chuẩn bị local và đọc metadata; `register` POST tạo manifest/registry local, không ghi Shopee. Helper kiểm **ready10/blocked0**, đúng tên, thứ tự/tầng/SKU/giá/tồn/cân nguồn, bìa vuông/gallery9/plain text và scope xác nhận. Sau register, nó đọc/hash ba manifest thật dưới vùng preparation của service, kiểm đúng **4/4/2**, từng source identity/revision và document từ preview. Chưa sinh yêu cầu chạy production ở bước này.

Quan sát thật lần preview đầu: request bắt đầu ghi `decision.json` lúc03:51:48UTC; các snapshot/ảnh tiếp tục được ghi đến03:53:20; DB preparation lưu lúc03:53:21.163. Client hết thời gian60giây và một GET sớm trả404, nhưng request server vẫn chạy. Root đã **không gửi lại**; GET sau trả10ready/0blocked, lưu `preview.get.json`. Đối chiếu độc lập03:54:26 không có PID bị chặn hoặc khóa preparation giữ lâu, API error log trống. Tệp phản hồi rỗng do timeout không được tính là proof. Cần cải tiến sau: preview durable async có tiến độ/tác vụ rõ ràng. Hiện dùng GET cùng preparation ID để phục hồi; chưa có dòng DB trong giai đoạn build không đủ chứng minh request đã thất bại. Không restart hoặc tạo nguồn/preparation trùng khi công việc vẫn tiến triển.

## Kiểm đọc trước lần gửi đầu

Với từng batch ID **chỉ lấy từ registration mới**, GET `/v1/production-batches/:batchId`, lưu phản hồi vào tệp rồi:

```powershell
& $tenNode --conditions=development --import tsx $tenHelper status $boundDirectory '<actual-batch-status.json>'
```

Helper sinh `statuses/<statusFingerprint>/inspect.request.json` nếu batch không bận. Gửi yêu cầu đó bằng `Send-TenRequest`, sau đó GET trạng thái đến khi `busy=false`. Lượt inspect gọi Shopee GET và lưu biên nhận local; không upload/create/init/publish. Thực hiện tuần tự cho cả ba nhóm. Cần `lastResult.mode=inspect`, `stopped=false`, đúng4/4/2 nguồn đều `inspected` và các listing vẫn `not_sent`. Nếu một nhóm bị chặn, giữ biên nhận và xử lý đúng nguyên nhân trước khi chạy.

Lưu mảng ba phản hồi GET cuối thành một tệp rồi:

```powershell
& $tenNode --conditions=development --import tsx $tenHelper ready $boundDirectory '<three-current-batch-statuses.json>'
```

Bước này chặn inspection cũ quá15phút, scope lẫn, operation đã có hoặc nhóm chưa đạt. Metadata vẫn được server đọc/kiểm lại tại lần thực thi; tuổi inspection không thay thế thời hạn của từng bằng chứng. Chỉ lúc đạt mới có `run.request.json`.

## Thực thi và phục hồi cùng công việc

**Lệnh tiếp theo bắt đầu ghi production** trong phạm vi người dùng đã cho phép. Không cần xin lại quyền đã có; vẫn phải dùng các hồ sơ thật đạt kiểm tra ở trên:

```powershell
$run = Send-TenRequest "$boundDirectory/run.request.json" "$boundDirectory/http-parent-run.json"
```

Parent endpoint `POST /v1/production-preparations/:id/run` dùng `{expectedFingerprint}`. GET `/v1/production-preparations/:id/execution` theo dõi nhóm hiện tại; GET batch hiện tại để xem từng tên sản phẩm. Parent dừng khi một nhóm chưa hoàn tất, chưa gửi nhóm sau. Một request được nhận, step ACK hay sản phẩm có item ID chưa phải đã đối chiếu đạt.

Nếu mất phản hồi, **GET cùng preparation/execution/batch**, không tạo preparation khác, không sửa manifest hoặc gọi lại upload/create/init. Khi tiến trình bị ngắt, trạng thái có thể yêu cầu reconcile. Đưa GET batch mới vào helper `status`; gửi `reconcile.request.json` được sinh với fingerprint mới. Không giới hạn sourceKey khi phục hồi orphan toàn batch. Reconcile bỏ qua nguồn chưa gửi, chỉ đọc lại operation có đủ ACK và publication đã nhận; không tạo/mở bán mới. `unknown`, `sent` hoặc `rejected` thiếu proof vẫn bị chặn: không sửa DB/xóa history để đi tiếp.

Sau khi xử lý QC, GET trạng thái để xác nhận không còn bận/orphan, rồi gửi lại **cùng parent `run.request.json`**. Parent kiểm trạng thái durable của từng nhóm và bỏ qua phần đã published; không dựa riêng vào bộ đếm cũ. Có thể tiếp tục dùng body/fingerprint parent cũ vì preparation bất biến; fingerprint trạng thái child phải lấy mới mỗi lần.

## QC bìa và cân nặng sau khi có item thật

### Đọc nhanh và lấy ảnh đúng case

Helper riêng `orchestration/read-ten-status.mts` **chỉ gọi GET tới localhost**, cố định parent và ba group mới từ registration; không import, approve, execute hoặc ghi DB. Không có vòng đợi dài. Chạy một lượt mỗi khi cần cập nhật:

```powershell
& $tenNode --conditions=development --import tsx '.local/vina-input-preparation-20260916/orchestration/read-ten-status.mts' poll
& $tenNode --conditions=development --import tsx '.local/vina-input-preparation-20260916/orchestration/read-ten-status.mts' snapshot
```

`poll` lưu một lượt parent + ba trạng thái nhóm. `snapshot` chọn một listing đã có operation/item nhưng chưa published, tìm case mới nhất chưa hết hạn đúng shop/operation/item/sourceAssetId/hash bìa/role/position, rồi lấy case và hai ảnh từ API local. Lưu `orchestration/cover-qc/<caseId>/case.json`, `source.png`, `output.jpg`; nếu định dạng thực khác thì giữ byte và dùng đúng phần mở rộng, không chuyển ảnh. Mỗi ảnh được kiểm hash, MIME và metadata thực; các phiên bản case có tệp hash riêng để giữ lịch sử. Helper **không xem hình thay reviewer và không tự tạo phiếu chấp nhận ảnh**.

Kết quả machine-readable luôn in ra stdout và ghi vào `orchestration/status.summary.json`; mục `selected` có tên sản phẩm/operation/item, `coverCase.images` có đường dẫn ảnh. Hồ sơ GET nguyên theo lượt nằm tại `status-snapshots/<timestamp-id>/`. Đây là con trỏ tới lần đọc cuối, không phải dữ liệu tự cập nhật liên tục.

Mode `requests` cũng chỉ GET; có thể sinh JSON reconcile từ trạng thái được server cho phép, weight-approve chỉ khi review thực `eligible=true`, chưa approved, chưa hết hạn và đúng ba mapping SKU130.9→131/322.3→322/503.8→504g. Parent-run chỉ được sinh khi parent paused, các group không busy/orphan/held và không còn create-readback hoặc unknown chưa giải quyết. Nó **không gửi các JSON này**, không sinh quyết định manual-review bìa. Root kiểm trạng thái/bằng chứng rồi gửi riêng; server tiếp tục kiểm fingerprint tại ranh giới gửi.

Checkpoint thật: khoảng04:01UTC parent dừng tại bìa listing đầu. Lần snapshot **04:12:37UTC**: Trà Trắng đã published1/10; Sả Chanh item50117892152, operation3ecb979b-619d-491f-a07e-4deea348c8ca đang `created_readback_pending`, casec718c145-cb73-4bfa-836a-35a8ffdc768b `review_required`. Đã lấy source PNG/output JPEG1024×1024 đúng hash, chưa review bằng helper. Các số1857 kiểm thử xanh không có nghĩa mười listing đã published.

Shopee có thể đổi ID/bytes bìa PNG→JPEG. Runner tự tạo case QC từ ảnh nguồn đúng hash và ảnh URL đọc từ API, gắn operation/item/outputImageId. Không coi đổi ID là bằng chứng ảnh giống nhau hoặc đổi source để ép khớp.

1. GET `/v1/image-qc`, chọn case đúng operation mới trong batch này; GET `/v1/image-qc/:id` và hai ảnh `/v1/image-qc/:id/image/source`, `/output`. Thực sự xem ảnh gốc/ảnh Shopee, kiểm sản phẩm, chữ, bố cục, vùng cắt, tỷ lệ. Riêng Sả Java phải đúng bìa21.png đã được chọn, không phải ảnh tổng16hương cũ.
2. Chỉ khi case `review_required` và đã kiểm hình đạt, dùng HTTP `POST /v1/image-qc/:id/review` với **binding và fingerprint từ case hiện tại**, requestId UUID giữ nguyên nếu mất phản hồi, `decision:"accept_lossy_match"`, `reviewer:"Codex QA (agent)"`, note mô tả kiểm thực tế. Đây là review của agent, không ghi là người dùng vừa duyệt ảnh chuyển đổi. Nếu ảnh khác nội dung thì giữ mismatch; không nhận bừa. Không dựng sẵn review có quyết định trước khi thấy ảnh.
3. Chạy read-only reconcile để có hai lần đọc mới. GET `/v1/production-batches/:batchId/review?sourceKey=<URL-encoded-exact-sourceKey>`. Weight review chỉ đủ điều kiện khi hai raw read ổn định/mới, đúng model/SKU, bìa đã đạt và mọi trường khác khớp. Mapping dự kiến cần đối chiếu thật: **130.9→131g,322.3→322g,503.8→504g**; không chấp nhận số khác chỉ vì gần nhau.
4. Khi scope ba SKU và mapping đúng quyết định thử nghiệm, lưu phản hồi rồi `POST /v1/production-batches/:batchId/review/approve` với `{sourceKey,expectedReviewFingerprint}` lấy từ phản hồi thật. Endpoint ghi phiếu local24giờ, không sửa cân nguồn hay Shopee và không tự tiếp tục parent. `eligible=false` phải đọc lý do; không gửi body giả. Nếu `approved=true`, không tạo phiếu trùng. Không sao phiếu cân của xịt thảm/ô tô/Ngọc Lan Tây sang operation mới.
5. Sau phiếu, reconcile/GET đúng batch rồi resume parent. Nguồn đã tạo được đọc lại, không tạo lại. Mở bán chỉ diễn ra khi create verified và metadata quyền/stock còn hợp lệ.

## Kết thúc và điểm còn phải kiểm trước khi gửi

Chỉ tính hoàn tất khi parent `completed`, ba batch `completed`, **10/10 published**, mỗi listing có create và publication verified, item NORMAL, đúng ba SKU ở hai readback ổn định. Kiểm độc lập raw với manifest cho tên/mô tả, gallery/bìa, thứ tự phân loại,30SKU-instance, giá gốc/tồn100, ngành/brand, thuộc tính được chọn, cân/kiện và logistics; QC bìa/cân phải ghi riêng basis. Không dùng UI số đếm thay readback. Đối chiếu nhật ký bốn listing published cũ và hai held giữ nguyên; nguồn nguyên bản không đổi.

Những điều không được coi là đã xong chỉ từ helper: ảnh Cam Sả/phần ảnh chưa review; compiler còn issue; brand/ngành/stock metadata hết hạn; quyền ảnh mô tả (đợt này dùng plain text); token hết hạn; phản hồi create không rõ; QC cover/rounding chưa có readback. Token revision3 từng có hạn05:38:40.316UTC — phải đọc trạng thái kết nối hiện tại, không coi mốc này là còn hiệu lực mãi hoặc replay lần refresh cũ. Nếu cần refresh đã được ủy quyền, dùng luồng refresh hiện có và bằng chứng revision mới rồi đọc lại metadata; không in token.

Tệp nguồn và các helper nằm trong `.local`, không commit. Runbook ghi quy trình và phạm vi đã được giao; **không khẳng định mười listing đã được gửi**. Toàn bộ helper chỉ tạo tệp local, không chạy importer hoặc gọi endpoint trong lượt chuẩn bị này.
