import { createHash } from 'node:crypto';
import type { ArchiveItem, ArchiveManifest } from './archive-clone.js';
import { canonicalJson } from './plans.js';

type Row = Record<string, any>;
export type CloneImageManualReview = {
  reviewId: string; reviewerId: string; reviewedAt: string;
  evidenceRef: string; evidenceSha256: string;
  sourceItemId: string; targetShopId: string; targetItemId: string;
  sourceImageId: string; uploadedImageId: string; observedImageId: string;
  sourceSha256: string; observedSha256: string;
  sourceUrl: string; observedUrl: string; finding: 'same_visual_content';
};
export type CloneImagePerceptualReview = {
  evidenceRef:string; evidenceSha256:string;
  evidence:{
    version:'archive-clone-image-qc/v1';state:'verified';basis:'strict_perceptual';
    binding:{environment:'production';shopId:string;itemId:string;role:'cover';
      position:number;sourceAssetId:string;outputImageId:string;operationId:string};
    source:{url:string;sha256:string;width:number;height:number};
    target:{url:string;sha256:string;width:number;height:number};
    metrics:{meanAbsolute:number;p99Absolute:number;maxTileMeanAbsolute:number;globalSsim:number};
    checkedAt:string;
  };
};
export type CloneImageProof = { role: 'cover'|'gallery'|'description'|'variation-0'; ordinal: number; sourceSha256: string; uploadedId: string; observedId?: string; observedSha256?: string; manualReview?: CloneImageManualReview; perceptualReview?: CloneImagePerceptualReview };
export type CloneVideoProof = { sourceSha256: string; sourceItemId: string; targetShopId: string; uploadId: string; status: 'SUCCEEDED'; targetUrl: string; thumbnailSha256?: string; targetThumbnailUrl?: string; thumbnailVerification?: 'source_sha256'|'manual_review'; observedThumbnailSha256?: string; manualReviewId?: string };
export type CloneReadback = { captureId: string; observedAt: string; shopId: string; item: Row; models: Row };
export type CloneQcInput = {
  manifest: ArchiveManifest; sourceItemId: string; sourceObservationHash: string; targetShopId: string;
  /** Two independent raw GET responses, never an ACK or payload echo. */
  readbacks: [CloneReadback, CloneReadback];
  images: CloneImageProof[]; video?: CloneVideoProof;
  targetCategoryId: number; targetBrandId: number;
  targetLocationBySku: Record<string,string>;
  targetLogisticIdBySourceId: Record<string,string>;
};
export type CloneQcField = { path: string; status: 'verified'|'blocked'|'source_only'|'target_specific'|'promotion_exception'; note?: string };
export type CloneQcResult = { verified: boolean; sourceItemId: string; targetShopId: string; targetItemId?: string; mismatchedPaths: string[]; fields: CloneQcField[]; expectedProjectionHash: string; observedProjectionHash: string };

const stable = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify({value})));
const same = (a: unknown,b: unknown) => stable(a) === stable(b);
const id = (v: unknown) => String(v ?? '');
const number = (v: unknown) => Number(v);
const own = (r: Row, k: string) => Object.prototype.hasOwnProperty.call(r,k);
const order = (item: ArchiveItem, role: string) => item.media.filter(m=>m.role===role).sort((a,b)=>a.ordinal-b.ordinal);
function attributes(rows: unknown) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((a: Row)=>({id:id(a.attribute_id), name:a.original_attribute_name, mandatory:a.is_mandatory, values:(a.attribute_value_list ?? []).map((v:Row)=>({
    id:id(v.value_id), name:v.original_value_name, unit:v.value_unit
  }))})).sort((a,b)=>a.id.localeCompare(b.id));
}
function stableReadback(value: Row | undefined): Row {
  const copy:Row=structuredClone(value ?? {});
  delete copy.update_time;
  if (copy.stock_info_v2?.summary_info)
    delete copy.stock_info_v2.summary_info.total_reserved_stock;
  if (Array.isArray(copy.model))
    for (const model of copy.model) {
      delete model.update_time;
      if (model.stock_info_v2?.summary_info)
        delete model.stock_info_v2.summary_info.total_reserved_stock;
    }
  if (Array.isArray(copy.attribute_list))
    copy.attribute_list.sort((a:Row,b:Row)=>String(a.attribute_id).localeCompare(String(b.attribute_id)));
  if (Array.isArray(copy.model))
    copy.model.sort((a:Row,b:Row)=>
      String(a.model_id ?? a.tier_index?.join(':') ?? '').localeCompare(
        String(b.model_id ?? b.tier_index?.join(':') ?? '')));
  return copy;
}
function dims(path: string, source: Row, target: Row, check: (p:string,a:unknown,b:unknown)=>void) {
  for (const key of ['package_length','package_width','package_height'])
    check(path+'.'+key, number(source?.[key] ?? 0), number(target?.[key] ?? 0));
}

/** Source-to-readback QC. Every expected field comes from the immutable archive, not the create payload. */
export function checkArchiveCloneReadback(input: CloneQcInput): CloneQcResult {
  const fields: CloneQcField[] = [];
  const mismatches = new Set<string>();
  const expectedChecks: Record<string,unknown> = {}, observedChecks: Record<string,unknown> = {};
  const hashChecks = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
  const mark = (path: string, status: CloneQcField['status'], note?: string) => {
    fields.push({path,status,...(note ? {note}: {})});
    if (status==='blocked') mismatches.add(path);
  };
  const check = (path:string, expected:unknown, actual:unknown) => {
    // Shopee may omit an unset GTIN. A nonempty code still requires exact equality.
    const normalized = (value:unknown) => path.endsWith('.gtin_code') &&
      (value === '' || value === undefined || value === null) ? null : value;
    const left=normalized(expected), right=normalized(actual);
    expectedChecks[path]=left ?? null; observedChecks[path]=right ?? null;
    mark(path, same(left,right) ? 'verified' : 'blocked');
  };
  const item = input.manifest.items.find(i=>i.sourceItemId===input.sourceItemId);
  const finish = (targetItemId?: string): CloneQcResult => ({
    verified:mismatches.size===0, sourceItemId:input.sourceItemId, targetShopId:input.targetShopId,
    ...(targetItemId ? {targetItemId}: {}), mismatchedPaths:[...mismatches], fields,
    expectedProjectionHash:hashChecks(expectedChecks), observedProjectionHash:hashChecks(observedChecks)
  });
  if (!item) { mark('sourceItemId','blocked','Missing immutable source item'); return finish(); }
  check('source.observationHash',item.observationHash,input.sourceObservationHash);
  if (!Array.isArray(input.readbacks) || input.readbacks.length!==2 ||
      !input.readbacks[0]?.item || !input.readbacks[1]?.item) {
    mark('readbacks','blocked','Two raw GET responses required'); return finish();
  }
  const first=input.readbacks[0], last=input.readbacks[1];
  if (!first.captureId || !last.captureId || first.captureId===last.captureId ||
      !Number.isFinite(Date.parse(first.observedAt)) || !Number.isFinite(Date.parse(last.observedAt)) ||
      Date.parse(last.observedAt)<Date.parse(first.observedAt))
    mark('readbacks.independentCaptures','blocked','Require two distinct ordered raw GET receipts');
  check('scope.shopId',[input.targetShopId,input.targetShopId],[first.shopId,last.shopId]);
  check('scope.itemId',id(first.item.item_id),id(last.item.item_id));
  if (!id(last.item.item_id) || id(last.item.item_id)===item.sourceItemId) mark('scope.newItemId','blocked');
  check('readbacks.itemStable',stableReadback(first.item),stableReadback(last.item));
  check('readbacks.modelsStable',stableReadback(first.models),stableReadback(last.models));
  const source=item.rawItem, remote=last.item, sourceModels=item.rawModels ?? {model:[],tier_variation:[]}, remoteModels=last.models ?? {model:[],tier_variation:[]};
  check('source.raw.item_id',item.sourceItemId,id(source.item_id));
  check('source.raw.item_name',item.title,source.item_name);
  check('source.raw.item_sku',item.sourceItemSku,source.item_sku);
  check('source.raw.tier_count',item.tierProjection.length,(sourceModels.tier_variation ?? []).length);
  check('source.raw.model_count',item.modelProjection.length,(sourceModels.model ?? []).length);
  if (item.tierProjection.length) for (const row of item.modelProjection) {
    const raw=(sourceModels.model ?? []).find((m:Row)=>id(m.model_id)===row.sourceModelId);
    const p='source.models.'+row.sourceModelId;
    check(p+'.sku',row.modelSku,raw?.model_sku);
    check(p+'.tier_index',row.tierIndex,raw?.tier_index);
    check(p+'.price',row.priceInfo,raw?.price_info);
    check(p+'.stock',row.stockInfoV2,raw?.stock_info_v2);
    check(p+'.weight',number(row.weight),number(raw?.weight));
    dims(p+'.dimension',row.dimension,raw?.dimension,check);
  } else {
    check('source.parent.price',item.parentPriceInfo,source.price_info);
    check('source.parent.stock',item.parentStockInfoV2,source.stock_info_v2);
  }
  check('source.media_receipt_count',item.media.filter(m=>['cover','gallery','description','variation-0'].includes(m.role)).length,input.images.length);
  check('source.description_block_order',item.descriptionBlocks.map(b=>b.blockIndex),item.descriptionBlocks.map((_,i)=>i));
  check('source.media.cover',order(item,'cover').map(m=>m.sourceMediaId),source.promotion_image?.image_id_list);
  check('source.media.gallery',order(item,'gallery').map(m=>m.sourceMediaId),source.image?.image_id_list);
  check('source.media.description',order(item,'description').map(m=>m.sourceMediaId),
    (source.description_info?.extended_description?.field_list ?? []).filter((b:Row)=>b.field_type==='image').map((b:Row)=>b.image_info?.image_id));
  check('source.media.variation',order(item,'variation-0').map(m=>m.sourceMediaId),
    (sourceModels.tier_variation?.[0]?.option_list ?? []).map((o:Row)=>o.image?.image_id).filter(Boolean));
  const image = (m: ArchiveItem['media'][number] | undefined): string | undefined => {
    if (!m) return undefined;
    const path='media.'+m.role+'.'+m.ordinal;
    const proofs=input.images.filter(p=>p.role===m.role && p.ordinal===m.ordinal && p.sourceSha256===m.sha256);
    if (proofs.length!==1 || !proofs[0]!.uploadedId) {mark(path,'blocked','Missing unique role/ordinal/SHA upload proof'); return undefined;}
    const proof=proofs[0]!;
    if (proof.observedId && proof.observedId!==proof.uploadedId && proof.observedSha256!==m.sha256) {
      const r=proof.manualReview;
      const reviewed=!!r && !!r.reviewId && !!r.reviewerId &&
        !!r.evidenceRef && /^[a-f0-9]{64}$/.test(r.evidenceSha256) &&
        Number.isFinite(Date.parse(r.reviewedAt)) &&
        r.sourceItemId===item.sourceItemId && r.targetShopId===input.targetShopId &&
        r.targetItemId===id(last.item.item_id) &&
        r.sourceImageId===m.sourceMediaId &&
        r.uploadedImageId===proof.uploadedId && r.observedImageId===proof.observedId &&
        r.sourceSha256===m.sha256 && r.observedSha256===proof.observedSha256 &&
        r.sourceUrl===m.sourceUrl &&
        r.observedUrl.endsWith('/'+proof.observedId) &&
        r.finding==='same_visual_content';
      const auto=proof.perceptualReview;
      const v=auto?.evidence;
      const autoHash=v ? createHash('sha256').update(canonicalJson(v)).digest('hex') : '';
      const automatic=!!auto && !!v && m.role==='cover' &&
        auto.evidenceSha256===autoHash && !!auto.evidenceRef &&
        v.version==='archive-clone-image-qc/v1' && v.state==='verified' &&
        v.basis==='strict_perceptual' &&
        v.binding.environment==='production' &&
        v.binding.shopId===input.targetShopId &&
        v.binding.itemId===id(last.item.item_id) &&
        v.binding.role==='cover' && v.binding.position===m.ordinal &&
        v.binding.sourceAssetId===m.sourceMediaId &&
        v.binding.outputImageId===proof.observedId && !!v.binding.operationId &&
        v.source.url===m.sourceUrl && v.source.sha256===m.sha256 &&
        v.target.url.endsWith('/'+proof.observedId) &&
        v.target.sha256===proof.observedSha256 &&
        v.source.width===v.target.width && v.source.height===v.target.height &&
        v.source.width>=512 && v.source.height>=512 &&
        Number.isFinite(Date.parse(v.checkedAt)) &&
        v.metrics.meanAbsolute<=2.5 && v.metrics.p99Absolute<=20 &&
        v.metrics.maxTileMeanAbsolute<=6 && v.metrics.globalSsim>=0.995;
      if (!reviewed && !automatic) {
        mark(path,'blocked','Changed image ID requires observed-byte SHA or scoped visual review proof');
        return undefined;
      }
      if (automatic) mark(path+'.strict_perceptual','verified','Stored JPEG recompression comparison');
      else mark(path+'.manual_review','verified','Reviewed source and target image; Shopee recompressed bytes');
    }
    mark(path,'verified');
    return proof.observedId ?? proof.uploadedId;
  };
  check('item.item_status','UNLIST',remote.item_status);
  check('item.item_name',item.title,remote.item_name);
  check('item.item_sku',item.sourceItemSku,remote.item_sku);
  check('item.category_id',input.targetCategoryId,remote.category_id);
  check('item.brand.brand_id',input.targetBrandId,remote.brand?.brand_id);
  check('item.brand.original_brand_name',source.brand?.original_brand_name,remote.brand?.original_brand_name);
  for (const key of ['condition','pre_order','tag','compatibility_info','item_dangerous',
      'purchase_limit_info','size_chart_id','size_chart','is_fulfillment_by_shopee'])
    if (own(source,key)) check('item.'+key,source[key],remote[key]);
  if (own(source,'gtin_code')) check('item.gtin_code',source.gtin_code,remote.gtin_code);
  if (own(source,'promotion_id')) mark('item.promotion_id','promotion_exception','Source campaign is not recreated');
  check('item.has_model',item.tierProjection.length>0,remote.has_model);
  check('item.weight',number(source.weight),number(remote.weight));
  dims('item.dimension',source.dimension,remote.dimension,check);
  check('item.attribute_list',attributes(source.attribute_list),attributes(remote.attribute_list));

  const logistics=Array.isArray(source.logistic_info)?source.logistic_info:[];
  const targetLogistics=Array.isArray(remote.logistic_info)?remote.logistic_info:[];
  for (const channel of logistics) {
    const targetId=input.targetLogisticIdBySourceId[id(channel.logistic_id)];
    const path='item.logistic_info.'+id(channel.logistic_id);
    if (!targetId) {mark(path+'.mapping','blocked');continue;}
    const found=targetLogistics.find((v:Row)=>id(v.logistic_id)===targetId);
    if (!found) {mark(path+'.missing','blocked');continue;}
    for (const key of ['enabled','is_free','size_id','include_pickup'])
      if (own(channel,key)) check(path+'.'+key,channel[key],found[key]);
    mark(path+'.logistic_name','target_specific','Channel display name belongs to the target shop');
    if (own(found,'estimated_shipping_fee')) mark(path+'.estimated_shipping_fee','target_specific','Shopee-calculated fee');
  }
  for (const channel of targetLogistics)
    if (channel.enabled && !Object.values(input.targetLogisticIdBySourceId).includes(id(channel.logistic_id)))
      mark('item.logistic_info.'+id(channel.logistic_id)+'.extra_enabled','blocked');
  mark('item.shipping_fee','target_specific','Fee and estimated delivery are computed for the target shop');

  check('item.promotion_image.image_ratio',source.promotion_image?.image_ratio,remote.promotion_image?.image_ratio);
  check('item.promotion_image.image_id_list',order(item,'cover').map(image),remote.promotion_image?.image_id_list);
  check('item.image.image_ratio',source.image?.image_ratio,remote.image?.image_ratio);
  check('item.image.image_id_list',order(item,'gallery').map(image),remote.image?.image_id_list);
  check('item.description_type',source.description_type,remote.description_type);
  if (source.description_type==='extended') {
    const sourceDesc=order(item,'description');
    const expected=item.descriptionBlocks.map(b=>b.field_type==='text'
      ? {type:'text',text:b.text ?? ''}
      : {type:'image',id:image(sourceDesc.find(m=>m.ordinal===b.blockIndex && m.sha256===b.sha256))});
    const actual=remote.description_info?.extended_description?.field_list?.map((b:Row)=>b.field_type==='text'
      ? {type:'text',text:b.text} : {type:'image',id:b.image_info?.image_id});
    check('item.description_info.extended_description.field_list',expected,actual);
  } else check('item.description',source.description,remote.description);

  const sourceVariation=order(item,'variation-0');
  const expectedTiers=item.tierProjection.map((t,ti)=>({name:t.name, options:t.options.map(o=>({
    name:o.label, image:ti===0 ? image(sourceVariation.find(m=>m.sourceMediaId===
      sourceModels.tier_variation?.[0]?.option_list?.[o.optionIndex]?.image?.image_id)) : undefined
  }))}));
  const targetTiers=(remoteModels.tier_variation ?? []).map((t:Row)=>({name:t.name,
    options:(t.option_list ?? []).map((o:Row)=>({name:o.option,image:o.image?.image_id}))}));
  check('models.tier_variation',expectedTiers,targetTiers);
  if (remoteModels.standardise_tier_variation) check('models.standardise_tier_variation',expectedTiers,
    remoteModels.standardise_tier_variation.map((t:Row)=>({name:t.variation_name,
      options:(t.variation_option_list ?? []).map((o:Row)=>({name:o.variation_option_name,image:o.image_id}))})));

  const sourceRows=item.tierProjection.length ? item.modelProjection : [{
    sourceModelId:'',modelSku:item.sourceItemSku,tierIndex:[],selections:[],
    priceInfo:item.parentPriceInfo ?? [],stockInfoV2:item.parentStockInfoV2,
    weight:item.parentWeight,dimension:item.parentDimension
  }];
  const targetRows: Row[]=item.tierProjection.length ? (remoteModels.model ?? []) : [remote];
  check('models.count',sourceRows.length,targetRows.length);
  const seen=new Set<string>();
  for (const row of sourceRows) {
    const key=row.tierIndex.join(':');
    const path='models.'+(key || 'parent');
    const matches=targetRows.filter(r=>(r.tier_index ?? []).join(':')===key);
    if (seen.has(key) || matches.length!==1) {mark(path+'.identity','blocked');continue;}
    seen.add(key);
    const target=matches[0]!;
    check(path+'.sku',row.modelSku,item.tierProjection.length?target.model_sku:target.item_sku);
    check(path+'.tier_index',row.tierIndex,target.tier_index ?? []);
    for (let t=0;t<row.selections.length;t++)
      check(path+'.selection.'+t,row.selections[t],item.tierProjection[t]?.options[row.tierIndex[t]!]?.label);
    const expectedPrice=row.priceInfo?.[0], actualPrice=target.price_info?.[0];
    check(path+'.original_price',expectedPrice?.original_price,actualPrice?.original_price);
    check(path+'.current_price',expectedPrice?.original_price,actualPrice?.current_price);
    check(path+'.currency',expectedPrice?.currency,actualPrice?.currency);
    for (const key of ['inflated_price_of_original_price','inflated_price_of_current_price'])
      if (actualPrice && own(actualPrice,key)) check(path+'.'+key,expectedPrice?.original_price,actualPrice[key]);
    const qty=row.stockInfoV2?.summary_info?.total_available_stock;
    check(path+'.saleable_stock',qty,target.stock_info_v2?.summary_info?.total_available_stock);
    check(path+'.reserved_stock',0,target.stock_info_v2?.summary_info?.total_reserved_stock);
    for (const allocation of target.stock_info_v2?.shopee_stock ?? [])
      check(path+'.shopee_stock',0,allocation.stock);
    const location=input.targetLocationBySku[row.modelSku];
    if (!location) mark(path+'.location','blocked');
    else {
      const stock=target.stock_info_v2?.seller_stock?.find((s:Row)=>id(s.location_id)===location);
      check(path+'.seller_stock',{stock:qty,if_saleable:true,location_id:location},
        stock && {stock:stock.stock,if_saleable:stock.if_saleable,location_id:stock.location_id});
    }
    if (item.tierProjection.length) {
      check(path+'.weight',number(row.weight),number(target.weight));
      dims(path+'.dimension',row.dimension,target.dimension,check);
      const raw=(sourceModels.model ?? []).find((m:Row)=>id(m.model_id)===row.sourceModelId);
      check(path+'.model_name',raw?.model_name,target.model_name);
      check(path+'.model_status',raw?.model_status,target.model_status);
      for (const field of ['gtin_code','pre_order','is_fulfillment_by_shopee'])
        check(path+'.'+field,raw?.[field],target[field]);
      for (const sourceOnly of ['model_id','ssp_id','cssp_id'])
        mark(path+'.'+sourceOnly,'source_only','Shopee/shop-generated model identity');
    }
    if (item.rawItem.has_promotion) mark(path+'.promotion_id','promotion_exception','Source campaign is not recreated');
    else mark(path+'.promotion_id','verified');
  }
  check('item.has_promotion',false,remote.has_promotion);
  const video=order(item,'video')[0],thumb=order(item,'video-thumbnail')[0];
  if (video) {
    const proof=input.video;
    if (!proof || proof.sourceSha256!==video.sha256 || proof.sourceItemId!==item.sourceItemId ||
        proof.targetShopId!==input.targetShopId || !proof.uploadId || proof.status!=='SUCCEEDED')
      mark('item.video_info.upload','blocked','Require finalized upload receipt for exact source SHA and target scope');
    else {
      check('item.video_info.video_url',proof.targetUrl,remote.video_info?.video_url);
      check('item.video_info.duration',source.video_info?.duration,remote.video_info?.duration);
      if (thumb) {
        if (proof.thumbnailSha256!==thumb.sha256 ||
            !(proof.thumbnailVerification==='source_sha256' && proof.observedThumbnailSha256===thumb.sha256 ||
              proof.thumbnailVerification==='manual_review' && proof.manualReviewId))
          mark('item.video_info.thumbnail.proof','blocked','Transcoded thumbnail needs byte or explicit visual review proof');
        check('item.video_info.thumbnail_url',proof.targetThumbnailUrl,remote.video_info?.thumbnail_url);
      }
    }
  } else check('item.video_info',source.video_info ?? [],remote.video_info ?? []);

  for (const key of ['item_id','create_time','update_time','deboost','authorised_brand_id'])
    mark('item.'+key,'source_only','Shop/Shopee-generated value');
  if (source.has_promotion || item.promotionSnapshot)
    mark('item.has_promotion.source','promotion_exception','Use source original price; campaign belongs to source shop');
  else mark('item.has_promotion.source','verified');
  const coveredItem=new Set(['item_id','create_time','update_time','deboost','authorised_brand_id',
    'has_promotion','item_status','item_name','item_sku','category_id','brand','condition','pre_order',
    'has_model','weight','dimension','attribute_list','logistic_info','size_chart_id','size_chart',
    'item_dangerous','purchase_limit_info','tag','compatibility_info','is_fulfillment_by_shopee',
    'promotion_image','image','description_type','description_info','description','video_info',
    'price_info','stock_info_v2','gtin_code','promotion_id']);
  for (const key of Object.keys(source)) if (!coveredItem.has(key)) mark('item.'+key+'.uncovered','blocked');
  const coveredModel=new Set(['ssp_id','cssp_id','model_id','weight','dimension','gtin_code','model_sku',
    'pre_order','model_name','price_info','tier_index','model_status','promotion_id','has_promotion',
    'stock_info_v2','is_fulfillment_by_shopee']);
  for (const m of sourceModels.model ?? []) for (const key of Object.keys(m))
    if (!coveredModel.has(key)) mark('models.'+id(m.model_id)+'.'+key+'.uncovered','blocked');
  return finish(id(remote.item_id));
}

