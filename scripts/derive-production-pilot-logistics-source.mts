import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve('.local/production-pilot-1423724897');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const parentBytes=await readFile(resolve(root,'source-authorized-v3.json'));
const source=JSON.parse(parentBytes.toString('utf8'));
const proofRoot=resolve(root,'preflight/a8090d73-0f39-4aaa-b3e6-b1ee67ef6967');
const channelBytes=await readFile(resolve(proofRoot,'channels.json'));
const baseBytes=await readFile(resolve(proofRoot,'base-20.json'));
const channelProof=JSON.parse(channelBytes.toString('utf8'));
const baseProof=JSON.parse(baseBytes.toString('utf8'));
const channels=channelProof.result.envelope.response.logistics_channel_list;
const oldItem=baseProof.result.envelope.response.item_list.find((i:any)=>i.item_id===42476682098);
if(!oldItem || oldItem.item_status!=='UNLIST')throw Error('OLD_ITEM_EVIDENCE_CHANGED');
for(const listing of source.listings){
  if(listing.sourceRevision!==3)throw Error('UNEXPECTED_PARENT_SOURCE');
  const candidates=oldItem.logistic_info.filter((c:any)=>c.enabled===true);
  const excluded:any[]=[];
  listing.document.logistics=candidates.filter((candidate:any)=>{
    const channel=channels.find((c:any)=>c.logistics_channel_id===candidate.logistic_id);
    if(!channel || channel.enabled!==true || channel.fee_type!=='SIZE_INPUT')throw Error('CHANNEL_CONTEXT_UNSUPPORTED');
    const limits=channel.item_max_dimension;
    if(limits?.unit!=='cm')throw Error('CHANNEL_UNIT_UNVERIFIED');
    const parcels=[{weightGrams:listing.document.weightGrams,dimensionCm:listing.document.dimensionCm},...listing.document.models];
    const fits=parcels.every((p:any)=>{
      const w=p.weightGrams/1000,d=p.dimensionCm;
      return !(channel.weight_limit.item_max_weight>0&&w>channel.weight_limit.item_max_weight) &&
        !(channel.weight_limit.item_min_weight>0&&w<channel.weight_limit.item_min_weight) &&
        ['length','width','height'].every(k=>!(limits[k]>0&&d[k]>limits[k])) &&
        !(limits.dimension_sum>0&&d.length+d.width+d.height>limits.dimension_sum);
    });
    if(!fits)excluded.push({channelId:String(candidate.logistic_id),reason:'source_package_exceeds_current_channel_limits',limits});
    return fits;
  }).map((c:any)=>({channelId:String(c.logistic_id),enabled:true}));
  const actual=listing.document.logistics.map((c:any)=>c.channelId).sort();
  if(JSON.stringify(actual)!==JSON.stringify(['5000','5001','5004','50052','50053']))throw Error('UNREVIEWED_CHANNEL_SELECTION');
  listing.sourceRevision=4;
  if(listing.sourceKey==='row-2')listing.supersedesOperationId='dfa64457-dd7d-4ca2-9354-c89482b4fd38';
  listing.logisticsChange={parentRevision:3,sourceItemId:'42476682098',
    rationale:'Use same-shop observed enabled delivery channels that fit every unchanged source package; required-channel identity is not exposed by current metadata.',
    authorization:'User authorized publication and applying operational knowledge from old listings; no shop settings changed.',
    sourceRequestIds:[channelProof.result.requestId,baseProof.result.requestId],
    sourceHashes:{channels:hash(channelBytes),baseInfo:hash(baseBytes)},excluded};
}
source.parentReceipt={path:'source-authorized-v3.json',sha256:hash(parentBytes)};
source.assembledAt=new Date().toISOString();
source.decisions.logistics='same_shop_existing_enabled_channels_filtered_by_source_package_limits';
await writeFile(resolve(root,'source-authorized-v4.json'),JSON.stringify(source,null,2),{flag:'wx'});
console.log(JSON.stringify({sourceRevision:4,listings:2,models:15,channels:source.listings[0].document.logistics,unchanged:'title/description/images/price/stock/variants/weight/dimensions',mutations:0}));
