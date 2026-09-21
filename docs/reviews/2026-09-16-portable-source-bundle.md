# Kiểm độc lập bản thư mục VINA TƯƠI portable

Kiểm lúc **13:22:29 UTC ngày 16/09/2026** trên bản đã chốt tại `D:/VINA_TUOI_712_836_20260916/Bo_nguon`, không kiểm thay bằng bản nguồn C. **374/374 kiểm đạt, 0 lỗi**. Agent chỉ đọc D, ghi báo cáo trong `.local`; không sao chép ảnh, sửa nguồn, gọi mạng, DB, API hoặc Shopee.

## Bằng chứng

- Biên nhận copy: `.local/vina-input-712-836-20260916/portable-copy-receipt.json`, SHA-256 `c8292f314e3be2f9017dfa1ad10239ef51ff34dba99aac68e268c03bc17dcfc1`.
- Báo cáo độc lập: `.local/vina-input-712-836-20260916/independent-portable-source-reader.json`, SHA-256 `5732ea44e96aa6ac2062a30ac7651a15d440ac39ca6f0d868b3ca278eebb9fbd`.
- DORIS thực đọc: SHA-256 `2642c4182a41a39cb01b0acde0f70d5b1c8d50c8daba640c942c281bf5930750`.

## Phạm vi đạt

18 hồ sơ đầy đủ đã chạy qua reader Word/Excel và bộ ghép thư mục thật của ứng dụng. 675 dòng SKU theo listing giữ nguyên mã, nhãn, tầng và thứ tự, ô GIÁ GỐC SHOP MALL, bìa, gallery và ảnh phân loại. Tiêu đề và mô tả khớp nguồn workbook. ID listing trống được giữ rõ; chọn sai bộ giá vẫn bị chặn. Danh tính nguồn ngữ nghĩa của cả 18 hồ sơ giống bản gốc dù đường dẫn được rút ngắn, nên thay đường dẫn không tạo ra một sản phẩm mới.

28 bảng pending được đọc bằng parser thật: giữ nguyên core, thứ tự và 1.526 vị trí phân loại, trong đó 444 vị trí thiếu SKU. Đây là số vị trí trong các listing, không phải số mã SKU duy nhất. Tất cả vẫn chưa xác nhận cấu trúc, không tự sinh lựa chọn, không có chỉnh SKU và không thể tiếp tục chỉ vì đã có bảng giá. 827 đường dẫn ảnh tham khảo đã đổi đúng theo bản đồ; các trường khác của mỗi gợi ý giữ nguyên và trỏ về đúng byte ảnh gốc.

Đối chiếu SHA độc lập đủ **1.372 tệp trong các nhóm nhập: 46 Word và 1.326 PNG**; không có byte bị thay đổi. Một PNG trắng nằm ngoài nhóm nhập trong phần cách ly, nên không được tính vào phép kiểm 1.372 tệp này. Tổng bản bàn giao có 1.536 tệp gồm cả workbook, báo cáo và hướng dẫn. Đường dẫn tương đối dài nhất 168 ký tự; đường dẫn tuyệt đối dài nhất tại vị trí D hiện tại là 207 ký tự. Chuyển bản bàn giao vào một đường dẫn cha quá dài vẫn có thể vượt giới hạn của công cụ Windows.

| Nhóm nhập | Sản phẩm | Tệp | Byte thực tế |
| --- | ---: | ---: | ---: |
| Nhap_01 | 6 | 190 | 380.326.886 |
| Nhap_02 | 6 | 174 | 343.997.283 |
| Nhap_03 | 6 | 174 | 344.384.877 |
| Nhap_04 | 6 | 183 | 382.558.927 |
| Nhap_05 | 6 | 163 | 323.146.450 |
| Nhap_06 | 6 | 141 | 288.092.783 |
| Nhap_07 | 6 | 201 | 405.283.395 |
| Nhap_08 | 4 | 192 | 407.520.186 |

Tám nhóm giữ đủ 46 sản phẩm, đều dưới 500 MiB. Không có tệp ngoài bản đồ lẫn vào các nhóm nhập. Hướng dẫn và bảng tên đầy đủ nằm ngoài nhóm để người vận hành chọn một sản phẩm trước, rồi từng nhóm ở chế độ mỗi thư mục con là một listing.

## Giới hạn còn lại

Đây là kiểm byte, đường dẫn, giữ nguyên nguồn và khả năng đọc/ghép tại máy. Không có lượt tải cả gói gần 3 GB qua trình duyệt, không tạo draft/đợt, không ghi Shopee, không kiểm lại nội dung từng ảnh. Chưa có kiểm ZIP trong báo cáo này; ZIP cần biên nhận riêng gắn đúng bản thư mục đã chốt.

**18 hồ sơ đầy đủ không đồng nghĩa 18 listing gửi được.** Các ngoại lệ nguồn vẫn giữ nguyên: 38 mô tả nhắc cồn trong khi những nhãn xịt đã xem ghi nguyên chất 100%; bộ mới **Xịt Thơm Hoa Lài cho phòng khách** có câu thành phần hương Hoa Hồng; các bộ còn ảnh sai ngữ cảnh, ảnh dư hoặc thiếu mã SKU vẫn cần quyết định cụ thể. Kết quả giữ nguyên Word không xác nhận nội dung đó đúng. Không kế thừa sửa thành phần, bỏ ảnh hoặc kích thước từ lô thử trước.

Một vấn đề giao diện nhỏ đã ghi riêng: tổng tệp đã đọc ở đầu màn nhập chưa cộng JSON pending, dù bảng pending, lưu/khôi phục và kiểm chặn vẫn hoạt động. Runtime đã chốt, chưa sửa nhãn này. Không coi số hiển thị đó là mất dữ liệu hoặc đổi nguồn để làm hết cảnh báo.
