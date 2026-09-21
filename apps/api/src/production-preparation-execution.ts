import { z } from 'zod';
import type { Repository } from '@shopee/persistence';
import type { ProductionPreparationService } from './production-preparation-service.js';
import type { ProductionBatchService } from './production-batch-service.js';
import { ProductionExecutionPolicyService } from './production-execution-policy.js';

type BatchPort = Pick<ProductionBatchService,'status'|'start'>;
const input=z.object({expectedFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const ownerKey='production-preparation-owner:production:2010476:1423724897';
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
/** Resumable parent queue. All child writes still pass through the existing durable journal. */
export class ProductionPreparationExecution {
  private active=new Map<string,Promise<void>>();
  constructor(private readonly repo:Repository,private readonly preparation:Pick<ProductionPreparationService,'get'>,
    private readonly batches:BatchPort,private readonly options:{sleep?:typeof delay;maximumPolls?:number;enabled?:boolean}={}){}
  async get(id:string) {
    z.string().uuid().parse(id);
    const row=(await this.repo.pool.query('SELECT body FROM production_preparation_executions WHERE preparation_id=$1',[id])).rows[0];
    if (!row) return null;
    const policy = await new ProductionExecutionPolicyService(this.repo).getForPreparation(id);
    const current = policy ? {...row.body, publicationMode:policy.publicationMode, imageQcPolicy:policy.imageQcPolicy,
      completionTarget:'created_hidden',executionPolicyFingerprint:policy.fingerprint} : row.body;
    if(row?.body.state==='running' && !this.active.has(id)) {
      const client=await this.repo.pool.connect(),key='production-preparation-execution:'+id;
      try {
        const unlocked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended(current_schema() || chr(58) || $1,0)) AS locked',[key])).rows[0].locked;
        if(unlocked) {
          await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema() || chr(58) || $1,0))',[key]);
          return {...current,state:'paused',code:'PREPARATION_INTERRUPTED_REVIEW_REQUIRED',canResume:true};
        }
      } finally {client.release();}
    }
    return current;
  }
  async start(id:string,raw:unknown) {
    z.string().uuid().parse(id); const parsed=input.parse(raw);
    if(!(this.options.enabled ?? process.env.PRODUCTION_PILOT_ENABLED==='1')) throw Error('PREPARATION_EXECUTION_DISABLED');
    // The coordinator and child journal each retain a lock connection; leave room for reads.
    if(this.repo.pool.options.max!<4)throw Error('PREPARATION_POOL_CAPACITY_REQUIRED');
    const prepared=await this.preparation.get(id);
    if(parsed.expectedFingerprint!==prepared.fingerprint || !prepared.registration) throw Error('PREPARATION_NOT_REGISTERED');
    const client=await this.repo.pool.connect(),key='production-preparation-execution:'+id;
    let locked=false,ownerLocked=false,dispatched=false;
    try {
      ownerLocked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended(current_schema() || chr(58) || $1,0)) AS locked',[ownerKey])).rows[0].locked;
      if(!ownerLocked) throw Error('PREPARATION_IN_PROGRESS');
      locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended(current_schema() || chr(58) || $1,0)) AS locked',[key])).rows[0].locked;
      if(!locked) throw Error('PREPARATION_IN_PROGRESS');
      const old=await this.get(id);
      if(['completed','completed_with_exclusions'].includes(old?.state)) return old;
      const policy = await new ProductionExecutionPolicyService(this.repo).getForPreparation(id);
      if (policy && policy.preparationFingerprint !== prepared.fingerprint) throw Error('PREPARATION_REVIEW_CHANGED');
      const publicationMode = policy?.publicationMode ?? prepared.publicationMode;
      const state={id,fingerprint:prepared.fingerprint,state:'running',startedAt:old?.startedAt ?? new Date().toISOString(),
        publicationMode,completionTarget:publicationMode==='hidden_for_review'?'created_hidden':'published',
        ...(policy ? {imageQcPolicy:policy.imageQcPolicy,executionPolicyFingerprint:policy.fingerprint} : {}),
        resumedAt:new Date().toISOString(),completedBatches:old?.completedBatches ?? [],excludedCount:old?.excludedCount ?? 0,totalBatches:prepared.registration.batches.length,currentBatchId:null,code:null};
      await this.save(id,prepared.fingerprint,state);
      const running=this.perform(state,prepared.registration.batches).finally(async()=>{
        this.active.delete(id);try { await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema() || chr(58) || $1,0))',[key]);
          await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema() || chr(58) || $1,0))',[ownerKey]); } finally {client.release();}
      });
      this.active.set(id,running);dispatched=true; void running.catch(()=>undefined);
      return {...state};
    } finally {
      if(!dispatched) { try {if(locked) await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema() || chr(58) || $1,0))',[key]);if(ownerLocked)await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema() || chr(58) || $1,0))',[ownerKey]);}finally{client.release();} }
    }
  }
  private async save(id:string,fp:string,body:unknown) {
    const saved=await this.repo.pool.query(`INSERT INTO production_preparation_executions(preparation_id,fingerprint,body) VALUES($1,$2,$3)
      ON CONFLICT(preparation_id) DO UPDATE SET body=EXCLUDED.body,updated_at=now() WHERE production_preparation_executions.fingerprint=EXCLUDED.fingerprint`,[id,fp,body]);
    if(saved.rowCount!==1)throw Error('PREPARATION_EXECUTION_CHANGED');
  }
  private async perform(state:any,batches:{batchId:string;manifestSha256:string}[]) {
    try {
      state.excludedCount=0;
      for(const batch of batches) {
        state.currentBatchId=batch.batchId;await this.save(state.id,state.fingerprint,state);
        let child=await this.batches.status(batch.batchId);
        if(child.manifestSha256!==batch.manifestSha256) throw Error('PREPARATION_BATCH_CHANGED');
        // Always inspect durable child state on resume; do not trust the parent's completed list.
        if(!['completed','completed_with_exclusions'].includes(child.state)) {
          if(child.busy || !child.canExecute) throw Error('PREPARATION_CHILD_REVIEW_REQUIRED');
          await this.batches.start(batch.batchId,{mode:'execute',expectedStatusFingerprint:child.statusFingerprint});
          let polls=0;
          do {
            await (this.options.sleep ?? delay)(1000);
            child=await this.batches.status(batch.batchId);
            if(child.manifestSha256!==batch.manifestSha256)throw Error('PREPARATION_BATCH_CHANGED');
            if(++polls >= (this.options.maximumPolls ?? 1800)) throw Error('PREPARATION_CHILD_STILL_RUNNING');
          } while(child.busy);
          if(!['completed','completed_with_exclusions'].includes(child.state)) throw Error(child.listings?.some(s=>s.state==='created_readback_pending') ? 'PREPARATION_CHILD_QC_REVIEW_REQUIRED' : 'PREPARATION_CHILD_REVIEW_REQUIRED');
        }
        state.excludedCount+=child.excludedCount ?? 0;
        state.completedBatches=[...new Set([...state.completedBatches,batch.batchId])];
        await this.save(state.id,state.fingerprint,state);
      }
      state.state=state.excludedCount?'completed_with_exclusions':'completed';state.currentBatchId=null;state.finishedAt=new Date().toISOString();
    } catch(error) {
      state.state='paused';const code=error instanceof Error?error.message:'';
      state.code=/^(PREPARATION|PRODUCTION_BATCH)_[A-Z_]+$/.test(code)?code:'PREPARATION_RUN_FAILED';
    }
    await this.save(state.id,state.fingerprint,state);
  }
  async waitForIdle(id:string) { await this.active.get(id); }
}
