import type { CatalogRow } from '../../packages/domain/src/contracts.js';

export function pendingWorksheet() {
  return {
    schemaVersion: 'listing-mapping-pending/v1',
    sourceKey: 'source-a',
    product: { productKey: 'product-a', sourceRevision: 0 },
    sourceWorkbookSha256: 'b'.repeat(64),
    title: 'Xịt thơm chờ hoàn thiện',
    sourceListingId: null,
    sourceListingIdCell: 'Nguồn!C10',
    rawVariationText: 'Nhãn nguồn giữ nguyên',
    tiers: [
      { ordinal: 1, literalHeading: 'Hương thơm', options: ['Hoa Hồng', 'Cam Sả (MỚI)'] },
      { ordinal: 2, literalHeading: 'Dung tích', options: ['100ml', '300ml'] },
    ],
    slots: [
      {
        slotId: 'slot-b',
        optionPositions: [1, 1],
        optionLabels: ['Cam Sả (MỚI)', '300ml'],
        sku: null,
        sourceCell: 'Nguồn!F10',
        membershipConfirmed: false,
        status: 'CHƯA CÓ SKU',
        issues: ['NEW_LABEL_IDENTITY_UNRESOLVED'],
        originalPrice: '999999',
      },
      {
        slotId: 'slot-a',
        optionPositions: [0, 0],
        optionLabels: ['Hoa Hồng', '100ml'],
        sku: 'A',
        sourceCell: 'Nguồn!F10',
        membershipConfirmed: false,
        status: 'ĐÃ KHỚP SKU NGUỒN',
        issues: [],
      },
    ],
    issues: ['SKU_MEMBERSHIP_INCOMPLETE'],
  };
}
export function pendingPriceSource() {
  const fact = (value: string) => ({
    value,
    confirmed: true,
    sources: [
      {
        kind: 'product_file' as const,
        fileSha256: 'c'.repeat(64),
        locator: 'Giá!A1',
        observedAt: '2026-09-16T00:00:00.000Z',
      },
    ],
  });
  const rows: CatalogRow[] = ['A', 'B'].map((sku, i) => ({
    key: 'row-' + sku,
    sheet: 'Giá',
    priceProfile: 'SHOP MALL',
    row: i + 2,
    headerRow: 1,
    sku: fact(sku),
    name: fact(sku),
    originalPrice: fact('123000'),
    issues: [],
  }));
  return {
    importId: '00000000-0000-4000-8000-000000000001',
    sheet: 'Giá',
    priceProfile: 'SHOP MALL',
    rows,
  };
}
