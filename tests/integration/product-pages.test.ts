import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { assertLocalIntegrationDatabase } from '../helpers/integration-database.js';
const database=new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://invalid/invalid');
if(process.env.INTERNAL_ISOLATED_MODE!=='1') throw Error('PRODUCT_PAGES_REQUIRES_ISOLATED_DATABASE');
assertLocalIntegrationDatabase(database);
const schema='product_pages_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:database.href});
const pool=new Pool({connectionString:database.href,options:`-c search_path=${schema}`});
const repo=new Repository(pool);
let root:string,app:Awaited<ReturnType<typeof createApp>>;
const outbound=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No outbound calls in paging fixture'));
const body=(key:string,revision=1)=>({productKey:key,revision,title:{value:'Fixture '+key,sources:[],confirmed:false},
  description:[{type:'text',text:'Evidence '.repeat(2000)}],coverKey:'',galleryKeys:[],tierNames:[],
  variants:[{sku:{value:key==='source-110'?'SKU%_':key==='source-111'?'SKUXY':key,sources:[],confirmed:false},optionLabels:[]}],
  assets:[],attributes:{},logistics:{},issues:[]});
beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);
  root=await mkdtemp(join(tmpdir(),'shopee-product-pages-'));
  const data=Array.from({length:120},(_,i)=>body('source-'+String(i).padStart(3,'0')));
  await pool.query(`INSERT INTO products(product_key,latest_revision,updated_at)
    SELECT value->>'productKey',1,'2026-10-01T00:00:00Z'::timestamptz FROM jsonb_array_elements($1::jsonb)`,[JSON.stringify(data)]);
  await pool.query(`INSERT INTO product_revisions(product_key,revision,body)
    SELECT value->>'productKey',1,value FROM jsonb_array_elements($1::jsonb)`,[JSON.stringify(data)]);
  await pool.query('INSERT INTO product_revisions(product_key,revision,body) VALUES($1,2,$2)',['source-000',body('source-000',2)]);
  await pool.query("UPDATE products SET latest_revision=2 WHERE product_key='source-000'");
  await pool.query("INSERT INTO local_resource_archives(kind,resource_id,archived_at) VALUES('product','source-071',now())");
  app=await createApp(repo,new BlobStore(root),['http://127.0.0.1:5273']);await app.getHttpAdapter().getInstance().ready();
});
afterAll(async()=>{await app?.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();if(root) await rm(root,{recursive:true,force:true});outbound.mockRestore();});
it('reaches all 120 sources with stable tie order and reads only latest revisions',async()=>{
  const pages=await Promise.all([1,2,3].map(page=>repo.listProductsPage({lifecycle:'all',page,limit:50})));
  expect(pages.map(page=>[page.total,page.items.length,page.hasMore])).toEqual([[120,50,true],[120,50,true],[120,20,false]]);
  const found=pages.flatMap(page=>page.items);
  expect(found.map(item=>item.productKey)).toEqual(Array.from({length:120},(_,i)=>'source-'+String(119-i).padStart(3,'0')));
  expect(found.at(-1)?.revision).toBe(2);
  expect(await repo.getProduct('source-000',1)).toMatchObject({revision:1});
  expect(await repo.getProductsByKeys(['source-000'])).toMatchObject([{productKey:'source-000',revision:2}]);
  await expect(repo.listProducts()).rejects.toThrow('PRODUCT_PAGING_REQUIRED');
});
it('counts archives and literal SKU search before paging, including empty late pages',async()=>{
  expect(await repo.listProductsPage({lifecycle:'active',page:3})).toMatchObject({total:119,hasMore:false});
  expect(await repo.listProductsPage({lifecycle:'archived'})).toMatchObject({total:1,items:[{productKey:'source-071',archived:true}]});
  expect(await repo.listProductsPage({q:'SKU%_'})).toMatchObject({total:1,items:[{productKey:'source-110'}]});
  expect(await repo.listProductsPage({lifecycle:'archived',q:'SKU%_'})).toMatchObject({total:0,items:[]});
  expect(await repo.listProductsPage({page:9})).toMatchObject({total:119,page:9,hasMore:false,items:[]});
});
it('returns page metadata through API and resolves a preparation selection outside its page',async()=>{
  const http=app.getHttpAdapter().getInstance();
  const response=await http.inject({method:'GET',url:'/v1/products?page=3&limit=50'});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({total:119,page:3,items:expect.any(Array),hasMore:false});
  const params=new URLSearchParams({partnerId:'2010476',shopId:'1423724897',productKeys:JSON.stringify(['source-000','source-071'])});
  const context=await http.inject({method:'GET',url:'/v1/production-preparations/context?'+params});
  expect(context.statusCode).toBe(200);
  expect(context.json().pageProductKeys).toHaveLength(50);
  expect(context.json().pageProductKeys).not.toContain('source-000');
  expect(context.json().products).toContainEqual(expect.objectContaining({productKey:'source-000',revision:2}));
  expect(context.json().products.some((product:any)=>product.productKey==='source-071')).toBe(false);
  expect((await http.inject({method:'GET',url:'/v1/production-preparations/context?'+params+'&page=0'})).statusCode).toBe(400);
  expect((await http.inject({method:'GET',url:'/v1/production-preparations/context?partnerId=2010476&shopId=1423724897&productKeys=broken'})).statusCode).toBe(400);
  expect(outbound).not.toHaveBeenCalled();
});
