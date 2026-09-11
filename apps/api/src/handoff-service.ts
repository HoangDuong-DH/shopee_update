import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalJson,
  handoffDocumentSchema,
  handoffChanges,
  handoffMembership,
  draftMembership,
  type HandoffDocument,
  type HandoffPreview,
  type HandoffRequest,
  type ListingDraft,
  type WorkbookImport,
  type InputBatchState,
} from '@shopee/domain';
import { Repository, transaction, type ImportRecord, type Pool } from '@shopee/persistence';
import type { PoolClient } from 'pg';
import { assembleProduct, productInput } from './product-service.js';

export const handoffRequestSchema = z
  .object({
    document: handoffDocumentSchema,
    mode: z.enum(['create_new', 'update_source']),
    productKey: z.string().min(1).max(200).optional(),
    expectedRevision: z.number().int().min(0).max(2147483646).optional(),
  })
  .strict();
const applySchema = handoffRequestSchema.extend({
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = (code: string): never => {
  throw new Error(code);
};
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export class HandoffService {
  constructor(readonly repo: Repository) {}

  async exportProduct(productKey: string): Promise<HandoffDocument> {
    const product = await this.repo.getProduct(productKey);
    if (!product) return fail('NOT_FOUND');
    const selection = product.sourceSelection;
    if (!selection) return fail('HANDOFF_SELECTION_MISSING');
    const ids = [
      ...new Set([
        ...(selection.coverId ? [selection.coverId] : []),
        ...selection.galleryIds,
        ...selection.descriptionImageIds,
        ...selection.variants.map((variant) => variant.importId),
        ...selection.variants.flatMap((variant) => (variant.imageId ? [variant.imageId] : [])),
      ]),
    ];
    const records = new Map<string, ImportRecord>();
    for (const id of ids) {
      const record = await this.repo.getImport(id);
      if (!record || record.status !== 'ready') return fail('HANDOFF_SOURCE_MISMATCH');
      records.set(id, record);
    }
    const variants = selection.variants.map((variant, index) => {
      const record = records.get(variant.importId)!;
      const rows =
        (record.body as WorkbookImport).rows?.filter((row) => row.key === variant.rowKey) ?? [];
      if (rows.length !== 1 || !rows[0].originalPrice) return fail('HANDOFF_PRICE_MISMATCH');
      const row = rows[0];
      if (
        product.variants[index]?.sku.value !== row.sku.value ||
        product.variants[index]?.originalPrice.value !== row.originalPrice!.value
      )
        return fail('HANDOFF_PRICE_MISMATCH');
      return {
        price: {
          importId: variant.importId,
          rowKey: row.key,
          sheet: row.sheet,
          priceProfile: row.priceProfile ?? null,
          sku: row.sku.value,
          originalPrice: row.originalPrice!.value,
          promotionTarget: row.promotionTarget?.value ?? null,
        },
        optionLabels: [...variant.optionLabels],
        ...(variant.imageId ? { imageId: variant.imageId } : {}),
      };
    });
    return handoffDocumentSchema.parse({
      format: 'shopee-listing-handoff',
      version: 1,
      product: { productKey: product.productKey, sourceRevision: product.revision },
      scope: { kind: 'saved_product', productKey: product.productKey, revision: product.revision },
      sources: [...records.values()].map((record) => ({
        importId: record.id,
        sha256: record.sha256,
        kind: record.kind,
        filename: record.filename,
      })),
      content: {
        origin: { kind: 'user_selection', sourceImportIds: [] },
        title: selection.title,
        headline: selection.headline,
        body: selection.body,
      },
      media: {
        ...(selection.coverId ? { coverId: selection.coverId } : {}),
        galleryIds: [...selection.galleryIds],
        descriptionImageIds: [...selection.descriptionImageIds],
      },
      tierNames: [...selection.tierNames],
      variants,
      confirmed: { content: true, imageRoles: true, membership: true },
    });
  }

  private async sourceScope(
    document: HandoffDocument,
    query: Queryable,
  ): Promise<{ ids: Set<string>; batchProductKey?: string }> {
    if (document.scope.kind === 'saved_product') {
      const scope = document.scope;
      const result = await query.query(
        'SELECT body FROM product_revisions WHERE product_key=$1 AND revision=$2',
        [scope.productKey, scope.revision],
      );
      const saved: ListingDraft | undefined = result.rows[0]?.body;
      if (!saved?.sourceSelection) return fail('HANDOFF_SCOPE_MISMATCH');
      return {
        ids: new Set([
          ...saved.assets.map((asset) => asset.key),
          ...saved.sourceSelection.variants.map((variant) => variant.importId),
        ]),
      };
    }
    const scope = document.scope;
    const result = await query.query(
      'SELECT state FROM input_batch_revisions WHERE batch_id=$1 AND revision=$2',
      [scope.batchId, scope.batchRevision],
    );
    const state: InputBatchState | undefined = result.rows[0]?.state;
    if (!state?.productKeys[scope.groupKey] || !state.priceSelection)
      return fail('HANDOFF_SCOPE_MISMATCH');
    const depth = state.mode === 'single_listing' ? 1 : 2;
    const ids = new Set(
      state.files
        .filter((file) => file.relativePath.split('/').slice(0, depth).join('/') === scope.groupKey)
        .flatMap((file) => (file.importId ? [file.importId] : [])),
    );
    ids.add(state.priceSelection.importId);
    if (
      document.variants.some(
        (variant) =>
          variant.price.importId !== state.priceSelection!.importId ||
          variant.price.sheet !== state.priceSelection!.sheet ||
          variant.price.priceProfile !== state.priceSelection!.priceProfile,
      )
    )
      return fail('HANDOFF_PRICE_MISMATCH');
    return { ids, batchProductKey: state.productKeys[scope.groupKey] };
  }

  private async prepare(
    input: HandoffRequest,
    query: Queryable,
    repo: Repository,
  ): Promise<HandoffPreview> {
    const { document, mode } = input;
    const productKey = input.productKey ?? document.product.productKey;
    const expectedRevision = input.expectedRevision ?? (mode === 'create_new' ? 0 : -1);
    if (
      !productKey.trim() ||
      (mode === 'update_source' && expectedRevision < 1) ||
      (mode === 'create_new' && expectedRevision !== 0)
    )
      return fail('HANDOFF_TARGET_REQUIRED');
    const existing = await repo.getProduct(productKey);
    if ((existing?.revision ?? 0) !== expectedRevision) return fail('PRODUCT_REVISION_CONFLICT');
    if (
      existing &&
      canonicalJson(draftMembership(existing)) !== canonicalJson(handoffMembership(document))
    )
      return fail('PRODUCT_MEMBERSHIP_LOCKED');
    const scope = await this.sourceScope(document, query);
    if (scope.batchProductKey && scope.batchProductKey !== productKey)
      return fail('HANDOFF_SCOPE_MISMATCH');
    const records = new Map<string, ImportRecord>();
    for (const source of document.sources) {
      if (!scope.ids.has(source.importId)) return fail('HANDOFF_SCOPE_MISMATCH');
      const record = await repo.getImport(source.importId);
      if (
        !record ||
        record.status !== 'ready' ||
        record.sha256 !== source.sha256 ||
        record.kind !== source.kind
      )
        return fail('HANDOFF_SOURCE_MISMATCH');
      records.set(record.id, record);
    }
    for (const variant of document.variants) {
      const price = variant.price;
      const workbook = records.get(price.importId)?.body as WorkbookImport | undefined;
      // assembleProduct resolves by rowKey, so that key must be unique in the entire workbook.
      const rows = workbook?.rows?.filter((row) => row.key === price.rowKey) ?? [];
      if (
        rows.length !== 1 ||
        rows[0].sheet !== price.sheet ||
        (rows[0].priceProfile ?? null) !== price.priceProfile ||
        rows[0].sku.value !== price.sku ||
        rows[0].originalPrice?.value !== price.originalPrice ||
        (rows[0].promotionTarget?.value ?? null) !== price.promotionTarget
      )
        return fail('HANDOFF_PRICE_MISMATCH');
    }
    const assembled = await assembleProduct(
      repo,
      productInput.parse({
        productKey,
        expectedRevision,
        title: document.content.title,
        headline: document.content.headline,
        body: document.content.body,
        ...document.media,
        tierNames: document.tierNames,
        variants: document.variants.map((variant) => ({
          importId: variant.price.importId,
          rowKey: variant.price.rowKey,
          optionLabels: variant.optionLabels,
          ...(variant.imageId ? { imageId: variant.imageId } : {}),
        })),
      }),
    );
    // A source revision does not reset existing category, shop settings or other product facts.
    const draft = existing
      ? {
          ...existing,
          ...assembled,
          attributes: existing.attributes,
          logistics: existing.logistics,
        }
      : assembled;
    const changes = handoffChanges(existing, draft);
    const issues = [...draft.issues];
    if (!changes.length)
      issues.push({
        code: 'HANDOFF_NO_CHANGES',
        field: 'source',
        severity: 'warn',
        message: 'Bộ đã lưu có đúng nội dung, ảnh và giá này; không cần tạo phiên bản mới.',
        sources: [],
      });
    const previewFingerprint = digest({ document, mode, productKey, expectedRevision, changes });
    return {
      document,
      mode,
      productKey,
      expectedRevision,
      previewFingerprint,
      draft,
      changes,
      issues,
      canApply: changes.length > 0 && !issues.some((issue) => issue.severity === 'block'),
    };
  }

  preview(raw: unknown) {
    return this.prepare(handoffRequestSchema.parse(raw), this.repo.pool, this.repo);
  }

  async apply(raw: unknown): Promise<{ product: ListingDraft; replayed: boolean }> {
    const { previewFingerprint, ...input } = applySchema.parse(raw);
    const productKey = input.productKey ?? input.document.product.productKey;
    return transaction(this.repo.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [productKey]);
      const receipt = await client.query(
        'SELECT product_key,revision FROM handoff_receipts WHERE preview_fingerprint=$1',
        [previewFingerprint],
      );
      if (receipt.rows[0]) {
        // A replay must still describe the exact action represented by this receipt.
        const saved = await client.query(
          'SELECT body FROM product_revisions WHERE product_key=$1 AND revision=$2',
          [receipt.rows[0].product_key, receipt.rows[0].revision],
        );
        const before = input.expectedRevision
          ? await client.query(
              'SELECT body FROM product_revisions WHERE product_key=$1 AND revision=$2',
              [productKey, input.expectedRevision],
            )
          : null;
        const product: ListingDraft = saved.rows[0]?.body;
        if (
          !product ||
          product.productKey !== productKey ||
          product.revision !== (input.expectedRevision ?? 0) + 1 ||
          digest({
            document: input.document,
            mode: input.mode,
            productKey,
            expectedRevision: input.expectedRevision ?? 0,
            changes: handoffChanges(before?.rows[0]?.body ?? null, product),
          }) !== previewFingerprint
        )
          return fail('HANDOFF_PREVIEW_CHANGED');
        return { product, replayed: true };
      }
      // Only read/assemble through this client; save and receipt commit in the same transaction.
      const scopedRepo = new Repository(client as unknown as Pool);
      const preview = await this.prepare(input, client, scopedRepo);
      if (preview.previewFingerprint !== previewFingerprint) return fail('HANDOFF_PREVIEW_CHANGED');
      if (!preview.canApply) return fail('HANDOFF_BLOCKED');
      const product = preview.draft;
      await client.query(
        'INSERT INTO products(product_key,latest_revision) VALUES($1,$2) ON CONFLICT(product_key) DO UPDATE SET latest_revision=$2,updated_at=now()',
        [product.productKey, product.revision],
      );
      await client.query(
        'INSERT INTO product_revisions(product_key,revision,body) VALUES($1,$2,$3)',
        [product.productKey, product.revision, product],
      );
      await client.query(
        'INSERT INTO handoff_receipts(preview_fingerprint,product_key,revision) VALUES($1,$2,$3)',
        [previewFingerprint, product.productKey, product.revision],
      );
      return { product, replayed: false };
    });
  }
}
