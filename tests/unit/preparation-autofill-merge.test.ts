import {describe,it,expect} from 'vitest';
import {mergeMissingChoices,autofillResultSchema} from '../../apps/web/src/preparation-autofill.js';

describe('bulk operational autofill merge',()=>{
  it('fills gaps without overwriting explicit stock, condition, dimensions or carrier decisions',()=>{
    const current={condition:'USED',dimensionCm:{length:5,width:6,height:7},logistics:[],weightGrams:503.8};
    const merged=mergeMissingChoices(current,{condition:'NEW',dimensionCm:{length:12,width:12,height:28},weightGrams:999,categoryId:'42',preOrder:{is_pre_order:false},logistics:[{channelId:'50',enabled:true}]});
    expect(merged).toEqual({...current,categoryId:'42',preOrder:{is_pre_order:false}});
    expect(current).not.toHaveProperty('categoryId');
  });
  it('adds missing attributes only for the same category and brand, retaining existing attribute values',()=>{
    const first={attribute_id:1,attribute_value_list:[{value_id:10}]};
    const second={attribute_id:2,attribute_value_list:[{value_id:20}]};
    const current={categoryId:'42',brandId:'7',attributeList:[first]};
    expect(mergeMissingChoices(current,{categoryId:'42',brandId:'7',attributeList:[{...first,attribute_value_list:[{value_id:999}]},second]}).attributeList).toEqual([first,second]);
    expect(mergeMissingChoices(current,{categoryId:'43',brandId:'7',attributeList:[second]}).attributeList).toEqual([first]);
    expect(mergeMissingChoices(current,{categoryId:'42',brandId:'8',attributeList:[second]}).attributeList).toEqual([first]);
  });
  it('rejects malformed write mappings and unknown operational fields at the response boundary',()=>{
    const response={scope:{shopId:'1',partnerId:'2'},observedAt:new Date().toISOString(),connectionRevision:1,fingerprint:'a'.repeat(64),entries:[{productKey:'a',sourceRevision:1,choices:{stockLocation:{referenceItemId:'1',expectedLocationBySku:{SKU:'VNZ'},writeLocationBySku:{SKU:123}}},explanations:[],unresolved:[],issues:[]}]};
    expect(autofillResultSchema.safeParse(response).success).toBe(false);
    response.entries[0]!.choices={publish:true} as any;
    expect(autofillResultSchema.safeParse(response).success).toBe(false);
  });
});
