import 'dotenv/config';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {uploadApprovedArchiveImage} from '../../apps/api/src/archive-clone-media-runner.js';
import {uploadApprovedArchiveVideo,readSucceededArchiveVideoReceipt} from '../../apps/api/src/archive-clone-video-runner.js';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {Pool,migrate} from '@shopee/persistence';
import {ShopListingMediaTransferJournal,ShopListingVideoUploadJournal,transferArchivedImage} from '../../apps/api/src/shop-listing-media-transfer.js';
const schema='test_clone_media_'+randomUUID().replaceAll('-','');
const database=new URL(process.env.DATABASE_URL!);
const localDatabase=['localhost','127.0.0.1'].includes(database.hostname);
const legacyTestDatabase=process.env.INTERNAL_ISOLATED_MODE!=='1'&&localDatabase&&database.port==='5442';
const internalTestDatabase=process.env.INTERNAL_ISOLATED_MODE==='1'&&localDatabase&&database.protocol==='postgres:'
  &&database.port==='5443'&&database.pathname==='/shopee_internal_test'&&database.username==='shopee_internal'
  &&!database.search&&!database.hash;
if(!legacyTestDatabase&&!internalTestDatabase) throw Error('Isolated local PostgreSQL required');
const admin=new Pool({connectionString:process.env.DATABASE_URL});
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
const journal=new ShopListingMediaTransferJournal(pool);
const ids={source:randomUUID(),a:randomUUID(),b:randomUUID(),c:randomUUID(),evidence:randomUUID(),archive:randomUUID()};
const sha=createHash('sha256').update(new Uint8Array([1,2,3])).digest('hex');
beforeAll(async()=>{
 await admin.query('CREATE SCHEMA '+schema); await migrate(pool);
 for(const [id,shop] of [[ids.source,'111'],[ids.a,'222'],[ids.b,'333'],[ids.c,'444']] as const)
  await pool.query("INSERT INTO connections(id,environment,partner_id,shop_id,name,revision,state,expires_at) VALUES($1,'production','777',$2,$2,1,'connected',now()+interval '2 hours')",[id,shop]);
 await pool.query("INSERT INTO seller_knowledge_observations(id,connection_id,kind,subject_key,content_hash,scope,body,observed_at) VALUES($1,$2,'listing','987',$3,'{}',$4,now())",[ids.evidence,ids.source,'a'.repeat(64),{rawItem:{video_info:[{duration:15,video_url:'https://example.invalid/video',thumbnail_url:'https://example.invalid/thumb'}]}}]);
 await pool.query("INSERT INTO shop_listing_archives(id,connection_id,source_shop_id,name,selection) VALUES($1,$2,'111','test','{}')",[ids.archive,ids.source]);
 await pool.query("INSERT INTO shop_listing_archive_items(archive_id,item_id,evidence_id,content_hash,item_status,title,brand_id,model_count,gallery_count,video_count) VALUES($1,'987',$2,$3,'NORMAL','Source','55',1,1,0)",[ids.archive,ids.evidence,'a'.repeat(64)]);
 await pool.query("INSERT INTO shop_listing_media_blobs(sha256,byte_count,mime,storage_path) VALUES($1,3,'image/png','test/cover.png')",[sha]);
 for(const role of ['cover','gallery','description','variation-0'])
  await pool.query("INSERT INTO shop_listing_media_refs(archive_id,item_id,role,ordinal,source_url,blob_sha256,state) VALUES($1,'987',$2,0,'https://example.invalid/source',$3,'stored')",[ids.archive,role,sha]);
});
afterAll(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
const input=(role:import('../../apps/api/src/shop-listing-media-transfer.js').MediaRole,targetConnectionId=ids.a,targetShopId='222')=>({archiveId:ids.archive,sourceItemId:'987',role,ordinal:0,blobSha256:sha,targetConnectionId,targetConnectionRevision:1,targetPartnerId:'777',targetShopId});
it('keeps image receipts separate by role and target shop',async()=>{
 const cover=await journal.reserveImage(input('cover'));
 expect((await journal.reserveImage(input('cover'))).id).toBe(cover.id);
 const gallery=await journal.reserveImage(input('gallery'));
 const desc=await journal.reserveImage(input('description'));
 const variation=await journal.reserveImage(input('variation-0'));
 const other=await journal.reserveImage(input('cover',ids.b,'333'));
 expect(new Set([cover.id,gallery.id,desc.id,variation.id,other.id]).size).toBe(5);
 expect([cover.image_scene,cover.image_ratio]).toEqual(['normal','1:1']);
 expect([gallery.image_scene,gallery.image_ratio]).toEqual(['normal','3:4']);
 expect([desc.image_scene,desc.image_ratio]).toEqual(['desc','']);
 await journal.markSent(cover.id);
 await journal.recordOutcome(cover.id,{kind:'acknowledged',remoteMediaId:'targetCover',receipt:{request_id:'r1'}});
 expect((await journal.reserveImage(input('cover'))).remote_media_id).toBe('targetCover');
 await expect(journal.markSent(cover.id)).rejects.toThrow('MEDIA_TRANSFER_ALREADY_SENT');
});
it('holds ambiguous upload and freezes changed connection',async()=>{
 const gallery=await journal.reserveImage(input('gallery'));
 await journal.markSent(gallery.id);
 await journal.recordOutcome(gallery.id,{kind:'unknown',receipt:{reason:'timeout'}});
 await journal.reconcile(gallery.id,{finding:'absent',evidence:{searched:true}});
 expect((await journal.get(gallery.id))?.state).toBe('held');
 await expect(journal.reserveImage(input('gallery'))).rejects.toThrow('MEDIA_TRANSFER_HELD');
 const variation=await journal.reserveImage(input('variation-0'));
 await pool.query('UPDATE connections SET revision=2 WHERE id=$1',[ids.a]);
 await expect(journal.markSent(variation.id)).rejects.toThrow('MEDIA_TRANSFER_TARGET_CHANGED');
});
it('persists video phase by CAS with scoped keys',async()=>{
 const j=new ShopListingVideoUploadJournal(pool,{environment:'production',partnerId:'777',shopId:'333',sourceItemId:'987',sourceSha256:sha});
 const key=['production','777','333','987',sha].join(':');
 const first={key,revision:0,phase:'planned' as const,nextPart:0};
 await j.save(key,null,first);
 await j.save(key,0,{...first,revision:1,phase:'init_pending'});
 await expect(j.save(key,0,{...first,revision:1,phase:'init_ack'})).rejects.toThrow('MEDIA_VIDEO_CAS_CONFLICT');
 await expect(j.load(key.replace(':333:',':222:'))).rejects.toThrow('MEDIA_VIDEO_SCOPE_MISMATCH');
});


it('pins video receipt to source role, bytes and target shop',async()=>{
 const bytes=new Uint8Array([0,0,0,12,102,116,121,112,0,0,0,0]);
 const videoSha=createHash('sha256').update(bytes).digest('hex');
 await pool.query("INSERT INTO shop_listing_media_blobs(sha256,byte_count,mime,storage_path) VALUES($1,12,'video/mp4','test/video.mp4')",[videoSha]);
 await pool.query("INSERT INTO shop_listing_media_refs(archive_id,item_id,role,ordinal,source_url,blob_sha256,state) VALUES($1,'987','video',0,'https://example.invalid/video',$2,'stored')",[ids.archive,videoSha]);
 const record=await journal.reserveVideo({...input('video',ids.b,'333'),blobSha256:videoSha});
 expect(record.media_kind).toBe('video');
 await journal.markSent(record.id);
 await journal.recordOutcome(record.id,{kind:'unknown',receipt:{phase:'complete',reason:'timeout'}});
 await expect(journal.markSent(record.id)).rejects.toThrow('MEDIA_TRANSFER_ALREADY_SENT');
 await journal.reconcile(record.id,{finding:'found',remoteMediaId:'targetVideo',evidence:{upload_id:'targetVideo',status:'SUCCEEDED'}});
 expect((await journal.get(record.id))?.remote_media_id).toBe('targetVideo');
 const other=await journal.reserveVideo({...input('video',ids.a,'222'),blobSha256:videoSha,targetConnectionRevision:2});
 expect(other.id).not.toBe(record.id);
});


it('runs a scoped image upload once and reuses its receipt',async()=>{
 const inputB=input('description',ids.b,'333');
 let calls=0;
 const transport={scope:{partnerId:'777',shopId:'333'},upload:async()=>{
  calls++;return {kind:'success' as const,requestId:'r1',response:{image_info:{image_id:'newImage'}}};
 }};
 const first=await transferArchivedImage(journal,inputB,new Uint8Array([1,2,3]),'image/png',transport);
 expect(first).toEqual({kind:'uploaded',remoteMediaId:'newImage'});
 const again=await transferArchivedImage(journal,inputB,new Uint8Array([1,2,3]),'image/png',transport);
 expect(again).toEqual({kind:'reused',remoteMediaId:'newImage'});
 expect(calls).toBe(1);
});
it('holds transport exceptions and never retries an ambiguous image',async()=>{
 const inputB=input('gallery',ids.b,'333');
 let calls=0;
 const transport={scope:{partnerId:'777',shopId:'333'},upload:async()=>{
  calls++;throw Error('timeout');
 }};
 expect((await transferArchivedImage(journal,inputB,new Uint8Array([1,2,3]),'image/png',transport)).kind).toBe('held');
 expect((await transferArchivedImage(journal,inputB,new Uint8Array([1,2,3]),'image/png',transport)).kind).toBe('held');
 expect(calls).toBe(1);
});


const pilotScope=()=>({
 archiveId:ids.archive,sourceShopId:'111',sourceItemId:'987',
 sourceObservationHash:'a'.repeat(64),sourceHasVariations:true,
 targetShopId:'444',connectionId:ids.c,connectionRevision:1,
});
const pilotApproval=(role:'cover'|'gallery',ordinal=0)=>({
 archiveId:ids.archive,sourceShopId:'111',sourceItemId:'987',
 sourceObservationHash:'a'.repeat(64),targetConnectionId:ids.c,
 targetConnectionRevision:1,targetPartnerId:'777',targetShopId:'444',
 blockers:[],expiresAt:new Date(Date.now()+60000).toISOString(),
 media:[{role,ordinal,sha256:sha}],
});
const pilotCredentials={environment:'production' as const,partnerId:'777',shopId:'444',
 partnerKey:'fixture-key',accessToken:'fixture-token'};
it('requires approved source/ref/connection and uploads a cover to the exact clone scope once',async()=>{
 const path=join(tmpdir(),'pilot-cover-'+randomUUID()+'.png');
 await writeFile(path,new Uint8Array([1,2,3]));
 await pool.query('UPDATE shop_listing_media_blobs SET storage_path=$2 WHERE sha256=$1',[sha,path]);
 await pool.query('UPDATE shop_listing_archives SET completed_at=now() WHERE id=$1',[ids.archive]);
 let calls=0;
 const transport=async()=>{calls++;return new Response(JSON.stringify({
   error:'',request_id:'fixture-1',response:{image_info:{image_id:'targetCover444'}}
 }),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const request={pool,journal,cloneScope:Object.fromEntries(Object.entries(pilotScope()).reverse()) as ReturnType<typeof pilotScope>,approval:pilotApproval('cover'),
   media:{role:'cover' as const,ordinal:0,sha256:sha,blobPath:path},
   credentials:pilotCredentials,transport:transport as typeof fetch};
  expect(await uploadApprovedArchiveImage(request)).toMatchObject({kind:'uploaded',remoteMediaId:'targetCover444'});
  expect(await uploadApprovedArchiveImage(request)).toMatchObject({kind:'reused',remoteMediaId:'targetCover444'});
  expect(calls).toBe(1);
  await expect(uploadApprovedArchiveImage({...request,
   approval:{...request.approval,sourceObservationHash:'b'.repeat(64)}}))
   .rejects.toThrow('ARCHIVE_CLONE_MEDIA_SOURCE');
  await expect(uploadApprovedArchiveImage({...request,
   credentials:{...pilotCredentials,shopId:'222'}}))
   .rejects.toThrow('ARCHIVE_CLONE_MEDIA_TARGET');
  await expect(uploadApprovedArchiveImage({...request,
   approval:{...request.approval,targetConnectionRevision:2}}))
   .rejects.toThrow('ARCHIVE_CLONE_MEDIA_TARGET');
  await pool.query("UPDATE connections SET expires_at=now()-interval '1 minute' WHERE id=$1",[ids.c]);
  try{await expect(uploadApprovedArchiveImage(request)).rejects.toThrow('ARCHIVE_CLONE_MEDIA_TARGET');}
  finally{await pool.query("UPDATE connections SET expires_at=now()+interval '2 hours' WHERE id=$1",[ids.c]);}
  await expect(uploadApprovedArchiveImage({...request,
   media:{...request.media,role:'gallery' as const}}))
   .rejects.toThrow('ARCHIVE_CLONE_MEDIA_ROLE');
  expect(calls).toBe(1);
 }finally{await unlink(path);}
});
it('persists ambiguous production transport response and never resends',async()=>{
 const path=join(tmpdir(),'pilot-gallery-'+randomUUID()+'.png');
 await writeFile(path,new Uint8Array([1,2,3]));
 await pool.query('UPDATE shop_listing_media_blobs SET storage_path=$2 WHERE sha256=$1',[sha,path]);
 let calls=0;
 const transport=async()=>{calls++;throw Error('network timeout');};
 try{
  const request={pool,journal,cloneScope:pilotScope(),approval:pilotApproval('gallery'),
   media:{role:'gallery' as const,ordinal:0,sha256:sha,blobPath:path},
   credentials:pilotCredentials,transport:transport as typeof fetch};
  expect((await uploadApprovedArchiveImage(request)).kind).toBe('held');
  expect((await uploadApprovedArchiveImage(request)).kind).toBe('held');
  expect(calls).toBe(1);
 }finally{await unlink(path);}
});


it('does not claim a reserved upload after the target token expires',async()=>{
 const row=await journal.reserveImage(input('variation-0',ids.b,'333'));
 await pool.query("UPDATE connections SET expires_at=now()-interval '1 minute' WHERE id=$1",[ids.b]);
 try{
  await expect(journal.markSent(row.id)).rejects.toThrow('MEDIA_TRANSFER_TARGET_CHANGED');
  expect((await journal.get(row.id))?.state).toBe('reserved');
 }finally{
  await pool.query("UPDATE connections SET expires_at=now()+interval '2 hours' WHERE id=$1",[ids.b]);
 }
});


const videoBlob=new Uint8Array([0,0,0,12,102,116,121,112,0,0,0,0]);
const videoSha=createHash('sha256').update(videoBlob).digest('hex');
const videoUrl='https://example.invalid/video';
const videoInfo={duration:15,video_url:videoUrl,thumbnail_url:'https://example.invalid/thumb'};
const videoApproval=(shopId:string,connectionId:string,revision:number)=>({
 archiveId:ids.archive,sourceShopId:'111',sourceItemId:'987',
 sourceObservationHash:'a'.repeat(64),targetConnectionId:connectionId,
 targetConnectionRevision:revision,targetPartnerId:'777',targetShopId:shopId,
 blockers:[],expiresAt:new Date(Date.now()+60000).toISOString(),
 media:[{role:'video' as const,ordinal:0,sha256:videoSha}],
});
const videoScope=(shopId:string,connectionId:string,revision:number)=>({
 archiveId:ids.archive,sourceShopId:'111',sourceItemId:'987',
 sourceObservationHash:'a'.repeat(64),sourceHasVariations:true,
 targetShopId:shopId,connectionId,connectionRevision:revision,
});
const videoRequest=(shopId:string,connectionId:string,revision:number,path:string,transport:typeof fetch)=>({
 pool,journal,approval:videoApproval(shopId,connectionId,revision),
 cloneScope:videoScope(shopId,connectionId,revision),
 media:{role:'video' as const,ordinal:0,sha256:videoSha,blobPath:path},
 credentials:{environment:'production' as const,partnerId:'777',shopId,
  partnerKey:'fixture-key',accessToken:'fixture-token'},transport,
});
const videoWire=(response:Record<string,unknown>,requestId:string)=>new Response(
 JSON.stringify({error:'',message:'',request_id:requestId,response}),
 {status:200,headers:{'content-type':'application/json'}});
async function setupVideoFixture(path:string){
 await writeFile(path,videoBlob);
 await pool.query('UPDATE shop_listing_media_blobs SET storage_path=$2 WHERE sha256=$1',[videoSha,path]);
 await pool.query('UPDATE shop_listing_archives SET completed_at=now() WHERE id=$1',[ids.archive]);
}
it('uploads scoped video through init/part/complete/status and reuses only SUCCEEDED receipt',async()=>{
 const path=join(tmpdir(),'pilot-video-'+randomUUID()+'.mp4');
 await setupVideoFixture(path);
 let calls=0;
 const transport=(async()=>{
  calls++;
  if(calls===1)return videoWire({video_upload_id:'targetUpload444'},'init-1');
  if(calls===2)return videoWire({},'part-1');
  if(calls===3)return videoWire({},'complete-1');
  if(calls===4)return videoWire({status:'SUCCEEDED',video_info:{
   duration:15,video_url_list:[{video_url:'https://example.invalid/target'}],
   thumbnail_url_list:[{image_url:'https://example.invalid/target-thumb'}],
  }},'status-1');
  throw Error('unexpected extra upload');
 }) as typeof fetch;
 const request=videoRequest('444',ids.c,1,path,transport);
 try{
  await expect(readSucceededArchiveVideoReceipt(request)).rejects.toThrow('ARCHIVE_CLONE_VIDEO_RECEIPT_MISSING');
  const result=await uploadApprovedArchiveVideo(request);
  expect(await readSucceededArchiveVideoReceipt(request)).toMatchObject({uploadId:'targetUpload444',status:'SUCCEEDED',sourceSha256:videoSha,targetShopId:'444'});
  expect(result).toMatchObject({kind:'uploaded',uploadId:'targetUpload444'});
  expect(await uploadApprovedArchiveVideo(request)).toMatchObject({kind:'reused',uploadId:'targetUpload444'});
  expect(calls).toBe(4);
  const receipt=await journal.get(result.transferId);
  expect(receipt).toMatchObject({state:'acknowledged',blob_sha256:videoSha,target_shop_id:'444',
   receipt:{status:'SUCCEEDED',sourceSha256:videoSha,targetShopId:'444'}});
  await expect(uploadApprovedArchiveVideo({...request,
   credentials:{...request.credentials,shopId:'333'}})).rejects.toThrow('ARCHIVE_CLONE_VIDEO_TARGET');
  await expect(uploadApprovedArchiveVideo({...request,
   media:{...request.media,ordinal:1}})).rejects.toThrow('ARCHIVE_CLONE_VIDEO_ROLE');
  await writeFile(path,new Uint8Array([9,9,9]));
  await expect(uploadApprovedArchiveVideo(request)).rejects.toThrow('ARCHIVE_CLONE_VIDEO_BYTES_CHANGED');
 }finally{await unlink(path);}
});
it('holds an ambiguous video part without sending it again',async()=>{
 const path=join(tmpdir(),'pilot-video-ambiguous-'+randomUUID()+'.mp4');
 await setupVideoFixture(path);
 let calls=0;
 const transport=(async()=>{calls++;
  if(calls===1)return videoWire({video_upload_id:'targetUpload222'},'init-2');
  throw Error('ambiguous part');
 }) as typeof fetch;
 const request=videoRequest('222',ids.a,2,path,transport);
 try{
  expect(await uploadApprovedArchiveVideo(request)).toMatchObject({kind:'held',state:'sent'});
  expect(await uploadApprovedArchiveVideo(request)).toMatchObject({kind:'held',state:'sent'});
  expect(calls).toBe(2);
 }finally{await unlink(path);}
});



