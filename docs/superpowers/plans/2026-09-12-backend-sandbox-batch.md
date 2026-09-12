# Thử đăng mới qua backend sandbox — 12/09/2026

## Phạm vi đã được yêu cầu

Người dùng yêu cầu thử hàng loạt bằng API backend và nhắc lại không ảnh hưởng shop thật. Phép thử dùng nguồn kỹ thuật tự tạo, ghi rõ `SANDBOX QA` / `SBX-BULK-`; không nhân bản Lamy hoặc thay dữ liệu doanh nghiệp. Chỉ partner TEST 1232297, shop sandbox 227418363, host `openplatform.sandbox.test-stable.shopee.sg`. Listing tạo mới giữ `UNLIST`.

Đây là nhánh thử backend có giới hạn, không bật đăng mới cho mọi WorkOrder và không phải nghiệm thu production. Việc thử nhiều sản phẩm không chứng minh nhiều ngành, Mall, QC, 24 giờ hay Flash Sale.

## Thiết kế

HTTP API nhận manifest cố định và bằng chứng preflight, trả 202 sau khi lưu Postgres. Worker nhận việc từ DB, gửi OpenAPI trực tiếp, lưu intent trước từng lần ghi và kết quả sau từng bước. `add_item` thành công phải lưu item ID trước khi chờ ít nhất 5 giây để khởi tạo phân loại. Đọc độc lập xác nhận nguồn sau cùng. Một sản phẩm đang ghi mỗi shop; không tự tăng concurrency.

Mất phản hồi ghi hoặc worker mất lease sau intent chuyển `unknown`; không tự gửi lại. Một `shop + sourceKey` chỉ có một ý định tạo. Kết quả lỗi token hoặc ghi chưa rõ tạm dừng lô, không tiếp tục tạo các sản phẩm sau. Sản phẩm đã tạo không bị xóa để làm sạch phép thử.

Các giới hạn 80 sản phẩm/lô, tối đa 4 model và 2 tầng, nguồn ảnh thử 1:1, mô tả chữ, trạng thái ẩn là giới hạn của pilot này, không phải giới hạn Shopee. Vai trò bìa 1:1/gallery 3:4, ảnh mô tả và nội dung Lamy thuộc kiểm thử khác.

## Công việc và trách nhiệm

1. Gateway riêng: payload chặt, TEST scope, metadata đầy đủ, parser lỗi nghiệp vụ/HTTP/mất phản hồi; không nới gateway cập nhật Lamy.
2. Migration 007, manifest bất biến, claim/lease/checkpoint/events và worker đăng thử riêng; không kích hoạt hàng đợi ghi cũ.
3. API preflight/submit/status, dữ liệu giả lập có nguồn và ảnh thử; pin revision kết nối và kết quả kiểm tra điều kiện ngành/kênh/giới hạn.
4. Kiểm thử 80 nguồn bằng cùng store/worker trong DB cô lập và transport giả có trạng thái. Đo số lần tạo, binding, phục hồi lỗi và hai worker; ghi rõ đây là giả lập.
5. Khi token TEST hợp lệ: metadata đọc thật → 1 sản phẩm → đọc lại → lô nhỏ tiếp theo chỉ khi đạt. Ghi item ID/request ID/thời gian/khác biệt thực tế. Chỉ tăng số lượng theo bằng chứng, không suy diễn số test thành số listing đã đăng.
6. Rà soát độc lập, kiểm kiểu/build/unit/integration, hồi quy phù hợp và báo cáo phạm vi đã/chưa chạy.

## Nguồn đối chiếu

Bản chụp KB 08/09/2026: hướng dẫn 209/211 (cập nhật 19/09/2025), `add_item` (01/09/2026), `init_tier_variation` (12/09/2025), FAQ 288 (16/05/2024), `get_attribute_tree`, `get_item_limit`, `get_channel_list`, `get_item_list`. Native `batch_add_item` có tài liệu nhưng chưa dùng ở pilot do tương quan lỗi một phần/task timeout chưa đủ chắc. Shop metadata và quyền được kiểm tra lại bằng API đọc thực tế trước ghi.

## Bằng chứng đầu lượt

12/09/2026 backend `get_shop_info` trả HTTP 403 / `invalid_acceess_token`, request ID `e3e3e7f35b3ef39338b47d50d6912f00`, connection revision 4; chưa có refresh token. Chưa gửi phép ghi Shopee nào trong lượt thử này. Đã yêu cầu người dùng cập nhật TEST token ở UI, tiếp tục phần code/test độc lập.
