import 'dotenv/config';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from '@shopee/persistence';
import {SecretBox} from '@shopee/gateway';
import {ProductionPilotTransport} from '../packages/shopee/src/production-pilot-transport.js';
import {readProductionPilotWithBackoff} from '../apps/api/src/production-pilot-read-scheduler.js';
const operationId=process.argv[2];
if(!operationId||!/^[a-f0-9-]{36}$/.test(operationId))throw Error('OPERATION_REQUIRED');
const scope={environment:'production',partnerId:'2010476',shopId:'1423724897'} as const;
const owner='production:2010476:1423724897';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const directory=resolve('.local/production-batch-pass1-20260915/created-read',operationId,randomUUID());
await mkdir(directory,{recursive:true});
try {
 const op=(await pool.query('SELECT * FROM production_pilot_operations WHERE id=$1 AND owner_key=$2',[operationId,owner])).rows[0];
 if(!op?.item_id||!['acknowledged','verified'].includes(op.state)||op.source_payload?.batchAuthorization?.batchId!=='e60446aa-8fed-45e6-8cd8-52b0eee04a47')throw Error('OPERATION_SCOPE_INVALID');
 const conn=(await pool.query('SELECT * FROM connections WHERE id=$1',[op.connection_id])).rows[0];
 if(conn.state!=='connected'||new Date(conn.expires_at).getTime()<=Date.now())throw Error('AUTH_REQUIRED');
 const box=new SecretBox(process.env.APP_ENCRYPTION_KEY!);
 const keys=box.open(conn.partner_key_ciphertext,owner) as {partnerKey:string};
 const tokens=box.open(conn.token_ciphertext,owner) as {accessToken:string};
 const client=new ProductionPilotTransport({...scope,partnerKey:keys.partnerKey,accessToken:tokens.accessToken});
 for(let pass=1;pass<=2;pass++){
  const record=async(name:string,path:string,query:Record<string,string>)=>readProductionPilotWithBackoff(client,path,query,async(result,attempt)=>{
   await writeFile(resolve(directory,`${pass}-${name}-${attempt}.json`),JSON.stringify({scope,operationId,itemId:op.item_id,observedAt:new Date().toISOString(),path,query,result},null,2),{flag:'wx'});
  });
  const base=await record('base','/api/v2/product/get_item_base_info',{item_id_list:op.item_id});
  const models=await record('models','/api/v2/product/get_model_list',{item_id:op.item_id});
  if(base.kind!=='success'||models.kind!=='success')throw Error('READ_FAILED');
  const raw={scope,operationId,itemId:op.item_id,sourceFingerprint:op.source_fingerprint,observedAt:new Date().toISOString(),base,models};
  await writeFile(resolve(directory,`read-${pass}.json`),JSON.stringify(raw,null,2),{flag:'wx'});
 }
 console.log(JSON.stringify({directory,operationId,itemId:op.item_id,reads:2,mutations:0}));
}catch(error){console.log(JSON.stringify({directory,code:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'READ_FAILED',mutations:0}));process.exitCode=1;}
finally{await pool.end();}
