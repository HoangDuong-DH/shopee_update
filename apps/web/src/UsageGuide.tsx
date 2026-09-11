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
          <p>Mỗi thư mục chứa Word và ảnh của một listing. Bảng giá dùng chung cho đợt nhập.</p>
        </div>
        <button onClick={onListings}>Về listing của tôi</button>
      </div>
      <section className="panel guide-start">
        <h2>Bạn đang cần làm việc gì?</h2>
        <div className="guide-actions">
          <button className="primary" onClick={onImport}>
            Nhập listing bằng thư mục
          </button>
          <button onClick={onListings}>Mở bộ đã nhập để kiểm tra</button>
        </div>
        <p>
          Đọc các thư mục, xem nguồn và xử lý phần chưa rõ trên cùng một màn hình. Việc đọc nguồn
          chưa lưu listing hoặc gửi lên Shopee.
        </p>
      </section>
      <ol className="guide-steps">
        <li>
          <span>1</span>
          <div>
            <h2>Chọn bảng giá chung và thư mục</h2>
            <p>
              Vào Kho đầu vào → Bảng giá chung để thêm Excel một lần. Chọn “Nhập thư mục listing”,
              chọn bảng giá, trang tính và bộ giá cho đợt. Sau đó chọn thư mục trên máy. Nếu đó là
              một bộ, chọn “Thư mục này là một listing”; nếu bên trong có nhiều thư mục listing,
              chọn “Mỗi thư mục con là một listing”.
            </p>
            <p>Bấm “Đọc các thư mục”. Danh sách giữ riêng tệp của từng bộ.</p>
            <p className="caption">
              GIÁ GỐC dùng khi đăng mới. GIÁ BÁN được giữ riêng làm giá mục tiêu khuyến mại; nhập
              nguồn không tự tạo giảm giá.
            </p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <h2>Chọn ảnh bằng hình và đối chiếu Word</h2>
            <p>
              Mở một thư mục trong danh sách. Đánh dấu ảnh rồi chọn dùng làm bìa, thêm vào ảnh sản
              phẩm, ảnh mô tả hoặc cả hai. Xem nhãn và số thứ tự trên ảnh; không cần đổi tên tệp
              thành SKU.
            </p>
            <p>
              Tab “Word & nội dung” cho xem nguyên văn và phần đã nhận diện. Nếu chưa rõ tiêu đề/mô
              tả, văn bản thô chỉ dùng để xem; bạn cần chọn đúng đoạn từ Word ở màn hoàn thiện.
            </p>
            <p className="caption">
              Ứng dụng giữ tệp gốc. Chưa có tính năng nhìn ảnh để tự suy ra SKU, combo hoặc tên phân
              loại.
            </p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <h2>Bổ sung đúng phần còn thiếu</h2>
            <p>
              Nếu chưa xác định được SKU và nhãn, bấm “Bổ sung SKU/phân loại”. Bảng giá, phần Word
              đã xác định và ảnh vừa chọn được giữ lại. Chỉ nhập đúng danh sách của bộ đã chuẩn bị,
              rồi kiểm tra giá và dòng nguồn.
            </p>
            <p>
              Trong Editor, kiểm tra nội dung, bố trí ảnh và gán ảnh cho từng phân loại. Tên, khoảng
              trắng và thứ tự phân loại phải đúng bộ gốc.
            </p>
            <p className="caption">
              “Nhập thủ công khi cần” là lựa chọn phụ khi chưa tổ chức nguồn bằng thư mục. Không cần
              bắt đầu lại từ đây cho mỗi thư mục.
            </p>
          </div>
        </li>
        <li>
          <span>4</span>
          <div>
            <h2>Lưu, xem lại và làm bộ tiếp theo</h2>
            <p>
              Bấm “Lưu & xem trước” để kiểm tra ảnh, chữ, SKU và giá. Đợt thư mục vẫn được giữ khi
              quay lại làm bộ tiếp theo. Danh sách và cấu trúc của bộ đã lưu được khóa.
            </p>
            <p className="caption">
              Lưu bộ nguồn và lưu bản kiểm tra theo shop chỉ lưu trong ứng dụng. Bản hiện tại chưa
              đăng hay cập nhật sản phẩm lên Shopee.
            </p>
          </div>
        </li>
      </ol>
      <section className="panel">
        <h2>Khi đang làm mà gặp vấn đề</h2>
        <dl>
          <div>
            <dt>Có tệp không đọc được</dt>
            <dd>
              Xem tên tệp, kiểm tra tệp gốc rồi đọc lại thư mục. Các tệp đọc được vẫn có để đối
              chiếu. Chi tiết kỹ thuật nằm trong mục dành cho người hỗ trợ.
            </dd>
          </div>
          <div>
            <dt>Word hoặc SKU chưa xác định rõ</dt>
            <dd>
              Giữ nguyên nguồn và bổ sung đúng phần được báo. Văn bản Word chưa phân loại không tự
              trở thành mô tả; tên trong bảng giá cũng không tự trở thành nhãn phân loại.
            </dd>
          </div>
          <div>
            <dt>Cần nghỉ giữa đợt nhập</dt>
            <dd>
              Đợi thông báo “Đã lưu vào Kho đầu vào” rồi có thể đóng trang. Mở Kho đầu vào → Bộ
              listing → Tiếp tục xử lý để lấy lại Word, ảnh, thứ tự đã chọn và nguồn giá của đợt.
              Phần đang sửa trong màn hoàn thiện SKU/nội dung cần bấm lưu riêng trước khi đóng.
            </dd>
          </div>
          <div>
            <dt>Thấy lời nhắc tiếp tục phần đang nhập</dt>
            <dd>
              Đợt thư mục đã lưu nằm trong Kho đầu vào. Lời nhắc trong luồng nhập thủ công chỉ khôi
              phục các ô của luồng đó; đây là hai phần lưu riêng.
            </dd>
          </div>
          <div>
            <dt>Không bấm lưu được</dt>
            <dd>
              Xem lý do ở đầu màn hình và bấm “Đi đến phần cần bổ sung”. Khi đang tải hoặc lưu, đợi
              kết quả trước khi đổi công việc.
            </dd>
          </div>
          <div>
            <dt>Thư mục báo bộ này đã lưu</dt>
            <dd>
              Bấm “Mở bộ đã lưu” để xem lại. Nhận biết bộ nguồn chưa bảo đảm phát hiện mọi sản phẩm
              trùng; kiểm tra danh sách trước khi nhập lại cùng một sản phẩm.
            </dd>
          </div>
          <div>
            <dt>Muốn thêm SKU vào bộ đã lưu</dt>
            <dd>
              Cấu trúc đã tiếp nhận được cố định. Chỉnh nội dung hoặc ảnh không ghép thêm SKU sang
              listing khác. Đối chiếu bộ gốc với người phụ trách sản phẩm.
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
