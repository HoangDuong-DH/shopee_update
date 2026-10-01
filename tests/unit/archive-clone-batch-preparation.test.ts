import { describe, expect, it, vi } from 'vitest';
import { ArchiveCloneBatchPreparer, deriveSourceCategoryPath } from '../../apps/api/src/archive-clone-batch-preparation.js';

const sha='a'.repeat(64);
const rawItem={item_id:1,item_name:'FAMONY Laundry',item_sku:'SKU-1',has_model:false,
  brand:{original_brand_name:'FAMONY'},attribute_list:[],
  logistic_info:[{logistic_id:1,enabled:true}]};
const candidate={manifest:{archiveId:'archive',sourceShopId:'source',items:[{
  sourceItemId:'1',observationHash:sha,title:'FAMONY Laundry',sourceItemSku:'SKU-1',
  categoryId:101814,brandId:5000616,rawItem,rawModels:null,
  modelProjection:[],tierProjection:[],parentStockInfoV2:{seller_stock:[{location_id:'VNZ',stock:10}]},
  media:[{role:'cover',ordinal:0,sha256:sha}]}]},
  sourceItemId:'1',targetShopId:'966101536',targetPartnerId:'2010476'} as any;
const metadata=()=>({scope:{shopId:'966101536'},connectionRevision:2,
  observedAt:new Date().toISOString(),shop:{status:'NORMAL'},
  categories:{complete:true,rows:[{id:'101814',path:['Home','Laundry'],leaf:true}]},
  selected:[{categoryId:'101814',path:['Home','Laundry'],brands:{complete:true,rows:[{id:'5000616',name:'FAMONY'}]},attributeTree:[]}],
  channels:{rows:[{logistics_channel_id:1,enabled:true,compulsory_channel:false,
    channel_relation_rules:{related_enabled_channels:[],related_disabled_channels:[]}}]},
  warehouse:{status:'available',rows:[{location_id:'VNZ',holiday_mode_state:0}]},evidence:[{requestId:'metadata'}]}) as any;
const deps=()=>({pool:{query:vi.fn(async(sql:string,params?:any[])=>({rows:sql.includes('shop_listing_media_refs')
  ? [{role:'cover',ordinal:0,blob_sha256:sha,storage_path:'C:/archive/cover.jpg'}]:[]}))},
  readConnection:vi.fn(async()=>({id:'conn',revision:2,state:'connected',
    expiresAt:new Date(Date.now()+3600_000).toISOString(),
    credentials:{environment:'production',shopId:'966101536',partnerId:'2010476'}})),
  readCurrentSource:vi.fn(async()=>({shopId:'source',itemId:'1',observedAt:new Date().toISOString(),
    requestIds:['a','b'],rawItem,rawModels:null})),
  readTargetList:vi.fn(async()=>({rows:[],statuses:['NORMAL','UNLIST','BANNED','REVIEWING'],
    requestIds:['list'],observedAt:new Date().toISOString()})),
  readTarget:vi.fn(),sourceCategoryPath:vi.fn(async()=>['Home','Laundry']),
  collectMetadata:vi.fn(async()=>metadata())});

describe('batch preparation',()=>{
  it('uses source comparison, full target assessment and stored media refs before upload',async()=>{
    const d=deps();
    const result=await new ArchiveCloneBatchPreparer(d as any).prepare(candidate);
    expect(result.kind).toBe('ready');
    if(result.kind==='ready'){
      expect(result.media.assets).toEqual([{role:'cover',ordinal:0,sha256:sha,blobPath:'C:/archive/cover.jpg'}]);
      expect(result.media.cloneScope.targetShopId).toBe('966101536');
      expect(result.locationId).toBe('VNZ');
    }
    expect(d.pool.query.mock.calls.some(([sql,params])=>sql.includes("r.state=$3")&&params?.length===3&&params?.[2]==="stored")).toBe(true);
  });
  it('accepts a not-whitelisted warehouse only with current scoped two-item proof',async()=>{
    const d:any=deps();
    const list={rows:[
      {item_id:'21',item_status:'NORMAL',update_time:100},
      {item_id:'22',item_status:'NORMAL',update_time:200}],
      statuses:['NORMAL','UNLIST','BANNED','REVIEWING'],
      requestIds:['list-1'],observedAt:new Date().toISOString()};
    d.readTargetList=vi.fn(async()=>list);
    d.pool.query=vi.fn(async(sql:string)=>({rows:sql.includes('shop_listing_media_refs')
      ? [{role:'cover',ordinal:0,blob_sha256:sha,storage_path:'C:/archive/cover.jpg'}]
      : sql.includes('seller_knowledge_items')
        ? [{item_id:'21',item_status:'NORMAL',item_sku:'OTHER-21',model_skus:[],
            remote_updated_at:100,title:'Other 21'},
           {item_id:'22',item_status:'NORMAL',item_sku:'OTHER-22',model_skus:[],
            remote_updated_at:200,title:'Other 22'}] : []}));
    d.collectMetadata=vi.fn(async()=>({...metadata(),warehouse:{status:'not_whitelisted'}}));
    const proof={kind:'signed_existing_item_stock',partnerId:'2010476',shopId:'966101536',
      connectionId:'conn',connectionRevision:2,locationId:'VNZ',
      listObservedAt:list.observedAt,listRequestIds:['list-1'],checkedAt:new Date().toISOString(),
      items:[{itemId:'21',status:'NORMAL',updateTime:'100',baseRequestId:'base-21',
        modelRequestId:null,locationIds:['VNZ']},
        {itemId:'22',status:'NORMAL',updateTime:'200',baseRequestId:'base-22',
        modelRequestId:'model-22',locationIds:['VNZ']}]} as any;
    const valid=await new ArchiveCloneBatchPreparer({...d,locationProof:async()=>proof} as any).prepare(candidate);
    expect(valid.kind).toBe('ready');
    if(valid.kind==='ready'){
      expect(valid.locationId).toBe('VNZ');
      expect(valid.locationEvidence).toEqual(proof);
      expect(valid.targetRequestIds).toEqual(expect.arrayContaining(['base-21','base-22','model-22']));
    }
    const wrong=await new ArchiveCloneBatchPreparer({...d,
      locationProof:async()=>({...proof,shopId:'another-shop'})} as any).prepare(candidate);
    expect(wrong).toMatchObject({kind:'held',reasons:['TARGET_LOCATION_PROOF_INVALID']});
  });  it('blocks missing media storage without issuing a write',async()=>{
    const d=deps();d.pool.query=vi.fn(async()=>({rows:[]}));
    const result=await new ArchiveCloneBatchPreparer(d as any).prepare(candidate);
    expect(result.kind).toBe('held');
    if(result.kind==='held') expect(result.reasons).toContain('SOURCE_MEDIA_STORAGE_MISSING');
  });
});

describe('source category path evidence',()=>{
  it('derives path only from the source category parent chain',()=>{
    const tree={category_list:[
      {category_id:101, parent_category_id:0, display_category_name:'Home'},
      {category_id:202, parent_category_id:101, display_category_name:'Laundry'},
    ]};
    expect(deriveSourceCategoryPath(tree,'202')).toEqual(['Home','Laundry']);
    expect(()=>deriveSourceCategoryPath(tree,'999')).toThrow('PATH_MISSING');
  });
});
