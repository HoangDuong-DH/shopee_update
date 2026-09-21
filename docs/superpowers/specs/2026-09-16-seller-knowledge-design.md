# Kiến thức từ listing đã đăng — thiết kế 16/09/2026

Người dùng yêu cầu triển khai cơ chế đọc listing cũ của shop hiện tại, mở rộng nhiều shop sau này, tiết kiệm token và không tin máy móc dữ liệu đã đăng. Đây là quyền đọc và lưu kiến thức nội bộ; không phải quyền tự sửa tất cả listing được thu thập.

## Luồng và ranh giới

Kết nối shop đã xác minh → công việc đồng bộ GET có checkpoint → PostgreSQL lưu quan sát và bằng chứng → metadata ngành có hạn → bộ đề xuất xác định bằng chương trình → người vận hành đối chiếu nguồn sản phẩm.

- Không đọc đơn hàng, người mua, tài chính hoặc cookie trình duyệt. Token giữ server; adapter mới chỉ cho GET phục vụ sản phẩm/metadata.
- Scope đầy đủ environment/partner/shop và connection revision. Không dùng ID shop thử làm mặc định cho shop khác.
- Lưu listing/item SKU/model SKU/category/brand/attribute, trạng thái, observedAt, source request ID và hash. Quan sát cũ bất biến, con trỏ hiện tại riêng; nhiều lần thấy cùng dữ liệu không trở thành nhiều phiếu chứng minh.
- Đồng bộ có ngân sách, cache, thời gian cập nhật, khóa theo kết nối, trạng thái đang chạy/gián đoạn/tiếp tục/đủ hoặc chưa đủ phạm vi. Mất kết nối không được coi là xóa listing. Chỉ GET được retry có giới hạn.
- Không chạy LLM cho việc phân trang, chuẩn hóa, đối chiếu ID, kiểm schema, loại trùng và tra cứu. Agent nhận kết quả nhỏ, có nguồn, cho các ngoại lệ cần suy xét.

## Đề xuất có căn cứ

Metadata mới xác định kiểu nhập, đơn vị, số giá trị, giá trị cho phép. Nguồn sản phẩm xác định sự thật; dữ liệu shop chỉ là tham khảo. SKU trùng mạnh hơn chỉ cùng tên/ngành; khác shop không tự áp. Không chọn phần nhiều để che mâu thuẫn. Giá trị cũ, ngành khác, brand khác, thuộc tính không còn hợp lệ hoặc không liên quan đều có lý do loại/chờ.

Source fact được người vận hành khai báo có locator có thể điền bản xem trước khi hợp lệ; không có API ghi Shopee trong mô-đun này. Đặc tính an toàn, xuất xứ, hạn dùng, đơn vị chịu trách nhiệm và bảo hành không được suy ra chỉ từ tần suất các listing. Không lấy một dung tích/mùi của một SKU áp cả listing nhiều phân loại. Phân biệt coverage đủ hay chỉ một phần SKU.

## Giao diện và nghiệm thu

Trong Tra cứu & kiểm tra thêm Kiến thức từ shop: chọn tên shop, Đồng bộ dữ liệu, trạng thái phạm vi/lỗi/tiếp tục, tìm tên/SKU, xem bằng chứng và đề xuất bổ sung cho listing. Tên sản phẩm là nhãn chính; code/ID dùng truy vết phụ. Không có nút tự ghi tất cả đề xuất lên shop.

Kiểm thử bắt buộc: shop isolation, wrong/revoked connection, repeated request, partial page/cap/resume, API lỗi200, schema/count/unit/custom type3, nguồn cũ/mâu thuẫn, trùngSKU nhưng thiếu coverage, dữ kiện nguồn thắng tham khảo, không có write transport. Test giả lập nhiều shop tách với một shop thật được kết nối. Lần đồng bộ thực tế hiện tại chỉ shop vuatinhdau.vn; báo rõ số listing/GET/thời gian và không gọi đây là nghiệm thu nhiều shop thật/24h.
