import { mkdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertNoLinks } from './onboarding-core.mjs';

export async function readJson(path) {
  await assertNoLinks(path);
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function atomicJson(path, value) {
  await assertNoLinks(path);
  const temp = path + '.' + randomBytes(12).toString('hex') + '.pending';
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
// A stale lock is deliberately not broken using PID liveness alone.
export async function withRuntimeLock(lock, operation, { skipBusy = false } = {}) {
  await assertNoLinks(lock);
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (skipBusy) return { busy: true };
    throw Error('Another launcher or supervisor is active, or its lock needs inspection. No service changed.');
  }
  try {
    await writeFile(resolve(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    return await operation();
  } finally { await unlink(resolve(lock, 'owner.json')).catch(() => {}); await rmdir(lock); }
}
