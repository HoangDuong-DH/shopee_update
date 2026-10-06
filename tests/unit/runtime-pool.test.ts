import { afterEach, expect, it, vi } from 'vitest';
import { createRuntimePool } from '../../packages/persistence/src/runtime-pool.js';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('keeps the runtime alive when an idle database connection fails without leaking credentials', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const pool = createRuntimePool({ DATABASE_URL: 'postgres://private:secret@127.0.0.1:5443/fixture' });
  try {
    expect(() => pool.emit('error', new Error('private secret connection payload'))).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/private|secret|payload/);
  } finally { await pool.end(); }
});
it('bounds outage logging and permits the next report after a minute', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const pool = createRuntimePool({});
  try {
    for (let n = 0; n < 1000; n++) pool.emit('error', new Error('outage'));
    expect(log).toHaveBeenCalledTimes(1);
    vi.setSystemTime(60000); pool.emit('error', new Error('outage'));
    expect(log).toHaveBeenCalledTimes(2);
  } finally { await pool.end(); }
});
