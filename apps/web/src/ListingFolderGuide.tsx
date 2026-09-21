import {
  ChevronDown,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  FolderTree,
} from 'lucide-react';
import './listing-folder-guide.css';

export function ListingFolderGuide({ onOpenPrices }: { onOpenPrices: () => void }) {
  return (
    <details className="listing-folder-guide" open>
      <summary>
        <FolderTree size={21} aria-hidden="true" />
        <h2>Cách sắp xếp thư mục listing</h2>
        <ChevronDown className="folder-guide-chevron" size={18} aria-hidden="true" />
      </summary>
      <div className="folder-guide-body">
        <p className="folder-guide-intro">
          Mỗi listing có một thư mục riêng, chứa Word và toàn bộ ảnh của listing đó.
        </p>
        <div className="folder-guide-layout">
          <div className="folder-guide-example">
            <div className="folder-guide-root">
              <FolderOpen size={20} aria-hidden="true" />
              <strong>LISTING_CẦN_NHẬP</strong>
              <span>Chọn thư mục này khi nhập nhiều listing</span>
            </div>
            <ul className="folder-guide-tree" aria-label="Cấu trúc thư mục listing mẫu">
              <li>
                <div className="folder-guide-folder">
                  <FolderOpen size={18} aria-hidden="true" /> <strong>Khẩu trang Lamy</strong>
                </div>
                <ul>
                  <li>
                    <div>
                      <FileText size={16} aria-hidden="true" />
                      <span>Nội dung.docx</span>
                    </div>
                    <small>Tiêu đề và mô tả đã chuẩn bị</small>
                  </li>
                  <li>
                    <div>
                      <FileImage size={16} aria-hidden="true" />
                      <span>Ảnh bìa.png</span>
                    </div>
                  </li>
                  <li>
                    <div>
                      <FileImage size={16} aria-hidden="true" />
                      <span>g1.png, g2.png, …</span>
                    </div>
                    <small>Ảnh sản phẩm và ảnh trong mô tả</small>
                  </li>
                  <li>
                    <div>
                      <FileImage size={16} aria-hidden="true" />
                      <span>phan-loai-01.png, phan-loai-02.png, …</span>
                    </div>
                    <small>Ảnh cho các phân loại của listing</small>
                  </li>
                </ul>
              </li>
              <li>
                <div className="folder-guide-folder">
                  <FolderOpen size={18} aria-hidden="true" /> <strong>Listing khác</strong>
                </div>
                <ul>
                  <li>
                    <div>
                      <FileText size={16} aria-hidden="true" />
                      <span>Word và bộ ảnh riêng của listing này</span>
                    </div>
                  </li>
                </ul>
              </li>
            </ul>
            <p className="folder-guide-caption">Tên minh họa · Không cần đổi tên tệp đang có.</p>
          </div>
          <div className="folder-guide-notes">
            <div className="folder-guide-price">
              <FileSpreadsheet size={22} aria-hidden="true" />
              <div>
                <h3>Bảng giá chung.xlsx</h3>
                <p>
                  Để riêng bên ngoài thư mục nhập listing. Nhập một lần và chọn dùng cho nhiều bộ.
                </p>
                <button type="button" onClick={onOpenPrices}>
                  Mở Bảng giá chung
                </button>
              </div>
            </div>
            <ol className="folder-guide-steps">
              <li>
                <strong>Nhập nhiều listing</strong>
                <p>
                  Chọn <b>LISTING_CẦN_NHẬP</b>, rồi chọn “Mỗi thư mục con là một listing”. Đặt các
                  thư mục listing ngay trong thư mục này.
                </p>
              </li>
              <li>
                <strong>Chỉ nhập một listing</strong>
                <p>
                  Chọn thẳng thư mục <b>Khẩu trang Lamy</b>, rồi chọn “Thư mục này là một listing”.
                </p>
              </li>
              <li>
                <strong>Giữ bộ ảnh đã có</strong>
                <p>
                  Ảnh có thể để cùng Word hoặc trong thư mục con <b>Ảnh</b>. Sau khi nhập, bạn chọn
                  vai trò, thứ tự và ảnh cho đúng SKU. Tên có “ảnh bìa”, “anh-bia”, “cover” hoặc đuôi “-g1”, “-g2”… sẽ hiện gợi ý. Bấm “Điền vị trí trống theo tên” để áp dụng; các lựa chọn tay được giữ. Ảnh chỉ mang số như 2.png có thể là nội dung hoặc phân loại, cần xem trước khi chọn.
                </p>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </details>
  );
}
