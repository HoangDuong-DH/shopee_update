import { describe, expect, it, vi } from 'vitest';
import { ArchiveCloneBatchInspector } from '../../apps/api/src/archive-clone-batch.js';

const job = (id: string, shop = '966101536') => ({
  manifest: { archiveId: 'archive', sourceShopId: 'source', items: [
    { sourceItemId: id, media: [] },
  ] },
  sourceItemId: id, sourceEvidenceId: 'evidence', target: { shopId: shop },
  scope: { shopId: shop }, policyHash: 'a'.repeat(64), context: {},
}) as any;

describe('archive clone batch inspector', () => {
  it('runs bounded inspect-only jobs in input order', async () => {
    const executeOne = vi.fn(async (input: any) => ({ kind: 'ready', plannedStepCount: 2, scope: input.scope }));
    const inspector = new ArchiveCloneBatchInspector({ executeOne } as any);
    const rows = [job('1'), job('2'), job('3')];
    const report = await inspector.inspect(rows, 2);
    expect(report.ready).toBe(3);
    expect(report.rows.map((row) => row.sourceItemId)).toEqual(['1', '2', '3']);
    expect(executeOne.mock.calls.every(([input]) => input.mode === 'inspect' && !input.pilot)).toBe(true);
  });
  it('rejects duplicate source/target and video before any I/O', async () => {
    const executeOne = vi.fn();
    const inspector = new ArchiveCloneBatchInspector({ executeOne } as any);
    await expect(inspector.inspect([job('1'), job('1')])).rejects.toThrow('DUPLICATE_TARGET');
    const video = job('2');
    video.manifest.items[0].media = [{role:'video'}];
    await expect(inspector.inspect([video])).rejects.toThrow('VIDEO_REQUIRES_SEPARATE_LANE');
    expect(executeOne).not.toHaveBeenCalled();
  });
});

describe('archive clone batch runner', () => {
  it('refuses all media/create work until the exact pilot is journal-verified', async () => {
    const { ArchiveCloneBatchRunner } = await import('../../apps/api/src/archive-clone-batch.js');
    const prepare = vi.fn();
    const executeOne = vi.fn();
    const pool = { query: vi.fn(async () => ({ rows: [{ state: 'held', target_item_id: '456', archive_id:'archive', source_item_id:'1', target_shop_id:'966101536',target_partner_id:'2010476',
      initial_result: 'mismatch', latest_recheck: null }] })) };
    const runner = new ArchiveCloneBatchRunner({ pool, coordinator: { executeOne },
      mediaJournal: {}, prepare, buildInput: vi.fn(), checkpoint: vi.fn() } as any);
    await expect(runner.run([{manifest:job('1').manifest,sourceItemId:'1',targetShopId:'966101536',targetPartnerId:'2010476'}],
      {intentId:'pilot',targetItemId:'456',archiveId:'archive',sourceItemId:'1',targetShopId:'966101536',targetPartnerId:'2010476'})).rejects.toThrow('PILOT_NOT_VERIFIED');
    expect(prepare).not.toHaveBeenCalled();
    expect(executeOne).not.toHaveBeenCalled();
  });
  it('never accepts a verified pilot from a different target shop', async () => {
    const { ArchiveCloneBatchRunner } = await import('../../apps/api/src/archive-clone-batch.js');
    const pool={query:vi.fn()};
    const prepare=vi.fn();
    const runner=new ArchiveCloneBatchRunner({pool,coordinator:{executeOne:vi.fn()},
      mediaJournal:{},prepare,buildInput:vi.fn(),checkpoint:vi.fn()} as any);
    await expect(runner.run([{manifest:job('1').manifest,sourceItemId:'1',
      targetShopId:'1376860967',targetPartnerId:'2010476'}],
      {intentId:'pilot',targetItemId:'456',archiveId:'archive',sourceItemId:'pilot',
        targetShopId:'966101536',targetPartnerId:'2010476'}))
      .rejects.toThrow('PILOT_SCOPE_MISMATCH');
    expect(pool.query).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });  it('stops on a held fresh preflight without an image upload or create', async () => {
    const { ArchiveCloneBatchRunner } = await import('../../apps/api/src/archive-clone-batch.js');
    const prepare = vi.fn(async () => ({kind:'held',reasons:['TARGET_CHANGED']}));
    const executeOne = vi.fn();
    const checkpoint = vi.fn(async () => {});
    const pool = { query: vi.fn(async (sql: string) => ({ rows: sql.includes('WHERE i.id=') ? [{ state: 'verified', target_item_id: '456', archive_id:'archive', source_item_id:'1', target_shop_id:'966101536',target_partner_id:'2010476',
      initial_result: 'mismatch', latest_recheck: 'verified' }] : [] })) };
    const runner = new ArchiveCloneBatchRunner({ pool, coordinator: { executeOne },
      mediaJournal: {}, prepare, buildInput: vi.fn(), checkpoint } as any);
    const rows = await runner.run([{manifest:job('1').manifest,sourceItemId:'1',targetShopId:'966101536',targetPartnerId:'2010476'},
      {manifest:job('2').manifest,sourceItemId:'2',targetShopId:'966101536',targetPartnerId:'2010476'}],
      {intentId:'pilot',targetItemId:'456',archiveId:'archive',sourceItemId:'1',targetShopId:'966101536',targetPartnerId:'2010476'},2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toEqual({kind:'held',reasons:['TARGET_CHANGED']});
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(executeOne).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({phase:'preflight',kind:'held'}));
  });
});

describe('existing clone intent guard', () => {
  it('skips an already verified pair before media preparation or another create', async () => {
    const { ArchiveCloneBatchRunner } = await import('../../apps/api/src/archive-clone-batch.js');
    const pool = { query: vi.fn(async (sql: string) => ({rows: sql.includes('WHERE i.id=$1')
      ? [{state:'verified',target_item_id:'456',archive_id:'archive',source_item_id:'pilot',
          target_shop_id:'966101536',target_partner_id:'2010476',initial_result:'verified'}]
      : [{id:'existing-intent',state:'verified',target_item_id:'789'}]})) };
    const prepare = vi.fn(), executeOne = vi.fn(), checkpoint = vi.fn(async () => {});
    const runner = new ArchiveCloneBatchRunner({pool,coordinator:{executeOne},mediaJournal:{},
      prepare,buildInput:vi.fn(),checkpoint} as any);
    const rows=await runner.run([{manifest:job('1').manifest,sourceItemId:'1',
      targetShopId:'966101536',targetPartnerId:'2010476'}],
      {intentId:'pilot',targetItemId:'456',archiveId:'archive',sourceItemId:'pilot',
       targetShopId:'966101536',targetPartnerId:'2010476'});
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('WHERE archive_id=$1 AND source_item_id=$2 AND target_partner_id=$3 AND target_shop_id=$4'))).toBe(true);
    expect(rows[0]!.skippedExisting).toBe(true);
    expect(rows[0]!.result).toEqual({kind:'verified',targetItemId:'789',intentId:'existing-intent'});
    expect(prepare).not.toHaveBeenCalled();
    expect(executeOne).not.toHaveBeenCalled();
  });
});

describe('batch media safety and pair isolation', () => {
  const batchCase = (id: string, mediaCount = 1) => ({
    manifest: { archiveId: 'archive', sourceShopId: 'source', items: [{ sourceItemId: id,
      observationHash: 'hash-' + id,
      media: Array.from({ length: mediaCount }, (_, ordinal) =>
        ({ role: 'gallery', ordinal, sha256: 'sha-' + ordinal })) }] },
    sourceItemId: id, targetShopId: '966101536', targetPartnerId: '2010476',
  }) as any;
  const prepared = (candidate: any) => ({ kind: 'ready', media: {
    approval: { archiveId: 'archive', sourceShopId: 'source',
      sourceItemId: candidate.sourceItemId,
      sourceObservationHash: 'hash-' + candidate.sourceItemId,
      targetShopId: '966101536', targetPartnerId: '2010476' },
    cloneScope: { targetShopId: '966101536' },
    credentials: { shopId: '966101536', partnerId: '2010476' },
    assets: candidate.manifest.items[0].media.map((m: any) => ({
      role: m.role, ordinal: m.ordinal, sha256: m.sha256, blobPath: 'fixture',
    })),
  } });
  const pilot = {intentId:'pilot',targetItemId:'456',archiveId:'archive',
    sourceItemId:'pilot',targetShopId:'966101536',targetPartnerId:'2010476'};
  const pool = (qcHeld = false) => ({query:vi.fn(async(sql:string) => ({rows:
    sql.includes('WHERE i.id=$1') ? [{state:'verified',target_item_id:'456',archive_id:'archive',
      source_item_id:'pilot',target_shop_id:'966101536',target_partner_id:'2010476',
      initial_result:'verified'}] : sql.includes('JOIN shop_listing_clone_qc') && qcHeld
      ? [{id:'held-intent'}] : []}))});

  it('limits image uploads to three, preserving asset order before create', async () => {
    const {ArchiveCloneBatchRunner}=await import('../../apps/api/src/archive-clone-batch.js');
    let active=0,peak=0;
    const uploadImage=vi.fn(async({media}:any)=>{
      active++;peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,8));
      active--;
      return {kind:'uploaded',remoteMediaId:'image-'+media.ordinal,transferId:'transfer-'+media.ordinal};
    });
    const buildInput=vi.fn(async(c:any,uploads:any[])=>{
      expect(uploads.map(r=>r.ordinal)).toEqual([0,1,2,3]);
      return {...job(c.sourceItemId),scope:{shopId:'966101536',partnerId:'2010476'}};
    });
    const executeOne=vi.fn(async(input:any)=>input.mode==='inspect'
      ? {kind:'ready',plannedStepCount:1,scope:input.scope}
      : {kind:'verified',targetItemId:'789',intentId:'intent'});
    const runner=new ArchiveCloneBatchRunner({pool:pool(),coordinator:{executeOne},
      mediaJournal:{},prepare:async(c:any)=>prepared(c),buildInput,
      checkpoint:async()=>{},uploadImage} as any);
    const rows=await runner.run([batchCase('1',4)],pilot);
    expect(rows[0]!.result.kind).toBe('verified');
    expect(uploadImage).toHaveBeenCalledTimes(4);
    expect(peak).toBe(3);
  });

  it('stops after a newly created item has a held QC mismatch, without starting another', async () => {
    const {ArchiveCloneBatchRunner}=await import('../../apps/api/src/archive-clone-batch.js');
    const executeOne=vi.fn(async(input:any)=>input.mode==='inspect'
      ? {kind:'ready',plannedStepCount:1,scope:input.scope}
      : input.sourceItemId==='1'
        ? {kind:'held',reasons:['QC_MISMATCH'],targetItemId:'789'}
        : {kind:'verified',targetItemId:'790',intentId:'other'});
    const runner=new ArchiveCloneBatchRunner({pool:pool(true),coordinator:{executeOne},
      mediaJournal:{},prepare:async(c:any)=>prepared(c),
      buildInput:async(c:any)=>({...job(c.sourceItemId),scope:{shopId:'966101536',partnerId:'2010476'}}),
      checkpoint:async()=>{},uploadImage:async({media}:any)=>({kind:'uploaded',remoteMediaId:'image-'+media.ordinal,transferId:'transfer'})} as any);
    const rows=await runner.run([batchCase('1'),batchCase('2')],pilot,2);
    expect(rows.map(r=>r.result.kind)).toEqual(['held']);
    expect(executeOne.mock.calls.filter(([input])=>input.mode==='pilot')).toHaveLength(1);
  });
});

describe('reviewed held pair checkpoint',()=>{
  it('stops on a held intent unless its exact ID was reviewed for isolation',async()=>{
    const {ArchiveCloneBatchRunner}=await import('../../apps/api/src/archive-clone-batch.js');
    const pool={query:vi.fn(async(sql:string)=>({rows:sql.includes('WHERE i.id=$1')
      ? [{state:'verified',target_item_id:'456',archive_id:'archive',source_item_id:'pilot',
          target_shop_id:'966101536',target_partner_id:'2010476',initial_result:'verified'}]
      : [{id:'held-1',state:'held',target_item_id:'789'}]}))};
    const prepare=vi.fn();
    const runner=new ArchiveCloneBatchRunner({pool,coordinator:{executeOne:vi.fn()},
      mediaJournal:{},prepare,buildInput:vi.fn(),checkpoint:vi.fn(async()=>{})} as any);
    const candidates=[{manifest:job('1').manifest,sourceItemId:'1',
      targetShopId:'966101536',targetPartnerId:'2010476'},
      {manifest:job('2').manifest,sourceItemId:'2',
      targetShopId:'966101536',targetPartnerId:'2010476'}];
    const pilot={intentId:'pilot',targetItemId:'456',archiveId:'archive',
      sourceItemId:'pilot',targetShopId:'966101536',targetPartnerId:'2010476'};
    expect(await runner.run(candidates,pilot,2)).toHaveLength(1);
    const reviewed=await runner.run(candidates,pilot,2,['held-1']);
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every(row=>row.skippedExisting)).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('bounded append-only QC recheck',()=>{
  const candidate={manifest:{archiveId:'archive',sourceShopId:'source',items:[{
    sourceItemId:'1',observationHash:'hash',media:[{role:'gallery',ordinal:0,sha256:'sha'}]}]},
    sourceItemId:'1',targetShopId:'966101536',targetPartnerId:'2010476'} as any;
  const pilot={intentId:'pilot',targetItemId:'456',archiveId:'archive',
    sourceItemId:'pilot',targetShopId:'966101536',targetPartnerId:'2010476'};
  const create = (paths:string[])=>{
    const pool={query:vi.fn(async(sql:string)=>({rows:sql.includes('WHERE i.id=$1')
      ? [{state:'verified',target_item_id:'456',archive_id:'archive',source_item_id:'pilot',
        target_shop_id:'966101536',target_partner_id:'2010476',initial_result:'verified'}]
      : sql.includes('JOIN shop_listing_clone_qc')
        ? [{id:'intent',comparator_result:{mismatchedPaths:paths}}] : []}))};
    const executeOne=vi.fn(async(input:any)=>input.mode==='inspect'
      ? {kind:'ready',plannedStepCount:1,scope:input.scope}
      : {kind:'held',reasons:['QC_MISMATCH'],targetItemId:'789'});
    const qcRechecker={recheckOne:vi.fn(async()=>({kind:'verified',targetItemId:'789',intentId:'intent'}))};
    const deps={pool,coordinator:{executeOne},mediaJournal:{},
      prepare:async()=>({kind:'ready',media:{approval:{archiveId:'archive',sourceShopId:'source',
        sourceItemId:'1',sourceObservationHash:'hash',targetShopId:'966101536',targetPartnerId:'2010476'},
        cloneScope:{targetShopId:'966101536'},credentials:{shopId:'966101536',partnerId:'2010476'},
        assets:[{role:'gallery',ordinal:0,sha256:'sha',blobPath:'fixture'}]}}),
      uploadImage:async()=>({kind:'uploaded',remoteMediaId:'img',transferId:'transfer'}),
      buildInput:async()=>({...job('1'),scope:{shopId:'966101536',partnerId:'2010476'}}),
      checkpoint:async()=>{},qcRechecker};
    return {deps,qcRechecker};
  };
  it('does not recheck a pricing or source-mapping mismatch',async()=>{
    const {ArchiveCloneBatchRunner}=await import('../../apps/api/src/archive-clone-batch.js');
    const {deps,qcRechecker}=create(['models.0.price_info']);
    const rows=await new ArchiveCloneBatchRunner(deps as any).run([candidate],pilot);
    expect(rows[0]!.result.kind).toBe('held');
    expect(qcRechecker.recheckOne).not.toHaveBeenCalled();
  });
  it('rechecks known propagation/cover paths once and never replays create',async()=>{
    vi.useFakeTimers();
    try{
      const {ArchiveCloneBatchRunner}=await import('../../apps/api/src/archive-clone-batch.js');
      const {deps,qcRechecker}=create(['readbacks.itemStable','readbacks.modelsStable','item.promotion_image.image_id_list','models.1.saleable_stock','models.1.seller_stock']);
      const pending=new ArchiveCloneBatchRunner(deps as any).run([candidate],pilot);
      await vi.advanceTimersByTimeAsync(3001);
      const rows=await pending;
      expect(rows[0]!.result.kind).toBe('verified');
      expect(qcRechecker.recheckOne).toHaveBeenCalledTimes(1);
      expect(deps.coordinator.executeOne).toHaveBeenCalledTimes(2);
    }finally{vi.useRealTimers();}
  });
});
