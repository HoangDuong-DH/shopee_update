import type { PatchReceipt } from '@shopee/domain';
import { Pool, transaction } from './db.js';
export class ImportPatchRepository {
  constructor(readonly pool: Pool) {}
  async get(id: string): Promise<PatchReceipt | null> {
    return (
      (
        await this.pool.query(
          'SELECT body FROM import_patch_receipts WHERE id=COALESCE((SELECT receipt_id FROM import_patch_save_requests WHERE id=$1),$1::uuid)',
          [id],
        )
      ).rows[0]?.body ?? null
    );
  }
  async list(): Promise<PatchReceipt[]> {
    return (
      await this.pool.query(
        'SELECT body FROM import_patch_receipts ORDER BY created_at DESC,id LIMIT 100',
      )
    ).rows.map((row) => row.body);
  }
  async replay(id: string, requestFingerprint: string): Promise<PatchReceipt | null> {
    const row = (
      await this.pool.query(
        'SELECT s.request_fingerprint,r.body FROM import_patch_save_requests s JOIN import_patch_receipts r ON r.id=s.receipt_id WHERE s.id=$1',
        [id],
      )
    ).rows[0];
    if (!row) return null;
    if (row.request_fingerprint !== requestFingerprint) throw new Error('PATCH_SAVE_CONFLICT');
    return row.body;
  }
  async save(
    id: string,
    requestFingerprint: string,
    semanticFingerprint: string,
    receipt: PatchReceipt,
  ): Promise<{ receipt: PatchReceipt; reused: boolean }> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'patch-save:' + id,
      ]);
      const prior = (
        await client.query(
          'SELECT s.request_fingerprint,r.body FROM import_patch_save_requests s JOIN import_patch_receipts r ON r.id=s.receipt_id WHERE s.id=$1',
          [id],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_fingerprint !== requestFingerprint)
          throw new Error('PATCH_SAVE_CONFLICT');
        return { receipt: prior.body, reused: true };
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'patch-semantic:' + semanticFingerprint,
      ]);
      // A local prepared-work receipt never changes the source or the active sandbox target lock.
      for (const target of [...receipt.preview.targets].sort((a, b) =>
        a.workOrderId.localeCompare(b.workOrderId),
      )) {
        const record = (
          await client.query(
            `SELECT w.latest_revision,r.config,p.latest_revision AS source_revision,c.revision AS connection_revision
          FROM work_orders w JOIN work_order_revisions r ON r.order_id=w.id AND r.revision=w.latest_revision
          JOIN products p ON p.product_key=r.product_key JOIN connections c ON c.id=r.connection_id
          WHERE w.id=$1 FOR SHARE OF w,p,c`,
            [target.workOrderId],
          )
        ).rows[0];
        if (
          !record ||
          record.latest_revision !== target.workOrderRevision ||
          record.source_revision !== target.sourceRevision ||
          record.connection_revision !== target.connectionRevision ||
          record.config.connectionId !== target.connectionId ||
          record.config.itemId !== target.itemId ||
          record.config.productKey !== target.productKey ||
          record.config.sourceRevision !== target.sourceRevision ||
          record.config.operation !== 'update'
        )
          throw new Error('PATCH_TARGET_CHANGED');
      }
      const duplicate = (
        await client.query(
          'SELECT id,body FROM import_patch_receipts WHERE semantic_fingerprint=$1',
          [semanticFingerprint],
        )
      ).rows[0];
      if (!duplicate) {
        await client.query(
          'INSERT INTO import_patch_receipts(id,name,semantic_fingerprint,body,created_at) VALUES($1,$2,$3,$4,$5)',
          [id, receipt.name, semanticFingerprint, receipt, receipt.createdAt],
        );
        for (const target of receipt.preview.targets)
          await client.query(
            'INSERT INTO import_patch_targets(receipt_id,work_order_id,work_order_revision) VALUES($1,$2,$3)',
            [id, target.workOrderId, target.workOrderRevision],
          );
      }
      await client.query(
        'INSERT INTO import_patch_save_requests(id,request_fingerprint,receipt_id) VALUES($1,$2,$3)',
        [id, requestFingerprint, duplicate?.id ?? id],
      );
      return { receipt: duplicate?.body ?? receipt, reused: !!duplicate };
    });
  }
}
