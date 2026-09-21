# Audit độc lập: nguồn thật, backend cô lập và đăng ẩn mô phỏng

Audit chỉ đọc ngày 16/09/2026. Không chạy lại smoke, không sửa nguồn, không gọi API, không ghi DB chính hoặc Shopee.

## Kết luận

Artifact smoke nhất quán về **giữ nguyên trường nguồn** và **ranh giới mô phỏng**. Có 116 assertion đạt; ba nguồn/63 SKU được nhập và lưu trong schema riêng. Chỉ Xịt thơm Hoa Lài chạy tới đăng ẩn với API mô phỏng. Không được báo là ba listing production ready, ba listing đã đăng, hoặc ảnh đã QC.

Một mâu thuẫn nội dung thực sự còn trong nguồn Hoa Lài: tên và cam kết là Hoa Lài, nhưng Word ghi **“Thành phần: cồn thực phẩm và tinh dầu tạo hương Hoa Hồng.”** Manifest và hai lần đọc mô phỏng giữ nguyên câu này. Điều đó chứng minh bảo toàn nguồn, không chứng minh nội dung đúng sản phẩm. Cần quyết định sửa có phiên bản trước khi gửi thật; không tự sửa hoặc kế thừa quyết định thành phần từ lô thử cũ. Người phụ trách đã có đề xuất riêng trong `content-review-proposals.json`, chưa áp vào nguồn trong artifact này.

## Bằng chứng đã đối chiếu

- Artifact: `.local/vina-input-712-836-20260916/backend-real-source-smoke-0d5db897-824a-4263-871d-376548184015.json`, SHA-256 `f1801d8b6d3624d8bf331842ea326dd17ef5723e8ce36ad7793232662958085d`; chạy từ 11:17:17 đến 11:19:15 UTC.
- Snapshot nguồn cố định: `ready-inputs-12-v1-receipt.json`, SHA `6dced3f2c43d039301a981285a0738a9c78b885b16b5efda7e2d38d49fd66313`, ZIP SHA `f1bab1ee52f94df236ff6bddaa83548679f4536b7ab0151783a142d58b6b7a8b`; 12 hồ sơ/387 SKU. Không mở rộng kết quả này sang các hồ sơ được bổ sung sau snapshot.
- Đọc lại 62 tệp được artifact dẫn và tính hash: tất cả vẫn khớp. Manifest đăng ký có hash đúng, mode `hidden_for_review`, policy `defer_image_qc`. Cả ba danh sách SKU/nhãn/giá gốc và thứ tự gallery khớp projection nguồn trong artifact.
- Báo cáo bổ sung `backend-real-source-field-preservation.json` ghi 37 phép đối chiếu riêng, gồm Word, mô tả/xuống dòng, tier index, ảnh từng SKU, giá và cân nặng. Đã đọc cả cách đối chiếu; đây là audit bổ sung, không cộng thành một lượt full verify mới.

| Nguồn | SKU | Gallery giữ nguyên | Kết quả có thể kết luận |
| --- | ---: | ---: | --- |
| Xịt Tủ Giày Và Túi Đồ Tập VINA TƯƠI — 16 hương, 100/300/500ml | 48 | 10 | Nhập/lưu/ghép manifest đạt với lựa chọn fixture; wire plan bị chặn `item_image_count_limit`. Không tự bỏ ảnh để qua giới hạn. |
| Nến Thơm Tinh Dầu Thơm Phòng VINA TƯƠI — hũ sáp 100g/200g | 12 | 9 | Nhập/lưu và wire plan fixture đạt; không chạy tạo listing trong smoke này. |
| Xịt Thơm Hoa Lài VINA TƯƠI — cho phòng khách 100ml/300ml | 3 | 9 | Nhập/lưu và một lần create/init mô phỏng; kết thúc `hidden_image_qc_deferred`, chưa có kiểm ảnh đầy đủ hay publication. |

Hoa Lài giữ thứ tự **500ml → 300ml → 100ml** theo hồ sơ. Tiêu đề chỉ nêu 100ml/300ml, nhưng mô tả có cả 500ml; audit không tự bỏ SKU 500ml hoặc sửa tiêu đề.

## Đăng ẩn mô phỏng khác production

Script khóa outbound `fetch` và truyền transport riêng vào platform trong bộ nhớ. Pool nghiệp vụ dùng schema `test_actual_source_…`; schema được kiểm tên và xóa khi xong. Dù lớp transport và scope có nhãn production, các request của smoke không rời máy, không đọc token thật và không dùng các bảng nghiệp vụ chính.

Nhật ký fixture ghi 21 lượt: 4 GET metadata, 11 upload, 1 create, 1 init phân loại, 2 GET base và 2 GET models. **0 publication**; chạy lại cùng operation dùng proof đã lưu và không thêm POST. Hai readback mô phỏng đều `UNLIST`. Trạng thái journal gốc vẫn `acknowledged`; `deferredVerification=true`, `strictVerification=false`. Mã item `970100001` là ID fixture, không phải listing thật.

Ngành, thương hiệu, thuộc tính, kênh vận chuyển, kích thước và các lựa chọn vận hành dùng để đi sâu vào contract được ghi `notUserProductFacts=true`. Chúng không được dùng làm dữ kiện sản phẩm hoặc xác nhận quyền shop. Tồn 100 trong hồ sơ kiểm này là phạm vi lựa chọn của lô nguồn, không phải mặc định chung.

## Readiness và giới hạn

Khi chưa thêm lựa chọn fixture, cả ba nguồn đều bị chặn với 8 trường vận hành cần bổ sung: ngành, thương hiệu, vận chuyển, kích thước, tình trạng hàng, đặt trước, kho và cân nặng cấp listing. Các số issue 152/44/17 còn bao gồm cảnh báo `DUPLICATE_SKU` theo nhiều bộ giá (144/36/9); không phải số lỗi block độc lập. Patch cảnh báo đã giải quyết theo đúng scope là công việc sau snapshot này và cần kiểm riêng.

`productionReady=false` được giữ ở cấp báo cáo và từng nguồn. `fixtureContractReady=true` chỉ nói lựa chọn tổng hợp đã đi qua bước lập manifest. Không chứng minh metadata thật, quyền gallery/ảnh mô tả, size chart, độ đúng nội dung, QC thị giác, cập nhật ID cũ, tất cả 46 nguồn, nhiều shop hoặc vận hành 24 giờ. Mâu thuẫn Hoa Lài là ví dụ cụ thể vì sao 12 hồ sơ/387 SKU không đồng nghĩa publishable.

## Checkpoint triển khai độc lập với smoke

Đã đọc bằng chứng root tại `.local/hidden-manual-20260916/`:

- `verification-after-crossflow.json` lúc **11:06:16.990 UTC**: typecheck, TypeScript build, web build, legacy và unit/integration đều exit 0. `test-results-after-crossflow.json` ghi **2026/2026**, 0 fail, 0 pending; root xác nhận 7 legacy.
- `folder-claims-migration-audit.json`: **031_folder_source_claims.sql** áp dụng lúc **11:12:59.237 UTC**. Tám bảng được bảo vệ có số dòng/hash trước và sau giống nhau, `shopeeWrites=0`.
- `runtime-after-crossflow.json` lúc **11:22:28.097 UTC**: PID **24668**, health `ready`, cả 5 batch `busy=false`; hai batch có policy hidden/defer và ba batch giữ automatic/required. Không tự đổi mode các job cũ.

Các mốc trên là bằng chứng tại thời điểm ghi nhận, không phải một lượt chạy lại của người audit hoặc bằng chứng mọi thay đổi sau đó đã được kiểm tổng.
