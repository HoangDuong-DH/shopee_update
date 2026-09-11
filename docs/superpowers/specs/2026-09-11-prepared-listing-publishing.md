# Đăng bộ listing có sẵn, kiểm trường theo shop và ngành

Ngày xác nhận: **11/09/2026**. Đây là làm rõ yêu cầu và tiêu chí triển khai A2/A4/B1/B3/C4 của kế hoạch đã có. Không phải báo cáo các tính năng bên dưới đã chạy production.

## 1. Đơn vị vận hành

Bên người dùng đã chuẩn bị sản phẩm, một listing gồm những SKU nào, tiêu đề, tên/thứ tự phân loại, bộ ảnh, nội dung và dữ liệu bán hàng. Ứng dụng nhận **bộ listing đã chuẩn bị**, xác định đúng shop đích, ánh xạ dữ liệu sang trường Shopee, kiểm tra, đăng và đọc lại kết quả.

- Một bộ listing có mã ổn định do nguồn/mapping đã xác nhận định danh, danh sách SKU, phiên bản nguồn và shop đích. Tên file giống nhau hoặc SKU xuất hiện nhiều chỗ không đủ để tự ghép sản phẩm.
- Không tự gộp/tách link, thêm/bớt combo, tự sinh tổ hợp phân loại, đổi tên/thứ tự hoặc ghép bộ ảnh từ listing khác. Nhiều SKU không có nghĩa nhiều link.
- Tiêu đề, nội dung, xuống dòng, nhãn phân loại, thứ tự/và vai trò ảnh lấy từ nguồn. Với bộ Lamy đã xác nhận: bìa riêng 1:1, gallery 3:4, đủ g1–g9 trong mô tả sau câu mở đầu và dòng trống.
- Ảnh gốc bất biến; không crop, ghép chữ, sinh ảnh hoặc thay ảnh để vượt giới hạn. Nếu Shopee xử lý media hoặc thay mã ảnh, lưu cả nguồn và kết quả; không khẳng định ảnh tải về từ sàn sẽ có cùng bytes với nguồn.
- Chỉ chuyển cách biểu diễn kỹ thuật đã xác minh, như ánh xạ tên thuộc tính sang ID hoặc đổi đơn vị rõ nghĩa sang đơn vị API. Giữ giá trị gốc, phép chuyển và giá trị gửi để đối chiếu. Không làm tròn/cắt chữ ngầm khi ảnh hưởng ý định người dùng.
- GIÁ GỐC dùng cho đăng mới; GIÁ BÁN vẫn là mục tiêu khuyến mại riêng. Tồn đăng bán phải là lệnh theo SKU/shop, không sao chép mức thử của Lamy sang sản phẩm khác.
- Nếu người dùng yêu cầu chỉnh một phần, tạo phiên bản mới cho đúng phần đó. Cập nhật link đang tồn tại phải chọn đúng item/model và trường muốn cập nhật; không thay thế link hoặc đăng lại để xử lý lỗi.

## 2. Trường theo ngành: quy tắc động, dữ kiện từ nguồn

Ngữ cảnh kiểm tra gồm môi trường, app, shop, thị trường/loại shop, ngành lá và phiên bản quyền/quy tắc. Không dùng một biểu mẫu Lamy cố định cho toàn bộ danh mục.

| Nhóm | Cơ chế cần triển khai | Khi chưa đủ cơ sở |
| --- | --- | --- |
| Ngành Shopee | Lấy cây ngành theo shop, khớp đúng ngành lá của nguồn và lưu tên/ID | Không tự chọn ngành gần giống hoặc đổi ngành để đăng được |
| Thuộc tính | Đọc bắt buộc/tùy chọn, kiểu dữ liệu, chọn một/nhiều, đơn vị, số giá trị, nhánh cha/con và tra giá trị khi API yêu cầu | Hiện đúng trường cần đối chiếu; không đoán thuộc tính từ ngành, ảnh hoặc sản phẩm khác |
| Thương hiệu | Đối chiếu thương hiệu nguồn với danh sách/ngành/trạng thái áp dụng | Không tự đổi sang No Brand, đăng ký thương hiệu hoặc coi pending là được duyệt |
| Tên, mô tả, ảnh, giá, tồn | Đọc giới hạn theo đúng scope; kiểm giữ nguyên nguồn và đúng vai trò ảnh | Báo vượt giới hạn, không tự cắt/bỏ nội dung, giảm số ảnh hoặc đổi giá |
| Phân loại | Giữ đúng cấu trúc không phân loại/một tầng/hai tầng của nguồn trong phạm vi API hỗ trợ; khớp SKU và tổ hợp thay vì vị trí mảng | Không tự đổi cấu trúc; trường hợp nhiều tầng/hình ảnh chưa hỗ trợ giữ ngoại lệ rõ |
| Định danh, bảng cỡ, chứng từ, vận chuyển | Kiểm yêu cầu ngành/shop và khả năng endpoint tương ứng; dùng dữ liệu vận hành được xác nhận | Thiếu quyền/API hoặc chưa kiểm được: ghi cần xử lý riêng, không âm thầm bỏ trường |

Quy tắc API không bao phủ toàn bộ chính sách và QC. Bổ sung quy định chính thức có ngày hiệu lực; quan sát Seller Center là nguồn vận hành có phạm vi, không tự thành quy định. Dữ liệu đủ chuẩn API vẫn có thể bị Shopee kiểm duyệt; trạng thái gửi thành công, đọc lại đúng và QC phải tách riêng.

Mapping lưu theo mẫu nguồn/shop/ngành có phiên bản để dùng lại, **không lưu một bộ giá trị mặc định áp cho mọi sản phẩm**. Khi đổi ngành, scope hoặc nguồn quy tắc, kiểm lại các mapping và công việc chưa gửi. Chỉ loại bỏ/đổi giá trị nguồn khi có quyết định cụ thể của người dùng.

## 3. Giao diện mục tiêu

Luồng mặc định: **Nhập bộ listing → Đối chiếu → Đăng lô → Theo dõi kết quả**. Các bước đăng lô/đọc lại/QC chưa có trong executor hiện tại.

1. **Nhập bộ listing:** chọn workbook/nội dung/bộ ảnh đã chuẩn bị và shop đích. Dùng mapping đã xác nhận hoặc nhận diện có đối chiếu. Nếu nguồn đã rõ cấu trúc, không buộc chọn lại từng SKU, chép Word từng đoạn hay gán lại từng ảnh. Cấu trúc mơ hồ cần xác nhận một lần rồi lưu mapping có phiên bản.
2. **Bảng chờ đăng:** mỗi dòng là một bộ listing cho một shop. Cột: ảnh bìa, mã bộ, tiêu đề nguồn, ngành, số SKU, khoảng GIÁ GỐC, ảnh/nội dung, kết quả kiểm tra. Lọc theo shop, ngành và lỗi. Trạng thái rõ: Sẵn sàng / Thiếu nguồn / Cần đối chiếu / Chưa hỗ trợ.
3. **Chi tiết đối chiếu:** bản xem trước dùng dữ liệu nguồn, cạnh bảng `Trường | Giá trị nguồn | Giá trị gửi Shopee | Nguồn | Kết quả`. Mặc định xem; chỉ mở điều chỉnh khi có thao tác cụ thể của người vận hành. Thuộc tính theo ngành tự hiện, trường không áp dụng được giải thích; không hiển thị một form trống bắt làm lại listing.
4. **Đăng lô:** chọn những dòng đã đủ điều kiện, xem số link/SKU theo từng shop và nội dung sẽ gửi, rồi ra lệnh đăng. Lỗi một listing được tách riêng; các dòng độc lập được phép chạy tiếp. Giữ pause/resume và bằng chứng chống gửi trùng.
5. **Kết quả:** link/item/model đã tạo, tiến độ tải ảnh/gửi/đọc lại, sai lệch theo trường, trạng thái QC và hành động cần người xử lý. Có phản hồi API chưa đủ để hiện “Hoàn tất”.

Các nhãn “tạo bản nháp/chuẩn bị listing” hiện có chỉ là lưu dữ liệu nội bộ phục vụ đăng. Chúng không được dẫn luồng sản phẩm sang soạn nội dung mới hoặc tự thiết kế link cho người dùng.

## 4. Khoảng trống được kiểm trong mã ngày 11/09

- `Editor.tsx` mới chỉnh một tầng phân loại và chọn Word/ảnh thủ công; chưa có trình nhập trọn bộ listing theo manifest/mapping tổng quát. Luồng nhập hiện ráp câu mở đầu → ảnh → phần chữ còn lại; đây là bố cục đã xác nhận cho Lamy, không được tự ép lên nguồn khác có bố cục riêng. Bố cục khác cần giữ thứ tự block theo nguồn hoặc cấu hình mà người dùng đã chọn.
- `product-service.ts` chưa nhận đủ ngành/thương hiệu/thuộc tính/vận chuyển từ nguồn; `attributes` và `logistics` đang để rỗng. Có type trong contract không chứng minh đã hỗ trợ E2E.
- Giá/SKU có nguồn ô Excel; nội dung chọn qua UI chưa lưu đầy đủ liên kết tới đoạn Word theo mapping có phiên bản.
- Chưa có renderer/validator thuộc tính theo ngành, bảng coverage endpoint/chứng từ, chọn cột mơ hồ, giao diện tồn thủ công và đủ nhánh phân loại.
- Backend mới kiểm kết nối bằng đọc shop; chưa có executor ghi listing, readback listing hoặc QC. Các test Lamy local và get_shop_info không chứng minh đã bao phủ nhiều ngành.

## 5. Tiêu chí nghiệm thu bổ sung

- Bộ nguồn đầu vào và bản gửi giữ nguyên tiêu đề, phần chữ/xuống dòng, số link, danh sách/thứ tự SKU/phân loại và ảnh. Mọi chuyển đổi kỹ thuật phải có nguồn và phép đối chiếu riêng.
- Không phân loại, một tầng và hai tầng có ca thử độc lập; hai listing trùng tên/SKU không bị tự gộp. Chạy lại công việc không tạo link trùng.
- Ca thiếu thuộc tính bắt buộc, nhánh thuộc tính con, đơn vị sai, giá trị không còn hỗ trợ, thương hiệu chưa khớp và thay ngành đều phải chặn đúng trường; không tự chọn giá trị thay thế.
- Ca đổi shop Mall/thường phải tải lại scope phù hợp và kiểm riêng; không suy mọi shop cùng thị trường có cùng quyền/giới hạn.
- Mỗi ngành thực sự đưa vào lô production cần ít nhất bộ nguồn đại diện đầy đủ và bằng chứng kiểm qua luồng áp dụng; lập bảng “đã nghiệm thu/chưa nghiệm thu/cần bước riêng”. Số ngành không phải con số bảo đảm tự động bao phủ.
- Nội dung/ảnh chỉ hiển thị đúng trên Seller Center hoặc có chuyển đổi phía Shopee cần bước kiểm riêng. Dữ liệu không có endpoint hỗ trợ không được âm thầm bỏ để báo PASS.

## 6. Nguồn và giới hạn tra cứu

- [Product creation preparation — Guide 209](https://open.shopee.com/developer-guide/209), snapshot 08/09, ngày bài 19/09/2025: cây ngành theo shop, ngành lá, thuộc tính, thương hiệu và giới hạn. Không áp dụng nguyên các đoạn đã cũ về size chart.
- [Creating product — Guide 211](https://open.shopee.com/developer-guide/211), snapshot 08/09, ngày bài 19/09/2025: cách biểu diễn giá trị, media và cấu trúc phân loại. Ví dụ trong guide không phải payload sản phẩm người dùng.
- [get_attribute_tree](https://open.shopee.com/documents/v2/v2.product.get_attribute_tree?module=89&type=1), lịch sử mới nhất hiển thị 13/01/2025; đọc toàn bộ snapshot và đối chiếu phần tham số/lịch sử trực tiếp trên Console ngày **11/09/2026**. API dùng `mandatory`; một đoạn Guide 209 ghi `is_mandatory`, cần theo schema API đã xác minh và response thực khi triển khai.
- [get_item_limit](https://open.shopee.com/documents/v2/v2.product.get_item_limit?module=89&type=1), lịch sử mới nhất hiển thị 08/01/2025; đọc toàn bộ snapshot, đối chiếu trực tiếp ngày **11/09/2026**. Có giới hạn tên/mô tả/ảnh, bắt buộc cân nặng/kích thước/bảng cỡ, GTIN. Mô tả min/max price có chỗ đảo nghĩa và đường dẫn GTIN chưa nhất quán trong bản trích; không lấy ví dụ làm giới hạn hoặc tự chốt adapter khi chưa kiểm response.
- [get_category](https://open.shopee.com/documents/v2/v2.product.get_category?module=89&type=1) và [get_brand_list](https://open.shopee.com/documents/v2/v2.product.get_brand_list?module=89&type=1): đã đọc toàn bộ snapshot 08/09; quyền/giá trị thực của shop production chưa kiểm.
- [Thông báo 1010](https://open.shopee.com/announcements/1010), hiệu lực 25/10/2024, sunset API size chart cũ 27/12/2024: dùng trường giới hạn mới thay cho đoạn hướng dẫn cũ. Không bật liên kết sản phẩm chuẩn hoặc chức năng thay nội dung nguồn trong thông báo này.

Đối chiếu tài liệu live là đọc trang tài liệu, **không phải đã gọi thành công các API trên bằng app và không phải đã kiểm thử ngành hàng của shop thật**.
