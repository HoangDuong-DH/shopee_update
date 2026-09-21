import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { Pool, Repository, migrate, listShopConnections } from '@shopee/persistence';
import { SecretBox } from '@shopee/gateway';
import { ConnectionMaintenance } from '../../apps/api/src/connection-maintenance.js';
import { prepareProductionAuthorization,finishProductionAuthorization,cancelProductionAuthorization } from '../../apps/api/src/production-authorization-service.js';
const schema='test_connection_lifecycle_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:process.env.DATABASE_URL});
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema},public`});
const repo=new Repository(pool),key='e3'.repeat(32),box=new SecretBox(key);
const scope='production:2010476:998877';
let id:string,receiptRoot:string;
const response=(body:unknown)=>new Response(JSON.stringify(body));
const shop=()=>response({error:'',shop_name:'Second shop',region:'VN',status:'NORMAL'});
const fetcher=()=>vi.fn(async(url:RequestInfo|URL)=>String(url).includes('/auth/access_token/get')?response({error:'',partner_id:2010476,shop_id:998877,access_token:'rotated-access',refresh_token:'rotated-refresh',expire_in:14400}):shop());
beforeAll(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
beforeEach(async()=>{
 await pool.query('TRUNCATE connections CASCADE');id=randomUUID();receiptRoot=await mkdtemp(resolve('.local/connection-lifecycle-'));
 await pool.query(`INSERT INTO connections(id,environment,partner_id,shop_id,name,state,token_ciphertext,partner_key_ciphertext,expires_at,auto_refresh)
 VALUES($1,'production','2010476','998877','Second shop','connected',$2,$3,now()-interval '1 minute',true)`,[id,box.seal({accessToken:'old-access',refreshToken:'old-refresh'},scope),box.seal({partnerKey:'private-fixture-key'},scope)]);
});
afterAll(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
it('does not advertise an expired persisted connected row as connected',async()=>{
 expect((await listShopConnections(pool))[0]?.state).toBe('token_expired');
});
it('cancels only the matching browser pending attempt and never consumes its code afterwards',async()=>{
 const options={encryptionKey:key,allowOtherShops:true};
 const attempt=await prepareProductionAuthorization(repo,{partnerId:'2010476',shopId:'332211',partnerKey:'fixture-key',expectedRevision:0},options);
 await expect(cancelProductionAuthorization(repo,attempt.attemptId,'b'.repeat(64))).rejects.toThrow('NOT_FOUND');
 expect((await cancelProductionAuthorization(repo,attempt.attemptId,attempt.browserSecret)).status).toBe('expired');
 const transport=vi.fn();
 await expect(finishProductionAuthorization(repo,{state:new URL(attempt.authorizationUrl).searchParams.get('state'),shop_id:'332211',code:'fixture-code'},attempt.browserSecret,{...options,transport})).rejects.toThrow('EXPIRED');
 expect(transport).not.toHaveBeenCalled();
});
it('makes a revoked shop unavailable to both the public view and backend writers',async()=>{
 const service=new ConnectionMaintenance(repo,{encryptionKey:key,receiptRoot,transport:async()=>response({error:'shop_no_linked'})});
 expect((await service.check(id,1)).kind).toBe('rejected');
 expect((await pool.query('SELECT state FROM connections WHERE id=$1',[id])).rows[0].state).toBe('reauth_required');
 expect((await listShopConnections(pool))[0]?.state).toBe('reauth_required');
});
it('refreshes another shop only within its own scope and deduplicates concurrent maintenance',async()=>{
 const transport=fetcher(),service=new ConnectionMaintenance(repo,{encryptionKey:key,receiptRoot,transport});
 await Promise.all([service.refresh(id,1),service.refresh(id,1)]);
 expect(transport.mock.calls.filter(([url])=>String(url).includes('/auth/access_token/get'))).toHaveLength(1);
 const row=(await pool.query('SELECT * FROM connections WHERE id=$1',[id])).rows[0];
 expect(row.revision).toBe(2);expect(row.refresh_status).toBe('healthy');
 expect(box.open(row.token_ciphertext,scope)).toEqual({accessToken:'rotated-access',refreshToken:'rotated-refresh'});
 expect((await listShopConnections(pool))[0]?.state).toBe('connected');
 await service.tick();expect(transport).toHaveBeenCalledTimes(2);
});
it('does not replay a refresh after network outcome is unknown, even on scheduler restart',async()=>{
 const transport=vi.fn(async()=>{throw Error('DO_NOT_LOG_TOKEN');});
 await new ConnectionMaintenance(repo,{encryptionKey:key,receiptRoot,transport}).tick();
 const next=new ConnectionMaintenance(repo,{encryptionKey:key,receiptRoot,transport});
 await next.tick();await next.refresh(id,1);
 expect(transport).toHaveBeenCalledTimes(1);
 expect((await listShopConnections(pool))[0]?.state).toBe('refresh_unknown');
});
it('recovers sealed rotated credentials after a failed GET without rotating twice',async()=>{
 const transport=fetcher();let reads=0;
 const limited=vi.fn(async(url:RequestInfo|URL)=>String(url).includes('/shop/get_shop_info') && ++reads===1 ? response({error:'error_server'}):transport(url));
 const service=new ConnectionMaintenance(repo,{encryptionKey:key,receiptRoot,transport:limited});
 await service.refresh(id,1);await service.refresh(id,1);
 expect(limited.mock.calls.filter(([url])=>String(url).includes('/auth/access_token/get'))).toHaveLength(1);
 expect((await listShopConnections(pool))[0]?.scope.connectionRevision).toBe(2);
});
it('keeps independent shop authorizations pending and verifies callback scope before exchange',async()=>{
 const input={partnerId:'2010476',shopId:'112233',partnerKey:'fixture-partner-key',expectedRevision:0};
 const options={encryptionKey:key,allowOtherShops:true};
 const a=await prepareProductionAuthorization(repo,input,options);
 await prepareProductionAuthorization(repo,{...input,shopId:'445566'},options);
 expect((await pool.query("SELECT count(*) FROM production_authorization_attempts WHERE status='pending'")).rows[0].count).toBe('2');
 const q={state:new URL(a.authorizationUrl).searchParams.get('state'),shop_id:'112233',code:'fixture-code'};
 const transport=vi.fn(async(url:RequestInfo|URL)=>String(url).includes('/auth/token/get')?response({error:'',access_token:'new-access-token',refresh_token:'new-refresh-token',expire_in:14400,shop_id_list:[112233]}):shop());
 await expect(finishProductionAuthorization(repo,{...q,shop_id:'445566'},a.browserSecret,{...options,transport})).rejects.toThrow('WRONG_SHOP');
 expect(transport).not.toHaveBeenCalled();
 expect((await finishProductionAuthorization(repo,q,a.browserSecret,{...options,transport})).status).toBe('verified');
 expect((await pool.query("SELECT shop_id FROM connections WHERE shop_id='112233'")).rowCount).toBe(1);
});
it('reuses only the same app key and enrolls only the requested shop from a multi-shop main-account grant',async()=>{
 const options={encryptionKey:key,allowOtherShops:true};
 const attempt=await prepareProductionAuthorization(repo,{partnerId:'2010476',shopId:'1126307464',expectedRevision:0},options);
 const transport=vi.fn(async(url:RequestInfo|URL)=>String(url).includes('/auth/token/get')?response({error:'',access_token:'main-access-token',refresh_token:'main-refresh-token',expire_in:14400,shop_id_list:[998877,1126307464,556677]}):shop());
 const result=await finishProductionAuthorization(repo,{state:new URL(attempt.authorizationUrl).searchParams.get('state'),main_account_id:'123456',code:'fixture-code'},attempt.browserSecret,{...options,transport});
 expect(result.status).toBe('verified');
 expect((await pool.query('SELECT shop_id FROM connections ORDER BY shop_id')).rows.map(r=>r.shop_id)).toEqual(['1126307464','998877']);
 await expect(prepareProductionAuthorization(repo,{partnerId:'123123',shopId:'1126307464',expectedRevision:0},options)).rejects.toThrow('KEY_REQUIRED');
});
