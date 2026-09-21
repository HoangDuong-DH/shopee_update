# 18/09 — Chờ QC từng listing, không giữ khóa shop

Nguyên nhân: Hương Thảo item 45417908562 đã ACK toàn bộ 13 bước nhưng đọc lại lệch item/model weight. Execute trả READBACK_MISMATCH; reconcile cũ còn chặn cover QC. Lane toàn shop khiến batch d217e0dc-3bea-4b8f-8599-51e4c0f91b44 bị chặn dù 4 nguồn chưa gửi. Batch cũ bị ẩn bởi workspace reset, nên khó tìm đường xử lý.

Migration 035 bổ sung receipt chờ QC riêng. Chỉ nhả lane khi operation acknowledged, item ID rõ, có đủ tập bước media/create/variations đúng tài liệu, mọi bước có biên nhận và không có publication. Sent/unknown/rejected/thiếu bước vẫn bị chặn. Receipt không đổi operation thành verified, không cấp quyền public. Nhận lane và kiểm receipt dưới khóa giao dịch chung; không xóa lane của operation khác. Đối chiếu core sau khi đỗ QC vẫn có thể lưu receipt hợp lệ.

Runner tiếp tục sản phẩm sau nếu chỉ còn đối chiếu một creation đã ACK đủ. Status không chặn đợt khác với lane đủ điều kiện chờ QC. UI giải thích rõ trạng thái không chặn. Không sửa dữ liệu cân nặng/kích thước hoặc comparator để giả đạt; các sai khác để người QC kiểm tra.

Thực thi local: operation cf87c395-4095-4f3e-b3bc-50012b33ec79 giữ nguyên revision40/acknowledged/item45417908562; thêm receipt chờ QC, nhả lane. Hash toàn bộ operations trước/sau bằng nhau. Không gọi ghi Shopee và không tự chạy 4 sản phẩm mới. Bằng chứng .local/qc-wait-recovery.json và .local/qc-wait-runtime-after.json. API được restart qua launcher khi không có batch busy.

Kiểm tra: typecheck/TS build/Vite build đạt. 76 unit batch đạt. Integration journal+runner lượt đầu sau sửa fixture 175/176 đạt; test mới sai giả định prepare giữ lane đã sửa để đặt lane của operation khác. Lượt tập trung sau đó 4/4 đạt (park QC, chống replay unknown, deferred hidden, chuyển operation cũ sang deferred). Không tuyên bố full suite hoặc browser E2E. Các fixture truncate được bổ sung bảng receipt; fixture query cũ cập nhật currentProductionSource và waitForQc.
