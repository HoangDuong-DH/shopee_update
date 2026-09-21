import { expect, it } from 'vitest';
import { eligibleProductChannels, productChannelIssue, type ProductLogisticsChannel } from '@shopee/domain';
const root: ProductLogisticsChannel = {id:'1',name:'Nhanh',parentId:'0',enabled:true,forceEnabled:false,compulsory:false,
  feeType:'SIZE_INPUT',relationsKnown:true,relatedEnabledChannelIds:[],dependentBlockChannelIds:[],
  weightKg:{min:0,max:10},maxDimension:{height:60,width:60,length:60,sum:0,unit:'cm'},volume:{min:0,max:0}};
const dimensions={length:12,width:12,height:28};
it('selects checkout groups only and excludes disabled or undersized lockers',()=>{
  const channels=[root,{...root,id:'2',parentId:'1'}, {...root,id:'3',enabled:false},
    {...root,id:'4',maxDimension:{...root.maxDimension,height:8}}];
  expect(eligibleProductChannels(channels,503.8,dimensions).selected.map(c=>c.id)).toEqual(['1']);
});
it('compulsory means at least one; dependent-block is a disabling rule',()=>{
  const a={...root,compulsory:true,dependentBlockChannelIds:['2']};
  const b={...root,id:'2',compulsory:true};
  expect(eligibleProductChannels([a,b],503.8,dimensions).selected).toHaveLength(2);
  expect(eligibleProductChannels([a,b],503.8,dimensions,new Set(['1'])).requiredMissing).toBe(false);
  expect(eligibleProductChannels([a,{...b,forceEnabled:true}],503.8,dimensions,new Set(['1'])).requiredMissing).toBe(true);
});
it('does not guess volume units or select a channel missing a required dependency',()=>{
  expect(productChannelIssue({...root,volume:{min:0,max:6000}},503.8,dimensions)).toContain('thể tích');
  expect(eligibleProductChannels([{...root,relatedEnabledChannelIds:['2']}],503.8,dimensions).selected).toEqual([]);
  expect(eligibleProductChannels([{...root,relatedDisabledChannelIds:['2']},{...root,id:'2'}],503.8,dimensions).selected).toEqual([]);
});
