# Kiểm thử giá, ảnh và phân loại — 14/09/2026

Đã bổ sung kiểm thử tình huống lỗi và thử ghi trực tiếp trên hai listing kỹ thuật sandbox. **Phép thử đã phát hiện lỗi bìa thực tế; chưa nghiệm thu đầy đủ cập nhật ảnh hoặc ứng dụng production.** Shop thật không bị thay đổi.

## Các phép thử sandbox mới

TEST partner 1232297, shop 227418363, kết nối revision 7 / quyền revision 6. Token cũ bị từ chối ở API đọc; người dùng đã cập nhật token và kết nối mới được kiểm tra lại. Hai listing đích 803934787 và 803935036 đều là nguồn kỹ thuật `SBX-BULK-`, đang `UNLIST`. Không tạo listing, không ghi Lamy.

| Tình huống | Thao tác và kết quả thực tế | Phần được giữ nguyên |
|---|---|---|
| Tồn 0 ở listing hai tầng | Model 4258854182, kho VNZ: 2 → 0. Hai lần đọc lại đạt. | Giá; ba model còn lại; toàn bộ nội dung, ảnh và cấu trúc. |
| Đổi ảnh phân loại hai tầng | Đổi ảnh lựa chọn “Cam” ở tầng đầu bằng mã ảnh QA đã có. Ảnh này áp dụng chung cho hai SKU Cam; hai lần đọc lại đạt. | Đủ bốn model, ID/SKU/tier index, tên và thứ tự cả hai tầng, ảnh Xanh, giá/tồn. |
| Chuyển gallery 1:1 → 3:4 | Tải ba PNG QA gốc 900×1200, gửi kèm mã bìa cũ. Gallery đúng nhưng Shopee lấy ảnh gallery mới đầu tiên làm bìa. **Không đạt giữ nguyên bìa.** | Đối chiếu raw không thấy thay đổi phần ngoài gallery/bìa ngoài `update_time`. |
| Khôi phục bìa bằng lệnh riêng | Gửi lại mã bìa sổ tay ban đầu qua một intent mới, chỉ đổi bìa. Ảnh đọc lại hiển thị đúng sổ tay 1000×1000. | Gallery 3:4, giá 20.000, tồn 2 và các trường còn lại giữ nguyên ở hai lần đọc cuối. **QC tự động vẫn chưa đạt vì Shopee đổi ID và nén lại ảnh.** |

Tổng lượt này: **bốn yêu cầu cập nhật listing và ba yêu cầu tải ảnh**, đều trên sandbox. Hai ca đạt kiểm tra tự động, một ca phát hiện thay đổi ngoài lựa chọn và một lệnh khôi phục được kiểm tra nội dung ảnh bằng mắt. Không gộp bốn ca thành “4/4 thành công”.

Lệnh chuyển tỷ lệ `f024d84e-9f95-48da-bdee-4749641873c0` và lệnh khôi phục `0c2ed720-0dc8-4ff4-9f47-607c14979bac` đã có biên nhận; **không gửi lại**. Hai intent tồn/ảnh phân loại cũng không được phát lại. Không bỏ kiểm mã bìa toàn cục để ép báo cáo thành công: ở ca gallery, ảnh đã đổi nội dung thật; ở ca khôi phục, ảnh hiển thị đúng nhưng ID/bytes khác. Hai tình huống cần bằng chứng riêng.

Trong một lần đọc trung gian sau khôi phục, API tạm không trả `estimated_shipping_fee` cho ba kênh; hai lần đọc cuối trả đủ giá trị ban đầu. Giữ toàn bộ các lần đọc trong bằng chứng, không suy từ việc thiếu trường thành phí bằng 0 hoặc đã đổi cấu hình vận chuyển.

## Giá và các tình huống giả lập

Hai phép đổi giá một SKU của listing một tầng/hai tầng đã đạt trên sandbox ở lượt FIELD-20260914-B trước đó. **Lượt mới không gửi thêm giá:** `get_item_promotion` của cả ba mẫu kỹ thuật không trả trường `promotion`, nên bộ xử lý hiện tại chưa đủ bằng chứng về chương trình đang/sắp chạy. Không tự hiểu trường thiếu thành danh sách rỗng, không bỏ guard vì giá hiện tại bằng giá gốc.

Các ca bổ sung tại máy kiểm tra:

- Tăng/giảm giá nhiều SKU, cùng mã SKU xuất hiện ở ba shop; giữ model/shop không chọn. Giá 0, âm, thập phân, vượt giới hạn, dữ liệu khuyến mại thiếu/không đúng item và giá sỉ chưa hỗ trợ đều phải bị chặn.
- Tồn 0 cho sản phẩm không tầng/hai tầng; mất phản hồi sau khi phía nhận đã áp dụng tồn; chạy lại không bù tồn hoặc gửi lại lệnh.
- Đổi bìa và gallery theo cả hai thứ tự trên baseline 3:4; bảo vệ ảnh bìa và thứ tự; phân biệt vai trò ảnh; không crop ảnh nguồn.
- Ảnh phân loại dùng chung lựa chọn tầng đầu; thiếu một model trong nguồn; đổi nhầm tên/SKU/tier index; các yêu cầu đổi cấu trúc ngoài phạm vi.
- Thành công một phần model phải dừng bước tiếp theo. Lỗi HTTP200, giới hạn gọi API, token hết hạn, quyền bị từ chối, JSON hỏng và mất kết nối không được báo thành công hoặc tự gửi lại.
- Hai tiến trình cùng chạy một lệnh; shop khác vẫn xử lý khi một shop chưa rõ kết quả; phiên bản kết nối thay đổi; đọc chậm và dữ liệu ngoài lựa chọn thay đổi.

## Lỗi đã sửa và giới hạn còn lại

1. **Thiếu model khi cập nhật ảnh phân loại:** planner trước đó có thể phát danh sách model bỏ sót một SKU đang tồn tại trên Shopee. Nay yêu cầu tập ID model khớp đầy đủ trước khi lập lệnh.
2. **Giá sỉ:** planner trước đó có thể cho đổi giá gốc dù chưa xử lý ràng buộc giá sỉ. Nay chặn rõ cấu hình giá sỉ chưa hỗ trợ; không tự đặt quy tắc tỷ lệ từ ví dụ.
3. **Mã nhóm phân loại:** QC trước đó từ chối `variation_group_id` hợp lệ do planner giữ lại. Nay chỉ chấp nhận đúng mã đã quan sát, vẫn chặn mã bị đổi hoặc bỏ.
4. **Chuyển tỷ lệ gallery:** thử thực tế cho thấy có thể thay bìa dù gửi bìa cũ. Luồng tự động chuyển 1:1 → 3:4 bị khóa lại; cần thiết kế và nghiệm thu thao tác nhiều bước, khôi phục và kiểm ảnh trước khi mở.

Nhật ký HTTP hiện chưa tự đọc baseline ngay trước mỗi lần ghi và chưa tự chuyển sang trạng thái QC thành công. Một ca giả lập chứng minh stock thay đổi sau khi chuẩn bị: nhật ký vẫn nhận biên nhận tiêu đề, nhưng QC độc lập phát hiện stock lệch. Các script sandbox lượt này kiểm baseline mới trước ghi; **điều đó chưa hoàn thiện cơ chế này trong worker của ứng dụng**.

Đổi tên phân loại/SKU, thêm/bớt hoặc đổi thứ tự cấu trúc, đổi ngành, Flash Sale, tồn có dự trữ/nhiều kho và mọi trường listing chưa được nghiệm thu trong executor này. Các bài thử không chứng minh đã bao quát mọi trường hợp có thể xảy ra.

## Bằng chứng

Kiểm tra tổng hoàn tất **14:03 ngày 14/09/2026 (UTC+7): 725/725 unit/integration, 7/7 legacy, kiểm kiểu và build đều đạt; không bỏ qua test**. So với checkpoint trước có 73 ca mới: 46 ca ràng buộc planner/QC, 15 ca tích hợp HTTP/DB và 12 ca lỗi truyền nhận. Các test đạt bao gồm việc phát hiện/chặn hành vi sai; không chuyển kết quả sandbox lỗi thành ca thành công. UI/API tại máy vẫn trả HTTP200; không chạy lại bộ kiểm thử trình duyệt trong lượt này vì giao diện không thay đổi.

- Kiểm tra tổng: `.local/acceptance-20260914/patch-matrix/final-verification.json`, `final-unit-results.json`.
- [Ma trận phạm vi chi tiết](../test-reports/2026-09-14-patch-case-matrix.md).
- [Phản biện planner và nguồn Shopee](../reviews/2026-09-14-patch-boundary-review.md).
- Sandbox: `.local/acceptance-20260914/patch-matrix/live/` — intent, từng biên nhận và từng lần đọc; thư mục `gallery-portrait`/`cover-restore` có ảnh trước/sau và hash.
- Đối chiếu raw độc lập: `.local/acceptance-20260914/patch-matrix/independent-live-audit.json`.
- 15 ca HTTP/DB giả lập: `.local/acceptance-20260914/patch-matrix/run-296d340a-0253-4d58-9cc3-9c246711f9a4/matrix.json` và `matrix-audit.json`.
- Bảo toàn dữ liệu chính: `.local/acceptance-20260914/patch-matrix/main-data-audit.json`. Bảy bảng nguồn/phiên bản/công việc/đợt nhập/run cũ giữ nguyên hash. Các shop giả chỉ nằm trong schema kiểm thử riêng.

Tài liệu chính thức được đối chiếu từ KB chụp 08/09; lần mở lại trang chính thức ngày 14/09 trả HTTP403. Các quan sát sandbox mới là bằng chứng vận hành của đúng shop và thời điểm, không phải xác nhận policy hoặc quyền production.
