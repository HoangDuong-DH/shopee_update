export type OperationShop = { partnerId: string; shopId: string };

export function belongsToOperationShop(
  value: { partnerId?: string; shopId?: string }, scope: OperationShop,
) {
  return value.partnerId === scope.partnerId && value.shopId === scope.shopId;
}

export function batchOperationMarker(scope: OperationShop, batchId: string) {
  return `production-batch:${scope.partnerId}:${scope.shopId}:${batchId}`;
}

/** Separate observed shop state from processing progress and human quality review. */
export function listingOperationView(row: {
  state: string; excluded?: boolean; itemId?: string | null; imageQcStatus?: string;
  currentSource?: string;
}) {
  if (row.excluded) return { progress: 'Đã loại khỏi đợt', shop: 'Chưa gửi trong đợt này', next: 'Sửa nguồn rồi chuẩn bị lại nếu cần đăng.' };
  if (row.state === 'published') return { progress: 'Đã đối chiếu kết quả mở bán', shop: 'Đã mở bán', next: 'Mở link Shopee để kiểm tra khi cần.' };
  if (['created_unlisted', 'created_hidden_image_qc_deferred'].includes(row.state)) return {
    progress: 'Đã tạo link và đối chiếu dữ liệu gửi', shop: 'Đang ẩn',
    next: row.state === 'created_hidden_image_qc_deferred' || row.imageQcStatus === 'deferred'
      ? 'QC ảnh và thông tin tạm trước khi mở bán; không tạo lại link.'
      : 'QC nội dung và thông tin tạm trước khi chọn mở bán.',
  };
  if (['not_sent', 'inspected', 'authorized_not_started'].includes(row.state)) return {
    progress: row.state === 'not_sent' ? 'Chưa gửi' : 'Đã chuẩn bị, chưa gửi', shop: 'Chưa tạo link trong đợt này',
    next: row.currentSource && row.currentSource !== 'current'
      ? 'Mở nguồn mới nhất để sửa và chuẩn bị lại.' : 'Kiểm tra dữ liệu rồi tạo link ẩn theo chế độ của đợt.',
  };
  if (row.state === 'blocked' || row.state === 'rejected') return {
    progress: row.state === 'rejected' ? 'Yêu cầu bị từ chối' : 'Cần bổ sung hoặc sửa dữ liệu',
    shop: row.itemId ? 'Đã có mã link; cần đọc lại trạng thái' : 'Chưa xác nhận có link',
    next: 'Xem lý do bên dưới; sửa đúng bộ này rồi kiểm tra lại.',
  };
  return {
    progress: row.state === 'publication_readback_pending' ? 'Đã yêu cầu mở bán, đang xác minh' : 'Đang xác minh kết quả gửi',
    shop: row.itemId ? 'Đã có mã link; trạng thái đang xác minh' : 'Chưa xác định',
    next: 'Chỉ đọc đối chiếu kết quả; không gửi tạo lại khi chưa rõ kết quả.',
  };
}
