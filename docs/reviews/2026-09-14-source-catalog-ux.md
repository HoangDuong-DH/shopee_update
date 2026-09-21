# Kho listing: nguồn đã nhận và điều hướng theo công việc — 14/09/2026

## Vấn đề và thay đổi

Giao diện trước buộc người dùng hiểu các mô-đun kỹ thuật trước khi tìm được nguồn cần làm. Nguồn Excel nội dung của Vina cũng không có cùng ý nghĩa với bảng giá KINI. Bản này đặt **Kho listing** làm trang đầu, với hai lựa chọn rõ ràng: **Dữ liệu đã nhận** để tìm và đọc nội dung; **Nhập Word / ảnh / bảng giá** để mở luồng tiếp nhận đã có. Không đưa Excel nội dung vào parser giá, không tự tạo listing hoặc công việc xuất bản từ một dòng Excel.

Bốn mục chính là **Kho listing**, **Đăng hàng**, **Cập nhật listing**, **Theo dõi công việc**. Các công cụ ít dùng hơn nằm trong menu **Công cụ** có thể mở bằng bàn phím, đóng bằng Escape và trả focus. Route, kiểm thay đổi chưa lưu và khóa chuyển trang khi đang lưu/nhận tệp được giữ. Luồng cũ vẫn truy cập được qua **Listing của tôi**, không được dùng làm điểm bắt đầu mặc định.

Trong kho, người dùng nhìn thấy tên nguồn, số dòng nội dung và thiết kế đã ghi nhận; lọc theo nhãn nguồn hoặc vấn đề, tìm từ khóa, mở đúng dòng. Nhãn Excel chưa được coi là shop. Một dòng chưa có ID cũng không tự trở thành yêu cầu tạo mới. Danh sách chỉ nêu số phần cần đối chiếu; nội dung chi tiết và cách giải quyết mở tại dòng để tránh hàng trăm cảnh báo lặp lại.

Trang chi tiết giữ tất cả phiên bản văn bản nguyên trạng, kể cả xuống dòng/khoảng trắng và ký tự giống HTML. Phân loại và ghi chú rà soát được trình bày riêng, mỗi phần có sheet/ô nguồn. Gợi ý Canva ghi rõ chưa xác nhận và chưa tải ảnh gốc; không tự gán ảnh từ tên thiết kế. Đối chiếu với shop cũ là phần mở rộng có shop, item ID, ngày quan sát, ngành, thuộc tính và những điểm cần kiểm tra. Quan sát này chưa xác minh qua API, chưa được chấp thuận dùng lại và không thay thế nguồn mới.

Bốn mục xem chi tiết **Nội dung / Phân loại / Ảnh Canva / Ghi chú & đối chiếu** chỉ hiển thị phần đang chọn. Nhân viên không phải cuộn qua ba phiên bản bài viết dài để tìm ảnh hoặc shop cũ. Nút số phần cần đối chiếu mở trực tiếp mục ghi chú. Chuyển mục không chọn một phiên bản để xuất bản và không sửa dữ liệu; kiểm thử quay về nội dung vẫn đối chiếu chính xác nguyên văn.

## Cơ sở thiết kế

- Giữ tác vụ thường dùng ở lớp đầu, đưa tính năng bổ trợ vào lớp mở rộng có nhãn rõ ràng. Áp dụng từ [NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/), đọc ngày 14/09/2026.
- Hiển thị tên nguồn, ảnh gợi ý, nhãn và địa chỉ ô để người dùng nhận ra dữ liệu, không phải nhớ mã kỹ thuật hoặc nhập lại nội dung. Áp dụng từ [NN/g: Recognition vs. Recall](https://www.nngroup.com/articles/recognition-and-recall/), bài cập nhật 15/01/2024, đọc ngày 14/09/2026.
- Phần xem nguồn tổ chức theo câu trả lời và thông tin liên quan tới công việc, trước bất kỳ bước xác nhận tiếp theo. Đây là trang kiểm nguồn, chưa phải màn xác nhận đăng. Tham khảo [GOV.UK: Check answers](https://design-system.service.gov.uk/patterns/check-answers/), đọc ngày 14/09/2026.
- Lỗi tải có tiêu đề dễ hiểu, thao tác tải lại và focus tới thông báo; bộ lọc và bản đã nhận được giữ. Tham khảo [GOV.UK: Error summary](https://design-system.service.gov.uk/components/error-summary/), đọc ngày 14/09/2026.

Đã đọc và áp dụng skill `C:/Users/Admin/.agents/skills/redesign-skill/SKILL.md`: kiểm stack/luồng cũ, sửa phần ảnh hưởng lớn trước, dùng thành phần và màu hiện có. Không thêm thư viện thiết kế, font hoặc hình minh họa không giúp công việc.

## Kiểm chứng và giới hạn

**Mã cuối: 53/53 ca giao diện đạt trong một lượt chạy, không bỏ qua hoặc flaky**, tại `.local/input-catalog/vina-tuoi-20260914/ui-frozen-final-53.json` (2,9 phút). Gồm 31 ca vận hành giao diện cũ, 5 ca catalog và 17 ca knowledge/source-preview/workspace-flow. Không cộng số ca ở những lượt trước vào 53. Config dùng ứng dụng local đang chạy ở 5173, không tạo server, không migration hoặc seed DB. Những thao tác thử POST trong fixture đều bị chặn tại trình duyệt; các ca nguồn Lamy và kho kiến thức chỉ đọc local. Không chạy sandbox PG, lô 80 nguồn hoặc ghi Shopee.

Phản biện dữ liệu thật phát hiện một dòng không có issue trong Excel nhưng có cảnh báo từ listing cũ vẫn hiện số 0. Đã cộng `operationalReferences.concerns` vào phần chi tiết, dùng tổng `operationalConcernCount` do API cung cấp cho danh sách và mở thẳng mục ghi chú từ cảnh báo đó. Ca độc lập với `issues:[]` và một concern đạt; khi không có cảnh báo, nút chỉ ghi “Xem ghi chú & đối chiếu”. Ngày quan sát chỉ hiển thị ngày nguồn, không dựng độ chính xác giờ từ giá trị ngày.

Các kiểm thử mới trong `tests/e2e/source-catalog.spec.ts` chặn toàn bộ API bằng fixture giao diện: điều hướng bằng bàn phím, tìm kiếm đặt lại trang, văn bản chính xác tới `textContent`, gợi ý ảnh chưa xác nhận, quan sát shop cũ, lỗi/tải lại/nguồn rỗng và chiều rộng nhỏ. Fixture có số lượng riêng; không phải kiểm chứng 604 dòng thật hoặc Canva thật. Không có POST từ các phép đọc này.

Các entry của suite cũ được đổi theo menu mới và trang đầu mới; assertion về nguồn, dirty guard, yêu cầu ghi một lần và phục hồi vẫn giữ. Không đổi kết quả nghiệp vụ để ép test đạt. Các suite lô 80 nguồn chỉ cập nhật cách mở trang, không chạy lại trong lượt giao diện này.

Lượt đầu 25 ca đạt 24; một ca Workbench sau reload vẫn giả định trang đầu cũ. Đã bổ sung thao tác mở **Theo dõi công việc** sau reload. Lượt sau trong `ui-navigation-final.json` đạt 34/35: toàn bộ **31 ca cũ** (nhập thư mục, vận hành không kỹ thuật, Workbench, điều khiển lô và tên shop) đạt; 3 ca catalog đạt, ca chiều cao phát hiện dòng đầu ở 618px nên cần sửa tiếp. Không gọi báo cáo này là toàn bộ xanh.

Sau sửa bố cục và bổ sung bộ chuyển phần xem chi tiết, **4/4 ca catalog** đã đạt ở lượt trung gian `ui-catalog-compact.json` (10,6 giây). Fixture dùng tên bộ nguồn dài và tiêu đề 106 ký tự. Kiểm kiểu toàn repository đạt sau lần sửa cuối. Lượt 52 ca kế tiếp được dừng chủ động sau 11 ca để bổ sung phản biện số đếm cảnh báo nêu trên, không coi là lượt đạt. Sau đó mới chạy 53/53 trên mã cuối.

Phản biện độc lập bằng trình duyệt thật ở khoảng 694×735 phát hiện phần đầu chiếm hết màn hình. Đã giảm padding/khoảng cách, bỏ lời dẫn lặp, chuyển giải thích trạng thái thành một dòng mở rộng. Kiểm thử với tiêu đề dài yêu cầu dòng đầu nằm trọn và dòng tiếp theo đã hiện trong chiều cao 735px; giữ nút tác vụ 44px và không cắt ngang toàn trang để che lỗi. Ảnh cuối nằm dưới `.local/input-catalog/vina-tuoi-20260914/ui-frozen-final-53/`: `catalog-694-desktop.png`, `catalog-desktop.png`, `catalog-mobile.png`, `catalog-detail-desktop.png` trong thư mục từng ca. Đã xem trực tiếp ảnh 694px và chi tiết ở lượt compact; ảnh fixture không phải dữ liệu thật.

Đây là tiếp nhận và tra cứu nguồn. Chưa có thao tác xác nhận shop, chọn phiên bản nội dung, gán ảnh, bổ sung bảng giá/tồn hoặc tạo bộ sẵn sàng đăng từ catalog. Những khả năng còn thiếu được nói rõ; không có nút giả hoặc tự đánh dấu sẵn sàng.
