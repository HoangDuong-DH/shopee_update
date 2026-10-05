import { useState } from 'react';
import { Search } from 'lucide-react';
import { categorySearchResults, type PreparationCategory } from './preparation-category-search.js';
export function PreparationCategorySelect({ categories, value, confirmed, onChange }: {
  categories: PreparationCategory[]; value: string; confirmed: boolean; onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const result = categorySearchResults(categories, query, value);
  return <div className="preparation-category" data-preparation-field="categoryId" tabIndex={-1}>
    {!confirmed && <label className="preparation-category-search">Tìm ngành hàng
      <span><Search size={16} aria-hidden="true"/><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nhập tên ngành hoặc nhóm sản phẩm"/></span>
    </label>}
    <label>Ngành hàng<select disabled={confirmed} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">Chọn ngành đúng với sản phẩm</option>
      {value && !categories.some(category => category.id === value) && <option value={value}>Ngành đã lưu — cần đối chiếu tên</option>}
      {result.items.map(category => <option key={category.id} value={category.id}>{category.path}</option>)}
    </select></label>
    {!confirmed && <small>{result.total === 0 ? 'Không có ngành khớp. Thử từ khóa khác; lựa chọn hiện tại được giữ.' : result.total > 100 ? `${result.total} ngành · Đang hiện 100 kết quả đầu. Nhập tên để tìm nhanh.` : `${result.total} ngành phù hợp`}</small>}
  </div>;
}
