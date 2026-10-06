import { describe, expect, it, vi } from 'vitest';
import { Repository } from '../../packages/persistence/src/repository.js';
import { productPageQuerySchema } from '../../packages/domain/src/product-page.js';
import { readProductPage, readProductsByKeys } from '../../packages/persistence/src/product-pages.js';

describe('bounded product reads', () => {
  it('validates page bounds and preserves literal search', () => {
    expect(productPageQuerySchema.parse({page:'3',q:'  SKU%_  '})).toMatchObject({page:3,limit:50,q:'SKU%_'});
    for (const bad of [{page:0},{page:1.5},{limit:101},{q:'\0'},{page:100000001}])
      expect(productPageQuerySchema.safeParse(bad).success).toBe(false);
  });
  it('keeps a late page reachable and bounds decoded bodies on a 12,000 source fixture', async () => {
    const fixture=Array.from({length:12000},(_,i)=>({productKey:`key-${i}`,revision:1}));
    const query=vi.fn(async (sql:string, values:any[])=>{
      expect(sql).toContain('LIMIT $4 OFFSET $5');
      expect(sql).toContain('ORDER BY p.updated_at DESC,p.product_key DESC');
      expect(values).toEqual(['active','','%%',50,11950]);
      return {rows:fixture.slice(values[4],values[4]+values[3]).map(body=>({total:'12000',body,archived_at:null}))};
    });
    const page=await readProductPage({query} as any,{page:240});
    expect(page).toMatchObject({total:12000,page:240,limit:50,hasMore:false});
    expect(page.items).toHaveLength(50);
    expect(page.items[0]?.productKey).toBe('key-11950');
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('filters archives and search in SQL before limit and returns total for empty pages', async () => {
    const query=vi.fn(async (sql:string, values:any[])=>{
      expect(sql.indexOf("a.archived_at IS NOT NULL")).toBeLessThan(sql.indexOf('LIMIT $4'));
      expect(sql).toContain("jsonb_array_elements(r.body->'variants')");
      expect(values).toEqual(['archived','SKU%_','%SKU\\%\\_%',2,198]);
      return {rows:[{total:'9',body:null}]};
    });
    expect(await readProductPage({query} as any,{page:100,limit:2,lifecycle:'archived',q:'SKU%_'}))
      .toMatchObject({items:[],total:9,page:100,hasMore:false});
  });
  it('reads exact selected keys independently of page and rejects unbounded pins', async()=>{
    const query=vi.fn(async (_sql:string,values:any[])=>({rows:[{body:{productKey:values[0][0],revision:7},archived_at:null}]}));
    expect(await readProductsByKeys({query} as any,['older-source'])).toMatchObject([{productKey:'older-source',revision:7}]);
    expect(query.mock.calls[0]?.[0]).toContain('ANY($1::text[])');
    await expect(readProductsByKeys({query} as any,Array.from({length:241},(_,i)=>String(i)))).rejects.toThrow();
  });
  it('legacy readers fail visibly if they cannot represent the full listing library',async()=>{
    const repo=new Repository({query:async()=>({rows:[{total:'101',body:{productKey:'a',revision:1},archived_at:null}]})} as any);
    await expect(repo.listProducts()).rejects.toThrow('PRODUCT_PAGING_REQUIRED');
  });
});
