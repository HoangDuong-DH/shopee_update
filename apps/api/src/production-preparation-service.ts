import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { workspaceResetState } from './workspace-reset-state.js';
import { canonicalJson, type SourceRef } from '@shopee/domain';
import { Repository, localArchiveLock, assertPreparationLocalSourcesActive, type BlobStore } from '@shopee/persistence';
import type { Pool, PoolClient } from 'pg';
import { buildProductionDraftSource, productionExistingListingAuthorizationSchema } from './production-draft-source.js';
import { ProductionPreparationMetadataService } from './production-preparation-metadata.js';
import { loadProductionBatchSource, productionBatchPass1Root, productionPublicationMode, productionPublicationModeSchema, productionImageQcPolicy, productionImageQcPolicySchema, type ProductionBatchManifest } from './production-batch-source.js';
import { registerProductionBatch } from './production-batch-service.js';
import { productionPilotScope } from './production-pilot-source.js';
import { validateDraftKnowledgeAcceptance } from './seller-knowledge-draft-service.js';
import { projectProductPriceIssues } from './product-service.js';

const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
const fingerprint = (v: unknown) => sha(canonicalJson(v));
const uuid = z.string().uuid();
function keyUuid(value: string) {
  const h = sha(value);
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
function fail(code: string): never { throw Error('PREPARATION_' + code); }
type Options = {
  root?: string;
  build?: typeof buildProductionDraftSource;
  register?: typeof registerProductionBatch;
  readSource?: (key: string) => Promise<unknown>;
  verifyStock?: (referenceId:string) => Promise<{expectedLocationId:string;writeLocationId:string|null}|null>;
};
async function immutable(path: string, bytes: Uint8Array | string) {
  const expected = sha(bytes);
  try { await writeFile(path, bytes, { flag: 'wx' }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (sha(await readFile(path)) !== expected) fail('FILE_CONFLICT');
  }
  return expected;
}

/** Local preparation only. Shopee writes remain in the existing journaled batch runner. */
export class ProductionPreparationService {
  constructor(private readonly repo: Repository, private readonly blobs: BlobStore, private readonly options: Options = {}) {}
  private get root() { return this.options.root ?? productionBatchPass1Root; }
  private async locked<T>(id: string, fn: (client:PoolClient,repo:Repository,lock:(key:string)=>Promise<void>) => Promise<T>): Promise<T> {
    const client = await this.repo.pool.connect();
    const locks:string[]=[];
    let sourceLocked=false;
    const lock=async(key:string)=>{await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);locks.push(key);};
    try {
      await client.query('SELECT pg_advisory_lock_shared(hashtextextended(current_schema() || chr(58) || $1,0))',[localArchiveLock]);sourceLocked=true;
      await lock('production-preparation:' + id);
      // Use this leased connection for all repository reads/writes. Approval is committed
      // before registry files become visible so a crash can safely resume local registration.
      return await fn(client,new Repository(client as unknown as Pool),lock);
    } finally {
      try {for(const key of locks.reverse())await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);if(sourceLocked)await client.query('SELECT pg_advisory_unlock_shared(hashtextextended(current_schema() || chr(58) || $1,0))',[localArchiveLock]);}finally{client.release();}
    }
  }
  private async stockMapping(referenceId:string,repo:Repository) {
    if(this.options.verifyStock) return this.options.verifyStock(referenceId);
    const data=await new ProductionPreparationMetadataService(repo).get({referenceItemId:referenceId,includeInventory:false});
    return data.reference?.writeMappingVerified ? data.reference.writeMapping : null;
  }
  private async stockMatches(location:{referenceItemId:string;expectedLocationBySku:Record<string,string>;writeLocationBySku:Record<string,string|null>}, cache:Map<string,Awaited<ReturnType<ProductionPreparationService['stockMapping']>>>,repo:Repository) {
    if(!cache.has(location.referenceItemId)) cache.set(location.referenceItemId,await this.stockMapping(location.referenceItemId,repo));
    const proof=cache.get(location.referenceItemId);
    return !!proof && Object.values(location.expectedLocationBySku).every(v=>v===proof.expectedLocationId) && Object.values(location.writeLocationBySku).every(v=>v===proof.writeLocationId);
  }
  private async row(id: string,query:Pick<PoolClient,'query'>=this.repo.pool) {
    return (await query.query('SELECT * FROM production_source_preparations WHERE id=$1', [uuid.parse(id)])).rows[0];
  }
  private public(row: any) {
    return {
      id: row.id, fingerprint: row.fingerprint, createdAt: new Date(row.created_at).toISOString(),
      scope: productionPilotScope,
      publicationMode: productionPublicationMode(row.body),
      imageQcPolicy: productionImageQcPolicy(row.body),
      readyCount: row.body.entries.filter((e: any) => e.kind === 'ready').length,
      blockedCount: row.body.entries.filter((e: any) => e.kind === 'blocked').length,
      entries: row.body.entries.map((e: any) => ({productKey:e.productKey,sourceRevision:e.sourceRevision,kind:e.kind,title:e.title,
        skuCount:e.document?.models.length ?? 0,issues:e.issues,
        ...(e.kind === 'ready' ? {document:e.document,brandName:e.brandName,priceProof:e.priceProof.map((p:any)=>({sku:p.sku,sheetName:p.sheetName,priceProfile:p.priceProfile,skuCell:p.skuCell,priceCell:p.priceCell,originalPrice:p.originalPrice})),proposedAttributeList:e.proposedAttributeList,...(e.existingListingAuthorization ? {existingListingAuthorization:e.existingListingAuthorization} : {})} : {})})),
      registration: row.registration ?? null,
    };
  }
  async get(id: string) { const row = await this.row(id); if (!row) fail('NOT_FOUND'); return this.public(row); }
  async context() {
    const hidden = new Set((await workspaceResetState())?.hiddenPreparationIds ?? []);
    const [products, imports, recent] = await Promise.all([
      this.repo.listProducts(), this.repo.listImports(),
      this.repo.pool.query('SELECT * FROM production_source_preparations ORDER BY created_at DESC LIMIT 30'),
    ]);
    const visibleProducts = await projectProductPriceIssues(this.repo, products);
    return {scope:productionPilotScope,products:visibleProducts.map(p=>({productKey:p.productKey,revision:p.revision,title:p.title.value,
      skus:p.variants.map(v=>v.sku.value), categoryId:p.categoryId?.value,brandId:p.brandId?.value,
      sourceSelection:p.sourceSelection,attributes:p.attributes,logistics:p.logistics,issues:p.issues})),
      pricebooks:imports.filter(i=>i.kind==='xlsx' && i.status==='ready').map(i=>({id:i.id,filename:i.filename})),
      preparations:recent.rows.filter(r=>!hidden.has(r.id)).map(r=>this.public(r))};
  }
  async preview(raw: unknown) {
    // Incomplete operating fields are per-listing issues, not a rejection of all siblings.
    const entryEnvelope=z.object({productKey:z.string().min(1).max(200),sourceRevision:z.number().int().positive()}).passthrough();
    // Leave omission in the request hash so an old request can be read again unchanged.
    // Only a newly materialized preparation receives the hidden default in its immutable body.
    const input = z.object({id:uuid,publicationMode:productionPublicationModeSchema.optional(),imageQcPolicy:productionImageQcPolicySchema.optional(),entries:z.array(entryEnvelope).min(1).max(80)}).strict().refine(value=>value.imageQcPolicy!=='defer_image_qc'||(value.publicationMode ?? 'hidden_for_review')==='hidden_for_review').parse(raw);
    if (new Set(input.entries.map(e=>e.productKey)).size !== input.entries.length) fail('DUPLICATE_SOURCE');
    return this.locked(input.id, async (client,repo) => {
      const hash = fingerprint(input), prior = await this.row(input.id,client);
      if (prior) { if (prior.request_hash !== hash) fail('REQUEST_CONFLICT'); return this.public(prior); }
      await assertPreparationLocalSourcesActive(client,input.entries);
      const directory = resolve(this.root,'preparations',input.id);
      await mkdir(directory,{recursive:true});
      const decisionPath=resolve(directory,'decision.json');
      let decisionRecord:{requestHash:string;observedAt:string};
      try { decisionRecord=JSON.parse(await readFile(decisionPath,'utf8')); }
      catch(e) {
        if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;
        decisionRecord={requestHash:hash,observedAt:new Date().toISOString()};
        await immutable(decisionPath,canonicalJson(decisionRecord));
      }
      if(decisionRecord.requestHash!==hash || !Number.isFinite(Date.parse(decisionRecord.observedAt))) fail('REQUEST_CONFLICT');
      const entries = [],stockProofs=new Map();
      for (const entry of input.entries) {
        const decisionSource: SourceRef = {kind:'user_decision',fileSha256:hash,locator:`preparation:${input.id}:${entry.productKey}`,observedAt:decisionRecord.observedAt};
        const result = await (this.options.build ?? buildProductionDraftSource)(repo,this.blobs,entry,decisionSource);
        if (result.kind === 'blocked') {
          const draft = await repo.getProduct(entry.productKey);
          entries.push({...entry,kind:'blocked',title:draft?.title.value ?? entry.productKey,issues:result.issues}); continue;
        }
        let knowledgeAcceptance;
        if (entry.knowledgeAcceptanceId !== undefined) {
          try {
            knowledgeAcceptance = await validateDraftKnowledgeAcceptance(repo, {receiptId:uuid.parse(entry.knowledgeAcceptanceId),productKey:entry.productKey,expectedRevision:entry.sourceRevision,categoryId:result.document.categoryId,brandId:result.document.brandId,scope:productionPilotScope,attributeList:result.proposedAttributeList});
          } catch (error) {
            entries.push({...entry,kind:'blocked',title:result.document.title,issues:[{code:error instanceof Error ? error.message : 'KNOWLEDGE_DRAFT_ACCEPTANCE_INVALID',field:'attributes',severity:'block',message:'Lựa chọn gợi ý đã hết hạn hoặc không còn khớp nguồn, shop và ngành hiện tại. Đọc lại gợi ý rồi chọn lại.',sources:[]}]});continue;
          }
        }
        if(!await this.stockMatches(result.stockLocation,stockProofs,repo)) {
          entries.push({...entry,kind:'blocked',title:result.document.title,issues:[{code:'STOCK_MAPPING_UNVERIFIED',field:'stockLocation',severity:'block',message:'Chưa có bằng chứng ánh xạ kho phù hợp cho shop. Chọn sản phẩm tham chiếu đã được đối chiếu.',sources:[]}]});continue;
        }
        const assets: Record<string,string> = {};
        for (const asset of result.assets) {
          if (sha(asset.bytes) !== asset.sha256) fail('ASSET_CHANGED');
          const path=resolve(directory,asset.sha256 + '.asset'); await immutable(path,asset.bytes); assets[asset.importId]=path;
        }
        const sourcePath=resolve(directory,keyUuid(entry.productKey)+'.source.json');
        let stockMappingEvidence=stockProofs.get(result.stockLocation.referenceItemId);
        const proofPath=resolve(directory,'stock-proof-'+result.stockLocation.referenceItemId+'.json');
        try {
          const priorProof=JSON.parse(await readFile(proofPath,'utf8'));
          if(priorProof.expectedLocationId!==stockMappingEvidence.expectedLocationId || priorProof.writeLocationId!==stockMappingEvidence.writeLocationId || priorProof.verificationFingerprint!==stockMappingEvidence.verificationFingerprint) fail('STOCK_MAPPING_CHANGED');
          stockMappingEvidence=priorProof;
        } catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await immutable(proofPath,canonicalJson(stockMappingEvidence));}
        const snapshotBytes=canonicalJson({...result.sourceSnapshot,stockMappingEvidence,...(knowledgeAcceptance ? {knowledgeAcceptance} : {})}),snapshotSha=await immutable(sourcePath,snapshotBytes);
        const priceFiles=[];
        for (const importId of new Set(result.priceProof.map((p:any)=>p.importId as string))) {
          const imported=await repo.getImport(importId);
          if (!imported || imported.kind!=='xlsx' || imported.status!=='ready') fail('PRICE_SOURCE_CHANGED');
          if(result.priceProof.some(p=>p.importId===importId && p.fileSha256!==imported.sha256)) fail('PRICE_SOURCE_CHANGED');
          const bytes=await this.blobs.read(imported.sha256),path=resolve(directory,imported.sha256+'.xlsx');
          await immutable(path,bytes);priceFiles.push({id:importId,role:'pricebook' as const,path,sha256:imported.sha256});
        }
        const {assets: _assets,...saved}=result;
        entries.push({...saved,stockMappingEvidence,...(knowledgeAcceptance ? {knowledgeAcceptance} : {}),productKey:entry.productKey,sourceRevision:entry.sourceRevision,title:result.document.title,
          assets,sourceFile:{id:entry.productKey,role:'listing-snapshot' as const,path:sourcePath,sha256:snapshotSha},priceFiles});
      }
      const body={entries,publicationMode:input.publicationMode ?? 'hidden_for_review',imageQcPolicy:input.imageQcPolicy ?? 'required'}, fp=fingerprint(body);
      await client.query('INSERT INTO production_source_preparations(id,request_hash,request,body,fingerprint) VALUES($1,$2,$3,$4,$5)',[input.id,hash,input,body,fp]);
      return this.public(await this.row(input.id,client));
    });
  }
  async register(id: string, raw: unknown) {
    uuid.parse(id);
    const input=z.object({expectedFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw);
    return this.locked(id,async(client,repo,lock)=>{
      const row=await this.row(id,client); if(!row) fail('NOT_FOUND');
      if(row.fingerprint!==input.expectedFingerprint || fingerprint(row.body)!==row.fingerprint) fail('REVIEW_CHANGED');
      if(row.registration) return row.registration;
      await assertPreparationLocalSourcesActive(client,row.body.entries);
      const ready=row.body.entries.filter((e:any)=>e.kind==='ready');
      if(!ready.length) fail('NOT_READY');
      for(const key of ready.map((e:any)=>String(e.productKey)).sort()) await lock(key);
      const stockProofs=new Map();
      // Every proof still checks its own hash. Import identities/bytes are immutable,
      // so load each shared pricebook once while holding this request's source locks.
      // Never retain this cache across registrations: a later attempt must read afresh.
      const priceImports = new Map<string, Awaited<ReturnType<Repository['getImport']>>>();
      for(const entry of ready) {
        const current=await (this.options.readSource ?? ((key:string)=>repo.getProduct(key)))(entry.productKey);
        if(fingerprint(current)!==fingerprint(entry.sourceSnapshot.draft)) fail('SOURCE_CHANGED');
        if(entry.knowledgeAcceptance) await validateDraftKnowledgeAcceptance(repo,{receiptId:entry.knowledgeAcceptance.id,productKey:entry.productKey,expectedRevision:entry.sourceRevision,categoryId:entry.document.categoryId,brandId:entry.document.brandId,scope:productionPilotScope,attributeList:entry.proposedAttributeList});
        if(!await this.stockMatches(entry.stockLocation,stockProofs,repo)) fail('STOCK_MAPPING_CHANGED');
        for(const p of entry.priceProof) {
          if (!priceImports.has(p.importId)) priceImports.set(p.importId, await repo.getImport(p.importId));
          const currentPrice=priceImports.get(p.importId);
          if(!currentPrice || currentPrice.sha256!==p.fileSha256) fail('PRICE_SOURCE_CHANGED');
        }
      }
      const manifests=[];
      for(let i=0;i<ready.length;i+=4) {
        const group=ready.slice(i,i+4),batchId=keyUuid(id+':'+row.fingerprint+':'+i);
        const sourceFiles=Array.from(new Map(group.flatMap((e:any)=>[e.sourceFile,...e.priceFiles]).map((file:any)=>[file.id,file])).values());
        const value:ProductionBatchManifest={version:2,batchId,preparation:{id,fingerprint:row.fingerprint},scope:productionPilotScope,
          ...(row.body.publicationMode ? {publicationMode:productionPublicationMode(row.body)} : {}),
          ...(row.body.imageQcPolicy ? {imageQcPolicy:productionImageQcPolicy(row.body)} : {}),
          authorizationReference:'operator-preparation:'+id+':'+row.fingerprint,sourceFiles:sourceFiles as any,
          assets:Object.assign({},...group.map((e:any)=>e.assets)),
          listings:group.map((e:any)=>({sourceIdentity:e.productKey,sourceRevision:e.sourceRevision,sourceKey:e.document.sourceKey,sourceFileId:e.sourceFile.id,
            document:e.document,proposedAttributeList:e.proposedAttributeList,brandName:e.brandName,condition:e.condition,preOrder:e.preOrder,stockLocation:e.stockLocation,
            ...(e.existingListingAuthorization ? {existingListingAuthorization:productionExistingListingAuthorizationSchema.parse(e.existingListingAuthorization)} : {}),
            priceProof:e.priceProof.map((p:any)=>({sku:p.sku,sourceFileId:p.importId,sheetName:p.sheetName,skuCell:p.skuCell,priceCell:p.priceCell,originalPrice:p.originalPrice,priceSet:p.priceProfile ?? '(Không phân bộ)'}))}))};
        const path=resolve(this.root,'preparations',id,batchId+'.manifest.json'),bytes=canonicalJson(value),expectedSha256=await immutable(path,bytes);
        // Check every group's bytes and exact Excel cells before registering any group.
        await loadProductionBatchSource(path,expectedSha256); manifests.push({manifestPath:path,expectedSha256});
      }
      await client.query('UPDATE production_source_preparations SET approved_at=COALESCE(approved_at,now()) WHERE id=$1',[id]);
      const batches=[];
      for(const manifest of manifests) batches.push(await (this.options.register ?? registerProductionBatch)(manifest));
      const receipt={id,fingerprint:row.fingerprint,batches,readyCount:ready.length,blockedCount:row.body.entries.length-ready.length};
      await client.query('UPDATE production_source_preparations SET registration=$2 WHERE id=$1 AND registration IS NULL',[id,receipt]);
      return receipt;
    });
  }
}
