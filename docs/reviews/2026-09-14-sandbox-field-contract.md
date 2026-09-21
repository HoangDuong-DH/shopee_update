# Hợp đồng phép thử cập nhật từng nhóm trường — 14/09/2026

Phạm vi đánh giá: TEST partner **1232297**, shop **227418363**, host `openplatform.sandbox.test-stable.shopee.sg`, các listing sổ tay kỹ thuật đã có bằng chứng nguồn `SANDBOX QA` / `SBX-BULK-`, giữ `UNLIST`. Hai item **803934364** và **846056124** phải bị chặn tại mọi đường ghi của phép thử này. Đây là hợp đồng triển khai và kiểm thử cục bộ, không phải kết quả ghi sandbox mới hoặc nghiệm thu production.

## Quyết định triển khai nhỏ nhất

Giữ nguyên `SandboxListingService` cũ: lớp đó pin item Lamy 803934364 và nguồn doanh nghiệp. Không mở rộng guard cũ để dùng cho fixture khác. Thêm `SandboxFieldClient` riêng trong `packages/shopee/src/field-client.ts`; lớp dịch vụ phép thử riêng chịu trách nhiệm intent, khóa, nguồn đích và đối chiếu. `ImportPatchService` vẫn là biên nhận chuẩn bị từ nguồn local, không tự biến biên nhận `prepared` thành quyền thực thi hoặc ảnh chụp remote.

Bộ gọi mới có sáu nhóm: tiêu đề, mô tả thường/mở rộng, gallery, bìa, giá gốc và tồn bán thủ công. Trả lời thành công của API chỉ là acknowledgement. Ảnh phân loại, thuộc tính, vận chuyển, thay cấu trúc/SKU, preorder, trạng thái bán, khuyến mại và cập nhật production chưa nằm trong bộ gọi này.

## Hợp đồng trường và đối chiếu

| Nhóm | Payload được phép | Điều kiện và phần phải giữ |
| --- | --- | --- |
| Tiêu đề | `update_item`: `item_id`, `item_name` | Giữ tiền tố fixture `SANDBOX QA`; kiểm giới hạn live. Mô tả, mọi ảnh, giá/tồn, ngành, thuộc tính, logistics và model giữ nguyên. |
| Mô tả | `update_item`: `description_type` cùng `description` hoặc toàn bộ `description_info.extended_description.field_list` | Giữ đúng thứ tự block, chữ, khoảng trắng và mã ảnh. Mở rộng là khả năng cần quyền; không suy từ sandbox sang production. Không gửi cả hai dạng nội dung cùng lúc. |
| Gallery | `update_item`: `image.image_id_list`, `image.image_ratio`; với 3:4 thêm `promotion_images.image_id_list` lấy nguyên từ ảnh chụp trước | Gallery là danh sách thay thế có thứ tự. Đổi gallery 3:4 mà thiếu bìa đã từng làm Shopee thay bìa Lamy. Nếu mã bìa đổi dù gửi lại đúng mã cũ, giữ `unknown` để kiểm chứng; không loại bìa ra khỏi tiêu chí bảo toàn. |
| Bìa riêng | `update_item`: `promotion_images.image_id_list` đúng một ảnh | Tài liệu chỉ cho bìa promotion khi gallery 3:4. Dịch vụ phải chặn khi ảnh chụp trước không đủ điều kiện. Fixture create 12/09 dùng 1:1 nên chưa đại diện phép thử bìa riêng. |
| Giá gốc | `update_price`: `item_id`, `price_list:[{model_id,original_price}]` | Một item/call; 1–50 model theo schema nguồn. Không tầng dùng model 0. Giá VND nguyên; kiểm `price_limit` live. Giữ SKU, model_id, tier_index và tồn. `current_price`/giá thuế là trường phụ thuộc: cần điều kiện không có chương trình và đối chiếu giá trị dự kiến cụ thể, không xóa cả `price_info` khỏi kiểm tra. |
| Tồn | `update_stock`: `item_id`, `stock_list:[{model_id,seller_stock:[{stock,location_id?}]}]` | Tồn là giá trị tuyệt đối do người dùng/fixture chốt, không phải số cộng thêm hay mục tiêu tự bù. Một vị trí kho rõ ràng cho mỗi model trong pilot; giữ nguyên cấu trúc có/không có location_id. Chặn nhiều kho, tồn Shopee/advance hoặc reserve chưa hiểu. Kiểm `stock_limit` live; không lấy tổng available làm đồng nghĩa seller_stock. |

Giá/tồn có `success_list` và `failure_list`. Bộ gọi kiểm hợp của hai danh sách đúng bằng tập model yêu cầu, không trùng, không thừa, không thiếu, không cùng một ID ở cả hai danh sách. Giá/tồn và location được trả về trong success phải đúng giá trị đã gửi. Partial trả `successIds` và `failureIds` tách biệt; thiếu hoặc mâu thuẫn biên nhận trả `unknown`. Không dùng HTTP 200 làm bằng chứng tất cả model đã cập nhật. Cần readback sau kết quả ghi, kể cả lỗi nghiệp vụ có thể có tác động một phần.

## Ảnh chụp trước và sau

`SandboxFieldClient.read(itemId)` đọc `get_item_base_info` đúng item_id. Nếu `has_model=true`, đọc thêm `get_model_list`; nếu false, lấy giá/tồn ở item và trả tập model/tier rỗng. Không đoán khi `has_model` thiếu. Giữ cấu trúc raw `standardise_tier_variation` nếu API trả về. Dịch vụ cần lưu timestamp và request receipt của các phép đọc, không coi dữ liệu local là trước-ghi remote.

Đích ghi phải liên kết với một nguồn kỹ thuật đã verified từ trial create: item_id chính xác, TEST owner, parent SKU kỹ thuật, ngành 301378, `UNLIST`, tập model/SKU/tier_index đầy đủ. Từ chối tên/SKU trùng, model lạ, nguồn lỗi C055–C058 chưa có item, hoặc đích chỉ khớp tiền tố nhưng không có biên nhận tạo tương ứng.

Ngay trước intent, đọc lại và so với ảnh chụp đã xem. Có drift thì dừng trước ghi. Chỉ chuẩn hóa các tập đã biết có thể đổi thứ tự: model theo model_id, logistics theo logistic_id, thuộc tính theo attribute_id; giữ nguyên thứ tự gallery, block mô tả, tier và option. Không bỏ qua trường lạ hoặc xóa toàn bộ nhóm raw để làm test đạt. Nếu cùng giá trị hiện diện cả ở trường chuẩn hóa và raw, phải sửa expected/so sánh cả hai biểu diễn nhất quán.

Kết quả cần có `selectedMatch`, `unchangedMatch` và danh sách diff theo đường dẫn với before/expected/after. Trường không đọc được là chưa xác minh. `update_time` là metadata thay đổi hợp lý sau mutation; không được bỏ các thay đổi như item_status, category, model_id, SKU, bìa hoặc tiền tệ. Đối với nhóm giá/tồn, quy tắc cho trường phụ thuộc phải ghi riêng trong contract thay vì bỏ kiểm tra rộng.

## Intent, lỗi và phục hồi

- Pin connection ID/revision, shop/partner/environment, item_id, tập model/warehouse, nhóm trường, payload và fingerprint bất biến. Lưu intent trước khi transport chạy.
- Khóa dùng chung theo owner TEST cho các đường create/field để hai worker không ghi đè hoặc chạy bên cạnh một request trễ. Không dùng riêng connection UUID làm danh tính owner; có thể có nhiều kết nối tới cùng shop.
- Sau timeout, lỗi mạng, phản hồi không parse được, server/internal error hoặc crash sau intent: giữ unknown. Không tự chuyển lại `prepared`, không tạo request mới để retry và không tự gửi lại tồn cũ sau khi đơn hàng đã giảm tồn.
- Một request lặp lại cùng ID phải trả biên nhận cũ. Đối chiếu lại chỉ đọc; có dữ liệu mới thì lập quyết định mới có phiên bản thay vì sửa intent cũ. Không rollback tự động bằng ảnh chụp tồn trước.
- Bộ gọi chặn redirect và không có retry. Chỉ giữ mã lỗi/HTTP status/request ID đã kiểm dạng; bỏ message/warning tùy ý có thể chứa dữ liệu nhạy cảm. Mất chẩn đoán cụ thể phải được ghi là giới hạn, không suy nguyên nhân như quota/rate-limit từ `product.error_busi`.

## Nếu thêm ảnh phân loại sau này

API đúng là `update_tier_variation`, không phải `update_model`. Gửi `standardise_tier_variation` đầy đủ hiện tại cùng `model_list:[{model_id,tier_index}]` không đổi. Chỉ đổi image_id của option được chọn; giữ nguyên tên, ID, thứ tự và số option/tier/model. Một option tầng đầu có thể dùng chung cho nhiều SKU ở tầng hai; phải mở rộng và công khai đúng tập SKU bị ảnh hưởng, chặn khi người dùng chỉ chọn một SKU nhưng các SKU cùng option cần ảnh khác nhau.

Log API ngày 12/09/2025 đã chuyển request sang `standardise_tier_variation`; ví dụ cũ trong guide 219 dùng `tier_variation`/`normal_stock` không nên sao chép làm payload mới. `update_model` phục vụ SKU/preorder/status/GTIN/weight/dimension; không có trường ảnh. Thay tầng qua `init_tier_variation` có thể hủy model ID hiện tại và nằm ngoài phép thử cập nhật ảnh.

## Nguồn và ngày

Kho đọc là snapshot 08/09/2026. Các API đã đọc gồm request, response, quyền, mã lỗi và lịch sử cập nhật; ví dụ nhiều ngôn ngữ không được dùng thay schema. Guide/FAQ cũ có khác biệt thời điểm, được đối chiếu với API mới hơn.

| Nguồn chính thức | Ngày cập nhật nguồn lưu |
| --- | --- |
| [update_item](https://open.shopee.com/documents/v2/v2.product.update_item?module=89&type=1) | 24/06/2026 |
| [update_price](https://open.shopee.com/documents/v2/v2.product.update_price?module=89&type=1) | Không trả ngày; thu thập 08/09/2026 |
| [update_stock](https://open.shopee.com/documents/v2/v2.product.update_stock?module=89&type=1) | 31/10/2022; log ngừng `normal_stock` |
| [update_tier_variation](https://open.shopee.com/documents/v2/v2.product.update_tier_variation?module=89&type=1) | 12/09/2025 |
| [update_model](https://open.shopee.com/documents/v2/v2.product.update_model?module=89&type=1) | 08/01/2025 |
| [get_item_base_info](https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1) | 03/04/2026 |
| [get_model_list](https://open.shopee.com/documents/v2/v2.product.get_model_list?module=89&type=1) | 31/07/2026 |
| [Stock & Price Management](https://open.shopee.com/developer-guide/223) | 18/03/2024 |
| [Variant management](https://open.shopee.com/developer-guide/219) | 28/05/2024 |
| [Stock calculation](https://open.shopee.com/faq/59), [Multiple locations](https://open.shopee.com/faq/61) | 16/05/2025 |
| [Standard variation fields](https://open.shopee.com/faq/288) | 16/05/2024 |
| [Thông báo ngừng trường cũ](https://open.shopee.com/announcements/1179) | Đăng 25/06/2025, nêu mốc 30/07/2025 |

Mở trực tiếp các trang update_price, update_stock, update_tier_variation và guide 223 ngày 14/09/2026 đều trả **403**. Chưa xác minh được trang chính thức mới hơn snapshot. Mọi hạn mức/quyền thực thi vẫn cần kiểm bằng metadata và phản hồi của đúng sandbox sau kết nối hợp lệ; không gọi đây là policy production hiện hành.

Bằng chứng lịch sử: [76/80 create thật ngày 12/09](../delivery/2026-09-12-backend-sandbox-trial.md), [hướng dẫn trial](../runbooks/sandbox-backend-trials.md), [Lamy và cover chưa rõ ngày 11/09](../delivery/2026-09-11-operation-workbench.md), [import patch chỉ prepared](../delivery/2026-09-12-import-patch-workflow.md).

## Kiểm chứng phần adapter

`tests/unit/sandbox-field-client.test.ts`: **43/43 đạt**, transport mô phỏng. Có ca pin owner/đích, giữ nguyên payload/chữ/thứ tự, bìa 3:4, default model 0/tồn 0, partial price, biên nhận thiếu/trùng/sai, stock location lệch, server error và mất phản hồi không retry. Đây chưa phải kiểm thử worker/DB hay ghi OpenAPI thật. Bộ gọi không đọc khóa/token của môi trường chạy trong quá trình phát triển và không ghi DB app chính.
