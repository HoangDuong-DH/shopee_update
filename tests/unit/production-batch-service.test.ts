import { randomUUID, createHash } from 'node:crypto';
import { canonicalJson } from '@shopee/domain';
import { productionPilotWriteFingerprint } from '../../packages/shopee/src/production-pilot-transport.js';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  ProductionBatchService,
  registerProductionBatch,
} from '../../apps/api/src/production-batch-service.js';
import { productionBatchPass1Root } from '../../apps/api/src/production-batch-source.js';
import { runPass1ProductionBatch } from '../../apps/api/src/production-batch-runner.js';
import { coreProjectionWithoutImages } from '../../apps/api/src/production-pilot-image-deferral.js';
let root: string;
beforeEach(async () => {
  await mkdir(productionBatchPass1Root, { recursive: true });
  root = await mkdtemp(resolve(productionBatchPass1Root, 'service-test-'));
});
function fixture() {
  const batchId = randomUUID(),
    loaded: any = {
      manifestPath: resolve(root, 'input.json'),
      sha256: 'a'.repeat(64),
      value: {
        batchId,
        authorizationReference: 'Explicit user batch approval',
        assets: {},
        listings: [
          {
            sourceIdentity: 'pass1:a',
            sourceRevision: 1,
            sourceKey: 'a',
            document: { title: 'Listing có sẵn', models: [{ sku: 'SKU-A' }] },
          },
        ],
      },
    };
  const load = vi.fn(async () => loaded),
    run = vi.fn(async (_input: any, _dependencies?: any) => ({
      stopped: false,
      listings: [{ sourceKey: 'a', state: 'inspected' }],
    })),
    query = vi.fn(async (_sql: string, _values?: any[]) => ({ rows: [] as any[] }));
  const locks = new Map<string, symbol>();
  const connect = vi.fn(async () => {
    const token = Symbol('session');
    return {
      query: vi.fn(async (sql: string, values: string[]) => {
        const key = values[0]!;
        if (sql.includes('pg_try_advisory_lock')) {
          const held = locks.get(key);
          if (!held) locks.set(key, token);
          return { rows: [{ locked: !held || held === token }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          if (locks.get(key) === token) locks.delete(key);
          return { rows: [{ unlocked: true }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
  });
  const repo = { pool: { query, connect } };
  const options: any = { root, load, run, enabled: true };
  return {
    loaded,
    load,
    run,
    query,
    options,
    repo,
    crash: () => locks.clear(),
    service: new ProductionBatchService(repo as any, {} as any, options),
  };
}
it('keeps registration server-only, rechecks the source and never exposes local paths', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const result = await f.service.list();
  expect(result.batches[0]).toMatchObject({
    batchId: f.loaded.value.batchId,
    listings: [{ title: 'Listing có sẵn', state: 'not_sent' }],
  });
  expect(JSON.stringify(result)).not.toContain(f.loaded.manifestPath);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.query.mock.calls[0]?.[1]).toEqual(['production:2010476:1423724897', ['pass1:a']]);
});
function completeFixture(f: ReturnType<typeof fixture>, fault = 'valid') {
  const source = f.loaded.value.listings[0],
    scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' };
  const fp = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  f.loaded.value.scope = scope;
  Object.assign(source, {
    proposedAttributeList: [],
    brandName: 'Original brand',
    condition: 'NEW',
    preOrder: { is_pre_order: false },
    stockLocation: {
      writeLocationBySku: { 'SKU-A': null },
      expectedLocationBySku: { 'SKU-A': 'VNZ' },
    },
  });
  Object.assign(source.document, {
    sourceKey: source.sourceIdentity,
    cover: { importId: 'source-cover' },
    gallery: [],
    description: [],
    tierNames: [],
  });
  const batchAuthorization = {
    batchId: f.loaded.value.batchId,
    manifestSha256: f.loaded.sha256,
    authorizationReference: f.loaded.value.authorizationReference,
    sources: [
      {
        sourceIdentity: source.sourceIdentity,
        sourceRevision: 1,
        documentSha256: fp(source.document),
      },
    ],
  };
  const payload = {
    sourceIdentity: source.sourceIdentity,
    sourceRevision: 1,
    connectionId: 'connection-a',
    connectionRevision: 1,
    document: source.document,
    assets: {},
    batchAuthorization,
    context: {
      attributeList: [],
      brandName: source.brandName,
      condition: source.condition,
      preOrder: source.preOrder,
      stockLocationBySku: source.stockLocation.writeLocationBySku,
    },
    stockLocationEvidence: { expectedLocationBySku: source.stockLocation.expectedLocationBySku },
    metadata: scope,
  };
  const projection = { status: 'UNLIST', title: source.document.title };
  const operation: any = {
    id: randomUUID(),
    source_identity: source.sourceIdentity,
    source_revision: 1,
    owner_key: 'production:2010476:1423724897',
    source_payload: payload,
    expected_projection: projection,
    connection_id: 'connection-a',
    connection_revision: 1,
    state: 'verified',
    revision: 7,
    item_id: '5001',
    source_fingerprint: fp({
      scope,
      sourceIdentity: source.sourceIdentity,
      sourceRevision: 1,
      sourcePayload: payload,
      expectedProjection: projection,
    }),
  };
  function proof(op: any, phase: string, expected: any) {
    const readbacks = [0, 1].map((index) => ({
      shopId: '1423724897',
      partnerId: '2010476',
      itemId: '5001',
      observedAt: new Date(1750000000000 + 1000 * index).toISOString(),
      requestIds: [phase + index],
      raw: { test: phase },
      rawSha256: fp({ test: phase }),
      projection: expected,
      projectionSha256: fp(expected),
    }));
    return {
      id: randomUUID(),
      operation_id: op.id,
      operation_revision: op.revision - 1,
      item_id: '5001',
      phase,
      expected_fingerprint: fp(expected),
      readbacks,
      evidence_fingerprint: fp(readbacks),
    };
  }
  const verification = proof(operation, 'created_unlisted', projection),
    publishPayload = { item_list: [{ item_id: 5001, unlist: false }] },
    receipt = {
      kind: 'success',
      response: { success_list: publishPayload.item_list, failure_list: [] },
    };
  const publication: any = {
    id: randomUUID(),
    state: 'verified',
    revision: 4,
    owner_key: operation.owner_key,
    create_operation_id: operation.id,
    create_verification_id: verification.id,
    source_identity: source.sourceIdentity,
    source_revision: 1,
    source_fingerprint: operation.source_fingerprint,
    item_id: '5001',
    connection_id: 'connection-a',
    connection_revision: 1,
    path: '/api/v2/product/unlist_item',
    payload: publishPayload,
    fingerprint: productionPilotWriteFingerprint('/api/v2/product/unlist_item', publishPayload),
    receipt,
    outcome_fingerprint: fp(receipt),
    expected_projection: projection,
  };
  const row: any = {
    operation,
    verification,
    publication,
    publication_verification: proof(publication, 'published', {
      ...projection,
      status: 'NORMAL',
    }),
    current_connection: {
      id: 'connection-a',
      environment: 'production',
      partner_id: '2010476',
      shop_id: '1423724897',
      state: 'connected',
      revision: 1,
    },
    steps: [
      { step_key: 'media-0', state: 'acknowledged' },
      { step_key: 'create', state: 'acknowledged' },
    ],
  };
  if (fault === 'missing-create-ACK') row.steps.pop();
  if (fault === 'wrong-create-fingerprint') verification.expected_fingerprint = 'f'.repeat(64);
  if (fault === 'wrong-publication-relation') publication.create_verification_id = randomUUID();
  if (fault === 'altered-receipt')
    publication.receipt.response.failure_list.push({ item_id: 5001 });
  if (fault === 'changed-source-context') payload.context.brandName = 'Other brand';
  f.query.mockResolvedValue({ rows: [row] });
  return row;
}
function deferredFixture(f: ReturnType<typeof fixture>) {
  f.loaded.value.publicationMode='hidden_for_review';f.loaded.value.imageQcPolicy='defer_image_qc';
  const row=completeFixture(f),op=row.operation;
  Object.assign(op.source_payload.batchAuthorization,{publicationMode:'hidden_for_review',imageQcPolicy:'defer_image_qc'});
  const fp=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
  op.state='acknowledged';op.revision=6;
  op.source_fingerprint=fp({scope:f.loaded.value.scope,sourceIdentity:op.source_identity,sourceRevision:op.source_revision,sourcePayload:op.source_payload,expectedProjection:op.expected_projection});
  row.deferred_image_verification={operation_id:op.id,operation_revision:op.revision,item_id:op.item_id,source_fingerprint:op.source_fingerprint,basis:'image_qc_deferred_by_operator',expected_core_fingerprint:fp(op.expected_projection),readbacks:row.verification.readbacks,evidence_fingerprint:row.verification.evidence_fingerprint};
  row.verification=null;row.publication=null;row.publication_verification=null;
  return row;
}
it('exposes an old lane blocker and permits the same undispatched reservation only after the lane clears',async()=>{
  const f=fixture(),row=completeFixture(f),op=row.operation;
  Object.assign(op,{state:'authorized',revision:1,item_id:null});
  Object.assign(row,{steps:[],verification:null,publication:null,publication_verification:null});
  const oldBatch=randomUUID(),oldOperation=randomUUID();
  const oldLoaded=structuredClone(f.loaded);oldLoaded.value.batchId=oldBatch;oldLoaded.manifestPath=resolve(root,'old-manifest');
  oldLoaded.value.listings[0].sourceIdentity='prior-source';oldLoaded.value.listings[0].sourceKey='prior-key';
  f.load.mockImplementation(async(...args:unknown[])=>String(args[0]).endsWith('old-manifest')?oldLoaded:f.loaded);
  await registerProductionBatch({manifestPath:'old-manifest',expectedSha256:oldLoaded.sha256},f.options);
  await registerProductionBatch({manifestPath:f.loaded.manifestPath,expectedSha256:f.loaded.sha256},f.options);
  let held=true;
  f.query.mockImplementation(async(sql:string)=>({rows:sql.includes('FROM production_pilot_lanes')
    ? held?[{operation_id:oldOperation,item_id:'45417908562',title:'Xịt Hương Thảo đã tạo',batch_id:oldBatch,source_identity:'prior-source',state:'acknowledged'}]:[]
    : [row]}));
  const blocked=await f.service.status(f.loaded.value.batchId);
  expect(blocked).toMatchObject({canExecute:false,canReconcile:false,listings:[{state:'authorized_not_started',operationId:op.id}],
    blockingWork:{operationId:oldOperation,itemId:'45417908562',title:'Xịt Hương Thảo đã tạo',batchId:oldBatch,sourceKey:'prior-key',state:'awaiting_reconciliation'}});
  await expect(f.service.start(f.loaded.value.batchId,{mode:'execute',expectedStatusFingerprint:blocked.statusFingerprint})).rejects.toThrow('RECONCILIATION_REQUIRED');
  held=false;
  const ready=await f.service.status(f.loaded.value.batchId);
  expect(ready.canExecute).toBe(true);expect(ready).not.toHaveProperty('blockingWork');
  expect(ready.statusFingerprint).not.toBe(blocked.statusFingerprint);
  await expect(f.service.start(f.loaded.value.batchId,{mode:'execute',expectedStatusFingerprint:blocked.statusFingerprint})).rejects.toThrow('STATUS_CHANGED');
  expect(f.run).not.toHaveBeenCalled();
  await f.service.start(f.loaded.value.batchId,{mode:'execute',expectedStatusFingerprint:ready.statusFingerprint});
  await vi.waitFor(async()=>expect((await f.service.status(f.loaded.value.batchId)).busy).toBe(false));
  expect(f.run).toHaveBeenCalledOnce();
});
it.each(['reserved-step','higher-revision','unexpected-item','verification'])('does not treat %s as an undispatched retry',async(fault)=>{
  const f=fixture(),row=completeFixture(f),op=row.operation;
  Object.assign(op,{state:'authorized',revision:1,item_id:null});
  Object.assign(row,{steps:[],verification:null,publication:null,publication_verification:null});
  if(fault==='reserved-step')row.steps=[{step_key:'media-0',state:'authorized'}];
  if(fault==='higher-revision')op.revision=2;
  if(fault==='unexpected-item')op.item_id='5001';
  if(fault==='verification')row.verification={id:randomUUID()};
  await registerProductionBatch({manifestPath:f.loaded.manifestPath,expectedSha256:f.loaded.sha256},f.options);
  expect(await f.service.status(f.loaded.value.batchId)).toMatchObject({canExecute:false,listings:[{state:'needs_review'}]});
  expect(f.run).not.toHaveBeenCalled();
});
it('counts an explicit deferred-image hidden receipt as created while never offering publication or claiming full verification',async()=>{
  const f=fixture();deferredFixture(f);
  await registerProductionBatch({manifestPath:f.loaded.manifestPath,expectedSha256:f.loaded.sha256},f.options);
  const status=await f.service.status(f.loaded.value.batchId);
  expect(status).toMatchObject({state:'completed',imageQcPolicy:'defer_image_qc',imageQcPendingCount:1,completedCount:1,createdVerifiedCount:0,publishedCount:0,canExecute:false,canReconcile:true,
    listings:[{state:'created_hidden_image_qc_deferred',imageQcStatus:'deferred',canPublish:false}]});
  await expect(f.service.publish(f.loaded.value.batchId,{sourceKey:'a',expectedStatusFingerprint:status.statusFingerprint})).rejects.toThrow('PUBLICATION_NOT_READY');
  expect(f.run).not.toHaveBeenCalled();
});

async function deferredOrphanFixture() {
  const f = fixture();
  f.loaded.value.publicationMode = 'hidden_for_review';
  f.loaded.value.imageQcPolicy = 'defer_image_qc';
  await registerProductionBatch({manifestPath:f.loaded.manifestPath,expectedSha256:f.loaded.sha256},f.options);
  const before = await f.service.status(f.loaded.value.batchId);
  f.run.mockImplementation(() => new Promise(() => {}));
  const original = await f.service.start(f.loaded.value.batchId, {mode:'execute',expectedStatusFingerprint:before.statusFingerprint});
  f.crash();
  const row = deferredFixture(f);
  const peer = new ProductionBatchService(f.repo as any, {} as any, f.options);
  f.run.mockResolvedValue({stopped:false,listings:[{sourceKey:'a',state:'created_hidden_image_qc_deferred'}]});
  return {...f,row,peer,original};
}

async function realCoordinatorDeferredOrphan() {
  const f=await deferredOrphanFixture(),op=f.row.operation;
  const fp=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
  Object.assign(op.expected_projection,{
    cover:{imageId:'cover-awaiting-qc'},gallery:[{imageId:'gallery-awaiting-qc'}],
    description:[{type:'text',text:'Original body'},{type:'image',image:{imageId:'description-awaiting-qc'}}],
    models:[{sku:'SKU-A',originalPrice:'123000',stock:100,image:{imageId:'variant-awaiting-qc'}}],
  });
  op.source_fingerprint=fp({scope:f.loaded.value.scope,sourceIdentity:op.source_identity,sourceRevision:op.source_revision,sourcePayload:op.source_payload,expectedProjection:op.expected_projection});
  const receipt=f.row.deferred_image_verification,core=coreProjectionWithoutImages(op.expected_projection);
  receipt.source_fingerprint=op.source_fingerprint;receipt.expected_core_fingerprint=fp(core);
  for(const read of receipt.readbacks){read.projection=structuredClone(core);read.projectionSha256=fp(core);}
  receipt.evidence_fingerprint=fp(receipt.readbacks);
  const checkpointDirectory=resolve(root,'checkpoints',f.loaded.value.batchId,f.loaded.sha256);
  await mkdir(checkpointDirectory,{recursive:true});
  const checkpointPath=resolve(checkpointDirectory,fp({sourceIdentity:op.source_identity,sourceRevision:op.source_revision})+'.json');
  await writeFile(checkpointPath,JSON.stringify({version:1,batchId:f.loaded.value.batchId,manifestSha256:f.loaded.sha256,
    sourceIdentity:op.source_identity,sourceRevision:op.source_revision,operationId:op.id,sourceFingerprint:op.source_fingerprint}));
  f.query.mockImplementation(async(sql:string)=>{
    if(sql.includes('to_jsonb(o)'))return {rows:[f.row]};
    if(sql.includes('FROM connections'))return {rows:[{...f.row.current_connection,expires_at:new Date(Date.now()+3600000)}]};
    if(sql.includes('FROM production_pilot_lanes'))return {rows:[]};
    if(sql.includes('SELECT id,source_revision'))return {rows:[{id:op.id,source_revision:op.source_revision}]};
    if(sql==='SELECT id FROM production_pilot_publications WHERE create_operation_id=$1')return {rows:f.row.publication?[f.row.publication]:[]};
    if(sql.includes('FROM products p WHERE p.product_key'))return {rows:[]};
    throw Error('Unexpected coordinator fixture query: '+sql);
  });
  const runner={
    journal:{waitForQc:vi.fn(async()=>false),get:vi.fn(async()=>({operation:op,steps:f.row.steps,verification:null,deferredImageVerification:receipt}))},
    publications:{getForCreate:vi.fn(async()=>null as any)},
    capabilityEvidenceFromVerified:vi.fn(async()=>({})),
    prepare:vi.fn(async()=>{throw Error('Unexpected create preparation');}),
    run:vi.fn(async()=>({state:'unresolved',operationId:op.id,itemId:op.item_id,code:'PRODUCTION_PILOT_COVER_CASE_UNVERIFIED'})),
    publish:vi.fn(async()=>{throw Error('Unexpected publication');}),
  };
  const collect=vi.fn(async()=>({sourceReceiptSha256:f.loaded.sha256,input:{}}));
  const createRunner=vi.fn((_repo:unknown,_options:unknown)=>runner as any);
  f.run.mockImplementation(async(args:any,dependencies:any)=>runPass1ProductionBatch(args,{
    ...dependencies,load:f.load,collect:collect as any,createRunner,outputRoot:root,
  }));
  return {...f,runner,collect,createRunner,checkpointPath,receipt};
}

it('connects the real coordinator to deferred orphan recovery, then preserves explicit full-image QC',async()=>{
  const f=await realCoordinatorDeferredOrphan(),batchId=f.loaded.value.batchId;
  const before=await f.peer.status(batchId),originalBytes=JSON.stringify(f.row);
  const accepted=await f.peer.start(batchId,{mode:'reconcile',expectedStatusFingerprint:before.statusFingerprint});
  await vi.waitFor(async()=>expect((await f.peer.status(batchId)).lastResult?.requestId).toBe(accepted.requestId));
  expect((await f.peer.status(batchId)).lastResult).toMatchObject({stopped:false,listings:[{state:'created_hidden_image_qc_deferred'}]});
  await vi.waitFor(async()=>expect((await f.peer.status(batchId)).recoveredRequestIds).toContain(f.original.requestId));
  const recovered=await f.peer.status(batchId);
  expect(recovered).toMatchObject({interrupted:false,createdVerifiedCount:0,canExecute:false,listings:[{canPublish:false,imageQcStatus:'deferred'}]});
  expect(f.runner.run).not.toHaveBeenCalled();expect(f.runner.prepare).not.toHaveBeenCalled();expect(f.runner.publish).not.toHaveBeenCalled();
  expect(f.collect).not.toHaveBeenCalled();expect(f.runner.capabilityEvidenceFromVerified).not.toHaveBeenCalled();
  expect(f.createRunner.mock.calls[0]?.[1]).toMatchObject({deferImageQc:false});
  expect(JSON.stringify(f.row)).toBe(originalBytes);
  await expect(f.peer.publish(batchId,{sourceKey:'a',expectedStatusFingerprint:recovered.statusFingerprint})).rejects.toThrow('PUBLICATION_NOT_READY');
  // No orphan remains: the next explicit reconcile must still perform full QC.
  const qc=await f.peer.start(batchId,{mode:'reconcile',expectedStatusFingerprint:recovered.statusFingerprint});
  await vi.waitFor(async()=>expect((await f.peer.status(batchId)).lastResult?.requestId).toBe(qc.requestId));
  expect(f.runner.run).toHaveBeenCalledExactlyOnceWith(f.row.operation.id);
  expect((await f.peer.status(batchId)).lastResult).toMatchObject({stopped:true,listings:[{code:'PRODUCTION_PILOT_COVER_CASE_UNVERIFIED'}]});
  expect((await f.peer.status(batchId)).listings[0]?.canPublish).toBe(false);
  expect(f.runner.prepare).not.toHaveBeenCalled();expect(f.runner.publish).not.toHaveBeenCalled();
});

it.each(['receipt','source','revision','checkpoint','publication','recovery-proof','receipt-after-assessment'] as const)('real coordinator cannot recover deferred orphan with altered %s',async fault=>{
  const f=await realCoordinatorDeferredOrphan(),batchId=f.loaded.value.batchId;
  if(fault==='receipt')f.receipt.evidence_fingerprint='f'.repeat(64);
  if(fault==='source')f.row.operation.source_fingerprint='f'.repeat(64);
  if(fault==='revision')f.row.operation.revision++;
  if(fault==='checkpoint')await writeFile(f.checkpointPath,'{}');
  if(fault==='publication') {
    const original=f.query.getMockImplementation()!;
    f.query.mockImplementation(async(sql:string,...args:any[])=>sql==='SELECT id FROM production_pilot_publications WHERE create_operation_id=$1'
      ? {rows:[{id:randomUUID()}]} : original(sql,...args));
  }
  if(fault==='recovery-proof') {
    const original=f.run.getMockImplementation()!;
    f.run.mockImplementation((args:any,dependencies:any)=>original(args,{...dependencies,
      deferredRecoveryProofs:dependencies.deferredRecoveryProofs.map((proof:any)=>({...proof,receiptFingerprint:'f'.repeat(64)})),
    }));
  }
  if(fault==='receipt-after-assessment') {
    const original=f.runner.journal.get.getMockImplementation()!;
    f.runner.journal.get.mockImplementation(async()=>{
      // The core remains valid; a different durable receipt identity must still invalidate dispatch proof.
      f.receipt.id=randomUUID();return original();
    });
  }
  const before=await f.peer.status(batchId);
  const accepted=await f.peer.start(batchId,{mode:'reconcile',expectedStatusFingerprint:before.statusFingerprint});
  await vi.waitFor(async()=>expect((await f.peer.status(batchId)).lastResult?.requestId).toBe(accepted.requestId));
  expect(await f.peer.status(batchId)).toMatchObject({interrupted:true,canExecute:false,recoveredRequestIds:[],lastResult:{stopped:true},listings:[{canPublish:false}]});
  await expect(readFile(resolve(root,'web-jobs',batchId,accepted.requestId+'.recovery.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(f.runner.prepare).not.toHaveBeenCalled();expect(f.runner.publish).not.toHaveBeenCalled();
  if(fault==='recovery-proof'||fault==='receipt-after-assessment') {
    expect((await f.peer.status(batchId)).lastResult).toMatchObject({listings:[{code:'PASS1_DEFERRED_RECOVERY_PROOF_CHANGED'}]});
    expect(f.runner.run).not.toHaveBeenCalled();
  }
});

it('does not accept client recovery proof or use it for a source also affected by an orphan publication',async()=>{
  const f=await realCoordinatorDeferredOrphan(),batchId=f.loaded.value.batchId;
  const originalPath=resolve(root,'web-jobs',batchId,f.original.requestId+'.request.json');
  const publishRequest={...JSON.parse(await readFile(originalPath,'utf8')),requestId:randomUUID(),mode:'publish',sourceKey:'a'};
  await writeFile(resolve(root,'web-jobs',batchId,publishRequest.requestId+'.request.json'),JSON.stringify(publishRequest));
  const before=await f.peer.status(batchId);
  await expect(f.peer.start(batchId,{mode:'reconcile',expectedStatusFingerprint:before.statusFingerprint,
    deferredRecoveryProofs:[{sourceKey:'a'}]})).rejects.toThrow();
  const accepted=await f.peer.start(batchId,{mode:'reconcile',expectedStatusFingerprint:before.statusFingerprint});
  await vi.waitFor(async()=>expect((await f.peer.status(batchId)).lastResult?.requestId).toBe(accepted.requestId));
  expect(f.run.mock.calls.at(-1)?.[1]).not.toHaveProperty('deferredRecoveryProofs');
  expect(await f.peer.status(batchId)).toMatchObject({interrupted:true,recoveredRequestIds:[],lastResult:{stopped:true},listings:[{canPublish:false}]});
  expect(f.runner.run).toHaveBeenCalledOnce();
  expect(f.runner.prepare).not.toHaveBeenCalled();expect(f.runner.publish).not.toHaveBeenCalled();
  await expect(readFile(resolve(root,'web-jobs',batchId,accepted.requestId+'.recovery.json'))).rejects.toMatchObject({code:'ENOENT'});
});

it('recovers a deferred-image orphan using separate immutable core proof without replay or publication', async () => {
  const f = await deferredOrphanFixture(), batchId = f.loaded.value.batchId;
  const orphan = await f.peer.status(batchId);
  expect(orphan).toMatchObject({interrupted:true,canExecute:false,canReconcile:true});
  const oldPath=resolve(root,'web-jobs',batchId,f.original.requestId+'.request.json');
  const oldBytes=await readFile(oldPath,'utf8');
  const accepted=await f.peer.start(batchId,{mode:'reconcile',expectedStatusFingerprint:orphan.statusFingerprint});
  await vi.waitFor(async()=>expect((await f.peer.status(batchId)).recoveredRequestIds).toContain(f.original.requestId));
  const status=await f.peer.status(batchId);
  expect(status).toMatchObject({state:'completed',createdVerifiedCount:0,publishedCount:0,canExecute:false,imageQcPendingCount:1,
    listings:[{state:'created_hidden_image_qc_deferred',canPublish:false,imageQcStatus:'deferred'}]});
  expect(status.recoveredRequestIds).toContain(f.original.requestId);
  expect(await readFile(oldPath,'utf8')).toBe(oldBytes);
  expect(f.run.mock.calls.map(([args])=>args.mode)).toEqual(['execute','reconcile']);
  await expect(f.peer.publish(batchId,{sourceKey:'a',expectedStatusFingerprint:status.statusFingerprint})).rejects.toThrow('PUBLICATION_NOT_READY');
  await expect(f.peer.start(batchId,{mode:'execute',expectedStatusFingerprint:status.statusFingerprint})).rejects.toThrow('RECONCILIATION_REQUIRED');
  const proofPath=resolve(root,'web-jobs',batchId,accepted.requestId+'.recovery.json');
  const recovery=JSON.parse(await readFile(proofPath,'utf8'));
  expect(recovery).toMatchObject({version:2,operationProofs:[],deferredOperationProofs:[{
    sourceKey:'a',operationId:f.row.operation.id,operationRevision:f.row.operation.revision,
    sourceFingerprint:f.row.operation.source_fingerprint,
  }]});
  // Later full QC must not invalidate the historical recovery or be confused with its deferred basis.
  const receipt=f.row.deferred_image_verification;
  f.row.verification={id:randomUUID(),operation_id:f.row.operation.id,operation_revision:f.row.operation.revision,
    item_id:f.row.operation.item_id,phase:'created_unlisted',expected_fingerprint:receipt.expected_core_fingerprint,
    readbacks:receipt.readbacks,evidence_fingerprint:receipt.evidence_fingerprint};
  f.row.operation.state='verified';f.row.operation.revision++;
  expect(await f.peer.status(batchId)).toMatchObject({interrupted:false,createdVerifiedCount:1,listings:[{state:'created_unlisted',canPublish:true}]});
  recovery.deferredOperationProofs[0].receiptFingerprint='f'.repeat(64);
  await writeFile(proofPath,JSON.stringify(recovery));
  await expect(f.peer.status(batchId)).rejects.toThrow('RECOVERY_INVALID');
});

it.each(['receipt','source','revision'] as const)('never recovers a deferred orphan with altered %s proof',async(fault)=>{
  const f=await deferredOrphanFixture(),batchId=f.loaded.value.batchId;
  if(fault==='receipt')f.row.deferred_image_verification.evidence_fingerprint='f'.repeat(64);
  if(fault==='source')f.row.operation.source_fingerprint='f'.repeat(64);
  if(fault==='revision')f.row.operation.revision++;
  const before=await f.peer.status(batchId);
  const accepted=await f.peer.start(batchId,{mode:'reconcile',expectedStatusFingerprint:before.statusFingerprint});
  await vi.waitFor(async()=>expect((await f.peer.status(batchId)).lastResult?.requestId).toBe(accepted.requestId));
  expect(await f.peer.status(batchId)).toMatchObject({interrupted:true,canExecute:false,recoveredRequestIds:[],listings:[{state:'needs_review',canPublish:false}]});
  await expect(readFile(resolve(root,'web-jobs',batchId,accepted.requestId+'.recovery.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(f.run.mock.calls.map(([args])=>args.mode)).toEqual(['execute','reconcile']);
});

it('does not use a deferred core receipt to resolve an interrupted publication request', async()=>{
  const f=await deferredOrphanFixture(),batchId=f.loaded.value.batchId;
  const directory=resolve(root,'web-jobs',batchId);
  // Simulate durable uncertainty about a publication; a hidden core receipt cannot prove its outcome.
  for(const name of await readdir(directory)) {
    if(!name.endsWith('.request.json') && !name.endsWith('.claim.json'))continue;
    const path=resolve(directory,name),record=JSON.parse(await readFile(path,'utf8'));
    if(record.requestId===f.original.requestId)await writeFile(path,JSON.stringify({...record,mode:'publish',sourceKey:'a'}));
  }
  const before=await f.peer.status(batchId);
  const accepted=await f.peer.start(batchId,{mode:'reconcile',expectedStatusFingerprint:before.statusFingerprint});
  await vi.waitFor(async()=>expect((await f.peer.status(batchId)).lastResult?.requestId).toBe(accepted.requestId));
  expect(await f.peer.status(batchId)).toMatchObject({interrupted:true,canExecute:false,recoveredRequestIds:[],listings:[{canPublish:false}]});
  await expect(readFile(resolve(directory,accepted.requestId+'.recovery.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(f.run.mock.calls.map(([args])=>args.mode)).toEqual(['execute','reconcile']);
});
it.each([
  'valid',
  'missing-create-ACK',
  'wrong-create-fingerprint',
  'wrong-publication-relation',
  'altered-receipt',
  'changed-source-context',
])(
  'dashboard requires the same durable publication proof as the coordinator: %s',
  async (fault) => {
    const f = fixture();
    completeFixture(f, fault);
    await registerProductionBatch(
      { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
      f.options,
    );
    const result = await f.service.status(f.loaded.value.batchId);
    expect(result.listings[0]?.state).toBe(fault === 'valid' ? 'published' : 'needs_review');
    expect(f.run).not.toHaveBeenCalled();
  },
);
it('hidden completion enables only an exact per-listing publication intent',async()=>{
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  const row=completeFixture(f,'valid');row.publication=null;row.publication_verification=null;
  await registerProductionBatch({manifestPath:f.loaded.manifestPath,expectedSha256:f.loaded.sha256},f.options);
  const status=await f.service.status(f.loaded.value.batchId);
  expect(status).toMatchObject({publicationMode:'hidden_for_review',state:'completed',completionTarget:'created_hidden',createdVerifiedCount:1,hiddenVerifiedCount:1,publishedCount:0,completedCount:1,remainingCount:0,canExecute:false});
  expect(status.listings[0]).toMatchObject({state:'created_unlisted',canPublish:true});
  const accepted=await (f.service as any).publish(f.loaded.value.batchId,{sourceKey:'a',expectedStatusFingerprint:status.statusFingerprint});
  expect(accepted.state).toBe('accepted');
  await vi.waitFor(async()=>expect((await f.service.status(f.loaded.value.batchId)).lastResult?.requestId).toBe(accepted.requestId));
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({mode:'publish',sourceKey:'a'}),expect.anything());
  const intent=JSON.parse(await readFile(resolve(root,'web-jobs',f.loaded.value.batchId,accepted.requestId+'.request.json'),'utf8'));
  expect(intent).toMatchObject({mode:'publish',sourceKey:'a',expectedStatusFingerprint:status.statusFingerprint,
    publicationIntent:{operationId:row.operation.id,itemId:'5001',sourceRevision:1,createVerificationId:row.verification.id}});
});
it('a hidden target with pending create QC cannot publish',async()=>{
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  const row=completeFixture(f,'valid');row.publication=null;row.publication_verification=null;row.operation.state='acknowledged';row.verification=null;
  await registerProductionBatch({manifestPath:f.loaded.manifestPath,expectedSha256:f.loaded.sha256},f.options);
  const status=await f.service.status(f.loaded.value.batchId);
  expect(status.listings[0]).toMatchObject({state:'created_readback_pending',canPublish:false});
  await expect((f.service as any).publish(f.loaded.value.batchId,{sourceKey:'a',expectedStatusFingerprint:status.statusFingerprint})).rejects.toThrow('PRODUCTION_BATCH_PUBLICATION_NOT_READY');
  expect(f.run).not.toHaveBeenCalled();
});
it('an old manifest without mode retains publication as its completion target',async()=>{
  const f=fixture();const row=completeFixture(f,'valid');row.publication=null;row.publication_verification=null;
  await registerProductionBatch({manifestPath:f.loaded.manifestPath,expectedSha256:f.loaded.sha256},f.options);
  const status=await f.service.status(f.loaded.value.batchId);
  expect(status).toMatchObject({publicationMode:'publish_after_verification',completionTarget:'published',state:'ready',publishedCount:0,remainingCount:1,canExecute:true});
  expect(status.listings[0]?.canPublish).toBe(false);
});
it('a lost publication response requires readonly reconciliation and cannot dispatch a new publication',async()=>{
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  const row=completeFixture(f,'valid');row.publication=null;row.publication_verification=null;
  await registerProductionBatch({manifestPath:f.loaded.manifestPath,expectedSha256:f.loaded.sha256},f.options);
  const status=await f.service.status(f.loaded.value.batchId);
  f.run.mockImplementation(()=>new Promise(()=>{}));
  await (f.service as any).publish(f.loaded.value.batchId,{sourceKey:'a',expectedStatusFingerprint:status.statusFingerprint});
  f.crash();
  const peer=new ProductionBatchService(f.repo as any,{} as any,f.options),orphan=await peer.status(f.loaded.value.batchId);
  expect(orphan).toMatchObject({interrupted:true,canExecute:false,canReconcile:true});
  expect(orphan.listings[0]?.canPublish).toBe(false);
  await expect((peer as any).publish(f.loaded.value.batchId,{sourceKey:'a',expectedStatusFingerprint:orphan.statusFingerprint})).rejects.toThrow('RECONCILIATION_REQUIRED');
  expect(f.run).toHaveBeenCalledTimes(1);
});
it('an acknowledged publication in hidden mode requires reconciliation instead of creation execution',async()=>{
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  const row=completeFixture(f,'valid');row.publication.state='acknowledged';row.publication.revision=3;row.publication_verification=null;
  await registerProductionBatch({manifestPath:f.loaded.manifestPath,expectedSha256:f.loaded.sha256},f.options);
  expect(await f.service.status(f.loaded.value.batchId)).toMatchObject({canExecute:false,canReconcile:true,listings:[{state:'publication_readback_pending',canPublish:false}]});
});
it('an empty server registry reports no batch instead of guessing a manifest', async () => {
  const f = fixture();
  expect(await f.service.list()).toEqual({ batches: [] });
  expect(f.load).not.toHaveBeenCalled();
});
it('observes a live coordinator in another instance and refuses a concurrent readonly reconciliation', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const status = await f.service.status(f.loaded.value.batchId);
  f.run.mockImplementation(() => new Promise(() => {}));
  await f.service.start(f.loaded.value.batchId, {
    mode: 'execute',
    expectedStatusFingerprint: status.statusFingerprint,
  });
  const peer = new ProductionBatchService(f.repo as any, {} as any, f.options);
  const live = await peer.status(f.loaded.value.batchId);
  expect(live.busy).toBe(true);
  expect(live.interrupted).toBe(false);
  expect(live.canReconcile).toBe(false);
  await expect(
    peer.start(f.loaded.value.batchId, {
      mode: 'reconcile',
      expectedStatusFingerprint: live.statusFingerprint,
    }),
  ).rejects.toThrow('IN_PROGRESS');
  expect(f.run).toHaveBeenCalledTimes(1);
});
it('allows explicit GET-only recovery after coordinator loss but does not clear a no-operation orphan', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const status = await f.service.status(f.loaded.value.batchId);
  f.run.mockImplementation(() => new Promise(() => {}));
  const original = await f.service.start(f.loaded.value.batchId, {
    mode: 'execute',
    expectedStatusFingerprint: status.statusFingerprint,
  });
  f.crash();
  const peer = new ProductionBatchService(f.repo as any, {} as any, f.options);
  const orphan = await peer.status(f.loaded.value.batchId);
  expect(orphan).toMatchObject({
    busy: false,
    interrupted: true,
    canExecute: false,
    canReconcile: true,
    state: 'needs_review',
  });
  f.run.mockResolvedValue({ stopped: false, listings: [{ sourceKey: 'a', state: 'not_sent' }] });
  const recovered = await peer.start(f.loaded.value.batchId, {
    mode: 'reconcile',
    expectedStatusFingerprint: orphan.statusFingerprint,
  });
  await vi.waitFor(async () =>
    expect((await peer.status(f.loaded.value.batchId)).lastResult?.requestId).toBe(
      recovered.requestId,
    ),
  );
  expect(f.run.mock.calls.at(-1)?.[0].mode).toBe('reconcile');
  expect((await peer.status(f.loaded.value.batchId)).canExecute).toBe(false);
  expect(
    await readFile(
      resolve(root, 'web-jobs', f.loaded.value.batchId, original.requestId + '.request.json'),
      'utf8',
    ),
  ).toContain(original.requestId);
});
it('appends a proof-bound recovery receipt for complete existing items without rewriting old request history', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const status = await f.service.status(f.loaded.value.batchId);
  f.run.mockImplementation(() => new Promise(() => {}));
  const original = await f.service.start(f.loaded.value.batchId, {
      mode: 'execute',
      expectedStatusFingerprint: status.statusFingerprint,
    }),
    path = resolve(root, 'web-jobs', f.loaded.value.batchId, original.requestId + '.request.json'),
    originalBytes = await readFile(path, 'utf8');
  f.crash();
  completeFixture(f);
  const peer = new ProductionBatchService(f.repo as any, {} as any, f.options);
  const orphan = await peer.status(f.loaded.value.batchId);
  f.run.mockResolvedValue({
    stopped: false,
    listings: [{ sourceKey: 'a', state: 'published', operationId: 'from-run-do-not-trust' }],
  } as any);
  const accepted = await peer.start(f.loaded.value.batchId, {
    mode: 'reconcile',
    expectedStatusFingerprint: orphan.statusFingerprint,
  });
  await vi.waitFor(async () =>
    expect((await peer.status(f.loaded.value.batchId)).interrupted).toBe(false),
  );
  const final = await peer.status(f.loaded.value.batchId);
  expect(final.state).toBe('completed');
  expect(final.recoveredRequestIds).toContain(original.requestId);
  expect(await readFile(path, 'utf8')).toBe(originalBytes);
  const proof = JSON.parse(
    await readFile(
      resolve(root, 'web-jobs', f.loaded.value.batchId, accepted.requestId + '.recovery.json'),
      'utf8',
    ),
  );
  expect(proof.originalRequests[0].requestId).toBe(original.requestId);
  expect(proof.operationProofs[0].operationId).not.toBe('from-run-do-not-trust');
  proof.resultFingerprint = 'f'.repeat(64);
  await writeFile(
    resolve(root, 'web-jobs', f.loaded.value.batchId, accepted.requestId + '.recovery.json'),
    JSON.stringify(proof),
  );
  await expect(peer.status(f.loaded.value.batchId)).rejects.toThrow('RECOVERY_INVALID');
});
it('keeps unknown journal outcomes held after readonly recovery and forbids a partial recovery scope', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const status = await f.service.status(f.loaded.value.batchId);
  f.run.mockImplementation(() => new Promise(() => {}));
  await f.service.start(f.loaded.value.batchId, {
    mode: 'execute',
    expectedStatusFingerprint: status.statusFingerprint,
  });
  f.crash();
  const row = completeFixture(f);
  row.operation.state = 'unknown';
  f.query.mockResolvedValue({ rows: [row] });
  const peer = new ProductionBatchService(f.repo as any, {} as any, f.options),
    current = await peer.status(f.loaded.value.batchId);
  await expect(
    peer.start(f.loaded.value.batchId, {
      mode: 'reconcile',
      sourceKey: 'a',
      expectedStatusFingerprint: current.statusFingerprint,
    }),
  ).rejects.toThrow('RECOVERY_REQUIRES_FULL_BATCH');
  f.run.mockResolvedValue({ stopped: true, listings: [{ sourceKey: 'a', state: 'unknown' }] });
  const accepted = await peer.start(f.loaded.value.batchId, {
    mode: 'reconcile',
    expectedStatusFingerprint: current.statusFingerprint,
  });
  await vi.waitFor(async () =>
    expect((await peer.status(f.loaded.value.batchId)).lastResult?.requestId).toBe(
      accepted.requestId,
    ),
  );
  const after = await peer.status(f.loaded.value.batchId);
  expect(after.interrupted).toBe(true);
  expect(after.canExecute).toBe(false);
  expect(after.recoveredRequestIds).toEqual([]);
});
it('does not admit two batch coordinators for the same shop across service instances', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const status = await f.service.status(f.loaded.value.batchId);
  f.run.mockImplementation(() => new Promise(() => {}));
  await f.service.start(f.loaded.value.batchId, {
    mode: 'execute',
    expectedStatusFingerprint: status.statusFingerprint,
  });
  const loaded = { ...f.loaded, value: { ...f.loaded.value, batchId: randomUUID() } },
    options = { ...f.options, load: async () => loaded };
  await registerProductionBatch(
    { manifestPath: loaded.manifestPath, expectedSha256: loaded.sha256 },
    options,
  );
  const peer = new ProductionBatchService(f.repo as any, {} as any, options),
    current = await peer.status(loaded.value.batchId);
  await expect(
    peer.start(loaded.value.batchId, {
      mode: 'inspect',
      expectedStatusFingerprint: current.statusFingerprint,
    }),
  ).rejects.toThrow('IN_PROGRESS');
  expect(f.run).toHaveBeenCalledTimes(1);
});
it('refuses a known single-connection pool before retaining a coordinator lease', async () => {
  const f = fixture();
  (f.repo.pool as any).options = { max: 1 };
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const status = await f.service.status(f.loaded.value.batchId);
  await expect(
    f.service.start(f.loaded.value.batchId, {
      mode: 'inspect',
      expectedStatusFingerprint: status.statusFingerprint,
    }),
  ).rejects.toThrow('POOL_CAPACITY_REQUIRED');
  expect(f.run).not.toHaveBeenCalled();
});
it('a trusted held registration allows inspection but rejects both execution modes', async () => {
  const f = fixture();
  await registerProductionBatch(
    {
      manifestPath: f.loaded.manifestPath,
      expectedSha256: f.loaded.sha256,
      executionEnabled: false,
      holdReason: 'Cả hai bộ cần bảng kích thước theo ngành đã chọn.',
    },
    f.options,
  );
  const status = await f.service.status(f.loaded.value.batchId);
  expect(status).toMatchObject({
    state: 'held',
    executionEnabled: false,
    canExecute: false,
    holdReason: 'Cả hai bộ cần bảng kích thước theo ngành đã chọn.',
  });
  for (const mode of ['execute', 'reconcile'])
    await expect(
      f.service.start(f.loaded.value.batchId, {
        mode,
        expectedStatusFingerprint: status.statusFingerprint,
      }),
    ).rejects.toThrow('EXECUTION_HELD');
  expect(f.run).not.toHaveBeenCalled();
  await expect(
    f.service.start(f.loaded.value.batchId, {
      mode: 'inspect',
      expectedStatusFingerprint: status.statusFingerprint,
    }),
  ).resolves.toMatchObject({ state: 'accepted' });
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  expect(f.run.mock.calls[0]?.[0].mode).toBe('inspect');
});
it('legacy registration defaults to enabled and an immutable hold cannot be silently removed', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  expect((await f.service.status(f.loaded.value.batchId)).executionEnabled).toBe(true);
  await expect(
    registerProductionBatch(
      {
        manifestPath: f.loaded.manifestPath,
        expectedSha256: f.loaded.sha256,
        executionEnabled: false,
        holdReason: 'Awaiting category source',
      },
      f.options,
    ),
  ).rejects.toThrow('REGISTRATION_CONFLICT');
});
it('rejects modified manifests, unknown batch IDs and browser path/proof injection', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const status = await f.service.status(f.loaded.value.batchId);
  await expect(
    f.service.start(randomUUID(), {
      mode: 'execute',
      expectedStatusFingerprint: status.statusFingerprint,
    }),
  ).rejects.toThrow('NOT_REGISTERED');
  await expect(
    f.service.start(f.loaded.value.batchId, {
      mode: 'execute',
      expectedStatusFingerprint: status.statusFingerprint,
      manifestPath: 'other',
    }),
  ).rejects.toThrow();
  f.load.mockRejectedValue(Error('PRODUCTION_BATCH_MANIFEST_CHANGED'));
  await expect(
    f.service.start(f.loaded.value.batchId, {
      mode: 'execute',
      expectedStatusFingerprint: status.statusFingerprint,
    }),
  ).rejects.toThrow('MANIFEST_CHANGED');
  expect(f.run).not.toHaveBeenCalled();
});
it('durably accepts one request, passes only registered scope to coordinator, then exposes its result', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const status = await f.service.status(f.loaded.value.batchId);
  let finish!: (value: any) => void;
  f.run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const accepted = await f.service.start(f.loaded.value.batchId, {
    mode: 'inspect',
    expectedStatusFingerprint: status.statusFingerprint,
  });
  await expect(
    f.service.start(f.loaded.value.batchId, {
      mode: 'inspect',
      expectedStatusFingerprint: status.statusFingerprint,
    }),
  ).rejects.toThrow();
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  expect(f.run.mock.calls[0]?.[0]).toEqual({
    mode: 'inspect',
    manifestPath: f.loaded.manifestPath,
    expectedSha256: f.loaded.sha256,
  });
  expect(
    JSON.parse(
      await readFile(
        resolve(root, 'web-jobs', f.loaded.value.batchId, accepted.requestId + '.request.json'),
        'utf8',
      ),
    ).mode,
  ).toBe('inspect');
  finish({ stopped: false, listings: [{ sourceKey: 'a', state: 'inspected' }] });
  await vi.waitFor(async () =>
    expect((await f.service.status(f.loaded.value.batchId)).lastResult?.listings[0]?.state).toBe(
      'inspected',
    ),
  );
});
it('retains an interrupted durable request and blocks another write after service restart', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const status = await f.service.status(f.loaded.value.batchId);
  f.run.mockImplementation(() => new Promise(() => {}));
  await f.service.start(f.loaded.value.batchId, {
    mode: 'execute',
    expectedStatusFingerprint: status.statusFingerprint,
  });
  f.crash();
  const restarted = new ProductionBatchService(f.repo as any, {} as any, f.options);
  const next = await restarted.status(f.loaded.value.batchId);
  expect(next.interrupted).toBe(true);
  expect(next.canExecute).toBe(false);
  await expect(
    restarted.start(f.loaded.value.batchId, {
      mode: 'execute',
      expectedStatusFingerprint: next.statusFingerprint,
    }),
  ).rejects.toThrow('RECONCILIATION_REQUIRED');
});
it('a complete immutable claim remains visible when the request index was not written', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const prior = await f.service.status(f.loaded.value.batchId);
  f.run.mockImplementation(() => new Promise(() => {}));
  const accepted = await f.service.start(f.loaded.value.batchId, {
    mode: 'execute',
    expectedStatusFingerprint: prior.statusFingerprint,
  });
  await rm(resolve(root, 'web-jobs', f.loaded.value.batchId, accepted.requestId + '.request.json'));
  f.crash();
  const restarted = new ProductionBatchService(f.repo as any, {} as any, f.options);
  const current = await restarted.status(f.loaded.value.batchId);
  expect(current.interrupted).toBe(true);
  expect(current.canExecute).toBe(false);
  expect(current.acceptedStatusFingerprints).toContain(prior.statusFingerprint);
});
it('an interrupted GET-only inspection does not block an explicit new inspection after restart', async () => {
  const f = fixture();
  await registerProductionBatch(
    { manifestPath: f.loaded.manifestPath, expectedSha256: f.loaded.sha256 },
    f.options,
  );
  const prior = await f.service.status(f.loaded.value.batchId);
  f.run.mockImplementation(() => new Promise(() => {}));
  await f.service.start(f.loaded.value.batchId, {
    mode: 'inspect',
    expectedStatusFingerprint: prior.statusFingerprint,
  });
  f.crash();
  const restarted = new ProductionBatchService(f.repo as any, {} as any, f.options);
  const current = await restarted.status(f.loaded.value.batchId);
  expect(current.interruptedInspection).toBe(true);
  expect(current.busy).toBe(false);
  await expect(
    restarted.start(f.loaded.value.batchId, {
      mode: 'inspect',
      expectedStatusFingerprint: current.statusFingerprint,
    }),
  ).resolves.toMatchObject({ state: 'accepted' });
  expect(
    (await readdir(resolve(root, 'web-jobs', f.loaded.value.batchId))).filter((n) =>
      n.endsWith('.request.json'),
    ),
  ).toHaveLength(2);
});
