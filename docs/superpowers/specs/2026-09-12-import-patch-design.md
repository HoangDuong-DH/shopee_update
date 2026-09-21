# Nhập bộ cập nhật theo nguồn

Ngày 12/09/2026. Người dùng đã yêu cầu import làm luồng chính cho mọi yếu tố, áp dụng patch thay vì nhập tay từng SKU, và giao các agent phản biện rồi triển khai. Đây là sửa kiến trúc input đã được yêu cầu, không mở quyền ghi shop thật.

## Hợp đồng nghiệp vụ

- Tiếp nhận nhiều tệp Excel, Word và ảnh gốc, nhóm theo listing đã chuẩn bị. Không tự tạo/chia/gộp SKU, viết lại nội dung, cắt ảnh hoặc đổi nguồn doanh nghiệp.
- File giá cập nhật không cần tên sản phẩm hay bộ listing đầy đủ. SKU chính xác; chọn rõ sheet và bộ giá. GIÁ GỐC là giá gốc, GIÁ BÁN chỉ là mục tiêu khuyến mại. TỒN ĐĂNG BÁN là số lượng bán do người vận hành quyết định, không suy từ tồn vật lý.
- Thiếu cột/ô/tệp là giữ nguyên. Số tồn 0 là lệnh có giá trị. Không hỗ trợ suy luận xóa từ thiếu nguồn. Sai số, công thức không có kết quả, cột mơ hồ, SKU trùng phải thành ngoại lệ.
- Đích là công việc đã lưu có shop, product/source revision, item đích cho update. Không ghép chỉ từ tên/độ giống. Giá theo shop không được ghi ngược lên bộ listing chung.
- Mỗi patch lưu sources (hash, import, sheet/row hoặc paragraph/image role), selection, scope và before/after. Snapshot nguồn cũ chỉ được ghi nhãn "Bản nguồn đã lưu", không phải "Trên Shopee". Remote comparison chưa có thì giữ chưa đọc.
- Import lại cùng ý định phải tìm được biên nhận cũ; receipt lưu nguồn/công việc không phải receipt đã ghi Shopee. Việc áp tồn một lần phải do execution receipt bảo đảm; không tự bù tồn do đơn hàng.
- Ảnh/Word chỉ có trong bộ cập nhật được chọn. Word chọn nguyên đoạn, không gõ lại. Vai trò ảnh và đích phải rõ; điểm mơ hồ cần người vận hành chọn qua ảnh thu nhỏ, lưu quyết định cho đợt.
- Một workbook có thể ánh xạ nhiều khối/bộ giá; mỗi khối có nhóm công việc/shop riêng. Không suy Mall/thường từ tên shop hoặc tự phát giá/tồn sang mọi đích đang chọn.
- Một ảnh có thể dùng nhiều vai trò bằng cùng nguồn bytes. Thứ tự thuộc từng công việc/vai trò; thay thứ tự gallery không được tự đổi thứ tự ảnh mô tả.
- Chọn/bỏ chọn hàng loạt tác động các thay đổi hợp lệ đang lọc, giữ lựa chọn ngoài bộ lọc. Trong lúc kết quả lưu chưa rõ, giữ nguyên request và khóa chỉnh sửa; tải lại trong phiên phải dùng lại request đó.

## Lát cắt thực thi

Tái dùng source_files, importer, công việc và blob. Thêm parser Excel thưa và dịch vụ import-patch với phiên bản/biên nhận trong PostgreSQL. Soạn và lưu patch không tạo product revision hay gửi Shopee. Công việc hiển thị bộ cập nhật liên quan và trường chưa có executor; chưa phát hành hành vi ghi mà không được kiểm thử.

Một màn hình chính "Nhập bộ cập nhật" nhận file/folder, chọn công việc/shop, tự ghép SKU duy nhất, giải quyết Word/ảnh mơ hồ, xem diff có provenance và chọn thay đổi, lưu/mở lại đợt qua API. Giao diện không có form giá/tồn từng SKU làm baseline. Thao tác mở/lưu không phụ thuộc console kỹ thuật hay JSON người dùng tự soạn.

## Nghiệm thu lát cắt

HTTP integration dùng PostgreSQL schema riêng: sparse giá-only, stock-only zero/blank, media-only giữ phần khác, Word giữ khoảng trắng, duplicates/ambiguous SKU, cross-shop isolation, source/target drift, save double-click/reload, semantic duplicate, unsupported field visible. Browser chạy upload thật vào API cô lập (không Shopee), xem bảng diff rồi lưu/mở lại; kiểm màn hình hẹp. Nguồn Lamy revision 1 và mọi bằng chứng sandbox cũ không bị thay đổi.

## Các cổng phát hành còn lại của toàn dự án

Import-patch không đóng các cổng còn thiếu: remote item/model registry, scoped patch executor/lease/readback đa trường, token refresh, dynamic ngành/thuộc tính/khuyến mại/QC, phục hồi unknown bìa Lamy, worker 24h, backup/restore, triển khai nội bộ và pilot production có phạm vi được phép. Không được đổi nhãn những cổng này thành hoàn thành bằng test local.
