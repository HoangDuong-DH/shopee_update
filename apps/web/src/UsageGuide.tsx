export function UsageGuide({
  onImport,
  onListings,
  onProduction,
}: {
  onImport: () => void;
  onListings: () => void;
  onProduction: () => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Dành cho nhân viên vận hành</p>
          <h1>Làm việc theo từng bộ và từng shop</h1>
          <p>Nội dung đã chuẩn bị được giữ nguyên. Ứng dụng đưa ra đúng phần cần bạn xác định.</p>
        </div>
        <button onClick={onProduction}>Về Đăng hàng</button>
      </div>
      <section className="panel guide-start">
        <h2>Bắt đầu từ công việc hôm nay</h2>
        <div className="guide-actions">
          <button className="primary" onClick={onImport}>
            Nhận thư mục listing
          </button>
          <button onClick={onListings}>Mở Listing của tôi</button>
          <button onClick={onProduction}>Làm tiếp đợt đăng đã lưu</button>
        </div>
      </section>
      <ol className="guide-steps">
        <li>
          <span>1</span>
          <div>
            <h2>Nhận bộ nguồn hoặc dùng bộ đã có</h2>
            <p>
              Chọn thư mục hoặc ZIP và kiểm tra cách chia thành từng listing. Chọn bảng giá,
              sheet và bộ giá đúng nguồn. Nếu có Excel nội dung, mở “Nội dung từ Excel”, chọn
              cột và xem cách ghép theo STT. Những dòng trùng hoặc chưa rõ cần bạn chọn tay.
            </p>
            <p>
              Lưu đợt nguồn rồi hoàn thiện ảnh, nội dung và SKU từng bộ. GIÁ GỐC và GIÁ BÁN
              được giữ riêng; nhận bảng giá không tự tạo khuyến mại. Lưu nguồn chưa gửi Shopee.
            </p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <h2>Chỉnh phân loại và lưu đúng phiên bản</h2>
            <p>
              Trong “Listing của tôi → Chỉnh phân loại hàng loạt”, tìm và chọn tối đa 80 bộ.
              Chọn dung tích hoặc từng phân loại cần bỏ, và thứ tự dung tích nếu cần. Xem từng
              SKU trong bản xem trước rồi bấm lưu các bộ đã kiểm tra.
            </p>
            <p>
              Lựa chọn giữ trong tab khi chuyển trang hoặc tải lại; vẫn cần xem trước lại.
              Nếu nguồn đổi phiên bản, chọn lại các phân loại bỏ riêng. Các link Shopee chưa
              thay đổi sau khi sửa nguồn trong kho.
            </p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <h2>Chọn shop và bổ sung phần thiếu</h2>
            <p>
              Mở “Đăng hàng → Chuẩn bị lô mới”, kiểm tên và ID shop, rồi chọn các listing đã lưu.
              Điền tồn, ngành, thương hiệu, kích thước và vận chuyển theo nguồn hoặc quyết định
              của bạn. Ô tồn trống là chưa quyết định; không tự trở thành 0.
            </p>
            <p>
              Bấm kiểm tra và mở nút bên cạnh từng lỗi để đến đúng mục. Thiếu ảnh, giá hay SKU
              cần bổ sung từ đúng nguồn. “Ứng dụng chưa hỗ trợ” là giới hạn triển khai; không
              đổi nguồn hoặc ngành để bỏ cảnh báo.
            </p>
          </div>
        </li>
        <li>
          <span>4</span>
          <div>
            <h2>Đối chiếu nguồn rồi tạo link ẩn</h2>
            <p>
              Kiểm kết quả, giữ “Đăng ẩn để QC”, rồi bấm chuẩn bị đợt. Bản chuẩn bị giữ cố định
              phiên bản nguồn. “Đối chiếu bản nguồn hiện tại” cho xem trước/sau của từng mục
              đã đổi; thao tác này không sửa đợt cũ.
            </p>
            <p>
              Khi đủ điều kiện, tự bấm “Đăng ẩn các listing đã chuẩn bị”. Với đợt đã đăng ký
              có nguồn đổi, mở “Đợt đang làm”: giữ link đã tạo để đối chiếu và loại phần chưa
              gửi trước khi chuẩn bị lại. Phần độc lập chỉ tiếp tục khi ứng dụng kiểm tra đạt.
            </p>
            <p className="caption">
              Bộ nguồn đã có ID listing cần đi luồng cập nhật đúng link. Đăng ẩn và mở bán là
              hai hành động riêng; tạo đợt hoặc nhận biên nhận chưa phải đã đối chiếu đạt.
            </p>
          </div>
        </li>
        <li><span>5</span><div><h2>Theo dõi, QC và bàn giao</h2>
          <p>Mở “Đợt đang làm”, xem tên sản phẩm, link đã tạo và việc tiếp theo. Có link nhưng
            chưa đủ phân loại hoặc chưa đối chiếu xong thì chưa tính hoàn tất. Nếu hoãn QC ảnh,
            kiểm tra ảnh rồi đọc đối chiếu lại trước khi chủ động mở bán.</p>
          <p>“Xuất báo cáo Excel” tải trạng thái đã lưu, lý do và việc cần làm của đúng đợt,
            đúng shop. Xuất báo cáo không gửi lại listing và không tự đọc mới dữ liệu Shopee.</p>
        </div></li>
      </ol>
      <section className="panel">
        <h2>Khi cần tạm dừng</h2>
        <p>
          Lưu lựa chọn công việc trước khi rời trang. Đợt nhận thư mục có trạng thái lưu riêng trong
          Kho đầu vào. Phần đang sửa tại màn hoàn thiện nội dung cần lưu riêng.
        </p>
        <p>
          Nếu gửi bị mất phản hồi, mở lại đợt và chọn “Đọc lại đợt đăng”, rồi đọc đối chiếu theo hướng dẫn. “Đã đọc lại
          và đối chiếu” xác nhận dữ liệu; không có nghĩa Shopee đã duyệt nội dung.
        </p>
      </section>
    </>
  );
}
