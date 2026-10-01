import {
  operationsOverviewQuerySchema, type OperationsBlocker, type OperationsConnectionHealth,
  type OperationsOverview, type OperationsRuntime, type OperationsScope, type OperationsSource,
} from '@shopee/domain';
import type { Repository } from '@shopee/persistence';

const healthFreshnessMs = 15 * 60_000, tokenExpiringMs = 10 * 60_000, connectionLimit = 100;
const date = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
const count = (value: unknown): number => {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(number) || number < 0)
    throw Error('OPERATIONS_COUNT_INVALID');
  return number;
};

export function operationsRuntime(env: NodeJS.ProcessEnv = process.env): OperationsRuntime {
  const isolatedMode = env.INTERNAL_ISOLATED_MODE === '1';
  return {
    productionWorkflowEnabled: env.PRODUCTION_PILOT_ENABLED === '1',
    productionWritesConfigured: env.SHOPEE_PRODUCTION_WRITES === 'true',
    connectionMaintenanceEnabled: env.CONNECTION_MAINTENANCE_ENABLED !== '0' && !isolatedMode,
    isolatedMode, executionReadiness: 'not_assessed', executor: 'api_coordinator',
  };
}

/** Explicit public projection. Credential bytes, raw capability responses and refresh error text never leave this service. */
export function connectionOperationalHealth(row: Record<string, any>, observedAt: string): OperationsConnectionHealth {
  const now = Date.parse(observedAt), expiresAt = date(row.expires_at), checkedAt = date(row.health_checked_at);
  const refreshState = ['idle', 'waiting', 'running', 'healthy', 'reauth_required', 'unknown'].includes(row.refresh_status)
    ? row.refresh_status as OperationsConnectionHealth['refreshState'] : 'unknown';
  const state = ['connected', 'disconnected', 'reauth_required', 'refresh_unknown'].includes(row.state)
    ? row.state as OperationsConnectionHealth['state'] : 'unknown';
  let tokenState: OperationsConnectionHealth['tokenState'] = 'unknown';
  if (row.has_token === false) tokenState = 'missing';
  else if (row.has_token === true && expiresAt && refreshState !== 'unknown' && state !== 'refresh_unknown') {
    const remaining = Date.parse(expiresAt) - now;
    tokenState = remaining <= 0 ? 'expired' : remaining <= tokenExpiringMs ? 'expiring' : 'valid';
  }
  const age = checkedAt ? now - Date.parse(checkedAt) : null;
  const healthState: OperationsConnectionHealth['health']['state'] = row.health_checked_at === null
    || row.health_checked_at === undefined ? 'never_checked'
    : age === null || age < 0 ? 'unknown' : age <= healthFreshnessMs ? 'fresh' : 'stale';
  return {
    id: String(row.id), name: String(row.display_name ?? row.name ?? row.shop_id).slice(0, 180),
    scope: { environment: row.environment, partnerId: String(row.partner_id), shopId: String(row.shop_id) },
    revision: count(row.revision), state, tokenState, tokenExpiresAt: expiresAt,
    health: { state: healthState, checkedAt,
      outcome: refreshState === 'healthy' && state === 'connected' ? 'healthy'
        : ['waiting', 'reauth_required'].includes(refreshState) || state === 'reauth_required' ? 'attention' : 'unknown' },
    refreshState, autoRefresh: row.auto_refresh === true,
  };
}

/** This collector reads local metadata and aggregates only. It cannot dispatch, recover, refresh credentials or call Shopee. */
export class OperationsOverviewService {
  constructor(private readonly repo: Repository, private readonly options: { now?: () => Date; env?: NodeJS.ProcessEnv } = {}) {}

  async get(raw: unknown = {}): Promise<OperationsOverview> {
    const query = operationsOverviewQuerySchema.parse(raw);
    const scope: OperationsScope | null = query.environment && query.partnerId && query.shopId
      ? { environment: query.environment, partnerId: query.partnerId, shopId: query.shopId } : null;
    const observedAt = (this.options.now?.() ?? new Date()).toISOString(), runtime = operationsRuntime(this.options.env);
    const values = [scope?.environment ?? null, scope?.partnerId ?? null, scope?.shopId ?? null];
    const connectionFilter = '($1::text IS NULL OR (c.environment=$1 AND c.partner_id=$2 AND c.shop_id=$3))';
    const read = async <T>(source: string, action: () => Promise<T>): Promise<OperationsSource<T>> => {
      try { return { state: 'available', observedAt, data: await action(), code: null }; }
      catch { return { state: 'unavailable', observedAt, data: null, code: `OPERATIONS_${source}_UNAVAILABLE` }; }
    };
    const [database, worker, connections, imports, drafts, workOrders, batches] = await Promise.all([
      read('DATABASE', async () => { await this.repo.probe(); return { schemaReady: true }; }),
      read('WORKER', async () => {
        const row = (await this.repo.pool.query('SELECT max(updated_at) AS last_seen FROM worker_heartbeats')).rows[0];
        const lastSeenAt = date(row?.last_seen), age = lastSeenAt ? Date.parse(observedAt) - Date.parse(lastSeenAt) : Infinity;
        return { state: age >= -5000 && age <= 15000 ? 'online' as const : 'offline' as const,
          lastSeenAt, freshnessSeconds: 15 as const };
      }),
      read('CONNECTIONS', async () => {
        const rows = (await this.repo.pool.query(`SELECT c.id,c.name,c.display_name,c.environment,c.partner_id,c.shop_id,
          c.revision,c.state,c.expires_at,c.health_checked_at,c.refresh_status,c.auto_refresh,
          (NULLIF(c.token_ciphertext,'') IS NOT NULL) AS has_token,count(*) OVER()::int AS total
          FROM connections c WHERE ${connectionFilter}
          ORDER BY c.environment,c.partner_id,c.shop_id,c.id LIMIT 101`, values)).rows;
        return { items: rows.slice(0, connectionLimit).map(row => connectionOperationalHealth(row, observedAt)),
          total: rows.length ? count(rows[0].total) : 0, truncated: rows.length > connectionLimit };
      }),
      read('IMPORTS', async () => {
        const row = (await this.repo.pool.query(`SELECT count(*)::int AS total,
          count(*) FILTER(WHERE status='queued')::int AS queued,count(*) FILTER(WHERE status='running')::int AS running,
          count(*) FILTER(WHERE status='ready')::int AS ready,count(*) FILTER(WHERE status='failed')::int AS failed,
          count(*) FILTER(WHERE status='running' AND lease_until<$1::timestamptz)::int AS expired_leases FROM source_files`, [observedAt])).rows[0];
        return { total: count(row.total), queued: count(row.queued), running: count(row.running),
          ready: count(row.ready), failed: count(row.failed), expiredLeases: count(row.expired_leases) };
      }),
      read('DRAFTS', async () => {
        const row = (await this.repo.pool.query(`SELECT count(*) FILTER(WHERE a.archived_at IS NULL)::int AS active,
          count(*) FILTER(WHERE a.archived_at IS NOT NULL)::int AS archived FROM products p
          LEFT JOIN local_resource_archives a ON a.kind='product' AND a.resource_id=p.product_key`)).rows[0];
        return { active: count(row.active), archived: count(row.archived) };
      }),
      read('WORK_ORDERS', async () => {
        const row = (await this.repo.pool.query(`SELECT count(*)::int AS total,
          count(*) FILTER(WHERE r.connection_id IS NULL)::int AS unassigned,
          count(*) FILTER(WHERE r.source_revision<>p.latest_revision)::int AS source_changed
          FROM work_orders w JOIN work_order_revisions r ON r.order_id=w.id AND r.revision=w.latest_revision
          JOIN products p ON p.product_key=r.product_key LEFT JOIN connections c ON c.id=r.connection_id
          WHERE ${connectionFilter}`, values)).rows[0];
        return { total: count(row.total), unassigned: count(row.unassigned), sourceChanged: count(row.source_changed) };
      }),
      read('BATCHES', async () => {
        const row = (await this.repo.pool.query(`WITH selected_preparations AS (
          SELECT p.id,p.registration,p.body->'scope' AS scope,
            EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p.body->'entries','[]'::jsonb)) entry
              WHERE entry->>'kind'='blocked') AS held
          FROM production_source_preparations p
          WHERE $1::text IS NULL OR (p.body->'scope'->>'environment'=$1
            AND p.body->'scope'->>'partnerId'=$2 AND p.body->'scope'->>'shopId'=$3)
        ), selected_operations AS (
          SELECT o.id,o.state FROM production_pilot_operations o JOIN connections c ON c.id=o.connection_id
          WHERE ${connectionFilter}
        ), selected_publications AS (
          SELECT o.state FROM production_pilot_publications o JOIN connections c ON c.id=o.connection_id
          WHERE ${connectionFilter}
        ) SELECT
          (SELECT count(*)::int FROM selected_preparations) AS preparations,
          (SELECT count(*)::int FROM selected_preparations WHERE registration IS NOT NULL) AS registered,
          (SELECT count(*)::int FROM selected_preparations WHERE held) AS held,
          (SELECT count(*)::int FROM selected_preparations WHERE scope IS NULL OR scope='null'::jsonb) AS unscoped_preparations,
          (SELECT count(*)::int FROM production_preparation_executions e JOIN selected_preparations p ON p.id=e.preparation_id WHERE e.body->>'state'='running') AS execution_running,
          (SELECT count(*)::int FROM production_preparation_executions e JOIN selected_preparations p ON p.id=e.preparation_id WHERE e.body->>'state'='paused') AS execution_paused,
          (SELECT count(*)::int FROM production_preparation_executions e JOIN selected_preparations p ON p.id=e.preparation_id WHERE e.body->>'state' IN ('completed','completed_with_exclusions')) AS completed,
          (SELECT count(*)::int FROM (SELECT state FROM selected_operations UNION ALL SELECT state FROM selected_publications) o WHERE state='unknown') AS operations_unknown,
          (SELECT count(*)::int FROM (SELECT state FROM selected_operations UNION ALL SELECT state FROM selected_publications) o WHERE state='sent') AS operations_sent,
          (SELECT count(*)::int FROM production_pilot_qc_wait_receipts q JOIN selected_operations o ON o.id=q.operation_id WHERE o.state<>'verified') AS waiting_qc`, values)).rows[0];
        return { preparations: count(row.preparations), registered: count(row.registered), held: count(row.held),
          unscopedPreparations: count(row.unscoped_preparations), executionRunning: count(row.execution_running),
          executionPaused: count(row.execution_paused), completed: count(row.completed),
          operationsUnknown: count(row.operations_unknown), operationsSent: count(row.operations_sent), waitingQc: count(row.waiting_qc),
          basis: 'database_preparations_and_journal' as const };
      }),
    ]);
    const blockers: OperationsBlocker[] = [];
    const add = (code: string, severity: OperationsBlocker['severity'], source: string, message: string,
      nextAction: string, page: OperationsBlocker['route']['page'], apiPath: string,
      details: Pick<OperationsBlocker, 'scope' | 'connectionId' | 'count'> = {}) =>
      blockers.push({ code, severity, source, message, nextAction, route: { page, apiPath }, ...details });
    for (const [name, snapshot] of Object.entries({ database, worker, connections, imports, drafts, workOrders, batches })) {
      if (snapshot.state === 'unavailable') add(snapshot.code!, 'block', name,
        'Chưa đọc được dữ liệu vận hành của phần này.', 'Kiểm tra dịch vụ và cơ sở dữ liệu; tải lại sau khi khôi phục.', 'guide', '/health/ready');
    }
    if (!runtime.productionWorkflowEnabled) add('PRODUCTION_WORKFLOW_DISABLED', 'attention', 'runtime',
      'Luồng đăng production đang tắt tại máy chủ.', 'Xem phạm vi bàn giao và cấu hình đã được cho phép.', 'guide', '/v1/operations/overview');
    if (runtime.productionWorkflowEnabled && !runtime.productionWritesConfigured) add('PRODUCTION_WRITE_FLAGS_DIFFER', 'attention', 'runtime',
      'Luồng production đang bật trong khi cờ cấu hình ghi chung đang tắt.',
      'Đối chiếu cấu hình máy chủ và quyền riêng từng đợt trước khi thao tác.', 'guide', '/v1/operations/overview');
    if (worker.data?.state === 'offline') add('IMPORT_WORKER_OFFLINE', imports.data && imports.data.queued + imports.data.running > 0 ? 'block' : 'attention', 'worker',
      'Chưa thấy heartbeat mới của worker nhập nguồn.', 'Kiểm tra worker; giữ các tệp và công việc đã nhận.', 'guide', '/v1/imports');
    if (imports.data?.failed) add('IMPORTS_FAILED', 'attention', 'imports', 'Có tệp nguồn chưa đọc được.',
      'Mở kho đầu vào để xem lỗi và bổ sung đúng tệp nguồn.', 'products', '/v1/imports', { count: imports.data.failed });
    if (imports.data?.expiredLeases) add('IMPORT_LEASE_EXPIRED', 'attention', 'imports', 'Có lần nhập đã hết lease nhưng còn ghi đang xử lý.',
      'Kiểm tra worker và biên nhận nhập; theo dõi công việc cũ.', 'products', '/v1/imports', { count: imports.data.expiredLeases });
    if (workOrders.data?.unassigned) add('WORK_ORDER_SHOP_MISSING', 'attention', 'workOrders', 'Có công việc chưa chọn shop.',
      'Mở công việc và chọn đúng shop được giao.', 'workbench', '/v1/workbench', { count: workOrders.data.unassigned });
    if (workOrders.data?.sourceChanged) add('WORK_ORDER_SOURCE_CHANGED', 'attention', 'workOrders', 'Có công việc đang giữ phiên bản nguồn cũ.',
      'So sánh nguồn hiện tại trước khi chuẩn bị công việc.', 'workbench', '/v1/workbench', { count: workOrders.data.sourceChanged, ...(scope ? { scope } : {}) });
    if (batches.data?.held) add('PREPARATIONS_HELD', 'attention', 'batches', 'Có bản chuẩn bị chứa listing cần bổ sung nguồn.',
      'Mở bản chuẩn bị và xử lý lý do của từng listing.', 'production', '/v1/production-preparations/context', { count: batches.data.held, ...(scope ? { scope } : {}) });
    if (batches.data?.executionPaused) add('PREPARATIONS_PAUSED', 'attention', 'batches', 'Có đợt đang giữ trạng thái tạm dừng.',
      'Xem nhật ký và việc tiếp theo trước khi tiếp tục đợt.', 'production', '/v1/production-batches', { count: batches.data.executionPaused, ...(scope ? { scope } : {}) });
    if (batches.data?.operationsUnknown) add('PRODUCTION_OUTCOME_UNKNOWN', 'block', 'batches', 'Có lệnh Shopee chưa xác định được kết quả.',
      'Mở đúng đợt để đối chiếu kết quả trước khi cân nhắc gửi tiếp.', 'production', '/v1/production-batches', { count: batches.data.operationsUnknown, ...(scope ? { scope } : {}) });
    if (batches.data?.operationsSent) add('PRODUCTION_REQUEST_SENT', 'attention', 'batches', 'Có lệnh đã gửi chưa ghi nhận kết quả cuối.',
      'Theo dõi hoặc đối chiếu công việc cũ; giữ nguyên lần gửi.', 'production', '/v1/production-batches', { count: batches.data.operationsSent, ...(scope ? { scope } : {}) });
    if (batches.data?.waitingQc) add('PRODUCTION_QC_PENDING', 'attention', 'batches', 'Có listing ẩn đang chờ QC.',
      'Mở đợt và kiểm tra link cùng bằng chứng đọc lại.', 'production', '/v1/production-batches', { count: batches.data.waitingQc, ...(scope ? { scope } : {}) });
    for (const connection of connections.data?.items ?? []) {
      const details = { scope: connection.scope, connectionId: connection.id };
      if (['expired', 'missing', 'unknown'].includes(connection.tokenState)) add(
        `CONNECTION_TOKEN_${connection.tokenState.toUpperCase()}`, 'block', 'connections',
        connection.tokenState === 'expired' ? 'Token đã hết hạn theo thời điểm lưu.'
          : connection.tokenState === 'missing' ? 'Kết nối chưa có token đã lưu.' : 'Chưa xác định được hiệu lực token đã lưu.',
        'Mở kết nối shop và đối chiếu trạng thái cấp quyền hoặc lần làm mới trước đó.', 'shops', '/v1/shops', details);
      else if (connection.tokenState === 'expiring') add('CONNECTION_TOKEN_EXPIRING', 'attention', 'connections',
        'Token đã lưu sắp hết hạn.', 'Mở kết nối để kiểm tra cơ chế làm mới và kết quả đã lưu.', 'shops', '/v1/shops', details);
      if (connection.state !== 'connected' || connection.refreshState === 'reauth_required') add('CONNECTION_NOT_CONNECTED', 'block', 'connections',
        'Kết nối shop đang cần xử lý.', 'Mở đúng kết nối để xem trạng thái và cấp quyền khi cần.', 'shops', '/v1/shops', details);
      if (connection.health.outcome === 'attention' && connection.state === 'connected'
        && connection.refreshState !== 'reauth_required') add('CONNECTION_CHECK_NEEDS_ATTENTION', 'attention', 'connections',
        'Lần kiểm tra hoặc làm mới kết nối đang cần xử lý.',
        'Mở kết nối để xem kết quả đã lưu và bước tiếp theo.', 'shops', '/v1/shops', details);
      if (connection.health.state !== 'fresh') add('CONNECTION_HEALTH_NOT_FRESH', 'attention', 'connections',
        'Chưa có lần kiểm tra shop gần đây có thời điểm hợp lệ.', 'Xem thời điểm kiểm tra đã lưu tại trang kết nối.', 'shops', '/v1/shops', details);
    }
    if (connections.data?.truncated) add('CONNECTION_LIST_TRUNCATED', 'attention', 'connections',
      'Tổng quan chỉ hiển thị 100 kết nối đầu tiên.', 'Chọn phạm vi một shop hoặc mở danh sách kết nối.', 'shops', '/v1/shops', { count: connections.data.total });
    const unavailable = [database, worker, connections, imports, drafts, workOrders, batches].some(source => source.state === 'unavailable');
    const visibleBlockers = blockers.length <= 100 ? blockers : [
      ...blockers.filter(blocker => blocker.severity === 'block').concat(blockers.filter(blocker => blocker.severity !== 'block')).slice(0, 99),
      { code: 'OPERATIONS_BLOCKERS_TRUNCATED', severity: 'attention' as const, source: 'overview',
        message: 'Có thêm mục cần xử lý ngoài giới hạn hiển thị của tổng quan.',
        nextAction: 'Chọn phạm vi một shop hoặc mở trang nghiệp vụ để xem đầy đủ.',
        route: { page: 'shops' as const, apiPath: '/v1/shops' }, count: blockers.length - 99 },
    ];
    return { observedAt, scope, status: unavailable || worker.data?.state === 'offline'
      || blockers.some(blocker => blocker.source !== 'runtime') ? 'degraded' : 'ok',
      runtime, database, worker, connections, counts: { sourceScope: 'workspace', workScope: scope ? 'selected_shop' : 'workspace',
        imports, drafts, workOrders, batches }, blockers: visibleBlockers };
  }
}
