# Kiểm thử thư mục, đối chiếu từng trường và tên shop — 14/09/2026

**Bản này ghi trạng thái trước khi người dùng đổi token.** Kết quả tiếp nối đã có: một create mới và 14/15 field đạt, một giá bị chặn trước ghi; xem [nghiệm thu backend sau kết nối revision 6](2026-09-14-live-backend-acceptance.md). Các kết quả import/browser bên dưới giữ nguyên là bằng chứng lượt trước.

## Kết luận

Hai mục nghiệm thu người dùng yêu cầu **chưa hoàn tất toàn bộ**. Đã có kiểm chứng nhập 80 thư mục qua hệ thống thật tại máy, ba bản nguồn/công việc theo ba shop giả lập, sửa lỗi mất metadata khi chỉnh sửa, và nhánh backend thử thay đổi từng nhóm trường. Chưa có kết quả ghi Shopee mới trong lượt này vì kết nối TEST bị Shopee từ chối xác thực. Nhiều ngành/nhiều shop live và luồng từ 80 thư mục thành 80 listing trên sàn vẫn chưa được nghiệm thu.

## Phạm vi đã kiểm

| Nội dung | Bằng chứng và giới hạn |
| --- | --- |
| Nhập thư mục | 80 DOCX + 240 PNG riêng theo 80 thư mục; một XLSX dùng chung. Browser → HTTP API → worker đọc nguồn → PostgreSQL/blob thật, schema riêng; giữ nguyên Word, SHA-256, quan hệ thư mục và tải lại. Lượt đọc/lưu trong suite riêng: 33,375 giây; không dùng số này làm tốc độ đăng Shopee |
| Nhiều nguồn giá/shop | Ba bộ QA Bắc/Trung/Nam, cùng SKU có giá riêng 11.001/22.002/33.003đ. Ba bản nguồn được lưu qua editor và ba WorkOrder được gán shop giả lập đúng ID; không phải 80 WorkOrder và không có kết nối shop thật trong fixture |
| Nhiều ngành | Bốn tên ngành có trong dữ liệu nguồn giả lập. Editor/API chưa có đầu vào category ID hoặc gán ngành/shop riêng theo từng thư mục; chưa chứng minh định tuyến/quyền ngành live |
| Lỗi nguồn | Trùng SKU cùng phạm vi được giữ lỗi; thiếu Word và DOCX/PNG hỏng cách ly khỏi thư mục hợp lệ. Một cặp ảnh cùng bytes vẫn giữ hai đường dẫn/thư mục nguồn |
| Giữ thông tin ngoài editor | Đã tái hiện và sửa mất category/brand/attributes/logistics và metadata khác khi chỉ sửa tiêu đề. Giữ cả asset tham chiếu video/size chart, lỗi ở đường dẫn con, nguồn chứng minh, lịch sử revision; CAS vẫn chặn bản cũ |
| Backend đối chiếu | Client sáu nhóm và service kiểm TEST riêng; nhóm mô tả extended/ảnh phân loại/thuộc tính/vận chuyển chưa đi trọn luồng. Giá/tồn đối chiếu từng model; kiểm các trường không chọn, giữ bìa, chặn lệch nguồn, intent không gửi lại sau timeout/crash; xem runbook |
| Tên shop | Shop 227418363 đã có tên gợi nhớ **Shop thử nghiệm VN**, nhãn SANDBOX, vẫn giữ tên chính thức và Shop ID. Chỉnh tại Kết nối shop. Tên nội bộ có revision riêng và xử lý gửi lại/xung đột; không gọi API đổi tên Shopee |

## Kiểm tra đã chạy

- Root: typecheck, TypeScript build, web build, **7 legacy + 432 unit/integration đạt**. Báo cáo riêng tại `.local/acceptance-20260914/verification.json` và `unit-integration-results.json`. Đây là kiểm tra phần mềm, không phải 432 cuộc gọi Shopee thành công.
- Tập browser nhập thư mục của agent: **7/7 đạt**, 97,85 giây gồm thao tác/đối chiếu và các ca khác. Tên gợi nhớ có 2 browser fixture và 7 integration đạt. Các tập này giao nhau với kiểm tổng; không cộng để tạo tổng khác.
- Root đã chạy lại toàn bộ browser sau khi tích hợp: **65/65 đạt, 4,7 phút, exit 0**; báo cáo `all-browser-results.json`. Lượt root đọc/lưu 80 thư mục mất **44,894 giây**, thư mục bằng chứng `bulk-folders/run-g7kmWb/`. Chênh với 33,375 giây của suite riêng phản ánh từng lượt tại máy, chưa là benchmark sản xuất. `bulk-folder-latest.json` hiện trỏ lượt root này; báo cáo agent giữ mốc suite riêng để truy vết.
- Đã chạy lại build sau thay đổi cuối ở phần giữ metadata và nhãn trạng thái kết nối. Web build còn cảnh báo chunk hơn 500 kB; chưa có số đo năng suất 24 giờ.
- Đọc sau cập nhật xác nhận products, nguồn, cấu hình/kết quả WorkOrder và trạng thái thực thi local giữ nguyên ngoài tên hiển thị shop. Connection revision 5, capability revision 4 không đổi; Lamy vẫn source revision 1 và run unknown cũ. Bằng chứng `protected-comparison.json`.

## Lượt backend Shopee trong ngày

1. API `sandbox-create-trials/inspect` trả HTTP 409 `SANDBOX_AUTH_REQUIRED` bằng kết nối đã lưu; chưa tới bước upload/create.
2. Đã dựng manifest 15 ca mới, năm nhóm (tiêu đề, mô tả chữ, gallery, giá, tồn) × ba nguồn kỹ thuật 0/1/2 tầng đã có biên nhận tạo. Manifest này không phải nguồn KINI hoặc nội dung doanh nghiệp.
3. Khi thử qua endpoint field mới, lần khởi động API local trong môi trường hạn chế mạng trả `FIELD_READ_UNKNOWN`. Kiểm tra công khai không mang khóa cho thấy Windows `EACCES`. Đã khởi động lại đúng API/worker/UI có quyền mạng sau khi bộ duyệt cho phép; vẫn bind loopback, không mở cổng Internet.
4. Lượt sau trả `FIELD_API_REJECTED` ở bước đọc trước. Kiểm lại qua inspect nhận **`SANDBOX_AUTH_REQUIRED`**. **0 ca field đã được ghi, 0 verified, 14 ca còn lại chưa thử**; không biến read failure thành create/update rồi retry. Tệp `final-live-field-status.json` và `final-sandbox-inspect.json` giữ kết quả.

Người dùng đã được yêu cầu cập nhật token tại UI, không gửi token vào chat. Hiện chỉ có một TEST shop được cấu hình. Không suy nghiệm thu nhiều shop từ ba kết nối giả lập. Không có ghi shop thật hoặc thay đổi Lamy trong lượt này. Kết quả 76/80 sandbox create ngày 12/09 giữ nguyên, không gán là thành công mới.

## Phần tiếp theo còn bắt buộc

- Sau token TEST hợp lệ: chạy canary đăng mới qua backend trong đúng sandbox và hoàn tất từng nhóm thay đổi/readback, không gửi lại intent cũ chưa rõ. Đổi revision kết nối phải chuẩn bị lại các intent chưa ghi theo phạm vi mới.
- Nối công việc doanh nghiệp và bộ cập nhật đã nhập với executor/snapshot/model binding; hiện nhánh field trial chỉ nhận nguồn kỹ thuật đã đăng trước.
- Bổ sung mapping ngành/thuộc tính/vận chuyển có nguồn và theo quyền shop; gán shop/bộ giá theo từng thư mục thay vì chỉ theo đợt. Sau đó mới nghiệm thu 80 bản listing hoàn thiện từ thư mục.
- Media 3:4, bìa riêng, ảnh mô tả và ảnh phân loại cần chứng minh scene/source/kích thước/thứ tự/ảnh dùng chung cho option; không dùng ID tải scene normal để nhận là đã kiểm ảnh mô tả.
- Nghiệm thu nhiều shop TEST rồi pilot production có phạm vi riêng; refresh token, lệnh tồn sau đơn, QC, vận hành 24 giờ vẫn chưa được xác nhận.

## Hồ sơ

- [Runbook đối chiếu từng trường](../runbooks/sandbox-field-acceptance.md)
- [Hợp đồng API và phản biện](../reviews/2026-09-14-sandbox-field-contract.md)
- Báo cáo nguồn thật tại máy: `.local/acceptance-20260914/bulk-folder-report.md`; dữ liệu fixture và ảnh chụp còn ở `bulk-folders/run-fgH9UM/`; schema và blob thử đã dọn sau nghiệm thu.
- Migrations 010–011 đã áp dụng local. API 4310 và UI 5173 đã mở lại. Mã vẫn trong checkout đang làm, chưa commit/push lần này; không xóa hoặc ghi đè công việc cũ.
