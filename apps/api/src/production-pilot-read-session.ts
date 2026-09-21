import { z } from 'zod';
import { canonicalJson } from '@shopee/domain';
import type { PreparedWireResponse } from '../../../packages/shopee/src/prepared-transport.js';

const cacheable = new Set(['product/get_category','product/get_attribute_tree','product/get_brand_list','logistics/get_channel_list'].map(path=>'/api/v2/'+path));
const scopeSchema=z.object({environment:z.literal('production'),partnerId:z.literal('2010476'),shopId:z.literal('1423724897'),connectionRevision:z.number().int().positive()}).strict();
const secretFields=new Set(['partner_id','partner_key','shop_id','access_token','refresh_token','timestamp','sign','authorization']);
export type ProductionPilotReadEvidence={observedAt:string;file:string;result:PreparedWireResponse};
type Options={batchId:string;manifestSha256:string;maxAgeMs?:number;now?:()=>number};
/** Process-local session for one immutable batch. Original evidence is never re-dated. */
export class ProductionPilotReadSession {
  private readonly binding: {batchId:string;manifestSha256:string;maxAgeMs:number};
  private readonly now:()=>number;
  private readonly cached=new Map<string,{value:ProductionPilotReadEvidence;bytes:number}>();
  private readonly inFlight=new Map<string,Promise<ProductionPilotReadEvidence>>();
  private byteCount=0;
  constructor(options:Options) {
    this.binding=z.object({batchId:z.string().uuid(),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/),maxAgeMs:z.number().int().min(1).max(300000)}).parse({...options,maxAgeMs:options.maxAgeMs??120000});
    this.now=options.now??Date.now;
  }
  assertManifest(sha:string) {if(sha!==this.binding.manifestSha256)throw Error('PRODUCTION_READ_SESSION_SOURCE_CHANGED');}
  async read(scope:z.input<typeof scopeSchema>,path:string,query:Record<string,string>,load:()=>Promise<ProductionPilotReadEvidence>):Promise<ProductionPilotReadEvidence&{cacheHit:boolean}> {
    const checked=scopeSchema.parse(scope);
    if(Object.entries(query).some(([key,value])=>secretFields.has(key.toLowerCase())||typeof value!=='string'))throw Error('PRODUCTION_READ_SESSION_QUERY_FORBIDDEN');
    if(!cacheable.has(path))return {...await load(),cacheHit:false};
    const key=canonicalJson({scope:checked,path,query});
    const entry=this.cached.get(key);
    if(entry){const age=this.now()-Date.parse(entry.value.observedAt);if(age>=0&&age<this.binding.maxAgeMs)return {...structuredClone(entry.value),cacheHit:true};this.cached.delete(key);this.byteCount-=entry.bytes;}
    const pending=this.inFlight.get(key);
    if(pending)return {...structuredClone(await pending),cacheHit:true};
    const promise=(async()=>{
      const value=structuredClone(await load());
      const age=this.now()-Date.parse(value.observedAt);
      if(value.result.kind==='success'&&typeof value.result.requestId==='string'&&value.result.requestId&&value.file&&age>=0&&age<this.binding.maxAgeMs){
        const bytes=Buffer.byteLength(JSON.stringify(value));
        // Operational memory bounds, independent of Shopee response or quota limits.
        if(bytes<=16*1024*1024){
          while(this.cached.size>=256||this.byteCount+bytes>16*1024*1024){const oldest=this.cached.entries().next().value;if(!oldest)break;this.cached.delete(oldest[0]);this.byteCount-=oldest[1].bytes;}
          this.cached.set(key,{value,bytes});this.byteCount+=bytes;
        }
      }
      return value;
    })();
    this.inFlight.set(key,promise);
    try{return {...structuredClone(await promise),cacheHit:false};}finally{if(this.inFlight.get(key)===promise)this.inFlight.delete(key);}
  }
}
