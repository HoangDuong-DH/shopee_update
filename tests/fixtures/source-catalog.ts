import type {
  WorkbookProfile,
  CanvaPageInventory,
} from '../../apps/api/src/source-catalog-build.js';

export const qaFolder = 'https://www.canva.com/folder/QA_FOLDER';
export const qaTitle = '  QA dầu 100%_ + SKU-A\nKhông tự đổi!  ';
export const qaOriginal = 'GỐC: SKU-A 100ml\n\n  Dòng có hai khoảng trắng  \n';
export const qaBefore = 'TRƯỚC: SKU-A 100ml\n\nHai lựa chọn, chỉ một tổ hợp.\n';
export const qaAfter = 'SAU: SKU-A 100ml\n\nĐây là nguồn QA, không đăng.\n';
export const qaVariants = 'Phân loại 1: Xanh · Đỏ\nPhân loại 2: 100ml · 500ml';
export const qaWarning = 'Nguồn cũ ghi 2 × 2 nhưng chỉ 1 tổ hợp bán; chưa có SKU từng tổ hợp.';

export function qaWorkbook(seed = 'a'): WorkbookProfile {
  const makeRow = (
    rowIndex: number,
    serial: number,
    brand: string,
    title: string,
    itemId: string | null,
  ) => {
    const sheet = `${brand} & nguồn`;
    const field = (column: string, value: string | number | null) => ({
      present: value !== null,
      value,
      ref: { sheet, cell: `${column}${rowIndex}` },
    });
    return {
      sheet,
      rowIndex,
      fields: {
        brandLabel: field('A', brand),
        sourceSerial: field('B', serial),
        listingId: field('C', itemId),
        title: field('D', title),
        contentOriginal: field('E', qaOriginal),
        contentBeforeReview: field('F', qaBefore),
        contentAfterEdit: field('G', qaAfter),
        variantsBeforeEdit: field('H', qaVariants),
        sourceReviewStatus: field('I', 'Chưa xác minh'),
        sourceChangeReasons: field('J', 'Giữ cả phiên bản cũ'),
        sourceNeedsVerification: field('K', qaWarning),
        sourceDocumentReference: field('L', '../QA nguồn chỉ là chuỗi.md'),
        sourceChangedFlag: field('M', 0),
      },
    };
  };
  const records = [
    makeRow(4, 12, 'QA ALPHA', qaTitle, '970000001'),
    makeRow(5, 13, 'QA ALPHA', 'QA thiếu ID không tự tạo mới', null),
    makeRow(4, 12, 'QA BETA', 'QA cùng số item ở nhãn khác', '970000001'),
    makeRow(6, 14, 'QA ALPHA', 'QA 100 phần trăm, không ký tự wildcard', null),
  ];
  return {
    schemaVersion: 'vina-workbook-profile/v1',
    source: {
      sha256: seed.repeat(64),
      observedAt: '2026-09-14T09:00:00.000Z',
      originalPath: 'C:/QA/nguồn.xlsx',
    },
    recordCount: records.length,
    records,
  };
}

export function qaCanva(): CanvaPageInventory {
  const design = (id: string, title: string, updated: number) => ({
    id,
    title,
    folderId: 'QA_FOLDER',
    metadataUpdatedAt: updated,
    expectedPageCount: 2,
    complete: true,
    pages: [
      { id: 'shared-page-id', pageNumber: 1, width: 1080, height: 1080 },
      { id: `${id}-portrait`, pageNumber: 2, width: 1080, height: 1440 },
    ],
  });
  return {
    complete: true,
    designs: [
      design('QA_ALPHA_OLD', '12 - QA ALPHA - bản cũ', 1700000000),
      design('QA_ALPHA_NEW', '12 - QA ALPHA - bản mới', 1800000000),
      design('QA_BETA', '12 - QA BETA - nhãn khác', 1750000000),
    ],
  };
}
