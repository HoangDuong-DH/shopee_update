# Tra cứu kiến thức từ listing của shop

Mục này giúp tìm lại listing, SKU và thông tin ngành đã đọc từ Shopee. Dữ liệu shop là nguồn tham khảo có ngày đọc; thông tin đúng của sản phẩm vẫn phải có nguồn sản phẩm hoặc xác nhận rõ ràng.

## Đồng bộ và tìm sản phẩm

1. Mở **Tra cứu & kiểm tra → Kiến thức từ shop**, chọn đúng tên shop.
2. Bấm **Đồng bộ dữ liệu**. Hệ thống chỉ đọc sản phẩm và ngành, rồi lưu vào kho nội bộ. Không đăng hoặc chỉnh listing.
3. Xem trạng thái công việc. Hết ngân sách mỗi lượt thì bấm **Tiếp tục** để đi tiếp từ vị trí đã lưu. Không tạo lại một công việc chỉ vì màn hình tải chậm.
4. Tìm theo tên sản phẩm hoặc SKU; có thể gõ không dấu. Bảng ưu tiên sản phẩm đang mở bán hoặc đang ẩn còn tên. Mở **Bằng chứng** để xem listing nào, shop nào, ngày đọc, cảnh báo và phản hồi nguồn.
5. Xem **Đề xuất bổ sung** để đối chiếu các lựa chọn hợp lệ của ngành với nguồn sản phẩm. Một đề xuất không phải lệnh cập nhật Shopee.

Kho shop vuatinhdau.vn đã đọc ngày 16/09/2026 có **57 listing hiện có** (4 mở bán, 53 ẩn) cùng **73 dấu vết listing đã xóa**. Dấu vết đã xóa không còn đủ tên/nội dung, không dùng làm nguồn gợi ý. Chúng được ghi rõ **Listing đã xóa**, xếp sau sản phẩm hiện có và chỉ cho xem dấu vết. Có thể tìm đúng mã item khi cần đối chiếu lịch sử.

## Cách hiểu cảnh báo

| Hiện tượng | Cách xử lý |
| --- | --- |
| Công việc đang chạy | Chờ hoàn tất; không cần tạo công việc trùng. |
| Hết giới hạn lượt đọc | Bấm Tiếp tục; dữ liệu đã đọc được giữ nguyên. |
| Kết nối/token thay đổi hoặc hết hạn | Hoàn tất kết nối đúng shop, rồi tiếp tục công việc. Không đổi shop để vượt lỗi. |
| Shopee không trả danh sách thuộc tính | Listing vẫn có trong kho, nhưng thuộc tính là chưa biết và bị loại khỏi nguồn đề xuất. Cần đọc lại hoặc đối chiếu nguồn. |
| SKU phân loại trống/trùng | Kiểm lại SKU theo từng model. Không dùng SKU cha hoặc một SKU đơn để đại diện cho mọi phân loại. |
| Không đọc được phí vận chuyển ước tính | Thông tin thuộc tính vẫn có thể đọc khi cảnh báo đúng loại đã nhận diện. Phí và cấu hình vận chuyển chưa được xác minh. |
| Nguồn cũ, trái nhau hoặc thiếu phạm vi SKU | Giữ trạng thái chờ; mở bằng chứng và xác nhận bằng nguồn sản phẩm. Không chọn giá trị xuất hiện nhiều nhất. |
| Dữ liệu ngành hết hạn | Khi xem đề xuất, hệ thống cần đọc lại metadata mới trước khi đánh giá giá trị. |

## Xác nhận thông tin sản phẩm

Chỉ lưu thông tin khi có tài liệu hoặc người có trách nhiệm đã xác nhận, với vị trí nguồn và phạm vi SKU rõ ràng. Tên công ty, địa chỉ, xuất xứ, hạn dùng, bảo hành và tuyên bố an toàn không được tự suy từ sản phẩm khác.

Đối với **xịt khử mùi thảm VINA TƯƠI**, người dùng đã xác nhận cho toàn bộ 48 SKU: xuất xứ Việt Nam, hạn dùng 36 tháng, tổ chức chịu trách nhiệm CÔNG TY TNHH VINA TƯƠI và không bảo hành. Kho nội bộ đã lưu năm trường tương ứng của ngành. **Địa chỉ tổ chức chưa có nguồn và còn để trống.**

Các dữ kiện được chấp nhận chỉ đủ điều kiện điền bản xem trước trong ứng dụng. Mô-đun này chưa có thao tác tự áp các trường đó lên listing Shopee.

## Phạm vi đã kiểm

Lần đọc lại 130 bản ghi trạng thái dùng 13 GET trong khoảng 7,5 giây, tái dùng 126 bản ghi. Bốn listing thiếu thuộc tính được đọc lại và giữ cảnh báo. Đây là hiệu quả đọc dữ liệu, không phải tốc độ đăng hàng.

Chưa nghiệm thu nhiều shop thật hoặc tự chạy liên tục 24 giờ. Không dùng kết quả một shop để khẳng định quyền API, ngành hoặc thông tin của shop khác. Xem [hồ sơ bàn giao ngày 16/09](../delivery/2026-09-16-seller-knowledge.md) để biết bằng chứng và giới hạn.
