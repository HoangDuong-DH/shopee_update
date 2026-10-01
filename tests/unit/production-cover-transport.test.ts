import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {ProductionPilotTransport,productionPilotWriteFingerprint} from '../../packages/shopee/src/production-pilot-transport.js';
const scope={environment:'production' as const,partnerId:'2010476',shopId:'1126307464'};
const credentials={...scope,partnerKey:'fixture-partner-key',accessToken:'fixture-access-token'};
const path='/api/v2/product/update_item';
const payload={item_id:1001,promotion_images:{image_id_list:['fixture_new_cover']}};
it('sends only the exact bound cover and target after a durable permit',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({error:'',request_id:'fixture',response:{item_id:1001}})));
  const claim=vi.fn(async(intent:{fingerprint:string})=>intent.fingerprint===productionPilotWriteFingerprint(path,payload,scope));
  const client=new ProductionPilotTransport(credentials,{transport:fetcher,authorizeMutation:claim});
  expect(await client.write(path,payload,{operationId:randomUUID(),stepId:'cover-v1'})).toMatchObject({kind:'success'});
  expect(claim).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual(payload);
});
it('rejects extra fields, multiple covers, empty IDs and target changes',async()=>{
  const fetcher=vi.fn<typeof fetch>();
  const claim=vi.fn(async(intent:{fingerprint:string})=>intent.fingerprint===productionPilotWriteFingerprint(path,payload,scope));
  const client=new ProductionPilotTransport(credentials,{transport:fetcher,authorizeMutation:claim});
  for(const invalid of [{...payload,item_status:'NORMAL'},{...payload,image:{image_id_list:['other']}},
    {...payload,promotion_images:{image_id_list:[]}},{...payload,promotion_images:{image_id_list:['a','b']}},
    {...payload,promotion_images:{image_id_list:['bad/url']}},{...payload,item_id:0}])
    await expect(client.write(path,invalid,{operationId:randomUUID(),stepId:'cover-v1'})).rejects.toThrow('WRITE_FORBIDDEN');
  expect(claim).not.toHaveBeenCalled();
  await expect(client.write(path,{...payload,item_id:1002},{operationId:randomUUID(),stepId:'cover-v1'})).rejects.toThrow('PERMIT_DENIED');
  expect(fetcher).not.toHaveBeenCalled();
});
