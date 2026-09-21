import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, Repository, probeMigrations } from '@shopee/persistence';
import { ProductionPilotRunner } from '../apps/api/src/production-pilot-runner.js';
import { collectProductionPilotInput, loadProductionPilotSource, pilotProbeAuthorization, productionPilotSourceRoot } from '../apps/api/src/production-pilot-source.js';
import { planPreparedWireCreate, preparedWireMediaRequirements } from '../packages/shopee/src/prepared-wire.js';

// Trusted operator entry point for exactly the two user-authorized sources. Default is read-only planning.
const execute = process.argv[2] === 'execute';
if (process.argv[2] && !['inspect','execute'].includes(process.argv[2])) throw Error('INVALID_ACTION');
const preflightId = process.argv[3];
if (!preflightId || !/^[0-9a-f-]{36}$/.test(preflightId)) throw Error('PREFLIGHT_ID_REQUIRED');
const pool = new Pool({ connectionString: process.env.DATABASE_URL }), repo = new Repository(pool);
const runId = randomUUID(), evidenceDir = resolve(productionPilotSourceRoot,'runs',runId);
await mkdir(evidenceDir,{recursive:true});
const events: unknown[] = [];
async function note(value: unknown) {
  events.push({at:new Date().toISOString(),value});
  await writeFile(resolve(evidenceDir,'progress.json'),JSON.stringify({runId,events},null,2));
  console.log(JSON.stringify(value));
}
try {
  const loaded = await loadProductionPilotSource();
  const first = JSON.parse(await readFile(resolve(productionPilotSourceRoot,'preflight',preflightId,'input.json'),'utf8'));
  if (first.sourceReceiptSha256 !== loaded.sha256 || first.sourceKey !== 'row-2') throw Error('SOURCE_PREFLIGHT_MISMATCH');
  const allowedSources = loaded.value.listings.map((s:any)=>({sourceIdentity:s.sourceIdentity,sourceRevision:s.sourceRevision}));
  const runner = new ProductionPilotRunner(repo,{allowedSources,assetRoot:resolve(productionPilotSourceRoot,'assets'),
    evidenceRoot:resolve(productionPilotSourceRoot,'wire-evidence'),capabilityProbe:{...allowedSources[0],authorizationReference:pilotProbeAuthorization}});
  const input = first.input;
  const requirements = preparedWireMediaRequirements(input.document);
  const inspection = planPreparedWireCreate(input.document,{...input.context,
    // An explicit source-bound experiment, never persisted as a supported shop capability.
    capabilities:{gallery34:true,extendedDescription:true},
    images:requirements.map((r,i)=>({importId:r.media.importId,sha256:r.media.sha256,role:r.role,imageId:'PREFLIGHT_ONLY_'+i}))});
  await note({phase:'plan',sourceKey:'row-2',result:inspection.kind,
    ...(inspection.kind==='blocked'?{issues:inspection.issues}:{apiSteps:inspection.steps.map(s=>s.path),mediaCalls:requirements.length}),
    sourceReceiptSha256:loaded.sha256,execute});
  if (inspection.kind!=='ready') {process.exitCode=1;} else if(execute) {
    await probeMigrations(pool);
    const existing = await pool.query('SELECT id,state FROM production_pilot_operations WHERE owner_key=$1', ['production:2010476:1423724897']);
    if(existing.rows.length) throw Error('PRODUCTION_PILOT_EXISTING_OPERATION_READ_ONLY_RECOVERY_REQUIRED');
    let firstVerifiedId: string | undefined;
    for(const source of loaded.value.listings) {
      let preparedInput = input;
      if(source.sourceKey!=='row-2') {
        if(!firstVerifiedId) throw Error('PRODUCTION_PILOT_CAPABILITY_PROOF_REQUIRED');
        const proof=await runner.capabilityEvidenceFromVerified(firstVerifiedId,input.connectionRevision,new Date().toISOString(),[resolve(productionPilotSourceRoot,'wire-evidence',firstVerifiedId)]);
        const next=await collectProductionPilotInput(repo,source.sourceKey,{priorCapabilityEvidence:proof,allowExistingListings:true});
        preparedInput=next.input;
      }
      if(Date.parse(preparedInput.metadata.expiresAt)<=Date.now()) throw Error('PRODUCTION_PILOT_METADATA_STALE');
      const prepared=await runner.prepare(preparedInput);
      await note({phase:'prepared',sourceKey:source.sourceKey,result:prepared});
      if(prepared.kind!=='ready') { process.exitCode=1; break; }
      const result=await runner.run(prepared.operationId);
      await note({phase:'create-readback',sourceKey:source.sourceKey,result});
      if(result.state!=='verified') { process.exitCode=1; break; }
      firstVerifiedId??=result.operationId;
      const published=await runner.publish(result.operationId,preparedInput.metadata);
      await note({phase:'publish-readback',sourceKey:source.sourceKey,result:published});
      if(published.state!=='published') { process.exitCode=1; break; }
    }
  }
} catch(error) {
  const text=error instanceof Error?error.message:'';
  await note({phase:'stopped',code:/^[A-Z0-9_]+$/.test(text)?text:'PRODUCTION_PILOT_INSPECTION_REQUIRED'});
  process.exitCode=1;
} finally { await pool.end(); }
console.log(JSON.stringify({runId,evidenceDir,progressSha256:createHash('sha256').update(await readFile(resolve(evidenceDir,'progress.json'))).digest('hex')}));
