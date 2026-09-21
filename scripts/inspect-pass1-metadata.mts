import 'dotenv/config';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from '@shopee/persistence';
import {SecretBox} from '@shopee/gateway';
import {ProductionPilotTransport} from '../packages/shopee/src/production-pilot-transport.js';
import {readProductionPilotWithBackoff} from '../apps/api/src/production-pilot-read-scheduler.js';
const scope={environment:'production',partnerId:'2010476',shopId:'1423724897'} as const;
const owner='production:2010476:1423724897';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const directory=resolve('.local/production-batch-pass1-20260915/metadata',randomUUID());
await mkdir(directory,{recursive:true});
try {
 const rows=(await pool.query('SELECT * FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3',['production',scope.partnerId,scope.shopId])).rows;
 if(rows.length!==1||rows[0].state!=='connected'||new Date(rows[0].expires_at).getTime()<=Date.now())throw Error('AUTH_REQUIRED');
 const conn=rows[0],box=new SecretBox(process.env.APP_ENCRYPTION_KEY!);
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
 for(const categoryId of ['102572','101127','100265','101128']){
  const limits=await get('/api/v2/product/get_item_limit',{category_id:categoryId},'limits-'+categoryId);
  const attributes=await get('/api/v2/product/get_attribute_tree',{category_id_list:categoryId,language:'vn'},'attrs-'+categoryId);
  categories.push({categoryId,limits,attributes});
 }
 const channels=await get('/api/v2/logistics/get_channel_list',{},'channels');
 const result={scope,connectionRevision:conn.revision,observedAt:new Date().toISOString(),categories,channels,mutations:0};
 await writeFile(resolve(directory,'summary.json'),JSON.stringify(result,null,2),{flag:'wx'});
 console.log(JSON.stringify({directory,mutations:0,categories:categories.map(c=>({categoryId:c.categoryId,limits:c.limits}))}));
}catch(error){const code=error instanceof Error&&/^[A-Z0-9_-]+$/.test(error.message)?error.message:'METADATA_INSPECTION_FAILED';console.log(JSON.stringify({directory,code,mutations:0}));process.exitCode=1;}
finally{await pool.end();}
