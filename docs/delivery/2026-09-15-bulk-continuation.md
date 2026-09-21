# Tiếp tục lô production và sửa nhập nguồn — 15/09/2026

Phạm vi: shop **1423724897 / vuatinhdau.vn**, partner **2010476**. Chỉ hai bộ đã được người dùng chốt: **can 5L, 12 SKU** và **xịt Ngọc Lan Tây, 3 SKU**. Kết quả này không đại diện cho 604 dòng nguồn, 80 listing production hoặc nhiều shop.

**Kết quả cuối: 2/2 listing, tổng 15 SKU đã mở bán và verified.** Lượt kiểm tổng kết thúc lúc **2026-09-15T08:47:19.288Z**: **1529/1529 unit + integration**, **7/7 legacy**, typecheck, TS build và web build đều đạt. Trạng thái ứng dụng là `complete`, `canStart:false`.

## Bằng chứng thực tế cuối lượt

**Can 5L — item 51467852283:** giữ kết quả đã mở bán và verified. Mọi dòng operation, step, verification và publication được chụp hash trước khi tiếp tục: `4774b33d82dfb176bb6a7cb94e6536d23695874f9e3affdf12aaf8f37af31358`. Audit cuối dùng cùng truy vấn xác nhận hash vẫn giữ nguyên. Script chỉ đọc `scripts/inspect-production-pilot-continuation.mts` dùng cùng truy vấn để kiểm lại. Không gọi prepare, run hoặc publish cho nguồn đã hoàn tất.

**Ngọc Lan Tây — item 51267858328**, create operation `007738be-04ec-4ead-88d2-825062b29056`: backend đã có biên nhận API cho 11 lượt tải ảnh gốc, một lệnh `add_item` và một lệnh `init_tier_variation`. Ba model ID **371511645264 / 371511645265 / 371511645266** lần lượt tương ứng **300 / 100 / 500ml**. Chưa phát lại bất kỳ lệnh nào trong số này.

Lần đọc đầu sau init thiếu `model_sku` và `tier_index`, đồng thời trả tồn 0 và địa điểm trống. Hai lần đọc mới lúc **08:19:05.680Z** và **08:19:08.721Z** xác nhận đầy đủ SKU, chỉ số phân loại và tồn **100 tại VNZ**; không gửi `update_stock`. Toàn bộ dữ liệu phản hồi sau chuẩn hóa ổn định giữa hai lần đọc. Giá, nội dung, thuộc tính, chín ảnh gallery đúng thứ tự, ảnh phân loại, vận chuyển và kích thước đều khớp nguồn.

Bìa được Shopee chuyển từ PNG sang JPEG, vẫn cùng kích thước **1024 × 1024 pixel**. Case `8e7e10d0-b3ee-4b3a-8985-cfce3ab3e326` đạt verified theo hình thức `manual_review` bởi **Codex QA (agent)**; root cũng xem trực tiếp hai ảnh. Đây không phải phiếu người dùng duyệt ảnh. Nguồn, ảnh đầu ra và case nằm tại `.local/production-pilot-1423724897/cover-qc-51267858328/`.

Biên nhận init giữ cân nặng gốc **0.3223 / 0.1309 / 0.5038kg**; phản hồi GET trả **0.322 / 0.131 / 0.504kg**. Người dùng **đã xác nhận riêng chấp nhận 322 / 131 / 504g**. Phiếu chỉ áp dụng cho đúng operation, item, model và SKU; nguồn, payload đã gửi và phản hồi gốc đều được giữ nguyên. SHA của phiếu là `3787b79f82b5a9321c027980ac65dfb4bcc89a1391844da97d264e404542d52f`; tệp riêng nằm tại `weight-reviews/007738be-04ec-4ead-88d2-825062b29056.json` trong thư mục pilot. Không nới bộ so sánh cân nặng chung.

**Ngọc Lan Tây đã mở bán và verified.** Publication `84d8e9a0-ad69-4740-8839-e796c998dac0` gửi đúng một lệnh `unlist:false` lúc **08:41:51.075Z**, request ID `e3e3e7f35b8185b10eff07d3c95ba600`. Phản hồi có đúng một dòng thành công cho item **51267858328**, không có dòng thất bại.

Hai lần đọc sau mở bán lúc **08:41:55.104Z** và **08:41:56.173Z** đều trả `NORMAL` trên kết nối revision **2**. Toàn bộ phản hồi sau chuẩn hóa ổn định; ngoài trạng thái mở bán, các trường cần bảo vệ giữ nguyên so với bằng chứng trước mở bán. Projection của cả hai lần đọc khớp nguồn với phiếu bìa và cân nặng đã nêu. Publication verification ID là `aea23b86-9f10-449c-919c-7ed1725aa00a`; fingerprint bằng chứng là `1077624ebc6789e93dae9f2bb4a3acfe4dd6003b5e35d36b556717d5575342e0`.

Audit độc lập cuối đạt **21/21 kiểm tra**: đúng 11 lượt tải ảnh, một create, một init phân loại và một publication; không có bước ghi bổ sung trong nhật ký operation này. Mọi bước tạo đều có biên nhận thành công và request ID riêng. Fingerprint nguồn tính lại khớp giá trị ban đầu `0edeff1ab7b4270dea3557a1a40399c6842b51e0ceba4856e35df40921895990`, nguồn và payload vẫn giữ nguyên, khóa thực thi đã được giải phóng. Hash phiếu cân nặng và fingerprint case bìa `bbbba376b8a4b031d3ea28a828029345619f40ec9256acbe176f77677de2a708` khớp trong các bằng chứng đọc create, trước mở bán và sau mở bán.

Kết nối revision **1** hết hạn lúc **08:26:42.273Z** và đã được làm mới thành công bằng refresh token đã lưu. Kết nối thực tế hiện là revision **2**, hạn mới **12:38:54Z**. Đây là lần làm mới thực tế đã thành công; **chưa có scheduler tự làm mới định kỳ**, không coi kết quả này là nghiệm thu vận hành liên tục 24 giờ.

## Thay đổi luồng API

Service phân biệt từng bộ theo các trạng thái: chưa gửi, đã đủ biên nhận chờ đọc lại, đã verified chờ mở bán, đã có biên nhận mở bán chờ đọc lại và hoàn tất. Nút tiếp tục chỉ xử lý phần còn lại có bằng chứng đúng nguồn, hash, shop và kết nối; giữ nguyên chuỗi các lần từ chối đã được đóng bằng chứng (`closed-rejection ancestry`). Các trạng thái `sent`, `unknown`, `rejected` hoặc mới tải được một phần ảnh không được phát lại.

Khi mất phản hồi trên giao diện, cùng một lần tiếp tục giữ khóa bằng `continuationKey`. Cơ chế này không khóa nhầm một lần tiếp tục mới đã được server xác nhận.

Runner có lịch đọc lại giới hạn sau **1 / 3 / 7 / 15 giây**, tính từ khi đã đủ biên nhận. Hai lần đọc cuối vẫn phải khớp nguồn và toàn bộ trạng thái cần bảo vệ. Tất cả phản hồi sớm và lịch đọc lại được lưu; không lặp lệnh ghi.

Preflight thực tế từng trả `error_rate_limit` tại `get_item_base_info`. Bộ đọc mới giãn mỗi lượt **500ms**, chỉ thử lại khi có lỗi rate limit rõ ràng kèm request ID, tối đa **bốn lần**, và lưu từng phản hồi. Lỗi xác thực hoặc lỗi truyền tải không được coi là thành công.

Khi mã hoặc tỷ lệ bìa thay đổi, bridge trên server lấy byte ảnh từ URL do API trả về và nguồn đã xác minh hash để tạo phiếu QC local. Byte hoặc pixel trùng hoàn toàn mới có thể đạt tự động; JPEG có pixel khác cần review. Hệ thống không tự đánh dấu approve. Mỗi lần đối chiếu đều tải byte mới và kiểm tra liên kết nguồn, hash cùng hạn hiệu lực.

Phiếu cân nặng cũng chỉ áp dụng cho đúng dữ kiện người dùng đã chốt, có dấu vết riêng trong bằng chứng đọc lại. Phản hồi Shopee gốc không bị thay đổi.

## Nhập nguồn: đã sửa gì và còn thiếu gì

`GET /v1/input-batches` thực tế trả **0 đợt nhập**. Catalog 604 dòng và nguồn production pilot không phải `SavedFolderBatch`. Vì vậy, dropdown chỉ có dòng chờ chọn là do chưa có đợt nhập; dòng này không phải một nguồn hợp lệ.

Tại **Đăng hàng → Công cụ chuẩn bị lô khác**, người dùng đã có thể nhập thư mục và Excel ngay tại chỗ. Luồng hỗ trợ chọn một thư mục listing hoặc thư mục cha chứa nhiều listing, tự chọn đợt vừa lưu, phân biệt trạng thái đang tải / chưa có dữ liệu / gặp lỗi, và khôi phục cùng request khi mất phản hồi lưu.

Excel phải có sheet **Điều phối listing**. Tệp DORIS riêng không được coi là bộ nguồn đầy đủ. Endpoint `GET /v1/prepared-batches/template` cung cấp Excel **ba sheet** đúng bộ đọc hiện tại; phiếu bàn giao **hai sheet** trước đó vẫn chỉ là tài liệu bàn giao, không phải mẫu nhập tự động.

**Luồng production tổng quát chưa hoàn chỉnh.** Tại checkpoint này, context của `PreparedBatch` trong app chính vẫn `unavailable`. Bộ đọc này còn giới hạn ở sandbox, một thuộc tính với một giá trị, một kênh vận chuyển; giá và điều phối phải nằm chung workbook. Chưa có cầu nối từ catalog 604 dòng sang nguồn production tổng quát hoặc khả năng tự áp mọi thuộc tính theo nhiều ngành. Không tạo batch giả, WorkOrder create mới hoặc đổi nguồn đã đăng để lấp khoảng trống.

Hướng dẫn cho nhân viên tách thuộc tính chung của listing khỏi đặc điểm từng SKU. Mùi trên ảnh bìa không đại diện cho cả 12 mùi; listing 100 / 300 / 500ml không được gán chung dung tích 100ml. Metadata ngành có thể có trường không phù hợp; không điền chỉ để tăng số trường hoàn thành. Hướng dẫn này không phải bằng chứng chức năng tự điền thuộc tính đã được triển khai.

## Kiểm tra

- **Kiểm tổng cuối, sau bridge cân nặng và refresh:** **1529/1529 unit + integration**, **7/7 legacy**, typecheck, TS build và web build đều đạt, exit code **0**, hoàn tất lúc **2026-09-15T08:47:19.288Z**. Bằng chứng: `.local/production-pilot-1423724897/verification-bulk-final.json` và `test-results-bulk-final.json`.
- **Browser:** 14 ca fixture cho nhập nguồn và controls; 11 ca fixture cho tiếp tục production; thêm một ca fixture thông báo QC. Các lượt browser này dùng API giả lập, không phải lượt ghi Shopee thực tế.
- **Checkpoint trước đó:** 1482/1482 unit + integration cùng 7/7 legacy, typecheck và build đã đạt trước bridge cân nặng và refresh; bằng chứng giữ tại `verification-bulk-1482.json` và `test-results-bulk-1482.json`. Sau đó, 21 unit và một integration roundtrip riêng cho bridge cân nặng đã đạt. Đây là các lượt kiểm lịch sử, không cộng thêm vào tổng 1529 của lượt cuối.
- **Audit dữ liệu production cuối:** 21/21 kiểm tra nhật ký và bằng chứng đọc lại đạt; không gọi Shopee hoặc ghi nhật ký trong lượt audit. Hai listing đã chốt hoàn tất, hash dữ liệu can 5L không thay đổi.
- **Phản biện độc lập:** semantics rollback/replay, liên kết nguồn bìa, đối chiếu payload và toàn bộ phản hồi với nguồn. Số test xanh không chứng minh ứng dụng đã khả dụng cho mọi ngành hoặc mọi shop.

## Phụ lục: hướng dẫn và bằng chứng

- [Chuẩn bị bộ listing cho nhân viên](../operator-guides/chuan-bi-bo-listing.md).
- [Chuẩn bị thông tin chi tiết theo ngành hàng](../operator-guides/thong-tin-chi-tiet-theo-nganh.md). Tài liệu nêu rõ phần nhân viên cần cung cấp, dữ kiện phải có nguồn và phần giao diện động còn là hướng triển khai tiếp.
- Các audit riêng trong `.local/production-pilot-1423724897/`: `row65-initial-source-audit.json`, `row65-initial-field-audit.json` và `created-read-589e89ee-2ad5-41e2-abf1-5b41e09bb133/row65-fresh-source-audit.json`.
- Audit cuối cùng trong cùng thư mục: `row65-final-publication-audit.json` chứa 21 kết quả đối chiếu, request ID, thời gian đọc và các hash; `row65-final-publication-audit.md` là báo cáo ngắn.

Không commit dữ liệu, token hoặc ảnh riêng trong `.local`.
