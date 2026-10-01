import { randomUUID } from 'node:crypto';
import { expect,it,vi } from 'vitest';
import { preparationFieldChanges } from '../../apps/api/src/production-preparation-changes.js';
import { ProductionPreparationService } from '../../apps/api/src/production-preparation-service.js';
import { withProductionScope } from '../../apps/api/src/production-scope.js';

const draft=()=>({productKey:'source',revision:1,title:{value:'Tinh dầu'},description:[{type:'text',text:'Dòng 1\n\nDòng 2'}],
  coverKey:'cover',galleryKeys:['g2','g3'],tierNames:['Dung tích'],variants:[{sku:{value:'REAL-SKU'},originalPrice:{value:'125000'},optionLabels:['500ml'],imageKey:'variant'}],
  attributes:{origin:{value:'VN'}},logistics:{fast:{value:true}}});
it('compares actual content, ordered images, SKU and price values while excluding receipts and fact provenance',()=>{
  const before=draft(),after:any=structuredClone(before);
  after.revision=2;after.title.source={observedAt:'later'};after.localBulkEdit={operationId:randomUUID()};after.issues=[{message:'new warning'}];
  expect(preparationFieldChanges(before,after)).toEqual([]);
  after.title.value='Tinh dầu mới';after.description[0].text='Dòng 2\n\nDòng 1';after.galleryKeys.reverse();
  after.variants[0].sku.value='REAL-SKU-2';after.variants[0].originalPrice.value='150000';
  const result=preparationFieldChanges(before,after);
  expect(result.map(change=>change.field)).toEqual(['title','description','gallery','variants','prices','variantImages']);
  expect(result.find(change=>change.field==='prices')?.before).toEqual([{sku:'REAL-SKU',price:'125000',promotionTarget:null,source:null}]);
  expect(before.galleryKeys).toEqual(['g2','g3']);
  expect(preparationFieldChanges(null,after)).toEqual([]);
});
it('returns scoped read-only snapshot comparisons, historical fallback and missing/archived states',async()=>{
  const id=randomUUID(),before=draft(),changed={...structuredClone(before),revision:2,title:{value:'Tên mới'}};
  const entries=[{productKey:'source',title:'Tinh dầu',sourceRevision:1,sourceSnapshot:{draft:before}},
    {productKey:'blocked',title:'Bộ chưa đủ',sourceRevision:1,kind:'blocked'},
    {productKey:'missing',title:'Bộ thiếu nguồn',sourceRevision:1},
    {productKey:'archived',title:'Bộ lưu trữ',sourceRevision:1}];
  const scope={environment:'production' as const,partnerId:'2010476',shopId:'1423724897'},body={scope,entries};
  const original=JSON.stringify(body);
  const query=vi.fn(async(sql:string,args:any[]=[])=>{
    if(sql.startsWith('SELECT * FROM production_source_preparations'))return {rows:[{body}]};
    if(sql.includes('FROM local_resource_archives a') && args[0].includes('archived'))return {rows:[{}],rowCount:1};
    if(!sql.startsWith('SELECT'))throw Error('Mutation forbidden');
    return {rows:[],rowCount:0};
  });
  const getProduct=vi.fn(async(key:string,revision?:number)=>key==='missing'?null:revision===1?{...before,productKey:key}:key==='source'?changed:{...before,productKey:key});
  const service=new ProductionPreparationService({pool:{query},getProduct} as any,{} as any);
  const result=await service.sourceChanges(id);
  expect(result).toMatchObject({preparationId:id,scope,entries:[
    {state:'changed',sourceRevision:1,currentRevision:2,changedFields:['title']},
    {state:'current',sourceRevision:1,currentRevision:1,changes:[]},
    {state:'missing',currentRevision:null,changes:[]},
    {state:'archived',currentRevision:1,changes:[]},
  ]});
  expect(getProduct).toHaveBeenCalledWith('blocked',1);
  expect(getProduct).not.toHaveBeenCalledWith('source',1);
  expect(JSON.stringify(body)).toBe(original);
  await expect(withProductionScope({...scope,shopId:'1126307464'},()=>service.sourceChanges(id))).rejects.toThrow('PRODUCTION_BATCH_SCOPE_MISMATCH');
});
