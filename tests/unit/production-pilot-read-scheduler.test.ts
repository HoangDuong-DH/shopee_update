import { it, expect, vi } from 'vitest';
import { readProductionPilotWithBackoff, ProductionPilotReadPacer } from '../../apps/api/src/production-pilot-read-scheduler.js';
const rateLimit = { kind: 'rejected', code: 'error_rate_limit', requestId: 'rate-1', envelope: { error: 'error_rate_limit' } } as const;
const success = { kind: 'success', requestId: 'ok-1', envelope: { response: {} }, response: {} } as const;
function clock(){let now=0;const pause=vi.fn(async(ms:number)=>{now+=ms;});return{pause,pacer:new ProductionPilotReadPacer({now:()=>now}),advance:(ms:number)=>{now+=ms;}};}
it('retains rate-limit evidence before bounded backoff, without sleeping before the first request', async () => {
  const timing=clock();
  const read = vi.fn().mockResolvedValueOnce(rateLimit).mockResolvedValue(success), pause = vi.fn(), records: any[] = [];
  expect(await readProductionPilotWithBackoff({ read }, '/api/v2/product/get_item_base_info', { item_id_list: '7' },
    async (r, a) => { records.push([r, a]); }, timing.pause,timing.pacer)).toEqual(success);
  expect(timing.pause.mock.calls).toEqual([[1000]]);
  expect(read.mock.calls).toEqual(Array(2).fill(['/api/v2/product/get_item_base_info', { item_id_list: '7' }]));
  expect(records).toEqual([[rateLimit, 0], [success, 1]]);
});
it('returns the rate limit after a bounded four reads and preserves all rejections', async () => {
  const timing=clock();
  const read = vi.fn().mockResolvedValue(rateLimit), record = vi.fn(), pause = vi.fn();
  expect(await readProductionPilotWithBackoff({ read }, '/api/v2/shop/get_shop_info', {}, record, timing.pause,timing.pacer)).toEqual(rateLimit);
  expect(read).toHaveBeenCalledTimes(4); expect(record).toHaveBeenCalledTimes(4);
  expect(timing.pause.mock.calls).toEqual([[1000], [3000], [7000]]);
});
it.each([
  { ...rateLimit, code: 'error_auth' },
  { ...rateLimit, envelope: { error: 'different_error' } },
  { ...rateLimit, requestId: undefined },
  { kind: 'unknown', code: 'PRODUCTION_PILOT_TRANSPORT' },
])('does not retry ambiguous or non-rate-limit outcomes %#', async (outcome) => {
  const read = vi.fn().mockResolvedValue(outcome);
  const timing=clock();await readProductionPilotWithBackoff({ read }, '/api/v2/shop/get_shop_info', {}, vi.fn(), timing.pause,timing.pacer);
  expect(read).toHaveBeenCalledTimes(1);
});
it('does not retry when evidence cannot be saved', async () => {
  const read = vi.fn().mockResolvedValue(rateLimit);
  const timing=clock();await expect(readProductionPilotWithBackoff({ read }, '/api/v2/shop/get_shop_info', {}, async () => { throw Error('disk'); }, timing.pause,timing.pacer)).rejects.toThrow('disk');
  expect(read).toHaveBeenCalledTimes(1);
});
it('accounts for network time in a conservative per-process read start budget',async()=>{const t=clock();await t.pacer.acquire(t.pause);expect(t.pause).not.toHaveBeenCalled();t.advance(200);await t.pacer.acquire(t.pause);expect(t.pause.mock.calls).toEqual([[300]]);t.advance(600);await t.pacer.acquire(t.pause);expect(t.pause.mock.calls).toEqual([[300]]);});
it('serializes concurrent read starts and cannot configure faster than the existing internal 2-per-second budget',async()=>{const t=clock();await Promise.all(Array.from({length:4},()=>t.pacer.acquire(t.pause)));expect(t.pause.mock.calls).toEqual([[500],[500],[500]]);expect(()=>new ProductionPilotReadPacer({minimumIntervalMs:100})).toThrow();});
