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
          <h1>Làm việc theo từng bộ và từng shop</h1>
          <p>Nội dung đã chuẩn bị được giữ nguyên. Ứng dụng đưa ra đúng phần cần bạn xác định.</p>
        </div>
        <button onClick={onListings}>Về công việc đăng hàng</button>
      </div>
      <section className="panel guide-start">
        <h2>Bắt đầu từ công việc hôm nay</h2>
        <div className="guide-actions">
          <button className="primary" onClick={onImport}>
            Nhận thư mục listing
          </button>
          <button onClick={onListings}>Làm tiếp công việc đã lưu</button>
        </div>
      </section>
      <ol className="guide-steps">
        <li>
          <span>1</span>
          <div>
            <h2>Nhận bộ nguồn hoặc dùng bộ đã có</h2>
            <p>
              Nhận bộ listing đã chuẩn bị. Nếu có hồ sơ bàn giao đã xác định Word, ảnh và SKU, ứng
              dụng dùng lại những lựa chọn đó. Thư mục chưa có hồ sơ vẫn có thể nhận và xác định
              phần chưa rõ một lần.
            </p>
            <p>
              Bảng giá chung nằm trong Kho đầu vào. GIÁ GỐC và GIÁ BÁN được giữ riêng; nhận bảng giá
              không tự tạo khuyến mại.
            </p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <h2>Chọn đúng shop và việc cần làm</h2>
            <p>
              Ở Công việc đăng hàng, bấm “Chọn bộ đã có”. Chọn một hoặc nhiều bộ nguồn, shop đích và
              đăng mới hay cập nhật. Mỗi bộ có công việc riêng.
            </p>
            <p>
              Với cập nhật, điền mã sản phẩm của đúng link và chọn những phần được phép đổi. Tồn
              đăng bán chỉ được nhập khi bên bạn quyết định theo SKU/shop; ô trống không tự thành 0.
            </p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <h2>Xử lý đúng nguyên nhân</h2>
            <p>
              “Nguồn chưa có thông tin” cần bổ sung dữ kiện. “Cần xác định cách ghép” cần đối chiếu
              quan hệ đã có trong nguồn. “Ứng dụng chưa hỗ trợ” là giới hạn triển khai, không yêu
              cầu bạn viết lại listing.
            </p>
            <p>
              Khi có bản nguồn mới, công việc giữ phiên bản đã chọn. Đối chiếu và chọn rõ bản muốn
              dùng trước khi lưu.
            </p>
          </div>
        </li>
        <li>
          <span>4</span>
          <div>
            <h2>Đọc listing, xem thay đổi, rồi gửi sandbox</h2>
            <p>
              Với công việc sandbox được hỗ trợ, bấm “Đọc & đối chiếu sandbox”. Kiểm tra đúng shop,
              link, SKU và phần khác biệt. “Xem trước những phần sẽ đổi” lưu một bản thay đổi để bạn
              xem trước khi gửi.
            </p>
            <p>
              Sau khi gửi, ứng dụng đọc lại để xác minh phần đã chọn và phần phải giữ nguyên. Kết
              quả ghi không rõ sẽ yêu cầu đọc lại; không gửi lặp để đoán.
            </p>
            <p className="caption">
              Luồng hiện tại chỉ thực thi cập nhật sandbox trong phạm vi được cấp. Shop thật chỉ
              đọc; tạo mới, các trường khác và kiểm duyệt Shopee chưa được nghiệm thu.
            </p>
          </div>
        </li>
      </ol>
      <section className="panel">
        <h2>Khi cần tạm dừng</h2>
        <p>
          Lưu lựa chọn công việc trước khi rời trang. Đợt nhận thư mục có trạng thái lưu riêng trong
          Kho đầu vào. Phần đang sửa tại màn hoàn thiện nội dung cần lưu riêng.
        </p>
        <p>
          Nếu gửi sandbox bị mất phản hồi, mở lại công việc và chọn “Đọc lại kết quả”. “Đã đọc lại
          và đối chiếu” xác nhận dữ liệu; không có nghĩa Shopee đã duyệt nội dung.
        </p>
      </section>
    </>
  );
}
