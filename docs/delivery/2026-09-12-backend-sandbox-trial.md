# Kết quả thử backend sandbox — 12/09/2026

**Kết luận: đã triển khai và kiểm thử nhánh đăng mới giả lập qua backend/worker. Chưa đăng mới listing thật trong lượt này vì token TEST bị Shopee từ chối. Production chưa nghiệm thu.**

## Phép gọi thật

- Đọc `get_shop_info` từ backend bằng kết nối mã hóa, đúng partner 1232297/shop 227418363/host sandbox: HTTP 403, `invalid_acceess_token`, request ID `e3e3e7f35b3ef39338b47d50d6912f00`.
- 08:35:51 ICT: gọi HTTP của ứng dụng `POST /v1/sandbox-create-trials/inspect` cho một nguồn thử. API trả HTTP 409 / `SANDBOX_AUTH_REQUIRED`, 340ms. Đây là thời gian từ chối xác thực, không phải thời gian đăng listing.
- Connection vẫn revision 4, chưa có refresh token. Người dùng đã được yêu cầu cập nhật token ở UI; không lấy khóa/token vào chat hoặc báo cáo.
- Kiểm DB lúc 08:41 ICT: **0 trial, 0 item create trong dữ liệu chạy thật**. Không tải ảnh mới lên Shopee, không gọi add_item/init_tier_variation, không đăng ký Mall/brand, không thay đổi shop thật trong lượt này.
- Lamy cũ 803934364 và nguồn revision 1 giữ nguyên. Run 627e471b-2054-4af8-afc0-5a0a1cc63562 vẫn revision 25, `unknown / COVER_READBACK_REVIEW`; không gửi lại hoặc nhân bản.

Bằng chứng riêng: `.local/sandbox-bulk-20260912/inspect.json`, `final-state.json`; không đưa dữ liệu vận hành vào Git.

## Phần đã triển khai

Gateway riêng chỉ nhận nguồn kỹ thuật có tên `SANDBOX QA`, SKU `SBX-BULK-`, ngành sổ tay 301378 và UNLIST trong đúng sandbox. Có kiểm metadata ngành/thuộc tính/thương hiệu/giá/tồn/vận chuyển trước ghi; thiếu thông tin hoặc quy tắc chưa hỗ trợ thì chặn. Quét shop phải đủ trang và khớp tổng item; không tự lấy ví dụ tài liệu làm quyền hay giới hạn shop.

API prepare lưu bản nguồn thử và ba ảnh PNG kỹ thuật có SHA/checkpoint, trả preview bất biến. Submit trả 202 sau lưu hàng đợi Postgres. Worker lưu intent trước từng mutation, pin revision kết nối và payload, lưu item ID ngay sau create, chờ tối thiểu 5 giây trước khởi tạo phân loại, rồi đọc lại độc lập. Hai worker bị điều phối thành một yêu cầu đang chạy trong luồng thử. Mất phản hồi ghi giữ unknown và khóa việc ghi tiếp; không tự tạo lại.

Migrations 007–008 đã áp dụng local. Backend/UI khởi động lại; kiểm cuối API ready, worker online, UI HTTP 200, productionWrites=false. Worker này tách riêng khỏi WorkOrder doanh nghiệp và generic jobs cũ; chưa bật đăng mới đại trà từ giao diện vận hành.

## Kiểm thử mô phỏng

Một ca lớn chạy cùng gateway, coordinator, schema PostgreSQL và worker sẽ dùng thật; chỉ thay transport Shopee bằng mô phỏng có trạng thái và dùng đồng hồ điều khiển cho thời gian chờ:

| Chỉ số | Kết quả mô phỏng |
|---|---:|
| Listing kỹ thuật | 80 |
| Không tầng / một tầng / hai tầng | 27 / 27 / 26 |
| Lần gọi add_item | 80 |
| Lần gọi init_tier_variation | 53 |
| Model thuộc 53 listing có tầng | 158 |
| Lần đọc base / model | 80 / 53 |
| Item ID khác nhau, đọc lại đạt | 80 |
| Lời gọi đồng thời tối đa khi hai worker tranh việc | 1 |

Các ca còn lại kiểm submit trùng, nguồn trùng, scope production, restart sau create, trễ phân loại, mất phản hồi create/init, lease hết hạn, phản hồi đến muộn, nguồn/kết nối đổi tại ranh giới ghi, HTTP 200 kèm lỗi nghiệp vụ, lỗi token, metadata hết hạn và readback sai. Kiểm tra số lần gọi thật trong máy chủ giả và checkpoint, không chỉ đếm trạng thái job.

**Không được gọi bảng trên là 80 sản phẩm đã đăng trên Shopee.** Không dùng thời gian mô phỏng để suy ra số link/24h. Phép thử không đi qua nhập thư mục/Word/KINI đầu cuối và không nghiệm thu nhiều ngành/Mall.

## Kiểm chứng mã và giao diện

- Typecheck và build đạt; **308/308 unit/integration**, **7/7 legacy** đạt. Báo cáo `.local/verification.json` và `.local/test-results.json`, 08:38 ICT.
- Sau đó sửa riêng một phép chờ trong test để xác nhận DB đã lưu unknown trước khi mô phỏng phản hồi đến muộn; **12/12** ca coordinator chạy lại đạt. Không thay runtime/migration sau lần kiểm toàn bộ.
- HTTP mới: **9/9** ca kiểm chuẩn bị/submit đồng thời, checkpoint ba ảnh, gate một item trước lô, kết nối đổi, upload mất phản hồi và trang item bị cắt cụt; không gọi Shopee thật.
- Browser regression: **42/43 đạt ở lượt đầu**; tìm KB quá giới hạn 5 giây khi chạy đồng thời test backend. Chạy riêng lại ca đó đạt (3,1 giây phần test). Không sửa hoặc tăng timeout để che lỗi; chưa kết luận tìm KB lạnh đạt mục tiêu thời gian. Báo cáo lượt đầy đủ được giữ ở `.local/sandbox-bulk-20260912/e2e-full.json`.
- Review độc lập phát hiện và đã sửa hợp đồng tiêu đề lệch, giả định GTIN đọc lại được ở VN và quét item thiếu kiểm tổng. QC không được nới để ép đạt. Build còn cảnh báo kích thước bundle như trước.

## Phần tiếp tục khi có token

Đọc metadata bằng token TEST mới → chuẩn bị một nguồn `SBX-BULK-` riêng → xem manifest → submit backend → chờ đọc lại đạt → mới thử lô nhiều nguồn. Giữ UNLIST, không dùng Lamy để thử tạo. Nếu ngành/kênh khác dự kiến hoặc readback thiếu, ghi ngoại lệ và dừng; không tự thay nguồn hoặc nối vào shop thật.

Chưa có tự refresh token, tự xử lý unknown qua UI, worker 24 giờ được nghiệm thu, ảnh mô tả/gallery 3:4 trong nhánh create này, đăng nguồn doanh nghiệp nhiều ngành, khuyến mại/Flash Sale, QC chính thức hoặc nghiệm thu production. Media preparation vẫn chạy trong HTTP; chết giữa upload giữ trạng thái chưa rõ, không tự chạy lại.

Hướng dẫn: [Sandbox backend trials](../runbooks/sandbox-backend-trials.md). Cơ sở kỹ thuật: [chuẩn bị tạo](https://open.shopee.com/developer-guide/209), [luồng tạo](https://open.shopee.com/developer-guide/211), [add_item](https://open.shopee.com/documents/v2/v2.product.add_item?module=89&type=1), [init_tier_variation](https://open.shopee.com/documents/v2/v2.product.init_tier_variation?module=89&type=1), [get_item_base_info](https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1) và [get_model_list](https://open.shopee.com/documents/v2/v2.product.get_model_list?module=89&type=1), bản chụp KB 08/09/2026. Đọc web trực tiếp ngày 12/09 bị HTTP 403; metadata shop hiện hành chưa đọc đủ do token lỗi. Không tuyên bố đã xác minh policy production mới nhất.
