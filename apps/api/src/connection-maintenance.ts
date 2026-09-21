import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Repository } from '@shopee/persistence';
import { SecretBox, readShopInfo } from '@shopee/gateway';
import { refreshProductionPilotConnection } from './production-refresh-service.js';

const authErrors = new Set(['error_auth','invalid_acceess_token','invalid_access_token','shop_no_linked','partner_shop_no_link','shop_access_expired','refresh_token_expired','error_shop_refresh_token','shop_banned']);
const configErrors = new Set(['error_sign','error_partner_key_expired','invalid_partner_id','source_ip_undeclared','error_api_permission']);
type Options = {receiptRoot?:string; encryptionKey?:string; transport?:typeof fetch};
const exists = async (path:string) => access(path).then(()=>true,()=>false);

/** Refreshes credentials only: this scheduler cannot enqueue, create or publish products. */
export class ConnectionMaintenance {
  private active=new Map<string,Promise<unknown>>();
  constructor(private readonly repo:Repository,private readonly options:Options={}){}
  async refresh(id:string, expectedRevision:number) {
    z.string().uuid().parse(id); z.number().int().positive().parse(expectedRevision);
    const current=this.active.get(id);
    if(current) return current;
    const running=this.perform(id,expectedRevision).finally(()=>this.active.delete(id));
    this.active.set(id,running);return running;
  }
  private async perform(id:string,revision:number) {
    const row=(await this.repo.pool.query("SELECT id,revision,environment,partner_id,shop_id FROM connections WHERE id=$1",[id])).rows[0];
    if(!row || row.environment!=='production')throw Error('CONNECTION_NOT_FOUND');
    if(row.revision!==revision)throw Error('PRODUCTION_CONNECTION_REVISION_CONFLICT');
    const receiptRoot=this.options.receiptRoot ?? resolve(row.partner_id==='2010476' && row.shop_id==='1423724897'
      ? '.local/production-pilot-1423724897/credential-refresh' : '.local/connection-refresh');
    const hasIntent=await exists(join(receiptRoot,`${id}-r${revision}`,'intent.json'));
    try {
      const result=await refreshProductionPilotConnection(this.repo,{
        ...this.options,connectionId:id,expectedRevision:revision,receiptRoot,mode:hasIntent?'recover':'refresh',
      });
      if(result.kind==='success' || result.kind==='already_saved')return {kind:result.kind,connectionRevision:result.connectionRevision,expiresAt:result.expiresAt};
      const retryRead=result.code==='PRODUCTION_REFRESH_SHOP_READ_UNVERIFIED';
      const status=retryRead?'waiting':result.kind==='rejected'?'reauth_required':'unknown';
      await this.note(id,revision,status,result.code ?? 'REFRESH_UNKNOWN',retryRead?60:null);
      return {kind:result.kind,code:result.code};
    } catch(error) {
      const code=error instanceof Error?error.message:'';
      const wait=['PRODUCTION_REFRESH_WRITER_ACTIVE','PRODUCTION_REFRESH_AUTHORIZATION_ACTIVE','PRODUCTION_REFRESH_REVISION_CONFLICT','PRODUCTION_REFRESH_ALREADY_ATTEMPTED'].includes(code) || (error as {code?:string}).code==='55P03';
      if(wait) {
        await this.note(id,revision,'waiting',code.startsWith('PRODUCTION_')?code:'CONNECTION_BUSY',60);
        return {kind:'waiting',code:'CONNECTION_BUSY'};
      }
      const noCredentials=code==='PRODUCTION_REFRESH_SAVED_CREDENTIALS_INVALID';
      await this.note(id,revision,noCredentials?'reauth_required':'unknown',noCredentials?code:'REFRESH_UNRESOLVED',null);
      return {kind:'unknown',code:noCredentials?code:'REFRESH_UNRESOLVED'};
    }
  }
  private async note(id:string,revision:number,status:string,code:string,delaySeconds:number|null) {
    await this.repo.pool.query(`UPDATE connections SET refresh_status=$3,refresh_reason=$4,health_checked_at=now(),
      state=CASE WHEN $3='unknown' THEN 'refresh_unknown' WHEN $3='reauth_required' THEN 'reauth_required' ELSE state END,
      next_refresh_at=CASE WHEN $5::int IS NULL THEN NULL ELSE now()+$5*interval '1 second' END
      WHERE id=$1 AND revision=$2`,[id,revision,status,code,delaySeconds]);
  }
  async check(id:string,revision:number) {
    z.string().uuid().parse(id);z.number().int().positive().parse(revision);
    const row=(await this.repo.pool.query("SELECT * FROM connections WHERE id=$1 AND environment='production'",[id])).rows[0];
    if(!row)throw Error('CONNECTION_NOT_FOUND');
    if(row.revision!==revision)throw Error('PRODUCTION_CONNECTION_REVISION_CONFLICT');
    const scope=`production:${row.partner_id}:${row.shop_id}`;
    let partnerKey:string,accessToken:string;
    try {
      const box=new SecretBox(this.options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? '');
      partnerKey=z.object({partnerKey:z.string().min(1)}).parse(box.open(row.partner_key_ciphertext,scope)).partnerKey;
      accessToken=z.object({accessToken:z.string().min(1)}).parse(box.open(row.token_ciphertext,scope)).accessToken;
    } catch { await this.note(id,revision,'reauth_required','CREDENTIALS_UNREADABLE',null);return {kind:'rejected',code:'CREDENTIALS_UNREADABLE'}; }
    const outcome=await readShopInfo({environment:'production',partnerId:row.partner_id,shopId:row.shop_id,partnerKey,accessToken},this.options.transport);
    if(outcome.kind==='success') {
      const expiredGrant=outcome.info.authorizationExpiresAt!==undefined && outcome.info.authorizationExpiresAt*1000<=Date.now();
      const usable=outcome.info.status==='NORMAL' && !expiredGrant;
      // A GET proves access now; it does not invent a new access-token expiry or erase an uncertain rotation.
      await this.repo.pool.query(`UPDATE connections SET name=$3,health_checked_at=now(),
        state=CASE WHEN $4='reauth_required' THEN 'reauth_required' ELSE state END,
        refresh_status=CASE WHEN refresh_status='unknown' THEN refresh_status ELSE $4 END,
        refresh_reason=CASE WHEN refresh_status='unknown' THEN refresh_reason ELSE $5 END
        WHERE id=$1 AND revision=$2`,[id,revision,outcome.info.shopName,usable?'healthy':'reauth_required',usable?null:'SHOP_AUTHORIZATION_UNAVAILABLE']);
      await this.repo.pool.query(`INSERT INTO connection_checks(id,connection_id,connection_revision,endpoint,result)
        VALUES($1,$2,$3,'v2.shop.get_shop_info',$4)`,[randomUUID(),id,revision,{kind:'success',status:outcome.info.status,checkedAt:new Date().toISOString()}]);
      return {kind:usable?'success':'rejected',code:usable?undefined:'SHOP_AUTHORIZATION_UNAVAILABLE'};
    }
    const permanent=outcome.kind==='rejected' && (authErrors.has(outcome.code)||configErrors.has(outcome.code));
    const refreshable=outcome.kind==='rejected' && ['invalid_acceess_token','invalid_access_token'].includes(outcome.code) && row.auto_refresh;
    if(row.refresh_status!=='unknown')await this.note(id,revision,refreshable?'waiting':permanent?'reauth_required':'waiting',permanent?outcome.code:'SHOP_CHECK_TEMPORARILY_UNAVAILABLE',permanent&&!refreshable?null:60);
    return {kind:outcome.kind,code:permanent?outcome.code:'SHOP_CHECK_TEMPORARILY_UNAVAILABLE'};
  }
  async tick() {
    const rows=(await this.repo.pool.query(`SELECT id,revision FROM connections WHERE environment='production'
      AND auto_refresh AND state='connected' AND refresh_status NOT IN ('reauth_required','unknown')
      AND (next_refresh_at IS NULL OR next_refresh_at<=now())
      AND (expires_at IS NULL OR expires_at<=now()+interval '10 minutes' OR refresh_status='waiting')
      ORDER BY expires_at NULLS FIRST LIMIT 20`)).rows;
    for(const row of rows)await this.refresh(row.id,row.revision);
  }
}

export function startConnectionMaintenance(service:ConnectionMaintenance) {
  let stopped=false,active:Promise<void>|undefined;
  const run=()=> {if(stopped||active)return;active=service.tick().catch(()=>{console.error('Connection maintenance temporarily unavailable; credentials were not logged.');}).finally(()=>{active=undefined;});};
  const timer=setInterval(run,60000);timer.unref();run();
  return async()=>{stopped=true;clearInterval(timer);await active;};
}
