# Mở ứng dụng sau khi bật máy

## Mỗi ngày chỉ cần làm ba việc

1. Vào Start của Windows, tìm **Docker Desktop**, mở ứng dụng và đợi báo **Engine running**. Giữ Docker chạy; có thể thu nhỏ cửa sổ.
2. Nhấn **Windows + E**. Dán `C:\shopee_product_uploader` vào thanh địa chỉ rồi nhấn Enter. Bấm đúp **MO_WEB_APP.cmd** một lần.
3. Đợi cửa sổ báo **3/3 San sang**. Trình duyệt sẽ mở `http://127.0.0.1:4310/`. Nếu trình duyệt chưa mở, tự nhập địa chỉ này.

File mở app tự kiểm tra PostgreSQL, mở API và bộ đọc Word/Excel/ảnh nếu chưa chạy. Không tự nhập nguồn, đăng hàng hoặc mở bán sản phẩm. Dùng giao diện đã build tại cổng 4310; cổng 5173 dành cho phát triển.

## Lần nhập đầu sau khi làm sạch

1. Mở **Kho listing → Nhập Word / ảnh / bảng giá**.
2. Nhập lại bảng giá DORIS từ file gốc, chọn đúng **FILE GIÁ DORIS → SHOP MALL → GIÁ GỐC**.
3. Nhập thư mục tại `D:\VINA_TUOI_712_836_20260916\Bo_nguon`. Chọn từng `Nhap_01`…`Nhap_08` và **Mỗi thư mục con là một listing**; không chọn toàn bộ thư mục chứa báo cáo hoặc cách ly.
4. Đọc nguồn, kiểm các ngoại lệ rồi lưu các bộ đủ dữ liệu theo lô.
5. Vào **Đăng hàng → Chuẩn bị lô mới**, kiểm shop **vuatinhdau.vn**, chọn **Đăng ẩn để QC**. Chỉ khi tự bấm nút đăng qua API mới gửi lên shop.

## Khi có vấn đề

- Báo chưa mở Docker: mở Docker Desktop, đợi Engine running rồi chạy lại file mở app.
- Trình duyệt không kết nối được: chạy lại MO_WEB_APP.cmd một lần và đọc thông báo; không chỉ tải lại tab liên tục.
- App mở nhưng không đọc được tệp: kiểm tra ổ D vẫn có và Docker đang chạy. Log tại `.local\launcher\worker.stderr.log`.
- Báo API chưa sẵn sàng: giữ thông báo, kiểm tra `.local\launcher\api.stderr.log` hoặc gửi thông báo cho người hỗ trợ. Không chạy setup để tạo lại cấu hình.
- Báo kết nối Shopee hết hạn: vào **Công cụ → Kết nối shop** để xử lý kết nối. Việc khởi động máy không tự cấp lại quyền Shopee.
- Đóng tab trình duyệt không xóa dữ liệu. Mở lại địa chỉ 4310 để tiếp tục; không cần chạy file mở app nhiều lần.

## Dữ liệu đã giữ

Bo_nguon, file Excel gốc, kết nối shop và kho kiến thức được giữ. Dữ liệu hiển thị cũ đã làm sạch; bản sao lưu DB là `workspace_backup_20260917115030772`, biên nhận tại `.local\workspace-cleanup\20260917115030772\receipt.json`. Biên nhận gửi Shopee và khóa chống gửi trùng vẫn lưu riêng, không bị coi là hoàn tất chỉ vì làm sạch giao diện. Không xóa hoặc sửa listing trên Shopee trong lượt này.
