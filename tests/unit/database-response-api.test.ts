import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { BlobStore } from '../../packages/persistence/src/blob-store.js';
let app:Awaited<ReturnType<typeof createApp>>;
const repo={pool:{},listProductsPage:vi.fn(async()=>{throw Error('Query read timeout')})};
beforeAll(async()=>{app=await createApp(repo as any,new BlobStore('.local/no-storage-write'),['http://localhost:5273']);await app.getHttpAdapter().getInstance().ready();});
afterAll(async()=>{await app?.close();});
it('explains a lost database response as unavailable and requires checking state before retry',async()=>{
 const response=await app.getHttpAdapter().getInstance().inject({method:'GET',url:'/v1/products'});
 expect(response.statusCode).toBe(503);
 expect(response.json()).toMatchObject({code:'DATABASE_REQUEST_TIMEOUT',message:expect.stringContaining('Đọc lại trạng thái')});
 expect(response.payload).not.toContain('Query read timeout');
});
