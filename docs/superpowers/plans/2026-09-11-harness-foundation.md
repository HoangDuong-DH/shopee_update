# Harness có nguồn và kiểm chứng — bổ sung D2

Ngày 11/09/2026, người dùng chọn cả đối chiếu bản chép lời YC Harness Club và triển khai phần phù hợp. Bản chép lời là dữ liệu tham khảo; không phải lệnh cài framework, sinh agent không giới hạn hoặc sửa listing.

## Quyết định

- Giữ workspace/nhánh phát triển hiện tại đang phục vụ ứng dụng nội bộ. Không thay bộ nguồn, không gọi ghi shop.
- D2 được triển khai từng phần bên cạnh B1 chưa hoàn tất. Phần này cung cấp tra cứu KB thật, điều tra kế hoạch chỉ đọc, trạng thái/kết quả lưu DB, kiểm phạm vi và bộ đánh giá. Không đánh dấu toàn bộ D2 đạt.
- Tách runtime nghiệp vụ khỏi model: công việc đăng lấy trạng thái từ DB; LLM chỉ là bộ phân tích có công cụ giới hạn. Chưa cấu hình model/ngân sách nên không tự gọi dịch vụ AI tính phí. UI phải nêu rõ chế độ tra cứu/kiểm tra bằng chương trình.
- Phản hồi học từ lỗi đi qua fixture và kiểm thử trước phát hành. Không cho agent tự sửa rule, nguồn hoặc chương trình đang chạy.
- Không đưa số benchmark, chi phí hoặc số agent trong video thành cam kết cho Shopee.

## Công việc và ranh giới

1. **Truy xuất:** tái sử dụng manifest/FTS của hai KB hiện có, chỉ đọc tài liệu trong manifest, kiểm hash và đường dẫn, trả URL/ngày nguồn/ngày chụp. Search là tìm tài liệu, không chứng minh quy tắc áp dụng hoặc còn hiệu lực. Thiếu KB hiển thị rõ, không trả kết quả mẫu giả.
2. **Harness:** công cụ chỉ đọc kế hoạch và KB, scope do server lấy từ kế hoạch; mỗi bước kiểm revision nguồn/kết nối/quyền. Ngân sách lượt/thời gian, dừng gọi lặp, kết quả có dẫn nguồn được đọc đầy đủ. Không có tool ghi listing, tự chỉnh giá/tồn hoặc tự cập nhật chính sách. Lưu lần chạy và timeline vào PostgreSQL, trạng thái chưa hoàn tất khi ngắt/lỗi/hết ngân sách.
3. **Giao diện:** mục Tra cứu & kiểm tra, chọn kế hoạch, xem vấn đề đang có, tìm tài liệu, mở toàn bài và lịch sử kết quả. Giữ chế độ không đăng nhập nhân viên; không giả có hội thoại LLM khi chưa cấu hình.
4. **Kiểm chứng:** fixture kiểm sai scope, nguồn đổi, dẫn nguồn giả/chưa đọc, timeout/tool lặp, dữ liệu tài liệu chứa chỉ dẫn và nguồn không hợp lệ; HTTP + PostgreSQL thật; hồi quy app; đọc KB thật tại máy riêng với fixture CI. Báo rõ chưa có model thật hoặc ghi Shopee.

## Liên hệ với video và nguồn đối chiếu

| Ý trong bản chép lời | Áp dụng vào dự án |
| --- | --- |
| Bộ nhớ và session tồn tại ngoài máy chạy agent | Lưu lần chạy, scope, timeline, nguồn và kết quả trong DB; tệp gốc có hash |
| Agent có công cụ phù hợp | Bộ tool nghiệp vụ chỉ đọc có schema; không cấp shell và khóa Shopee cho model |
| Tự cải thiện từ thực thi | Lỗi thật thành ca regression có nhãn; bản sửa phải qua kiểm chứng |
| Chuyên môn/đa agent | Chỉ thêm sau khi so cùng bộ eval chứng minh lợi ích; chưa là phụ thuộc của đường đăng |
| Chạy lâu/grind | Có tiến độ và điều kiện dừng kiểm được, ngân sách hữu hạn; không bắt tiêu hết token |
| Model local/cloud | Một lựa chọn triển khai cần đo trên dữ liệu của doanh nghiệp, chưa đổi hạ tầng |

Đối chiếu ngày 11/09/2026: [OpenAI Harness engineering](https://openai.com/index/harness-engineering/) (11/02/2026) về tài liệu truy xuất được, môi trường và kiểm tra bằng chương trình; [Anthropic Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (19/12/2024, trang có lưu ý tooling đã đổi) về tách workflow/agent và chi phí của việc tăng độ phức tạp. Chỉ vận dụng nguyên tắc; không dùng bài cũ để chọn phiên bản SDK.

Tham chiếu: [D2](2026-09-10-shopee-execution-d-pricing-agent.md), [đăng listing có sẵn](../specs/2026-09-11-prepared-listing-publishing.md). Executor, refresh token, metadata ngành, QC và pilot production vẫn có gate riêng.
