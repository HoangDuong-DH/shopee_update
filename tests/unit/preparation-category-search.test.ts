import { describe, expect, it } from 'vitest';
import { categorySearchResults } from '../../apps/web/src/preparation-category-search.js';
describe('category search from current metadata', () => {
  const categories = [
    {id:'1',label:'Áo',path:'Thời Trang > Áo màu đỏ'},
    {id:'2',label:'Tinh dầu',path:'Nhà cửa > Tinh dầu'},
    {id:'3',label:'Cotton',path:'Chất liệu > Khăn Cotton'},
  ];
  it('searches all words accent independently across unrelated industries', () => {
    expect(categorySearchResults(categories,'do ao','',50).items.map(c=>c.id)).toEqual(['1']);
    expect(categorySearchResults(categories,'cotton','',50).items.map(c=>c.id)).toEqual(['3']);
  });
  it('preserves the selected category while limiting large result lists', () => {
    const large=Array.from({length:2000},(_,i)=>({id:String(i),label:'Ngành '+i,path:'Nhóm > Ngành '+i}));
    const result=categorySearchResults(large,'','1999',100);
    expect(result.total).toBe(2000);
    expect(result.items).toHaveLength(101);
    expect(result.items.some(c=>c.id==='1999')).toBe(true);
  });
  it('never fabricates a category or loses a real selected option on an unmatched search', () => {
    const result=categorySearchResults(categories,'không có','2',100);
    expect(result.total).toBe(0);
    expect(result.items.map(c=>c.id)).toEqual(['2']);
    expect(categorySearchResults(categories,'không có','missing',100).items).toEqual([]);
  });
});
