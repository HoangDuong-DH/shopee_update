import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { ProductionPreparationService } from '../../apps/api/src/production-preparation-service.js';
import { ProductionPreparationExecution } from '../../apps/api/src/production-preparation-execution.js';
import { productionBatchPass1Root, loadProductionBatchSource } from '../../apps/api/src/production-batch-source.js';

const schema = 'test_production_preparation_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
const repo = new Repository(pool);
let root: string, blobs: BlobStore;
beforeAll(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); root = await mkdtemp(resolve(productionBatchPass1Root, 'preparation-test-')); blobs = new BlobStore(root); });
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function setup(count = 1) {
  const priceId = randomUUID(), imageId = randomUUID();
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Bảng giá');
  workbook.creator=priceId;
  sheet.getCell('A2').value = 'SKU'; sheet.getCell('B2').value = 125000;
  const priceBytes = Buffer.from(await workbook.xlsx.writeBuffer()), priceSha = await blobs.put(priceBytes);
  await pool.query('INSERT INTO source_files(id,sha256,filename,kind,bytes,status,body) VALUES($1,$2,$3,$4,$5,$6,$7)', [priceId,priceSha,'Giá.xlsx','xlsx',priceBytes.length,'ready',{}]);
  const bytes = Buffer.from('isolated image fixture'), imageSha = await blobs.put(bytes);
  const media = {importId:imageId,sha256:imageSha,mime:'image/png',width:1200,height:1600};
  const build = vi.fn(async (_repo: unknown,_blobs: unknown,input: any,decisionSource: any) => ({
    kind:'ready', document:{sourceKey:input.productKey,title:'Nội dung nguyên vẹn '+input.productKey,description:[{type:'text',text:' Dòng 1\n\nDòng 2 '}],cover:media,gallery:[media],tierNames:[],models:[{sku:'SKU',optionLabels:[],tierIndex:[],originalPrice:'125000',stock:input.stocks.SKU}],categoryId:'101128',brandId:'1252097',attributes:{},logistics:[{channelId:'5001',enabled:true}],weightGrams:100,dimensionCm:{length:10,width:10,height:10},publication:'unlisted'},
    proposedAttributeList:[],brandName:'VINA TƯƠI',condition:'NEW',preOrder:{is_pre_order:false},stockLocation:{referenceItemId:'99',expectedLocationBySku:{SKU:'VNZ'},writeLocationBySku:{SKU:null}},
    priceProof:[{sku:'SKU',importId:priceId,rowKey:'r2',sheetName:'Bảng giá',priceProfile:'Giá thường',fileSha256:priceSha,skuCell:'A2',priceCell:'B2',originalPrice:'125000'}],
    assets:[{...media,filename:'Ảnh.png',bytes}],sourceSnapshot:{draft:{productKey:input.productKey,revision:1},input,decisionSource},sourceFingerprint:digest(input.productKey),issues:[],
  }));
  const register = vi.fn(async (input: any) => { const loaded = await loadProductionBatchSource(input.manifestPath,input.expectedSha256); return {batchId:loaded.value.batchId,manifestSha256:loaded.sha256}; });
  const readSource = vi.fn(async (key:string) => ({productKey:key,revision:1}));
  const service = new ProductionPreparationService(repo,blobs,{root,build,register,readSource,verifyStock:async()=>({expectedLocationId:'VNZ',writeLocationId:null})} as any);
  const input = {id:randomUUID(),entries:Array.from({length:count},(_,i)=>({productKey:randomUUID(),sourceRevision:1,priceSelection:{importId:priceId,sheet:'Bảng giá',priceProfile:'Giá thường'},stocks:{SKU:0},choices:{}}))};
  return {service,input,build,register,readSource,blobs};
}
it('persists a preview without registering a writer and recovers the same request after restart',async()=>{
  const f=await setup(); const first=await f.service.preview(f.input); const again=await f.service.preview(f.input);
  expect(again).toEqual(first); expect(first.readyCount).toBe(1); expect(f.build).toHaveBeenCalledTimes(1); expect(f.register).not.toHaveBeenCalled();
  await expect(f.service.preview({...f.input,entries:[{...f.input.entries[0],stocks:{SKU:1}}]})).rejects.toThrow('PREPARATION_REQUEST_CONFLICT');
});
it('keeps a fabricated knowledge acceptance blocked before stock lookup or registration',async()=>{
  const f=await setup();(f.input.entries[0] as any).knowledgeAcceptanceId=randomUUID();
  const preview=await f.service.preview(f.input);
  expect(preview).toMatchObject({readyCount:0,blockedCount:1});
  expect(preview.entries[0].issues[0].code).toBe('KNOWLEDGE_DRAFT_ACCEPTANCE_NOT_FOUND');
  expect(f.register).not.toHaveBeenCalled();
});
it('revalidates a stored knowledge receipt before registering a preparation',async()=>{
  const f=await setup();await f.service.preview(f.input);
  const row=(await pool.query('SELECT body FROM production_source_preparations WHERE id=$1',[f.input.id])).rows[0];
  row.body.entries[0].knowledgeAcceptance={id:randomUUID()};
  const {canonicalJson}=await import('@shopee/domain'), fingerprint=digest(canonicalJson(row.body));
  await pool.query('UPDATE production_source_preparations SET body=$2,fingerprint=$3 WHERE id=$1',[f.input.id,row.body,fingerprint]);
  await expect(f.service.register(f.input.id,{expectedFingerprint:fingerprint})).rejects.toThrow('KNOWLEDGE_DRAFT_ACCEPTANCE_NOT_FOUND');
  expect(f.register).not.toHaveBeenCalled();
});
it('defaults new preparations to hidden and binds mode in every immutable manifest',async()=>{
  const f=await setup(5),preview=await f.service.preview(f.input);
  expect(preview).toMatchObject({publicationMode:'hidden_for_review'});
  await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint});
  for(const [arg] of f.register.mock.calls)expect(JSON.parse(await readFile(arg.manifestPath,'utf8')).publicationMode).toBe('hidden_for_review');
  await expect(f.service.preview({...f.input,publicationMode:'publish_after_verification'})).rejects.toThrow('PREPARATION_REQUEST_CONFLICT');
});
it('preserves an explicitly selected automatic publication mode',async()=>{
  const f=await setup(),preview=await f.service.preview({...f.input,publicationMode:'publish_after_verification'});
  expect(preview).toMatchObject({publicationMode:'publish_after_verification'});
  await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint});
  expect(JSON.parse(await readFile(f.register.mock.calls[0]![0].manifestPath,'utf8')).publicationMode).toBe('publish_after_verification');
});
it('persists explicit image deferral only for a hidden preparation and every child manifest',async()=>{
  const f=await setup(5),preview=await f.service.preview({...f.input,publicationMode:'hidden_for_review',imageQcPolicy:'defer_image_qc'});
  expect(preview).toMatchObject({publicationMode:'hidden_for_review',imageQcPolicy:'defer_image_qc'});
  await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint});
  for(const [arg] of f.register.mock.calls)expect(JSON.parse(await readFile(arg.manifestPath,'utf8'))).toMatchObject({publicationMode:'hidden_for_review',imageQcPolicy:'defer_image_qc'});
  const other=await setup();await expect(other.service.preview({...other.input,publicationMode:'publish_after_verification',imageQcPolicy:'defer_image_qc'})).rejects.toThrow();
  expect(other.build).not.toHaveBeenCalled();
});
it('reads a legacy preview without adding hidden mode to its body or manifest',async()=>{
  const f=await setup();await f.service.preview(f.input);
  const row=(await pool.query('SELECT * FROM production_source_preparations WHERE id=$1',[f.input.id])).rows[0];
  delete row.body.publicationMode;
  const {canonicalJson}=await import('@shopee/domain');
  const legacyFingerprint=digest(canonicalJson(row.body));
  await pool.query('UPDATE production_source_preparations SET body=$2,fingerprint=$3 WHERE id=$1',[f.input.id,row.body,legacyFingerprint]);
  const again=await f.service.preview(f.input);
  expect(again).toMatchObject({publicationMode:'publish_after_verification',fingerprint:legacyFingerprint});
  expect(f.build).toHaveBeenCalledTimes(1);
  await f.service.register(f.input.id,{expectedFingerprint:legacyFingerprint});
  const manifest=JSON.parse(await readFile(f.register.mock.calls[0]![0].manifestPath,'utf8'));
  expect(Object.hasOwn(manifest,'publicationMode')).toBe(false);
  expect((await pool.query('SELECT body FROM production_source_preparations WHERE id=$1',[f.input.id])).rows[0].body).toEqual(row.body);
});
it('registers immutable source groups without calling any Shopee writer, preserving explicit stock zero',async()=>{
  const f=await setup(5), preview=await f.service.preview(f.input);
  const accepted=await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint});
  expect(accepted.batches).toHaveLength(2); expect(f.register).toHaveBeenCalledTimes(2);
  const manifest=JSON.parse(await readFile(f.register.mock.calls[0]![0].manifestPath,'utf8'));
  expect(manifest.version).toBe(2); expect(manifest.listings).toHaveLength(4); expect(manifest.listings[0].document.models[0].stock).toBe(0);
  expect(manifest.listings[0].document.description[0].text).toBe(' Dòng 1\n\nDòng 2 ');
  const again=await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint}); expect(again).toEqual(accepted);
});
it('keeps incomplete sources visible and registers only the ready source selected by the preview',async()=>{
  const f=await setup(2); f.build.mockResolvedValueOnce({kind:'blocked',issues:[{code:'MISSING_WEIGHT',field:'weight',message:'Chưa có cân nặng',severity:'block',sources:[]}]} as any);
  const preview=await f.service.preview(f.input); expect(preview.readyCount).toBe(1); expect(preview.blockedCount).toBe(1);
  const accepted=await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint}); expect(accepted.batches).toHaveLength(1);
});
it('preserves explicit per-listing duplicate authorization across groups without applying it to siblings',async()=>{
  const f=await setup(5);
  const authorization={reason:'distinct_prepared_listing_test',authorizationReference:'review-ten/source-first/revision-1'};
  (f.input.entries[0] as any).existingListingAuthorization=authorization;
  const originalBuild=f.build.getMockImplementation()!;
  f.build.mockImplementation(async(...args)=>{
    const result=await originalBuild(...args);
    return {...result,...(args[2].existingListingAuthorization ? {existingListingAuthorization:args[2].existingListingAuthorization} : {})};
  });
  const preview=await f.service.preview(f.input);
  expect(preview.entries[0].existingListingAuthorization).toEqual(authorization);
  await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint});
  const manifests=await Promise.all(f.register.mock.calls.map(async(call)=>JSON.parse(await readFile(call[0].manifestPath,'utf8'))));
  const listings=manifests.flatMap((manifest)=>manifest.listings);
  expect(listings).toHaveLength(5);
  expect(listings[0].existingListingAuthorization).toEqual(authorization);
  expect(listings.slice(1).every((listing)=>!Object.hasOwn(listing,'existingListingAuthorization'))).toBe(true);
  expect(listings[0].sourceIdentity).toBe(f.input.entries[0]!.productKey);
});
it('rejects stale preview source versions before any registration',async()=>{
  const f=await setup(), preview=await f.service.preview(f.input); f.readSource.mockImplementation(async(key:string)=>({productKey:key,revision:2}));
  await expect(f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint})).rejects.toThrow('PREPARATION_SOURCE_CHANGED'); expect(f.register).not.toHaveBeenCalled();
});
it('dispatches five ready sources across two groups with one command and never replays a completed group',async()=>{
  const f=await setup(5),preview=await f.service.preview(f.input),registered=await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint});
  const completed=new Set<string>();
  const status=vi.fn(async(id:string)=>({batchId:id,manifestSha256:registered.batches.find((b:any)=>b.batchId===id).manifestSha256,state:completed.has(id)?'completed':'ready',busy:false,canExecute:true,statusFingerprint:'a'.repeat(64)}));
  const start=vi.fn(async(id:string)=>{completed.add(id);return {};});
  const queue=new ProductionPreparationExecution(repo,f.service,{status,start} as any,{enabled:true,sleep:async()=>{}});
  await queue.start(f.input.id,{expectedFingerprint:preview.fingerprint});await queue.waitForIdle(f.input.id);
  expect((await queue.get(f.input.id)).state).toBe('completed');expect(start).toHaveBeenCalledTimes(2);
  expect(await queue.get(f.input.id)).toMatchObject({publicationMode:'hidden_for_review',completionTarget:'created_hidden'});
  await queue.start(f.input.id,{expectedFingerprint:preview.fingerprint});expect(start).toHaveBeenCalledTimes(2);
});
it('pauses hidden creation honestly for pending QC and resumes later groups only after child verification',async()=>{
  const f=await setup(5),preview=await f.service.preview(f.input),registered=await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint});
  const done=new Set<string>();let reviewed=false;
  const status=vi.fn(async(id:string)=>({batchId:id,manifestSha256:registered.batches.find((b:any)=>b.batchId===id).manifestSha256,
    state:done.has(id)?'completed':'ready',busy:false,canExecute:true,statusFingerprint:'a'.repeat(64),
    listings:[{state:done.has(id)?'created_unlisted':'created_readback_pending'}]}));
  const start=vi.fn(async(id:string)=>{if(reviewed)done.add(id);return {};});
  const queue=new ProductionPreparationExecution(repo,f.service,{status,start} as any,{enabled:true,sleep:async()=>{}});
  await queue.start(f.input.id,{expectedFingerprint:preview.fingerprint});await queue.waitForIdle(f.input.id);
  expect(await queue.get(f.input.id)).toMatchObject({state:'paused',code:'PREPARATION_CHILD_QC_REVIEW_REQUIRED',publicationMode:'hidden_for_review',completedBatches:[]});
  expect(start).toHaveBeenCalledTimes(1);expect(start.mock.calls[0]![0]).toBe(registered.batches[0].batchId);
  reviewed=true;
  await queue.start(f.input.id,{expectedFingerprint:preview.fingerprint});await queue.waitForIdle(f.input.id);
  expect(await queue.get(f.input.id)).toMatchObject({state:'completed',completionTarget:'created_hidden',completedBatches:registered.batches.map((b:any)=>b.batchId)});
  expect(start).toHaveBeenCalledTimes(3);
});
it('pauses the parent when a child has an unresolved write, without dispatching another group or replaying it',async()=>{
  const f=await setup(5),preview=await f.service.preview(f.input),registered=await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint});
  const status=vi.fn(async(id:string)=>({manifestSha256:registered.batches.find((b:any)=>b.batchId===id).manifestSha256,state:'running',busy:true,canExecute:false}));
  const start=vi.fn();const queue=new ProductionPreparationExecution(repo,f.service,{status,start} as any,{enabled:true,sleep:async()=>{}});
  await queue.start(f.input.id,{expectedFingerprint:preview.fingerprint});await queue.waitForIdle(f.input.id);
  expect((await queue.get(f.input.id)).state).toBe('paused');expect(start).not.toHaveBeenCalled();expect(status).toHaveBeenCalledTimes(1);
});
it('exposes an interrupted parent as resumable while leaving its durable record and child untouched',async()=>{
  const f=await setup(),preview=await f.service.preview(f.input);await f.service.register(f.input.id,{expectedFingerprint:preview.fingerprint});
  const body={id:f.input.id,fingerprint:preview.fingerprint,state:'running',completedBatches:[],totalBatches:1};
  await pool.query('INSERT INTO production_preparation_executions(preparation_id,fingerprint,body) VALUES($1,$2,$3)',[f.input.id,preview.fingerprint,body]);
  const start=vi.fn(),queue=new ProductionPreparationExecution(repo,f.service,{status:vi.fn(),start} as any,{enabled:true});
  expect(await queue.get(f.input.id)).toMatchObject({state:'paused',code:'PREPARATION_INTERRUPTED_REVIEW_REQUIRED',canResume:true});
  expect((await pool.query('SELECT body FROM production_preparation_executions WHERE preparation_id=$1',[f.input.id])).rows[0].body).toEqual(body);expect(start).not.toHaveBeenCalled();
});
it('prepares and registers with a single database connection without acquiring a nested pool slot',async()=>{
  const f=await setup(),single=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema},public`,max:1,connectionTimeoutMillis:500});
  try {
    const service=new ProductionPreparationService(new Repository(single),f.blobs,{root,build:f.build,register:f.register,readSource:f.readSource,verifyStock:async()=>({expectedLocationId:'VNZ',writeLocationId:null})} as any);
    const preview=await service.preview(f.input);
    expect((await service.register(f.input.id,{expectedFingerprint:preview.fingerprint})).batches).toHaveLength(1);
  } finally {await single.end();}
});
