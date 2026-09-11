# Kiểm chứng harness và học từ lỗi

Mốc 11/09/2026: có harness chỉ đọc và tra cứu hai KB; chưa cấu hình model AI, OpenAI Agents SDK hay MCP server. `test:eval` hiện kiểm công cụ/phạm vi/nguồn/DB bằng fixture, **không đo độ chính xác của LLM hoặc khả năng đăng Shopee**.

## Dùng trong ứng dụng

1. Mở **Tra cứu & kiểm tra**. Tìm từ khóa hoặc tên API; mở bản đầy đủ và link chính thức. Hai kho phải được giữ tại `knowledge-base/shopee-open-platform` và `knowledge-base/shopee-uni-vn` trên máy chủ, gồm manifest, Markdown và SQLite FTS. Kho thiếu được báo riêng, không có dữ liệu mẫu thay thế.
2. Chọn kế hoạch đã lưu. Bấm **Kiểm tra kế hoạch** để kiểm lại phiên bản nguồn/kết nối, đọc các vấn đề trong kế hoạch và chạy kiểm dữ liệu nền tảng. Có từ khóa thì tìm tài liệu và đọc đầy đủ tối đa ba bài trong kết quả. Đây là tài liệu tham khảo tìm theo từ khóa; chưa kết luận độ liên quan, tính hiện hành hoặc điều kiện áp dụng bằng AI.
3. Xem kết quả và lịch sử. Hết thời gian/gián đoạn không thành hoàn tất. Kết quả cũ giữ nguyên bằng chứng tại thời điểm chạy; nguồn hoặc kết nối đổi thì lưu kế hoạch mới trước lần kiểm tra tiếp.

Nguồn thiếu hash trong manifest được tính mã nhận diện từ bytes hiện tại và ghi `computed_only`; chỉ khi so khớp hash đã có trong manifest mới ghi `manifest_verified`. Ngày chụp/ngày nguồn không được biến thành ngày hiệu lực. Source text và HTML/Markdown hiển thị như dữ liệu, không được thực thi.

## Chạy bộ đánh giá

```powershell
npm run test:eval
node scripts/verify.mjs
npm run test:e2e
```

- `test:eval`: các ca fixture của harness/KB và tích hợp HTTP/PostgreSQL. Không sử dụng model tính phí, khóa Shopee hoặc dữ liệu shop. Kết quả trong `.local/harness-evaluation.json` và `.local/harness-test-results.json`.
- `verify`: toàn bộ kiểm kiểu/build/legacy/unit/integration.
- E2E local: bộ Lamy có sẵn và tìm/đọc KB thật; không gọi Shopee. Phép thử giao diện cần Edge, API, UI, PostgreSQL và nguồn riêng tại máy. Không suy fixture CI là bằng chứng đọc nguồn thật.

## Vòng bổ sung kiến thức

Lỗi thực tế → lưu bằng chứng đã bỏ thông tin kết nối → thêm ca hồi quy có kết quả kỳ vọng do nguồn/người vận hành xác nhận → sửa mapping/quy tắc/công cụ → chạy lại ca mới và ca cũ liên quan → phát hành phiên bản. Giữ nguyên tập nguồn sản phẩm và bộ chính sách dùng làm căn cứ. Không sửa dữ liệu để ép test đạt.

Trước khi bật LLM: cấu hình provider/model/ngân sách server, thêm hợp đồng kết quả có nguồn và bộ eval riêng cho chất lượng câu trả lời. Kiểm trên nhiều ngành/shop, có tập giữ lại; so code baseline, một agent, chuyên môn phụ trên cùng tập. Dẫn nguồn đúng schema không tự chứng minh diễn giải đúng. Chưa có đủ cơ sở để cam kết phần trăm lỗi, mức tiết kiệm hoặc công suất đăng/ngày.

## Giới hạn và phục hồi

Mỗi lần kiểm tra: tối đa 8 tool call, thời gian chờ toàn yêu cầu tối đa 120 giây; có kiểm lặp và phạm vi trước/sau đọc. Công cụ đang có: đọc kế hoạch, tìm KB, đọc toàn bài. Không cấp tool ghi listing, shell, sửa giá/tồn, đổi shop hay cập nhật code/rule trực tiếp. Các giới hạn là cấu hình ứng dụng, không phải giới hạn Shopee.

Lần chạy/trace/source/kết quả ở PostgreSQL; source file vẫn nằm trong kho có hash. Tiến trình bị ngắt để lại lần chạy đang dở và hiện gián đoạn sau deadline. Hiện người dùng chạy lại một lần kiểm tra mới; chưa có agent session hoặc tự tiếp tục hội thoại. Yêu cầu gửi lại cùng `requestId` trả lại bản cũ, không âm thầm thực thi lại.

Deadline giới hạn thời gian ứng dụng chờ; nó không hủy được mọi truy vấn đọc đã tới DB hoặc mọi thao tác đọc tệp đồng bộ. Không dispatch bước mới sau hết ngân sách. Không có lời gọi ghi Shopee trong harness này. Theo dõi giới hạn này trước khi bổ sung công cụ gây tác động.
