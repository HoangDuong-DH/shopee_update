import type { DraftField, ListingDraft, ShopConnection } from './contracts.js';
import type { SandboxRun } from './sandbox-listing.js';

export type WorkIssueKind =
  'missing_source' | 'mapping_needed' | 'connection' | 'unsupported' | 'conflict';
export type WorkIssue = {
  code: string;
  kind: WorkIssueKind;
  field: string;
  message: string;
  action: string;
};
export type WorkOrderConfig = {
  productKey: string;
  sourceRevision: number;
  connectionId: string | null;
  operation: 'create' | 'update';
  itemId: string | null;
  fieldMask: DraftField[];
  stocks: Record<string, number>;
};
export type WorkOrder = {
  id: string;
  revision: number;
  config: WorkOrderConfig;
  createdAt: string;
  updatedAt: string;
};
export type WorkOrderView = WorkOrder & {
  source: ListingDraft;
  shop: ShopConnection | null;
  latestSourceRevision: number;
  issues: WorkIssue[];
  state: 'needs_attention' | 'ready_to_check';
  /** Active target recovery takes priority, even when it belongs to an older source revision. */
  sandboxRun: SandboxRun | null;
  /** Current-state evidence; it does not change the original run's historical QC result. */
  sandboxReconciliation?: { id: string; verifiedAt: string };
  sandboxRunMatchesConfig: boolean;
};
export type Workbench = {
  orders: WorkOrderView[];
  sources: ListingDraft[];
  shops: ShopConnection[];
  execution: { productionWrites: false; sandboxUpdates: boolean; createEnabled: boolean };
};
