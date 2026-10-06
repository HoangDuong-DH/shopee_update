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

## Giới hạn xử lý nguồn ở worker

Sau khi nhận quyền giữ một tệp, worker cho tối đa 120 giây để đọc blob và phân tích. Đồng hồ dùng chung cho cả hai bước, gồm thời gian khởi tạo bộ phân tích; không cấp thêm 120 giây sau khi đọc blob. Đây là giới hạn đọc/phân tích, không phải cam kết tổng thời gian gồm claim/hoàn tất trong database: các thao tác database có giới hạn độc lập của runtime pool.

Bộ phân tích Excel, Word và ảnh chạy trong một worker thread riêng. Tệp ảnh tối đa 32 MiB; XLSX/DOCX tối đa 64 MiB. Dung lượng khai báo được kiểm trước khi mở blob, byte thật được đọc từng phần tối đa 256 KiB và bị chặn khi vượt giới hạn. Hash vẫn được kiểm; hủy đọc hoặc lỗi không xóa hay sửa byte gốc. Office archive giữ giới hạn giải nén 128 MiB hiện có. Sharp chỉ đọc metadata ảnh với giới hạn 100 triệu pixel; không giải mã toàn bộ ảnh ở bước nhập này.

Mỗi thread có giới hạn V8 heap cũ 256 MiB, heap mới 32 MiB và stack 4 MiB. Các giới hạn V8 không phải hạn mức tổng bộ nhớ của hệ điều hành: ArrayBuffer và bộ nhớ native của thư viện vẫn nằm ngoài chúng; giới hạn byte, archive và pixel bổ sung các chốt cho nguồn được hỗ trợ. Kết quả JSON tối đa 16 MiB tính theo byte UTF-8, được kiểm trước khi trả ra khỏi thread và được kiểm lại khi nhận. Kết quả vượt giới hạn bị từ chối toàn bộ, không cắt dòng hoặc tự rút gọn nội dung.

Khi hết thời gian, worker dừng thread và ghi lỗi `SOURCE_IMPORT_TIMEOUT` bằng đúng lease/epoch đang giữ nếu quyền vẫn hợp lệ. Nếu mất lease hoặc không xác minh được lần gia hạn, nó hủy đọc/phân tích và không hoàn tất tệp bằng quyền cũ. Lần gia hạn bị kẹt có giới hạn riêng 5 giây. Luồng phân tích phải kết thúc trước khi chuyển sang tệp kế tiếp; kết quả muộn không được ghi. Thread chỉ chạy entry cố định đi cùng ứng dụng, không lấy đường dẫn thực thi từ tên tệp hay nội dung nguồn.

Các mã `SOURCE_FILE_TOO_LARGE`, `SOURCE_ARCHIVE_TOO_LARGE`, `SOURCE_IMPORT_RESULT_TOO_LARGE` và `SOURCE_PARSER_MEMORY_LIMIT` giữ tệp gốc để người vận hành chia nhỏ hoặc bổ sung nguồn phù hợp. Tệp lỗi được giữ riêng; các tệp đủ nguồn tiếp tục được đọc. Không tự cắt workbook, tạo lại dữ liệu hay gửi lại thao tác Shopee. Những lỗi chưa nhận diện dùng thông báo chung và không đưa đường dẫn, stack hoặc byte nguồn ra giao diện.

Kiểm thử dùng blob trong thư mục tạm và workbook/Word/PNG fixture, có vòng lặp CPU không kết thúc, blob/renewal không trả về, mất lease và kết quả muộn. Chúng không xác nhận giới hạn tổng RAM của mọi codec, tải dữ liệu doanh nghiệp thực tế, Shopee production hoặc vận hành 24 giờ.

Bộ phân tích chỉ nạp module của đúng loại nguồn: Excel dùng bộ workbook; Word và ảnh không nạp bộ workbook hoặc toàn bộ thư viện domain. Mỗi tệp vẫn có thread riêng và thread được dừng sau xử lý; các giới hạn thời gian, dung lượng, kết quả và quyền giữ tệp ở trên được giữ nguyên.

Trên Windows, bộ chọn thư mục của trình duyệt có thể không đọc được đường dẫn rất dài dù Node tạo được tệp đó. Giữ lại thông báo lỗi từng tệp; không xem bộ thiếu ảnh là hoàn tất. Dùng ZIP giữ đúng cấu trúc hoặc chuyển bộ nguồn sang đường dẫn ngắn rồi nhập lại khi người vận hành xác định nguyên nhân.
