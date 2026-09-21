import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type DraftField,
  type ListingDraft,
  type PreparedGateway,
} from '@shopee/domain';
import {
  BlobStore,
  Repository,
  WorkOrderRepository,
  listShopConnections,
} from '@shopee/persistence';
import { buildPreparedSources, type PreparedSourceRow } from './prepared-source.js';
import { PreparedExecutionService, preparedExecutionFingerprint } from './prepared-execution.js';

const fields = z.enum([
  'title',
  'description',
  'cover',
  'gallery',
  'variationImages',
  'price',
  'stock',
  'attributes',
  'logistics',
]);
const inputSchema = z
  .object({
    id: z.string().uuid(),
    inputBatchId: z.string().uuid(),
    inputBatchRevision: z.number().int().positive(),
    workbookImportId: z.string().uuid(),
    operation: z.enum(['create', 'update']),
    fieldMask: z.array(fields).max(9),
    folderKeys: z.array(z.string().min(1)).min(1).max(2000).optional(),
    selectedSkus: z.array(z.string().min(1)).max(2000).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.fieldMask).size !== v.fieldMask.length)
      c.addIssue({ code: 'custom', path: ['fieldMask'], message: 'Duplicate fields' });
    if (v.operation === 'update' && !v.fieldMask.length)
      c.addIssue({ code: 'custom', path: ['fieldMask'], message: 'Choose fields' });
  });
const idSchema = z.string().uuid();
// Coalesce concurrent retries before acquiring any database connection. Persistence and
// executor constraints still provide the durable identity across processes/restarts.
const submissionTails = new WeakMap<Repository['pool'], Map<string, Promise<unknown>>>();
function keyUuid(text: string) {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Public bulk intake is shared by the UI and acceptance. Execution requires an explicit adapter. */
export class PreparedBatchService {
  readonly execution?: PreparedExecutionService;
  constructor(
    readonly repo: Repository,
    readonly blobs: BlobStore,
    readonly gateway?: PreparedGateway,
  ) {
    if (gateway) this.execution = new PreparedExecutionService(repo, gateway);
  }
  async context() {
    return {
      mode: this.gateway?.mode ?? 'unavailable',
      shops: (await listShopConnections(this.repo.pool)).map((s) => ({
        id: s.id,
        name: s.name,
        shopId: s.scope.shopId,
      })),
      batches: await this.list(),
    };
  }
  async list() {
    const rows = (
      await this.repo.pool.query(
        'SELECT id FROM prepared_source_batches ORDER BY created_at DESC LIMIT 100',
      )
    ).rows;
    return Promise.all(rows.map((r) => this.get(r.id)));
  }
  async get(id: string): Promise<any> {
    const row = (
      await this.repo.pool.query('SELECT * FROM prepared_source_batches WHERE id=$1', [
        idSchema.parse(id),
      ])
    ).rows[0];
    if (!row) throw new Error('PREPARED_NOT_FOUND');
    const body = row.body;
    // A process may stop after the execution transaction commits but before the public
    // preparation flag is updated. The durable execution ID remains the same request ID.
    const executionExists =
      this.execution &&
      (body.executionPrepared ||
        (await this.repo.pool.query('SELECT id FROM prepared_execution_batches WHERE id=$1', [id]))
          .rowCount);
    const run = executionExists ? await this.execution!.get(id) : null;
    const jobs = run?.jobs ?? [];
    const entries = body.rows.map((r: PreparedSourceRow) => {
      const j = jobs.find((j: any) => j.entry.folderKey === r.folderKey);
      return {
        folderKey: r.folderKey,
        shopName: r.shopName,
        categoryId: r.categoryId,
        title: r.title,
        skuCount: r.skuCount,
        issues: [
          ...r.issues,
          ...(j?.state === 'blocked'
            ? [
                {
                  code: 'PREPARED_METADATA_BLOCKED',
                  message: j.message ?? j.result?.code ?? 'Điều kiện shop/ngành chưa đạt',
                  field: 'điều kiện đăng',
                },
              ]
            : []),
        ],
      };
    });
    const items = body.rows.map((r: PreparedSourceRow, index: number) => {
      const j = jobs.find((j: any) => j.entry.folderKey === r.folderKey);
      return {
        id: j?.id ?? `${id}:${index}`,
        folderKey: r.folderKey,
        shopName: r.shopName,
        state: j?.state ?? 'blocked',
        itemId: j?.itemId ?? null,
        message: j?.message ?? j?.result?.code ?? r.issues.map((i) => i.message).join('; '),
        check: j?.result ?? null,
        paused: j?.paused ?? false,
      };
    });
    const sourceBlocked = items.filter(
      (item: any) => !jobs.some((job) => job.id === item.id),
    ).length;
    const state =
      run?.state === 'verified' && sourceBlocked
        ? 'blocked'
        : (run?.state ?? (entries.some((r: any) => r.issues.length) ? 'blocked' : 'prepared'));
    return {
      id,
      fingerprint: body.fingerprint,
      operation: row.request.operation,
      mode: this.gateway?.mode ?? 'unavailable',
      state,
      createdAt: row.created_at.toISOString(),
      entries,
      items,
      issues: body.rows.flatMap((r: PreparedSourceRow) => r.issues),
      counts: { ...run?.counts, blocked: (run?.counts.blocked ?? 0) + sourceBlocked },
      sourceDigest: row.source_digest,
    };
  }
  async preview(raw: unknown) {
    const input = inputSchema.parse(raw),
      prior = (
        await this.repo.pool.query('SELECT * FROM prepared_source_batches WHERE id=$1', [input.id])
      ).rows[0];
    if (prior) {
      if (canonicalJson(prior.request) !== canonicalJson(input))
        throw new Error('PREPARED_INTENT_CONFLICT');
      await this.prepareStored(prior);
      return this.get(input.id);
    }
    const built = await buildPreparedSources(this.repo, this.blobs, input);
    const valid = built.rows.flatMap((r) => (r.entry ? [r.entry] : []));
    const semantic = {
      batchId: input.id,
      inputSourceDigest: built.sourceDigest,
      entries: valid,
      operation: input.operation,
      fieldMask: input.fieldMask,
      ...(input.selectedSkus !== undefined ? { selectedSkus: input.selectedSkus } : {}),
    };
    const fingerprint = preparedExecutionFingerprint(semantic);
    // Store the exact source first. No owner/source reservation may exist without a
    // public, recoverable source receipt, even if metadata or connection state changes.
    await this.repo.pool.query(
      'INSERT INTO prepared_source_batches(id,request,source_digest,body) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
      [
        input.id,
        input,
        built.sourceDigest,
        { rows: built.rows, fingerprint, executionPrepared: false },
      ],
    );
    const saved = (
      await this.repo.pool.query('SELECT * FROM prepared_source_batches WHERE id=$1', [input.id])
    ).rows[0];
    if (canonicalJson(saved.request) !== canonicalJson(input))
      throw new Error('PREPARED_INTENT_CONFLICT');
    await this.prepareStored(saved);
    return this.get(input.id);
  }
  private async prepareStored(row: any) {
    if (!this.execution) return;
    const entries = (row.body.rows as PreparedSourceRow[]).flatMap((source) =>
      source.entry ? [source.entry] : [],
    );
    if (!entries.length) return;
    await this.execution.prepare({
      batchId: row.id,
      inputSourceDigest: row.source_digest,
      entries,
      operation: row.request.operation,
      fieldMask: row.request.fieldMask,
      ...(row.request.selectedSkus !== undefined ? { selectedSkus: row.request.selectedSkus } : {}),
      fingerprint: row.body.fingerprint,
    });
    await this.repo.pool.query(
      `UPDATE prepared_source_batches SET body=jsonb_set(body,'{executionPrepared}','true'::jsonb) WHERE id=$1`,
      [row.id],
    );
  }
  async submit(id: string, raw: unknown) {
    idSchema.parse(id);
    let tails = submissionTails.get(this.repo.pool);
    if (!tails) {
      tails = new Map();
      submissionTails.set(this.repo.pool, tails);
    }
    const previous = tails.get(id) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(() => this.submitStored(id, raw));
    tails.set(id, running);
    try {
      return await running;
    } finally {
      if (tails.get(id) === running) tails.delete(id);
    }
  }
  private async submitStored(id: string, raw: unknown) {
    const { fingerprint } = z
      .object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(raw);
    if (!this.execution) throw new Error('PREPARED_EXECUTION_UNAVAILABLE');
    const row = (
      await this.repo.pool.query('SELECT * FROM prepared_source_batches WHERE id=$1', [
        idSchema.parse(id),
      ])
    ).rows[0];
    if (!row || row.body.fingerprint !== fingerprint) throw new Error('PREPARED_INTENT_CONFLICT');
    await this.prepareStored(row);
    if (!(row.body.rows as PreparedSourceRow[]).some((source) => source.entry))
      throw new Error('PREPARED_SOURCE_BLOCKED');
    const run = await this.execution.get(id);
    // A repeated submission returns the stored execution. It must not resurrect an old stock command.
    if (run.state !== 'prepared' && run.state !== 'blocked') return this.get(id);
    const current = await buildPreparedSources(this.repo, this.blobs, row.request);
    if (current.sourceDigest !== row.source_digest)
      throw new Error('PREPARED_INPUT_REVISION_CHANGED');
    // Each repository operation completes before the next acquires a pool connection.
    // Keeping an outer connection while these methods run can exhaust a small pool.
    const workOrders = new WorkOrderRepository(this.repo.pool);
    for (const source of row.body.rows as PreparedSourceRow[]) {
      if (!source.entry || !source.draft) continue;
      const job = run.jobs.find((j: any) => j.entry.folderKey === source.folderKey);
      if (!job || job.state !== 'prepared') continue;
      const draft = source.draft,
        entry = source.entry;
      let mapping = (
        await this.repo.pool.query(
          'SELECT source_revision FROM prepared_source_versions WHERE source_key=$1 AND source_fingerprint=$2',
          [draft.productKey, entry.sourceFingerprint],
        )
      ).rows[0];
      if (!mapping) {
        const old = await this.repo.getProduct(draft.productKey);
        const same =
          old &&
          canonicalJson({ ...old, revision: 0 }) === canonicalJson({ ...draft, revision: 0 });
        const revision = same ? old.revision : (old?.revision ?? 0) + 1;
        if (!same) await this.repo.saveProduct({ ...draft, revision }, old?.revision ?? 0);
        await this.repo.pool.query(
          'INSERT INTO prepared_source_versions(source_key,source_fingerprint,source_revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [draft.productKey, entry.sourceFingerprint, revision],
        );
        mapping = { source_revision: revision };
      }
      const workId = keyUuid(
        'prepared-work:' +
          entry.connectionId +
          ':' +
          draft.productKey +
          ':' +
          row.request.operation,
      );
      const old = await workOrders.get(workId);
      const fieldMask: DraftField[] = [
        ...new Set<DraftField>(
          (row.request.fieldMask as string[]).map((f) =>
            f === 'cover' ? 'gallery' : f === 'variationImages' ? 'variations' : (f as DraftField),
          ),
        ),
      ];
      await workOrders.save(workId, old?.revision ?? 0, {
        productKey: draft.productKey,
        sourceRevision: mapping.source_revision,
        connectionId: entry.connectionId,
        operation: row.request.operation,
        itemId: row.request.operation === 'update' ? job.itemId : null,
        fieldMask,
        stocks: Object.fromEntries(entry.document.models.map((m) => [m.sku, m.stock])),
      });
    }
    await this.execution.submit(id, fingerprint, async (c) => {
      // Source revision check and enqueue share one transaction/client.
      const pinned = (
        await c.query('SELECT latest_revision FROM input_batches WHERE id=$1 FOR SHARE', [
          row.request.inputBatchId,
        ])
      ).rows[0];
      if (pinned?.latest_revision !== row.request.inputBatchRevision)
        throw new Error('PREPARED_INPUT_REVISION_CHANGED');
    });
    return this.get(id);
  }
  async control(jobId: string, action: 'pause' | 'resume' | 'cancel') {
    if (!this.execution) throw new Error('PREPARED_EXECUTION_UNAVAILABLE');
    return this.execution.control(idSchema.parse(jobId), action);
  }
  async reconcile(jobId: string) {
    if (!this.execution) throw new Error('PREPARED_EXECUTION_UNAVAILABLE');
    return this.execution.reconcile(idSchema.parse(jobId));
  }
}
