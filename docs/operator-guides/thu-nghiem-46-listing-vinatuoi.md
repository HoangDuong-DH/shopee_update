> Cập nhật17/09v4: hiện45bộ nhập vì người dùng bỏ qua753. Dùng hướng dẫn mới [nhập lại sau đổi tên ảnh](nhap-lai-vina-tuoi-sau-doi-ten-anh.md). Các số46/1773/28pending vàZIPv3 bên dưới là phạm vi lịch sử trước quyết định này.

# Tự nhập 46 bộ VINA TƯƠI và đăng ẩn qua API

Lô đang làm: 46 dòng VINA TƯƠI trong STT 712–836. STT không phải ID Shopee. Đăng vào **vuatinhdau.vn — shop 1423724897**, lấy **GIÁ GỐC / SHOP MALL** trong DORIS, tồn đăng bán **100 mỗi SKU** theo xác nhận của bạn.

## Chọn đúng thư mục

Mở `D:\VINA_TUOI_712_836_20260916\Bo_nguon`. Có tám nhóm `Nhap_01` đến `Nhap_08`, mỗi nhóm 4–6 thư mục sản phẩm. Bản cập nhật phân loại ngày 17/09 bỏ 260ml ở dòng 100/300/500ml và gộp các lựa chọn MỚI trùng SKU về lựa chọn thường. Tên và ảnh của lựa chọn thường được giữ. File Word và ảnh gốc không sửa.

Trong ứng dụng, vào **Kho listing → Nhập Word / ảnh / bảng giá → Nhập thư mục listing**:

1. Chọn chế độ **Mỗi thư mục con là một listing**.
2. Chọn riêng nhóm `Nhap_01`. Không chọn toàn bộ `Bo_nguon` vì bên trong còn nhiều tầng và tài liệu dùng chung.
3. Chọn bảng **FILE GIÁ DORIS.xlsx**, sheet **FILE GIÁ DORIS**, bộ giá **SHOP MALL**.
4. Bấm **Đọc các thư mục** và chờ báo đã lưu vào Kho đầu vào. Làm lần lượt các nhóm còn lại để dễ kiểm tra.

## Hoàn thiện từng bộ trong ứng dụng

- Bộ có hồ sơ đầy đủ: mở bản đọc được, kiểm tên và số phân loại, rồi lưu bộ listing. Nếu đã có **Mở bộ đã lưu**, dùng bộ đó để tránh tạo thêm bản.
- Bộ hiện **Bảng phân loại chờ hoàn thiện**: mở **SKU & phân loại**. Mã đã đối chiếu nằm sẵn trong bảng. Kiểm lại số lựa chọn, đánh dấu **Dùng đủ N phân loại trong bảng này**, chờ lưu, rồi bấm **Xem và hoàn thiện nội dung**.
- Bản v3 đã khớp đủ **1.773 vị trí với 82 mã SKU**, không còn ô thiếu mã. Theo xác nhận ngày 17/09: lọ treo xe dùng dòng **8ml** trong tên sản phẩm DORIS dù SKU có đuôi 10; hai lựa chọn nước lau sàn “Không Mùi” dùng dòng **Nước lau sàn 1 lít**. Đây là đối chiếu riêng các sản phẩm này, không phải luật bỏ qua dung tích hay mùi cho mọi nguồn khác.
- **28 bảng vẫn chờ hoàn thiện** vì còn cần xác nhận cấu trúc, vai trò ảnh hoặc nội dung. Không cần nhập lại SKU đã ghép sẵn. Cặp hai chai Bạc Hà vẫn phải xác định đúng quy cách bán, dù các dòng đã có mã.
- Đủ SKU chưa đồng nghĩa đủ ảnh, nội dung hoặc ngành hàng. Nếu còn yêu cầu chọn Word, bìa, ảnh sản phẩm hoặc ảnh phân loại, chọn từ chính thư mục đã nhập. Tệp nháp/thừa vẫn giữ trong nguồn; chỉ ảnh được chọn mới đi vào bản đăng.
- Kiểm tra các lỗi nội dung còn được ghi nhận, nhất là thành phần và quy cách combo. Không cần nhập lại phần đã đọc đúng. Không tự dùng mã chai đơn cho cặp hai chai.

## Chuẩn bị và tự bấm đăng ẩn

1. Vào **Đăng hàng → Chuẩn bị lô mới**. Chọn các bộ đã lưu, đúng shop **1423724897**, bộ giá DORIS và tồn 100.
2. Giữ **Đăng ẩn để kiểm tra**. Nếu chọn tạm hoãn QC ảnh, vẫn phải có ảnh đã gán đúng vai trò, SKU/giá hợp lệ và đủ trường bắt buộc của ngành/shop.
3. Xem trước. Mở từng mục **Cần xử lý** để bổ sung ngành, thương hiệu, chi tiết hoặc vận chuyển theo dữ liệu có nguồn. Không đổi ngành chỉ để qua kiểm tra.
4. Khi lô đủ điều kiện, lưu/đăng ký lô rồi tự bấm nút thực thi. Các nút gửi trong bước này gọi API Shopee thật. Đọc file và lưu bản nháp ở các bước trước chỉ làm việc trong ứng dụng.
5. Theo dõi từng listing. Nếu báo chưa rõ kết quả, chọn đọc đối chiếu hoặc mở lần gửi đã lưu; không tạo lô khác và gửi lại ngay.
6. Để người phụ trách kiểm tra link ẩn. Chỉ dùng bước **Mở bán** sau khi QC xong. Đăng ẩn không tự động chuyển công khai.

Toàn bộ 46 dòng của nguồn này đang để trống ID LISTING; ứng dụng vẫn đối chiếu lịch sử thực thi để tránh tạo lại bộ từng gửi. Lô có ID nguồn ở những lần sau phải đi theo luồng cập nhật link cũ.

## Dọn và khôi phục dữ liệu trong ứng dụng

- **Dữ liệu đã nhận**: nút **Lưu trữ** ở từng dòng nội dung; bộ lọc **Hiển thị → Đã lưu trữ** để khôi phục.
- **Kho đầu vào**: có cùng thao tác ở đợt nhập, bộ listing đã lưu và bảng giá.
- **Listing của tôi**: lưu trữ/khôi phục bản nháp. Nguồn đang gắn với công việc chưa kết thúc được bảo vệ; lưu trữ không thay cho hủy công việc.
- **Ảnh đang chọn**: **Bỏ chọn** chỉ gỡ ảnh khỏi vị trí đang sửa; không xóa tệp gốc.

Lưu trữ chỉ dọn danh sách nội bộ. Không xóa sản phẩm trên Shopee, ảnh gốc, các biên nhận hay lịch sử đối chiếu.

Hiện Kho listing đã thu gọn còn 46 dòng. Kho đầu vào vẫn giữ 10 bản nháp thử cũ vì lô thử chưa kết thúc; đây không phải 46 bộ đang chuẩn bị nhập. Không gửi lại lô cũ để dọn danh sách. Bộ 46 mới được chọn từ tám nhóm trên ổ D.
