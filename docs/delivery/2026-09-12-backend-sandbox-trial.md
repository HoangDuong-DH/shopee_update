# Kết quả thử backend sandbox — 12/09/2026

**Đã gửi 80 yêu cầu tạo qua API backend và worker: 76 listing tạo thật, đọc lại đạt; 4 bị Shopee từ chối với `product.error_busi`. Không phải 80/80 thành công. Production chưa nghiệm thu.**

Dữ liệu sổ tay kỹ thuật tự tạo, đúng TEST partner **1232297**, shop **227418363**, host `openplatform.sandbox.test-stable.shopee.sg`. Mọi listing mới giữ **UNLIST**. Không đăng ký Mall/brand, tạo khuyến mại hoặc ghi shop thật. Không dùng hoặc thay nguồn Lamy/KINI.

## Kết quả thực tế

Người dùng cập nhật token tại UI; kết nối revision 5 đọc shop thành công. Thử tăng dần 1 → 10 → 69 nguồn riêng, mỗi nguồn gửi `add_item` đúng một lần. Backend gọi OpenAPI trực tiếp, không điều khiển API Test Tool để tạo listing.

| Lô | Yêu cầu | Đọc lại đạt | Bị từ chối | Chuẩn bị, gồm 3 ảnh | Xếp hàng → kết quả cuối |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 1 | 1 | 0 | 12,169 giây | 7,871 giây |
| B | 10 | 10 | 0 | 6,746 giây | 46,251 giây |
| C | 69 | 65 | 4 | 6,479 giây | 389,846 giây |
| Tổng | **80** | **76** | **4** | | |

Thời gian lấy từ sự kiện `QUEUED` đến kết quả cuối. Lô C xử lý hết nhưng có lỗi; 389,846 giây không phải thời gian đạt toàn bộ 69 listing. Chuẩn bị, con người xem trước, nhập token và sửa/khởi động lại ứng dụng nằm ngoài thời gian hàng đợi.

76 listing đạt gồm **26 không tầng, 25 một tầng, 25 hai tầng**; **150 model phân loại**, tương đương **176 SKU bán được** khi tính thêm listing không tầng. Có 80 request tạo, 50 request khởi tạo phân loại, 126 request đọc base/model; 76 listing đạt ngay lần đối chiếu đầu. Khoảng chờ tạo xong → khởi tạo phân loại thấp nhất **5,064 giây**.

Kiểm độc lập khớp tên, SKU, mô tả chữ, gallery/ảnh phân loại, ngành/thuộc tính, thương hiệu theo ID, kích thước/cân nặng, kênh vận chuyển, giá và tồn từng model. Shopee trả model khác thứ tự ở một số item; ánh xạ theo SKU và `tier_index` vẫn đúng. Đây là đối chiếu dữ liệu đã gửi, không phải Shopee đã duyệt policy/QC.

Mở mẫu trong Seller Center sandbox:

- [803934774 — không phân loại](https://banhang.sandbox.test-stable.shopee.vn/portal/product/803934774)
- [803934776 — một tầng phân loại](https://banhang.sandbox.test-stable.shopee.vn/portal/product/803934776)
- [803934777 — hai tầng phân loại](https://banhang.sandbox.test-stable.shopee.vn/portal/product/803934777)

Quét lại shop lúc **09:36:45 ICT** thấy **78 item = 76 mới + 2 cũ**, mọi item mới đúng SKU và UNLIST. Không thấy SKU của bốn nguồn lỗi. Hai item cũ **803934364** và **846056124** giữ nguyên các trường base được đối chiếu và `update_time`; hash trước/sau khớp. Nguồn Lamy revision 1 và run cũ `unknown / COVER_READBACK_REVIEW` giữ nguyên; không gửi lại cập nhật hoặc nhân bản.

## Bốn lỗi và phát hiện từ phép thử

| Nguồn | Mã phản hồi | Request ID |
| --- | --- | --- |
| SBX-BULK-20260912-C-055 | product.error_busi | e3e3e7f35b4004b3fb05d820e432fa00 |
| SBX-BULK-20260912-C-056 | product.error_busi | e3e3e7f35b40063369d7c45080113300 |
| SBX-BULK-20260912-C-057 | product.error_busi | e3e3e7f35b4006fcb388fda222568500 |
| SBX-BULK-20260912-C-058 | product.error_busi | e3e3e7f35b4007c4e8d9bdf66ca3ca00 |

Mỗi lần bị từ chối mất khoảng 10,7–11,2 giây. C059–C069 sau đó lại thành công, nên chưa có bằng chứng về trần cứng 65 listing hoặc nguyên nhân do tốc độ. Ngành, thuộc tính, thương hiệu, giới hạn và từng cấu hình kênh trước/sau C giống nhau; chỉ thứ tự mảng vận chuyển đổi.

`product.error_busi` dùng cho nhiều nguyên nhân. **Chưa xác định được nguyên nhân cụ thể**: gateway chưa giữ thông báo lỗi, worker chưa giữ HTTP status trong bằng chứng mutation. Cần chẩn đoán đã lọc dữ liệu nhạy cảm; không suy nguyên nhân hoặc tự retry từ message.

Lượt chạy thật chỉ tự dừng lô khi lỗi xác thực hoặc ghi chưa rõ; bốn lỗi nghiệp vụ liên tiếp vẫn cho nguồn khác chạy. Lệnh dừng thủ công có audit lúc **09:35:11 ICT**, **sau khi mọi item đã kết thúc**. Không gọi đây là bằng chứng tự ngắt khi lỗi lặp lại. Bốn nguồn lỗi giữ nguyên, không gửi lại để ép 80/80. Bản sửa sau phép thử phải tách khỏi hành vi đã chạy thật.

Các phát hiện khác:

- Quy tắc vận chuyển thực tế trả object, khác dạng mảng trong schema; đã sửa parser và kiểm cả yêu cầu bật/tắt kênh.
- SPX/Economy trả giới hạn thể tích dương nhưng không có đơn vị: vẫn giữ ngoại lệ. Chọn rõ SPF Mart 50040 trước khi chốt fixture vì metadata đủ kiểm tra; không áp làm mặc định production.
- Một số mẫu trả `has_promotion=true`, `promotion_id=0` dù giá hiện tại bằng giá gốc. Chỉ kết luận giá khớp; chưa kết luận chương trình từ cờ này.
- Trial cha từng báo `waiting` vì cờ dừng được ưu tiên dù mọi item đã kết thúc. `updatedAt` cũng chưa cập nhật sau mọi readback. Báo cáo này tính theo item/event, không dùng hai trường tổng hợp đó.

## Bằng chứng và phạm vi

Tệp riêng tại `.local/sandbox-bulk-20260912/`, không đưa lên Git:

- `trial-{A,B,C}-{prepare,submit,status}.json`: nguồn, ảnh, request ID, checkpoint và readback.
- `live-summary.json`; `live-items.csv` đủ 80 nguồn và kết quả; `live-models.csv` có **184 SKU dự kiến**, phân biệt **176 SKU đã đối chiếu** với **8 SKU thuộc nguồn lỗi**, không tự tạo model ID cho chúng.
- `inspect-after-live.json`, `final-readback-sweep.json`: toàn shop và hai item cũ.
- `manual-pause.json`: thời điểm dừng thủ công; không sửa trạng thái item để ép thành công.

Fixture dùng chung **3 ảnh PNG 1:1 trong mỗi lô, tổng 9 upload**. Chỉ một ngành sổ tay, tối đa hai tầng/bốn model, mô tả chữ. Chưa đại diện ảnh riêng từng sản phẩm, Word/KINI đầu cuối, bìa riêng 1:1 + gallery 3:4, ảnh mô tả, nhiều ngành/Mall, nguồn doanh nghiệp hoặc chạy 24 giờ. Không ngoại suy số link/24h.

## Mã và kiểm chứng

API chuẩn bị lưu nguồn/ảnh/manifest bất biến, metadata và fingerprint; submit lưu Postgres trước khi trả 202. Worker pin shop/revision/payload, lưu intent trước ghi, checkpoint item ID, chờ trước init rồi đọc độc lập. Mất phản hồi ghi giữ unknown, không tự gửi lại. Migrations 007–008 áp dụng local. Nhánh thử riêng chưa bật create cho WorkOrder doanh nghiệp.

Sau lượt thật đã sửa trạng thái tổng để kết quả terminal ưu tiên hơn cờ paused, cập nhật thời gian trial sau readback, và thêm guard dừng khi ba CREATE liên tiếp cùng lô bị từ chối cùng mã. Thành công hoặc mã lỗi khác ngắt chuỗi; không tự retry/resume. Bảy ca mới kiểm việc không gửi yêu cầu thứ tư, restart, cách ly lô, reset chuỗi, trạng thái tổng và thời gian. **Guard mới được kiểm thử giả lập, chưa kiểm thử lỗi này lại trên Shopee; không đổi bằng chứng 76/80.**

Kiểm cuối: typecheck/build đạt, **333/333 unit/integration**, **7/7 legacy** đạt; báo cáo `.local/verification.json` và `.local/test-results.json`. Ca mô phỏng 80 nguồn dùng Postgres thật nhưng transport/đồng hồ giả, tách riêng hoàn toàn với kết quả thật **76/80**. Ca lỗi kiểm duplicate submit, scope, checkpoint/lease, mất phản hồi, token, metadata hết hạn và readback lệch.

Đã nạp bản sửa local lúc 09:47 ICT. Đọc API sau nạp trả đúng lô C `failed` với 65 verified/4 failed và giữ lý do paused riêng; không có yêu cầu Shopee mới. Kiểm cuối API ready, worker online, UI HTTP 200, `productionWrites=false`; DB vẫn 3 trial/80 nguồn. Bản chụp `trial-C-status-after-fix.json` giữ riêng khỏi bằng chứng lượt chạy cũ.

Browser trước đó 42/43 ở lượt đầu, một ca KB timeout khi chạy cùng test backend rồi đạt khi chạy riêng; không gọi là 43/43 cùng lượt. Lượt này không sửa giao diện. Build còn cảnh báo kích thước bundle. Chưa nghiệm thu refresh token, chẩn đoán đầy đủ lỗi, giải quyết unknown qua UI, lịch/worker 24h, nguồn doanh nghiệp nhiều ngành, khuyến mại/Flash Sale hoặc production.

Hướng dẫn: [Sandbox backend trials](../runbooks/sandbox-backend-trials.md). Nguồn: [chuẩn bị tạo](https://open.shopee.com/developer-guide/209), [luồng tạo](https://open.shopee.com/developer-guide/211), [add_item](https://open.shopee.com/documents/v2/v2.product.add_item?module=89&type=1), [init_tier_variation](https://open.shopee.com/documents/v2/v2.product.init_tier_variation?module=89&type=1), [get_item_base_info](https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1), [get_model_list](https://open.shopee.com/documents/v2/v2.product.get_model_list?module=89&type=1), [FAQ 410](https://open.shopee.com/faq/410). KB snapshot 08/09/2026; add_item cập nhật 01/09/2026, hướng dẫn 209/211 ngày 19/09/2025. Web trực tiếp 12/09 trả 403; metadata đúng sandbox đã xác minh lại qua API. Không tuyên bố policy production mới nhất đã được nghiệm thu.

Đầu lượt, token revision 4 từng bị từ chối (`invalid_acceess_token`, HTTP nội bộ `SANDBOX_AUTH_REQUIRED`); bằng chứng `inspect.json` giữ riêng. Người dùng đổi token thành revision 5 trước các phép ghi ở trên; không đưa khóa/token vào chat hoặc báo cáo.
