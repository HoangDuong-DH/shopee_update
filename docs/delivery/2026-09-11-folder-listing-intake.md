# Nhận bộ listing theo thư mục — 11/09/2026

## Nhu cầu vận hành đã xác nhận

Nhân viên nhận **mỗi listing một thư mục ảnh + Word**, dùng **bảng giá chung**. Ảnh phân loại ở cùng thư mục với ảnh listing, được phân biệt bằng nội dung nhìn thấy; không có quy ước tên SKU được xác nhận. Doanh nghiệp đã làm sẵn sản phẩm, nội dung, hình và cấu trúc phân loại.

Luồng mới bắt đầu từ thư mục, thay việc tiếp nhận từng tệp rồi nhập lại mọi lựa chọn. Không tạo nội dung, cắt ảnh, suy nhãn phân loại từ tên hàng trong bảng giá hoặc tự sinh tổ hợp SKU.

## Đã triển khai

- Màn hình nhận một thư mục listing hoặc thư mục cha chứa nhiều listing. Người dùng chọn rõ cấp thư mục; giữ ảnh trong thư mục ảnh con thuộc cùng listing.
- Chọn bảng giá, trang tính và bộ giá một lần cho đợt. Dữ liệu giá vẫn đi qua bộ đối chiếu SKU chính xác hiện có; GIÁ GỐC dùng cho giá đăng mới, GIÁ BÁN tách riêng.
- Sau khi đọc, phần chọn nguồn thu gọn thành tóm tắt để nhường màn hình cho danh sách listing và ảnh. Có thể mở lại lựa chọn hoặc đọc tiếp tệp; thiếu bảng giá và lỗi phân nhóm vẫn hiện rõ.
- Đọc tệp với tối đa ba tác vụ đồng thời mặc định. Giữ đường dẫn tương đối của từng tệp; các thư mục có tên ảnh giống nhau không bị ghép chung. Một tệp lỗi không làm mất kết quả các tệp khác.
- Tính SHA-256 từ bytes gốc, kiểm SHA/kích thước/loại tệp và mã bản nhập sau phản hồi. Dùng lại bản đã nhận khi nội dung giống nhau, kể cả tên khác; tên và vị trí riêng của tệp trong thư mục vẫn được giữ. Thử tiếp tệp đã nhận bằng đọc trạng thái, không tự gửi lại cả bộ.
- Một bảng ảnh trực quan cho từng listing: chọn nhiều ảnh, gán vào ảnh sản phẩm, mô tả hoặc cả hai; bìa được chọn riêng. Giữ thứ tự lựa chọn và có điều chỉnh thứ tự. Ảnh số không tự trở thành ảnh của SKU.
- Đọc các mục Word có nhãn rõ ràng và hiện kết quả nguyên văn để đối chiếu. Có cách đọc theo nhãn/câu mở đầu/dấu xuống dòng do người dùng chọn. Word không xác định được vẫn hiện nguồn để đọc, nhưng không điền cả tài liệu vào mô tả.
- Khi chưa có danh sách SKU/nhãn xác định, **Bổ sung SKU/phân loại** chỉ chuyển sang bước còn thiếu với bảng giá đã chọn; nội dung và vai trò ảnh đã xác định được chuyển tiếp. Bộ chọn ảnh/Word trong editor giới hạn theo thư mục này. Tệp bổ sung được đưa vào đúng phạm vi bằng mã bản nhập thực tế trả về.
- Đợt thư mục vẫn ở bộ nhớ khi mở editor, lưu một bộ rồi quay lại xử lý bộ tiếp theo. Chặn rời trang trong lúc nhận tệp và nhắc về phần chưa lưu. Luồng nhập thủ công cũ là lựa chọn phụ; không ghi đè phần khôi phục thủ công khác bằng dữ liệu thư mục.

## Kiểm chứng

- `scripts/verify.mjs` hoàn tất lúc **2026-09-11T04:01:16.802Z**, mọi bước có exit code 0: typecheck, build TypeScript/web, **7/7 legacy**, **144/144 unit/integration** trên 19 tệp kiểm thử. PostgreSQL thật với schema kiểm thử cô lập. Báo cáo riêng: `.local/verification.json` và `.local/test-results.json`.
- 19 kiểm thử mới cho nhóm thư mục, giữ nguyên chữ, membership có nguồn, ảnh dùng tên số không tự suy SKU, phân vai trò ảnh, nguồn trùng tên nhưng khác listing, alias cùng bytes, chặn sai nội dung/kích thước/loại tệp/mã phản hồi, giới hạn đồng thời và thử lại đúng tệp.
- **27/27 E2E trình duyệt đạt**, 73,810 giây, bắt đầu **2026-09-11T04:01:09.389Z**; không fail, skip hoặc flaky. Gồm 12 tình huống local thật chỉ đọc và 15 tình huống fixture có mọi ghi bị chặn ở trình duyệt. Năm ca mới kiểm thư mục/giá chung, nguyên văn Word và đúng mã/thứ tự ảnh qua bước bổ sung phân loại, tệp lỗi độc lập, khóa chuyển màn khi đang đọc và Word chưa rõ không bị điền thành nội dung.
- Ảnh chụp mới desktop 1440px/mobile 390px tại `.local/e2e-artifacts/folder-batch-desktop.png` và `folder-batch-mobile.png`, có hai thư mục fixture; không tràn ngang. Đã kiểm mở lại phần chọn nguồn vẫn giữ lựa chọn và thu gọn được. Fixture dùng ảnh kiểm thử, không phải kết quả đăng sản phẩm thật.
- Đọc local API sau kiểm tra: vẫn một bộ `lamy-5d`, revision 1, sáu SKU; worker online, `productionWrites:false`, `listingExecutor:not_configured`.

Các phép thử giao diện phân biệt dữ liệu local chỉ đọc với API xử lý nguồn giả lập; không coi chúng là kiểm thử đăng Shopee.

## Giới hạn còn lại

- Chưa có dịch vụ thị giác để nhận diện nội dung ảnh hoặc đọc nhãn/SKU từ ảnh. Người vận hành vẫn xác định SKU/nhãn và ảnh phân loại khi nguồn chưa có mapping rõ ràng. Không yêu cầu đổi tên ảnh để hợp thức hóa suy đoán.
- Nhận diện lại bộ đã lưu hiện dựa trên dấu vết đường dẫn/nội dung trong cùng cách nhập. Đổi tên/đường dẫn thư mục hoặc sửa nguồn có thể tạo mã khác. Chưa có liên kết phiên bản nguồn với định danh listing ổn định, và chưa chống mọi trường hợp nhập cùng sản phẩm thực tế.
- Đợt thư mục giữ trong bộ nhớ của trang, chưa có checkpoint bền vững hoặc khôi phục sau tải lại/đóng tab. Tệp đã nhận và bộ đã lưu nằm ở server; vai trò ảnh/phần đang nhập chưa lưu sẽ mất khi tải lại.
- Word được đọc theo đoạn chữ; bố cục, ảnh nhúng và mapping tự động cho mọi mẫu tài liệu chưa hoàn tất. Mẫu đọc Word áp dụng trong đợt hiện tại, chưa lưu thành cấu hình dùng chung có phiên bản.
- Tệp đã xử lý thất bại được giữ trạng thái lỗi để hỗ trợ xử lý. Chưa có API chạy lại worker cho cùng bản nhập thất bại; bấm đọc lại không tự sửa tệp lỗi hoặc đổi bytes nguồn.
- Chưa có lưu tất cả listing trong đợt bằng một nút. Từng bộ còn cần đủ nguồn, đối chiếu và lưu riêng. Ngành/thuộc tính/tồn/vận chuyển, executor, cập nhật, QC và vận hành 24 giờ vẫn thuộc kế hoạch chưa nghiệm thu.

A4 tiếp tục `in_progress`. Đợt này không thêm gọi OpenAPI hoặc thay quyền ghi shop thật. Bộ Lamy đã lưu được dùng để kiểm tra chỉ đọc, không tạo bản Lamy trùng.

## Cơ sở và hướng dẫn

- Yêu cầu trực tiếp ngày 11/09/2026 về thư mục listing, bảng giá chung và ảnh phân biệt bằng hình.
- `AGENTS.md`; hai `AGENT_GUIDE.md` của kho Shopee Open Platform/Học viện Việt Nam (bản chụp 08/09). Không thêm kết luận policy/giới hạn hiện hành của Shopee trong đợt sửa giao diện này.
- [Hướng dẫn nhân viên](../runbooks/listing-workspace.md).
