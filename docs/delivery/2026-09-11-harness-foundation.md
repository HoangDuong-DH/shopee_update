# Mốc harness và tra cứu — 11/09/2026

Đã áp dụng phần phù hợp của bản chép lời YC Harness Club vào kế hoạch D2 và ứng dụng đang chạy. Đây là **harness chỉ đọc và bộ kiểm tra bằng chương trình**, chưa phải agent LLM tự xử lý toàn bộ nghiệp vụ hoặc hệ thống đăng production đã hoàn tất.

## Đã triển khai

- Mục **Tra cứu & kiểm tra**: tìm trong cả hai kho Shopee tại máy, ưu tiên tên API khớp, mở toàn bài và link chính thức. Hiện ngày nguồn/ngày chụp, giữ nguyên nội dung tài liệu; thiếu kho hoặc nguồn lỗi được hiển thị rõ.
- Đọc tài liệu từ manifest, giới hạn đường dẫn vào đúng kho, kiểm đường dẫn thực của manifest/index/tài liệu, xác minh hash khi bản kê có hash. Tệp chưa có hash chỉ được tính mã nhận diện và ghi trạng thái khác.
- Harness có ba công cụ đọc: kế hoạch, tìm tài liệu, đọc toàn bài. Scope lấy từ server, kiểm phiên bản nguồn/kết nối/quyền trước và sau đọc. Không có tool viết lại listing, sửa giá/tồn, đổi shop, chạy shell hoặc ghi Shopee.
- Giới hạn 8 lượt công cụ và 120 giây chờ toàn lần kiểm tra; dừng lặp. Bằng chứng và lịch sử lưu trong PostgreSQL, dùng request ID chống tạo lần chạy trùng khi gửi lại. Trạng thái gián đoạn khác trạng thái hoàn tất.
- Giao dịch lưu kết quả cuối khóa dòng rồi kiểm lại thời gian và có timeout phía PostgreSQL. Đã tái hiện bằng khóa dòng thật việc request hết giờ nhưng UPDATE ghi hoàn tất muộn; bản sửa chặn trường hợp này. Dùng đồng hồ DB cho hạn lưu/hiển thị gián đoạn, thời gian đơn điệu trong tiến trình cho ngân sách chờ.

## Bằng chứng

- `node scripts/verify.mjs`: kiểm kiểu/build đạt, **7/7 legacy**, **87/87 unit/integration**, PostgreSQL thật trong schema riêng.
- `npm run test:eval`: **56/56 fixture** ranh giới harness/KB và tích hợp. Đây là tập con của bộ kiểm tra trên, không cộng thêm thành số test độc lập và không đo chất lượng LLM.
- E2E local: **4/4** trên Edge, gồm nguồn Lamy desktop/mobile và tìm/đọc KB thật. Ảnh giữ tại `.local/e2e-artifacts/`; báo cáo/trace của runner tách riêng để không xóa ảnh nghiệm thu khi chạy một phần.
- Kiểm qua HTTP của app đang chạy trên bản Lamy thật đã nhập: đúng sandbox partner/shop, đọc ba tài liệu đầy đủ, lưu và đọc lại cùng kết quả, gửi lại request giữ cùng ID. Hash dữ liệu sản phẩm trước/sau bằng nhau, số job không tăng. Đây là kiểm nguồn local và kho kiến thức, **không gọi API Shopee**.
- Rà soát độc lập đã xử lý các phát hiện về deadline và xác nhận integrity. Không còn phát hiện cần sửa trong phần đã rà soát.

Các báo cáo riêng nằm tại `.local/verification.json`, `.local/test-results.json`, `.local/harness-evaluation.json`, `.local/harness-live-evidence.json`, `.local/e2e-results.json`. Không đưa tài liệu kinh doanh hoặc dữ liệu kiểm shop riêng lên GitHub.

## Chưa triển khai/nghiệm thu

Model AI/Agents SDK, MCP client/server, tự cập nhật KB, bộ đánh giá diễn giải bằng model và đề xuất sửa có dẫn nguồn vẫn còn trong D2. Luồng này chỉ tìm tài liệu theo từ khóa và kiểm dữ liệu nền tảng; chưa tự kết luận tài liệu có hiệu lực/áp dụng cho shop hoặc thông tin sản phẩm là đúng.

Metadata đa ngành, executor ghi listing, refresh token, readback/QC, khuyến mại, chạy bền 24 giờ và pilot production vẫn giữ gate riêng. Nội dung/ảnh của người dùng được bảo toàn. Không lấy số benchmark hoặc chi phí trong video thành kết quả của ứng dụng.

Tham chiếu: [đối chiếu video và kế hoạch triển khai](../superpowers/plans/2026-09-11-harness-foundation.md), [cách dùng và bộ đánh giá](../runbooks/agent-evaluation.md).
