# Từ thư mục nguồn đến đăng ẩn và mở bán

**Cập nhật lô VINA TƯƠI 46 bộ ngày 17/09/2026:** dùng [hướng dẫn bản v3](thu-nghiem-46-listing-vinatuoi.md). Đã khớp đủ 1.773 vị trí với 82 mã SKU; 28 bảng vẫn cần xác nhận ảnh/nội dung/cấu trúc. Hướng dẫn bổ sung SKU dưới đây là cơ chế chung, không phải trạng thái thiếu mã của lô v3.

Cập nhật theo giao diện ngày 16/09/2026. Chọn và trao đổi theo **tên sản phẩm**, chẳng hạn **Xịt thơm Cam Sả cho phòng và khoang xe** hoặc **Xịt khử mùi thảm VINA TƯƠI**. Mã bộ chỉ để đối chiếu hồ sơ; ID Shopee là mã listing trên shop.

Luồng chính: **Nhập thư mục → Lưu bộ listing → Chuẩn bị lô mới → Đăng ẩn → Kiểm tra → Mở bán từng listing**. Đọc tệp, lưu nguồn và chuẩn bị đợt chưa gửi sản phẩm lên Shopee. Các nút **Đăng ẩn**, **Tiếp tục listing này** và **Mở bán listing này** có thể gọi API thật.

## 1. Nhập đúng bộ nguồn và bộ giá

1. Mở **Kho listing → Nhập Word / ảnh / bảng giá → Kho đầu vào → Nhập thư mục listing**. Chọn một thư mục sản phẩm, hoặc thư mục cha với chế độ **Mỗi thư mục con là một listing**. Bảng giá chọn riêng; không chọn cả thư mục bàn giao chứa tài liệu hướng dẫn làm một listing.
2. Chọn **Bảng giá chung**, **Sheet chứa giá**, **Bộ giá áp dụng** đúng với shop. Nếu hồ sơ chỉ xác định tệp và sheet, bạn vẫn phải chọn bộ giá. Có giá SHOP MALL không có nghĩa mọi shop được dùng giá đó.
3. Bấm **Đọc các thư mục**, rồi mở từng sản phẩm. Bộ có `listing-source.json` đã giữ cách ghép Word, ảnh, SKU và thứ tự; đối chiếu phần ứng dụng đọc được. Tệp ảnh nháp, ảnh trắng hoặc bản thừa được lưu để tham khảo không tự trở thành ảnh đăng.
4. Chờ dòng **Đã lưu vào Kho đầu vào**. Đây là lưu đợt nhập; khi sang màn nội dung, vẫn cần lưu bộ listing riêng.

GIÁ GỐC dùng khi đăng mới. GIÁ BÁN là giá mục tiêu cho công việc khuyến mại riêng. Không chép giá bằng tay để làm hết cảnh báo hoặc tự lấy một bộ giá khác thay cho ô trống.

Với gói lớn, bắt đầu bằng **một sản phẩm**. Nếu gói bàn giao có các nhóm nhập sẵn, chọn nguyên một nhóm khoảng **4–6 sản phẩm, tối đa 500 MiB**, rồi chờ lưu xong trước khi sang nhóm khác. Ứng dụng đọc tất cả tệp trong thư mục đã chọn; chọn một sản phẩm trong danh sách xem không có nghĩa chỉ tải sản phẩm đó. Đây là cách dễ theo dõi và phục hồi, không phải giới hạn API. Chưa nghiệm thu nhập cả gói gần 3 GB trong một phiên trình duyệt.

Bản thư mục portable ngày 16/09 ở `D:/VINA_TUOI_712_836_20260916/Bo_nguon` đã chia **Nhap_01 đến Nhap_08**. Mở `BAT_DAU_TAI_DAY.txt` trước; dùng `BANG_THU_MUC_NHAP.csv` để tìm sản phẩm theo tên đầy đủ. Chọn một nhóm `Nhap_XX` với chế độ **Mỗi thư mục con là một listing**; nếu thử một sản phẩm thì chọn thẳng thư mục sản phẩm đó và chế độ một listing. Bảng giá DORIS nằm riêng trong **Tệp chung**. Không chọn cả `Bo_nguon`, thư mục báo cáo hoặc ảnh cách ly làm nguồn listing.

Bộ nguồn VINA TƯƠI gồm **46 sản phẩm: 18 hồ sơ tự điền với 675 dòng SKU trong các listing, và 28 bảng phân loại chờ hoàn thiện với 1.098 dòng đã khớp mã**. Dòng SKU được đếm theo listing, không phải 675 mã hàng khác nhau. Đã nhận 53 bản Canva và 1.327 PNG gốc; ảnh trắng được lưu riêng ngoài phần nhập. Đây là kết quả kiểm dữ liệu đầu vào, **chưa phải 46 listing đủ điều kiện đăng**. Vẫn cần giải quyết nội dung/ảnh mâu thuẫn và các lựa chọn vận hành của từng sản phẩm. Trạng thái đóng gói ZIP và triển khai ứng dụng có biên nhận riêng, không suy từ số nguồn này.

Bản thư mục portable đã được đọc lại bằng parser và bộ ghép nguồn của ứng dụng; byte Word/ảnh trong tám nhóm giữ nguyên. Xem [phạm vi kiểm bản bàn giao](../reviews/2026-09-16-portable-source-bundle.md). Việc nhập qua trình duyệt và lưu listing vẫn là bước người vận hành thực hiện.

## 2. Bổ sung SKU còn thiếu và làm tiếp sau

Thư mục có `listing-mapping.pending.json` mở **SKU & phân loại → Bảng phân loại chờ hoàn thiện**. Tên lựa chọn, các tầng và thứ tự giữ theo hồ sơ; các ô **CHƯA CÓ SKU** vẫn được giữ đủ.

1. Điền mã SKU thật vào đúng ô, đối chiếu với bảng giá đang chọn. Không bỏ dòng còn thiếu, dùng mã tạm hoặc thay nhãn “MỚI” bằng sản phẩm khác cho dễ khớp.
2. Kiểm số lượng và cấu trúc, rồi chọn **Dùng đủ N phân loại trong bảng này**. Chỉ chọn khi đây đúng là danh sách cần bán.
3. Chờ lưu xong. Có thể rời trang và mở lại đúng đợt trong **Kho đầu vào** để tiếp tục các ô còn thiếu; không cần làm lại bảng. Nếu thấy lỗi lưu, giữ trang và dùng **Thử lưu lại**. Nếu có bản mới hơn, mở bản đã lưu để đối chiếu.
4. Khi mọi SKU khớp duy nhất với dòng giá hợp lệ, bấm **Xem và hoàn thiện nội dung**. Đây là bước mở bản nháp, chưa phải xác nhận đủ điều kiện gửi.

Nếu đổi bộ giá, kiểm lại toàn bộ dòng khớp và giá trước khi tiếp tục. Giá thiếu hoặc nhiều dòng còn mơ hồ sẽ giữ bộ ở trạng thái cần bổ sung.

## 3. Lưu và mở lại đúng listing

Đối chiếu tiêu đề, mô tả, bố trí nội dung, bìa, ảnh sản phẩm và ảnh phân loại; giữ đúng thứ tự nguồn. Sau đó lưu bộ listing. Bản đã lưu mặc định chỉ xem; dùng **Điều chỉnh nội dung và ảnh** khi thực sự cần sửa.

Khi nhận lại cùng thư mục có hồ sơ nguồn, ứng dụng đối chiếu với bản đã lưu để dùng lại đúng bộ. Nếu có **Mở bộ đã lưu**, mở bộ đó. Nếu báo nội dung, ảnh, SKU hoặc bộ giá khác, kiểm lại phiên bản; không đổi mã bộ để né đối chiếu và tạo một listing trùng.

| ID LISTING trong nguồn | Đường xử lý |
| --- | --- |
| Trống | Có ý định đăng mới; vẫn kiểm lịch sử để tránh tạo lại nguồn đã gửi. |
| Có ID hợp lệ | Có ý định cập nhật đúng link, đúng shop. Nút **Mở Cập nhật listing** dẫn sang công việc cập nhật; luồng cập nhật production toàn bộ nội dung/ảnh/phân loại từ thư mục chưa nối hoàn chỉnh. Không xóa ID để đăng mới. |
| ID sai hoặc chưa rõ shop sở hữu | Dừng để xác định lại; không tự chuyển sang đăng mới. |

Lô thử Hương Thảo, Hoa Hồng, Hoa Lài và Cam Sả đã đăng ký trước có hướng dẫn riêng tại [Tự đăng ẩn bốn listing còn lại](tiep-tuc-4-listing-2026-09-16.md). Không nhập lại hoặc đổi nguồn của công việc đó theo quy tắc lô mới.

## 4. Chuẩn bị đợt đăng ẩn

1. Mở **Đăng hàng → Chuẩn bị lô mới**, chọn bộ listing đã lưu, tối đa 80 bộ mỗi lần. Chuyển giữa **Đợt đang làm** và **Chuẩn bị lô mới** vẫn giữ lựa chọn đang nhập.
2. Kiểm shop đích. Điền tồn đăng bán theo quyết định cho đúng SKU/shop; **0 là một lựa chọn, ô trống là chưa quyết định**. Không kế thừa tồn hoặc kích thước từ lô thử trước.
3. Chọn ngành, thương hiệu, tình trạng hàng và thời gian chuẩn bị; bổ sung thuộc tính và kích thước có nguồn. Cân nặng từng SKU đã có thì giữ theo nguồn. Gợi ý từ listing cũ chỉ là tham khảo; chỉ dùng dữ kiện đúng sản phẩm đã được xác nhận.
4. Tại **Kho áp dụng → Chọn listing tham khảo kho**, chọn sản phẩm của đúng shop và chờ xác nhận đã đối chiếu cấu hình kho. Chọn vận chuyển phù hợp. Thiếu bảng kích thước, thương hiệu hoặc bằng chứng kho thì xử lý phần thiếu; không đổi ngành để qua kiểm tra.
5. Giữ lựa chọn **Đăng ẩn để QC**. Tùy chọn **Mở bán sau kiểm tra** là chế độ tự mở bán, không dùng nếu muốn kiểm tra tay trước. Chế độ đã lưu trong đợt không tự đổi theo lựa chọn của lô sau.
6. Nếu có quyết định thử đăng ẩn trước khi kiểm ảnh, chọn rõ **Tạm hoãn kiểm tra ảnh để thử đăng ẩn**. Nội dung, SKU, giá và tồn vẫn phải được đối chiếu; ảnh sẽ có nhãn **Ảnh chưa QC**.
7. Bấm **Kiểm tra … listing đã chọn**, xem phần đủ nguồn/cần bổ sung và đối chiếu giá, tồn, phân loại. Sửa thông tin sau khi kiểm tra thì phải kiểm tra lại. Bấm **Chuẩn bị đợt cho … listing đủ nguồn** để lưu công việc; bước này chưa gửi Shopee.

## 5. Đăng ẩn, kiểm tra và mở bán

Để xử lý cả lô, bấm **Đăng ẩn các listing đã chuẩn bị**. Để làm từng sản phẩm, vào **Đợt đang làm**, tìm đúng tên, bấm **Kiểm tra listing này**, rồi **Đăng ẩn listing này**. Theo dõi từng dòng; không bấm nhiều lần khi đang xử lý.

| Trạng thái | Ý nghĩa và bước tiếp |
| --- | --- |
| Đã chuẩn bị | Công việc lưu trong ứng dụng; chưa phải sản phẩm đã đăng. |
| Đã tạo, chờ đối chiếu | Đã có listing trên shop. Xử lý phần khác biệt hoặc đọc lại, không tạo lại. |
| Đã tạo ẩn · Ảnh chưa QC | Đã hoàn tất phần đăng ẩn theo lựa chọn hoãn ảnh; chưa được coi là ảnh đạt và chưa thể mở bán. |
| Đã tạo và đối chiếu đạt, vẫn ẩn | Kiểm tra listing rồi xác nhận mở bán riêng. |
| Đã mở bán và đối chiếu đạt | Đã hoàn tất bước mở bán. |

Nếu có **Xem chênh lệch cân nặng**, xem số nguồn, số Shopee lưu và từng SKU. Chỉ chấp nhận mức làm tròn khi đúng quyết định vận hành; nguồn không bị sửa. Với đợt hoãn ảnh, sau khi lưu phiếu cân, bấm **Tiếp tục listing này** để hoàn tất đăng ẩn.

Khi sẵn sàng kiểm ảnh của listing đã hoãn QC:

1. Bấm **Chỉ đọc đối chiếu** để tạo hồ sơ ảnh nếu chưa có.
2. Vào **Công cụ → Kiểm tra ảnh**, chọn đúng sản phẩm/ID Shopee, xem và lưu kết quả.
3. Quay lại nhóm, bấm **Chỉ đọc đối chiếu** lần nữa để kiểm đầy đủ.
4. Khi nút đã đủ điều kiện, chọn **Tôi đã kiểm tra listing này và đồng ý mở bán**, rồi **Mở bán listing này**. Đây là thao tác chuyển riêng sản phẩm đó từ ẩn sang công khai.

## 6. Khi gián đoạn hoặc bị chặn

- Mất phản hồi: **Đọc lại đợt đăng**, dùng **Đọc lại để phục hồi** nếu được yêu cầu. Giữ công việc cũ; không tạo lô khác để gửi lại từ đầu.
- Lần kiểm tra nguồn chưa nhận được kết quả: dùng **Lấy lại kết quả kiểm tra trước**. Nếu đã đổi thông tin, kiểm tra lại lựa chọn mới.
- Hàng đợi tạm dừng: xử lý đúng sản phẩm đang báo lỗi rồi tiếp tục công việc đã lưu. Chấp nhận cân nặng không tự chạy tiếp hàng đợi.
- Kết nối hết hạn, ảnh quá giới hạn, SKU/giá/nội dung không khớp hoặc ngành thiếu quyền: xử lý nguyên nhân hiển thị; không sửa nguồn để làm hết cảnh báo.

Các bộ Word, ảnh, SKU và giá có liên kết đầy đủ vẫn cần giới hạn hiện tại của shop và thông tin kinh doanh phù hợp. Hoàn tất nhập nguồn hoặc kiểm thử tại máy không đồng nghĩa đã đăng hay đã nghiệm thu mọi ngành, nhiều shop và vận hành liên tục.

**Ngoại lệ nguồn đã phát hiện:** bộ mới **Xịt Thơm Hoa Lài VINA TƯƠI — cho phòng khách 100ml, 300ml** có tên/cam kết Hoa Lài nhưng câu thành phần trong Word ghi hương **Hoa Hồng**. Giữ bộ để người phụ trách xác nhận bản sửa; không tự sửa hoặc dùng kết quả kiểm “giữ nguyên nguồn” làm xác nhận nội dung đúng. Đây là bộ nguồn mới, khác công việc Hoa Lài thuộc lô thử đã đăng ký trước.
