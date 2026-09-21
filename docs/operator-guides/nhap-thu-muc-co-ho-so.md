# Nhập thư mục có sẵn nội dung và phân loại

Mỗi thư mục sản phẩm gồm Word, ảnh và hồ sơ `listing-source.json`. Hồ sơ giữ cách ghép SKU, tên và thứ tự phân loại, vị trí ảnh, đoạn Word và bộ giá. Nhân viên không cần gõ lại các SKU đã chuẩn bị.

1. Mở **Kho listing → Nhập Word / ảnh / bảng giá → Nhập thư mục listing**.
2. Chọn một thư mục sản phẩm và **Thư mục này là một listing**. Với cả bộ, chọn thư mục **San pham** rồi chọn **Mỗi thư mục con là một listing**.
3. Chọn hoặc tải bảng giá chung đúng bản gốc. Bộ VINA TƯƠI V2 dùng **FILE GIÁ DORIS.xlsx → FILE GIÁ DORIS → SHOP MALL**. Nếu bản này đã có, ứng dụng nhận diện theo hồ sơ.
4. Bấm **Đọc các thư mục**, kiểm tra các tab ảnh, Word và SKU. Nội dung cùng thứ tự được lấy từ hồ sơ; không suy phân loại từ tên ảnh.
5. Bấm **Mở bộ đã lưu** khi nguồn và phiên bản khớp. Bộ mới chưa từng lưu dùng **Xem & hoàn thiện**. Nhập thư mục chưa gửi dữ liệu lên Shopee.

Giữ `listing-source.json` ở ngay trong thư mục từng sản phẩm. Không đổi tên hay sửa tệp được hồ sơ dẫn đến. Khi thay nội dung, giá hoặc ảnh, cần bộ nguồn phiên bản mới; tệp thiếu, sai hash, trùng SKU/tổ hợp hoặc sai bộ giá sẽ bị chặn.

**Riêng bộ 10 sản phẩm V2 ngày 16/09:** Cam Sả được nhận đủ 3 SKU theo thứ tự 300ml, 100ml, 500ml và mở lại nguồn đã lưu. Chín sản phẩm còn lại có ID listing trong Excel nhưng bản nháp lịch sử chưa ghi ID đó, nên nhập lại sẽ báo chênh lệch ID. Không bỏ ID trong hồ sơ để vượt kiểm tra. Dùng đợt công việc đang có trong ứng dụng cho lượt thử đã được xác nhận; bốn sản phẩm đang xử lý thủ công đã có trong ứng dụng, không nhập lại để tiếp tục.

Tồn kho và quyết định đăng/cập nhật thuộc bước vận hành riêng. Hồ sơ thư mục không tự đặt tồn, không áp dụng giá khuyến mại và không thay cho xác nhận đăng hàng. Các ảnh gốc chưa chọn được giữ riêng ngoài thư mục nhập, không tự đưa vào listing.

**Bộ nguồn chưa chốt bộ giá:** hồ sơ có thể ghi rõ chờ người vận hành chọn giá. Ứng dụng tự nhận đúng tệp Excel và sheet, giữ sẵn SKU/phân loại nhưng để trống bộ giá. Sau khi đọc thư mục, mở **Bảng giá & tệp nguồn** và chọn **Bộ giá áp dụng** một lần. Không tự chọn SHOP MALL; hồ sơ cũ đã chốt giá vẫn yêu cầu đúng bộ giá đã ghi.
