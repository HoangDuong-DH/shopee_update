import { createHash,randomUUID } from 'node:crypto';
import { link,mkdir,open,readFile,unlink } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { canonicalJson } from '@shopee/domain';
import { localArchiveLock,type Repository } from '@shopee/persistence';
import { assertProductionScope,currentProductionScope,productionOwner } from './production-scope.js';
import { productionBatchPass1Root,type loadProductionBatchSource } from './production-batch-source.js';

type Loaded=Awaited<ReturnType<typeof loadProductionBatchSource>>;
export const recoveryFingerprint=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export type NoDispatchProof={sourceKey:string;sourceIdentity:string;sourceRevision:number;documentSha256:string;basis:'empty_historical_journal'};
export type RecoveryReference={requestId:string;recoveryFingerprint:string;sourceKeys:string[]};
const absent=async(path:string)=>{try{await readFile(path);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}};
export async function durableRecoveryFile(path:string,value:unknown) {
  const temporary=resolve(dirname(path),'.recovery-'+randomUUID()+'.pending');
  try {
    const file=await open(temporary,'wx',0o600);
    try {await file.writeFile(JSON.stringify(value,null,2));await file.sync();}finally{await file.close();}
    // Publish a complete file atomically without overwriting an earlier receipt.
    // Hard linking within this directory works on NTFS and POSIX; unlike rename,
    // EEXIST never replaces a competing immutable receipt.
    await link(temporary,path);
  } finally {await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
}

/** Called with the batch coordinator lease. Match product -> journal lock order.
 * Persist the negative observation before releasing the journal owner transaction. */
export async function withNoDispatchProofs<T>(repo:Repository,root:string,loaded:Loaded,sourceKeys:string[],persist:(proofs:NoDispatchProof[])=>Promise<T>):Promise<T> {
  assertProductionScope(loaded.value.scope);
  const sources=loaded.value.listings.filter(source=>sourceKeys.includes(source.sourceKey));
  const client=await repo.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema() || chr(58) || $1,0))',[localArchiveLock]);
    for(const identity of sources.map(source=>source.sourceIdentity).sort())await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[identity]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['production-pilot:'+productionOwner()]);
    const proofs:NoDispatchProof[]=[];
    for(const source of sources) {
      // Every revision, not just the currently prepared one. Steps/publications
      // have operation FKs; the explicit joins make their inspection auditable.
      const history=await client.query(`SELECT o.id,s.step_key,p.id AS publication_id
        FROM production_pilot_operations o LEFT JOIN production_pilot_steps s ON s.operation_id=o.id
        LEFT JOIN production_pilot_publications p ON p.create_operation_id=o.id
        WHERE o.owner_key=$1 AND o.source_identity=$2`,[productionOwner(),source.sourceIdentity]);
      if(history.rows.length)continue;
      const file=recoveryFingerprint({sourceIdentity:source.sourceIdentity,sourceRevision:source.sourceRevision})+'.json';
      const roots=[...new Set([root,productionBatchPass1Root])];
      if(!(await Promise.all(roots.map(base=>absent(resolve(base,'checkpoints',loaded.value.batchId,loaded.sha256,file))))).every(Boolean))continue;
      proofs.push({sourceKey:source.sourceKey,sourceIdentity:source.sourceIdentity,sourceRevision:source.sourceRevision,
        documentSha256:recoveryFingerprint(source.document),basis:'empty_historical_journal'});
    }
    const result=await persist(proofs);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export function noDispatchProofMatches(proof:NoDispatchProof|undefined,source:Loaded['value']['listings'][number]) {
  return !!proof && canonicalJson(proof)===canonicalJson({sourceKey:source.sourceKey,sourceIdentity:source.sourceIdentity,
    sourceRevision:source.sourceRevision,documentSha256:recoveryFingerprint(source.document),basis:'empty_historical_journal'});
}
const bindingPath=(root:string,batchId:string,requestId:string,sourceKey:string)=>resolve(root,'web-jobs',batchId,
  requestId+'-'+createHash('sha256').update(sourceKey).digest('hex')+'.successor.json');
export async function bindRecoverySuccessor(root:string,loaded:Loaded,request:any,references:RecoveryReference[],sourceKey:string,operation:any) {
  assertProductionScope(loaded.value.scope);
  const relevant=references.filter(reference=>reference.sourceKeys.includes(sourceKey));
  if(!relevant.length)return;
  const source=loaded.value.listings.find(source=>source.sourceKey===sourceKey);
  if(!source || operation.owner_key!==productionOwner() || operation.source_identity!==source.sourceIdentity || operation.source_revision!==source.sourceRevision || operation.state!=='authorized' || operation.item_id!==null)
    throw Error('PRODUCTION_BATCH_SUCCESSOR_BINDING_INVALID');
  const body={version:1,scope:currentProductionScope(),batchId:loaded.value.batchId,manifestSha256:loaded.sha256,
    requestId:request.requestId,requestFingerprint:recoveryFingerprint(request),references:relevant,
    sourceKey,sourceIdentity:source.sourceIdentity,sourceRevision:source.sourceRevision,
    operationId:operation.id,sourceFingerprint:operation.source_fingerprint};
  await mkdir(resolve(root,'web-jobs',loaded.value.batchId),{recursive:true});
  await durableRecoveryFile(bindingPath(root,loaded.value.batchId,request.requestId,sourceKey),body);
}
export async function hasRecoverySuccessor(root:string,loaded:Loaded,records:Map<string,any>,recovery:any,sourceKey:string,operation:any) {
  for(const request of records.values()) {
    if(request.mode!=='execute' || request.sourceKey && request.sourceKey!==sourceKey)continue;
    const refs:RecoveryReference[]=request.noDispatchRecoveryRefs ?? [];
    if(!Array.isArray(refs))continue;
    if(!refs.some(reference=>reference.requestId===recovery.requestId && reference.recoveryFingerprint===recoveryFingerprint(recovery) && reference.sourceKeys.includes(sourceKey)))continue;
    let binding:any;
    try{binding=JSON.parse(await readFile(bindingPath(root,loaded.value.batchId,request.requestId,sourceKey),'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const expected={version:1,scope:currentProductionScope(),batchId:loaded.value.batchId,manifestSha256:loaded.sha256,
      requestId:request.requestId,requestFingerprint:recoveryFingerprint(request),references:refs.filter(reference=>reference.sourceKeys.includes(sourceKey)),
      sourceKey,sourceIdentity:operation.source_identity,sourceRevision:operation.source_revision,
      operationId:operation.id,sourceFingerprint:operation.source_fingerprint};
    if(canonicalJson(binding)===canonicalJson(expected))return true;
  }
  return false;
}
