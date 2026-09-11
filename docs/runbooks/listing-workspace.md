# Hướng dẫn dùng ứng dụng listing nội bộ

Cập nhật ngày **11/09/2026**. Mở http://127.0.0.1:5173/ trên máy đang chạy ứng dụng. Nút **Hướng dẫn** trong ứng dụng cũng mở các bước sử dụng cơ bản.

Ứng dụng tiếp nhận bộ listing công ty đã chuẩn bị, gồm danh sách SKU, tên phân loại, nội dung và ảnh. Luồng chính bắt đầu từ **thư mục của từng listing**. Trang **Công việc đăng hàng** gắn một bản nguồn với một shop để theo dõi phần cần xử lý. Bản hiện tại có phép cập nhật giới hạn cho Lamy sandbox; **shop thật chỉ đọc, chưa có đăng mới hàng loạt**.

## Các nơi làm việc chính

| Mục | Dùng khi nào |
| --- | --- |
| **Công việc đăng hàng** | Chọn bộ đã có, shop đích, công việc đăng mới/cập nhật; xử lý ngoại lệ và theo dõi phép thử sandbox |
| **Listing của tôi** | Mở bộ đã lưu hoặc nhập các thư mục listing đã chuẩn bị |
| **Kho đầu vào** | Bảng giá dùng chung, các đợt thư mục đang làm và bộ listing đã tiếp nhận |
| **Kết quả** | Xem bản kiểm tra theo shop và trạng thái công việc; bản kiểm tra nội bộ chưa phải kết quả đăng Shopee |

## Nhập các listing bằng thư mục

Vào **Kho đầu vào → Nhập thư mục listing** hoặc **Listing của tôi → Nhập listing có sẵn**. Màn hình **Nhập listing theo thư mục** giữ bảng giá, danh sách thư mục và phần xem nguồn trên cùng một trang. Mỗi nút nhập mới bắt đầu một đợt mới; để tiếp tục công việc cũ, mở đúng đợt trong Kho đầu vào.

### Chọn bảng giá chung một lần

Chọn **Bảng giá chung → Sheet chứa giá → Bộ giá áp dụng**. Nếu chưa tải Excel, bấm **Tải bảng giá chung** ngay tại đây, hoặc vào tab **Bảng giá chung** trong Kho đầu vào. Khu này chỉ nhận Excel; Word/ảnh được nhận theo thư mục. Các thư mục trong đợt được đối chiếu với lựa chọn này; không phải tải lại bảng giá cho từng listing. Bản giá mới được giữ riêng, không tự thay nguồn của đợt cũ.

Bảng giá dùng để tìm SKU và giá. Những SKU cùng nằm trên một sheet không tự chứng minh chúng thuộc cùng listing. Nếu SKU không có hoặc khớp nhiều dòng, kiểm tra lại đúng sheet, bộ giá và mã nguyên văn. Không dùng một giá khác chỉ để vượt lỗi.

**GIÁ GỐC** là giá dùng cho đăng mới. **GIÁ BÁN** được giữ riêng làm giá mục tiêu khuyến mại. Nhập nguồn không tạo chương trình giảm giá.

### Chọn đúng phạm vi thư mục

Mỗi thư mục listing chứa Word và các ảnh của riêng bộ đó. Không bắt đổi tên ảnh thành mã SKU.

| Bạn chọn trên máy | Lựa chọn trong ứng dụng |
| --- | --- |
| Một thư mục của một listing, ví dụ `Khẩu trang Lamy/` | **Thư mục này là một listing** |
| Một thư mục cha chứa nhiều thư mục listing riêng | **Mỗi thư mục con là một listing** |

Bấm **Chọn thư mục**, xem lại tên và số tệp của các dòng, rồi bấm **Đọc các thư mục**. Tệp nằm trực tiếp trong thư mục cha có thể được báo chưa rõ thuộc listing nào; ứng dụng không tự ghép tệp đó sang một bộ bất kỳ.

**Đọc các thư mục** chỉ tải và đọc nguồn. Chưa tạo listing, chưa lưu bản nháp sản phẩm và chưa gửi lên Shopee.

### Chọn ảnh bằng hình, ngay trên cùng màn hình

Chọn một dòng trong **Các listing trong đợt**. Khung bên cạnh chỉ hiện nguồn của thư mục đó. Trong tab **Ảnh trong thư mục**, đánh dấu những ảnh cần dùng rồi chọn hành động:

| Hành động | Kết quả |
| --- | --- |
| **Dùng làm ảnh bìa** | Gán một ảnh đang chọn làm bìa |
| **Thêm vào ảnh sản phẩm** | Thêm các ảnh đã chọn vào bộ ảnh sản phẩm |
| **Thêm vào ảnh mô tả** | Thêm các ảnh đã chọn vào phần mô tả |
| **Thêm vào cả hai** | Chủ động dùng cùng các ảnh cho cả ảnh sản phẩm và ảnh mô tả |

Các nhãn trên hình cho biết ảnh đang nằm ở vị trí nào. Phần **Ảnh đã phân vào vị trí** hiển thị thứ tự; dùng nút lên trước/về sau để chỉnh theo đúng bộ nguồn. Bỏ ảnh ở một vị trí không xóa tệp và không tự bỏ ảnh ở vị trí còn lại.

Ảnh phân loại sẽ được gán bằng hình khi đã xác định đúng SKU và nhãn. Ứng dụng không nhìn ảnh rồi tự suy ra SKU, combo hoặc tên phân loại. Mọi tệp được giữ nguyên; không crop, tạo ảnh hay chèn chữ.

### Đối chiếu Word và phần chưa rõ

Tab **Word & nội dung** hiển thị nguyên văn đã đọc. Khi nhận diện được rõ các mục trong Word, phần **Nội dung đã nhận diện** cho biết tiêu đề, câu mở đầu và phần chữ sẽ dùng. Nếu có nhiều Word, chọn đúng tệp nội dung của listing.

Nếu chưa phân biệt được các phần, ứng dụng hiển thị ngoại lệ. Văn bản thô vẫn dùng để xem, **không tự điền toàn bộ văn bản chưa phân loại vào mô tả**. Cần chọn lại nội dung từ Word ở màn hoàn thiện.

Mục **Cách đọc Word trong bộ nguồn** chỉ dùng khi các Word có cùng cấu trúc. Có thể xác nhận dòng đánh dấu tiêu đề/nội dung, cách lấy câu mở đầu và khoảng cách đoạn cho cả đợt. Chỉ áp dụng nếu đúng bộ tài liệu thực tế, rồi đối chiếu kết quả. Việc nhận diện phần chữ chưa chứng minh ứng dụng đã hiểu bố cục Word hoặc vị trí ảnh trong mô tả.

Tab **SKU & giá** cho biết phần đã nhận diện và những mã/nhãn còn cần làm rõ. Khi cần bổ sung, bấm **Bổ sung SKU/phân loại**. Bảng giá chung, Word đã xác định và các vai trò ảnh đã chọn được chuyển tiếp; không phải tải lại thư mục. Màn bổ sung bắt đầu từ phần danh sách phân loại, sử dụng đúng nguồn giá đã chọn.

Nếu Word chưa xác định rõ, các ô nội dung chưa được tự điền; tệp Word gốc vẫn có để chọn lại. Kho chọn ảnh của bộ đang hoàn thiện giữ đúng các tệp trong thư mục, cùng những tệp bạn tải bổ sung cho bộ đó.

## Hoàn thiện SKU/phân loại khi nguồn chưa có ánh xạ rõ

Đây là phần xử lý ngoại lệ, không phải bước bắt buộc nhập lại mọi tài nguyên. Nút **Nhập thủ công khi cần** cũng mở luồng này khi bạn chưa tổ chức nguồn bằng thư mục.

| Cấu trúc bộ đã chuẩn bị | Dữ liệu cần xác định |
| --- | --- |
| **Không có phân loại** | Một mã SKU |
| **Một nhóm** | Tên nhóm, từng mã SKU và nhãn phân loại |
| **Hai nhóm** | Hai tên nhóm, từng mã SKU và hai nhãn tương ứng |

**SKU** là mã hàng trong bảng giá. **Nhãn phân loại** là tên khách mua nhìn thấy. Giữ nguyên tên, khoảng trắng và thứ tự của bộ đã chuẩn bị. Ứng dụng không lấy tên trong bảng giá để tự đặt nhãn hoặc sinh thêm tổ hợp.

Có thể điền từng dòng hoặc mở **Đã có bảng phân loại trong Excel? Dán nhiều dòng**. Sao chép các ô SKU và nhãn, bỏ hàng tiêu đề, rồi đưa dữ liệu vào bảng. Nếu đã có dữ liệu, cần chọn rõ hành động thay bảng trước khi ghi đè các dòng. Dữ liệu dán chưa áp dụng phải được áp dụng hoặc xóa trước khi tiếp tục.

Kiểm tra SKU, nhãn, **Giá đăng mới**, **Giá bán mục tiêu** và dòng nguồn. **Xem ô nguồn** giúp đối chiếu vị trí giá trong Excel. Chỉ tiếp tục khi đủ SKU, đúng nhãn và thứ tự. Thêm/xóa dòng ở phần này chỉ để nhập đúng danh sách bộ mới, không dùng để thiết kế lại sản phẩm.

## Hoàn thiện nội dung và ảnh trước khi lưu

Trong Editor, các phần đã xác định từ thư mục được giữ lại. Bạn chỉ cần kiểm tra và hoàn thiện phần còn thiếu.

### Nội dung

Trong tab **Nội dung**, mở **Tệp Word để đối chiếu** nếu cần chọn lại phần chữ. Chọn **Từ đoạn / Đến đoạn**, chọn đưa vào tiêu đề, câu mở đầu hoặc phần chữ sau ảnh. Đọc **Hiện tại / Sau khi áp dụng**, rồi bấm **Áp dụng** vào đúng trường. Cũng có thể dán nguyên văn vào các ô.

Các khoảng trắng và xuống dòng được giữ. Việc đọc Word hiện lấy phần chữ; chưa tự nhập bố cục, ảnh nhúng hoặc lưu vị trí đoạn thành liên kết nguồn cho từng ô.

Chọn **Bố trí mô tả trong bộ nguồn**. Bản hiện tại hỗ trợ câu mở đầu → dòng trống → toàn bộ ảnh mô tả → dòng trống → phần chữ còn lại. Chỉ chọn khi đúng với nguồn. Bố trí khác được báo chưa hỗ trợ, không tự ép vào mẫu này.

### Ảnh và ảnh phân loại

Trong **Bộ ảnh**, xem riêng ảnh bìa, ảnh listing và ảnh mô tả. Mặc định chỉ hiện các ảnh đã chọn. Bấm chọn/đổi/thêm ảnh khi có yêu cầu cụ thể; có thể tải thêm ảnh từ máy ngay tại vị trí đó.

Trong **SKU & phân loại**, xem mã SKU, GIÁ GỐC và nhãn đã khóa rồi gán đúng ảnh phân loại bằng hình thu nhỏ. Không đổi danh sách, tên nhóm, nhãn hoặc thứ tự SKU ở bước này.

Bấm **Lưu & xem trước** để lưu bản nháp nội bộ. Nếu chưa lưu được, lý do và nút đưa đến phần cần bổ sung nằm ở đầu màn hình. Lưu thành công **chưa phải đã đăng Shopee**.

## Trở lại đợt thư mục và mở bộ đã có

Đợi trạng thái **Đã lưu vào Kho đầu vào**, rồi có thể rời trang. Vào **Kho đầu vào → Bộ listing → Tiếp tục xử lý** để mở lại Word, nguồn giá và thứ tự ảnh đã lưu, kể cả sau khi đóng tab. Tệp đã nhận không phải tải lại. Nếu còn tệp chưa nhận, chọn lại đúng thư mục gốc để kiểm tên, kích thước và SHA trước khi thử tiếp. Những thay đổi chỉ mới thực hiện trong Editor cần được lưu riêng; nếu bỏ thay đổi để quay lại, phần chưa lưu trong Editor không được nhập ngược vào khung thư mục.

Sau khi lưu, mở lại đúng bộ nguồn đã nhận diện có thể hiện **Mở bộ đã lưu**. Cơ chế này nhận biết mã bộ nguồn tương ứng; không bảo đảm phát hiện mọi lần nhập trùng cùng sản phẩm thực tế, nhất là khi đổi nguồn hoặc đường dẫn. Kiểm tra **Listing của tôi** trước khi nhập lại.

Để sửa một bộ đã có: mở tên bộ → **Đối chiếu nguồn** → **Điều chỉnh nội dung và ảnh**. Bản đã lưu mở ở chế độ chỉ xem. Danh sách SKU, tên nhóm và nhãn đã tiếp nhận được khóa; chỉnh nội dung/ảnh không thêm SKU sang listing khác.

## Công việc theo shop

1. Tại **Công việc đăng hàng**, dùng **Nhận thư mục listing** cho bộ mới. Nếu bộ đã lưu, bấm **Chọn bộ đã có**; có thể chọn nhiều bộ trong một lần.
2. Chọn rõ shop và đăng mới hay cập nhật. Ứng dụng tạo công việc nội bộ, chưa gửi lên Shopee.
3. Mở công việc. Với cập nhật, nhập đúng mã item và chọn những trường được phép thay đổi. Với đăng mới, nhập mức tồn theo từng SKU/shop khi đã quyết định. Đổi shop sẽ bỏ lựa chọn item và mức tồn của shop trước.
4. Xử lý các mục **Cần xử lý**. “Nguồn chưa có thông tin” khác “Ứng dụng chưa hỗ trợ”: không sửa nguồn để vượt qua một tính năng chưa được triển khai.
5. Với đúng Lamy sandbox, bấm đọc và đối chiếu, xem bản thay đổi đã lưu, rồi mới gửi. Bước này hiện chỉ hỗ trợ tiêu đề, mô tả và ảnh sản phẩm; ảnh bìa, SKU, giá, tồn và thông tin khác được đọc lại để kiểm tra giữ nguyên.

Nếu kết quả chưa rõ, mở công việc và dùng **đọc đối chiếu**. Lần thực hiện được giữ trên server, có thể tìm lại ở trình duyệt khác. Không gửi lại chỉ vì tab đã đóng. Công việc có lần gửi chưa rõ sẽ chặn thay cấu hình cho đến khi được đối chiếu.

**Mã ảnh bìa thay đổi sau khi lưu:** Shopee có thể trả mã mới. Ứng dụng chưa tự kết luận hai ảnh giống nhau, nên giữ yêu cầu đối chiếu dù các trường khác đã khớp. Mở ảnh tại Shopee và nguồn để người hỗ trợ kiểm tra; bấm đọc đối chiếu chỉ đọc lại, không phục hồi hoặc gửi ảnh lần nữa. Trường hợp Lamy ngày 11/09 đã khôi phục bìa đúng bằng phép sửa riêng, nhưng còn chờ cơ chế chấp nhận ảnh đổi mã có bằng chứng trong ứng dụng.

**Nhập / xuất hồ sơ** là cách dùng lại tùy chọn cho những bộ đã nhận. Hồ sơ do ứng dụng tạo, tham chiếu các tệp đã có trên cùng máy chủ; không phải tệp ảnh/Word đóng gói và không dùng để chuyển nguyên bộ sang máy chủ khác. Nhập hồ sơ chỉ lưu nguồn nội bộ sau khi xem khác biệt, chưa gửi Shopee.

## Tệp lỗi, công việc đang làm và tải lại trang

- **Tệp chưa đọc được:** xem tên tệp và thông báo. Kiểm tra tệp gốc rồi thử **Đọc các thư mục** lại. Chi tiết kỹ thuật nằm trong mục đóng dành cho người hỗ trợ; các tệp đọc được vẫn có thể xem và đối chiếu.
- **Đang tải/đọc/lưu:** đợi kết quả trước khi chuyển công việc. Tệp đã nhận chưa chắc đã được đọc thành công.
- **Đợt thư mục đang mở:** lưu tự động trên máy chủ với lịch sử phiên bản. Chỉ phần đã được xác nhận lưu mới phục hồi sau khi đóng trang. Mất mạng thì giữ trang và dùng nút thử lưu lại; không coi thông báo đang lưu là đã lưu.
- **Đợt có bản mới hơn:** có thể một người khác vừa sửa. Ứng dụng dừng ghi để không đè bản của họ. Mở bản đã lưu để đối chiếu; không tự trộn hai bộ lựa chọn.
- **Editor chưa lưu:** chưa có phục hồi nội dung/ảnh đang sửa sau khi tải lại trang. Bản đã lưu trong ứng dụng vẫn còn.
- **Nhập thủ công:** các ô bảng giá/SKU của luồng phụ có cơ chế lưu tạm trong cùng tab. Lời nhắc **Tiếp tục phần đang nhập** chỉ áp dụng phần này, không khôi phục tệp hoặc toàn bộ đợt thư mục, và không phải bản làm việc dùng chung giữa nhân viên.
- **Rời phần có thay đổi:** chọn **Ở lại** để tiếp tục hoặc hành động bỏ thay đổi được nêu rõ. Bỏ phần chưa lưu không xóa bản đã lưu. Chọn một đợt thư mục khác sẽ bắt đầu lại phần đối chiếu của đợt đó.

## Giới hạn cần phân biệt

Nguồn thiếu, bố trí chưa hỗ trợ hoặc SKU/giá không rõ phải được giữ thành ngoại lệ. Không đổi dữ kiện, giá, cấu trúc sản phẩm hoặc ảnh chỉ để vượt kiểm tra. Tồn đăng bán cần quyết định riêng cho từng SKU/shop; không tự lấy mức tồn thử làm mặc định.

**Tra cứu & kiểm tra** dùng kho kiến thức tại máy. Kết quả tìm tài liệu chưa chứng minh chính sách hiện hành, quyền shop hoặc QC Shopee.

Bản hiện tại chưa có đăng mới hàng loạt, nhận diện toàn bộ cấu trúc tài liệu bằng thị giác, thuộc tính ngành động đầy đủ, cập nhật model/giá/tồn trên Shopee, QC, Flash Sale hoặc vận hành 24 giờ. Mức tồn trong công việc mới là quyết định được lưu, chưa được gửi. Nhập thư mục và phép thử cập nhật Lamy không chứng minh các khả năng còn lại đã được nghiệm thu.
