import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

/** A restored journal is never sufficient authorization to resume its jobs. */
export function transferRecoveryRequired(root = process.cwd()): boolean {
  try {
    const stat = lstatSync(resolve(root, '.local/onboarding/transfer-hold.json'));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('TRANSFER_HOLD_INVALID');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function recoveryRequestBlocked(method: string, value: string): boolean {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return true;
  try {
    const path = decodeURIComponent(new URL(value, 'http://127.0.0.1').pathname);
    // Callback and status views can change or expire staged credentials.
    return /\/callback\/?$/i.test(path)
      || /\/connections\/production-pilot\/authorization(?:-result)?(?:\/|$)/i.test(path);
  } catch { return true; }
}

export function installRecoveryFetchGuard(): () => void {
  const original = globalThis.fetch;
  const guarded: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password) throw new Error('TRANSFER_EXTERNAL_REQUEST_BLOCKED');
    const response = await original(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) throw new Error('TRANSFER_REDIRECT_BLOCKED');
    return response;
  };
  globalThis.fetch = guarded;
  return () => { if (globalThis.fetch === guarded) globalThis.fetch = original; };
}