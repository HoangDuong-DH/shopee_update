# Chuẩn bị một bộ listing để bàn giao đăng Shopee

Phiên bản ngày 16/09/2026. Dành cho nhân viên chuẩn bị dữ liệu và người nhập liệu. Sau khi lưu nguồn, làm tiếp theo [Từ thư mục nguồn đến đăng ẩn và mở bán](dang-hang-tu-bo-listing-da-luu.md).

**Một thư mục là một listing đã được bên mình quyết định sẵn.** Giữ nguyên nội dung, ảnh, các phân loại và thứ tự đã chuẩn bị. Dùng bảng giá chung; không chép lại giá vào từng Word.

File Excel mẫu hai sheet đi kèm là **phiếu bàn giao để đối chiếu**; ứng dụng chưa tự nhập mẫu phiếu này thành toàn bộ listing. Khác với phiếu đó, hồ sơ `listing-source.json` đi kèm thư mục đã được ứng dụng nhận để ghép Word, ảnh, SKU và giá; `listing-mapping.pending.json` giữ bảng phân loại còn thiếu để bổ sung từng ô trong ứng dụng. Giữ các hồ sơ này cùng nguồn gốc, không tự sửa mã nhận diện. Không chọn phiếu bàn giao làm bảng giá DORIS.

## 1. Sắp thư mục

Ví dụ dưới đây là cách đặt tên dễ nhận biết. Không bắt buộc đổi tên ảnh cũ. Trong phiếu bàn giao, ghi đúng tên tệp thực tế.

```text
DOT_DANG_2026-09-15/
├── Bang_gia/
│   └── FILE GIÁ DORIS.xlsx
├── Phieu_ban_giao/
│   ├── VINA-CAN-5L.xlsx
│   └── MA-BO-TIEP-THEO.xlsx
└── Listing/                         ← chọn thư mục này khi nhập nhiều bộ
    ├── VINA-CAN-5L/
    │   ├── Noi_dung.docx
    │   └── Anh/
    │       ├── anh-bia.png          ← ảnh bìa 1:1 đã có
    │       ├── g1.png               ← ảnh sản phẩm 3:4, thứ tự 1
    │       ├── g2.png
    │       ├── ...
    │       ├── g9.png
    │       ├── ten-anh-phan-loai-A.png
    │       └── ten-anh-phan-loai-B.png
    └── MA-BO-TIEP-THEO/
        ├── Noi_dung.docx
        └── Anh/
            └── ...
```

Chọn `Listing` khi dùng chế độ **Mỗi thư mục con là một listing**. Không chọn cả `DOT_DANG_2026-09-15`, vì ứng dụng sẽ hiểu cả `Bang_gia` và `Phieu_ban_giao` là listing. Bảng giá được chọn ở mục riêng.

Ảnh phân loại có thể nằm chung với bìa và ảnh sản phẩm. Không cần chia lại nếu bộ cũ đã như vậy. Một ảnh được dùng cho nhiều vai trò hoặc nhiều SKU thì ghi lại đúng cùng đường dẫn ở các vị trí cần dùng. Việc được Shopee chấp nhận còn phụ thuộc cấu trúc phân loại và quyền của shop.

**Tên `g1.png` tự nó không quyết định vai trò ảnh.** Nếu có hồ sơ nguồn đầy đủ, ứng dụng dùng vai trò và thứ tự trong hồ sơ; nếu chưa có, người nhập chọn bìa, ảnh sản phẩm và ảnh mô tả trên màn hình. Luôn đối chiếu ảnh thật, không đưa toàn bộ ảnh nháp/ảnh trắng/ảnh lưu tham khảo vào gallery chỉ vì chúng cùng thư mục.

## 2. Chuẩn bị Word

Dùng tệp `.docx` chứa chữ có thể chọn và sao chép. Ảnh nằm trong Word không được bộ đọc hiện tại lấy thành ảnh listing; cần bàn giao thêm ảnh gốc riêng.

Với bộ mới, có thể dùng hai dòng nhãn dưới đây. Đây là nhãn để đọc file, không phải phần tiêu đề hay mô tả sẽ đăng.

```text
TIÊU ĐỀ
[Một dòng tiêu đề đã được chuẩn bị]

MÔ TẢ SẢN PHẨM
[Nội dung đã được chuẩn bị, giữ nguyên cách xuống dòng]
```

Hai nhãn xuất hiện một lần. Giữa hai nhãn chỉ để một dòng tiêu đề. Nếu Word cũ có cấu trúc khác, giữ tệp gốc và chỉ rõ vị trí tiêu đề/mô tả; không tự viết lại nội dung. Khi cấu trúc cả đợt giống nhau, người nhập có thể lưu cách đọc Word một lần cho cả đợt.

Nếu muốn câu mở đầu trước ảnh mô tả, ghi rõ câu đó và chọn **Dòng đầu của phần nội dung, đặt trước ảnh**. Ghi thứ tự ảnh mô tả riêng, ví dụ `g1, g2, …, g9`, cùng yêu cầu dòng trống trước/sau ảnh. Giữ g1 nếu bộ nguồn có g1.

Nếu shop không được dùng ảnh trong mô tả, ghi ngoại lệ và xin quyết định cụ thể. Không tự bỏ ảnh hay thay nội dung. Riêng phép thử can 5L đã được chủ shop đồng ý dùng mô tả chữ và giữ đủ g1–g9 trong bộ ảnh sản phẩm.

## 3. Điền phiếu bàn giao

Mỗi listing dùng một bản sao file mẫu. Trong sheet **Bộ listing**, điền các ô màu vàng. Trong sheet **Phân loại**, mỗi dòng là một SKU thực sự bán trong listing. Phần ví dụ can 5L phía dưới chỉ để tham khảo; không đưa vào listing mới.

| Nhóm | Nhân viên cần cung cấp | Có sẵn thì làm thế nào? |
| --- | --- | --- |
| Nhận diện | Mã bộ nội bộ, thư mục, shop đích, đăng mới hay cập nhật | Dùng mã ổn định, ví dụ `VINA-CAN-5L`. Mã bộ là tên hồ sơ nội bộ, không tự đổi SKU. |
| Nội dung | Tệp Word đúng phiên bản, vị trí tiêu đề/mô tả | Bàn giao file, không chép lại nội dung vào phiếu. |
| Ảnh | Bìa; danh sách ảnh sản phẩm theo thứ tự; ảnh mô tả và vị trí chèn; ảnh từng phân loại | Ghi đường dẫn tương đối trong thư mục listing, ví dụ `Anh/ten-anh.png`. Giữ nguyên ảnh gốc. |
| Phân loại | Tên nhóm 1/2, nhãn từng lựa chọn, thứ tự, SKU tương ứng | Sao chép đúng bản đã chốt. Không xóa khoảng trắng, đổi tên, tự tạo tổ hợp hoặc gộp/tách combo. |
| Giá | Tệp bảng giá, sheet và bộ giá được phép áp dụng cho shop | Đối chiếu theo SKU chính xác. Không điền lại giá vào phiếu mới. |
| Tồn | Mức tồn đăng bán do người phụ trách quyết định cho từng SKU/shop | Ghi số nguyên. Trống nghĩa là chưa quyết định, **0 là muốn hết hàng**. Không tự điền 100. |
| Giao hàng | Cân nặng khai báo, kích thước kiện sau đóng gói, thời gian chuẩn bị khi có yêu cầu | Ghi nguồn và đơn vị. Có trong DORIS thì dẫn nguồn, chỉ bổ sung phần thiếu/khác. |
| Chi tiết sản phẩm | Thương hiệu, ngành dự kiến, thuộc tính, tài liệu/nhãn chứng minh | Có link sản phẩm cũ phù hợp thì gửi link để tham khảo. Không tự sao chép toàn bộ thuộc tính. |
| Điểm chưa rõ | Ví dụ SKU thiếu giá, ảnh và Word khác thành phần, chưa biết dung tích | Ghi cụ thể để người phụ trách giải quyết; không đoán cho đầy ô. |

**Phân loại hai tầng:** mỗi dòng ghi đủ lựa chọn tầng 1 và tầng 2 của SKU đó. Thứ tự các lựa chọn được xác định bằng lần xuất hiện đầu tiên trong bảng. Ảnh thường gắn với lựa chọn tầng đầu; nếu hai SKU cùng lựa chọn tầng đầu yêu cầu ảnh khác nhau, ghi ngoại lệ để kiểm tra khả năng hỗ trợ trước. Không ép hai ảnh khác nhau thành một.

**Không có phân loại:** một dòng SKU, tên nhóm và các ô lựa chọn để trống. Nếu nguồn yêu cầu cấu trúc vượt khả năng hiện tại, giữ nguyên và báo người phụ trách.

## 4. Dùng bảng giá và tồn cho đúng

Với `FILE GIÁ DORIS.xlsx`, sheet `FILE GIÁ DORIS`, bộ **SHOP MALL**: cột E là SKU, O là **GIÁ GỐC**, P là **GIÁ BÁN** mục tiêu khuyến mại. Listing mới dùng GIÁ GỐC. GIÁ BÁN không tự tạo giảm giá hoặc Flash Sale.

Chọn bộ giá theo quyết định kinh doanh cho shop đó. Không thấy giá thường thì không tự lấy giá Mall thay thế. Một SKU có nhiều dòng không rõ nguồn, ô trống, hoặc công thức không có giá trị đọc được phải được đối chiếu trước.

Tồn đăng bán có thể là tồn ảo theo quyết định của shop. Phiếu này không tự bù tồn sau đơn hàng. **100/SKU trong ví dụ can 5L là quyết định riêng cho phép thử đó**, không phải mặc định cho mọi sản phẩm. Lô khác chỉ dùng mức tồn đã được xác nhận cho đúng danh sách SKU và shop của lô ấy.

## 5. Cân nặng, kích thước và thuộc tính

- **Cân nặng khai báo:** dùng gram trên phiếu. DORIS có cân nặng thực ở I và cân nặng khai báo ở J; không đánh đồng hai cột. Hệ thống đổi gram sang kg khi gửi, giữ nguồn và giá trị chính xác. Không tự làm tròn cho bằng giá trị đọc lại.
- **Kích thước kiện:** dài × rộng × cao, đơn vị cm, sau đóng gói. Ghi rõ đã đo hay ước lượng; ước lượng phải có người quyết định. SKU khác kiện có thể cần số đo riêng.
- **Thương hiệu/ngành:** dùng tên dễ hiểu. Nhân viên không cần tìm mã API. Người nhập kiểm tra ngành và thương hiệu khả dụng trên đúng shop.
- **Thuộc tính:** ghi tên thuộc tính, giá trị và nơi kiểm chứng, ví dụ dung tích trên nhãn, hạn dùng trên hồ sơ. Listing cũ là tham khảo; không chứng minh mọi tuyên bố đều đúng cho sản phẩm mới.
- Word, ảnh, bảng giá hoặc nhãn mâu thuẫn: đánh dấu phần mâu thuẫn và bàn giao. Không tự đổi thương hiệu, thành phần hay công dụng để qua kiểm tra.

## 6. Nhập và đối chiếu trong ứng dụng hiện tại

1. Mở **Kho listing → Nhập Word / ảnh / bảng giá**. Trong màn **Kho đầu vào**, bấm **Nhập thư mục listing**.
2. Chọn **Bảng giá chung**, **Sheet chứa giá**, **Bộ giá áp dụng**. Dùng DORIS đã nhập nếu đúng bản.
3. Chọn đúng thư mục `Listing` và chế độ **Mỗi thư mục con là một listing**, rồi **Đọc các thư mục**. Một bộ đơn lẻ dùng chế độ một listing.
4. Chọn từng bộ. Hồ sơ đầy đủ sẽ chọn sẵn theo mapping; phần chưa có hồ sơ cần chọn vai trò ảnh theo phiếu. Ở **Word & nội dung**, kiểm tiêu đề, câu mở đầu, mô tả và xuống dòng. Không tự viết lại nội dung để qua cảnh báo.
5. Ở **SKU & phân loại**, đối chiếu số SKU, tên, thứ tự, ảnh và giá. Nếu có **Bảng phân loại chờ hoàn thiện**, giữ đủ mọi dòng **CHƯA CÓ SKU**, điền mã thật đúng dòng giá và xác nhận **Dùng đủ N phân loại trong bảng này** khi đã kiểm cấu trúc. Không bỏ lựa chọn hoặc tạo mã giả. Còn thiếu thì vẫn lưu lại để làm tiếp, chưa thể chuyển thành nguồn gửi.
6. Chờ **Đã lưu vào Kho đầu vào**. Mở lại đúng đợt tại Kho đầu vào sẽ giữ phần SKU đã bổ sung và bộ giá đang chọn. Nếu đổi bộ giá, đối chiếu lại giá và mọi dòng khớp. Khi đã đủ, bấm **Xem và hoàn thiện nội dung**, kiểm bố trí/ảnh rồi lưu bộ listing riêng.
7. Khi nhận lại cùng hồ sơ và cùng nguồn, dùng **Mở bộ đã lưu** nếu ứng dụng đã nhận diện. Khi báo khác phiên bản hoặc khác giá/nội dung/ảnh, đối chiếu bản cũ; không đổi mã bộ để tạo thêm bản trùng.
8. Sau khi lưu, mở **Đăng hàng → Chuẩn bị lô mới**. Kiểm đúng shop, tồn, ngành, thuộc tính và vận chuyển; chọn **Đăng ẩn để QC**. Chuẩn bị đợt chỉ lưu công việc; nút đăng ẩn mới bắt đầu gửi. Xem [hướng dẫn đăng ẩn và QC](dang-hang-tu-bo-listing-da-luu.md) cho bước tiếp.

Nguồn có ID LISTING trống mang ý định đăng mới nhưng vẫn phải kiểm lịch sử gửi. Có ID thì đi theo cập nhật đúng link/shop; luồng tạo mới sẽ chặn. Luồng cập nhật production đầy đủ từ thư mục chưa nối hoàn chỉnh, nên không xóa ID để vượt chặn. ID sai hoặc chưa rõ chủ shop cần được xác định lại.

Hồ sơ đầy đủ giúp tránh gõ lại dữ liệu; vẫn phải kiểm điều kiện hiện tại của shop trước khi gửi. Bộ nguồn VINA TƯƠI ngày 16/09 gồm 46 sản phẩm: **18 hồ sơ tự điền/675 dòng SKU theo listing và 28 bảng phân loại chờ hoàn thiện**. Đây là số nguồn đã ghép, không phải số listing đã đăng hoặc sẵn sàng mở bán. Bắt đầu nhập một sản phẩm; với gói được chia nhóm, dùng từng nhóm 4–6 sản phẩm/tối đa 500 MiB và chờ lưu xong. Không chọn cả thư mục bàn giao chứa báo cáo và bảng giá làm một bộ listing.

Bản portable ở `D:/VINA_TUOI_712_836_20260916/Bo_nguon` có tám nhóm **Nhap_01…Nhap_08**; mỗi nhóm được nhập ở chế độ **Mỗi thư mục con là một listing**. Tra tên đầy đủ trong `BANG_THU_MUC_NHAP.csv`, đọc `BAT_DAU_TAI_DAY.txt` và chọn DORIS từ **Tệp chung** riêng. Các hồ sơ và ảnh đã được kiểm trên bản portable; điều đó chưa thay cho kiểm nội dung và điều kiện gửi. Xem [hướng dẫn từ nhập nguồn đến đăng ẩn](dang-hang-tu-bo-listing-da-luu.md).

**Công cụ điều phối cũ:** mục thu gọn **Đăng hàng → Chuẩn bị lô mới → Công cụ chuẩn bị lô khác** có công cụ Excel điều phối riêng. Đây không phải đường đăng production từ bộ listing đã lưu ở các bước trên. Excel thiếu sheet `Điều phối listing` chưa được dùng để xem trước trong công cụ cũ.

Mẫu điều phối tải tại màn này là **mẫu kỹ thuật cho công cụ sandbox hiện tại**, khác phiếu bàn giao hai sheet trong tài liệu. Bộ đọc này yêu cầu Word gồm liên tiếp: một đoạn `TIÊU ĐỀ`, một đoạn tên sản phẩm, một đoạn `BÀI MÔ TẢ ĐĂNG BÁN`, rồi các đoạn mô tả. Giá và điều phối phải ở cùng workbook. Hiện chỉ nhận một thuộc tính/một giá trị và một kênh vận chuyển; chưa phải mẫu đầy đủ để nhân viên tự đăng production đa ngành. Người phụ trách chuẩn bị bản phù hợp từ nguồn gốc; không yêu cầu nhân viên tự đoán mã ngành/thuộc tính hoặc chép dữ kiện không có nguồn.

## 7. Ví dụ đối chiếu can 5L

Tên listing: **Can 5 Lít Một Hương Duy Nhất VINA TƯƠI - Bản Tiếp Liệu Rót Đầy Bình Xịt Thơm**. Shop phép thử: **vuatinhdau.vn**. Một nhóm tên **Phân loại 1**, giữ đúng thứ tự 12 SKU dưới đây.

| Thứ tự | Tên lựa chọn | SKU | Dòng DORIS |
| --- | --- | --- | --- |
| 1 | Sả Java 5L | VTSJC5L | 1021 |
| 2 | Hoa Lài 5L | VTHLC5L | 1023 |
| 3 | Bạc Hà Lục 5L | VTBHLC5L | 1026 |
| 4 | Bạch Đàn Chanh 5L | VTBDCC5L | 1027 |
| 5 | Bạc Hà 5L | VTBHC5L | 1019 |
| 6 | Hương Thảo 5L | VTHTC5L | 1028 |
| 7 | Cam Sả 5L | VTCSC5L | 1022 |
| 8 | Vỏ Quế 5L | VTVQC5L | 1025 |
| 9 | Rừng Thông 5L | VTRTC5L | 1029 |
| 10 | Sả Chanh 5L | VTSCC5L | 1018 |
| 11 | Oải Hương 5L | VTOHC5L | 1024 |
| 12 | Trà Trắng 5L | VTTTC5L | 1020 |

Mỗi SKU có GIÁ GỐC **2.179.998đ** theo cột O, tồn thử được cho phép **100**, cân nặng khai báo **5.225g** theo cột J. Kiện **25 × 20 × 35cm** là **ước lượng được chủ shop cho phép**, chưa phải số đo thực tế. Ví dụ dùng đủ bìa, 9 ảnh sản phẩm và 12 ảnh phân loại gốc. File Excel ghi đúng tên tệp ảnh phân loại đã đối chiếu; số trong ngoặc của tên ảnh không phải thứ tự SKU.

Nội dung lấy từ phiên bản được chủ shop xác nhận gần nhất. Với bộ này, phần “nguyên chất 100%” đã được chủ shop xác nhận thay cho nội dung thành phần mâu thuẫn trước đó; không dùng bản Word/ảnh cũ trái với quyết định đó mà chưa đối chiếu. Ví dụ không phải yêu cầu tạo thêm một bản can 5L.

## 8. Kiểm trước khi bàn giao

- [ ] Một bộ có đúng một listing, đúng phiên bản Word và đủ ảnh gốc.
- [ ] Đã ghi shop và bộ giá; không phải chỉ ghi “giá DORIS”.
- [ ] Số dòng SKU bằng số phân loại thực sự muốn bán; giữ nguyên tên và thứ tự.
- [ ] Mỗi dòng xác định rõ ảnh hoặc ghi lý do không có ảnh riêng; không đoán bằng số thứ tự tệp.
- [ ] Tồn mỗi SKU đã được quyết định; ô chưa rõ được để trống và ghi ngoại lệ.
- [ ] Cân nặng/kích thước có đơn vị và nguồn, ước lượng có xác nhận.
- [ ] Thương hiệu, ngành, thuộc tính có nguồn phù hợp; mâu thuẫn đã ghi lại.
- [ ] Nếu là cập nhật, có link listing đích và danh sách trường muốn đổi. Trường không chọn phải giữ nguyên.

## Ghi chú đối chiếu cho người phụ trách triển khai

Hướng dẫn đối chiếu với giao diện và luồng lưu ngày 16/09/2026. Hồ sơ JSON đầy đủ và bảng chờ bổ sung đã có đường tiếp nhận riêng; mẫu Excel hai sheet bàn giao vẫn là tài liệu đối chiếu. Việc triển khai phiên bản/migration trên máy vận hành phải theo checkpoint kỹ thuật mới nhất, không suy ra từ tài liệu thao tác này.

Ví dụ lấy từ DORIS gốc và hồ sơ phép thử can 5L bản nguồn 4, ngày 15/09/2026. Giá, ảnh và cấu trúc phân loại được đối chiếu theo từng SKU. Trạng thái đăng/publish phải xem biên nhận mới nhất trong ứng dụng; tài liệu này hướng dẫn chuẩn bị nguồn, không xác nhận trạng thái đăng.
