import 'dotenv/config';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from '@shopee/persistence';
import {SecretBox} from '@shopee/gateway';
import {ProductionPilotTransport} from '../packages/shopee/src/production-pilot-transport.js';
import {readProductionPilotWithBackoff} from '../apps/api/src/production-pilot-read-scheduler.js';
const scope={environment:'production',partnerId:'2010476',shopId:'1423724897'} as const;
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const directory=resolve('.local/production-batch-pass1-20260915/brands',randomUUID());
await mkdir(directory,{recursive:true});
try {
 const rows=(await pool.query('SELECT * FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3',['production',scope.partnerId,scope.shopId])).rows;
 if(rows.length!==1||rows[0].state!=='connected'||new Date(rows[0].expires_at).getTime()<=Date.now())throw Error('AUTH_REQUIRED');
 const conn=rows[0],box=new SecretBox(process.env.APP_ENCRYPTION_KEY!),owner='production:2010476:1423724897';
 const keys=box.open(conn.partner_key_ciphertext,owner) as {partnerKey:string};
 const tokens=box.open(conn.token_ciphertext,owner) as {accessToken:string};
 const client=new ProductionPilotTransport({...scope,partnerKey:keys.partnerKey,accessToken:tokens.accessToken});
 const get=async(path:string,query:Record<string,string>,name:string)=>{
  const result=await readProductionPilotWithBackoff(client,path,query,async(result,attempt)=>{
   await writeFile(resolve(directory,`${name}-${attempt}.json`),JSON.stringify({scope,connectionRevision:conn.revision,observedAt:new Date().toISOString(),path,query,result},null,2),{flag:'wx'});
  });
  if(result.kind!=='success')throw Error('READ_FAILED_'+name);
  return result.response;
 };
 const shop=await get('/api/v2/shop/get_shop_info',{},'shop');
 if(shop.region!=='VN'||shop.status!=='NORMAL'||shop.shop_name!=='Vuatinhdau - Đại Lý Chính Hãng')throw Error('SHOP_MISMATCH');
 const categories=[];
 for(const categoryId of ['102572','101127','100265','101128']) {
  let offset=0,complete=false,found=false,count=0,pages=0;
  const matches:unknown[]=[];
  while(pages<100){
   const response=await get('/api/v2/product/get_brand_list',{category_id:categoryId,status:'1',offset:String(offset),page_size:'100',language:'vi'},'brands-'+categoryId+'-'+pages);
   const brands=response.brand_list;
   if(!Array.isArray(brands)||typeof response.has_next_page!=='boolean')throw Error('BRAND_RESPONSE_INVALID');
   count+=brands.length;pages++;
   const matched=brands.filter((b:any)=>String(b.brand_id)==='1252097'||String(b.original_brand_name).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s/g,'').toLowerCase()==='vinatuoi');
   matches.push(...matched);
   complete=response.has_next_page===false;
   found=matched.some((b:any)=>String(b.brand_id)==='1252097'&&b.original_brand_name==='VINA TƯƠI');
   if(complete||found)break;
   if(!Number.isSafeInteger(response.next_offset)||Number(response.next_offset)<=offset||!brands.length)throw Error('BRAND_CURSOR_INVALID');
   offset=Number(response.next_offset);
  }
  const category={categoryId,pages,count,complete,found,matches};categories.push(category);console.log(JSON.stringify(category));
 }
 await writeFile(resolve(directory,'summary.json'),JSON.stringify({scope,observedAt:new Date().toISOString(),categories,mutations:0},null,2),{flag:'wx'});
 console.log(JSON.stringify({directory,mutations:0}));
}catch(error){const code=error instanceof Error&&/^[A-Z0-9_-]+$/.test(error.message)?error.message:'BRAND_INSPECTION_FAILED';console.log(JSON.stringify({directory,code,mutations:0}));process.exitCode=1;}
finally{await pool.end();}
