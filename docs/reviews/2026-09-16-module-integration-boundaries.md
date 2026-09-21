# Rà soát đường đi giữa các mô-đun — 16/09/2026

Rà mã và hồ sơ cục bộ lúc **09:33 UTC / 16:33 UTC+7**; không gọi Shopee, không đọc/ghi DB chính hoặc khởi động lại runtime. Đây là báo cáo ranh giới tích hợp, không phải xác nhận các listing còn lại đã được đăng.

## Đường đi đã nối

`listing-source.json` giữ định danh sản phẩm, phiên bản, hash tệp, đoạn Word, SKU/thứ tự phân loại, vai trò ảnh và ID listing nguồn. Nhập thành ListingDraft giữ ID đó trong cả dữ kiện và lựa chọn nguồn; khi mở lại phải khớp nội dung, ảnh, giá và thứ tự. ID trống mang ý định tạo mới; có ID mang ý định cập nhật đúng link. Khâu production tạo mới chặn ý định cập nhật.

Gợi ý KB gắn đúng bản nháp/phiên bản/kết nối/shop/ngành/thương hiệu. Chỉ dữ kiện sản phẩm đã xác nhận mới có thể được chọn; lịch sử listing không tự điền. Phiếu lựa chọn bất biến được kiểm trước preview và trước đăng ký nhóm, sau đó đi vào snapshot nguồn. Preview đăng ký nhóm tối đa bốn listing với chế độ bất biến. Luồng mới mặc định đăng ẩn; hoãn QC ảnh là lựa chọn riêng chỉ dùng với đăng ẩn.

Thực thi giữ kiểm nguồn, giá ô Excel, metadata còn hiệu lực và lane/journal. Hoãn ảnh vẫn yêu cầu mọi lệnh có ACK đã biết và hai lần đọc đầy đủ phần dữ liệu kinh doanh. Phiếu hoàn tất ẩn tách khỏi chứng cứ QC đầy đủ; không đánh dấu ảnh đã đạt. Khi đã QC đầy đủ, mở bán là hành động riêng trên đúng một listing với fingerprint trạng thái và ý định ghi bất biến. Unknown hoặc tiến trình bị gián đoạn vẫn phải đối chiếu, không tự phát lại create/init.

## Chỗ cần nói rõ với người vận hành

| Ranh giới | Hành vi hiện tại và ảnh hưởng |
| --- | --- |
| Nguồn có ID → cập nhật | Đã nhận và giữ đúng ý định, nhưng chưa có luồng production cập nhật tổng quát nối từ bộ nguồn này. Nguồn sẽ bị chặn khỏi tạo mới; không nên hướng dẫn xóa ID để đi tiếp. Các patch sandbox là phạm vi khác. |
| Phiếu KB → thực thi sau đăng ký | Hạn schema, revision và dữ kiện xác nhận mới nhất được kiểm đến lúc đăng ký. Sau đăng ký, runner dùng snapshot đã duyệt bất biến và đọc lại metadata Shopee; chưa đọc lại phiếu KB/dữ kiện local mới thay thế trước từng dispatch. Vì vậy sửa bản nháp hoặc xác nhận sau đăng ký không tự sửa/hủy nhóm cũ. |
| Hoãn ảnh → hoàn tất ẩn | Dùng **Tiếp tục listing này/Đăng ẩn** để chạy chế độ execute đã lưu. **Chỉ đọc đối chiếu** dùng kiểm ảnh nghiêm ngặt, không phải lệnh tạo phiếu hoãn ảnh. Các lệnh create/init đã ACK được tái dùng, không gửi lại. Cân nặng làm tròn vẫn cần phiếu riêng; lệch giá/tồn/SKU/nội dung hoặc unknown sẽ dừng nhóm. Parent chạy tuần tự nên có thể tạm dừng cả phần sau khi một nguồn cần xử lý. |
| Hoãn ảnh → mở bán | Listing mới hoãn ảnh có thể chưa có hồ sơ QC. Bấm **Chỉ đọc đối chiếu** để tạo hồ sơ nếu cần, vào **Kiểm tra ảnh**, rồi **Chỉ đọc đối chiếu** lần nữa. Chỉ mở trang Kiểm tra ảnh không tự tạo case. Nút mở bán chưa khả dụng khi còn nhãn **Ảnh chưa QC**. |
| Thuộc tính và quyền shop | Cây con/type3/đơn vị/giới hạn đã dùng kiểm chung ở preflight. Nhiều custom value cùng ID 0, một số object thuộc tính đã lưu và tìm giá trị ngoài cây chưa nối đầy đủ, vẫn chặn. Bằng chứng media tái dùng operation verified của pilot; chưa phải phép đo quyền whitelist mới cho mọi shop/ngành. |
| Preview và đồng bộ KB | Preview vẫn là tác vụ HTTP đồng bộ; lô nhiều ảnh từng tiếp tục khoảng 90 giây sau client timeout. Đọc lại đúng preparation ID; không nhập lại nguồn hoặc tạo request mới theo suy đoán. Chưa có tiến độ nền/durable job cho preview. KB chưa tự đồng bộ sau publish; dữ liệu mới cần lần đồng bộ riêng. |

## Sửa hẹp từ rà soát này

Đã tái hiện việc một `existingListingAuthorization` dạng văn bản bất kỳ làm compiler cho tạo mới từ bản nháp có ID. Theo phạm vi người dùng đã chốt, compiler nay chặn trường hợp này bất kể văn bản khai báo. Schema lịch sử được giữ để đọc manifest cũ; không biên dịch lại, sửa hoặc vô hiệu lô thử đã đăng ký. Kiểm đỏ trước sửa; **83/83** ca nguồn/compiler và manifest đạt sau sửa, TypeScript noEmit và project/declaration build đạt. Ca v2 riêng xác nhận snapshot/manifest lịch sử giữ nguyên bytes. Hồ sơ `.local/existing-id-declaration-{red,green,type,build}.*`; không cộng vào số ca của lượt tổng.

## Phạm vi production đã có bằng chứng

Hồ sơ gần nhất đã đọc là [checkpoint 09:02 UTC của lô thử](../delivery/2026-09-16-ten-listing-pilot.md): sáu bộ mới Trà Trắng, Sả Chanh, Phong Lữ, Rừng Thông, Oải Hương và Sả Java đã mở bán; Hương Thảo có link đang ẩn; Hoa Hồng, Hoa Lài, Cam Sả chưa gửi. Bốn bộ còn lại đã có policy cục bộ chuyển sang đăng ẩn/hoãn ảnh, chưa phải bằng chứng thực thi xong. Không đọc lại trạng thái live trong lượt rà soát này.

Writer vẫn giới hạn shop production pilot **1423724897**, partner **2010476**. Nhiều shop của KB và các tình huống lỗi/khôi phục có fixture; chưa nghiệm thu nhiều shop thật, mọi ngành, cập nhật production tổng quát hoặc chạy 24 giờ. Hướng dẫn hiện hành: [tự đăng ẩn bốn listing](../operator-guides/tiep-tuc-4-listing-2026-09-16.md), [gợi ý thuộc tính](../operator-guides/goi-y-thuoc-tinh-cho-ban-nhap.md), [bộ kiểm thuộc tính chung](../delivery/2026-09-16-current-attribute-validation.md).

Vị trí rà soát chính: `folder-manifest.ts`/`folder-source.ts`, `product-service.ts`, `production-draft-source.ts`, `seller-knowledge-draft-service.ts`, `production-preparation-service.ts`, `production-preparation-execution.ts`, `production-batch-runner.ts`/`production-batch-service.ts`, `production-pilot-image-deferral.ts` và `production-pilot-cover-qc.ts`.
