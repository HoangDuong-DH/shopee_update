import { randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,writeFile,readFile,readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { Pool,Repository,migrate } from '../../packages/persistence/src/index.js';
import { productionOwner,currentProductionScope } from '../../apps/api/src/production-scope.js';
import { productionBatchPass1Root } from '../../apps/api/src/production-batch-source.js';
import { durableRecoveryFile,recoveryFingerprint,withNoDispatchProofs } from '../../apps/api/src/production-batch-recovery.js';
const schema='test_no_dispatch_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:process.env.DATABASE_URL});
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema},public`});
const repo=new Repository(pool),connectionId=randomUUID();let root:string;
beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);
  root=await mkdtemp(resolve(productionBatchPass1Root,'negative-recovery-'));
  await pool.query("INSERT INTO connections(id,environment,partner_id,shop_id,name) VALUES($1,'production','2010476','1423724897','Isolated fixture')",[connectionId]);
});
afterAll(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
function fixture() {return {sha256:'a'.repeat(64),value:{batchId:randomUUID(),scope:currentProductionScope(),listings:[{sourceIdentity:randomUUID(),sourceRevision:2,sourceKey:'a',document:{title:'Immutable fixture'}}]}} as any;}
it('records absence only while holding the same journal owner and source locks as the writers',async()=>{
  const loaded=fixture(),observer=await pool.connect();
  try {
    await withNoDispatchProofs(repo,root,loaded,['a'],async proofs=>{
      expect(proofs).toHaveLength(1);
      for(const key of ['production-pilot:'+productionOwner(),loaded.value.listings[0].sourceIdentity])
        expect((await observer.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held',[key])).rows[0].held).toBe(false);
    });
    const key='production-pilot:'+productionOwner();
    expect((await observer.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held',[key])).rows[0].held).toBe(true);
    await observer.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
  } finally {observer.release();}
});
it.each(['authorized','sent','unknown'])('refuses negative proof when an older revision is %s, including its step history',async(state)=>{
  const loaded=fixture(),id=randomUUID(),source=loaded.value.listings[0];
  await pool.query(`INSERT INTO production_pilot_operations(id,owner_key,connection_id,connection_revision,source_identity,source_revision,source_payload,source_fingerprint,expected_projection,state)
    VALUES($1,$2,$3,1,$4,1,'{}',$5,'{}',$6)`,[id,productionOwner(),connectionId,source.sourceIdentity,'a'.repeat(64),state]);
  if(state==='sent')await pool.query(`INSERT INTO production_pilot_steps(id,operation_id,step_key,ordinal,kind,path,payload,fingerprint,authorized_revision,state,sent_at)
    VALUES($1,$2,'create',1,'create','/api/v2/product/add_item','{}',$3,1,'sent',now())`,[randomUUID(),id,'b'.repeat(64)]);
  await withNoDispatchProofs(repo,root,loaded,['a'],async proofs=>expect(proofs).toEqual([]));
});
it('refuses an unexplained checkpoint even when the complete database history is empty',async()=>{
  const loaded=fixture(),source=loaded.value.listings[0],directory=resolve(root,'checkpoints',loaded.value.batchId,loaded.sha256);
  await mkdir(directory,{recursive:true});await writeFile(resolve(directory,recoveryFingerprint({sourceIdentity:source.sourceIdentity,sourceRevision:source.sourceRevision})+'.json'),'{}');
  await withNoDispatchProofs(repo,root,loaded,['a'],async proofs=>expect(proofs).toEqual([]));
});
it('atomically publishes one complete fsynced receipt without overwriting a concurrent immutable receipt',async()=>{
  const path=resolve(root,randomUUID()+'.recovery.json');
  const results=await Promise.allSettled([durableRecoveryFile(path,{winner:1}),durableRecoveryFile(path,{winner:2})]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const rejected=results.find(result=>result.status==='rejected') as PromiseRejectedResult;
  expect(rejected.reason.code).toBe('EEXIST');
  expect([1,2]).toContain(JSON.parse(await readFile(path,'utf8')).winner);
  expect((await readdir(root)).filter(name=>name.endsWith('.pending'))).toEqual([]);
});
