import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { canonicalJson, type CloneQcInput } from '@shopee/domain';
import { Pool, migrate } from '@shopee/persistence';
import { ShopListingCloneJournal } from '../../apps/api/src/shop-listing-clone-journal.js';
import type { ArchiveManifest } from '../../packages/domain/src/archive-clone.js';

const schema='test_clone_journal_'+randomUUID().replaceAll('-','');
const database=new URL(process.env.DATABASE_URL!);
if (!['localhost','127.0.0.1'].includes(database.hostname) || database.port!=='5442')
  throw Error('Clone journal integration requires local PostgreSQL 5442.');
const admin=new Pool({connectionString:process.env.DATABASE_URL});
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
const journal=new ShopListingCloneJournal(pool);
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const sourceHash='a'.repeat(64),policyHash='b'.repeat(64),payloadHash='c'.repeat(64);
const archive=JSON.parse(readFileSync('.local/haby-archive-20260930/clone-manifest-9411abc005e25b4185bbd41ea3a07d126fda2a4e624376f18bd4ddeef817c306.json','utf8')) as ArchiveManifest;
const fixture=archive.items.find(i=>i.sourceItemId==='49517062898')!;
const sourceItemId=fixture.sourceItemId;
const ids={sourceConnection:randomUUID(),sourceEvidence:randomUUID(),archive:randomUUID(),
  targetConnection:randomUUID(),secondTarget:randomUUID(),thirdTarget:randomUUID(),fourthTarget:randomUUID(),fifthTarget:randomUUID()};
const clone=<T>(v:T):T=>structuredClone(v);

beforeAll(async()=>{
  await admin.query('CREATE SCHEMA '+schema);
  await migrate(pool);
  for (const [id,shop] of [[ids.sourceConnection,'111'],[ids.targetConnection,'222'],[ids.secondTarget,'333'],
      [ids.thirdTarget,'444'],[ids.fourthTarget,'555'],[ids.fifthTarget,'666']] as const)
    await pool.query('INSERT INTO connections(id,environment,partner_id,shop_id,name,revision,state,expires_at) '+
      "VALUES($1,'production','777',$2,$2,1,'connected',now()+interval '2 hours')",[id,shop]);
  await pool.query('INSERT INTO seller_knowledge_observations '+
    '(id,connection_id,kind,subject_key,content_hash,scope,body,observed_at) '+
    "VALUES($1,$2,'listing',$3,$4,'{}',$5,now())",
    [ids.sourceEvidence,ids.sourceConnection,sourceItemId,sourceHash,
      {rawItem:fixture.rawItem,rawModels:fixture.rawModels}]);
  await pool.query('INSERT INTO shop_listing_archives(id,connection_id,source_shop_id,name,selection) '+
    "VALUES($1,$2,'111','test','{}')",[ids.archive,ids.sourceConnection]);
  await pool.query('INSERT INTO shop_listing_archive_items '+
    '(archive_id,item_id,evidence_id,content_hash,item_status,title,brand_id,model_count,gallery_count,video_count) '+
    "VALUES($1,$2,$3,$4,'NORMAL',$5,$6,0,9,0)",
    [ids.archive,sourceItemId,ids.sourceEvidence,sourceHash,fixture.title,String(fixture.brandId)]);
  for (const m of fixture.media) {
    await pool.query('INSERT INTO shop_listing_media_blobs(sha256,byte_count,mime,storage_path) '+
      'VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[m.sha256,1,m.mime,'test/'+m.sha256]);
    await pool.query('INSERT INTO shop_listing_media_refs '+
      '(archive_id,item_id,role,ordinal,source_media_id,source_url,blob_sha256,state) '+
      "VALUES($1,$2,$3,$4,$5,$6,$7,'stored')",
      [ids.archive,sourceItemId,m.role,m.ordinal,m.sourceMediaId ?? null,'test-url',m.sha256]);
  }
  await pool.query('INSERT INTO shop_listing_archive_aux '+
    '(archive_id,item_id,kind,content_hash,body,observed_at) '+
    "VALUES($1,$2,'promotion',$3,'{}',now())",[ids.archive,sourceItemId,'d'.repeat(64)]);
});
afterAll(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
function input(targetConnectionId:string,targetShopId:string) {
  return {archiveId:ids.archive,sourceItemId,sourceEvidenceId:ids.sourceEvidence,sourceHash,policyHash,
    plannedPayloadHash:payloadHash,targetConnectionId,targetConnectionRevision:1,targetPartnerId:'777',targetShopId};
}
function evidence(targetShopId:string, targetItemId='12345'):CloneQcInput {
  const remote=clone(fixture.rawItem), models=clone(fixture.rawModels!);
  const images=fixture.media.filter(m=>['cover','gallery','description','variation-0'].includes(m.role))
    .map(m=>({role:m.role as 'cover'|'gallery'|'description'|'variation-0',ordinal:m.ordinal,
      sourceSha256:m.sha256,uploadedId:'target-'+m.role+'-'+m.sha256.slice(0,12)}));
  const image=(role:string,sourceId:string)=>images.find(p=>p.role===role&&fixture.media.some(m=>
    m.role===role&&m.sourceMediaId===sourceId&&m.ordinal===p.ordinal))?.uploadedId;
  remote.item_id=Number(targetItemId);remote.item_status='UNLIST';remote.has_promotion=false;
  remote.promotion_image.image_id_list=remote.promotion_image.image_id_list.map((v:string)=>image('cover',v));
  remote.image.image_id_list=remote.image.image_id_list.map((v:string)=>image('gallery',v));
  for (const block of remote.description_info.extended_description.field_list)
    if (block.field_type==='image')block.image_info.image_id=image('description',block.image_info.image_id);
  remote.price_info[0].current_price=remote.price_info[0].original_price;
  remote.price_info[0].inflated_price_of_current_price=remote.price_info[0].original_price;
  const qty=remote.stock_info_v2.summary_info.total_available_stock;
  remote.stock_info_v2.summary_info.total_reserved_stock=0;
  remote.stock_info_v2.seller_stock=[{stock:qty,location_id:'TARGET',if_saleable:true}];
  const manifest={...archive,archiveId:ids.archive,sourceShopId:'111',items:[clone(fixture)]};
  return {manifest,sourceItemId,sourceObservationHash:fixture.observationHash,targetShopId,
    targetCategoryId:fixture.categoryId,targetBrandId:fixture.brandId,
    targetLocationBySku:{[fixture.sourceItemSku]:'TARGET'},
    targetLogisticIdBySourceId:Object.fromEntries(remote.logistic_info.map((l:any)=>[String(l.logistic_id),String(l.logistic_id)])),
    images,readbacks:[
      {captureId:'get-1',observedAt:'2026-09-30T08:00:00Z',shopId:targetShopId,item:clone(remote),models:clone(models)},
      {captureId:'get-2',observedAt:'2026-09-30T08:00:01Z',shopId:targetShopId,item:remote,models}
    ]};
}
async function seedImageReceipts(targetConnectionId:string,targetShopId:string,revision=1) {
  const proofs=evidence(targetShopId).images;
  const seen=new Set<string>();
  for (const p of proofs) {
    const key=p.role+':'+p.sourceSha256;
    if (seen.has(key)) continue;
    seen.add(key);
    const scene=p.role==='description'?'desc':'normal';
    const ratio=p.role==='gallery'?'3:4':p.role==='description'?'':'1:1';
    await pool.query('INSERT INTO shop_listing_media_transfers '+
      '(id,archive_id,source_item_id,source_role,source_ordinal,blob_sha256,media_kind,'+
      'image_scene,image_ratio,target_connection_id,target_connection_revision,target_partner_id,target_shop_id,'+
      'state,remote_media_id,receipt,receipt_hash,sent_at,recorded_at) '+
      "VALUES($1,$2,$3,$4,$5,$6,'image',$7,$8,$9,$13,'777',$10,'acknowledged',$11,'{}',$12,now(),now())",
      [randomUUID(),ids.archive,sourceItemId,p.role,p.ordinal,p.sourceSha256,scene,ratio,
       targetConnectionId,targetShopId,p.uploadedId,hash({}),revision]);
  }
}
async function createToQc(targetConnectionId:string,targetShopId:string,targetItemId:string) {
  const intent=await journal.reserve(input(targetConnectionId,targetShopId));
  await seedImageReceipts(targetConnectionId,targetShopId);
  const step=await journal.authorizeStep(intent.id,{stepKey:'create',ordinal:1,kind:'create',requestHash:payloadHash});
  await journal.markSent(step.id);
  await journal.recordOutcome(step.id,'acknowledged',{request_id:'create'},targetItemId);
  return intent;
}
it('pins source projection and target; ambiguous create is reconciled without a second send',async()=>{
  const first=await journal.reserve(input(ids.targetConnection,'222'));
  expect((await journal.reserve(input(ids.targetConnection,'222'))).id).toBe(first.id);
  await expect(journal.reserve({...input(ids.targetConnection,'222'),policyHash:'e'.repeat(64)}))
    .rejects.toThrow('INTENT_ALREADY_RESERVED_DIFFERENT_PLAN');
  await expect(journal.reserve({...input(ids.targetConnection,'222'),expectedProjectionHash:'f'.repeat(64)}))
    .rejects.toThrow('SOURCE_PROJECTION_MISMATCH');
  const second=await journal.reserve(input(ids.secondTarget,'333'));
  expect(second.id).not.toBe(first.id);
  const image=await journal.authorizeStep(first.id,{stepKey:'image:0',ordinal:1,kind:'image',requestHash:'e'.repeat(64)});
  await journal.markSent(image.id);await journal.recordOutcome(image.id,'acknowledged',{request_id:'image'});
  const video=await journal.authorizeStep(first.id,{stepKey:'video:0',ordinal:2,kind:'video',requestHash:'f'.repeat(64)});
  await journal.markSent(video.id);await journal.recordOutcome(video.id,'acknowledged',{request_id:'video'});
  const create=await journal.authorizeStep(first.id,{stepKey:'create',ordinal:3,kind:'create',requestHash:payloadHash});
  await journal.markSent(create.id);
  await expect(journal.markSent(create.id)).rejects.toThrow('STEP_ALREADY_SENT_OR_HELD');
  await journal.recordOutcome(create.id,'unknown',{network:'timeout'});
  await expect(journal.authorizeStep(first.id,{stepKey:'create-again',ordinal:4,kind:'create',requestHash:payloadHash}))
    .rejects.toThrow('INTENT_NOT_WRITABLE');
  await journal.reconcile(create.id,{finding:'found',targetItemId:'12345',
    evidence:{status:'UNLIST',item_id:'12345'},observedAt:new Date().toISOString()});
  await expect(journal.recordQc(first.id,{targetItemId:'12345',evidence:evidence('222'),
    readbackHash:'f'.repeat(64)})).rejects.toThrow('READBACK_HASH_MISMATCH');
  const altered=evidence('222');
  altered.manifest.items[0]!.rawItem.item_name='tampered';
  await expect(journal.recordQc(first.id,{targetItemId:'12345',evidence:altered}))
    .rejects.toThrow('QC_SOURCE_EVIDENCE_MISMATCH');
  await seedImageReceipts(ids.targetConnection,'222');
  const forged=evidence('222');
  forged.images[0]!.uploadedId='forged-id';
  await expect(journal.recordQc(first.id,{targetItemId:'12345',evidence:forged}))
    .rejects.toThrow('QC_MEDIA_RECEIPT_MISMATCH');
  const wrongOrdinal=evidence('222');
  wrongOrdinal.images[0]!.ordinal+=100;
  await expect(journal.recordQc(first.id,{targetItemId:'12345',evidence:wrongOrdinal}))
    .rejects.toThrow('QC_MEDIA_RECEIPT_MISMATCH');
  const forgedVideo=evidence('222');
  forgedVideo.video={sourceSha256:'f'.repeat(64),sourceItemId,targetShopId:'222',
    uploadId:'fabricated',status:'SUCCEEDED',targetUrl:'https://target.invalid/video'};
  await expect(journal.recordQc(first.id,{targetItemId:'12345',evidence:forgedVideo}))
    .rejects.toThrow('QC_VIDEO_PROOF_MISSING');
  const qc=await journal.recordQc(first.id,{targetItemId:'12345',evidence:evidence('222')});
  expect(qc.result).toBe('verified');
  expect(qc.readback_hash).not.toBe(qc.expected_projection_hash);
  expect(qc.normalized_expected_hash).toBe(qc.normalized_observed_hash);
  expect(qc.comparator_result.verified).toBe(true);
  expect((await journal.get(first.id))?.intent.state).toBe('verified');
  await expect(journal.recordQc(first.id,{targetItemId:'12345',evidence:evidence('222')}))
    .rejects.toThrow('QC_NOT_READY');
});
it('does not accept caller claims or price drift as verified',async()=>{
  const intent=await createToQc(ids.secondTarget,'333','54321');
  const proof=evidence('333','54321');
  proof.readbacks[0].item.price_info[0].original_price+=1;
  proof.readbacks[1].item.price_info[0].original_price+=1;
  const qc=await journal.recordQc(intent.id,{targetItemId:'54321',evidence:proof});
  expect(qc.result).toBe('mismatch');
  expect(qc.normalized_expected_hash).not.toBe(qc.normalized_observed_hash);
  expect(qc.comparator_result.mismatchedPaths).toContain('models.parent.original_price');
  expect((await journal.get(intent.id))?.intent.state).toBe('held');
  await new Promise(resolve=>setTimeout(resolve,100));
  const fresh=evidence('333','54321');
  fresh.readbacks[0].captureId='recheck-1';
  fresh.readbacks[1].captureId='recheck-2';
  fresh.readbacks[0].observedAt=new Date().toISOString();
  fresh.readbacks[1].observedAt=new Date().toISOString();
  const bad=clone(fresh);
  bad.images[0]!.uploadedId='forged-cover';
  await expect(journal.recordQcRecheck(intent.id,{targetItemId:'54321',evidence:bad}))
    .rejects.toThrow('QC_MEDIA_RECEIPT_MISMATCH');
  const followup=await journal.recordQcRecheck(intent.id,{targetItemId:'54321',evidence:fresh});
  expect(followup.result).toBe('verified');
  expect(followup.attempt_no).toBe(1);
  const recorded=await journal.get(intent.id);
  expect(recorded?.intent.state).toBe('verified');
  expect(recorded?.qc?.result).toBe('mismatch');
  expect(recorded?.rechecks).toHaveLength(1);
  expect(recorded?.rechecks[0].proof.images).toHaveLength(fresh.images.length);
  await expect(journal.recordQcRecheck(intent.id,{targetItemId:'54321',evidence:fresh}))
    .rejects.toThrow('QC_NOT_READY');
});
it('freezes sent request when connection revision changes',async()=>{
  const intent=await journal.reserve(input(ids.thirdTarget,'444'));
  const step=await journal.authorizeStep(intent.id,{stepKey:'create',ordinal:1,kind:'create',requestHash:payloadHash});
  await pool.query("UPDATE connections SET expires_at=now()+interval '30 seconds' WHERE id=$1",[ids.thirdTarget]);
  await expect(journal.markSent(step.id)).rejects.toThrow('TARGET_TOKEN_EXPIRING');
  await pool.query("UPDATE connections SET expires_at=now()+interval '2 hours',revision=2 WHERE id=$1",[ids.thirdTarget]);
  await expect(journal.markSent(step.id)).rejects.toThrow('TARGET_CHANGED');
  expect((await journal.get(intent.id))?.steps[0].state).toBe('authorized');
});
it('rejects ACK images from a different connection revision',async()=>{
  const intent=await journal.reserve(input(ids.fifthTarget,'666'));
  const step=await journal.authorizeStep(intent.id,{stepKey:'create',ordinal:1,kind:'create',requestHash:payloadHash});
  await journal.markSent(step.id);
  await journal.recordOutcome(step.id,'acknowledged',{request_id:'created'},'66666');
  await seedImageReceipts(ids.fifthTarget,'666',2);
  await expect(journal.recordQc(intent.id,{targetItemId:'66666',evidence:evidence('666','66666')}))
    .rejects.toThrow('QC_MEDIA_RECEIPT_MISMATCH');
  expect((await journal.get(intent.id))?.intent.state).toBe('needs_qc');
});
it('keeps absent reconciliation held; no replacement create',async()=>{
  const intent=await journal.reserve(input(ids.fourthTarget,'555'));
  const step=await journal.authorizeStep(intent.id,{stepKey:'create',ordinal:1,kind:'create',requestHash:payloadHash});
  await journal.markSent(step.id);await journal.recordOutcome(step.id,'unknown',{network:'timeout'});
  await journal.reconcile(step.id,{finding:'absent',evidence:{scanned:true},observedAt:new Date().toISOString()});
  expect((await journal.get(intent.id))?.intent.state).toBe('held');
  await expect(journal.authorizeStep(intent.id,{stepKey:'create-retry',ordinal:2,kind:'create',requestHash:payloadHash}))
    .rejects.toThrow('INTENT_NOT_WRITABLE');
});

