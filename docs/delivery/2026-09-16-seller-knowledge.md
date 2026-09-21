# Kho kiến thức từ listing của shop — 16/09/2026

**Bổ sung 16:03 UTC+7:** đã nối gợi ý có nguồn cho từng bản nháp vào màn hình chuẩn bị lô, kèm lựa chọn rõ ràng và phiếu nội bộ bất biến. Đọc [bàn giao bridge bản nháp](2026-09-16-draft-knowledge-bridge.md) và [hướng dẫn thao tác](../operator-guides/goi-y-thuoc-tinh-cho-ban-nhap.md). Kết quả kiểm riêng là fixture; không cập nhật các số liệu inventory/live bên dưới thành hiện trạng mới.

## Kết quả đã đối chiếu

Luồng đọc và lưu kiến thức nội bộ đã chạy trên **vuatinhdau.vn — shop 1423724897 / partner 2010476**, connection `2bb497e4-a306-4b1e-85ba-5ee7a814fdaf`, revision 3. Không có lệnh ghi Shopee trong mô-đun này.

- **57 listing hiện có:** 4 NORMAL và 53 UNLIST, tổng 839 model được đọc. Tên, SKU, phân loại, ngành, thương hiệu và thuộc tính giữ nguồn từ API.
- **73 dấu vết SELLER_DELETE:** chỉ ghi nhận ID/trạng thái từ danh sách. Đây không phải 73 bộ nội dung sản phẩm đầy đủ và không được dùng làm nguồn đề xuất.
- Tổng cộng **130 bản ghi trạng thái** trong một shop, cùng metadata của **13 ngành**. Không gọi đây là 130 listing đang bán hoặc nghiệm thu nhiều shop thật.
- Bốn listing cũ không trả `attribute_list`; lưu `attributes=null`, `attributeEvidenceComplete=false`, vấn đề `ATTRIBUTE_LIST_NOT_RETURNED`, giữ nguyên phản hồi gốc và loại khỏi nguồn đề xuất. Đây là dữ liệu chưa biết, không phải bằng chứng thuộc tính rỗng.

Lượt đầu `0706bf1b-9625-4845-b3db-decf74516dd1` hoàn tất lúc **03:12:32.302 UTC / 10:12:32 UTC+7**: 130 bản ghi, 89 biên nhận GET, không phát lại create/init/upload/publication. Con số 89 gồm các GET trong lúc điều tra và 3 GET thất bại do tiến trình khởi động trong môi trường không có mạng; không trình bày như thời gian/tốc độ một lượt lạnh chạy liền mạch.

Lượt đọc lại `7d20a985-74e7-41a4-a85d-b45c4ce5abe6` hoàn tất lúc **03:13:46.299 UTC**. Đo từ yêu cầu HTTP đến nhận kết quả: **7.528 giây, 13 GET, 126 bản ghi tái dùng, 4 listing đọc lại** vì thuộc tính chưa đầy đủ. Đã dừng đúng ngân sách 100 bản ghi rồi tiếp tục 30 bản ghi còn lại bằng checkpoint. Đây là tốc độ đọc/lưu kiến thức, không phải tốc độ đăng hàng.

## Quy tắc thu thập và các ngoại lệ đã gặp thật

Adapter riêng chỉ cho GET của `get_item_list`, `get_item_base_info`, `get_model_list`, `get_category`, `get_attribute_tree`. Dữ liệu và khóa theo environment/partner/shop/connection revision; thông tin xác thực chỉ được giải mã phía server. Không đọc đơn hàng hoặc dữ liệu khách hàng. Các lời gọi, hash, request ID, thời điểm và cảnh báo lưu thành bằng chứng bất biến; con trỏ quan sát hiện tại riêng.

Danh sách lấy tối đa 100 dòng/trang; đọc thông tin cơ bản theo nhóm vận hành 20 item, thấp hơn giới hạn 50 trong tài liệu API. Có tối đa 3 lần thử cho lỗi GET tạm thời, khóa theo kết nối, checkpoint sau mỗi item và ngành đang chờ. Ngân sách mỗi lần chạy mặc định 100, tối đa 500; hết ngân sách phải tiếp tục cùng công việc. Không tự xóa dữ liệu vì nhận một trang rỗng.

- Dữ liệu listing chưa đổi thời gian cập nhật được tái dùng tối đa 24 giờ. Sau hạn này phải đọc lại base/model; bằng chứng cũ giữ thời điểm cũ, bằng chứng mới gắn biên nhận mới. Mỗi item chỉ có một nguồn hiện tại khi xét đề xuất.
- Metadata ngành dùng tối đa 15 phút và phải cùng revision kết nối. Thời điểm/hạn dùng tổng hợp theo nguồn thành phần cũ nhất; đọc lại một phần không làm mới giả phần còn lại.
- SKU trống/trùng không bị che bằng việc rút gọn danh sách: vẫn lưu đủ model ID, SKU và `tier_index`, số model, cờ `skuIdentityComplete`; không lấy SKU cha thay một SKU phân loại bị thiếu.
- Cảnh báo thật `fail to get channel estimated_shipping_fee for channel [số]` được phép tiếp tục **chỉ tại get_item_base_info**, khi mọi dòng cảnh báo đều đúng mẫu này. Cảnh báo nguyên văn vẫn lưu, và listing có `SHIPPING_FEE_UNAVAILABLE`. Không suy ra phí hay tính hợp lệ vận chuyển. Cảnh báo hỗn hợp, khác nội dung hoặc xuất hiện ở API khác vẫn dừng; ngành đang chờ được giữ để tiếp tục đúng điểm.
- Phản hồi nhóm BANNED rỗng thực tế bỏ trường `item`: chỉ nhận là rỗng khi offset đầu bằng 0, `total_count` đúng 0 và `has_next_page` đúng false. Các trường hợp thiếu/mâu thuẫn còn lại bị chặn.

## Năm thông tin đã xác nhận cho xịt khử mùi thảm

Đúng **xịt khử mùi thảm VINA TƯƠI, item 45467915350, 48 model/SKU**, bằng chứng hiện tại `25f0f13f-6c26-480f-b741-64a643d666ec`. Người dùng xác nhận phạm vi toàn bộ 48 SKU; đã lưu qua HTTP vào phiếu nội bộ bất biến `2e11a273-d269-4bb4-9996-88933bd23002` lúc **03:14:16.917 UTC**.

| Trường | Giá trị đã xác nhận | Ánh xạ API |
| --- | --- | --- |
| Xuất xứ | Việt Nam | attribute 100037, value 136 |
| country of origins | Việt Nam | attribute 102560, custom value 0 |
| Hạn sử dụng | 36 tháng | attribute 100010, custom value 0 |
| Tên tổ chức chịu trách nhiệm sản xuất | CÔNG TY TNHH VINA TƯƠI | attribute 101067, custom value 0 |
| Loại bảo hành | Không bảo hành | attribute 100370, value 5576 |

Bộ đề xuất trả cả năm với nguồn `product_source`, độ tin cậy `confirmed`, cho phép điền **bản xem trước nội bộ**. Không có ứng viên lịch sử cùng ngành/brand còn lại cho mục tiêu này (`candidateCoverage.totalCount=0`). Phiếu không phát lệnh cập nhật thuộc tính trên Shopee, không đổi nguồn Excel/Word hoặc listing đã đăng.

**Địa chỉ tổ chức chịu trách nhiệm chưa được cung cấp.** Không lấy tên công ty điền vào địa chỉ, không suy từ listing khác. `missingMandatoryAttributeIds=[]` của metadata hiện tại không có nghĩa địa chỉ đã được xác minh hoặc mọi thông tin sản phẩm đã đầy đủ.

## Kiểm chứng và phạm vi

- Migration 026–027 đã áp dụng; `/health/ready` đạt sau khởi động. API tại thời điểm bàn giao **03:31:17 UTC**: **PID 26988, cổng 4310**, giữ `PRODUCTION_PILOT_ENABLED=1` và `TSX_TSCONFIG_PATH` đúng app API. Đã kiểm không có công việc đăng/đọc đang chạy trước restart. Luôn kiểm PID/công việc hiện tại trước lần restart tiếp theo.
- Bản mã cuối được kiểm lúc **03:29:19 UTC**: **93/93 kiểm thử tập trung** gồm 32 PostgreSQL collector, 6 HTTP và 55 unit của bộ đề xuất/adapter/transport/facts; **typecheck, build TypeScript và web đạt**. Hash 10 tệp triển khai/kiểm thử chính không đổi trong lượt kiểm này. Bao phủ phân trang/checkpoint/resume, tách shop, bằng chứng bất biến, revision/token, retry, cache, thiếu thuộc tính, SKU trống/trùng, cảnh báo, trang rỗng có bằng chứng và thứ tự tìm kiếm.
- **5/5 browser fixture** đạt trên UI cuối: đồng bộ/tiếp tục/xem nguồn, giữ ngữ cảnh khi lỗi, bỏ phản hồi đến muộn của shop trước, cảnh báo tập nguồn bị giới hạn và dấu vết đã xóa chỉ có thao tác xem bằng chứng. Các ca browser không gọi Shopee hoặc DB.
- Lượt kiểm tổng kết thúc **03:25:16 UTC** đạt **1845/1845 unit/integration + 7 legacy**, typecheck/build đạt. Đây là baseline rộng; sửa nhỏ thứ tự tìm kiếm/UI đã diễn ra khi lượt đó đang chạy, nên không gọi là lượt kiểm tổng trên toàn bộ mã cuối. Phần thay đổi cuối được kiểm lại riêng bằng 93 ca, 5 browser fixture và typecheck/build nói trên; không cộng thành số test của một lượt tổng mới.
- **Kiểm tổng tiếp theo trên mã đã chốt, kết thúc 03:58:19.128 UTC: 1857/1857 unit/integration (99 tệp) + 7/7 legacy, 0 skip; typecheck/TS build/web build đạt.** Lượt này bao gồm mã KB/search/UI cuối và phần preparation brand/authorization hoàn tất sau đó. Trong lượt chỉ còn thay đổi helper riêng `.local` và tài liệu, không sửa app/package/test. Đây là lượt tổng ổn định mới; không biến kiểm fixture thành kết quả publication. Hồ sơ tại `.local/vina-input-preparation-20260916/orchestration/verification-frozen-final.json`, `test-results-frozen-final.json`, `full-verify-frozen.log`.
- GET HTTP trên DB thật lúc **03:31:17 UTC** xác nhận mặc định trả 30 listing có tên, không lẫn dấu vết đã xóa; tìm đúng item ID lịch sử vẫn trả dấu vết SELLER_DELETE. UI dùng tên sản phẩm trước, ghi rõ trạng thái ẩn/đã xóa; dòng đã xóa không có nút lấy đề xuất. Phép kiểm này không gọi thêm Shopee.
- Đối chiếu lúc **03:15:41.384 UTC**: **15 bảng nguồn/công việc/kết nối/nhật ký publication giữ nguyên số dòng và hash** so với 02:47:52.446 UTC. Bao gồm 4 publication verified, 4 operation verified + 2 rejected, 146 step ACK + 2 rejected; không đổi lịch sử.
- Mọi biên nhận collector đã kiểm đều có method GET. Không có publish, update thuộc tính, đơn hàng, refresh token hoặc tác vụ tự chạy 24 giờ trong lượt nghiệm thu này.
- Đa shop, gián đoạn tiến trình và ca lỗi có kiểm thử riêng; chỉ **một shop production** đã chạy thật. Chưa có scheduler 24 giờ, nhiều shop thật hoặc tự áp đề xuất lên Shopee.

## Hồ sơ bằng chứng

Tệp riêng nằm trong `.local/attribute-research-20260916/`, không commit:

- `acceptance-summary.json`: phạm vi, thống kê trạng thái/model, bốn ngoại lệ, GET theo API và job.
- `acceptance-resume.json`, `acceptance-warm.json`: trạng thái hoàn tất, thời gian HTTP, cache và checkpoint.
- `carpet-facts-request.json`, `carpet-facts-receipt.json`, `carpet-recommendations-before-facts.json`, `carpet-recommendations-after-facts.json`.
- `protected-before.json`, `protected-after.json`: đối chiếu 15 bảng; script chỉ đọc và lưu hash, không xuất bí mật.
- `incomplete-live-item.json`, `live-list-empty.json`: phản hồi thật làm cơ sở sửa guard hẹp.
- `verification-first.json`, `test-results-first.json`: lượt cũ có test thay đổi giữa lúc chạy; không xóa hoặc trình bày thành lượt cuối đạt.
- `verification-mid-fix.json`, `test-results-mid-fix.json`, `full-verify-final.log`: lượt kiểm giữa các sửa lỗi thật.
- `verification-before-search-final.json`, `test-results-before-search-final.json`, `full-verify-stable.log`: baseline rộng 1845 + 7; giữ tên log lịch sử, không coi là mã cuối ổn định.
- `verification-focused-final.json`, `focused-test-results-final.json`, `focused-verify-final.log`: 93 ca và type/build của mã cuối, kèm hash không đổi.
- `browser-results-final.json`, `seller-knowledge-mobile.png`: 5 ca UI fixture và ảnh màn hình nhỏ.
- `http-search-final.json`: health/PID, thứ tự tìm kiếm thật và khả năng tra dấu vết đã xóa bằng ID.

Nguồn API: kho Shopee chụp **08/09/2026**, đọc hướng dẫn đầy đủ và đối chiếu trực tiếp phản hồi production **16/09/2026**: [API calls](https://open.shopee.com/developer-guide/16), [get_item_list](https://open.shopee.com/documents/v2/v2.product.get_item_list?module=89&type=1), [get_item_base_info](https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1), [get_model_list](https://open.shopee.com/documents/v2/v2.product.get_model_list?module=89&type=1), [get_attribute_tree](https://open.shopee.com/documents/v2/v2.product.get_attribute_tree?module=89&type=1). Mức 0 trong dữ liệu rate limit tài liệu không được coi là shop có quota vô hạn.
