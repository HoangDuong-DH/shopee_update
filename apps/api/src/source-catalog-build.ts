import { createHash } from 'node:crypto';
import type {
  CatalogDesign,
  CatalogEvidence,
  CatalogListingDetail,
  CatalogText,
  SourceCatalogDetail,
  CatalogOperationalReference,
} from '@shopee/domain';
import type { CatalogSnapshot } from '@shopee/persistence';

type Field = { value?: unknown; present: boolean; ref: { sheet: string; cell: string } };
export interface WorkbookProfile {
  schemaVersion: string;
  source: { sha256: string; observedAt: string; originalPath: string };
  recordCount: number;
  records: { sheet: string; rowIndex: number; fields: Record<string, Field> }[];
}
export interface CanvaPageInventory {
  complete: boolean;
  designs: {
    id: string;
    title: string;
    folderId: string;
    metadataUpdatedAt: number | string;
    currentMetadataUpdatedAt?: string;
    expectedPageCount: number;
    currentPageCount?: number;
    metadataRecheck?: { verified: boolean; stablePageMetadata: boolean };
    coverageComplete?: boolean;
    complete: boolean;
    pages: { id: string; pageNumber: number; width: number; height: number }[];
  }[];
}
const compact = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const sourceValue = (f?: Field) =>
  f?.present && f.value !== undefined && f.value !== null ? String(f.value) : '';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

/** Exact source text only. Candidate matching is deliberately separate from confirmation. */
export function buildSourceCatalog(
  profile: WorkbookProfile,
  inventory: CanvaPageInventory,
  folderUrl: string,
  references: CatalogOperationalReference[] = [],
): CatalogSnapshot {
  if (
    profile.schemaVersion !== 'vina-workbook-profile/v1' ||
    !/^[a-f0-9]{64}$/.test(profile.source.sha256) ||
    profile.recordCount !== profile.records.length ||
    inventory.complete !== true ||
    inventory.designs.some(
      (d) =>
        !(d.complete || d.coverageComplete) ||
        d.pages.length !== (d.currentPageCount ?? d.expectedPageCount),
    )
  )
    throw new Error('CATALOG_SOURCE_INCOMPLETE');
  if (
    new Set(inventory.designs.map((d) => d.id)).size !== inventory.designs.length ||
    new Set(profile.records.map((r) => `${r.sheet}:${r.rowIndex}`)).size !==
      profile.records.length ||
    profile.records.some(
      (r) =>
        !Number.isInteger(r.rowIndex) ||
        r.rowIndex < 1 ||
        Object.values(r.fields).some(
          (f) => f.ref.sheet !== r.sheet || !new RegExp(`^[A-Z]+${r.rowIndex}$`).test(f.ref.cell),
        ),
    ) ||
    inventory.designs.some(
      (d) =>
        !/^[A-Za-z0-9_-]+$/.test(d.id) ||
        new Set(d.pages.map((p) => p.id)).size !== d.pages.length ||
        d.pages.some(
          (p, i) =>
            !p.id ||
            p.pageNumber !== i + 1 ||
            !Number.isInteger(p.width) ||
            p.width <= 0 ||
            !Number.isInteger(p.height) ||
            p.height <= 0,
        ) ||
        (d.currentPageCount !== undefined &&
          d.currentPageCount !== d.expectedPageCount &&
          !(d.metadataRecheck?.verified && d.metadataRecheck.stablePageMetadata)),
    )
  )
    throw new Error('CATALOG_SOURCE_INVALID');
  const folder = new URL(folderUrl);
  if (
    folder.protocol !== 'https:' ||
    folder.hostname !== 'www.canva.com' ||
    folder.username ||
    folder.password ||
    folder.port ||
    !/^\/folder\/[A-Za-z0-9_-]+$/.test(folder.pathname) ||
    folder.search ||
    folder.hash
  )
    throw new Error('CATALOG_FOLDER_INVALID');
  const sourceId = 'workbook:' + profile.source.sha256;
  const designs: CatalogDesign[] = inventory.designs.map((d) => ({
    id: d.id,
    title: d.title,
    url: `https://www.canva.com/design/${encodeURIComponent(d.id)}/edit`,
    folderId: d.folderId,
    pageCount: d.currentPageCount ?? d.expectedPageCount,
    observedPageCount: d.pages.length,
    complete: d.complete || d.coverageComplete === true,
    updatedAt:
      d.currentMetadataUpdatedAt ??
      (typeof d.metadataUpdatedAt === 'number'
        ? new Date(d.metadataUpdatedAt * 1000).toISOString()
        : d.metadataUpdatedAt),
  }));
  const pages = inventory.designs.flatMap((d) =>
    d.pages.map((p) => ({
      designId: d.id,
      id: p.id,
      pageNumber: p.pageNumber,
      width: p.width,
      height: p.height,
    })),
  );
  const listings: CatalogListingDetail[] = profile.records.map((row, ordinal) => {
    const f = row.fields;
    const evidence = (key: string, label: string): CatalogEvidence => ({
      sourceId,
      sheet: f[key]?.ref.sheet ?? row.sheet,
      cell: f[key]?.ref.cell,
      label,
    });
    const text = (key: string, label: string): CatalogText[] =>
      sourceValue(f[key]) !== ''
        ? [{ label, value: sourceValue(f[key]), evidence: evidence(key, label) }]
        : [];
    const brand = sourceValue(f.brandLabel),
      sourceNumber = sourceValue(f.sourceSerial) || null,
      title = sourceValue(f.title);
    const contents = [
      ...text('contentOriginal', 'Nội dung gốc trong file'),
      ...text('contentBeforeReview', 'Nội dung trước rà soát'),
      ...text('contentAfterEdit', 'Nội dung sau sửa trong file'),
    ];
    const variations = text('variantsBeforeEdit', 'Phân loại — bản trước trong file');
    const reviewNotes = [
      ...text('sourceNeedsVerification', 'Ghi chú cần xác minh trong file'),
      ...text('sourceReviewStatus', 'Kết quả rà soát trong file'),
      ...text('sourceChangeReasons', 'Lý do sửa trong file'),
      ...text('sourceChangedFlag', 'Cờ sửa trong file'),
      ...text('sourceDocumentReference', 'Tên tệp nguồn được ghi trong Excel'),
    ];
    const designCandidates = designs
      .filter((d) => {
        const number = /^\s*(\d+)\s*[-–—.]/.exec(d.title)?.[1];
        return (
          !!sourceNumber &&
          !!number &&
          Number(number) === Number(sourceNumber) &&
          compact(d.title).includes(compact(brand)) &&
          !!compact(brand)
        );
      })
      .map((d) => ({
        ...d,
        reason:
          'Cùng số thứ tự và tên nhãn hàng trong tiêu đề. Chưa xác nhận đây là bộ ảnh của listing.',
        status: 'suggested' as const,
      }));
    const issues: CatalogListingDetail['issues'] = [];
    if (!sourceValue(f.listingId))
      issues.push({
        code: 'missing_item_id',
        message: 'Chưa có mã listing trong Excel',
        action:
          'Xác định đăng mới hay cập nhật và shop đích; ô trống không tự có nghĩa là đăng mới.',
      });
    if (!designCandidates.length)
      issues.push({
        code: 'no_design',
        message: 'Chưa tìm thấy bộ Canva tương ứng',
        action: 'Đối chiếu ảnh theo sản phẩm; ứng dụng chưa tự ghép theo tên gần giống.',
      });
    if (designCandidates.length > 1)
      issues.push({
        code: 'multiple_designs',
        message: `Có ${designCandidates.length} bộ Canva cần đối chiếu`,
        action:
          'Mở từng thiết kế để xác định bộ ảnh cần dùng; ngày mới hơn không chứng minh đúng bộ.',
      });
    if (sourceValue(f.sourceNeedsVerification))
      issues.push({
        code: 'source_review',
        message: 'File có ghi chú cần xác minh',
        action:
          'Đọc ghi chú bên dưới và kiểm lại tình trạng hiện tại. Đây là ghi chú trong nguồn, chưa phải kết luận kiểm tra mới.',
      });
    return {
      id: 'row-' + (ordinal + 1),
      brand,
      sourceNumber,
      itemId: sourceValue(f.listingId) || null,
      title,
      sheet: row.sheet,
      row: row.rowIndex,
      contentAvailable: contents.length > 0,
      variationAvailable: variations.length > 0,
      designCandidateCount: designCandidates.length,
      issues,
      status: 'needs_review',
      titleSource: evidence('title', 'Tiêu đề trong Excel'),
      contents,
      variations,
      reviewNotes,
      designCandidates,
      shopBinding: null,
      priceSource: null,
      stockSource: null,
      attributeReference: null,
      operationalReferences: references.filter(
        (ref) =>
          ref.itemId === sourceValue(f.listingId) &&
          ref.title === title &&
          ref.apiVerified === false &&
          ref.approvedForReuse === false,
      ),
    };
  });
  // Fingerprint includes the normalized parser output, so code changes cannot silently reuse an old parse.
  const fingerprint = digest(
    JSON.stringify({ profileHash: profile.source.sha256, listings, designs, pages, folderUrl }),
  );
  const h = fingerprint;
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const catalog: SourceCatalogDetail = {
    id,
    name: 'Bộ nội dung Vina Tươi và các nhãn hàng',
    revision: 1,
    receivedAt: profile.source.observedAt,
    counts: {
      listings: listings.length,
      designs: designs.length,
      pages: pages.length,
      needsReview: listings.length,
    },
    brands: [...new Set(listings.map((l) => l.brand))].map((name) => ({
      name,
      count: listings.filter((l) => l.brand === name).length,
    })),
    sources: [
      {
        id: sourceId,
        name: profile.source.originalPath.split(/[\\/]/).at(-1)!,
        kind: 'workbook',
        sha256: profile.source.sha256,
      },
      {
        id: 'canva:' + folder.pathname.split('/').at(-1),
        name: 'Thư mục Canva đã nhận',
        kind: 'canva_folder',
        url: folderUrl,
      },
    ],
    notes: [
      'Excel này lưu nội dung và lịch sử rà soát của nhiều nhãn hàng. Không phải bảng giá hoặc bảng tồn.',
      'Các phiên bản chữ được giữ nguyên. Chưa chọn thay bạn bản sẽ đăng.',
      'Tên nhãn hàng chưa được coi là tên shop. Mã listing trong nguồn cần đối chiếu với đúng shop.',
      'Đã kiểm kê trang Canva và kích thước; chưa tải tệp ảnh gốc, chưa xác nhận vai trò bìa, nội dung hoặc phân loại.',
      'Liên kết Canva bên dưới là ứng viên để đối chiếu, chưa phải bộ ảnh đã ghép xong.',
      ...inventory.designs
        .filter(
          (d) => d.currentPageCount !== undefined && d.currentPageCount !== d.expectedPageCount,
        )
        .map(
          (d) =>
            `Thiết kế ${d.id} thay đổi trong lúc đọc: danh sách ban đầu ${d.expectedPageCount} trang, lần đối chiếu mới ${d.currentPageCount} trang. Giữ cả hai mốc nguồn.`,
        ),
    ],
    missing: [
      'Shop đích và thao tác đăng mới / cập nhật',
      'SKU và tổ hợp phân loại được bán',
      'Bảng giá và mức tồn theo SKU/shop',
      'Ảnh gốc, vai trò và thứ tự ảnh',
      'Ngành hàng và thuộc tính có nguồn đối chiếu',
    ],
    originalAssetsDownloaded: false,
    publishable: false,
    importFingerprint: fingerprint,
  };
  return { catalog, listings, designs, pages };
}
