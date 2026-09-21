# Chuẩn bị thông tin chi tiết theo ngành hàng

Ngày đối chiếu: 15/09/2026. Mục tiêu: nhân viên chỉ bổ sung phần chưa có căn cứ, không nhập lại nội dung, ảnh hoặc giá đã chuẩn bị.

## Những gì ứng dụng biết và chưa biết

API ngành hàng cho biết tên trường, bắt buộc hay không, danh sách lựa chọn, kiểu nhập, đơn vị, số giá trị tối đa và quan hệ cha/con. API không xác định thành phần, xuất xứ hoặc hạn sử dụng thực tế của hàng bên mình. Các dữ kiện đó phải có nguồn sản phẩm.

Luồng production hiện chỉ chạy hai bộ VINA TƯƠI đã được đối chiếu riêng. Chưa có chức năng tự đọc toàn bộ catalog604 rồi điền đúng mọi thuộc tính của mọi ngành. Mẫu Excel điều phối hiện tại cũng chưa phải hợp đồng production đa ngành hoàn chỉnh; không coi nhập được tệp là đủ điều kiện đăng.

## Nhân viên chuẩn bị theo ba lớp

| Lớp | Cần chuẩn bị | Cách tái dùng |
| --- | --- | --- |
| Thông tin chung của nhóm hàng | Thương hiệu, tên và địa chỉ đơn vị chịu trách nhiệm, xuất xứ, chính sách bảo hành nếu có | Một hồ sơ có nguồn, chỉ dùng cho đúng nhóm sản phẩm đã xác định. Không mặc định cả shop đều giống nhau. |
| Thông tin của bộ listing | Ngành hàng dự kiến, dạng sản phẩm, nội dung đã chuẩn bị, link sản phẩm cũ cùng loại để tham khảo | Giữ một bản cho cả listing nếu đúng với mọi phân loại. Hệ thống cần đối chiếu ngành/giá trị hợp lệ trước khi dùng. |
| Thông tin từng SKU | Dung tích, mùi/màu/cỡ, thành phần khác biệt, khối lượng kiện, kích thước, giá theo bộ giá, tồn đăng bán và ảnh phân loại | Ghép bằng SKU đã xác nhận. Không ghép chỉ vì cùng dòng Excel hoặc tên gần giống. |

Với mỗi thông tin cần có giá trị và nơi kiểm lại được: tên tệp + sheet/ô, đoạn Word, nhãn ảnh, hồ sơ sản phẩm hoặc link cũ + ngày đối chiếu. Khi chưa có, ghi **chưa xác định**; không dùng 0, Không hoặc Không áp dụng thay cho thiếu dữ liệu.

## Ví dụ từ hai listing đang thử

| Trường | Can5L nhiều mùi | Xịt Ngọc Lan Tây100/300/500ml |
| --- | --- | --- |
| Thương hiệu | VINA TƯƠI dùng chung | VINA TƯƠI dùng chung |
| Dạng sản phẩm | Dạng lỏng | Dạng xịt |
| Dung tích | 5L đúng cho cả12 phân loại | Ba dung tích khác nhau. Không tự chọn100ml hay500ml làm thuộc tính chung cho cả listing. |
| Mùi hương | 12 mùi khác nhau. Không lấy Hương Thảo trên ảnh bìa để gán cả listing. API hiện cho tối đa5 giá trị mùi ở ngành này, nên không tự chọn5 trong12. | Ngọc Lan Tây dùng chung |
| Xuất xứ, đơn vị chịu trách nhiệm, bảo hành | Chỉ bổ sung khi nguồn đúng phạm vi được xác nhận | Tương tự; không suy từ tên thương hiệu hoặc ảnh có tiếng Việt |

Màn Seller Center hiển thị3/12 là mức độ đã điền, không phải chứng cứ12 trường đều bắt buộc. API thực tế của category101128 trong lượt này trả11 thuộc tính, đều mandatory=false; thương hiệu là trường riêng. Cũng xuất hiện trường Tires Size (Installation). Không điền kích thước lốp cho tinh dầu để tăng số hoàn thành; đây là bất thường cần giữ lại trong quan sát metadata.

## Cách tổ chức phần cần bổ sung

Mục tiêu giao diện tiếp theo là một bảng ngoại lệ gồm: bộ listing/SKU, tên thông tin bằng tiếng Việt, giá trị từ nguồn, nguồn tham khảo, lý do cần kiểm tra và giá trị được chốt. Có thể áp một giá trị cho nhiều dòng được chọn khi chắc chắn chúng cùng phạm vi. Không bắt nhân viên tra mã attribute/value; phần ánh xạ mã thuộc trách nhiệm phần mềm.

Đây là hướng triển khai tiếp, chưa phải xác nhận giao diện bảng thuộc tính động đã hoàn tất. Luồng hiện có vẫn cần chuẩn bị và đối chiếu nguồn trước khi đưa vào bộ production được phép.

## Nguồn và phạm vi

- Tài liệu chính thức: https://open.shopee.com/documents/v2/v2.product.get_attribute_tree?module=89&type=1 ; bản lưu `knowledge-base/shopee-open-platform/documents/api/en/v2.product.get_attribute_tree.md`, nguồn cập nhật13/01/2025, thu thập08/09/2026.
- Đã đọc mới trực tiếp API production cho shop1423724897, category101128 ngày15/09; phản hồi nguyên nằm trong `.local/production-pilot-1423724897/preflight/` với tên `attributes.json`. Metadata quan sát không tự trở thành dữ kiện sản phẩm hoặc quy định áp cho shop khác.
- Nguồn kinh doanh: workbook nội dung VINA TƯƠI, bảng giá DORIS, ảnh Canva và các xác nhận cụ thể của người dùng. Không sửa nguồn để đạt số lượng thuộc tính.
