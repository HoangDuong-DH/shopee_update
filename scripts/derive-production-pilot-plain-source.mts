import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve('.local/production-pilot-1423724897');
const bytes=await readFile(resolve(root,'source-authorized-v2.json'));
const source=JSON.parse(bytes.toString('utf8'));
for(const listing of source.listings){
  if(listing.sourceRevision!==2 || listing.document.description.filter((b:any)=>b.type==='image').length!==9) throw Error('UNEXPECTED_PARENT_SOURCE');
  listing.sourceRevision=3;
  listing.descriptionChange={parentRevision:2,userDecision:'Đăng mô tả chữ; giữ đủ g1–g9 ở bộ ảnh sản phẩm, bìa và ảnh phân loại giữ nguyên',
    removedOnlyDescriptionImageBlocks:9,preservedTextBlocks:true,unchangedRoles:['cover','gallery','variation']};
  listing.document.description=listing.document.description.filter((b:any)=>b.type==='text');
  if(listing.sourceKey==='row-2') listing.supersedesOperationId='85c09451-42b1-4927-b819-7a30dd21a602';
}
source.parentReceipt={path:'source-authorized-v2.json',sha256:createHash('sha256').update(bytes).digest('hex')};
source.assembledAt=new Date().toISOString();
source.decisions.description='plain_text_user_authorized_after_api_rejection';
source.remaining=['Prove no listing created by rejected attempt','New explicit revision attempt with fresh metadata','API readback and publication'];
source.apiCapabilityEvidence={extendedDescription:{state:'unsupported',requestId:'e3e3e7f35b7f9b7fb0e758f0addb4f00',
  operationId:'85c09451-42b1-4927-b819-7a30dd21a602',error:'product.error_param',
  message:'You are not in the whitelist to add images in description, can only upload plain text'}};
await writeFile(resolve(root,'source-authorized-v3.json'),JSON.stringify(source,null,2),{flag:'wx'});
console.log(JSON.stringify({sourceRevision:3,listings:source.listingCount,models:source.modelCount,descriptionImageBlocks:0,galleryPerListing:9,sourceImagesModified:0,mutations:0}));
