export type WorkspaceDataResource = 'connections' | 'sources' | 'production' | 'workspace';
const resources = new Set(['connections','sources','production','workspace']);
const listeners = new Set<(resource: WorkspaceDataResource) => void>();
let channel: BroadcastChannel | undefined;
function broadcast() {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  if (!channel) {
    try { channel = new BroadcastChannel('listing-studio-data-v1'); } catch { return; }
    channel.onmessage = event => {
      const value = event.data;
      if (value?.version === 1 && resources.has(value.resource))
        for (const listener of listeners) { try { listener(value.resource); } catch { /* A view cannot affect the write. */ } }
    };
  }
  return channel;
}
export function dataChangeResource(path: string, method = 'GET'): WorkspaceDataResource | null {
  if (['GET','HEAD','OPTIONS'].includes(method.toUpperCase()) || !path.startsWith('/v1/')) return null;
  const root = path.split('/')[2]?.split('?')[0];
  if (['connections','shops'].includes(root ?? '')) return 'connections';
  if (['products','imports','input-batches','pricebooks','local-library'].includes(root ?? '')) return 'sources';
  if (root?.startsWith('production-') || ['image-qc','prepared-batches'].includes(root ?? '')) return 'production';
  return 'workspace';
}
/** Only a data-domain signal travels between tabs; no payload, IDs or credentials. */
export function notifyWorkspaceDataChange(resource: WorkspaceDataResource) {
  if (typeof window === 'undefined') return;
  for (const listener of listeners) { try { listener(resource); } catch { /* Preserve the request outcome. */ } }
  try { broadcast()?.postMessage({version:1,resource}); } catch { /* Poll/focus remain available. */ }
}
export function subscribeWorkspaceDataChanges(listener: (resource: WorkspaceDataResource) => void) {
  listeners.add(listener); broadcast();
  return () => { listeners.delete(listener); };
}
