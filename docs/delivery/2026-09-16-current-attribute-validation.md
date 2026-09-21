# Kiểm thuộc tính theo ngành hiện tại — 16/09/2026

Bước thu thập dữ liệu trước khi đăng production đã dùng bộ kiểm chung cho cây thuộc tính của đúng ngành đang xử lý. Bộ kiểm đối chiếu giá trị đã chọn với metadata hiện tại; không sửa giá trị nguồn, chọn thêm thuộc tính, đổi thứ tự SKU hoặc cấp quyền ghi. Không có gọi Shopee, đọc/ghi DB chính hoặc khởi động lại API trong lượt triển khai này.

Thuộc tính con chỉ hoạt động khi giá trị cha tương ứng hợp lệ và đã được chọn. Khi nhánh hoạt động thiếu trường bắt buộc, dữ liệu bị chặn. Cùng một ID con có thể xuất hiện ở các nhánh khác nhau; các định nghĩa cùng hoạt động phải thống nhất. Thứ tự khóa trong JSON hoặc thứ tự các lựa chọn metadata không gây mâu thuẫn giả.

Bộ kiểm phân biệt năm kiểu nhập, số giá trị tối đa, ID định sẵn và giá trị tự nhập. Loại FREE_TEXT dùng `value_id=0` cùng nội dung có nguồn; không tự tạo giá trị từ nhãn gần giống. Số nguyên, số thập phân và ngày được kiểm theo kiểu API trả về. Ngày gửi API phải là chuỗi Unix seconds theo tài liệu; ứng dụng không đoán hoặc đổi chuỗi ngày hiển thị. Giá trị tự nhập định lượng phải có đúng đơn vị API cho phép. Lựa chọn định sẵn có thể chỉ gửi ID; nếu nguồn có thêm đơn vị thì phải khớp đơn vị của chính ID đó.

Giới hạn thiếu, cây lỗi, ID không còn tồn tại, thuộc tính thuộc nhánh chưa chọn, đơn vị đổi hoặc lựa chọn trùng đều bị chặn. Các giới hạn kích thước cây là bảo vệ tài nguyên cục bộ, không phải quota Shopee. Bộ kiểm không suy giới hạn shop từ ví dụ tài liệu. Cơ chế kiểm shop, revision kết nối, thời hạn metadata tối đa 15 phút, nguồn bất biến, thương hiệu, tồn, vận chuyển và media của luồng đăng được giữ nguyên.

Phạm vi mã:

- `packages/shopee/src/attribute-validation.ts`: hàm thuần `validateAttributeSelection`, được xuất qua package gateway.
- `apps/api/src/production-pilot-source.ts`: kiểm tập thuộc tính nguồn bằng cây ngành của phiên đọc trước đăng; thay vòng kiểm cũ chỉ nhìn thuộc tính gốc và chưa nhận FREE_TEXT loại 3.
- `packages/shopee/src/prepared-metadata.ts`: kiểm chung sau bước ánh xạ ID/tên có sẵn. Bộ ánh xạ này vẫn không đoán giá trị tự nhập từ chuỗi chưa xác định.

Kiểm riêng trên mã ổn định lúc **09:26 UTC / 16:26 UTC+7**: **227/227 ca trong 8 tệp unit** đạt; gồm 27 ca của bộ kiểm mới, 54 ca bộ đọc nguồn production, 16 ca metadata và các hồi quy nguồn/codec liên quan. Các ca mới đã được chạy đỏ trước sửa: 6 ca thất bại đúng lỗi cũ, sau đó đạt. Kiểm kiểu và TypeScript project/declaration build đều đạt. Đây là kiểm bằng phản hồi API giả lập và nguồn kiểm thử cục bộ, không phải listing production mới hoặc nghiệm thu mọi ngành thật. Lượt kiểm tổng do điều phối viên chạy riêng sau khi các mô-đun chốt.

Giới hạn còn lại được giữ rõ: nhiều giá trị tự nhập cùng `value_id=0` được hàm thuần hiểu, nhưng bộ biên dịch nguồn/codec và đối chiếu production hiện vẫn chặn dạng này để tránh nhận sai bằng chứng chỉ dựa vào ID. Chưa nới chặn đó khi chưa có đối chiếu đầy đủ theo cả nội dung và đơn vị. Mọi object thuộc tính đã lưu có nhãn cũng chưa được tự chuyển sang hợp đồng nguồn production. API tìm giá trị ngoài cây chưa được bổ sung. Writer vẫn trong phạm vi shop pilot hiện có; không biến kiểm fixture đa ngành thành nghiệm thu đa shop production.

**Bổ sung 09:39 UTC:** hàm thuần giữ hợp đồng DATE/Unix seconds đúng tài liệu, nhưng collector production chặn thuộc tính DATE đang chọn bằng `PRODUCTION_PILOT_ATTRIBUTE_DATE_READBACK_UNSUPPORTED` trước khi chuyển sang writer. Shopee có thể trả ngày dạng `DD/MM/YYYY` hoặc `MM/YYYY`, còn comparator hiện so nhãn nguyên văn; chưa có đối chiếu theo định dạng/múi giờ có nguồn nên không ghi rồi để listing mắc ở QC. Lô thử cũ không có thuộc tính DATE. Hồi quy mới tái hiện đỏ trước sửa; **83/83** ca bộ kiểm và collector đạt sau sửa, mọi request trong ca DATE là GET và dừng trước phần preflight tiếp theo. Hồ sơ riêng `.local/attribute-date-readback-{red,green,type,build}.*`.

Bằng chứng riêng: `.local/attribute-validator-hook-red.log`, `.local/attribute-validator-focused-tests.json`, `.local/attribute-validator-focused-tests.log`, `.local/attribute-validator-typecheck.log`, `.local/attribute-validator-build-ts.log`. Không cộng các lượt kiểm riêng vào số ca của lượt tổng.

Nguồn kỹ thuật: [Attribute API guide 209](https://open.shopee.com/developer-guide/209), [Creating product guide 211 §2.2](https://open.shopee.com/developer-guide/211), [get_attribute_tree](https://open.shopee.com/documents/v2/v2.product.get_attribute_tree?module=89&type=1) và tham số `attribute_list` của `add_item` trong kho Shopee chụp **08/09/2026**. Guide 211 cập nhật **19/09/2025**, get_attribute_tree cập nhật **13/01/2025**. Điều kiện hiện hành của ngành/shop được lấy từ phiên đọc API khi xử lý, không được khẳng định mới chỉ từ bản chụp tài liệu.
