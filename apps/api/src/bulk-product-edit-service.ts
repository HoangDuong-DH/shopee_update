import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, type ListingDraft } from '@shopee/domain';
import { Repository, transaction, lockLocalSourceSelection, assertDraftLocalSourcesActive } from '@shopee/persistence';
import { bulkProductEditInput, previewBulkProductEdit, type BulkProductEditInput } from '../../../packages/domain/src/bulk-product-edit.js';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const applyInput = z.object({ input: bulkProductEditInput, expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type AuditedDraft = ListingDraft & { localBulkEdit?: { operationId: string; digest: string; previousRevision: number; recordedAt: string } };

export class BulkProductEditService {
  constructor(private readonly repo: Repository) {}

  private async collect(input: BulkProductEditInput, historical = false, repo = this.repo) {
    const results = [];
    for (const entry of input.entries) {
      const before = await repo.getProduct(entry.productKey, historical ? entry.expectedRevision : undefined);
      if (!before) { results.push({ entry, before: null, result: null }); continue; }
      results.push({ entry, before, result: previewBulkProductEdit(before, entry, input) });
    }
    return results;
  }
  private view(input: BulkProductEditInput, results: Awaited<ReturnType<BulkProductEditService['collect']>>) {
    const fingerprint = digest({ input, sources: results.map(row => row.before) });
    return { input, digest: fingerprint, localOnly: true as const,
      changedCount: results.filter(row => row.result?.changed && !row.result.issues.length).length,
      blockedCount: results.filter(row => !row.result || row.result.issues.length).length,
      entries: results.map(({ entry, before, result }) => ({ productKey: entry.productKey, title: before?.title.value ?? entry.productKey,
        expectedRevision: entry.expectedRevision, nextRevision: result?.after.revision ?? entry.expectedRevision,
        changed: result?.changed ?? false, beforeCount: before?.variants.length ?? 0, afterCount: result?.after.variants.length ?? 0,
        issues: result?.issues ?? [{ code: 'NOT_FOUND', message: 'Không tìm thấy bộ nguồn đã chọn.' }],
        warnings: result?.warnings ?? [], removed: result?.removed.map(variant => ({ key: variant.key, sku: variant.sku.value, labels: variant.optionLabels })) ?? [],
        models: result?.models ?? [],
      })),
    };
  }
  async preview(raw: unknown) {
    const input = bulkProductEditInput.parse(raw);
    return this.view(input, await this.collect(input));
  }
  async apply(raw: unknown) {
    const { input, expectedDigest } = applyInput.parse(raw);
    return transaction(this.repo.pool, async client => {
      await lockLocalSourceSelection(client);
      for (const key of input.entries.map(entry => entry.productKey).sort())
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const scopedRepo = new Repository(client as unknown as Repository['pool']);
      const results = await this.collect(input, true, scopedRepo), preview = this.view(input, results);
      if (preview.digest !== expectedDigest) throw Error('BULK_EDIT_PREVIEW_CHANGED');
      if (preview.blockedCount) throw Error('BULK_EDIT_BLOCKED');
      let alreadyApplied = 0;
      for (const row of results) {
        const current = await scopedRepo.getProduct(row.entry.productKey) as AuditedDraft | null;
        if (!current) throw Error('PRODUCT_REVISION_CONFLICT');
        await assertDraftLocalSourcesActive(client, current);
        if (current.revision === row.entry.expectedRevision) {
          if (canonicalJson(current) !== canonicalJson(row.before)) throw Error('BULK_EDIT_PREVIEW_CHANGED');
          continue;
        }
        if (row.result!.changed && current.revision === row.entry.expectedRevision + 1
          && current.localBulkEdit?.operationId === input.operationId && current.localBulkEdit.digest === expectedDigest) {
          alreadyApplied++; continue;
        }
        throw Error('PRODUCT_REVISION_CONFLICT');
      }
      if (alreadyApplied && alreadyApplied !== preview.changedCount) throw Error('BULK_EDIT_PARTIAL_STATE');
      if (alreadyApplied) return { ...preview, applied: true as const, recovered: true };
      for (const row of results) {
        if (!row.result!.changed) continue;
        const after: AuditedDraft = { ...row.result!.after, localBulkEdit: { operationId: input.operationId,
          digest: expectedDigest, previousRevision: row.entry.expectedRevision, recordedAt: new Date().toISOString() } };
        const updated = await client.query('UPDATE products SET latest_revision=$2,updated_at=now() WHERE product_key=$1 AND latest_revision=$3',
          [after.productKey, after.revision, row.entry.expectedRevision]);
        if (updated.rowCount !== 1) throw Error('PRODUCT_REVISION_CONFLICT');
        await client.query('INSERT INTO product_revisions(product_key,revision,body) VALUES($1,$2,$3)', [after.productKey, after.revision, after]);
      }
      return { ...preview, applied: true as const, recovered: false };
    });
  }
}
