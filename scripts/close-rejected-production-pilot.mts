import 'dotenv/config';
import {Pool,Repository} from '@shopee/persistence';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ProductionPilotJournal} from '../apps/api/src/production-pilot-journal.js';
import {loadProductionPilotSource,productionPilotSourceRoot,productionPilotScope} from '../apps/api/src/production-pilot-source.js';
// Local append-only reconciliation only. No Shopee network request, no deletion, no old-run rewrite.
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try{
  const source=await loadProductionPilotSource();
  const file=resolve(productionPilotSourceRoot,'rejected-scans-b25b0443-584c-443f-9a17-42064cf58807.json');
  const raw=JSON.parse(await readFile(file,'utf8'));
  const current=source.value.listings.map((s:any)=>({sourceIdentity:s.sourceIdentity,sourceRevision:s.sourceRevision}));
  if(current[0].sourceRevision!==3 || raw.operationId!=='85c09451-42b1-4927-b819-7a30dd21a602' || raw.connectionRevision!==1)throw Error('WRONG_RECONCILIATION_SOURCE');
  const allowedSources=[{sourceIdentity:current[0].sourceIdentity,sourceRevision:2},...current];
  const journal=new ProductionPilotJournal(new Repository(pool),{allowedSources});
  const before=await journal.get(raw.operationId);
  const scans=raw.scans.map((scan:any)=>({...productionPilotScope,connectionRevision:raw.connectionRevision,...scan}));
  const result=await journal.closeRejectedCreate({operationId:raw.operationId,expectedRevision:before.operation.revision,connectionRevision:raw.connectionRevision,scans});
  await writeFile(resolve(productionPilotSourceRoot,'rejected-closure-result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify({operationId:raw.operationId,originalState:before.operation.state,reconciliationSaved:true,shopeeMutations:0}));
}finally{await pool.end();}
