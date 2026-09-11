# Công việc theo shop và thử backend sandbox

Ngày **11/09/2026**. Người dùng cho phép triển khai lại luồng làm việc và tạo dữ liệu giả để kiểm thử; nguồn sản phẩm, nội dung, ảnh, SKU và phạm vi shop thật vẫn giữ theo yêu cầu đã xác nhận.

## Kết quả triển khai

Trang chính là **Công việc đăng hàng**. Nhân viên nhận thư mục listing mới hoặc chọn nhiều bộ đã lưu, chỉ rõ shop và việc đăng mới/cập nhật. Một công việc giữ bản nguồn, phạm vi, các trường cần thay và quyết định tồn riêng; không thêm SKU vào listing khác hoặc tự thay nội dung để vượt kiểm tra. Đổi shop xóa lựa chọn item/tồn của shop trước trên form.

Các ngoại lệ phân biệt thiếu dữ kiện, cần xác định ánh xạ, kết nối, tính năng chưa hỗ trợ và phiên bản xung đột. Tính năng chưa có trong ứng dụng không được trình bày như lỗi thiếu dữ liệu của nhân viên. Tạo công việc mới là ghi nội bộ, chưa phải đăng Shopee.

Hồ sơ bàn giao là lựa chọn phụ, được xuất từ bộ đã lưu, tham chiếu nguồn bất biến và đúng dòng giá. Nhập lại phải chọn bộ đích và xem khác biệt. Hồ sơ giữ cấu trúc SKU/nhãn/thứ tự, ảnh theo vai trò và nội dung; không chứa byte ảnh/Word và chỉ dùng lại nguồn đã có trên cùng máy chủ. Không yêu cầu nhân viên tự soạn JSON. Luồng thư mục và bảng giá chung vẫn là đầu vào chính.

## Backend đã nối

- Migrations **005–006** thêm công việc có lịch sử phiên bản, biên nhận bàn giao và các lần thực hiện sandbox có checkpoint.
- Đọc listing/model/giới hạn qua OpenAPI trực tiếp. Phạm vi ghi giới hạn ở Lamy sandbox đã được cho phép; trường hỗ trợ là tiêu đề, mô tả và gallery. Không có tạo mới hoặc ghi production.
- Bản gửi khóa WorkOrder ID/revision, bản nguồn, shop/item, field mask và baseline. Chuẩn bị đang chạy mà cấu hình đổi sẽ bị chặn; bản chuẩn bị cũ không được thực thi.
- Máy chủ giữ lần thực hiện đang dở, kể cả khi mất localStorage. Kết quả chưa rõ chỉ cho đọc đối chiếu và chặn đổi phạm vi. Kết quả kết thúc cho phép chủ động đọc mới, chuẩn bị intent mới; không tự gửi lại khi chưa biết kết quả.
- Hash byte ảnh, SKU, nhãn và thứ tự được kiểm trước ghi. Readback kiểm cả trường được chọn và trường cần giữ nguyên. “Đã đối chiếu” không đồng nghĩa Shopee đã duyệt policy/QC.
- Khi cập nhật token TEST, có thể dùng lại Partner Key đã mã hóa. Lần kết nối đầu vẫn cần key. Chưa có tự refresh token.

## Các phát hiện từ API thật

Sau khi người dùng cập nhật token, backend đọc đúng shop TEST thành công. Listing Lamy trả **6 model, 8 ảnh gallery, 9 ảnh mô tả**; không lệch SKU/nhãn. Giới hạn được lấy từ API của chính shop/ngành, không dùng ví dụ tài liệu làm mặc định.

Các khác biệt đã được đưa vào kiểm thử hồi quy:

1. Danh sách vận chuyển có thể đổi thứ tự giữa các lần đọc. Đối chiếu theo `logistic_id` duy nhất, giữ mọi giá trị phí/trạng thái; không sắp xếp lại ảnh, mô tả hoặc phân loại.
2. Kết quả tải ảnh thành công trả `image_info_list[].error: null`. Parser chấp nhận rõ `null` hoặc chuỗi rỗng, vẫn chặn lỗi thực, thiếu trường/sai kiểu hoặc các image ID mâu thuẫn. Mã lỗi và request ID đã lọc được giữ để hỗ trợ điều tra.
3. Danh sách thuộc tính có thể đổi thứ tự ngoài. Đối chiếu theo `attribute_id` duy nhất; không đổi thứ tự các giá trị bên trong một thuộc tính.
4. Cập nhật gallery 3:4 mà bỏ qua `promotion_images` có thể làm Shopee thay bìa bằng ảnh đầu gallery. Bản sửa yêu cầu đúng một mã bìa hiện tại và gửi kèm mã đó để giữ bìa. Kiểm thử tái hiện tác động này; ảnh bìa vẫn phải được kiểm tra độc lập sau ghi.

**Kết quả live:** backend đã gửi một cập nhật tiêu đề/mô tả/gallery vào đúng listing Lamy cũ trên sandbox, không tạo listing mới. Lần này tái dùng 17 mã ảnh có checkpoint, không tải lại. API ghi trả thành công; đọc ngay còn dữ liệu cũ, lần đọc tiếp theo mới khớp cả ba trường. Readback đồng thời phát hiện bìa bị thay bởi tác động ở mục 4; không đánh dấu thành công toàn bộ.

Đã khôi phục bìa gốc bằng một yêu cầu riêng chỉ gửi đúng mã bìa từ baseline. Shopee lưu bìa dưới mã mới; kiểm tra ảnh thực tế xác nhận đúng bìa **COMBO 100 CÁI** đã trở lại. Byte và pixel không giống tuyệt đối sau Shopee xử lý, nên không coi hai mã là tương đương bằng suy đoán. Lần thực hiện vẫn **unknown / cần đối chiếu bìa**, dù tiêu đề/mô tả/gallery và các dữ kiện ngoài bìa đều khớp. Chưa có quy trình chấp nhận ảnh đổi mã trong ứng dụng. Không sửa nguồn hoặc nới điều kiện QC để ép trạng thái thành `verified`.

Sáu model, SKU/nhãn/thứ tự, giá và tồn 100/model được giữ nguyên; nguồn local `lamy-5d` vẫn revision 1. Shop thật không bị ghi. Các lần trước dừng trước `update_item` khi phát hiện khác biệt thứ tự hoặc phản hồi upload chưa được parser hỗ trợ; ảnh tải thành công đã có checkpoint được tái dùng đúng shop/hash/vai trò/tỷ lệ.

**Thời gian quan sát, không phải cam kết năng suất:** đọc 0,66 giây, chuẩn bị 0,51 giây, gửi và đọc lại 3,60 giây khi đã có 17 mã ảnh. Một lần trước tải 17 ảnh và kiểm tra mất 25,49 giây rồi dừng trước ghi item. Thời gian sửa lỗi, đổi token và kiểm tra bìa nằm ngoài các số đo này. Chưa đo tải đồng thời hoặc 24 giờ.

Bằng chứng riêng tại `.local/lamy-http-pilot.json`, `.local/lamy-backend-read.json`, `.local/lamy-upload-diagnostic.json`, `.local/lamy-cover-restore.json` và `.local/lamy-cover-equivalence.json`. Các file này không chứa khóa/token và không được đưa vào repository. Hồ sơ nghiên cứu có nguồn API đầy đủ tại `docs/research/shopee-backend-pilot-2026-09-11/README.md` (bản riêng tại máy).

## Kiểm chứng cuối

- Node 24.20.0: typecheck/build đạt; **240/240 unit/integration** trong 27 file và **7/7 legacy** đạt. Báo cáo cuối `.local/verification.json`, `.local/test-results.json` ngày 11/09/2026; integration dùng PostgreSQL với schema riêng.
- **43/43 browser E2E**, 111,402 giây, không lỗi/bỏ qua/flaky: 12 ca dùng app local thật chỉ đọc và 31 ca fixture chặn yêu cầu ghi. Các ca `verified` giả lập không thay thế bằng chứng sandbox thật đang chờ đối chiếu bìa.
- Quan sát app thật: một công việc, không phát sinh lệnh ghi, không lỗi trang, không tràn ngang ở màn 390px và desktop; trạng thái `unknown` cùng cảnh báo bìa hiện đúng. Ảnh riêng trong `.local/e2e-artifacts/operation-live-*.png`.
- Review độc lập phát hiện hai lỗi thử lại ở UI đã sửa: kết quả kết thúc phải có bước đọc/chuẩn bị mới; lỗi prepare đã xác định phải bỏ fingerprint cũ. Review cuối không phát hiện thêm P0/P1 trong phạm vi đã đọc; đây không phải chứng minh hệ thống không còn lỗi.
- Build còn cảnh báo bundle JavaScript khoảng 514kB minified (151kB gzip); chưa đo tải nhiều nhân viên. Chưa phải nghiệm thu hiệu năng production.
- Mã đã commit/push tại `2b8f1f3` trên `feat/internal-app`. GitHub [kiểm tra push](https://github.com/HoangDuong-DH/shopee-product-uploader/actions/runs/34587610088) và [kiểm tra pull request](https://github.com/HoangDuong-DH/shopee-product-uploader/actions/runs/34587613314) đều đạt, gồm kiểm ứng dụng và audit dependency trong workflow. [PR #1](https://github.com/HoangDuong-DH/shopee-product-uploader/pull/1) đã cập nhật tên/mô tả và giữ Draft; chưa merge/triển khai production. Commit tiếp theo chỉ ghi nhận mốc kiểm chứng này.

## Giới hạn còn lại

Đây là bản phát triển có một luồng sandbox giới hạn, **chưa phải ứng dụng production hoàn chỉnh**. Chưa nghiệm thu đăng mới hàng loạt, model/giá/tồn/thuộc tính/vận chuyển, khuyến mại và Flash Sale, quyền ngành cho nhiều shop Mall/shop thường, callback và refresh token tự động, QC sau đăng, worker đăng bền 24 giờ, backup/khôi phục khi sự cố máy hoặc triển khai LAN cho nhân viên.

Phép gọi cập nhật đang chạy trong vòng đời HTTP của backend, có trạng thái bền để đối chiếu nhưng chưa có scheduler/lease worker cho hàng nghìn công việc. Đọc trước ghi không tạo được giao dịch nguyên tử với một người khác sửa trực tiếp trên Shopee; readback phát hiện khác biệt quan sát được, không bảo đảm tránh mọi ghi đè xảy ra giữa hai thời điểm.

Các mẫu kiểm thử là dữ liệu tổng hợp tách khỏi dữ liệu doanh nghiệp. Chưa thử với nhân viên thực tế hoặc đo năng suất 24 giờ. Không lấy thời gian một listing sandbox để suy ra số link/ngày.

Hướng dẫn: [Cách dùng](../runbooks/listing-workspace.md), [Kết nối TEST](../runbooks/sandbox-connection.md). Cơ sở API: hai kho Shopee snapshot 08/09/2026, tài liệu đầy đủ có nguồn/ngày và các phản hồi sandbox ngày 11/09; không kết luận policy production hiện hành từ phép thử sandbox.
