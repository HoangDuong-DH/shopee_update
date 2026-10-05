import type { ShopConnection } from '@shopee/domain';
import { api, post, RequestError } from './api.js';
export type ConnectionAction = 'check' | 'refresh';
export type ConnectionSnapshot = {
  environment: string;
  connectionId: string | null;
  partnerId: string;
  shopId: string;
  connectionRevision: number;
  state: string;
  refreshStatus: string;
  refreshReason: string | null;
  hasSavedKey: boolean;
  tokenExpiresAt: string | null;
  officialName: string | null;
};
export type ConnectionActionResult = { kind: string; code?: string; connectionRevision?: number };
export type ConnectionActionClient = {
  read: (scope: ShopConnection['scope']) => Promise<ConnectionSnapshot>;
  perform: (
    id: string,
    action: ConnectionAction,
    revision: number,
  ) => Promise<ConnectionActionResult>;
};
export type ConnectionActionRow = {
  shop: ShopConnection;
  action: ConnectionAction;
  status:
    | 'ready'
    | 'held'
    | 'reading'
    | 'running'
    | 'success'
    | 'waiting'
    | 'failed'
    | 'unknown'
    | 'cancelled';
  message: string;
  before?: ConnectionSnapshot;
  after?: ConnectionSnapshot;
  completedAt?: string;
};
export const connectionActionClient: ConnectionActionClient = {
  read: (scope) =>
    api(
      '/v1/connections/production?' +
        new URLSearchParams({ partnerId: scope.partnerId, shopId: scope.shopId }),
    ),
  perform: (id, action, expectedRevision) =>
    post(`/v1/connections/${encodeURIComponent(id)}/${action}`, { expectedRevision }),
};
function sameIdentity(shop: ShopConnection, snapshot: ConnectionSnapshot) {
  return (
    snapshot.environment === shop.scope.environment &&
    snapshot.connectionId === shop.id &&
    snapshot.partnerId === shop.scope.partnerId &&
    snapshot.shopId === shop.scope.shopId &&
    Number.isSafeInteger(snapshot.connectionRevision) &&
    snapshot.connectionRevision > 0
  );
}
function eligibility(
  shop: ShopConnection,
  action: ConnectionAction,
  snapshot?: ConnectionSnapshot,
): string | null {
  if (shop.scope.environment !== 'production')
    return 'Giữ riêng shop thử nghiệm: thao tác nhóm này chỉ hỗ trợ shop thật.';
  if (!snapshot) return null;
  if (!sameIdentity(shop, snapshot))
    return 'Thông tin trả về không khớp đúng kết nối, môi trường, ứng dụng và shop đã chọn.';
  if (snapshot.state === 'disconnected' || !snapshot.hasSavedKey)
    return 'Chưa có kết nối và khóa hợp lệ. Mở kết nối shop để bổ sung.';
  if (action === 'refresh') {
    if (snapshot.state === 'refresh_unknown' || snapshot.refreshStatus === 'unknown')
      return 'Lần gia hạn trước chưa rõ kết quả. Giữ riêng để phục hồi bằng chứng trong kết nối shop.';
    if (snapshot.state === 'reauth_required' || snapshot.refreshStatus === 'reauth_required')
      return 'Cần cấp quyền lại cho đúng shop. Giữ riêng khỏi nhóm gia hạn.';
  }
  return null;
}
function readError(error: unknown) {
  return error instanceof RequestError
    ? error.message
    : 'Chưa đọc được trạng thái đã lưu. Giữ riêng shop này; chưa gửi thao tác.';
}
async function pool<T>(rows: T[], work: (row: T, index: number) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, rows.length) }, async () => {
      while (cursor < rows.length) {
        const index = cursor++;
        await work(rows[index]!, index);
      }
    }),
  );
}
/** Reads local server snapshots only. A ready review is not evidence of live Shopee access. */
export async function prepareConnectionActions(
  shops: ShopConnection[],
  action: ConnectionAction,
  client = connectionActionClient,
): Promise<ConnectionActionRow[]> {
  const rows: ConnectionActionRow[] = shops.map((shop) => ({
    shop: structuredClone(shop),
    action,
    status: 'reading',
    message: 'Đang đọc trạng thái đã lưu…',
  }));
  await pool(rows, async (row) => {
    const duplicate = rows.some(
      (other) =>
        other !== row &&
        (other.shop.id === row.shop.id ||
          (other.shop.scope.environment === row.shop.scope.environment &&
            other.shop.scope.partnerId === row.shop.scope.partnerId &&
            other.shop.scope.shopId === row.shop.scope.shopId)),
    );
    const held = duplicate
      ? 'Danh sách có kết nối trùng định danh. Tải lại danh sách và chọn lại.'
      : eligibility(row.shop, action);
    if (held) {
      row.status = 'held';
      row.message = held;
      return;
    }
    try {
      const before = await client.read(row.shop.scope);
      const reason = eligibility(row.shop, action, before);
      row.before = before;
      row.status = reason ? 'held' : 'ready';
      row.message =
        reason ??
        (action === 'check'
          ? 'Sẵn sàng kiểm tra quyền truy cập trực tiếp với Shopee.'
          : 'Sẵn sàng gia hạn qua dịch vụ an toàn; máy chủ kiểm tra khóa và tác vụ đang giữ shop.');
    } catch (error) {
      row.status = 'held';
      row.message = readError(error);
    }
  });
  return rows;
}
const resultMessages: Record<string, string> = {
  CONNECTION_BUSY:
    'Shop đang có thao tác hoặc phiên cấp quyền giữ kết nối. Chưa gia hạn; không tự thử lại.',
  NETWORK_UNAVAILABLE: 'Chưa liên lạc được với Shopee. Giữ chờ; không tự thử lại.',
  SHOP_AUTHORIZATION_UNAVAILABLE:
    'Shopee chưa xác nhận quyền truy cập shop hoạt động. Cần kiểm tra hoặc cấp quyền lại.',
  CREDENTIALS_UNREADABLE: 'Chưa đọc được khóa kết nối đã lưu. Mở kết nối shop để kiểm tra.',
  PRODUCTION_REFRESH_SAVED_CREDENTIALS_INVALID:
    'Khóa hoặc token đã lưu chưa hợp lệ. Mở kết nối shop để cấp quyền lại.',
};
/** One attempt per reviewed row. Waiting and unknown rows are retained and never retried here. */
export async function executeConnectionActions(
  input: ConnectionActionRow[],
  action: ConnectionAction,
  client = connectionActionClient,
  options: {
    shouldStop?: () => boolean;
    onRow?: (row: ConnectionActionRow, index: number) => void;
  } = {},
): Promise<ConnectionActionRow[]> {
  const rows = structuredClone(input);
  const update = (row: ConnectionActionRow, index: number) =>
    options.onRow?.(structuredClone(row), index);
  await pool(rows, async (row, index) => {
    if (row.status !== 'ready') return;
    if (options.shouldStop?.()) {
      row.status = 'cancelled';
      row.message = 'Đã bỏ khỏi hàng chờ; chưa gửi thao tác.';
      update(row, index);
      return;
    }
    row.status = 'reading';
    row.message = 'Đang đối chiếu phiên kết nối trước khi gửi…';
    update(row, index);
    try {
      const fresh = await client.read(row.shop.scope);
      const reason = eligibility(row.shop, action, fresh);
      if (
        row.action !== action ||
        reason ||
        !row.before ||
        fresh.connectionRevision !== row.before.connectionRevision
      ) {
        row.status = 'held';
        row.message =
          reason ?? 'Kết nối hoặc thao tác đã đổi sau lúc rà soát. Rà soát lại trước khi gửi.';
        row.after = fresh;
        update(row, index);
        return;
      }
    } catch (error) {
      row.status = 'held';
      row.message = readError(error);
      update(row, index);
      return;
    }
    if (options.shouldStop?.()) {
      row.status = 'cancelled';
      row.message = 'Đã bỏ khỏi hàng chờ; chưa gửi thao tác.';
      update(row, index);
      return;
    }
    row.status = 'running';
    row.message =
      action === 'check' ? 'Đang kiểm tra trực tiếp với Shopee…' : 'Đang gia hạn kết nối…';
    update(row, index);
    let result: ConnectionActionResult | undefined;
    try {
      result = await client.perform(row.shop.id, action, row.before!.connectionRevision);
      if (result.kind === 'success' || (action === 'refresh' && result.kind === 'already_saved')) {
        row.status = 'success';
        row.message =
          action === 'check'
            ? 'Shopee xác nhận quyền truy cập ở lần kiểm tra này.'
            : 'Dịch vụ đã xác nhận gia hạn và lưu kết nối.';
      } else {
        row.status =
          result.kind === 'waiting' ? 'waiting' : result.kind === 'rejected' ? 'failed' : 'unknown';
        row.message =
          (result.code && resultMessages[result.code]) ||
          (row.status === 'waiting'
            ? 'Máy chủ đang giữ chờ điều kiện an toàn. Không tự thử lại.'
            : row.status === 'failed'
              ? 'Shopee từ chối thao tác. Mở kết nối shop để kiểm tra quyền.'
              : 'Chưa xác nhận được kết quả. Đọc lại trạng thái và bằng chứng trước khi xử lý tiếp.');
      }
    } catch (error) {
      const definite =
        error instanceof RequestError &&
        error.status !== undefined &&
        error.status < 500 &&
        !['REQUEST_TIMEOUT', 'NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code);
      row.status = definite
        ? error.code === 'PRODUCTION_CONNECTION_REVISION_CONFLICT'
          ? 'held'
          : 'failed'
        : 'unknown';
      row.message = definite
        ? error.message
        : 'Mất phản hồi hoặc chưa rõ kết quả. Không gửi lại; đọc trạng thái và mở kết nối shop để đối chiếu bằng chứng.';
    }
    try {
      const after = await client.read(row.shop.scope);
      if (!sameIdentity(row.shop, after)) throw Error('SCOPE_MISMATCH');
      row.after = after;
      if (row.status === 'success') {
        const expected =
          action === 'refresh' ? result?.connectionRevision : row.before!.connectionRevision;
        if (
          !Number.isSafeInteger(expected) ||
          after.connectionRevision !== expected ||
          (action === 'refresh' && expected !== row.before!.connectionRevision + 1)
        ) {
          row.status = 'unknown';
          row.message =
            'Phản hồi thành công nhưng phiên đọc lại chưa khớp. Giữ riêng để đối chiếu; không gửi lại.';
        } else if (
          action === 'check' &&
          (after.refreshStatus === 'unknown' || after.state === 'refresh_unknown')
        )
          row.message += ' Lần gia hạn trước vẫn chưa rõ kết quả và được giữ nguyên.';
      }
    } catch {
      if (row.status === 'success') row.status = 'unknown';
      row.message +=
        ' Chưa đọc lại được đúng kết nối sau thao tác; cần đối chiếu trước khi làm tiếp.';
    }
    row.completedAt = new Date().toISOString();
    update(row, index);
  });
  return rows;
}
