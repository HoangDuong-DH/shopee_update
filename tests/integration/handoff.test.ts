import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Pool,
  Repository,
  InputLibraryRepository,
  migrate,
} from '../../packages/persistence/src/index.js';
import type { HandoffDocument, WorkbookImport } from '../../packages/domain/src/index.js';
import { HandoffService } from '../../apps/api/src/handoff-service.js';
import { createHandoffFixture } from '../fixtures/handoff-factory.js';

const schema = 'test_handoff_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool),
  service = new HandoffService(repo),
  library = new InputLibraryRepository(pool);
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
async function seed(fixture = createHandoffFixture(2)) {
  for (const record of fixture.records)
    await pool.query(
      'INSERT INTO source_files(id,sha256,filename,kind,bytes,status,body) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        record.id,
        record.sha256,
        record.filename,
        record.kind,
        record.bytes,
        record.status,
        record.body,
      ],
    );
  await library.save(fixture.batchId, 0, fixture.batchState);
  return fixture;
}
const createRequest = (document: HandoffDocument) => ({
  document,
  mode: 'create_new' as const,
  productKey: document.product.productKey,
  expectedRevision: 0,
});
async function receive(document: HandoffDocument) {
  const input = createRequest(document),
    preview = await service.preview(input);
  const result = await service.apply({ ...input, previewFingerprint: preview.previewFingerprint });
  return { ...result, preview, input };
}

describe('handoff service with isolated source fixtures', () => {
  it.each([0, 1, 2] as const)(
    'receives and exports a %i-tier prepared bundle without reentry or Shopee requests',
    async (tiers) => {
      const fixture = await seed(createHandoffFixture(tiers));
      const transport = vi.spyOn(globalThis, 'fetch');
      try {
        const { product, preview } = await receive(fixture.document);
        expect(preview.canApply).toBe(true);
        expect(product.sourceSelection?.body).toBe(fixture.document.content.body);
        expect(product.variants.map((variant) => variant.optionLabels)).toEqual(
          fixture.document.variants.map((variant) => variant.optionLabels),
        );
        expect(product.variants.map((variant) => variant.originalPrice.value)).toEqual(
          fixture.document.variants.map((variant) => variant.price.originalPrice),
        );
        const exported = await service.exportProduct(product.productKey);
        expect(exported.content).toEqual({
          ...fixture.document.content,
          origin: { kind: 'user_selection', sourceImportIds: [] },
        });
        expect(exported.media).toEqual(fixture.document.media);
        expect(exported.variants).toEqual(fixture.document.variants);
        expect(exported.scope).toEqual({
          kind: 'saved_product',
          productKey: product.productKey,
          revision: 1,
        });
        expect(transport).not.toHaveBeenCalled();
      } finally {
        transport.mockRestore();
      }
    },
  );

  it('applies an explicit source revision once, preserves shop-related fields and returns the same result after a lost response', async () => {
    const fixture = await seed(),
      initial = await receive(fixture.document);
    const configured = {
      ...initial.product,
      revision: 2,
      attributes: { material: { value: 'Giấy', confirmed: true, sources: [] } },
      logistics: { chosen: { value: 'shop-specific', confirmed: true, sources: [] } },
    };
    await repo.saveProduct(configured, 1);
    const document = await service.exportProduct(fixture.productKey);
    document.content.body = 'Bản nguồn mới\n\n Giữ  nguyên dòng  \n';
    document.media.descriptionImageIds = [fixture.variantImage.id, fixture.gallery.id];
    const request = {
      document,
      mode: 'update_source' as const,
      productKey: fixture.productKey,
      expectedRevision: 2,
    };
    const preview = await service.preview(request);
    expect(preview.changes.map((change) => change.field)).toEqual(['Nội dung', 'Ảnh mô tả']);
    const [one, two] = await Promise.all([
      service.apply({ ...request, previewFingerprint: preview.previewFingerprint }),
      service.apply({ ...request, previewFingerprint: preview.previewFingerprint }),
    ]);
    expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
    expect(one.product).toEqual(two.product);
    expect(one.product.revision).toBe(3);
    expect(one.product.productKey).toBe(fixture.productKey);
    expect(one.product.sourceSelection?.body).toBe(document.content.body);
    expect(one.product.attributes).toEqual(configured.attributes);
    expect(one.product.logistics).toEqual(configured.logistics);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM product_revisions WHERE product_key=$1', [
          fixture.productKey,
        ])
      ).rows[0].n,
    ).toBe(3);
  });

  it('rejects changed content after preview and leaves no product or replay receipt', async () => {
    const fixture = await seed(),
      request = createRequest(fixture.document),
      preview = await service.preview(request);
    const changed = structuredClone(request);
    changed.document.content.title += ' edited';
    await expect(
      service.apply({ ...changed, previewFingerprint: preview.previewFingerprint }),
    ).rejects.toThrow('HANDOFF_PREVIEW_CHANGED');
    expect(await repo.getProduct(fixture.productKey)).toBeNull();
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM handoff_receipts WHERE preview_fingerprint=$1',
          [preview.previewFingerprint],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('rejects membership order, label or SKU changes and stale source revision targets', async () => {
    const fixture = await seed(),
      first = await receive(fixture.document);
    const exported = await service.exportProduct(fixture.productKey);
    const reordered = structuredClone(exported);
    reordered.variants.reverse();
    await expect(
      service.preview({
        document: reordered,
        mode: 'update_source',
        productKey: fixture.productKey,
        expectedRevision: 1,
      }),
    ).rejects.toThrow('PRODUCT_MEMBERSHIP_LOCKED');
    const renamed = structuredClone(exported);
    renamed.variants[0].optionLabels[0] = 'Trắng';
    await expect(
      service.preview({
        document: renamed,
        mode: 'update_source',
        productKey: fixture.productKey,
        expectedRevision: 1,
      }),
    ).rejects.toThrow('PRODUCT_MEMBERSHIP_LOCKED');
    await expect(
      service.preview({
        document: exported,
        mode: 'update_source',
        productKey: fixture.productKey,
        expectedRevision: 0,
      }),
    ).rejects.toThrow('HANDOFF_TARGET_REQUIRED');
    await expect(service.preview(createRequest(exported))).rejects.toThrow(
      'PRODUCT_REVISION_CONFLICT',
    );
    expect((await repo.getProduct(fixture.productKey))?.revision).toBe(first.product.revision);
  });

  it('rejects a foreign image even if its ID, hash and declared source entry are valid', async () => {
    const one = await seed(createHandoffFixture(1, 'Listing Một')),
      other = await seed(createHandoffFixture(0, 'Listing Hai'));
    const document = structuredClone(one.document);
    document.media.galleryIds = [other.gallery.id];
    document.sources.push({
      importId: other.gallery.id,
      sha256: other.gallery.sha256,
      kind: 'image',
      filename: other.gallery.filename,
    });
    await expect(service.preview(createRequest(document))).rejects.toThrow(
      'HANDOFF_SCOPE_MISMATCH',
    );
  });

  it('rejects missing bytes, wrong SHA, mismatched price tuple and ambiguous source row', async () => {
    const fixture = await seed();
    const hash = structuredClone(fixture.document);
    hash.sources[0].sha256 = 'a'.repeat(64);
    await expect(service.preview(createRequest(hash))).rejects.toThrow('HANDOFF_SOURCE_MISMATCH');
    const wrongPrice = structuredClone(fixture.document);
    wrongPrice.variants[0].price.originalPrice = '1';
    await expect(service.preview(createRequest(wrongPrice))).rejects.toThrow(
      'HANDOFF_PRICE_MISMATCH',
    );
    const wrongSheet = structuredClone(fixture.document);
    wrongSheet.variants[0].price.sheet = 'Bộ giá khác';
    await expect(service.preview(createRequest(wrongSheet))).rejects.toThrow(
      'HANDOFF_PRICE_MISMATCH',
    );
    const workbook = structuredClone(fixture.price.body) as WorkbookImport;
    workbook.rows.push(structuredClone(workbook.rows[0]));
    await repo.finishImport(fixture.price.id, workbook);
    await expect(service.preview(createRequest(fixture.document))).rejects.toThrow(
      'HANDOFF_PRICE_MISMATCH',
    );
    workbook.rows[workbook.rows.length - 1].sheet = 'Trang tính khác';
    workbook.rows[workbook.rows.length - 1].priceProfile = 'Bộ giá khác';
    await repo.finishImport(fixture.price.id, workbook);
    await expect(service.preview(createRequest(fixture.document))).rejects.toThrow(
      'HANDOFF_PRICE_MISMATCH',
    );
  });

  it('reports missing source content fields as blocking preview issues and recognizes unchanged exports', async () => {
    const fixture = await seed();
    const incomplete = structuredClone(fixture.document);
    incomplete.content.title = '';
    delete incomplete.media.coverId;
    const blocked = await service.preview(createRequest(incomplete));
    expect(blocked.canApply).toBe(false);
    expect(blocked.issues.map((issue) => issue.code)).toContain('MISSING_TITLE');
    await expect(
      service.apply({
        ...createRequest(incomplete),
        previewFingerprint: blocked.previewFingerprint,
      }),
    ).rejects.toThrow('HANDOFF_BLOCKED');
    await receive(fixture.document);
    const document = await service.exportProduct(fixture.productKey);
    const unchanged = await service.preview({
      document,
      mode: 'update_source',
      productKey: fixture.productKey,
      expectedRevision: 1,
    });
    expect(unchanged.changes).toEqual([]);
    expect(unchanged.canApply).toBe(false);
  });
});
