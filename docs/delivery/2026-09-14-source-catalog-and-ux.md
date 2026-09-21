# Kho nguồn Vina Tươi và giao diện theo công việc — 14/09/2026

## Kết quả

Đã đọc workbook `Copy of SHOP VINA TƯƠI(AutoRecovered).xlsx` và toàn bộ danh mục thiết kế trong Canva folder `FAHUmIOUUyk`, bao gồm thư mục con `FAHU39qowfg`. Bộ nhận được lưu tại PostgreSQL của ứng dụng và bản SQLite riêng. Trang đầu **Kho listing → Dữ liệu đã nhận** đã đọc dữ liệu thật này qua API nội bộ.

Đây là bộ nội dung cần đối chiếu, chưa phải bộ sẵn sàng đăng. Không tạo sản phẩm, WorkOrder hoặc lệnh ghi Shopee từ các dòng vừa nhận. Shop thật chỉ được đọc; không lưu thuộc tính, dùng gợi ý ngành, đổi cấu hình, giá, tồn hoặc nội dung.

| Dữ liệu đã nhận | Kết quả |
| --- | --- |
| Dòng nội dung | 604: VINA TƯƠI 213, VUATINHDAU 168, TINHDAUSACHANH 96, ABURA 127 |
| Thiết kế Canva | 227 thiết kế, 5.961 trang có thông tin kích thước/thứ tự |
| Gợi ý thiết kế theo nhãn + STT | 202 dòng có một gợi ý, 10 có nhiều gợi ý, 392 chưa có gợi ý |
| ID listing trong Excel | 57 có ID; 547 chưa có ID, không được suy thành yêu cầu tạo mới |
| Ghi chú rà soát trong Excel | 386 dòng có ghi chú lịch sử; chưa khẳng định lỗi còn tồn tại |
| Giá, tồn, shop đích và SKU/model có thể thực thi | Chưa đủ; không suy từ tiêu đề, thứ tự hoặc giá trên shop cũ |

Workbook là nguồn nội dung và rà soát, không phải bảng giá KINI. Bộ phân tích riêng giữ nguyên các phiên bản văn bản và địa chỉ ô. Kiểm nguyên văn 5.043 ô chữ, tổng 6.712 ô và 6.574 tham chiếu trường; không sửa workbook. Mô tả phân loại vẫn là nội dung nguồn, không tự nhân các lựa chọn thành mọi tổ hợp.

Canva mới được kiểm kê thiết kế/trang; chưa xuất ảnh gốc hoặc gán trang vào bìa/gallery/nội dung/phân loại. Không coi ảnh preview có URL hết hạn là bản gốc. Có năm thiết kế bắt đầu bằng trang dọc, nên không mặc định trang 1 là bìa. Một thiết kế thay đổi 26→27 trang trong lúc đọc; đã đọc lại metadata và danh sách trang xác nhận, giữ cả bằng chứng trước/sau. Bản thu thập không phải snapshot nguyên tử của toàn Canva.

## Cấu trúc dữ liệu

- `source_catalogs`: phiên nhận nguồn bất biến, fingerprint và checksum.
- `source_catalog_files`: tài liệu gốc và danh tính nguồn.
- `source_catalog_listings`: từng dòng nội dung, nguyên văn, nhãn, sheet/ô và phần còn thiếu.
- `source_catalog_designs`, `source_catalog_pages`: danh mục thiết kế và trang. ID trang có thể trùng giữa thiết kế; khóa gồm cả thiết kế và trang.
- `source_catalog_candidates`: gợi ý đối chiếu, trạng thái luôn chưa xác nhận.
- `source_catalog_evidence`: bằng chứng bổ sung chỉ thêm, có hash 238 tệp, thời điểm thu thập và kết quả đọc lại.

Migrations 019–020 đã áp dụng local. Các bảng mới tách khỏi nguồn sản phẩm/công việc hiện có. Nhập lại cùng nội dung giữ biên nhận đầu; cùng fingerprint nhưng nội dung khác bị từ chối. Bảy bảng nguồn/công việc/legacy runs giữ nguyên hash so với trước lượt này.

Catalog ID: `fd983d71-dbe4-4980-a3d6-d2f90d9f117c`.

Các GET `/v1/source-catalogs`, `/:id`, `/:id/listings`, `/:id/listings/:listingId`, `/:id/evidence` cung cấp tra cứu có phân trang, tìm tiếng Việt không dấu trong tiêu đề/nội dung/phân loại và lọc nhãn. Chưa có API ghi công khai cho catalog; lượt nhận nguồn này dùng script quản trị. Nút nhập Word/ảnh/bảng giá vẫn mở luồng nhận tệp cũ, không giả vờ hỗ trợ tự nhập mọi workbook nội dung hoặc Canva URL.

## Giao diện và cách dùng

1. Mở ứng dụng, chọn **Kho listing → Dữ liệu đã nhận**.
2. Tìm tên, ID hoặc nội dung; lọc nhãn và phần cần đối chiếu. Nhãn trong Excel chưa đồng nghĩa với shop.
3. Mở một dòng, chọn **Nội dung / Phân loại / Ảnh Canva / Ghi chú & đối chiếu**. Nội dung luôn có nguồn sheet/ô; các phiên bản giữ nguyên.
4. Khi cần xem nguồn cũ, mở **Ghi chú & đối chiếu → Đối chiếu với shop cũ**. Đây là dữ liệu tham khảo chưa được áp dụng.

Bốn mục chính: Kho listing, Đăng hàng, Cập nhật listing, Theo dõi công việc. Công cụ phụ nằm trong menu Công cụ. Giữ các luồng cũ, kiểm thay đổi chưa lưu và khóa điều hướng trong khi nhận/lưu tệp. Kiểm trực tiếp kích thước 694×735 với tiêu đề nguồn dài; dòng đầu nằm trọn trong màn hình, dòng thứ hai đã xuất hiện. Chi tiết chia phần để không phải cuộn qua nhiều phiên bản văn bản dài khi tìm ảnh hoặc ghi chú.

Skill đã dùng: `redesign-existing-projects`, `verification-before-completion`, browser và spreadsheets cho phần tương ứng. Không cần cài thêm plugin. Cơ sở UX và các nguồn NN/g/GOV.UK: [báo cáo giao diện](../reviews/2026-09-14-source-catalog-ux.md).

## Kiến thức từ shop cũ

Đã đọc hai listing của `vinatuoi.vn`: `40750340260` và `29926930476`, nối tham khảo với Excel theo cả ID và tiêu đề khớp. Lưu nhãn UI, ngày đọc, shop, URL, thuộc tính và mâu thuẫn; không coi ID bài hướng dẫn ngành là API category ID.

Listing `29926930476` đang bị Shopee báo **Sai ngành hàng**. Cả hai listing có ô địa chỉ nhà sản xuất chứa tên công ty. Dung tích thuộc tính cũng không áp chung được khi các SKU có nhiều dung tích. Các tuyên bố kháng khuẩn/an toàn không được xem là đã chứng minh chỉ vì có trên shop cũ.

Đã bổ sung tài liệu và chỉ mục vào `knowledge-base/shopee-seller-observations/`. Quan sát này chưa xác minh API, chưa chấp thuận dùng lại; không tự chuyển thành rule hoặc dữ liệu đăng. Harness hiện tại chưa tự nạp toàn bộ corpus quan sát mới. [Hồ sơ quan sát](../../knowledge-base/shopee-seller-observations/documents/2026-09-14-vina-tuoi.md).

## Bằng chứng kiểm tra

Lượt kiểm tổng đạt **940/940 unit/integration**, **7/7 legacy**, typecheck và build, không bỏ qua test. Bằng chứng ở `.local/input-catalog/vina-tuoi-20260914/full-verification.json` và `full-test-results.json`. Các kiểm thử catalog gồm bất biến nguồn, lỗi mapping, nguồn/ID trùng, ranh giới catalog, truy vấn và bằng chứng; các phép HTTP/PG của catalog dùng schema riêng, chặn ghi 43 bảng nghiệp vụ và mạng ngoài.

Kiểm cuối **53/53 ca giao diện đạt**, không skip/flaky, 176 giây; báo cáo `ui-frozen-final-53.json`. Phạm vi gồm 31 ca vận hành cũ, 5 ca catalog, 17 ca knowledge/source-preview/workspace-flow. Các thao tác giả lập được chặn bằng fixture; không chạy sandbox ghi hoặc lô 80 nguồn. Root kiểm thêm dữ liệu thật 604 dòng trên ứng dụng. Sau kiểm trực tiếp đã sửa bộ đếm để tính cả các vấn đề quan sát từ shop cũ; không hiển thị “0 phần cần đối chiếu” khi tồn tại cảnh báo. Hai regression bổ sung đạt trong lượt **29/29 unit catalog** (`operational-concerns-unit-final.json`); không cộng hai ca này vào con số 940 của lượt trước. Typecheck và hai bước build sau thay đổi cuối đều đạt (`final-build.json`).

API nội bộ sau khởi động lại trả đúng 604/227/5961, một biên nhận nguồn; tìm ID29926930476 trả một dòng với 6 điểm quan sát cần đối chiếu, tìm nguyên văn không dấu `giay the thao` trả 12 dòng. Giao diện5173 trảHTTP200. Bằng chứng `local-api-check.json`; không dùng health/build thành bằng chứng đã đăng Shopee.

Không có phép đăng mới/cập nhật Shopee trong lượt này. Những kết quả này không nghiệm thu luồng đăng 80 listing doanh nghiệp nhiều shop, production, refresh token hoặc chạy 24 giờ.

## Tài liệu bàn giao tại máy

Thư mục `.local/input-catalog/vina-tuoi-20260914/` chứa README, SQLite, snapshot JSON, workbook gốc và profile, metadata Canva, biên nhận nguồn và kết quả kiểm. Đây là dữ liệu riêng của doanh nghiệp, không đưa vào Git. Bản SQLite `catalog-fd983d71dbe4.sqlite` có toàn bộ nội dung/candidate/page metadata và bằng chứng nguồn; không chứa ảnh xuất bản gốc.

Để chuyển từ kho tham khảo thành bộ đăng, còn cần luồng xác nhận phiên bản nội dung, shop đích, nguồn SKU/giá/tồn, ảnh gốc và vai trò ảnh; kiểm ngành/thuộc tính theo metadata shop đích rồi mới tạo bộ gửi. Giữ việc này tường minh, không tự ghép nguồn hoặc đổi listing để vượt kiểm tra.
