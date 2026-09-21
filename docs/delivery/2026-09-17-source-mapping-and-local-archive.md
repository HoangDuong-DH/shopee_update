# Bản v3 của 46 listing VINA TƯƠI và lưu trữ dữ liệu nội bộ

Checkpoint 2026-09-17T02:07:34.957592+00:00. Phạm vi: chuẩn bị nguồn, dọn danh sách nội bộ và kiểm tra ứng dụng; **không gọi ghi Shopee, không đăng thêm hoặc mở bán listing trong lượt này**. Người dùng tự nhập và bấm đăng ẩn.

## Nguồn đã cập nhật

Bản dùng hiện tại: `D:/VINA_TUOI_712_836_20260916/Bo_nguon`, tám nhóm Nhap_01…08; ZIP mới `D:\VINA_TUOI_712_836_20260916\VINA_TUOI_46_BO_712-836_V3.zip`. ZIP 2,998,508,270 byte / 1590 tệp; đã kiểm SHA từng thành viên và CRC. SHA toàn ZIP `25ddb998559c995e69e7ee282e11b42b41a4a330bbc8bf36f0489f7dc2ab792f`. Bản ZIP cũ còn nguyên; không đưa nhầm bản cũ khi hướng dẫn.

Theo quyết định người dùng: bỏ 200 vị trí 260ml ở 10 bộ xịt; gộp 228 lựa chọn MỚI trùng ở 19 bộ, giữ tên/ảnh lựa chọn thường; bỏ qua mô tả CAO CẤP khi ghép đúng mùi/dung tích và dòng sản phẩm. Cuối cùng ghép 14 lọ treo với tên hàng DORIS 8ml dù SKU có đuôi T10, và 2 ô nước lau sàn Không Mùi với dòng Nước lau sàn VNT 1 lít (VTKMLS1000). Đây là quyết định có phạm vi, không phải quy tắc bỏ qua sai dung tích hoặc đổi dòng sản phẩm trên mọi nguồn.

**46 listing / 1.773 vị trí / 82 SKU khác nhau / 0 ô thiếu mã**. 18 hồ sơ tự ghép giữ nguyên 675 vị trí; 28 bảng pending gồm 1.098 vị trí đã khớp mã, vẫn pending vì cấu trúc/ảnh/nội dung. Đã thay đúng 22 JSON, giữ byte của 24 JSON còn lại và toàn bộ Word/PNG/XLSX. Không chuyển trạng thái thành publish-ready chỉ vì đủ mã.

Còn các ngoại lệ thật: cặp hai chai Bạc Hà chưa chứng minh đúng mã combo; 38 mô tả có cồn chưa có xác nhận cho lô mới; Hoa Lài có câu thành phần Hoa Hồng; một số bộ có nhiều thiết kế hoặc ảnh khác dòng sản phẩm; ba bộ còn lịch sử công việc cần dùng lại. Chưa tự bỏ QC, đổi ngành, sửa nội dung hay kế thừa kích thước/quyết định của lô cũ.

Biên nhận ở `.local/vina-input-712-836-20260916/revisions/20260917-mapping-v3/`: release-manifest, validation, countercheck, applied-receipt, zip-receipt. Bản trước của 22 hồ sơ và các hướng dẫn nằm ngoài thư mục nhập, trong `D:/VINA_TUOI_712_836_20260916/Luu_tru_goi_cu/Truoc_ban_v3_20260917`. Checksum thư mục đã tái tạo theo đường Nhap_01…08. Hướng dẫn vận hành: [tự nhập 46 listing](../operator-guides/thu-nghiem-46-listing-vinatuoi.md).

## Dọn giao diện và dữ liệu

Migration032 thêm overlay lưu trữ và sự kiện bất biến. UI có Lưu trữ/Khôi phục cho dòng catalog, đợt nhập, bản nháp và bảng giá; lọc Đang sử dụng/Đã lưu trữ. Nút ảnh hiện Bỏ chọn. Lưu trữ không xóa nguồn hay biên nhận.

Đã lưu trữ 558 dòng catalog ngoài lô, 2 đợt Cam Sả cũ, 1 bảng KINI và 1 nháp Lamy: **562 mục**. Còn đúng **46 dòng catalog active**, DORIS là bảng giá active duy nhất, 0 đợt thư mục active. 13 bảng nguồn/lịch sử có cùng hash trước-sau; trạng thái lưu trữ nằm riêng. Kiểm độc lập GET/SQL xác nhận số lượng; browser thật tại localhost đã thấy46 dòng và nút lưu trữ. App đang mở màn nhập thư mục, chọn DORIS / FILE GIÁ DORIS / SHOP MALL và chế độ Mỗi thư mục con là một listing; chưa chọn tệp, chưa nhập lô mới.

10 nháp thử cũ chưa lưu trữ được vì cùng parent a9b09646… đang paused/PREPARATION_CHILD_REVIEW_REQUIRED. 6 sản phẩm đã verified, Hương Thảo còn acknowledged/giữ lane, Hoa Hồng/Hoa Lài/Cam Sả chưa có operation. Guard bảo vệ theo lô chưa kết thúc; không phải cả10 đều chưa đăng. Không sửa parent thành completed để ép lưu trữ. Registry đã approved nhưng chưa registered sau crash cũng được bảo vệ.

Local lifecycle lock bảo vệ chọn/lưu nguồn và đường preview/register production mới. Các đường mutation legacy raw Plan/WorkOrder/prepared sandbox chưa được chứng minh đều có guard archive; không gọi đây là bảo vệ mọi writer cũ.

Bằng chứng `.local/lifecycle-20260917/`: cleanup-plan, cleanup-receipt, independent-cleanup-audit, migration-audit, full-verification, full-test-results. Full kiểm cuối **2.065/2.065 unit/integration + 7/7 legacy**, typecheck/TS/web build đạt. 4 ca archive UI, 8 catalog, 2 DORIS và13 workspace đã đạt qua các lượt tập trung; không có một lượt27 chung toàn xanh cuối cùng, không dùng số này làm bằng chứng Shopee thật. Bản nguồn v3 có841/841 kiểm parser và859/859 kiểm độc lập.

## Dung lượng và vận hành

Ổ C đã hết chỗ lúc ghi applied-receipt, sau khi bản D đã áp đúng. Đã kiểm lại toàn bộ D trước khi phục hồi biên nhận rồi đóng ZIP; không áp lại thao tác hoặc bỏ qua hash. Các ZIP10/12 cũ và53ZIPCanva gốc đã chuyển sang `D:/VINA_TUOI_712_836_20260916/Luu_tru_goi_cu`, có biên nhận SHA; ảnh giải nén giữ nguyên. Không chạy lại script apply lần đầu. API4310 PID71772 từ08:43:54+07; UI5173 PID23320 tại checkpoint, phải kiểm freshPID/busy trước thay đổi. Không in/commit khóa hoặc dữ liệu .local.


Bổ sung sau xác nhận riêng của người dùng: đã xóa đúng bản lặp `C:/shopee_product_uploader/.local/vina-input-712-836-20260916/Bo nguon 46 san pham VINA TUOI`, sau khi đối chiếu lại SHA đủ1.534 tệp/2.986.837.080byte với bản sao `D:/VINA_TUOI_712_836_20260916/Luu_tru_goi_cu/Bo_nguon_C_truoc_portable`. Bản D nguyên vẹn, Bo_nguon v3/ZIP v3 không đổi. Receipt `.local/lifecycle-20260917/approved-staging-removal.json`; C trống3.443.347.456byte tại02:15:26Z. Đường C staging/downloadZIP trong hồ sơ cũ là lịch sử, tra biên nhận di chuyển để lấy bản D; không tải lại Canva hoặc dựng lại nguồn vì đường cũ trống. Auto-review ban đầu từ chối xóa staging; đã sao lưu đầy đủ, hỏi đúng thư mục và nhận xác nhận rõ rồi mới thực hiện.
