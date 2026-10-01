import type { Pool } from 'pg';
import type { ShopCredentials } from '../../../packages/shopee/src/shop-info.js';
import { compareCurrentArchiveSource, type CurrentArchiveSource } from './archive-clone-current-source.js';
import { assessArchiveTargetPreflight } from './archive-target-preflight.js';
import { verifyCloneTargetInventoryDelta } from './archive-clone-target-inventory.js';
import type { ArchiveTargetMetadata } from './archive-target-metadata.js';
import type { ArchiveCloneBatchCandidate, ArchiveCloneMediaJob } from './archive-clone-batch.js';
import { assertCloneLocationProof, type CloneLocationProof } from './archive-clone-location-proof.js';

/** Resolve a source category path from a signed source-shop get_category response. */
export function deriveSourceCategoryPath(response: unknown, categoryId: string): string[] {
  const rows=(response as any)?.category_list;
  if(!Array.isArray(rows)||rows.length>30_000)throw Error('SOURCE_CATEGORY_TREE_INVALID');
  const byId=new Map<string,any>();
  for(const row of rows){
    const id=String(row?.category_id??'');
    if(!/^[1-9][0-9]*$/.test(id)||byId.has(id))throw Error('SOURCE_CATEGORY_TREE_INVALID');
    byId.set(id,row);
  }
  const parts:string[]=[];
  let id=categoryId;
  const visited=new Set<string>();
  while(id!=='0'){
    if(visited.has(id)||visited.size>20)throw Error('SOURCE_CATEGORY_PATH_CYCLE');
    visited.add(id);
    const row=byId.get(id);
    const name=row?.display_category_name||row?.original_category_name;
    if(!row||typeof name!=='string'||!name.trim())throw Error('SOURCE_CATEGORY_PATH_MISSING');
    parts.push(name.trim());
    id=String(row.parent_category_id??'');
    if(!/^(0|[1-9][0-9]*)$/.test(id))throw Error('SOURCE_CATEGORY_PARENT_INVALID');
  }
  if(!parts.length)throw Error('SOURCE_CATEGORY_PATH_MISSING');
  return parts.reverse();
}
type TargetList = {rows:any[];observedAt:string;requestIds:string[];statuses:string[]};
type Connection = {id:string;revision:number;state:'connected'|'disconnected';
  expiresAt:string;credentials:ShopCredentials};
type ReadResult = {response:any;requestId:string};
export type ArchiveCloneBatchPreparationDependencies = {
  pool: Pick<Pool,'query'>;
  readConnection: (candidate:ArchiveCloneBatchCandidate)=>Promise<Connection>;
  readCurrentSource: (candidate:ArchiveCloneBatchCandidate)=>Promise<CurrentArchiveSource>;
  readTargetList: (candidate:ArchiveCloneBatchCandidate)=>Promise<TargetList>;
  readTarget: (candidate:ArchiveCloneBatchCandidate,path:string,query:Record<string,string>)=>Promise<ReadResult>;
  /** Must use the source category path, never infer it from a numeric ID. */
  sourceCategoryPath: (candidate:ArchiveCloneBatchCandidate)=>Promise<string[]>;
  collectMetadata: (candidate:ArchiveCloneBatchCandidate,path:string[])=>Promise<ArchiveTargetMetadata>;
  /** Warehouse endpoint may be unavailable. Supply independently verified live SKU location. */
  locationProof?: (candidate:ArchiveCloneBatchCandidate,metadata:ArchiveTargetMetadata,context:{
    connectionId:string;connectionRevision:number;targetList:TargetList;
    expectedLocationId:string})=>Promise<CloneLocationProof|undefined>;
  reviewedHeldIntentIds?: readonly string[];
  now?:()=>number;
};
export type ArchiveCloneBatchPrepared =
  {kind:'ready';media:ArchiveCloneMediaJob;metadata:ArchiveTargetMetadata;locationId:string;
    inventoryRequestIds:string[];sourceRequestIds:string[];targetRequestIds:string[];
    locationEvidence?:CloneLocationProof} |
  {kind:'held';reasons:string[];classification:'source'|'systemic'};

/** Fresh, source-backed preflight before any image upload. Metadata is cached only
 * for the same shop, connection revision, category path and brand for 10 minutes. */
export class ArchiveCloneBatchPreparer {
  private readonly cache=new Map<string,ArchiveTargetMetadata>();
  constructor(private readonly deps:ArchiveCloneBatchPreparationDependencies) {}
  async prepare(candidate:ArchiveCloneBatchCandidate):Promise<ArchiveCloneBatchPrepared>{
    const now=this.deps.now?.()??Date.now();
    const item=candidate.manifest.items.find(row=>row.sourceItemId===candidate.sourceItemId);
    if(!item || item.media.some(asset=>asset.role==='video') ||
       candidate.manifest.sourceShopId===candidate.targetShopId)
      return {kind:'held',reasons:['SOURCE_OR_VIDEO_INVALID'],classification:'source'};
    const connection=await this.deps.readConnection(candidate);
    if(connection.state!=='connected'||connection.credentials.shopId!==candidate.targetShopId||
       connection.credentials.partnerId!==candidate.targetPartnerId||
       Date.parse(connection.expiresAt)<=now+60_000)
      return {kind:'held',reasons:['TARGET_CONNECTION_UNAVAILABLE'],classification:'systemic'};
    const path=await this.deps.sourceCategoryPath(candidate);
    if(!Array.isArray(path)||!path.length||path.some(p=>typeof p!=='string'||!p.trim()))
      return {kind:'held',reasons:['SOURCE_CATEGORY_PATH_UNVERIFIED'],classification:'source'};
    const key=[candidate.targetPartnerId,candidate.targetShopId,connection.revision,
      path.join('/'),item.rawItem.brand?.original_brand_name].join('|');
    let metadata=this.cache.get(key);
    if(!metadata||metadata.connectionRevision!==connection.revision||
       metadata.scope.shopId!==candidate.targetShopId||
       now-Date.parse(metadata.observedAt)<0||now-Date.parse(metadata.observedAt)>10*60_000){
      metadata=await this.deps.collectMetadata(candidate,path);
      this.cache.set(key,metadata);
    }
    const selected=metadata.selected.filter(row=>row.categoryId===String(item.categoryId)&&
      row.path.length===path.length&&row.path.every((part,index)=>part===path[index]));
    if(selected.length!==1||!selected[0]!.brands?.rows.some(row=>
      row.id===String(item.brandId)&&row.name===item.rawItem.brand?.original_brand_name))
      return {kind:'held',reasons:['TARGET_CATEGORY_OR_BRAND_UNVERIFIED'],classification:'source'};
    const source=await this.deps.readCurrentSource(candidate);
    const sourceComparison=compareCurrentArchiveSource(item,source,candidate.manifest.sourceShopId);
    if(!sourceComparison.equal)
      return {kind:'held',reasons:sourceComparison.changedPaths.map(p=>'SOURCE_CHANGED:'+p),classification:'source'};
    const list=await this.deps.readTargetList(candidate);
    const checkedNow=this.deps.now?.()??Date.now();
    if(list.statuses.some(status=>!['NORMAL','UNLIST','BANNED','REVIEWING'].includes(status))||
       ['NORMAL','UNLIST','BANNED','REVIEWING'].some(status=>!list.statuses.includes(status))||
       !list.requestIds.length||checkedNow-Date.parse(list.observedAt)<0||
       checkedNow-Date.parse(list.observedAt)>5*60_000)
      return {kind:'held',reasons:['TARGET_LIST_INCOMPLETE'],classification:'systemic'};
    const ids=list.rows.map(row=>String(row.item_id));
    const cached=(await this.deps.pool.query(
      'SELECT item_id,item_status,item_sku,model_skus,remote_updated_at,title ' +
      'FROM seller_knowledge_items WHERE connection_id=$1 AND item_id=ANY($2::text[])',
      [connection.id,ids])).rows;
    const hydrated=await verifyCloneTargetInventoryDelta({pool:this.deps.pool,
      connectionId:connection.id,partnerId:candidate.targetPartnerId,
      shopId:candidate.targetShopId,live:list.rows,cached,
      reviewedHeldIntentIds:this.deps.reviewedHeldIntentIds,
      read:(endpoint,query)=>this.deps.readTarget(candidate,endpoint,query)});
    const skuRows=item.modelProjection.length?item.modelProjection.map(row=>row.modelSku):[item.sourceItemSku];
    const wanted=new Set(skuRows.filter(Boolean));
    if(hydrated.rows.some(row=>row.title===item.title||
       [row.item_sku,...row.model_skus].some(sku=>wanted.has(sku))))
      return {kind:'held',reasons:['TARGET_DUPLICATE'],classification:'source'};
    const sourceStock=item.modelProjection.length
      ? item.modelProjection.map(row=>row.stockInfoV2)
      : [item.parentStockInfoV2];
    const sourceLocations=[...new Set(sourceStock.flatMap(stock=>
      (stock?.seller_stock??[]).map((row:any)=>String(row.location_id??''))).filter(Boolean))];
    const preferred=sourceLocations.length===1 ? sourceLocations[0] : undefined;
    if(!preferred)
      return {kind:'held',reasons:['SOURCE_STOCK_LOCATION_AMBIGUOUS'],classification:'source'};
    let locationEvidence:CloneLocationProof|undefined;
    if(metadata.warehouse.status==='not_whitelisted' && this.deps.locationProof){
      locationEvidence=await this.deps.locationProof(candidate,metadata,{
        connectionId:connection.id,connectionRevision:connection.revision,
        targetList:list,expectedLocationId:preferred});
      if(locationEvidence){
        try {assertCloneLocationProof({proof:locationEvidence,
          connection:{id:connection.id,revision:connection.revision,
            partnerId:candidate.targetPartnerId,shopId:candidate.targetShopId,
            state:connection.state,expiresAt:connection.expiresAt},
          targetList:list,expectedLocationId:preferred,now:this.deps.now?.()??Date.now()});}
        catch{return {kind:'held',reasons:['TARGET_LOCATION_PROOF_INVALID'],classification:'systemic'};}
      }
    }
    const location=metadata.warehouse.status==='available' &&
      metadata.warehouse.rows.some(row=>row.location_id===preferred&&row.holiday_mode_state===0)
        ? preferred : locationEvidence?.locationId;
    if(!location)
      return {kind:'held',reasons:['TARGET_WAREHOUSE_UNVERIFIED'],classification:'systemic'};
    const proposal={categoryId:String(item.categoryId),brandId:String(item.brandId),
      attributes:(item.rawItem.attribute_list??[]).map((row:any)=>({attribute_id:row.attribute_id,
        attribute_value_list:row.attribute_value_list})),
      logisticIds:(item.rawItem.logistic_info??[]).filter((row:any)=>row.enabled).map((row:any)=>String(row.logistic_id)),
      mappingConfirmationRef:['archive',candidate.manifest.archiveId,item.sourceItemId,item.observationHash].join(':')};
    const observation=(value:any)=>({shopId:candidate.targetShopId,revision:connection.revision,
      observedAt:metadata!.observedAt,value});
    const assessed=assessArchiveTargetPreflight({
      source:{shopId:candidate.manifest.sourceShopId,itemId:item.sourceItemId,
        categoryPath:path,brandName:item.rawItem.brand?.original_brand_name??null,
        itemSku:item.sourceItemSku,modelSkus:item.modelProjection.map(row=>row.modelSku),
        sourceContractRef:proposal.mappingConfirmationRef},
      target:{shopId:candidate.targetShopId,connection:{state:connection.state,
        revision:connection.revision,expiresAt:connection.expiresAt},proposal,
        shop:observation({shopId:candidate.targetShopId,status:metadata.shop.status}),
        categories:observation(metadata.categories),
        brands:observation({categoryId:String(item.categoryId),...selected[0]!.brands!}),
        attributeTree:observation({categoryId:String(item.categoryId),tree:selected[0]!.attributeTree}),
        logistics:observation({complete:true,rows:metadata.channels.rows.map((row:any)=>({
          id:String(row.logistics_channel_id),enabled:row.enabled,compulsory:row.compulsory_channel,
          relationsKnown:!!row.channel_relation_rules,
          relatedEnabledIds:(row.channel_relation_rules?.related_enabled_channels??[]).map(String),
          blockedWithIds:(row.channel_relation_rules?.related_disabled_channels??[]).map(String)}))}),
        inventory:{shopId:candidate.targetShopId,revision:connection.revision,
          observedAt:list.observedAt,value:{complete:true,statuses:list.statuses,
            rows:hydrated.rows.map(row=>({itemId:String(row.item_id),itemSku:row.item_sku,
              modelSkus:row.model_skus}))}}},
      now:new Date(checkedNow).toISOString(),maxEvidenceAgeMs:900000,
    });
    if(!assessed.readyForWriterPreflight)
      return {kind:'held',reasons:assessed.blockers.map(row=>row.code+':'+row.path),classification:'source'};
    const images=item.media.filter(media=>['cover','gallery','description','variation-0'].includes(media.role));
    if(!images.length||images.some(media=>!media.sha256))
      return {kind:'held',reasons:['SOURCE_MEDIA_UNAVAILABLE'],classification:'source'};
    const stored=(await this.deps.pool.query(
      'SELECT r.role,r.ordinal,r.blob_sha256,b.storage_path FROM shop_listing_media_refs r ' +
      'JOIN shop_listing_media_blobs b ON b.sha256=r.blob_sha256 ' +
      'WHERE r.archive_id=$1 AND r.item_id=$2 AND r.state=$3',
      [candidate.manifest.archiveId,item.sourceItemId,'stored'])).rows;
    const mediaPath=new Map<string,string>();
    for(const row of stored){
      const key=[row.role,row.ordinal,row.blob_sha256].join(':');
      if(mediaPath.has(key)||typeof row.storage_path!=='string'||!row.storage_path)
        return {kind:'held',reasons:['SOURCE_MEDIA_STORAGE_AMBIGUOUS'],classification:'source'};
      mediaPath.set(key,row.storage_path);
    }
    const storedImages=stored.filter(row=>['cover','gallery','description','variation-0'].includes(row.role));
    if(storedImages.length!==images.length||
       images.some(media=>!mediaPath.has([media.role,media.ordinal,media.sha256].join(':'))))
      return {kind:'held',reasons:['SOURCE_MEDIA_STORAGE_MISSING'],classification:'source'};
    const currentConnection=await this.deps.readConnection(candidate);
    if(currentConnection.id!==connection.id||currentConnection.revision!==connection.revision||
       currentConnection.state!=='connected'||
       Date.parse(currentConnection.expiresAt)<= (this.deps.now?.()??Date.now())+60_000)
      return {kind:'held',reasons:['TARGET_CONNECTION_CHANGED'],classification:'systemic'};
    const approval={archiveId:candidate.manifest.archiveId,sourceShopId:candidate.manifest.sourceShopId,
      sourceItemId:item.sourceItemId,sourceObservationHash:item.observationHash,
      targetConnectionId:connection.id,targetConnectionRevision:connection.revision,
      targetPartnerId:candidate.targetPartnerId,targetShopId:candidate.targetShopId,
      blockers:[] as string[],expiresAt:new Date(checkedNow+10*60_000).toISOString(),
      media:images.map(media=>({role:media.role as 'cover'|'gallery'|'description'|'variation-0',ordinal:media.ordinal,sha256:media.sha256}))};
    const cloneScope={archiveId:candidate.manifest.archiveId,sourceShopId:candidate.manifest.sourceShopId,
      sourceItemId:item.sourceItemId,sourceObservationHash:item.observationHash,
      sourceHasVariations:item.tierProjection.length>0,targetShopId:candidate.targetShopId,
      connectionId:connection.id,connectionRevision:connection.revision};
    return {kind:'ready',locationId:location,media:{approval,cloneScope,credentials:connection.credentials,
      assets:images.map(media=>({role:media.role as 'cover'|'gallery'|'description'|'variation-0',ordinal:media.ordinal,
        sha256:media.sha256,blobPath:mediaPath.get([media.role,media.ordinal,media.sha256].join(':'))!}))},metadata,
      inventoryRequestIds:[...list.requestIds,...hydrated.requestIds],
      sourceRequestIds:source.requestIds,
      targetRequestIds:[...metadata.evidence.map(row=>row.requestId),
        ...(locationEvidence?.items.flatMap(row=>[row.baseRequestId,
          ...(row.modelRequestId?[row.modelRequestId]:[])])??[])],
      ...(locationEvidence?{locationEvidence}:{})};
  }
}
