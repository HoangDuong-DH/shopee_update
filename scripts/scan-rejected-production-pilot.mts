import 'dotenv/config';
import {Pool,Repository} from '@shopee/persistence';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {collectProductionPilotInput,productionPilotSourceRoot} from '../apps/api/src/production-pilot-source.js';
// Two complete, read-only inventory observations. No journal closure or API mutation here.
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const operationId=process.argv[2]??'85c09451-42b1-4927-b819-7a30dd21a602';
if(!['85c09451-42b1-4927-b819-7a30dd21a602','dfa64457-dd7d-4ca2-9354-c89482b4fd38'].includes(operationId))throw Error('UNREVIEWED_OPERATION');
try{
  const scans=[];
  for(let i=0;i<2;i++){
    const collected=await collectProductionPilotInput(new Repository(pool),'row-2');
    const records=await Promise.all(collected.evidenceFiles.map(async file=>JSON.parse(await readFile(file,'utf8'))));
    const inventory=records.filter(r=>['/api/v2/product/get_item_list','/api/v2/product/get_item_base_info','/api/v2/product/get_model_list'].includes(r.path));
    if(inventory.some(r=>r.result.kind!=='success'))throw Error('SCAN_INCOMPLETE');
    scans.push({observedAt:new Date().toISOString(),requestIds:inventory.map(r=>r.result.requestId),
      pages:inventory.filter(r=>r.path.endsWith('/get_item_list')).map(r=>({request:{offset:Number(r.query.offset),page_size:Number(r.query.page_size),item_status:r.query.item_status},envelope:r.result.envelope})),
      baseInfo:inventory.filter(r=>r.path.endsWith('/get_item_base_info')).map(r=>r.result.envelope),
      modelLists:inventory.filter(r=>r.path.endsWith('/get_model_list')).map(r=>({itemId:r.query.item_id,envelope:r.result.envelope})),
    });
    console.log(JSON.stringify({scan:i+1,preflightId:collected.preflightId,inventoryCount:collected.inventoryCount,duplicateMatches:collected.duplicateMatches,mutations:0}));
  }
  const file=resolve(productionPilotSourceRoot,'rejected-scans-'+randomUUID()+'.json');
  await writeFile(file,JSON.stringify({operationId,connectionRevision:1,scans},null,2),{flag:'wx'});
  console.log(JSON.stringify({file,scans:scans.length,mutations:0}));
}finally{await pool.end();}
