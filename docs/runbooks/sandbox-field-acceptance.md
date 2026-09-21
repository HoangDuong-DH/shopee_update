# Nghiệm thu cập nhật theo nhóm trường — 14/09/2026

Đây là đường kiểm thử kỹ thuật mới, chưa phải executor cho bộ cập nhật doanh nghiệp. Chỉ backend TEST partner 1232297 / shop 227418363 có thể ghi. Mục tiêu phải là item đã được tạo và đọc lại đạt trong `sandbox_create_trial_items`, mang SKU `SBX-BULK-`, đang UNLIST. Lamy 803934364 và mẫu cũ 846056124 bị chặn. Shop thật không có đường ghi qua dịch vụ này.

## Quy trình

1. `POST /v1/sandbox-field-trials/prepare` nhận `{id, trialItemId, connectionRevision, operation}`. Backend tự lấy item ID từ biên nhận tạo, đọc Shopee, đối chiếu SKU/model/tier/ngành/trạng thái và kiểm giới hạn hiện trả về. Không nhập item ID tùy ý hoặc suy ngành từ tên sản phẩm.
2. Kết quả `prepared` lưu ảnh chụp trước, thay đổi mong muốn và fingerprint bất biến trong PostgreSQL. Chưa có yêu cầu sửa listing.
3. `POST /v1/sandbox-field-trials/execute` nhận `{id,fingerprint}`. Backend đọc lại, giành quyền ghi TEST dùng chung với worker tạo, ghi intent bền rồi đọc thêm ngay sát lệnh ghi. Có khác biệt thì dừng trước ghi.
4. Mỗi intent chỉ có tối đa một lệnh sửa. Sau đó đọc lại và so sánh dữ liệu đã yêu cầu cùng toàn bộ trường khác có trong phản hồi. HTTP 200 hoặc một phần `success_list` không đủ để đánh dấu đạt.
5. `GET /v1/sandbox-field-trials/:id` mở bằng chứng. `verified` chỉ có nghĩa dữ liệu quan sát đã khớp; `unknown` giữ kết quả chưa giải thích được và chặn lệnh tiếp theo. Gửi lại cùng ID trả biên nhận đã có, không bù lại tồn sau đơn hàng. Không sửa DB để ép trạng thái hoặc tạo yêu cầu mới để lặp một lệnh unknown.

Không có cơ chế nguyên tử với thao tác bên ngoài trên Seller Center. Kiểm tra ngay trước và đọc lại sau giúp phát hiện khác biệt quan sát được, không bảo đảm không có tác động đồng thời giữa hai thời điểm. Các trường API không trả về chưa được kiểm chứng.

## Phạm vi đang hỗ trợ trong pilot

| Nhóm | Điều kiện và phần phải giữ |
| --- | --- |
| Tiêu đề | Giữ nhãn nguồn kỹ thuật SANDBOX QA; toàn bộ thông tin còn lại không đổi |
| Mô tả chữ | Giữ nguyên từng ký tự/dòng trống của thay đổi đã chốt; phải có nhãn SANDBOX ONLY |
| Gallery | Chỉ mã ảnh đã có trong manifest nguồn kỹ thuật, không đổi tỷ lệ; gallery 1:1 giữ ảnh đầu/bìa, gallery 3:4 gửi lại bìa riêng hiện tại |
| Bìa riêng | Chỉ khi ảnh chụp trước có gallery 3:4 và nguồn ảnh đã xác minh; mã bìa bị Shopee đổi chưa được tự xem là tương đương |
| Giá gốc | Chọn model ID/SKU đã liên kết; chỉ VND, không có chương trình đang hoạt động; kiểm cả giá phụ thuộc đã biết, tiền tệ và các SKU không chọn |
| Tồn | Lệnh tuyệt đối, một vị trí kho đã xác định; không có reserve/advance/tồn Shopee chưa hiểu; số 0 có ý nghĩa riêng; giữ SKU khác và giá |

Client có biểu diễn mô tả extended nhưng dịch vụ hiện chặn `FIELD_EXTENDED_LIMIT_UNVERIFIED`: chưa có đường chứng minh scene/kích thước và metadata của ảnh mô tả mới. Chưa thực thi ảnh phân loại, đổi tên/cấu trúc phân loại, thuộc tính, vận chuyển, khuyến mại hoặc bộ cập nhật doanh nghiệp từ UI. Các nhóm đó là khoảng trống cần triển khai/kiểm thử riêng, không được tính là đã nghiệm thu chỉ vì client hoặc UI có tên trường.

## Chạy tập 15 trường hợp

`scripts/run-field-acceptance.mts` tạo manifest 15 thay đổi mới có nhãn giả lập: năm nhóm (tiêu đề, mô tả chữ, gallery, giá, tồn) trên ba mẫu kỹ thuật 0/1/2 tầng đã có bằng chứng tạo. Mặc định chỉ lập kế hoạch qua API local; không gửi thay đổi Shopee. Kèm `--execute` mới đi qua các endpoint trên. Mọi tệp được giữ ở `.local/acceptance-20260914/<tên-lượt>/`; lần chạy lại cùng tên không tạo ID khác. Đổi revision kết nối yêu cầu tên lượt mới; không phát lại intent đã ghi chưa rõ.

```powershell
node --conditions=development --import tsx scripts/run-field-acceptance.mts FIELD-20260914-A
node --conditions=development --import tsx scripts/run-field-acceptance.mts FIELD-20260914-A --execute
```

Tập này dừng ngay khi chuẩn bị bị chặn hoặc đọc lại chưa đạt. Không tự bỏ qua lỗi, giảm tiêu chí hoặc gửi tiếp lô. Đây không phải đăng mới 80 listing nhiều ngành từ thư mục và không phải kiểm thử nhiều shop thật. Bằng chứng nghiệm thu nhập thư mục nằm riêng ở `.local/acceptance-20260914/bulk-folder-latest.json`.

## Chẩn đoán chỉ đọc và kết quả live tiếp nối

`POST /v1/sandbox-field-trials/inspect` nhận `{trialItemId,connectionRevision}`, cùng header nội bộ. Đọc snapshot và `get_item_promotion` đúng item kỹ thuật đã ràng buộc; không có write intent, không ghi DB/Shopee. Kết quả tách `snapshot`/`promotions` theo ProductOutcome, lưu request ID và đánh dấu `promotionFieldPresent`. Thiếu trường `promotion` không được biến thành `[]`. Cờ true mâu thuẫn vẫn chặn giá; diagnostic không tự cấp quyền ghi hoặc thay thế bộ kiểm chương trình đang chạy/sắp chạy.

Lượt **FIELD-20260914-B revision 6** đã có **14 verified, 1 giá bị chặn trước ghi, 0 unknown, 0 chưa thử**. Continuation chỉ chọn rõ các ca độc lập sau một prepare bị chặn, giữ nguyên UUID/nguồn; không tiếp tục sau unknown. Xem [kết quả live và giới hạn](../delivery/2026-09-14-live-backend-acceptance.md). Lượt A với token cũ là lịch sử chưa ghi, không chạy lại để nghiệm thu revision mới.

## Nguồn đối chiếu

Hợp đồng API, các giới hạn và nguồn đầy đủ được ghi trong [đối chiếu API](../reviews/2026-09-14-sandbox-field-contract.md). Kho Shopee là snapshot 08/09/2026; truy cập nguồn chính thức mới trong lượt kiểm tra nhận 403, nên không nâng hợp đồng lưu trữ thành xác nhận policy production hiện hành. Điều kiện live phải qua metadata và phản hồi sandbox thực tế.
