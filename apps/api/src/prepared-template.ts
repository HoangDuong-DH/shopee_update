import ExcelJS from 'exceljs';

// This is the existing dispatch contract, not a new catalogue or permission to publish.
const dispatchColumns = [
  ['THƯ MỤC', 'Tên thư mục listing đã nhập. Nếu tên trùng, dùng đầy đủ đường dẫn tương đối.'],
  ['SHOP ID', 'Mã shop đã kết nối. Bộ đọc tổng quát hiện chỉ hỗ trợ sandbox.'],
  ['BẢNG GIÁ', 'Tên sheet giá trong chính workbook này, ví dụ Bảng giá.'],
  ['MÃ NGÀNH', 'Mã ngành được đối chiếu từ metadata Shopee của đúng shop; không suy ra từ tên.'],
  [
    'MÃ THƯƠNG HIỆU',
    'Mã thương hiệu hợp lệ của ngành; chỉ dùng 0 khi nguồn xác nhận không thương hiệu.',
  ],
  [
    'MÃ THUỘC TÍNH',
    'Bộ đọc hiện chỉ hỗ trợ một thuộc tính chọn sẵn. Chưa hỗ trợ bảng thuộc tính đầy đủ.',
  ],
  ['MÃ GIÁ TRỊ', 'Một mã giá trị chọn sẵn (> 0), có nguồn sản phẩm xác nhận. Không tự đoán.'],
  ['KÊNH VẬN CHUYỂN', 'Một mã kênh được metadata và quy cách kiện hàng cho phép.'],
  [
    'CÂN NẶNG G',
    'Cân nặng khai báo của listing theo gram, số dương, lấy từ quy cách kiện hàng đã xác nhận.',
  ],
  ['DÀI CM', 'Chiều dài kiện hàng theo cm, số dương.'],
  ['RỘNG CM', 'Chiều rộng kiện hàng theo cm, số dương.'],
  ['CAO CM', 'Chiều cao kiện hàng theo cm, số dương.'],
  ['WORD', 'Tên .docx trong thư mục listing; giữ nguyên tên nguồn.'],
  ['ẢNH BÌA', 'Tên ảnh bìa vuông 1:1 trong thư mục listing.'],
  ['ẢNH GALLERY', 'Danh sách JSON đúng thứ tự, ví dụ ["g1.png","g2.png"]. Mỗi ảnh phải là 3:4.'],
  [
    'ẢNH MÔ TẢ',
    'Danh sách JSON đúng thứ tự, hoặc [] khi nguồn không có ảnh mô tả. Quyền API kiểm riêng.',
  ],
  ['TÊN TẦNG 1', 'Giữ nguyên tên tầng phân loại. Để trống nếu listing không có phân loại.'],
  ['TÊN TẦNG 2', 'Chỉ điền khi có tầng 1; giữ nguyên tên và thứ tự nguồn.'],
] as const;
const priceColumns = [
  ['SKU', 'SKU nguyên văn dạng văn bản, giữ cả số 0 đầu. Mỗi SKU một dòng trong đúng thư mục.'],
  ['TÊN SẢN PHẨM', 'Tên nguyên văn từ bảng giá đã chọn.'],
  ['NGÀNH HÀNG', 'Nhãn ngành trong bảng giá nguồn, nếu có; không thay cho MÃ NGÀNH đã đối chiếu.'],
  ['BRAND', 'Nhãn thương hiệu trong bảng giá nguồn, nếu có.'],
  ['GIÁ GỐC', 'Giá gốc VNĐ theo đúng bộ giá được xác nhận. Đăng mới dùng giá này.'],
  ['GIÁ BÁN', 'Giá mục tiêu khuyến mại theo nguồn, có thể trống. Không tự tạo khuyến mại.'],
  ['CÂN NẶNG KHAI BÁO G', 'Cân nặng từ bảng giá nếu có; không tự suy ra quy cách kiện hàng.'],
  ['THƯ MỤC', 'Khớp đúng THƯ MỤC trong sheet Điều phối listing.'],
  [
    'TỒN BÁN',
    'Lệnh tồn theo SKU/shop được xác nhận; 0 là hết hàng, trống là chưa biết. Không mặc định 100.',
  ],
  ['PHÂN LOẠI 1', 'Nhãn lựa chọn tầng 1 nguyên văn; thứ tự dòng xác định thứ tự xuất hiện.'],
  ['PHÂN LOẠI 2', 'Nhãn lựa chọn tầng 2 nguyên văn, nếu có.'],
  ['ẢNH PHÂN LOẠI', 'Tên tệp ảnh được ánh xạ với SKU trong đúng thư mục; không đoán từ tên.'],
] as const;

/** No DB reads, source inference, jobs, or network. Data rows intentionally remain empty. */
export async function createPreparedDispatchTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shopee Workspace';
  workbook.title = 'Mẫu điều phối theo bộ đọc hiện tại';
  for (const [name, columns] of [
    ['Điều phối listing', dispatchColumns],
    ['Bảng giá', priceColumns],
  ] as const) {
    const sheet = workbook.addWorksheet(name, {
      views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }],
    });
    sheet.addRow(columns.map(([label]) => label));
    sheet.getRow(1).height = 42;
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    columns.forEach(([label, note], index) => {
      const column = sheet.getColumn(index + 1);
      column.width = /ẢNH|WORD|THƯ MỤC/.test(label) ? 32 : 24;
      // Excel must not rewrite SKU/shop/option text or create formulas from pasted source values.
      column.numFmt = '@';
      const header = sheet.getCell(1, index + 1);
      header.note = note;
      header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF283C35' } };
      header.alignment = { vertical: 'middle', wrapText: true };
    });
  }
  const guide = workbook.addWorksheet('Hướng dẫn', { views: [{ state: 'frozen', ySplit: 1 }] });
  guide.columns = [{ width: 25 }, { width: 115 }];
  guide.addRows([
    ['MỤC', 'CÁCH CHUẨN BỊ'],
    [
      'Phạm vi hiện tại',
      'Mẫu đúng parser của luồng tổng quát sandbox. Chưa nối được source catalog hoặc nguồn pilot production vào luồng này. Tải mẫu không tạo listing hay gửi Shopee.',
    ],
    [
      'Mỗi listing',
      'Một thư mục chứa Word và ảnh. Một dòng trong Điều phối listing. Mỗi SKU một dòng trong Bảng giá, gắn đúng THƯ MỤC. Giữ nguyên các tên nguồn.',
    ],
    [
      'Bảng giá đã có',
      'Sao chép giá trị của đúng SKU và đúng bộ giá đã được xác nhận sang Bảng giá; không tự áp giá Mall sang shop thường. GIÁ GỐC để đăng mới; GIÁ BÁN là mục tiêu khuyến mại riêng. DORIS đứng riêng chưa đủ điều phối.',
    ],
    [
      'Thông tin chưa có',
      'Để trống và xử lý ngoại lệ; không lấy một số ví dụ làm mặc định. TỒN BÁN phải có chỉ định theo SKU/shop; 0 khác với ô trống. Không có giá/cân nặng thì không tự bù.',
    ],
    [
      'Word theo bộ đọc',
      'Một đoạn TIÊU ĐỀ → một đoạn tên sản phẩm → một đoạn BÀI MÔ TẢ ĐĂNG BÁN → các đoạn mô tả. Bộ đọc lấy đoạn mô tả đầu, chèn ảnh mô tả đúng thứ tự, rồi phần chữ còn lại. Không tự viết lại Word nguồn để vượt kiểm tra.',
    ],
    [
      'Ảnh và phân loại',
      'ẢNH GALLERY và ẢNH MÔ TẢ là danh sách JSON tên tệp theo đúng thứ tự. Tên g1 chỉ là tên tệp; không tự gán vai trò từ tên. Bìa 1:1, gallery 3:4; không crop. Nhãn phân loại giữ cả khoảng trắng và thứ tự.',
    ],
    [
      'Ngành và thuộc tính',
      'Parser hiện chỉ nhận một thuộc tính/một giá trị chọn sẵn và một kênh vận chuyển. Mã ngành, thương hiệu và lựa chọn phải đối chiếu metadata đúng shop, kèm nguồn sản phẩm. Chưa có bộ xuất lựa chọn động theo ngành; không coi mẫu là đầy đủ mọi thuộc tính, không tự gán giá trị để đạt kiểm tra.',
    ],
    [
      'Nguồn và công thức',
      'Giữ workbook gốc để đối chiếu. Chỉ nhập giá trị; sheet điều phối từ chối công thức kể cả có kết quả lưu sẵn. Không đổi tên cột hoặc chèn dòng phía trên tiêu đề hàng 1. Ghi rõ tên nguồn/bộ giá trong quy trình bàn giao.',
    ],
    [
      'Sản phẩm đã đăng',
      'Nguồn đã tạo listing không được đưa lại vào Đăng mới. Cập nhật cần liên kết chính xác shop/item/SKU, chọn trường thay đổi và đối chiếu phần cần giữ nguyên.',
    ],
  ]);
  guide.getRow(1).font = { bold: true };
  guide.eachRow((row, index) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (index > 1) row.height = 62;
  });
  workbook.views = [
    { activeTab: 2, firstSheet: 0, x: 0, y: 0, width: 1400, height: 900, visibility: 'visible' },
  ];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
