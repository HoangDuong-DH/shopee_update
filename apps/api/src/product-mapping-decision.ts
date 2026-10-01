import { createHash } from 'node:crypto';
import { canonicalJson, type ListingDraft } from '@shopee/domain';
import { folderDraftSelection } from '../../../packages/domain/src/folder-source-identity.js';
import type { Repository, ImportRecord } from '@shopee/persistence';
import { resolveFolderSourceClaim } from './folder-source-claim.js';

export type MappingSourceHash = { importId: string; sha256: string; kind: ImportRecord['kind'] };
type MappingReader = Pick<Repository,'getImport'> & Partial<Pick<Repository,'pool'>>;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (a: unknown,b: unknown) => canonicalJson(a)===canonicalJson(b);

export const productMappingFingerprint = (draft: ListingDraft) =>
  digest({productKey:draft.productKey,mapping:folderDraftSelection(draft)});

/** Selected immutable identities only; never retrieve every raw import body for a review. */
export async function readMappingSourceHashes(repo: MappingReader, draft: ListingDraft): Promise<MappingSourceHash[]> {
  const selection=draft.sourceSelection;
  if(!selection) throw Error('SOURCE_MAPPING_UNAVAILABLE');
  const roles=new Map<string,ImportRecord['kind']>();
  const add=(id:string,kind:ImportRecord['kind'])=>{
    if(roles.has(id) && roles.get(id)!==kind) throw Error('SOURCE_MAPPING_IMPORT_INVALID');
    roles.set(id,kind);
  };
  for(const variant of selection.variants) add(variant.importId,'xlsx');
  if(selection.contentBinding) add(selection.contentBinding.mapping.importId,'xlsx');
  const assetIds=[...new Set([draft.coverKey,...draft.galleryKeys,
    ...draft.description.flatMap(block=>block.type==='image'?[block.assetKey]:[]),
    ...draft.variants.flatMap(variant=>variant.imageKey?[variant.imageKey]:[])])];
  for(const id of assetIds) add(id,'image');
  if([...roles.keys()].some(id=>!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)))
    throw Error('SOURCE_MAPPING_IMPORT_INVALID');
  const records=repo.pool ? (await repo.pool.query(
    'SELECT id,sha256,kind,bytes,status FROM source_files WHERE id=ANY($1::uuid[])',[[...roles.keys()]])).rows
    : await Promise.all([...roles.keys()].map(id=>repo.getImport(id)));
  const byId=new Map(records.filter(Boolean).map(record=>[record.id,record]));
  const hashes:MappingSourceHash[]=[];
  for(const [id,kind] of [...roles].sort(([left],[right])=>left.localeCompare(right))) {
    const record=byId.get(id);
    if(!record || record.kind!==kind || !/^[a-f0-9]{64}$/.test(record.sha256)
      || (kind==='image' && record.status!=='ready')) throw Error('SOURCE_MAPPING_IMPORT_UNAVAILABLE');
    if(kind==='image') {
      const assets=draft.assets.filter(asset=>asset.key===id);
      if(assets.length!==1 || assets[0]!.sha256!==record.sha256 || assets[0]!.bytes!==Number(record.bytes))
        throw Error('SOURCE_MAPPING_IMPORT_CHANGED');
    }
    if(selection.contentBinding?.mapping.importId===id && selection.contentBinding.mapping.sha256!==record.sha256)
      throw Error('SOURCE_MAPPING_IMPORT_CHANGED');
    hashes.push({importId:id,sha256:record.sha256,kind});
  }
  return hashes;
}

export function productMappingDecisionFingerprint(draft: ListingDraft,sourceHashes:MappingSourceHash[],
  reviewedRevision=draft.revision,confirmedRevision=draft.revision+1) {
  return digest({version:1,productKey:draft.productKey,reviewedRevision,confirmedRevision,
    mappingFingerprint:productMappingFingerprint(draft),sourceHashes,
    folderSource:draft.folderSource??null,folderBinding:draft.sourceSelection?.folderBinding??null});
}
export function hasStructuredMappingDecision(draft: ListingDraft) {
  const confirmation=draft.sourceSelection?.mappingConfirmation;
  return confirmation!==undefined && ['reviewedRevision','confirmedRevision','sourceHashes','decisionFingerprint']
    .some(key=>Object.hasOwn(confirmation,key));
}
export function currentProductMappingDecision(draft:ListingDraft,sourceHashes:MappingSourceHash[]) {
  const confirmation=draft.sourceSelection?.mappingConfirmation;
  return !!confirmation && confirmation.kind==='user_decision'
    && Number.isSafeInteger(confirmation.reviewedRevision) && confirmation.reviewedRevision!>0
    && confirmation.confirmedRevision===draft.revision && confirmation.reviewedRevision!+1===draft.revision
    && confirmation.fileSha256===productMappingFingerprint(draft)
    && confirmation.locator===`listing-mapping-confirmation:${draft.productKey}`
    && Number.isFinite(Date.parse(confirmation.observedAt)) && same(confirmation.sourceHashes,sourceHashes)
    && confirmation.decisionFingerprint===productMappingDecisionFingerprint(draft,sourceHashes,confirmation.reviewedRevision,draft.revision);
}
export function legacyProductMappingDecision(draft:ListingDraft) {
  const confirmation=draft.sourceSelection?.mappingConfirmation;
  return !hasStructuredMappingDecision(draft) && confirmation?.kind==='user_decision'
    && confirmation.fileSha256===productMappingFingerprint(draft)
    && confirmation.locator===`listing-mapping-confirmation:${draft.productKey}`
    && Number.isFinite(Date.parse(confirmation.observedAt));
}
/** A fresh decision supersedes a changed selection, while the original folder lineage remains untouched. */
export async function storedFolderMappingMatches(repo:MappingReader,draft:ListingDraft) {
  const selection=draft.sourceSelection;
  if(!repo.pool || !selection?.folderBinding || !draft.folderSource) return false;
  try {
    const proof=await resolveFolderSourceClaim(repo as Repository,{productKey:draft.productKey,expectedRevision:0,
      folderBinding:selection.folderBinding,contentBinding:selection.contentBinding,
      sourceListingId:selection.sourceListingId??draft.sourceListingId?.value,title:selection.title,
      headline:selection.headline,body:selection.body,coverId:selection.coverId,galleryIds:selection.galleryIds,
      descriptionImageIds:selection.descriptionImageIds,tierNames:selection.tierNames,variants:selection.variants});
    return proof.fingerprint===draft.folderSource.fingerprint && draft.folderSource.productKey===draft.productKey;
  } catch { return false; }
}
