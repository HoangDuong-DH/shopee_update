export function UsageGuide({
  onImport,
  onListings,
}: {
  onImport: () => void;
  onListings: () => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Dành cho nhân viên vận hành</p>
          <h1>Bắt đầu từ bộ listing đã có</h1>
          <p>Một listing là một link sản phẩm với đúng các phân loại bên bạn đã chuẩn bị.</p>
        </div>
        <button onClick={onListings}>Về listing của tôi</button>
      </div>
      <section className="panel guide-start">
        <h2>Bạn đang cần làm việc gì?</h2>
        <div className="guide-actions">
          <button className="primary" onClick={onImport}>
            Nhập một bộ listing mới
          </button>
          <button onClick={onListings}>Mở bộ đã nhập để kiểm tra</button>
        </div>
        <p>
          Không cần nhập lại bộ đã có trong danh sách. SKU là mã sản phẩm/phân loại trong bảng giá
          của công ty.
        </p>
      </section>
      <ol className="guide-steps">
        <li>
          <span>1</span>
          <div>
            <h2>Chọn bảng giá</h2>
            <p>
              Chọn tệp Excel đã nhập, hoặc tải lên ngay tại bước này. Chọn đúng trang tính và bộ giá
              dành cho shop bạn đang làm.
            </p>
            <p className="caption">
              GIÁ GỐC là giá dùng cho bước đăng mới. GIÁ BÁN được giữ riêng làm giá mục tiêu khuyến
              mại.
            </p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <h2>Điền các phân loại đã chuẩn bị</h2>
            <p>
              Chọn sản phẩm không có phân loại, có một nhóm (ví dụ Quy cách) hoặc hai nhóm (ví dụ
              Màu sắc và Quy cách). Điền từng SKU và đúng tên phân loại vào bảng. Có thể dán nhiều
              dòng từ Excel trong phần mở rộng.
            </p>
            <p className="caption">
              Ứng dụng đối chiếu từng SKU với nguồn giá. Nếu không tìm thấy hoặc trùng nguồn, quay
              lại sửa lựa chọn; không tự đoán dữ liệu.
            </p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <h2>Chọn nội dung và ảnh của bộ</h2>
            <p>
              Đưa tiêu đề và mô tả có sẵn vào các ô tương ứng. Có thể chọn đoạn từ Word để điền.
              Chọn ảnh bìa, ảnh sản phẩm, ảnh mô tả và ảnh cho từng phân loại bằng hình thu nhỏ.
            </p>
            <p className="caption">
              Kiểm tra đúng vai trò và thứ tự. Ứng dụng giữ nguyên tệp ảnh; khi nhập thiếu sẽ chỉ rõ
              phần cần bổ sung.
            </p>
          </div>
        </li>
        <li>
          <span>4</span>
          <div>
            <h2>Lưu và xem lại</h2>
            <p>
              Lưu bộ nguồn, xem lại ảnh, chữ, phân loại và giá. Mục “Việc tiếp theo” dẫn đến phần
              cần kiểm tra. SKU và cấu trúc của bộ đã lưu được cố định.
            </p>
            <p className="caption">
              “Lưu bộ nguồn” và “Lưu bản kiểm tra theo shop” chỉ lưu trong ứng dụng. Bản hiện tại
              chưa đăng hay cập nhật sản phẩm lên Shopee.
            </p>
          </div>
        </li>
      </ol>
      <section className="panel">
        <h2>Khi đang làm mà gặp vấn đề</h2>
        <dl>
          <div>
            <dt>Tải tệp bị lỗi</dt>
            <dd>
              Xem tên từng tệp ở bảng tiến độ và bấm thử lại các tệp chưa nhận. Giữ trang mở để
              không phải chọn lại tệp lỗi.
            </dd>
          </div>
          <div>
            <dt>Cần nghỉ giữa bước nhập</dt>
            <dd>
              Phần bảng giá và phân loại đang nhập được giữ trong tab trình duyệt. Khi trở lại, chọn
              “Tiếp tục phần đang nhập”. Nội dung và ảnh đang chỉnh chưa lưu cần được lưu trước khi
              rời trang.
            </dd>
          </div>
          <div>
            <dt>Không bấm lưu được</dt>
            <dd>Xem danh sách việc còn thiếu, bấm vào việc đó để đến đúng ô cần điền.</dd>
          </div>
          <div>
            <dt>Muốn thêm SKU vào bộ đã lưu</dt>
            <dd>
              Cấu trúc bộ đã tiếp nhận được cố định. Không ghép SKU từ bảng giá sang một listing
              khác. Kiểm tra bộ gốc với người phụ trách sản phẩm.
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
