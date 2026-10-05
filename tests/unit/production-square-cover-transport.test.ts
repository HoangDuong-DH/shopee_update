import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ProductionPilotTransport, productionPilotWriteFingerprint, type ProductionPilotMutationIntent } from '../../packages/shopee/src/production-pilot-transport.js';
const scope = { environment:'production' as const, partnerId:'2010476', shopId:'1039879415' };
const credentials = {...scope, partnerKey:'fixture-key', accessToken:'fixture-token'};
const path = '/api/v2/product/update_item';
const body = {item_id:9001,image:{image_ratio:'1:1',image_id_list:['uploaded-cover','retained-g2','retained-g3']}};
const permit = () => ({operationId:randomUUID(),stepId:'update-cover'});
const response = () => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({error:'',request_id:'fixture',response:{item_id:9001}})));
describe('square cover transport',()=>{
 it('binds the original retained gallery and selected shop into the permit',async()=>{
  const transport=response(); const fingerprint=productionPilotWriteFingerprint(path,body,scope);
  const authorizeMutation=vi.fn(async (intent: Readonly<ProductionPilotMutationIntent>)=>intent.fingerprint===fingerprint);
  const result=await new ProductionPilotTransport(credentials,{transport,authorizeMutation}).write(path,body,permit());
  expect(result.kind).toBe('success'); expect(authorizeMutation).toHaveBeenCalledOnce();
  const [address,init]=transport.mock.calls[0]!;
  expect(new URL(String(address)).searchParams.get('shop_id')).toBe(scope.shopId);
  expect(JSON.parse(String(init?.body))).toEqual(body);
 });
 it('requires a durable permit and denies a cross-shop fingerprint',async()=>{
  const transport=response();
  await expect(new ProductionPilotTransport(credentials,{transport}).write(path,body,permit())).rejects.toThrow('PRODUCTION_PILOT_PERMIT_REQUIRED');
  const other=productionPilotWriteFingerprint(path,body,{...scope,shopId:'1286166423'});
  await expect(new ProductionPilotTransport(credentials,{transport,authorizeMutation:async intent=>intent.fingerprint===other}).write(path,body,permit())).rejects.toThrow('PRODUCTION_PILOT_PERMIT_DENIED');
  expect(transport).not.toHaveBeenCalled();
 });
 it.each([
  {...body,image:{...body.image,image_ratio:'3:4'}},
  {...body,image:{...body.image,image_id_list:[]}},
  {...body,image:{...body.image,image_id_list:Array.from({length:10},(_,i)=>'id-'+i)}},
  {...body,image:{...body.image,image_id_list:['same','same']}},
  {...body,item_status:'NORMAL'},
  {...body,item_name:'Changed'},
  {...body,stock:1000},
  {...body,promotion_images:{image_id_list:['uploaded-cover']}},
 ])('rejects unsupported or wider updates before sending %j',invalid=>{
  expect(()=>productionPilotWriteFingerprint(path,invalid,scope)).toThrow('PRODUCTION_PILOT_WRITE_FORBIDDEN');
 });
});