import { expect,it } from 'vitest';
import { decodeProductionPilotInventoryPage } from '../../apps/api/src/production-pilot-source.js';

it('accepts the actual empty NORMAL response without inventing absent nonempty inventory',()=>{
  expect(decodeProductionPilotInventoryPage({total_count:0,has_next_page:false,next:''},'NORMAL',0).ids).toEqual([]);
  expect(()=>decodeProductionPilotInventoryPage({total_count:2,has_next_page:false,next:''},'NORMAL',0)).toThrow('INVENTORY_RESPONSE_INVALID');
});
it.each([
  {total_count:0,has_next_page:false,item:null},
  {has_next_page:false,item:[]},
  {total_count:1,has_next_page:true,item:[],next_offset:1},
  {total_count:1,has_next_page:true,item:[{item_id:2,item_status:'UNLIST'}],next_offset:0},
  {total_count:1,has_next_page:true,item:[{item_id:2,item_status:'UNLIST'}],next:'opaque-cursor'},
])('blocks incomplete or invalid inventory %#',(page)=>{
  expect(()=>decodeProductionPilotInventoryPage(page,'UNLIST',0)).toThrow();
});
it('uses documented next_offset and keeps exact item identity/status',()=>{
  expect(decodeProductionPilotInventoryPage({total_count:2,has_next_page:true,next_offset:1,item:[{item_id:42476682098,item_status:'UNLIST'}]},'UNLIST',0))
    .toEqual({ids:['42476682098'],complete:false,nextOffset:1});
  expect(()=>decodeProductionPilotInventoryPage({total_count:1,has_next_page:false,item:[{item_id:2,item_status:'NORMAL'}]},'UNLIST',0)).toThrow('INVENTORY_STATUS_CHANGED');
});
it('never treats a truncated final page as a complete duplicate scan',()=>{
  expect(()=>decodeProductionPilotInventoryPage({total_count:53,has_next_page:false,item:[{item_id:42476682098,item_status:'UNLIST'}]},'UNLIST',0)).toThrow('INVENTORY_INCOMPLETE');
});
