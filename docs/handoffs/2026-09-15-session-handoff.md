# Bàn giao dự án Shopee Product Uploader

> **Cập nhật mới nhất 15/09 lúc 15:47 UTC+7:** đọc **mục 18** và [hồ sơ lô production](../delivery/2026-09-15-bulk-continuation.md) trước các phần lịch sử. Hai listing **51467852283 / 51267858328**, tổng **15 SKU**, trên shop **1423724897** đã đăng qua backend API, mở bán và đọc lại verified. Người dùng đã cấp quyền riêng cho lô này; kết nối revision2 sau refresh thành công. Không phát lại các intent đã hoàn tất. Các đoạn dưới ghi chỉ đọc production, chưa kết nối hoặc row65 chưa gửi là lịch sử trước quyền/kết quả mới. Chưa nghiệm thu production tổng quát 80 listing nhiều ngành/shop hay 24 giờ.

**Ngày tổng hợp:** 15/09/2026, múi giờ UTC+7.  
**Mục đích:** đưa file này cho session khác để tiếp tục dự án mà không phải đọc lại toàn bộ hội thoại, không làm mất dữ liệu và không hiểu nhầm mức độ hoàn thiện.  
**Workspace hiện tại:** `C:\shopee_product_uploader`.  
**Phạm vi bản bàn giao ban đầu:** hồ sơ triển khai, mã nguồn và biên nhận đến ngày 14/09/2026. Các mục cập nhật cuối tài liệu bổ sung phép thử production thật ngày 15/09; luôn ưu tiên checkpoint mới nhất có bằng chứng.

> **Giới hạn cần giữ nguyên:** dự án đã có ứng dụng local, kho dữ liệu thật, các luồng nhập/cập nhật được kiểm thử, nhiều phép thử sandbox và lô production 2 listing tại mục 18. **Chưa nghiệm thu trọn luồng nguồn doanh nghiệp → 80 listing nhiều ngành/nhiều shop thật hoặc chạy bền 24 giờ.** Quyền ghi production chỉ áp dụng đúng lô/shop được người dùng chốt, không suy rộng sang shop khác.

**Cách đọc:** đọc mục 1–3 để nắm mục tiêu/quyền; mục 4–6 để biết dữ liệu và mã hiện có; mục 7–8 trước mọi kiểm thử; mục 9–12 để tiếp nối. Mục 13 có prompt ngắn có thể đưa cho session mới. Nếu session không truy cập được workspace, phải nói rõ chỉ đang đọc bàn giao, chưa tự xác minh code hoặc trạng thái hệ thống.

## 1. Đọc nhanh trước khi làm bất cứ việc gì

1. Người dùng muốn ứng dụng nội bộ cho nhân viên không rành kỹ thuật: đăng mới và điều chỉnh hàng loạt **listing đã được bên họ chuẩn bị đầy đủ**.
2. Không tự sáng tác sản phẩm, viết lại nội dung, tạo/crop ảnh, gộp/tách listing hoặc thay cấu trúc phân loại để vượt kiểm tra.
3. Đầu vào chính: **một thư mục mỗi listing, gồm Word và ảnh; bảng giá Excel dùng chung**. Cập nhật cũng phải nhập tệp thay đổi, không bắt gõ lại từng SKU.
4. Dữ liệu Vina Tươi đã nhận: **604 dòng nội dung, 227 thiết kế Canva, metadata 5.961 trang**. Chưa xuất toàn bộ ảnh gốc, chưa thành 604 bộ sẵn sàng đăng.
5. DORIS đã nhận: **800 SKU tinh dầu duy nhất có giá SHOP MALL**. Chưa gắn vào 604 dòng nội dung; giá shop thường đang trống. Không còn đúng nếu nói “chưa có file giá tinh dầu”.
6. Lamy sandbox cũ **803934364** đã có phiếu đối chiếu trạng thái hiện tại và giải phóng khóa. Run lịch sử vẫn `unknown`; **không gửi lại hoặc sửa lịch sử cho thành công**.
7. Các bộ kiểm thử 80 nguồn nghiệp vụ và HTTP wire có phần **giả lập Shopee**, phải tách khỏi kết quả sandbox thật 76/80 nguồn kỹ thuật.
8. Writer chính cho nguồn doanh nghiệp chưa được nối hoàn chỉnh. Nút **Thử sandbox** là đường kỹ thuật riêng, không chứng minh toàn bộ ứng dụng đã phát hành.
9. Mã hiện tại có nhiều thay đổi chưa commit. **Chỉ clone GitHub/HEAD sẽ thiếu đáng kể công việc mới và toàn bộ dữ liệu private**.
10. Ưu tiên tiếp nối: hoàn thiện liên kết nguồn có bằng chứng → nối một luồng doanh nghiệp thật có kiểm soát → nghiệm thu cập nhật/giữ nguyên trường → vận hành bền. Không tiếp tục đổi giao diện mà bỏ qua hợp đồng dữ liệu.

## 2. Yêu cầu và các quyết định nghiệp vụ đã chốt

### 2.1. Mục tiêu sử dụng

- Ban đầu khoảng 50–80 **sản phẩm khác nhau** mỗi ngày; mỗi sản phẩm có các phân loại riêng. Không phải 80 bản sao của một listing.
- Quản lý nhiều shop, gồm Mall và shop thường. Người dùng nói ứng dụng Open Platform đã được duyệt production; quyền từng API/shop thực tế vẫn phải xác minh riêng.
- Đăng mới và cập nhật một hoặc nhiều nhóm: tiêu đề, mô tả, ảnh bìa, gallery, ảnh trong mô tả, ảnh phân loại, giá, tồn, thuộc tính, vận chuyển, cấu trúc phân loại khi được yêu cầu rõ.
- Ứng dụng nội bộ, ưu tiên năng suất; bản đầu không cần đăng nhập nhân viên, MFA hoặc quy trình duyệt nhiều người. Kết nối Shopee, lưu token phía server, nhận diện đúng shop và chống ghi trùng vẫn cần giữ.
- Không có bằng chứng về công suất tối đa/24 giờ. Không đưa số cam kết từ tốc độ một request hoặc bộ mô phỏng.

### 2.2. Nội dung và ảnh thuộc quyền quyết định của người dùng

- Bên người dùng đã làm sản phẩm, nội dung, cấu trúc listing và ảnh. Ứng dụng tiếp nhận, ánh xạ, kiểm tra và thực thi đúng nguồn.
- Giữ nguyên văn bản, tệp gốc, tên và thứ tự phân loại đã được chọn. Mọi thay đổi phải có yêu cầu cụ thể và phiên bản.
- Ảnh phân loại có thể nằm lẫn trong thư mục ảnh listing; nhận ra bằng nội dung hình, không có quy tắc tên tệp chắc chắn. Không tự đoán rồi coi là đã xác nhận.
- Bìa chuẩn bị 1:1; gallery còn lại 3:4. Tách vai trò bìa, gallery, ảnh mô tả và ảnh phân loại, kể cả khi dùng chung một tệp.
- Riêng Lamy: tiêu đề mở đầu trong Word → dòng trống → đủ g1–g9 đúng thứ tự → dòng trống → phần chữ còn lại.
- Thiếu dữ liệu hoặc mơ hồ phải hiện ngoại lệ cụ thể, không sửa nguồn để làm test xanh.

### 2.3. Giá và tồn

| Nội dung | Quy tắc đã chốt |
| --- | --- |
| GIÁ GỐC | Khi đăng mới, đưa vào `original_price`, đúng bộ giá áp dụng cho shop/SKU. |
| GIÁ BÁN | Giá mục tiêu của bước khuyến mại riêng; không tự tạo chương trình bằng tỷ lệ hai cột. |
| Flash Sale/khuyến mại | Cần kiểm tra riêng quyền, dữ liệu chương trình và điều kiện hiện hành; chưa nghiệm thu đầy đủ. |
| Tồn kho ảo | Người dùng được đặt mức đăng bán thủ công theo từng SKU/shop; không mặc định bằng tồn vật lý. |
| Ô tồn trống | Thiếu nguồn, không phải 0. Không tự điền, sao chép sang shop khác hoặc tự bù sau đơn hàng. |
| Tồn Lamy 100/model | Chỉ là số thử được cho phép cho sáu SKU trên sandbox 227418363, không là mặc định doanh nghiệp. |
| Giá DORIS shop thường | Chưa được xác nhận dùng chung giá Mall. Không tự áp dụng. |

### 2.4. Cập nhật bằng tệp và patch

Luồng mục tiêu: nhập Excel giá/tồn mới hoặc Word/ảnh mới → xác định chính xác listing/SKU/shop → chọn nhóm thay đổi → xem trước giá trị cũ/mới → thực thi → đọc lại cả phần đổi và phần phải giữ.

- Chỉ cập nhật trường được chọn và có nguồn; không gửi lại toàn bộ listing thiếu kiểm soát.
- Không coi ô trống là lệnh xóa; xóa phải là ý định rõ ràng nếu trường/API cho phép.
- Không nối SKU theo thứ tự dòng, chuỗi gần giống hoặc một kết quả tìm kiếm chứa nhiều mã.
- Không âm thầm cập nhật listing ngoài bộ được chọn. Nguồn có sẵn ID chưa chứng minh đúng shop hoặc đúng model.
- Tách số giá trị cập nhật, số SKU, số listing, số shop và số bản ghi theo bộ giá khi thống kê.

## 3. Quyền thao tác và cách đọc bằng chứng

### 3.1. Giới hạn quyền hiện tại

**Shop thật:** chỉ nghiên cứu/đọc dữ liệu listing, cấu hình liên quan. Không lưu sản phẩm, thay giá/tồn, tải ảnh, chọn gợi ý ngành, đăng ký Mall, thay cấu hình, tạo chương trình hoặc ghi API production.

**Sandbox:** đã được phép kiểm thử trong đúng môi trường TEST, nhưng phải giữ phạm vi dữ liệu thử, guard và nhật ký. Không phát lại lệnh cũ để “thử lại cho chắc”, không chuyển sang LIVE token nếu TEST lỗi.

Thông tin định danh không phải bí mật: partner TEST `1232297`, shop TEST `227418363`, vùng VN, host `https://openplatform.sandbox.test-stable.shopee.sg`. Tên nội bộ shop: **Shop thử nghiệm VN**. Chỉ có một kết nối sandbox thật được chứng minh; các shop khác trong bộ nghiệm thu là fixture.

Khóa, access token, refresh token, `.env` và cấu hình mã hóa không được đưa vào tài liệu/chat. Người dùng nhập qua UI kết nối. Revision kết nối cuối ghi nhận là 7, capability 6; **không suy ra token còn hiệu lực ngày 15/09**.

### 3.2. Bốn cấp bằng chứng không được trộn

| Cấp | Chứng minh được | Không chứng minh được |
| --- | --- | --- |
| Unit/integration với fixture | Logic, hợp đồng, trạng thái, lỗi giả lập, một phần DB thật | API Shopee thật chấp nhận, quyền shop, policy hiện hành |
| Browser + API + PostgreSQL local | Người dùng thực hiện luồng UI, lưu/đọc dữ liệu thật tại máy | Outbound Shopee thật nếu vẫn dùng fixture |
| API backend → sandbox thật → readback | Phép thử cụ thể trên shop/item TEST tại thời điểm ghi | Production, mọi ngành/shop hoặc toàn bộ luồng doanh nghiệp |
| Production pilot | Chỉ có thể kết luận khi được cấp quyền và có bằng chứng thực tế | **Chưa thực hiện/nghiệm thu trong dự án này** |

`acknowledged` là biên nhận API, không phải tự động `verified`. HTTP 200 có thể kèm lỗi nghiệp vụ. Phản hồi ghi có thể trả dữ liệu trước thay đổi; model có thể khác thứ tự đầu vào. Mất phản hồi sau gửi phải giữ outcome chưa rõ và đối chiếu bằng đọc, không tự resend.

## 4. Kho nguồn đã nhận và các liên kết còn thiếu

### 4.1. KINI và bộ Lamy chuẩn

- Excel: `C:/Users/Admin/Desktop/FILE KINI (MẸ & BÉ, BCS).xlsx`.
- Word: `C:/Users/Admin/Downloads/Lamy_5D_Tieu_De_Va_Content.docx`.
- Sản phẩm thử đúng: **khẩu trang Lamy 5D**; không nhầm thành khăn giấy từ cách gọi trước đó.
- Sáu SKU: `LMKT5DT100`, `LMKT5DT300`, `LMKT5DT500`, `LMKT5DD100`, `LMKT5DD300`, `LMKT5DD500`.
- Canva: <https://www.canva.com/design/DAHUeVfNBwM/bmnOXDVD0tvY64fG3O-flQ/edit>.
- Đã xuất 25 PNG gốc ngày 10/09; thư mục `docs/research/shopee-lamy-listing-2026-09-10/assets/`, manifest có kích thước/hash.
- Trang 1 bìa; trang 2–10 là g1–g9; trang 11–16 là ảnh trắng 100/300/500 rồi đen 100/300/500.
- Bộ nguồn: `docs/research/shopee-lamy-listing-2026-09-10/prepared-source-bundle.json`. Source key `lamy-5d`, revision 1 phải được giữ.
- Listing sandbox `803934364`, sáu model `4258853357`–`4258853362`. Không tạo bản Lamy trùng.
- Từng đăng NORMAL với giá KINI GIÁ GỐC, 100/model, các vai trò ảnh riêng. Đây là kết quả lịch sử, không phải lần kiểm tra trạng thái mới ngày 15/09.
- Brand LAMY `2003493820` từng pending sau đăng ký thử; tạo listing thành công không tương đương thương hiệu đã duyệt QC.
- Kênh SPF Mart `50040` nhận giá thử; SPX/Economy từng có giới hạn giá ở UI sandbox. Không biến hành vi đó thành quy tắc/default production.

### 4.2. Catalog nội dung Vina Tươi

Nguồn Excel: `C:/Users/Admin/Downloads/Copy of SHOP VINA TƯƠI(AutoRecovered).xlsx`. Canva folder: <https://www.canva.com/folder/FAHUmIOUUyk>, có thư mục con `FAHU39qowfg`.

| Nhóm | Dòng nội dung |
| --- | ---: |
| VINA TƯƠI | 213 |
| VUATINHDAU | 168 |
| TINHDAUSACHANH | 96 |
| ABURA | 127 |
| Tổng | **604** |

- Catalog ID: `fd983d71-dbe4-4980-a3d6-d2f90d9f117c`.
- Lưu PostgreSQL và bản riêng `.local/input-catalog/vina-tuoi-20260914/catalog-fd983d71dbe4.sqlite`.
- Kiểm nguyên văn 5.043 ô chữ, tổng 6.712 ô và 6.574 tham chiếu trường. Giữ sheet/ô và các phiên bản nội dung, không tự nhân mọi tổ hợp phân loại.
- 57 dòng có ID listing; 547 dòng thiếu ID **không tự trở thành yêu cầu đăng mới**. 386 dòng có ghi chú lịch sử, không phải toàn bộ lỗi còn hiện hành.
- 227 thiết kế, 5.961 trang **metadata**, chưa tải toàn bộ ảnh gốc. 202 dòng có một gợi ý thiết kế, 10 nhiều gợi ý, 392 chưa có gợi ý; tất cả chưa phải mapping được duyệt.
- Có năm thiết kế mở đầu bằng trang dọc; không mặc định trang đầu là bìa. Không dùng preview/URL hết hạn thay bản gốc.
- Thiết kế `DAHVJ_GzdT4` thay 26→27 trang trong lúc thu thập; đã đọc lại, giữ bằng chứng trước/sau. Không gọi toàn bộ Canva là snapshot nguyên tử.
- 238 tệp bằng chứng có hash, giữ trong kho `.local/input-catalog/vina-tuoi-20260914/` và bảng evidence. Khi đối chiếu kỹ thuật, lấy fingerprint/checksum từ biên nhận gốc.
- API catalog hiện chỉ GET. Lần nhập này dùng script quản trị, chưa có luồng UI tổng quát nhập Canva/workbook nội dung → xác nhận → publish.
- Workbook nội dung này **không được nhập bằng parser bảng giá KINI**.

### 4.3. DORIS: đã có giá và thông tin tinh dầu

Nguồn: `C:/Users/Admin/Desktop/FILE GIÁ DORIS.xlsx`. Import/pricebook ID `6bea45ed-8211-41c2-9f6f-4d8416f9af12`.

SHA-256 file: `2642c4182a41a39cb01b0acde0f70d5b1c8d50c8daba640c942c281bf5930750`. Nguồn/audit tại `.local/input-catalog/doris-20260914/`; không commit.

| Nhãn nguồn | Dòng bảng chính | SKU duy nhất |
| --- | --- | ---: |
| VINA TƯƠI | 759–1041 | 283 |
| ABURA | 532–757 | 226 |
| VUATINHDAU | 1042–1190 | 149 |
| TDSC | 1191–1332 | 142 |
| Tổng tinh dầu | | **800** |

Header dòng 2: B tên, C thương hiệu, D ngành, E SKU, F URL ảnh, H đơn vị tính theo VAT, I cân nặng thực(g), J cân nặng khai báo(g).

| Cột | Bộ giá | Hiện trạng 800 SKU tinh dầu |
| --- | --- | --- |
| K/L | GIÁ GỐC/GIÁ BÁN — SHOP THƯỜNG | Trống |
| M/N | GIÁ GỐC ĐẶC BIỆT/GIÁ BÁN ĐẶC BIỆT — SHOP THƯỜNG | Trống |
| O/P | GIÁ GỐC/GIÁ BÁN — SHOP MALL | Đủ |

- Không tự lấy Mall điền shop thường. Người dùng **chưa trả lời** câu hỏi áp dụng giá Mall cho shop thường hay dùng bảng riêng.
- `TDSC` chưa được xác nhận là alias `TINHDAUSACHANH`; không tự nối hai nhãn.
- 800 SKU có tên, thương hiệu, đơn vị, URL ảnh, hai loại cân nặng và giá Mall; **674 thiếu ngành**, chưa có tồn đăng bán, shop/model đích, kích thước vận chuyển và thuộc tính đầy đủ.
- Bảng chính 1.325 dòng SKU, các bảng cấu trúc toàn workbook 1.727 dòng; parser trả **4.377 bản ghi theo bộ giá**, không phải 4.377 sản phẩm.
- Giữ ba bộ giá, header locators, đơn vị và thông tin ẩn. K:N bị ẩn vẫn được đọc, không bỏ hoặc tự chấp nhận mọi dữ liệu ẩn.
- DHC ẩn 86 dòng và FILE DHC cột giá mơ hồ vẫn bị chặn; viegreen chưa mapping. Các vùng Q:AM có sản phẩm khác A:P trên cùng dòng, 2.445 ô phụ giữ riêng, không ghép theo vị trí.
- Công thức xuất từ Google Sheets dùng kết quả cache của file; không gọi Google Sheets, không thực thi hàm hoặc tuyên bố giá đã được làm mới online.
- 12 SKU can 5L từ listing tham khảo tìm được duy nhất ở dòng 1018–1029: giá gốc 2.179.998đ, giá bán 1.089.999đ, thực 4.750g, khai báo 5.225g, ĐVT Can. Đây chưa là mapping shop/model được phê duyệt.
- Ví dụ `VTSCC5L` dòng 1018; tìm chuỗi có thể hiện thêm `VTSCC5L300`. Phải khớp SKU chính xác, không chọn theo dòng đầu.
- **Đã nhập vào kho giá ứng dụng nhưng chưa nối SKU/giá vào catalog 604 dòng.** Không yêu cầu người dùng nộp lại file để khắc phục phần mapping này.

### 4.4. Kiến thức từ sản phẩm cũ: dùng có nguồn, không sao chép máy móc

Đã đọc hai listing của `vinatuoi.vn`: `40750340260` (can 5L) và `29926930476` (xịt giày). Tên hiển thị VINA TƯƠI - Đại Lý Chính Hãng; không suy ra trạng thái Mall nếu chưa xác minh.

- `29926930476` có cảnh báo **Sai ngành hàng**. Không dùng ngành đang lưu làm chuẩn và không bấm áp dụng gợi ý trên shop thật.
- Một số trường địa chỉ nhà sản xuất chỉ chứa tên công ty; đó không phải địa chỉ đầy đủ.
- Thuộc tính 500ml không tự phù hợp tất cả phân loại 100/300/500ml.
- Tuyên bố diệt khuẩn/an toàn cho bé/không hóa chất trên listing cũ không tự trở thành sự thật đã được xác minh.
- Mã trong URL hướng dẫn ngành như 101128/101611 không được suy thành category ID API.
- Quan sát lưu `apiVerified=false`, `approvedForReuse=false`; phải đối chiếu sản phẩm cụ thể và metadata/API trước sử dụng.
- Hồ sơ: `knowledge-base/shopee-seller-observations/documents/2026-09-14-vina-tuoi.md`. Chưa khảo sát toàn bộ 46 shop.

## 5. Kiến trúc và bản đồ mã nguồn hiện tại

Ứng dụng mới nằm trong `apps/` và `packages/`; extension cũ ở root được giữ riêng. Đây là cấu trúc hiện có, không khẳng định mọi nhánh đã nối vào một pipeline.

```text
Nhân viên nội bộ
   │
   ▼
apps/web — React / Vite
   │ API nội bộ
   ▼
apps/api — NestJS / Fastify ───── PostgreSQL + blob gốc theo hash
   │                               │
   ├─ Kho nguồn / catalog / giá ────┤
   ├─ Nhập patch / preview / QC ────┤
   ├─ SandboxTryout kỹ thuật ── OpenAPI TEST ── readback
   │
   └─ WorkOrder / kế hoạch ─── apps/worker
                                 │
                                 └─ Pipeline doanh nghiệp tổng quát:
                                    còn thiếu nối writer HTTP và nghiệm thu thật

packages/domain       Hợp đồng nguồn, listing, patch, kế hoạch
packages/persistence  Revision, CAS, journal, khóa, nguồn và bằng chứng
packages/shopee        Transport, codec, metadata, QC, phân loại
packages/agent-runtime Harness chỉ đọc, đánh giá bằng fixture
```

| Khu vực | Điểm bắt đầu đọc |
| --- | --- |
| Navigation/UI | `apps/web/src/Workspace.tsx`, `Resources.tsx`, `SourceCatalog.tsx` |
| Nhập/cập nhật | `apps/web/src/ImportUpdates.tsx`, `ImportPatchTable.tsx`, `ImportWorkbookMapping.tsx` |
| Công việc/thử/QC | `apps/web/src/Workbench.tsx`, `PreparedBatch.tsx`, `SandboxTryout.tsx`, `ImageQuality.tsx` |
| Parser Excel/Word | `packages/domain/src/source/kini.ts`, `word.ts`, `patch-workbook.ts` |
| Nguồn nghiệp vụ | `apps/api/src/prepared-source.ts`, `prepared-batch-service.ts`, `prepared-execution.ts` |
| Wire/patch | `apps/api/src/prepared-wire-runner.ts`, `import-patch-service.ts` |
| Phân loại/ảnh/phục hồi | `apps/api/src/variation-execution.ts`, `image-qc-service.ts`, `legacy-listing-recovery.ts` |
| Đường thử sandbox | `apps/api/src/sandbox-tryout-context.ts`, `sandbox-field-trial-service.ts` |
| Catalog | `apps/api/src/source-catalog-build.ts`, `packages/persistence/src/source-catalogs.ts`, `source-catalog-evidence.ts` |
| Database | `packages/persistence/`, migrations 001–020 theo checkpoint local |
| Kiểm thử | `tests/unit/`, `tests/integration/`, `tests/e2e/` |

Các tên file không có thư mục trong cùng một ô bảng được hiểu cùng thư mục với file đầu tiên. Khi cần sửa, xác nhận lại bằng tìm kiếm mã thay vì dựa vào mô tả này như API contract bất biến.

### 5.1. Những nguyên tắc dữ liệu đã triển khai từng phần

- Tệp nguồn theo hash, bản nhận/revision và vị trí ô/header; giữ nguyên bản gốc.
- Catalog, nguồn đã chuẩn bị, draft, WorkOrder, kế hoạch và execution receipt là các lớp khác nhau. Nhập dữ liệu không đồng nghĩa đã tạo hoặc đăng listing.
- CAS/revision để chặn ghi đè nguồn đã thay đổi; journal lưu ý định trước request và bằng chứng sau gửi.
- Khóa thực thi theo shop dùng chung giữa các đường ghi liên quan; không xóa khóa để ép thông qua một outcome chưa rõ.
- Patch tách phạm vi trường, vai trò/thứ tự ảnh và bộ giá theo shop. QC so phần chọn và phần phải giữ.
- Readback không dựa chỉ vào phản hồi POST hoặc thứ tự model. Phân biệt mảng rỗng với object rỗng, dữ liệu thiếu với giá trị hợp lệ.
- Phục hồi lịch sử và review ảnh có phiếu riêng; không sửa kết quả cũ để biến thành pass.
- Đây chưa là chứng minh mọi tính chất trên đã được áp dụng end-to-end cho writer doanh nghiệp chính.

### 5.2. Harness/AI: trạng thái thật

`packages/agent-runtime` có harness chỉ đọc, tìm tài liệu và đánh giá kế hoạch theo fixture xác định. `test:eval` **không đo LLM**, chưa có model/SDK/MCP runtime sản xuất, chưa có cập nhật KB tự động hay policy engine động hoàn chỉnh.

Multiagent đã được dùng để phản biện một số lần phát triển/QC, không đồng nghĩa ứng dụng có hệ multiagent chạy vận hành. Bản chép lời YC Harness Club là tài liệu tham khảo, không cấp quyền tự sửa nguồn/rule/code live. AI nên hỗ trợ đối chiếu/ngoại lệ; không phải phụ thuộc để tạo lại nội dung đã có.

## 6. Trạng thái tính năng — không dùng phần trăm hoàn thành

| Nhóm | Đã có bằng chứng | Phần còn thiếu |
| --- | --- | --- |
| Nhập Word/ảnh theo thư mục | UI/API/worker/PG, revision, nhập lô fixture, hướng dẫn cây thư mục | Tự nhận diện/mapping chắc chắn mọi bộ nguồn không đồng nhất |
| Bảng giá | KINI + DORIS, ba bộ giá, locators, tra nguồn | Gắn đúng 800 SKU với 604 nội dung và shop đích |
| Catalog Vina/Canva | GET dữ liệu thật, 604 dòng/227 thiết kế, evidence | Export ảnh gốc, xác nhận ghép, chuyển thành bộ có thể thực thi |
| Nhập cập nhật | Excel giá/tồn thưa, Word và các vai trò ảnh; lưu preview/biên nhận nội bộ | Kết nối toàn bộ luồng patch nghiệp vụ đến Shopee thật |
| Business batch | 80 bộ → 80 draft/WorkOrder/listing mô phỏng | Một luồng thật nhiều ngành/nhiều shop, writer chính |
| OpenAPI wire | Transport/codec/journal/raw QC, HTTP fixture + một số live patch | Bridge vào main worker tổng quát, metadata/quyền đầy đủ |
| TEST tạo mới | 76/80 nguồn kỹ thuật thành công; thêm một mẫu kỹ thuật verified | 80/80 bộ doanh nghiệp thật, điều tra 4 lỗi cũ, không retry mù |
| Cập nhật trường TEST | Title, mô tả, tồn, một số ảnh/thuộc tính theo ca đã ghi | Không phải mọi nhóm trường đều đạt trên mọi cấu trúc/shop |
| Phân loại | Đổi tên/đảo thứ tự một tầng, đổi tên hai tầng verified | Thêm/bớt và đổi số tầng thật bị chặn; fixture không thay thế live |
| QC ảnh | So dữ liệu/ảnh, immutable review, khôi phục có bằng chứng | Xử lý ảnh Shopee mã hóa lại tổng quát; gallery đổi tỷ lệ còn guard |
| Token/vận hành | Kết nối TEST và lưu token server, heartbeat | Refresh tự động, autostart, soak 24h, backup/restore diễn tập |
| Production | Thiết kế, nghiên cứu, chế độ không ghi | Pilot được cấp quyền, nghiệm thu, triển khai nội bộ ổn định |

Giao diện mới lấy **Kho listing** làm trang đầu, nhóm tác vụ chính giảm còn bốn; chi tiết chia Nội dung/Phân loại/Ảnh/Ghi chú. DORIS có **Thông tin nguồn** từng dòng. Các cải tiến có kiểm UI, nhưng người dùng chưa xác nhận nghiệm thu năng suất sử dụng toàn quy trình.

## 7. Tiến độ kiểm thử thực tế và giới hạn

### 7.1. Các lần nghiệm thu nghiệp vụ/API đáng nhớ

| Mốc | Kết quả | Giới hạn bắt buộc ghi kèm |
| --- | --- | --- |
| 09/09 — API Test Tool | 19 phản hồi/13 API; tạo item thử 846056124, cuối UNLIST | Dùng Console qua UI, không phải backend ứng dụng |
| 10/09 — Lamy | Listing 803934364, 6 model, nguồn thật, ảnh/giá/tồn TEST | Sandbox; không tạo Lamy lần nữa |
| 12/09 — bulk backend | 80 nguồn kỹ thuật: **76 verified**, 4 C055–C058 `product.error_busi` | Một ngành kỹ thuật, một shop thật TEST; không phải 80/80 doanh nghiệp |
| 14/09 — FIELD-20260914-B | 15 ca: **14 verified, 1 giá không tầng bị chặn** | Ba item kỹ thuật; thiếu chi tiết khuyến mại, không ép guard |
| 14/09 — business fixture | 80 Word + 440 ảnh + Excel → 80 draft + 80 WorkOrder + 80 listing mô phỏng; 200 SKU, 4 ngành/3 shop giả | Không phải 80 listing trên Shopee |
| 14/09 — HTTP wire fixture | 80 tài liệu/200 SKU/3 shop/4 ngành; 9 nhóm patch + giá/tồn 12 listing | Codec/transport/PG được thử riêng; chưa nối liền với lô UI thành live E2E |
| 14/09 — phân loại thật | Đổi tên/đảo thứ tự một tầng, đổi tên hai tầng verified qua hai readback | Thêm/bớt bị chặn trước POST; 0↔1↔2 mới có fixture |
| 14/09 — UI live tryout | UI → backend → TEST đổi title 803935036 verified, phần khác giữ nguyên | Một phép kỹ thuật; 2,428 giây không tính chuẩn bị/người dùng, không là throughput |

Giá từng bị chặn vì `get_item_promotion` thiếu trường cần chứng minh; không coi phản hồi thiếu là không có khuyến mại. Metadata ngành kỹ thuật `301378` thiếu `size_chart_mandatory`; không tự điền false để tạo thành công.

### 7.2. Các bộ kiểm tra code/UI gần nhất

Đây là các lượt có thời điểm và phạm vi khác nhau; **không cộng số test chồng lặp** và không gọi tất cả là lượt cuối sau mọi thay đổi.

| Lượt ngày 14/09 | Kết quả | Hồ sơ |
| --- | --- | --- |
| Phục hồi + Tryout | 892 unit/integration + 7 legacy, typecheck/build đạt; 6 browser fixture đạt riêng | `.local/acceptance-20260914/legacy-recovery/`, `.local/acceptance-20260914/ui-live-readiness/` |
| Catalog/UX | 940 unit/integration + 7 legacy, typecheck/build đạt | `.local/input-catalog/vina-tuoi-20260914/full-verification.json` |
| UI catalog/UX | 53 passed, không skipped/unexpected/flaky | `.local/input-catalog/vina-tuoi-20260914/ui-frozen-final-53.json` |
| DORIS sau thay đổi parser | 592 unit; 19 integration liên quan; 8 UI; typecheck/build đạt | `.local/input-catalog/doris-20260914/` và delivery DORIS |
| Đối chiếu DORIS | 77.070 giá trị/locators khớp; 14 bảng bảo vệ giữ hash | Audit/parser report, `protected-after.json` trong thư mục DORIS |

Lượt 940 có trước một sửa nhỏ bộ đếm concerns và trước thay đổi DORIS. Không lấy 940 làm “toàn bộ test đã chạy sau mọi sửa đổi cuối cùng”. Lượt DORIS có các bộ unit/integration/UI được chạy riêng, không phải tuyên bố đã lặp full verify toàn dự án với số 940.

Ngày tạo handoff chỉ đọc hồ sơ; session tiếp theo nên chạy lại kiểm tra thích hợp sau sửa code, ghi rõ môi trường và thời điểm. Không cần chạy lại live mutation đã có bằng chứng để chứng minh tài liệu này.

## 8. Lịch sử phải bảo toàn — không replay

### 8.1. Lamy và khóa shop đã được xử lý thế nào

- Item `803934364`, run lịch sử **`627e471b-2054-4af8-afc0-5a0a1cc63562`**, vẫn `unknown`, revision **25**, JSONB row không đổi.
- Phiếu phục hồi mới **`9e7a34b7-ad03-4248-b4d9-dba9cbf24c0a`**, 14/09 15:19:28 UTC+7, verified trạng thái hiện tại; shared lane đã được giải phóng đúng run.
- Basis: `historical_projection_and_fresh_raw_stability`. Hai fresh read base/models khớp projection lịch sử và raw hiện tại ổn định. Decoder cũ đã bỏ một số trường; không chứng minh toàn bộ raw lịch sử trước/sau.
- Phiếu ảnh **`3d216c1a-dc86-40f3-b745-40175e095aa3`**, reviewer **Codex QA (agent)**. Không gọi là người dùng/nhân viên đã duyệt hoặc byte/pixel tự động khớp.
- Không POST Shopee trong bước phục hồi. Không sửa old run/revision, vì phiếu gắn với revision, input fingerprint và toàn bộ row; thay đổi sẽ làm mất hiệu lực chứng cứ.
- Các tài liệu cũ còn nói Lamy đang giữ khóa là lịch sử trước phiếu này, không phải kết luận mới nhất.

### 8.2. Danh sách lệnh/ca thử cũ không được phát lại

| Item/nhóm | ID | Tình trạng cần giữ |
| --- | --- | --- |
| Gallery 803935036 | `f024d84e-9f95-48da-bdee-4749641873c0` | Đổi gallery 1:1→3:4 đã làm đổi bìa dù gửi promotion_images cũ; mismatch |
| Khôi phục bìa 803935036 | `0c2ed720-0dc8-4ff4-9f47-607c14979bac` | Khôi phục bằng lệnh mới; mã/bytes đổi, review scoped, không sửa ca sai thành pass |
| Wire title 803935036 | `8bb19101-220b-4693-af7b-4fcf85aca6c3` | Đã gửi và có readback; không replay |
| UI live title 803935036 | `7c06ae31-6b38-48c1-86bf-a29047bd45f5` | Verified; request `e3e3e7f35b6d34195dcb77030377ac00` |
| Đổi tên một tầng | `de5ba333-a1b3-4e75-903d-d68faf24e9b8` | Verified trên 803934786 |
| Đảo thứ tự một tầng | `804ba0d4-eb64-4fd7-b7f6-d1531c48ac8c` | Verified trên 803934786 |
| Đổi tên hai tầng | `7ed97014-7ab5-4b40-917a-dab28ed35713` | Verified trên 803934787 |
| Thêm phân loại | `e5159b68-f633-4d11-9d45-12ab71e4c7ad` | Blocked trước ghi do chi tiết khuyến mại chưa xác minh |
| Bớt phân loại | `6b3f2bf9-b58b-46e5-a7eb-72629eaf1ba5` | Blocked trước ghi, không tính là live pass |
| Bulk cũ/FIELD-B | Các intent trong biên nhận gốc | Đọc lại hồ sơ; không chạy lại nguyên script hoặc dùng lại ID để gửi mới |

QC ảnh restore có review `590d5d06-43d9-4ab8-b1f4-7ee168270add`, được đối chiếu basis `image_manual_review`; review ca sai `eb3cce69-85ab-45a7-bd3f-76f222247087` giữ mismatch. Không nới so ID ảnh toàn cục, dùng thumbnail gần giống để tự đạt hoặc bỏ guard tự chuyển tỷ lệ gallery.

## 9. Những việc còn thiếu và thứ tự tiếp nối đề xuất

Phần này là **đề xuất công việc tiếp theo**, không phải các tính năng đã hoàn tất và không cấp thêm quyền ghi production.

### P0 — Bảo toàn và xác định đúng hiện trạng

1. Đọc AGENTS.md và các delivery mới nhất; kiểm Git diff, branch, migrations và tình trạng local bằng GET.
2. Ghi nhận các thay đổi chưa commit, bảo toàn DB/blob/bằng chứng. Không reset, xóa `.local`, khởi tạo DB mới hoặc import lại nguồn chỉ vì chưa thấy ở UI.
3. Nếu localhost từ chối kết nối, kiểm tiến trình/cổng/API/DB trước. Đây có thể là server dừng, không phải Shopee khóa shop.
4. Xác minh TEST bằng đọc khi công việc cần API, không lộ token. Mở ứng dụng không tự gửi lệnh ghi.

**Đạt khi:** biết code/DB đang dùng, nguồn và lịch sử vẫn nguyên; không phải tạo lại dữ liệu để tiếp tục.

### P1 — Làm một bộ nguồn doanh nghiệp đủ để thực thi

1. Dùng catalog 604 + DORIS đã có; tạo mapping có chứng cứ giữa nội dung → thiết kế/trang gốc → SKU → bộ giá → shop/model.
2. Xác nhận cách dùng giá Mall cho shop thường và quan hệ TDSC/TINHDAUSACHANH nếu cần sử dụng; trong lúc chờ vẫn làm phần có nguồn rõ.
3. Xuất ảnh gốc đúng thiết kế được chọn, lưu hash/phiên bản, xác định vai trò/thứ tự. Không tự gán toàn bộ theo số trang hoặc chỉ từ preview.
4. Lấy ngành/thuộc tính từ nguồn sản phẩm + tham khảo cũ có provenance, kiểm metadata/quyền hiện tại. Chặn mâu thuẫn như “Sai ngành hàng”, thể tích chung sai, địa chỉ thiếu.
5. Nhận mức tồn thủ công theo SKU/shop và dữ liệu vận chuyển còn thiếu. Không sinh thông số để đạt preflight.
6. UI tập trung hàng cần xử lý: đúng thì đi tiếp, thiếu thì chỉ rõ ô/nguồn cần xác nhận; không bắt nhập lại nội dung đã có.

**Đạt khi:** mỗi bộ xuất được bản chuẩn bị có phiên bản, đầy đủ nguồn từng trường, không còn mapping tự suy, người vận hành xem trước đúng ý định.

### P2 — Nối luồng chính vào backend thực thi

- Nối PreparedGateway/main worker với HTTP adapter thật theo hợp đồng; giữ journal, shared lane, baseline, idempotency, capability/metadata gates.
- Cùng một work order đi được từ import đến kết quả; không ghép báo cáo nhiều harness riêng rồi gọi E2E.
- Phân biệt lỗi trước gửi, lỗi API xác định, mất phản hồi sau gửi, readback chậm và mismatch; không retry mù hoặc báo thành công sớm.
- Chọn target TEST đủ nguồn, thử một bộ rồi lô nhỏ; chỉ tăng quy mô sau chứng cứ đúng cả trường thay đổi và trường giữ nguyên.

**Đạt khi:** một bộ nghiệp vụ được nhập qua UI, gửi backend đúng sandbox, đọc lại đủ, có toàn bộ nguồn/ý định/request/result/QC trong một chuỗi truy vết.

### P3 — Hoàn thiện cập nhật nhiều tình huống

- Import giá/tồn thưa; thay bìa riêng, gallery riêng, Word riêng, ảnh mô tả/phân loại riêng; trường không chọn phải giữ nguyên.
- Nhiều shop/bộ giá, SKU trùng giữa shop, SKU tương tự nhưng khác, số 0 và ô trống, xóa có chủ đích, dữ liệu nguồn đã đổi giữa preview và gửi.
- Đổi tên/thứ tự/thêm/bớt phân loại phải kiểm mapping model, giá/tồn/ảnh/SKU và chương trình liên quan; ca thêm/bớt đang thiếu bằng chứng live.
- Xử lý re-encode ảnh có bằng chứng đúng phạm vi; không bỏ QC để giảm lỗi hiển thị.
- Thử lỗi xác thực, quyền thiếu, metadata đổi, timeout sau ghi, rate limit, partial success, worker restart và readback chưa nhất quán trong fixture; live chỉ khi phạm vi/thông tin đủ.

**Đạt khi:** từng nhóm có ma trận before/intent/after, không đổi trường ngoài phạm vi, chặn đúng ca thiếu chứng cứ, khôi phục không tạo lệnh trùng.

### P4 — Nghiệm thu vận hành và production

- 50–80 bộ nguồn đa dạng trong cùng pipeline; tách số fixture với số sandbox thật. Multi-shop thật cần kết nối/quyền thật tương ứng, không dùng shop giả để thay bằng chứng.
- Refresh token tự động, queue/backoff/rate limit theo API thực tế, tạm dừng lỗi nghiệp vụ lặp lại, giám sát, tự khởi động dịch vụ, backup và phục hồi thử.
- Soak 24 giờ có báo cáo độ trễ/thông lượng/lỗi/recovery; ghi rõ mức concurrency và giới hạn đo được. Không cam kết “đăng tối đa bao nhiêu” trước đo.
- Chốt UX với nhân viên thao tác trọn ca thực tế, kiểm không cần hiểu SKU mapping nội bộ để dùng những bộ đã đủ.
- Production pilot nhỏ chỉ sau khi người dùng cấp **quyền ghi cụ thể** cho shop, bộ dữ liệu và tác vụ. Quyền hiện tại chưa có.

## 10. Runtime, Git và cách tiếp nối trên máy

### 10.1. Trạng thái Git khi lập bàn giao

- Repo private: <https://github.com/HoangDuong-DH/shopee-product-uploader>.
- Branch đang có: `feat/internal-app`.
- HEAD đọc khi bàn giao: `da5e934` — `Record live sandbox bulk results and guard repeated creation failures`.
- Working tree có nhiều file modified/untracked: modules, migrations, tests, docs mới. Không đồng nhất “đã có trên máy” với “đã push GitHub”.
- Không dùng connector mang owner `vestacanva-maker` thay GitHub người dùng `HoangDuong-DH`.
- Không reset/clean để bắt đầu lại; nếu cần nhánh mới dùng quy tắc nhánh hiện hành nhưng phải bảo toàn công việc chưa commit.

### 10.2. Các thành phần local

| Thành phần | Cấu hình đã ghi nhận |
| --- | --- |
| Node riêng | `.local/runtime/node-v24.20.0-win-x64/node.exe` |
| PostgreSQL | 17.11-alpine, Docker Compose, loopback 5442, named volume |
| API | 4310 |
| Vite UI | 5173 |
| UI build | API cũng phục vụ sau build tại 4310 |
| Bind hiện tại | `127.0.0.1`, chưa là triển khai LAN/autostart |
| Blob nguồn | `.local/data/blobs` |
| Cấu hình private | `.env`, `.local/docker.env`; không in hoặc đưa vào handoff |

Trạng thái cuối 14/09: API/worker/UI hoạt động, `productionWrites=false`, writer listing chính `not_configured`. **Ngày 15/09 chưa kiểm tra lại runtime**, không dựa vào PID hoặc health lịch sử để kết luận đang chạy.

### 10.3. Bước kiểm tra đầu tiên

Đọc `docs/runbooks/local-development.md` trước khi khởi động. Trên máy đã có dữ liệu, kiểm cổng/tiến trình trước, tránh chạy hai bộ server. Không tự chạy lại setup/migrate/import như một workspace rỗng.

```powershell
Set-Location C:\shopee_product_uploader
$env:Path=(Join-Path (Get-Location) '.local/runtime/node-v24.20.0-win-x64')+';'+$env:Path
git status --short
git branch --show-current
git log -1 --oneline
```

GET local để kiểm tra khi API đang chạy:

```text
http://127.0.0.1:4310/health/live
http://127.0.0.1:4310/health/ready
http://127.0.0.1:4310/v1/status
```

`npm run dev` khởi động API/worker/Vite khi cần. Nếu chạy API bằng tsx riêng, đặt `TSX_TSCONFIG_PATH=apps/api/tsconfig.json` như script dev; thiếu biến có thể lỗi decorator.

Kiểm code sau thay đổi: `node scripts/verify.mjs` (typecheck, build, legacy, unit/integration); báo cáo `.local/verification.json`, `.local/test-results.json`. Chọn E2E theo phần sửa và đọc cấu hình môi trường trước chạy. Không chạy nguyên các script live sandbox đã có intent cũ.

Trên máy mới, làm theo runbook để cài dependencies, cấu hình DB và migrations sau khi có bản sao/backup cần thiết. Không coi lệnh setup là cách phục hồi dữ liệu nghiệp vụ đã mất.

## 11. Tài liệu nào cần đọc và thứ tự ưu tiên

Mọi đường dẫn dưới đây tính từ `C:\shopee_product_uploader`. Tài liệu checkpoint mới hơn được ưu tiên khi nó ghi rõ đã thay thế tình trạng lịch sử; không dùng README/ledger cũ để phủ định bằng chứng mới.

| Ưu tiên | Tài liệu | Nội dung |
| --- | --- | --- |
| 1 | `AGENTS.md` | Quy tắc dự án, quyền, nguồn, checkpoint và no-replay |
| 2 | `docs/delivery/2026-09-14-doris-pricebook.md` | File giá tinh dầu đã nhận, mapping/giá còn thiếu |
| 3 | `docs/delivery/2026-09-14-source-catalog-and-ux.md` | Catalog604, Canva, UX, provenance |
| 4 | `docs/reviews/2026-09-14-source-catalog-ux.md` | Kiểm và giới hạn UX/catalog |
| 5 | `docs/delivery/2026-09-14-legacy-recovery-and-tryout.md` | Lamy đã giải phóng khóa, UI live title |
| 6 | `docs/delivery/2026-09-14-variation-and-image-qc.md` | Đổi phân loại, ảnh, giới hạn thêm/bớt |
| 7 | `docs/delivery/2026-09-14-patch-scenarios.md` | Ma trận cập nhật và sự cố đổi bìa |
| 8 | `docs/delivery/2026-09-14-openapi-wire-bridge.md` | Transport/codec/QC và thiếu nối main worker |
| 9 | `docs/delivery/2026-09-14-prepared-business-acceptance.md` | 80 bộ nghiệp vụ mô phỏng, nguồn fixture |
| 10 | `docs/delivery/2026-09-14-live-backend-acceptance.md` | Live field B, 14/15 và guard khuyến mại |
| 11 | `docs/delivery/2026-09-12-import-patch-workflow.md` | Nhập cập nhật bằng Excel/Word/ảnh |
| 12 | `docs/runbooks/local-development.md` | Khởi động, cổng, verify và giới hạn runtime |

Các tài liệu theo công việc:

- `docs/runbooks/import-updates.md`, `sandbox-connection.md`, `sandbox-backend-trials.md`, `agent-evaluation.md`.
- `docs/superpowers/specs/2026-09-11-prepared-listing-publishing.md`: yêu cầu không tự tạo/thay nguồn.
- `docs/superpowers/specs/2026-09-09-shopee-production-architecture-design.md`: thiết kế kiến trúc; **không phải xác nhận đã triển khai**.
- `docs/superpowers/plans/2026-09-10-shopee-execution-plan.md` và `2026-09-10-shopee-execution-ledger.json`: kế hoạch/ledger tổng; trạng thái task thô chưa đủ phản ánh mọi checkpoint mới.
- `docs/superpowers/plans/2026-09-11-harness-foundation.md`: giới hạn harness.
- `docs/research/shopee-lamy-listing-2026-09-10/README.md`, `content-and-pricing.md`: nguồn và phép thử Lamy.

Tra cứu Shopee bắt buộc từ:

1. `knowledge-base/shopee-open-platform/AGENT_GUIDE.md` — Developer Guide, API, tham số, quyền, lỗi, FAQ và thông báo.
2. `knowledge-base/shopee-uni-vn/AGENT_GUIDE.md` — listing, hướng dẫn và cập nhật VN.
3. `knowledge-base/shopee-seller-observations/AGENT_GUIDE.md` — dữ liệu vận hành quan sát, không mặc định chính xác.

Kho chính là snapshot 08/09/2026. Khi đưa quyết định phụ thuộc hiện hành, xác minh nguồn chính thức mới; giữ ngày nguồn và ngày hiệu lực. Ví dụ trong tài liệu không phải giới hạn thật của shop. Tính năng trên Seller Center không chứng minh ứng dụng có quyền OpenAPI tương ứng.

## 12. Gói bàn giao cần gì ngoài file Markdown này?

### Session tiếp theo trên cùng máy/workspace

Đưa file này và yêu cầu đọc AGENTS.md + các delivery được chỉ dẫn. Mã, DB và `.local` có thể tiếp tục dùng tại chỗ sau khi kiểm tra. Không cần người dùng giải thích lại toàn bộ nghiệp vụ hoặc nhập lại nguồn đã nhận.

### Session trên máy khác hoặc chỉ có GitHub

File này đủ để hiểu bối cảnh, **không chứa bản thân mã nguồn chưa commit, dữ liệu DB, ảnh gốc hoặc credentials**. Để thực thi tiếp cần bàn giao riêng:

- Working tree hiện tại, gồm các file mới chưa commit; không chỉ HEAD GitHub.
- Nguồn Word/Excel được người dùng cung cấp và ảnh gốc/manifest đã tải.
- Kho kiến thức Shopee và hồ sơ delivery/review cần thiết.
- Backup PostgreSQL và blobs tương ứng; SQLite catalog Vina là bản nguồn bổ sung, không thay thế DB công việc/journal.
- Các thư mục `.local/input-catalog/`, `.local/acceptance-20260914/`, `.local/sandbox-bulk-20260912/` liên quan để kiểm bằng chứng; giữ private, không commit dữ liệu này lên repo.
- Cấu hình kết nối được thiết lập lại qua kênh phù hợp; không dán khóa/token hoặc toàn bộ `.env` vào prompt. Không hứa chuyển DB mã hóa là tự đọc được credentials nếu thiếu cơ chế khóa tương ứng.

Trước di chuyển, lập danh mục/hash/backup và kiểm phục hồi. Tài liệu này không chứng minh đã tạo backup hoặc đã chuyển dữ liệu sang máy khác.

## 13. Prompt ngắn để mở session tiếp theo

```text
Hãy đọc file docs/handoffs/2026-09-15-session-handoff.md và AGENTS.md trong
C:\shopee_product_uploader trước khi tiếp tục dự án Shopee nội bộ.

Đối chiếu delivery mới nhất, Git working tree và bằng chứng local; không coi
mọi test giả lập là nghiệm thu Shopee thật. Giữ nguyên nguồn listing do tôi
chuẩn bị, không tạo lại nội dung/ảnh hoặc tự ghép SKU/giá chưa có bằng chứng.

Shop thật chỉ đọc. Không replay các operation sandbox cũ và không sửa lịch sử
unknown để ép thành công. DORIS đã nhận; việc còn thiếu là mapping đúng vào
catalog và hoàn thiện một luồng doanh nghiệp thực thi có QC.

Trước khi sửa, báo ngắn gọn hiện trạng đã xác minh và việc tiếp theo có tiêu chí
nghiệm thu. Tiếp tục phần đã được ủy quyền; chỉ hỏi dữ liệu nghiệp vụ còn thiếu,
không bắt tôi giải thích lại những quyết định đã ghi trong handoff.
```

## 14. Những điều session mới tuyệt đối không nên kết luận nhầm

- “Đã có 4.377 sản phẩm DORIS” — sai; đó là bản ghi theo bộ giá.
- “Đã tải 5.961 ảnh Canva gốc” — sai; mới là metadata trang.
- “Có một gợi ý thiết kế nghĩa là đã ghép đúng” — sai; gợi ý chưa xác nhận.
- “Không có giá tinh dầu” — đã lỗi thời; DORIS đã nhận, giá Mall có, mapping còn thiếu.
- “Mall có giá thì shop thường dùng luôn” — chưa có quyết định nghiệp vụ.
- “Listing đang hoạt động có nghĩa thuộc tính/ngành đúng” — có bằng chứng cảnh báo sai ngành.
- “80/80 fixture nghĩa là đã đăng 80 sản phẩm doanh nghiệp thật” — sai.
- “Thêm/bớt phân loại đã live pass” — sai; ca thật đang blocked, fixture mới đạt.
- “Lamy vẫn đang giữ khóa chưa xử lý” — đã lỗi thời sau phiếu phục hồi 14/09; nhưng run cũ vẫn unknown.
- “Đã sửa run unknown thành verified” — sai; phiếu đối chiếu hiện tại là bản ghi riêng.
- “Agent duyệt ảnh nghĩa là người dùng đã duyệt” — sai.
- “Nút Thử sandbox nghĩa là production writer sẵn sàng” — sai.
- “Ứng dụng đang chạy 24/7 vì health từng xanh” — chưa được chứng minh.
- “Clone repo là có hết dự án hiện tại” — sai; có working tree chưa commit và dữ liệu private.

---

**Cách tiếp nối đúng:** dựa trên nguồn và bằng chứng mới nhất, giữ những phần đã làm, xử lý ngoại lệ có định danh, hoàn thiện một luồng sử dụng xuyên suốt rồi nghiệm thu từng phạm vi. Không lấy số test hoặc hình giao diện thay cho kết quả vận hành thực tế.

## 15. Audit bổ sung ngày 15/09 — hướng xử lý được ưu tiên

Phần này ghi các điểm phát hiện sau khi đọc lại code, không phải bằng chứng đã sửa. Chúng được đưa vào handoff để session sau không chỉ đọc số test mà bỏ qua các lỗi nối luồng.

### Đã xác nhận trong code

| Mức | Vị trí | Nhận định | Hướng sửa an toàn |
| --- | --- | --- | --- |
| P0 | `packages/shopee/src/prepared-wire.ts` quanh dòng 608 | Guard giá sỉ đọc `raw.item.wholesale` số ít. Hợp đồng/nguồn Shopee dùng `wholesales`; nếu snapshot giữ tên API thì guard không chạy. | Viết một canonical normalizer chấp nhận đúng tên API đã xác minh, test cả `wholesales` và trường bị thiếu; giữ fail-closed khi payload không rõ. Không chỉ đổi một chuỗi rồi bỏ test phản hồi thật. |
| P0 | `packages/domain/src/draft.ts` dòng 6 | `validateDraft` gắn `draft.title.sources` cho mọi issue, nên lỗi giá/ảnh/phân loại có provenance của tiêu đề. | Tạo helper nhận `SourceRef[]` theo field; mỗi issue dùng nguồn của fact/asset/variant tương ứng. Thêm test xác nhận source locator của giá và ảnh. |
| P0 | `packages/persistence/src/repository.ts` và `apps/worker/src/main.ts` | `submitPlan` ghi `outbox(job.ready)` nhưng worker hiện chỉ xử lý import và bounded TEST create trial. Không có consumer tổng quát đánh dấu `delivered_at`/claim job. | Xây consumer outbox có lease/CAS, idempotency và dead-letter/unknown; chỉ nối writer sau khi consumer chạy fixture và readback. Không “đánh dấu delivered” giả để làm xanh test. |

### Đúng về ranh giới hiện tại, chưa nên sửa bằng cách mở khóa thẳng

- `PreparedWireRunner`, `VariationExecutionService` và `LegacyListingRecoveryService` hiện được gọi từ script/integration. Đây là boundary bảo vệ, không phải bằng chứng thiếu code. Bước đúng là tạo route/command nội bộ có scope, capability, preview và journal; không expose endpoint ghi tự do.
- Các ID partner/shop/item cứng ở nhiều chỗ là guard pilot sandbox. Không xóa hàng loạt. Thay bằng `TargetPolicy`/registry cấu hình, trong đó sandbox allowlist và production policy là hai cấu hình khác nhau; production mặc định vẫn `writes=false`.
- Nút/copy `g1.png`, `cover-and-g-number` đang mô tả convention cũ trong `folder-source.ts`/`ListingFolderGuide.tsx`. Vì nguồn thật không có filename contract, UI phải gọi đây là gợi ý/heuristic và yêu cầu xác nhận vai trò; không được để nhân viên tưởng tên tệp tự ghép đúng.
- Chuỗi Lamy trong màn thử là phạm vi technical canary. Khi thành luồng dùng chung, lấy tên từ source/work order; không thay chuỗi bằng tên khác mà làm mất guard test.

### Kho kiến thức seller chưa được nối vào harness

`packages/agent-runtime/src/retrieval.ts` hiện chỉ cho corpus `open-platform` và `seller-vn`. `knowledge-base/shopee-seller-observations` có manifest/chunks nhưng không nằm trong root/corpus contract của library. Vì vậy quan sát cũ không được app tìm kiếm tự động; đây là thiếu tích hợp, không phải thiếu dữ liệu. Nếu nối, phải:

1. thêm corpus riêng và parser manifest đúng schema;
2. kiểm hash/nguồn/ngày quan sát, gắn `apiVerified=false`/`approvedForReuse=false`;
3. buộc agent trình bày đây là tham khảo vận hành, không phải policy hay giá trị được phép tự áp dụng;
4. cập nhật index/verification, rồi thêm test khi corpus thiếu hoặc hash sai.

Không trộn quan sát seller vào quy tắc Shopee chính và không tự dùng nó để chọn ngành/thuộc tính.

### Chính sách công thức Excel phải chốt một lần

Hiện parser KINI cho phép giá trị công thức đã có cache; parser sheet Điều phối/patch yêu cầu chính sách chặt hơn. Trước khi nối executor cần ghi rõ policy theo loại nguồn:

- công thức có kết quả cache hợp lệ: chỉ dùng nếu nguồn cho phép và lưu cả công thức, kết quả, thời điểm đọc;
- công thức không có cache hoặc trả lỗi: block với locator cụ thể;
- không gọi lại Google Sheets/Excel để tự tính và không biến thiếu thành 0;
- mọi parser dùng cùng enum policy, không mỗi màn hình tự quyết định.

### So sánh giá và kiểu dữ liệu

Một đường biên dùng so sánh nghiêm ngặt số, trong khi field client có thể chấp nhận chuỗi số từ Shopee. Chuẩn hóa tiền/ID ngay tại codec boundary, rồi so sánh canonical representation trong QC. Test phải bao gồm `1099999` và `"1099999"`, nhưng không được coi chuỗi sai định dạng là hợp lệ. Đây là lỗi hợp đồng kiểu dữ liệu, không phải lý do để nới mọi comparator.

### Thứ tự triển khai tôi khuyến nghị

1. Sửa và test ba P0 ở bảng trên; không gọi Shopee trong bước này.
2. Chuẩn hóa `TargetPolicy`, nguồn issue và Excel formula policy; cập nhật runbook stale về Lamy/ledger.
3. Tạo outbox consumer fixture-only, chứng minh claim/retry/unknown/restart rồi mới gắn PreparedWireRunner qua service có route nội bộ.
4. Nối seller observations ở chế độ đọc và provenance rõ; sửa copy UI về filename heuristic.
5. Chạy `node scripts/verify.mjs` sau các sửa, ghi bộ số mới theo thời điểm; không cộng với 940/892/865 cũ.
6. Một bộ nguồn doanh nghiệp thật trong sandbox → lô nhỏ → mới xem xét 50–80. Mỗi bước phải có readback cả trường đổi và trường giữ, rollback/reconcile và bằng chứng shop đích.

### Điều kiện để gọi là E2E

Một test chỉ được gọi là E2E khi cùng một WorkOrder đi xuyên qua import nguồn → mapping có provenance → preview/guard → outbox → worker claim → HTTP OpenAPI TEST → readback → QC/journal, với một scope sandbox xác định. Bộ fixture 80 hiện có rất hữu ích cho logic nhưng không thỏa điều kiện này; 76/80 bulk kỹ thuật và các ca field riêng cũng không thay thế được.

### Những việc không nên làm để “tiến độ xanh”

- không chỉ đổi `wholesale` thành `wholesales` mà không sửa schema/fixtures/readback;
- không gắn mọi lỗi vào nguồn tiêu đề cho tiện hiển thị;
- không tạo consumer chỉ cập nhật trạng thái mà không dispatch HTTP;
- không xóa allowlist sandbox hoặc thay ID bằng giá trị động chưa có policy;
- không đưa quan sát seller vào search mà bỏ nhãn tham khảo;
- không sửa run lịch sử `unknown`, replay intent cũ hoặc nới QC ảnh để biến mismatch thành pass.

## 16. Quyền thử production mới — shop 1423724897 / vuatinhdau.vn

**Cập nhật sau người dùng lưu khóa Live:** đọc `docs/delivery/2026-09-15-production-authorization.md`. Console báo khóa mới có hiệu lực 15/09 11:01 nhưng vẫn hiện cảnh báo cạnh hạn cũ; chưa suy ra API thành công. Đã triển khai luồng nhập khóa → liên kết cấp quyền → callback backend → đổi code một lần → đọc shop → lưu mã hóa, migration021 áp dụng local, 93/93 kiểm thử mục tiêu đạt với phản hồi Shopee mô phỏng. Callback local cổng4310, cookie/state và giới hạn đúng shop; chưa xác minh Shopee chấp nhận redirect hay user hoàn tất quyền. Trạng thái đọc cuối vẫn disconnected/revision0, production writer và tự refresh chưa bật. Đã mở UI và yêu cầu user dán khóa mới tại đó, không vào chat. Các ghi nhận “chưa có kết nối/writer” bên dưới là preflight trước khi bổ sung phần kết nối; phần writer vẫn chưa hoàn tất.

Sau các checkpoint trên, người dùng đã yêu cầu thử đăng thực tế bằng API vào **shop 1423724897 / vuatinhdau.vn**, cho phép agent chọn **một bộ listing tinh dầu đã cung cấp**. Đây là ngoại lệ mới theo yêu cầu trực tiếp, thay thế giới hạn chỉ đọc cho đúng phép thử/shop này; các shop khác vẫn chỉ đọc. Không suy rộng thành quyền gửi lô, tự đặt giá/tồn, sửa sản phẩm có sẵn tùy ý hoặc phát lại intent cũ.

Preflight thực tế chưa gửi API production: ứng dụng local chỉ có kết nối sandbox; production writer chưa cấu hình. Console app **VestaPro / Live Partner ID 2010476**, trang `/console/app/218272`, hiển thị rõ **Live Partner Key đã hết hạn**. Chưa xoay khóa hoặc đọc giá trị khóa. Cần người dùng hoàn tất xoay khóa và cấu hình kết nối an toàn trước các phép đọc API shop thật.

Bộ ứng viên chuẩn bị: catalog `row-2`, sheet `01 VINA TUOI`, dòng 5, **Can 5 Lít Một Hương Duy Nhất VINA TƯƠI - Bản Tiếp Liệu Rót Đầy Bình Xịt Thơm**, 12 phân loại 5L; Canva candidate `DAHUmT4_SaQ`, 22 trang metadata. Chưa có đủ ảnh gốc/mapping, tồn và bộ giá áp dụng shop đích để gửi. Đọc `.local/production-pilot-1423724897/preflight.md`. Không gọi đây là test đăng thật đã hoàn thành.

## 17. Cập nhật sau kết nối và tạo production thật — 15/09

**Kết quả mới nhất14:37:17 UTC+7:** listing51467852283 đã **NORMAL/published verified** sau hai freshread; createec195c1c… và publication5995935b… đềuverified. Một lệnh unlist_item duy nhất(requeste3e3e7f35b8090f198e7db9e89347100); lần đối chiếu sau chỉ đọc. Bìa đã cócasee6e9dd41… verified/manual_review bởiCodex QA(agent), đúngPNG→JPEG1024², không sửarawđểche mãảnhđổi.12SKU/giá2179998đ/tồn100VNZ/9gallery/nội dung/phân loại/vận chuyển đều khớp. Row65chưagửi. UIpartial_complete, canStartfalse, khôngreplay. Các đoạn mô tả chờbìa bên dưới là checkpointtrước14:37. Xem deliveryproduction-pilot đểlấyfilekếtquả vàgiớihạnnghiệmthu.

Đọc **docs/delivery/2026-09-15-production-pilot.md** trước khi tiếp nối; mục16 phía trên là lịch sử trước khi kết nối hoàn tất. Production đã kết nối đúng shop1423724897, partner2010476, revision1. Người dùng sau đó cho phép lô2listing/15SKU, tồn100/SKU, giá gốc DORIS SHOP MALL, kích thước ước tính có nhãn; loại Tràm Huế khỏi lô, chọn mô tả chữ sau lỗi whitelist ảnh mô tả, và cho phép trùng listing cũ trong pilot. Mới nhất ưu tiên hoàn tất **một listing can5L** trước.

Listing **51467852283** đã tạo thật bằng backend OpenAPI, operation **ec195c1c-b2e1-44d9-a866-e14a39988a9b**, nguồn row-2 revision4. Có22 upload ACK +add_item ACK +init_tier_variation ACK/12model. Đang UNLIST chờ hoàn tất bằng chứng bìa, **không tạo lại**. Hai freshread07:15:15/18Z xác nhận12SKU tồn100 tạiVNZ, giá2179998đ,9gallery, nội dung/phân loại/thuộc tính/vận chuyển/cân nặng/kích thước đúng nguồn; chỉ còn mã bìa do Shopee đổi và tỷ lệ bìa bị bỏ khỏi phản hồi. Tồn0 ở phản hồi đầu là đồng bộ trễ; không gửi bổ sung stock. Hai agent đang đối chiếu bìa qua ảnh tải thật và ImageQcService; xem delivery để biết kết quả mới nhất trước khi publish. Row-65 chưa gửi.

Hai lần bị từ chối v2/v3 đã đóng bằng chứng bổ sung bất biến, vẫn giữ trạng thái rejected. Migration024 đã áp dụng. V2 thiếu quyền ảnh mô tả; v3 lỗi kênh bắt buộc1326. V4 giữ5kênh phù hợp kiện từ sản phẩm cũ cùng shop; không đổi shop settings. Nguồn/ảnh gốc và lịch sử giữ nguyên trong .local/production-pilot-1423724897. Kiểm tổng hoàn tất07:12:20Z đạt1412unit/integration+7legacy/typecheck/build; bridgebìa64runner tests sau đó đạt riêng. Không coi đây là nghiệm thu80listing/multi-shop/24h.

UI **Đăng hàng** đã có màn pilot2listing, trạng thái từDB và lịch sử; POSTstart qua backend, không dùng thao tác Seller Center để đăng. Người dùng mới yêu cầu hướng dẫn nhân viên chuẩn bị input đơn giản/đủ thông tin; agent đang tạo docs/operator-guides/chuan-bi-bo-listing.md và mẫuExcel bàn giao. Mẫu bàn giao phải ghi rõ chưa có parser nhập tự động nếu dùng schema mới; không hứa chức năng chưa có.

## 18. Lô 2/2 hoàn tất, nhập nguồn và thuộc tính theo ngành — 15/09 15:47 UTC+7

**Đã hoàn tất hai nguồn được chốt bằng backend OpenAPI**, trên shop 1423724897 / vuatinhdau.vn, partner2010476. Không có thao tác điền form Seller Center để đăng. Màn hình Đăng hàng xác nhận cả hai “Đã mở bán, đối chiếu đạt”, trạng thái `complete`, remainingCount0, canStartfalse.

- Can 5L **51467852283**, 12 SKU: không chạy lại prepare/create/init/publish. Hash các dòng operation, steps, verification và publication trước/sau vẫn `4774b33d82dfb176bb6a7cb94e6536d23695874f9e3affdf12aaf8f37af31358`.
- Ngọc Lan Tây **51267858328**, 3 SKU 300/100/500ml: create `007738be-04ec-4ead-88d2-825062b29056`, publication `84d8e9a0-ad69-4740-8839-e796c998dac0`, đều verified. Một request mở bán `e3e3e7f35b8185b10eff07d3c95ba600`; hai NORMAL read **08:41:55.104Z / 08:41:56.173Z**. Đúng 11 upload + 1 create + 1 init + 1 mở bán; toàn bộ trường được bảo vệ giữ nguyên khi mở bán, chỉ đổi trạng thái.
- Người dùng đã xác nhận riêng **300ml=322g, 100ml=131g, 500ml=504g**. Nguồn vẫn giữ **322.3/130.9/503.8g**, giá lần lượt **377998/235998/559998đ**, tồn **100/SKU tại VNZ**. Phiếu cân nặng theo đúng operation/model/SKU có SHA `3787b79f82b5a9321c027980ac65dfb4bcc89a1391844da97d264e404542d52f`; không dùng làm quy tắc làm tròn toàn app.
- Bìa case `8e7e10d0-b3ee-4b3a-8985-cfce3ab3e326` verified, manual_review bởi **Codex QA (agent)**, PNG→JPEG1024² cùng nội dung. Raw phản hồi Shopee và tệp nguồn giữ nguyên, đối chiếu bằng bằng chứng riêng.
- Token hết hạn đã được refresh thật bằng backend từ thông tin lưu mã hóa: kết nối `2bb497e4-a306-4b1e-85ba-5ee7a814fdaf`, revision **1→2**, hết hạn **12:38:54.454Z**. Refresh được gọi chủ động một lần; chưa có lịch tự làm mới 24h. Không gửi lại refresh revision1; trường hợp mất phản hồi phải dùng đường recover biên nhận mã hóa.

**Không replay** bất kỳ create/init/publication đã có biên nhận. Các lần đọc đầu thiếu SKU/tồn do đồng bộ trễ được giữ làm bằng chứng; hệ thống chỉ đọc lại, không tự bù tồn. Hai lần rejected v2/v3 và Lamy sandbox lịch sử giữ nguyên.

**Nhập nguồn đã cải thiện nhưng chưa thành production tổng quát:** tại Đăng hàng → Công cụ chuẩn bị lô khác có Nhập thư mục Word và ảnh, Nhập Excel điều phối, Tải mẫu điều phối; tự chọn đợt nhập mới và có phục hồi cùng request. App chính hiện chưa có SavedFolderBatch; catalog604 và nguồn pilot là kho riêng. Excel ba sheet từ `/v1/prepared-batches/template` đúng parser hiện tại; phiếu bàn giao hai sheet cũ không phải mẫu auto-import. PreparedBatch vẫn sandbox, context app chính unavailable, giới hạn một thuộc tính/một giá trị và một kênh, giá/điều phối chung workbook. Chưa có cầu nối catalog604→production và chưa được giả lập nguồn trong DB chính để che khoảng trống.

**Thông tin chi tiết theo ngành:** người dùng muốn tận dụng nguồn có sẵn, chỉ bổ sung thiếu. API cho danh sách trường/lựa chọn; Word/Excel/nhãn và xác nhận người dùng mới chứng minh dữ kiện. Phải tách thuộc tính chung listing khỏi riêng SKU, không lấy một mùi/dung tích đại diện sai cho nhiều phân loại hoặc điền trường không phù hợp để tăng 3/12 thành 12/12. Hướng dẫn `docs/operator-guides/thong-tin-chi-tiet-theo-nganh.md`; đây chưa phải bộ tự điền đa ngành đã triển khai.

**Kiểm cuối:** 1529/1529 unit/integration, 7/7 legacy, typecheck/TS build/web build đều đạt lúc **08:47:19.288Z**. Browser fixture 14 ca nhập nguồn/controls + 11 ca tiếp tục + 1 ca thông báo QC chạy riêng; không gọi Shopee. Audit độc lập nhật ký cuối 21/21. Các kết quả thật chỉ chứng minh 2 listing / 15 SKU / 1 shop / 1 ngành đã chốt; không suy rộng 80 listing, nhiều shop hoặc chạy24h.

Bằng chứng private dưới `.local/production-pilot-1423724897/`: `row65-final-publication-audit.json`, `verification-bulk-final.json`, `test-results-bulk-final.json`, `continuation-inspection-40f507b0-f9a8-4a7a-ab99-cc5b0ac89d58.json`, `weight-reviews/`, `cover-qc-51267858328/`, `wire-evidence/`. Runtime cuối API4310 PID30708 / UI5173; kiểm cổng trước khi khởi động lại. Không commit `.local`. Bản đầy đủ: `docs/delivery/2026-09-15-bulk-continuation.md`.

## 19. PASS1 bốn bộ mới — 15/09, sau 17:23 UTC+7

Đọc `docs/delivery/2026-09-15-pass1-batch.md` trước khi tiếp nối. Nguồn mới từ PASS 1 ĐĂNG BÀI và bốn thiết kế Canva đã được tải nguyên, ánh xạ theo SKU với DORIS. Người dùng chốt shop 1423724897, giá gốc SHOP MALL, tồn 100/SKU, kiện ước tính 12 × 12 × 28cm; 510 giữ 16 mùi × 3 dung tích, 777 thêm 100ml vào tiêu đề, thành phần theo nhãn Nguyên chất 100%, giữ cảnh báo. 775/777/772 giữ trang Canva 2–10 và lưu riêng trang 11. Không tự thay nguồn khác.

**510 / row-119 revision 3 đã tạo UNLIST item 53267854751 bằng API**, operation `2c492b36-39d3-4536-92fa-6232e0efeb4e`, fingerprint `c7401d3fdbca5fa7e39062724461b32952abfb21408d799b11953d2abb1136d5`, 26 upload + create + init đều ACK. Ngành **102572 Nước hoa xe** và brand **1252097 VINA TƯƠI** đã được API lưu đúng; không cần đổi ngành ô tô để tìm thương hiệu. Hai readback ổn định; audit độc lập 928 phép đối chiếu, 832 khớp và 96 khác biệt cân nặng (48 model × 2 lần đọc). Toàn bộ nội dung, giá, tồn, SKU, phân loại và vận chuyển còn lại khớp. Bìa case `4b9a68a1-9fa7-4f7d-a1cc-95b3a0424eac` verified/manual_review bởi Codex QA (agent), PNG→JPEG cùng hình 1024². Không sửa source/raw để làm QC xanh.

**Đang chờ người dùng trả lời câu hỏi cân nặng cho cả PASS1**: nguồn 100/300/500ml là 130.9/322.3/503.8g, Shopee lưu 131/322/504g. Phiếu đồng ý pilot row65 cũ không áp cho operation mới. Nếu người dùng chấp nhận, tạo phiếu riêng theo đúng operation/fingerprint/modelID/SKU/tier và hai raw read; sau đó tiếp tục QC/publish qua runner, không phát lại create/init. HTTP reconcile `df694eb5-2e61-4212-b30f-07d0fc447d69` đã kết thúc READBACK_MISMATCH, không còn job đang chạy.

**775 / row-193 revision 2** kiểm trước đăng đạt, chưa gửi. **777/772** giữ lại trước ghi: ngành **100265 Khử mùi giày dép** trả `size_chart_mandatory=true`, `get_size_chart_list` thật trả `total_count=0`, chưa có bảng phù hợp trong nguồn. Không đăng ký bảng chân/dung tích giả hay chuyển ngành để vượt yêu cầu. Bằng chứng `size-chart/3878c5e0-8157-49be-b571-56a1715e1b89/summary.json`.

App **Đăng hàng → Đăng theo đợt** đã nối HTTP → service → coordinator → API backend; hiển thị đúng hai nhóm ready/held, mã Shopee thật và số biên nhận. Backend giữ registry/proof và chặn thao tác ghi nhóm held. Mỗi manifest chứa hai listing/96 SKU/52 ảnh: ready batch `e60446aa-8fed-45e6-8cd8-52b0eee04a47` SHA `61929783333e7895167055a9083084f6e8ca948289fdebd655e9dc3c96d594e2`; held batch `4d653a20-c148-45de-b02f-dda6f2232e7b` SHA `36773af538506f31422f37653c6c04e1e907b4a03d42d9bc1d6f05f0d6d45467`. Không đổi manifest ready sau reservation, không dùng lại candidate bốn nguồn để ghi. UI chỉ gửi ID/mode/fingerprint, không nhận đường dẫn hoặc quyền tự mở writer từ browser. Luồng nhập tùy ý từ thư mục/Excel đến production vẫn chưa nghiệm thu tổng quát.

**Kiểm cuối:** 1627/1627 unit/integration + 7/7 legacy đạt, full report lúc 10:16:18.184Z đã gồm ca held cuối. Typecheck/TS build/web build kiểm lại sau khi code dừng đều đạt. 8/8 browser fixture kiểm riêng lúc 10:23:12Z, không gọi Shopee. App thật đã kiểm hiển thị nhóm giữ lại không có nút ghi và nhóm có item 53267854751. Chưa có 4/4 mở bán, 80 listing/multi-shop/24h. Hai pilot cũ không phát lại.

Bằng chứng private `.local/production-batch-pass1-20260915/`: `verification-1627.json`, `test-results-1627.json`, `final-build-verification.json`, `final-held-coverage-audit.json`, `final-held-ui-results.json`, `final-web-status.json`, `source-audit/510-live-independent-audit.json`. API PID20896 cổng4310, UI PID23320 cổng5173; khi restart API cần `TSX_TSCONFIG_PATH=C:/shopee_product_uploader/apps/api/tsconfig.json` và `PRODUCTION_PILOT_ENABLED=1`, dùng cửa sổ ẩn, kiểm job/cổng trước. Token revision2 hết hạn 12:38:54.454Z; không có lịch refresh tự động. Không in token hoặc commit `.local`.

## 20. Workflow production và thời gian thực thi — 15/09

Đọc [bàn giao workflow](../delivery/2026-09-15-production-workflow.md) và [hướng dẫn nhân viên](../operator-guides/dang-hang-tu-bo-listing-da-luu.md). Phần dưới thay thế trạng thái triển khai ở các mốc trước, không thay đổi biên nhận lịch sử.

### Đã triển khai

Luồng **ListingDraft đã lưu → kiểm nguồn/metadata → snapshot và manifest v2 → nhóm tối đa 4 → parent execution → ProductionBatchService → OpenAPI/journal/QC**. Có thể chuẩn bị tối đa 80 bộ đã lưu. Server kiểm giá theo ô workbook và byte ảnh, giữ nguyên tên/thứ tự phân loại, nguồn đã xác nhận và tồn 0. Browser không được cung cấp đường dẫn file hoặc quyền mở writer. Mapping kho cần bằng chứng từ operation verified và lần đọc mới; không mặc định VNZ/null.

Migration **025_production_preparations.sql** đã áp dụng mainDB, thêm preparation và parent execution. Preview có khóa nguồn, registry và công việc lưu bền theo phiên bản. Parent chạy tuần tự, dừng nếu một nhóm chưa hoàn tất. Sau crash, child chỉ được đọc đối chiếu toàn lô để tạo bằng chứng phục hồi; giữ nguyên lịch sử request và kết quả chưa rõ. Parent cần pool tối thiểu 4, mặc định local 10; child cần tối thiểu 2. Chưa phải scheduler đa máy hoặc vận hành 24 giờ.

UI **Đăng hàng** mặc định **Đợt đang làm**; tab **Chuẩn bị lô mới** giữ lựa chọn khi đổi tab. Sau preview/đăng ký vẫn ở lại để bấm đăng và theo dõi. Có metadata shop/ngành/thương hiệu/thuộc tính/kênh và chọn sản phẩm tham chiếu kho. Review cân nặng chỉ mở khi hai raw read mới khớp mọi trường khác; chưa có quyết định chấp nhận PASS1.

### Kiểm chứng mới

- Full verify kết thúc **11:35:15.636Z**: **1751/1751 unit/integration, 93 file, 0 skip; 7/7 legacy; typecheck/TS build/web build đạt**. Sau chỉnh UI cuối, **17/17 browser fixture** và type/build đạt riêng. File tại `.local/production-workflow-20260915/verification-1751.json`, `test-results-1751.json`; không dùng `.local/e2e-results.json` ngày 12/09 cũ.
- **80 DOCX + 240 PNG + Excel → 80 draft/160 SKU/3 ngành fixture → 20 manifest** mất **25.583 giây**, không gọi Shopee. Receipt `.local/production-batch-pass1-20260915/draft-source-acceptance-DZoIa6/source-preparation-acceptance.json`. Không phải 80 listing đăng thật.
- GET thật trên **775**: **48 GET/25.770s** lần đầu; **4 GET mới + 44 cache/3.241s** trong cùng phiên. Nguồn có quyết định miễn kiểm trùng riêng, không áp số đo cho mọi nguồn/shop. File `read-performance-1789471776770.json`.
- HTTP metadata 6 GET xác nhận mapping kho đúng shop, ref **51267858328** và operation verified **007738be-04ec-4ead-88d2-825062b29056**; file `live-metadata.json`. Danh sách 1.821 ngành/31 kênh không chứng minh tất cả được phép hoặc phù hợp sản phẩm.
- Hash **13 bảng nguồn/biên nhận/kết nối trước và sau bằng nhau**: `before.json`, `after.json`. Lượt cải tiến này không ghi Shopee.

### Trạng thái thực tế cần tiếp nối

- **510 / item 53267854751** vẫn **UNLIST**, operation **2c492b36-39d3-4536-92fa-6232e0efeb4e**, 28 bước ACK; không replay create/init. HTTP chỉ đọc đối chiếu **6eedf181-43c0-4b67-a097-229b4d0afa3c** kết thúc **11:34:03.505Z**, READBACK_MISMATCH. GET review eligible=true/approved=false: **130.9→131g, 322.3→322g, 503.8→504g**, mỗi nhóm 16 SKU. File `live-weight-review.json`; chấp nhận Ngọc Lan Tây cũ không áp dụng.
- **775 chưa gửi; 777/772 thiếu size chart.** Không đăng ký ngành/thương hiệu hoặc chuyển ngành để tránh điều kiện. VINA TƯƠI **1252097** đã được lưu đúng trong ngành **102572 Nước hoa xe** trên 510.
- Hai pilot **51467852283 / 51267858328** đã verified NORMAL; không phát lại. Quyền production chỉ đúng shop 1423724897 và nguồn/điều chỉnh người dùng đã chốt.
- App chính có **1 canonical draft Lamy, 2 pricebook, 0 preparation mới**. PASS1 dùng manifest đã đăng ký riêng. Catalog604 còn cần ảnh/SKU/giá và ánh xạ đủ; không nạp 80 mock vào mainDB. Chưa nghiệm thu 80 listing thật, nhiều shop, mọi nhóm patch hoặc 24h.

API4310 đã restart ẩn **PID30404**, UI5173 **PID23320**; health/new routes/UI đã kiểm. Khi restart phải kiểm PID/job mới, giữ flags và tsconfig ở mục19. Token revision2 hết **12:38:54.454Z** theo lần đọc trước; cần kiểm hiệu lực khi tiếp tục. Chưa có lịch tự refresh. Giữ bằng chứng trong `.local/production-workflow-20260915/`, không in/commit token hoặc nguồn riêng.

## 21. Xịt thơm ô tô và xịt khử mùi thảm đã mở bán — 16/09/2026

Đọc [kết quả tiếp tục PASS1](../delivery/2026-09-16-pass1-continuation.md). Mốc này thay thế trạng thái chờ cân nặng/chưa gửi của hai sản phẩm ở mục19–20; các biên nhận và quyết định lịch sử vẫn giữ nguyên. **Nhóm sẵn sàng PASS1 đã đạt 2/2 listing, 96 SKU; toàn PASS1 bốn nguồn vẫn là 2 đã mở bán và 2 đang giữ lại.** Gọi tên sản phẩm trước, mã nguồn chỉ để tra cứu.

### Quyết định nguồn và kết quả thật

Ngày16/09, người dùng cho phép cân nặng/kích thước thử hợp lý và ghi việc cần người vận hành xử lý. Hai listing dùng đúng cột **J: CÂN NẶNG KHAI BÁO (G)** của DORIS: 130.9/322.3/503.8g, Shopee lưu 131/322/504g. Giữ nguyên số nguồn và payload; mỗi operation có phiếu chấp nhận làm tròn gắn đúng model/SKU và hai raw read mới. Kiện **12 × 12 × 28cm** là ước tính đã được cho phép cho lô thử, không phải số đo lấy từ workbook. Không áp các quyết định này làm mặc định cho nguồn khác.

| Sản phẩm | Item / số SKU | Operation tạo | Publication verified | Hai lần đọc NORMAL ngày16/09 (UTC) |
| --- | --- | --- | --- | --- |
| Xịt thơm ô tô VINA TƯƠI (510 / row-119 rev3) | 53267854751 / 48 | `2c492b36-39d3-4536-92fa-6232e0efeb4e` | `0b003112-4929-4191-8fc0-aea9d7a1fa49` | 01:41:48.463Z / 01:41:49.537Z |
| Xịt khử mùi thảm VINA TƯƠI (775 / row-193 rev2) | 45467915350 / 48 | `7d712c1c-9c92-4e85-8ece-96bd6a4f4ee7` | `a0ae5d7d-1dd2-4a43-8b08-bdfb4a7c47a7` | 02:05:27.992Z / 02:05:28.868Z |

Mỗi sản phẩm có **266/266 phép kiểm độc lập đạt**: nguồn/ô giá DORIS, 26 biên nhận ảnh, payload tạo/phân loại, 48 SKU, giá gốc SHOP MALL, tồn100/SKU, nội dung, bìa, 9 gallery đúng thứ tự, ngành/thương hiệu, vận chuyển và các trường raw được bảo vệ. Khi mở bán, chỉ trạng thái đổi sang NORMAL. Mỗi operation có 26 upload + create + init đã ACK và chỉ một request mở bán; không phát lại create/init/upload. Khóa của hai operation đã giải phóng. Bìa dùng phiếu QC ảnh riêng, PNG→JPEG được Codex QA (agent) đối chiếu; đây không phải người dùng duyệt hoặc xác minh tuyên bố trên nhãn.

Nhóm ready `e60446aa-8fed-45e6-8cd8-52b0eee04a47`, manifest SHA `61929783333e7895167055a9083084f6e8ca948289fdebd655e9dc3c96d594e2`, đã hoàn tất và không còn cho execute. Không đổi manifest hoặc gửi lại để kiểm tra.

### Hai sản phẩm còn chờ xử lý

**Xịt khử mùi tủ giày (777) và xịt khử mùi giày da nam (772)** chưa gửi. GET mới ngày16/09 vẫn trả ngành **100265 Khử mùi giày dép** yêu cầu size chart và shop có **0 bảng**. Brand **1252097 VINA TƯƠI** đã có bằng chứng trong danh sách của ngành; vướng hiện tại là bảng kích cỡ, không phải thiếu thương hiệu. Kích thước kiện không thay cho size chart.

Registry nhóm held `4d653a20-c148-45de-b02f-dda6f2232e7b` giữ nguyên, không đổi ngành/brand, đăng ký bảng giả hoặc nới điều kiện API. Đã có [phiếu việc người vận hành cần xử lý](../operator-guides/pass1-viec-can-xu-ly-tay.md); chưa có codec size chart cho PASS1 hoặc tự đồng bộ kết quả đăng tay vào app.

### Sửa lỗi, kiểm chứng và trạng thái chạy

- Lần đầu chuẩn bị xịt khử mùi thảm bị chặn trước operation/upload vì thời điểm đọc kho mới hơn mốc metadata tổng hợp403ms. Collector đã sửa `observedAt` theo bằng chứng mới nhất, **`expiresAt` vẫn theo bằng chứng cũ nhất +15 phút**. Cache giữ nguyên thời điểm/request ID/tệp gốc; guard kho không nới. Hai hồi quy cold/warm đi qua guard thật; 72 kiểm thử mục tiêu đạt.
- Full verify hoàn tất **2026-09-16T02:01:21.972Z**: **1753/1753 unit/integration +7/7 legacy**, typecheck/TS build/web build đạt. **1/1 browser fixture tên sản phẩm** đạt riêng ngày16/09; không cộng 17 browser fixture ngày15/09 thành lượt mới.
- GET độc lập lúc **02:08:11.330Z** xác nhận bốn item của các lượt đều NORMAL: can5L **51467852283 /12 SKU**, Ngọc Lan Tây **51267858328 /3 SKU**, xịt thơm ô tô **53267854751 /48 SKU**, xịt khử mùi thảm **45467915350 /48 SKU**. Tổng **4 listing /111 SKU-instance**, gồm hai listing cũ và hai mới; không phải 111 SKU sản phẩm duy nhất. Lần đọc này có **0 mutation**, hai pilot cũ không phát lại.
- Kết nối production refresh một lần **revision2→3**, hết hạn **2026-09-16T05:38:40.316Z**; chưa có lịch tự refresh24h. API4310 **PID22356**, UI5173 **PID23320** tại checkpoint; kiểm lại PID/job và hạn kết nối trước khi tiếp tục. Không in token.

Bằng chứng private: `.local/production-pass1-20260916/510-publication-audit.json/md`, `carpet-publication-audit.json/md`, `full-verification.json`, `full-test-results.json`, `status-read/e30ae4bc-7029-4c74-b6d5-b032e29682bb/summary.json`; UI tại `.local/production-workflow-20260916/product-name-results.json`. Bằng chứng size chart mới tại `.local/production-batch-pass1-20260915/size-chart/4a8ca4d1-7645-420e-bf25-b66f707d522c/summary.json`. Không commit `.local`.

**Giới hạn còn lại:** chưa nghiệm thu 80 listing production, nhiều shop, mọi nhóm cập nhật hoặc chạy24h; catalog604 chưa tự thành bộ nguồn đủ điều kiện đăng. Hai sản phẩm giày còn cần xử lý. Kết quả hai listing mới không có nghĩa toàn dự án đã hoàn tất.
