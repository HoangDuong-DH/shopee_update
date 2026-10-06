import { afterAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { once } from 'node:events';
import { createRuntimePool } from '../../packages/persistence/src/runtime-pool.js';
import { transaction } from '../../packages/persistence/src/db.js';
const db=new URL(process.env.DATABASE_URL ?? 'http://invalid');
if(db.hostname!=='127.0.0.1'||db.port!=='5443'||db.pathname!=='/shopee_internal_test')throw Error('ISOLATED_DATABASE_REQUIRED');
const admin=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:1000});
afterAll(async()=>{await admin.end();vi.restoreAllMocks();});
it('survives losing an owned idle backend and reconnects for the next read',async()=>{
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});const pool=createRuntimePool(process.env);
 try{
  const pid=(await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const lost=once(pool,'error');
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=$2',[pid,'shopee_internal_test']);
  await lost;
  expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
  expect(log).toHaveBeenCalledOnce();
 }finally{await pool.end();log.mockRestore();}
});
it('cancels slow SQL, discards the failed transaction connection and keeps original code',async()=>{
 const pool=createRuntimePool({...process.env,DB_STATEMENT_TIMEOUT_MS:'1000'});
 try{
  await expect(transaction(pool,client=>client.query('SELECT pg_sleep(3)'))).rejects.toMatchObject({code:'57014'});
  expect(pool.totalCount).toBe(0);
  expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
 }finally{await pool.end();}
});
it('bounds waiting for a saturated pool without replaying work or retaining its wait queue',async()=>{
 const pool=createRuntimePool({...process.env,DB_CONNECTION_TIMEOUT_MS:'1000'});pool.options.max=2;
 const holders=await Promise.all([pool.connect(),pool.connect()]);
 try{
  const started=performance.now();await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
  expect(performance.now()-started).toBeLessThan(1800);expect(pool.waitingCount).toBe(0);
 }finally{holders.forEach(client=>client.release());await pool.end();}
});
