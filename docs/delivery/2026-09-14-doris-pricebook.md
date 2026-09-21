# Tiếp nhận giá và thông tin tinh dầu từ DORIS — 14/09/2026

Đã nhận nguyên file `C:/Users/Admin/Desktop/FILE GIÁ DORIS.xlsx` vào kho bảng giá của ứng dụng. Import ID `6bea45ed-8211-41c2-9f6f-4d8416f9af12`, SHA-256 `2642c4182a41a39cb01b0acde0f70d5b1c8d50c8daba640c942c281bf5930750`. Không chỉnh file gốc, không tạo listing/WorkOrder hoặc gửi lệnh Shopee. Catalog nội dung 604 dòng giữ nguyên; bảng giá mới chưa được gắn tự động vào các phân loại.

## Nguồn đã có

| Nhãn nguyên gốc | Dòng ở sheet FILE GIÁ DORIS | SKU duy nhất | Có giá SHOP MALL |
| --- | --- | ---: | ---: |
| VINA TƯƠI | 759–1041 | 283 | 283 |
| ABURA | 532–757 | 226 | 226 |
| VUATINHDAU | 1042–1190 | 149 | 149 |
| TDSC | 1191–1332 | 142 | 142 |

800 SKU có tên, thương hiệu, đơn vị tính, link ảnh, cân nặng thực/khai báo, giá gốc và giá bán. Không có SKU trùng trong tập 800 này. Nhãn `TDSC` chưa được tự đổi thành `TINHDAUSACHANH` của workbook nội dung.

Header dòng 2 của bảng chính: B tên, C thương hiệu, D ngành, E SKU, F link ảnh, H đơn vị tính theo VAT, I cân nặng thực(g), J khai báo(g). Các cặp giá tách riêng:

- K/L: GIÁ GỐC/GIÁ BÁN thuộc SHOP THƯỜNG.
- M/N: GIÁ GỐC ĐẶC BIỆT/GIÁ BÁN ĐẶC BIỆT thuộc SHOP THƯỜNG.
- O/P: GIÁ GỐC/GIÁ BÁN thuộc SHOP MALL.

**Cả 800 SKU tinh dầu chỉ có giá O/P. K/L và M/N đều trống.** Không lấy giá Mall điền bù cho shop thường hoặc suy tên bộ giá thành loại shop đích. Cách dùng GIÁ GỐC để đăng mới và GIÁ BÁN cho bước khuyến mại riêng vẫn theo xác nhận nghiệp vụ trước của người dùng; lần nhập này không tạo khuyến mại.

12 SKU can 5L quan sát trước tại listing `40750340260` đều tìm được duy nhất ở dòng 1018–1029. Giá gốc O là 2.179.998đ, giá bán P là 1.089.999đ; I=4.750g, J=5.225g, H=Can. Đây là đối chiếu nguồn, chưa phải phê duyệt gắn model/shop. Không dùng thứ tự hai bảng để nối SKU.

## Xử lý dữ liệu và phần chưa đủ

Bảng chính có 1.325 dòng SKU. Các bảng có cấu trúc sản phẩm trong toàn file có 1.727 dòng. Do mỗi SKU của bảng chính có ba bộ giá riêng, bộ đọc trả 4.377 bản ghi theo bộ giá; không gọi đây là 4.377 sản phẩm. FILE DHC có cột giá mơ hồ, sheet viegreen chưa có mapping, DHC ẩn có 86 dòng được giữ nhưng chặn dùng. Các cảnh báo còn nguyên, không sửa nguồn để đạt kiểm tra.

Các cột K:N bị ẩn trong workbook vẫn được giữ với ghi chú. Những ô phụ Q:AM có sản phẩm khác với A:P cùng dòng; 2.445 ô phụ được lưu riêng trong audit, không ghép theo vị trí. Những ô công thức xuất từ Google Sheets được đọc theo kết quả lưu trong file, không thực thi hàm, không gọi Google Sheets và không tuyên bố đã tính lại dữ liệu online.

674/800 SKU tinh dầu chưa có ngành. Workbook chưa cung cấp tồn đăng bán, shop/model ID, kích thước vận chuyển hoặc bộ thuộc tính đầy đủ. Link ảnh là nguồn tham khảo trong file, chưa tải ảnh gốc/gán vai trò. Đây không phải bản nghiệm thu đăng production.

## Thay đổi ứng dụng

`readKini` đọc theo tiêu đề cột, thêm bộ giá đặc biệt có danh tính riêng và giữ khóa/giá trị của 3.052 dòng cũ. Bổ sung 1.325 bản ghi đặc biệt, không ghi đè giá thông thường/Mall. Nhãn cột và vị trí ô được giữ trong `sourceHeaders`, có đơn vị tính và thông tin cột/sheet ẩn.

Mở **Kho listing → Nhập Word / ảnh / bảng giá → Bảng giá chung → FILE GIÁ DORIS.xlsx → Tra giá**. Bộ lọc cho phép chọn trang tính/bộ giá, tìm SKU/tên. **Thông tin nguồn** trên mỗi dòng hiển thị nguyên văn và vị trí ô, tách hai loại cân nặng. Ô trống hiển thị dấu gạch, số 0 được giữ. Tổng hàng nghìn cảnh báo lặp theo bộ giá được thay bằng lời nhắc xem chi tiết; dữ liệu cảnh báo không bị bỏ.

Ví dụ đã kiểm trên giao diện thật: tìm `VTSCC5L`, chọn SHOP MALL. Tìm theo chuỗi cũng hiển thị SKU combo `VTSCC5L300`; chúng vẫn là hai mã riêng, không tự chọn hoặc gộp.

## Kiểm chứng

- 77.070 giá trị và tham chiếu tiêu đề/ô của bộ đọc khớp nguồn độc lập; không sai lệch, nguồn SHA giữ nguyên.
- 13/13 kiểm thử parser, toàn bộ 592 unit đạt; 19/19 integration liên quan nhập nguồn và giữ dữ liệu đạt.
- 8/8 giao diện cuối đạt, không skip/flaky; gồm ba bộ giá, ô trống/0, nguồn nguyên văn, nguồn giá/đơn vị/cân nặng và màn hình hẹp. Ghi API trong UI fixture bị chặn.
- Typecheck, TypeScript build và web build mã cuối đạt.
- 14 bảng nguồn/công việc/catalog giữ nguyên hash trước/sau. Chỉ có bản nhập DORIS mới trong kho nguồn và dữ liệu tệp riêng được thêm.

Bằng chứng riêng ở `.local/input-catalog/doris-20260914/`: `import-receipt.json`, `imported-pricebook.json`, `parser-verification.json`, `integration-final.json`, `ui-frozen-final.json`, `final-build.json`, `protected-before.json`, `protected-after.json`. `audit/` có toàn bộ ô nguồn, kiểm công thức, 800 SKU, dữ liệu phụ và đối chiếu 12 SKU can 5L. Không commit nguồn giá hoặc dữ liệu riêng này.
