import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { canonicalJson } from '@shopee/domain';
import { Repository, transaction } from '@shopee/persistence';
import { normalizePreparedWireSnapshot } from '../../../packages/shopee/src/prepared-wire.js';
import {
  productionPilotWriteFingerprint,
  type ProductionPilotMutationIntent,
} from '../../../packages/shopee/src/production-pilot-transport.js';
import type { FieldSnapshot } from '../../../packages/shopee/src/field-client.js';
import type {
  ProductionPilotSource,
  ProductionPilotReadback,
  ProductionPilotOutcome,
} from './production-pilot-journal.js';
import { assertProductionPilotBatchBinding, parseProductionPilotBatchAuthorization,
  type ProductionPilotBatchAuthorization } from './production-pilot-batch-authorization.js';

const owner = 'production:2010476:1423724897';
const path = '/api/v2/product/unlist_item';
const uuid = z.string().uuid(),
  revision = z.number().int().positive();
function fail(code: string): never {
  throw new Error('PRODUCTION_PILOT_PUBLICATION_' + code);
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const metadataSchema = z
  .object({
    environment: z.literal('production'),
    partnerId: z.literal('2010476'),
    shopId: z.literal('1423724897'),
    connectionRevision: revision,
    categoryId: z.string().min(1),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    requestIds: z.array(z.string().min(1).max(256)).min(1),
  })
  .strict();
export type ProductionPilotPublicationMetadata = z.infer<typeof metadataSchema>;
function id(value: unknown): string | undefined {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === 'string' &&
    /^[1-9]\d*$/.test(value) &&
    Number.isSafeInteger(Number(value))
    ? value
    : undefined;
}
function snapshot(value: unknown): Record<string, any> {
  let nodes = 0;
  const copy = (entry: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 50) fail('INVALID_SNAPSHOT');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) {
      if (entry.length > 100000 || Object.keys(entry).length !== entry.length)
        fail('INVALID_SNAPSHOT');
      return Array.from({ length: entry.length }, (_, index) => {
        const d = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!d || !Object.hasOwn(d, 'value')) fail('INVALID_SNAPSHOT');
        return copy(d.value, depth + 1);
      });
    }
    if (!record(entry) || ![Object.prototype, null].includes(Object.getPrototypeOf(entry)))
      fail('INVALID_SNAPSHOT');
    return Object.fromEntries(
      Object.keys(entry).map((key) => {
        const d = Object.getOwnPropertyDescriptor(entry, key)!;
        if (
          !Object.hasOwn(d, 'value') ||
          ([
            'partner_key',
            'partnerkey',
            'access_token',
            'accesstoken',
            'refresh_token',
            'refreshtoken',
            'password',
            'authorization',
          ].includes(key.toLowerCase()) &&
            !['[redacted]', '[REDACTED]'].includes(d.value))
        )
          fail('INVALID_SNAPSHOT');
        return [key, copy(d.value, depth + 1)];
      }),
    );
  };
  const result = copy(value, 0);
  if (!record(result) || Buffer.byteLength(JSON.stringify(result)) > 16_000_000)
    fail('INVALID_SNAPSHOT');
  return result;
}
/** A transport-level success still needs exact per-item acknowledgement. */
export function inspectProductionPilotPublicationAcknowledgement(
  response: unknown,
  itemId: string,
): 'acknowledged' | 'rejected' | 'unknown' {
  if (
    !id(itemId) ||
    !record(response) ||
    !Array.isArray(response.success_list) ||
    !Array.isArray(response.failure_list)
  )
    return 'unknown';
  if (response.failure_list.length === 0 && response.success_list.length === 1) {
    const row = response.success_list[0];
    return record(row) && id(row.item_id) === itemId && row.unlist === false
      ? 'acknowledged'
      : 'unknown';
  }
  if (response.success_list.length === 0 && response.failure_list.length === 1) {
    const row = response.failure_list[0];
    if (
      record(row) &&
      id(row.item_id) === itemId &&
      typeof row.failed_reason === 'string' &&
      row.failed_reason.trim()
    )
      return 'rejected';
  }
  return 'unknown';
}
function readbacks(value: unknown): ProductionPilotReadback[] {
  return z
    .array(
      z
        .object({
          shopId: z.literal('1423724897'),
          partnerId: z.literal('2010476'),
          itemId: z.string().regex(/^[1-9]\d*$/),
          connectionRevision: revision,
          observedAt: z.iso.datetime(),
          requestIds: z.array(z.string().min(1).max(256)).length(2),
          raw: z.record(z.string(), z.unknown()),
          projection: z.record(z.string(), z.unknown()),
        })
        .strict(),
    )
    .length(2)
    .parse(value);
}
function normalized(read: ProductionPilotReadback): FieldSnapshot {
  const raw = read.raw as Record<string, any>;
  if (
    !record(raw.base) ||
    !record(raw.models) ||
    raw.base.error !== '' ||
    raw.models.error !== '' ||
    !record(raw.base.response) ||
    !record(raw.models.response)
  )
    fail('READBACK_SCOPE_INVALID');
  const items = raw.base.response.item_list;
  if (
    !Array.isArray(items) ||
    items.length !== 1 ||
    id(items[0]?.item_id) !== read.itemId ||
    canonicalJson([...read.requestIds].sort()) !==
      canonicalJson([raw.base.request_id, raw.models.request_id].sort())
  )
    fail('READBACK_SCOPE_INVALID');
  const models = z
    .object({
      model: z.array(z.record(z.string(), z.unknown())),
      tier_variation: z.array(z.record(z.string(), z.unknown())),
    })
    .passthrough()
    .parse(raw.models.response);
  return normalizePreparedWireSnapshot({ item: items[0], models });
}

/** Trusted server-only single-item publisher. No API call, generic item adoption, or retry path. */
export class ProductionPilotPublicationJournal {
  private readonly allowed: ProductionPilotSource[];
  private readonly batchAuthorization?: ProductionPilotBatchAuthorization;
  constructor(
    readonly repo: Repository,
    options: { allowedSources: readonly ProductionPilotSource[]; batchAuthorization?: ProductionPilotBatchAuthorization },
  ) {
    this.allowed = z
      .array(
        z.object({ sourceIdentity: z.string().min(1).max(200), sourceRevision: revision }).strict(),
      )
      .min(1)
      .max(9)
      .parse(options.allowedSources);
    this.batchAuthorization = parseProductionPilotBatchAuthorization(options.batchAuthorization, this.allowed);
    if (
      new Set(this.allowed.map((s) => JSON.stringify([s.sourceIdentity, s.sourceRevision])))
        .size !== this.allowed.length
    )
      fail('SOURCE_ALLOWLIST_INVALID');
    const identities = new Set(this.allowed.map((source) => source.sourceIdentity));
    if (
      identities.size > (this.batchAuthorization?.sources.length ?? 3) ||
      [...identities].some(
        (identity) =>
          this.allowed.filter((source) => source.sourceIdentity === identity).length > 3,
      )
    )
      fail('SOURCE_ALLOWLIST_INVALID');
  }
  private allow(row: any) {
    if (
      !this.allowed.some(
        (source) =>
          source.sourceIdentity === row.source_identity &&
          source.sourceRevision === row.source_revision,
      )
    )
      fail('SOURCE_FORBIDDEN');
  }
  private lock(c: PoolClient) {
    return c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'production-pilot:' + owner,
    ]);
  }
  private async connection(c: PoolClient, connectionId: string, expectedRevision?: number) {
    const row = (
      await c.query('SELECT * FROM connections WHERE id=$1 FOR SHARE', [uuid.parse(connectionId)])
    ).rows[0];
    if (
      !row ||
      row.environment !== 'production' ||
      row.partner_id !== '2010476' ||
      row.shop_id !== '1423724897'
    )
      fail('SCOPE_FORBIDDEN');
    if (expectedRevision !== undefined && row.revision !== expectedRevision)
      fail('CONNECTION_CHANGED');
    if (
      expectedRevision !== undefined &&
      (row.state !== 'connected' ||
        !row.expires_at ||
        new Date(row.expires_at).getTime() <= Date.now())
    )
      fail('AUTH_REQUIRED');
    return row;
  }
  private async create(c: PoolClient, createOperationId: string) {
    const row = (
      await c.query('SELECT * FROM production_pilot_operations WHERE id=$1 FOR SHARE', [
        uuid.parse(createOperationId),
      ])
    ).rows[0];
    if (!row || row.owner_key !== owner) fail('CREATE_NOT_FOUND');
    this.allow(row);
    assertProductionPilotBatchBinding(this.batchAuthorization, row);
    const verification = (
      await c.query('SELECT * FROM production_pilot_verifications WHERE operation_id=$1', [row.id])
    ).rows[0];
    const steps = (
      await c.query('SELECT kind,state FROM production_pilot_steps WHERE operation_id=$1', [row.id])
    ).rows;
    if (
      row.state !== 'verified' ||
      !id(row.item_id) ||
      !verification ||
      verification.phase !== 'created_unlisted' ||
      verification.operation_revision !== row.revision - 1 ||
      verification.item_id !== row.item_id ||
      verification.expected_fingerprint !== fingerprint(row.expected_projection) ||
      row.expected_projection.status !== 'UNLIST' ||
      !steps.some((s) => s.kind === 'create') ||
      steps.some((s) => s.state !== 'acknowledged')
    )
      fail('CREATE_UNVERIFIED');
    return { row, verification };
  }
  private async operation(c: PoolClient, operationId: string, expectedRevision?: number) {
    const row = (
      await c.query('SELECT * FROM production_pilot_publications WHERE id=$1 FOR UPDATE', [
        uuid.parse(operationId),
      ])
    ).rows[0];
    if (!row || row.owner_key !== owner) fail('OPERATION_NOT_FOUND');
    this.allow(row);
    const source = (await c.query('SELECT * FROM production_pilot_operations WHERE id=$1 FOR SHARE',
      [row.create_operation_id])).rows[0];
    if (!source || source.owner_key !== owner || source.source_identity !== row.source_identity ||
      source.source_revision !== row.source_revision || source.source_fingerprint !== row.source_fingerprint)
      fail('CREATE_UNVERIFIED');
    assertProductionPilotBatchBinding(this.batchAuthorization, source);
    if (expectedRevision !== undefined && row.revision !== expectedRevision)
      fail('REVISION_CONFLICT');
    return row;
  }
  private async lane(c: PoolClient, createOperationId: string) {
    const existing = (
      await c.query(
        'SELECT operation_id FROM production_pilot_lanes WHERE owner_key=$1 FOR UPDATE',
        [owner],
      )
    ).rows[0];
    if (existing && existing.operation_id !== createOperationId) fail('SHOP_BUSY');
    if (!existing)
      await c.query('INSERT INTO production_pilot_lanes(owner_key,operation_id) VALUES($1,$2)', [
        owner,
        createOperationId,
      ]);
  }
  private async view(c: Pick<PoolClient, 'query'>, operationId: string) {
    const operation = (
      await c.query('SELECT * FROM production_pilot_publications WHERE id=$1', [operationId])
    ).rows[0];
    const verification =
      (
        await c.query(
          'SELECT * FROM production_pilot_publication_verifications WHERE operation_id=$1',
          [operationId],
        )
      ).rows[0] ?? null;
    return { operation, verification };
  }
  async get(operationId: string) {
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      await this.operation(c, operationId);
      return this.view(c, operationId);
    });
  }
  async getForCreate(createOperationId: string) {
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      await this.create(c, createOperationId);
      const row = (
        await c.query('SELECT id FROM production_pilot_publications WHERE create_operation_id=$1', [
          createOperationId,
        ])
      ).rows[0];
      return row ? this.view(c, row.id) : null;
    });
  }
  private checkReads(
    reads: ProductionPilotReadback[],
    itemId: string,
    connectionRevision: number,
    after: number,
    previousRequestIds: string[],
    expectedProjection: Record<string, any>,
    expectedRaw: FieldSnapshot,
  ) {
    const times = reads.map((r) => Date.parse(r.observedAt)),
      now = Date.now();
    if (
      !(
        times[0]! > after &&
        times[1]! > times[0]! &&
        times[1]! <= now &&
        now - times[0]! <= 15 * 60 * 1000
      ) ||
      reads.some((r) => r.itemId !== itemId || r.connectionRevision !== connectionRevision)
    )
      fail('READBACK_SCOPE_INVALID');
    const ids = [...previousRequestIds, ...reads.flatMap((r) => r.requestIds)];
    if (new Set(ids).size !== ids.length) fail('READBACK_SCOPE_INVALID');
    for (const read of reads)
      if (
        canonicalJson(read.projection) !== canonicalJson(expectedProjection) ||
        canonicalJson(normalized(read)) !== canonicalJson(expectedRaw)
      )
        fail('READBACK_MISMATCH');
  }
  async authorizePublication(raw: {
    createOperationId: string;
    connectionId: string;
    expectedConnectionRevision: number;
    preflightExpiresAt: string;
    metadata: ProductionPilotPublicationMetadata;
    readbacks: readonly ProductionPilotReadback[];
  }) {
    const input = z
      .object({
        createOperationId: uuid,
        connectionId: uuid,
        expectedConnectionRevision: revision,
        preflightExpiresAt: z.iso.datetime(),
        metadata: metadataSchema,
        readbacks: z.unknown(),
      })
      .strict()
      .parse(snapshot(raw));
    const reads = readbacks(input.readbacks);
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      const { row: source, verification } = await this.create(c, input.createOperationId);
      if (source.connection_id !== input.connectionId) fail('SCOPE_FORBIDDEN');
      await this.connection(c, input.connectionId, input.expectedConnectionRevision);
      const metadata = input.metadata;
      if (
        metadata.connectionRevision !== input.expectedConnectionRevision ||
        metadata.categoryId !== source.source_payload.document?.categoryId ||
        metadata.expiresAt !== input.preflightExpiresAt ||
        Date.parse(metadata.observedAt) > Date.parse(reads[0]!.observedAt) ||
        Date.parse(metadata.expiresAt) - Date.parse(metadata.observedAt) > 15 * 60 * 1000 ||
        Date.parse(metadata.expiresAt) <= Date.parse(metadata.observedAt)
      )
        fail('METADATA_STALE_OR_MISMATCHED');
      const old = (
        await c.query(
          'SELECT * FROM production_pilot_publications WHERE create_operation_id=$1 FOR UPDATE',
          [source.id],
        )
      ).rows[0];
      if (old) return this.view(c, old.id);
      const originals = verification.readbacks as ProductionPilotReadback[],
        expectedRaw = normalized(originals[1]!);
      if (canonicalJson(normalized(originals[0]!)) !== canonicalJson(expectedRaw))
        fail('CREATE_UNVERIFIED');
      // Observation times share the collector clock; database commit time may have clock skew.
      this.checkReads(
        reads,
        source.item_id,
        input.expectedConnectionRevision,
        Math.max(...originals.map((r) => Date.parse(r.observedAt))),
        originals.flatMap((r) => r.requestIds),
        source.expected_projection,
        expectedRaw,
      );
      const expires = Date.parse(input.preflightExpiresAt),
        observed = Date.parse(reads[1]!.observedAt);
      if (expires <= Date.now() || expires <= observed || expires - observed > 15 * 60 * 1000)
        fail('PREFLIGHT_EXPIRED');
      const payload = { item_list: [{ item_id: Number(source.item_id), unlist: false }] },
        operationId = randomUUID();
      await this.lane(c, source.id);
      await c.query(
        `INSERT INTO production_pilot_publications(id,owner_key,create_operation_id,create_verification_id,connection_id,connection_revision,source_identity,source_revision,source_fingerprint,item_id,path,payload,fingerprint,expected_projection,expected_raw,preflight_readbacks,preflight_expires_at,preflight_metadata,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'authorized')`,
        [
          operationId,
          owner,
          source.id,
          verification.id,
          input.connectionId,
          input.expectedConnectionRevision,
          source.source_identity,
          source.source_revision,
          source.source_fingerprint,
          source.item_id,
          path,
          payload,
          productionPilotWriteFingerprint(path, payload),
          source.expected_projection,
          expectedRaw,
          JSON.stringify(reads),
          input.preflightExpiresAt,
          metadata,
        ],
      );
      return this.view(c, operationId);
    });
  }
  async markSent(intent: Readonly<ProductionPilotMutationIntent>): Promise<boolean> {
    uuid.parse(intent.operationId);
    uuid.parse(intent.stepId);
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      const operation = await this.operation(c, intent.operationId);
      if (
        operation.state !== 'authorized' ||
        intent.stepId !== operation.id ||
        intent.path !== operation.path ||
        intent.fingerprint !== operation.fingerprint
      )
        return false;
      await this.connection(c, operation.connection_id, operation.connection_revision);
      await this.create(c, operation.create_operation_id);
      await this.lane(c, operation.create_operation_id);
      if (new Date(operation.preflight_expires_at).getTime() <= Date.now())
        fail('PREFLIGHT_EXPIRED');
      await c.query(
        "UPDATE production_pilot_publications SET state='sent',revision=revision+1,sent_at=$2,updated_at=now() WHERE id=$1",
        [operation.id, new Date()],
      );
      return true;
    });
  }
  async recordOutcome(input: {
    operationId: string;
    expectedRevision: number;
    result: ProductionPilotOutcome;
  }) {
    revision.parse(input.expectedRevision);
    const result = snapshot(input.result);
    z.enum(['success', 'rejected', 'unknown']).parse(result.kind);
    if (result.kind === 'success') z.string().min(1).max(256).parse(result.requestId);
    else z.string().min(1).max(200).parse(result.code);
    const resultHash = fingerprint(result);
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      const operation = await this.operation(c, input.operationId);
      if (operation.outcome_fingerprint === resultHash) return this.view(c, operation.id);
      if (operation.revision !== input.expectedRevision) fail('REVISION_CONFLICT');
      if (operation.state !== 'sent') fail('REPLAY_FORBIDDEN');
      const state =
        result.kind === 'success'
          ? inspectProductionPilotPublicationAcknowledgement(result.response, operation.item_id)
          : result.kind;
      await c.query(
        'UPDATE production_pilot_publications SET state=$2,receipt=$3,outcome_fingerprint=$4,recorded_at=$5,revision=revision+1,updated_at=now() WHERE id=$1',
        [operation.id, state, result, resultHash, new Date()],
      );
      return this.view(c, operation.id);
    });
  }
  async recordVerification(input: {
    operationId: string;
    expectedRevision: number;
    readbacks: readonly ProductionPilotReadback[];
  }) {
    revision.parse(input.expectedRevision);
    const reads = readbacks(snapshot({ readbacks: input.readbacks }).readbacks);
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      const operation = await this.operation(c, input.operationId, input.expectedRevision);
      if (!['acknowledged', 'unknown', 'rejected'].includes(operation.state))
        fail('RECONCILIATION_REQUIRED');
      await this.connection(c, operation.connection_id, reads[0]!.connectionRevision);
      const original = await this.create(c, operation.create_operation_id);
      if (
        operation.source_fingerprint !== original.row.source_fingerprint ||
        operation.create_verification_id !== original.verification.id
      )
        fail('SOURCE_CHANGED');
      const expected = { ...operation.expected_projection, status: 'NORMAL' },
        expectedRaw = structuredClone(operation.expected_raw) as FieldSnapshot;
      expectedRaw.item.item_status = 'NORMAL';
      const prior = operation.preflight_readbacks as ProductionPilotReadback[];
      this.checkReads(
        reads,
        operation.item_id,
        reads[0]!.connectionRevision,
        Math.max(
          new Date(operation.sent_at).getTime(),
          operation.recorded_at ? new Date(operation.recorded_at).getTime() : 0,
        ),
        [
          ...prior.flatMap((r) => r.requestIds),
          ...(original.verification.readbacks as ProductionPilotReadback[]).flatMap(
            (r) => r.requestIds,
          ),
        ],
        expected,
        expectedRaw,
      );
      const saved = reads.map((r) => ({
        ...r,
        rawSha256: fingerprint(r.raw),
        projectionSha256: fingerprint(r.projection),
      }));
      await c.query(
        `INSERT INTO production_pilot_publication_verifications(id,operation_id,operation_revision,phase,basis,item_id,readbacks,evidence_fingerprint) VALUES($1,$2,$3,'published',$4,$5,$6,$7)`,
        [
          randomUUID(),
          operation.id,
          operation.revision,
          operation.state === 'acknowledged' ? 'acknowledged' : 'read_reconciliation',
          operation.item_id,
          JSON.stringify(saved),
          fingerprint(saved),
        ],
      );
      await c.query(
        "UPDATE production_pilot_publications SET state='verified',revision=revision+1,updated_at=now() WHERE id=$1",
        [operation.id],
      );
      await c.query('DELETE FROM production_pilot_lanes WHERE owner_key=$1 AND operation_id=$2', [
        owner,
        operation.create_operation_id,
      ]);
      return this.view(c, operation.id);
    });
  }
}
