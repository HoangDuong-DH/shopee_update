import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnManagedService,inspectManagedClaim} from '../scripts/local-supervisor.mjs';

test('API recovery preserves explicit connection maintenance while keeping publication disabled', async()=>{
 const root=process.cwd(),parent=resolve(root,'.local/maintenance-policy-tests');await mkdir(parent,{recursive:true});const dir=await mkdtemp(resolve(parent,'child-'));let claim;
 try{const file=resolve(dir,'fixture.mjs'),marker=resolve(dir,'flags.json');await writeFile(file,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({maintenance:process.env.CONNECTION_MAINTENANCE_ENABLED,writes:process.env.SHOPEE_PRODUCTION_WRITES,pilot:process.env.PRODUCTION_PILOT_ENABLED,workflow:process.env.PRODUCTION_WORKFLOW_ENABLED}));setInterval(()=>{},1000);`);
 claim=await spawnManagedService({root,role:'api',recipe:{file,args:[file]},env:{CONNECTION_MAINTENANCE_ENABLED:'1',SHOPEE_PRODUCTION_WRITES:'true',PRODUCTION_PILOT_ENABLED:'1',PRODUCTION_WORKFLOW_ENABLED:'1'},logs:dir,saveClaim:async()=>{}});
 let flags;for(let i=0;i<30;i++){try{flags=JSON.parse(await readFile(marker,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,50));}}
 assert.deepEqual(flags,{maintenance:'1',writes:'false',pilot:'0',workflow:'0'});
 }finally{if(claim&&(await inspectManagedClaim(claim,root)).kind==='alive')process.kill(claim.pid);await new Promise(r=>setTimeout(r,100));await rm(dir,{recursive:true,force:true});}
});
import {readConnectionMaintenancePolicy} from '../scripts/connection-maintenance-policy.mjs';
import {supervisorIdentity,sameSupervisorIdentity} from '../scripts/local-supervisor.mjs';
async function policyFixture(fn){const parent=resolve(process.cwd(),'.local/maintenance-policy-tests');await mkdir(parent,{recursive:true});const root=await mkdtemp(resolve(parent,'policy-'));await mkdir(resolve(root,'.local'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('new install has maintenance disabled and never borrows a parent environment opt-in',()=>policyFixture(async root=>{assert.deepEqual(await readConnectionMaintenancePolicy(root),{enabled:false,sha256:'disabled'});}));
test('explicit opt-in survives restart while a transfer hold suppresses renewal',()=>policyFixture(async root=>{await writeFile(resolve(root,'.local/connection-maintenance.json'),JSON.stringify({version:1,enabled:true}));assert.equal((await readConnectionMaintenancePolicy(root)).enabled,true);assert.equal((await readConnectionMaintenancePolicy(root,{recoveryHeld:true})).enabled,false);}));
test('malformed or oversized policy is held instead of enabling external calls',()=>policyFixture(async root=>{const p=resolve(root,'.local/connection-maintenance.json');for(const text of ['null','{"version":1,"enabled":"true"}','{"version":1,"enabled":true,"writes":true}','x'.repeat(1025)]){await writeFile(p,text);await assert.rejects(readConnectionMaintenancePolicy(root),/MAINTENANCE_POLICY_INVALID/);}}));
test('policy change is part of supervised runtime identity',()=>policyFixture(async root=>{for(const dir of ['infra/local','packages/persistence/migrations','apps/web/dist','apps/api/dist','apps/worker/dist','packages/persistence/dist'])await mkdir(resolve(root,dir),{recursive:true});await writeFile(resolve(root,'package.json'),'{"name":"fixture"}');await writeFile(resolve(root,'package-lock.json'),'{"lockfileVersion":3,"packages":{"":{"name":"fixture"}}}');for(const file of ['infra/local/compose.yaml','packages/persistence/migrations/001.sql','apps/web/dist/index.html','apps/api/dist/main.js','apps/worker/dist/main.js','packages/persistence/dist/index.js'])await writeFile(resolve(root,file),'fixture');await writeFile(resolve(root,'.env'),'fixture-only');const a=await supervisorIdentity(root);await writeFile(resolve(root,'.local/connection-maintenance.json'),'{"version":1,"enabled":true}');const b=await supervisorIdentity(root);assert.equal(a.configurationSha256,b.configurationSha256);assert.equal(sameSupervisorIdentity(a,b),false);}));
