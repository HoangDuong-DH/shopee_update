import { expect, it, vi } from 'vitest';
import { runtimePoolConfig } from '../../packages/persistence/src/runtime-pool.js';
import { transaction } from '../../packages/persistence/src/db.js';
it('bounds missing database responses after the server cancellation deadline', () => {
  const config=runtimePoolConfig({DB_STATEMENT_TIMEOUT_MS:'1000'});
  expect(config.statement_timeout).toBe(1000);
  expect(config.query_timeout).toBe(6000);
});
it('keeps the original failure and discards the connection when rollback also fails', async () => {
  const original=new Error('Query read timeout');
  const client={query:vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('rollback transport lost')),release:vi.fn()};
  const pool={connect:vi.fn(async()=>client)};
  await expect(transaction(pool as any,async()=>{throw original})).rejects.toBe(original);
  expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
});
it('returns a successful transaction connection to the pool', async()=>{
  const client={query:vi.fn(async()=>({})),release:vi.fn()};
  expect(await transaction({connect:async()=>client} as any,async()=>42)).toBe(42);
  expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
});
