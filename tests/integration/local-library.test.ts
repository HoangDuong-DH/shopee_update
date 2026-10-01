import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, Repository, BlobStore, LocalLibraryRepository, migrate } from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { assertLocalIntegrationDatabase } from '../helpers/integration-database.js';

const database=new URL(process.env.DATABASE_URL??'postgres://invalid/invalid');
if(process.env.INTERNAL_ISOLATED_MODE!=='1') throw Error('LOCAL_LIBRARY_REQUIRES_ISOLATED_DATABASE');
assertLocalIntegrationDatabase(database);
const schema='local_library_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:database.href});
const pool=new Pool({connectionString:database.href,options:`-c search_path=${schema}`});
const repo=new Repository(pool), library=new LocalLibraryRepository(pool);
let root:string,app:Awaited<ReturnType<typeof createApp>>;
const imports:string[]=[],connections=[randomUUID(),randomUUID()];
const body=(key:string,title:string)=>({productKey:key,revision:1,title:{value:title,sources:[],confirmed:false},
  description:[{type:'text',text:'RAW_DOCUMENT_DO_NOT_DOWNLOAD_'.repeat(4000)}],coverKey:'cover-key',galleryKeys:[],
  tierNames:[],variants:[],assets:[],attributes:{},logistics:{},
  issues:[{code:'MISSING_SOURCE',severity:'block',field:'price',message:'Source required',sources:[]},
    {code:'REVIEW',severity:'warn',field:'title',message:'Review needed',sources:[]} ]});
async function product(key:string,title:string|undefined,at:string) {
  await pool.query('INSERT INTO products(product_key,latest_revision,updated_at) VALUES($1,1,$2)',[key,at]);
  await pool.query('INSERT INTO product_revisions(product_key,revision,body) VALUES($1,1,$2)',
    [key,title===undefined?{productKey:key,revision:1}:body(key,title)]);
}
const digests=async()=>(await pool.query('SELECT product_key,revision,md5(body::text) AS digest FROM product_revisions ORDER BY product_key,revision')).rows;

beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
  root=await mkdtemp(join(tmpdir(),'shopee-local-library-'));
  app=await createApp(repo,new BlobStore(root),['http://127.0.0.1:5273']);
  await app.getHttpAdapter().getInstance().ready();
  await product('micro-a','Bình xịt khử mùi','2026-10-01T00:00:00.000001Z');
  await product('micro-b','Bình xịt thơm','2026-10-01T00:00:00.000002Z');
  await product('micro-c','Bình xịt làm sạch','2026-10-01T00:00:00.000003Z');
  await product('unknown',undefined,'2026-09-29T00:00:00Z');
  await product('archived','Nguồn đã lưu trữ','2026-09-28T00:00:00Z');
  await pool.query("INSERT INTO local_resource_archives(kind,resource_id,archived_at) VALUES('product','archived',now())");
  for(const [index,id] of connections.entries())
    await pool.query("INSERT INTO connections(id,environment,partner_id,shop_id,name) VALUES($1,'production','987654',$2,$3)",
      [id,String(8001000+index),'Shop fixture '+index]);
  const order=randomUUID();
  await pool.query('INSERT INTO work_orders(id,latest_revision,target_key) VALUES($1,1,$2)',[order,'local-library-target']);
  await pool.query('INSERT INTO work_order_revisions(order_id,revision,product_key,source_revision,connection_id,config) VALUES($1,1,$2,1,$3,$4)',
    [order,'micro-a',connections[0],{operation:'create'}]);
  for(const [index,kind] of ['xlsx','docx','image'].entries()) {
    const source=await repo.createImport({sha256:String(index+1).repeat(64),filename:['Giá gốc.xlsx','Mô tả.docx','Ảnh nguồn.png'][index]!,kind:kind as any,bytes:100});
    await repo.finishImport(source.id,{raw:'RAW_IMPORT_DO_NOT_DOWNLOAD_'.repeat(4000)});imports.push(source.id);
  }
  await pool.query("INSERT INTO local_resource_archives(kind,resource_id,archived_at) VALUES('pricebook',$1,now())",[imports[0]]);
});
afterAll(async()=>{await app?.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();if(root) await rm(root,{recursive:true,force:true});});

it('preserves microsecond order across pages without omissions or duplicates',async()=>{
  const found:string[]=[];let cursor:string|undefined;
  do {
    const page=await library.products({q:'binh xit',limit:1,...(cursor?{cursor}:{})});
    found.push(...page.items.map(item=>item.productKey));cursor=page.nextCursor??undefined;
  } while(cursor);
  expect(found).toEqual(['micro-c','micro-b','micro-a']);
});

it('queries compact summaries, exact lifecycle and Vietnamese search without downloading evidence',async()=>{
  const original=await digests(),query=vi.spyOn(pool,'query');
  const page=await library.products({q:'khu mui'});
  expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({productKey:'micro-a',variantCount:0,
    savedIssueCount:2,savedBlockingIssueCount:1,issueBasis:'saved_draft',shopAssignmentCount:1,
    shopAssignments:[{connectionId:connections[0],scope:{environment:'production',partnerId:'987654',shopId:'8001000'}}]});
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls.every(([sql])=>!String(sql).includes('r.body'))).toBe(true);query.mockRestore();
  expect(JSON.stringify(page)).not.toContain('RAW_DOCUMENT');expect(JSON.stringify(page).length).toBeLessThan(2000);
  expect((await library.products({lifecycle:'archived'})).items.map(item=>item.productKey)).toEqual(['archived']);
  expect((await library.products({lifecycle:'all'})).items).toHaveLength(5);
  expect(await digests()).toEqual(original);
});

it('keeps missing saved fields unknown and synchronizes a newer source revision in the same transaction',async()=>{
  expect((await library.products({q:'unknown'})).items[0]).toMatchObject({title:null,variantCount:null,savedIssueCount:null,savedBlockingIssueCount:null});
  const client=await pool.connect();await client.query('BEGIN');
  try {
    await client.query("UPDATE products SET latest_revision=2,updated_at='2026-10-01T00:00:00.000004Z' WHERE product_key='micro-a'");
    await client.query("INSERT INTO product_revisions(product_key,revision,body) VALUES('micro-a',2,$1)",[{...body('micro-a','Bình xịt đã sửa'),revision:2}]);
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;}finally{client.release();}
  expect((await library.products({q:'da sua'})).items[0]).toMatchObject({productKey:'micro-a',revision:2,title:'Bình xịt đã sửa',shopAssignments:[{sourceChanged:true,sourceRevision:1}]});
});

it('uses bounded import metadata with lazy bodies and the original content identities',async()=>{
  const original=(await pool.query('SELECT id,md5(body::text) AS digest FROM source_files ORDER BY id')).rows;
  const active=await library.imports({limit:1});expect(active.items).toHaveLength(1);expect(active.hasMore).toBe(true);
  const next=await library.imports({limit:1,cursor:active.nextCursor!});expect(next.items).toHaveLength(1);
  expect(next.items[0]!.id).not.toBe(active.items[0]!.id);
  const archived=await library.imports({lifecycle:'archived',q:'gia goc'});
  expect(archived.items[0]).toMatchObject({id:imports[0],importId:imports[0],sha256:'1'.repeat(64),sourceSha:'1'.repeat(64),
    originalName:'Giá gốc.xlsx',kind:'xlsx',dataType:'xlsx',revision:null,bodyState:'not_loaded',archived:true});
  expect(JSON.stringify(archived)).not.toContain('RAW_IMPORT');
  expect((await pool.query('SELECT id,md5(body::text) AS digest FROM source_files ORDER BY id')).rows).toEqual(original);
  expect((await repo.getImport(imports[0]!))?.body).toHaveProperty('raw');
});

it('rejects cursors reused with another search, lifecycle or source type',async()=>{
  const first=await library.products({limit:1});expect(first.nextCursor).toBeTruthy();
  await expect(library.products({cursor:first.nextCursor,q:'other'})).rejects.toThrow('LOCAL_LIBRARY_CURSOR_INVALID');
  await expect(library.products({cursor:first.nextCursor,lifecycle:'all'})).rejects.toThrow('LOCAL_LIBRARY_CURSOR_INVALID');
  await expect(library.imports({cursor:first.nextCursor})).rejects.toThrow('LOCAL_LIBRARY_CURSOR_INVALID');
});

it('connects summary routes with no-store and exposes unavailable storage as 503',async()=>{
  const response=await app.inject({method:'GET',url:'/v1/local-library/products?limit=2'});
  expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.json().items).toHaveLength(2);
  expect((await app.inject({method:'GET',url:'/v1/local-library/imports?limit=101'})).statusCode).toBe(400);
  await pool.query('ALTER TABLE local_product_summaries RENAME TO hidden_product_summaries');
  try {
    const unavailable=await app.inject({method:'GET',url:'/v1/local-library/products'});
    expect(unavailable.statusCode).toBe(503);expect(unavailable.json().message).toBe('LOCAL_LIBRARY_UNAVAILABLE');
    expect(unavailable.json()).not.toHaveProperty('items');
  } finally {await pool.query('ALTER TABLE hidden_product_summaries RENAME TO local_product_summaries');}
});
