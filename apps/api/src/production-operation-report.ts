import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { ProductionScope } from './production-scope.js';

const identifier = z.string().regex(/^[1-9]\d*$/);
const listing = z.object({
  sourceKey: z.string(), title: z.string(), state: z.string(), modelCount: z.number().int().nonnegative(),
  productKey: z.string().optional(), sourceRevision: z.number().int().positive().optional(),
  currentRevision: z.number().int().positive().optional(), currentSource: z.string().optional(),
  itemId: identifier.nullable().optional(), operationId: z.string().uuid().optional(),
  acknowledgedSteps: z.number().int().nonnegative(), totalSteps: z.number().int().nonnegative(),
  excluded: z.boolean().optional(), imageQcStatus: z.string().optional(),
});
const batch = z.object({
  batchId: z.string().uuid(), partnerId: identifier, shopId: identifier, shopName: z.string().optional(),
  state: z.string(), publicationMode: z.enum(['hidden_for_review', 'publish_after_verification']).optional(),
  listings: z.array(listing).max(1000), holdReason: z.string().optional(),
  lastResult: z.object({ code: z.string().optional(), listings: z.array(z.object({
    sourceKey: z.string(), code: z.string().optional(), state: z.string(),
  })) }).nullable().optional(),
});
type Listing = z.infer<typeof listing>;

/** These labels describe durable evidence, not a fresh Shopee read or human QC. */
function view(row: Listing) {
  if (row.excluded) return { group: 'excluded', progress: 'Đã loại khỏi đợt', shop: 'Chưa gửi trong đợt này', next: 'Sửa nguồn và chuẩn bị lại nếu cần đăng.' };
  if (row.state === 'published') return { group: 'published', progress: 'Đã đối chiếu mở bán', shop: 'Đã mở bán', next: 'Mở link để kiểm tra nghiệp vụ khi cần.' };
  if (['created_unlisted', 'created_hidden_image_qc_deferred'].includes(row.state)) return {
    group: 'hidden', progress: 'Đã tạo link ẩn và đối chiếu dữ liệu gửi', shop: 'Đang ẩn',
    next: row.state === 'created_hidden_image_qc_deferred' || row.imageQcStatus === 'deferred'
      ? 'QC ảnh và thông tin tạm trước khi mở bán; không tạo lại link.' : 'QC nội dung và thông tin tạm trước khi chọn mở bán.',
  };
  if (['not_sent', 'inspected', 'authorized_not_started'].includes(row.state)) return {
    group: row.currentSource && row.currentSource !== 'current' ? 'needs_source' : 'not_sent',
    progress: row.state === 'not_sent' ? 'Chưa gửi' : 'Đã chuẩn bị, chưa gửi', shop: 'Chưa tạo link trong đợt này',
    next: row.currentSource && row.currentSource !== 'current' ? 'Mở bản nguồn mới nhất và chuẩn bị lại bộ này.' : 'Kiểm tra dữ liệu rồi tạo link ẩn.',
  };
  if (['blocked', 'rejected'].includes(row.state)) return {
    group: 'needs_source', progress: row.state === 'rejected' ? 'Yêu cầu bị từ chối' : 'Cần bổ sung hoặc sửa dữ liệu',
    shop: row.itemId ? 'Đã có mã link; cần đọc lại trạng thái' : 'Chưa xác nhận có link', next: 'Xem nguyên nhân, sửa đúng bộ này rồi kiểm tra lại.',
  };
  return { group: 'reconciling', progress: row.state === 'publication_readback_pending' ? 'Đã yêu cầu mở bán, đang xác minh' : 'Đang xác minh kết quả gửi',
    shop: row.itemId ? 'Đã có mã link; trạng thái đang xác minh' : 'Chưa xác định', next: 'Đọc đối chiếu kết quả; không gửi tạo lại khi kết quả chưa rõ.' };
}
const safeCode = (value?: string) => value && /^[A-Z][A-Z0-9_]{0,199}$/.test(value) ? value : null;
const reasons: Record<string, string> = {
  PASS1_PLAN_BLOCKED: 'Bộ này chưa đạt kiểm tra trước khi gửi. Mở bản chuẩn bị để xem trường cần sửa.',
  PRODUCTION_BATCH_SOURCE_CHANGED: 'Nguồn đã có phiên bản mới; bản chuẩn bị chưa được cập nhật.',
  PRODUCTION_BATCH_SOURCE_ARCHIVED: 'Nguồn đã được lưu trữ; cần khôi phục hoặc loại phần chưa gửi khỏi đợt.',
  PRODUCTION_PILOT_MANDATORY_ATTRIBUTE_MISSING: 'Thiếu thuộc tính Shopee bắt buộc theo ngành đã chọn.',
  PRODUCTION_PILOT_BRAND_REVALIDATION_REQUIRED: 'Thương hiệu cần được đối chiếu lại với ngành và shop đã chọn.',
  PRODUCTION_PILOT_DUPLICATE_LISTING_OR_SKU: 'Đã có listing hoặc SKU liên quan; kiểm tra link hiện có trước khi tạo mới.',
  PRODUCTION_PILOT_STOCK_LOCATION_REFERENCE_MISSING: 'Chưa có listing tham khảo kho để xác định nơi nhận tồn.',
  PRODUCTION_PILOT_WAREHOUSE_MAPPING_REVIEW_REQUIRED: 'Chưa đối chiếu được kho nhận tồn; cần xác định kho trước khi gửi.',
  PREPARATION_CHILD_STILL_RUNNING: 'Nhóm con vẫn đang xử lý. Đọc lại tiến độ, không gửi lại lệnh tạo.',
  PRODUCTION_BATCH_RECONCILIATION_REQUIRED: 'Có lần gửi chưa xác định đầy đủ kết quả; cần đọc đối chiếu trước khi tiếp tục.',
};

/** Whitelist all exported fields. Raw request/response, tokens and connection data never enter a report. */
export function createProductionOperationReport(raw: unknown, scope: ProductionScope, now = new Date()) {
  const status = batch.parse(raw);
  if (scope.environment !== 'production' || status.partnerId !== scope.partnerId || status.shopId !== scope.shopId)
    throw Error('PRODUCTION_BATCH_SCOPE_MISMATCH');
  const rows = status.listings.map(row => {
    const reasonCode = safeCode(status.lastResult?.listings.find(result => result.sourceKey === row.sourceKey)?.code)
      ?? (row.currentSource === 'source_changed' ? 'PRODUCTION_BATCH_SOURCE_CHANGED'
        : row.currentSource === 'archived' ? 'PRODUCTION_BATCH_SOURCE_ARCHIVED' : null);
    const state = view(row);
    return { sourceKey: row.sourceKey, productKey: row.productKey ?? null, title: row.title,
      sourceRevision: row.sourceRevision ?? null, currentRevision: row.currentRevision ?? null,
      sourceState: row.currentSource ?? 'unknown', state: row.state, ...state, reasonCode,
      reason: reasonCode ? reasons[reasonCode] ?? 'Ứng dụng đã giữ kết quả để kiểm tra. Mở chi tiết đợt và xem mã lý do; chưa kết luận đã đăng thành công.' : '',
      itemId: row.itemId ?? null, url: row.itemId ? `https://banhang.shopee.vn/portal/product/${row.itemId}` : null,
      modelCount: row.modelCount, acknowledgedSteps: row.acknowledgedSteps, totalSteps: row.totalSteps,
      imageQc: row.state === 'created_hidden_image_qc_deferred' || row.imageQcStatus === 'deferred' ? 'Ảnh chưa QC'
        : row.imageQcStatus === 'verified' ? 'Có bằng chứng đối chiếu ảnh; vẫn cần QC nghiệp vụ' : 'Chưa có kết quả QC ảnh',
    };
  });
  const count = (group: string) => rows.filter(row => row.group === group).length;
  const errorCounts: Record<string, number> = {};
  for (const row of rows) if (row.reasonCode) errorCounts[row.reasonCode] = (errorCounts[row.reasonCode] ?? 0) + 1;
  return { version: 1, generatedAt: now.toISOString(), scope: { environment: scope.environment, partnerId: scope.partnerId, shopId: scope.shopId },
    shopName: status.shopName ?? scope.shopId, batchId: status.batchId, state: status.state,
    publicationMode: status.publicationMode ?? 'hidden_for_review',
    evidenceNotice: 'Báo cáo từ nhật ký đã lưu tại ứng dụng; không tự gọi đọc lại Shopee và không thay thế QC nghiệp vụ.',
    summary: { total: rows.length, verifiedHidden: count('hidden'), verifiedPublished: count('published'),
      awaitingReconciliation: count('reconciling'), needsSource: count('needs_source'), notSent: count('not_sent'), excluded: count('excluded'),
      imageQcPending: rows.filter(row => row.imageQc === 'Ảnh chưa QC').length,
      acknowledgedSteps: rows.reduce((n, row) => n + row.acknowledgedSteps, 0), totalSteps: rows.reduce((n, row) => n + row.totalSteps, 0) },
    errorCounts, rows,
  };
}
export type ProductionOperationReport = ReturnType<typeof createProductionOperationReport>;

export async function productionOperationReportWorkbook(report: ProductionOperationReport) {
  const book = new ExcelJS.Workbook();
  book.creator = 'Shopee Product Uploader';
  book.created = new Date(report.generatedAt);
  const overview = book.addWorksheet('Tong quan');
  overview.columns = [{ width: 35 }, { width: 90 }];
  overview.addRows([
    ['BÁO CÁO ĐỢT ĐĂNG', report.batchId], ['Shop', `${report.shopName} (${report.scope.shopId})`],
    ['Partner ID', report.scope.partnerId], ['Thời điểm xuất (UTC)', report.generatedAt], ['Phạm vi bằng chứng', report.evidenceNotice],
    ['Tổng sản phẩm', report.summary.total], ['Link ẩn đã đối chiếu', report.summary.verifiedHidden],
    ['Đã đối chiếu mở bán', report.summary.verifiedPublished], ['Đang xác minh', report.summary.awaitingReconciliation],
    ['Cần sửa nguồn', report.summary.needsSource], ['Chưa gửi', report.summary.notSent],
    ['Đã loại khỏi đợt', report.summary.excluded], ['Ảnh đang chờ QC', report.summary.imageQcPending],
    ['Bước có biên nhận / tổng bước', `${report.summary.acknowledgedSteps} / ${report.summary.totalSteps}`],
  ]);
  const sheet = book.addWorksheet('San pham', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    ['Tên sản phẩm', 'title', 48], ['Tiến độ', 'progress', 40], ['Trên shop', 'shop', 32], ['Việc tiếp theo', 'next', 64],
    ['Lý do / cách xử lý', 'reason', 64], ['Mã lý do gần nhất', 'reasonCode', 35], ['Link Shopee', 'url', 55], ['ID sản phẩm', 'itemId', 22],
    ['QC ảnh', 'imageQc', 48], ['Số phân loại', 'modelCount', 16], ['Bản chuẩn bị', 'sourceRevision', 18],
    ['Bản nguồn hiện tại', 'currentRevision', 20], ['Trạng thái nguồn', 'sourceState', 22], ['Mã bộ nguồn', 'productKey', 32],
    ['Tham chiếu nguồn', 'sourceKey', 45], ['Trạng thái kỹ thuật', 'state', 36],
  ].map(([header, key, width]) => ({ header: header as string, key: key as string, width: width as number }));
  for (const record of report.rows) {
    // ExcelJS strings stay strings even when user content begins with '='; never create formula objects from source text.
    const row = sheet.addRow(record);
    if (record.url) row.getCell('url').value = { text: record.url, hyperlink: record.url };
    row.alignment = { vertical: 'top', wrapText: true };
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: report.rows.length + 1, column: sheet.columnCount } };
  for (const table of [overview, sheet]) {
    table.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    table.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF175A4A' } };
  }
  overview.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true }; });
  return Buffer.from(await book.xlsx.writeBuffer());
}
