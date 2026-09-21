import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Pool,Repository,BlobStore} from '@shopee/persistence';
import {ProductionPilotRunner} from '../apps/api/src/production-pilot-runner.js';
import {ImageQcService} from '../apps/api/src/image-qc-service.js';
import {collectProductionPilotInput,loadProductionPilotSource,pilotProbeAuthorization,productionPilotSourceRoot} from '../apps/api/src/production-pilot-source.js';
const caseId=process.argv[2];
const reconcileOnly=process.argv[3]==='reconcile-publication';
if(process.argv[3]&&!reconcileOnly)throw Error('UNKNOWN_ACTION');
if(!/^[0-9a-f-]{36}$/.test(caseId??''))throw Error('EXPLICIT_REVIEWED_CASE_REQUIRED');
const operationId='ec195c1c-b2e1-44d9-a866-e14a39988a9b',itemId='51467852283';
const pool=new Pool({connectionString:process.env.DATABASE_URL}),repo=new Repository(pool);
const evidenceDirectory=resolve(productionPilotSourceRoot,'finish-one-'+randomUUID());
await mkdir(evidenceDirectory,{recursive:true});
const emit=async(phase:string,result:unknown)=>{
  await writeFile(resolve(evidenceDirectory,phase+'.json'),JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify({phase,result,evidenceDirectory}));
};
try{
  const loaded=await loadProductionPilotSource();
  const listing=loaded.value.listings[0];
  if(listing.sourceRevision!==4||listing.sourceKey!=='row-2')throw Error('SOURCE_CHANGED');
  const op=(await pool.query('SELECT * FROM production_pilot_operations WHERE id=$1',[operationId])).rows[0];
  if(!op||op.owner_key!=='production:2010476:1423724897'||op.item_id!==itemId||!['acknowledged','verified'].includes(op.state))throw Error('CREATED_ITEM_STATE_CHANGED');
  const steps=(await pool.query('SELECT kind,state FROM production_pilot_steps WHERE operation_id=$1',[operationId])).rows;
  if(steps.length!==24||steps.some((s:any)=>s.state!=='acknowledged'))throw Error('FULL_ACK_REQUIRED_FOR_READ_ONLY');
  const existingPublications=(await pool.query('SELECT id,state,preflight_metadata FROM production_pilot_publications WHERE create_operation_id=$1',[operationId])).rows;
  if(reconcileOnly){
    if(existingPublications.length!==1||existingPublications[0].state!=='acknowledged')throw Error('ACKNOWLEDGED_PUBLICATION_REQUIRED');
  }else if(existingPublications.length)throw Error('PUBLICATION_EXISTS_READ_ONLY_REVIEW_REQUIRED');
  const imageQc=new ImageQcService(repo,new BlobStore(process.env.DATA_ROOT??'.local/data'));
  const allowedSources=[{sourceIdentity:listing.sourceIdentity,sourceRevision:2},{sourceIdentity:listing.sourceIdentity,sourceRevision:3},
    ...loaded.value.listings.map((s:any)=>({sourceIdentity:s.sourceIdentity,sourceRevision:s.sourceRevision}))];
  const runner=new ProductionPilotRunner(repo,{allowedSources,assetRoot:resolve(productionPilotSourceRoot,'assets'),
    evidenceRoot:resolve(productionPilotSourceRoot,'wire-evidence'),capabilityProbe:{sourceIdentity:listing.sourceIdentity,sourceRevision:4,authorizationReference:pilotProbeAuthorization},
    coverImageQc:{service:imageQc,findCase:async({binding,sourceSha256,sourceFingerprint})=>
      binding.operationId===operationId&&binding.itemId===itemId&&binding.sourceAssetId===listing.document.cover.importId&&
      binding.outputImageId==='vn-11134201-81ztc-mt4ye0fzurydbd'&&sourceSha256===listing.document.cover.sha256&&sourceFingerprint===op.source_fingerprint
        ?{caseId}:null}});
  // This complete acknowledged operation enters runner's read-only reconciliation branch.
  const reconciled=await runner.run(operationId);
  await emit('read-only-reconciliation',reconciled);
  if(reconciled.state!=='verified'){process.exitCode=1;}
  else{
    const preflight=reconcileOnly?null:await collectProductionPilotInput(repo,'row-2',{allowExistingListings:true});
    if(preflight&&preflight.sourceReceiptSha256!==loaded.sha256)throw Error('SOURCE_CHANGED');
    // Exactly one product publication; the second source is not dispatched here.
    const published=await runner.publish(operationId,reconcileOnly?existingPublications[0].preflight_metadata:preflight!.input.metadata);
    await emit(reconcileOnly?'publication-read-only':'publish-one',published);
    if(published.state!=='published')process.exitCode=1;
  }
}finally{await pool.end();}
