import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {canonicalJson} from '@shopee/domain';
import {transaction} from '@shopee/persistence';
import type {VideoJournalEntry,VideoUploadJournal} from '../../../packages/shopee/src/video-upload.js';

const hashPattern=/^[a-f0-9]{64}$/;
const idPattern=/^[1-9][0-9]*$/;
const mediaIdPattern=/^[A-Za-z0-9_.:-]{1,512}$/;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail=(code:string):never=>{throw new Error('MEDIA_'+code);};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const evidence=(value:unknown)=>{
 if(!object(value)) fail('TRANSFER_EVIDENCE_INVALID');
 const copy=JSON.parse(JSON.stringify(value));
 if(!object(copy)) fail('TRANSFER_EVIDENCE_INVALID');
 return copy as Record<string,unknown>;
};
export type MediaRole='cover'|'gallery'|'description'|'video'|'video-thumbnail'|`variation-${number}`;
export type MediaTransferInput={
 archiveId:string; sourceItemId:string; role:MediaRole; ordinal:number; blobSha256:string;
 targetConnectionId:string; targetConnectionRevision:number; targetPartnerId:string; targetShopId:string;
};
export type ImageUploadOutcome=
 |{kind:'acknowledged';remoteMediaId:string;receipt:Record<string,unknown>}
 |{kind:'rejected'|'unknown';receipt:Record<string,unknown>};
export type MediaReconciliation={
 finding:'found'|'absent'|'inconclusive';remoteMediaId?:string;evidence:Record<string,unknown>;
};
function imageProfile(role:string):{scene:'normal'|'desc';ratio:''|'1:1'|'3:4'}{
 if(role==='cover'||role==='video-thumbnail'||/^variation-[0-9]+$/.test(role))
  return {scene:'normal',ratio:'1:1'};
 if(role==='gallery') return {scene:'normal',ratio:'3:4'};
 if(role==='description') return {scene:'desc',ratio:''};
 return fail('TRANSFER_ROLE_INVALID');
}
function validate(input:MediaTransferInput,kind:'image'|'video'){
 if(!uuidPattern.test(input.archiveId)||!uuidPattern.test(input.targetConnectionId)||
 !idPattern.test(input.sourceItemId)||!idPattern.test(input.targetPartnerId)||
 !idPattern.test(input.targetShopId)||!hashPattern.test(input.blobSha256)||
 !Number.isSafeInteger(input.ordinal)||input.ordinal<0||
 !Number.isSafeInteger(input.targetConnectionRevision)||input.targetConnectionRevision<1)
  fail('TRANSFER_INPUT_INVALID');
 if(kind==='image') imageProfile(input.role);
 else if(input.role!=='video') fail('TRANSFER_ROLE_INVALID');
}
async function checkedTarget(client:any,input:MediaTransferInput){
 const target=(await client.query(
  'SELECT environment,partner_id,shop_id,revision,state,expires_at FROM connections WHERE id=$1 FOR SHARE',
  [input.targetConnectionId])).rows[0];
 if(!target||target.environment!=='production'||target.partner_id!==input.targetPartnerId||
  target.shop_id!==input.targetShopId||target.revision!==input.targetConnectionRevision||
  target.state!=='connected'||!target.expires_at||
  new Date(target.expires_at).getTime()<=Date.now()+60_000) fail('TRANSFER_TARGET_CHANGED');
}
/** Persistence boundary. The caller still must verify the local bytes, scope and preflight before invoking a transport. */
export class ShopListingMediaTransferJournal{
 constructor(private readonly pool:Pool){}
 async reserveImage(input:MediaTransferInput){return this.reserve(input,'image');}
 async reserveVideo(input:MediaTransferInput){return this.reserve(input,'video');}
 private async reserve(input:MediaTransferInput,kind:'image'|'video'){
  validate(input,kind);
  const profile=kind==='image'?imageProfile(input.role):{scene:'',ratio:''};
  return transaction(this.pool,async client=>{
   const source=(await client.query(
    `SELECT r.state,r.blob_sha256,b.mime,b.byte_count,a.source_shop_id
     FROM shop_listing_media_refs r JOIN shop_listing_media_blobs b ON b.sha256=r.blob_sha256
     JOIN shop_listing_archives a ON a.id=r.archive_id
     WHERE r.archive_id=$1 AND r.item_id=$2 AND r.role=$3 AND r.ordinal=$4 FOR SHARE OF r,b,a`,
    [input.archiveId,input.sourceItemId,input.role,input.ordinal])).rows[0];
   if(!source||source.state!=='stored'||source.blob_sha256!==input.blobSha256||
    source.source_shop_id===input.targetShopId||
    source.byte_count<=0||
    (kind==='image'?!['image/png','image/jpeg'].includes(source.mime)||Number(source.byte_count)>10_000_000:
      source.mime!=='video/mp4'||Number(source.byte_count)>=30_000_000)) fail('TRANSFER_SOURCE_CHANGED');
   await checkedTarget(client,input);
   const created=(await client.query(
    `INSERT INTO shop_listing_media_transfers
     (id,archive_id,source_item_id,source_role,source_ordinal,blob_sha256,media_kind,
      image_scene,image_ratio,target_connection_id,target_connection_revision,
      target_partner_id,target_shop_id)
     VALUES($1,$2,$3,$4,$5,$6,$13,$7,$8,$9,$10,$11,$12)
     ON CONFLICT(target_partner_id,target_shop_id,blob_sha256,source_role,media_kind,image_scene,image_ratio)
     DO NOTHING RETURNING *`,
    [randomUUID(),input.archiveId,input.sourceItemId,input.role,input.ordinal,input.blobSha256,
     profile.scene,profile.ratio,input.targetConnectionId,input.targetConnectionRevision,
     input.targetPartnerId,input.targetShopId,kind])).rows[0];
   const row=created??(await client.query(
    `SELECT * FROM shop_listing_media_transfers
     WHERE target_partner_id=$1 AND target_shop_id=$2 AND blob_sha256=$3 AND source_role=$4
       AND media_kind=$7 AND image_scene=$5 AND image_ratio=$6 FOR UPDATE`,
    [input.targetPartnerId,input.targetShopId,input.blobSha256,input.role,profile.scene,profile.ratio,kind])).rows[0];
   if(!row) fail('TRANSFER_RESERVATION_FAILED');
   if(row.state==='held'||row.state==='rejected') fail('TRANSFER_HELD');
   if(row.state!=='acknowledged'&&
      (row.target_connection_id!==input.targetConnectionId||
       row.target_connection_revision!==input.targetConnectionRevision))
    fail('TRANSFER_TARGET_CHANGED');
   return {...row,source_mime:source.mime,source_byte_count:Number(source.byte_count)};
  });
 }
 async markSent(id:string){
  if(!uuidPattern.test(id)) fail('TRANSFER_ID_INVALID');
  return transaction(this.pool,async client=>{
   const row=(await client.query('SELECT * FROM shop_listing_media_transfers WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!row||row.state!=='reserved') fail('TRANSFER_ALREADY_SENT');
   await checkedTarget(client,{
    archiveId:row.archive_id,sourceItemId:row.source_item_id,role:row.source_role,
    ordinal:row.source_ordinal,blobSha256:row.blob_sha256,
    targetConnectionId:row.target_connection_id,targetConnectionRevision:row.target_connection_revision,
    targetPartnerId:row.target_partner_id,targetShopId:row.target_shop_id,
   });
   const source=(await client.query(
    `SELECT r.state,r.blob_sha256,b.mime,b.byte_count FROM shop_listing_media_refs r
     JOIN shop_listing_media_blobs b ON b.sha256=r.blob_sha256
     WHERE r.archive_id=$1 AND r.item_id=$2 AND r.role=$3 AND r.ordinal=$4 FOR SHARE OF r,b`,
    [row.archive_id,row.source_item_id,row.source_role,row.source_ordinal])).rows[0];
   if(!source||source.state!=='stored'||source.blob_sha256!==row.blob_sha256||
    (row.media_kind==='image'?!['image/png','image/jpeg'].includes(source.mime)||Number(source.byte_count)>10_000_000:
      source.mime!=='video/mp4'||Number(source.byte_count)>=30_000_000))
    fail('TRANSFER_SOURCE_CHANGED');
   return (await client.query(
    "UPDATE shop_listing_media_transfers SET state='sent',sent_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];
  });
 }
 async recordOutcome(id:string,outcome:ImageUploadOutcome){
  if(!uuidPattern.test(id)||!object(outcome)) fail('TRANSFER_INPUT_INVALID');
  if(outcome.kind==='acknowledged'&&!mediaIdPattern.test(outcome.remoteMediaId))
   fail('TRANSFER_REMOTE_ID_INVALID');
  if(!['acknowledged','unknown','rejected'].includes(outcome.kind))
   fail('TRANSFER_OUTCOME_INVALID');
  const receipt=evidence(outcome.receipt);
  return transaction(this.pool,async client=>{
   const row=(await client.query('SELECT * FROM shop_listing_media_transfers WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!row||row.state!=='sent') fail('TRANSFER_OUTCOME_ALREADY_RECORDED');
   return (await client.query(
    `UPDATE shop_listing_media_transfers SET state=$2,remote_media_id=$3,receipt=$4,
      receipt_hash=$5,recorded_at=now() WHERE id=$1 RETURNING *`,
    [id,outcome.kind,outcome.kind==='acknowledged'?outcome.remoteMediaId:null,receipt,digest(receipt)])).rows[0];
  });
 }
 async reconcile(id:string,input:MediaReconciliation){
  if(!uuidPattern.test(id)||!['found','absent','inconclusive'].includes(input.finding)||
   (input.finding==='found'?!mediaIdPattern.test(input.remoteMediaId??''):input.remoteMediaId!==undefined))
   fail('TRANSFER_RECONCILIATION_INVALID');
  const proof=evidence(input.evidence);
  return transaction(this.pool,async client=>{
   const row=(await client.query('SELECT * FROM shop_listing_media_transfers WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!row||row.state!=='unknown') fail('TRANSFER_NOT_UNKNOWN');
   const next=input.finding==='found'?'acknowledged':'held';
   const reconciliation={finding:input.finding,evidence:proof,evidenceHash:digest(proof)};
   return (await client.query(
    `UPDATE shop_listing_media_transfers SET state=$2,remote_media_id=$3,
      reconciliation=$4,reconciled_at=now() WHERE id=$1 RETURNING *`,
    [id,next,input.finding==='found'?input.remoteMediaId:null,reconciliation])).rows[0];
  });
 }
 async get(id:string){
  if(!uuidPattern.test(id)) fail('TRANSFER_ID_INVALID');
  return (await this.pool.query('SELECT * FROM shop_listing_media_transfers WHERE id=$1',[id])).rows[0]??null;
 }
}
/** PostgreSQL CAS implementation for runVideoUpload. Scoped to one target and source blob. */
export class ShopListingVideoUploadJournal implements VideoUploadJournal{
 private readonly key:string;
 constructor(private readonly pool:Pool,scope:{
  environment:'production';partnerId:string;shopId:string;sourceItemId:string;sourceSha256:string;
 }){
  if(!idPattern.test(scope.partnerId)||!idPattern.test(scope.shopId)||
   !idPattern.test(scope.sourceItemId)||!hashPattern.test(scope.sourceSha256))
   fail('VIDEO_SCOPE_INVALID');
  this.key=[scope.environment,scope.partnerId,scope.shopId,scope.sourceItemId,scope.sourceSha256].join(':');
 }
 private check(key:string){if(key!==this.key) fail('VIDEO_SCOPE_MISMATCH');}
 async load(key:string):Promise<VideoJournalEntry|null>{
  this.check(key);
  const row=(await this.pool.query(
   'SELECT entry,revision FROM shop_listing_video_upload_entries WHERE key=$1',[key])).rows[0];
  if(!row) return null;
  if(row.entry?.key!==key||row.entry?.revision!==row.revision) fail('VIDEO_JOURNAL_CORRUPT');
  return row.entry as VideoJournalEntry;
 }
 async save(key:string,expectedRevision:number|null,next:VideoJournalEntry):Promise<void>{
  this.check(key);
  if(next.key!==key||!Number.isSafeInteger(next.revision)||next.revision<0||
   !Number.isSafeInteger(next.nextPart)||next.nextPart<0||
   (expectedRevision===null?next.revision!==0:next.revision!==expectedRevision+1))
   fail('VIDEO_ENTRY_INVALID');
  const parts=key.split(':');
  if(expectedRevision===null){
   const result=await this.pool.query(
    `INSERT INTO shop_listing_video_upload_entries
     (key,target_partner_id,target_shop_id,source_item_id,blob_sha256,revision,entry)
     VALUES($1,$2,$3,$4,$5,0,$6) ON CONFLICT(key) DO NOTHING`,
    [key,parts[1],parts[2],parts[3],parts[4],next]);
   if(result.rowCount!==1) fail('VIDEO_CAS_CONFLICT');
  }else{
   const result=await this.pool.query(
    `UPDATE shop_listing_video_upload_entries SET revision=$3,entry=$4,updated_at=now()
     WHERE key=$1 AND revision=$2`,[key,expectedRevision,next.revision,next]);
   if(result.rowCount!==1) fail('VIDEO_CAS_CONFLICT');
  }
 }
}


export type ScopedImageTransport={
 scope:{partnerId:string;shopId:string};
 upload:(bytes:Uint8Array,mime:'image/png'|'image/jpeg',
  options:{scene:'normal'|'desc';ratio?:'1:1'|'3:4'})=>Promise<
   |{kind:'success';requestId:string;response:Record<string,unknown>}
   |{kind:'rejected'|'unknown';code:string;requestId?:string}
  >;
};
export type ImageTransferResult=
 |{kind:'uploaded'|'reused';remoteMediaId:string}
 |{kind:'held';state:string;reason:string};
/** Explicitly invoked by a writer only after target/source preflight. Never retries a sent upload. */
export async function transferArchivedImage(
 journal:ShopListingMediaTransferJournal,input:MediaTransferInput,bytes:Uint8Array,
 mime:'image/png'|'image/jpeg',transport:ScopedImageTransport,
):Promise<ImageTransferResult>{
 const row=await journal.reserveImage(input);
 if(row.state==='acknowledged'){
  if(!mediaIdPattern.test(row.remote_media_id)) fail('TRANSFER_RECEIPT_CORRUPT');
  return {kind:'reused',remoteMediaId:row.remote_media_id};
 }
 if(row.state!=='reserved') return {kind:'held',state:row.state,reason:'PREVIOUS_UPLOAD_UNRESOLVED'};
 if(transport.scope.partnerId!==input.targetPartnerId||transport.scope.shopId!==input.targetShopId)
  fail('TRANSFER_TARGET_MISMATCH');
 if(!(bytes instanceof Uint8Array)||bytes.length!==row.source_byte_count||
  createHash('sha256').update(bytes).digest('hex')!==input.blobSha256||
  mime!==row.source_mime) fail('TRANSFER_BYTES_CHANGED');
 const profile=imageProfile(input.role);
 await journal.markSent(row.id);
 let response:Awaited<ReturnType<ScopedImageTransport['upload']>>;
 try{
  response=await transport.upload(Uint8Array.from(bytes),mime,{
   scene:profile.scene,...(profile.ratio?{ratio:profile.ratio}:{}),
  });
 }catch{
  await journal.recordOutcome(row.id,{kind:'unknown',receipt:{code:'IMAGE_TRANSPORT_UNKNOWN'}});
  return {kind:'held',state:'unknown',reason:'IMAGE_TRANSPORT_UNKNOWN'};
 }
 if(response.kind!=='success'){
  await journal.recordOutcome(row.id,{kind:response.kind,
   receipt:{code:response.code,...(response.requestId?{requestId:response.requestId}:{})}});
  return {kind:'held',state:response.kind,reason:response.code};
 }
 const info=object(response.response.image_info)?response.response.image_info:undefined;
 const list=Array.isArray(response.response.image_info_list)?response.response.image_info_list:undefined;
 const listed=list?.length===1&&object(list[0])&&list[0].error===null&&
  object(list[0].image_info)?list[0].image_info:undefined;
 const ids=[info?.image_id,listed?.image_id].filter(
  (id):id is string=>typeof id==='string'&&mediaIdPattern.test(id));
 if(ids.length===0||new Set(ids).size!==1||
   (response.response.image_info!==undefined&&!info)||
   (response.response.image_info_list!==undefined&&!listed)){
  await journal.recordOutcome(row.id,{kind:'unknown',
   receipt:{code:'IMAGE_RESPONSE_UNVERIFIED',requestId:response.requestId}});
  return {kind:'held',state:'unknown',reason:'IMAGE_RESPONSE_UNVERIFIED'};
 }
 await journal.recordOutcome(row.id,{kind:'acknowledged',remoteMediaId:ids[0]!,
  receipt:{requestId:response.requestId,imageId:ids[0]!}});
 return {kind:'uploaded',remoteMediaId:ids[0]!};
}

