import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { assertPreparationLocalSourcesActive, localArchiveLock, type Repository } from '@shopee/persistence';
import type { loadProductionBatchSource } from './production-batch-source.js';

type Loaded = Awaited<ReturnType<typeof loadProductionBatchSource>>;
type Listing = Loaded['value']['listings'][number];
export type CurrentProductionSource = { currentSource: 'current' | 'source_changed' | 'archived'; currentRevision?: number; productKey?:string };
/** Only saved local products participate; legacy manifest identities remain supported. */
export async function currentProductionSource(repo: Repository, listing: Listing): Promise<CurrentProductionSource> {
  const row = (await repo.pool.query(
    'SELECT p.product_key,p.latest_revision FROM products p WHERE p.product_key=$1', [listing.sourceIdentity],
  )).rows.find(row => row.product_key === listing.sourceIdentity);
  if (!row) return {currentSource:'current'};
  const currentRevision = Number(row.latest_revision);
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 1) throw Error('PRODUCTION_BATCH_SOURCE_CHANGED');
  try {
    await assertPreparationLocalSourcesActive(repo.pool,[{productKey:listing.sourceIdentity}]);
  } catch (error) {
    if (error instanceof Error && error.message === 'LOCAL_RESOURCE_ARCHIVED') return {currentSource:'archived',currentRevision,productKey:listing.sourceIdentity};
    throw error;
  }
  return {currentSource:currentRevision===listing.sourceRevision?'current':'source_changed',currentRevision,productKey:listing.sourceIdentity};
}
export async function assertCurrentProductionSource(repo: Repository, listing: Listing) {
  const current = await currentProductionSource(repo,listing);
  if(current.currentSource!=='current') throw Error(current.currentSource==='archived'?'PRODUCTION_BATCH_SOURCE_ARCHIVED':'PRODUCTION_BATCH_SOURCE_CHANGED');
}
/** Match saveProduct's lock order; keep revisions and archive state stable through first dispatch. */
export async function lockProductionSourceSelection(repo:Repository,listing:Listing) {
  const client=await repo.pool.connect();
  let lifecycle=false,product=false;
  const release=async()=>{
    try {
      if(product)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[listing.sourceIdentity]);
      if(lifecycle)await client.query('SELECT pg_advisory_unlock_shared(hashtextextended(current_schema() || chr(58) || $1,0))',[localArchiveLock]);
    } finally {client.release();}
  };
  try {
    await client.query('SELECT pg_advisory_lock_shared(hashtextextended(current_schema() || chr(58) || $1,0))',[localArchiveLock]);lifecycle=true;
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[listing.sourceIdentity]);product=true;
    await assertCurrentProductionSource({pool:client} as unknown as Repository,listing);
    return release;
  } catch(error) {await release();throw error;}
}
const receiptSchema=z.object({version:z.literal(1),batchId:z.string().uuid(),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/),sourceKey:z.string().min(1),sourceIdentity:z.string().min(1),sourceRevision:z.number().int().positive(),expectedStatusFingerprint:z.string().regex(/^[a-f0-9]{64}$/),excludedAt:z.iso.datetime()}).strict();
export type ProductionBatchExclusion=z.infer<typeof receiptSchema>;
const filename=(sourceKey:string)=>createHash('sha256').update(sourceKey).digest('hex')+'.json';
export async function readProductionBatchExclusions(root:string,loaded:Loaded):Promise<ProductionBatchExclusion[]> {
  const directory=resolve(root,'web-exclusions',loaded.value.batchId);
  let names:string[];
  try {names=await readdir(directory);} catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const receipts:ProductionBatchExclusion[]=[];
  for(const name of names.sort()) {
    if(!name.endsWith('.json'))continue;
    const parsed=receiptSchema.safeParse(JSON.parse(await readFile(resolve(directory,name),'utf8')));
    if(!parsed.success)throw Error('PRODUCTION_BATCH_EXCLUSION_INVALID');
    const receipt=parsed.data,source=loaded.value.listings.find(s=>s.sourceKey===receipt.sourceKey);
    if(name!==filename(receipt.sourceKey)||receipt.batchId!==loaded.value.batchId||receipt.manifestSha256!==loaded.sha256||!source||source.sourceIdentity!==receipt.sourceIdentity||source.sourceRevision!==receipt.sourceRevision)throw Error('PRODUCTION_BATCH_EXCLUSION_INVALID');
    receipts.push(receipt);
  }
  return receipts;
}
export async function writeProductionBatchExclusion(root:string,loaded:Loaded,source:Listing,expectedStatusFingerprint:string) {
  const receipt=receiptSchema.parse({version:1,batchId:loaded.value.batchId,manifestSha256:loaded.sha256,sourceKey:source.sourceKey,sourceIdentity:source.sourceIdentity,sourceRevision:source.sourceRevision,expectedStatusFingerprint,excludedAt:new Date().toISOString()});
  const directory=resolve(root,'web-exclusions',loaded.value.batchId);
  await mkdir(directory,{recursive:true});
  try {await writeFile(resolve(directory,filename(source.sourceKey)),JSON.stringify(receipt,null,2),{flag:'wx'});}
  catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('PRODUCTION_BATCH_STATUS_CHANGED');throw error;}
}
