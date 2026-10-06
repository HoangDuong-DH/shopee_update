# Tự gia hạn kết nối

Gia hạn credentials là một luồng riêng với đăng, mở bán và sao chép sản phẩm. Bật gia hạn không bật PRODUCTION_PILOT_ENABLED, SHOPEE_PRODUCTION_WRITES hoặc PRODUCTION_WORKFLOW_ENABLED.

## Cho phép trên một máy

Sau khi chủ máy cho phép, dừng app bằng launcher sở hữu đúng tiến trình và lưu tệp riêng .local/connection-maintenance.json với nội dung:

```json
{"version":1,"enabled":true}
```

Không chỉnh .env/secrets hoặc biên nhận setup để bật tính năng. Tệp vắng mặt mặc định tắt; enabled false tắt. Policy hỏng hoặc quá 1KiB giữ chờ kiểm, không tự bật. Tệp riêng không commit và không tự mang qua máy nhận. Đổi policy khi app đang chạy cần dừng/khởi động có kiểm; supervisor xem dấu kiểm policy là một phần identity. Sau restart kiểm runtime.connectionMaintenanceEnabled từ /v1/operations/overview, không chỉ nhìn nội dung tệp.

Setup mới mặc định tắt. Transfer hold và INTERNAL_ISOLATED_MODE luôn chặn gia hạn; khôi phục dữ liệu không tự cấp quyền gọi Shopee. Policy đã bật được launcher/supervisor giữ khi phục hồi API, nhưng supervisor không phải dịch vụ Windows tự chạy sau reboot. Private helper trên máy vận hành dùng cùng policy.

## Cách hoạt động

API kiểm các shop production có auto_refresh, state connected và refresh_status phù hợp mỗi phút, tối đa 20 shop một lượt; gia hạn khi còn tối đa một giờ, khi token hết hạn hoặc đang chờ mạng. Tick không chồng; thông tin từng connection/revision và receipt mã hóa ràng buộc đúng scope. Không gửi thao tác sản phẩm. Chỉ coi kết nối đã gia hạn khi đã lưu token và đọc xác minh shop.

Mất mạng trước gửi giữ waiting. Sau gửi mà chưa rõ kết quả: giữ journal/receipt và không dùng lại token một lần. Unknown không tự tham gia tick tiếp; phục hồi từ receipt đúng scope/revision trước khi quyết định cấp quyền lại. Có phản hồi HTTP không đồng nghĩa token đã được chấp nhận. Không xóa intent để vượt chặn. Chi tiết cơ chế và lịch sử cũ trong production-pilot-token-refresh.md không thay cho trạng thái live.

UI hiển thị Cần gia hạn cho access token quá hạn và Sắp gia hạn khi gần hạn; không đồng nhất với thời hạn shop cấp quyền. Trạng thái chưa xác minh giữ riêng. Giao diện đọc lại projection khi có cập nhật, focus hoặc mỗi 30 giây khi hiển thị; không tự gọi refresh từ lượt GET.

## Kiểm

Trong checkout/database cách ly: Node connection-maintenance-policy.test.mjs, local-supervisor.test.mjs, onboarding-launcher.test.mjs; unit connection-maintenance-scheduler, operations-presentation, shop-connections, operations-overview; integration connection-lifecycle và operations-overview. Có kiểm giữ pause đăng, ngăn tick chồng, transfer/isolated suppression, policy đổi, phục hồi API giữ flag, CAS/journal và unknown không resend. Không chạy suite DB lên database vận hành.

Không coi kiểm fixture là nghiệm thu 24 giờ hoặc mọi shop. App tắt/ngủ/mất mạng quá lâu không tự gia hạn được; nếu refresh token hết hạn hoặc quyền bị thu hồi cần chủ shop xử lý.
