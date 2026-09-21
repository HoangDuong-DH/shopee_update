# VINA TƯƠI — nguồn nhập lại và xử lý ảnh phân loại, 17/09/2026

## Kết quả cuối

Nguồn tại `D:/VINA_TUOI_712_836_20260916/Bo_nguon`: **43 hồ sơ hoàn chỉnh / 1.699 vị trí SKU**, 2 bộ chờ. Nhóm Nhap_01→08 lần lượt đủ 6/5/5/5/6/6/6/4 bộ. Không gửi listing mới lên Shopee trong lượt này. Đủ nguồn chưa đồng nghĩa đủ quyền/ngành/thuộc tính/vận chuyển để gửi.

- Sửa 38 Word: thành phần theo xác nhận “Nguyên chất 100%”, bỏ câu Hoa Hồng sai trong Hoa Lài, giữ ý cảnh báo. C01 cho Túi Xách/Ô Tô/Phòng Khử Mùi Hôi/Khách Sạn. 13 hồ sơ giữ 9 gallery đầu, ảnh10 còn ở nguồn.
- Gán 1.072 vị trí ảnh phân loại theo slot/SKU/path/SHA. Domain/backend giữ candidates và kiểm lựa chọn thật; frontend có bulk chọn ảnh khớp, chọn cả C01/C02, giữ khi reload và truyền imageId đúng sang draft.
- 25 bảng chờ đủ nguồn đã chuyển thành hồ sơ tự ghép strict. Pending gốc chuyển vào thư mục backup ngoài Bo_nguon. Hai ngoại lệ: Lọ treo xe Sả Chanh thiếu ảnh; Bạc Hà cặp2chai chưa có SKU/giá combo.
- Theo yêu cầu mới, KHÔNG nhập sẵn/lưu 43 draft cho người dùng. Chỉ khoảng nửa nguồn đã được đọc vào blobstore trước khi người dùng yêu cầu tự nhập từ đầu; imports giữ để tái sử dụng hash.
- Lưu trữ cả 4 intake cũ; active intake=0. Nháp Thảm Xốp740 được sửa rồi người dùng yêu cầu bỏ: archive old canonical key, giữ 2rev/2plan/claim, phát hành manifest generation mới `vina-source-2b65dda4caf6e5b4-01-182-generation-20260917-2`, sourceRevision0. Có receipt nối old→new. Không xóa immutable audit.
- 10 nháp thử cũ còn active vì `LOCAL_ARCHIVE_IN_USE`, không vượt guard. DORIS, shop connection và lịch sử thực thi giữ nguyên.
- Nút **Bắt đầu phiên nhập mới** xóa đúng 2 working-copy session keys, không xóa dấu phục hồi hoặc biên nhận. Đã bấm trong tab18 và quan sát màn nhập trống. Browser vẫn mở cho người dùng.

## Runtime

DATA_ROOT trong `.env` hiện **D:/SHOPEE_UPLOADER_DATA**; đã copy/kiểm SHA779tệp và API media readback2tệp đúng. API PID11704, worker82420 tại mốc08:09UTC, healthready. PostgreSQL/Docker đã bị treo; restart thường timeout, đã restart đúng các process Docker và phục hồi health. Không xóa volume/migration.

Bản `.local/data` cũ trên C vẫn giữ: auto-review từ chối lệnh gộp xóa đệ quy và đổi revision metadata, nên không chạy/xóa bằng đường khác. Người dùng sau đó yêu cầu archive nháp740; thực hiện bằng route chuẩn và manifest generation có receipt riêng, không đổi revision của oldhistory.

## Kiểm chứng

- Domain/claim/private-PG focused:55 đạt; frontend/domain/claim nhóm59 đạt (có chồng lặp, không cộng).
- Folder-sidecar browser8 đạt; fresh-intake-session browser1 đạt; typecheck và root TypeScript/Vite build đạt.
- Source checks2736, independent7512, strict43 assembler240; cuối đọc trực tiếp D xác nhận43strict+2pending/1699slots.
- Fresh GET metadata3ngành101127/101213/101162 đều có VINA TƯƠI1252097; khoVNZ/writeLocationnull được kiểm. 101213 bắt buộc attr100752; option4021 cho lau sàn. Metadata không chứng minh quyền category hay E2E43listing. Không tự biến missing size_chart_mandatory thànhfalse.

## Bằng chứng riêng tại máy

`.local/pending-completion-20260917/final-result.json`, `source-apply-result.json`, `portable-apply-result.json`, `740-reset-receipt.json`, `workspace-archive-final.json`, `fresh-metadata-summary.json`, `storage-copy-receipt.json`, `storage-media-readback.json`.

Hướng dẫn tại D: `BAT_DAU_TAI_DAY.txt`, `TINH_TRANG_NGUON_HIEN_TAI.csv`. Dùng nguồn hiện tại, không giải nén ZIP cũ đè lên. Người dùng tự nhập Nhap_01→08, chọn DORIS/SHOP MALL/GIÁ GỐC, lưu nháp rồi chuẩn bị lô hidden_for_review. Tồn100/SKU đã được xác nhận. Không tự chạy gửi thay người dùng trong lượt này.
