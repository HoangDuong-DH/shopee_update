# Đăng thử từ backend trong sandbox

Phạm vi: nhánh thử kỹ thuật ngày 12/09/2026, chỉ TEST partner 1232297 / shop 227418363. Không đăng vào shop thật; không sửa hoặc tạo lại Lamy. Worker nhận các manifest giả lập được gửi rõ ràng qua API riêng. Công việc nguồn doanh nghiệp và executor production vẫn chưa được bật.

## Luồng sử dụng khi nghiệm thu

1. Khởi động Postgres, áp dụng migrations, API và worker theo hướng dẫn phát triển local. Cập nhật token TEST ở **Kết nối shop**. Token không nhập vào mã nguồn, lệnh hoặc báo cáo.
2. `POST /v1/sandbox-create-trials/inspect` đọc metadata shop/ngành/kênh và kiểm trùng SKU. Thân yêu cầu: `trialKey` bắt đầu `SBX-BULK-`, `connectionId`, `connectionRevision`, `count`, `logisticId`; có thể truyền `sizeId`/`shippingFee` nếu kênh yêu cầu. Mọi POST dùng header nội bộ `X-App-Client: internal-workspace`.
3. `POST /v1/sandbox-create-trials/prepare` cùng thân yêu cầu. Backend kiểm điều kiện trước khi tải ba ảnh kỹ thuật tự tạo. Sau đó lưu manifest bất biến và trả bản xem trước, `id`, `fingerprint`, `issues`, mã ảnh và SHA. `prepared` chưa có nghĩa đã tạo listing. `blocked`/`unknown`/`preparing` không được submit; không tự chạy lại một upload chưa rõ kết quả.
4. Kiểm tra manifest. Gửi `POST /v1/sandbox-create-trials/preparations/{id}/submit` với `{ "fingerprint": "..." }`. HTTP 202 chỉ xác nhận đã xếp hàng.
5. `GET /v1/sandbox-create-trials/{trialId}` trả trạng thái từng nguồn, item ID, bước, lỗi, bằng chứng đọc lại và thời gian. Worker lưu intent trước mutation, không gửi lại create/init khi mất phản hồi. Sau create phải chờ ít nhất 5 giây trước khởi tạo phân loại.
6. Lần đầu chỉ một item. Lô nhiều item chỉ được submit khi có một item đã đọc lại đạt trên cùng revision kết nối. Giữ `UNLIST` toàn bộ. Không có bước tự bật bán, xóa mẫu, cập nhật Lamy hoặc tạo chương trình giá.

## Nội dung fixture và giới hạn

- Sổ tay giả lập ngành 301378, tên `SANDBOX QA`, parent/model SKU riêng. Ngành, thuộc tính giấy 200134/101205 và No Brand phải được xác minh lại bằng metadata; sai hoặc thiếu thì chặn, không đổi nguồn để vượt kiểm tra.
- Giá/tồn/cân nặng/bao bì trong fixture là dữ liệu kỹ thuật mới, không phải dữ liệu KINI hoặc mặc định doanh nghiệp.
- 0/1/2 tầng theo thứ tự fixture; tối đa 4 model. Ảnh gallery thử 1:1, mô tả chữ; không nghiệm thu được bìa riêng 1:1 + gallery 3:4 hoặc ảnh mô tả bằng nhánh này.
- Nguồn không khai GTIN. Chỉ chấp nhận quy tắc Optional; Flexible/Mandatory dừng trước tải ảnh. API VN không bảo đảm trả GTIN để đối chiếu.
- 80 là trần lô thử do ứng dụng đặt. Không phải quota Shopee và không chứng minh số link/ngày.
- Snapshot metadata có thời hạn 15 phút, pin revision kết nối. Token đổi hoặc snapshot hết hạn không tự sửa manifest/lặp mutation. Chưa có cơ chế tự refresh token.
- Worker dừng lô khi lỗi xác thực hoặc ghi chưa rõ. Intent chưa rõ còn giữ khóa ghi shop qua lần khởi động lại. Hiện chưa có màn hình/endpoint giải quyết tự động các trạng thái unknown; cần đọc và đối chiếu bằng chứng, không chỉnh DB để ép verified.
- Chuẩn bị media đang chạy trong request API; mất tiến trình giữ record chưa rõ, không tự phục hồi upload. Worker listing tách khỏi vòng đời HTTP. Chưa nghiệm thu vận hành 24 giờ.

## Phân biệt bằng chứng

`tests/integration/sandbox-create-trials.test.ts` chạy Postgres cô lập và cùng store/worker/gateway với transport Shopee giả có trạng thái. Số item của thử nghiệm đó là giả lập. Chỉ báo cáo listing sandbox thật khi có request thực tế, item ID và đọc lại thực tế. HTTP 200/202, test xanh hoặc ảnh giao diện không thay thế bằng chứng này.
