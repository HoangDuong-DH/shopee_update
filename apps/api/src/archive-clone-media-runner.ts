import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {canonicalJson} from '@shopee/domain';
import {
 ProductionPilotTransport,productionPilotUploadFingerprint,
 type ProductionPilotCloneScope,type ProductionPilotImageOptions,type ProductionPilotMutationIntent,
} from '../../../packages/shopee/src/production-pilot-transport.js';
import type {ShopCredentials} from '../../../packages/shopee/src/shop-info.js';
import {
 ShopListingMediaTransferJournal,type MediaRole,type MediaTransferInput,
} from './shop-listing-media-transfer.js';

const hash=/^[a-f0-9]{64}$/;
const mediaId=/^[A-Za-z0-9_-]{1,512}$/;
const error=(code:string):never=>{throw Error('ARCHIVE_CLONE_MEDIA_'+code);};
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
export type ApprovedCloneMediaPreflight={
 archiveId:string;sourceShopId:string;sourceItemId:string;sourceObservationHash:string;
 targetConnectionId:string;targetConnectionRevision:number;targetPartnerId:string;targetShopId:string;
 blockers:string[];expiresAt:string;
 media:{role:MediaRole;ordinal:number;sha256:string}[];
};
export type ArchiveCloneImageRequest={
 pool:Pool;journal:ShopListingMediaTransferJournal;cloneScope:ProductionPilotCloneScope;
 approval:ApprovedCloneMediaPreflight;
 media:{role:MediaRole;ordinal:number;sha256:string;blobPath:string};
 credentials:ShopCredentials;transport?:typeof fetch;
};
export type ArchiveCloneImageResult=
 |{kind:'uploaded'|'reused';remoteMediaId:string;transferId:string}
 |{kind:'held';state:string;reason:string;transferId:string};

function checkRequest(input:ArchiveCloneImageRequest){
 const {cloneScope:s,approval:a,media:m,credentials:c}=input;
 if(!hash.test(a.sourceObservationHash)||s.archiveId!==a.archiveId||
  s.sourceShopId!==a.sourceShopId||s.sourceItemId!==a.sourceItemId||
  s.sourceObservationHash!==a.sourceObservationHash||
  !Array.isArray(a.blockers)||a.blockers.length>0||
  !Array.isArray(a.media)||a.media.length===0) error('SOURCE');
 const expiry=Date.parse(a.expiresAt),now=Date.now();
 if(!Number.isFinite(expiry)||expiry<=now||expiry>now+15*60_000) error('PREFLIGHT_EXPIRED');
 if(s.targetShopId!==a.targetShopId||s.connectionId!==a.targetConnectionId||
  s.connectionRevision!==a.targetConnectionRevision||
  c.environment!=='production'||c.partnerId!==a.targetPartnerId||c.shopId!==a.targetShopId||
  a.targetShopId===a.sourceShopId) error('TARGET');
 if(!hash.test(m.sha256)||!Number.isSafeInteger(m.ordinal)||m.ordinal<0||
  typeof m.blobPath!=='string'||!m.blobPath||
  a.media.filter(entry=>entry.role===m.role&&entry.ordinal===m.ordinal&&entry.sha256===m.sha256).length!==1)
  error('ROLE');
 if(m.role==='video'||(!['cover','gallery','description','video-thumbnail'].includes(m.role)&&
  !/^variation-[0-9]+$/.test(m.role))) error('ROLE');
}
function imageOptions(role:MediaRole):ProductionPilotImageOptions{
 if(role==='gallery') return {scene:'normal',ratio:'3:4'};
 if(role==='description') return {scene:'desc'};
 return {scene:'normal',ratio:'1:1'};
}
async function checkImmutableSource(input:ArchiveCloneImageRequest){
 const {approval:a,media:m,pool}=input;
 const target=(await pool.query(
  'SELECT environment,partner_id,shop_id,revision,state,expires_at FROM connections WHERE id=$1',
  [a.targetConnectionId])).rows[0];
 if(!target||target.environment!=='production'||target.partner_id!==a.targetPartnerId||
  target.shop_id!==a.targetShopId||target.revision!==a.targetConnectionRevision||
  target.state!=='connected'||!target.expires_at||
  new Date(target.expires_at).getTime()<=Date.now()+60_000) error('TARGET');
 const result=await pool.query(
  'SELECT a.source_shop_id,a.completed_at,i.content_hash,i.item_status,i.model_count,'+
  'o.content_hash AS observation_hash,r.state AS media_state,r.blob_sha256,'+
  'b.storage_path,b.byte_count,b.mime '+
  'FROM shop_listing_archives a '+
  'JOIN shop_listing_archive_items i ON i.archive_id=a.id '+
  'JOIN seller_knowledge_observations o ON o.id=i.evidence_id '+
  'JOIN shop_listing_media_refs r ON r.archive_id=i.archive_id AND r.item_id=i.item_id '+
  'JOIN shop_listing_media_blobs b ON b.sha256=r.blob_sha256 '+
  'WHERE a.id=$1 AND i.item_id=$2 AND r.role=$3 AND r.ordinal=$4',
  [a.archiveId,a.sourceItemId,m.role,m.ordinal]);
 const row=result.rows[0];
 if(result.rows.length!==1||!row||!row.completed_at||
  row.source_shop_id!==a.sourceShopId||row.content_hash!==a.sourceObservationHash||
  row.observation_hash!==a.sourceObservationHash||row.item_status!=='NORMAL'||
  (row.model_count>0)!==input.cloneScope.sourceHasVariations)
  error('SOURCE');
 if(row.media_state!=='stored'||row.blob_sha256!==m.sha256||
  row.storage_path!==m.blobPath||!['image/png','image/jpeg'].includes(row.mime)||
  Number(row.byte_count)<=0||Number(row.byte_count)>10_000_000)
  error('ROLE');
 return {mime:row.mime as 'image/png'|'image/jpeg',byteCount:Number(row.byte_count)};
}
function imageIdFrom(response:Record<string,unknown>):string|null{
 const info=response.image_info;
 const list=response.image_info_list;
 const one=info&&typeof info==='object'&&!Array.isArray(info)?
  (info as Record<string,unknown>).image_id:null;
 const entry=Array.isArray(list)&&list.length===1&&
  list[0]&&typeof list[0]==='object'&&!Array.isArray(list[0])?
  list[0] as Record<string,unknown>:null;
 const listed=entry?.error===null&&entry.image_info&&typeof entry.image_info==='object'?
  (entry.image_info as Record<string,unknown>).image_id:null;
 const ids=[one,listed].filter((id):id is string=>typeof id==='string'&&mediaId.test(id));
 if(!ids.length||new Set(ids).size!==1||
  (info!==undefined&&!one)||(list!==undefined&&!listed)) return null;
 return ids[0]!;
}
/** No autonomous call: the caller must pass one reviewed preflight and explicitly invoke this method. */
export async function uploadApprovedArchiveImage(input:ArchiveCloneImageRequest):Promise<ArchiveCloneImageResult>{
 checkRequest(input);
 const metadata=await checkImmutableSource(input);
 const bytes=await readFile(input.media.blobPath);
 if(bytes.length!==metadata.byteCount||
  createHash('sha256').update(bytes).digest('hex')!==input.media.sha256)
  error('BYTES_CHANGED');
 const transferInput:MediaTransferInput={
  archiveId:input.approval.archiveId,sourceItemId:input.approval.sourceItemId,
  role:input.media.role,ordinal:input.media.ordinal,blobSha256:input.media.sha256,
  targetConnectionId:input.approval.targetConnectionId,
  targetConnectionRevision:input.approval.targetConnectionRevision,
  targetPartnerId:input.approval.targetPartnerId,targetShopId:input.approval.targetShopId,
 };
 const row=await input.journal.reserveImage(transferInput);
 if(row.state==='acknowledged'){
  if(!mediaId.test(row.remote_media_id)) error('RECEIPT_CORRUPT');
  return {kind:'reused',remoteMediaId:row.remote_media_id,transferId:row.id};
 }
 if(row.state!=='reserved') return {kind:'held',state:row.state,
  reason:'PREVIOUS_UPLOAD_UNRESOLVED',transferId:row.id};
 const options=imageOptions(input.media.role);
 const fingerprint=productionPilotUploadFingerprint(
  bytes,metadata.mime,options,{
   environment:'production',partnerId:input.approval.targetPartnerId,
   shopId:input.approval.targetShopId,
  });
 const expectedScope=input.cloneScope;
 const authorizeMutation=async (intent:Readonly<ProductionPilotMutationIntent>)=>{
  if(intent.path!=='/api/v2/media_space/upload_image'||intent.fingerprint!==fingerprint||
   intent.operationId!==row.id||intent.stepId!==row.id||
   !same(intent.cloneScope,expectedScope)) return false;
  try{await input.journal.markSent(row.id);return true;}catch{return false;}
 };
 const client=new ProductionPilotTransport(input.credentials,{
  cloneScope:expectedScope,authorizeMutation,
  ...(input.transport?{transport:input.transport}:{}),
 });
 let result;
 try{
  result=await client.upload(bytes,metadata.mime,options,{operationId:row.id,stepId:row.id});
 }catch{
  const current=await input.journal.get(row.id);
  if(current?.state!=='sent') error('PERMIT_DENIED');
  await input.journal.recordOutcome(row.id,{kind:'unknown',
   receipt:{code:'IMAGE_TRANSPORT_EXCEPTION'}});
  return {kind:'held',state:'unknown',reason:'IMAGE_TRANSPORT_EXCEPTION',transferId:row.id};
 }
 if(result.kind!=='success'){
  await input.journal.recordOutcome(row.id,{kind:result.kind,
   receipt:{code:result.code,...(result.requestId?{requestId:result.requestId}:{})}});
  return {kind:'held',state:result.kind,reason:result.code,transferId:row.id};
 }
 const remoteMediaId=imageIdFrom(result.response);
 if(!remoteMediaId){
  await input.journal.recordOutcome(row.id,{kind:'unknown',
   receipt:{code:'IMAGE_RESPONSE_UNVERIFIED',requestId:result.requestId}});
  return {kind:'held',state:'unknown',reason:'IMAGE_RESPONSE_UNVERIFIED',transferId:row.id};
 }
 await input.journal.recordOutcome(row.id,{kind:'acknowledged',remoteMediaId,
  receipt:{requestId:result.requestId,imageId:remoteMediaId}});
 return {kind:'uploaded',remoteMediaId,transferId:row.id};
}

