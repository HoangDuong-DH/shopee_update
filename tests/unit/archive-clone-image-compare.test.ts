import {createHash,randomUUID} from 'node:crypto';
import {readFile,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {expect,it} from 'vitest';
import {compareCloneImageBytes,verifyCloneImageCdn} from '../../apps/api/src/archive-clone-image-compare.js';

const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const url='https://cf.shopee.vn/file/target-cover';
const binding={environment:'production' as const,partnerId:'2010476',shopId:'966101536',
 itemId:'46518636276',operationId:'fixture-op',role:'cover' as const,position:0,
 sourceAssetId:'source-cover',outputImageId:'target-cover'};
async function fixtures(){
 const svg=Buffer.from('<svg width="700" height="700"><rect width="700" height="700" fill="#f5dfdb"/><circle cx="350" cy="330" r="195" fill="#177fa3"/><text x="105" y="105" font-size="56" fill="#24344b">FAMONY 2.1L</text><text x="180" y="600" font-size="43" fill="#24344b">Organic Care</text></svg>');
 const source=await sharp(svg).jpeg({quality:96}).toBuffer();
 const recompressed=await sharp(source).jpeg({quality:83}).toBuffer();
 const altered=await sharp(recompressed).composite([{input:Buffer.from('<svg width="12" height="12"><rect width="12" height="12" fill="#e71d36"/></svg>'),left:145,top:80}]).jpeg({quality:83}).toBuffer();
 const input={sourcePath:'fixture-source.jpg',sourceUrl:'https://cf.shopee.vn/file/source-cover',
  sourceSha256:hash(source),targetUrl:url,observedTargetUrls:[url],binding};
 return {source,recompressed,altered,input};
}
it('accepts tested JPEG recompression with a strict local-content gate',async()=>{
 const f=await fixtures();
 const result=await compareCloneImageBytes(f.input,f.source,f.recompressed);
 expect(result.state).toBe('verified');
 expect(result.basis).toBe('strict_perceptual');
 expect(result.source.sha256).toBe(hash(f.source));
 expect(result.target.sha256).toBe(hash(f.recompressed));
 expect(result.metrics!.globalSsim).toBeGreaterThan(.995);
});
it('routes a local cover alteration and an unobserved target URL to review',async()=>{
 const f=await fixtures();
 const altered=await compareCloneImageBytes(f.input,f.source,f.altered);
 expect(altered.state).not.toBe('verified');
 const forged=await compareCloneImageBytes({...f.input,targetUrl:'https://cf.shopee.vn/file/other'},
  f.source,f.recompressed);
 expect(forged.state).toBe('unresolved');
 expect(forged.reason).toBe('target_url_unobserved_or_id_mismatch');
});
it('records read-only CDN evidence with both hashes and refuses a non-image response',async()=>{
 const f=await fixtures();
 const sourcePath=join(tmpdir(),'clone-source-'+randomUUID()+'.jpg');
 const evidencePath=join(tmpdir(),'clone-evidence-'+randomUUID()+'.json');
 await writeFile(sourcePath,f.source);
 try{
  const fetcher=(async()=>new Response(f.recompressed,{status:200,headers:{
   'content-type':'image/jpeg','content-length':String(f.recompressed.length),
  }})) as typeof fetch;
  const result=await verifyCloneImageCdn({...f.input,sourcePath,evidencePath,fetch:fetcher});
  expect(result.state).toBe('verified');
  const persisted=JSON.parse(await readFile(evidencePath,'utf8'));
  expect(persisted.target.sha256).toBe(hash(f.recompressed));
  expect(persisted.target.url).toBe(url);
  const html=(async()=>new Response('<html>error</html>',{status:200,headers:{
   'content-type':'text/html',
  }})) as typeof fetch;
  const bad=await verifyCloneImageCdn({...f.input,sourcePath,fetch:html});
  expect(bad.state).toBe('unresolved');
 }finally{await unlink(sourcePath);await unlink(evidencePath);}
});


