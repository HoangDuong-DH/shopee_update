import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, RequestError } from '../../apps/web/src/api.js';

afterEach(() => vi.unstubAllGlobals());
describe('staff-facing request failures', () => {
  it.each([
    ['FOLDER_SOURCE_CHANGED', 'Mở bản đã lưu'],
    ['FOLDER_SOURCE_BINDING_STALE', 'Mở lại bản đã lưu'],
    ['FOLDER_SOURCE_BINDING_INVALID', 'hồ sơ nguồn'],
    ['PENDING_SOURCE_INVALID', 'bảng phân loại'],
    ['PENDING_SOURCE_BINDING_STALE', 'Mở lại đúng bộ đầu vào'],
    ['PENDING_SOURCE_BINDING_INVALID', 'tệp nguồn'],
    ['PENDING_SOURCE_INCOMPLETE', 'xác nhận dùng đủ phân loại'],
    ['PENDING_SOURCE_PRICE_INVALID', 'bộ giá'],
    ['PENDING_SOURCE_IMAGE_INVALID', 'Ảnh đã chọn'],
    ['INPUT_BATCH_PENDING_SOURCE_CHANGED', 'Giữ nguyên nhãn và thứ tự'],
  ])(
    'shows actionable source recovery for %s while ignoring raw payloads',
    async (code, action) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              code,
              message: 'database path or raw response must not be shown',
            }),
            { status: 409 },
          ),
        ),
      );
      const error = await api('/v1/products').catch((reason) => reason);
      if (!(error instanceof RequestError)) throw new Error('Expected a request failure');
      expect(error).toMatchObject({ code, status: 409, message: expect.stringContaining(action) });
      expect(error.message).not.toContain('database path');
    },
  );
  it.each([
    [
      'SELLER_KNOWLEDGE_SCOPE_UNAVAILABLE',
      'Chưa đủ dữ liệu để đối chiếu hoặc kết nối đã thay đổi. Nguồn đã lưu vẫn được giữ; xem trạng thái đồng bộ và thử lại. Chưa thay đổi listing trên Shopee.',
    ],
    [
      'PRODUCTION_EXECUTION_POLICY_SOURCE_CHANGED',
      'Lựa chọn thực thi không còn khớp bộ nguồn. Đọc lại đợt đăng và kiểm tra thông tin trước khi tiếp tục.',
    ],
    [
      'PRODUCTION_PILOT_RECONCILIATION_REQUIRED',
      'Lô này đã có lần gửi. Xem kết quả và đối chiếu trước khi lập phiên bản tiếp theo.',
    ],
    [
      'PRODUCTION_AUTHORIZATION_EXPIRED',
      'Phiên cấp quyền chưa hợp lệ, đang xử lý hoặc đã hết hạn. Tải lại kết nối để kiểm tra.',
    ],
    [
      'PRODUCTION_CONNECTION_UNAVAILABLE',
      'Chưa xác minh được kết nối production. Kiểm tra đúng khóa, token và phiên kết nối.',
    ],
  ])('keeps server-translated operational recovery for %s', async (code, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message }), { status: 409 })),
    );
    await expect(api('/v1/production-batches')).rejects.toMatchObject({
      code,
      message,
      status: 409,
    });
  });
  it.each([
    'PRODUCTION_EXECUTION_POLICY_INVALID',
    'SELLER_KNOWLEDGE_READ_FAILED',
    'PRODUCTION_AUTHORIZATION_INVALID',
  ])('hides raw operational payloads for %s', async (code) => {
    const message = 'unsafe internal server payload';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message }), { status: 409 })),
    );
    const error = await api('/v1/production-batches').catch((reason) => reason);
    if (!(error instanceof RequestError)) throw new Error('Expected a request failure');
    expect(error).toMatchObject({ code, status: 409 });
    expect(error.message).not.toContain(message);
  });
  it.each([
    [
      'PREPARATION_SOURCE_CHANGED',
      'Bộ listing đã có phiên bản mới. Kiểm tra lại nguồn để lập bản xem trước mới.',
    ],
    [
      'PRODUCTION_PREPARATION_AUTH_REQUIRED',
      'Thông tin chưa đủ điều kiện hoặc đã thay đổi. Mở kết quả để xem phần cần xử lý; chưa gửi thêm thay đổi.',
    ],
    [
      'PRODUCTION_BATCH_REVIEW_READBACK_EXPIRED',
      'Kết quả đọc đã cũ. Bấm đọc lại kết quả rồi mở lại phần đối chiếu.',
    ],
  ])('retains translated recovery guidance for %s', async (code, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message }), { status: 409 })),
    );
    await expect(api('/v1/production-preparations')).rejects.toMatchObject({
      code,
      message,
      status: 409,
    });
  });
  it.each([
    ['PRODUCTION_BATCH_INTERNAL', 'server implementation details'],
    ['UNKNOWN_INTERNAL', 'Lỗi nội bộ: server implementation details'],
    ['PREPARATION_SOURCE_CHANGED_INVALID!', 'Nội dung chưa được dịch từ nguồn không xác định'],
  ])(
    'does not expose an untranslated or unknown recovery payload for %s',
    async (code, message) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message }), { status: 409 })),
      );
      await expect(api('/v1/production-preparations')).rejects.toMatchObject({
        message: expect.not.stringContaining(message),
        status: 409,
      });
    },
  );
  it('gives revision conflicts a recovery action', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 'PRODUCT_REVISION_CONFLICT' }), { status: 409 }),
        ),
    );
    await expect(api('/v1/products')).rejects.toMatchObject({
      code: 'PRODUCT_REVISION_CONFLICT',
      message: expect.stringContaining('bản mới nhất'),
    });
  });
  it('does not expose an unknown server payload in the staff message', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ code: 'UNKNOWN_INTERNAL', message: 'server implementation details' }),
            { status: 500 },
          ),
        ),
    );
    await expect(api('/v1/products')).rejects.toMatchObject({
      code: 'UNKNOWN_INTERNAL',
      message: expect.stringContaining('thử lại'),
    });
  });
  it('handles a disconnected request without claiming the write failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api('/v1/products', { method: 'POST' })).rejects.toMatchObject({
      code: 'NETWORK_UNAVAILABLE',
      message: expect.stringContaining('chưa xác nhận'),
    });
  });
  it('handles a non-JSON response without exposing proxy HTML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>proxy failure</html>', { status: 502 })),
    );
    await expect(api('/v1/products')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('keeps cancellation distinct from a network failure', async () => {
    const error = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    await expect(api('/v1/imports')).rejects.toBe(error);
  });
});
