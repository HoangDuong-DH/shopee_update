# Phản biện và xác minh lô nguồn doanh nghiệp — 14/09/2026

Phân công độc lập: agent dữ liệu/nghiệm thu tạo Word/ảnh/Excel và phía nhận mô phỏng có trạng thái; agent thực thi xây hàng đợi và phép so; agent giao diện xây luồng thao tác và kiểm tra phục hồi; root nối nguồn/API/persistence, kiểm lại bằng chứng và hồi quy. Dữ liệu kỳ vọng của phép thử đọc từ fixture gốc; không lấy toàn bộ kết quả kỳ vọng từ hàm dựng payload đang được kiểm tra.

## Phát hiện quan trọng và cách xử lý

1. **Vận chuyển thiếu cân nặng/kích thước.** Đối chiếu file phiên bản mới phát hiện kết quả `verified` nhưng giá trị vẫn như cũ. Sửa nhóm `logistics` bao gồm kênh, cân nặng và kích thước. Ca độc lập theo tệp mới đã đạt.
2. **Lẫn trạng thái đang ghi và chưa rõ kết quả.** DB lưu `unknown` trước gọi adapter là đúng cho phục hồi, nhưng public API từng khiến UI dừng theo dõi giữa chừng. Nay phân biệt `durableState`, `inFlight`, khả năng tiếp tục của các shop và trạng thái hiển thị. Giữ lệnh ghi mơ hồ bất biến, không đưa lại vào hàng đợi.
3. **Chờ vô hạn.** Thử bằng promise thật không kết thúc, không chỉ trả về mã lỗi giả. Đã giới hạn chờ, giữ pending mutation, ngăn đối chiếu kết thúc giả khi adapter còn chạy; shop khác vẫn xử lý. Không tuyên bố timeout đã hủy tác động ở máy chủ bên ngoài.
4. **Cạn pool do giao dịch lồng truy cập.** Root bỏ giữ kết nối ngoài khi repository cần kết nối khác. Guard kiểm phiên bản nguồn dùng chính client của giao dịch enqueue. Bốn retry đồng thời hoàn thành với pool max 1; không tăng số nguồn/công việc.
5. **Đặt chỗ không có biên nhận sau crash.** Lưu source snapshot trước đặt chỗ. Mô phỏng lỗi ghi snapshot chứng minh chưa có reservation; lỗi sau reservation vẫn mở lại cùng lô được dù kết nối đã đổi, rồi hủy phần chưa gửi bằng API công khai.
6. **Lỗi một nguồn làm hỏng cả lô.** Kiểm cấu trúc từng entry và loại entry/draft lỗi trước gọi bộ thực thi. Đã thử kích thước lẻ ngoài cấu trúc cho phép cùng hàng xóm hợp lệ. Sáu lỗi nguồn qua UI/DB vẫn được giữ riêng và hàng xóm có thể thực thi.
7. **Lô có lỗi báo đạt toàn bộ.** Tổng trạng thái và bộ đếm bao gồm nguồn bị chặn trước khi có job. Kết quả `verified:1, blocked:6` luôn còn `blocked`.
8. **Menu mobile tràn ngang.** Hồi quy phát hiện scrollWidth 426 tại viewport 390. Cho các nút co và xuống dòng, không che/cắt trang; đo lại 390 và kiểm thử các màn hình cũ.

## Bằng chứng phân tầng

- Mức tệp: hash, chữ Word, khoảng trắng, dòng trống, kích thước ảnh, dòng/sheet giá, thứ tự ảnh và nguồn của từng SKU.
- Mức nghiệp vụ: 80 nguồn đầy đủ/WorkOrder/remote mô phỏng; chín nhóm cập nhật; 12 listing giá/tồn; bảo toàn các field và model không chọn.
- Mức lỗi: mất phản hồi, hết hạn/đổi kết nối, xung đột nguồn, pending mutation, crash, gửi trùng, thay đổi sau đơn hàng, sai model/kiểu dữ liệu, partial write, nhiều shop và retry cạnh tranh.
- Mức giao diện: browser dùng API/PG thật cho bộ 15 ca; ba ca điều khiển phục hồi dùng API fixture, được ghi riêng. Hồi quy giao diện cũ không được coi là bằng chứng ghi Shopee.

Các tệp bằng chứng có đường dẫn trong `docs/delivery/2026-09-14-prepared-business-acceptance.md`. Kết luận giới hạn ở mô phỏng có trạng thái và ứng dụng local. `PreparedGateway` chưa phải codec OpenAPI; toàn bộ quyền live, QC, policy hiện hành và production vẫn cần phép thử khác. Không dùng số lượng test để khẳng định đã bao phủ mọi tình huống có thể xảy ra.
