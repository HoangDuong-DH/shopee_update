# Bàn giao tạm — 10 listing mới VINA TƯƠI

**Checkpoint 16/09, 09:02 UTC: bốn bộ còn lại đã chuyển sang đăng ẩn và hoãn QC ảnh theo yêu cầu mới.** Policy cục bộ bất biến `6996d9a2-369f-43bf-9567-bdeeb1c27686` chỉ bao gồm Hương Thảo/Hoa Hồng/Hoa Lài/Cam Sả; sáu bộ đã mở bán không thuộc scope. Hai manifest, nguồn và operation cũ giữ nguyên; audit 8 bảng trước/sau bằng hash khớp, phản biện receipt 25/25 đạt. Hương Thảo vẫn là link45417908562 đang ẩn/chưa đối chiếu đủ; ba bộ còn lại chưa gửi. Không có yêu cầu Shopee mới do bước chuyển lựa chọn này. Runtime đã đọc `hidden_for_review` + `defer_image_qc`; người dùng tự bấm tại Đăng hàng → Đợt đang làm. Cần đọc lại dữ liệu/cân nặng để lập phiếu hoàn tất ẩn, nhưng không bắt duyệt ảnh trước bước này; ảnh giữ nhãn chưa QC, chưa được phép mở bán. Bằng chứng `.local/hidden-manual-20260916/`. [Hướng dẫn hiện hành](../operator-guides/tiep-tuc-4-listing-2026-09-16.md).

**Checkpoint mới hơn: người dùng yêu cầu dừng đăng tự động và tự bấm trong ứng dụng nội bộ.** GET lúc 06:17:03 UTC ngày16/09 xác nhận parent `paused`, mọi nhóm không bận: **6/10 đã mở bán** (Trà Trắng, Sả Chanh, Phong Lữ, Rừng Thông, Oải Hương, Sả Java); **Hương Thảo45417908562 đã tạo, đang ẩn/chờ QC bìa**; Hoa Hồng, Hoa Lài, Cam Sả chưa gửi. Không tự resume, approve QC/cân hoặc đăng thêm sau yêu cầu dừng. Đã mở đúng phiếu ảnh Hương Thảo cho người dùng, chưa bấm xác nhận. [Hướng dẫn thao tác tay trong app](../operator-guides/tiep-tuc-4-listing-2026-09-16.md). Snapshot: `.local/vina-input-preparation-20260916/orchestration/status-snapshots/2026-09-16T06-17-02-773Z-d7ab838f-4609-485d-919c-49e1d8fea29c/`. Kết nối đã refresh thành côngrevision3→4 trước khi dừng, token có hạn09:42:01.378UTC; không đưa token/khóa vào tài liệu. Audit độc lập toàn10 và snapshot bảo vệ cuối chưa thực hiện. Các mốc bên dưới là lịch sử, không phải trạng thái hiện tại.

**Mốc trạng thái: 11:32:07 ngày 16/09/2026 (04:32:07 UTC).** Đã chuẩn bị và nhập đủ mười bộ nguồn, mỗi bộ ba SKU. Lần GET tại mốc này cho thấy **ba listing đã mở bán và đối chiếu đạt**, một listing đã tạo ở trạng thái ẩn, sáu listing chưa gửi. Đợt đang tạm dừng để tiếp tục đúng công việc đã lưu. **Đây chưa phải bàn giao 10/10 đã đăng.** Root đang thực thi; cần cập nhật kết quả và audit cuối sau khi cả đợt kết thúc.

## Bộ nguồn nhân viên có thể dùng

Đã có [thư mục bộ đăng 10 sản phẩm](<C:/shopee_product_uploader/.local/vina-input-preparation-20260916/Bo dang 10 san pham VINA TUOI>) và [ZIP cùng nội dung](<C:/shopee_product_uploader/.local/vina-input-preparation-20260916/Bo dang 10 san pham VINA TUOI.zip>), gồm **409 tệp, khoảng 824,16 MiB**. Kiểm tệp tại máy lúc **11:33 ngày 16/09** xác nhận kích thước ZIP 864.194.974 byte, số tệp, mười DOCX và hash khớp biên nhận.

- **10 Word nội dung đăng:** parser thực của ứng dụng đọc đúng tiêu đề và phần nội dung đã có phiên bản; đã kiểm hình 20 trang render. Không tạo lại nội dung bằng AI.
- **245 ảnh nguyên gốc** của đúng mười thiết kế ưu tiên đã được nhận và review. Gói ứng dụng chọn **109 tệp ảnh duy nhất**, đủ bìa, chín gallery và ảnh cho ba SKU mỗi listing. Một tệp có thể dùng cho nhiều vai trò; số tệp không phải số SKU hoặc lượt upload.
- **30 SKU-instance** đã ghép về đúng ô bảng giá DORIS và thứ tự phân loại nguồn. Mười nháp đã lưu local ở revision 1, không có nghĩa đã xuất bản.
- Audit độc lập gói nguồn đạt **1.356/1.356 kiểm tra**; 385 bản sao nguồn được đối chiếu byte; toàn bộ ZIP đạt kiểm CRC. Phiếu xác nhận phạm vi đạt 66/66 và liên kết tới mười nháp thật đạt 110/110. Các số này kiểm nguồn và chuẩn bị, tách khỏi nghiệm thu Shopee.

Đã kiểm kê đầy đủ thư mục Canva được giao: **228 thiết kế**, gồm thư mục gốc và một thư mục con đã duyệt. Mới **mười thiết kế ưu tiên được xuất và đóng vào bộ đăng này**; danh sách 228 thiết kế chưa đồng nghĩa toàn bộ ảnh của cả thư mục đã tải xong. Không trình bày gói mười sản phẩm là bản xuất toàn bộ Canva.

## Phạm vi người dùng đã xác nhận

Đợt này chỉ áp dụng mười nguồn mới được chọn cho **vuatinhdau.vn**, cùng 30 SKU theo bộ nguồn. Người dùng cho phép thử listing mới trong shop thật, kể cả SKU đã xuất hiện trong listing khác. Quyền này được ghi riêng cho từng productKey và revision; không cho phép gửi lại operation cũ hoặc tự mở rộng sang nguồn/shop khác.

Giá đăng mới dùng **GIÁ GỐC DORIS SHOP MALL**, tồn **100/SKU**. Giữ cân khai báo từ cột J là **130,9 / 322,3 / 503,8g**; kiện **12 × 12 × 28cm** là số ước tính người dùng chấp thuận cho đợt này. Khi Shopee lưu số làm tròn, cần phiếu gắn đúng operation/model/SKU và hai lần đọc thực tế; không sửa cân nguồn hoặc sao phiếu từ sản phẩm đã đăng trước.

Người dùng xác nhận thành phần theo nhãn “100%” cho mười sản phẩm. Nội dung v2 lưu **17 thay thế chính xác**, giữ cảnh báo và workbook gốc. Ảnh dùng chung giữa các hương được chấp thuận; bộ có mười gallery dùng chín ảnh đầu đúng thứ tự, lưu ảnh thứ mười nguyên vẹn. Riêng **xịt Sả Java** dùng ảnh vuông Sả Java `21.png` làm bìa thay ảnh Oải Hương; chỉ đổi vai trò được chọn, không sửa artwork. Nội dung đăng dạng chữ, không suy quyền ảnh mô tả từ metadata giới hạn.

Chín listing dùng ngành **Chất khử mùi, làm thơm** theo lựa chọn đã đối chiếu; **xịt Cam Sả** dùng ngành **Nước hoa xe**. Brand VINA TƯƠI đã được đọc đúng từng ngành. Các lựa chọn ngành, kênh vận chuyển và ánh xạ kho vẫn được backend kiểm lại trước ghi; dữ kiện xuất xứ/hạn dùng/tên công ty của xịt khử mùi thảm không tự chuyển sang mười sản phẩm mới.

## Trạng thái đăng thật tại mốc bàn giao tạm

| Sản phẩm | Trạng thái từ GET lúc 11:32:07 |
| --- | --- |
| Xịt thơm phòng Trà Trắng | Đã mở bán và đối chiếu đạt |
| Xịt thơm nhà bếp Sả Chanh | Đã mở bán và đối chiếu đạt |
| Xịt thơm Phong Lữ | Đã mở bán và đối chiếu đạt |
| Xịt thơm phòng Rừng Thông | Đã tạo, đối chiếu create đạt; còn ẩn, chưa tính mở bán |
| Xịt thơm Oải Hương | Chưa gửi |
| Xịt thơm Sả Java | Chưa gửi |
| Xịt thơm Hương Thảo | Chưa gửi |
| Xịt thơm Hoa Hồng | Chưa gửi |
| Xịt thơm tủ quần áo Hoa Lài | Chưa gửi |
| Xịt thơm Cam Sả | Chưa gửi |

Bảng dùng tên gọi gọn để vận hành; tiêu đề đầy đủ trong nguồn/manifest giữ nguyên. Ba listing đầu có trạng thái `published` theo phép kiểm journal của ứng dụng. **Audit độc lập cuối cho cả mười chưa hoàn tất**; không cộng một item đã tạo hoặc step ACK thành một listing đã mở bán. Rừng Thông đã qua trạng thái chờ QC bìa ở checkpoint trước; GET mới tại mốc trên là `created_unlisted`, không tiếp tục mô tả nó như vẫn chờ duyệt bìa.

Ba nhóm **4–4–2** dùng cùng một công việc cha. Parent dừng khi nhóm hiện tại chưa hoàn tất; nhóm sau chưa được gửi. Ảnh bìa PNG→JPEG và cân làm tròn được xử lý bằng chứng riêng, giữ nguyên raw/nguồn. Mỗi lần tiếp tục dùng cùng preparation, manifest và operation đã lưu; không replay create/init/upload/publication đã nhận.

Đã gặp một điểm vận hành thật: preview dựng mười bộ nguồn mất khoảng **93 giây**, vượt thời gian chờ 60 giây của trình gọi. Máy chủ vẫn tiến triển; root đọc lại cùng ID và nhận đủ 10 ready/0 blocked, không gửi lại. Cần bổ sung preview bất đồng bộ có tiến độ trong một lượt cải tiến sau. Công cụ đọc trạng thái/ảnh QC hiện chỉ GET, giúp lấy đúng case và hai ảnh cho reviewer; nó không tự kết luận hình ảnh hoặc gửi phiếu duyệt. Xem [runbook điều phối và phục hồi](../runbooks/2026-09-16-ten-listing-orchestration.md).

**Bổ sung riêng về vận hành lúc 11:39:11, sau mốc bảng trên:** kết quả child job đã ghi Rừng Thông mở bán, hoàn tất nhóm bốn đầu. Rà soát local nhóm này đếm 678 GET, gồm 451 lượt đọc trang thương hiệu; có hai lỗi giới hạn tốc độ ở bước đọc kiểm tra, đã phục hồi theo công việc cũ. Cache đang chỉ sống trong từng lượt và đường QC chưa dùng bộ chờ GET chung. [Báo cáo áp lực đọc và hướng cải tiến](../reviews/2026-09-16-production-read-pressure.md) ghi số đo, phạm vi và đề xuất; chưa sửa runtime hoặc suy quota Shopee từ số đo. Bổ sung này không biến bảng checkpoint 11:32 thành kết quả cuối của cả mười.

Bốn listing đã đăng trước — **can 5L, Ngọc Lan Tây, xịt thơm ô tô và xịt khử mùi thảm** — cùng hai nguồn **tủ giày/giày da nam đang held** nằm ngoài phạm vi đợt mới. Có snapshot bảo vệ riêng lúc **11:02:49**; snapshot này được lấy sau khi parent mới bắt đầu, nên không gọi là bằng chứng trước mọi thực thi. So sánh cuối các nguồn/nhật ký cũ còn chờ đợt mới hoàn tất.

## Phần nền tảng đã đạt và giới hạn

Kiểm tổng trên mã app đã chốt, hoàn tất **10:58:19 ngày 16/09**: **1.857/1.857 unit/integration, 7/7 legacy, không skip; typecheck và build đạt**. Đây là kiểm phần mềm, sử dụng fixture và schema test riêng; không phải bằng chứng mười listing production đã đăng. Các kiểm browser/helper riêng được giữ riêng, không cộng thành số của lượt tổng.

Song song, **kho kiến thức từ listing của shop đã nghiệm thu đọc thật**: 57 listing hiện có, 839 model và 73 dấu vết listing đã xóa; không coi tổng 130 bản ghi là 130 sản phẩm đang bán. Lần đọc lại dùng 13 GET trong 7,528 giây, tái dùng 126 bản ghi; bốn listing thiếu thuộc tính giữ cảnh báo và bị loại khỏi nguồn đề xuất. Năm thông tin người dùng xác nhận cho xịt khử mùi thảm đã lưu nội bộ, còn địa chỉ tổ chức chưa có nguồn. Kho kiến thức chưa tự áp đề xuất lên Shopee. Xem [bàn giao kho kiến thức](2026-09-16-seller-knowledge.md) và [hướng dẫn tra cứu](../operator-guides/kien-thuc-tu-listing-cua-shop.md).

Phạm vi live vẫn chỉ một shop. **Chưa nghiệm thu nhiều shop thật, chạy liên tục 24 giờ, toàn bộ 228 thiết kế Canva hoặc mọi loại cập nhật production.** Các số đo kiện là ước tính có xác nhận; các tuyên bố sản phẩm dựa trên nguồn/quyết định đã lưu, không phải chứng nhận độc lập. Không suy kết quả của một listing sang các listing còn chưa gửi.

## Phụ lục bằng chứng kỹ thuật

Mốc GET dùng cho bản tạm: [summary](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/orchestration/status-snapshots/2026-09-16T04-32-07-399Z-048a8017-585a-4035-a185-7d7a01cd9c33/summary.json), [ba trạng thái nhóm](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/orchestration/status-snapshots/2026-09-16T04-32-07-399Z-048a8017-585a-4035-a185-7d7a01cd9c33/groups.json), [biên nhận GET](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/orchestration/status-snapshots/2026-09-16T04-32-07-399Z-048a8017-585a-4035-a185-7d7a01cd9c33/http-get-receipts.json). [Con trỏ lần đọc gần nhất](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/orchestration/status.summary.json) có thể mới hơn, không tự thay đổi mốc của bản tạm này.

| Sản phẩm | Item ID đã quan sát thực tế |
| --- | --- |
| Trà Trắng | 57367891960 |
| Sả Chanh | 50117892152 |
| Phong Lữ | 53467883096 |
| Rừng Thông | 56817883096 |
| Oải Hương | Chưa có tại mốc GET |
| Sả Java | Chưa có tại mốc GET |
| Hương Thảo | Chưa có tại mốc GET |
| Hoa Hồng | Chưa có tại mốc GET |
| Hoa Lài | Chưa có tại mốc GET |
| Cam Sả | Chưa có tại mốc GET |

Shop1423724897 / partner2010476; preparation`a9b09646-bc43-4dc2-8c5f-53cd66f224d0`. Ba manifest của đúng đợt này được giữ trong [registration](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/orchestration/a9b09646-bc43-4dc2-8c5f-53cd66f224d0/registration.response.json). Phiếu xác nhận bất biến hiện dùng `authorization-4895c26f57260d65.json`, SHA`8678cb4cdfbdcba0c1906c8682a0e62a223ff3a9c9ce21b9f6a49eacee604b97`; phiếu cũ tham chiếu hash quyết định trước khi sửa câu trích dẫn được giữ làm lịch sử, không dùng thay phiếu cuối.

Hồ sơ riêng trong `.local/vina-input-preparation-20260916/`, không commit:

- [Biên nhận bộ nhân viên](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/employee-delivery-receipt.json), [kiểm thư mục](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/employee-folder-validation.json), [kiểm Word bằng parser thực](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/employee-word-parser-verification.json). ZIP SHA`2b37d079266912c69bfcb7b639295755db5e3827e6ea898bfb792df609ba7ec8`.
- [Inventory Canva đầy đủ](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/canva-inventory-complete.json), [review ảnh và ngoại lệ](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/IMAGE-REVIEW-COMPLETE.md), [diff nội dung có xác nhận](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/selected-10-content-diff.md).
- [Audit nguồn 1.356 kiểm tra](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/source-index/preflight/assembled-ten-independent-audit.json), [audit phiếu xác nhận](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/source-index/preflight/authorization-independent-audit.json), [audit binding nháp thật](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/source-index/preflight/bound-ten-independent-audit.json), [receipt nhập local](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/app-source-package/local-import-receipt.json).
- [Kiểm tổng mã ổn định](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/orchestration/verification-frozen-final.json), [kết quả unit/integration](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/orchestration/test-results-frozen-final.json).
- [Hướng dẫn audit sau đăng](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/source-index/preflight/POST-PUBLISH-AUDIT.md), [các lần audit journal](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/source-index/preflight/new-ten-journal-audits), [snapshot bảo vệ phần cũ](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/source-index/preflight/protected-old-state-before.json). Lần audit lúc04:14 mới có một publication đạt, `pending=9`, `publicationVerified=false`; đó là checkpoint cũ, không thay cho audit cuối sau cả mười.

Để chốt bàn giao cuối, cần điền trạng thái/item ID còn lại từ đọc thật, audit mười nguồn với `pending=0`, `publicationVerified=true`, không có kiểm tra thất bại và đối chiếu phần cũ giữ nguyên. Không đổi các checkpoint chưa đạt thành kết quả cuối.
