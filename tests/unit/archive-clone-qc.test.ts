import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkArchiveCloneReadback, type CloneQcInput } from '../../packages/domain/src/archive-clone-qc.js';
import { canonicalJson } from '../../packages/domain/src/plans.js';
import type { ArchiveItem } from '../../packages/domain/src/archive-clone.js';
import { syntheticArchiveManifest } from '../fixtures/archive-clone.js';

const manifest = syntheticArchiveManifest();
const clone=<T>(x:T):T=>structuredClone(x);
function evidence(item:ArchiveItem):CloneQcInput {
  const remote=clone(item.rawItem), models=clone(item.rawModels ?? {model:[],tier_variation:[]});
  remote.item_id=99999999; remote.item_status='UNLIST'; remote.has_promotion=false;
  const images=item.media.filter(m=>['cover','gallery','description','variation-0'].includes(m.role))
    .map(m=>({role:m.role as 'cover'|'gallery'|'description'|'variation-0',ordinal:m.ordinal,
      sourceSha256:m.sha256,uploadedId:'new-'+m.sourceMediaId}));
  const image=(role:string,sourceId:string)=>images.find(p=>p.role===role&&item.media.some(m=>m.role===role&&m.sourceMediaId===sourceId&&m.ordinal===p.ordinal))?.uploadedId;
  remote.promotion_image.image_id_list=remote.promotion_image.image_id_list.map((id:string)=>image('cover',id));
  remote.image.image_id_list=remote.image.image_id_list.map((id:string)=>image('gallery',id));
  for (const block of remote.description_info?.extended_description?.field_list ?? [])
    if (block.field_type==='image') block.image_info.image_id=image('description',block.image_info.image_id);
  for (const tier of models.tier_variation ?? []) for (const option of tier.option_list ?? [])
    if (option.image?.image_id) option.image.image_id=image('variation-0',option.image.image_id);
  for (const tier of models.standardise_tier_variation ?? []) for (const option of tier.variation_option_list ?? [])
    if (option.image_id) option.image_id=image('variation-0',option.image_id);
  const rows=item.tierProjection.length ? models.model : [remote];
  for (const row of rows) {
    row.price_info[0].current_price=row.price_info[0].original_price;
    row.price_info[0].inflated_price_of_current_price=row.price_info[0].original_price;
    const qty=row.stock_info_v2.summary_info.total_available_stock;
    row.stock_info_v2.summary_info.total_reserved_stock=0;
    row.stock_info_v2.seller_stock=[{stock:qty,if_saleable:true,location_id:'TARGET'}];
    row.has_promotion=false; row.promotion_id=0;
  }
  for (const model of models.model ?? []) model.model_id=Number(model.model_id)+100000000;
  const video=item.media.find(m=>m.role==='video');
  const thumb=item.media.find(m=>m.role==='video-thumbnail');
  const videoProof=video ? {sourceSha256:video.sha256,sourceItemId:item.sourceItemId,targetShopId:'888',uploadId:'upload-1',status:'SUCCEEDED' as const,targetUrl:'https://target/video.mp4',
    ...(thumb ? {thumbnailSha256:thumb.sha256,thumbnailVerification:'source_sha256' as const,observedThumbnailSha256:thumb.sha256,targetThumbnailUrl:'https://target/cover.jpg'}:{})} : undefined;
  if (videoProof) {
    remote.video_info.video_url=videoProof.targetUrl;
    if (thumb) remote.video_info.thumbnail_url=videoProof.targetThumbnailUrl;
  }
  return {manifest,sourceItemId:item.sourceItemId,sourceObservationHash:item.observationHash,targetShopId:'888',targetCategoryId:item.categoryId,
    targetBrandId:item.brandId,images,video:videoProof,targetLocationBySku:Object.fromEntries(rows.map((r:any)=>
      [item.tierProjection.length?r.model_sku:r.item_sku,'TARGET'])),
    targetLogisticIdBySourceId:Object.fromEntries(remote.logistic_info.map((l:any)=>[String(l.logistic_id),String(l.logistic_id)])),
    readbacks:[{captureId:'get-1',observedAt:'2026-09-30T08:00:00Z',shopId:'888',item:clone(remote),models:clone(models)},{captureId:'get-2',observedAt:'2026-09-30T08:00:01Z',shopId:'888',item:remote,models}]};
}
describe('archive clone independent QC',()=>{
  for (const tiers of [0,1,2]) it('verifies complete source-based readback with '+tiers+' tier(s)',()=>{
    const item=manifest.items.find(i=>i.tierProjection.length===tiers)!;
    const result=checkArchiveCloneReadback(evidence(item));
    expect(result.mismatchedPaths,item.sourceItemId+':'+result.mismatchedPaths.join(',')).toEqual([]);
    expect(result.expectedProjectionHash).toBe(result.observedProjectionHash);
    expect(result.fields.some(f=>f.status==='source_only')).toBe(true);
    expect(result.fields.some(f=>f.status==='promotion_exception')).toBe(Boolean(item.rawItem.has_promotion));
  });
  it('covers every synthetic immutable source item',()=>{
    for (const item of manifest.items) {
      const result=checkArchiveCloneReadback(evidence(item));
      expect(result.mismatchedPaths,item.sourceItemId+':'+result.mismatchedPaths.join(',')).toEqual([]);
    expect(result.expectedProjectionHash).toBe(result.observedProjectionHash);
    }
  });
  it('catches wrong two-tier SKU, cents-like price drift, and state change',()=>{
    const item=manifest.items.find(i=>i.tierProjection.length===2)!;
    const e=evidence(item);
    e.readbacks[0].models.model[0].model_sku='wrong';
    e.readbacks[1].models.model[0].model_sku='wrong';
    e.readbacks[0].models.model[0].price_info[0].original_price+=1;
    e.readbacks[1].models.model[0].price_info[0].original_price+=1;
    e.readbacks[0].item.item_status='NORMAL';e.readbacks[1].item.item_status='NORMAL';
    const paths=checkArchiveCloneReadback(e).mismatchedPaths;
    expect(paths).toContain('models.'+item.modelProjection[0]!.tierIndex.join(':')+'.sku');
    expect(paths).toContain('models.'+item.modelProjection[0]!.tierIndex.join(':')+'.original_price');
    expect(paths).toContain('item.item_status');
    const result=checkArchiveCloneReadback(e);
    expect(result.expectedProjectionHash).not.toBe(result.observedProjectionHash);
  });
  it('holds changed image ID without readback SHA proof',()=>{
    const item=manifest.items.find(i=>i.tierProjection.length===0)!;
    const e=evidence(item);
    e.images.find(p=>p.role==='cover')!.observedId='shopee-rewritten-id';
    const result=checkArchiveCloneReadback(e);
    expect(result.verified).toBe(false);
    expect(result.mismatchedPaths).toContain('media.cover.0');
  });
  it('accepts an exact scoped visual review for a Shopee-reencoded image, but rejects wrong scope',()=>{
    const item=manifest.items.find(i=>i.tierProjection.length===0)!;
    const e=evidence(item);
    const cover=item.media.find(m=>m.role==='cover')!;
    const proof=e.images.find(p=>p.role==='cover')!;
    proof.observedId='vn-reencoded-cover';
    proof.observedSha256='d'.repeat(64);
    proof.manualReview={reviewId:'review-1',reviewerId:'human-or-agent-reviewer',
      reviewedAt:'2026-09-30T08:00:01Z',evidenceRef:'audit/review.json',evidenceSha256:'e'.repeat(64),sourceItemId:item.sourceItemId,targetShopId:'888',
      targetItemId:'99999999',sourceImageId:cover.sourceMediaId!,
      uploadedImageId:proof.uploadedId,observedImageId:proof.observedId,
      sourceSha256:cover.sha256,observedSha256:proof.observedSha256,
      sourceUrl:cover.sourceUrl!,observedUrl:'https://cf.shopee.vn/file/'+proof.observedId,
      finding:'same_visual_content'};
    e.readbacks[0].item.promotion_image.image_id_list[0]=proof.observedId;
    e.readbacks[1].item.promotion_image.image_id_list[0]=proof.observedId;
    expect(checkArchiveCloneReadback(e).mismatchedPaths).toEqual([]);
    proof.manualReview.targetShopId='wrong-shop';
    expect(checkArchiveCloneReadback(e).mismatchedPaths).toContain('media.cover.0');
  });
  it('accepts only an exact strict perceptual cover proof with bounded metrics',()=>{
    const item=manifest.items.find(i=>i.tierProjection.length===0)!;
    const e=evidence(item);
    const cover=item.media.find(m=>m.role==='cover')!;
    const proof=e.images.find(p=>p.role==='cover')!;
    proof.observedId='vn-reencoded-cover';
    proof.observedSha256='d'.repeat(64);
    e.readbacks[0].item.promotion_image.image_id_list[0]=proof.observedId;
    e.readbacks[1].item.promotion_image.image_id_list[0]=proof.observedId;
    const visual={
      version:'archive-clone-image-qc/v1' as const,state:'verified' as const,
      basis:'strict_perceptual' as const,
      binding:{environment:'production' as const,shopId:'888',itemId:'99999999',
        role:'cover' as const,position:0,sourceAssetId:cover.sourceMediaId!,
        outputImageId:proof.observedId,operationId:'readback'},
      source:{url:cover.sourceUrl!,sha256:cover.sha256,width:1024,height:1024},
      target:{url:'https://cf.shopee.vn/file/'+proof.observedId,
        sha256:proof.observedSha256,width:1024,height:1024},
      metrics:{meanAbsolute:1.5,p99Absolute:10,maxTileMeanAbsolute:4,globalSsim:.999},
      checkedAt:'2026-09-30T08:00:01Z'
    };
    proof.perceptualReview={evidenceRef:'audit/cover-auto.json',
      evidenceSha256:createHash('sha256').update(canonicalJson(visual)).digest('hex'),
      evidence:visual};
    expect(checkArchiveCloneReadback(e).mismatchedPaths).toEqual([]);
    proof.perceptualReview.evidence.metrics.maxTileMeanAbsolute=7;
    proof.perceptualReview.evidenceSha256=createHash('sha256')
      .update(canonicalJson(proof.perceptualReview.evidence)).digest('hex');
    expect(checkArchiveCloneReadback(e).mismatchedPaths).toContain('media.cover.0');
  });  it('ignores only volatile update time and reserved stock between two GETs',()=>{
    const item=manifest.items.find(i=>i.tierProjection.length===0)!;
    const e=evidence(item);
    e.readbacks[0].item.attribute_list.reverse();
    e.readbacks[0].item.update_time=100;
    e.readbacks[1].item.update_time=101;
    e.readbacks[0].item.stock_info_v2.summary_info.total_reserved_stock=1;
    expect(checkArchiveCloneReadback(e).mismatchedPaths).not.toContain('readbacks.itemStable');
    e.readbacks[0].item.price_info[0].original_price+=1;
    expect(checkArchiveCloneReadback(e).mismatchedPaths).toContain('readbacks.itemStable');
  });  it('holds missing video and unapproved logistics changes',()=>{
    const item=manifest.items.find(i=>i.media.some(m=>m.role==='video'))!;
    const e=evidence(item);
    delete e.video;
    e.readbacks[0].item.logistic_info[0].enabled=false;
    e.readbacks[1].item.logistic_info[0].enabled=false;
    const result=checkArchiveCloneReadback(e);
    expect(result.mismatchedPaths).toContain('item.video_info.upload');
    expect(result.mismatchedPaths).toContain('item.logistic_info.'+item.rawItem.logistic_info[0].logistic_id+'.enabled');
  });
  it('compares nested objects independent of key order and treats only empty GTIN as omitted',()=>{
    const item=manifest.items.find(i=>i.tierProjection.length===1)!;
    const e=evidence(item);
    const sourcePre=e.manifest.items.find(i=>i.sourceItemId===item.sourceItemId)!.rawItem.pre_order;
    if (sourcePre && typeof sourcePre==='object' && !Array.isArray(sourcePre)) {
      const reversed=Object.fromEntries(Object.entries(sourcePre).reverse());
      e.readbacks[0].item.pre_order=reversed;
      e.readbacks[1].item.pre_order=reversed;
    }
    if (item.rawItem.gtin_code==='') {
      delete e.readbacks[0].item.gtin_code;
      delete e.readbacks[1].item.gtin_code;
    }
    for (const model of e.readbacks[0].models.model ?? []) if(model.gtin_code==='') delete model.gtin_code;
    for (const model of e.readbacks[1].models.model ?? []) if(model.gtin_code==='') delete model.gtin_code;
    const result=checkArchiveCloneReadback(e);
    expect(result.mismatchedPaths).not.toContain('item.pre_order');
    expect(result.mismatchedPaths).not.toContain('item.gtin_code');
    expect(result.mismatchedPaths.filter(p=>p.endsWith('.gtin_code'))).toEqual([]);
    expect(result.expectedProjectionHash).toBe(result.observedProjectionHash);
  });
  it('still blocks a changed nonempty GTIN',()=>{
    const item=manifest.items.find(i=>i.tierProjection.length===1)!;
    const e=evidence(item);
    const model=e.readbacks[1].models.model[0]!;
    e.readbacks[0].models.model[0]!.gtin_code='wrong-code';
    model.gtin_code='wrong-code';
    expect(checkArchiveCloneReadback(e).mismatchedPaths)
      .toContain('models.'+item.modelProjection[0]!.tierIndex.join(':')+'.gtin_code');
  });  it('holds if source projection was altered after archiving',()=>{
    const item=manifest.items.find(i=>i.tierProjection.length===2)!;
    const e=evidence(item);
    e.manifest={...manifest,items:[{...clone(item),modelProjection:clone(item.modelProjection)}]};
    e.manifest.items[0]!.modelProjection[0]!.modelSku='invented';
    const result=checkArchiveCloneReadback(e);
    expect(result.mismatchedPaths).toContain('source.models.'+item.modelProjection[0]!.sourceModelId+'.sku');
  });
  it('rejects two reads that reuse one capture receipt',()=>{
    const e=evidence(manifest.items[0]!);
    e.readbacks[1].captureId=e.readbacks[0].captureId;
    expect(checkArchiveCloneReadback(e).mismatchedPaths).toContain('readbacks.independentCaptures');
  });
  it('holds when independent reads differ',()=>{
    const e=evidence(manifest.items[0]!);
    e.readbacks[1].item.item_name='changed';
    const result=checkArchiveCloneReadback(e);
    expect(result.mismatchedPaths).toContain('readbacks.itemStable');
    expect(result.mismatchedPaths).toContain('item.item_name');
  });
});

