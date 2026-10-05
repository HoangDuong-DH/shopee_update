import { useEffect, useRef } from 'react';
import { subscribeWorkspaceDataChanges, type WorkspaceDataResource } from './workspace-data-updates.js';
/** Refresh saved projections only. Never dispatch or retry a platform operation. */
export function useWorkspaceDataUpdates(load: () => void | Promise<void>, resources: WorkspaceDataResource[], busy = false) {
  const latest = useRef({load, busy, resources}); latest.current = {load, busy, resources};
  const dirty = useRef(false);
  const flush = useRef<() => void>(() => {});
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      dirty.current = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.hidden || latest.current.busy) return;
        dirty.current = false; void latest.current.load();
      }, 120);
    };
    flush.current = update;
    const unsubscribe = subscribeWorkspaceDataChanges(resource => {
      if (resource === 'workspace' || latest.current.resources.includes(resource) || latest.current.resources.includes('workspace')) update();
    });
    const visible = () => { if (!document.hidden) update(); };
    const interval = setInterval(visible,30_000);
    window.addEventListener('focus',visible); document.addEventListener('visibilitychange',visible);
    return () => { unsubscribe(); clearInterval(interval); if(timer) clearTimeout(timer);
      window.removeEventListener('focus',visible); document.removeEventListener('visibilitychange',visible); };
  }, []);
  useEffect(() => { if (!busy && dirty.current) flush.current(); },[busy]);
}
