import {
  canonicalJson,
  type WorkOrder,
  type WorkOrderConfig,
  type SandboxRun,
} from '@shopee/domain';
import { Pool, transaction } from './db.js';

function row(r: any): WorkOrder {
  return {
    id: r.id,
    revision: r.revision,
    config: r.config,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
export class WorkOrderRepository {
  constructor(readonly pool: Pool) {}
  async sandboxRun(config: WorkOrderConfig, workOrderId: string): Promise<SandboxRun | null> {
    if (!config.connectionId || !config.itemId || config.operation !== 'update') return null;
    const mask = JSON.stringify(config.fieldMask);
    const result = await this.pool.query(
      `SELECT * FROM sandbox_listing_runs WHERE connection_id=$1 AND item_id=$2 AND
        (state IN ('in_flight','unknown') OR
          (product_key=$3 AND source_revision=$4 AND body->'fieldMask' @> $5::jsonb AND body->'fieldMask' <@ $5::jsonb AND intent->'input'->>'workOrderId'=$6))
       ORDER BY CASE WHEN state IN ('in_flight','unknown') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 1`,
      [
        config.connectionId,
        config.itemId,
        config.productKey,
        config.sourceRevision,
        mask,
        workOrderId,
      ],
    );
    const run = result.rows[0];
    if (!run) return null;
    return {
      id: run.id,
      revision: run.revision,
      state: run.state,
      workOrderId: run.intent.input.workOrderId,
      workOrderRevision: run.intent.input.workOrderRevision,
      connectionId: run.connection_id,
      itemId: run.item_id,
      productKey: run.product_key,
      sourceRevision: run.source_revision,
      fieldMask: run.body.fieldMask,
      baseline: run.body.baseline,
      preview: run.body.preview,
      uploads: run.body.uploads,
      result: run.body.result,
      createdAt: run.created_at.toISOString(),
      updatedAt: run.updated_at.toISOString(),
    };
  }
  async get(id: string): Promise<WorkOrder | null> {
    const result = await this.pool.query(
      `SELECT w.id,r.revision,r.config,w.created_at,r.created_at AS updated_at
      FROM work_orders w JOIN work_order_revisions r ON r.order_id=w.id AND r.revision=w.latest_revision WHERE w.id=$1`,
      [id],
    );
    return result.rows[0] ? row(result.rows[0]) : null;
  }
  async list(): Promise<WorkOrder[]> {
    const result = await this.pool
      .query(`SELECT w.id,r.revision,r.config,w.created_at,r.created_at AS updated_at
      FROM work_orders w JOIN work_order_revisions r ON r.order_id=w.id AND r.revision=w.latest_revision ORDER BY w.updated_at DESC,w.id`);
    return result.rows.map(row);
  }
  async save(id: string, expectedRevision: number, config: WorkOrderConfig): Promise<WorkOrder> {
    const target = JSON.stringify(
      config.connectionId
        ? config.operation === 'update' && config.itemId
          ? ['item', config.connectionId, config.itemId]
          : ['source', config.connectionId, config.productKey, config.operation]
        : ['unassigned', config.productKey, config.operation, config.itemId],
    );
    try {
      return await transaction(this.pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'work-order:' + id,
        ]);
        const current = (
          await client.query(
            `SELECT w.*,r.config FROM work_orders w JOIN work_order_revisions r ON r.order_id=w.id AND r.revision=w.latest_revision WHERE w.id=$1 FOR UPDATE OF w`,
            [id],
          )
        ).rows[0];
        if ((current?.latest_revision ?? 0) !== expectedRevision) {
          const replay = (
            await client.query(
              'SELECT config FROM work_order_revisions WHERE order_id=$1 AND revision=$2',
              [id, expectedRevision + 1],
            )
          ).rows[0];
          if (replay && canonicalJson(replay.config) === canonicalJson(config)) {
            const record = (
              await client.query(
                'SELECT $1::uuid AS id,revision,config,created_at,created_at AS updated_at FROM work_order_revisions WHERE order_id=$1 AND revision=$2',
                [id, expectedRevision + 1],
              )
            ).rows[0];
            return row({ ...record, created_at: current.created_at });
          }
          throw new Error('WORK_ORDER_REVISION_CONFLICT');
        }
        if (current && current.config.productKey !== config.productKey)
          throw new Error('WORK_ORDER_SOURCE_IDENTITY');
        if (current && canonicalJson(current.config) === canonicalJson(config))
          return row({ ...current, revision: current.latest_revision });
        // Lock both targets in a stable order. A concurrent execute claim either wins first
        // and blocks this save, or sees the prepared-run revision invalidated below.
        const targets = [
          ...new Map(
            [current?.config, config]
              .filter(Boolean)
              .filter((value) => value.connectionId && value.itemId && value.operation === 'update')
              .map((value) => [JSON.stringify([value.connectionId, value.itemId]), value]),
          ).entries(),
        ].sort(([one], [two]) => (one < two ? -1 : one > two ? 1 : 0));
        const runs: any[] = [];
        for (const [, value] of targets) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            'sandbox-target:' + value.connectionId + ':' + value.itemId,
          ]);
          runs.push(
            ...(
              await client.query(
                "SELECT * FROM sandbox_listing_runs WHERE connection_id=$1 AND item_id=$2 AND state IN ('prepared','in_flight','unknown') ORDER BY id FOR UPDATE",
                [value.connectionId, value.itemId],
              )
            ).rows,
          );
        }
        if (runs.some((run) => ['in_flight', 'unknown'].includes(run.state)))
          throw new Error('WORK_ORDER_ACTIVE_RUN');
        const draft = (
          await client.query(
            'SELECT body FROM product_revisions WHERE product_key=$1 AND revision=$2',
            [config.productKey, config.sourceRevision],
          )
        ).rows[0]?.body;
        if (!draft) throw new Error('SOURCE_NOT_FOUND');
        if (
          config.connectionId &&
          !(await client.query('SELECT id FROM connections WHERE id=$1', [config.connectionId]))
            .rowCount
        )
          throw new Error('SOURCE_SHOP_NOT_FOUND');
        const skus = new Set(draft.variants.map((v: any) => v.sku.value));
        if (Object.keys(config.stocks).some((sku) => !skus.has(sku)))
          throw new Error('WORK_ORDER_STOCK_SOURCE');
        if (current)
          for (const run of runs) {
            const prior: WorkOrderConfig = current.config;
            if (
              run.state !== 'prepared' ||
              run.intent.input.workOrderId !== id ||
              run.intent.input.workOrderRevision !== current.latest_revision ||
              run.connection_id !== prior.connectionId ||
              run.item_id !== prior.itemId ||
              run.product_key !== prior.productKey ||
              run.source_revision !== prior.sourceRevision ||
              canonicalJson([...run.body.fieldMask].sort()) !==
                canonicalJson([...prior.fieldMask].sort())
            )
              continue;
            const body = {
              ...run.body,
              phase: 'done',
              result: {
                code: 'WORK_ORDER_CONFIG_CHANGED',
                message:
                  'Lựa chọn công việc đã thay đổi. Bản gửi cũ chưa được thực thi; cần đọc và đối chiếu lại theo lựa chọn mới.',
                requestIds: [],
              },
            };
            const invalidated = (
              await client.query(
                "UPDATE sandbox_listing_runs SET state='drift',revision=revision+1,body=$2,updated_at=now() WHERE id=$1 RETURNING revision",
                [run.id, body],
              )
            ).rows[0];
            await client.query(
              "INSERT INTO sandbox_listing_run_events(run_id,revision,state,code) VALUES($1,$2,'drift','WORK_ORDER_CONFIG_CHANGED')",
              [run.id, invalidated.revision],
            );
          }
        const revision = expectedRevision + 1;
        const saved = (
          await client.query(
            `INSERT INTO work_orders(id,latest_revision,target_key) VALUES($1,$2,$3)
          ON CONFLICT(id) DO UPDATE SET latest_revision=$2,target_key=$3,updated_at=now() RETURNING *`,
            [id, revision, target],
          )
        ).rows[0];
        const snapshot = (
          await client.query(
            `INSERT INTO work_order_revisions(order_id,revision,product_key,source_revision,connection_id,config)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at`,
            [id, revision, config.productKey, config.sourceRevision, config.connectionId, config],
          )
        ).rows[0];
        return row({
          id,
          revision,
          config,
          created_at: saved.created_at,
          updated_at: snapshot.created_at,
        });
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new Error('WORK_ORDER_TARGET_EXISTS');
      throw error;
    }
  }
}
