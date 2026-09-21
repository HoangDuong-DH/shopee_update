# Chuẩn bị bộ Canva và workbook để nhập listing

Đối chiếu mã nguồn ngày 16/09/2026. Có thể chuẩn bị thư mục và nhập nguồn ngay. Một thư mục đã nhập chỉ trở thành nguồn đăng sau khi ghép đúng nội dung, ảnh, SKU, giá và lưu listing; tải đủ ảnh Canva chưa có nghĩa đã đủ điều kiện đăng.

## Cách xếp thư mục dùng được hiện tại

```text
ĐỢT ĐANG CHUẨN BỊ/
  Nguồn gốc/                 ← giữ workbook và toàn bộ trang Canva nguyên bản
  Bảng giá/                  ← workbook giá được chọn, nhập riêng một lần
  Hồ sơ đối chiếu/           ← nguồn từng ô, từng thiết kế/trang và vai trò ảnh
  Listing/                   ← chọn thư mục này khi nhập nhiều listing
    Tên sản phẩm thứ nhất/
      Nội dung.docx
      Ảnh/                   ← các ảnh thuộc đúng listing này
    Tên sản phẩm thứ hai/
      Nội dung.docx
      Ảnh/
```

Tên trên chỉ minh họa cách xếp. Ứng dụng không bắt đổi tên Word hoặc ảnh đang có. Các thư mục listing phải nằm ngay dưới thư mục được chọn; ảnh có thể nằm trong thư mục con của từng listing. Không chọn cả thư mục chứa bảng giá, hồ sơ và nguồn gốc làm thư mục cha của listing.

- Nhập nhiều listing: chọn `Listing`, chọn **Mỗi thư mục con là một listing**.
- Nhập một listing: chọn thẳng thư mục sản phẩm, chọn **Thư mục này là một listing**.
- Chọn đúng workbook giá, sheet và bộ giá; giữ SKU dạng chữ, kể cả số 0 ở đầu. Dữ liệu nội dung trong `Copy of SHOP VINA TƯƠI` không thay cho bảng giá DORIS và không được đọc bằng quy tắc cột DORIS.
- Chọn Word, ảnh bìa, thứ tự ảnh sản phẩm, thứ tự ảnh mô tả và ảnh từng SKU. Tên `g1`, số trang Canva hoặc tên mùi riêng lẻ không tự chứng minh vai trò hay SKU.
- Hoàn thiện danh sách SKU, tên và thứ tự phân loại theo nguồn đã chuẩn bị, đối chiếu giá rồi lưu listing. Không tự chia/gộp listing hoặc tạo tổ hợp SKU chỉ vì thấy đủ tên mùi và dung tích.

## Nội dung Word

Luồng nhập thư mục đọc `.docx`; ảnh nhúng trong Word không được trích thành bộ ảnh đăng. Giữ các ảnh gốc thành tệp riêng.

Khi tạo **bản Word dẫn xuất** từ ô nội dung workbook, giữ nguyên chữ, cảnh báo và thứ tự; ghi workbook/sheet/ô nguồn trong hồ sơ đối chiếu, không sửa workbook gốc. Bố cục dưới đây được cả hai bộ đọc nhận biết:

```text
TIÊU ĐỀ
[Một đoạn chứa đúng tiêu đề đã chuẩn bị]
BÀI MÔ TẢ ĐĂNG BÁN
[Các đoạn mô tả nguyên văn]
```

Đây là minh họa cấu trúc, không phải nội dung sản phẩm để nhập. Mỗi dòng nhãn và tiêu đề là một đoạn Word. Với bộ đọc Excel kỹ thuật, ba đoạn đầu phải liền nhau, không có đoạn rỗng xen giữa; chỉ một nhãn tiêu đề và một nhãn mô tả. Bộ đọc này lấy đoạn mô tả đầu trước ảnh mô tả, rồi các đoạn còn lại sau ảnh. Nếu cách bố trí đó không đúng bộ đã chuẩn bị, dùng phần chọn nội dung/ảnh trong luồng nhập thư mục, không tự viết lại nội dung để qua kiểm tra.

Luồng nhập thư mục còn nhận nhãn `MÔ TẢ SẢN PHẨM` và cho chọn đoạn nội dung khi cấu trúc Word khác. Cần kiểm bản xem trước trước khi lưu.

## Giữ nguồn Canva và ghép đúng sản phẩm

Với thư mục Canva `FAHUmIOUUyk`, lưu toàn bộ thiết kế và trang đã lấy được vào nguồn gốc, giữ mã thiết kế, số trang gốc, tên nguồn, đường dẫn và dấu kiểm tệp. Không trải tất cả ảnh vào một thư mục chung rồi đánh số lại mất nguồn. Một thiết kế Canva hoặc một trang không mặc nhiên tương ứng một listing.

Mỗi ảnh đưa vào listing cần truy được về thiết kế/trang gốc và một vai trò rõ ràng: bìa, ảnh sản phẩm, ảnh mô tả hoặc ảnh SKU. Thứ tự cho từng vai trò ghi riêng. Các trang chưa dùng vẫn giữ nguyên trong nguồn gốc; phần chưa ghép chắc chắn ghi **chưa xác định**, không bỏ mất hoặc tự gán cho sản phẩm gần giống.

Hồ sơ đối chiếu này là tài liệu kiểm nguồn của đợt, **chưa phải một định dạng tệp mà giao diện tự nhập**. Việc ánh xạ phải được chuyển vào lựa chọn của listing đã lưu. Giữ bìa 1:1 và ảnh sản phẩm 3:4 theo bộ đã chuẩn bị; không crop, thêm chữ hoặc tạo ảnh thay nguồn.

## Excel ba sheet: dùng đúng phạm vi

Nút tải mẫu trong **Thực hiện theo lô** tạo workbook ba sheet bên dưới. Đây là bộ đọc kỹ thuật tổng quát dành cho sandbox; nó chặn shop production. Mẫu không phải đường tắt từ thư mục Canva thô đến đăng shop thật. Bảng bàn giao hai sheet `Bộ listing`/`Phân loại` cũng chưa phải định dạng tự nhập của bộ đọc này.

**Điều phối listing** — một dòng mỗi listing, tên cột ở hàng 1:

```text
THƯ MỤC | SHOP ID | BẢNG GIÁ | MÃ NGÀNH | MÃ THƯƠNG HIỆU |
MÃ THUỘC TÍNH | MÃ GIÁ TRỊ | KÊNH VẬN CHUYỂN | CÂN NẶNG G |
DÀI CM | RỘNG CM | CAO CM | WORD | ẢNH BÌA | ẢNH GALLERY |
ẢNH MÔ TẢ | TÊN TẦNG 1 | TÊN TẦNG 2
```

**Bảng giá** — một dòng mỗi SKU:

```text
SKU | TÊN SẢN PHẨM | NGÀNH HÀNG | BRAND | GIÁ GỐC | GIÁ BÁN |
CÂN NẶNG KHAI BÁO G | THƯ MỤC | TỒN BÁN | PHÂN LOẠI 1 |
PHÂN LOẠI 2 | ẢNH PHÂN LOẠI
```

**Hướng dẫn** — giải thích cách điền; không chứa sản phẩm mẫu.

Các ràng buộc cần biết:

- `BẢNG GIÁ` là tên sheet trong **chính workbook điều phối**. `THƯ MỤC` ở dòng giá phải khớp dòng điều phối và thư mục đã nhập; chỉ dùng tên cuối thư mục khi tên đó khớp duy nhất.
- Tên tệp là đường dẫn tương đối trong listing, có thể là `Ảnh/ten-goc.png`; dùng dấu `/`, không dùng đường dẫn ổ đĩa hoặc `..`.
- `ẢNH GALLERY` và `ẢNH MÔ TẢ` là danh sách JSON có thứ tự, ví dụ `[]` nếu không có ảnh mô tả. Không nhập danh sách bằng dấu phẩy thường. Bìa phải vuông, ít nhất một ảnh gallery đúng 3:4. Không lặp đường dẫn trong cùng danh sách.
- Cấu trúc hỗ trợ 0–2 tầng; không có tầng thì chỉ một SKU. Mỗi SKU và tổ hợp lựa chọn phải duy nhất; thứ tự xuất hiện trong dòng giá quyết định thứ tự lựa chọn.
- `GIÁ GỐC` là giá đăng mới theo đúng bộ giá, không tự dùng `GIÁ BÁN`. `TỒN BÁN` là số nguyên không âm theo quyết định đúng SKU/shop; 0 khác với để trống. Không mặc định 100 hoặc sao chép lệnh tồn của đợt cũ.
- Chỉ nhập giá trị, không công thức. Giữ tiêu đề cột hàng 1. Mã dạng chữ số; số cân/kích thước dùng số dương và dấu chấm thập phân nếu cần.
- Bộ đọc này chỉ mang **một thuộc tính/một giá trị chọn sẵn và một kênh vận chuyển**; cân nặng điều phối là một số chung cho listing. Nó không biểu diễn đủ mọi thuộc tính, custom value, size chart hoặc cân nặng riêng từng SKU.

## Điểm còn thiếu trước khi đăng shop thật

| Phần nguồn | Điều đã hỗ trợ | Việc phải hoàn tất cho đợt thật |
|---|---|---|
| Thư mục Word và ảnh | Nhận, giữ tệp và đối chiếu từng listing | Ghép đủ vai trò, thứ tự, phân loại rồi lưu listing |
| Workbook nội dung và Canva | Đã có kho tham khảo; không tự thành bộ đăng | Lấy đủ tệp gốc, nối đúng dòng nội dung ↔ thiết kế/trang ↔ SKU |
| Giá | Chọn đúng workbook/sheet/bộ giá và SKU | Kiểm giá gốc tới ô nguồn; không dùng bố cục workbook khác |
| Đăng theo đợt production | Nhận listing đã lưu; chọn tối đa 80, chia nhóm tối đa 4 | Đúng shop, tồn, kho, cân/kiện, ngành/brand/thuộc tính có nguồn và metadata hợp lệ |
| Ngoại lệ ngành | Giữ lý do chặn | Size chart, thuộc tính thiếu/mâu thuẫn hoặc quyền chưa có phải được xử lý riêng |

Sau khi các listing đã lưu đủ nguồn: vào **Đăng hàng → Chuẩn bị lô mới**, chọn bộ cần đăng, xem trước và xử lý ngoại lệ. Luồng production hiện giới hạn shop đã nghiệm thu; kiểm 80 nguồn mô phỏng không phải 80 listing đã đăng thật. Sản phẩm đã tạo hoặc đang có kết quả chưa rõ phải đối chiếu nhật ký, không đưa lại vào đăng mới.

Nguồn đối chiếu triển khai: `apps/web/src/ListingFolderGuide.tsx`, `FolderIntake.tsx`, `folder-source.ts`; `apps/api/src/prepared-template.ts`, `prepared-source.ts`, `production-draft-source.ts`; `packages/domain/src/source/word.ts`; [luồng từ listing đã lưu](dang-hang-tu-bo-listing-da-luu.md), [hướng dẫn chuẩn bị bộ listing](chuan-bi-bo-listing.md), [checkpoint production ngày 16/09](../delivery/2026-09-16-pass1-continuation.md).
