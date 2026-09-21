# Phản biện độc lập readback sandbox — 14/09/2026

**FIELD-20260914-B có 14 trường hợp đọc lại đạt, 1 trường hợp bị chặn trước ghi, 0 chưa thực hiện, 0 unknown.** Đối chiếu độc lập toàn bộ 14 cặp raw before/after không phát hiện kết quả `verified` sai hoặc tiếp tục sau một lần ghi chưa rõ kết quả. Đây là nghiệm thu từng nhóm trường trên ba listing kỹ thuật sandbox, chưa phải nghiệm thu toàn bộ cập nhật sản phẩm hoặc production.

Phạm vi pin: TEST partner **1232297**, shop **227418363**, connection revision **6**, capability revision **5**. Thời gian 14/09/2026 **02:26:06.454–02:27:39.736 UTC** (09:26–09:27 giờ Việt Nam), gồm khoảng dừng để xem xét giá rồi tiếp tục rõ ràng các trường hợp độc lập. Bằng chứng gốc nằm tại [FIELD-20260914-B](../../.local/acceptance-20260914/FIELD-20260914-B/): `manifest.json`, 15 biên nhận prepare, 14 biên nhận execute, `summary.json`, `continuation-summary.json` và `continue-field.mts`. Bản summary đầu vẫn ghi đúng đoạn đầu 3 đạt, 1 bị chặn, 11 chưa thực hiện; bản continuation ghi kết quả đủ 15.

## Đích và kết quả

| Item | Nguồn kỹ thuật | Cấu trúc | Kết quả |
| --- | --- | --- | --- |
| 803935036 | SBX-BULK-20260914-R6A-001 | Không tầng; model API 0 | Tiêu đề, mô tả thường, gallery, tồn đạt; giá bị chặn |
| 803934786 | SBX-BULK-20260912-C-002 | Một tầng, hai model | Cả năm nhóm đạt |
| 803934787 | SBX-BULK-20260912-C-003 | Hai tầng, bốn model | Cả năm nhóm đạt |

Tổng theo nhóm: **3 tiêu đề, 3 mô tả thường, 3 gallery, 2 giá, 3 tồn đạt**. Tất cả giữ `UNLIST`, ngành 301378, parent SKU, model ID/SKU/tier index và cấu trúc phân loại. Item 803934364 (Lamy) và 846056124 không có trong các intent này và bị guard của client/dịch vụ loại khỏi đường ghi. Việc tạo canary 803935036 có biên nhận riêng tại [LIVE-REV6/create-latest.json](../../.local/acceptance-20260914/LIVE-REV6/create-latest.json); không cộng phép tạo đó vào 15 trường hợp cập nhật.

## Phương pháp kiểm độc lập và phần được bảo toàn

Đã đọc từng prepare/execute, so input với đúng UUID và operation trong manifest, kiểm baseline của execute trùng prepare, rồi dựng giá trị dự kiến từ bản raw trước bằng chương trình kiểm riêng dùng `assert.deepStrictEqual`, **không gọi comparator của ứng dụng**. Tập model được kiểm không trùng ID và sắp theo model ID; Shopee thực tế đổi thứ tự trả về giữa các lần đọc. Giữ nguyên thứ tự tier, option, ảnh và mọi trường chưa biết. Chỉ cho phép `item.update_time` thay đổi ở các lệnh update_item; URL gallery được ghép lại theo ánh xạ image ID → URL của bản trước, không bỏ URL toàn cục. Toàn bộ raw sau phải trùng expected, bao gồm trường chưa biết.

Kết quả:

- 14/14 phép ghi có giá trị được chọn khác trước và đúng yêu cầu sau; fingerprint trước/sau đều khác. 14 acknowledgement có request ID riêng. Giá/tồn trả đúng một success ID đã chọn và không có failure ID.
- Mô tả giữ đúng chữ Việt, ký tự `Ắ ệ & < >`, xuống dòng và dòng trống. Không thay nội dung để qua kiểm tra.
- Gallery chỉ hoán đổi ảnh thứ hai và thứ ba. Tập mã ảnh, ảnh đầu tiên, tỷ lệ 1:1 và toàn bộ promotion image giữ nguyên; URL đổi theo chính các mã ảnh đó. Không upload/crop/remap ảnh trong nhóm cập nhật này.
- Mỗi baseline kế tiếp của cùng item trùng raw readback trước đó sau khi sắp model theo ID. Không thấy drift bị che giữa các trường hợp.

| Nhóm | Đích được chọn và thay đổi thật | Phần ngoài lựa chọn được kiểm nguyên vẹn |
| --- | --- | --- |
| Giá, một tầng | Model 4258854181 / C-002-M2: 21.100 → 21.200 VND | Toàn bộ model 4258854180; tồn của cả hai model; tiền tệ, khuyến mại và cấu trúc |
| Giá, hai tầng | Model 4258854182 / C-003-M1: 20.200 → 20.300 VND | Toàn bộ model 4258854183, 4258854184, 4258854185; tồn của cả bốn model; tiền tệ, khuyến mại và cấu trúc |
| Tồn, không tầng | Model 0, location VNZ: 3 → 2 | Giá 20.000 VND và toàn bộ nội dung/ảnh/cấu hình |
| Tồn, một tầng | Model 4258854181, location VNZ: 4 → 2 | Toàn bộ model 4258854180; mọi giá, gồm giá mới 21.200 VND của model được chọn |
| Tồn, hai tầng | Model 4258854182, location VNZ: 3 → 2 | Toàn bộ ba model còn lại; mọi giá, gồm giá mới 20.300 VND của model được chọn |

Hai lệnh giá làm đổi đúng bốn giá trị: original/current và hai inflated price trên model được chọn; điều kiện trước được kiểm là cờ `has_promotion=false` và bốn giá bằng nhau. Điều này chưa xác minh toàn diện chương trình sắp chạy. Ba lệnh tồn chỉ đổi seller stock và tổng available tương ứng; location, if_saleable, reserved = 0, Shopee stock = 0 và advance stock = 0 giữ nguyên. Đây là lệnh tồn tuyệt đối 2 đã chọn cho phép thử, không phải cơ chế tự bù tồn hoặc phản ứng sau đơn hàng.

## Thời gian ghi nhận

Đơn vị mili giây. Prepare gồm kiểm tra và đọc baseline; execute gồm các lần đọc trước, ghi và đọc lại với thời gian chờ của dịch vụ. Đây không phải thời gian riêng của một request Shopee hoặc số đo tải lớn.

| Ca | Item | Nhóm | Prepare | Execute | Kết quả |
| --- | --- | --- | ---: | ---: | --- |
| 01 | 803935036 | Tiêu đề | 624 | 2.566 | Đạt |
| 02 | 803935036 | Mô tả | 349 | 2.531 | Đạt |
| 03 | 803935036 | Gallery | 303 | 2.321 | Đạt |
| 04 | 803935036 | Giá | 198 | — | Chặn trước ghi |
| 05 | 803935036 | Tồn | 575 | 2.352 | Đạt |
| 06 | 803934786 | Tiêu đề | 425 | 2.925 | Đạt |
| 07 | 803934786 | Mô tả | 402 | 3.108 | Đạt |
| 08 | 803934786 | Gallery | 416 | 2.811 | Đạt |
| 09 | 803934786 | Giá | 493 | 2.912 | Đạt |
| 10 | 803934786 | Tồn | 610 | 2.645 | Đạt |
| 11 | 803934787 | Tiêu đề | 434 | 3.028 | Đạt |
| 12 | 803934787 | Mô tả | 483 | 2.875 | Đạt |
| 13 | 803934787 | Gallery | 463 | 2.802 | Đạt |
| 14 | 803934787 | Giá | 509 | 2.678 | Đạt |
| 15 | 803934787 | Tồn | 415 | 2.616 | Đạt |

14 execute mất 2.321–3.108 ms, trung bình **2.726,4 ms**, tổng **38.170 ms**. Prepare của các ca đạt mất 303–624 ms, tổng 6.501 ms. Tổng thời gian hai đoạn, kể cả khoảng dừng xem xét, là **93.282 ms**.

## Lỗi comparator đã sửa và trường hợp bị chặn

Trong phản biện trước lượt ghi, comparator đệ quy từng key đã coi hai đối tượng rỗng khác kiểu `[]` và `{}` như không có diff. Điều đó có thể báo `verified` sai khi một trường ngoài phạm vi đổi kiểu. Đã bổ sung kiểm kiểu array/object tại [sandbox-field-checks.ts](../../apps/api/src/sandbox-field-checks.ts) và hai regression theo cả hai chiều tại [sandbox-field-checks.test.ts](../../tests/unit/sandbox-field-checks.test.ts). Chạy trước sửa tái hiện **2 lỗi**, chạy sau sửa **8/8 đạt**; lỗi phải trả `verified=false`, `selectedMatch=true`, `unchanged=false` và đúng đường dẫn ngoài lựa chọn. Kiểm raw độc lập của 14 biên nhận thật không thấy dạng thay đổi này hoặc loại false-green khác.

Ca 04 có `has_model=false`, `has_promotion=true`, `promotion_id=0`, giá current/original cùng 20.000 VND. Dịch vụ trả HTTP 409 `FIELD_PROMOTION_REQUIRES_REVIEW` trong prepare; không có execute/acknowledgement cho ca này. Không suy từ ID khuyến mại 0 hoặc giá bằng nhau thành không có chương trình. Ca này vẫn **bị chặn**, chưa nghiệm thu đổi giá không tầng.

Continuation giữ cùng manifest/UUID, bỏ qua đúng bốn ca đã xử lý và chỉ thực hiện ca 05–15 sau khi xác định ca 04 chưa gửi mutation. Không replay ba ca đạt, không gửi lại ca giá bị chặn, không nới guard và không tiếp tục sau unknown. Chương trình tiếp tục vẫn trả mã thoát 2 vì chưa đủ 15 ca đạt.

## Giới hạn còn lại

- Giá của listing không tầng còn mâu thuẫn cờ khuyến mại; cần chẩn đoán chỉ đọc và quyết định có nguồn trước khi thêm phép ghi.
- Chưa thử bìa riêng 1:1 cùng gallery 3:4, mô tả có ảnh, ảnh phân loại, thuộc tính hoặc vận chuyển trong lượt backend này. Extended description còn bị `FIELD_EXTENDED_LIMIT_UNVERIFIED`; không dùng lại mã ảnh normal như bằng chứng đã upload đúng scene mô tả.
- Chưa có live test partial nhiều model, timeout/crash, cạnh tranh lệnh, đơn hàng giảm tồn, nhiều kho, tồn 0, đổi khuyến mại hoặc phục hồi unknown. Kiểm mô phỏng các nhánh lỗi không thay thế các bằng chứng đó.
- Kết luận dựa trên những trường API trả tại thời điểm đọc. Không suy ra QC/Seller Center, quyền shop thật, dữ liệu doanh nghiệp, tự làm mới token hoặc tải 50–80 phép cập nhật. Import patch vẫn cần luồng thực thi và biên nhận riêng.
- Hợp đồng và ngày tài liệu Shopee được lưu tại [bản phản biện nguồn](2026-09-14-sandbox-field-contract.md). Snapshot tài liệu 08/09/2026 và các lần mở trang chính thức bị 403 không tự chứng minh policy production hiện hành.

Phản biện này chỉ đọc hồ sơ chạy và mã, thêm tài liệu đánh giá, cùng bản sửa comparator đã được yêu cầu riêng. Không gọi mạng ghi Shopee, không đọc khóa/token và không sửa DB app chính trong quá trình phản biện.
