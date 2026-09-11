# Hướng dẫn dùng ứng dụng listing nội bộ

Cập nhật ngày **11/09/2026**. Mở http://127.0.0.1:5173/ trên máy đang chạy ứng dụng. Nút **Hướng dẫn** trong ứng dụng cũng mở các bước sử dụng cơ bản.

Ứng dụng tiếp nhận bộ listing công ty đã chuẩn bị: danh sách SKU, tên phân loại, nội dung và ảnh. Bản hiện tại giúp nhập, đối chiếu và lưu bản nháp nội bộ; **chưa bật đăng/cập nhật Shopee**.

## Ba nơi làm việc chính

| Mục                 | Dùng khi nào                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| **Listing của tôi** | Mở bộ đã có, hoặc bắt đầu nhập một bộ mới đã chuẩn bị                                                     |
| **Tệp nguồn**       | Xem Excel, Word, ảnh đã tải; kiểm tra tệp chưa đọc được; tra SKU và giá                                   |
| **Kết quả**         | Xem các bản kiểm tra theo shop và trạng thái công việc; bản kiểm tra nội bộ chưa phải kết quả đăng Shopee |

## Xem bộ Lamy đã nhập

1. Vào **Listing của tôi**, bấm tên Lamy.
2. Xem ảnh bìa, ảnh sản phẩm, bảng sáu SKU, giá đăng mới và giá bán mục tiêu. Mô tả giữ chín ảnh đã chọn trong bộ nguồn.
3. Bấm **Đối chiếu nguồn**. Ba tab **Nội dung**, **Bộ ảnh**, **SKU & phân loại** giúp xem từng phần. Bản đã lưu mở ở chế độ chỉ xem.
4. Nếu có yêu cầu sửa nội dung hoặc ảnh cụ thể, bấm **Điều chỉnh nội dung và ảnh**, sửa đúng phần rồi **Lưu & xem trước**. Việc lưu tạo phiên bản nội bộ, chưa sửa listing trên Shopee.
5. Chỉ chọn **Shop đích** khi cần lưu bản kiểm tra theo shop. Phần này chưa đăng mới hoặc cập nhật link đang có.

Danh sách, thứ tự SKU, tên nhóm và nhãn phân loại của bộ đã lưu được khóa. Không dùng sửa nội dung để thêm/bớt SKU hay đổi cấu trúc sản phẩm.

## Nhập một bộ listing mới đã chuẩn bị

Vào **Listing của tôi → Nhập listing có sẵn**. Màn hình hướng dẫn ba bước, mỗi bước chỉ hiện phần cần làm. Nút **Quay lại** giữa ba bước giữ nguyên các ô đã điền.

### 1. Nguồn giá

Chọn **File bảng giá → Trang tính chứa giá → Bộ giá áp dụng**, rồi bấm **Tiếp tục: phân loại**. Nếu chưa có Excel, bấm **Thêm file Excel** ngay tại đây; không cần rời phần đang nhập. Chờ tệp được đọc xong rồi chọn nó trong danh sách.

Bảng giá chỉ dùng để tìm SKU và giá. SKU xuất hiện trong cùng trang tính không tự chứng minh chúng thuộc cùng listing. Cần chọn đúng bộ giá của bộ nguồn, kể cả khi cùng SKU xuất hiện ở nhiều bộ giá.

**GIÁ GỐC** là giá dùng khi đăng listing mới. **GIÁ BÁN** được giữ làm giá mục tiêu cho bước khuyến mại riêng; thao tác nhập này không tạo chương trình giảm giá.

### 2. Phân loại đã chuẩn bị

Chọn cấu trúc đúng như bộ công ty đã làm:

| Lựa chọn               | Cách điền                                                  |
| ---------------------- | ---------------------------------------------------------- |
| **Không có phân loại** | Điền một mã SKU                                            |
| **Một nhóm**           | Điền tên nhóm và từng dòng SKU/nhãn phân loại              |
| **Hai nhóm**           | Điền hai tên nhóm và từng dòng SKU/nhãn nhóm 1/nhãn nhóm 2 |

**SKU** là mã hàng trong bảng giá. **Nhãn phân loại** là tên khách mua nhìn thấy. Nhập nguyên văn, kể cả khoảng trắng, và giữ đúng thứ tự trong bộ đã chuẩn bị. Dùng **Thêm dòng SKU** hoặc nút xóa dòng chỉ để đưa vào đúng danh sách của bộ mới này. Ứng dụng không tự tạo thêm tổ hợp, gộp/tách sản phẩm hoặc đặt tên từ bảng giá.

Nếu đã có bảng phân loại trong Excel, mở **Đã có bảng phân loại trong Excel? Dán nhiều dòng**. Sao chép các ô SKU và nhãn, bỏ hàng tiêu đề, rồi bấm **Đưa dữ liệu vào bảng**. Nếu bảng đang có dữ liệu, ứng dụng yêu cầu bấm rõ **Thay bảng bằng dữ liệu đã dán** trước khi thay các dòng. Phần dán chưa áp dụng phải được đưa vào bảng hoặc xóa trước khi tiếp tục.

Bấm **Tiếp tục: kiểm tra**. Lỗi chỉ rõ dòng cần làm rõ: SKU không tìm thấy, trùng SKU, thiếu nhãn hoặc giá nguồn chưa hợp lệ. Nếu đổi từ hai nhóm xuống một nhóm mà còn nhãn nhóm hai, ứng dụng giữ ô đó và yêu cầu xử lý; không âm thầm bỏ nhãn.

### 3. Kiểm tra

Đọc lại danh sách SKU, nhãn, **Giá đăng mới**, **Giá bán mục tiêu** và dòng nguồn. **Xem ô nguồn** giúp kiểm tra vị trí giá trong Excel. Xác nhận đã đủ SKU, đúng tên và thứ tự rồi bấm **Tiếp tục: nội dung & ảnh**.

Ứng dụng tự tạo mã theo dõi, nằm trong phần **Mã theo dõi trong ứng dụng**. Nhân viên không phải nghĩ thêm một mã mới. Mã này không phải SKU hoặc mã sản phẩm Shopee; nó cũng chưa phát hiện hai lần nhập khác nhau là cùng sản phẩm thực tế.

## Đưa nội dung Word và ảnh vào đúng chỗ

### Nội dung

Trong tab **Nội dung**, chọn **Tệp Word để đối chiếu** hoặc **Tải Word từ máy**. Ứng dụng hiện các đoạn theo thứ tự để kiểm tra. Chọn **Từ đoạn / Đến đoạn**, chọn đưa vào tiêu đề, câu mở đầu hoặc phần chữ sau ảnh. Đọc phần **Hiện tại / Sau khi áp dụng**, rồi bấm **Áp dụng** vào đúng trường. Có thể hủy lựa chọn mà không đổi nội dung.

Bạn cũng có thể dán nguyên văn vào từng ô. Ứng dụng giữ khoảng trắng và xuống dòng; không tự viết lại nội dung. Việc đọc Word hiện lấy phần chữ theo đoạn; chưa tự nhập bố cục, ảnh nhúng hoặc lưu vị trí đoạn thành liên kết nguồn cho từng ô.

Chọn **Bố trí mô tả trong bộ nguồn**. Bản hiện tại hỗ trợ câu mở đầu → dòng trống → toàn bộ ảnh mô tả → dòng trống → phần chữ còn lại. Chỉ chọn khi đúng bố trí đã chuẩn bị. Bố trí khác được báo chưa hỗ trợ, không tự ép nguồn vào mẫu này.

### Bộ ảnh và ảnh phân loại

Trong tab **Bộ ảnh**, chọn riêng **Ảnh bìa**, **Ảnh listing** hoặc **Ảnh mô tả**. Mặc định màn hình chỉ hiện các ảnh đã chọn cho vị trí đó. Bấm **Chọn ảnh**, **Đổi ảnh** hoặc **Thêm ảnh** để mở kho, tìm theo tên tệp và chọn đúng ảnh gốc. Có thể **Tải ảnh từ máy** ngay trong kho.

Ảnh được đánh số theo thứ tự đã chọn. Dùng nút lên trước/về sau khi cần chỉnh theo đúng nguồn; nút bỏ ảnh chỉ bỏ liên kết khỏi bản nháp, không xóa tệp gốc. Tải một tệp lên chưa tự gán nó vào listing. Ứng dụng không crop, sinh ảnh hoặc đổi nội dung ảnh.

Trong tab **SKU & phân loại**, kiểm tra nhãn đã khóa và gán ảnh cho từng phân loại bằng hình thu nhỏ/tên tệp. Không đổi danh sách SKU hoặc tên phân loại ở bước này.

Khi đã đối chiếu xong, bấm **Lưu & xem trước**. Nếu chưa lưu được, lý do và nút đưa đến phần cần bổ sung hiện ở đầu màn hình. Lưu thành công là lưu nội bộ; chưa phải đã đăng Shopee.

## Tải tệp lỗi, nhập dở và quay lại

- **Tệp tải lỗi:** bảng tiến độ nêu rõ từng tệp **Đã nhận / Chưa nhận**. Bấm **Thử lại … tệp chưa nhận**; chỉ các tệp lỗi được gửi lại. Tệp độc lập khác vẫn được nhận. Giữ trang mở để ứng dụng còn tệp cần thử lại; sau khi tải lại trang, tệp chưa nhận cần được chọn lại từ máy.
- **Đang nhận tệp / đang lưu:** đợi kết quả trước khi đổi màn hoặc sang bước tiếp theo. “Đã nhận tệp” chưa có nghĩa worker đã đọc xong tệp.
- **Nhập dở ba bước đầu:** nếu tải lại trang hoặc mở lại phần nhập trong cùng tab, ứng dụng đề nghị **Tiếp tục phần đang nhập** hoặc **Nhập bộ khác**. Tiếp tục giữ nguồn, bảng SKU/nhãn và mã theo dõi; bước kiểm tra cần chạy lại. Chọn bộ khác xóa phần tạm của bộ trước.
- **Phạm vi phục hồi:** chỉ lưu tạm các ô nhập của ba bước đầu trong phiên tab trình duyệt. Không phải bản lưu dùng chung giữa nhân viên, không chứa tệp hay token, và không bảo đảm còn sau khi đóng tab. Nội dung/ảnh đang sửa trong editor chưa có phục hồi sau tải lại trang. Nếu trình duyệt không lưu được phần tạm, ứng dụng hiện thông báo để giữ tab mở.
- **Quay lại từ nội dung/ảnh của bộ mới:** hộp thoại nói rõ phần nội dung/ảnh chưa lưu sẽ bị bỏ. Nếu tiếp tục quay lại, phần nguồn giá/SKU ở ba bước đầu vẫn được giữ để phục hồi.
- **Rời sang công việc khác:** chọn **Ở lại** để tiếp tục hoặc **Bỏ thay đổi và rời đi**. Bản đã lưu luôn được giữ; bỏ phần nhập bộ mới sẽ xóa phần tạm tương ứng. Sửa rồi bỏ thay đổi của một listing đã lưu không xóa phần nhập dở của bộ khác.

## Những trường hợp cần người vận hành làm rõ

- SKU không có hoặc khớp nhiều dòng: kiểm tra file, trang tính, bộ giá và mã nguyên văn. Ứng dụng không chọn đại dòng đầu.
- Mã theo dõi đã tồn tại: mở bộ đã lưu; không ghi đè bằng lần nhập mới. Kiểm tra danh sách trước khi nhập lại một sản phẩm vì mã mới không tự chống trùng link trên sàn.
- Nguồn/giá thiếu, bố trí khác hoặc ngành/thuộc tính/tồn/vận chuyển chưa kiểm: giữ ngoại lệ để bổ sung nguồn hoặc khả năng hỗ trợ. Không đổi dữ kiện sản phẩm, giá hay ảnh chỉ để vượt kiểm tra.
- **Tra cứu & kiểm tra** dùng kho kiến thức chụp tại máy. Kết quả tìm tài liệu chưa tự chứng minh chính sách hiện hành, quyền shop hoặc QC Shopee.

Chưa có đăng hàng loạt, nhập trọn bộ tự động cho mọi cấu trúc, thuộc tính ngành động đầy đủ, cập nhật item/model, nhập lệnh tồn trên UI, QC, Flash Sale hoặc vận hành 24 giờ. Các phần đó thuộc kế hoạch tiếp theo, không được coi đã hoàn tất vì giao diện đã thay đổi.
