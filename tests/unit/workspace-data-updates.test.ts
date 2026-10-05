import { afterEach, expect, it, vi } from 'vitest';
import { dataChangeResource, notifyWorkspaceDataChange, subscribeWorkspaceDataChanges } from '../../apps/web/src/workspace-data-updates.js';
import { api } from '../../apps/web/src/api.js';
afterEach(() => vi.unstubAllGlobals());
it('maps writes to data domains without exposing IDs, queries or payloads', () => {
  expect(dataChangeResource('/v1/connections/production-pilot/a/refresh?secret=hidden','POST')).toBe('connections');
  expect(dataChangeResource('/v1/products/key','PUT')).toBe('sources');
  expect(dataChangeResource('/v1/production-batches/id/run','POST')).toBe('production');
  expect(dataChangeResource('/v1/shops','GET')).toBeNull();
  expect(dataChangeResource('https://foreign.example/v1/shops','POST')).toBeNull();
});
it('notifies readers after a write succeeds or becomes uncertain, never for GET', async () => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('BroadcastChannel', undefined);
  const events: string[] = [];
  const stop = subscribeWorkspaceDataChanges(resource => events.push(resource));
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async () => new Response('{}',{status:200})));
  await api('/v1/shops');
  expect(events).toEqual([]);
  await api('/v1/connections/production-pilot/a/check',{method:'POST'});
  expect(events).toEqual(['connections']);
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(Error('lost reply')));
  await expect(api('/v1/production-batches/id/run',{method:'POST'})).rejects.toThrow();
  expect(events).toEqual(['connections','production']);
  stop(); notifyWorkspaceDataChange('sources'); expect(events).toHaveLength(2);
});


it('a failing UI subscriber cannot turn an acknowledged write into a request failure', async () => {
  vi.stubGlobal('window',{}); vi.stubGlobal('BroadcastChannel',undefined);
  const stop = subscribeWorkspaceDataChanges(() => {throw Error('broken view');});
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async () => new Response('{"saved":true}',{status:200})));
  try { await expect(api('/v1/products/key',{method:'PUT'})).resolves.toEqual({saved:true}); } finally {stop();}
});


it('accepts cross-tab domain signals and ignores unknown or raw payloads', () => {
  vi.stubGlobal('window',{});
  let handler: ((event: {data:unknown}) => void) | null = null;
  class FakeChannel { set onmessage(value: typeof handler) {handler=value;} postMessage() {} }
  vi.stubGlobal('BroadcastChannel',FakeChannel);
  const events: string[] = [];
  const stop = subscribeWorkspaceDataChanges(resource => events.push(resource));
  const deliver = (data: unknown) => (handler as unknown as (event:{data:unknown})=>void)({data});
  deliver({version:1,resource:'connections'}); deliver({version:2,resource:'sources'}); deliver({version:1,resource:'secret'});
  expect(events).toEqual(['connections']); stop();
});
