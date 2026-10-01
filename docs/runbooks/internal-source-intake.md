# Nhận nguồn ZIP và ảnh bìa bằng giao diện

Trong màn nhập thư mục listing, có thể chọn thư mục như trước hoặc dùng **Nhận nguồn từ ZIP**. ZIP được mở tại trình duyệt; từng tệp sau giải nén đi qua cùng bộ nhận nguồn hiện có, được lưu theo hash. Không sinh SKU, giá hoặc nội dung thay cho nguồn thiếu. ZIP gốc vẫn giữ trên máy, ứng dụng giữ các tệp đã nhận và cách ghép đã lưu.

1. Chọn bảng giá và đúng bộ giá trước khi hoàn thiện listing.
2. Chọn bố cục ZIP: **Mỗi ZIP là một listing**, hoặc **ZIP chứa nhiều thư mục listing hoặc ZIP con**. Có thể chọn nhiều ZIP trong cùng lần.
3. Nếu ZIP có thêm đúng một thư mục bao ngoài, đánh dấu bỏ một tầng. Hệ thống không tự bỏ tầng theo phỏng đoán. Kiểm số bộ và tên bộ sau mở ZIP; nếu nhiều listing đang bị gom thành một bộ, điều chỉnh bố cục trước khi đọc.
4. Nếu có thư mục ảnh bìa riêng, bấm **Ghép thêm thư mục ảnh bìa** trước khi đọc. Tên ảnh và thư mục cần có STT rõ ở đầu tên, ví dụ `698 - ...`. Cũng nhận tiền tố thứ tự ngắn như `7_222 ...`. Không lấy số dung tích ở cuối tên làm STT.
5. Chỉ STT khớp duy nhất mới được đề xuất làm bìa. Hai ảnh cùng STT, hai thư mục cùng STT, thương hiệu ghi rõ nhưng khác nhau hoặc nguồn đã có công thức `listing-source.json` đều được giữ lại để xử lý riêng. Lựa chọn bìa đã có không bị ghi đè.
6. Bấm **Đọc các thư mục**, xem ảnh/nội dung/phân loại, giải quyết phần chưa rõ và lưu. Đợi trạng thái đã lưu trước khi đóng trang. Các thao tác này chưa gửi Shopee.

Giới hạn bảo vệ hiện có: tổng ZIP được chọn tối đa 512 MB, tối đa 3 tầng ZIP, 5.000 mục kể cả thư mục, 64 MB cho từng tệp nguồn thông thường, ngân sách giải nén cộng dồn 1 GB. ZIP con được kiểm thêm theo giới hạn dung lượng ZIP. Vượt giới hạn thì chia lần nhập; không tắt kiểm tra để nhận một lô lớn.

Khi mở lại đợt đã lưu, byte đã nhận vẫn ở kho ứng dụng. Nếu cần chọn lại ZIP để tiếp tục tệp chưa nhận, dùng cùng cấu trúc/bỏ tầng và cùng nguồn; hệ thống đối chiếu hash trước khi tiếp tục. Nếu từng bổ sung bìa riêng mà chưa đọc xong, chọn lại toàn bộ bộ nguồn có đường dẫn tương ứng hoặc mở đợt mới; không giả định ZIP ban đầu tự chứa các ảnh bìa được bổ sung sau.

## Excel nội dung riêng với Excel giá

Mở **Nội dung từ Excel — ghép cùng lúc theo STT**, chọn tệp XLSX, dòng tiêu đề và sheet. Xem các dòng đầu rồi chọn riêng cột STT, tiêu đề, nội dung sau ảnh và câu mở đầu nếu có. Bấm **Xem ghép nội dung cho cả lô**. Chỉ STT duy nhất mới được đề xuất; STT trùng, thiếu, công thức chưa có giá trị hoặc ô nhập nhằng giữ lại để chọn/sửa. Danh sách hiện tên sản phẩm và số dòng để đối chiếu trước khi **Áp dụng nội dung các bộ đã chọn**. Việc đổi sheet/cột vô hiệu bản xem trước cũ; không thay bản đã áp dụng cho đến khi xác nhận lần mới.

Ứng dụng đọc lại XLSX nguyên trong kho hash. Trạng thái bộ đọc **giá** có thể thất bại vì workbook không chứa SKU; điều đó không cấm đọc **nội dung** nguyên. Nguồn nội dung lưu sheet/cột/dòng/header/SHA và được đối chiếu lại khi lưu đợt và khi lưu bản nháp. Không tạo Word giả hoặc dùng bảng nội dung làm giá. Nhập tệp khác tạo nguồn hash khác; không ghi đè tệp nguyên. Đợt có revision; bản cũ bị chặn nếu đã có người lưu bản mới.

Giới hạn nội dung: XLSX tối đa16 MB; tối đa30 sheet,10.000 dòng/sheet,128 cột/sheet; trả tối đa8 MB chữ mỗi mapping. Không thực thi công thức; chỉ đọc giá trị được Excel lưu. Ô ghép phụ hoặc công thức thiếu kết quả bị chỉ rõ. Nếu cần cập nhật kết quả công thức, tính lại bằng Excel rồi lưu tệp mới. Không tải đường dẫn ảnh hay liên kết bên ngoài trong ô Excel.

Sau khi ghép, bộ đủ dữ liệu có thể lưu; bộ chưa xác định SKU/phân loại vẫn cần chọn từ giá thật tại bước hoàn thiện. **Excel nội dung không tự xác định cấu trúc phân loại.** Bộ có sidecar nguồn hoặc bảng phân loại đang bổ sung vẫn dùng hồ sơ đó, không bị Excel ghi đè. Nguồn nội dung mới phải lưu nguyên văn lần đầu để có claim đúng nguồn; sau đó có thể sửa bản nháp và thay đổi chữ được ghi nhận là lựa chọn thủ công, lịch sử nguồn cũ còn nguyên. Lưu nháp chưa gửi Shopee.

## Bằng chứng và giới hạn

Có kiểm thử parser bằng XLSX thật, PostgreSQL riêng cho lưu/mở lại/CAS/chống lặp và kiểm giao diện bằng API fixture. Không dùng dữ liệu thật hoặc lệnh ghi Shopee để thử các tính năng nhập này. Cần nghiệm thu thêm trên một bản sao bộ nguồn doanh nghiệp thực tế trước bàn giao toàn hệ thống. ZIP chưa có phép tiếp tục giải nén giữa chừng; source phải nằm trong giới hạn tài nguyên của trình duyệt.
