import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {canonicalJson} from '@shopee/domain';
import {
  prepareVideoUpload,runVideoUpload,VideoUploadTransport,
  type VideoJournalEntry,
} from '../../../packages/shopee/src/video-upload.js';
import type {ShopCredentials} from '../../../packages/shopee/src/shop-info.js';
import type {ArchiveCloneVideoBinding} from '../../../packages/shopee/src/archive-clone-wire.js';
import type {ProductionPilotCloneScope} from '../../../packages/shopee/src/production-pilot-transport.js';
import type {ApprovedCloneMediaPreflight} from './archive-clone-media-runner.js';
import {
  ShopListingMediaTransferJournal,ShopListingVideoUploadJournal,
  type MediaTransferInput,
} from './shop-listing-media-transfer.js';

const shaPattern=/^[a-f0-9]{64}$/;
const uploadIdPattern=/^[A-Za-z0-9_.:-]{1,256}$/;
const fail=(code:string):never=>{throw new Error('ARCHIVE_CLONE_VIDEO_'+code);};
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const record=(value:unknown):value is Record<string,unknown>=>
  !!value&&typeof value==='object'&&!Array.isArray(value);
const validVideoInfo=(value:unknown):value is ArchiveCloneVideoBinding['videoInfo']=>
  record(value)&&Number.isFinite(value.duration)&&
  Array.isArray(value.video_url_list)&&value.video_url_list.length>0&&
  value.video_url_list.every((x:unknown)=>record(x)&&typeof x.video_url==='string'&&x.video_url.length>0)&&
  Array.isArray(value.thumbnail_url_list)&&value.thumbnail_url_list.length>0&&
  value.thumbnail_url_list.every((x:unknown)=>record(x)&&typeof x.image_url==='string'&&x.image_url.length>0);

export type ArchiveCloneVideoRequest={
  pool:Pool;journal:ShopListingMediaTransferJournal;
  cloneScope:ProductionPilotCloneScope;approval:ApprovedCloneMediaPreflight;
  media:{role:'video';ordinal:number;sha256:string;blobPath:string};
  credentials:ShopCredentials;transport?:typeof fetch;
};
export type ArchiveCloneVideoResult=
  |{kind:'uploaded'|'reused';uploadId:string;transferId:string;videoInfo:Record<string,unknown>}
  |{kind:'processing';uploadId:string;status:string;transferId:string}
  |{kind:'held';state:string;reason:string;transferId:string};

function checkRequest({cloneScope:s,approval:a,media:m,credentials:c}:ArchiveCloneVideoRequest){
  if(!shaPattern.test(a.sourceObservationHash)||s.archiveId!==a.archiveId||
    s.sourceShopId!==a.sourceShopId||s.sourceItemId!==a.sourceItemId||
    s.sourceObservationHash!==a.sourceObservationHash||
    !Array.isArray(a.blockers)||a.blockers.length>0||!Array.isArray(a.media)||
    a.media.filter(x=>x.role==='video').length!==1) fail('SOURCE');
  const now=Date.now(),expiry=Date.parse(a.expiresAt);
  if(!Number.isFinite(expiry)||expiry<=now||expiry>now+15*60_000) fail('PREFLIGHT_EXPIRED');
  if(s.targetShopId!==a.targetShopId||s.connectionId!==a.targetConnectionId||
    s.connectionRevision!==a.targetConnectionRevision||
    c.environment!=='production'||c.partnerId!==a.targetPartnerId||c.shopId!==a.targetShopId||
    a.sourceShopId===a.targetShopId) fail('TARGET');
  if(m.role!=='video'||m.ordinal!==0||!shaPattern.test(m.sha256)||
    typeof m.blobPath!=='string'||!m.blobPath||
    a.media.filter(x=>x.role==='video'&&x.ordinal===m.ordinal&&x.sha256===m.sha256).length!==1)
    fail('ROLE');
}

async function sourceFacts(input:ArchiveCloneVideoRequest){
  const {approval:a,media:m,pool}=input;
  const target=(await pool.query(
    'SELECT environment,partner_id,shop_id,revision,state,expires_at FROM connections WHERE id=$1',
    [a.targetConnectionId])).rows[0];
  if(!target||target.environment!=='production'||target.partner_id!==a.targetPartnerId||
    target.shop_id!==a.targetShopId||target.revision!==a.targetConnectionRevision||
    target.state!=='connected'||!target.expires_at||
    new Date(target.expires_at).getTime()<=Date.now()+60_000) fail('TARGET');
  const rows=(await pool.query(
    'SELECT a.source_shop_id,a.completed_at,i.content_hash,i.item_status,i.model_count,'+
    "o.content_hash AS observation_hash,o.body->'rawItem'->'video_info' AS video_info,"+
    'r.state AS media_state,r.source_url,r.blob_sha256,b.storage_path,b.byte_count,b.mime '+
    'FROM shop_listing_archives a '+
    'JOIN shop_listing_archive_items i ON i.archive_id=a.id '+
    'JOIN seller_knowledge_observations o ON o.id=i.evidence_id '+
    'JOIN shop_listing_media_refs r ON r.archive_id=i.archive_id AND r.item_id=i.item_id '+
    'JOIN shop_listing_media_blobs b ON b.sha256=r.blob_sha256 '+
    "WHERE a.id=$1 AND i.item_id=$2 AND r.role='video' AND r.ordinal=$3",
    [a.archiveId,a.sourceItemId,m.ordinal])).rows;
  const row=rows[0];
  if(rows.length!==1||!row||!row.completed_at||row.source_shop_id!==a.sourceShopId||
    row.content_hash!==a.sourceObservationHash||row.observation_hash!==a.sourceObservationHash||
    row.item_status!=='NORMAL'||(row.model_count>0)!==input.cloneScope.sourceHasVariations)
    fail('SOURCE');
  if(row.media_state!=='stored'||row.blob_sha256!==m.sha256||
    row.storage_path!==m.blobPath||row.mime!=='video/mp4'||
    Number(row.byte_count)<12||Number(row.byte_count)>=30_000_000) fail('ROLE');
  const videos=row.video_info;
  if(!Array.isArray(videos)||videos.length!==1||!record(videos[0])||
    videos[0].video_url!==row.source_url||
    !Number.isFinite(videos[0].duration)||Number(videos[0].duration)<10||
    Number(videos[0].duration)>60) fail('VIDEO_SOURCE_METADATA');
  return {byteCount:Number(row.byte_count),duration:Number(videos[0].duration)};
}

/** Only an explicit, target-specific approved preflight may start this upload. */
export async function uploadApprovedArchiveVideo(input:ArchiveCloneVideoRequest):Promise<ArchiveCloneVideoResult>{
  checkRequest(input);
  const facts=await sourceFacts(input);
  const bytes=await readFile(input.media.blobPath);
  if(bytes.length!==facts.byteCount||
    createHash('sha256').update(bytes).digest('hex')!==input.media.sha256) fail('BYTES_CHANGED');
  const plan=prepareVideoUpload(bytes,{
    environment:'production',partnerId:input.approval.targetPartnerId,
    shopId:input.approval.targetShopId,sourceItemId:input.approval.sourceItemId,
    sourceSha256:input.media.sha256,
    expectedMd5:createHash('md5').update(bytes).digest('hex'),
    durationSeconds:facts.duration,
  });
  const a=input.approval,m=input.media;
  const scope:MediaTransferInput={
    archiveId:a.archiveId,sourceItemId:a.sourceItemId,role:'video',ordinal:m.ordinal,
    blobSha256:m.sha256,targetConnectionId:a.targetConnectionId,
    targetConnectionRevision:a.targetConnectionRevision,
    targetPartnerId:a.targetPartnerId,targetShopId:a.targetShopId,
  };
  const transfer=await input.journal.reserveVideo(scope);
  if(transfer.state==='acknowledged'){
    const binding=await readSucceededArchiveVideoReceipt(input);
    return {kind:'reused',uploadId:binding.uploadId,
      transferId:transfer.id,videoInfo:binding.videoInfo};
  }
  if(transfer.state!=='reserved'&&transfer.state!=='sent') return {
    kind:'held',state:transfer.state,reason:'PREVIOUS_UPLOAD_UNRESOLVED',transferId:transfer.id,
  };
  const steps=new ShopListingVideoUploadJournal(input.pool,{
    environment:'production',partnerId:a.targetPartnerId,shopId:a.targetShopId,
    sourceItemId:a.sourceItemId,sourceSha256:m.sha256,
  });
  if(transfer.state==='reserved'){
    const initial:VideoJournalEntry={key:plan.key,revision:0,phase:'planned',nextPart:0};
    const existing=await steps.load(plan.key);
    if(!existing) await steps.save(plan.key,null,initial);
    else if(!same(existing,initial)) fail('JOURNAL_CONFLICT');
    await input.journal.markSent(transfer.id);
  }else if(!await steps.load(plan.key)){
    return {kind:'held',state:'sent',reason:'VIDEO_SESSION_UNRESOLVED',transferId:transfer.id};
  }
  const client=new VideoUploadTransport({
    environment:'production',partnerId:a.targetPartnerId,shopId:a.targetShopId,
    partnerKey:input.credentials.partnerKey,accessToken:input.credentials.accessToken,
  },input.transport??fetch);
  // runVideoUpload CAS-records each mutation before sending. A pending step is held.
  let outcome;
  try{outcome=await runVideoUpload(plan,bytes,client,steps);}
  catch{ return {kind:'held',state:'sent',reason:'VIDEO_JOURNAL_OR_TRANSPORT_EXCEPTION',transferId:transfer.id}; }
  if(outcome.kind==='processing') return {kind:'processing',uploadId:outcome.uploadId,
    status:outcome.status,transferId:transfer.id};
  if(outcome.kind==='held') return {kind:'held',state:'sent',
    reason:outcome.reason,transferId:transfer.id};
  if(!uploadIdPattern.test(outcome.uploadId)||!validVideoInfo(outcome.videoInfo)) fail('RESULT_INVALID');
  await input.journal.recordOutcome(transfer.id,{kind:'acknowledged',remoteMediaId:outcome.uploadId,
    receipt:{status:'SUCCEEDED',sourceSha256:m.sha256,targetShopId:a.targetShopId,
      uploadId:outcome.uploadId,videoInfo:outcome.videoInfo}});
  return {kind:'uploaded',uploadId:outcome.uploadId,
    transferId:transfer.id,videoInfo:outcome.videoInfo};
}

/**
 * Read-only evidence boundary for create. This returns no binding unless the exact
 * target shop/source blob has a durable SUCCEEDED upload receipt.
 */
export async function readSucceededArchiveVideoReceipt(input:ArchiveCloneVideoRequest):Promise<ArchiveCloneVideoBinding>{
  checkRequest(input);
  await sourceFacts(input);
  const {approval:a,media:m,pool}=input;
  const rows=(await pool.query(
    'SELECT * FROM shop_listing_media_transfers '+
    "WHERE target_partner_id=$1 AND target_shop_id=$2 AND blob_sha256=$3 "+
    "AND source_role='video' AND media_kind='video' AND image_scene='' AND image_ratio=''",
    [a.targetPartnerId,a.targetShopId,m.sha256])).rows;
  const row=rows[0];
  if(rows.length!==1||!row||row.state!=='acknowledged') fail('RECEIPT_MISSING');
  const receipt=row.receipt;
  if(!uploadIdPattern.test(row.remote_media_id)||!record(receipt)||
    receipt.status!=='SUCCEEDED'||receipt.sourceSha256!==m.sha256||
    receipt.targetShopId!==a.targetShopId||receipt.uploadId!==row.remote_media_id||
    !validVideoInfo(receipt.videoInfo)||
    createHash('sha256').update(canonicalJson(receipt)).digest('hex')!==row.receipt_hash)
    fail('RECEIPT_CORRUPT');
  const uploadKey=['production',a.targetPartnerId,a.targetShopId,
    row.source_item_id,m.sha256].join(':');
  const step=(await pool.query(
    'SELECT entry FROM shop_listing_video_upload_entries WHERE key=$1',[uploadKey])).rows[0]?.entry;
  if(!record(step)||step.phase!=='succeeded'||step.uploadId!==row.remote_media_id||
    !record(step.videoInfo)||!same(step.videoInfo,receipt.videoInfo)) fail('RECEIPT_CORRUPT');
  const current=(await pool.query(
    'SELECT environment,partner_id,shop_id,revision,state,expires_at FROM connections WHERE id=$1',
    [a.targetConnectionId])).rows[0];
  if(!current||current.environment!=='production'||current.partner_id!==a.targetPartnerId||
    current.shop_id!==a.targetShopId||current.revision!==a.targetConnectionRevision||
    current.state!=='connected'||new Date(current.expires_at).getTime()<=Date.now()+60_000)
    fail('TARGET');
  return {
    targetShopId:a.targetShopId,connectionId:a.targetConnectionId,
    connectionRevision:a.targetConnectionRevision,sourceSha256:m.sha256,
    uploadId:row.remote_media_id,status:'SUCCEEDED' as const,
    journalKey:row.id,receiptHash:row.receipt_hash,
    videoInfo:receipt.videoInfo,
  };
}


