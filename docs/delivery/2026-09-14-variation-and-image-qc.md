# Phân loại và QC ảnh — 14/09/2026

**Bổ sung sau checkpoint này:** khóa Lamy lịch sử đã được giải phóng lúc15:19 bằng phiếu đối chiếu mới, giữ nguyên lịch sử. Đã thử tiêu đề qua giao diện và API sandbox thật. Đọc [bàn giao phục hồi và Tryout](2026-09-14-legacy-recovery-and-tryout.md) để lấy trạng thái mới nhất; các số và giới hạn dưới đây mô tả thời điểm14:51.

Đã bổ sung bộ lập lệnh thay đổi cấu trúc phân loại, thực thi sandbox có nhật ký từng bước và QC ảnh có đối chiếu được lưu. Ba agent làm hợp đồng/API, QC ảnh và phản biện độc lập. Chưa nghiệm thu production hoặc luồng nhập cấu trúc phân loại → worker tổng quát trên nhiều shop thật.

## API sandbox thực tế

Chỉ TEST partner1232297/shop227418363; listing kỹ thuật UNLIST. Không sửa Lamy803934364, không tạo listing trùng, không upload ảnh mới trong đợt này, không ghi production.

| Ca | Listing | Kết quả | Operation / request |
|---|---|---|---|
| Đổi tên tầng/lựa chọn một tầng | 803934786 | verified; giữ 2 model ID, SKU, giá, tồn, ảnh và trường ngoài phạm vi | de5ba333-a1b3-4e75-903d-d68faf24e9b8 / e3e3e7f35b6c624f100cfba5fa0e0d00 |
| Đảo thứ tự lựa chọn một tầng | 803934786 | verified; model ID chuyển đúng tier_index | 804ba0d4-eb64-4fd7-b7f6-d1531c48ac8c / e3e3e7f35b6c64047b4bb9156f167500 |
| Đổi tên tầng/lựa chọn hai tầng | 803934787 | verified; giữ 4 model ID và toàn bộ trường ngoài phạm vi | 7ed97014-7ab5-4b40-917a-dab28ed35713 / e3e3e7f35b6c689742921460b8992b00 |
| Thêm lựa chọn/SKU | 803934786 | blocked trước POST: PROMOTION_DETAIL_UNVERIFIED | e5159b68-f633-4d11-9d45-12ab71e4c7ad |
| Bớt một tổ hợp hai tầng | 803934787 | blocked trước POST: PROMOTION_DETAIL_UNVERIFIED | 6b3f2bf9-b58b-46e5-a7eb-72629eaf1ba5 |

Mỗi ca verified có hai readback đạt liên tiếp. Payload, nguồn mock có phiên bản và raw responses ở `.local/acceptance-20260914/variation-qc/live/<case>/`. Không chạy lại case đã có result.json.

get_item_promotion trả success_list/item_id nhưng thiếu mảng promotion. Tài liệu không định nghĩa thiếu mảng là không có chương trình. Thêm/xóa/thay model hiện yêu cầu dữ liệu chương trình đầy đủ: đây là giới hạn bảo thủ của ứng dụng, không phải lệnh cấm chung của Shopee. Đổi tên/đảo thứ tự giữ ID chỉ đi tiếp khi cờ hiện tại, giá/tồn và lượng giữ chỗ được xác nhận. Sáu hướng đổi số tầng0↔1↔2 mới kiểm bằng API fixture độc lập, chưa gửi thật.

## Cơ chế đã bổ sung

- Intent khai báo model giữ, xóa, thêm; thiếu SKU không tự hiểu là xóa. Đổi số tầng phải chỉ định thay toàn bộ model; không tái dùng ID mất hiệu lực. Về0tầng còn giới hạn SKU phải khớp item_sku đang đọc được.
- Đọc baseline trước mỗi POST, lưu sent trước HTTP, đọc lại toàn bộ sau từng bước; không chuyển bước chỉ dựa HTTP200. Kiểm cả unknown fields ngoài phần được đổi.
- Partial200, mất phản hồi, hết lease tại sent hoặc drift giữ unknown, không gửi lại. Ca phục hồi dựng từ checkpoint PostgreSQL; không gọi đây là thử kill tiến trình thật.
- Đọc lại chương trình trước mỗi bước thêm/xóa/thay model, chặn chương trình bắt đầu sau khi lập kế hoạch dù giá hiện tại chưa đổi.
- Khóa chung cho create/field/listing/media/prepared-wire/variation. Test tái hiện lỗi luồng cũ và mới cùng ghi rồi chứng minh chặn hai chiều và phân biệt chủ shop.

## QC ảnh và giao diện

Ứng dụng → **Kiểm tra ảnh** hiển thị cặp ảnh, shop/listing/vị trí, kết quả, người đối chiếu, ghi chú. Lưu nhận xét chỉ ghi nội bộ. Không nhận JSON tự khai đã duyệt làm bằng chứng.

Chỉ tự đạt nếu bytes hoặc toàn bộ pixel giải mã khớp. Độ giống thumbnail không tự đạt. Sai tỷ lệ/ảnh khác rõ → mismatch; ảnh nén/khác pixel → review_required; thiếu/hỏng → unresolved. Bộ so sánh nhóm kiểm đủ ảnh, thứ tự và vai trò. Phiếu/nhận xét bất biến, gắn operation/shop/item/role/position/source hash/output hash, có expiry, CAS và idempotency.

Bridge reconciliation chỉ thay phép so sánh tại đúng một vị trí bìa đã xác minh, rồi chạy lại toàn bộ QC trường bảo vệ. Không tạo alias toàn cục; không sửa snapshot hoặc trạng thái lịch sử.

Hai phiếu main DB:

1. `eb3cce69-85ab-45a7-bd3f-76f222247087`: gallery làm bìa đổi từ sổ xám sang thẻ xanh → mismatch. Tham chiếu PNG giải mã không mất dữ liệu từ ảnh đã đọc; không dùng làm attestation raw bytes mới.
2. `590d5d06-43d9-4ab8-b1f4-7ee168270add`: bìa sổ đã khôi phục, Shopee đổi mã/JPEG → ban đầu review_required. Hai agent xem ảnh đủ kích thước, lưu kết luận nhãn **Codex QA (agent)**, không giả là nhân viên đã duyệt. Tải lại raw bytes đúng URL quan sát, xác thực hash và đọc toàn bộ listing hai lần: reconciliation verified, basis `image_manual_review`.

Bằng chứng `.local/acceptance-20260914/variation-qc/image-cases/cover-restore-reconciliation.json`. Ca gallery sai vẫn mismatch. Hai nhật ký của đợt trước giữ nguyên, không sửa thành pass.

## Kiểm thử và ranh giới

Kiểm tổng kết thúc **14/09/2026 14:51:22 UTC+7: 865/865 unit/integration, 0 fail/skip; 7/7 legacy; typecheck và hai build đạt**. Test trình duyệt QC riêng 1/1 đạt. Tăng140 ca unit/integration so với checkpoint725 trước.

- Variation:24unit +37integration với receiver HTTP độc lập và PostgreSQL thật; đủ sáu hướng đổi số tầng, thêm/xóa/tên/thứ tự, partial200, drift, lease, nhiều worker, khóa liên luồng.
- Image:78unit/integration; ảnh gần giống sai số lượng/SKU, crop1pixel, tráo thứ tự/proof, hết hạn, ảnh lỗi, HTTPreview, giữ trường sau projection.
- Browser: `tests/e2e/image-quality.spec.ts` chạy bộ riêng, thao tác/lưu/mở lại và viewport390px, chỉlocalhost. Màu QA trong test browser không phải bằng chứng ảnh sản phẩm thực.
- Kết quả kiểm tổng cuối: `.local/acceptance-20260914/variation-qc/final-verification.json` và `final-tests.json`. Giữ kết quả RED trước để phân biệt lỗi đã tìm với bản cuối. Fixture legacy từng đặt Lamyunknown cùng chủ shop nhưng vẫn kỳ vọng tạo80; đã tách rõ chủ shop khác và bổ sung ca same-ownerunknown phải chặn. Không sửa guard/main data để ép test đạt.
- Migrations016–017 đã áp dụng. UI5173/API4310/worker đã nạp lại. Health/ready và các route QC trả JSON; đã kiểm giao diện thật bằng trình duyệt.

**Còn chặn:** main còn một Lamy listing run unknown lịch sử; khóa chung mới giữ shop. Không xóa/đổi lịch sử để mở khóa. Cần đối chiếu chỉ đọc cho lần đó và cơ chế giải quyết có bằng chứng. Variation terminalunknown cũng chưa có API reconciliation mở lại lane. Chưa được tuyên bố worker không giám sát/productionE2E hoàn chỉnh. Thêm/xóa thật và đổi số tầng thật cần nghiệm thu khi đủ dữ liệu chương trình và giải quyết lane. Service variation hiện là đường sandbox riêng, chưa nối màn hình import cấu trúc tổng quát.

Nguồn có ngày cụ thể: [hợp đồng phân loại](../research/2026-09-14-variation-mutations.md), [thiết kế QC](../reviews/2026-09-14-image-qc-design.md), [đợt patch trước](2026-09-14-patch-scenarios.md). Truy cập lại nguồn Shopee hiện trả403; không coi snapshot là xác minh policy hiện hành.
