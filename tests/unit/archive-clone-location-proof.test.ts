import { describe,expect,it,vi } from 'vitest';
import { proveCloneLocationFromLiveItems } from '../../apps/api/src/archive-clone-location-proof.js';

const now=Date.parse('2026-09-30T12:00:00.000Z');
const connection={id:'connection-a',revision:3,partnerId:'partner-a',
  shopId:'shop-a',state:'connected' as const,expiresAt:new Date(now+3600000).toISOString()};
const targetList={observedAt:new Date(now-2000).toISOString(),requestIds:['list-a'],
  rows:[{item_id:'11',item_status:'NORMAL',update_time:100},
    {item_id:'22',item_status:'NORMAL',update_time:200},
    {item_id:'33',item_status:'UNLIST',update_time:300}]};
function fixture(){
  const read=vi.fn(async(path:string,query:Record<string,string>)=>{
    const id=query.item_id_list??query.item_id;
    if(path.endsWith('get_item_base_info'))return {requestId:'base-'+id,
      response:{item_list:[{item_id:id,item_status:'NORMAL',
        update_time:id==='11'?100:200,has_model:id==='22',
        stock_info_v2:{seller_stock:[{location_id:'VNZ',stock:10}]}}]}};
    if(path.endsWith('get_model_list'))return {requestId:'model-'+id,
      response:{model:[{model_sku:'S-'+id,stock_info_v2:{seller_stock:[{location_id:'VNZ',stock:10}]}}]}};
    throw Error('unexpected path');
  });
  return {connection:{...connection},targetList:structuredClone(targetList),locationId:'VNZ',read,
    readConnection:vi.fn(async()=>connection),now:()=>now};
}

describe('read-only target warehouse location proof',()=>{
  it('records two distinct live NORMAL items, signed GET receipts and exact scope',async()=>{
    const input=fixture();
    const proof=await proveCloneLocationFromLiveItems(input);
    expect(proof).toMatchObject({kind:'signed_existing_item_stock',
      partnerId:'partner-a',shopId:'shop-a',connectionId:'connection-a',
      connectionRevision:3,locationId:'VNZ',listRequestIds:['list-a']});
    expect(proof.items.map(row=>row.itemId)).toEqual(['11','22']);
    expect(proof.items.map(row=>row.baseRequestId)).toEqual(['base-11','base-22']);
    expect(proof.items[1]?.modelRequestId).toBe('model-22');
    expect(input.read).toHaveBeenCalledTimes(3);
  });
  it('holds on stale inventory and sends no read',async()=>{
    const input=fixture();
    input.targetList.observedAt=new Date(now-301000).toISOString();
    await expect(proveCloneLocationFromLiveItems(input)).rejects.toThrow('LOCATION_PROOF_LIST_STALE');
    expect(input.read).not.toHaveBeenCalled();
  });
  it('holds if the connection changes revision after signed reads',async()=>{
    const input=fixture();
    input.readConnection=vi.fn(async()=>({...connection,revision:4}));
    await expect(proveCloneLocationFromLiveItems(input)).rejects.toThrow('LOCATION_PROOF_CONNECTION_CHANGED');
  });
  it('holds when the signed item update time differs from the live list',async()=>{
    const input=fixture();
    const original=input.read;
    input.read=vi.fn(async(path,query)=>{
      const value=await original(path,query);
      if(path.endsWith('get_item_base_info') && query.item_id_list==='11')
        (value.response.item_list as any[])[0]!.update_time=999;
      return value;
    });
    await expect(proveCloneLocationFromLiveItems(input)).rejects.toThrow('LOCATION_PROOF_ITEM_DRIFT');
  });
  it('requires two evidenced locations and never infers from one listing',async()=>{
    const input=fixture();
    input.targetList.rows=input.targetList.rows.slice(0,1);
    await expect(proveCloneLocationFromLiveItems(input)).rejects.toThrow('LOCATION_PROOF_CANDIDATES_MISSING');
  });
  it('rejects candidate IDs from another shop inventory',async()=>{
    const input=fixture();
    await expect(proveCloneLocationFromLiveItems({...input,candidateItemIds:['11','99']}))
      .rejects.toThrow('LOCATION_PROOF_CANDIDATES_MISSING');
  });
});
