import {describe,it,expect,vi} from 'vitest';
import {pendingRead} from '../../apps/web/src/pending-read.js';
describe('concurrent metadata reads',()=>{
  it('shares one in-flight request for identical queries but refreshes after completion',async()=>{
    const pending=new Map<string,Promise<number>>();let resolve!:(v:number)=>void;
    const read=vi.fn(()=>new Promise<number>(done=>resolve=done));
    const a=pendingRead(pending,'shop:category',read),b=pendingRead(pending,'shop:category',read);
    await Promise.resolve();expect(read).toHaveBeenCalledTimes(1);expect(a).toBe(b);
    resolve(7);expect(await a).toBe(7);expect(pending.size).toBe(0);
    expect(await pendingRead(pending,'shop:category',async()=>8)).toBe(8);
  });
  it('does not share different scopes or retain a rejected request',async()=>{
    const pending=new Map<string,Promise<number>>();
    const failed=pendingRead(pending,'shop1',async()=>{throw Error('network');});
    expect(await pendingRead(pending,'shop2',async()=>2)).toBe(2);
    await expect(failed).rejects.toThrow('network');
    expect(await pendingRead(pending,'shop1',async()=>3)).toBe(3);
  });
});
