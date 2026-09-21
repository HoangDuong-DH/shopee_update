import 'dotenv/config';
import { Pool,Repository } from '@shopee/persistence';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProductionPilotJournal } from '../apps/api/src/production-pilot-journal.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try {
  const source=JSON.parse(await readFile(resolve('.local/production-pilot-1423724897/source-authorized-v2.json'),'utf8'));
  const journal=new ProductionPilotJournal(new Repository(pool),{allowedSources:source.listings.map((s:any)=>({sourceIdentity:s.sourceIdentity,sourceRevision:s.sourceRevision}))});
  const view=await journal.get('85c09451-42b1-4927-b819-7a30dd21a602');
  await writeFile(resolve('.local/production-pilot-1423724897/operation-85c09451.json'),JSON.stringify(view,null,2));
  console.log(JSON.stringify({operationId:view.operation.id,state:view.operation.state,itemId:view.operation.item_id,
    steps:view.steps.map((s:any)=>({kind:s.kind,path:s.path,state:s.state,requestId:s.receipt?.request_id,
      error:s.receipt?.error,message:s.receipt?.message,warning:s.receipt?.warning,sentAt:s.sent_at})),verification:view.verification},null,2));
} finally {await pool.end();}
