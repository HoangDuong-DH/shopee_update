import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalJson, checkArchiveCloneReadback, type CloneQcInput } from '@shopee/domain';
import { transaction } from '@shopee/persistence';

const sha = /^[a-f0-9]{64}$/;
const itemId = /^[1-9][0-9]*$/;
const stepKey = /^[A-Za-z0-9_.:-]{1,160}$/;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = (reason: string): never => { throw new Error('CLONE_JOURNAL_' + reason); };
const assertHash = (value: string) => { if (!sha.test(value)) fail('HASH_INVALID'); };
const json = (value: unknown) => {
  const valueCopy = JSON.parse(JSON.stringify(value));
  if (!valueCopy || typeof valueCopy !== 'object' || Array.isArray(valueCopy))
    fail('EVIDENCE_INVALID');
  return valueCopy as Record<string, unknown>;
};

export type CloneIntentInput = {
  archiveId: string;
  sourceItemId: string;
  sourceEvidenceId: string;
  sourceHash: string;
  policyHash: string;
  plannedPayloadHash: string;
  expectedProjectionHash?: string;
  targetConnectionId: string;
  targetConnectionRevision: number;
  targetPartnerId: string;
  targetShopId: string;
};
export type CloneStepKind = 'image' | 'video' | 'create' | 'init_variation';
export type CloneStepInput = {
  stepKey: string;
  ordinal: number;
  kind: CloneStepKind;
  requestHash: string;
};

/** Source contract excludes target-generated IDs. It is computed from DB evidence, not caller input. */
async function sourceProjectionHash(client: PoolClient, archiveId: string, sourceItemId: string,
  sourceEvidenceId: string, sourceHash: string, policyHash: string) {
  const row = (await client.query(`SELECT o.body,o.content_hash,a.source_shop_id
    FROM seller_knowledge_observations o
    JOIN shop_listing_archive_items i ON i.evidence_id=o.id
    JOIN shop_listing_archives a ON a.id=i.archive_id
    WHERE i.archive_id=$1 AND i.item_id=$2 AND o.id=$3`,
    [archiveId,sourceItemId,sourceEvidenceId])).rows[0];
  if (!row || row.content_hash !== sourceHash ||
      String(row.body?.rawItem?.item_id) !== sourceItemId ||
      !Object.prototype.hasOwnProperty.call(row.body,'rawModels')) fail('SOURCE_PROJECTION_UNAVAILABLE');
  const media = (await client.query(`SELECT role,ordinal,source_media_id,blob_sha256,state
    FROM shop_listing_media_refs WHERE archive_id=$1 AND item_id=$2 ORDER BY role,ordinal`,
    [archiveId,sourceItemId])).rows;
  if (media.some((m: any) => m.state !== 'stored' || !m.blob_sha256)) fail('SOURCE_MEDIA_INCOMPLETE');
  const aux = (await client.query(`SELECT kind,content_hash FROM shop_listing_archive_aux
    WHERE archive_id=$1 AND item_id=$2 ORDER BY kind`,[archiveId,sourceItemId])).rows;
  if (row.body.rawItem.has_promotion && !aux.some((a: any) => a.kind === 'promotion'))
    fail('SOURCE_PROMOTION_INCOMPLETE');
  return digest({archiveId,sourceItemId,sourceEvidenceId,sourceHash,sourceShopId:row.source_shop_id,
    policyHash,rawItem:row.body.rawItem,rawModels:row.body.rawModels,media,aux});
}
/** Pure persistence boundary. The caller must run source/target preflight and own Shopee transport. */
export class ShopListingCloneJournal {
  constructor(private readonly pool: Pool) {}

  async reserve(input: CloneIntentInput) {
    for (const hash of [input.sourceHash,input.policyHash,input.plannedPayloadHash]) assertHash(hash);
    if (input.expectedProjectionHash) assertHash(input.expectedProjectionHash);
    if (!itemId.test(input.sourceItemId) || !itemId.test(input.targetShopId) || !itemId.test(input.targetPartnerId) ||
        !Number.isSafeInteger(input.targetConnectionRevision) || input.targetConnectionRevision <= 0)
      fail('IDENTITY_INVALID');
    return transaction(this.pool, async client => {
      const source = await client.query(
        `SELECT i.evidence_id,i.content_hash,a.source_shop_id FROM shop_listing_archive_items i
         JOIN shop_listing_archives a ON a.id=i.archive_id
         WHERE i.archive_id=$1 AND i.item_id=$2 FOR SHARE OF i,a`,
        [input.archiveId,input.sourceItemId]);
      if (source.rows.length !== 1 ||
          source.rows[0].evidence_id !== input.sourceEvidenceId ||
          source.rows[0].content_hash !== input.sourceHash ||
          source.rows[0].source_shop_id === input.targetShopId) fail('SOURCE_CHANGED');
      const target = await client.query(
        `SELECT partner_id,shop_id,revision,state,environment FROM connections WHERE id=$1 FOR SHARE`,
        [input.targetConnectionId]);
      if (target.rows.length !== 1 ||
          target.rows[0].environment !== 'production' ||
          target.rows[0].partner_id !== input.targetPartnerId ||
          target.rows[0].shop_id !== input.targetShopId ||
          target.rows[0].revision !== input.targetConnectionRevision ||
          target.rows[0].state !== 'connected') fail('TARGET_CHANGED');
      const expectedProjectionHash = await sourceProjectionHash(client,input.archiveId,input.sourceItemId,
        input.sourceEvidenceId,input.sourceHash,input.policyHash);
      if (input.expectedProjectionHash && input.expectedProjectionHash !== expectedProjectionHash)
        fail('SOURCE_PROJECTION_MISMATCH');
      const result = await client.query(
        `INSERT INTO shop_listing_clone_intents
         (id,archive_id,source_item_id,source_evidence_id,source_hash,policy_hash,
          planned_payload_hash,expected_projection_hash,target_connection_id,
          target_connection_revision,target_partner_id,target_shop_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (archive_id,source_item_id,target_partner_id,target_shop_id) DO NOTHING
         RETURNING *`,
        [randomUUID(),input.archiveId,input.sourceItemId,input.sourceEvidenceId,input.sourceHash,
         input.policyHash,input.plannedPayloadHash,expectedProjectionHash,input.targetConnectionId,
         input.targetConnectionRevision,input.targetPartnerId,input.targetShopId]);
      const row = result.rows[0] ?? (await client.query(
        `SELECT * FROM shop_listing_clone_intents
         WHERE archive_id=$1 AND source_item_id=$2 AND target_partner_id=$3 AND target_shop_id=$4 FOR UPDATE`,
        [input.archiveId,input.sourceItemId,input.targetPartnerId,input.targetShopId])).rows[0];
      if (!row || row.source_evidence_id !== input.sourceEvidenceId ||
          row.source_hash !== input.sourceHash || row.policy_hash !== input.policyHash ||
          row.planned_payload_hash !== input.plannedPayloadHash ||
          row.expected_projection_hash !== expectedProjectionHash ||
          row.target_connection_id !== input.targetConnectionId ||
          row.target_connection_revision !== input.targetConnectionRevision)
        fail('INTENT_ALREADY_RESERVED_DIFFERENT_PLAN');
      return row;
    });
  }

  async authorizeStep(intentId: string, input: CloneStepInput) {
    if (!stepKey.test(input.stepKey) || !Number.isSafeInteger(input.ordinal) || input.ordinal <= 0 ||
        !['image','video','create','init_variation'].includes(input.kind)) fail('STEP_INVALID');
    assertHash(input.requestHash);
    return transaction(this.pool, async client => {
      const intent = (await client.query(
        'SELECT * FROM shop_listing_clone_intents WHERE id=$1 FOR UPDATE',[intentId])).rows[0];
      if (!intent || !['reserved','working','needs_qc'].includes(intent.state)) fail('INTENT_NOT_WRITABLE');
      if (input.kind === 'create' && input.requestHash !== intent.planned_payload_hash)
        fail('CREATE_PAYLOAD_CHANGED');
      if (intent.state === 'needs_qc' && input.kind !== 'init_variation') fail('INTENT_NEEDS_QC');
      const prior = (await client.query(
        `SELECT s.*,r.finding FROM shop_listing_clone_steps s
         LEFT JOIN shop_listing_clone_reconciliations r ON r.step_id=s.id
         WHERE s.intent_id=$1 ORDER BY s.ordinal`,[intentId])).rows;
      if (prior.some(row => row.state !== 'acknowledged' && !(row.state === 'unknown' && row.finding === 'found')))
        fail('PREVIOUS_STEP_UNRESOLVED');
      if (prior.length && input.ordinal <= prior[prior.length-1].ordinal) fail('STEP_ORDER');
      if (input.kind === 'init_variation' && !prior.some(row => row.kind === 'create'))
        fail('CREATE_REQUIRED');
      if (input.kind === 'create' && prior.some(row => row.kind === 'create')) fail('CREATE_ALREADY_RESERVED');
      const result = await client.query(
        `INSERT INTO shop_listing_clone_steps(id,intent_id,step_key,ordinal,kind,request_hash)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [randomUUID(),intentId,input.stepKey,input.ordinal,input.kind,input.requestHash]);
      if (intent.state === 'reserved')
        await client.query(`UPDATE shop_listing_clone_intents SET state='working',updated_at=now() WHERE id=$1`,[intentId]);
      return result.rows[0];
    });
  }

  /** Persist the sent marker before making the marketplace request. No second send is allowed. */
  async markSent(stepId: string) {
    return transaction(this.pool, async client => {
      const row = (await client.query(
        `SELECT s.*,i.target_connection_id,i.target_connection_revision,i.target_partner_id,i.target_shop_id,
                i.state AS intent_state FROM shop_listing_clone_steps s
         JOIN shop_listing_clone_intents i ON i.id=s.intent_id WHERE s.id=$1 FOR UPDATE OF s`,[stepId])).rows[0];
      if (!row || row.state !== 'authorized' || !['working','needs_qc'].includes(row.intent_state))
        fail('STEP_ALREADY_SENT_OR_HELD');
      const connection = (await client.query(
        "SELECT revision,state,environment,partner_id,shop_id,expires_at, " +
        "(expires_at > now() + interval '60 seconds') AS token_safe FROM connections WHERE id=$1 FOR SHARE",
        [row.target_connection_id])).rows[0];
      if (!connection || connection.revision !== row.target_connection_revision ||
          connection.state !== 'connected' || connection.environment !== 'production' ||
          connection.partner_id !== row.target_partner_id || connection.shop_id !== row.target_shop_id)
        fail('TARGET_CHANGED');
      if (connection.token_safe !== true) fail('TARGET_TOKEN_EXPIRING');
      return (await client.query(
        `UPDATE shop_listing_clone_steps SET state='sent',sent_at=now() WHERE id=$1 RETURNING *`,[stepId])).rows[0];
    });
  }

  async recordOutcome(stepId: string, outcome: 'acknowledged'|'rejected'|'unknown',
                      receipt: Record<string,unknown>, targetItemId?: string) {
    if (targetItemId && !itemId.test(targetItemId)) fail('TARGET_ITEM_INVALID');
    const body = json(receipt);
    return transaction(this.pool, async client => {
      const step = (await client.query(
        'SELECT * FROM shop_listing_clone_steps WHERE id=$1 FOR UPDATE',[stepId])).rows[0];
      if (!step || step.state !== 'sent') fail('STEP_OUTCOME_ALREADY_RECORDED');
      const intent = (await client.query(
        'SELECT * FROM shop_listing_clone_intents WHERE id=$1 FOR UPDATE',[step.intent_id])).rows[0];
      if (step.kind !== 'create' && targetItemId) fail('TARGET_ITEM_UNEXPECTED');
      if (step.kind === 'create' && outcome === 'acknowledged' && !targetItemId) fail('TARGET_ITEM_REQUIRED');
      if (step.kind === 'create' && outcome !== 'acknowledged' && targetItemId) fail('TARGET_ITEM_UNEXPECTED');
      const result = await client.query(
        `UPDATE shop_listing_clone_steps SET state=$2,receipt=$3,receipt_hash=$4,recorded_at=now()
         WHERE id=$1 RETURNING *`,[stepId,outcome,body,digest(body)]);
      const state = outcome === 'unknown' ? 'needs_reconciliation' :
        outcome === 'rejected' ? 'held' :
        step.kind === 'create' || step.kind === 'init_variation' ? 'needs_qc' : 'working';
      if (state !== intent.state || targetItemId)
        await client.query(
          `UPDATE shop_listing_clone_intents SET state=$2,target_item_id=COALESCE(target_item_id,$3),updated_at=now()
           WHERE id=$1`,[intent.id,state,targetItemId ?? null]);
      return result.rows[0];
    });
  }

  async reconcile(stepId: string, input: {
    finding: 'found'|'absent'|'inconclusive'; targetItemId?: string;
    evidence: Record<string,unknown>; observedAt: string;
  }) {
    if (!Number.isFinite(Date.parse(input.observedAt)) ||
        (input.targetItemId !== undefined && !itemId.test(input.targetItemId)))
      fail('RECONCILIATION_INVALID');
    const evidence = json(input.evidence);
    return transaction(this.pool, async client => {
      const step = (await client.query(
        'SELECT * FROM shop_listing_clone_steps WHERE id=$1 FOR UPDATE',[stepId])).rows[0];
      if (!step || step.state !== 'unknown') fail('STEP_NOT_UNKNOWN');
      const intent = (await client.query(
        'SELECT * FROM shop_listing_clone_intents WHERE id=$1 FOR UPDATE',[step.intent_id])).rows[0];
      if (intent.state !== 'needs_reconciliation') fail('INTENT_NOT_RECONCILING');
      if (step.kind === 'create' && input.finding === 'found' && !input.targetItemId)
        fail('TARGET_ITEM_REQUIRED');
      if ((step.kind !== 'create' || input.finding !== 'found') && input.targetItemId)
        fail('TARGET_ITEM_UNEXPECTED');
      const row = (await client.query(
        `INSERT INTO shop_listing_clone_reconciliations
         (id,step_id,finding,target_item_id,evidence_hash,evidence,observed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [randomUUID(),stepId,input.finding,input.targetItemId ?? null,digest(evidence),evidence,input.observedAt])).rows[0];
      const state = input.finding === 'found' ? (['create','init_variation'].includes(step.kind) ? 'needs_qc' : 'working') : 'held';
      await client.query(
        `UPDATE shop_listing_clone_intents SET state=$2,target_item_id=COALESCE(target_item_id,$3),updated_at=now()
         WHERE id=$1`,[intent.id,state,input.targetItemId ?? null]);
      return row;
    });
  }

  async recordQc(intentId: string, input: {
    targetItemId: string;
    evidence: CloneQcInput;
    /** Optional caller checksum; journal independently hashes the raw GET pair. */
    readbackHash?: string;
  }) {
    return this.recordQcAttempt(intentId,input,false);
  }

  /** Read-only append-only reconciliation after propagation caused an initial QC mismatch.
   * It cannot authorize, send, or retry any marketplace mutation. */
  async recordQcRecheck(intentId: string, input: {
    targetItemId: string;
    evidence: CloneQcInput;
    readbackHash?: string;
  }) {
    return this.recordQcAttempt(intentId,input,true);
  }

  private async recordQcAttempt(intentId: string, input: {
    targetItemId: string;
    evidence: CloneQcInput;
    readbackHash?: string;
  }, recheck: boolean) {
    if (!itemId.test(input.targetItemId)) fail('TARGET_ITEM_INVALID');
    const evidence = input.evidence;
    const rawReadback = json({readbacks:evidence.readbacks});
    const rawReadbackHash = digest(rawReadback);
    if (input.readbackHash && input.readbackHash !== rawReadbackHash) fail('READBACK_HASH_MISMATCH');
    return transaction(this.pool, async client => {
      const intent = (await client.query(
        'SELECT * FROM shop_listing_clone_intents WHERE id=$1 FOR UPDATE',[intentId])).rows[0];
      if (!intent || intent.state !== (recheck ? 'held' : 'needs_qc') ||
          intent.target_item_id !== input.targetItemId)
        fail('QC_NOT_READY');
      let initialQc: any;
      if (recheck) {
        initialQc = (await client.query(
          'SELECT * FROM shop_listing_clone_qc WHERE intent_id=$1 FOR SHARE',[intentId])).rows[0];
        if (!initialQc || initialQc.result !== 'mismatch' ||
            initialQc.target_item_id !== input.targetItemId)
          fail('QC_RECHECK_INITIAL_MISMATCH_REQUIRED');
        const steps=(await client.query(
          'SELECT kind,state FROM shop_listing_clone_steps WHERE intent_id=$1',[intentId])).rows;
        if (!steps.some((s:any)=>s.kind==='create' && s.state==='acknowledged') ||
            steps.some((s:any)=>s.state!=='acknowledged'))
          fail('QC_RECHECK_STEPS_UNRESOLVED');
        const checkedAt=Date.parse(initialQc.checked_at);
        const now=Date.now();
        if (evidence.readbacks.length!==2 ||
            evidence.readbacks.some((r:any)=>{
              const observed=Date.parse(r.observedAt);
              return !Number.isFinite(observed) || observed<=checkedAt ||
                observed>now || now-observed>5*60_000;
            }))
          fail('QC_RECHECK_READS_NOT_FRESH');
      }
      if (evidence.manifest.archiveId !== intent.archive_id ||
          evidence.sourceItemId !== intent.source_item_id ||
          evidence.targetShopId !== intent.target_shop_id ||
          evidence.manifest.sourceShopId === intent.target_shop_id)
        fail('QC_SCOPE_MISMATCH');
      const source = (await client.query(
        'SELECT o.body,a.source_shop_id FROM shop_listing_archive_items i ' +
        'JOIN shop_listing_archives a ON a.id=i.archive_id ' +
        'JOIN seller_knowledge_observations o ON o.id=i.evidence_id ' +
        'WHERE i.archive_id=$1 AND i.item_id=$2 AND i.evidence_id=$3',
        [intent.archive_id,intent.source_item_id,intent.source_evidence_id])).rows[0];
      const sourceItem = evidence.manifest.items.find(i => i.sourceItemId === intent.source_item_id);
      if (!sourceItem) throw new Error('CLONE_JOURNAL_QC_SOURCE_EVIDENCE_MISMATCH');
      if (!source || source.source_shop_id !== evidence.manifest.sourceShopId ||
          canonicalJson(sourceItem.rawItem) !== canonicalJson(source.body.rawItem) ||
          canonicalJson(sourceItem.rawModels) !== canonicalJson(source.body.rawModels))
        fail('QC_SOURCE_EVIDENCE_MISMATCH');
      const media = (await client.query(
        'SELECT role,ordinal,source_media_id,blob_sha256 FROM shop_listing_media_refs ' +
        'WHERE archive_id=$1 AND item_id=$2 ORDER BY role,ordinal',
        [intent.archive_id,intent.source_item_id])).rows;
      const expectedMedia = [...sourceItem.media].sort((a,b) =>
        (a.role+':'+a.ordinal).localeCompare(b.role+':'+b.ordinal))
        .map(m => ({role:m.role,ordinal:m.ordinal,source_media_id:m.sourceMediaId ?? null,
          blob_sha256:m.sha256}));
      if (canonicalJson(media) !== canonicalJson(expectedMedia)) fail('QC_SOURCE_MEDIA_MISMATCH');
      const sourceHash = await sourceProjectionHash(client,intent.archive_id,intent.source_item_id,
        intent.source_evidence_id,intent.source_hash,intent.policy_hash);
      if (sourceHash !== intent.expected_projection_hash) fail('QC_SOURCE_PROJECTION_CHANGED');
      if (evidence.sourceObservationHash !== sourceItem.observationHash) fail('QC_SOURCE_OBSERVATION_MISMATCH');
      const transfers = (await client.query(
        'SELECT source_role,source_ordinal,blob_sha256,state,remote_media_id,image_scene,image_ratio '+
        'FROM shop_listing_media_transfers WHERE archive_id=$1 AND source_item_id=$2 '+
        'AND target_connection_id=$3 AND target_connection_revision=$4 '+
        "AND target_partner_id=$5 AND target_shop_id=$6 AND media_kind='image'",
        [intent.archive_id,intent.source_item_id,intent.target_connection_id,
         intent.target_connection_revision,intent.target_partner_id,intent.target_shop_id])).rows;
      for (const proof of evidence.images) {
        const ratio = proof.role === 'gallery' ? '3:4' : proof.role === 'description' ? '' : '1:1';
        const scene = proof.role === 'description' ? 'desc' : 'normal';
        const matches = transfers.filter((t: any) => t.source_role===proof.role &&
          t.source_ordinal===proof.ordinal && t.blob_sha256===proof.sourceSha256 && t.state==='acknowledged' &&
          t.remote_media_id===proof.uploadedId && t.image_scene===scene && t.image_ratio===ratio);
        if (matches.length !== 1) fail('QC_MEDIA_RECEIPT_MISMATCH');
      }
      const sourceVideo = sourceItem.media.find(m => m.role === 'video');
      if (Boolean(sourceVideo) !== Boolean(evidence.video)) fail('QC_VIDEO_PROOF_MISSING');
      if (sourceVideo && evidence.video) {
        const videoKey = ['production',intent.target_partner_id,intent.target_shop_id,
          intent.source_item_id,sourceVideo.sha256].join(':');
        const videoEntry = (await client.query(
          'SELECT entry FROM shop_listing_video_upload_entries WHERE key=$1',[videoKey])).rows[0]?.entry;
        const hasUrl=(rows: unknown, url: string | undefined, keys: string[]) =>
          typeof url === 'string' && Array.isArray(rows) &&
          rows.some((entry: unknown) => typeof entry === 'string' ? entry === url :
            !!entry && typeof entry === 'object' &&
            keys.some(key=>(entry as Record<string,unknown>)[key] === url));
        if (!videoEntry || videoEntry.phase !== 'succeeded' ||
            videoEntry.uploadId !== evidence.video.uploadId ||
            !hasUrl(videoEntry.videoInfo?.video_url_list,evidence.video.targetUrl,['video_url','url']) ||
            !hasUrl(videoEntry.videoInfo?.thumbnail_url_list,evidence.video.targetThumbnailUrl,['image_url','url']))
          fail('QC_VIDEO_RECEIPT_MISMATCH');
      }
      const qc = checkArchiveCloneReadback(evidence);
      if (qc.targetItemId !== input.targetItemId) fail('QC_TARGET_ITEM_MISMATCH');
      const verified = qc.verified && qc.expectedProjectionHash === qc.observedProjectionHash;
      const comparatorResult = json(qc);
      const proof=json({images:evidence.images,video:evidence.video,
        targetCategoryId:evidence.targetCategoryId,targetBrandId:evidence.targetBrandId,
        targetLocationBySku:evidence.targetLocationBySku,
        targetLogisticIdBySourceId:evidence.targetLogisticIdBySourceId});
      let row: any;
      if (recheck) {
        const prior=(await client.query(
          'SELECT COALESCE(MAX(attempt_no),0) AS n FROM shop_listing_clone_qc_rechecks WHERE intent_id=$1',
          [intentId])).rows[0];
        row=(await client.query(
          'INSERT INTO shop_listing_clone_qc_rechecks ' +
          '(id,intent_id,initial_qc_id,attempt_no,target_item_id,source_hash,expected_projection_hash,' +
          'readback_hash,readback,proof,result,normalized_expected_hash,normalized_observed_hash,comparator_result) ' +
          'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
          [randomUUID(),intentId,initialQc.id,Number(prior.n)+1,input.targetItemId,
           intent.source_hash,intent.expected_projection_hash,rawReadbackHash,rawReadback,proof,
           verified ? 'verified' : 'mismatch',qc.expectedProjectionHash,
           qc.observedProjectionHash,comparatorResult])).rows[0];
        if (verified)
          await client.query(
            "UPDATE shop_listing_clone_intents SET state='verified',updated_at=now() WHERE id=$1",
            [intentId]);
      } else {
        row=(await client.query(
          'INSERT INTO shop_listing_clone_qc ' +
          '(id,intent_id,target_item_id,source_hash,expected_projection_hash,' +
          'readback_hash,readback,result,normalized_expected_hash,normalized_observed_hash,comparator_result) ' +
          'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
          [randomUUID(),intentId,input.targetItemId,intent.source_hash,intent.expected_projection_hash,
           rawReadbackHash,rawReadback,verified ? 'verified' : 'mismatch',
           qc.expectedProjectionHash,qc.observedProjectionHash,comparatorResult])).rows[0];
        await client.query(
          'UPDATE shop_listing_clone_intents SET state=$2,updated_at=now() WHERE id=$1',
          [intentId,verified ? 'verified' : 'held']);
      }
      return row;
    });
  }

  async get(intentId: string) {
    const [intent,steps,reconciliations,qc,rechecks] = await Promise.all([
      this.pool.query('SELECT * FROM shop_listing_clone_intents WHERE id=$1',[intentId]),
      this.pool.query('SELECT * FROM shop_listing_clone_steps WHERE intent_id=$1 ORDER BY ordinal',[intentId]),
      this.pool.query(`SELECT r.* FROM shop_listing_clone_reconciliations r
        JOIN shop_listing_clone_steps s ON s.id=r.step_id WHERE s.intent_id=$1`,[intentId]),
      this.pool.query('SELECT * FROM shop_listing_clone_qc WHERE intent_id=$1',[intentId]),
      this.pool.query('SELECT * FROM shop_listing_clone_qc_rechecks WHERE intent_id=$1 ORDER BY attempt_no',[intentId]),
    ]);
    return intent.rows[0] ? {intent:intent.rows[0],steps:steps.rows,reconciliations:reconciliations.rows,qc:qc.rows[0] ?? null,rechecks:rechecks.rows} : null;
  }
}




