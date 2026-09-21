# Bàn giao luồng nhập bộ cập nhật — 12/09/2026

## Kết quả

Đã triển khai trên ứng dụng thật luồng **Công việc đăng hàng → Nhập bộ cập nhật → chọn nguồn/đích → xem thay đổi → chọn nhóm → lưu → mở lại**. Giá/tồn đến từ Excel, nội dung từ Word, ảnh từ các tệp đã chuẩn bị. Không yêu cầu nhập lại toàn bộ listing để đổi một phần, không có ô gõ lại giá/tồn từng SKU trong luồng chính.

Đây là nghiệm thu **chuẩn bị cập nhật nội bộ từ giao diện đến API và PostgreSQL**, chưa phải nghiệm thu gửi cập nhật lên Shopee hoặc hoàn thành ứng dụng production. Giá trị “trước” là bản nguồn đã lưu; giao diện nói rõ chưa đọc shop. Biên nhận mang trạng thái `prepared`; không có endpoint thực thi patch mới.

## Kết quả phản biện giữa các agent

Ba agent đảm nhận UX/triển khai giao diện, backend/triển khai hợp đồng dữ liệu, và nghiệm thu độc lập. Backend và UX kiểm tra giả định của nhau; reviewer đọc diff cuối, test và ảnh chụp, không tự nâng test local thành bằng chứng Shopee.

| Vấn đề phát hiện | Hành vi sau sửa |
| --- | --- |
| Bảng cập nhật bị yêu cầu như một bộ listing đầy đủ | Parser cập nhật riêng nhận SKU + giá hoặc SKU + tồn; Word/bìa có thể nhập riêng |
| Dòng thiếu SKU hoặc công thức lỗi có thể bị bỏ qua | Giữ ngoại lệ kèm ô nguồn; phân biệt ô trống, số 0 và công thức chưa có kết quả |
| Tồn của một nhóm cột hoặc bộ giá có thể áp sang nhóm khác | Ánh xạ cột có phạm vi; từng sheet/khối có tập công việc/shop riêng |
| Ảnh chỉ có một vai trò, thứ tự ảnh dùng chung cho mọi vai trò | Cùng bytes dùng nhiều vai trò; thứ tự riêng theo công việc và vai trò |
| Thêm vai trò làm mất SKU hoặc kéo vai trò cũ sang đích khác | Giữ SKU khi cùng đích; đổi đích chỉ dùng vai trò vừa chọn và yêu cầu ánh xạ SKU lại nếu cần |
| Word/ảnh mới dễ bị suy bố cục từ nguồn cũ | Chọn nguyên đoạn; chỉ ghép ảnh vào Word theo bố cục được chọn. Ảnh-only trên nguồn chưa rõ bố cục giữ ngoại lệ |
| Lọc giá/tồn vẫn phải bỏ chọn từng dòng | Chọn/bỏ chọn các thay đổi hợp lệ đang xem, giữ lựa chọn ngoài bộ lọc |
| Mất phản hồi sau máy chủ lưu có thể tạo yêu cầu mới | Giữ đúng request ID/body trong phiên, khóa sửa lúc chưa rõ, tải lại và khôi phục bằng cùng yêu cầu |
| Biên nhận có thể lấy nguồn ngoài tập tệp hoặc nguồn đã bị thay | Kiểm manifest, hash/size/bytes, phiên bản nguồn/công việc/kết nối và lưu trong giao dịch bất biến |

Kết luận review: **Spec PASS và Quality PASS trong phạm vi trên**. Xem [review cuối](../reviews/2026-09-12-import-patch-final-review.md), [review UI/API](../reviews/2026-09-12-import-patch-ui-backend-review.md) và [review backend](../reviews/2026-09-12-import-patch-backend-review.md).

## Bằng chứng

- Backend mới: 28 ca parser/integration; đã chạy trên PostgreSQL với schema riêng, không dùng DB giả để báo đạt.
- Agent giao diện chạy 24/24 ca: 13 ca mới qua API/worker nhập/blob/PostgreSQL thật tại máy, 11 ca Workbench dùng fixture. Đây là các tập giao nhau với lần kiểm tổng hợp, không cộng thành tổng khác.
- Kiểm tổng hợp của root: typecheck, TypeScript build, web build, 7/7 legacy và 361/361 unit/integration đều đạt. Bằng chứng máy đọc tại `.local/verification.json` và `.local/test-results.json`.
- Lượt browser tổng hợp sau khi đóng review: **56/56 đạt, 2,6 phút, exit 0**, gồm cả 13 ca import mới và các màn hình cũ. Bằng chứng `.local/e2e-results.json`. Không cộng 24 ca của agent vào 56 vì trùng nhau.
- Các ca mới bao gồm Excel 80 giá + 80 tồn chọn riêng giá; stock 0/ô trống; chỉ Word/bìa; hai bộ giá hai shop cùng SKU; cùng ảnh nhiều vai trò và thứ tự khác nhau; ảnh-only bố cục chưa rõ; mất phản hồi sau commit thật; lưu rồi tải lại.
- 80 SKU là fixture kiểm giao diện/chọn nhóm, **không phải 80 listing doanh nghiệp được đăng lên Shopee**. Bộ kiểm thử nguồn kỹ thuật sandbox ngày trước vẫn giữ kết quả 76/80 riêng.
- Ảnh desktop, mobile 390px và thứ tự gallery/mô tả được xem trực quan trong `.local/import-patch-review/`. Tệp và ảnh ở đây là dữ liệu thử có nhãn; không sửa ảnh doanh nghiệp.
- Browser fixture có schema/blob riêng, chỉ schema thử trong `search_path`, không có khóa Shopee, chặn fetch ngoài localhost; startup/cleanup lỗi làm suite thất bại. Các nguồn Lamy và WorkOrder của app chính không được dùng làm mục tiêu ghi thử.

Build có cảnh báo một JavaScript chunk lớn hơn 500 kB trước gzip; đây không phải lỗi build. Chưa đo hiệu năng 80 thư mục listing, tải nhiều người đồng thời hoặc vận hành 24 giờ.

## Trạng thái tại máy

Migration 009 đã áp dụng sau review backend. API mới trả HTTP 200, UI chạy tại `http://127.0.0.1:5173`, worker online. Kiểm lại sau toàn bộ suite lúc **10:20:27 UTC (17:20:27 ICT)**: toàn bộ phản hồi products và workbench trùng baseline trước sửa; Lamy vẫn revision 1, không có biên nhận thử ghi vào DB ứng dụng chính, `productionWrites:false`; UI HTTP 200. Bằng chứng riêng `.local/import-patch-review/protected-after.json`.

Không thực hiện cuộc gọi Shopee trong phần việc này. Không phát lại run Lamy `unknown`, không tạo Lamy trùng và không thay phạm vi shop thật chỉ đọc.

Thay đổi hiện nằm trong checkout local đang chạy; lượt này chưa commit hoặc push GitHub. Không thay nhánh, hợp nhất hoặc xóa công việc đang có.

## Hướng dẫn dùng và giới hạn

Xem [Nhập bộ cập nhật](../runbooks/import-updates.md). Chọn công việc đã có liên kết shop/link; nhập phần muốn cập nhật; chọn bộ giá đúng nhóm shop; xác định vai trò ảnh/đoạn Word chưa rõ; kiểm nguồn/đích rồi lưu. Biên nhận mở lại từ Công việc hoặc danh sách bộ cập nhật.

Chưa tự ghi nhớ mapping cho một file mới ở ngày sau; chưa tự lưu mọi lựa chọn nháp trước nút lưu. Mỗi Word/ảnh đang ánh xạ một công việc trong một lần nhập. Chưa có công cụ cấu hình mọi bố cục Excel tùy ý, import mọi thuộc tính ngành/vận chuyển hoặc tự nhìn ảnh để đoán SKU. Directory input đã nối giao diện; bộ browser mới kiểm nhiều tệp, chưa phải benchmark 80 thư mục.

Các cổng còn lại của toàn ứng dụng vẫn mở: liên kết item/model từ dữ liệu shop; thực thi và đối chiếu từng trường; lệnh tồn không bị phát lại sau đơn; refresh token; ngành/thuộc tính/khuyến mại/QC theo quyền thực tế; phục hồi bìa Lamy; triển khai nội bộ, backup/restore, chạy bền 24 giờ và pilot production có phạm vi được cho phép. Chi tiết nằm trong [audit E2E](../reviews/2026-09-12-e2e-acceptance-audit.md). Không gọi toàn bộ dự án đã hoàn chỉnh dựa vào nghiệm thu luồng nhập này.
