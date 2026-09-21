# Kết quả thực tế sau kết nối TEST mới — 14/09/2026

**Backend đã đăng mới một mẫu và thực hiện thành công 14/15 ca cập nhật có đọc lại. Một ca giá bị chặn trước khi ghi.** Tất cả thao tác ghi thuộc **Shop thử nghiệm VN**, shop 227418363, partner TEST 1232297, connection revision 6. Không có ghi shop thật, không tạo lại hoặc cập nhật Lamy trong lượt này.

Đây là kết quả chạy OpenAPI thật từ backend tại máy, không phải thao tác chuột trong API Test Tool hoặc phản hồi Shopee giả lập. Nguồn sử dụng vẫn là mẫu kỹ thuật `SANDBOX QA`/`SBX-BULK`, ngành sổ tay 301378, giữ trạng thái **UNLIST — ẩn**. Hai mục nghiệm thu 80 bộ listing doanh nghiệp nhiều ngành/nhiều shop và cập nhật đầy đủ các trường **chưa hoàn tất toàn bộ**.

## Kết quả vừa thực hiện

| Phép thử | Kết quả thực tế | Phần đã đối chiếu |
| --- | --- | --- |
| Đăng mới qua backend và worker | Item **803935036**, đạt | Đọc lại nội dung, ảnh, ngành, thuộc tính, vận chuyển, giá/tồn và UNLIST theo manifest kỹ thuật |
| Tiêu đề | **3/3 đạt** | Đúng chữ; các thông tin khác giữ nguyên |
| Mô tả chữ | **3/3 đạt** | Giữ dấu tiếng Việt, ký tự đặc biệt và dòng trống |
| Gallery 1:1 | **3/3 đạt** | Đúng thứ tự mới, giữ ảnh đầu/bìa và các trường khác; tái dùng mã ảnh |
| Giá gốc | **2/3 đạt, 1 bị chặn trước ghi** | Đúng model được chọn; giá/tồn của model khác giữ nguyên |
| Tồn bán | **3/3 đạt** | Đúng số lượng và vị trí kho được chỉ định; các SKU khác và mọi giá giữ nguyên |

Ba kiểu sản phẩm được kiểm gồm không phân loại (803935036), một tầng/hai model (803934786), hai tầng/bốn model (803934787). Giá mẫu một tầng đổi đúng model 4258854181 từ 21.100 → 21.200đ; mẫu hai tầng đổi đúng model 4258854182 từ 20.200 → 20.300đ. Các lệnh tồn đặt đúng model đã chọn về 2. Đây là số thử đã chốt trong manifest, không phải mặc định cho nguồn KINI hoặc shop thật.

Agent thứ hai đã dựng kết quả mong đợi và so sánh độc lập toàn bộ dữ liệu raw, không sử dụng lại comparator của ứng dụng: **14/14 kết quả verified được chứng minh**, bao gồm các model không chọn, trường chưa biết, thứ tự ảnh/tier và cấu trúc. Xem [báo cáo phản biện và thời gian từng ca](../reviews/2026-09-14-live-field-readback.md).

## Ca giá chưa đạt và cách hệ thống xử lý

Item không phân loại 803935036 trả `has_promotion=true`, `promotion_id=0`, current/original cùng 20.000đ. Prepare bị chặn với `FIELD_PROMOTION_REQUIRES_REVIEW`; không có lệnh sửa giá được gửi.

Đã bổ sung endpoint **chẩn đoán chỉ đọc** và gọi `get_item_promotion` thật sau đó. Shopee trả đúng item trong success_list nhưng **không có trường `promotion`**. Đây không phải một danh sách chương trình rỗng được xác nhận, nên không đủ giải quyết mâu thuẫn với cờ true. Giá vẫn giữ nguyên 20.000đ; không nới điều kiện để ép ca thử đạt. Hai item có phân loại trả cờ false và cũng không có trường promotion trong chẩn đoán sau chạy; kết quả đổi giá đã đọc lại đạt chỉ chứng minh dữ liệu thực tế, chưa chứng minh một bộ kiểm toàn diện về chương trình đang chạy/sắp chạy.

Những ca độc lập còn lại được tiếp tục có chủ đích sau khi xác nhận ca giá bị chặn **trước mutation**. Giữ cùng manifest/UUID; không gửi lại ca đạt hoặc lệnh unknown. `summary.json` giữ kết quả đoạn đầu, `continuation-summary.json` giữ đủ 15 ca. Chương trình trả exit 2 vì vẫn chưa đủ 15/15 đạt.

## Thời gian đã đo

- Đăng mới: **7,752 giây** từ vào hàng đợi đến đọc lại đạt; chưa tính bước kiểm metadata, tải ba ảnh và xem manifest.
- Cập nhật: **2,321–3,108 giây/ca execute**, trung bình 2,726 giây; bao gồm kiểm trước, gửi sửa và đọc lại. Prepare của ca đạt thêm 0,303–0,624 giây.
- Hai đoạn xử lý 15 ca, gồm khoảng dừng xem xét giá: **93,282 giây**. Không dùng số này suy ra năng suất 24 giờ hoặc tốc độ nhiều shop.

## Kiểm tra phần mềm và giữ nguồn

- Sửa lỗi comparator bỏ sót khi một trường rỗng đổi kiểu giữa `[]` và `{}`. Hai ca hồi quy đã tái hiện lỗi trước sửa và đạt sau sửa.
- Root chạy lại kiểm kiểu, TypeScript/web build, **453 unit/integration + 7 legacy: đều đạt**, không có test bỏ qua. Báo cáo tại `.local/acceptance-20260914/LIVE-REV6/verification.json` và `unit-integration-results.json`. 65 browser đạt ở lượt trước trong cùng ngày; không gán chúng thành phép chạy mới sau cập nhật diagnostic.
- Gửi lại đúng ID/fingerprint của lệnh tồn đã đạt trả nguyên biên nhận cũ. Thử revision kết nối cũ và đổi nội dung của một intent đã dùng đều bị chặn HTTP 409. Không mô phỏng đơn hàng thật hoặc tự bù tồn.
- Sau khi khởi động lại backend, diagnostic đọc mới cả ba item: toàn bộ raw vẫn trùng readback cuối sau khi sắp model theo ID; không bỏ trường nào và cả ba vẫn UNLIST. Bằng chứng `LIVE-REV6/restart-readback-check.json`.
- Products, nguồn Lamy revision 1, cấu hình/kết quả WorkOrder và execution local giữ nguyên. Khác biệt shop gắn trong WorkOrder là dữ liệu kết nối được người dùng làm mới từ revision 5 → 6; khác biệt `.28Z`/`.280Z` trong tệp đối chiếu chỉ là cách PowerShell ghi cùng timestamp. Có báo cáo raw và đối chiếu giải thích riêng, không sửa DB để ép kết quả.
- API ready và giao diện được mở lại tại http://127.0.0.1:5173/. Mã chưa commit/push trong lượt này.

## Hai mục nghiệm thu ban đầu còn thiếu gì

**Nhập 80 thư mục:** lượt trước đã kiểm 80 Word + 240 ảnh và bảng giá chung qua browser/API/worker/PG thật tại máy, giữ nội dung/ảnh/quan hệ thư mục. Chỉ ba bộ tập con thành draft + WorkOrder theo ba shop giả lập. Chưa nối 80 bộ đó thành 80 listing trên Shopee; chưa có mapping ngành/thuộc tính/vận chuyển và shop/bộ giá riêng cho từng thư mục để nghiệm thu nhiều ngành/nhiều shop live.

**Đăng và cập nhật đầy đủ:** đã có bằng chứng backend mới ở bảng trên. Luồng thực thi từ bộ cập nhật doanh nghiệp trong UI còn phải nối với remote snapshot và item/model binding. Bìa riêng 1:1 cùng gallery 3:4, ảnh trong mô tả, ảnh phân loại, thuộc tính/vận chuyển, chính sách khuyến mại/QC, tự làm mới token, phục hồi unknown và chạy 24 giờ cần nghiệm thu riêng. Không có thêm shop TEST thứ hai được cấu hình để chứng minh nhiều shop thật.

Kết quả 76/80 tạo mẫu kỹ thuật ngày 12/09 là lịch sử riêng; bốn nguồn bị từ chối vẫn chưa được thử lại. Mẫu mới hôm nay không thay thế hoặc nâng kết quả cũ thành 80/80.

## Hồ sơ bằng chứng

- `.local/acceptance-20260914/LIVE-REV6/`: request/inspect/prepare/submit/readback của canary, ba diagnostic chỉ đọc, kiểm biên nhận lặp/revision/intent, bảo toàn nguồn và báo cáo kiểm phần mềm.
- `.local/acceptance-20260914/FIELD-20260914-B/`: manifest 15 ca, 15 prepare, 14 execute, hai summary và chương trình continuation. Không phát lại để tạo thay đổi mới.
- [Runbook cập nhật từng trường](../runbooks/sandbox-field-acceptance.md), [phản biện độc lập](../reviews/2026-09-14-live-field-readback.md), [nghiệm thu nhập 80 thư mục trước khi đổi token](2026-09-14-acceptance-and-shop-names.md).
- Hợp đồng khuyến mại đối chiếu từ kho ngày 08/09/2026: [get_item_promotion](https://open.shopee.com/documents/v2/v2.product.get_item_promotion?module=89&type=1), [thông báo 1280](https://open.shopee.com/announcements/1280), [thông báo 1377](https://open.shopee.com/announcements/1377). Mở lại tài liệu chính thức trong lượt này nhận 403/trang không mở được; không gọi snapshot là policy production mới nhất. Phản hồi diagnostic sandbox được lưu riêng với timestamp và request ID.
