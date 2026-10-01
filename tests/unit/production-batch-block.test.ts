import { expect,it } from 'vitest';
import { independentBatchHold } from '../../apps/api/src/production-batch-block.js';
import { runtimePoolConfig } from '../../packages/persistence/src/runtime-pool.js';

it('permits a source revision hold but never uncertain dispatch or a shared shop block',()=>{
  const base={state:'needs_review',listings:[{state:'not_sent',currentSource:'source_changed'}]};
  expect(independentBatchHold(base)).toBe(true);
  for(const extra of [{busy:true},{interrupted:true},{blockingWork:{blocksExecution:true}},
    {listings:[{state:'unknown'}]},{listings:[{state:'sent'}]},{listings:[{state:'rejected'}]},
    {listings:[]},{listings:[{state:'not_sent',currentSource:'current'}]}])
    expect(independentBatchHold({...base,...extra})).toBe(false);
});
it('allows isolated QC holds only after the journal has released the shop lane',()=>{
  const base={state:'ready',listings:[{state:'created_readback_pending'},{state:'created_unlisted'}]};
  expect(independentBatchHold(base)).toBe(true);
  expect(independentBatchHold({...base,blockingWork:{blocksExecution:true}})).toBe(false);
});
it('bounds DB connection admission and rejects disabled or invalid deadlines',()=>{
  expect(runtimePoolConfig({})).toMatchObject({connectionTimeoutMillis:5000,statement_timeout:120000});
  for(const timeout of ['0','-1','Infinity','abc','600001'])
    expect(()=>runtimePoolConfig({DB_STATEMENT_TIMEOUT_MS:timeout})).toThrow('DATABASE_TIMEOUT_CONFIGURATION_INVALID');
});
it('isolates a rejected local plan only when its matching source has no operation',()=>{
  const base={state:'ready',listings:[{sourceKey:'source-a',state:'not_sent',currentSource:'current'}],
    lastResult:{mode:'execute',listings:[{sourceKey:'source-a',state:'blocked',code:'PASS1_PLAN_BLOCKED'}]}};
  expect(independentBatchHold(base)).toBe(true);
  expect(independentBatchHold({...base,lastResult:{...base.lastResult,mode:'inspect'}})).toBe(false);
  expect(independentBatchHold({...base,listings:[{...base.listings[0]!,operationId:'reserved'}]})).toBe(false);
  expect(independentBatchHold({...base,lastResult:{mode:'execute',listings:[{sourceKey:'other',state:'blocked',code:'PASS1_PLAN_BLOCKED'}]}})).toBe(false);
  expect(independentBatchHold({...base,lastResult:{mode:'execute',listings:[{sourceKey:'source-a',state:'blocked',code:'CONNECTION_EXPIRED'}]}})).toBe(false);
});
it('does not hide a later shared failure behind an earlier local source hold',()=>{
  const base={state:'ready',listings:[{sourceKey:'a',state:'not_sent'},{sourceKey:'b',state:'not_sent'}],
    lastResult:{mode:'execute',listings:[{sourceKey:'a',state:'blocked',code:'PASS1_PLAN_BLOCKED'}]}};
  expect(independentBatchHold(base)).toBe(true);
  for(const code of ['PASS1_CONNECTION_REQUIRED','PRODUCTION_PILOT_AUTH_REQUIRED','PASS1_FAILED']) {
    expect(independentBatchHold({...base,lastResult:{...base.lastResult,listings:[...base.lastResult.listings,{sourceKey:'b',state:'blocked',code}]}})).toBe(false);
    expect(independentBatchHold({...base,lastResult:{...base.lastResult,code}})).toBe(false);
  }
  const local={sourceKey:'a',state:'blocked',code:'PRODUCTION_PILOT_MANDATORY_ATTRIBUTE_MISSING',failureScope:'source_preflight'};
  expect(independentBatchHold({...base,lastResult:{mode:'execute',listings:[local]}})).toBe(true);
  expect(independentBatchHold({...base,lastResult:{mode:'execute',listings:[{...local,failureScope:undefined}]}})).toBe(false);
  expect(independentBatchHold({...base,lastResult:{mode:'execute',listings:[{...local,code:'PRODUCTION_PILOT_PREFLIGHT_READ_FAILED_CATEGORY'}]}})).toBe(false);
});
