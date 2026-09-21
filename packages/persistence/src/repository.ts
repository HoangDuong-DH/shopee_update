import { createHash, randomUUID } from 'node:crypto';
import { folderDraftSelection } from '../../domain/src/folder-source-identity.js';
import {
  planFingerprint,
  canonicalJson,
  type ChangePlan,
  type ListingDraft,
  type JobRecord,
} from '@shopee/domain';
import type { Pool, PoolClient } from 'pg';
import { transaction, probeMigrations } from './db.js';
import { localArchiveList, lockLocalSourceSelection, assertDraftLocalSourcesActive, assertLocalResourcesActive, type LocalLifecycle } from './local-archives.js';
export type ImportRecord = {
  id: string;
  sha256: string;
  filename: string;
  kind: 'xlsx' | 'docx' | 'image';
  bytes: number;
  status: string;
  message: string;
  createdAt: string;
  body: unknown;
};
const importRow = (r: any): ImportRecord => ({
  id: r.id,
  sha256: r.sha256,
  filename: r.filename,
  kind: r.kind,
  bytes: Number(r.bytes),
  status: r.status,
  message: r.message,
  createdAt: r.created_at.toISOString(),
  body: r.body,
});
const jobRow = (r: any): JobRecord => ({
  id: r.id,
  planId: r.plan_id,
  planRevision: r.plan_revision,
  scope: r.scope,
  state: r.state,
  paused: r.paused,
  cancelRequested: r.cancel_requested,
  leaseEpoch: r.lease_epoch,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  nextRunAt: r.next_run_at.toISOString(),
  message: r.message,
  attemptCount: r.attempt_count,
});
const preparedStructure = (draft: ListingDraft) => ({
  tierNames: draft.tierNames,
  variants: draft.variants.map((variant) => ({
    sku: variant.sku.value,
    optionLabels: variant.optionLabels,
  })),
});
export class Repository {
  constructor(readonly pool: Pool) {}
  async probe() {
    await probeMigrations(this.pool);
  }
  async createImport(input: {
    sha256: string;
    filename: string;
    kind: ImportRecord['kind'];
    bytes: number;
  }): Promise<ImportRecord> {
    const result = await this.pool.query(
      `INSERT INTO source_files(id,sha256,filename,kind,bytes) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(sha256,kind) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING *`,
      [randomUUID(), input.sha256, input.filename, input.kind, input.bytes],
    );
    return importRow(result.rows[0]);
  }
  async listImports(lifecycle: LocalLifecycle = 'active') {
    const rows = (
      await this.pool.query('SELECT *,NULL AS body FROM source_files ORDER BY created_at DESC')
    ).rows.map(importRow);
    // Only pricebooks have archive controls; other imported files remain historical evidence.
    const marked = await localArchiveList(this.pool, 'pricebook', rows, r => r.kind === 'xlsx' ? r.id : '', 'all');
    return marked.filter(r => lifecycle === 'all' || r.archived === (lifecycle === 'archived'));
  }
  async getImport(id: string) {
    const r = await this.pool.query('SELECT * FROM source_files WHERE id=$1', [id]);
    return r.rows[0] ? importRow(r.rows[0]) : null;
  }
  async claimImport(): Promise<ImportRecord | null> {
    const r = await this.pool
      .query(`UPDATE source_files SET status='running',lease_until=now()+interval '5 minutes',updated_at=now()
      WHERE id=(SELECT id FROM source_files WHERE status='queued' OR (status='running' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    return r.rows[0] ? importRow(r.rows[0]) : null;
  }
  async finishImport(id: string, body: unknown, message = '') {
    await this.pool.query(
      'UPDATE source_files SET status=$2,body=$3,message=$4,lease_until=NULL,updated_at=now() WHERE id=$1',
      [id, message ? 'failed' : 'ready', body, message],
    );
  }
  async saveProduct(
    draft: ListingDraft,
    expectedRevision: number,
    folderClaim?: {
      batchId: string;
      revision: number;
      groupKey: string;
      fingerprint: string;
    },
  ): Promise<ListingDraft> {
    if (draft.revision !== expectedRevision + 1) throw new Error('PRODUCT_REVISION_CONFLICT');
    return transaction(this.pool, async (c) => {
      await lockLocalSourceSelection(c);
      await assertDraftLocalSourcesActive(c, draft);
      if (folderClaim) await assertLocalResourcesActive(c, [{kind:'input_batch',resourceId:folderClaim.batchId}]);
      if (folderClaim) {
        const latestBatch = await c.query(
          'SELECT latest_revision FROM input_batches WHERE id=$1 FOR SHARE',
          [folderClaim.batchId],
        );
        if (latestBatch.rows[0]?.latest_revision !== folderClaim.revision)
          throw new Error('FOLDER_SOURCE_BINDING_STALE');
      }
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [draft.productKey]);
      const prior = await c.query(
        `SELECT p.latest_revision, r.body FROM products p
         JOIN product_revisions r ON r.product_key=p.product_key AND r.revision=p.latest_revision
         WHERE p.product_key=$1 FOR UPDATE OF p`,
        [draft.productKey],
      );
      const selectionFingerprint = () =>
        createHash('sha256')
          .update(canonicalJson(folderDraftSelection(draft)))
          .digest('hex');
      if (folderClaim) {
        if (
          expectedRevision !== 0 ||
          draft.folderSource?.productKey !== draft.productKey ||
          draft.folderSource.fingerprint !== folderClaim.fingerprint
        )
          throw new Error('FOLDER_SOURCE_BINDING_INVALID');
        const claim = (
          await c.query('SELECT * FROM folder_source_claims WHERE product_key=$1', [
            draft.productKey,
          ])
        ).rows[0];
        if (claim) {
          if (
            claim.source_fingerprint !== folderClaim.fingerprint ||
            claim.selection_fingerprint !== selectionFingerprint() ||
            !prior.rows[0] ||
            createHash('sha256')
              .update(canonicalJson(folderDraftSelection(prior.rows[0].body)))
              .digest('hex') !== claim.selection_fingerprint
          )
            throw new Error('FOLDER_SOURCE_CHANGED');
          return prior.rows[0].body as ListingDraft;
        }
        if (prior.rows[0]) throw new Error('FOLDER_SOURCE_IDENTITY_CONFLICT');
      } else if (expectedRevision === 0 && draft.folderSource)
        throw new Error('FOLDER_SOURCE_BINDING_REQUIRED');
      if ((prior.rows[0]?.latest_revision ?? 0) !== expectedRevision)
        throw new Error('PRODUCT_REVISION_CONFLICT');
      if (
        prior.rows[0]?.body.folderSource &&
        canonicalJson(prior.rows[0].body.folderSource) !== canonicalJson(draft.folderSource ?? null)
      )
        throw new Error('FOLDER_SOURCE_IDENTITY_CONFLICT');
      if (
        prior.rows[0] &&
        canonicalJson(preparedStructure(prior.rows[0].body)) !==
          canonicalJson(preparedStructure(draft))
      )
        throw new Error('PRODUCT_MEMBERSHIP_LOCKED');
      await c.query(
        'INSERT INTO products(product_key,latest_revision) VALUES($1,$2) ON CONFLICT(product_key) DO UPDATE SET latest_revision=$2,updated_at=now()',
        [draft.productKey, draft.revision],
      );
      await c.query('INSERT INTO product_revisions(product_key,revision,body) VALUES($1,$2,$3)', [
        draft.productKey,
        draft.revision,
        draft,
      ]);
      if (folderClaim)
        await c.query(
          'INSERT INTO folder_source_claims(product_key,source_fingerprint,selection_fingerprint,batch_id,batch_revision,group_key) VALUES($1,$2,$3,$4,$5,$6)',
          [
            draft.productKey,
            folderClaim.fingerprint,
            selectionFingerprint(),
            folderClaim.batchId,
            folderClaim.revision,
            folderClaim.groupKey,
          ],
        );
      return draft;
    });
  }
  async getProduct(key: string, revision?: number): Promise<ListingDraft | null> {
    const r = await this.pool.query(
      'SELECT r.body FROM product_revisions r JOIN products p USING(product_key) WHERE r.product_key=$1 AND r.revision=COALESCE($2,p.latest_revision)',
      [key, revision ?? null],
    );
    return r.rows[0]?.body ?? null;
  }
  async listProducts(lifecycle: LocalLifecycle = 'active'): Promise<ListingDraft[]> {
    const rows = (
      await this.pool.query(
        'SELECT r.body FROM products p JOIN product_revisions r ON r.product_key=p.product_key AND r.revision=p.latest_revision ORDER BY p.updated_at DESC',
      )
    ).rows.map((r) => r.body);
    return localArchiveList(this.pool, 'product', rows, r => r.productKey, lifecycle);
  }
  async savePlan(plan: ChangePlan) {
    if (planFingerprint(plan) !== plan.fingerprint) throw new Error('PLAN_CONFLICT');
    await this.pool.query(
      'INSERT INTO plan_revisions(plan_id,revision,product_key,source_revision,fingerprint,body) VALUES($1,$2,$3,$4,$5,$6)',
      [plan.id, plan.revision, plan.productKey, plan.sourceRevision, plan.fingerprint, plan],
    );
    return plan;
  }
  async getPlan(id: string, revision?: number): Promise<ChangePlan | null> {
    const r = await this.pool.query(
      'SELECT body FROM plan_revisions WHERE plan_id=$1 AND ($2::int IS NULL OR revision=$2) ORDER BY revision DESC LIMIT 1',
      [id, revision ?? null],
    );
    return r.rows[0]?.body ?? null;
  }
  async listPlans(): Promise<ChangePlan[]> {
    return (
      await this.pool.query('SELECT body FROM plan_revisions ORDER BY created_at DESC LIMIT 200')
    ).rows.map((r) => r.body);
  }
  async submitPlan(id: string, revision: number, fingerprint: string): Promise<{ jobId: string }> {
    return transaction(this.pool, async (c) => {
      const record = await c.query(
        'SELECT * FROM plan_revisions WHERE plan_id=$1 AND revision=$2 FOR UPDATE',
        [id, revision],
      );
      const plan: ChangePlan | undefined = record.rows[0]?.body;
      if (!plan || plan.fingerprint !== fingerprint || planFingerprint(plan) !== fingerprint)
        throw new Error('PLAN_CONFLICT');
      const existing = await c.query('SELECT id FROM jobs WHERE plan_id=$1 AND plan_revision=$2', [
        id,
        revision,
      ]);
      if (existing.rows[0]) return { jobId: existing.rows[0].id };
      if (plan.issues.some((i) => i.severity === 'block')) throw new Error('PLAN_BLOCKED');
      const current = await c.query(
        'SELECT latest_revision FROM products WHERE product_key=$1 FOR UPDATE',
        [plan.productKey],
      );
      if (current.rows[0]?.latest_revision !== plan.sourceRevision)
        throw new Error('SOURCE_REVISION_CHANGED');
      for (const command of plan.stocks) {
        const { environment, partnerId, shopId } = command.scope;
        const inserted = await c.query(
          'INSERT INTO stock_instructions(command_id,environment,partner_id,shop_id,sku,revision,quantity,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(command_id) DO NOTHING RETURNING command_id',
          [
            command.commandId,
            environment,
            partnerId,
            shopId,
            command.sku,
            command.revision,
            command.quantity,
            command,
          ],
        );
        if (!inserted.rowCount) {
          const old = await c.query('SELECT body FROM stock_instructions WHERE command_id=$1', [
            command.commandId,
          ]);
          if (canonicalJson(old.rows[0].body) !== canonicalJson(command))
            throw new Error('STOCK_COMMAND_CONFLICT');
        }
      }
      const jobId = randomUUID();
      await c.query('INSERT INTO jobs(id,plan_id,plan_revision,scope) VALUES($1,$2,$3,$4)', [
        jobId,
        id,
        revision,
        plan.scope,
      ]);
      await c.query("INSERT INTO outbox(job_id,topic,body) VALUES($1,'job.ready',$2)", [
        jobId,
        { jobId },
      ]);
      await this.event(
        c,
        jobId,
        'queued',
        'Đã lưu công việc. Chờ kiểm tra kết nối và điều kiện thực thi.',
      );
      return { jobId };
    });
  }
  private async event(c: PoolClient, id: string, state: string, message: string) {
    await c.query('INSERT INTO job_events(job_id,state,message) VALUES($1,$2,$3)', [
      id,
      state,
      message,
    ]);
  }
  async getJob(id: string): Promise<JobRecord | null> {
    const r = await this.pool.query('SELECT * FROM jobs WHERE id=$1', [id]);
    return r.rows[0] ? jobRow(r.rows[0]) : null;
  }
  async listJobs() {
    return (
      await this.pool.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200')
    ).rows.map(jobRow);
  }
  async jobEvents(id: string) {
    return (
      await this.pool.query(
        'SELECT id::text,state,message,created_at FROM job_events WHERE job_id=$1 ORDER BY id',
        [id],
      )
    ).rows;
  }
  async controlJob(id: string, action: 'pause' | 'resume' | 'cancel') {
    return transaction(this.pool, async (c) => {
      const r = await c.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
      if (!r.rows[0]) throw new Error('NOT_FOUND');
      const j = jobRow(r.rows[0]);
      if (['verified', 'failed', 'cancelled'].includes(j.state)) throw new Error('JOB_TERMINAL');
      if (action === 'resume' && ['unknown', 'running'].includes(j.state))
        throw new Error('RECONCILIATION_REQUIRED');
      const state =
        action === 'cancel' && j.state !== 'running' && j.state !== 'unknown'
          ? 'cancelled'
          : action === 'resume'
            ? 'queued'
            : j.state;
      const message =
        action === 'cancel'
          ? 'Đã yêu cầu hủy các bước chưa gửi.'
          : action === 'pause'
            ? 'Đã tạm dừng các bước chưa gửi.'
            : 'Chờ kiểm tra lại trước khi tiếp tục.';
      await c.query(
        'UPDATE jobs SET paused=$2,cancel_requested=$3,state=$4,message=$5,next_run_at=now(),updated_at=now() WHERE id=$1',
        [id, action === 'pause', action === 'cancel' || j.cancelRequested, state, message],
      );
      await this.event(c, id, state, message);
      return { id, state };
    });
  }
}
