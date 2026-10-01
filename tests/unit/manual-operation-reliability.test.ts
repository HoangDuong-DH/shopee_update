import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../apps/web/src/api.js';
import { belongsToOperationShop, batchOperationMarker, listingOperationView } from '../../apps/web/src/batch-operation-view.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('manual operation request deadline', () => {
  it.each([
    ['PRODUCTION_BATCH_SCOPE_MISMATCH', 'không thuộc shop đang chọn'],
    ['PASS1_CAPABILITY_SETUP_REQUIRED', 'chưa hoàn tất kiểm tra khả năng'],
    ['PREPARATION_PARTIAL_REVIEW_REQUIRED', 'còn đợt cần sửa hoặc đối chiếu riêng'],
  ])('shows an actionable operation error for %s without raw server details', async (code, action) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message: 'Raw internal data' }), { status: 409 })));
    await expect(api('/v1/production-batches')).rejects.toMatchObject({ code, message: expect.stringContaining(action) });
  });
  it('bounds a pending write without resending or claiming the server cancelled it', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    const outcome = api('/v1/production-batches/a/run', { method: 'POST', timeoutMs: 50 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toMatchObject({ code: 'REQUEST_TIMEOUT', message: expect.stringContaining('không hủy tác vụ') });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: expect.objectContaining({ aborted: true }) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds a stalled body after HTTP headers arrived', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) }));
    const outcome = api('/v1/production-batches', { timeoutMs: 50 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });

  it('preserves caller cancellation while consuming a stalled body', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) }));
    const outcome = api('/v1/production-batches', { signal: controller.signal }).catch(error => error);
    await Promise.resolve();
    const reason = new DOMException('Leaving this shop', 'AbortError');
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not send a request already cancelled by the caller', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const signal = AbortSignal.abort(new DOMException('Aborted', 'AbortError'));
    await expect(api('/v1/production-batches', { signal })).rejects.toBe(signal.reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears the deadline after a successful read', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"batches":[]}')));
    await expect(api('/v1/production-batches')).resolves.toEqual({ batches: [] });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('shop scoped operation display', () => {
  const scope = { partnerId: '2010476', shopId: '1126307464' };
  it('rejects a different shop, partner or a response lacking scope even without a recovery request', () => {
    const values = [scope, { ...scope, shopId: '1423724897' }, { ...scope, partnerId: 'other' }, { shopId: scope.shopId }];
    expect(values.filter(value => belongsToOperationShop(value, scope))).toEqual([scope]);
    expect(batchOperationMarker(scope, 'batch')).not.toBe(batchOperationMarker({ ...scope, shopId: '1423724897' }, 'batch'));
  });
  it('never infers hidden state or QC completion from an item ID alone', () => {
    expect(listingOperationView({ state: 'created_readback_pending', itemId: '123' })).toMatchObject({
      shop: 'Đã có mã link; trạng thái đang xác minh', next: expect.stringContaining('không gửi tạo lại'),
    });
    expect(listingOperationView({ state: 'created_hidden_image_qc_deferred', itemId: '123' })).toMatchObject({
      shop: 'Đang ẩn', next: expect.stringContaining('QC ảnh'),
    });
    expect(listingOperationView({ state: 'created_unlisted' }).next).toContain('QC nội dung');
  });
  it('keeps exclusion and source changes separate from a completed listing', () => {
    expect(listingOperationView({ state: 'excluded', excluded: true }).shop).toContain('Chưa gửi');
    expect(listingOperationView({ state: 'not_sent', currentSource: 'source_changed' }).next).toContain('nguồn mới nhất');
    expect(listingOperationView({ state: 'publication_readback_pending', itemId: '123' }).shop).not.toBe('Đã mở bán');
  });
});
