# 17/09/2026 — Đổi tên ảnh v4 và sửa nguồn lẫn sản phẩm

Đã áp dụng tại `D:/VINA_TUOI_712_836_20260916/Bo_nguon`. Người dùng yêu cầu bỏ qua Nến thơm hương trái cây (753), nên bộ nhập hiện có **45 sản phẩm**, không còn46. Toàn bộ29tệp của753 giữ nguyên tại `D:/VINA_TUOI_712_836_20260916/Tam_bo_qua/753 Nến Thơm Hương Trái Cây VINA TƯƠI - Hũ`.

## Kết quả tại máy

- Đổi tên1191ảnh:48bìa,471ảnh nội dung,663ảnh phân loại và9ảnh Hoa Lài chưa chọn giữ tên trung tính. Bốn bộ xịt cùng dòng còn hai phiên bản Canva riêng; chưa tự chọn/gộp.
- Cập nhật45JSON và4828aliaspath/filename đã đối chiếu.18hồ sơ hoàn chỉnh giữ định danh ngữ nghĩa;27bảng pending cóSHA mới do đường dẫn đổi. Giữ khóa sản phẩm, SKU, giá, thứ tự và trạng thái xác nhận. Kiểm DB chỉ đọc trước áp dụng thấy0folder_source_claims; không nới guard cho nguồn khác phiên bản.
- Tách108PNG sai dòng ra `D:/VINA_TUOI_712_836_20260916/Cach_ly_anh_khong_dung`. Nước lau sàn Quế726 còn16PNG; hai dung dịch lau Sả Chanh835/836 mỗi bộ11PNG; Lọ treo xe735 còn thiếu ảnh đúng. Bộ753 bỏ qua nguyên vẹn, không chỉnh riêng JSON hoặc tách27ảnh của nó.
- 45bộ có1761vị trí/82SKU duy nhất:675trong18hồ sơ ghép sẵn,1086trong27bảng chờ. Đây không phải45listing sẵn sàng gửi. Các vấn đề thành phần, combo, ngành, quyền và QC cũ vẫn giữ.
- Sao lưu toàn bộ1590tệp trước sửa tại `D:/VINA_TUOI_712_836_20260916/Luu_tru_goi_cu/Truoc_doi_ten_v4_20260917`. Word/PNG/XLSX không sửa bytes. Index mới1459tệp. ZIPv3 giữ nguyên và là lịch sử; **không tạo ZIPv4**, theo ưu tiên giao thư mục nhanh của người dùng.

## Căn cứ phân loại

Đối chiếu46Word với tiêu đề/nội dung Excel nguyên văn, tênfile, nội dung bìa và bộmùi/dungtích. Hình chai/màu chai không đủ kết luận sản phẩm khác nhau. Dùng hashpixel để tái sử dụng bằng chứng đã nhìn, chỉ xem lại ảnh khác.

Canva hai thiết kế735/753 hiện có tên treo xe/nến nhưng page1 thật là ảnh xịt Oải Hương500ml Chăn Gối. Root đã đọc qua connector và mở trực tiếp Canva để xác minh. Không kết luận nguyên nhân hoặc thời điểm sai; không sửa Canva. Các bộxịt dùng chungchai/cỡ/mùi vẫn giữ. Với726/835/836 còn có bằng chứng loại sản phẩm, cỡ, bộphânloại và chữ trên ảnh mâu thuẫn vớiExcel; không tách chỉ vì màu chai.

## Ứng dụng

Thêm nhận diện filename theo selectedrelativePath thay vì importrecordfilename được tái dùng theoSHA. Gợi ýảnhbìa (`anh-bia`, `ảnh bìa`, `cover`), ảnhnội dung (`g1`, tên dài `-g2`), ảnhphânloại (`phan-loai`, `pl`). Tên số đơn như2/26 vẫn mơhồ, không tự gánSKU. `Nhap_01` không bị nhận nhầm thànhnháp. Prefix `chua-phan-vai-tro` luôn giữ unknown.

Nút **Điền vị trí trống theo tên** chỉ điền phầnchưa chọn; chọn phạmvi ảnhg, giữlựachọntay, cảnhbáo nhiều bìa/gtrùng. Lọcảnh và sắpxếp sốtựnhiên. Hồsơmanifest mạnh hơn tênfile. Giao diệnVite cập nhật, không reload tabđang nhập và không restartAPI.

## Kiểm chứng

-97/97unit filename/folder/manifest/pending.
-11/11Playwright nhập thư mục, toàn bộAPIwrites được chặn bằngfixture; gồmgiữ chọn tay, bỏchọn/lưu/mởlại.
-Typecheck và buildđạt.
-Kếhoạchstaged4181/4181; phảnbiện độc lập1326ảnhnguồn cùng45previewJSON, khôngcollision.
-Sau áp dụng: **334/334kiểm tra bằng parser/assembler thật đạt**. Mọi đườngảnhactive trỏđúngSHA;18strictassemblevớiDORISMALL;27pending vẫn chờxácnhận;753đủ29tệp giữbytes.

Không có lệnh ghi Shopee hoặc thay DB trong lượt này. LượtUI làfixture; kiểm thật làđọcfilesystem+parser, không gọiđây lànghiệmthu production.

## Hồ sơ

`.local/vina-input-712-836-20260916/image-rename-v1/`:
- `rename-plan.json`:SHA eee3859441e21ad82afc2f3bd8f45aee54ff6d3dc63d482ffe2595f4ff2cad7d.
- `validation.json`, `applied-receipt.json`, `release-receipt.json`, `real-parser-actual-report.json`.
- Nguồnđốichiếu `.local/lifecycle-20260917/multidesign-media-audit/` và `cover-identity/`.

Hướng dẫn mới: `D:/VINA_TUOI_712_836_20260916/Bo_nguon/BAT_DAU_TAI_DAY.txt`; bảng `TINH_TRANG_ANH_V4.csv` và `DOI_CHIEU_TEN_ANH_V4.csv`. Nhập theoNhập_01…08 hoặc mộtthưmụcsảnphẩm, khôngnhậptoànBo_nguon. Đợtimportcũvẫngiữtêncũ;nhậpđợtmớitừthưmụcv4 đểnhậntênmới,khôngđổikeynguồnvượtkiểmxungđột.
