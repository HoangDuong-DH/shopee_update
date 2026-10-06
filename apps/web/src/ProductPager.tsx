import type { ProductPageInfo } from '@shopee/domain';
export function ProductPager({info,loading,onPage}:{info:ProductPageInfo;loading:boolean;onPage:(page:number)=>void}) {
  return <div className="input-library-toolbar" aria-label="Trang bộ listing">
    <p role="status">{info.total} bộ listing · Trang {info.page}/{Math.max(1,Math.ceil(info.total/info.limit))}</p>
    <button type="button" disabled={loading || info.page<=1} onClick={()=>onPage(info.page-1)}>Trang trước</button>
    <button type="button" disabled={loading || !info.hasMore} onClick={()=>onPage(info.page+1)}>Trang sau</button>
  </div>;
}
