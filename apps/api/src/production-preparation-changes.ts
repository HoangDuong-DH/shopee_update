import { canonicalJson } from '@shopee/domain';

const object=(value:unknown):value is Record<string,any> => !!value && typeof value==='object' && !Array.isArray(value);
const value=(fact:any)=>object(fact) && Object.hasOwn(fact,'value') ? fact.value : fact;
const facts=(input:any)=>Object.fromEntries(Object.entries(object(input)?input:{}).filter(([key])=>!key.startsWith('__') && key!=='localBulkEdit').map(([key,fact])=>[key,value(fact)]));
const labels:Record<string,string>={title:'Tiêu đề',headline:'Câu mở đầu',description:'Nội dung mô tả',cover:'Ảnh bìa',gallery:'Ảnh sản phẩm',descriptionImages:'Ảnh mô tả',tierNames:'Tên tầng phân loại',variants:'SKU và phân loại',prices:'Giá và nguồn giá',variantImages:'Ảnh phân loại',category:'Ngành hàng',brand:'Thương hiệu',attributes:'Thuộc tính',logistics:'Vận chuyển'};

/** Compare business values, never audit timestamps, decision receipts or issue messages. */
function projection(raw:unknown):Record<string,unknown> {
  if(!object(raw))return {};
  const draft=raw, selection=object(draft.sourceSelection)?draft.sourceSelection:{};
  const result:Record<string,unknown>={};
  if(Object.hasOwn(draft,'title'))result.title=selection.title ?? value(draft.title);
  if(Object.hasOwn(selection,'headline'))result.headline=selection.headline;
  if(Object.hasOwn(draft,'description'))result.description=selection.body ?? draft.description;
  if(Object.hasOwn(draft,'coverKey'))result.cover=draft.coverKey;
  if(Object.hasOwn(draft,'galleryKeys'))result.gallery=draft.galleryKeys;
  if(Object.hasOwn(draft,'description'))result.descriptionImages=selection.descriptionImageIds ?? draft.description.filter((block:any)=>block.type==='image');
  if(Object.hasOwn(draft,'tierNames'))result.tierNames=draft.tierNames;
  if(Array.isArray(draft.variants)) {
    result.variants=draft.variants.map((variant:any)=>({sku:value(variant.sku),optionLabels:variant.optionLabels}));
    result.prices=draft.variants.map((variant:any,index:number)=>({sku:value(variant.sku),price:value(variant.originalPrice),promotionTarget:value(variant.promotionTarget) ?? null,
      source:selection.variants?.[index]?{importId:selection.variants[index].importId,rowKey:selection.variants[index].rowKey}:null}));
    result.variantImages=draft.variants.map((variant:any)=>({sku:value(variant.sku),imageKey:variant.imageKey ?? null}));
  }
  for(const [field,key] of [['category','categoryId'],['brand','brandId']] as const) {
    if(Object.hasOwn(draft,'title'))result[field]=value(draft[key]) ?? null;
  }
  for(const field of ['attributes','logistics'] as const)if(Object.hasOwn(draft,field))result[field]=facts(draft[field]);
  return result;
}
export type PreparationFieldChange={field:string;label:string;before:unknown;after:unknown};
export function preparationFieldChanges(before:unknown,after:unknown):PreparationFieldChange[] {
  // A missing historical source is unknown, not an empty product. Do not invent a diff.
  if(!object(before)||!object(after))return [];
  const old=projection(before),next=projection(after);
  return Object.keys(labels).filter(field=>(Object.hasOwn(old,field)||Object.hasOwn(next,field)) && canonicalJson(old[field] ?? null)!==canonicalJson(next[field] ?? null))
    .map(field=>({field,label:labels[field]!,before:old[field] ?? null,after:next[field] ?? null}));
}

export type PreparationSourceChange={productKey:string;title:string;sourceRevision:number;currentRevision:number|null;
  state:'current'|'changed'|'missing'|'archived';changedFields:string[];changes:PreparationFieldChange[]};
