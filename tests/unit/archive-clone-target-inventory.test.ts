import { describe, expect, it, vi } from 'vitest';
import { verifyCloneTargetInventoryDelta } from '../../apps/api/src/archive-clone-target-inventory.js';

const live = [{item_id:789,item_status:'UNLIST',update_time:12}];
const sourceBody = {rawItem:{item_name:'Cloned item',item_sku:'',has_model:true},
  rawModels:{model:[{model_sku:'SKU-A'},{model_sku:'SKU-B'}]}};
const intent = () => ({id:'intent',state:'verified',target_item_id:'789',
  initial_qc:'verified',latest_recheck:null,ack_create:1,unresolved_steps:0,body:sourceBody});
const read = vi.fn(async(path:string) => ({requestId:path,
  response:path.endsWith('get_item_base_info')
    ? {item_list:[{item_id:789,item_status:'UNLIST',update_time:12,
      item_name:'Cloned item',item_sku:'',has_model:true}]}
    : {model:[{model_sku:'SKU-B'},{model_sku:'SKU-A'}]}}));
const run = (rows:any[], held:string[]=[]) => verifyCloneTargetInventoryDelta({
  pool:{query:vi.fn(async()=>({rows}))} as any,
  connectionId:'conn',partnerId:'partner',shopId:'shop',live,cached:[],
  reviewedHeldIntentIds:held,read,
});

describe('dynamic target inventory delta',()=>{
  it('hydrates only exact journal-verified clones using signed base/model reads',async()=>{
    read.mockClear();
    const result=await run([intent()]);
    expect(result.deltaItemIds).toEqual(['789']);
    expect(result.rows[0]).toEqual(expect.objectContaining({
      title:'Cloned item',model_skus:['SKU-B','SKU-A'],remote_updated_at:12}));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not read an unrecognized missing target item',async()=>{
    read.mockClear();
    await expect(run([])).rejects.toThrow('DELTA_INTENT_MISSING');
    expect(read).not.toHaveBeenCalled();
  });
  it('requires explicit review to include a held clone, and still checks its SKU',async()=>{
    const row={...intent(),state:'held',initial_qc:'mismatch'};
    read.mockClear();
    await expect(run([row])).rejects.toThrow('DELTA_INTENT_UNVERIFIED');
    expect(read).not.toHaveBeenCalled();
    expect((await run([row],['intent'])).deltaItemIds).toEqual(['789']);
  });
  it('rejects stale cached rows instead of hiding a changed target listing',async()=>{
    read.mockClear();
    await expect(verifyCloneTargetInventoryDelta({pool:{query:vi.fn()} as any,
      connectionId:'conn',partnerId:'partner',shopId:'shop',live,
      cached:[{item_id:'789',item_status:'UNLIST',remote_updated_at:11,
        item_sku:'',model_skus:[],title:'Cloned item'}],read}))
      .rejects.toThrow('CACHE_STALE');
    expect(read).not.toHaveBeenCalled();
  });
});
