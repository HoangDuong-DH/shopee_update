export type CloneLocationConnection = {
  id:string; revision:number; partnerId:string; shopId:string;
  state:'connected'|'disconnected'; expiresAt:string;
};
export type CloneLocationList = {
  observedAt:string; requestIds:string[];
  rows:Array<{item_id:string|number;item_status:string;update_time:string|number}>;
};
export type CloneLocationRead = {response:any;requestId:string};
export type CloneLocationProof = {
  kind:'signed_existing_item_stock'; partnerId:string; shopId:string;
  connectionId:string;connectionRevision:number;locationId:string;
  listObservedAt:string;listRequestIds:string[];checkedAt:string;
  items:Array<{itemId:string;status:'NORMAL';updateTime:string;
    baseRequestId:string;modelRequestId:string|null;locationIds:string[]}>;
};

const locations=(entries:any[]):string[]=>[...new Set(entries.flatMap(entry=>
  (entry?.stock_info_v2?.seller_stock??[]).map((stock:any)=>String(stock?.location_id??''))
    .filter((id:string)=>id.length>0)))];

// The caller supplies a signed read transport built for this exact connection.
// Every request ID and connection revision is retained for the clone preflight.
export async function proveCloneLocationFromLiveItems(input:{
  connection:CloneLocationConnection;
  readConnection:()=>Promise<CloneLocationConnection>;
  targetList:CloneLocationList;locationId:string;
  read:(path:string,query:Record<string,string>)=>Promise<CloneLocationRead>;
  candidateItemIds?:readonly string[];
  now?:()=>number;
}):Promise<CloneLocationProof>{
  const now=input.now?.()??Date.now();
  const c=input.connection;
  if(!c.id||!Number.isSafeInteger(c.revision)||c.revision<1||!c.partnerId||!c.shopId||
     c.state!=='connected'||Date.parse(c.expiresAt)<=now+60_000)
    throw Error('LOCATION_PROOF_CONNECTION_INVALID');
  if(!input.locationId||!input.targetList.requestIds.length||
     input.targetList.requestIds.some(id=>!id)||
     now-Date.parse(input.targetList.observedAt)<0||
     now-Date.parse(input.targetList.observedAt)>5*60_000)
    throw Error('LOCATION_PROOF_LIST_STALE');
  const eligible=input.targetList.rows.filter(row=>row.item_status==='NORMAL');
  const eligibleById=new Map(eligible.map(row=>[String(row.item_id),row]));
  if(eligibleById.size!==eligible.length)throw Error('LOCATION_PROOF_LIST_DUPLICATE');
  const chosen=input.candidateItemIds?.length
    ? [...new Set(input.candidateItemIds)].map(id=>eligibleById.get(id))
    : eligible.slice(0,8);
  if(chosen.length<2||chosen.some(row=>!row))throw Error('LOCATION_PROOF_CANDIDATES_MISSING');
  const proofItems:CloneLocationProof['items']=[];
  for(const row of chosen){
    if(proofItems.length===2)break;
    const id=String(row!.item_id);
    const base=await input.read('/api/v2/product/get_item_base_info',{item_id_list:id});
    const items=base.response?.item_list;
    if(!base.requestId||!Array.isArray(items)||items.length!==1)
      throw Error('LOCATION_PROOF_BASE_INVALID');
    const item=items[0];
    if(String(item?.item_id)!==id||item.item_status!=='NORMAL'||
       String(item.update_time)!==String(row!.update_time))
      throw Error('LOCATION_PROOF_ITEM_DRIFT');
    let modelRequestId:string|null=null;
    let entries=[item];
    if(item.has_model){
      const models=await input.read('/api/v2/product/get_model_list',{item_id:id});
      if(!models.requestId||!Array.isArray(models.response?.model)||
         models.response.model.length<1)
        throw Error('LOCATION_PROOF_MODELS_INVALID');
      modelRequestId=models.requestId;
      entries=[item,...models.response.model];
    }
    const ids=locations(entries);
    if(ids.includes(input.locationId))proofItems.push({itemId:id,status:'NORMAL',
      updateTime:String(row!.update_time),baseRequestId:base.requestId,
      modelRequestId,locationIds:ids});
  }
  if(proofItems.length!==2)throw Error('LOCATION_PROOF_TWO_ITEMS_MISSING');
  const latest=await input.readConnection();
  const checkedAt=input.now?.()??Date.now();
  if(latest.id!==c.id||latest.revision!==c.revision||
     latest.partnerId!==c.partnerId||latest.shopId!==c.shopId||
     latest.state!=='connected'||Date.parse(latest.expiresAt)<=checkedAt+60_000)
    throw Error('LOCATION_PROOF_CONNECTION_CHANGED');
  if(checkedAt-Date.parse(input.targetList.observedAt)>5*60_000)
    throw Error('LOCATION_PROOF_LIST_STALE');
  return {kind:'signed_existing_item_stock',partnerId:c.partnerId,shopId:c.shopId,
    connectionId:c.id,connectionRevision:c.revision,locationId:input.locationId,
    listObservedAt:input.targetList.observedAt,listRequestIds:[...input.targetList.requestIds],
    checkedAt:new Date(checkedAt).toISOString(),items:proofItems};
}
/** Revalidate a prior proof at the exact preflight using the same live list.
 * A saved proof never substitutes for a current target inventory read. */
export function assertCloneLocationProof(input:{
  proof:CloneLocationProof;connection:CloneLocationConnection;
  targetList:CloneLocationList;expectedLocationId:string;now?:number;
}):void{
  const {proof,connection,targetList,expectedLocationId}=input;
  const now=input.now??Date.now();
  if(proof.kind!=='signed_existing_item_stock'||proof.partnerId!==connection.partnerId||
     proof.shopId!==connection.shopId||proof.connectionId!==connection.id||
     proof.connectionRevision!==connection.revision||proof.locationId!==expectedLocationId||
     proof.listObservedAt!==targetList.observedAt||
     JSON.stringify(proof.listRequestIds)!==JSON.stringify(targetList.requestIds)||
     now-Date.parse(proof.checkedAt)<0||now-Date.parse(proof.checkedAt)>5*60_000||
     now-Date.parse(targetList.observedAt)<0||now-Date.parse(targetList.observedAt)>5*60_000)
    throw Error('LOCATION_PROOF_SCOPE_OR_TTL_INVALID');
  if(proof.items.length!==2||new Set(proof.items.map(item=>item.itemId)).size!==2)
    throw Error('LOCATION_PROOF_ITEMS_INVALID');
  const listById=new Map(targetList.rows.map(row=>[String(row.item_id),row]));
  for(const item of proof.items){
    const live=listById.get(item.itemId);
    if(!live||live.item_status!=='NORMAL'||item.status!=='NORMAL'||
       String(live.update_time)!==item.updateTime||
       !item.locationIds.includes(expectedLocationId)||!item.baseRequestId)
      throw Error('LOCATION_PROOF_ITEMS_INVALID');
  }
}
