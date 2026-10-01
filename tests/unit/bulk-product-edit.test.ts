import { describe, expect, it, vi } from 'vitest';
import type { ListingDraft } from '../../packages/domain/src/contracts.js';
import { bulkProductEditInput, explicitVolumesMl, previewBulkProductEdit } from '../../packages/domain/src/bulk-product-edit.js';
import { Repository } from '../../packages/persistence/src/repository.js';
import { BulkProductEditService } from '../../apps/api/src/bulk-product-edit-service.js';

const operationId = '33333333-3333-4333-8333-333333333333';
const source = { kind: 'product_file' as const, fileSha256: 'a'.repeat(64), locator: 'GIÁ MALL!O10', observedAt: '2026-09-23T00:00:00Z', filename: 'DORIS.xlsx' };
const fact = (value: string) => ({ value, confirmed: true, sources: [source] });
function draft(key = 'one', labels = [['100ml'], ['280ml'], ['500ml + 10ml'], ['500ml']]): ListingDraft {
  const variants = labels.map((optionLabels, index) => ({ key: `row${index}`, sku: fact(`REAL-SKU-${index}`), originalPrice: fact(String(10000 + index)), optionLabels, imageKey: `image${index}` }));
  return { productKey: key, revision: 1, title: fact('Tinh dầu thật ' + key), description: [{ type: 'text', text: 'Nội dung nguồn' }],
    coverKey: 'cover', galleryKeys: ['cover'], tierNames: labels[0]!.length === 2 ? ['Mùi', 'Dung tích'] : ['Dung tích'], variants,
    assets: ['cover', ...variants.map(variant => variant.imageKey)].map(assetKey => ({ key: assetKey, sha256: 'b'.repeat(64), mime: 'image/jpeg', bytes: 100, width: 100, height: 100, source })),
    attributes: {}, logistics: {}, issues: [],
    sourceSelection: { title: 'Tinh dầu thật ' + key, headline: 'Mở đầu', body: 'Nội dung', coverId: 'cover', galleryIds: ['cover'], descriptionImageIds: [],
      tierNames: labels[0]!.length === 2 ? ['Mùi', 'Dung tích'] : ['Dung tích'],
      variants: variants.map(variant => ({ importId: 'price-file', rowKey: variant.key, optionLabels: variant.optionLabels, imageId: variant.imageKey })) },
  };
}
function input(keys = ['one']) {
  return bulkProductEditInput.parse({ operationId, entries: keys.map(productKey => ({ productKey, expectedRevision: 1 })), removeVolumesMl: [280], sortVolumeDescending: true });
}

describe('bulk variant transformation', () => {
  it('uses explicit ml/l quantities, never SKU digits or words without units', () => {
    expect(explicitVolumesMl(['Chai 0,5 lít + 10ml'])).toEqual([500, 10]);
    expect(explicitVolumesMl(['SKU5000', 'Combo 2 chai'])).toEqual([]);
  });
  it('removes exact 280ml and sorts 500,500combo,100 while preserving provenance and matching source rows', () => {
    const before = draft(), original = structuredClone(before), request = input();
    const result = previewBulkProductEdit(before, request.entries[0]!, request);
    expect(result.issues).toEqual([]);
    expect(result.models.map(model => model.key)).toEqual(['row3', 'row2', 'row0']);
    expect(result.models.map(model => model.tierIndex)).toEqual([[0], [1], [2]]);
    expect(result.after.sourceSelection!.variants.map(variant => variant.rowKey)).toEqual(['row3', 'row2', 'row0']);
    expect(result.after.variants[0]).toEqual(before.variants[3]);
    expect(result.after.assets).toEqual(before.assets);
    expect(result.after.description).toEqual(before.description);
    expect(before).toEqual(original);
  });
  it('reindexes a two-tier grid after removing one volume across scents', () => {
    const before = draft('one', [['Bạc Hà', '100ml'], ['Bạc Hà', '280ml'], ['Quế', '100ml'], ['Quế', '280ml']]), request = input();
    const result = previewBulkProductEdit(before, request.entries[0]!, request);
    expect(result.issues).toEqual([]);
    expect(result.models.map(model => model.tierIndex)).toEqual([[0, 0], [1, 0]]);
    expect(result.after.sourceSelection!.variants.map(row => row.rowKey)).toEqual(['row0', 'row2']);
  });
  it('blocks empty products, missing source mapping and incomplete two-tier grids', () => {
    const before = draft('one', [['100ml']]), request = input(); request.removeVolumesMl = [100];
    expect(previewBulkProductEdit(before, request.entries[0]!, request).issues.map(issue => issue.code)).toContain('BULK_EDIT_EMPTY_VARIANTS');
    delete before.sourceSelection;
    expect(previewBulkProductEdit(before, request.entries[0]!, request).issues.map(issue => issue.code)).toContain('BULK_EDIT_SOURCE_MAPPING_REQUIRED');
    const grid = draft('one', [['A', '100ml'], ['A', '300ml'], ['B', '100ml'], ['B', '300ml']]);
    request.removeVolumesMl = []; request.entries[0]!.removeVariantKeys = ['row0'];
    expect(previewBulkProductEdit(grid, request.entries[0]!, request).issues.map(issue => issue.code)).toContain('BULK_EDIT_INCOMPLETE_GRID');
  });
  it('allows exact selection and identifies nonexistent variant keys without guessing', () => {
    const request = input(); request.removeVolumesMl = []; request.entries[0]!.removeVariantKeys = ['row2'];
    expect(previewBulkProductEdit(draft(), request.entries[0]!, request).removed.map(variant => variant.key)).toEqual(['row2']);
    request.entries[0]!.removeVariantKeys = ['missing'];
    expect(previewBulkProductEdit(draft(), request.entries[0]!, request).issues.map(issue => issue.code)).toContain('BULK_EDIT_VARIANT_NOT_FOUND');
  });
});

function store(drafts = [draft('one'), draft('two')]) {
  let latest = new Map(drafts.map(value => [value.productKey, value.revision]));
  let revisions = new Map(drafts.map(value => [`${value.productKey}:${value.revision}`, structuredClone(value)]));
  let snapshot: { latest: typeof latest; revisions: typeof revisions };
  let failInsert = false, archived = false;
  const query = vi.fn(async (sql: string, values: any[] = []): Promise<any> => {
    if (sql === 'BEGIN') snapshot = { latest: structuredClone(latest), revisions: structuredClone(revisions) };
    if (sql === 'ROLLBACK') { latest = snapshot.latest; revisions = snapshot.revisions; }
    if (sql.includes('SELECT r.body FROM product_revisions')) {
      const body = revisions.get(`${values[0]}:${values[1] ?? latest.get(values[0])}`);
      return { rows: body ? [{ body: structuredClone(body) }] : [], rowCount: body ? 1 : 0 };
    }
    if (sql.includes('FROM local_resource_archives')) return { rows: archived ? [{}] : [], rowCount: archived ? 1 : 0 };
    if (sql.startsWith('UPDATE products')) {
      if (latest.get(values[0]) !== values[2]) return { rows: [], rowCount: 0 };
      latest.set(values[0], values[1]); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO product_revisions')) {
      if (failInsert && values[0] === 'two') throw Error('SIMULATED_DB_FAILURE');
      revisions.set(`${values[0]}:${values[1]}`, structuredClone(values[2]));
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() }, pool: any = { query, connect: async () => client };
  return { service: new BulkProductEditService(new Repository(pool)), query,
    current: (key: string) => revisions.get(`${key}:${latest.get(key)}`)!,
    change: (key: string) => { const changed = { ...revisions.get(`${key}:1`)!, revision: 2 }; latest.set(key, 2); revisions.set(`${key}:2`, changed); },
    fail: () => { failInsert = true; }, archive: () => { archived = true; },
  };
}

describe('atomic local bulk edits', () => {
  it('previews without writes and saves all drafts once; exact replay recovers the receipt', async () => {
    const f = store(), request = input(['one', 'two']), preview = await f.service.preview(request);
    expect(preview).toMatchObject({ changedCount: 2, blockedCount: 0, localOnly: true });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql.startsWith('INSERT'))).toBe(false);
    const command = { input: request, expectedDigest: preview.digest };
    await expect(f.service.apply(command)).resolves.toMatchObject({ applied: true, recovered: false });
    expect(f.current('one').revision).toBe(2); expect(f.current('two').revision).toBe(2);
    await expect(f.service.apply(command)).resolves.toMatchObject({ applied: true, recovered: true });
    expect(f.current('one').revision).toBe(2);
    expect(f.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO product_revisions'))).toHaveLength(2);
  });
  it('rejects changed sources or changed requested removal without overwriting any draft', async () => {
    const f = store(), request = input(['one', 'two']), preview = await f.service.preview(request);
    f.change('two');
    await expect(f.service.apply({ input: request, expectedDigest: preview.digest })).rejects.toThrow('PRODUCT_REVISION_CONFLICT');
    expect(f.current('one').revision).toBe(1);
    request.removeVolumesMl = [100];
    await expect(f.service.apply({ input: request, expectedDigest: preview.digest })).rejects.toThrow('BULK_EDIT_PREVIEW_CHANGED');
  });
  it('rolls back every changed draft when a later insert fails', async () => {
    const f = store(), request = input(['one', 'two']), preview = await f.service.preview(request); f.fail();
    await expect(f.service.apply({ input: request, expectedDigest: preview.digest })).rejects.toThrow('SIMULATED_DB_FAILURE');
    expect(f.current('one').revision).toBe(1); expect(f.current('two').revision).toBe(1);
    expect(f.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  });
  it('keeps per-product blocking reasons and refuses writes to archived sources', async () => {
    const f = store(), request = input(['one', 'missing']);
    expect(await f.service.preview(request)).toMatchObject({ blockedCount: 1, changedCount: 1 });
    const valid = input(['one']), preview = await f.service.preview(valid); f.archive();
    await expect(f.service.apply({ input: valid, expectedDigest: preview.digest })).rejects.toThrow('LOCAL_RESOURCE_ARCHIVED');
    expect(f.current('one').revision).toBe(1);
  });
});
