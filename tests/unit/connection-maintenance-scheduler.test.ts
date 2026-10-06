import {it,expect,vi,afterEach} from 'vitest';
import {startConnectionMaintenance,type ConnectionMaintenance} from '../../apps/api/src/connection-maintenance.js';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
it('renewal is independent of paused publishing and has no overlapping ticks',async()=>{
 vi.useFakeTimers();vi.stubEnv('CONNECTION_MAINTENANCE_ENABLED','1');vi.stubEnv('INTERNAL_ISOLATED_MODE','0');vi.stubEnv('SHOPEE_PRODUCTION_WRITES','false');vi.stubEnv('PRODUCTION_PILOT_ENABLED','0');
 let release:()=>void=()=>{};const tick=vi.fn(()=>new Promise<void>(r=>{release=r}));const stop=startConnectionMaintenance({tick} as unknown as ConnectionMaintenance);
 expect(tick).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(120000);expect(tick).toHaveBeenCalledTimes(1);release();await Promise.resolve();await Promise.resolve();await vi.advanceTimersByTimeAsync(60000);expect(tick).toHaveBeenCalledTimes(2);release();await stop();await vi.advanceTimersByTimeAsync(60000);expect(tick).toHaveBeenCalledTimes(2);
});
it.each([undefined,'0','true','unexpected'])('requires explicit enabled flag (%s)',async value=>{
 vi.stubEnv('CONNECTION_MAINTENANCE_ENABLED',value);vi.stubEnv('INTERNAL_ISOLATED_MODE','0');const tick=vi.fn(async()=>{});await startConnectionMaintenance({tick} as unknown as ConnectionMaintenance)();expect(tick).not.toHaveBeenCalled();
});
it('isolated mode overrides explicit opt-in',async()=>{vi.stubEnv('CONNECTION_MAINTENANCE_ENABLED','1');vi.stubEnv('INTERNAL_ISOLATED_MODE','1');const tick=vi.fn(async()=>{});await startConnectionMaintenance({tick} as unknown as ConnectionMaintenance)();expect(tick).not.toHaveBeenCalled();});
