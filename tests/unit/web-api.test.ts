import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../apps/web/src/api.js';

afterEach(() => vi.unstubAllGlobals());
describe('staff-facing request failures', () => {
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
