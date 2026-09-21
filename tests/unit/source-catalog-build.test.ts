import { describe, expect, it } from 'vitest';
import { buildSourceCatalog } from '../../apps/api/src/source-catalog-build.js';
import type { CatalogOperationalReference } from '../../packages/domain/src/source-catalog.js';
import { listingSummary } from '../../packages/persistence/src/source-catalogs.js';
import {
  qaAfter,
  qaBefore,
  qaCanva,
  qaFolder,
  qaOriginal,
  qaTitle,
  qaVariants,
  qaWarning,
  qaWorkbook,
} from '../fixtures/source-catalog.js';

describe('source catalog is evidence and cannot become a prepared product', () => {
  it('derives operational concern count without source issues or leaking reference details', () => {
    const profile = qaWorkbook();
    profile.records[0].fields.sourceNeedsVerification = {
      ...profile.records[0].fields.sourceNeedsVerification,
      present: false,
      value: null,
    };
    const inventory = qaCanva();
    inventory.designs = [inventory.designs[0]];
    const reference: CatalogOperationalReference = {
      shopHandle: 'qa-shop-observed',
      itemId: '970000001',
      title: qaTitle,
      sourceUrl: 'https://shopee.vn/product/910000001/970000001',
      observedAt: '2026-09-14T09:00:00Z',
      categoryLabel: 'QA category observed',
      categoryGuideUrl: 'https://seller.shopee.vn/edu',
      attributes: [{ label: 'QA source attribute', value: 'QA private detail' }],
      concerns: ['QA private concern A', 'QA private concern B'],
      apiVerified: false,
      approvedForReuse: false,
    };
    const references = [
      reference,
      { ...reference, shopHandle: 'qa-second-observation', concerns: ['QA private concern C'] },
    ];
    const inputBefore = structuredClone({ profile, inventory, references });
    const detail = buildSourceCatalog(profile, inventory, qaFolder, references).listings[0];
    detail.operationalConcernCount = 99;
    const detailBefore = structuredClone(detail);
    const summary = listingSummary(detail);
    expect(summary.issues).toEqual([]);
    expect(summary.operationalConcernCount).toBe(3);
    expect(summary.title).toBe(qaTitle);
    expect(summary).not.toHaveProperty('operationalReferences');
    expect(summary).not.toHaveProperty('contents');
    expect(summary).not.toHaveProperty('reviewNotes');
    expect(JSON.stringify(summary)).not.toContain('QA private');
    expect(detail).toEqual(detailBefore);
    expect({ profile, inventory, references }).toEqual(inputBefore);
    expect(detail.contents.map((entry) => entry.value)).toEqual([qaOriginal, qaBefore, qaAfter]);
  });

  it('derives zero operational concerns for older source rows without references', () => {
    const detail = buildSourceCatalog(qaWorkbook(), qaCanva(), qaFolder).listings[0];
    delete detail.operationalReferences;
    detail.operationalConcernCount = 99;
    const before = structuredClone(detail);
    const summary = listingSummary(detail);
    expect(summary.operationalConcernCount).toBe(0);
    expect(summary).not.toHaveProperty('operationalReferences');
    expect(detail).toEqual(before);
  });

  it('keeps exact Unicode whitespace, all content versions, ordered variant text and source refs', () => {
    const p = qaWorkbook(),
      inv = qaCanva(),
      before = structuredClone({ p, inv });
    const result = buildSourceCatalog(p, inv, qaFolder);
    expect(result.listings[0].title).toBe(qaTitle);
    expect(result.listings[0].contents.map((c) => c.value)).toEqual([
      qaOriginal,
      qaBefore,
      qaAfter,
    ]);
    expect(result.listings[0].variations.map((v) => v.value)).toEqual([qaVariants]);
    expect(result.listings[0].titleSource).toMatchObject({
      sourceId: `workbook:${'a'.repeat(64)}`,
      sheet: 'QA ALPHA & nguồn',
      cell: 'D4',
    });
    expect(result.listings[0].reviewNotes.map((n) => n.value)).toContain(qaWarning);
    expect(result.listings[0].reviewNotes.map((n) => n.value)).toContain('0');
    expect(result.listings[0].reviewNotes.map((n) => n.value)).toContain(
      '../QA nguồn chỉ là chuỗi.md',
    );
    expect({ p, inv }).toEqual(before);
  });

  it('keeps same source item ID in different brands as separate unbound records', () => {
    const { listings } = buildSourceCatalog(qaWorkbook(), qaCanva(), qaFolder);
    expect(
      listings.filter((r) => r.itemId === '970000001').map((r) => [r.brand, r.shopBinding]),
    ).toEqual([
      ['QA ALPHA', null],
      ['QA BETA', null],
    ]);
    expect(new Set(listings.map((r) => r.id)).size).toBe(4);
  });

  it('leaves blank IDs unbound and all prices/stock/category/source media unconfirmed', () => {
    const p = qaWorkbook();
    p.records[1].fields.listingId.value = 'IGNORED_WHEN_PRESENT_FALSE';
    (p.records[1].fields as any).price = {
      present: true,
      value: 0,
      ref: { sheet: p.records[1].sheet, cell: 'N5' },
    };
    const { listings, catalog } = buildSourceCatalog(p, qaCanva(), qaFolder);
    expect(listings[1].itemId).toBeNull();
    expect(listings[1].issues.map((i) => i.code)).toContain('missing_item_id');
    for (const row of listings) {
      expect(row).toMatchObject({
        status: 'needs_review',
        shopBinding: null,
        priceSource: null,
        stockSource: null,
        attributeReference: null,
      });
      expect(row).not.toHaveProperty('operation');
      expect(row).not.toHaveProperty('models');
    }
    expect(catalog).toMatchObject({ publishable: false, originalAssetsDownloaded: false });
  });

  it('retains both old and new same-number designs as suggestions and never picks latest', () => {
    const { listings, pages } = buildSourceCatalog(qaWorkbook(), qaCanva(), qaFolder);
    expect(listings[0].designCandidates.map((x) => [x.id, x.status])).toEqual([
      ['QA_ALPHA_OLD', 'suggested'],
      ['QA_ALPHA_NEW', 'suggested'],
    ]);
    expect(listings[0].issues.map((i) => i.code)).toContain('multiple_designs');
    expect(listings[1].designCandidates).toEqual([]);
    expect(listings[2].designCandidates.map((x) => x.id)).toEqual(['QA_BETA']);
    expect(pages.filter((p) => p.id === 'shared-page-id').map((p) => p.designId)).toEqual([
      'QA_ALPHA_OLD',
      'QA_ALPHA_NEW',
      'QA_BETA',
    ]);
  });

  it('does not treat source review status or zero change flag as an approval', () => {
    const p = qaWorkbook();
    p.records[0].fields.sourceReviewStatus.value = 'Chưa phát hiện câu cần sửa';
    const row = buildSourceCatalog(p, qaCanva(), qaFolder).listings[0];
    expect(row.status).toBe('needs_review');
    expect(row.issues.map((i) => i.code)).toContain('source_review');
    expect(row.reviewNotes.find((n) => n.evidence.cell === 'K4')?.value).toBe(qaWarning);
  });

  it('changes snapshot identity when content bytes, a source warning or page dimensions change', () => {
    const p = qaWorkbook(),
      inv = qaCanva();
    const first = buildSourceCatalog(p, inv, qaFolder);
    expect(buildSourceCatalog(structuredClone(p), structuredClone(inv), qaFolder)).toEqual(first);
    p.records[0].fields.contentAfterEdit.value = `${qaAfter} `;
    expect(buildSourceCatalog(p, inv, qaFolder).catalog.id).not.toBe(first.catalog.id);
    p.records[0].fields.sourceNeedsVerification.value = qaWarning + '\nCần kiểm lại';
    const changed = buildSourceCatalog(p, inv, qaFolder);
    inv.designs[0].pages[0].width = 1024;
    expect(buildSourceCatalog(p, inv, qaFolder).catalog.importFingerprint).not.toBe(
      changed.catalog.importFingerprint,
    );
  });

  it('records source page-count change while requiring the fresh full coverage', () => {
    const inv = qaCanva();
    inv.designs[0].expectedPageCount = 3;
    inv.designs[0].currentPageCount = 2;
    inv.designs[0].coverageComplete = true;
    inv.designs[0].metadataRecheck = { verified: true, stablePageMetadata: true };
    const result = buildSourceCatalog(qaWorkbook(), inv, qaFolder);
    expect(result.catalog.notes.join('\n')).toContain('ban đầu 3 trang');
    expect(result.designs[0]).toMatchObject({ pageCount: 2, observedPageCount: 2 });
  });

  it.each([
    undefined,
    { verified: false, stablePageMetadata: true },
    { verified: true, stablePageMetadata: false },
  ])('refuses a changed page count without a verified stable recheck: %j', (metadataRecheck) => {
    const inv = qaCanva();
    inv.designs[0].expectedPageCount = 3;
    inv.designs[0].currentPageCount = 2;
    inv.designs[0].coverageComplete = true;
    inv.designs[0].metadataRecheck = metadataRecheck;
    expect(() => buildSourceCatalog(qaWorkbook(), inv, qaFolder)).toThrow(/CATALOG_/);
  });

  it('keeps only exact source item/title operational observations as explicitly unapproved references', () => {
    const reference: CatalogOperationalReference = {
      shopHandle: 'qa-shop-observed',
      itemId: '970000001',
      title: qaTitle,
      sourceUrl: 'https://shopee.vn/product/910000001/970000001',
      observedAt: '2026-09-14T09:00:00Z',
      categoryLabel: 'QA label observed only',
      categoryGuideUrl: 'https://seller.shopee.vn/edu',
      attributes: [{ label: 'QA unit', value: '100ml' }],
      concerns: ['Observed UI, not API identity'],
      apiVerified: false,
      approvedForReuse: false,
    };
    const result = buildSourceCatalog(qaWorkbook(), qaCanva(), qaFolder, [
      reference,
      { ...reference, title: qaTitle.trim() },
      { ...reference, itemId: '970000002' },
      { ...reference, approvedForReuse: true } as any,
    ]);
    expect(result.listings[0].operationalReferences).toEqual([reference]);
    expect(result.listings[2].operationalReferences).toEqual([]);
    expect(result.listings[0].attributeReference).toBeNull();
    expect(result.listings[0].shopBinding).toBeNull();
  });

  it.each([
    'http://www.canva.com/folder/QA_FOLDER',
    'https://evil.test/folder/QA_FOLDER',
    'https://www.canva.com/folder/QA_FOLDER?token=x',
    'https://www.canva.com/folder/QA_FOLDER#x',
    'https://user:password@www.canva.com/folder/QA_FOLDER',
    'https://www.canva.com:8443/folder/QA_FOLDER',
  ])('rejects a folder URL outside the exact canonical source boundary: %s', (url) => {
    expect(() => buildSourceCatalog(qaWorkbook(), qaCanva(), url)).toThrow();
  });

  it.each([
    'incomplete',
    'missing-page',
    'duplicate-page-number',
    'noncontiguous-page-number',
    'duplicate-page-id',
    'zero-width',
    'duplicate-design-id',
    'traversal-design-id',
  ] as const)('refuses false complete inventory: %s', (fault) => {
    const inv = qaCanva(),
      d = inv.designs[0];
    if (fault === 'incomplete') inv.complete = false;
    if (fault === 'missing-page') d.pages.pop();
    if (fault === 'duplicate-page-number') d.pages[1].pageNumber = 1;
    if (fault === 'noncontiguous-page-number') d.pages[1].pageNumber = 3;
    if (fault === 'duplicate-page-id') d.pages[1].id = d.pages[0].id;
    if (fault === 'zero-width') d.pages[0].width = 0;
    if (fault === 'duplicate-design-id') inv.designs[1].id = d.id;
    if (fault === 'traversal-design-id') d.id = '..';
    expect(() => buildSourceCatalog(qaWorkbook(), inv, qaFolder)).toThrow();
  });

  it('rejects a duplicate source row rather than assigning it a second synthetic listing ID', () => {
    const p = qaWorkbook();
    p.records.push(structuredClone(p.records[0]));
    p.recordCount++;
    expect(() => buildSourceCatalog(p, qaCanva(), qaFolder)).toThrow();
  });

  it('rejects a populated field whose evidence points at a different sheet/row', () => {
    const p = qaWorkbook();
    p.records[0].fields.title.ref = { sheet: 'QA BETA & nguồn', cell: 'D999' };
    expect(() => buildSourceCatalog(p, qaCanva(), qaFolder)).toThrow();
  });
});
