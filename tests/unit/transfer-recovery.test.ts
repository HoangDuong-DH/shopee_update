import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transferRecoveryRequired, recoveryRequestBlocked, installRecoveryFetchGuard } from '../../packages/persistence/src/transfer-recovery.js';
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const p of dirs.splice(0)) await rm(p, { recursive:true,force:true }); });
describe('restored data recovery boundary', () => {
  it('holds even a malformed journal marker so a manual worker start cannot consume old queues', async () => {
    const root=await mkdtemp(join(tmpdir(),'listingstudio-transfer-mode-')); dirs.push(root);
    expect(transferRecoveryRequired(root)).toBe(false);
    await mkdir(join(root,'.local/onboarding'),{recursive:true});
    await writeFile(join(root,'.local/onboarding/transfer-hold.json'),'incomplete');
    expect(transferRecoveryRequired(root)).toBe(true);
  });
  it.each(['POST','PUT','PATCH','DELETE','CONNECT','TRACE'])('blocks %s before any route side effect', method => {
    expect(recoveryRequestBlocked(method,'/v1/imports')).toBe(true);
  });
  it.each(['GET','HEAD','OPTIONS'])('keeps %s browsing available', method => {
    expect(recoveryRequestBlocked(method,'/v1/products')).toBe(false);
  });
  it.each(['/v1/connections/production-pilot/callback?code=private','/v1/connections/production-pilot/%63allback/'])('blocks credential-changing GET callback %s', url => {
    expect(recoveryRequestBlocked('GET',url)).toBe(true);
    expect(recoveryRequestBlocked('HEAD',url)).toBe(true);
  });
  it.each(['/v1/connections/production-pilot/authorization/attempt-id', '/v1/connections/production-pilot/authorization-result/attempt-id', '/v1/connections/production-pilot/%61uthorization/attempt-id/'])('blocks authorization status reads that expire staged credentials %s', url => {
    expect(recoveryRequestBlocked('GET', url)).toBe(true);
    expect(recoveryRequestBlocked('HEAD', url)).toBe(true);
  });
  it('blocks remote reads and redirects without contacting Shopee', async () => {
    const original=vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch',original); const restore=installRecoveryFetchGuard();
    try {
      await expect(fetch('https://partner.shopeemobile.com/api/v2/product/get_item_list')).rejects.toThrow('TRANSFER_EXTERNAL_REQUEST_BLOCKED');
      expect(original).not.toHaveBeenCalled();
      await fetch('http://127.0.0.1:4310/health/ready');
      expect(original.mock.calls[0]).toEqual(['http://127.0.0.1:4310/health/ready',{redirect:'manual'}]);
      original.mockImplementationOnce(async () => new Response(null,{status:302,headers:{location:'https://partner.shopeemobile.com'}}));
      await expect(fetch('http://localhost:4310/redirect')).rejects.toThrow('TRANSFER_REDIRECT_BLOCKED');
    } finally { restore(); }
    expect(globalThis.fetch).toBe(original);
  });
});