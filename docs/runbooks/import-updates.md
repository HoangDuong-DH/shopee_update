# Nhập bộ cập nhật

Luồng này nhận Excel, Word và ảnh đã chuẩn bị, đối chiếu với bản nguồn của công việc, rồi lưu các thay đổi được chọn tại ứng dụng. **Chưa gửi lên Shopee.** Dữ liệu bên trái là bản nguồn đã lưu, không phải dữ liệu shop vừa đọc.

## Thao tác

1. Tại **Công việc đăng hàng**, mở **Nhập bộ cập nhật**. Có thể bắt đầu từ một công việc đã gắn đúng bộ listing, shop và link cần cập nhật.
2. Chọn các công việc đích. Nhập một hoặc nhiều tệp, hoặc thư mục chứa các bộ cập nhật. Không cần mang lại các tệp của phần muốn giữ nguyên.
3. Excel: chọn đúng sheet/khối/bộ giá và nhóm công việc áp dụng cho từng bộ. Một file có thể thêm nhiều sheet/bộ giá, mỗi bộ có đích riêng; có thể chọn cả nhóm công việc của một shop. Các dòng ghép theo SKU chính xác trong phạm vi đó. Word: chọn nguyên đoạn tiêu đề/mô tả, không gõ lại. Ảnh: chọn công việc nhận và vai trò; có thể chọn nhiều ảnh rồi gán vai trò cùng lúc. Một ảnh được dùng đồng thời cho gallery và mô tả nếu bạn chọn cả hai. Thay cả gallery cần lựa chọn rõ ràng, thứ tự được giữ.
4. **Xem thay đổi** chuyển sang màn đối chiếu riêng: kiểm shop, listing, SKU, giá trị trước/sau và vị trí nguồn. Giá/tồn có bảng đối chiếu, nội dung/ảnh có phần xem trực quan. Bỏ chọn phần chưa muốn lưu. Các ngoại lệ phải được xử lý theo dòng/tệp; không sửa nguồn để ép kiểm tra đạt.
5. **Lưu bộ cập nhật**. Mở lại từ danh sách bộ cập nhật đã lưu hoặc công việc liên quan. Biên nhận giữ lựa chọn, nguồn và phiên bản đích; lưu không sửa bản nguồn chung hay trạng thái lần gửi sandbox cũ.

## Excel giá/tồn

- Cần cột SKU và ít nhất một trường cập nhật được nhận diện. Không bắt cột tên sản phẩm, Word hay ảnh khi chỉ đổi giá/tồn.
- `GIÁ GỐC` là giá gốc; `GIÁ BÁN` được nhận diện là mục tiêu khuyến mại và báo cần luồng riêng.
- `TỒN ĐĂNG BÁN` là tồn đăng bán do bên vận hành quyết định. Ứng dụng không lấy số tồn vật lý làm mặc định.
- Ô trống là giữ nguyên; số tồn `0` là giá trị cụ thể. Công thức lỗi, công thức chưa có kết quả và giá trị sai kiểu là ngoại lệ.
- Giữ SKU dạng chữ để bảo toàn số 0 đầu và khoảng trắng có trong mã nguồn. Không tự sửa/chuẩn hóa mã SKU để ghép.
- Bảng nhiều bộ giá cần phạm vi cột rõ ràng. Một cột tồn duy nhất không tự được áp cho mọi shop/bộ giá. Cột/bố cục chưa hỗ trợ được nêu rõ; chưa có bộ ánh xạ cột tùy ý cho mọi workbook.

## Word và ảnh

- Không có Word trong đợt thì không đổi tiêu đề/mô tả. Không có ảnh được chọn cho một vai trò thì giữ phần đó.
- Nhập bìa mới riêng không yêu cầu bảng giá, Word hoặc gallery. Không tự crop, tạo ảnh hoặc đổi tệp gốc.
- Mô tả Word mới kèm ảnh cần chọn rõ vị trí ảnh nếu ranh giới câu mở đầu/phần còn lại chưa được xác nhận. Ứng dụng không lấy bố cục cũ làm bằng chứng cho cấu trúc Word mới.
- Thay riêng bộ ảnh mô tả chỉ dùng lại phần chữ khi bố cục nguồn đã lưu được xác định. Bố cục khác giữ ngoại lệ. Xóa và thay bằng bộ ảnh rỗng chưa được hỗ trợ.
- Mở lại cùng biên nhận không đồng nghĩa ứng dụng đã tự nhận diện mọi thư mục mới ở lần nhập sau; các ánh xạ mới/mơ hồ vẫn cần xác nhận.
- Mỗi tệp Word/ảnh hiện chọn một công việc đích trong đợt. Một ảnh có thể có nhiều vai trò trong công việc đó; mỗi vai trò có thứ tự riêng.

## Lưu lại và phục hồi

Nhập lại cùng ý định có thể trả biên nhận cũ, kể cả file Excel đã Save As. Đây là chống trùng đề xuất nội bộ, chưa phải chứng minh chống bù tồn sau khi có đơn trên Shopee. Yêu cầu chủ động đặt lại cùng số tồn trong tương lai cần lệnh thực thi mới có phiên bản và bằng chứng riêng.

Các lựa chọn nhập chưa bấm lưu chưa được tự lưu toàn bộ. Ứng dụng cảnh báo trước khi rời; nên lưu bộ cập nhật trước khi đóng phiên làm việc.

Nếu mất phản hồi sau lưu, ứng dụng giữ chính xác yêu cầu trong phiên trình duyệt và khóa chỉnh sửa trong lúc chưa rõ kết quả. Có thể tải lại trang rồi xác nhận lại bằng yêu cầu cũ; không tạo một yêu cầu khác chỉ vì chưa nhìn thấy kết quả. Nếu đã đóng mất phiên, tra danh sách bộ cập nhật đã lưu trước khi tạo yêu cầu mới. Công việc hoặc nguồn đã đổi sau bước xem trước cần được đối chiếu lại; biên nhận cũ vẫn giữ nguyên để tra cứu.

## Phạm vi chưa phát hành

Luồng này chưa tự tìm tất cả listing/model trên shop, chưa thực thi patch đa trường, chưa kiểm giá/khuyến mại/QC trên Shopee, chưa tự refresh token hoặc chạy hàng đợi doanh nghiệp 24 giờ. Các hạn chế được giữ hiển thị; nguồn và đề xuất không bị đổi để che các bước còn thiếu. Shop thật vẫn chỉ đọc, Lamy sandbox đang cần đối chiếu bìa vẫn giữ trạng thái cũ.
