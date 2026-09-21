import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { BlobStore, Repository } from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { ProductionBatchService } from '../../apps/api/src/production-batch-service.js';
import { ProductionBatchReviewService } from '../../apps/api/src/production-batch-review-service.js';
import { ProductionPreparationService } from '../../apps/api/src/production-preparation-service.js';
import { ProductionPreparationExecution } from '../../apps/api/src/production-preparation-execution.js';
import { ProductionPreparationMetadataService } from '../../apps/api/src/production-preparation-metadata.js';

const unexpected = vi.fn(() => { throw new Error('Unexpected database access'); });
const repo = new Repository({ query: unexpected, connect: unexpected } as any);
let app: Awaited<ReturnType<typeof createApp>>;
let network: ReturnType<typeof vi.spyOn>;
const id = randomUUID(), fingerprint = 'a'.repeat(64), sourceKey = 'nguon/xit-thom';
const headers = { 'x-app-client': 'internal-workspace', origin: 'http://localhost:5173' };
const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.getHttpAdapter().getInstance().inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { ...headers, 'content-type': 'application/json' } }) });

beforeAll(async () => {
  app = await createApp(repo, new BlobStore('.local/route-contracts-no-write'), ['http://localhost:5173']);
  await app.getHttpAdapter().getInstance().ready();
});
beforeEach(() => {
  unexpected.mockClear();
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected network'); });
});
afterEach(() => {
  expect(unexpected).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
afterAll(async () => { await app?.close(); });

it.each([
  ['PRODUCTION_BATCH_NOT_REGISTERED', 404, 'kiểm tra'],
  ['PRODUCTION_BATCH_STATUS_CHANGED', 409, 'Đọc lại đợt đăng'],
  ['PRODUCTION_BATCH_EXECUTION_DISABLED', 409, 'chưa được bật'],
] as const)('keeps the batch HTTP meaning and recovery guidance for %s', async (code, status, guidance) => {
  const service = app.get(ProductionBatchService);
  const start = vi.spyOn(service, 'start').mockRejectedValue(new Error(code));
  const result = await call('POST', `/v1/production-batches/${id}/run`, {
    mode: 'execute', expectedStatusFingerprint: fingerprint,
  });
  expect(result.statusCode).toBe(status);
  expect(result.json().code).toBe(code);
  expect(result.json().message).toContain(guidance);
  expect(start).toHaveBeenCalledExactlyOnceWith(id, { mode: 'execute', expectedStatusFingerprint: fingerprint });
});

it('retains the specific expired weight-review guidance', async () => {
  vi.spyOn(app.get(ProductionBatchReviewService), 'approve').mockRejectedValue(new Error('PRODUCTION_BATCH_REVIEW_READS_EXPIRED'));
  const result = await call('POST', `/v1/production-batches/${id}/review/approve`, {
    sourceKey, expectedReviewFingerprint: fingerprint,
  });
  expect(result.statusCode).toBe(409);
  expect(result.json()).toMatchObject({ code: 'PRODUCTION_BATCH_REVIEW_READS_EXPIRED' });
  expect(result.json().message).toContain('Bấm đọc lại kết quả');
});

it('preserves a real execution-policy validation error returned through execution GET', async () => {
  const body = {
    version: 1, id, preparationId: id, preparationFingerprint: fingerprint,
    publicationMode: 'hidden_for_review', imageQcPolicy: 'defer_image_qc',
    createdAt: '2026-09-17T00:00:00.000Z',
    scope: { environment: 'production', partnerId: '2010476', shopId: '1423724897' },
    batches: [{ batchId: id, manifestSha256: fingerprint, priorStatusFingerprint: fingerprint,
      sources: [{ sourceKey, sourceIdentity: 'source-fixture', sourceRevision: 1, documentSha256: fingerprint,
        operationId: null, itemId: null, sourceFingerprint: null }] }],
  };
  const query = vi.fn(async (sql: string) => {
    if (sql === 'SELECT body FROM production_preparation_executions WHERE preparation_id=$1')
      return { rows: [{ body: { state: 'paused' } }] };
    if (sql === 'SELECT * FROM production_execution_policies WHERE preparation_id=$1')
      return { rows: [{ id, preparation_id: id, body, fingerprint: '0'.repeat(64) }] };
    throw Error('Unexpected isolated fixture query');
  });
  const execution = new ProductionPreparationExecution(
    new Repository({ query } as any), {} as any, {} as any,
  );
  // Execute both real service get() and policy validated(); only persistence is an in-memory fixture.
  vi.spyOn(app.get(ProductionPreparationExecution), 'get').mockImplementation((key) => execution.get(key));
  const result = await call('GET', `/v1/production-preparations/${id}/execution`);
  expect(result.statusCode).toBe(409);
  expect(result.json().code).toBe('PRODUCTION_EXECUTION_POLICY_RECEIPT_INVALID');
  expect(result.json().message).toContain('Đọc lại');
  expect(query).toHaveBeenCalledTimes(2);
});

it('parses metadata paging and false inventory flags without shadowing the context route', async () => {
  const context = vi.spyOn(app.get(ProductionPreparationService), 'context').mockResolvedValue({ scope: 'context fixture' } as never);
  const metadata = vi.spyOn(app.get(ProductionPreparationMetadataService), 'get').mockResolvedValue({ scope: 'metadata fixture' } as never);
  const first = await call('GET', '/v1/production-preparations/context');
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({ scope: 'context fixture' });
  expect(context).toHaveBeenCalledExactlyOnceWith();
  const second = await call('GET', '/v1/production-preparations/metadata?categoryId=101127&brandOffset=100&inventoryOffset=20&includeInventory=false&inventoryStatus=UNLIST');
  expect(second.statusCode).toBe(200);
  expect(metadata).toHaveBeenCalledExactlyOnceWith({ categoryId: '101127', brandOffset: 100, inventoryOffset: 20, includeInventory: false, inventoryStatus: 'UNLIST' });
  const invalid = await call('GET', '/v1/production-preparations/metadata?brandOffset=100');
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().code).toBe('INVALID_INPUT');
  expect(metadata).toHaveBeenCalledTimes(1);
});

it.each(['missing', 'expired'] as const)('explains the real metadata %s connection guard before any upstream request', async kind => {
  const query = vi.fn(async () => ({ rows: kind === 'missing' ? [] : [{
    id, environment:'production', partner_id:'2010476', shop_id:'1423724897',
    state:'connected', revision:1, expires_at:'2026-09-16T00:00:00.000Z',
  }] }));
  const metadata = new ProductionPreparationMetadataService(new Repository({query} as any), {
    now:()=>Date.parse('2026-09-17T00:00:00.000Z'),
  });
  vi.spyOn(app.get(ProductionPreparationMetadataService),'get').mockImplementation(input=>metadata.get(input));
  const result=await call('GET','/v1/production-preparations/metadata?includeInventory=false');
  expect(result.statusCode).toBe(409);
  expect(result.json().code).toBe('PRODUCTION_PREPARATION_AUTH_REQUIRED');
  expect(result.json().message).toContain('Kết nối shop');
  expect(result.json().message).toContain('đọc lại thông tin ngành');
  expect(result.json().message).not.toContain('Mở kết quả');
  expect(query).toHaveBeenCalledExactlyOnceWith(
    'SELECT * FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3',
    ['production','2010476','1423724897'],
  );
});

it.each([
  ['CONNECTION_CHANGED','Kết nối shop'],
  ['QUERY_INVALID','lựa chọn ngành'],
  ['READ_FAILED','quyền truy cập'],
  ['SHOP_IDENTITY_MISMATCH','đúng shop'],
  ['CATEGORY_NOT_SELECTABLE','ngành cuối'],
  ['CATEGORY_TREE_INVALID','danh sách ngành'],
  ['ATTRIBUTES_INVALID','thuộc tính'],
  ['BRANDS_INVALID','thương hiệu'],
  ['BRAND_CURSOR_INVALID','thương hiệu'],
  ['BRAND_SEARCH_LIMIT_REACHED','thương hiệu'],
  ['CHANNELS_INVALID','vận chuyển'],
  ['CHANNEL_RELATIONS_INVALID','vận chuyển'],
  ['INVENTORY_INVALID','listing tham khảo'],
  ['REFERENCE_INVALID','listing tham khảo'],
  ['RESPONSE_INVALID','dữ liệu ngành'],
  ['CACHE_TTL_INVALID','người phụ trách ứng dụng'],
] as const)('returns actionable metadata guidance for the service code %s',async(suffix,subject)=>{
  const code='PRODUCTION_PREPARATION_'+suffix;
  vi.spyOn(app.get(ProductionPreparationMetadataService),'get').mockRejectedValue(new Error(code));
  const result=await call('GET','/v1/production-preparations/metadata?includeInventory=false');
  expect(result.statusCode).toBe(409);
  expect(result.json().code).toBe(code);
  expect(result.json().message).toContain(subject);
  expect(result.json().message).not.toContain('Mở kết quả');
});

it.each([
  ['GET', `/v1/production-preparations/${id}`, ProductionPreparationService, 'get', undefined, [id], 200],
  ['POST', '/v1/production-preparations/preview', ProductionPreparationService, 'preview', { id, entries: [] }, [{ id, entries: [] }], 201],
  ['POST', `/v1/production-preparations/${id}/register`, ProductionPreparationService, 'register', { expectedFingerprint: fingerprint }, [id, { expectedFingerprint: fingerprint }], 201],
  ['GET', `/v1/production-preparations/${id}/execution`, ProductionPreparationExecution, 'get', undefined, [id], 200],
  ['POST', `/v1/production-preparations/${id}/run`, ProductionPreparationExecution, 'start', { expectedFingerprint: fingerprint }, [id, { expectedFingerprint: fingerprint }], 201],
  ['GET', '/v1/production-batches', ProductionBatchService, 'list', undefined, [], 200],
  ['GET', `/v1/production-batches/${id}`, ProductionBatchService, 'status', undefined, [id], 200],
  ['POST', `/v1/production-batches/${id}/run`, ProductionBatchService, 'start', { mode: 'reconcile', expectedStatusFingerprint: fingerprint }, [id, { mode: 'reconcile', expectedStatusFingerprint: fingerprint }], 202],
  ['POST', `/v1/production-batches/${id}/publish`, ProductionBatchService, 'publish', { sourceKey, expectedStatusFingerprint: fingerprint }, [id, { sourceKey, expectedStatusFingerprint: fingerprint }], 202],
  ['GET', `/v1/production-batches/${id}/review?sourceKey=${encodeURIComponent(sourceKey)}`, ProductionBatchReviewService, 'review', undefined, [id, sourceKey], 200],
  ['POST', `/v1/production-batches/${id}/review/approve`, ProductionBatchReviewService, 'approve', { sourceKey, expectedReviewFingerprint: fingerprint }, [id, { sourceKey, expectedReviewFingerprint: fingerprint }], 201],
] as const)('forwards %s %s to its service with the exact request contract', async (method, path, serviceType, action, payload, args, status) => {
  // Service work is mocked: these assertions cover HTTP registration, decoding,
  // acknowledgement status and body forwarding, not business authorization.
  const target = vi.spyOn(app.get(serviceType) as any, action).mockResolvedValue({ contractFixture: true });
  const result = await call(method, path, payload);
  expect(result.statusCode).toBe(status);
  expect(result.json()).toEqual({ contractFixture: true });
  expect(target).toHaveBeenCalledExactlyOnceWith(...args);
});
