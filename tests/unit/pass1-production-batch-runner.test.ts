import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson } from '@shopee/domain';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  parsePass1Arguments,
  runPass1ProductionBatch,
} from '../../scripts/run-pass1-production-batch.mjs';
import { productionBatchPass1Root } from '../../apps/api/src/production-batch-source.js';
import { productionPilotWriteFingerprint } from '../../packages/shopee/src/production-pilot-transport.js';
const fp = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
let directory: string;
beforeEach(async () => {
  await mkdir(productionBatchPass1Root, { recursive: true });
  directory = await mkdtemp(resolve(productionBatchPass1Root, 'runner-test-'));
});
function fixture() {
  const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
    identity = 'pass1:source-a';
  const doc = {
    sourceKey: identity,
    title: 'Original source',
    cover: { importId: 'image-a' },
    gallery: [],
    description: [{ type: 'text', text: 'Original body' }],
    tierNames: [],
    models: [
      { sku: 'SKU-A', originalPrice: '123000', stock: 100, optionLabels: [], tierIndex: [] },
    ],
  };
  const source = {
    sourceIdentity: identity,
    sourceRevision: 1,
    sourceKey: 'a',
    document: doc,
    proposedAttributeList: [],
    brandName: 'Brand',
    condition: 'NEW',
    preOrder: { is_pre_order: false },
    stockLocation: {
      expectedLocationBySku: { 'SKU-A': 'VNZ' },
      writeLocationBySku: { 'SKU-A': null },
    },
  };
  const loaded: any = {
    sha256: 'a'.repeat(64),
    value: {
      version: 1,
      batchId: randomUUID(),
      scope,
      authorizationReference: 'Explicit complete batch approval',
      assets: {},
      listings: [source],
    },
  };
  const input: any = {
    sourceIdentity: identity,
    sourceRevision: 1,
    connectionId: 'connection-a',
    connectionRevision: 1,
    document: doc,
    assets: {},
    metadata: { ...scope, connectionRevision: 1 },
    context: {
      images: [],
      attributeList: [],
      brandName: 'Brand',
      condition: 'NEW',
      preOrder: { is_pre_order: false },
      stockLocationBySku: { 'SKU-A': null },
    },
    stockLocationEvidence: { expectedLocationBySku: { 'SKU-A': 'VNZ' } },
  };
  let operation: any = null;
  const events: string[] = [];
  const proof = {
    batchId: loaded.value.batchId,
    manifestSha256: loaded.sha256,
    authorizationReference: loaded.value.authorizationReference,
    sources: [{ sourceIdentity: identity, sourceRevision: 1, documentSha256: fp(doc) }],
  };
  function setOperation(state = 'acknowledged') {
    const payload = { ...structuredClone(input), batchAuthorization: proof },
      expected = { status: 'UNLIST', title: doc.title };
    const op: any = {
      id: randomUUID(),
      owner_key: 'production:2010476:1423724897',
      source_identity: identity,
      source_revision: 1,
      source_payload: payload,
      expected_projection: expected,
      connection_id: 'connection-a',
      connection_revision: 1,
      state,
      revision: 6,
      item_id: '5001',
      source_fingerprint: fp({
        scope,
        sourceIdentity: identity,
        sourceRevision: 1,
        sourcePayload: payload,
        expectedProjection: expected,
      }),
    };
    operation = {
      operation: op,
      verification: null,
      steps: [
        { step_key: 'media-0', state: 'acknowledged' },
        { step_key: 'create', state: 'acknowledged' },
      ],
    };
    return operation;
  }
  const query = vi.fn(async (sql: string) =>
    sql.includes('FROM connections')
      ? {
          rows: [
            {
              id: 'connection-a',
              revision: 1,
              state: 'connected',
              expires_at: new Date(Date.now() + 3600000),
            },
          ],
        }
      : { rows: operation ? [{ id: operation.operation.id, source_revision: 1 }] : [] },
  );
  const runner: any = {
    journal: { get: vi.fn(async () => operation), waitForQc:vi.fn(async()=>false) },
    publications: {
      getForCreate: vi.fn(async () => {
        if (operation?.operation.state !== 'verified')
          throw Error('PRODUCTION_PILOT_CREATE_UNVERIFIED');
        return null;
      }),
    },
    capabilityEvidenceFromVerified: vi.fn(async () => ({
      ...scope,
      connectionRevision: 1,
      gallery34: { state: 'supported', verifiedOperationId: randomUUID() },
      extendedDescription: { state: 'unsupported' },
    })),
    prepare: vi.fn(async () => {
      events.push('prepare');
      setOperation('authorized');
      return { kind: 'ready', operationId: operation.operation.id };
    }),
    renewUndispatched: vi.fn(async () => ({renewalId:randomUUID()})),
    run: vi.fn(async () => {
      events.push('run');
      return { state: 'verified', operationId: operation.operation.id, itemId: '5001' };
    }),
    publish: vi.fn(async () => {
      events.push('publish');
      return { state: 'published', operationId: operation.operation.id, itemId: '5001' };
    }),
  };
  const deps: any = {
    repo: { pool: { query } },
    blobs: {},
    load: vi.fn(async () => loaded),
    collect: vi.fn(async () => ({
      sourceReceiptSha256: loaded.sha256,
      input,
      preflightId: randomUUID(),
    })),
    createRunner: vi.fn(() => runner),
    outputRoot: directory,
    lockSource:async()=>async()=>{},
    inspectPlan: vi.fn(() => ({ kind: 'ready', requests: [] })),
  };
  const args = {
    mode: 'inspect' as const,
    manifestPath: resolve(directory, 'manifest.json'),
    expectedSha256: loaded.sha256,
  };
  return {
    loaded,
    input,
    args,
    deps,
    runner,
    events,
    setOperation,
    getOperation: () => operation,
    source,
  };
}
it('defaults to inspect and rejects missing or unknown CLI arguments', () => {
  expect(
    parsePass1Arguments(['--manifest', 'C:/private/manifest.json', '--sha', 'a'.repeat(64)]).mode,
  ).toBe('inspect');
  expect(() => parsePass1Arguments(['--manifest', 'x'])).toThrow();
  expect(() =>
    parsePass1Arguments(['--manifest=x', '--sha=' + 'a'.repeat(64), '--force']),
  ).toThrow();
});
it('inspect collects only GET preflight and pure local plan, with no reservation or writer calls', async () => {
  const f = fixture(),
    result = await runPass1ProductionBatch(f.args, f.deps);
  expect(f.deps.collect).toHaveBeenCalledOnce();
  expect(f.deps.inspectPlan).toHaveBeenCalledOnce();
  expect(f.runner.prepare).not.toHaveBeenCalled();
  expect(f.runner.run).not.toHaveBeenCalled();
  expect(f.runner.publish).not.toHaveBeenCalled();
  expect(result.listings[0]?.state).toBe('inspected');
});
it('loads the existing operation before checking a hidden conversion binding and never takes the legacy automatic publish branch',async()=>{
  const f=fixture();f.loaded.value.version=2;
  const view=f.setOperation('acknowledged');await checkpoint(f);
  const op=view.operation,body={version:1,id:randomUUID(),preparationId:randomUUID(),preparationFingerprint:'b'.repeat(64),
    publicationMode:'hidden_for_review',imageQcPolicy:'defer_image_qc',createdAt:new Date().toISOString(),scope:f.loaded.value.scope,
    batches:[{batchId:f.loaded.value.batchId,manifestSha256:f.loaded.sha256,priorStatusFingerprint:'c'.repeat(64),sources:[{
      sourceKey:f.source.sourceKey,sourceIdentity:f.source.sourceIdentity,sourceRevision:1,documentSha256:fp(f.source.document),
      operationId:op.id,itemId:op.item_id,sourceFingerprint:op.source_fingerprint}]}]};
  const original=f.deps.repo.pool.query.getMockImplementation();
  f.deps.repo.pool.query.mockImplementation(async(sql:string)=>sql.includes('FROM production_execution_policies') ? {rows:[{id:body.id,preparation_id:body.preparationId,body,fingerprint:fp(body)}]} : original(sql));
  f.runner.run.mockResolvedValue({state:'hidden_image_qc_deferred',operationId:op.id,itemId:op.item_id});
  const result=await runPass1ProductionBatch({...f.args,mode:'execute'},f.deps);
  expect(result).toMatchObject({stopped:false,listings:[{state:'created_hidden_image_qc_deferred',itemId:op.item_id}]});
  expect(f.deps.createRunner.mock.calls[0][1]).toMatchObject({deferImageQc:true,executionPolicy:{id:body.id},batchAuthorization:op.source_payload.batchAuthorization});
  expect(f.runner.prepare).not.toHaveBeenCalled();expect(f.runner.publish).not.toHaveBeenCalled();
});
it('inspection reports every source-local metadata issue without stopping the remaining read-only checks', async () => {
  const f = fixture();
  const second = structuredClone(f.loaded.value.listings[0]);
  second.sourceKey = 'b';
  second.sourceIdentity = 'pass1:source-b';
  second.document.sourceKey = second.sourceIdentity;
  f.loaded.value.listings.push(second);
  f.deps.inspectPlan.mockReturnValueOnce({ kind: 'blocked', issues: [{ code: 'SIZE_CHART_REQUIRED' }] });
  const result = await runPass1ProductionBatch(f.args, f.deps);
  expect(result.listings.map(row => [row.sourceKey, row.state])).toEqual([
    ['a', 'blocked'], ['b', 'inspected'],
  ]);
  expect(f.deps.collect).toHaveBeenCalledTimes(2);
  expect(f.runner.prepare).not.toHaveBeenCalled();
  expect(f.runner.run).not.toHaveBeenCalled();
});
it('execute checkpoints the exact operation before first outgoing progression', async () => {
  const f = fixture();
  f.runner.run.mockImplementation(async (id: string) => {
    const checkpointDirectory = resolve(
      directoryForCheckpoint(f),
      fp({ sourceIdentity: f.source.sourceIdentity, sourceRevision: 1 }) + '.json',
    );
    expect(JSON.parse(await readFile(checkpointDirectory, 'utf8'))).toMatchObject({
      operationId: id,
      manifestSha256: f.loaded.sha256,
    });
    return { state: 'verified', operationId: id, itemId: '5001' };
  });
  const result = await runPass1ProductionBatch({ ...f.args, mode: 'execute' }, f.deps);
  expect(f.runner.prepare).toHaveBeenCalledOnce();
  expect(f.runner.run).toHaveBeenCalledOnce();
  expect(f.runner.publish).toHaveBeenCalledOnce();
  expect(result.listings[0]?.state).toBe('published');
  expect(f.deps.createRunner.mock.calls[0]![1].allowedSources).toEqual([
    { sourceIdentity: f.source.sourceIdentity, sourceRevision: 1 },
  ]);
  expect(f.deps.createRunner.mock.calls[0]![1].batchAuthorization.sources).toHaveLength(1);
});
function directoryForCheckpoint(f: ReturnType<typeof fixture>) {
  return resolve(directory, 'checkpoints', f.loaded.value.batchId, f.loaded.sha256);
}
async function checkpoint(f: ReturnType<typeof fixture>) {
  const op = f.getOperation().operation,
    folder = directoryForCheckpoint(f);
  await mkdir(folder, { recursive: true });
  await writeFile(
    resolve(folder, fp({ sourceIdentity: f.source.sourceIdentity, sourceRevision: 1 }) + '.json'),
    JSON.stringify({
      version: 1,
      batchId: f.loaded.value.batchId,
      manifestSha256: f.loaded.sha256,
      sourceIdentity: f.source.sourceIdentity,
      sourceRevision: 1,
      operationId: op.id,
      sourceFingerprint: op.source_fingerprint,
    }),
    { flag: 'wx' },
  );
}
it('reconcile requires a checkpoint and only reads an exact all-ACK create without opening sales', async () => {
  const f = fixture();
  f.setOperation();
  await checkpoint(f);
  const result = await runPass1ProductionBatch({ ...f.args, mode: 'reconcile' }, f.deps);
  expect(f.runner.prepare).not.toHaveBeenCalled();
  expect(f.runner.run).toHaveBeenCalledOnce();
  expect(f.runner.publish).not.toHaveBeenCalled();
  expect(result.listings[0]?.state).toBe('created_unlisted');
});
it('hidden mode completes verified creation without publication metadata or sales',async()=>{
  const f=fixture(); f.loaded.value.publicationMode='hidden_for_review';
  const result=await runPass1ProductionBatch({...f.args,mode:'execute'},f.deps);
  expect(result).toMatchObject({stopped:false,listings:[{state:'created_unlisted',itemId:'5001'}]});
  expect(f.deps.collect).toHaveBeenCalledTimes(1);expect(f.runner.publish).not.toHaveBeenCalled();
});
it('hidden mode skips a verified hidden create without repeating metadata or QC',async()=>{
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  publication(f);f.runner.publications.getForCreate.mockResolvedValue(null);await checkpoint(f);
  const result=await runPass1ProductionBatch({...f.args,mode:'execute'},f.deps);
  expect(result.listings[0]?.state).toBe('created_unlisted');
  expect(f.deps.collect).not.toHaveBeenCalled();expect(f.runner.run).not.toHaveBeenCalled();expect(f.runner.publish).not.toHaveBeenCalled();
});
it('hidden execution continues to the next prepared source after verified creation in original order',async()=>{
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  const second=structuredClone(f.source);second.sourceIdentity='pass1:source-b';second.sourceKey='b';
  second.document.sourceKey=second.sourceIdentity;second.document.title='Second exact source';
  f.loaded.value.listings.push(second);
  const originalQuery=f.deps.repo.pool.query.getMockImplementation();
  f.deps.repo.pool.query.mockImplementation(async(sql:string,values:any[]=[])=>{
    if(sql.includes('FROM connections'))return originalQuery(sql,values);
    const op=f.getOperation()?.operation;
    return {rows:op && op.source_identity===values[1]?[{id:op.id,source_revision:op.source_revision}]:[]};
  });
  f.deps.collect.mockImplementation(async(_repo:unknown,args:any)=>{
    const source=f.loaded.value.listings.find((s:any)=>s.sourceKey===args.sourceKey);
    return {sourceReceiptSha256:f.loaded.sha256,input:{...structuredClone(f.input),sourceIdentity:source.sourceIdentity,document:source.document}};
  });
  let count=0;
  f.runner.prepare.mockImplementation(async(input:any)=>{
    const view=f.setOperation('authorized'),op=view.operation;
    op.source_identity=input.sourceIdentity;op.item_id=String(5001+count++);
    op.expected_projection={status:'UNLIST',title:input.document.title};
    op.source_payload={...input,batchAuthorization:{batchId:f.loaded.value.batchId,manifestSha256:f.loaded.sha256,
      authorizationReference:f.loaded.value.authorizationReference,sources:f.loaded.value.listings.map((s:any)=>({sourceIdentity:s.sourceIdentity,sourceRevision:s.sourceRevision,documentSha256:fp(s.document)}))}};
    op.source_fingerprint=fp({scope:f.loaded.value.scope,sourceIdentity:op.source_identity,sourceRevision:1,sourcePayload:op.source_payload,expectedProjection:op.expected_projection});
    return {kind:'ready',operationId:op.id};
  });
  f.runner.run.mockImplementation(async()=>({state:'verified',operationId:f.getOperation().operation.id,itemId:f.getOperation().operation.item_id}));
  const result=await runPass1ProductionBatch({...f.args,mode:'execute'},f.deps);
  expect(result).toMatchObject({stopped:false,listings:[{sourceKey:'a',state:'created_unlisted',itemId:'5001'},{sourceKey:'b',state:'created_unlisted',itemId:'5002'}]});
  expect(f.runner.prepare).toHaveBeenCalledTimes(2);expect(f.runner.publish).not.toHaveBeenCalled();
  expect(f.deps.collect.mock.calls.map((call:any)=>call[1].sourceKey)).toEqual(['a','b']);
});
it('hidden mode preserves unresolved image QC instead of reporting completion',async()=>{
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  f.runner.run.mockResolvedValue({state:'unresolved',code:'PRODUCTION_PILOT_COVER_CASE_UNVERIFIED'});
  const result=await runPass1ProductionBatch({...f.args,mode:'execute'},f.deps);
  expect(result).toMatchObject({stopped:true,listings:[{state:'unresolved',code:'PRODUCTION_PILOT_COVER_CASE_UNVERIFIED'}]});
  expect(f.runner.publish).not.toHaveBeenCalled();
});
it('explicit publication targets a verified hidden source without preparing a create',async()=>{
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  publication(f);f.runner.publications.getForCreate.mockResolvedValue(null);await checkpoint(f);
  const result=await runPass1ProductionBatch({...f.args,mode:'publish',sourceKey:'a'} as any,f.deps);
  expect(result).toMatchObject({stopped:false,listings:[{state:'published'}]});
  expect(f.runner.prepare).not.toHaveBeenCalled();expect(f.runner.publish).toHaveBeenCalledOnce();
});
it('explicit publication cannot create an unsent source',async()=>{
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  const result=await runPass1ProductionBatch({...f.args,mode:'publish',sourceKey:'a'} as any,f.deps);
  expect(result).toMatchObject({stopped:true,listings:[{code:'PASS1_PUBLICATION_REQUIRES_VERIFIED_CREATE'}]});
  expect(f.runner.prepare).not.toHaveBeenCalled();expect(f.runner.publish).not.toHaveBeenCalled();expect(f.deps.collect).not.toHaveBeenCalled();
});
it('publication rejects missing source selection before any work',async()=>{
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  await expect(runPass1ProductionBatch({...f.args,mode:'publish'} as any,f.deps)).rejects.toThrow('PASS1_PUBLICATION_SOURCE_REQUIRED');
  expect(f.deps.collect).not.toHaveBeenCalled();expect(f.runner.publish).not.toHaveBeenCalled();
});
it.each(['sent', 'unknown', 'rejected', 'authorized'])(
  'never resumes an existing %s operation',
  async (state) => {
    const f = fixture();
    f.setOperation(state);
    await checkpoint(f);
    const result = await runPass1ProductionBatch({ ...f.args, mode: 'execute' }, f.deps);
    expect(result.stopped).toBe(true);
    expect(f.runner.prepare).not.toHaveBeenCalled();
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.runner.publish).not.toHaveBeenCalled();
  },
);
it('never resumes only-media ACK even when an operation claims acknowledged state', async () => {
  const f = fixture(),
    op = f.setOperation();
  op.steps.pop();
  op.operation.item_id = null;
  await checkpoint(f);
  const result = await runPass1ProductionBatch({ ...f.args, mode: 'execute' }, f.deps);
  expect(result.stopped).toBe(true);
  expect(f.runner.run).not.toHaveBeenCalled();
});
it('retries only an undispatched reservation with the same operation and fresh create preflight', async () => {
  const f=fixture();f.loaded.value.publicationMode='hidden_for_review';
  const view=f.setOperation('authorized');view.operation.revision=1;view.operation.item_id=null;view.steps=[];
  await checkpoint(f);
  const operationId=view.operation.id;
  const result=await runPass1ProductionBatch({...f.args,mode:'execute'},f.deps);
  expect(result).toMatchObject({stopped:false,listings:[{state:'created_unlisted',operationId}]});
  expect(f.runner.prepare).not.toHaveBeenCalled();
  expect(f.runner.run).toHaveBeenCalledExactlyOnceWith(operationId);
  expect(f.runner.renewUndispatched).toHaveBeenCalledExactlyOnceWith(operationId,view.operation.source_fingerprint,f.input);
  expect(f.runner.renewUndispatched.mock.invocationCallOrder[0]).toBeLessThan(f.runner.run.mock.invocationCallOrder[0]);
  expect(f.runner.publish).not.toHaveBeenCalled();
  expect(f.deps.collect.mock.calls[0][2]).toMatchObject({purpose:'create',allowExistingListings:false});
  expect(f.deps.collect.mock.calls[0][2]).not.toHaveProperty('trustedExistingOperation');
});
it.each(['inspect','reconcile'] as const)('never dispatches a zero-step reservation from %s',async(mode)=>{
  const f=fixture(),view=f.setOperation('authorized');view.operation.revision=1;view.operation.item_id=null;view.steps=[];
  await checkpoint(f);
  const result=await runPass1ProductionBatch({...f.args,mode},f.deps);
  expect(result).toMatchObject({stopped:false,listings:[{state:mode==='inspect'?'inspected':'authorized_not_started',operationId:view.operation.id}]});
  expect(f.runner.prepare).not.toHaveBeenCalled();expect(f.runner.run).not.toHaveBeenCalled();expect(f.runner.publish).not.toHaveBeenCalled();
  if(mode==='reconcile')expect(f.deps.collect).not.toHaveBeenCalled();
});
it('rejects a zero-step reservation changed while its preflight was being collected',async()=>{
  const f=fixture(),view=f.setOperation('authorized');view.operation.revision=1;view.operation.item_id=null;view.steps=[];
  await checkpoint(f);
  f.deps.collect.mockImplementation(async()=>{
    view.operation.revision=2;view.steps.push({step_key:'media-0',state:'authorized'});
    return {sourceReceiptSha256:f.loaded.sha256,input:f.input};
  });
  const result=await runPass1ProductionBatch({...f.args,mode:'execute'},f.deps);
  expect(result).toMatchObject({stopped:true,listings:[{code:'PASS1_RECONCILIATION_REQUIRED'}]});
  expect(f.runner.prepare).not.toHaveBeenCalled();expect(f.runner.run).not.toHaveBeenCalled();
});
it('blocks a missing checkpoint for existing work without re-preparing it', async () => {
  const f = fixture();
  f.setOperation();
  const result = await runPass1ProductionBatch({ ...f.args, mode: 'execute' }, f.deps);
  expect(result.stopped).toBe(true);
  expect(f.runner.prepare).not.toHaveBeenCalled();
  expect(f.runner.run).not.toHaveBeenCalled();
});
it('refuses changed source bytes before any writer progression', async () => {
  const f = fixture();
  f.deps.load
    .mockResolvedValueOnce(f.loaded)
    .mockRejectedValue(Error('PRODUCTION_BATCH_SOURCE_FILE_CHANGED'));
  const result = await runPass1ProductionBatch({ ...f.args, mode: 'execute' }, f.deps);
  expect(result.stopped).toBe(true);
  expect(f.runner.prepare).not.toHaveBeenCalled();
});
function verification(op: any, phase: string, projection: unknown) {
  const readbacks = [0, 1].map((index) => ({
    shopId: '1423724897',
    partnerId: '2010476',
    itemId: op.item_id,
    observedAt: new Date(1750000000000 + index * 1000).toISOString(),
    requestIds: [phase + '-' + index],
    connectionRevision: 1,
    raw: { fixture: phase },
    projection,
    rawSha256: fp({ fixture: phase }),
    projectionSha256: fp(projection),
  }));
  return {
    id: randomUUID(),
    operation_id: op.id,
    operation_revision: op.revision - 1,
    item_id: op.item_id,
    phase,
    expected_fingerprint: fp(projection),
    readbacks,
    evidence_fingerprint: fp(readbacks),
  };
}
function publication(f: ReturnType<typeof fixture>, state = 'verified') {
  const view = f.setOperation('verified');
  view.operation.revision = 7;
  view.verification = verification(
    view.operation,
    'created_unlisted',
    view.operation.expected_projection,
  );
  const payload = { item_list: [{ item_id: 5001, unlist: false }] },
    receipt = {
      kind: 'success',
      requestId: 'publish-ack',
      response: { success_list: payload.item_list, failure_list: [] },
    };
  const op = {
    id: randomUUID(),
    owner_key: view.operation.owner_key,
    create_operation_id: view.operation.id,
    create_verification_id: view.verification.id,
    item_id: '5001',
    source_identity: f.source.sourceIdentity,
    source_revision: 1,
    source_fingerprint: view.operation.source_fingerprint,
    connection_id: 'connection-a',
    connection_revision: 1,
    state,
    revision: state === 'verified' ? 4 : 3,
    path: '/api/v2/product/unlist_item',
    payload,
    expected_projection: view.operation.expected_projection,
    fingerprint: productionPilotWriteFingerprint('/api/v2/product/unlist_item', payload),
    receipt,
    outcome_fingerprint: fp(receipt),
  };
  const result = {
    operation: op,
    verification:
      state === 'verified'
        ? verification(op, 'published', { ...op.expected_projection, status: 'NORMAL' })
        : null,
  };
  f.runner.publications.getForCreate.mockResolvedValue(result);
  return result;
}
it('skips completed current publications without any collector or runner progression', async () => {
  const f = fixture();
  publication(f);
  await checkpoint(f);
  const result = await runPass1ProductionBatch({ ...f.args, mode: 'execute' }, f.deps);
  expect(result).toMatchObject({
    stopped: false,
    listings: [{ state: 'published', itemId: '5001' }],
  });
  expect(f.deps.collect).not.toHaveBeenCalled();
  expect(f.runner.prepare).not.toHaveBeenCalled();
  expect(f.runner.run).not.toHaveBeenCalled();
  expect(f.runner.publish).not.toHaveBeenCalled();
});
it('reconcile passes only an already-ACK publication to the runner readback branch', async () => {
  const f = fixture();
  publication(f, 'acknowledged');
  await checkpoint(f);
  const result = await runPass1ProductionBatch({ ...f.args, mode: 'reconcile' }, f.deps);
  expect(result.stopped).toBe(false);
  expect(f.runner.prepare).not.toHaveBeenCalled();
  expect(f.runner.publish).toHaveBeenCalledOnce();
});
it.each(['sent', 'unknown', 'rejected'])(
  'does not dispatch an existing %s publication',
  async (state) => {
    const f = fixture();
    publication(f, state);
    await checkpoint(f);
    const result = await runPass1ProductionBatch({ ...f.args, mode: 'execute' }, f.deps);
    expect(result.stopped).toBe(true);
    expect(f.runner.publish).not.toHaveBeenCalled();
    expect(f.runner.run).not.toHaveBeenCalled();
  },
);
it('refuses a tampered completed proof instead of skipping the source as successful', async () => {
  const f = fixture(),
    pub = publication(f);
  pub.verification!.readbacks[0]!.raw.fixture = 'changed';
  await checkpoint(f);
  const result = await runPass1ProductionBatch({ ...f.args, mode: 'execute' }, f.deps);
  expect(result.stopped).toBe(true);
  expect(f.runner.prepare).not.toHaveBeenCalled();
  expect(f.runner.publish).not.toHaveBeenCalled();
});
