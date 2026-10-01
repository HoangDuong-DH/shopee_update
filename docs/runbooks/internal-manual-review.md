# Thao tác nguồn, phiên bản và báo cáo trong bản nâng cấp nội bộ

Tài liệu cho worktree nâng cấp nội bộ, không thay biên bản triển khai hoặc quyền gửi của từng shop. Đọc [nhập nguồn](internal-source-intake.md) để biết bố cục ZIP, Excel nội dung và giới hạn tệp.

## Từ bộ nguồn đến bản nháp

1. Trong Kho listing, mở phần nhập Word/ảnh/bảng giá rồi nhận thư mục hoặc ZIP. Chọn đúng cách chia listing, bảng giá, sheet và bộ giá.
2. Excel nội dung được chọn và ghép riêng theo STT. Dòng trùng hoặc chưa rõ giữ lại để chọn tay; Excel nội dung không tự tạo SKU hoặc cấu trúc phân loại.
3. Lưu đợt nguồn, hoàn thiện ảnh/nội dung/SKU, rồi lưu từng bộ hoặc các bộ đủ điều kiện. Đợi thông báo đã lưu trước khi đóng trang. Tệp chưa nhận xong không được coi là đã lưu.

## Chỉnh phân loại hàng loạt

Trong **Công cụ → Listing của tôi → Chỉnh phân loại hàng loạt**, tìm theo tên hoặc SKU, chọn tối đa 80 bộ. Lọc danh sách giữ nguyên các bộ đã chọn; màn hình ghi số bộ đang ngoài bộ lọc. Chọn dung tích cần bỏ, chọn riêng phân loại hoặc sắp xếp dung tích giảm dần, sau đó xem trước từng SKU/giá và lưu phần đã kiểm tra.

Lựa chọn được giữ trong cùng tab khi chuyển trang hoặc tải lại. Bản xem trước không được phục hồi như quyền lưu: luôn xem trước lại. Nếu nguồn đã đổi phiên bản, các lựa chọn bỏ riêng của bộ đó được bỏ để người vận hành chọn lại; tiêu chí dung tích vẫn giữ. Trường hợp mất phản hồi khi lưu dùng **Khôi phục kết quả lần lưu** để đọc biên nhận của đúng thao tác; không lập thao tác mới để đoán kết quả.

Sửa nguồn tạo phiên bản mới trong kho ứng dụng, chưa sửa link Shopee. Không chọn bỏ tất cả phân loại hoặc làm thiếu tổ hợp hai tầng; kết quả xem trước chỉ rõ bộ cần xử lý, các bộ khác vẫn giữ lựa chọn.

## Chuẩn bị theo shop và đối chiếu bản nguồn

Mở **Đăng hàng → Chuẩn bị lô mới**, kiểm tên và ID shop. Chọn tối đa 80 nguồn, bổ sung thông tin vận hành rồi kiểm tra. Nút bên cạnh lỗi mở đúng trường vận hành hoặc mục nội dung/ảnh/phân loại của bản nguồn mới nhất.

**Đối chiếu bản nguồn hiện tại** đọc khác biệt giữa snapshot đã kiểm tra và nguồn hiện tại: phiên bản, tiêu đề, ảnh, cấu trúc, giá hoặc các trường nguồn thay đổi. Trước/sau chỉ hiển thị để đối chiếu; không tự sửa snapshot hoặc manifest của đợt cũ.

- Chưa đăng ký đợt: nguồn đổi thì dùng nguồn hiện tại và kiểm tra lại trước khi đăng ký.
- Đã đăng ký: phần nguồn đổi được chỉ rõ. Mở **Đợt đang làm**, giữ link đã tạo để đối chiếu; chỉ loại phần chưa từng gửi trước khi chuẩn bị lại.
- Nếu còn nguồn độc lập không đổi, nút tiếp tục vẫn có thể khả dụng; backend kiểm tra riêng từng nguồn. Nguồn đã có lần gửi phải đi theo nhật ký/đối chiếu, không tạo lại chỉ vì nguồn trong kho thay đổi.

Lựa chọn vận hành tạm được giữ theo shop trong tab. Sau tải lại cần đọc lại thông tin shop và kiểm tra; bằng chứng kho, quyền gửi và phiếu QC không được tự tái sử dụng từ phần nhập tạm.

## Đăng ẩn, QC và bàn giao

Sau kiểm tra và đăng ký đợt, người vận hành tự bấm tạo link ẩn. Trong **Đợt đang làm**, phân biệt tiến độ thực thi, trạng thái link trên shop và việc cần làm. Có ID sản phẩm chưa phải đã đủ phân loại, giá, tồn hoặc ảnh. Lần gửi chưa rõ kết quả phải đọc đối chiếu trước.

Đợt đã tạo ẩn nhưng còn chờ QC vẫn nằm trong bộ lọc mặc định **Chưa hoàn tất**, kể cả sau tải lại trang. Hoàn tất khâu tạo link chưa đồng nghĩa đã hoàn tất QC hoặc mở bán.

**Xuất báo cáo Excel** trong chi tiết đợt dùng đúng shop đã chọn và nhật ký đã lưu. Tải báo cáo không gửi lại listing và không tạo lần đọc mới Shopee; xem thời điểm trong báo cáo để biết độ mới. Khi xuất lỗi hoặc quá thời gian, thử tải lại; ứng dụng không lưu phản hồi lỗi thành tệp Excel.

Đăng ẩn không mở bán. Nếu hoãn QC ảnh, cần kiểm tra ảnh và đọc đối chiếu lại trước khi xác nhận mở bán riêng. Những bước chưa được hỗ trợ cho shop hiện tại vẫn phải xử lý theo lý do hiển thị.

## Phạm vi đã kiểm tra tại máy

Ngày 23/09/2026: 13 ca trình duyệt fixture đã kiểm Excel nội dung, chọn/đổi/sắp phân loại, lưu/xung đột phiên bản, tải lại/chuyển trang, cô lập shop, mất phản hồi gửi, xuất báo cáo và đối chiếu nguồn một phần. Các thao tác gọi route thật của giao diện nhưng phản hồi được kiểm soát; không dùng thông tin đăng nhập hoặc ghi Shopee. 14 ca unit riêng kiểm thời hạn chờ, hủy yêu cầu và xử lý trạng thái; kiểm kiểu đạt. Kiểm HTTP/database/Excel thực tế và nghiệm thu tổng hợp được ghi riêng bởi nhóm kiểm chứng; các con số này không chứng minh nghiệm thu nhiều shop live hoặc vận hành 24h.

Một ca trình duyệt liên tục bổ sung đã đạt qua giao diện → HTTP/API thật → bộ đọc nguồn → PostgreSQL riêng → biên dịch nguồn → đăng ký đợt → hàng đợi cha/con → nhật ký thực thi → tải báo cáo Excel. Ca này nhập ZIP hai bộ ảnh, Excel nội dung và bảng giá, ghép SKU thủ công, lưu nguồn, bỏ 280 ml và sắp 500 ml/100 ml, kiểm ngành/kho/vận chuyển, tạo ẩn rồi tải lại. Bộ thiếu SKU vẫn được giữ để bổ sung. Giá và nội dung từ Excel còn nguyên trong hồ sơ gửi; chỉ một lần tạo và một lần khởi tạo phân loại cho listing mới, không gửi lại sau tải trang.

Phạm vi của ca liên tục là **shop thử đã kết nối và có lịch sử kho**, không kiểm đăng nhập hoặc thiết lập shop mới. Hai hồ sơ tiền đề được runner thật tạo/đối chiếu từ trước trong cùng schema riêng; chỉ phản hồi nền tảng Shopee là fixture, không chặn thay các route `/v1`. Kết quả cuối UNLIST, hai lần đọc dữ liệu cốt lõi đạt, ảnh ghi rõ **chưa QC**; chưa mở bán hoặc xác nhận ảnh đạt. Bằng chứng lượt chốt tại `.local/internal-acceptance-20260923/browser-vvko6h/` gồm `ui-evidence.json`, `database-evidence.json`, ảnh màn hình và `hidden-qc-report.xlsx`. Bốn ca hồi quy chọn shop/mất phản hồi/xuất báo cáo đã chạy lại đạt sau sửa bộ lọc; kiểm kiểu đạt.
