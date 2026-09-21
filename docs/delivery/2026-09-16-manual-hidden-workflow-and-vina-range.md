# Bàn giao nhập nguồn và tự đăng ẩn VINA TƯƠI

Ngày 16/09/2026. Phạm vi hiện tại: người vận hành tự nhập nguồn, chuẩn bị và bấm gửi qua API trong ứng dụng nội bộ. Không có lệnh ghi Shopee trong lượt rà soát và đóng gói này. Các lô thử đã đăng trước đó giữ nguyên lịch sử; không tự tiếp tục hàng đợi cũ.

## Bộ nguồn STT 712–836

Kho nguồn có **46 dòng VINA TƯƠI**, không phải 125 listing liên tục: workbook chỉ có 46 dòng được chọn trong khoảng STT này. Đã tải đủ **53 thiết kế Canva / 1.327 ảnh gốc**, tạo 46 Word từ nội dung nguyên của workbook. Bảy dòng có hai thiết kế; các phiên bản được tách và giữ nguồn. Ảnh nháp, ảnh trắng, ảnh thừa và trang chưa chọn vẫn được giữ để đối chiếu, không tự ghép vào ảnh đăng.

- **18 bộ có hồ sơ ánh xạ đầy đủ / 675 vị trí SKU** theo đúng DORIS SHOP MALL. Đây là số vị trí phân loại trong các listing, không phải 675 SKU duy nhất hoặc listing đã sẵn sàng gửi.
- **28 bộ có bảng phân loại chờ bổ sung**, giữ tên, tầng, thứ tự và ô chưa có SKU. Không bỏ các lựa chọn MỚI hoặc dùng chuỗi CHƯA CÓ SKU làm mã gửi API.
- **Chưa có bộ nào được xác nhận đủ toàn bộ lựa chọn trước đăng của lô mới.** Ngành, thương hiệu/quyền hiện hành, thuộc tính, kích thước, vận chuyển và các ngoại lệ nội dung cần được xử lý trong bước chuẩn bị. Không kế thừa kích thước, thành phần hoặc quyết định bỏ ảnh từ lô thử cũ.
- Người dùng đã chốt cho lô này: shop vuatinhdau.vn / 1423724897, GIÁ GỐC của bộ SHOP MALL trong DORIS, tồn đăng bán 100 mỗi SKU, đăng ẩn và tự bấm gửi. Đó không phải mặc định toàn hệ thống hoặc quyền tự mở bán.

Nguồn và hồ sơ riêng tại `.local/vina-input-712-836-20260916/`; `range-readiness.json` là bảng trạng thái theo từng tên sản phẩm. Tệp gốc không sửa. Workbook nguồn có SHA-256 `2b65dda4caf6e5b4c389db23a8b50963b40927d02eba9d4460846638f07b0b45`.

**Thư mục có thể chọn trực tiếp:** `D:/VINA_TUOI_712_836_20260916/Bo_nguon`. Đã chia thành `Nhap_01` đến `Nhap_08`, mỗi nhóm 4–6 sản phẩm, dưới 500 MiB. Chọn một nhóm trong ứng dụng, không chọn toàn bộ `Bo_nguon` ở chế độ mỗi thư mục con. Tệp `BANG_THU_MUC_NHAP.csv` tra tên đầy đủ và thư mục; `BAT_DAU_TAI_DAY.txt` có hướng dẫn ngắn. Bảng giá và hồ sơ nằm ngoài các nhóm. Tổng 1.536 tệp / 2.986.463.913 byte, đường dẫn tương đối tối đa 168 ký tự; tại vị trí bàn giao, đường dẫn tuyệt đối tối đa 207 ký tự. Bộ trên D được tạo vì ổ C gần đầy và đường dẫn gói cũ quá dài; nguồn C và ZIP 12 bộ lịch sử giữ nguyên, chỉ hai ZIP tạm lỗi của task bị dọn.

Kiểm độc lập bản D đạt **374/374**, bao gồm 18 hồ sơ qua reader/assembler thật, 28 bảng pending giữ 1.526 vị trí và 444 vị trí thiếu SKU, SHA đủ 1.372 Word/PNG trong nhóm và 827 đường dẫn ảnh tham khảo. Một PNG trắng nằm riêng ngoài nhóm. Danh tính nguồn của 18 hồ sơ không đổi sau rút ngắn đường dẫn. Xem [kiểm bộ portable](../reviews/2026-09-16-portable-source-bundle.md), `portable-copy-receipt.json` và `independent-portable-source-reader.json` trong kho bằng chứng. Đây chưa phải một lần nhập toàn bộ gói qua browser hoặc đăng production.

ZIP hoàn tất lúc **13:31:04 UTC / 20:31:04 UTC+7**: `D:/VINA_TUOI_712_836_20260916/VINA_TUOI_46_BO_712-836.zip`, **2.986.861.083 byte**. Đã đọc lại đủ **1.536 thành phần trong ZIP**, kiểm SHA-256 từng tệp và CRC, khớp bản D đã được reviewer kiểm; đường dẫn trong ZIP tối đa177 ký tự. SHA-256 toàn ZIP: `7cc4ce46815ddf0b55674bb3ddee49b0a236740192ee76dd64b3b63761978fc1`. Bằng chứng `portable-zip-receipt.json` khóa cả SHA của biên nhận copy và audit độc lập. Có thể dùng thẳng thư mục trên D, không cần giải nén thêm trên ổ C.

Các ngoại lệ chính: 38 mô tả ghi có cồn trong khi những nhãn xịt đã đối chiếu ghi “Nguyên chất 100%”; Xịt Thơm Hoa Lài cho phòng khách có câu thành phần nhắc Hoa Hồng; một số bìa dùng ngữ cảnh khác tiêu đề; một số thiết kế nến/nước lau sàn lại chứa ảnh xịt. Những điểm này được ghi riêng để người phụ trách quyết định, không được coi là đúng chỉ vì file đọc được hoặc test xanh.

## Luồng ứng dụng đã nối

1. **Kho listing → Nhập Word / ảnh / bảng giá → Nhập thư mục listing.** Bảng giá chọn riêng, đúng sheet và SHOP MALL. Nhập một sản phẩm trước để làm quen; sau đó chọn một trong tám thư mục `Nhap_01`…`Nhap_08` đã chia sẵn, ở chế độ **Mỗi thư mục con là một listing**. Không cần tự sao chép để gom nhóm. Tổng kho gần 3 GB chưa được kiểm một lần qua trình duyệt, nên không cam kết tốc độ khi chọn cả kho.
2. Hồ sơ đầy đủ tự ghép Word, ảnh và phân loại. Bảng chờ bổ sung giữ toàn bộ ô và lưu lại để tiếp tục; phải có SKU thật, khớp giá duy nhất và xác nhận dùng đủ phân loại mới sang nháp gửi.
3. Lưu bộ listing. Nhập lại cùng nguồn có danh tính ổn định dùng lại nháp; đổi tên thư mục hoặc tệp nhưng giữ byte không tạo bản trùng. Thay nội dung, ảnh, thứ tự, giá hoặc ID nguồn phải được đối chiếu, không âm thầm ghi đè.
4. **Đăng hàng → Chuẩn bị lô mới.** Lấy ngành/quyền/metadata tại lúc xử lý, xem gợi ý có bằng chứng, chọn dữ kiện phù hợp, điền phần thiếu rồi kiểm tra. Sửa lựa chọn sau khi kiểm tra sẽ vô hiệu bản xem trước cũ; phản hồi đến muộn không được bật lại nút chuẩn bị.
5. Giữ **Đăng ẩn để QC**; nếu thử trước QC ảnh thì chọn rõ **Tạm hoãn kiểm tra ảnh để thử đăng ẩn**. Chuẩn bị đợt chỉ lưu công việc. Người dùng bấm **Đăng ẩn** mới gửi API.
6. Đọc lại đúng listing, kiểm giá/tồn/phân loại/nội dung và các trường giữ nguyên. Hoãn ảnh chỉ hoãn ảnh; không bỏ kiểm dữ liệu. Khi đã QC đầy đủ mới có thao tác mở bán riêng.

Hướng dẫn thao tác: [Từ thư mục nguồn đến đăng ẩn và mở bán](../operator-guides/dang-hang-tu-bo-listing-da-luu.md). Khi token hết hạn, sử dụng màn **Công cụ → Kết nối shop** và luồng cấp quyền hiện có; trạng thái connected đã lưu không phải phép kiểm token còn hiệu lực lúc gửi. Backend có cơ chế refresh có biên nhận, nhưng chưa có lịch tự làm mới 24 giờ.

## Những lỗi đã sửa qua phản biện

- Cam Sả bị báo sai khác mô tả chỉ vì PostgreSQL đổi thứ tự khóa JSON: so cấu trúc nội dung/ảnh có ý nghĩa, giữ chặn thay chữ, dòng hoặc ảnh thật.
- Cảnh báo SKU trùng toàn workbook vẫn lặp sau khi đã chọn đúng dòng giá: chỉ bỏ cảnh báo đã giải quyết trong phần hiển thị, đối chiếu đúng import/sheet/bộ giá/row/fact. Raw workbook, nháp lịch sử và snapshot chuẩn bị không bị sửa.
- Mã chờ bổ sung có thể lọt qua đường nhập thủ công: chặn tại nháp chung và planner trước khi sinh lệnh ghi, giữ nguồn của đúng ô SKU.
- Bản xem trước cũ có thể ghi đè lựa chọn vừa sửa: hủy và bỏ phản hồi cũ theo phiên yêu cầu; không đăng ký nhầm số đo/tồn/thuộc tính.
- Danh tính nguồn portable và bảng phân loại chờ được nối xuyên UI, API, PostgreSQL; migration 031 đã áp dụng. Đối chiếu tám bảng được bảo vệ trước/sau migration giữ nguyên hash.
- Bộ đếm Kho đầu vào bỏ sót hồ sơ mở lại bản nháp phiên bản đã có: đối chiếu dữ liệu đã phân tích và hash trong tối đa ba truy vấn, không tải lại byte ảnh/Excel. Giữ chặn cùng giá nhưng khác nguồn, thiếu ảnh hoặc sai phiên bản; không thay đổi dữ liệu đã lưu.

## Kiểm chứng

Kiểm tổng cuối trên mã đã chốt, kết thúc **12:03:33.467 UTC / 19:03:33 UTC+7**: **2.057/2.057 unit/integration trong 112 tệp, 7/7 legacy, typecheck, TypeScript build và web build đạt**. Hồ sơ `.local/hidden-manual-20260916/verification-final-frozen.json`, `test-results-final-frozen.json` và `full-verification-final-frozen.log`. Lượt này bao gồm cả bản sửa cảnh báo giá và bộ đếm cuối. Mốc 2.026 lúc 18:06 là lượt trước, được giữ nguyên hồ sơ lịch sử.

Ba bộ nguồn thật / 63 vị trí SKU được chạy qua smoke cô lập: 116 đối chiếu luồng, 37 kiểm giữ trường và rà soát độc lập 62 hash tệp. Hoa Lài được chạy tạo ẩn qua API fixture với 11 upload, một create, một init, hai lần đọc base/model; tiếp tục không thêm POST. Không gọi Shopee. Nguồn thiếu lựa chọn vận hành hoặc vượt giới hạn ảnh vẫn bị chặn. Xem [smoke nguồn thật](../reviews/2026-09-16-real-source-hidden-smoke.md) và [phản biện độc lập](../reviews/2026-09-16-real-source-smoke-review.md).

Bản sửa cảnh báo giá có **89/89 ca tập trung** và typecheck/build đạt; kiểm lại artifact ba bộ nguồn đạt **168/168**, giữ document/source snapshot và những lỗi chặn thật. Bộ đếm có 12 hồi quy riêng, 11 ca Kho đầu vào và 7 ca claim đều đạt; sau đó tất cả đã có trong lượt kiểm tổng 2.057. Xem [báo cáo cảnh báo giá](../reviews/2026-09-16-selected-price-warning-projection.md) và [bộ đếm nhập lại](../reviews/2026-09-16-portable-intake-counter.md).

API chính đã nạp mã cuối lúc **19:11:41 UTC+7**, PID **6608**, cổng 4310; UI cổng 5173. GET lúc 12:17:45 UTC xác nhận health ready, cả năm batch đều không chạy; hai batch còn lại của lô thử giữ hidden/defer. Đợt Cam Sả SHOP MALL đã lưu lúc 17:08 hiển thị 1/1 và không còn cảnh báo trùng SKU đã giải quyết; đợt cũ SHOP THƯỜNG vẫn 0/1. Đã quan sát cùng kết quả trong giao diện. Bằng chứng `.local/hidden-manual-20260916/runtime-final-frozen.json`. Những GET này không xác nhận token còn hiệu lực trên Shopee và không phát lệnh đăng.

Kho kiến thức đã đọc thật một shop: 57 listing / 839 model và 13 ngành tại checkpoint riêng; 73 dấu vết đã xóa chỉ có trạng thái. Có checkpoint đồng bộ tăng dần, bằng chứng, tra cứu và gợi ý có giải thích; lịch sử không tự thành dữ kiện sản phẩm. Xem [bàn giao KB](2026-09-16-seller-knowledge.md), [bridge bản nháp](2026-09-16-draft-knowledge-bridge.md) và [kiểm thuộc tính hiện hành](2026-09-16-current-attribute-validation.md).

## Giới hạn phải giữ rõ

- Writer production hiện trong phạm vi shop pilot vuatinhdau.vn; cách ly nhiều shop và nhiều ngành đã có fixture, chưa phải nghiệm thu nhiều shop production.
- Nguồn có ID listing không được tạo mới. Đường cập nhật production tổng quát toàn bộ nội dung/ảnh/cấu trúc phân loại từ thư mục chưa hoàn tất; không xóa ID để đi đường tạo mới.
- DATE và nhiều giá trị tự nhập chung value_id=0 còn bị chặn trước ghi vì chưa có đọc lại đủ tin cậy. Thiếu quyền ngành/brand/size chart vẫn cần xử lý đúng nguyên nhân.
- Chưa nghiệm thu mọi điểm gián đoạn tiến trình, mọi nhánh cập nhật, toàn bộ 46 bộ qua trình duyệt một lần, nhiều shop thật hoặc chạy tự động 24 giờ.
- Chưa đăng lô STT 712–836 lên shop trong lượt này. ZIP đầy đủ và kiểm thử cục bộ không phải biên nhận đăng thành công.
