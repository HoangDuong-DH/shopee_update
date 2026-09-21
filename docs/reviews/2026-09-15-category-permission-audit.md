# Ngành hàng, quyền shop và gợi ý API — 15/09/2026

Phạm vi: đọc mã, kho Shopee và chuẩn bị phép đọc bốn bộ PASS 1 cho partner **2010476**, shop **1423724897**. Không đăng ký ngành/thương hiệu, không đổi ngành listing cũ, không gửi sản phẩm hoặc ảnh lên Shopee trong audit này. Hai listing đã nghiệm thu `51467852283` và `51267858328` giữ nguyên.

## Kết luận

Gợi ý ngành, ngành có trong cây trả về và giấy phép đăng bán là ba loại bằng chứng khác nhau. API gợi ý không thay thế xác nhận quyền ngành. Listing cũ cùng shop chỉ là nguồn quan sát có ngày và phạm vi; không chứng minh ngành luôn mở cho mọi sản phẩm mới hoặc mọi chứng từ đã được duyệt.

Không tìm thấy nhánh tự đổi sang ngành khác khi thất bại trong collector/runner được kiểm. Không được thêm hành vi chọn ngành ít điều kiện hơn, chọn `No Brand`, bỏ chứng từ hoặc đăng ký thay người dùng để vượt chặn. Nguồn không phù hợp với ngành, API thiếu dữ liệu, hoặc Seller Center hiện “Không hỗ trợ” phải giữ thành ngoại lệ có bằng chứng.

## Tài liệu đối chiếu

| Nguồn | Ngày nguồn | Ý nghĩa chính |
| --- | --- | --- |
| [get_category](../../knowledge-base/shopee-open-platform/documents/api/en/v2.product.get_category.md) · [trang Shopee](https://open.shopee.com/documents/v2/v2.product.get_category?module=89&type=1) | 29/10/2021 | Cây ngành có ID, cha, tên và `has_children`; không có trường trạng thái giấy phép hoặc chứng từ. |
| [Hướng dẫn 209](../../knowledge-base/shopee-open-platform/documents/guide/en/209.md) · [trang Shopee](https://open.shopee.com/developer-guide/209) | 19/09/2025 | Mô tả cây ngành khả dụng theo shop/thị trường; chọn ngành lá rồi lấy thuộc tính, thương hiệu và giới hạn. Cụm “available” không bổ sung trạng thái xét duyệt riêng mà API không trả. |
| [category_recommend](../../knowledge-base/shopee-open-platform/documents/api/en/v2.product.category_recommend.md) · [trang Shopee](https://open.shopee.com/documents/v2/v2.product.category_recommend?module=89&type=1) | 04/07/2022 | **GET Shop API**, bắt buộc `item_name`, tùy chọn `product_cover_image` là ID từ upload_image. Trả `category_id: int[]`. Có loại app Seller In House System trong danh sách quyền tài liệu; quyền thực tế phải đọc bằng app/shop hiện tại. |
| [Quản lý Giấy phép](../../knowledge-base/shopee-uni-vn/documents/article/27816.md) · [trang Shopee](https://banhang.shopee.vn/edu/article/27816) | 13/08/2026 | Tính năng bắt đầu 13/08/2026, tách giấy phép ngành và chứng từ sản phẩm. Ngành chưa đăng ký có thể hiện “Không hỗ trợ” ở bước tạo listing. Cách giữ sản phẩm hàng loạt thành nháp được mô tả cho Seller Center, chưa phải hợp đồng OpenAPI. |
| [Chứng từ đăng bán](../../knowledge-base/shopee-uni-vn/documents/article/3483.md) · [trang Shopee](https://banhang.shopee.vn/edu/article/3483) | 31/07/2026 | Ngành có điều kiện cần xét duyệt phù hợp; sản phẩm kiểm soát có thể cần chứng từ riêng. Không suy phân loại pháp lý chỉ từ chữ “tinh dầu”. |
| [get_product_certification_rule](../../knowledge-base/shopee-open-platform/documents/api/en/v2.product.get_product_certification_rule.md) | 23/04/2025 | Là **POST truy vấn** theo `category_id`/`attribute_list`, trả danh sách permit và mandatory. Chưa được gọi trong audit này. Tài liệu có mô tả `certification_rule_list` bị lẫn nội dung extended-description; không dùng đoạn đó để suy quyền. |
| [add_item](../../knowledge-base/shopee-open-platform/documents/api/en/v2.product.add_item.md) | 01/09/2026 | Có `error_category_is_block` và `error_forbidden_category`. `certification_info` mô tả đầu vào cho PH, chi tiết expiry nhắc PH/TW; chưa chứng minh tích hợp Quản lý Giấy phép VN. |

Kho là bản chụp 08/09/2026. Đã thử xác minh trực tiếp ngày 15/09: bài Seller 27816 chỉ trả HTML khung qua công cụ đọc web; trang API category_recommend trả 403. Vì vậy chưa xác minh độc lập có thay đổi nội dung sau bản chụp; không ghi đây là đã tải lại chính sách hiện hành. Kết quả API thực tế do lượt chạy riêng của root lưu sẽ chứng minh khả năng gọi tại thời điểm đó, không chứng minh mọi giấy phép.

## Seller Center và OpenAPI không có đầu vào giống nhau

Seller Center có thể hiển thị gợi ý sau khi người dùng điền ảnh, nội dung và phân loại. Hợp đồng category_recommend đã đọc chỉ có **tên** và tùy chọn **một ID ảnh bìa**; không có tham số mô tả, gallery hoặc ảnh phân loại. Không tuyên bố backend tái hiện toàn bộ cơ chế gợi ý của giao diện.

Gợi ý chỉ là ứng viên. Khi chọn ngành đúng với nguồn và điều kiện shop đã có bằng chứng, phải đọc lại thuộc tính của ngành đó: kiểu chọn đơn/đa, trường custom, đơn vị, giới hạn số giá trị và quan hệ cha/con. API gợi ý thuộc tính cũng không bảo đảm trả đủ thuộc tính bắt buộc. Không tự điền dữ kiện sản phẩm không có trong nguồn chỉ để tăng bộ đếm hoàn thiện.

## Gate trong mã và phạm vi đã kiểm

- `apps/api/src/production-pilot-source.ts`: collector lấy cây ngành cho đúng kết nối; bản sửa của agent sở hữu file dùng **đúng một** kết quả categoryId và yêu cầu `has_children === false`. Trước đó `.find` có thể chấp nhận bản ghi trùng ID. Hồi quy trong `production-batch-source.test.ts` kiểm ngành thiếu, trùng, không phải lá và không đăng ký/chọn ngành khác.
- `packages/shopee/src/prepared-metadata.ts`: kiểm envelope, metadata giới hạn/brand/attribute và mảng thuộc tính đúng một categoryId. Đây là đánh giá tương thích dữ liệu, không cấp quyền ghi; input hiện không có bằng chứng giấy phép VN.
- `apps/api/src/production-pilot-runner.ts`: giữ categoryId của tài liệu nguồn, đúng environment/partner/shop/connection revision, hạn metadata và hash nguồn. Không tự thay categoryId. Scope/hạn/hash không thay thế kiểm giấy phép ngành.
- `packages/shopee/src/prepared-wire.ts`: mã hóa categoryId nguồn sang payload; không phải nơi suy chọn ngành hoặc tự tra quyền. Không gọi `compatible` của codec là toàn bộ chính sách ngành đã được kiểm.
- `packages/shopee/src/production-pilot-transport.ts`: lỗi ngành bị hạn chế vẫn trả rejected và giữ envelope đã che bí mật. Các mã chưa trong danh sách an toàn có thể được rút gọn thành `PRODUCTION_PILOT_API_REJECTED`; không có retry qua ngành khác. Tên mã đẹp hơn không phải cơ chế cấp phép.

**Còn thiếu:** bằng chứng giấy phép/chứng từ VN có nguồn, ngày, shop và ngành cụ thể trong contract preflight; đồng bộ trạng thái bị từ chối quan sát trên Seller Center; nghiệm thu sản phẩm thật trong ngành có điều kiện. Chưa có cơ sở để tạo một cờ `authorized: true` chung hoặc coi danh sách rỗng của API chứng nhận thị trường khác là “không cần giấy phép”.

## Phép đọc bốn nguồn PASS 1

Đã thêm `scripts/inspect-pass1-category-recommendations.mts` và riêng GET allowlist `product/category_recommend`. Script yêu cầu SHA-256 của `source-audit/source-receipt.json`, pin đúng bốn sourceKey/CanvaID/file MD và kiểm lại hash từng MD trước khi giải mã kết nối hoặc gọi mạng.

Luồng gồm đúng sáu GET khi kết nối và cây hợp lệ: đọc shop, toàn cây ngành, bốn gợi ý theo nguyên văn tiêu đề trong biên nhận. Trước mỗi GET kiểm lại revision/expiry kết nối. Không tạo mutation permit, không tải ảnh, không đăng ký và không tạo WorkOrder. Kết quả không chọn ngành; `categoryAuthorizationVerified` và `productDocumentApprovalVerified` luôn false trong loại báo cáo này.

Raw envelope đã che khóa/token được lưu riêng tại `.local/production-batch-pass1-20260915/category-recommendations/<uuid>/`. Bản console chỉ trả scope, tên shop, trạng thái, mã lỗi an toàn, request ID và đường dẫn ngành. Ngành gợi ý không có trong cây được ghi riêng, không thay bằng ngành khác; cây trùng ID bị chặn.

**Kiểm mã:** bước đỏ xác nhận endpoint chưa được allowlist; bước xanh lúc 16:11 ngày 15/09 đạt **112/112** (101 transport + 11 inspection), typecheck toàn dự án đạt. Toàn bộ phép kiểm này dùng fixture, không gọi Shopee. Việc chạy đọc thật do root thực hiện riêng; không tính 112 test này thành nghiệm thu đăng bốn sản phẩm.

## Ngoại lệ bảng kích cỡ: ngành 100265, nguồn row194

Phản hồi production `get_item_limit(category_id=100265)` do root lưu lúc **2026-09-15T09:28:10.815Z**, connection revision 2, request **e3e3e7f35b822b5d84e2fc9aa1c52600**, trả cả ba cờ `size_chart_mandatory`, `support_image_size_chart`, `support_template_size_chart` bằng **true**. Bằng chứng nằm trong `.local/production-batch-pass1-20260915/metadata/fbca457a-5bf7-4cec-b337-cabcfdf87eb3/limits-100265-0.json`. Nguồn xịt khử mùi giày row194 không có bảng kích cỡ được chuẩn bị hoặc xác nhận. Planner chặn thiếu dữ liệu là đúng với phản hồi này; chưa có căn cứ tắt cờ hoặc tự chuyển ngành.

- [Hướng dẫn Seller 14834](../../knowledge-base/shopee-uni-vn/documents/article/14834.md), ngày nguồn **09/12/2025**, giải thích bảng thuộc nhóm ngành và mẫu chỉ tái dùng cùng ngành. Từ **03/12/2025**, bảng cho ngành Giày dép cần thông số Chiều dài bàn chân; nhóm thời trang khác cần ít nhất hai thông số. Bài không có ngoại lệ rõ cho dung dịch khử mùi giày nằm trong nhánh này.
- [Hướng dẫn Shopee Mall 3528](../../knowledge-base/shopee-uni-vn/documents/article/3528.md), ngày nguồn **24/07/2025**, dẫn danh sách ngành cần bảng từ 21/05/2025. Danh sách PDF là tên ngành, không phải ánh xạ quyền shop hoặc danh sách miễn trừ theo công dụng sản phẩm. Không dùng tài liệu tĩnh này để ghi đè metadata thật.
- [get_size_chart_list](../../knowledge-base/shopee-open-platform/documents/api/en/v2.product.get_size_chart_list.md), ngày nguồn **01/07/2026**, là **GET Shop API**, local shop: `category_id` và `page_size` bắt buộc (tối đa 50), phân trang theo `next_cursor` thực. Trả ID của các bảng kích cỡ đã có trong shop/ngành; **không phải** API xác định thông số bắt buộc, không chứng minh được miễn bảng nếu danh sách rỗng. Bảng tài liệu ghi ID/count dạng chuỗi nhưng ví dụ dùng số; bộ đọc cần kiểm số an toàn hoặc chuỗi số, không đoán cursor.
- [get_size_chart_detail](../../knowledge-base/shopee-open-platform/documents/api/en/v2.product.get_size_chart_detail.md), ngày nguồn **26/05/2023**, là **GET Shop API**, local shop: nhận `size_chart_id` có thật, trả tên bảng, cột số đo, kiểu nhập, đơn vị và giá trị. Cả hai API liệt kê Seller In House System trong quyền tài liệu; chưa gọi thật hai API trong audit này.
- `add_item` có `size_chart_info.size_chart` (ảnh) hoặc `size_chart_info.size_chart_id` (bảng); bảng được ưu tiên nếu gửi cả hai. Khả năng nhận trường không cung cấp nội dung nguồn để điền. Không tải ảnh chai hoặc tự tạo bảng số đo để đạt điều kiện.

Hướng đối chiếu chỉ đọc: lấy list cho đúng shop/ngành, lấy detail từng ID trả về, kiểm mục Bảng quy đổi kích cỡ trên Seller Center cùng ngành mà không lưu. Nếu shop chỉ có bảng đo chân hoặc không có bảng phù hợp, giữ nguồn này ở trạng thái cần làm rõ; đối chiếu hỗ trợ Shopee bằng category ID, tên sản phẩm và request ID trên. Không có kết quả GET nào trong hai API tự cho phép chọn ngành khác hoặc bỏ điều kiện. Chỉ tiếp tục khi có xác nhận phù hợp và nguồn bảng thực, hoặc metadata/phản hồi chính thức mới giải quyết được mâu thuẫn.

Đã thử đọc lại trang chính thức Seller 14834 ngày 15/09 nhưng công cụ web chỉ nhận HTML khung; trang OpenAPI detail không tải được qua công cụ. Vì vậy ngày quy định ở trên lấy từ bản chụp 08/09; ba cờ bắt buộc lấy từ phản hồi API thật riêng, không tuyên bố nội dung website vừa được xác minh đầy đủ.

### Phép đọc thực tế tiếp theo, 17:08 ngày 15/09

Theo phạm vi chỉ đọc được giao, `scripts/inspect-pass1-size-charts.mts` đã dùng kết nối production mã hóa revision 2 để đọc đúng shop, giới hạn ngành và danh sách bảng. Shop trả tên **Vuatinhdau - Đại Lý Chính Hãng**. `get_item_limit` vẫn trả ba cờ size-chart bằng true. `get_size_chart_list(category_id=100265,page_size=50)` trả thành công **`total_count: 0`, `next_cursor: ""`**, không có khóa `size_chart_list`. Không có ID bảng nào để gọi `get_size_chart_detail`; vì vậy API detail mới được kiểm bằng fixture, chưa gọi thật. Không tìm thấy bảng có sẵn để dùng cho nguồn row194.

| Phép đọc | Thời điểm UTC | Request ID |
| --- | --- | --- |
| Shop | 2026-09-15T10:08:02.248Z | `e3e3e7f35b82b9d8e67a48d2ba4b2f00` |
| Giới hạn 100265 | 2026-09-15T10:08:02.505Z | `e3e3e7f35b82b9db398cc1b8c1312700` |
| Danh sách bảng 100265 | 2026-09-15T10:08:02.644Z | `e3e3e7f35b82b9df49ad4605f0c44100:020000c5aaf3f5e3:010002a9b840f47d` |

Bằng chứng riêng: `.local/production-batch-pass1-20260915/size-chart/3878c5e0-8157-49be-b571-56a1715e1b89/`. Lần phân tích đầu ghi `failure.json` vì parser yêu cầu mảng theo tài liệu. Sau khi thêm hồi quy đỏ rồi xanh cho hình dạng đã quan sát, bộ đọc chỉ chấp nhận thiếu mảng khi **tổng tường minh bằng 0 và cursor kết thúc rỗng**; null, thiếu tổng/cursor hoặc tổng dương vẫn chặn. `summary.json` được phân tích lại từ đúng ba raw receipt trên, không gọi mạng lại và không sửa lịch sử failure. Lần thử đầu ở sandbox mạng của công cụ không nhận được phản hồi shop (`PRODUCTION_PILOT_TRANSPORT`); lượt được phép truy cập mạng sau đó là ba GET thành công trên, không có phép ghi Shopee.

Hai GET list/detail được thêm vào allowlist cố định; không mở API tạo/sửa/xóa bảng hoặc tham số đổi shop. Script chặn ID sai/trùng, cursor lặp, tổng thay đổi, detail sai ID; chỉ đọc ID trả về thật và không chọn bảng. Kiểm mã lúc **17:09:29** đạt **117/117** (101 transport + 16 chẩn đoán). Đây không phải nghiệm thu đăng row194 hay miễn yêu cầu size chart.
