# Kiểm chéo backend từ bộ nguồn đến tạo ẩn

Thời điểm chốt: 16/09/2026, 17:52 UTC+7. Phạm vi là đọc mã và kiểm thử cô lập tại máy. Không đọc hoặc ghi DB ứng dụng chính, không khởi động lại API, không gọi Shopee, không đăng hay mở bán sản phẩm.

## Lỗi đã tái hiện và sửa

**P1 — mã chờ bổ sung có thể đi qua đường nhập thủ công.** Bảng phân loại pending đã chặn `CHƯA CÓ SKU`, nhưng điểm kiểm nháp chung trước đây chỉ kiểm trùng mã/giá/phân loại. Một workbook thật chứa SKU `CHƯA CÓ SKU`, giá gốc 120000 có nguồn xác nhận và hai phân loại hợp lệ vẫn làm `buildProductionDraftSource` trả `ready`. Tương tự, một `PreparedDocument` truyền trực tiếp có mã này hoặc toàn dấu cách vẫn sinh được các bước `add_item`/`init_tier_variation`.

Đã bổ sung cùng cách nhận biết ô thiếu vào `validateDraft` và `prepared-wire.structure`. Nháp giữ nguyên nội dung, báo `MISSING_VARIANT_SKU` với nguồn của chính ô SKU và tên phân loại cần sửa. Planner trả `PREPARED_WIRE_MISSING_VARIANT_SKU` tại `models.<vị trí>.sku`, không sinh bước ghi. Không tự thay mã, suy mã từ tên, đổi thứ tự hoặc bỏ phân loại. Các nguồn và manifest lịch sử không bị sửa.

Bằng chứng trước sửa: `.local/backend-placeholder-red.json` có sáu thất bại đúng mục tiêu; `.local/backend-placeholder-wire-red.json` có ba thất bại đúng mục tiêu. Sau sửa: 91/91 kiểm tra tập trung đạt tại `.local/backend-placeholder-final-focused.json`; kiểm kiểu và build TypeScript đều exit 0, log `.local/backend-crossflow-{typecheck,build}.log`.

Không phát hiện thêm P0/P1 trong phần mã và tình huống đã kiểm. Đây không phải kết luận mọi đường ghi hoặc mọi ngành/shop đã được nghiệm thu.

## Các chỗ nối đã kiểm

| Ranh giới | Điều kiện được giữ |
| --- | --- |
| Tệp → bảng phân loại chờ hoàn thiện | Tệp pending được đọc cục bộ, giữ mã ô, nhãn và thứ tự; giá/tồn dạng gợi ý trong worksheet không tự thành giá/tồn đăng. Bản lưu có phiên bản riêng, chỉ sửa ô SKU và xác nhận dùng bảng; nguồn worksheet đã lưu không bị thay âm thầm. |
| Bảng pending → nháp | Phải dùng đủ các ô đã xác nhận; mọi SKU khớp duy nhất đúng sheet/bộ giá, có giá gốc dương và nguồn. Thiếu mã, placeholder, thiếu giá, trùng mã hoặc gửi một tập con đều bị chặn. Ảnh phải thuộc đúng nhóm nguồn đã nhận. |
| Nhập lại → nháp đã có | Server đối chiếu bộ đầu vào và phiên bản đã lưu, khóa giao dịch theo nguồn; hai lần nhập hoặc lưu đồng thời cùng danh tính chỉ có một product/claim. Đổi thư mục hoặc tên tệp với byte giữ nguyên không tạo danh tính mới. Đổi nội dung/bộ giá/ID nguồn bị chặn; không lặng lẽ ghi đè nháp đã sửa. |
| Nháp → chuẩn bị | ID listing có giá trị được coi là yêu cầu cập nhật; compiler tạo mới bị chặn kể cả có khai báo quyền tạo trùng bằng văn bản tùy ý. Giá được đọc lại từ workbook nguyên và đúng ô; thiếu dữ kiện giữ issue. Provenance `folderSource` không bị hiểu nhầm là thuộc tính sản phẩm. |
| KB → lựa chọn thuộc tính | Gợi ý ràng buộc nháp/phiên bản, shop/kết nối/ngành/brand, nguồn và hạn metadata. Lịch sử shop chỉ để giải thích, không tự điền. Chỉ dữ kiện sản phẩm đã xác nhận mới được nhận; xung đột, schema cũ, lựa chọn thiếu quan hệ cha/con, fact bị thay thế hoặc khác shop đều bị chặn. |
| Chấp nhận KB → đăng ký lô | Biên nhận local bất biến, không sửa sản phẩm. Preview và register kiểm lại đúng phiên bản, giá trị nhận, metadata và fact hiện hành; source snapshot giữ bằng chứng. |
| Đăng ký → thực thi | Chỉ nguồn/manifest đã đăng ký, fingerprint còn khớp mới được nhận yêu cầu thực thi. Đăng ký không tự chạy. Lệnh gửi có nhật ký; mất phản hồi/unknown không được tự phát lại. |
| Tạo ẩn → đọc lại | Mode hidden dừng trước mở bán. Hoãn kiểm ảnh chỉ hợp lệ với hidden và lựa chọn/phiếu chính xác; mọi bước ghi phải ACK, có hai lần đọc core ổn định và đúng nguồn/shop. Giá, tồn, phân loại, thuộc tính, vận chuyển và cân nặng vẫn phải đạt. |
| Hoãn kiểm ảnh → mở bán | Phiếu hoãn ảnh tách khỏi phiếu QC đầy đủ; trạng thái chưa QC ảnh không có `canPublish`. Phải kiểm ảnh đầy đủ rồi có hành động mở bán riêng cho đúng listing. Parent hidden không tự chuyển sang NORMAL. |

Kiểm độc lập trước bản sửa placeholder: 8 file, **120/120** đạt, lưu `.local/backend-crossflow-audit-focused.json`. Gồm claim portable, pending persistence, biên nhận KB, source compiler/registration, execution-policy, batch service/runner và publication. Ca 80 nguồn trong bộ này là compiler + tệp/metadata giả lập tại máy, không phải 80 listing thật. Hai bộ 120 và 91 có phần giao nhau; không cộng thành kết quả kiểm tổng mới.

Sau guard writer, chạy thêm đúng bảy tình huống PostgreSQL về hidden/defer: **7/7 đạt**, `.local/backend-crossflow-hidden-regressions.json` lúc 17:51 UTC+7. Bao gồm không cho sai giá/tồn/title/status đi qua hoãn ảnh, kiểm ảnh nghiêm ngặt về sau và tiếp tục operation cũ đã ACK mà không sửa nguồn hoặc phát lại POST. Đây là lượt lọc; 74 ca khác của file không chạy trong lượt này, không gọi là cả file 81 ca đạt.

## Những điểm vẫn có thể làm vận hành dừng lại

- **Nguồn có ID listing:** đã chặn tạo mới sai ý định, nhưng chưa nối đường cập nhật production tổng quát từ bộ nguồn này. Phải hiển thị “cần cập nhật đúng link đã có”; không hướng dẫn bỏ ID để đi đường tạo mới. Lô thử cũ dùng manifest đã đăng ký và phiếu chuyển sang hidden riêng, không cấp quyền tạo trùng cho nguồn mới.
- **Mất tiến trình giữa lô:** giữ yêu cầu dang dở để tránh gửi trùng. Phục hồi chỉ đọc hiện đòi bằng chứng QC đầy đủ cho toàn bộ phạm vi yêu cầu cũ; yêu cầu chưa có operation hoặc còn nguồn chưa gửi không tự được gỡ chỉ vì đọc lại không thấy lỗi. Trường hợp này cần đối chiếu nhật ký kỹ thuật; không xóa lịch sử hoặc bấm gửi lại. Đây là giới hạn đã được test, chưa có quy trình phục hồi tổng quát mọi điểm crash.
- **Ảnh hoãn kiểm:** “Tiếp tục” dùng lựa chọn hidden/defer để hoàn tất core; “Chỉ đọc/đối chiếu” kiểm nghiêm ngặt có thể tiếp tục chờ ảnh hoặc cân nặng. Hoãn ảnh không đồng nghĩa ảnh đúng, listing được mở bán hay đã qua QC đầy đủ.
- **Sau khi đăng ký lô:** runner dùng snapshot đã đăng ký và kiểm metadata/quyền Shopee hiện hành. Một thay đổi dữ kiện KB hoặc nháp local sau đó chưa tự thu hồi snapshot đã đăng ký; cần tạo phiên bản chuẩn bị mới nếu muốn thay quyết định đã chốt.
- **Thời gian và cấu trúc chưa hỗ trợ:** preview hiện đồng bộ nên có thể quá thời gian chờ HTTP; đọc lại cùng ID để xác định kết quả trước khi tạo yêu cầu khác. DATE vẫn chặn trước writer vì chưa có đối chiếu ngày đọc lại đúng format/timezone; nhiều giá trị tự nhập `value_id=0` của cùng thuộc tính chưa được nối đầy đủ.
- **Giới hạn production thực:** KB và các fixture có tách nhiều shop, nhưng writer production hiện chỉ mở cho shop thử đã cấu hình `vuatinhdau.vn`. Chưa nghiệm thu production đa shop, mọi ngành, worker 24 giờ hoặc mọi loại cập nhật. Các test ở lượt này không thay đổi trạng thái các listing thật.
- **Mốc triển khai tách riêng:** phần kiểm chéo này chốt lúc17:52 UTC+7, trước lượt triển khai migration031 lúc18:12 UTC+7 do root báo lại. Bằng chứng cô lập ở đây không tự chứng minh trạng thái runtime chính; áp dụng migration, kiểm hoạt động đang chạy và nạp API thuộc hồ sơ triển khai riêng của root, không phải thao tác của agent kiểm chéo.

Tham chiếu vận hành: [ranh giới tích hợp](2026-09-16-module-integration-boundaries.md), [thuộc tính hiện hành](../delivery/2026-09-16-current-attribute-validation.md), [bàn giao lô thử](../delivery/2026-09-16-ten-listing-pilot.md), [bản sửa nhập Cam Sả](../delivery/2026-09-16-cam-sa-folder-import-hotfix.md). Trạng thái production phải lấy từ checkpoint/bằng chứng của lượt thật; không suy từ màu xanh của kiểm thử này.
