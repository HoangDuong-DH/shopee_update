# Cam Sả: sửa chặn sai khi mở lại thư mục

Ngày kiểm: 16/09/2026. Phạm vi: nhập nguồn local, không gửi hoặc cập nhật Shopee.

## Nguyên nhân và thay đổi

- `compareManifestSavedDraft` so sánh JSON của các đoạn mô tả, nhưng giữ nguyên thứ tự khóa của object text. PostgreSQL JSONB đọc lại `{text, type}` khác với `{type, text}` do bộ nhập sinh ra dù chữ và xuống dòng giống hoàn toàn. Đã chiếu tường minh `type/text` trước khi so sánh. Vẫn chặn thay đổi chữ, xuống dòng, hash ảnh và thứ tự đoạn.
- `assembleFolderListing` mang theo cảnh báo `DUPLICATE_SKU` của toàn bảng giá sau khi đã chọn được chính xác một dòng trong đúng bộ giá. Chỉ loại cảnh báo này sau khi scope/rowKey khớp duy nhất; nhiều dòng cùng scope chưa chọn rõ vẫn bị chặn. Các issue nguồn khác giữ nguyên.

## Bằng chứng

- 19/19 kiểm thử tập trung đạt; typecheck đạt. Báo cáo private `.local/hidden-manual-20260916/cam-sa-import-hotfix-green.json` và các lượt RED/GREEN JSONB/duplicate riêng.
- Đã mở lại chính intake `7ff1ce9c-e7a3-462d-afb3-b0163f795a63` qua UI thật, bản lưu lúc 17:08:36 UTC+7. Không yêu cầu người dùng tải lại.
- Màn nguồn hiện 15/15 tệp, DORIS / FILE GIÁ DORIS / SHOP MALL; ba SKU đúng thứ tự: VTTDCS300 = 235998, VTTDCS100 = 119998, VTTDCS500 = 331998.
- Không còn cảnh báo khác mô tả hoặc trùng SKU đã giải quyết; `Mở bộ đã lưu` bật ở danh sách và cuối nội dung. Tab `SKU & giá` được để mở cho người dùng tiếp tục.
- Đối chiếu private `.local/vina-input-712-836-20260916/cam-sa-main-mismatch-readonly-audit.json`: bản nguồn được giữ nguyên, 15 tệp bản sao khớp hash; không sửa nội dung để vượt kiểm tra.

## Phạm vi chưa bao gồm

Đây là sửa lỗi nhập/mở lại Cam Sả, không phải bằng chứng đã đăng sản phẩm. Luồng đăng đang do người dùng tự bấm. Không restart API, không thay đổi nguồn sản phẩm, không ghi shop. Phần UI portable identity/pending SKU còn đang chuẩn bị; hoãn HMR các component đang dùng để không làm mất màn thử của người dùng.
