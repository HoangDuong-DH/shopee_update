import 'dotenv/config';
import {Pool,Repository} from '@shopee/persistence';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ProductionPilotJournal} from '../apps/api/src/production-pilot-journal.js';
import {loadProductionPilotSource,productionPilotSourceRoot,productionPilotScope} from '../apps/api/src/production-pilot-source.js';
const scanName=process.argv[2];
if(!/^rejected-scans-[a-f0-9-]{36}\.json$/.test(scanName??''))throw Error('EXPLICIT_SCAN_FILE_REQUIRED');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try{
  const source=await loadProductionPilotSource();
  const raw=JSON.parse(await readFile(resolve(productionPilotSourceRoot,scanName),'utf8'));
  const operationId='dfa64457-dd7d-4ca2-9354-c89482b4fd38';
  const current=source.value.listings.map((s:any)=>({sourceIdentity:s.sourceIdentity,sourceRevision:s.sourceRevision}));
  if(current[0].sourceRevision!==4 || source.value.listings[0].supersedesOperationId!==operationId || raw.operationId!==operationId || raw.connectionRevision!==1)throw Error('WRONG_RECONCILIATION_SOURCE');
  const allowedSources=[{...current[0],sourceRevision:2},{...current[0],sourceRevision:3},...current];
  const journal=new ProductionPilotJournal(new Repository(pool),{allowedSources});
  const before=await journal.get(operationId);
  const scans=raw.scans.map((scan:any)=>({...productionPilotScope,connectionRevision:raw.connectionRevision,...scan}));
  const result=await journal.closeRejectedCreate({operationId,expectedRevision:before.operation.revision,connectionRevision:raw.connectionRevision,scans});
  await writeFile(resolve(productionPilotSourceRoot,'rejected-logistics-closure-result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify({operationId,originalState:before.operation.state,reconciliationSaved:true,shopeeMutations:0}));
}finally{await pool.end();}
