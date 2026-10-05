import type {
  OperationsBlocker,
  OperationsConnectionHealth,
  OperationsScope,
  OperationsOverview,
} from '@shopee/domain';

export type OperationsIssueGroup = {
  key: string;
  connectionId: string;
  scope: OperationsScope;
  name: string;
  severity: OperationsBlocker['severity'];
  issues: OperationsBlocker[];
};

/** Names and grouping must share the complete identity; a Shop ID alone is not a connection. */
export function operationsConnectionKey(id: string, scope: OperationsScope) {
  return JSON.stringify([id, scope.environment, scope.partnerId, scope.shopId]);
}

export function presentOperationsIssues(
  blockers: OperationsBlocker[],
  connections: OperationsConnectionHealth[] = [],
) {
  const names = new Map(
    connections.map((connection) => [
      operationsConnectionKey(connection.id, connection.scope),
      connection.name,
    ]),
  );
  const groups = new Map<string, OperationsIssueGroup>();
  const tasks: OperationsBlocker[] = [];
  for (const issue of blockers) {
    if (!issue.connectionId || !issue.scope) {
      tasks.push(issue);
      continue;
    }
    const key = operationsConnectionKey(issue.connectionId, issue.scope);
    const existing = groups.get(key);
    if (existing) {
      existing.issues.push(issue);
      if (issue.severity === 'block') existing.severity = 'block';
    } else {
      groups.set(key, {
        key,
        connectionId: issue.connectionId,
        scope: issue.scope,
        name: names.get(key)?.trim() || `Shop ${issue.scope.shopId}`,
        severity: issue.severity,
        issues: [issue],
      });
    }
  }
  // Sorting a copy preserves the response and every issue's original count and route.
  const prioritize = (
    a: { severity: OperationsBlocker['severity'] },
    b: { severity: OperationsBlocker['severity'] },
  ) => Number(b.severity === 'block') - Number(a.severity === 'block');
  return {
    tasks: tasks.sort(prioritize),
    connections: [...groups.values()]
      .sort(prioritize)
      .map((group) => ({ ...group, issues: [...group.issues].sort(prioritize) })),
  };
}

export type ConnectionIndicator = {
  label: string;
  icon: 'clock' | 'key' | 'help' | 'history' | 'alert';
  tone: 'danger' | 'warning';
};
/** Presentation of known API reason codes, never inference from shop names or token age. */
export function connectionIndicator(issues: OperationsBlocker[]): ConnectionIndicator {
  const codes = new Set(issues.map((issue) => issue.code));
  if (codes.has('CONNECTION_TOKEN_UNKNOWN'))
    return { label: 'Chưa xác minh', icon: 'help', tone: 'warning' };
  if (codes.has('CONNECTION_TOKEN_MISSING'))
    return { label: 'Chưa cấp quyền', icon: 'key', tone: 'danger' };
  if (codes.has('CONNECTION_TOKEN_EXPIRED'))
    return { label: 'Hết hạn', icon: 'clock', tone: 'danger' };
  if (codes.has('CONNECTION_NOT_CONNECTED'))
    return { label: 'Cần kết nối', icon: 'key', tone: 'danger' };
  if (codes.has('CONNECTION_TOKEN_EXPIRING'))
    return { label: 'Sắp hết hạn', icon: 'clock', tone: 'warning' };
  if (codes.has('CONNECTION_CHECK_NEEDS_ATTENTION'))
    return { label: 'Cần xử lý', icon: 'alert', tone: 'warning' };
  if (codes.has('CONNECTION_HEALTH_NOT_FRESH'))
    return { label: 'Cần kiểm tra lại', icon: 'history', tone: 'warning' };
  return { label: 'Cần xử lý', icon: 'alert', tone: issues.some((issue) => issue.severity === 'block') ? 'danger' : 'warning' };
}
export function connectionIndicatorCounts(groups: OperationsIssueGroup[]) {
  const counts = new Map<string, { indicator: ConnectionIndicator; count: number }>();
  for (const group of groups) {
    const indicator = connectionIndicator(group.issues);
    const key = JSON.stringify([indicator.label, indicator.icon, indicator.tone]);
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { indicator, count: 1 });
  }
  return [...counts.values()];
}


export type ProductionWorkFilter = 'active' | 'all' | 'ready' | 'qc' | 'held' | 'paused';
export type OperationsNextAction = { label: string; page: OperationsBlocker['route']['page']; view?: 'working' | 'new'; filter?: ProductionWorkFilter };
export function operationNextAction(blocker: OperationsBlocker): OperationsNextAction {
  if (blocker.connectionId) return {label:'Mở kết nối',page:'shops'};
  if (blocker.code === 'PRODUCTION_WORKFLOW_DISABLED' || blocker.code === 'PRODUCTION_WRITE_FLAGS_DIFFER')
    return {label:'Xem luồng đăng',page:'production',view:'working',filter:'active'};
  if (blocker.code === 'PREPARATIONS_HELD') return {label:'Xem nguồn cần bổ sung',page:'production',view:'new',filter:'all'};
  if (blocker.code === 'PREPARATIONS_PAUSED') return {label:'Xem đợt tạm dừng',page:'production',view:'working',filter:'paused'};
  if (['PRODUCTION_QC_PENDING','PRODUCTION_OUTCOME_UNKNOWN','PRODUCTION_REQUEST_SENT'].includes(blocker.code))
    return {label:'Đối chiếu listing',page:'production',view:'working',filter:'qc'};
  return {label: blocker.route.page === 'guide' ? 'Xem hướng dẫn' : blocker.route.page === 'products' ? 'Mở bộ nguồn' : blocker.route.page === 'workbench' ? 'Mở công việc' : 'Xem chi tiết',page:blocker.route.page};
}
export function operationsDataUnavailable(value: OperationsOverview) {
  return [value.database,value.worker,value.connections,value.counts.imports,value.counts.drafts,value.counts.workOrders,value.counts.batches].some(part => part.state === 'unavailable');
}
export function readProductionWorkFilter(search: string): ProductionWorkFilter {
  const value = new URLSearchParams(search).get('work');
  return ['active','all','ready','qc','held','paused'].includes(value ?? '') ? value as ProductionWorkFilter : 'active';
}
