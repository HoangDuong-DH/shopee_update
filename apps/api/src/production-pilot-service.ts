import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { Repository } from '@shopee/persistence';
import { canonicalJson } from '@shopee/domain';
import { preparedWireMediaRequirements } from '../../../packages/shopee/src/prepared-wire.js';
import { productionPilotWriteFingerprint } from '../../../packages/shopee/src/production-pilot-transport.js';
import { ProductionPilotRunner } from './production-pilot-runner.js';
import {
  collectProductionPilotInput,
  loadProductionPilotSource,
  pilotProbeAuthorization,
  productionPilotScope,
  productionPilotSourceRoot,
} from './production-pilot-source.js';

const owner = 'production:2010476:1423724897';
type OperationSummary = {
  id: string;
  source_identity: string;
  source_revision: number;
  item_id: string | null;
  state: string;
  revision?: number;
  owner_key?: string;
  connection_id?: string;
  connection_revision?: number;
  source_payload?: Record<string, any>;
  source_fingerprint?: string;
  expected_projection?: Record<string, any>;
  current_connection?: Record<string, any>;
  create_verification?: Record<string, any> | null;
  publication?: Record<string, any> | null;
  publication_verification?: Record<string, any> | null;
  step_states?: { step_key: string; state: string }[];
  publication_state?: string;
  closure_operation_id?: string | null;
  supersedes_operation_id?: string | null;
  total: number;
  acknowledged: number;
  sent: number;
  unknown: number;
  rejected: number;
  upload_acknowledged: number;
  create_acknowledged: number;
  model_acknowledged: number;
  failure_code?: string;
  failure_message?: string;
  failure_debug_message?: string;
  failure_request_id?: string;
  failure_path?: string;
};
type LoadedSource = Awaited<ReturnType<typeof loadProductionPilotSource>>;
const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
type Stage = 'unsent' | 'reconcile_create' | 'publish' | 'reconcile_publication' | 'published';
/** Recheck immutable journal evidence before treating an existing item as fulfilled work. */
function verifiedReads(
  proof: Record<string, any> | null | undefined,
  opId: string,
  revision: number,
  itemId: string,
  phase: string,
  expected: Record<string, any>,
  connection: Record<string, any>,
) {
  if (
    !proof ||
    proof.operation_id !== opId ||
    proof.operation_revision !== revision - 1 ||
    proof.item_id !== itemId ||
    proof.phase !== phase ||
    !Array.isArray(proof.readbacks) ||
    proof.readbacks.length !== 2 ||
    proof.evidence_fingerprint !== fingerprint(proof.readbacks)
  )
    return false;
  const reads = proof.readbacks;
  if (!(Date.parse(reads[0]?.observedAt) < Date.parse(reads[1]?.observedAt))) return false;
  const ids = reads.flatMap((r: any) => r.requestIds ?? []);
  return (
    ids.length >= 2 &&
    new Set(ids).size === ids.length &&
    reads.every(
      (r: any) =>
        r.partnerId === productionPilotScope.partnerId &&
        r.shopId === productionPilotScope.shopId &&
        r.itemId === itemId &&
        Number.isSafeInteger(r.connectionRevision) &&
        r.connectionRevision > 0 &&
        r.connectionRevision <= connection.revision &&
        Array.isArray(r.requestIds) &&
        r.requestIds.length > 0 &&
        r.requestIds.every((id: unknown) => typeof id === 'string' && id.length > 0) &&
        r.raw &&
        typeof r.raw === 'object' &&
        Object.keys(r.raw).length > 0 &&
        r.rawSha256 === fingerprint(r.raw) &&
        r.projectionSha256 === fingerprint(r.projection) &&
        same(r.projection, expected),
    )
  );
}
function existingStage(
  source: LoadedSource,
  listing: any,
  op: OperationSummary,
): Stage | undefined {
  try {
    const payload = op.source_payload,
      connection = op.current_connection;
    if (
      !payload ||
      !connection ||
      op.owner_key !== owner ||
      !Number.isSafeInteger(op.revision) ||
      !Number.isSafeInteger(op.connection_revision) ||
      !op.connection_revision ||
      connection.id !== op.connection_id ||
      connection.environment !== 'production' ||
      connection.partner_id !== productionPilotScope.partnerId ||
      connection.shop_id !== productionPilotScope.shopId ||
      connection.state !== 'connected' ||
      connection.revision < op.connection_revision ||
      payload.connectionId !== op.connection_id ||
      payload.connectionRevision !== op.connection_revision ||
      payload.sourceIdentity !== listing.sourceIdentity ||
      payload.sourceRevision !== listing.sourceRevision ||
      (payload.supersedesOperationId ?? null) !== (listing.supersedesOperationId ?? null) ||
      (op.supersedes_operation_id ?? null) !== (listing.supersedesOperationId ?? null) ||
      !same(payload.document, listing.document) ||
      !same(payload.assets, source.value.assets) ||
      !same(payload.context?.attributeList, listing.proposedAttributeList) ||
      ['metadata', 'capabilityEvidence'].some(
        (key) =>
          payload[key]?.environment !== 'production' ||
          payload[key]?.partnerId !== productionPilotScope.partnerId ||
          payload[key]?.shopId !== productionPilotScope.shopId ||
          payload[key]?.connectionRevision !== op.connection_revision,
      ) ||
      !op.expected_projection ||
      op.source_fingerprint !==
        fingerprint({
          scope: productionPilotScope,
          sourceIdentity: listing.sourceIdentity,
          sourceRevision: listing.sourceRevision,
          sourcePayload: payload,
          expectedProjection: op.expected_projection,
        })
    )
      return undefined;
    const keys = [
      ...preparedWireMediaRequirements(payload.document).map((_, i) => 'media-' + i),
      'create',
      ...(payload.document.tierNames.length ? ['variations'] : []),
    ];
    if (
      !op.item_id ||
      !/^[1-9]\d*$/.test(op.item_id) ||
      !Number.isSafeInteger(Number(op.item_id)) ||
      !op.step_states ||
      op.step_states.length !== keys.length ||
      op.total !== keys.length ||
      op.acknowledged !== keys.length ||
      op.sent !== 0 ||
      op.unknown !== 0 ||
      op.rejected !== 0 ||
      !keys.every(
        (key) =>
          op.step_states!.filter((step) => step.step_key === key && step.state === 'acknowledged')
            .length === 1,
      )
    )
      return undefined;
    if (
      op.state === 'acknowledged' &&
      !op.create_verification &&
      !op.publication &&
      !op.publication_state
    )
      return 'reconcile_create';
    if (
      op.state !== 'verified' ||
      !op.create_verification ||
      op.create_verification.expected_fingerprint !== fingerprint(op.expected_projection) ||
      !verifiedReads(
        op.create_verification,
        op.id,
        op.revision!,
        op.item_id,
        'created_unlisted',
        op.expected_projection,
        connection,
      )
    )
      return undefined;
    const publication = op.publication;
    if (!publication && !op.publication_state && !op.publication_verification) return 'publish';
    if (
      !publication ||
      publication.owner_key !== owner ||
      publication.create_operation_id !== op.id ||
      publication.create_verification_id !== op.create_verification.id ||
      publication.item_id !== op.item_id ||
      publication.source_identity !== op.source_identity ||
      publication.source_revision !== op.source_revision ||
      publication.source_fingerprint !== op.source_fingerprint ||
      publication.connection_id !== op.connection_id ||
      !Number.isSafeInteger(publication.connection_revision) ||
      publication.connection_revision < op.connection_revision ||
      publication.connection_revision > connection.revision ||
      publication.state !== op.publication_state ||
      publication.path !== '/api/v2/product/unlist_item' ||
      !same(publication.payload, { item_list: [{ item_id: Number(op.item_id), unlist: false }] }) ||
      publication.fingerprint !==
        productionPilotWriteFingerprint(publication.path, publication.payload) ||
      !same(publication.expected_projection, op.expected_projection) ||
      !publication.receipt ||
      publication.outcome_fingerprint !== fingerprint(publication.receipt)
    )
      return undefined;
    if (
      publication.state === 'acknowledged' &&
      !op.publication_verification &&
      publication.receipt.kind === 'success'
    )
      return 'reconcile_publication';
    if (
      publication.state === 'verified' &&
      verifiedReads(
        op.publication_verification,
        publication.id,
        publication.revision,
        op.item_id,
        'published',
        { ...op.expected_projection, status: 'NORMAL' },
        connection,
      )
    )
      return 'published';
  } catch {
    /* Malformed evidence cannot grant a continuation. */
  }
  return undefined;
}
function reasonCode(op: OperationSummary) {
  if (
    op.state === 'rejected' &&
    op.failure_path === '/api/v2/product/add_item' &&
    op.failure_code === 'product.error_busi' &&
    op.failure_request_id &&
    op.failure_debug_message?.includes(
      'Rule Type: logistics.channel.force_enable_forbid_disable',
    ) &&
    op.failure_debug_message.includes('"code":1326') &&
    op.failure_debug_message.includes('"msg":"cannot disable a force-enabled channel"')
  )
    return 'LOGISTICS_FORCE_CHANNEL_REQUIRED';
  if (
    op.state === 'rejected' &&
    op.failure_path === '/api/v2/product/add_item' &&
    op.failure_code === 'product.error_param' &&
    op.failure_request_id &&
    op.failure_message?.includes(
      'You are not in the whitelist to add images in description, can only upload plain text',
    )
  )
    return 'DESC_IMAGES_NOT_ALLOWED';
  return op.failure_code;
}
function publicAttempt(op: OperationSummary) {
  return {
    operationId: op.id,
    sourceIdentity: op.source_identity,
    sourceRevision: op.source_revision,
    itemId: op.item_id,
    state: op.state,
    publicationState: op.publication_state,
    rejectionClosed: op.closure_operation_id === op.id,
    reasonCode: reasonCode(op),
    requestId: op.failure_request_id,
    stepCounts: {
      total: op.total,
      acknowledged: op.acknowledged,
      sent: op.sent,
      unknown: op.unknown,
      rejected: op.rejected,
      uploadsAcknowledged: op.upload_acknowledged,
      createsAcknowledged: op.create_acknowledged,
      modelsAcknowledged: op.model_acknowledged,
    },
  };
}
function continuationPlan(source: LoadedSource, operations: OperationSummary[]) {
  const listings = source.value.listings;
  const consumed = new Set<string>();
  const entries: { listing: any; operation?: OperationSummary; stage: Stage }[] = [];
  const blocked = () => ({
    entries,
    blocked: 'PRODUCTION_PILOT_RECONCILIATION_REQUIRED' as string | undefined,
  });
  for (const listing of listings) {
    const current = operations.filter(
      (op) =>
        op.source_identity === listing.sourceIdentity &&
        op.source_revision === listing.sourceRevision,
    );
    if (current.length > 1) return blocked();
    const op = current[0],
      stage = op ? existingStage(source, listing, op) : 'unsent';
    if (!stage) return blocked();
    if (op) consumed.add(op.id);
    entries.push({ listing, operation: op, stage });
    let predecessor: string | null | undefined = listing.supersedesOperationId;
    let laterRevision = listing.sourceRevision,
      ancestors = 0;
    while (predecessor) {
      const op = operations.find((candidate) => candidate.id === predecessor);
      if (
        !op ||
        consumed.has(op.id) ||
        ++ancestors > 2 ||
        op.source_identity !== listing.sourceIdentity ||
        op.source_revision >= laterRevision ||
        op.state !== 'rejected' ||
        op.item_id !== null ||
        op.closure_operation_id !== op.id ||
        op.sent !== 0 ||
        op.unknown !== 0 ||
        op.create_acknowledged !== 0 ||
        op.model_acknowledged !== 0
      )
        return blocked();
      consumed.add(op.id);
      laterRevision = op.source_revision;
      predecessor = op.supersedes_operation_id;
    }
  }
  // Every operation must be an exact current source or its explicit closed predecessor chain.
  return consumed.size === operations.length ? { entries, blocked: undefined } : blocked();
}
function continuationKey(
  source: LoadedSource,
  entries: ReturnType<typeof continuationPlan>['entries'],
) {
  return fingerprint({
    sourceReceiptSha256: source.sha256,
    remaining: entries
      .filter((entry) => entry.stage !== 'published')
      .map((entry) => ({
        sourceIdentity: entry.listing.sourceIdentity,
        sourceRevision: entry.listing.sourceRevision,
        stage: entry.stage,
        operationId: entry.operation?.id ?? null,
        revision: entry.operation?.revision ?? null,
        publicationRevision: entry.operation?.publication?.revision ?? null,
      })),
  });
}
/** Application entry point for the approved two-source pilot, not the general batch worker. */
export class ProductionPilotService {
  private active = false;
  private phase = 'ready';
  private code: string | undefined;
  private task: Promise<void> | undefined;
  constructor(
    readonly repo: Repository,
    readonly options: {
      enabled?: boolean;
      transport?: typeof fetch;
      encryptionKey?: string;
      coverImageQc?: ConstructorParameters<typeof ProductionPilotRunner>[1]['coverImageQc'];
      weightReview?: ConstructorParameters<typeof ProductionPilotRunner>[1]['weightReview'];
    } = {},
  ) {}
  private enabled() {
    return this.options.enabled ?? process.env.PRODUCTION_PILOT_ENABLED === '1';
  }
  private async operations(source: LoadedSource): Promise<OperationSummary[]> {
    const present = (
      await this.repo.pool.query(`SELECT to_regclass('production_pilot_operations') AS operations,
      to_regclass('production_pilot_publications') AS publications,to_regclass('production_pilot_rejection_closures') AS closures,
      to_regclass('production_pilot_verifications') AS verifications,
      to_regclass('production_pilot_publication_verifications') AS publication_verifications`)
    ).rows[0];
    if (!present?.operations) return [];
    return (
      await this.repo.pool.query(
        `SELECT o.id,o.source_identity,o.source_revision,o.item_id,o.state,o.revision,o.owner_key,
      o.connection_id,o.connection_revision,o.source_payload,o.source_fingerprint,o.expected_projection,
      jsonb_build_object('id',connection.id,'environment',connection.environment,'partner_id',connection.partner_id,
        'shop_id',connection.shop_id,'revision',connection.revision,'state',connection.state) AS current_connection,
      ${present.verifications ? 'to_jsonb(v)' : 'NULL::jsonb'} AS create_verification,
      ${present.publications ? 'to_jsonb(p)' : 'NULL::jsonb'} AS publication,
      ${present.publication_verifications && present.publications ? 'to_jsonb(pv)' : 'NULL::jsonb'} AS publication_verification,
      ${present.closures ? 'o.supersedes_operation_id' : 'NULL::uuid'} AS supersedes_operation_id,
      ${present.publications ? 'p.state' : 'NULL::text'} AS publication_state,
      ${present.closures ? 'c.operation_id' : 'NULL::uuid'} AS closure_operation_id,
      counts.*,failure.path AS failure_path,failure.receipt->>'code' AS failure_code,
      failure.receipt->'envelope'->>'message' AS failure_message,failure.receipt->'envelope'->>'debug_message' AS failure_debug_message,
      failure.receipt->>'requestId' AS failure_request_id
      FROM production_pilot_operations o
      LEFT JOIN connections connection ON connection.id=o.connection_id
      ${present.verifications ? 'LEFT JOIN production_pilot_verifications v ON v.operation_id=o.id' : ''}
      ${present.publications ? 'LEFT JOIN production_pilot_publications p ON p.create_operation_id=o.id' : ''}
      ${present.publication_verifications && present.publications ? 'LEFT JOIN production_pilot_publication_verifications pv ON pv.operation_id=p.id' : ''}
      ${present.closures ? 'LEFT JOIN production_pilot_rejection_closures c ON c.operation_id=o.id' : ''}
      CROSS JOIN LATERAL (SELECT count(*)::int AS total,count(*) FILTER(WHERE state='acknowledged')::int AS acknowledged,
        count(*) FILTER(WHERE state='sent')::int AS sent,count(*) FILTER(WHERE state='unknown')::int AS unknown,
        count(*) FILTER(WHERE state='rejected')::int AS rejected,
        count(*) FILTER(WHERE kind='media' AND state='acknowledged')::int AS upload_acknowledged,
        count(*) FILTER(WHERE kind='create' AND state='acknowledged')::int AS create_acknowledged,
        count(*) FILTER(WHERE kind='variations' AND state='acknowledged')::int AS model_acknowledged,
        jsonb_agg(jsonb_build_object('step_key',step_key,'state',state) ORDER BY ordinal) AS step_states
        FROM production_pilot_steps WHERE operation_id=o.id) counts
      LEFT JOIN LATERAL (SELECT path,receipt FROM production_pilot_steps WHERE operation_id=o.id AND state IN ('rejected','unknown')
        ORDER BY recorded_at DESC NULLS LAST,id LIMIT 1) failure ON true
      WHERE o.owner_key=$1 AND o.source_identity=ANY($2::text[]) ORDER BY o.created_at,o.id`,
        [owner, source.value.listings.map((entry: any) => entry.sourceIdentity)],
      )
    ).rows;
  }
  async status() {
    const source = await loadProductionPilotSource(),
      operations = await this.operations(source);
    const plan = continuationPlan(source, operations),
      blocked = plan.blocked;
    const isCurrent = (op: OperationSummary) =>
      source.value.listings.some(
        (listing: any) =>
          listing.sourceIdentity === op.source_identity &&
          listing.sourceRevision === op.source_revision,
      );
    const historical = operations.filter((op) => !isCurrent(op));
    const publishedCount = plan.entries.filter((entry) => entry.stage === 'published').length;
    const remainingCount = plan.entries.filter((entry) => entry.stage !== 'published').length;
    const onlyPublishedOrUnsent =
      !blocked && plan.entries.every((entry) => ['published', 'unsent'].includes(entry.stage));
    const fullyPublished =
      source.value.listings.length > 0 &&
      publishedCount === source.value.listings.length &&
      onlyPublishedOrUnsent;
    const partiallyPublished =
      !this.active &&
      publishedCount > 0 &&
      publishedCount < source.value.listings.length &&
      onlyPublishedOrUnsent;
    const durableOutcome = fullyPublished || partiallyPublished;
    return {
      enabled: this.enabled(),
      active: this.active,
      phase: fullyPublished ? 'complete' : partiallyPublished ? 'partial_complete' : this.phase,
      code: durableOutcome ? undefined : this.code,
      canStart: this.enabled() && !this.active && !blocked && remainingCount > 0,
      remainingCount: blocked ? 0 : remainingCount,
      continuationKey: blocked ? undefined : continuationKey(source, plan.entries),
      continuationKind:
        !blocked && plan.entries.some((entry) => !['published', 'unsent'].includes(entry.stage))
          ? 'reconcile'
          : publishedCount > 0
            ? 'remaining'
            : 'initial',
      // Current work and completed work remain non-replayable, but neither is a recovery failure.
      startBlockedCode: this.active || durableOutcome ? undefined : blocked,
      sourceReceiptSha256: source.sha256,
      shop: { shopId: productionPilotScope.shopId, name: 'Vuatinhdau - Đại Lý Chính Hãng' },
      historicalAttempts: historical.map(publicAttempt),
      listings: source.value.listings.map((s: any) => {
        const op = operations.find(
          (o) => o.source_identity === s.sourceIdentity && o.source_revision === s.sourceRevision,
        );
        return {
          sourceKey: s.sourceKey,
          sourceRevision: s.sourceRevision,
          title: s.document.title,
          skuCount: s.document.models.length,
          coverImportId: s.document.cover.importId,
          models: s.document.models.map((m: any) => ({
            sku: m.sku,
            label: m.optionLabels.join(' / '),
            originalPrice: m.originalPrice,
            stock: m.stock,
            weightGrams: m.weightGrams,
          })),
          operationId: op?.id,
          itemId: op?.item_id,
          state: op?.state ?? 'not_sent',
          publicationState: op?.publication_state,
          reasonCode: op ? reasonCode(op) : undefined,
          stepCounts: {
            total: op?.total ?? 0,
            acknowledged: op?.acknowledged ?? 0,
            sent: op?.sent ?? 0,
            unknown: op?.unknown ?? 0,
            rejected: op?.rejected ?? 0,
            uploadsAcknowledged: op?.upload_acknowledged ?? 0,
            createsAcknowledged: op?.create_acknowledged ?? 0,
            modelsAcknowledged: op?.model_acknowledged ?? 0,
          },
        };
      }),
    };
  }
  async asset(importId: string) {
    z.string().uuid().parse(importId);
    const source = await loadProductionPilotSource(),
      declared = source.value.assets[importId];
    if (typeof declared !== 'string') throw Error('PRODUCTION_PILOT_ASSET_NOT_FOUND');
    const root = await realpath(resolve(productionPilotSourceRoot, 'assets')),
      path = await realpath(declared),
      rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
      throw Error('PRODUCTION_PILOT_ASSET_OUTSIDE_ROOT');
    const bytes = await readFile(path);
    const descriptors = source.value.listings.flatMap((s: any) => [
      s.document.cover,
      ...s.document.gallery,
      ...s.document.models.map((m: any) => m.image),
    ]);
    const descriptor = descriptors.find((m: any) => m?.importId === importId);
    if (!descriptor || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256)
      throw Error('PRODUCTION_PILOT_ASSET_CHANGED');
    return { bytes, mime: descriptor.mime };
  }
  async start(raw: unknown) {
    const input = z
      .object({
        sourceReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
        continuationKey: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(raw);
    if (!this.enabled()) throw Error('PRODUCTION_PILOT_DISABLED');
    const source = await loadProductionPilotSource();
    if (source.sha256 !== input.sourceReceiptSha256) throw Error('PRODUCTION_PILOT_SOURCE_CHANGED');
    if (this.active) return { started: true };
    const plan = continuationPlan(source, await this.operations(source));
    if (plan.blocked) throw Error(plan.blocked);
    if (!plan.entries.some((entry) => entry.stage !== 'published'))
      throw Error('PRODUCTION_PILOT_RECONCILIATION_REQUIRED');
    if (input.continuationKey && input.continuationKey !== continuationKey(source, plan.entries))
      throw Error('PRODUCTION_PILOT_CONTINUATION_CHANGED');
    // Atomic per-process claim before async execution; durable journals arbitrate cross-process writes.
    if (this.active) return { started: true };
    this.active = true;
    this.phase = 'checking';
    this.code = undefined;
    this.task = this.execute(source)
      .catch((error) => {
        this.phase = 'stopped';
        this.code =
          error instanceof Error && /^PRODUCTION_PILOT_[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : 'PRODUCTION_PILOT_REVIEW_REQUIRED';
      })
      .finally(() => {
        this.active = false;
      });
    return { started: true };
  }
  private async execute(source: Awaited<ReturnType<typeof loadProductionPilotSource>>) {
    const operations = await this.operations(source),
      plan = continuationPlan(source, operations);
    if (plan.blocked) throw Error(plan.blocked);
    const currentSources = source.value.listings.map((s: any) => ({
      sourceIdentity: s.sourceIdentity,
      sourceRevision: s.sourceRevision,
    }));
    const allowedSources = Array.from(
      new Map(
        [
          ...currentSources,
          ...operations.map((op) => ({
            sourceIdentity: op.source_identity,
            sourceRevision: op.source_revision,
          })),
        ].map((entry) => [canonicalJson(entry), entry]),
      ).values(),
    );
    const runner = new ProductionPilotRunner(this.repo, {
      allowedSources,
      assetRoot: resolve(productionPilotSourceRoot, 'assets'),
      evidenceRoot: resolve(productionPilotSourceRoot, 'wire-evidence'),
      transport: this.options.transport,
      encryptionKey: this.options.encryptionKey,
      coverImageQc: this.options.coverImageQc,
      weightReview: this.options.weightReview,
      readbackDelaysMs: [1000, 3000, 7000, 15000],
      capabilityProbe: { ...currentSources[0], authorizationReference: pilotProbeAuthorization },
    });
    let firstVerifiedId = plan.entries.find((entry) => entry.stage === 'published')?.operation?.id;
    for (const entry of plan.entries.filter((entry) => entry.stage !== 'published')) {
      const listing = entry.listing;
      this.phase = 'checking';
      let evidence;
      if (firstVerifiedId) {
        const row = (
          await this.repo.pool.query(
            'SELECT revision FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3',
            ['production', '2010476', '1423724897'],
          )
        ).rows[0];
        if (!row) throw Error('PRODUCTION_PILOT_CONNECTION_CHANGED');
        evidence = await runner.capabilityEvidenceFromVerified(
          firstVerifiedId,
          row.revision,
          new Date().toISOString(),
          [resolve(productionPilotSourceRoot, 'wire-evidence', firstVerifiedId)],
        );
      }
      const preflight = await collectProductionPilotInput(this.repo, listing.sourceKey, {
        allowExistingListings: true,
        ...this.options,
        priorCapabilityEvidence: evidence,
      });
      if (preflight.sourceReceiptSha256 !== source.sha256)
        throw Error('PRODUCTION_PILOT_SOURCE_CHANGED');
      let operationId = entry.operation?.id;
      if (entry.stage === 'unsent') {
        const prepared = await runner.prepare(preflight.input);
        if (prepared.kind !== 'ready') throw Error('PRODUCTION_PILOT_PLAN_BLOCKED');
        operationId = prepared.operationId;
      }
      if (!operationId) throw Error('PRODUCTION_PILOT_RECONCILIATION_REQUIRED');
      this.phase = 'creating';
      // For a matched existing operation, the plan proved all create steps ACK or verified.
      // run() therefore only reads/reconciles. It never prepares or replays this source.
      const created = await runner.run(operationId);
      await writeFile(
        resolve(
          productionPilotSourceRoot,
          'preflight',
          preflight.preflightId,
          'create-result.json',
        ),
        JSON.stringify(created, null, 2),
        { flag: 'wx' },
      );
      if (created.state !== 'verified') {
        this.phase = 'stopped';
        this.code = created.code ?? 'PRODUCTION_PILOT_CREATE_QC_PENDING';
        return;
      }
      firstVerifiedId ??= created.operationId;
      this.phase = 'publishing';
      const published = await runner.publish(created.operationId, preflight.input.metadata);
      await writeFile(
        resolve(
          productionPilotSourceRoot,
          'preflight',
          preflight.preflightId,
          'publish-result.json',
        ),
        JSON.stringify(published, null, 2),
        { flag: 'wx' },
      );
      if (published.state !== 'published') {
        this.phase = 'stopped';
        this.code = published.code ?? 'PRODUCTION_PILOT_PUBLICATION_QC_PENDING';
        return;
      }
    }
    this.phase = 'complete';
  }
}
