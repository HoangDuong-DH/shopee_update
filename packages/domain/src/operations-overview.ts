import { z } from 'zod';
import type { Environment } from './contracts.js';

export type OperationsScope = { environment: Environment; partnerId: string; shopId: string };
const identifier = z.string().regex(/^[1-9]\d*$/).refine(value => Number.isSafeInteger(Number(value)));
export const operationsOverviewQuerySchema = z.object({
  environment: z.enum(['sandbox', 'production']).optional(),
  partnerId: identifier.optional(), shopId: identifier.optional(),
}).strict().refine(value => {
  const supplied = [value.environment, value.partnerId, value.shopId].filter(value => value !== undefined).length;
  return supplied === 0 || supplied === 3;
}, { message: 'A shop filter requires environment, partnerId and shopId together.' });

/** Unavailable data remains null; zero always means a successful count. */
export type OperationsSource<T> = {
  state: 'available' | 'unavailable'; observedAt: string; data: T | null; code: string | null;
};
export type OperationsRuntime = {
  productionWorkflowEnabled: boolean;
  /** Literal server setting; the existing pilot transport does not use this as a universal write gate. */
  productionWritesConfigured: boolean;
  connectionMaintenanceEnabled: boolean; isolatedMode: boolean;
  executionReadiness: 'not_assessed'; executor: 'api_coordinator';
};
export type OperationsConnectionHealth = {
  id: string; name: string; scope: OperationsScope; revision: number;
  state: 'connected' | 'disconnected' | 'reauth_required' | 'refresh_unknown' | 'unknown';
  tokenState: 'valid' | 'expiring' | 'expired' | 'missing' | 'unknown'; tokenExpiresAt: string | null;
  health: {
    state: 'fresh' | 'stale' | 'never_checked' | 'unknown'; checkedAt: string | null;
    /** Freshness of a recorded check is separate from its outcome. No new check is performed. */
    outcome: 'healthy' | 'attention' | 'unknown';
  };
  refreshState: 'idle' | 'waiting' | 'running' | 'healthy' | 'reauth_required' | 'unknown'; autoRefresh: boolean;
};
export type OperationsBlocker = {
  code: string; severity: 'block' | 'attention'; source: string; message: string; nextAction: string;
  route: { page: 'shops' | 'products' | 'workbench' | 'production' | 'results' | 'guide'; apiPath: string };
  scope?: OperationsScope; connectionId?: string; count?: number;
};
export type OperationsOverview = {
  observedAt: string; scope: OperationsScope | null; status: 'ok' | 'degraded'; runtime: OperationsRuntime;
  database: OperationsSource<{ schemaReady: boolean }>;
  worker: OperationsSource<{ state: 'online' | 'offline'; lastSeenAt: string | null; freshnessSeconds: 15 }>;
  connections: OperationsSource<{ items: OperationsConnectionHealth[]; total: number; truncated: boolean }>;
  counts: {
    /** Imports and drafts belong to the shared source workspace, even when filtering shop work. */
    sourceScope: 'workspace'; workScope: 'workspace' | 'selected_shop';
    imports: OperationsSource<{ total: number; queued: number; running: number; ready: number; failed: number; expiredLeases: number }>;
    drafts: OperationsSource<{ active: number; archived: number }>;
    workOrders: OperationsSource<{ total: number; unassigned: number; sourceChanged: number }>;
    batches: OperationsSource<{
      preparations: number; registered: number; held: number; unscopedPreparations: number;
      /** Stored execution states are diagnostic records, not proof that a coordinator is alive. */
      executionRunning: number; executionPaused: number; completed: number;
      operationsUnknown: number; operationsSent: number; waitingQc: number;
      /** Legacy batches registered only on disk are intentionally not counted here. */
      basis: 'database_preparations_and_journal';
    }>;
  };
  blockers: OperationsBlocker[];
};
