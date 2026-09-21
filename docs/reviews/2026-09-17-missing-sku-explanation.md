# Vì sao bản đầu có 28 bộ chờ và 444 vị trí chưa chốt SKU

**Cập nhật ngày 17/09: bản sửa v3 đã đối chiếu đủ mã, còn 0 ô thiếu SKU.** Bản sửa đã áp vào thư mục D và ZIP v3; xem biên nhận trong delivery ngày 17/09. 28 bảng vẫn chờ xác nhận cấu trúc, ảnh/nội dung và điều kiện đăng. Các con số 444 bên dưới giải thích bản gốc trước khi người dùng chốt bỏ 260ml, gộp MỚI và xác nhận danh tính lọ treo/nước lau sàn.

**444 là số ô phân loại trong nhiều listing, không phải 444 mã hàng khác nhau.** Trong 28 bộ pending của gói ngày 16/09, chỉ **22 bộ có ô chưa chốt SKU**; **6 bộ đã đủ mã** nhưng còn vướng nội dung, ảnh hoặc công việc cũ. Tổng 28 bộ có 1.526 vị trí, gồm 1.082 vị trí đã ghép mã và 444 vị trí để trống. Nếu chỉ khử trùng chuỗi nhãn phân loại, 444 ô thuộc 47 mẫu nhãn; 47 cũng chưa phải số SKU độc lập vì loại chai, gói bán và nhãn MỚI còn phải được xác định.

## Phân nhóm đủ 444 ô, không đếm trùng

| Lý do ở bản đã bàn giao | Số ô | Thực chất |
| --- | ---: | --- |
| Nhãn **MỚI** chưa được cho phép dùng cùng mã với bản thường | 268 | 228 ô ở 100/300/500ml và 40 ô ở 260ml. Mã cùng mùi/dung tích có thể đã có; không được diễn giải là DORIS thiếu toàn bộ 268 mã. |
| 260ml không tìm được dòng đúng hương và quy cách | 120 | 12 hương × 10 listing; không thay 260ml bằng 300ml hoặc lấy hương khác. |
| 260ml có mã thuộc dòng **xịt phòng máy lạnh** | 40 | 4 hương × 10 listing. Đã tìm thấy mã nhưng chưa chốt đúng dòng sản phẩm; tên ghi 260ml, mã có đuôi 280. |
| **Lọ treo xe 10ml** chưa chốt được đúng loại chai | 14 | Có chai tinh dầu 10ml và nhóm mã đuôi T10 nhưng tên DORIS ghi 8ml; không tự coi là cùng quy cách. |
| **Không Mùi** chưa có xác nhận từ tên DORIS | 2 | Dòng giá chỉ ghi “Nước lau sàn VNT 1 lít”, không ghi “Không Mùi”. |
| **Tổng** | **444** | 56 ô đã có ứng viên trong hồ sơ cũ; 388 ô chưa có ứng viên theo quy tắc cũ. |

Vấn đề **cặp 2 chai** chồng lên 32 ô thiếu trong một listing, không cộng thêm vào 444. Các tổ hợp trong bảng là vị trí để đối chiếu nguồn, chưa mặc nhiên là toàn bộ tổ hợp bán đã được xác nhận.

## Ví dụ truy được tới ô nguồn

Các ô F dưới đây thuộc sheet **01 VINA TUOI** của workbook nội dung. Ô B/E thuộc sheet **FILE GIÁ DORIS**: B là tên hàng, E là SKU. STT là mã nguồn, khác số dòng Excel.

1. **Xịt Khử Mùi Phòng Ngủ Của Bé VINA TƯƠI - Tinh Dầu Hương Dịu Nhẹ 300ml 500ml** (STT 712), ô **F171**: `Bạc Hà (MỚI) × 100ml`. DORIS đã có **VTTDBH100**, B772/E772, “Tinh dầu xịt Bạc hà VNT 100ml”. Bản cũ chưa có quyền coi nhánh MỚI là cùng hàng với nhánh Bạc Hà thường, nên để trống; không phải không tìm thấy Bạc Hà 100ml.
2. **Xịt Thơm Nhà Tắm Nhà Vệ Sinh VINA TƯƠI Hương Thảo - Tinh Dầu Thiên Nhiên 16 Hương 300ml 500ml** (STT 718), **F173**: `Cam Sả (MỚI) × 500ml`. Mã gần nhất đúng mùi/dung tích là **VTTDCS500**, B784/E784. Vướng ở ý nghĩa MỚI, tương tự ví dụ trên.
3. **Chai Xịt Tinh Dầu VINA TƯƠI - Thơm Phòng Ngủ Và Khu Vệ Sinh Khép Kín 300ml 500ml** (STT 713), **F172**: `Hoa Hồng (CAO CẤP) × 260ml`. DORIS có **VTTDHH100/300/500** tại B827:E829, nhưng không có Hoa Hồng 260ml tương ứng. Có hàng khác 260ml như Darling/Honey không tạo thành kết quả khớp Hoa Hồng.
4. Cũng **Chai Xịt Tinh Dầu cho phòng ngủ và khu vệ sinh** (STT 713, tên đầy đủ ở trên), **F172**: `Sả Chanh × 260ml`. Đã tìm thấy **VTXMLSC280**, B864/E864, tên “Xịt thơm phòng máy lạnh Sả chanh VNT 260ml”. Đây là mã có thật; hồ sơ chờ xác nhận loại sản phẩm và mâu thuẫn tên 260ml/mã đuôi 280, không tự đổi dung tích theo mã.
5. **Tinh Dầu Sả Chanh Treo Xe Ô Tô VINA TƯƠI Lọ 10ml Nắp Gỗ - Móc Gương Cho Xe Chạy Dịch Vụ Cả Ngày** (STT 735), **F180**: `Sả Chanh 10ml`. **VTSC10** ở B957/E957 là tinh dầu 10ml, chưa chứng minh chai treo nắp gỗ. **VTSCT10** ở B918/E918 lại ghi tên 8ml, trong khi combo **VT2SCT10** ở B932/E932 ghi “Treo Sả Chanh Combo 2 x 10ml”. Cần chốt đúng quy cách, không suy từ đuôi mã.
6. **Nước Lau Sàn Hương Quế VINA TƯƠI - Sàn Nhà Thơm Ấm Sáu Lựa Chọn Chai 1 Lít** (STT 726), **F176**: `Không Mùi`. Ứng viên **VTKMLS1000**, B1012/E1012, chỉ ghi “Nước lau sàn VNT 1 lít”. Thiếu chữ chỉ hương không đồng nghĩa đã xác nhận không mùi.
7. **Xịt Thơm Tinh Dầu Bạc Hà 100ml VINA TƯƠI - Cặp 2 Chai Bỏ Túi, Mười Sáu Hương** (STT 762), **F191**: `Bạc Hà (MỚI) × 100ml` có mã chai đơn **VTTDBH100**, E772. Ngoài nhãn MỚI, tiêu đề còn yêu cầu cặp 2 chai. Mã combo Bạc Hà ở B775/E775 là **VTTDBH500X2Q100**, tức 2×500ml + 100ml, không phải cặp 2×100ml. Không tự nhân giá hoặc thay bằng combo đó.

## Sáu bộ đã đủ SKU nhưng vẫn pending

| Sản phẩm | Đã có mã | Phần còn chờ |
| --- | ---: | --- |
| **Nến Thơm Hương Trái Cây VINA TƯƠI - Hũ Thuỷ Tinh Cam Ngọt Vỏ Bưởi Vỏ Quýt 100g 200g** (753, F187) | 12/12 | Tiêu đề nói Cam Ngọt/Vỏ Bưởi/Vỏ Quýt nhưng phân loại là Trà Trắng/Hương Thảo/Bạc Hà/Hương Sen/Sả Chanh/Oải Hương; còn đối chiếu ảnh đúng loại sản phẩm. |
| **Xịt Khử Mùi Giày VINA TƯƠI - Tinh Dầu Thiên Nhiên Giày Da Nam 100ml 300ml 500ml** (772, F195) | 48/48 | Đã có nguồn/công việc trong app; đối chiếu công việc cũ và ảnh, không tạo mới lại. |
| **Xịt Khử Mùi Thảm VINA TƯƠI - Tinh Dầu Thiên Nhiên Thảm Sofa Rèm 100ml 300ml 500ml** (775, F196) | 48/48 | Đã có nguồn/công việc trong app; đối chiếu lịch sử và ảnh, không tạo thêm listing. |
| **Xịt Khử Mùi Tủ Giày VINA TƯƠI - Tinh Dầu Thiên Nhiên Cho Đôi Cất Lâu 300ml 500ml** (777, F197) | 48/48 | Đã có nguồn/công việc trong app; đối chiếu công việc cũ và ảnh. |
| **Sả Chanh Chua Nhẹ VINA TƯƠI Chai Xịt Lau Bàn Ăn Mỗi Ngày 100ml Và 500ml - Dọn Cơm Xong Bóp Vài Nhát** (835, F215) | 2/2 | Có nhiều bản Canva, chưa chốt ảnh phù hợp; hồ sơ ghi ảnh khác dòng sản phẩm nguồn. |
| **Sả Chanh Đơn Hương VINA TƯƠI Dung Dịch Lau Đa Năng Chai Xịt 100ml 500ml - Mặt Bếp Xịt Xong Tự Khô** (836, F216) | 2/2 | Cùng vấn đề chọn bản Canva và ảnh đúng dòng sản phẩm. |

## Phản biện và quyết định mới ngày 17/09

Đã đọc lại DORIS, kiểm tên/SKU tới ô gốc và có agent đối chiếu độc lập. Chưa tìm thấy ô trống có một kết quả khớp đầy đủ mà có thể tự áp theo **quyền cũ**. Tuy vậy, cách gọi chung “thiếu SKU” quá rộng: nhiều ô là **chưa chốt danh tính**, và danh sách ứng viên cũ chưa đưa ra nhóm mã T10 ghi 8ml để người vận hành thấy mâu thuẫn. Phân tích này bổ sung chúng, không khẳng định nguồn không có hàng.

Người dùng đã cho phép **bỏ 260ml ở dòng 100/300/500ml**, **bỏ qua các từ MỚI/CAO CẤP khi đối chiếu, giữ đúng mùi+dung tích và dòng sản phẩm**, rồi xác nhận **“Gộp, giữ lựa chọn thường”**. Không có cặp mã thường/cao cấp trùng nhau trong cùng mùi+dung tích thuộc 131 dòng đơn đã kiểm. 228 ô MỚI khớp 12 mã có thật, nhưng đều trùng nhánh thường của chính listing đó; chúng đã được gộp vào nhánh thường theo quyết định mới, không tạo thêm SKU.

Bản sửa **v2 được giữ bất biến để truy vết** đã bỏ 200 vị trí 260ml trong 10 listing và gộp 228 vị trí MỚI trong 19 listing. Cả 19 bộ xịt giữ **16 mùi × 3 dung tích = 48 mã đối chiếu**, đúng thứ tự, nhãn và ảnh của lựa chọn thường. Toàn 46 bộ còn **1.773 vị trí**: 675 trong 18 hồ sơ đầy đủ không đổi và 1.098 trong 28 bảng pending. Tại mốc v2 còn **16 ô chưa chốt ở ba bộ**: lọ treo xe Sả Chanh 10ml có 14 ô; Nước Lau Sàn Hương Quế và Nước Lau Sàn Tinh Dầu Sả Chanh có mỗi bộ một ô Không Mùi. Việc có 48 mã chai đơn không giải quyết vấn đề cặp 2 chai của Xịt Thơm Tinh Dầu Bạc Hà.

Đã chạy parser và hàm ghép dòng SKU thật của ứng dụng trên cả 28 bảng v2: **767/767 kiểm đạt**, không trùng SKU; bảng chưa được tự xác nhận, ba bộ thiếu mã vẫn bị chặn, chọn sai bộ giá vẫn bị chặn. Tên, mô tả Word, ảnh và workbook không sửa. Đã đọc 46 Word và xác nhận không có nội dung 260ml cần đổi; thay đổi chỉ ở cấu trúc phân loại được người dùng cho phép. Thư mục staging: `.local/vina-input-712-836-20260916/revisions/20260917-mapping-v2/`; patch có hash trước/sau và lịch sử từng ô bỏ/gộp. Chưa tự ghi đè thư mục D, ZIP, draft đã lưu hoặc shop.

## Bản v3: chốt 16 ô còn lại theo xác nhận người dùng

Người dùng yêu cầu dựa theo **cột tên sản phẩm DORIS**, xác nhận mã lọ treo có đuôi 10ml nhưng tên hàng 8ml vẫn đúng, và dùng dòng nước lau sàn 1 lít cho lựa chọn Không Mùi. Vì vậy v3:

- Giữ nhãn nguồn **10ml**, ghép 14 hương lọ treo đơn vào đúng B915:B928/E915:E928, giá gốc tại O và cân khai báo tại J cùng dòng. Ví dụ Sả Chanh dùng **VTSCT10**, B918/E918, tên “Tinh dầu Sả chanh VNT 8ml”; không dùng **VTSC10** của chai tinh dầu thường hoặc **VT2SCT10** của combo 2 × 10ml.
- Giữ nhãn **Không Mùi** ở Nước Lau Sàn Hương Quế và Nước Lau Sàn Tinh Dầu Sả Chanh, ghép **VTKMLS1000** ở B1012/E1012, tên “Nước lau sàn VNT 1 lít”, giá gốc O1012 và cân khai báo J1012.
- Không đổi nhãn, thứ tự, ảnh, nội dung Word hoặc số lượng gói bán. Mọi lựa chọn đã có mã trước đó giữ nguyên. Giữ 28 bảng ở trạng thái chờ; không biến chúng thành hồ sơ đầy đủ hoặc tự xác nhận bảng.

V3 thay **22 JSON so với gói D gốc**, gồm 19 bảng đã sửa ở v2 và 3 bảng chốt 16 danh tính. 24 JSON khác giữ nguyên, trong đó 18 hồ sơ đầy đủ. Tổng vẫn **1.773 vị trí, 0 ô thiếu mã**, dùng **82 chuỗi SKU khác nhau**; 28 bảng pending có 1.098 vị trí và cũng chứa đủ 82 mã đó. Thư mục staged v3 chỉ có JSON và hồ sơ kiểm, không sao chép hoặc sửa PNG/Word/Excel. Không áp v3 chồng lên v2: bản bàn giao đích phải khớp hash gốc trước khi thay.

**841/841 kiểm bằng parser thật của ứng dụng đạt** trên 28 bảng pending và 18 hồ sơ đầy đủ. Khi chỉ xác nhận cấu trúc trong bộ nhớ để kiểm, cả 28 bảng ghép đủ dòng SHOP MALL; chọn sai bộ giá hoặc chưa xác nhận cấu trúc vẫn bị chặn. Đây là kiểm bảo toàn nguồn và ánh xạ mã/giá, không chứng nhận nội dung, ảnh hay khả năng đăng. Riêng vấn đề **cặp 2 chai Bạc Hà**, 38 mô tả nhắc cồn và câu Hoa Hồng trong nội dung Hoa Lài vẫn được giữ.

Phản biện riêng đạt **859/859 kiểm, không còn finding**: 16 quyết định khớp ô tên/SKU/giá gốc/cân khai báo thực tế, 22 bản gốc lưu nguyên byte, nhãn/ảnh/thứ tự giữ đúng, v2 bất biến và 7 hướng dẫn/CSV không còn nói 16 hoặc 444 ô là thiếu hiện tại. Hai cột đếm trong CSV không cộng với nhau: 675 vị trí trong hồ sơ đầy đủ là một phần của 1.773 vị trí đã khớp. Hồ sơ `countercheck.json` SHA `e42a318e3726156b1e9c6914914a09b291ce5dc445f01117aab72951211fcb40`; `validation.json` SHA `9d2fa79954928870f34ea5181eac4c9da14ba4a194dd90f74f604e4fca6c47fb`.

Tệp triển khai nằm tại `.local/vina-input-712-836-20260916/revisions/20260917-mapping-v3/`. `operative-guides-manifest.json` chuẩn bị thay hướng dẫn/bảng tình trạng vận hành cũ bằng bản v3 có 0 ô thiếu; báo cáo lịch sử vẫn giữ để truy vết. Việc áp lên D, dựng lại checksum và ZIP do root thực hiện sau khi có kiểm độc lập; báo cáo này không tự thực hiện các bước đó.

## Hồ sơ kiểm

Private JSON: `.local/vina-input-712-836-20260916/missing-sku-explanation.json`, đủ 444 ô của bản cũ và danh sách 28 bộ; phản biện tại `missing-sku-countercheck.json`/`.md`. DORIS đọc ngày 17/09 vẫn SHA `2642c4182a41a39cb01b0acde0f70d5b1c8d50c8daba640c942c281bf5930750`. Workbook nội dung trong Downloads có SHA mới `8aeb4988108e0fa5d16e90c10eb0804664636c2a8f61aa8c96808dc80d41efea`, khác snapshot gói `2b65dda4…`, nhưng đối chiếu độc lập đủ **322 ô A:G của 46 dòng** cho thấy không đổi giá trị/công thức/link, kể cả tiêu đề, nội dung, ID, phân loại và tham chiếu tài liệu. Không có URL Canva trong các ô này; ảnh vẫn gắn với inventory và hash tải trước, không suy Canva trực tuyến chưa đổi. Bằng chứng `selected46-workbook-current-comparison.json`.
