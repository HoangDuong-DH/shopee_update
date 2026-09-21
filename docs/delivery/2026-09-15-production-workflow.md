# Workflow từ listing đã lưu tới hàng đợi production — 15/09/2026

## Phạm vi

Tiếp yêu cầu tối ưu công việc end-to-end. Luồng mới nhận **ListingDraft đã lưu đúng mapping**; không tự tạo nội dung, ảnh, SKU hoặc suy ngành để vượt quyền. Production vẫn giới hạn app 2010476/shop 1423724897. Không phải nghiệm thu mọi ngành, nhiều shop thật hoặc chạy 24 giờ.

## Hành vi mới

1. Trang Đăng hàng mặc định mở **Đợt đang làm**. Tab **Chuẩn bị lô mới** chọn tối đa 80 listing đã lưu, giữ nguyên Word/ảnh/phân loại và dòng giá nguồn. Chuyển tab không làm mất lựa chọn; sau khi lưu lô vẫn ở lại để đăng và theo dõi cùng luồng. Bổ sung tồn rõ ràng (kể cả 0) và các thông tin vận hành còn thiếu. Thiếu thông tin ở một listing được ghi thành ngoại lệ, không làm mất kết quả của các listing còn lại.
2. Đọc metadata theo shop/ngành từ OpenAPI: tên ngành, danh sách thương hiệu có phân trang, thuộc tính, vận chuyển, giới hạn. Danh sách ngành không tự chứng minh shop đã được duyệt ngành đó. Không tự đăng ký ngành/thương hiệu.
3. Server kiểm byte ảnh và giá tới ô workbook gốc. Dữ kiện đã xác nhận không được thay bằng lựa chọn mới trong form; cần một phiên bản nguồn riêng. Các trường chưa có codec được giữ thành lỗi, không âm thầm bỏ.
4. Bản xem trước lưu bền trong PostgreSQL và file riêng có hash. Đăng ký thành nhóm tối đa 4 listing theo hợp đồng writer hiện có; một công việc cha chạy tuần tự các nhóm, nhân viên không phải bấm từng nhóm. Có thể chọn tới 80 nguồn (20 nhóm). Khi một nhóm chưa completed (kể cả rejected/unknown), công việc cha dừng để xử lý; không tự bỏ qua hoặc tự tiếp tục sau khi chấp nhận cân nặng.
5. Mỗi listing vẫn đi qua journal API, tạo UNLIST, đọc lại và QC trước khi bật bán. ACK không có nghĩa đã đạt QC. Mất phản hồi hoặc lệch dữ liệu cần đối chiếu, không tự phát lại POST.
6. UI có phần xử lý cân nặng làm tròn: chỉ đưa nút chấp nhận khi hai lần đọc mới đủ điều kiện và không có lệch trường khác. Bấm chấp nhận chỉ lưu quyết định local có hạn, không tự đăng. Không áp chấp nhận của listing/lô khác.

## Tối ưu đã làm

- Phiên đọc metadata có thời hạn, theo đúng connection revision, query và manifest. Tái dùng bằng chứng gốc, không đổi ngày đọc. Shop, giới hạn, trạng thái sản phẩm/kho vẫn đọc mới.
- Đọc lại sản phẩm đã tạo bằng journal đúng operation/item; không quét toàn bộ shop để tìm lại. Lần tạo mới vẫn kiểm trùng trừ khi có quyết định cho phép trùng đúng bộ đã được ghi nhận.
- Giữ mức điều phối nội bộ 2 GET/giây; đây không phải tuyên bố quota Shopee. Đổi cách tính khoảng cách request để tránh chờ thừa sau mỗi phản hồi.
- Trang trạng thái đọc manifest bất biến, không băm lại toàn bộ ảnh mỗi lần cập nhật. Trước thao tác thực thi vẫn kiểm lại byte nguồn.
- Ánh xạ kho phải có biên nhận verified và quan sát mới trên sản phẩm tham chiếu; không mặc định VNZ/null. Bằng chứng mapping được giữ trong snapshot chuẩn bị.
- Mutex chuẩn bị dùng cùng connection cho truy vấn, có kiểm pool một connection. Hàng đợi production giữ khóa dài cho coordinator/child; cần pool tối thiểu 4, cấu hình local mặc định 10. Không gọi đây là hệ thống worker đa máy/soak 24h.

## Bằng chứng phân biệt rõ

- Acceptance nguồn thật tại máy: 80 DOCX + 240 PNG + 1 Excel → 80 ListingDraft/160 SKU/3 ngành **fixture** → 20 manifest; 25,583 giây (nhập/lưu 10,489; chuyển/đóng gói 8,784; kiểm/đăng ký receipt 5,974). Dùng compiler thật, worker và PostgreSQL; stock proof/registry fixture; **0 request Shopee**. Không bao gồm browser chọn thư mục hoặc 80 listing trên shop thật.
- Hồ sơ: `.local/production-batch-pass1-20260915/draft-source-acceptance-DZoIa6/source-preparation-acceptance.json`.
- Kiểm UI mới dùng fixture chặn mọi endpoint bên ngoài. Quyết định cân nặng production của 510 chưa được tự chấp nhận.
- Kiểm tổng kết thúc **11:35:15.636Z (18:35 UTC+7): 1751/1751 unit/integration, 93 file, 0 skip; 7/7 legacy; typecheck, TypeScript build và web build đạt**. Bản riêng tại `.local/production-workflow-20260915/verification-1751.json` và `test-results-1751.json`.
- Sau chỉnh tab và responsive cuối: **17/17 browser fixture (12 batch + 5 preparation)** đạt, không skip/flaky, gồm giữ tồn 37/lựa chọn khi đổi tab và mở review tại chiều rộng 674px. Lỗi cột tên listing bị ép còn 74px được tái hiện rồi sửa cách xếp theo chiều rộng card; kiểm không tràn và chữ/nút còn đủ chỗ đọc. Báo cáo chính thức `.local/production-workflow-20260915/ui-responsive-results.json`, bắt đầu **11:50:40.194Z**, mất **35.745 giây**. Typecheck/TypeScript build/web build kiểm lại đạt đến **11:51:17.078Z**, file `responsive-build-results.json`. Không dùng `.local/e2e-results.json` cũ ngày 12/09 để chứng minh lượt này.
- Đo GET OpenAPI thật trên bộ **775**: lần đầu **48 request / 25,770 giây**; lần kế tiếp cùng phiên **4 request mới + 44 kết quả tái dùng / 3,241 giây**. Bằng chứng `.local/production-workflow-20260915/read-performance-1789471776770.json`. Nguồn này có quyết định cho phép trùng riêng nên không quét inventory; không áp số đo cho mọi listing/shop hoặc tốc độ đăng.
- HTTP metadata thật trả 1.821 ngành lá, 31 kênh và mapping kho có proof đúng shop/sản phẩm tham chiếu, 6 GET. `.local/production-workflow-20260915/live-metadata.json`. Metadata trả về không thay cho xác nhận ngành được shop đăng hoặc mọi kênh phù hợp kiện hàng.
- HTTP đối chiếu 510 mới, request `6eedf181-43c0-4b67-a097-229b4d0afa3c`, kết thúc **11:34:03.505Z**, vẫn `READBACK_MISMATCH`. GET review trả `eligible=true`, `approved=false`, ba nhóm cân nặng mỗi nhóm 16 SKU; file `live-weight-review.json`. Chỉ đọc, không tự chấp nhận hoặc gửi lại.
- Hash **13 bảng được bảo vệ** trước/sau bằng nhau, gồm nguồn/công việc/biên nhận sản phẩm/kết nối: `.local/production-workflow-20260915/before.json`, `after.json`. Lượt cải tiến này không ghi Shopee; migration 025 thêm bảng local, các nhật ký kiểm đọc lưu riêng.

## Lô thực tế đang giữ

510/item 53267854751 đã tạo UNLIST, 48 SKU, 28/28 bước ACK. Còn quyết định mức cân nặng làm tròn riêng PASS1; không gửi lại create/init. 775 chưa gửi. 777 và 772 giữ riêng vì size chart theo ngành còn thiếu. Giữ đúng các quyết định ảnh/tiêu đề/giá/tồn người dùng đã chốt. Hai listing thử trước 51467852283 và 51267858328 đã verified NORMAL; không phát lại.

## Giới hạn cần giữ trong thông điệp sản phẩm

“Chọn 80 listing đã lưu” không có nghĩa mọi thư mục thô đã tự nhận đúng SKU/ảnh. Kho catalog 604 dòng chưa đồng nghĩa 604 bộ có đủ asset, giá, mapping và thông tin ngành. Kết quả chuẩn bị nhanh không phải tốc độ đăng Shopee. Thuộc tính thiếu bằng chứng, ngành hạn chế, size chart/video/compliance chưa hỗ trợ phải thể hiện thành ngoại lệ. Các cập nhật từng nhóm trường vẫn cần nghiệm thu production riêng; không suy từ create sang mọi patch.

## Các điểm vào

- `GET /v1/production-preparations/context`, `GET /metadata`
- `POST /v1/production-preparations/preview`, `GET /:id`
- `POST /v1/production-preparations/:id/register`
- `POST /v1/production-preparations/:id/run`, `GET /:id/execution`
- `GET /v1/production-batches/:id/review`, `POST /:id/review/approve`

Migration 025 thêm preparation và parent execution, không thay đổi các run/source cũ. File bằng chứng riêng giữ trong `.local`, không commit khóa/token/nguồn riêng.

## Vận hành tại checkpoint

API PID30404/cổng4310, UI PID23320/cổng5173; `/health/ready` và giao diện Đăng hàng đã kiểm sau khởi động lại. Khi restart cần kiểm cổng/job trước, dùng `PRODUCTION_PILOT_ENABLED=1` và `TSX_TSCONFIG_PATH=C:/shopee_product_uploader/apps/api/tsconfig.json`, giữ cửa sổ ẩn. Token revision2 hết hạn 12:38:54.454Z; đây là hạn tại lần đọc, không chứng minh token còn hợp lệ ở phiên sau. Refresh thật đã có công cụ backend, chưa có lịch tự refresh 24h.

Coordinator phục hồi sau crash chỉ cho đối chiếu đọc toàn lô trước khi tiếp tục; lịch sử request và trạng thái chưa rõ giữ nguyên. Công việc cha có tiến độ và tiếp tục có điều kiện, không phải consumer đa máy cho mọi task cũ. App chính tại checkpoint có 1 ListingDraft (Lamy), 2 bảng giá, 0 preparation mới; PASS1 được nạp qua manifest riêng. Không nạp 80 mock vào kho chính để che khoảng trống nguồn.
