# Rà soát lượt đọc khi đăng mười listing ngày 16/09/2026

**Chỉ điều tra bằng hồ sơ và mã local; không sửa runtime, khởi động lại API, gọi Shopee hoặc ghi DB.** Phạm vi đếm chốt ở **04:39:11 UTC / 11:39:11 UTC+7**, chỉ nhóm Trà Trắng, Sả Chanh, Phong Lữ và Rừng Thông. Nhóm này đã có kết quả `published` cho cả bốn lúc 04:39:10.848 UTC. Đây không phải kết quả cuối của cả mười listing.

Kết luận: hai lỗi `error_rate_limit` xuất hiện trên GET kiểm tra sản phẩm. Đường đọc này chưa dùng bộ điều tiết/backoff chung của metadata. Đồng thời, cache chỉ sống trong một lượt chạy khiến mỗi lần tiếp tục đọc lại 41 trang thương hiệu. Các quan sát xác nhận tải đọc có thể giảm và cơ chế xử lý lỗi chưa đồng nhất; **chưa đủ dữ liệu để suy ra quota thực hoặc chứng minh riêng một thành phần gây Shopee giới hạn**.

## Dữ liệu đếm được

[Báo cáo máy đọc và hash từng receipt](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/orchestration/read-pressure-first-group.json) chứa **678 GET**, đủ 678 request ID, không có receipt trùng theo endpoint/request ID, tất cả nằm trong 11 lượt chạy đã kết thúc. **484 lần tái dùng cache được tách riêng**, không tính là GET mới. Không cộng bản sao `input.json`, request/claim của job hoặc response lưu lặp bên trong envelope.

Phạm vi loại trừ đọc metadata ở bước chuẩn bị trước đó, kho kiến thức seller, công cụ bên ngoài, POST và tải ảnh CDN. Vì vậy 678 là số chính xác trong các thư mục được kiểm, **không phải tổng lưu lượng ứng dụng/shop trong ngày**. `observedAt` ghi lúc nhận xong; hai GET base/models của runner dùng chung thời điểm hoàn tất cặp. Không dùng số này để suy ra thời điểm gửi từng request hoặc QPS thực.

| Nhóm endpoint | GET thực |
| --- | ---: |
| Danh sách thương hiệu | 451 |
| Model sản phẩm, gồm 22 lần đọc model tham chiếu kho | 75 |
| Thông tin cơ bản sản phẩm | 53 |
| Thông tin shop / giới hạn ngành / kho | 22 mỗi loại |
| Cây ngành / thuộc tính / kênh vận chuyển | 11 mỗi loại |
| **Tổng** | **678** |

572 GET thuộc thu thập preflight nguồn; 68 thuộc QC sau tạo; 38 thuộc kiểm trước/sau mở bán. Các receipt kho có **22 `warehouse.error_not_in_whitelist`** được collector nhận diện theo nhánh xử lý kho hiện có; không gộp chúng thành 22 lỗi rate limit. Có đúng **hai** receipt `error_rate_limit` trong phạm vi.

| Bắt đầu UTC | Mode | Thời gian máy chạy, giây | GET | Cache tái dùng | Kết quả cuối lượt |
| --- | --- | ---: | ---: | ---: | --- |
| 03:58:06.714 | inspect | 48,159 | 60 | 132 | Kiểm nhóm bốn |
| 04:01:09.631 | execute | 52,427 | 50 | 0 | Trà Trắng chờ QC bìa |
| 04:09:00.426 | reconcile | 60,194 | 58 | 0 | Trà Trắng chờ xử lý cân |
| 04:10:41.930 | execute | 74,183 | 74 | 88 | Trà Trắng mở bán; Sả Chanh chờ QC bìa |
| 04:14:04.222 | reconcile | 61,248 | 58 | 0 | Sả Chanh chờ xử lý cân |
| 04:15:51.367 | execute | 75,286 | 74 | 88 | Sả Chanh mở bán; Phong Lữ chờ QC bìa |
| 04:22:36.785 | reconcile | 59,745 | 58 | 0 | Phong Lữ chờ xử lý cân |
| 04:23:46.510 | execute | 73,491 | 70 | 88 | Phong Lữ mở bán; Rừng Thông chờ QC bìa |
| 04:28:25.645 | reconcile | 59,475 | 58 | 0 | Rừng Thông chờ xử lý cân |
| 04:29:35.183 | execute | 40,818 | 58 | 44 | Rừng Thông dừng ở đọc trước mở bán |
| 04:38:28.785 | execute | 42,063 | 60 | 44 | Rừng Thông mở bán; nhóm bốn hoàn tất |

Thời gian trong bảng là `finishedAt − acceptedAt` của child job, không gồm thời gian người vận hành xem ảnh/xác nhận và không phải thời gian riêng Shopee.

## Hai lỗi và đường phục hồi

**Sả Chanh, 04:16:23.082 UTC:** `get_item_base_info` bị rate limit trong create readback. Runner giữ operation/ACK đã có, ghi marker `create_read_only_reconciliation` chờ 1 giây rồi chỉ đọc lại. Lượt kết thúc với Sả Chanh `published`. Receipt: [4797f5f0](C:/shopee_product_uploader/.local/production-batch-pass1-20260915/wire-evidence/ba7f975c-ba26-44d7-873c-7264f4d8438c/3ecb979b-619d-491f-a07e-4deea348c8ca/4797f5f0-006e-4283-8377-a63ea59428bf.json), request ID `e3e3e7f35b91ee131cd9a9402d691c00`.

**Rừng Thông, 04:30:15.997 UTC:** base bị cùng lỗi, models thành công. Kết quả lượt là `PUBLICATION_PREFLIGHT_UNAVAILABLE`. Theo nhánh [publishOnce](C:/shopee_product_uploader/apps/api/src/production-pilot-runner.ts:985), lỗi này trả về **trước authorizePublication và lệnh mở bán**. Nó không thuộc danh sách tự thử lại sau publication ACK. Receipt: [38bae584](C:/shopee_product_uploader/.local/production-batch-pass1-20260915/wire-evidence/ba7f975c-ba26-44d7-873c-7264f4d8438c/b8d0e811-9f88-4a3a-92dc-b64698024f59/38bae584-ac29-4a2e-88e0-a485fbb948e1.json), request ID `e3e3e7f35b921fb843ce81c0cf1ded00`.

Lần tiếp tục cùng công việc được child nhận lúc 04:38:28.785; [kết quả 04:39:10.848](C:/shopee_product_uploader/.local/production-batch-pass1-20260915/web-jobs/ba7f975c-ba26-44d7-873c-7264f4d8438c/bc79f86a-a9cc-4e9d-adb5-42a9807eb274.result.json) ghi bốn listing `published`. 60 GET của lượt này gồm 52 preflight nguồn và 8 kiểm publication, **không có create readback mới**. Đây là phục hồi công việc đã lưu, không phải lý do tạo lại listing. Báo cáo này không thay audit mutation journal cuối.

## Cơ chế hiện có và chỗ đọc lặp

| Đường đọc | Điều tiết/thử lại hiện tại | Giới hạn bằng chứng |
| --- | --- | --- |
| Source preflight | Pacer chung trong process, tối thiểu 500 ms giữa điểm bắt đầu; tối đa 4 lần với chờ 1/3/7 giây khi đúng envelope `error_rate_limit` có request ID | Các số là chính sách nội bộ, không phải quota Shopee |
| Create/publication readback | Gọi `transport.read` trực tiếp; chờ 25 ms trước cặp đầu, 500 ms trước cặp thứ hai; không dùng pacer trên | Pacer của metadata không bao phủ QC |
| Reconcile sau ACK | Có thể đọc lại sau 1/3/7/15 giây, chỉ với mã lỗi định sẵn và bằng chứng ACK hợp lệ | Publication **preflight** chưa có ACK không vào vòng này |
| Seller knowledge | Đọc tuần tự; 150 ms trước lần đầu, thử lại tối đa 3 lần với chờ 1/2 giây cho nhóm lỗi GET tạm thời; lưu mọi receipt | Không chia sẻ ngân sách với pilot; chưa có bằng chứng KB chạy đồng thời hai thời điểm lỗi trên |

Nguồn mã: [scheduler](C:/shopee_product_uploader/apps/api/src/production-pilot-read-scheduler.ts:29), [publication reads](C:/shopee_product_uploader/apps/api/src/production-pilot-runner.ts:859), [create reads](C:/shopee_product_uploader/apps/api/src/production-pilot-runner.ts:1235), [reconcile](C:/shopee_product_uploader/apps/api/src/production-pilot-runner.ts:1045), [KB](C:/shopee_product_uploader/apps/api/src/seller-knowledge-service.ts:245).

**Thương hiệu:** 11/11 lượt đều đọc 41 trang từ cursor 0 đến trang chứa đúng brand. Tổng 451 GET chiếm 66,52% số đọc. Collector dừng khi tìm đúng ID/tên, không đọc hết mọi brand. [Read session](C:/shopee_product_uploader/apps/api/src/production-pilot-read-session.ts:18) mặc định 120 giây, giới hạn tối đa 300 giây, cache ngành/thuộc tính/brand/kênh với scope + revision + query. Nhưng [batch runner tạo session mới mỗi lần chạy](C:/shopee_product_uploader/apps/api/src/production-batch-runner.ts:240), kể cả resume ngay sau reconcile. Cache hữu ích trong lượt — đã tránh 484 GET — nhưng không sống qua các lượt. Không coi cả 451 GET đều bỏ được: dữ liệu hết TTL vẫn phải đọc mới.

**Cân làm tròn:** cả bốn lượt reconcile đều có mismatch chỉ `item.weight` và ba `model.weight`. Mỗi lượt vẫn thử thêm bốn lần, mỗi lần một cặp base/models, rồi trả cùng mismatch. Tổng **16 vòng bổ sung = 32 GET và 104 giây chờ theo cấu hình**. Đây là phần có thể dừng sớm khi đã xác định cần phiếu HIL; chưa được phép tự coi số làm tròn là đúng. Thiếu QC bìa đã có mã riêng và dừng ngay, không bị vòng lặp này.

## Đề xuất cho lượt cải tiến sau

1. **Đưa mọi GET Shopee qua cùng một scheduler có scope và lưu thời điểm được đọc tiếp.** Bao phủ metadata, QC, publication preflight và KB; ưu tiên công việc đang phục hồi, giữ ngân sách riêng khi cần. Khi có rate limit, dừng các GET phụ thuộc và áp dụng backoff có giới hạn; chỉ nhận `Retry-After` nếu response thật có header và được kiểm hợp lệ. Không đoán quota hoặc đổi POST thành cơ chế tự retry. Chưa có header retry trong receipt hiện tại để suy thời gian chờ bắt buộc.
2. **Lưu cache metadata qua resume trong phạm vi nguồn đã ràng buộc.** Giữ nguyên scope/revision/category/query, hash nguồn và timestamp receipt; tuổi cache dùng timestamp gốc. Hết TTL, token revision đổi hoặc nguồn đổi phải vô hiệu. Có thể dùng trang/cursor brand đã được chứng minh cùng ngành để đọc xác nhận có mục tiêu, với fallback phân trang nếu không khớp; cần test dữ liệu dịch trang, tên/ID đổi và phạm vi shop khác. Không tái dùng cursor khác ngành hoặc hardcode một số trang làm chân lý. Không cache QC base/models hoặc bỏ đọc kho/tồn bắt buộc.
3. **Phân biệt “cần phiếu cân” với chậm đồng bộ.** Khi chỉ chênh lệch cân trong trường hợp đã nhận diện, trả trạng thái chờ HIL cụ thể để người vận hành dùng bằng chứng thực; giữ cân nguồn nguyên vẹn. Sau phiếu đúng operation/model/SKU vẫn cần hai readback mới đạt. Không tự cấp phiếu, nới tolerance hoặc xóa raw mismatch.
4. **Hiển thị chờ giới hạn và tiến độ có thể tiếp tục.** Parent lưu nguyên ID/operation, hiển thị tên sản phẩm, lý do và thời điểm kiểm tiếp; không khiến timeout UI giống thất bại. Preview dựng nguồn cũng cần chạy bền vững có tiến độ, theo vấn đề 93 giây đã ghi trong [bàn giao](../delivery/2026-09-16-ten-listing-pilot.md).

Kiểm hồi quy cần có: mọi đường GET dùng scheduler; 429/API error đúng và response không đủ request ID; resume sau crash vẫn giữ cooldown; cache không vượt TTL/revision/scope; chênh lệch cân chờ HIL không lặp vô ích; readback sau HIL vẫn cần đủ hai lần; lỗi preflight không gửi publication; ACK/unknown không replay create/init/upload/publication. Các thay đổi trên **chưa triển khai hoặc nghiệm thu** trong lượt điều tra này.

## Đối chiếu tài liệu Shopee

Đã tra kho snapshot **08/09/2026**, đọc hướng dẫn và phần liên quan của endpoint, đối chiếu với receipt live **16/09/2026**. [Developer Guide 16](https://open.shopee.com/developer-guide/16), nguồn cập nhật 21/11/2025, nêu request ID riêng cho mỗi request và ý nghĩa error/warning. [get_item_base_info](https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1), cập nhật 03/04/2026, và [get_model_list](https://open.shopee.com/documents/v2/v2.product.get_model_list?module=89&type=1), cập nhật 31/07/2026, phân biệt `error_rate_limit` với `error_limit` của hạn mức ngày. Lỗi thực tế ở đây là loại thứ nhất.

Mục rate-limit trong bản nguồn endpoint lưu `[0,0,0]`; **không coi đó là quota bằng 0, không giới hạn, hoặc một tốc độ được cấp cho shop**. Không có lần tra online mới trong điều tra này theo phạm vi root giao. Khi cần chốt cấu hình vận hành dài hạn phải lấy hạn mức thực từ nguồn Shopee chính thức/app console, không biến tốc độ nội bộ 500 ms hoặc thời gian nghỉ thực tế thành chính sách Shopee.

Hồ sơ local có thể tái lập bằng [script chỉ đọc tệp](C:/shopee_product_uploader/.local/vina-input-preparation-20260916/orchestration/analyze-read-pressure.mts). Script ghi báo cáo nghiên cứu; không có HTTP, SQL hoặc lệnh khởi động lại. Quy trình vận hành hiện hành vẫn là [runbook mười listing](../runbooks/2026-09-16-ten-listing-orchestration.md).
