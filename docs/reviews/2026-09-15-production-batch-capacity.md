# Giới hạn nguồn theo lô đã xác nhận — 15/09/2026

Phạm vi mới là tối đa **bốn danh tính nguồn trong một manifest đã xác nhận**, đúng partner 2010476 / shop 1423724897. Lịch sử hai listing production cũ không bị xóa, sửa, chuyển owner hoặc tính vào sức chứa của lô mới. Không thay đổi schema; không có migration mới.

Runner nhận tùy chọn server `batchAuthorization` do coordinator dựng từ kết quả `loadProductionBatchSource` đã kiểm SHA của manifest và tệp nguồn. Giá trị gồm UUID `batchId`, `manifestSha256`, `authorizationReference`, toàn bộ `sources[{sourceIdentity,sourceRevision,documentSha256}]`; `documentSha256` được tính trên `canonicalJson(document)`. UUID lô runtime khác slug thư mục `production-batch-pass1-20260915`. Đây không phải body cho người gọi HTTP tự cấp quyền.

`allowedSources` của một runner có thể là tập con một nguồn, nhưng mỗi tuple phải có trong proof toàn lô. Mỗi nguồn trong proof chỉ có một revision. Proof được sao chép và đóng băng; journal chèn nó vào bản snapshot `source_payload.batchAuthorization`, không sửa `preflight.input`, document hoặc collector output. Fingerprint và trigger immutable sẵn có bảo vệ cả proof.

Khi giữ khóa shop, journal đọc các operation của đúng batchId và yêu cầu **toàn bộ proof khớp**, không chỉ UUID. Một UUID không được dùng lại với manifest hash, nội dung nguồn hoặc danh sách nguồn khác. Số operation bị chặn tại số nguồn cụ thể trong proof; không có giới hạn biến thiên do caller tự đặt. Kiểm identity/revision toàn owner vẫn giữ nên đổi batchId không cho phép tạo lại một nguồn cũ. Các operation legacy không có proof mới giữ contract và giới hạn cũ.

Mọi lần đọc/thao tác journal trên operation của lô mới đều yêu cầu proof cùng document hash khớp. Publisher kiểm cùng liên kết qua create operation đã verified; bỏ option proof hoặc dùng proof lô khác không mở được operation. Khóa shop, CAS, trạng thái sent/unknown, chống phát lại, biên nhận và hai lần đọc QC không đổi.

Runner có thêm `capabilityProofOperationIds` tối đa bốn UUID cụ thể, chỉ dành cho đọc bằng chứng media của operation cũ. Đường đọc này kiểm đúng shop, operation verified, source fingerprint, verification revision/item/projection, chính xác đủ thứ tự media/create/init và toàn bước ghi acknowledged. Hai readback phải khớp fingerprint tổng, hash raw/projection từng lần, shop/item và projection đã xác minh. Nó không thêm nguồn cũ vào mutation allowlist. `prepare`, `run` và `publish` nguồn cũ vẫn bị chặn khi coordinator chỉ được cấp nguồn lô mới.

Giới hạn có chủ đích: sửa nguồn sau một lần gửi thuộc lô này cần cơ chế supersession có bằng chứng riêng; không tự cho phép đổi manifest/batchId rồi gửi lại. Thay đổi này không phải nghiệm thu 80 nguồn, nhiều shop hoặc scheduler 24 giờ.

Kiểm đạt với PostgreSQL và API fixture riêng: bốn nguồn mới sau ba nguồn lịch sử, idempotency, proof đổi/ngoài phạm vi, document sai hash, proof bị chèn, và một lượt nguồn mới tạo → QC → mở bán dùng capability cũ chỉ đọc. Các bản ghi cũ được so nguyên dòng trước/sau. Lượt hồi quy ba module đạt **189/189**; sau phản biện chốt đọc capability, **3/3 ca focused** đạt gồm lượt E2E đó và hai ca mới thiếu biên nhận init/sửa raw readback. Typecheck toàn dự án đạt lúc 16:37. Không gọi đây là lượt full 191 test; root sẽ ghi lượt kiểm tổng cuối khi hoàn tất tích hợp.

Không có API thật, migration hoặc thay đổi DB ứng dụng chính trong các test này. Rà soát CLI phát hiện `getForCreate` bị gọi trước create verified, cản trở đối chiếu một operation đã đủ ACK; đã giao agent sở hữu CLI sửa và thêm hồi quy. Các ràng buộc chống gửi lại và chỉ dùng manifest server vẫn cần giữ khi nối HTTP/UI.
