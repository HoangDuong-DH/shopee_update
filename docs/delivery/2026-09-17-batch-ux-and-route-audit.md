# Luồng đăng theo đợt và liên kết giao diện – backend, 17/09/2026

## Phạm vi

Người dùng yêu cầu làm lại Đăng theo đợt, chỉ rõ phần thiếu sau kiểm tra, rà các routes/backend và liên kết frontend–backend; áp dụng các nguyên tắc hiển thị trạng thái, ngôn ngữ dễ hiểu, kiểm soát lựa chọn, ngăn lỗi và hướng dẫn phục hồi. Thực hiện trên mã local và trình duyệt local nối backend thật. Đã làm mới kết nối đã cấp quyền của đúng shop vuatinhdau.vn; không chạy lệnh đăng, mở bán hay sửa listing Shopee trong lượt này.

## Thay đổi giao diện

- Đăng theo đợt dùng danh sách bên trái và một đợt đang xem bên phải, có tìm theo tên sản phẩm/đợt/shop. Mã kỹ thuật và biên nhận nằm trong chi tiết.
- Phân biệt chưa gửi, cần đối chiếu, đang ẩn và đã mở bán. Bộ không đọc được giữ trạng thái chưa xác định; không suy ra hoàn tất từ danh sách rỗng.
- Chỉ rõ thao tác tiếp theo, chế độ đăng ẩn/mở bán và tên sản phẩm đang xử lý. Có tùy chọn ẩn sản phẩm đã mở bán khỏi danh sách đang xem.
- Chuẩn bị lô hiển thị bốn bước, thông báo đang kiểm tra/kết quả và cuộn tới kết quả. Lỗi thiếu ngành, thương hiệu, kiện hàng, kho, vận chuyển… có tên trường và nút đến đúng ô.
- Gộp thông báo trùng trong cùng mục; với lô lớn chỉ mở sẵn sản phẩm đầu tiên còn thiếu, các sản phẩm khác có số mục cần bổ sung.
- Lỗi đọc kho/nguồn có nút đọc lại và kết thúc trạng thái đang tải. Giữ lựa chọn và tồn đang nhập. Hướng dẫn dùng đúng tên tab “Đợt đang làm”.
- Kho tham khảo hỗ trợ listing đang mở bán hoặc đang ẩn, tải thêm trang và giữ lựa chọn đã đọc. Đổi listing tham khảo xóa bằng chứng kho cũ trước khi đọc lại.
- Kích thước kiện hướng dẫn số nguyên dương theo hợp đồng backend; không tự làm tròn hay thay nguồn.
- Khi mở nhanh nhiều nguồn kiến thức, kết quả cũ không ghi đè nguồn vừa chọn.
- Phần đang nhập trước khi kiểm tra được giữ trong cùng tab, ràng buộc shop và phiên bản nguồn. Đọc lại nguồn, giá và metadata khi phục hồi; không khôi phục phiếu kho, xác nhận kiến thức, quyền mở bán hoặc hoãn QC ảnh. Có nút bỏ phần nhập tạm, giữ nguồn đã lưu.
- Lỗi đọc lựa chọn của shop có nút đọc lại; giữ ô đang nhập và chỉ rõ đường Công cụ → Kết nối shop.
- Kiểm tra chéo bản nhập tạm phát hiện kênh vận chuyển bị nguồn ghi đè khi reload; đã sửa riêng lựa chọn kênh và tái hiện RED → GREEN. Không mở quyền ghi đè ngành, thương hiệu hoặc cân nặng đã xác nhận.
- Màn hình kết nối đổi nhãn cũ “SHOP THẬT / CHỈ ĐỌC” thành “SHOP THẬT / PRODUCTION”; trạng thái quyền ghi vẫn do từng luồng và backend quyết định.

## Sửa liên kết và backend

- Tách nhánh lỗi production batch khỏi nhánh chuẩn bị chung: đúng HTTP 404 cho đợt chưa đăng ký; giữ hướng dẫn đọc lại trạng thái và trạng thái chưa bật thực thi.
- Lỗi chính sách thực thi trả xung đột có hướng dẫn thay vì lỗi dịch vụ chung. Frontend giữ thông báo dịch sẵn cho các nhóm lỗi đã biết; lỗi không xác định vẫn không phơi bày nội dung thô.
- Phiếu duyệt cân nặng hết hạn theo lần đọc sớm nhất trong hai lần đọc bắt buộc, cùng tiêu chí với kiểm tra backend.
- Hướng dẫn lỗi duyệt cân nặng dùng mã lỗi, không tìm mã trong thông báo đã dịch.
- Phục hồi đợt bị gián đoạn khi đã tạo ẩn và có bằng chứng hoãn QC ảnh dùng bằng chứng riêng, không biến bằng chứng dữ liệu thành xác nhận QC ảnh. Không gửi lại lệnh đã gửi hoặc cho mở bán từ bằng chứng hoãn QC.
- Nhánh phục vụ web phân biệt đường API/kiểm tra sức khỏe không tồn tại với đường giao diện; lỗi tệp tĩnh trả 404 đúng kiểu dữ liệu.
- Bổ sung hướng dẫn cho 17 lỗi đọc dữ liệu ngành/shop thực tế. Lỗi kết nối không còn hướng người dùng tới một “kết quả” chưa tồn tại.

## Rà hợp đồng

Đối chiếu HTTP method, path, query, body, response và chốt phiên bản của: nhập tệp/đợt, lưu listing từ hồ sơ ghép sẵn hoặc bảng chờ, claim chống trùng, archive/khôi phục local, gợi ý kiến thức và xác nhận có nguồn, metadata theo ngành, kiểm tra nguồn, đăng ký đợt, bắt đầu/đọc lại/phục hồi, duyệt cân nặng và mở bán riêng.

Kiểm HTTP dùng service giả lập chỉ chứng minh route/giải mã/chuyển tham số. Kiểm service và PostgreSQL cô lập chứng minh xử lý dữ liệu/khóa/biên nhận trong phạm vi ca kiểm. Các bộ kiểm tự động trình duyệt chặn hoặc giả lập API; phần kiểm trực tiếp bên dưới dùng trình duyệt và backend đang chạy thật. Cả hai không phải bằng chứng đăng Shopee thật trong lượt này.

## Kiểm chứng

- Lượt tổng: **2.195/2.195 unit/integration, 7/7 legacy**, typecheck, TypeScript build và web build đạt. Bằng chứng `final-verification.json`, `final-test-results.json` và `full-verify-final.log` trong `.local/batch-ui-redesign-20260917/`.
- Sau lượt tổng, kiểm trình duyệt thật phát hiện thiếu hướng dẫn AUTH_REQUIRED và bổ sung phục hồi phần nhập tạm. Kiểm lại có mục tiêu: **116/116** ca API/metadata/routes và **58/58** ca trình duyệt preparation/batches; typecheck và build đạt. Không cộng các ca trùng thành một số kiểm thử lớn hơn, không gọi lượt tổng là đã chạy lại sau bổ sung này.
- 15 ca liên kết nguồn/sidecar/archive và 4 ca tránh phản hồi kiến thức cũ đã đạt riêng trước bổ sung phần nhập tạm; không phải nghiệm thu luồng Shopee thật.
- Sau sửa cuối cùng về giữ lựa chọn kênh vận chuyển: **11/11** ca recovery đạt, typecheck và build đạt lại. Đây là tập con có một ca mới; không cộng trùng với 58 ca trên. Bằng chứng `.local/e2e-artifacts/preparation-shipping-restore-final/`.
- Báo cáo machine-readable: `final-added-route-regressions.json`, `final-after-working-copy-browser.json`.

## Kiểm trực tiếp app đang chạy

Dùng tab kiểm riêng, không reload tab đang làm của người dùng. Đã quan sát:

1. Đăng theo đợt tải đúng 5 đợt hiện có từ API thật; tìm “tủ giày” hiện đúng đợt bị giữ, lý do thiếu bảng kích cỡ và không hiện thao tác đăng.
2. Chuẩn bị lô mới đọc đúng 11 listing đã lưu. Chọn Cam Sả tự lấy ba SKU, bộ giá FILE GIÁ DORIS / SHOP MALL và cân nặng nguồn; không nhập lại nguồn.
3. Trước làm mới kết nối: metadata trả 409 `PRODUCTION_PREPARATION_AUTH_REQUIRED`, UI cũ chỉ báo chung; ghi ở `live-metadata-error.json`. Đây là lỗi tìm được bằng kiểm thật và đã thêm test/sửa hướng dẫn.
4. Làm mới kết nối bằng cơ chế refresh sẵn có: revision **4 → 5**, xác minh đúng shop **1423724897**; API đọc metadata thành công với 1.821 mục ngành và 31 kênh trong phản hồi. Đây là số mục trả về, không chứng minh từng mục đều đủ điều kiện đăng cho mọi sản phẩm. Không đổi quyền ứng dụng hoặc scope shop; không dùng token trong chat/log.
5. Sau tải lại và mở lại phần chuẩn bị: Cam Sả vẫn được chọn, ô tồn chung vẫn là 100, có thông báo phục hồi và yêu cầu kiểm lại. Danh sách ngành đã có lựa chọn; chưa bấm áp dụng tồn, kiểm tra, đăng ký đợt hoặc đăng sản phẩm.
6. Backend đã nạp bản sửa. `/health/ready` đạt; đường API/health/assets không tồn tại trả JSON 404. Cuối kiểm: 5 đợt, không có đợt đang chạy. Bằng chứng `runtime-after-restart.json`, `runtime-final.json`, `live-metadata-recovered.json`.

## Đánh giá theo checklist 5–8

| Nhóm | Kết luận trong phạm vi đã kiểm | Giới hạn |
| --- | --- | --- |
| Frontend rõ và dễ dùng | Có trạng thái tải/lỗi/kết quả, thao tác tiếp theo, lỗi theo trường, phục hồi phần đang nhập; kiểm desktop/mobile bằng fixture và kiểm desktop thật | Không tuyên bố đã audit accessibility toàn bộ ứng dụng |
| Backend và data | Sửa route/error contract, chống nhầm trạng thái, giữ request/fingerprint/revision và bằng chứng phục hồi; kiểm độc lập service/coordinator | Chưa chạy lại toàn bộ 45 bộ lên Shopee thật từ UI mới |
| Linh hoạt, không quá phức tạp | Sửa cục bộ, giữ component/framework/schema hiện có; không thay thư viện lớn, không thêm migration | Refresh hiện vẫn là lệnh chủ động cho shop pilot; chưa có lịch tự làm mới hoặc luồng UI refresh chung nhiều shop |
| Multi-agent | Chia phạm vi ghi, kiểm tra chéo; một đầu mối restart server và tổng hợp E2E; đã bắt lỗi qua phản biện trước chốt | Repo thực tế đã có Git nhưng nhiều thay đổi chưa commit; không tạo worktree/branch hoặc coi các thay đổi cũ là của lượt này |

## Giới hạn còn giữ

- Luồng production hiện vẫn giới hạn shop đã cấu hình vuatinhdau.vn; kiểm thử giả lập nhiều shop không đồng nghĩa đã mở production nhiều shop.
- Luồng cập nhật listing có ID nguồn còn là nhánh riêng; không đổi một ID có sẵn thành yêu cầu tạo mới để vượt chặn.
- Không tự điền thuộc tính chưa có căn cứ, bỏ SKU/ảnh nguồn, tự hợp thức hóa trạng thái chưa rõ hoặc coi hoãn QC ảnh là ảnh đã đạt.
- Việc app đọc lại trạng thái không tự gửi thêm lệnh đăng. Người dùng tự thao tác đăng ẩn và kiểm tra trước khi mở bán.
