import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ProductionBatchService, registerProductionBatch } from '../../apps/api/src/production-batch-service.js';
import { productionBatchPass1Root } from '../../apps/api/src/production-batch-source.js';
import { runPass1ProductionBatch } from '../../apps/api/src/production-batch-runner.js';

async function fixture() {
  await mkdir(productionBatchPass1Root,{recursive:true});
  const root=await mkdtemp(resolve(productionBatchPass1Root,'lifecycle-test-'));
  const loaded:any={manifestPath:resolve(root,'manifest.json'),sha256:'a'.repeat(64),value:{version:1,batchId:randomUUID(),authorizationReference:'User-approved source',assets:{},listings:[{sourceIdentity:'local-product',sourceRevision:1,sourceKey:'source-a',document:{title:'Tinh dầu Cam Sả',models:[{sku:'SKU-A'}]}}]}};
  const data={revision:1 as number|null,archived:false,operation:null as any};
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes('SELECT to_jsonb(o) AS operation'))return {rows:data.operation?[{operation:data.operation,steps:[]}]:[]};
    if(sql.includes('FROM products p'))return {rows:data.revision===null?[]:[{product_key:'local-product',latest_revision:data.revision,body:{productKey:'local-product',revision:data.revision}}]};
    if(sql.includes('JOIN jsonb_to_recordset'))return {rows:data.archived?[{}]:[],rowCount:data.archived?1:0};
    return {rows:[],rowCount:0};
  });
  const locks=new Set<string>();
  const connect=vi.fn(async()=>({query:vi.fn(async(sql:string,values:string[])=>{
    const key=values?.[0]!;
    if(sql.includes('pg_try_advisory_lock')){const locked=!locks.has(key);if(locked)locks.add(key);return {rows:[{locked}]};}
    if(sql.includes('pg_advisory_unlock'))locks.delete(key);
    return {rows:[]};
  }),release:vi.fn()}));
  const repo:any={pool:{query,connect}},run=vi.fn(async()=>({stopped:false,listings:[]}));
  const options:any={root,load:async()=>loaded,run,enabled:true};
  const service=new ProductionBatchService(repo,{} as any,options);
  await registerProductionBatch({manifestPath:loaded.manifestPath,expectedSha256:loaded.sha256},options);
  return {root,loaded,data,repo,run,service,batchId:loaded.value.batchId};
}
it('blocks stale first dispatch while preserving eligible siblings and legacy identities',async()=>{
  const f=await fixture();f.data.revision=2;
  let status=await f.service.status(f.batchId);
  expect(status.listings[0]).toMatchObject({currentSource:'source_changed',currentRevision:2,canExclude:true});
  expect(status.canExecute).toBe(false);
  await expect(f.service.start(f.batchId,{mode:'execute',expectedStatusFingerprint:status.statusFingerprint})).rejects.toThrow('PRODUCTION_BATCH_SOURCE_CHANGED');
  f.data.archived=true;status=await f.service.status(f.batchId);
  expect(status.listings[0]).toMatchObject({currentSource:'archived',currentRevision:2});
  expect(f.run).not.toHaveBeenCalled();
  f.loaded.value.listings.push({...f.loaded.value.listings[0],sourceIdentity:'legacy-source',sourceKey:'legacy-source'});
  status=await f.service.status(f.batchId);
  expect(status.canExecute).toBe(true);
  expect(status.listings).toMatchObject([{currentSource:'archived',canExecute:false},{currentSource:'current',canExecute:true,excluded:false}]);
  await expect(f.service.start(f.batchId,{mode:'execute',sourceKey:'source-a',expectedStatusFingerprint:status.statusFingerprint})).rejects.toThrow('PRODUCTION_BATCH_SOURCE_ARCHIVED');
  await expect(f.service.start(f.batchId,{mode:'execute',expectedStatusFingerprint:status.statusFingerprint})).resolves.toMatchObject({state:'accepted'});
});
it('excludes only an untouched source with a durable receipt and distinct completion count',async()=>{
  const f=await fixture(),before=await f.service.status(f.batchId),snapshot=JSON.stringify(f.loaded);
  const after=await f.service.exclude(f.batchId,{sourceKey:'source-a',expectedStatusFingerprint:before.statusFingerprint});
  expect(after).toMatchObject({state:'completed_with_exclusions',completedCount:0,excludedCount:1,remainingCount:0,canExecute:false,listings:[{excluded:true,canExclude:false,state:'not_sent'}]});
  expect(after.statusFingerprint).not.toBe(before.statusFingerprint);
  expect(JSON.stringify(f.loaded)).toBe(snapshot);
  const names=await readdir(resolve(f.root,'web-exclusions',f.batchId));
  expect(names).toHaveLength(1);
  expect(JSON.parse(await readFile(resolve(f.root,'web-exclusions',f.batchId,names[0]!), 'utf8'))).toMatchObject({sourceKey:'source-a',manifestSha256:f.loaded.sha256});
  await expect(f.service.exclude(f.batchId,{sourceKey:'source-a',expectedStatusFingerprint:before.statusFingerprint})).rejects.toThrow('PRODUCTION_BATCH_STATUS_CHANGED');
  expect(f.run).not.toHaveBeenCalled();
  const reserved=await fixture();reserved.data.operation={id:randomUUID(),source_identity:'local-product',state:'authorized',revision:1,item_id:null};
  const status=await reserved.service.status(reserved.batchId);
  expect(status.listings[0]?.canExclude).toBe(false);
  await expect(reserved.service.exclude(reserved.batchId,{sourceKey:'source-a',expectedStatusFingerprint:status.statusFingerprint})).rejects.toThrow('PRODUCTION_BATCH_EXCLUSION_NOT_ALLOWED');
});
it('the direct runner skips an excluded source without collecting or dispatching',async()=>{
  const f=await fixture(),before=await f.service.status(f.batchId);
  await f.service.exclude(f.batchId,{sourceKey:'source-a',expectedStatusFingerprint:before.statusFingerprint});
  const collect=vi.fn(),createRunner=vi.fn();
  const result=await runPass1ProductionBatch({mode:'execute',manifestPath:f.loaded.manifestPath,expectedSha256:f.loaded.sha256},{repo:f.repo,blobs:{} as any,load:async()=>f.loaded,collect,createRunner,outputRoot:f.root});
  expect(result).toMatchObject({stopped:false,listings:[{sourceKey:'source-a',state:'excluded'}]});
  expect(collect).not.toHaveBeenCalled();expect(createRunner).not.toHaveBeenCalled();
});
