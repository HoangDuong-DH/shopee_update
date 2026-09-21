# Đối chiếu trạng thái hiện tại cho lượt Lamy cũ

Ngày 14/09/2026. Đây là bổ sung phục hồi cho sandbox TEST `1232297 / 227418363`, không phải công cụ gửi lại yêu cầu hoặc nghiệm thu production.

Lượt `627e471b-2054-4af8-afc0-5a0a1cc63562`, revision 25, item `803934364`, nguồn `lamy-5d` revision 1 vẫn là `unknown`, phase `done`, mã `COVER_READBACK_REVIEW`. Ngày 11/09 API đã xác nhận yêu cầu tiêu đề/mô tả/gallery; yêu cầu đó thiếu `promotion_images` và thực tế làm đổi bìa. Một yêu cầu riêng sau đó khôi phục bìa. Shopee trả mã ảnh mới nên kiểm tra ID nghiêm ngặt của lượt cũ chưa kết luận toàn bộ được. Khóa shop giữ trạng thái chưa rõ này để không phát sinh ghi tiếp vượt qua một kết quả chưa giải quyết; không có tiến trình cũ đang tự gửi lại.

Nguồn lịch sử: `docs/delivery/2026-09-11-operation-workbench.md`, `docs/research/shopee-lamy-listing-2026-09-10/README.md`; bản đọc DB chỉ đọc ngày 14/09 ở `.local/acceptance-20260914/legacy-recovery/old-run.json`. Mã bìa baseline là `vn-11134201-81z1k-msxkncjjmayra9`, mã đọc cuối của lượt cũ là `vn-11134201-81z1k-mszenf4uof0je1`. Không sửa bản nguồn hay lịch sử để coi sự cố đã không xảy ra.

## Hợp đồng phục hồi

`apps/api/src/legacy-listing-recovery.ts` chỉ nhận một bộ đọc được tiêm nội bộ. Bộ đọc trả `FieldSnapshot` raw, thời điểm, request ID của item/models và bằng chứng hash ảnh theo đúng ID nếu cần. Dịch vụ gọi hai lần, hạn 30 giây mỗi lần, không có adapter mạng mặc định hay hàm ghi Shopee. Kết quả đến trễ sau timeout không được nhận làm bằng chứng.

Hai bản raw được giữ đầy đủ trong biên nhận, so ổn định bằng bộ chuẩn hóa raw hiện hành chỉ loại các trường vận chuyển được khai báo. Mỗi bản cũng được chiếu qua bộ giải mã lịch sử và đối chiếu tất cả trường được lưu trong `expected`, gồm các trường không chọn và đủ sáu model. Phạm vi kết luận được ghi đúng là `historical_projection_and_fresh_raw_stability`: bộ giải mã lịch sử đã bỏ `standardise_tier_variation` và một số trường có chữ `url`, vì vậy không thể chứng minh các trường chưa từng được lưu là bất biến từ ngày 11/09. Hai lần đọc raw mới chứng minh chúng ổn định tại thời điểm phục hồi.

Nếu bìa đổi ID, chỉ cho thay hai đường dẫn khi chiếu để đối chiếu: `coverImageIds` và `protectedFields.item.promotion_image.image_id_list`. Cần một Image QC case đã đạt, gắn chính xác shop/item/lượt cũ, vị trí bìa 0, ID bìa baseline, ID bìa hiện tại và hash hai ảnh. Chấp nhận ảnh mất dữ liệu phải có hồ sơ kiểm tra riêng; mã ảnh khác hoặc độ tương tự đơn thuần không tự đủ. Nguồn ảnh lịch sử phải ghi đúng xuất xứ; URL suy từ ID không được gọi là URL API đã trả. Observer nội bộ chịu trách nhiệm bảo toàn liên kết giữa ảnh lưu trữ, ID nguồn và hash; dịch vụ không tự suy đoán liên kết ấy.

Migration 018 thêm bảng bất biến `sandbox_listing_reconciliations`; không cập nhật `sandbox_listing_runs`, events, intent, revision hoặc nguồn. Trước append, dịch vụ khóa chung owner, kiểm toàn bộ row cũ đúng snapshot/hash/revision, kiểm kết nối TEST đang hợp lệ và revision/capability revision chưa đổi trong hai lần đọc. Token đổi trước khi phục hồi được phép: revision kết nối hiện tại được lưu riêng, không so với revision kết nối lịch sử. Bằng chứng quá 60 giây hoặc Image QC case hết hạn không thể mở khóa.

Khóa chỉ bỏ qua đúng row lịch sử khi có bản append `verified=true`, cùng run ID, revision, fingerprint đầu vào và `run_snapshot=to_jsonb(run)`. Kết quả mang nhãn **trạng thái hiện tại đã đối chiếu, lịch sử giữ nguyên**. Run khác chưa rõ vẫn giữ khóa. Bản ghi failed không mở khóa; gọi lại cùng request ID trả biên nhận cũ, không đọc lại hoặc chèn bản trùng.

## Kiểm chứng mã

12 integration test với PostgreSQL schema riêng đạt; kiểm kiểu toàn dự án đạt. Có kiểm lịch sử giữ nguyên và idempotency, raw tier drift mà phép chiếu cũ không thấy, thiếu ACK, CAS run/kết nối, thiếu proof, proof sai run, byte ảnh thay đổi, giá model ngoài phạm vi thay đổi dù proof bìa hợp lệ, timeout đọc không bao giờ kết thúc và bảng append chống sửa/xóa. Ảnh thử được tạo xác định bằng chương trình trong fixture, không sửa ảnh sản phẩm người dùng.

Báo cáo đỏ/xanh: `.local/acceptance-20260914/legacy-recovery/tests-expanded-red.json` và `tests-expanded-green.json`. Những test này kiểm cơ chế phục hồi; chưa phải bằng chứng đã đối chiếu thành công Lamy thật. Kết quả live và việc mở lại owner chỉ được ghi nhận sau khi root hoàn tất observer, kiểm ảnh và append thật.
