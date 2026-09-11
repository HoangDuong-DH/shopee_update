# Giao diện nhận bộ listing đã chuẩn bị — 11/09/2026

## Vấn đề và thay đổi

Người dùng phản ánh giao diện khó hiểu và nút ghép SKU dễ làm sai cấu trúc bộ listing đã chuẩn bị. Kiểm mã xác nhận nút cũ tạo bản nháp local mới, không sửa listing ngoài Shopee; tuy nhiên nó cho chọn dòng giá bất kỳ, giữ lựa chọn qua bộ lọc, và tự dùng tên sản phẩm làm nhãn phân loại.

Đã thay luồng chính bằng **Listing của tôi → Nhập listing có sẵn → Kiểm tra listing**, với ba mục chính Listing/Tệp nguồn/Kết quả. Kết nối shop và kho tài liệu nằm trên thanh công cụ phụ. Mỗi dòng trên trang đầu là một bộ nguồn có ảnh, số SKU, khoảng giá và hành động kiểm tra; không có KPI/công suất giả định.

- Bảng giá chỉ đọc; không còn checkbox chọn SKU hoặc nút ghép vào listing.
- Nhập bộ có mã ổn định, file/sheet/bộ giá chọn rõ, bảng SKU/nhãn được dán nguyên văn từ nguồn. Khớp SKU chính xác, không bỏ khoảng trắng/đổi chữ hoa, không tự chọn dòng đầu khi mơ hồ, không tự tạo tổ hợp. Người dùng xác nhận thành phần bộ trước khi sang nội dung/ảnh.
- Bản đã lưu mở chỉ đọc. Chỉ nút điều chỉnh rõ ràng mở sửa nội dung/ảnh. Tên tầng, thứ tự và nhãn phân loại 0–2 tầng được giữ; không còn thao tác làm mất tầng hai.
- `Repository.saveProduct` kiểm cấu trúc trong transaction, sau khóa và kiểm phiên bản. Thay đổi thứ tự SKU/tầng/nhãn của cùng `productKey` bị trả `PRODUCT_MEMBERSHIP_LOCKED`, không tạo revision mới. Thay giá, nguồn dòng, nội dung và ảnh vẫn được phép khi cấu trúc giữ nguyên.
- Không mặc định shop đầu tiên. Lưu bản kiểm tra theo shop được ghi rõ chỉ là ngữ cảnh nội bộ cho đăng mới; cập nhật item/model hiện chưa hỗ trợ.
- Cảnh báo dữ liệu chưa lưu; chặn chuyển màn hình khi tải tệp hoặc đang gửi yêu cầu lưu. Không dùng hủy HTTP như bảo đảm rollback. Lỗi tải tệp chỉ rõ vị trí dừng và số tệp còn lại.
- Nội dung/ảnh tách thành hai tab. Word chỉ dùng làm văn bản đối chiếu, bỏ hành động thêm đoạn tự chèn dòng trống. Bộ mới phải chọn rõ bố trí mô tả hiện hỗ trợ; bố trí khác giữ trạng thái chưa hỗ trợ.

Không thay framework/thư viện; extension cũ giữ nguyên. Backend mới chỉ thêm chốt lưu local và thông báo lỗi, không thêm lời gọi Shopee.

## Kiểm chứng thực tế

- `node scripts/verify.mjs`: typecheck, build, **7/7 legacy** và **110/110 unit/integration** đạt. PostgreSQL kiểm thử dùng schema cô lập. Báo cáo tại `.local/verification.json`, thời điểm 2026-09-11T02:47:41.803Z, và `.local/test-results.json`.
- **11/11 Playwright E2E** đạt: 8 ca dùng UI/nguồn local thật và 3 fixture chỉ trong trình duyệt (bản hai tầng, phản hồi lưu kế hoạch chậm/lỗi, phản hồi lưu sản phẩm chậm/lỗi). POST fixture bị chặn tại trình duyệt, không tới API hoặc dữ liệu riêng. Có hồi quy không chọn shop ngầm, giữ 6 SKU/9 ảnh Lamy, bản nguồn mặc định chỉ đọc, cảnh báo chưa lưu và phục hồi lỗi lưu.
- Thử trước sửa tái hiện 10 trường hợp thay cấu trúc được lưu sai; sau sửa bị chặn và revision gốc còn nguyên. Các ca bộ nhập kiểm SKU/phân loại/giá mơ hồ hoặc thiếu, giữ thứ tự và đủ hai tầng.
- Đã kiểm hình thực tế desktop 1440px và mobile 390px: trang listing, xem trước, nhập bộ và tab ảnh; không tràn ngang trang. Ảnh riêng nằm trong `.local/e2e-artifacts/`, kiểm chứng bổ sung `.local/ux-capture-evidence.json`.
- Đã khởi động lại app/API/worker tại máy và đọc readiness `ready`; `productionWrites:false`, `listingExecutor:not_configured`, worker `online`. Đã nhìn trực tiếp tab ứng dụng của người dùng hiển thị trang Listing của tôi mới.

Đây không phải phép thử đăng/cập nhật backend Shopee, QC, tải 50–80 listing hoặc chạy 24h. Không thay nguồn sản phẩm, giá/tồn hay shop thật trong đợt thay giao diện này.

## Giới hạn cần giữ rõ

Nhập bộ mới hiện vẫn là dán danh sách phân loại và gán nội dung/ảnh qua UI. Chưa có parser nhận trọn mọi bộ Word/Canva/Excel tự động. KINI là nguồn giá, không đủ tự chứng minh SKU nào thuộc một listing. Nhãn/source Word đang do người dùng đối chiếu, chưa có mapping đoạn đầy đủ.

Chốt cấu trúc bảo vệ **cùng mã bộ local**; không xác minh quan hệ SKU với listing Shopee, và không nhận diện hai mã bộ khác nhau là cùng sản phẩm. Thay thành phần/phân loại đã lưu cần luồng có đối chiếu riêng sau này, không có trường bypass trong request. Mã bộ mới vẫn chịu kiểm revision ở server nếu trùng mã đang có, kể cả UI chưa tải trạng thái mới.

Nhập trọn bộ, mapping ngành/thuộc tính/giới hạn theo shop, giao diện tồn, cập nhật item/model, thực thi lô, QC và production vẫn chưa nghiệm thu. A4/A3 giữ `in_progress`, không đổi thành hoàn tất vì giao diện đã được sửa.

## Cơ sở quyết định

- Yêu cầu người dùng và `AGENTS.md`: bộ listing đã chuẩn bị, không tự gộp/tách/đổi nguồn; nội bộ không thêm đăng nhập nhân viên.
- `docs/superpowers/specs/2026-09-11-prepared-listing-publishing.md`: đơn vị vận hành là bộ listing, nguồn và scope tách rõ.
- `knowledge-base/shopee-open-platform/AGENT_GUIDE.md` và `knowledge-base/shopee-uni-vn/AGENT_GUIDE.md`: kho chụp 08/09 cần phân biệt dữ kiện, chính sách và quyền.
- [Creating product — Guide 211](https://open.shopee.com/developer-guide/211), ngày nguồn 19/09/2025, bản chụp 08/09/2026: cấu trúc biến thể và vai trò media. Đợt này sửa cách giữ dữ liệu và UX local, không chốt giới hạn/quyền Shopee hiện hành hoặc triển khai adapter từ ví dụ tài liệu. Khóa bộ là quy tắc vận hành ứng dụng theo yêu cầu người dùng, không diễn giải thành quy định cấm đổi phân loại của Shopee.

Hướng dẫn thao tác: [listing-workspace.md](../runbooks/listing-workspace.md).
