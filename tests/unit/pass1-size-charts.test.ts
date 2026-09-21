import { expect, it, vi } from 'vitest';
import { inspectPass1SizeCharts } from '../../scripts/inspect-pass1-size-charts.mjs';
import { ProductionPilotTransport } from '../../packages/shopee/src/production-pilot-transport.js';

const ok = (response: Record<string, unknown>) => ({ kind: 'success' as const, response, envelope: { error: '' }, requestId: 'fixture-request' });
function fixture() {
 const pages:any[]=[{size_chart_list:[{size_chart_id:71}],total_count:2,next_cursor:'actual-cursor'}, {size_chart_list:[{size_chart_id:'72'}],total_count:'2',next_cursor:''}];
 const read=vi.fn(async(path:string,query:Record<string,string>)=>{
  if(path.endsWith('get_shop_info'))return ok({shop_id:1423724897,shop_name:'Shop',region:'VN',status:'NORMAL'});
  if(path.endsWith('get_item_limit'))return ok({size_chart_limit:{size_chart_mandatory:true,support_image_size_chart:true,support_template_size_chart:true}});
  if(path.endsWith('get_size_chart_list'))return ok(pages.shift());
  return ok({size_chart_id:Number(query.size_chart_id),size_chart_name:'Bảng giày',size_chart_table:{column_list:[{measurement:{display_name:'Chiều dài bàn chân',input_type:'Input Single Number',unit:'cm'},measurement_value_list:[{value:23}]}]}});
 });
 const save=vi.fn(async(_name:string,_value:unknown)=>{});
 return {pages,read,save};
}
it.each(['get_size_chart_list','get_size_chart_detail'])('allows only the new GET diagnostic endpoint %s without mutation authorization', async suffix=>{
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({error:'',response:{size_chart_list:[]},request_id:'request'})));
 const client=new ProductionPilotTransport({environment:'production',partnerId:'2010476',shopId:'1423724897',partnerKey:'fixture-key',accessToken:'fixture-token'},{transport:fetcher});
 const response=await client.read('/api/v2/product/'+suffix,suffix.endsWith('list')?{category_id:'100265',page_size:'50'}:{size_chart_id:'71'});
 expect(response.kind).toBe('success');expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
});
it('reads exact category, follows actual cursor, reads only returned IDs and never selects a chart',async()=>{
 const f=fixture(),result=await inspectPass1SizeCharts(f);
 expect(f.read.mock.calls.map(call=>call[0])).toEqual(['/api/v2/shop/get_shop_info','/api/v2/product/get_item_limit','/api/v2/product/get_size_chart_list','/api/v2/product/get_size_chart_list','/api/v2/product/get_size_chart_detail','/api/v2/product/get_size_chart_detail']);
 expect(f.read.mock.calls[2]?.[1]).toEqual({category_id:'100265',page_size:'50'});expect(f.read.mock.calls[3]?.[1]).toEqual({category_id:'100265',page_size:'50',cursor:'actual-cursor'});
 expect(f.read.mock.calls.slice(4).map(call=>call[1])).toEqual([{size_chart_id:'71'},{size_chart_id:'72'}]);
 expect(result).toMatchObject({readOnly:true,mutations:0,categoryId:'100265',selectedChartId:null,suitableForSourceVerified:false,sizeChartLimit:{size_chart_mandatory:true}});
 expect(result.charts).toHaveLength(2);expect(result.charts[0].columns[0].measurement.display_name).toBe('Chiều dài bàn chân');
});
it('keeps the mandatory requirement when the shop has no size charts',async()=>{
 const f=fixture();f.pages.splice(0,2,{size_chart_list:[],total_count:0,next_cursor:''});
 const result=await inspectPass1SizeCharts(f);expect(result.charts).toEqual([]);expect(result.sizeChartLimit.size_chart_mandatory).toBe(true);expect(f.read).toHaveBeenCalledTimes(3);
});
it('accepts the observed omitted array only with explicit zero total and terminal cursor',async()=>{
 const f=fixture();f.pages.splice(0,2,{total_count:0,next_cursor:''});
 const result=await inspectPass1SizeCharts(f);expect(result.charts).toEqual([]);expect(result.sizeChartLimit.size_chart_mandatory).toBe(true);
});
it.each([{total_count:1,next_cursor:''},{total_count:0,next_cursor:'more'},{total_count:0},{total_count:0,next_cursor:'',size_chart_list:null}])('does not infer absent/malformed pages mean zero charts: %j',async page=>{
 const f=fixture();f.pages.splice(0,2,page);await expect(inspectPass1SizeCharts(f)).rejects.toThrow(/^PASS1_SIZE_CHART_/);
});
it.each(['wrong-shop','duplicate-id','cursor-cycle','count-mismatch','invalid-id','wrong-detail-id','denied'])('stops and preserves the recorded response for %s',async fault=>{
 const f=fixture();
 if(fault==='wrong-shop')f.read.mockResolvedValueOnce(ok({shop_id:7,shop_name:'Other',region:'VN',status:'NORMAL'}));
 if(fault==='duplicate-id')f.pages[1].size_chart_list=[{size_chart_id:71}];
 if(fault==='cursor-cycle')f.pages[1].next_cursor='actual-cursor';
 if(fault==='count-mismatch')f.pages[1].total_count=3;
 if(fault==='invalid-id')f.pages[0].size_chart_list=[{size_chart_id:9007199254740992}];
 if(fault==='wrong-detail-id'){const original=f.read.getMockImplementation()!;f.read.mockImplementation(async(path,query)=>path.endsWith('detail')?ok({size_chart_id:999,size_chart_name:'Wrong',size_chart_table:{column_list:[]}}):original(path,query));}
 if(fault==='denied')f.read.mockResolvedValueOnce({kind:'rejected',code:'error_api_permission',envelope:{error:'error_api_permission'},requestId:'denied'} as any);
 await expect(inspectPass1SizeCharts(f)).rejects.toThrow(/^PASS1_SIZE_CHART_/);expect(f.save).toHaveBeenCalled();
 if(fault==='wrong-shop'||fault==='denied')expect(f.read).toHaveBeenCalledTimes(1);
});
