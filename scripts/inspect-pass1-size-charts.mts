import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '../packages/persistence/src/index.js';
import { SecretBox } from '../packages/shopee/src/index.js';
import { ProductionPilotTransport } from '../packages/shopee/src/production-pilot-transport.js';
import type { PreparedWireResponse } from '../packages/shopee/src/prepared-transport.js';

// Official GET list/detail contracts read in full; this diagnostic cannot create/select a chart.
const scope = Object.freeze({ environment: 'production' as const, partnerId: '2010476', shopId: '1423724897' });
const categoryId = '100265';
const root = resolve('.local/production-batch-pass1-20260915/size-chart');
type Read = (path: string, query: Record<string, string>) => Promise<PreparedWireResponse>;
type Save = (name: string, value: unknown) => Promise<void>;
type Options = { read: Read; save: Save };
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: string): never { throw Error('PASS1_SIZE_CHART_' + code); }
function count(value: unknown) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) fail('INVALID_RESPONSE');
  return numeric;
}
function identifier(value: unknown) { const number = count(value); if (!number) fail('INVALID_RESPONSE'); return String(number); }

export async function inspectPass1SizeCharts(options: Options) {
  const requestIds: string[] = [];
  const read = async (path: string, query: Record<string, string>, name: string) => {
    const result = await options.read(path, query);
    await options.save(name, { observedAt: new Date().toISOString(), scope, method: 'GET', path, query, result });
    if (result.kind !== 'success') fail('READ_FAILED');
    if (result.requestId) requestIds.push(result.requestId);
    return result.response;
  };
  const shop = await read('/api/v2/shop/get_shop_info', {}, 'shop');
  if (typeof shop.shop_name !== 'string' || !shop.shop_name || shop.region !== 'VN' || shop.status !== 'NORMAL' ||
    (shop.shop_id !== undefined && String(shop.shop_id) !== scope.shopId)) fail('SHOP_UNVERIFIED');
  const limits = await read('/api/v2/product/get_item_limit', { category_id: categoryId }, 'limits');
  const limit = limits.size_chart_limit;
  if (!record(limit) || ['size_chart_mandatory', 'support_image_size_chart', 'support_template_size_chart'].some(key => typeof limit[key] !== 'boolean')) fail('LIMIT_UNVERIFIED');
  const ids: string[] = [], cursors = new Set<string>();
  let cursor = '', total: number | undefined;
  for (let page = 0; ; page++) {
    if (page >= 10) fail('READ_BOUND_EXCEEDED'); // Diagnostic bound, not a Shopee limit.
    const listing = await read('/api/v2/product/get_size_chart_list', { category_id: categoryId, page_size: '50', ...(cursor ? { cursor } : {}) }, 'list-' + page);
    const nextTotal = count(listing.total_count);
    // Observed production 15/09: zero total + terminal cursor omits size_chart_list.
    // This does not normalize null, missing totals/cursors, or any nonempty page.
    const entries = !Object.hasOwn(listing, 'size_chart_list') && nextTotal === 0 && listing.next_cursor === '' ? [] : listing.size_chart_list;
    if (!Array.isArray(entries) || entries.length > 50 || typeof listing.next_cursor !== 'string' || listing.next_cursor.length > 4096) fail('INVALID_RESPONSE');
    if (total !== undefined && nextTotal !== total) fail('LIST_CHANGED');
    total = nextTotal;
    for (const entry of entries) {
      if (!record(entry)) fail('INVALID_RESPONSE');
      const id = identifier(entry.size_chart_id);
      if (ids.includes(id)) fail('DUPLICATE_ID');
      ids.push(id);
    }
    if (ids.length > total) fail('COUNT_MISMATCH');
    const next = listing.next_cursor;
    if (!next) { if (ids.length !== total) fail('COUNT_MISMATCH'); break; }
    if (!entries.length || cursors.has(next)) fail('CURSOR_INVALID');
    cursors.add(next); cursor = next;
  }
  const charts: { id: string; name: string; columns: Record<string, any>[] }[] = [];
  for (const id of ids) {
    const detail = await read('/api/v2/product/get_size_chart_detail', { size_chart_id: id }, 'detail-' + id);
    if (identifier(detail.size_chart_id) !== id || typeof detail.size_chart_name !== 'string' || !record(detail.size_chart_table) ||
      !Array.isArray(detail.size_chart_table.column_list) || detail.size_chart_table.column_list.length > 100) fail('DETAIL_INVALID');
    const columns = detail.size_chart_table.column_list;
    if (columns.some((column: unknown) => !record(column) || !record(column.measurement) ||
      ['display_name', 'input_type', 'unit'].some(key => typeof column.measurement[key] !== 'string') ||
      !Array.isArray(column.measurement_value_list) || column.measurement_value_list.length > 1000)) fail('DETAIL_INVALID');
    charts.push({ id, name: detail.size_chart_name, columns });
  }
  return { readOnly: true, mutations: 0, scope, categoryId, shopName: shop.shop_name, sizeChartLimit: limit,
    chartCount: charts.length, charts, selectedChartId: null, suitableForSourceVerified: false, requestIds };
}

async function main() {
  if (process.argv.length !== 2) { console.error('PASS1_SIZE_CHART_ARGUMENTS_FORBIDDEN'); process.exitCode = 1; return; }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const output = resolve(root, randomUUID());
  let created = false;
  try {
    const rows = (await pool.query(`SELECT id,revision,state,expires_at,partner_key_ciphertext,token_ciphertext FROM connections
      WHERE environment='production' AND partner_id=$1 AND shop_id=$2`, [scope.partnerId, scope.shopId])).rows;
    const row = rows[0];
    if (rows.length !== 1 || !row || row.state !== 'connected' || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) fail('CONNECTION_NOT_READY');
    const box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? ''), context = 'production:2010476:1423724897';
    const key = box.open(row.partner_key_ciphertext, context) as { partnerKey: string };
    const token = box.open(row.token_ciphertext, context) as { accessToken: string };
    const transport = new ProductionPilotTransport({ ...scope, partnerKey: key.partnerKey, accessToken: token.accessToken });
    await mkdir(output, { recursive: true }); created = true;
    const save: Save = async (name, value) => {
      if (!/^[a-z0-9-]+$/.test(name)) fail('EVIDENCE_NAME_INVALID');
      await writeFile(resolve(output, name + '.json'), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    };
    const result = await inspectPass1SizeCharts({ save, read: async (path, query) => {
      const current = (await pool.query(`SELECT revision,state,expires_at FROM connections WHERE id=$1
        AND environment='production' AND partner_id=$2 AND shop_id=$3`, [row.id, scope.partnerId, scope.shopId])).rows[0];
      if (!current || current.revision !== row.revision || current.state !== 'connected' || !current.expires_at || new Date(current.expires_at).getTime() <= Date.now()) fail('CONNECTION_CHANGED');
      return transport.read(path, query);
    } });
    await save('summary', { ...result, connectionId: row.id, connectionRevision: row.revision });
    // Raw chart values stay in private evidence; console contains only diagnostic names and bindings.
    console.log(JSON.stringify({ ...result, charts: result.charts.map(chart => ({ id: chart.id, name: chart.name,
      measurements: chart.columns.map(column => column.measurement) })), evidenceDirectory: output }));
  } catch (error) {
    const code = error instanceof Error && /^PASS1_SIZE_CHART_[A-Z_]+$/.test(error.message) ? error.message : 'PASS1_SIZE_CHART_FAILED';
    if (created) await writeFile(resolve(output, 'failure.json'), JSON.stringify({ code }), { flag: 'wx', mode: 0o600 }).catch(() => undefined);
    console.error(JSON.stringify({ code, ...(created ? { evidenceDirectory: output } : {}) })); process.exitCode = 1;
  } finally { await pool.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
