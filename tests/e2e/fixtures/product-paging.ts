import type { Route } from '@playwright/test';
function paginate(items:any[],url:URL) {
  const page=Number(url.searchParams.get('page') ?? 1),limit=Number(url.searchParams.get('limit') ?? 50);
  const q=(url.searchParams.get('q') ?? '').normalize('NFKC').trim().toLocaleLowerCase('vi');
  const matching=items.filter(item=>`${item.productKey} ${typeof item.title==='string'?item.title:item.title?.value ?? ''} ${(item.skus ?? item.variants?.map((variant:any)=>variant.sku.value) ?? []).join(' ')}`.toLocaleLowerCase('vi').includes(q));
  return {items:matching.slice((page-1)*limit,page*limit),total:matching.length,page,limit,hasMore:page*limit<matching.length};
}
/** Cursor library fixtures expose only display summaries; drafts still use the detail route. */
export function localLibraryProductPage(items:any[],url:URL) {
  const lifecycle=url.searchParams.get('lifecycle') ?? 'active';
  const q=(url.searchParams.get('q') ?? '').normalize('NFKC').trim().toLocaleLowerCase('vi');
  const limit=Number(url.searchParams.get('limit') ?? 50);
  const token=url.searchParams.get('cursor');
  const offset=token ? Number(JSON.parse(Buffer.from(token,'base64url').toString('utf8')).offset) : 0;
  const matching=items.filter(item=>(lifecycle==='all' || !!item.archived===(lifecycle==='archived')) &&
    `${item.productKey} ${typeof item.title==='string'?item.title:item.title?.value ?? ''} ${(item.skus ?? item.variants?.map((variant:any)=>variant.sku.value) ?? []).join(' ')}`.toLocaleLowerCase('vi').includes(q));
  const selected=matching.slice(offset,offset+limit),hasMore=offset+limit<matching.length;
  return {observedAt:'2026-10-05T00:00:00.000Z',hasMore,
    nextCursor:hasMore ? Buffer.from(JSON.stringify({offset:offset+limit})).toString('base64url') : null,
    items:selected.map(item=>({productKey:item.productKey,revision:item.revision,title:typeof item.title==='string'?item.title:item.title?.value ?? null,
      coverKey:item.coverKey ?? null,variantCount:item.variantCount ?? item.variants?.length ?? null,
      assetCount:item.assetCount ?? item.assets?.length ?? null,galleryCount:item.galleryCount ?? item.galleryKeys?.length ?? null,
      savedIssueCount:item.savedIssueCount ?? item.issues?.length ?? null,
      savedBlockingIssueCount:item.savedBlockingIssueCount ?? item.issues?.filter((issue:any)=>issue.severity==='block').length ?? null,
      issueBasis:'saved_draft',updatedAt:item.updatedAt ?? '2026-09-17T00:00:00Z',archived:!!item.archived,archivedAt:item.archivedAt ?? null,
      shopAssignments:item.shopAssignments ?? [],shopAssignmentCount:item.shopAssignmentCount ?? 0,shopAssignmentsTruncated:item.shopAssignmentsTruncated ?? false}))};
}
/** Fixture routes use the same page envelope as the API; other responses pass through unchanged. */
export function fulfillPagedProducts(route:Route,options:NonNullable<Parameters<Route['fulfill']>[0]>) {
  const request=route.request(),url=new URL(request.url());let json=options.json;
  if(request.method()==='GET' && json) {
    if(url.pathname==='/v1/products' && Array.isArray(json)) json=paginate(json,url);
    if(url.pathname==='/v1/local-library/products' && Array.isArray(json)) json=localLibraryProductPage(json,url);
    if(url.pathname==='/v1/workbench' && Array.isArray(json.sources) && !json.sourcePage) {
      const {items,...sourcePage}=paginate(json.sources,url);json={...json,sources:items,sourcePage};
    }
    if(url.pathname==='/v1/production-preparations/context' && Array.isArray(json.products) && !json.productPage) {
      const {items,...productPage}=paginate(json.products,url);
      const pins=new Set<string>(JSON.parse(url.searchParams.get('productKeys') ?? '[]'));
      const products=[...new Map([...items,...json.products.filter((item:any)=>pins.has(item.productKey))].map((item:any)=>[item.productKey,item])).values()];
      json={...json,products,productPage,pageProductKeys:items.map(item=>item.productKey)};
    }
  }
  return route.fulfill({...options,json});
}
