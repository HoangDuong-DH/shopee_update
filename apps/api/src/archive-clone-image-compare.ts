import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {
 compareImageBytes,fetchObservedShopeeImage,isImageQcBinding,
 type ImageQcBinding,
} from '../../../packages/shopee/src/image-qc.js';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const shaPattern=/^[a-f0-9]{64}$/;
const limits={meanAbsolute:2.5,p99Absolute:20,maxTileMeanAbsolute:6,maxChannelAbsolute:50,ssim:0.995} as const;
export type CloneImageVisualEvidence={
 version:'archive-clone-image-qc/v1';
 state:'verified'|'manual_review'|'mismatch'|'unresolved';
 basis:'exact_bytes'|'exact_pixels'|'strict_perceptual'|'manual_review_required'|'different'|'unresolved';
 reason:string;
 binding:ImageQcBinding;
 source:{path:string;url:string;sha256:string;bytes:number;width?:number;height?:number};
 target:{url:string;sha256?:string;bytes?:number;width?:number;height?:number};
 metrics?:{
  meanAbsolute:number;p99Absolute:number;maxTileMeanAbsolute:number;maxChannelAbsolute:number;
  globalSsim:number;tiles:number;
 };
 thresholds:typeof limits;
 checkedAt:string;
};
export type CloneImageCompareInput={
 sourcePath:string;sourceUrl:string;sourceSha256:string;
 targetUrl:string;observedTargetUrls:readonly string[];
 binding:ImageQcBinding;
 fetch?:typeof globalThis.fetch;
 evidencePath?:string;
};
const enough=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
async function persist(evidence:CloneImageVisualEvidence,path?:string){
 if(path) await writeFile(path,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
 return evidence;
}
type Decoded={pixels:Buffer;width:number;height:number;format:string};
async function decode(bytes:Uint8Array):Promise<Decoded>{
 const image=sharp(Buffer.from(bytes),{limitInputPixels:16_000_000,failOn:'error'}).timeout({seconds:5});
 const metadata=await image.metadata();
 if(!['jpeg','png','webp'].includes(metadata.format??'')||(metadata.pages??1)!==1)
  throw Error('IMAGE_UNSUPPORTED');
 const {data,info}=await image.rotate().toColourspace('srgb').removeAlpha().raw()
  .toBuffer({resolveWithObject:true});
 if(info.channels!==3) throw Error('IMAGE_CHANNELS_UNSUPPORTED');
 return {pixels:data,width:info.width,height:info.height,format:metadata.format!};
}
function metric(a:Decoded,b:Decoded):NonNullable<CloneImageVisualEvidence['metrics']>{
 if(a.width!==b.width||a.height!==b.height) throw Error('IMAGE_DIMENSIONS_DIFFER');
 const pixels=a.width*a.height,tilesPerSide=32;
 const tileSums=new Float64Array(tilesPerSide*tilesPerSide);
 const tileCounts=new Uint32Array(tilesPerSide*tilesPerSide);
 const histogram=new Uint32Array(256);
 let absolute=0,sumA=0,sumB=0,sumAA=0,sumBB=0,sumAB=0;
 for(let i=0;i<pixels;i++){
  const offset=i*3,x=i%a.width,y=Math.floor(i/a.width);
  const tile=Math.min(tilesPerSide-1,Math.floor(y*tilesPerSide/a.height))*tilesPerSide+
   Math.min(tilesPerSide-1,Math.floor(x*tilesPerSide/a.width));
  let perPixel=0;
  for(let c=0;c<3;c++){
   const av=a.pixels[offset+c]!,bv=b.pixels[offset+c]!;
   const d=Math.abs(av-bv);absolute+=d;perPixel+=d;histogram[d]!++;
  }
  tileSums[tile]+=perPixel;tileCounts[tile]+=3;
  const la=.2126*a.pixels[offset]!+.7152*a.pixels[offset+1]!+.0722*a.pixels[offset+2]!;
  const lb=.2126*b.pixels[offset]!+.7152*b.pixels[offset+1]!+.0722*b.pixels[offset+2]!;
  sumA+=la;sumB+=lb;sumAA+=la*la;sumBB+=lb*lb;sumAB+=la*lb;
 }
 let maxChannelAbsolute=0;for(let d=255;d>=0;d--)if(histogram[d]){maxChannelAbsolute=d;break;}
 let seen=0,p99=255;
 for(let d=0;d<256;d++){seen+=histogram[d]!;if(seen>=pixels*3*.99){p99=d;break;}}
 const meanA=sumA/pixels,meanB=sumB/pixels;
 const varA=Math.max(0,sumAA/pixels-meanA*meanA);
 const varB=Math.max(0,sumBB/pixels-meanB*meanB);
 const cov=sumAB/pixels-meanA*meanB;
 const c1=(.01*255)**2,c2=(.03*255)**2;
 const ssim=((2*meanA*meanB+c1)*(2*cov+c2))/
  ((meanA*meanA+meanB*meanB+c1)*(varA+varB+c2));
 let maxTileMeanAbsolute=0;
 for(let t=0;t<tileSums.length;t++)
  if(tileCounts[t])maxTileMeanAbsolute=Math.max(maxTileMeanAbsolute,tileSums[t]!/tileCounts[t]!);
 return {meanAbsolute:absolute/(pixels*3),p99Absolute:p99,maxTileMeanAbsolute,maxChannelAbsolute,
  globalSsim:ssim,tiles:tileSums.length};
}
function base(input:CloneImageCompareInput,sourceBytes:number):CloneImageVisualEvidence{
 return {version:'archive-clone-image-qc/v1',state:'unresolved',basis:'unresolved',
  reason:'not_checked',binding:structuredClone(input.binding),
  source:{path:input.sourcePath,url:input.sourceUrl,sha256:input.sourceSha256,bytes:sourceBytes},
  target:{url:input.targetUrl},thresholds:limits,checkedAt:new Date().toISOString()};
}
/** Pure-bytes comparison after exact provenance and a trusted remote readback URL are supplied. */
export async function compareCloneImageBytes(input:CloneImageCompareInput,
 sourceBytes:Uint8Array,targetBytes:Uint8Array):Promise<CloneImageVisualEvidence>{
 const result=base(input,sourceBytes.length);
 result.target.sha256=hash(targetBytes);result.target.bytes=targetBytes.length;
 if(!isImageQcBinding(input.binding)||input.binding.role!=='cover'){
  result.reason='cover_binding_required';return result;
 }
 if(!shaPattern.test(input.sourceSha256)||hash(sourceBytes)!==input.sourceSha256){
  result.reason='source_sha_mismatch';return result;
 }
 if(!enough(input.sourceUrl)||!input.sourceUrl.endsWith('/'+input.binding.sourceAssetId)||
  !enough(input.targetUrl)||
  !input.observedTargetUrls.includes(input.targetUrl)||
  !input.targetUrl.endsWith('/'+input.binding.outputImageId)){
  result.reason='target_url_unobserved_or_id_mismatch';return result;
 }
 const basic=await compareImageBytes({source:sourceBytes,output:targetBytes,binding:input.binding});
 if(basic.state==='unresolved'){result.reason=basic.reason;return result;}
 result.source.width=basic.evidence?.source.width;result.source.height=basic.evidence?.source.height;
 result.target.width=basic.evidence?.output.width;result.target.height=basic.evidence?.output.height;
 if(basic.state==='verified'){
  result.state='verified';result.basis=basic.verificationBasis==='exact_bytes'?'exact_bytes':'exact_pixels';
  result.reason=basic.reason;return result;
 }
 if(basic.state==='mismatch'){
  result.state='mismatch';result.basis='different';result.reason=basic.reason;return result;
 }
 if(!basic.metrics?.sameDimensions){
  result.state='manual_review';result.basis='manual_review_required';
  result.reason='dimensions_changed';return result;
 }
 const [a,b]=await Promise.all([decode(sourceBytes),decode(targetBytes)]);
 const metrics=metric(a,b);result.metrics=metrics;
 const strict=a.format==='jpeg'&&b.format==='jpeg'&&a.width>=512&&a.height>=512&&
  metrics.meanAbsolute<=limits.meanAbsolute&&metrics.p99Absolute<=limits.p99Absolute&&
  metrics.maxTileMeanAbsolute<=limits.maxTileMeanAbsolute&&
  metrics.maxChannelAbsolute<=limits.maxChannelAbsolute&&metrics.globalSsim>=limits.ssim;
 result.state=strict?'verified':'manual_review';
 result.basis=strict?'strict_perceptual':'manual_review_required';
 result.reason=strict?'strict_jpeg_reencode_match':'perceptual_threshold_not_met';
 return result;
}
/** Read-only CDN fetch; URL must come from the persisted Shopee readback. */
export async function verifyCloneImageCdn(input:CloneImageCompareInput):Promise<CloneImageVisualEvidence>{
 if(!isImageQcBinding(input.binding)||!shaPattern.test(input.sourceSha256))
  throw Error('ARCHIVE_CLONE_IMAGE_QC_INPUT_INVALID');
 const sourceBytes=await readFile(input.sourcePath);
 const result=base(input,sourceBytes.length);
 if(hash(sourceBytes)!==input.sourceSha256){
  result.reason='source_sha_mismatch';return persist(result,input.evidencePath);
 }
 const fetched=await fetchObservedShopeeImage({url:input.targetUrl,
  observedUrls:input.observedTargetUrls,fetch:input.fetch});
 if(fetched.state!=='fetched'){
  result.reason=fetched.reason;return persist(result,input.evidencePath);
 }
 return persist(await compareCloneImageBytes(input,sourceBytes,fetched.bytes),input.evidencePath);
}






