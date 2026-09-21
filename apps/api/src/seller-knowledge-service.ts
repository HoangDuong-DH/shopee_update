import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Repository, transaction, listShopConnections } from '@shopee/persistence';
import { canonicalJson } from '@shopee/domain';
import { SecretBox } from '@shopee/gateway';
import type { PreparedWireResponse } from '../../../packages/shopee/src/prepared-transport.js';
import { SellerKnowledgeTransport, sanitizeKnowledge } from './seller-knowledge-transport.js';

type Db = Pick<PoolClient, 'query'>;
export type SellerKnowledgeScope = {
  environment: 'production';
  partnerId: string;
  shopId: string;
  connectionRevision: number;
};
export type SellerKnowledgeListing = {
  evidenceId: string;
  connectionId: string;
  scope: SellerKnowledgeScope;
  itemId: string;
  title: string;
  itemSku: string;
  modelSkus: string[];
  hasModel: boolean;
  modelCount: number;
  skuIdentityComplete: boolean;
  modelIdentities: { modelId: string; sku: string; tierIndex: number[] | null }[];
  categoryId: string | null;
  brandId: string | null;
  attributes: any[] | null;
  attributeEvidenceComplete: boolean;
  models: any[];
  itemStatus: string;
  remoteUpdatedAt: number | null;
  observedAt: string;
  lastSeenAt: string;
  issues: string[];
  evidenceRefs: string[];
};
export type SellerKnowledgeSync = {
  id: string;
  connectionId: string;
  scope: SellerKnowledgeScope;
  state: 'queued' | 'running' | 'paused' | 'complete' | 'failed';
  code: string | null;
  processedCount: number;
  fetchedCount: number;
  reusedCount: number;
  requestCount: number;
  maxItems: number;
  canResume: boolean;
  issues: string[];
  createdAt: string;
  updatedAt: string;
};
export type SellerKnowledgeCategory = {
  evidenceId: string;
  categoryId: string;
  scope: SellerKnowledgeScope;
  observedAt: string;
  expiresAt: string;
  attributeTree: any[];
  categoryPath: any[];
  issues: string[];
  evidenceRefs: string[];
};
export type SellerKnowledgeOptions = {
  encryptionKey?: string;
  transport?: typeof fetch;
  read?: (
    scope: SellerKnowledgeScope,
    path: string,
    query: Record<string, string>,
  ) => Promise<PreparedWireResponse>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  autoRun?: boolean;
};
type Header = { item_id: number; item_status: string; update_time?: number };
type Cursor = {
  statusIndex: number;
  offset: number;
  pending: Header[];
  nextOffset: number;
  hasNext: boolean;
  pageEvidenceId?: string;
  pendingCategoryId?: string;
};
const statuses = ['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING', 'SELLER_DELETE', 'SHOPEE_DELETE'];
const startSchema = z
  .object({
    connectionId: z.string().uuid(),
    requestId: z.string().uuid(),
    maxItems: z.number().int().min(1).max(500).default(100),
  })
  .strict();
const numericId = z
  .union([
    z.string().regex(/^[1-9]\d{0,15}$/),
    z.number().int().positive().refine(Number.isSafeInteger),
  ])
  .transform(String);
const searchSchema = z
  .object({
    connectionId: z.string().uuid(),
    categoryId: numericId.optional(),
    brandId: z
      .union([numericId, z.literal(0), z.literal('0')])
      .transform(String)
      .optional(),
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(40),
  })
  .strict();
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const isRecord = (v: any): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const idText = (v: unknown): string | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
    ? String(v)
    : typeof v === 'string' && /^\d+$/.test(v)
      ? v
      : null;
const string = (v: unknown) => (typeof v === 'string' ? v : '');
function classifyReadWarnings(path: string, result: any): { codes: string[]; blocking: boolean } {
  const warnings = [result.envelope?.warning, result.response?.warning].filter((value) =>
    typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null,
  );
  if (!warnings.length) return { codes: [], blocking: false };
  // Observed production receipt 541f7b87-0ecf-4bab-915b-f8c925d6da1c, 2026-09-16.
  // This narrow exception concerns a field this attribute collector does not use.
  // The unmodified warning remains in raw evidence; no shipping value is inferred.
  const shippingOnly =
    path === '/api/v2/product/get_item_base_info' &&
    warnings.every(
      (value) =>
        typeof value === 'string' &&
        value
          .trim()
          .split(/\r?\n/)
          .every((line) =>
            /^fail to get channel estimated_shipping_fee for channel \[\d+\];?$/.test(line.trim()),
          ),
    );
  return shippingOnly
    ? { codes: ['SHIPPING_FEE_UNAVAILABLE'], blocking: false }
    : { codes: ['KNOWLEDGE_API_WARNING'], blocking: true };
}
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
const scopeOf = (c: any): SellerKnowledgeScope => ({
  environment: 'production',
  partnerId: c.partner_id,
  shopId: c.shop_id,
  connectionRevision: c.revision,
});
const syncView = (r: any): SellerKnowledgeSync => ({
  id: r.id,
  connectionId: r.connection_id,
  scope: r.scope,
  state: r.state,
  code: r.code,
  processedCount: r.processed_count,
  fetchedCount: r.fetched_count,
  reusedCount: r.reused_count,
  requestCount: r.request_count,
  maxItems: r.max_items,
  canResume: ['queued', 'running', 'paused', 'failed'].includes(r.state),
  issues: r.issues,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** Durable marketplace observations only: never a source of product truth or write authorization. */
export class SellerKnowledgeService {
  private running = new Map<string, Promise<void>>();
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  constructor(
    private repo: Repository,
    private options: SellerKnowledgeOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  private async connection(id: string, db: Db = this.repo.pool) {
    const row = (await db.query('SELECT * FROM connections WHERE id=$1', [id])).rows[0];
    if (!row || row.environment !== 'production' || row.state !== 'connected')
      throw Error('KNOWLEDGE_CONNECTED_PRODUCTION_REQUIRED');
    if (!row.expires_at || new Date(row.expires_at).getTime() <= this.now())
      throw Error('KNOWLEDGE_CONNECTION_EXPIRED');
    return row;
  }
  private async observation(
    db: Db,
    connectionId: string,
    kind: string,
    subject: string,
    scope: SellerKnowledgeScope,
    body: any,
    observedAt: string,
    hashBody: any = body,
  ) {
    const contentHash = digest(sanitizeKnowledge(hashBody)),
      id = randomUUID();
    await db.query(
      `INSERT INTO seller_knowledge_observations(id,connection_id,kind,subject_key,content_hash,scope,body,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(connection_id,kind,subject_key,content_hash) DO NOTHING`,
      [id, connectionId, kind, subject, contentHash, scope, sanitizeKnowledge(body), observedAt],
    );
    return (
      await db.query(
        'SELECT * FROM seller_knowledge_observations WHERE connection_id=$1 AND kind=$2 AND subject_key=$3 AND content_hash=$4',
        [connectionId, kind, subject, contentHash],
      )
    ).rows[0];
  }
  private async read(db: Db, c: any, path: string, query: Record<string, string>, jobId?: string) {
    const scope = scopeOf(c);
    let transport: SellerKnowledgeTransport | undefined;
    if (!this.options.read) {
      const box = new SecretBox(this.options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? ''),
        key = `production:${c.partner_id}:${c.shop_id}`;
      try {
        const secret = z
          .object({ partnerKey: z.string().min(1) })
          .parse(box.open(c.partner_key_ciphertext, key));
        const token = z
          .object({ accessToken: z.string().min(1) })
          .parse(box.open(c.token_ciphertext, key));
        transport = new SellerKnowledgeTransport(
          { ...scope, partnerKey: secret.partnerKey, accessToken: token.accessToken },
          this.options.transport,
        );
      } catch {
        throw Error('KNOWLEDGE_CREDENTIALS_INVALID');
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.connection(c.id, db);
      if (current.revision !== c.revision) throw Error('KNOWLEDGE_CONNECTION_CHANGED');
      await this.sleep(attempt ? Math.min(1000 * 2 ** (attempt - 1), 4000) : 150);
      let result: PreparedWireResponse;
      try {
        result = this.options.read
          ? await this.options.read(scope, path, { ...query })
          : await transport!.read(path, query);
      } catch {
        result = { kind: 'unknown', code: 'KNOWLEDGE_NETWORK_ERROR' };
      }
      const observedAt = new Date(this.now()).toISOString();
      const safe = sanitizeKnowledge(result);
      const warnings =
        result.kind === 'success'
          ? classifyReadWarnings(path, safe)
          : { codes: [], blocking: false };
      const evidence = await this.observation(
        db,
        c.id,
        'read',
        path,
        scope,
        {
          method: 'GET',
          path,
          query,
          result: safe,
          warningCodes: warnings.codes,
          attempt: attempt + 1,
          syncId: jobId ?? null,
        },
        observedAt,
      );
      if (jobId)
        await db.query(
          'UPDATE seller_knowledge_syncs SET request_count=request_count+1,updated_at=now() WHERE id=$1',
          [jobId],
        );
      if ((await this.connection(c.id, db)).revision !== c.revision)
        throw Error('KNOWLEDGE_CONNECTION_CHANGED');
      if (warnings.blocking) throw Error('KNOWLEDGE_API_WARNING');
      if (result.kind === 'success')
        return {
          response: safe.response as Record<string, any>,
          requestId: result.requestId,
          evidenceId: evidence.id as string,
          observedAt,
          warningCodes: warnings.codes,
        };
      const code =
        /^(?:product\.)?(?:error_[a-z_]+|KNOWLEDGE_[A-Z_]+|invalid_acceess_token|invalid_access_token|partner_shop_no_link|shop_no_linked|shop_banned)$/.test(
          result.code,
        )
          ? result.code
          : 'KNOWLEDGE_READ_REJECTED';
      if (
        attempt === 2 ||
        ![
          'error_rate_limit',
          'error_server',
          'error_inner',
          'error_network',
          'error_system_busy',
          'KNOWLEDGE_NETWORK_ERROR',
        ].includes(code.replace(/^product\./, ''))
      )
        throw Error(code);
    }
    throw Error('KNOWLEDGE_READ_FAILED');
  }
  async startSync(raw: unknown): Promise<SellerKnowledgeSync> {
    const input = startSchema.parse(raw);
    const job = await transaction(this.repo.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'seller-knowledge-request:' + input.requestId,
      ]);
      const old = (
        await db.query('SELECT * FROM seller_knowledge_syncs WHERE request_id=$1', [
          input.requestId,
        ])
      ).rows[0];
      if (old) {
        if (old.connection_id !== input.connectionId || old.max_items !== input.maxItems)
          throw Error('KNOWLEDGE_REQUEST_CONFLICT');
        return syncView(old);
      }
      const c = await this.connection(input.connectionId, db),
        id = randomUUID();
      const cursor: Cursor = {
        statusIndex: 0,
        offset: 0,
        pending: [],
        nextOffset: 0,
        hasNext: false,
      };
      const r = await db.query(
        `INSERT INTO seller_knowledge_syncs(id,request_id,connection_id,scope,connection_revision,max_items,state,cursor) VALUES($1,$2,$3,$4,$5,$6,'queued',$7) RETURNING *`,
        [id, input.requestId, input.connectionId, scopeOf(c), c.revision, input.maxItems, cursor],
      );
      return syncView(r.rows[0]);
    });
    if (this.options.autoRun !== false && job.state === 'queued') this.launch(job.id);
    return job;
  }
  private launch(id: string) {
    if (this.running.has(id)) return;
    const promise = this.runSync(id)
      .then(() => undefined)
      .catch(() => undefined);
    this.running.set(id, promise);
    void promise.finally(() => this.running.delete(id));
  }
  async waitForIdle(id: string) {
    await this.running.get(id);
  }
  async resumeSync(id: string) {
    z.string().uuid().parse(id);
    const job = await this.getSync(id);
    if (!job) throw Error('KNOWLEDGE_SYNC_NOT_FOUND');
    if (job.state === 'complete') return job;
    await this.connection(job.connectionId);
    if (this.options.autoRun !== false) this.launch(id);
    return (await this.getSync(id))!;
  }
  async getSync(id: string): Promise<SellerKnowledgeSync | null> {
    z.string().uuid().parse(id);
    const r = (await this.repo.pool.query('SELECT * FROM seller_knowledge_syncs WHERE id=$1', [id]))
      .rows[0];
    return r ? syncView(r) : null;
  }
  async runSync(id: string) {
    z.string().uuid().parse(id);
    const db = await this.repo.pool.connect();
    let locked = false,
      connectionId = '';
    try {
      let job = (await db.query('SELECT * FROM seller_knowledge_syncs WHERE id=$1', [id])).rows[0];
      if (!job) throw Error('KNOWLEDGE_SYNC_NOT_FOUND');
      if (job.state === 'complete') return;
      connectionId = job.connection_id;
      locked = (
        await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [
          'seller-knowledge:' + connectionId,
        ])
      ).rows[0].locked;
      if (!locked) return;
      job = (await db.query('SELECT * FROM seller_knowledge_syncs WHERE id=$1', [id])).rows[0];
      if (job.state === 'complete') return;
      const c = await this.connection(connectionId, db),
        scope = scopeOf(c),
        cursor = job.cursor as Cursor;
      let processedThisRun = 0;
      const categoriesVisited = new Set<string>();
      await db.query(
        `UPDATE seller_knowledge_syncs SET state='running',code=NULL,connection_revision=$2,scope=$3,updated_at=now() WHERE id=$1`,
        [id, c.revision, scope],
      );
      const checkpoint = async (increments: { fetched?: number; reused?: number } = {}) => {
        await db.query(
          `UPDATE seller_knowledge_syncs SET cursor=$2,processed_count=processed_count+$3,fetched_count=fetched_count+$4,reused_count=reused_count+$5,updated_at=now() WHERE id=$1`,
          [
            id,
            cursor,
            (increments.fetched ?? 0) + (increments.reused ?? 0),
            increments.fetched ?? 0,
            increments.reused ?? 0,
          ],
        );
      };
      if (cursor.pendingCategoryId) {
        await this.category(c, cursor.pendingCategoryId, false, db, id);
        categoriesVisited.add(cursor.pendingCategoryId);
        delete cursor.pendingCategoryId;
        await checkpoint();
      }
      while (cursor.statusIndex < statuses.length) {
        if (processedThisRun >= job.max_items) {
          await db.query(
            `UPDATE seller_knowledge_syncs SET state='paused',code='KNOWLEDGE_BATCH_LIMIT',cursor=$2,updated_at=now() WHERE id=$1`,
            [id, cursor],
          );
          return;
        }
        if (!cursor.pending.length) {
          const page = await this.read(
            db,
            c,
            '/api/v2/product/get_item_list',
            {
              offset: String(cursor.offset),
              page_size: '100',
              item_status: statuses[cursor.statusIndex]!,
            },
            id,
          );
          // Production returns an omitted item field for an explicitly empty initial status page.
          // Missing items without all three independent zero-page signals remain unknown.
          const items =
            page.response.item === undefined &&
            page.response.total_count === 0 &&
            page.response.has_next_page === false &&
            cursor.offset === 0
              ? []
              : page.response.item;
          if (
            !Array.isArray(items) ||
            items.length > 100 ||
            typeof page.response.has_next_page !== 'boolean' ||
            items.some(
              (v) =>
                !isRecord(v) ||
                !Number.isSafeInteger(v.item_id) ||
                v.item_id <= 0 ||
                !statuses.includes(v.item_status),
            ) ||
            new Set(items.map((v) => v.item_id)).size !== items.length
          )
            throw Error('KNOWLEDGE_LIST_RESPONSE_INVALID');
          if (
            page.response.has_next_page &&
            (!Number.isSafeInteger(page.response.next_offset) ||
              page.response.next_offset <= cursor.offset ||
              !items.length)
          )
            throw Error('KNOWLEDGE_PAGINATION_INVALID');
          cursor.pending = items;
          cursor.hasNext = page.response.has_next_page;
          cursor.nextOffset = page.response.next_offset ?? 0;
          cursor.pageEvidenceId = page.evidenceId;
          if (!items.length) {
            cursor.statusIndex++;
            cursor.offset = 0;
            await checkpoint();
            continue;
          }
          await checkpoint();
        }
        const batch = cursor.pending.slice(0, Math.min(20, job.max_items - processedThisRun));
        const current = (
          await db.query(
            'SELECT i.*,o.observed_at FROM seller_knowledge_items i JOIN seller_knowledge_observations o ON o.id=i.evidence_id WHERE i.connection_id=$1 AND i.item_id=ANY($2::text[])',
            [connectionId, batch.map((i) => String(i.item_id))],
          )
        ).rows;
        const prior = new Map(current.map((r) => [r.item_id, r]));
        // update_time is a cheap daily cache hint, never an unlimited freshness guarantee.
        const changed = batch.filter((header) => {
          const p = prior.get(String(header.item_id));
          const age = p ? this.now() - new Date(p.observed_at).getTime() : Infinity;
          return (
            !p ||
            !p.complete ||
            age < 0 ||
            age >= 86400000 ||
            !Number.isSafeInteger(header.update_time) ||
            String(header.update_time) !== String(p.remote_updated_at) ||
            p.item_status !== header.item_status
          );
        });
        const activeChanged = changed.filter((h) => !h.item_status.endsWith('DELETE'));
        const base = activeChanged.length
          ? await this.read(
              db,
              c,
              '/api/v2/product/get_item_base_info',
              { item_id_list: activeChanged.map((h) => h.item_id).join(',') },
              id,
            )
          : null;
        const rows = base?.response.item_list;
        if (
          base &&
          (!Array.isArray(rows) ||
            rows.some(
              (r: any) =>
                !isRecord(r) || !activeChanged.some((h) => String(h.item_id) === String(r.item_id)),
            ) ||
            new Set(rows.map((r: any) => String(r.item_id))).size !== rows.length)
        )
          throw Error('KNOWLEDGE_BASE_RESPONSE_INVALID');
        for (const header of batch) {
          const itemId = String(header.item_id),
            previous = prior.get(itemId);
          let reused = !changed.includes(header),
            categoryIdUsed: string | null = previous?.category_id ?? null;
          if (reused) {
            await db.query(
              'UPDATE seller_knowledge_items SET last_seen_at=$3 WHERE connection_id=$1 AND item_id=$2',
              [connectionId, itemId, new Date(this.now())],
            );
          } else {
            const deleted = header.item_status.endsWith('DELETE'),
              item = deleted
                ? {
                    item_id: header.item_id,
                    item_status: header.item_status,
                    item_name: previous?.title ?? '',
                    item_sku: previous?.item_sku ?? '',
                    category_id: previous?.category_id,
                    brand: { brand_id: previous?.brand_id },
                    has_model: false,
                    attribute_list: [],
                  }
                : rows?.find((r: any) => String(r.item_id) === itemId);
            if (!item) throw Error('KNOWLEDGE_ITEM_MISSING_FROM_RESPONSE');
            if (
              !deleted &&
              (typeof item.has_model !== 'boolean' ||
                (item.attribute_list !== undefined && !Array.isArray(item.attribute_list)) ||
                !idText(item.category_id) ||
                typeof item.item_name !== 'string' ||
                !statuses.includes(item.item_status))
            )
              throw Error('KNOWLEDGE_ITEM_RESPONSE_INCOMPLETE');
            const modelRead = item.has_model
              ? await this.read(db, c, '/api/v2/product/get_model_list', { item_id: itemId }, id)
              : null;
            if (
              modelRead &&
              (!Array.isArray(modelRead.response.model) ||
                !modelRead.response.model.length ||
                modelRead.response.model.some(
                  (m: any) =>
                    !isRecord(m) || !idText(m.model_id) || typeof m.model_sku !== 'string',
                ))
            )
              throw Error('KNOWLEDGE_MODEL_RESPONSE_INCOMPLETE');
            const models = modelRead?.response.model ?? [],
              modelSkus = [
                ...new Set(models.map((m: any) => string(m.model_sku)).filter(Boolean)),
              ] as string[];
            const modelIdentities = models.map((m: any) => ({
              modelId: idText(m.model_id)!,
              sku: m.model_sku as string,
              tierIndex:
                Array.isArray(m.tier_index) &&
                m.tier_index.every((v: any) => Number.isSafeInteger(v) && v >= 0)
                  ? (m.tier_index as number[])
                  : null,
            }));
            const skuIdentityComplete = item.has_model
              ? modelIdentities.every((m: any) => m.sku.trim().length > 0) &&
                new Set(modelIdentities.map((m: any) => m.sku)).size === modelIdentities.length &&
                new Set(modelIdentities.map((m: any) => m.modelId)).size === modelIdentities.length
              : !deleted && string(item.item_sku).trim().length > 0;
            const observedAt = base?.observedAt ?? new Date(this.now()).toISOString();
            const body = {
              connectionId,
              scope,
              itemId,
              title: string(item.item_name),
              itemSku: string(item.item_sku),
              modelSkus,
              hasModel: item.has_model,
              modelCount: models.length,
              modelIdentities,
              skuIdentityComplete,
              categoryId: idText(item.category_id),
              brandId: idText(item.brand?.brand_id),
              attributes: item.attribute_list ?? null,
              attributeEvidenceComplete: Array.isArray(item.attribute_list),
              models,
              itemStatus: item.item_status,
              remoteUpdatedAt: Number.isSafeInteger(header.update_time) ? header.update_time : null,
              observedAt,
              issues: [
                ...(base?.warningCodes ?? []),
                ...(!deleted && item.attribute_list === undefined
                  ? ['ATTRIBUTE_LIST_NOT_RETURNED']
                  : []),
                ...(deleted ? ['LISTING_DELETED'] : []),
                ...(header.item_status !== item.item_status
                  ? ['ITEM_STATUS_CHANGED_DURING_READ']
                  : []),
                ...(!deleted && !skuIdentityComplete ? ['MODEL_SKU_IDENTITY_INCOMPLETE'] : []),
              ],
              evidenceRefs: [cursor.pageEvidenceId, base?.evidenceId, modelRead?.evidenceId].filter(
                Boolean,
              ),
              rawItem: item,
              rawModels: modelRead?.response ?? null,
            };
            // Content remains fingerprinted; a fresh GET has distinct immutable provenance.
            // The current-item table contributes at most one observation per item to retrieval.
            const contentFingerprint = digest({ scope, item, models, header });
            const evidence = await this.observation(
              db,
              connectionId,
              'listing',
              itemId,
              scope,
              { ...body, contentFingerprint },
              observedAt,
              { contentFingerprint, evidenceRefs: body.evidenceRefs, observedAt },
            );
            categoryIdUsed = body.categoryId;
            await db.query(
              `INSERT INTO seller_knowledge_items(connection_id,item_id,evidence_id,category_id,brand_id,title,item_sku,model_skus,normalized_text,item_status,remote_updated_at,complete,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13,$12) ON CONFLICT(connection_id,item_id) DO UPDATE SET evidence_id=EXCLUDED.evidence_id,category_id=EXCLUDED.category_id,brand_id=EXCLUDED.brand_id,title=EXCLUDED.title,item_sku=EXCLUDED.item_sku,model_skus=EXCLUDED.model_skus,normalized_text=EXCLUDED.normalized_text,item_status=EXCLUDED.item_status,remote_updated_at=EXCLUDED.remote_updated_at,complete=EXCLUDED.complete,last_seen_at=EXCLUDED.last_seen_at`,
              [
                connectionId,
                itemId,
                evidence.id,
                body.categoryId,
                body.brandId,
                body.title,
                body.itemSku,
                modelSkus,
                normalize([body.title, body.itemSku, ...modelSkus].join(' ')),
                body.itemStatus,
                body.remoteUpdatedAt,
                new Date(this.now()),
                body.attributeEvidenceComplete,
              ],
            );
          }
          cursor.pending.shift();
          processedThisRun++;
          if (!cursor.pending.length) {
            if (cursor.hasNext) cursor.offset = cursor.nextOffset;
            else {
              cursor.statusIndex++;
              cursor.offset = 0;
            }
          }
          await checkpoint(reused ? { reused: 1 } : { fetched: 1 });
          if (
            categoryIdUsed &&
            !header.item_status.endsWith('DELETE') &&
            !categoriesVisited.has(categoryIdUsed) &&
            categoriesVisited.size < 20
          ) {
            categoriesVisited.add(categoryIdUsed);
            cursor.pendingCategoryId = categoryIdUsed;
            await checkpoint();
            try {
              await this.category(c, categoryIdUsed, false, db, id);
            } catch (error) {
              const code = error instanceof Error ? error.message : '';
              if (
                [
                  'KNOWLEDGE_CONNECTION_CHANGED',
                  'KNOWLEDGE_CONNECTION_EXPIRED',
                  'KNOWLEDGE_CONNECTED_PRODUCTION_REQUIRED',
                  'KNOWLEDGE_API_WARNING',
                ].includes(code)
              )
                throw error;
              await db.query(
                `UPDATE seller_knowledge_syncs SET issues=CASE WHEN issues @> '["CATEGORY_METADATA_PARTIAL"]'::jsonb THEN issues ELSE issues || '["CATEGORY_METADATA_PARTIAL"]'::jsonb END WHERE id=$1`,
                [id],
              );
            }
            delete cursor.pendingCategoryId;
            await checkpoint();
          }
        }
      }
      await db.query(
        `UPDATE seller_knowledge_syncs SET state='complete',code=NULL,cursor=$2,updated_at=now() WHERE id=$1`,
        [id, cursor],
      );
    } catch (error) {
      if (locked) {
        const message = error instanceof Error ? error.message : '';
        const code =
          /^(?:KNOWLEDGE_[A-Z_]+|(?:product\.)?error_[a-z_]+|invalid_acceess_token|invalid_access_token|partner_shop_no_link|shop_no_linked|shop_banned)$/.test(
            message,
          )
            ? message
            : 'KNOWLEDGE_SYNC_FAILED';
        await db.query(
          `UPDATE seller_knowledge_syncs SET state='paused',code=$2,issues=CASE WHEN issues @> to_jsonb(ARRAY[$2]::text[]) THEN issues ELSE issues || to_jsonb(ARRAY[$2]::text[]) END,updated_at=now() WHERE id=$1`,
          [id, code],
        );
      } else throw error;
    } finally {
      if (locked)
        await db
          .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
            'seller-knowledge:' + connectionId,
          ])
          .catch(() => undefined);
      db.release();
    }
  }
  async search(raw: unknown): Promise<SellerKnowledgeListing[]> {
    const input = searchSchema.parse(raw),
      query = normalize(input.query ?? '').replace(/[\\%_]/g, '\\$&');
    const rows = (
      await this.repo.pool.query(
        `SELECT i.*,o.scope,o.body,o.observed_at FROM seller_knowledge_items i JOIN seller_knowledge_observations o ON o.id=i.evidence_id WHERE i.connection_id=$1 AND ($2::text IS NULL OR i.category_id=$2) AND ($3::text IS NULL OR i.brand_id=$3) AND ($4='' OR i.item_id=$4 OR i.normalized_text LIKE '%'||$4||'%') ORDER BY CASE WHEN i.item_status IN ('NORMAL','UNLIST') AND i.title<>'' THEN 0 WHEN i.item_status NOT IN ('SELLER_DELETE','SHOPEE_DELETE') THEN 1 ELSE 2 END,i.last_seen_at DESC,i.item_id LIMIT $5`,
        [input.connectionId, input.categoryId ?? null, input.brandId ?? null, query, input.limit],
      )
    ).rows;
    return rows.map((r) => ({
      ...r.body,
      rawItem: undefined,
      rawModels: undefined,
      evidenceId: r.evidence_id,
      scope: r.scope,
      observedAt: iso(r.observed_at),
      lastSeenAt: iso(r.last_seen_at),
    }));
  }
  async getCandidates(input: {
    connectionId: string;
    categoryId: string | number;
    brandId?: string | number;
    skus?: string[];
    excludeItemId?: string | number;
    query?: string;
  }) {
    const checked = searchSchema.parse({
      connectionId: input.connectionId,
      categoryId: input.categoryId,
      brandId: input.brandId,
      limit: 100,
    });
    const skus = z
        .array(z.string().max(200))
        .max(200)
        .parse(input.skus ?? []),
      exclude = input.excludeItemId === undefined ? null : numericId.parse(input.excludeItemId);
    const rows = (
      await this.repo.pool.query(
        `SELECT i.*,o.scope,o.body,o.observed_at,row_number() OVER(PARTITION BY i.model_skus,i.item_sku,o.body->'attributes' ORDER BY i.last_seen_at DESC,i.item_id) AS duplicate_rank FROM seller_knowledge_items i JOIN seller_knowledge_observations o ON o.id=i.evidence_id WHERE i.connection_id=$1 AND i.category_id=$2 AND ($3::text IS NULL OR i.brand_id=$3) AND ($4::text IS NULL OR i.item_id<>$4) AND i.item_status IN ('NORMAL','UNLIST') AND i.complete ORDER BY (i.model_skus && $5::text[] OR i.item_sku=ANY($5::text[])) DESC,duplicate_rank,i.last_seen_at DESC,i.item_id LIMIT 100`,
        [checked.connectionId, checked.categoryId, checked.brandId ?? null, exclude, skus],
      )
    ).rows;
    return rows.map((r) => ({
      ...r.body,
      rawItem: undefined,
      rawModels: undefined,
      evidenceId: r.evidence_id,
      scope: r.scope,
      observedAt: iso(r.observed_at),
      lastSeenAt: iso(r.last_seen_at),
    })) as SellerKnowledgeListing[];
  }
  async getCandidateCoverage(input: {
    connectionId: string;
    categoryId: string | number;
    brandId?: string | number;
    skus?: string[];
    excludeItemId?: string | number;
    query?: string;
  }) {
    const checked = searchSchema.parse({
        connectionId: input.connectionId,
        categoryId: input.categoryId,
        brandId: input.brandId,
        limit: 100,
      }),
      exclude = input.excludeItemId === undefined ? null : numericId.parse(input.excludeItemId);
    const totalCount = Number(
      (
        await this.repo.pool.query(
          `SELECT count(*) AS count FROM seller_knowledge_items WHERE connection_id=$1 AND category_id=$2 AND ($3::text IS NULL OR brand_id=$3) AND ($4::text IS NULL OR item_id<>$4) AND item_status IN ('NORMAL','UNLIST') AND complete`,
          [checked.connectionId, checked.categoryId, checked.brandId ?? null, exclude],
        )
      ).rows[0].count,
    );
    return { totalCount, limit: 100 as const, truncated: totalCount > 100 };
  }
  async getEvidence(id: string) {
    z.string().uuid().parse(id);
    const r = (
      await this.repo.pool.query('SELECT * FROM seller_knowledge_observations WHERE id=$1', [id])
    ).rows[0];
    if (!r) return null;
    const refs = Array.isArray(r.body.evidenceRefs) ? r.body.evidenceRefs : [];
    const raw = (
      await this.repo.pool.query(
        'SELECT id,scope,body,observed_at FROM seller_knowledge_observations WHERE connection_id=$1 AND id=ANY($2::uuid[])',
        [r.connection_id, refs],
      )
    ).rows;
    return {
      id: r.id,
      connectionId: r.connection_id,
      kind: r.kind,
      subjectKey: r.subject_key,
      contentHash: r.content_hash,
      scope: r.scope,
      observedAt: iso(r.observed_at),
      body: r.body,
      rawEvidence: raw.map((v) => ({
        id: v.id,
        scope: v.scope,
        observedAt: iso(v.observed_at),
        ...v.body,
      })),
    };
  }
  private async category(
    c: any,
    categoryId: string,
    refresh: boolean,
    db: Db,
    jobId?: string,
  ): Promise<SellerKnowledgeCategory> {
    const cached = (
      await db.query(
        `SELECT k.expires_at,o.* FROM seller_knowledge_categories k JOIN seller_knowledge_observations o ON o.id=k.evidence_id WHERE k.connection_id=$1 AND k.category_id=$2 AND k.connection_revision=$3`,
        [c.id, categoryId, c.revision],
      )
    ).rows[0];
    if (!refresh && cached && new Date(cached.expires_at).getTime() > this.now())
      return {
        ...cached.body,
        evidenceId: cached.id,
        observedAt: iso(cached.observed_at),
        expiresAt: iso(cached.expires_at),
      };
    let tree = (
      await db.query(
        `SELECT k.expires_at,o.* FROM seller_knowledge_categories k JOIN seller_knowledge_observations o ON o.id=k.evidence_id WHERE k.connection_id=$1 AND k.category_id='0' AND k.connection_revision=$2`,
        [c.id, c.revision],
      )
    ).rows[0];
    if (!tree || new Date(tree.expires_at).getTime() <= this.now()) {
      const read = await this.read(
        db,
        c,
        '/api/v2/product/get_category',
        { language: 'vi' },
        jobId,
      );
      if (!Array.isArray(read.response.category_list))
        throw Error('KNOWLEDGE_CATEGORY_RESPONSE_INVALID');
      tree = await this.observation(
        db,
        c.id,
        'category_tree',
        '0',
        scopeOf(c),
        { categories: read.response.category_list, evidenceRefs: [read.evidenceId] },
        read.observedAt,
      );
      await db.query(
        `INSERT INTO seller_knowledge_categories(connection_id,category_id,evidence_id,connection_revision,expires_at) VALUES($1,'0',$2,$3,$4) ON CONFLICT(connection_id,category_id) DO UPDATE SET evidence_id=EXCLUDED.evidence_id,connection_revision=EXCLUDED.connection_revision,expires_at=EXCLUDED.expires_at`,
        [c.id, tree.id, c.revision, new Date(Date.parse(read.observedAt) + 900000)],
      );
    }
    const read = await this.read(
        db,
        c,
        '/api/v2/product/get_attribute_tree',
        { category_id_list: categoryId, language: 'vn' },
        jobId,
      ),
      entry = Array.isArray(read.response.list)
        ? read.response.list.find((x: any) => String(x.category_id) === categoryId)
        : null;
    if (!entry || !Array.isArray(entry.attribute_tree))
      throw Error('KNOWLEDGE_ATTRIBUTE_TREE_INVALID');
    const categoryPath: any[] = [];
    let node = tree.body.categories.find((n: any) => String(n.category_id) === categoryId);
    const visited = new Set<string>();
    while (node && !visited.has(String(node.category_id))) {
      visited.add(String(node.category_id));
      categoryPath.unshift(node);
      node = tree.body.categories.find(
        (n: any) => String(n.category_id) === String(node.parent_category_id),
      );
    }
    const oldest = Math.min(new Date(tree.observed_at).getTime(), Date.parse(read.observedAt));
    const body = {
      categoryId,
      scope: scopeOf(c),
      observedAt: new Date(oldest).toISOString(),
      expiresAt: new Date(oldest + 900000).toISOString(),
      attributeTree: entry.attribute_tree,
      categoryPath,
      issues: [
        ...(!categoryPath.length ? ['CATEGORY_NOT_IN_CURRENT_TREE'] : []),
        ...(entry.warning ? ['ATTRIBUTE_API_WARNING'] : []),
      ],
      evidenceRefs: [tree.id, read.evidenceId],
    };
    const evidence = await this.observation(
      db,
      c.id,
      'category',
      categoryId,
      scopeOf(c),
      body,
      body.observedAt,
    );
    await db.query(
      `INSERT INTO seller_knowledge_categories(connection_id,category_id,evidence_id,connection_revision,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(connection_id,category_id) DO UPDATE SET evidence_id=EXCLUDED.evidence_id,connection_revision=EXCLUDED.connection_revision,expires_at=EXCLUDED.expires_at`,
      [c.id, categoryId, evidence.id, c.revision, body.expiresAt],
    );
    return { ...body, evidenceId: evidence.id };
  }
  async getCategory(input: {
    connectionId: string;
    categoryId: string | number;
    refresh?: boolean;
  }) {
    const connectionId = z.string().uuid().parse(input.connectionId),
      categoryId = numericId.parse(input.categoryId),
      refresh = z.boolean().optional().parse(input.refresh) ?? false;
    const db = await this.repo.pool.connect();
    let locked = false;
    try {
      locked = (
        await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [
          'seller-knowledge:' + connectionId,
        ])
      ).rows[0].locked;
      if (!locked) throw Error('KNOWLEDGE_SYNC_BUSY');
      return await this.category(await this.connection(connectionId, db), categoryId, refresh, db);
    } finally {
      if (locked)
        await db
          .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
            'seller-knowledge:' + connectionId,
          ])
          .catch(() => undefined);
      db.release();
    }
  }
  async listShops() {
    const shops = (await listShopConnections(this.repo.pool)).filter(
      (s) => s.scope.environment === 'production',
    );
    const output = [];
    for (const shop of shops) {
      const stats = (
        await this.repo.pool.query(
          `SELECT count(*)::integer AS count,max(last_seen_at) AS last_seen_at FROM seller_knowledge_items WHERE connection_id=$1`,
          [shop.id],
        )
      ).rows[0];
      const latest = (
        await this.repo.pool.query(
          'SELECT * FROM seller_knowledge_syncs WHERE connection_id=$1 ORDER BY created_at DESC LIMIT 1',
          [shop.id],
        )
      ).rows[0];
      const tree = (
        await this.repo.pool.query(
          `SELECT o.body FROM seller_knowledge_categories k JOIN seller_knowledge_observations o ON o.id=k.evidence_id WHERE k.connection_id=$1 AND k.category_id='0'`,
          [shop.id],
        )
      ).rows[0]?.body;
      const categories = (
        await this.repo.pool.query(
          'SELECT category_id,count(*)::integer AS count FROM seller_knowledge_items WHERE connection_id=$1 AND category_id IS NOT NULL GROUP BY category_id ORDER BY count(*) DESC',
          [shop.id],
        )
      ).rows.map((r) => {
        const category = tree?.categories?.find(
          (c: any) => String(c.category_id) === r.category_id,
        );
        return {
          id: r.category_id,
          name:
            category?.display_category_name ?? category?.original_category_name ?? r.category_id,
          count: r.count,
        };
      });
      output.push({
        ...shop,
        listingCount: stats.count,
        lastSeenAt: stats.last_seen_at ? iso(stats.last_seen_at) : null,
        latestSync: latest ? syncView(latest) : null,
        categories,
      });
    }
    return output;
  }
}
