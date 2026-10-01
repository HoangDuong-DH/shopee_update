# Khởi tạo listing ẩn đầu tiên và kiểm quyền ảnh

Bản nâng cấp trong worktree, 23/09/2026. Chưa triển khai vào runtime đang vận hành và chưa nghiệm thu trên shop thật mới.

## Luồng đang được thực hiện bằng code

1. Đọc manifest đã chốt, kiểm SHA, scope partner/shop và đúng nguồn/phần giá/ảnh. Quyền gửi vẫn đến từ batch đã được người dùng lựa chọn; một lần kiểm quyền không tạo sản phẩm mẫu riêng.
2. Tìm operation đã `verified` cùng owner và connection thuộc đúng shop. Ưu tiên hồ sơ đã dùng ảnh mô tả nếu sản phẩm hiện tại cần ảnh mô tả, thay vì lấy operation mới nhất bất kể tính năng. SQL chỉ chọn ứng viên; runner vẫn kiểm journal, fingerprint, bước ghi và hai lần đọc lại.
3. Nếu quyền còn `unknown`, chỉ luồng đăng ẩn có thể sinh permission cho chính listing dự định đăng. Permission băm scope, batch ID, manifest SHA, chỉ dẫn người dùng, source identity/revision và nguyên document. Collector tính lại permission; runner chỉ nhận đúng source và permission được server cấp. Thay nguồn, shop hoặc nội dung làm permission cũ không còn dùng được.
4. Chỉ những tính năng thật sự cần và đang unknown được thử qua lần tạo UNLIST đó. Trạng thái nguồn đã lưu vẫn unknown; cờ cho phép lập payload chỉ tạm thời. Không đổi unknown thành supported chỉ vì upload hoặc create nhận ACK.
5. Khi hoãn QC ảnh được người dùng chọn, từng listing định đăng có permission riêng. Listing đã có hai lần đọc phần cốt lõi đạt có thể chờ QC ảnh để mục khác tiếp tục. Timeout/mất phản hồi ghi vẫn đi đường journal/đối chiếu cũ, không tạo lại tự động. Một lỗi quyền hoặc kết quả chưa xác định không được hiểu thành quyền hỗ trợ.
6. Khi có đầy đủ verification, operation đó mới được dùng làm bằng chứng tính năng cho lần sau. Nguồn đã dùng fallback văn bản không chứng minh ảnh mô tả được hỗ trợ.

Nếu chuyển một batch cũ sang đăng ẩn bằng execution policy, collector đọc lại receipt và kiểm source/document binding của policy trước khi chấp nhận permission; không sửa manifest hoặc journal lịch sử.

## Tên shop và kho hàng

Collector dùng bản ghi kết nối đúng partner/shop và tên Shopee gốc `connections.name`, được lưu từ API khi kết nối và kiểm tra sức khỏe. `display_name` là nhãn riêng của nhân viên, không dùng đối chiếu danh tính. Nếu phản hồi có shop_id, nó cũng phải đúng scope. Tên cũ của shop pilot không còn là mặc định của trusted batch. Đổi tên shop trên Shopee có thể cần đồng bộ lại tên kết nối trước khi tiếp tục.

Không tự tạo stock location. Hai lỗi kho có metadata rõ:

| Code | Field | Hành động |
| --- | --- | --- |
| `PRODUCTION_PILOT_STOCK_LOCATION_REFERENCE_MISSING` | `stockLocation.referenceItemId` | Bổ sung tham chiếu kho hợp lệ của đúng shop và đọc lại |
| `PRODUCTION_PILOT_WAREHOUSE_MAPPING_REVIEW_REQUIRED` | `stockLocation` | Kiểm cấu trúc kho thật và ánh xạ trước khi ghi |

Error và kết quả listing trong batch kèm `scope: { environment, partnerId, shopId }`. Không chứa token. API/UI phía trên cần giữ hoặc ánh xạ metadata này; chỉ có mã lỗi không chứng minh màn hình đã hiển thị đúng ô sửa. Shop mới hoàn toàn chưa có nguồn chứng minh kho vẫn bị chặn, không dùng kho của shop khác để vượt qua.

## Giới hạn quét danh mục

- Trusted batch: tối đa 1.000 item duy nhất trong bốn trạng thái đang xét; pilot lịch sử vẫn tối đa 200.
- Mỗi trạng thái tối đa 10 trang, 100 item/trang. Phải thấy trang cuối thật; tổng số ổn định và số ID duy nhất đọc được khớp total_count. Trang lặp, cursor bỏ qua item, tổng thay đổi, phản hồi base/model thiếu đều chặn.
- Đây là giới hạn bảo vệ của ứng dụng, không phải hạn mức tổng sản phẩm của Shopee. Chưa có quét nền resumable cho kho lớn hơn hoặc cache inventory dùng chung lâu dài.
- Nhịp GET chung hiện ít nhất 500ms giữa các lần bắt đầu và backoff giới hạn khi Shopee trả rate limit rõ. Một nghìn item cần thêm khoảng 50 lần base info và 1.000 lần model info; riêng pacing tối thiểu đã gần chín phút, chưa tính latency/retry. Bằng chứng metadata vẫn có cửa sổ 15 phút từ receipt cũ nhất; quét quá chậm sẽ bị chặn do hết hạn, không nới thời hạn để vượt kiểm.
- Không thay codec: gallery vẫn 3:4 và bìa promotion riêng. Hỗ trợ 1:1 cần thiết kế riêng payload, thứ tự bìa/gallery và readback; không tự cắt ảnh hay bỏ kiểm quyền 3:4 trong bản sửa này.

## Kiểm chứng và giới hạn

- 104 unit liên quan collector/batch runner/capability/inventory đạt. Có fixture shop khác với tên thật và alias riêng; manifest permission giả bị chặn trước GET; inventory 201/1.000 đạt, 1.001 vượt giới hạn bị chặn; trang lặp/bỏ cursor/đổi tổng bị chặn.
- File integration runner gồm 87 ca đã chạy: 86 đạt ngay, một fixture mới truyền dư trường vào allowlist bị schema chặn; sửa fixture rồi chạy lại ba ca trọng tâm đạt. Không cộng lượt chạy lại thành số test mới. Ca mới dùng PostgreSQL cách ly và OpenAPI giả lập chứng minh hai intended probe hoãn QC không trở thành proof, và selector chọn đúng feature/đúng shop. Các ca cũ kiểm lost-response không resend cũng đạt trong lượt đầy đủ đó.
- Kiểm kiểu toàn worktree và diff whitespace đạt. Không restart, merge, deploy, gọi API Shopee thật hoặc sửa nguồn sản phẩm trong lượt này.

## Cơ sở tài liệu

Đối chiếu kho chính thức chụp 08/09/2026; không coi snapshot là xác nhận quyền hiện tại của shop. Quyền thật vẫn phải qua API và readback:

- [Product creation preparation](https://open.shopee.com/developer-guide/209), cập nhật 19/09/2025: metadata theo shop, leaf category, thuộc tính bắt buộc.
- [Creating product](https://open.shopee.com/developer-guide/211), cập nhật 19/09/2025: upload trước create, extended description có whitelist, stock location, tạo variation sau item.
- [Upload image](https://open.shopee.com/documents/v2/v2.media_space.upload_image?module=91&type=1), cập nhật 08/09/2025: tối đa 10MB/ảnh, JPEG/PNG, scene desc/normal, ratio 1:1/3:4 theo quyền.
- [Add item](https://open.shopee.com/documents/v2/v2.product.add_item?module=89&type=1), cập nhật 01/09/2026: ảnh 1:1 mặc định, 3:4/extended theo whitelist, promotion image chỉ dùng cùng 3:4.
- [Get item list](https://open.shopee.com/documents/v2/v2.product.get_item_list?module=89&type=1), cập nhật 18/10/2024: page_size tối đa 100, cursor và has_next_page; không có giới hạn tổng 200 trong API này.
- [Extended description FAQ](https://open.shopee.com/faq/51): chỉ text/image, lấy giới hạn qua get_item_limit, không HTML. Mã FAQ218 cũ trong guide không có file tương ứng của snapshot; dùng mục51 đã thu thập, không suy nội dung file thiếu.
