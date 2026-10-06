import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {assertNoLinks} from './onboarding-core.mjs';
/** Explicit local opt-in, independent of listing writes. Missing policy stays disabled. */
export async function readConnectionMaintenancePolicy(root, {recoveryHeld=false}={}) {
 const path=resolve(root,'.local/connection-maintenance.json');await assertNoLinks(path);
 let bytes;
 try{const stat=await lstat(path);if(!stat.isFile()||stat.size>1024)throw Error('MAINTENANCE_POLICY_INVALID');bytes=await readFile(path);}catch(e){if(e.code==='ENOENT')return {enabled:false,sha256:'disabled'};throw e;}
 let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('MAINTENANCE_POLICY_INVALID');}
 if(!value||value.version!==1||typeof value.enabled!=='boolean'||Object.keys(value).some(k=>!['version','enabled'].includes(k)))throw Error('MAINTENANCE_POLICY_INVALID');
 return {enabled:value.enabled&&!recoveryHeld,sha256:createHash('sha256').update(bytes).digest('hex')};
}
