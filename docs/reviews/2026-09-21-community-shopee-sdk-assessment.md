# Đánh giá `@congminh1254/shopee-sdk` cho web app đăng hàng loạt

Ngày đánh giá: 21/09/2026

Repository: https://github.com/congminh1254/shopee-sdk

## Kết luận

SDK dùng được như một thư viện tham khảo và nguồn kiểu dữ liệu/endpoint. Không dùng nguyên SDK làm lớp thực thi production và không thay transport, token service, journal hoặc worker hiện có.

Giá trị đáng áp dụng nhất là:

1. Danh mục manager và schema TypeScript phủ rộng API Shopee.
2. API `product.batch_add_item`, nhận từ 1 đến 100 sản phẩm, trả `task_id`; kết quả được đọc qua `product.get_batch_task_result` với `task_type=4`.
3. Các manager đọc cho Product, Logistics, Shop, Media, Order và các module khác giúp giảm code lặp khi mở rộng chức năng.
4. Cách đóng gói multipart cho ảnh và chuyển đổi timestamp có thể dùng làm tài liệu đối chiếu.

## Khả năng liên quan trực tiếp đến dự án

| Khả năng | SDK có | Có nên dùng |
| --- | --- | --- |
| Ký HMAC request OpenAPI v2 | Có | Có thể đối chiếu bằng contract test; implementation hiện tại đã có và đã chạy production |
| OAuth và exchange code | Có | Chỉ tham khảo; giữ callback/state/DB hiện tại |
| Refresh token | Có, tự refresh khi hết hạn hoặc nhận lỗi auth | Không dùng trực tiếp trong worker nhiều shop |
| Token storage tùy biến | Có interface `store/get/clear` | Có thể viết adapter, nhưng không thay cơ chế mã hóa, revision và receipt hiện tại |
| Product CRUD và phân loại | Có | Có thể dùng schema/method sau khi kiểm contract |
| Upload ảnh/video | Có | Chỉ thử sau khi xác minh multipart và giới hạn ảnh bằng tài liệu Shopee |
| Tạo tối đa 100 item theo batch | Có | Ứng viên tốt nhất cho thử nghiệm có kiểm soát |
| Theo dõi batch task | Có | Cần journal, polling có hạn và readback của ứng dụng bao ngoài |
| Rate limit / 429 backoff | Không thấy trong transport | Không đủ cho production |
| Timeout / hủy request | Không thấy trong transport | Không đủ cho production; có thể làm request treo lâu |
| Durable queue, lease, resume | Không | Giữ worker/PostgreSQL hiện tại |
| Chống gửi trùng mutation | Không | Giữ fingerprint và journal hiện tại |
| Phân biệt rejected/unknown | Không đầy đủ | Giữ outcome model hiện tại |
| Runtime response validation | Không; chủ yếu là TypeScript compile-time | Giữ Zod parsing hiện tại |

## Các phát hiện từ mã nguồn

### Transport chưa phải transport production cho bulk

`ShopeeFetch.fetch` ký request và gọi `fetch`, nhưng không đặt timeout, không có `AbortController`, không có scheduler/token bucket, không xử lý riêng `429` hoặc `error_rate_limit`, và không có exponential backoff. Retry duy nhất thấy trong transport là refresh token rồi gọi lại một lần khi Shopee trả lỗi access token.

Điều này không đáp ứng vấn đề chính của web app: request treo, giới hạn tần suất, kết quả mutation chưa xác định và tránh gửi trùng.

### Refresh token có rủi ro chạy đồng thời

Shopee quy định refresh token mới phải dùng cho lần refresh kế tiếp; token cần lưu riêng theo từng shop/merchant. SDK gọi `get()`, refresh, rồi `store()` mà không có transaction, distributed lock, revision/CAS hoặc receipt phục hồi. Hai worker cùng thấy token hết hạn có thể cùng dùng một refresh token; một lần thành công và lần còn lại làm trạng thái trở nên khó xác định.

Backend hiện tại an toàn hơn vì khóa theo owner/shop, khóa hàng DB, connection revision, receipt mã hóa, recovery không gửi lại refresh token, và xác minh shop sau khi đổi token.

### Tài liệu và implementation token mặc định chưa nhất quán

Tài liệu token storage mô tả mặc định lưu file JSON theo shop. Constructor trong `src/sdk.ts` hiện tạo `InMemoryTokenStorage` khi người dùng không truyền storage. Vì vậy không dựa vào mô tả “automatic token storage” nếu chưa tự cấp storage production.

### TypeScript không phải validation runtime

Manager được sinh tự động và cung cấp type tốt, nhưng response JSON được cast thành kiểu `T`. Nếu Shopee đổi envelope hoặc trả dữ liệu thiếu/sai kiểu, SDK không chặn ở runtime. Web app hiện kiểm `request_id`, kích thước response, scope shop, mã lỗi và cấu trúc bằng Zod; phải giữ các bước này.

### `batch_add_item` đáng thử nhất

Kho tài liệu Shopee chụp ngày 08/09/2026 xác nhận endpoint chính thức:

- `POST /api/v2/product/batch_add_item`
- `item_list` từ 1 đến 100
- có `item_status=UNLIST`
- hỗ trợ ảnh, ngành, thuộc tính, thương hiệu, vận chuyển, mô tả mở rộng, phân loại/model, SKU, giá và tồn trong item
- response trả `task_id`
- `GET /api/v2/product/get_batch_task_result`, `task_type=4`, trả trạng thái, danh sách thành công và thất bại

API này phù hợp mục tiêu tạo hàng loạt link ẩn. Tuy nhiên quyền API phải được kiểm trên chính partner/app/shop. Task được tiếp nhận chưa đồng nghĩa từng listing đã tạo thành công; ứng dụng phải poll tới trạng thái kết thúc, lưu từng lỗi và readback từng item/model.

## Phương án áp dụng

### Giai đoạn 1: không ghi Shopee

1. Ghim chính xác một phiên bản SDK, không lấy `main` tự động.
2. Tạo adapter thử nghiệm chỉ cho API đọc.
3. Contract-test chữ ký, query serialization và response của các API đang dùng với transport hiện tại.
4. So schema SDK với kho kiến thức Shopee và response thật đã lưu.

### Giai đoạn 2: thử `batch_add_item` có giới hạn

1. Kiểm permission/capability của app và shop bằng request chỉ đọc hoặc một lô thử được người vận hành cho phép.
2. Upload ảnh qua pipeline hiện có và lưu image ID trước.
3. Tạo payload tối đa 2–5 listing UNLIST trong lần đầu.
4. Ghi intent và fingerprint trước khi POST.
5. Không tự replay khi timeout hoặc mất response.
6. Lưu `request_id`, `task_id`, poll có rate limit và thời hạn.
7. Ghi kết quả riêng cho từng listing, rồi đọc lại item, model, ảnh, SKU, giá, tồn và trạng thái UNLIST.
8. Chỉ tăng kích thước lô sau khi có số liệu latency/rate-limit và recovery.

### Giai đoạn 3: mở rộng nhiều shop

Mỗi job phải khóa theo `partner_id + shop_id`; token refresh vẫn do service hiện tại quản lý. SDK client nếu được dùng phải nhận access token snapshot đã khóa theo revision, không được tự refresh. Rate limiter cần theo app/shop/API group và thích ứng với phản hồi Shopee. Queue, journal, unknown reconciliation và QC readback tiếp tục thuộc backend hiện tại.

## Quyết định kiến trúc

- Không cài SDK vào đường production hiện tại ngay.
- Có thể dùng schema/manager làm nguồn tham khảo hoặc sinh adapter.
- Ưu tiên proof-of-concept `batch_add_item` vì có lợi ích thực tế lớn nhất.
- Không dùng auto-refresh, default storage hoặc transport fetch của SDK trong worker production.
- Không bỏ các lớp bảo vệ hiện có để đổi lấy ít code hơn.

## Nguồn

- Repository và README: https://github.com/congminh1254/shopee-sdk
- Core SDK: https://github.com/congminh1254/shopee-sdk/blob/main/src/sdk.ts
- HTTP transport: https://github.com/congminh1254/shopee-sdk/blob/main/src/fetch.ts
- Product manager: https://github.com/congminh1254/shopee-sdk/blob/main/src/managers/product.manager.ts
- Token storage guide: https://github.com/congminh1254/shopee-sdk/blob/main/docs/guides/token-storage.md
- Shopee `batch_add_item`: https://open.shopee.com/documents/v2/v2.product.batch_add_item?module=89&type=1
- Shopee `get_batch_task_result`: https://open.shopee.com/documents/v2/v2.product.get_batch_task_result?module=89&type=1
- Shopee authorization guide: local snapshot `knowledge-base/shopee-open-platform/documents/guide/en/20.md`, retrieved 08/09/2026
