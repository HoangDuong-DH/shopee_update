import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadWorkbook } from '../../apps/web/src/download.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('workbook report download', () => {
  it('bounds a response whose body never finishes and does not retry', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), blob: () => new Promise(() => {}) });
    vi.stubGlobal('fetch', fetcher);
    const result = downloadWorkbook('/report.xlsx', undefined, 50);
    const rejected = expect(result).rejects.toMatchObject({ code: 'REPORT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it('rejects an HTML or JSON success response instead of saving it as Excel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
    await expect(downloadWorkbook('/report.xlsx')).rejects.toMatchObject({ code: 'REPORT_INVALID_RESPONSE' });
  });
  it('cancels before fetch when its owning page has already closed', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const owner = new AbortController(); owner.abort();
    await expect(downloadWorkbook('/report.xlsx', owner.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
