# Chốt nguồn trước khi đăng sản phẩm

Quy tắc này áp dụng cho thao tác tay và các phiên trợ lý khi chuẩn bị, tạo hoặc sửa listing. Mục tiêu là để nguồn thiếu trở thành việc cần bổ sung, thay vì một giá trị tự suy ra rồi được gửi lên Shopee.

## Nguồn được chấp nhận

| Trường | Bằng chứng cần giữ |
| --- | --- |
| Cấu trúc phân loại | Dòng nội dung hoặc chỉ dẫn trực tiếp của người dùng; từng tầng, nhãn và tổ hợp lựa chọn phải khớp. |
| SKU, giá | Đúng bộ giá, sheet, dòng/ô và phiên bản tệp đã chọn; tên sản phẩm, mùi và dung tích phải khớp lựa chọn. |
| Bìa, gallery, ảnh phân loại | Vai trò ảnh được chọn rõ, đường dẫn tệp gốc và dấu kiểm nội dung tệp; không lấy ảnh từ listing khác hoặc tự đổi vai trò. |
| Thuộc tính ngành, thương hiệu, vận chuyển | Dữ liệu shop hiện tại cộng lựa chọn người dùng hoặc dữ kiện đã xác nhận trong nguồn; giá trị lịch sử chỉ là gợi ý. |

Nếu không chứng minh được một trường bắt buộc, dừng riêng listing đó với mã lý do và chỉ đúng nguồn cần bổ sung. Không dùng SKU nội bộ tự tạo, ảnh tìm ngoài thư mục, ảnh gallery thay ảnh mô tả, ngành hoặc thuộc tính suy từ tiêu đề như dữ kiện đã xác nhận. Gợi ý tự động phải hiện rõ là **chưa xác nhận** và không được đi vào bản chốt để đăng trước khi người dùng chọn.

Với bộ nhập có manifest, lúc chuẩn bị đăng backend đọc lại manifest và kiểm đúng từng tầng phân loại, tổ hợp SKU và vai trò ảnh trong chính thư mục listing. Với nháp nhập tay hoặc nháp cũ chưa có manifest, người dùng mở **Kiểm tra listing → Xem bản ánh xạ cần xác nhận**, xem từng SKU/giá/ảnh rồi bấm xác nhận rõ ràng. Biên nhận gắn với đúng phiên bản và dấu kiểm nội dung; sửa nguồn sau đó phải xác nhận lại. Không tạo biên nhận tự động khi lưu nháp.

Lô production cũ không có bằng chứng ánh xạ bất biến bị khóa thao tác **đăng mới/mở bán**. Màn hình vẫn cho xem trạng thái và đối chiếu chỉ đọc; không phát lại lệnh của lô đã tạo hoặc trạng thái chưa rõ. Cần chuẩn bị một lô mới từ nguồn đã đối chiếu, tuyệt đối không sửa manifest cũ để vượt khóa.

## Trước và sau thao tác Shopee

1. Khóa đúng shop, item ID và phiên bản nguồn. Chụp trạng thái hiện tại ngay trước ghi, gồm trạng thái `NORMAL`/`UNLIST` và các trường không thuộc phạm vi sửa.
2. Chỉ ghi các trường người dùng giao. Với tác vụ kích thước, chỉ xóa R–D–C trực tiếp; không tháo tầng phân loại để tạo lại vì có thể làm rỗng SKU, giá, tồn và cân nặng.
3. Sau một lần lưu, đọc lại. Chỉ ghi `verified` khi trường mục tiêu đúng và những trường cần giữ nguyên khớp. Nếu mất phản hồi hoặc có chênh lệch, đọc lại trước khi thử gửi lại; giữ link trong nhóm ngoại lệ và thông báo, không tự sửa trường khác.
4. Khi đối chiếu, phân biệt dữ liệu do thao tác làm đổi với biến động đồng thời như tồn kho giảm vì đơn hàng. Không tự bù tồn hoặc thay trạng thái để ép kiểm tra đạt.

Quét toàn shop chỉ đọc để tìm `1×1×1`; danh sách quét là ảnh chụp theo thời điểm, nên vẫn cần đọc lại từng link ngay trước khi sửa. Báo cáo quét và biên nhận trước/sau được giữ cục bộ dưới `.local/session-dimension-clear-20260924/`.

### Khi giao diện Seller Center hiển thị SKU lệch phân loại

Nếu một dòng trên giao diện có SKU không khớp **cả mùi và dung tích** (ví dụ lựa chọn 500ml nhưng SKU kết thúc `100`), không bấm **Cập nhật** và không sửa theo vị trí dòng. Đọc mới `get_model_list` của đúng shop/item, rồi ghép từng `model_id → model_sku → tier_index → tên lựa chọn ở từng tầng` với dòng SKU/giá trong tệp nguồn. Không dùng thứ tự trả về của mảng `model`, vì thứ tự này có thể thay đổi giữa các lần đọc.

Nếu API mới đúng nhưng giao diện sai, ghi nhận lỗi hiển thị/chưa lưu và kiểm tra lại giao diện; không gửi payload tái tạo phân loại. Nếu API mới cũng sai, giữ listing ở trạng thái hiện tại, lập bảng chênh lệch trước/sau theo `model_id` và xác định thao tác đã gây đổi. Chỉ sửa đúng các binding được chứng minh sai; đọc lại toàn bộ SKU, giá, tồn, ảnh phân loại, video và trạng thái. Kết quả `verified` của lần đăng trước chỉ là bằng chứng **tại thời điểm đó**, không thay cho kiểm tra mới sau các thao tác về sau.

### Phân loại không khớp nguồn, áp dụng cho mọi ngành

Số tầng, tên tầng, tên từng lựa chọn và tổ hợp SKU phải được chốt từ dòng/ô/tệp nguồn của **chính listing** hoặc quyết định rõ của người dùng. So sánh cấu trúc đã chuẩn bị với khai báo này trước khi gửi: một nguồn khai báo hai tầng mà bản chuẩn bị chỉ còn một tầng phải bị giữ riêng, dù SKU và giá trông có vẻ khớp. Quy tắc này không dựa vào chữ “mùi”, “dung tích”, “ml”, tên ngành hay quy luật đặt SKU. Nếu nguồn không khai báo đủ để phân biệt các tầng, chuyển đúng listing sang danh sách cần xác nhận; không tự tách hoặc gộp tầng.

Ảnh cũng phải khớp vai trò và tệp thuộc bộ nguồn của chính listing. Ảnh combo trong bảng giá, ảnh của listing khác và kết quả tìm kiếm chỉ là gợi ý; không tự coi là ảnh phân loại được phép dùng. Với ảnh thiếu hoặc nguồn mâu thuẫn, giữ riêng listing và nêu chính xác ảnh cần bổ sung. Không dùng script ghi trực tiếp bỏ qua bước chốt nguồn, bảng đối chiếu giá và cổng thực thi chung.

Các phép so sánh tự động chạy theo lô trước khi gửi; chỉ listing có ngoại lệ mới cần người xem và quyết định. Lô production mới phải có hợp đồng nguồn gắn với bản nháp đã duyệt; backend so hợp đồng với payload ngay trước bước ghi, kể cả vai trò của từng ảnh. Thiếu hợp đồng nguồn thì không gửi lệnh tạo hoặc cập nhật. Sau ghi vẫn phải đọc lại đúng link, so trạng thái cùng các trường cần giữ nguyên. Việc đọc lại khớp payload chỉ xác minh thao tác ghi, không chứng minh payload đúng nguồn nếu bước chốt nguồn bị bỏ qua.
Với listing đã công khai và có khuyến mãi, đổi từ một tầng sang hai tầng có thể phải tạo lại model, làm đổi `model_id` và liên kết khuyến mãi. Chỉ thực hiện khi đã chứng minh được đường cập nhật giữ hoặc khôi phục an toàn tất cả SKU, giá, tồn, ảnh phân loại, khuyến mãi và trạng thái; nếu chưa, giữ nguyên listing và báo rõ lý do.
### Kiểm tính đầy đủ của ảnh và bố cục mô tả

Đối với bộ nguồn có danh sách ảnh theo vai trò, bản chuẩn bị phải giữ **đúng số lượng, thứ tự và nội dung tệp** ảnh bìa, gallery và ảnh mô tả. Chỉ kiểm “ảnh đã gửi có nằm trong bộ nguồn” là chưa đủ: cách đó cho phép gửi 3/9 ảnh rồi vẫn báo đạt. Bản chốt từ thư mục phải được so lại với manifest của chính thư mục; bản nhập tay phải có quyết định của người dùng gắn với toàn bộ danh sách ảnh. Không mặc định mọi ngành phải có 9 ảnh; số ảnh mong đợi do bộ nguồn hoặc quyết định của người dùng xác định.

Sau đăng, đối chiếu riêng hai câu hỏi: **Shopee đã nhận đúng những gì gửi chưa?** và **bản gửi có đủ theo nguồn đã duyệt chưa?** Chỉ gọi hoàn tất khi cả hai đạt. Văn bản chỉ chứa khoảng trắng giữa hai ảnh mô tả là lỗi bố cục, chặn trước khi gửi. Khi giá lệch vài đồng, đối chiếu giá nguyên theo đúng sheet, ô và phiên bản file; không suy từ mẫu SKU, không tự làm tròn và không dùng giá đang hiện trên listing cũ làm nguồn giá mới.

Ví dụ 26/09/2026: STT 686 “Xịt Thơm Nhà Tắm VUATINHDAU … 300ml 500ml”, item 52418370873, hồ sơ nguồn .local/vtd-next-20260923/prepared-sources.json có g01–g09; báo cáo QC cũ ghi 3 ảnh sản phẩm và 3 ảnh mô tả rồi đánh dấu đạt. Đây là bằng chứng báo cáo cũ chưa phân biệt **tệp ảnh ứng viên** với **danh sách ảnh đã duyệt**; không phải kết luận phải đăng đủ 9. Đọc ảnh cho thấy g04 là cảnh thú cưng, g06 ở ô tô, g05/g09 có cả dung tích 100ml và g08 là mùi Oải Hương; không tự thêm các ảnh này vào link nhà tắm. G07 có bối cảnh nhà tắm và mùi Bạc Hà Lục 500ml, là ứng viên cần đối chiếu với trạng thái hiện tại trước khi cập nhật. Link hiện có video và các chỉnh sửa tay; không ghi đè link đó chỉ để thử cổng kiểm mới.