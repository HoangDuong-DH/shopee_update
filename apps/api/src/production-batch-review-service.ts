import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson, preparedWeightKilograms, type PreparedDocument } from '@shopee/domain';
import type { BlobStore, Repository } from '@shopee/persistence';
import type { PoolClient } from 'pg';
import type { FieldSnapshot } from '../../../packages/shopee/src/field-client.js';
import type { PreparedWireContext } from '../../../packages/shopee/src/prepared-wire.js';
import { preparedWireMediaRequirements } from '../../../packages/shopee/src/prepared-wire.js';
import { checkPreparedWireCreate } from '../../../packages/shopee/src/prepared-wire-qc.js';
import { normalizePreparedWireSnapshot } from '../../../packages/shopee/src/prepared-wire.js';
import { productionPilotWriteFingerprint } from '../../../packages/shopee/src/production-pilot-transport.js';
import { loadProductionBatchSource, productionBatchPass1Root } from './production-batch-source.js';
import { checkCreate, allAcknowledged } from './production-batch-runner.js';
import { ImageQcService } from './image-qc-service.js';
import {
  reconcileProductionPilotWeights,
  type ProductionPilotWeightReview,
} from './production-pilot-weight-review.js';

const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' } as const;
const owner = 'production:2010476:1423724897',
  maximumReadAge = 15 * 60 * 1000;
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha(canonicalJson(value));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const input = z
  .object({ sourceKey: z.string().min(1).max(4000), expectedReviewFingerprint: digest })
  .strict();
function fail(code: string): never {
  throw Error('PRODUCTION_BATCH_REVIEW_' + code);
}
function identifier(value: unknown) {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !/^[1-9]\d*$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  )
    fail('MODEL_BINDING_INVALID');
  return String(value);
}
function kg(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (
    typeof value === 'string' &&
    /^(0|[1-9]\d*)(\.\d+)?$/.test(value) &&
    Number(value) > 0 &&
    Number.isFinite(Number(value))
  )
    return Number(value);
  return fail('WEIGHT_INVALID');
}
type WeightModel = ProductionPilotWeightReview['models'][number];
/** Hypothetical comparison only. It returns no authorization and writes no receipt. */
export function previewObservedWeightMapping(document: PreparedDocument, raw: FieldSnapshot) {
  if (
    !document.tierNames.length ||
    !Array.isArray(raw.models.model) ||
    raw.models.model.length !== document.models.length ||
    !document.models.length
  )
    fail('MODEL_BINDING_INVALID');
  const rows = raw.models.model,
    seenIds = new Set<string>(),
    seenSkus = new Set<string>(),
    seenTiers = new Set<string>();
  const models: WeightModel[] = document.models.map((source) => {
    const matches = rows.filter((row) => row.model_sku === source.sku),
      row = matches[0];
    if (
      matches.length !== 1 ||
      source.weightGrams === undefined ||
      !Number.isFinite(source.weightGrams) ||
      source.weightGrams <= 0 ||
      !same(row?.tier_index, source.tierIndex)
    )
      fail('MODEL_BINDING_INVALID');
    const modelId = identifier(row.model_id),
      observedKg = kg(row.weight),
      acceptedGrams = Math.round(observedKg * 1000);
    if (
      !Number.isSafeInteger(acceptedGrams) ||
      acceptedGrams <= 0 ||
      preparedWeightKilograms(acceptedGrams) !== observedKg ||
      Math.round(source.weightGrams) !== acceptedGrams
    )
      fail('NOT_ROUNDING_ONLY');
    const tier = canonicalJson(source.tierIndex);
    if (seenIds.has(modelId) || seenSkus.has(source.sku) || seenTiers.has(tier))
      fail('MODEL_BINDING_INVALID');
    seenIds.add(modelId);
    seenSkus.add(source.sku);
    seenTiers.add(tier);
    return {
      modelId,
      sku: source.sku,
      tierIndex: structuredClone(source.tierIndex),
      sourceGrams: source.weightGrams,
      acceptedGrams,
    };
  });
  if (
    document.weightGrams !== Math.max(...models.map((model) => model.sourceGrams)) ||
    kg(raw.item.weight) !==
      preparedWeightKilograms(Math.max(...models.map((model) => model.acceptedGrams)))
  )
    fail('ITEM_WEIGHT_INVALID');
  const projected = structuredClone(raw);
  projected.item.weight = preparedWeightKilograms(document.weightGrams);
  for (const row of projected.models.model)
    row.weight = preparedWeightKilograms(
      models.find((model) => model.modelId === identifier(row.model_id))!.sourceGrams,
    );
  return {
    models,
    projected,
    changed: models.filter((model) => model.sourceGrams !== model.acceptedGrams).length,
  };
}
type Queryable = Pick<Repository['pool'], 'query'>;
type Options = {
  root?: string;
  now?: () => number;
  load?: typeof loadProductionBatchSource;
  withLock?: <T>(work: (db: Queryable) => Promise<T>) => Promise<T>;
};
export class ProductionBatchReviewService {
  constructor(
    private readonly repo: Repository,
    private readonly blobs: BlobStore,
    private readonly options: Options = {},
  ) {}
  private get root() {
    return this.options.root ?? productionBatchPass1Root;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async locked<T>(work: (db: Queryable) => Promise<T>) {
    if (this.options.withLock) return this.options.withLock(work);
    const db: PoolClient = await this.repo.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'production-pilot:' + owner,
      ]);
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  private async source(batchId: string, sourceKey: string) {
    uuid.parse(batchId);
    z.string().min(1).max(4000).parse(sourceKey);
    const registered = z
      .object({
        version: z.literal(1),
        batchId: uuid,
        manifestPath: z.string().min(1),
        expectedSha256: digest,
        executionEnabled: z.boolean().default(true),
        holdReason: z.string().optional(),
      })
      .strict()
      .parse(
        JSON.parse(await readFile(resolve(this.root, 'web-registry', batchId + '.json'), 'utf8')),
      );
    if (registered.batchId !== batchId || !registered.executionEnabled) fail('SOURCE_HELD');
    const loaded = await (this.options.load ?? loadProductionBatchSource)(
      registered.manifestPath,
      registered.expectedSha256,
    );
    if (loaded.sha256 !== registered.expectedSha256 || loaded.value.batchId !== batchId)
      fail('SOURCE_CHANGED');
    const matches = loaded.value.listings.filter((listing) => listing.sourceKey === sourceKey);
    if (matches.length !== 1) fail('SOURCE_NOT_ALLOWED');
    return { loaded, listing: matches[0]! };
  }
  private async operation(batchId: string, sourceKey: string, db: Queryable) {
    const { loaded, listing } = await this.source(batchId, sourceKey);
    const rows = (
      await db.query(
        `SELECT to_jsonb(o) AS operation,
    jsonb_build_object('id',c.id,'revision',c.revision,'environment',c.environment,'partner_id',c.partner_id,'shop_id',c.shop_id,'state',c.state) AS current_connection,
    COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY ordinal) FROM production_pilot_steps s WHERE s.operation_id=o.id),'[]'::jsonb) AS steps,
    (SELECT count(*)::int FROM production_pilot_publications p WHERE p.create_operation_id=o.id) AS publications
    FROM production_pilot_operations o JOIN connections c ON c.id=o.connection_id WHERE o.owner_key=$1 AND o.source_identity=$2 ORDER BY o.source_revision`,
        [owner, listing.sourceIdentity],
      )
    ).rows;
    if (rows.length !== 1) fail('OPERATION_UNAVAILABLE');
    const view = rows[0],
      op = view.operation,
      connection = view.current_connection;
    if (
      !connection ||
      connection.state !== 'connected' ||
      connection.environment !== 'production' ||
      connection.partner_id !== '2010476' ||
      connection.shop_id !== '1423724897' ||
      view.publications !== 0
    )
      fail('OPERATION_UNAVAILABLE');
    const authorization = {
      batchId,
      manifestSha256: loaded.sha256,
      authorizationReference: loaded.value.authorizationReference,
      sources: loaded.value.listings.map((source) => ({
        sourceIdentity: source.sourceIdentity,
        sourceRevision: source.sourceRevision,
        documentSha256: hash(source.document),
      })),
    };
    checkCreate(view, listing, loaded, authorization, connection.id, connection.revision);
    allAcknowledged(view, listing);
    const context = structuredClone(op.source_payload.context) as PreparedWireContext;
    context.images = [];
    for (const [index, requirement] of preparedWireMediaRequirements(listing.document).entries()) {
      const step = view.steps.find((step: any) => step.step_key === 'media-' + index),
        receipt = step.receipt;
      if (receipt?.kind !== 'success' || step.outcome_fingerprint !== hash(receipt))
        fail('RECEIPT_INVALID');
      const imageId =
        receipt.response?.image_info?.image_id ??
        receipt.response?.image_info_list?.[0]?.image_info?.image_id;
      if (typeof imageId !== 'string' || !imageId) fail('RECEIPT_INVALID');
      context.images.push({
        importId: requirement.media.importId,
        sha256: requirement.media.sha256,
        role: requirement.role,
        imageId,
      });
    }
    for (const step of view.steps.filter((step: any) => step.kind !== 'media'))
      if (
        step.receipt?.kind !== 'success' ||
        step.outcome_fingerprint !== hash(step.receipt) ||
        step.fingerprint !== productionPilotWriteFingerprint(step.path, step.payload)
      )
        fail('RECEIPT_INVALID');
    const readLocations = op.source_payload.stockLocationEvidence?.expectedLocationBySku;
    if (readLocations) context.stockLocationBySku = structuredClone(readLocations);
    return { loaded, listing, view, context };
  }
  private async records(batchId: string, operationId: string) {
    const directory = resolve(this.root, 'wire-evidence', batchId, uuid.parse(operationId));
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return fail('TWO_READS_REQUIRED');
    }
    if (names.length > 2000) fail('EVIDENCE_LIMIT');
    const root = await realpath(directory),
      records: { path: string; sha256: string; value: any }[] = [];
    for (const name of names.filter((name) => /^[a-f0-9-]+\.json$/.test(name))) {
      const path = await realpath(resolve(directory, name)),
        tail = relative(root, path);
      if (!tail || tail === '..' || tail.startsWith('..' + sep) || isAbsolute(tail))
        fail('EVIDENCE_CHANGED');
      const bytes = await readFile(path);
      if (bytes.length > 8 * 1024 * 1024) fail('EVIDENCE_LIMIT');
      const value = JSON.parse(bytes.toString('utf8'));
      if (value?.observedAt && value.base && value.models)
        records.push({ path, sha256: sha(bytes), value });
    }
    records.sort((a, b) => Date.parse(b.value.observedAt) - Date.parse(a.value.observedAt));
    if (records.length < 2) fail('TWO_READS_REQUIRED');
    return records.slice(0, 2).reverse();
  }
  private async cover(
    document: PreparedDocument,
    context: PreparedWireContext,
    raw: FieldSnapshot,
    op: any,
    db: Queryable,
  ) {
    const promotion = raw.item.promotion_image as any,
      source = context.images.find((image) => image.role === 'cover');
    if (!source || !Array.isArray(promotion?.image_id_list) || promotion.image_id_list.length !== 1)
      fail('COVER_UNVERIFIED');
    if (promotion.image_id_list[0] === source.imageId && promotion.image_ratio === '1:1')
      return { snapshot: raw, proof: null };
    if (promotion.image_ratio !== undefined && promotion.image_ratio !== '1:1')
      fail('COVER_UNVERIFIED');
    const binding = {
      ...scope,
      itemId: op.item_id,
      operationId: op.id,
      role: 'cover',
      position: 0,
      sourceAssetId: document.cover.importId,
      outputImageId: promotion.image_id_list[0],
    };
    const rows = (
      await db.query(
        'SELECT id FROM image_qc_cases WHERE binding=$1::jsonb AND source_sha256=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
        [canonicalJson(binding), document.cover.sha256],
      )
    ).rows;
    if (rows.length !== 1) fail('COVER_UNVERIFIED');
    const service = new ImageQcService(this.repo, this.blobs, { now: () => new Date(this.now()) }),
      entry = await service.get(rows[0].id);
    await service.check({
      id: entry.id,
      binding: binding as any,
      sourceSha256: document.cover.sha256,
      outputSha256: entry.outputSha256,
    });
    const evidence = entry.result.evidence;
    if (
      entry.state !== 'verified' ||
      !entry.result.verificationBasis ||
      !evidence ||
      evidence.source.sha256 !== document.cover.sha256 ||
      evidence.output.sha256 !== entry.outputSha256 ||
      evidence.source.width !== document.cover.width ||
      evidence.source.height !== document.cover.height ||
      evidence.output.width !== evidence.output.height ||
      evidence.output.width <= 0
    )
      fail('COVER_UNVERIFIED');
    // Check persisted pixels against the existing independent review; this does not fetch or approve images.
    if (
      sha(await this.blobs.read(entry.outputSha256)) !== entry.outputSha256 ||
      sha(await this.blobs.read(entry.sourceSha256)) !== entry.sourceSha256
    )
      fail('COVER_UNVERIFIED');
    const snapshot = structuredClone(raw);
    (snapshot.item.promotion_image as any).image_id_list = [source.imageId];
    (snapshot.item.promotion_image as any).image_ratio = '1:1';
    return {
      snapshot,
      proof: {
        caseId: entry.id,
        caseFingerprint: entry.fingerprint,
        binding,
        outputSha256: entry.outputSha256,
        basis: entry.result.verificationBasis,
        reviewer: entry.review?.reviewer ?? null,
      },
    };
  }
  private async evaluate(batchId: string, sourceKey: string, db: Queryable) {
    const source = await this.operation(batchId, sourceKey, db),
      op = source.view.operation,
      records = await this.records(batchId, op.id),
      raws: FieldSnapshot[] = [],
      proofs: any[] = [],
      ids: string[] = [],
      models: WeightModel[][] = [];
    const now = this.now(),
      lastAcknowledged = Math.max(
        ...source.view.steps.map((step: any) => Date.parse(step.recorded_at)),
      );
    for (const record of records) {
      const { base, models: observed, observedAt } = record.value,
        date = Date.parse(observedAt);
      if (
        !Number.isFinite(date) ||
        date > now ||
        now - date > maximumReadAge ||
        !Number.isFinite(lastAcknowledged) ||
        date <= lastAcknowledged
      )
        fail('READS_EXPIRED');
      if (
        base.kind !== 'success' ||
        observed.kind !== 'success' ||
        typeof base.requestId !== 'string' ||
        !base.requestId ||
        typeof observed.requestId !== 'string' ||
        !observed.requestId ||
        base.envelope?.error !== '' ||
        observed.envelope?.error !== '' ||
        base.envelope?.request_id !== base.requestId ||
        observed.envelope?.request_id !== observed.requestId ||
        !same(base.envelope.response, base.response) ||
        !same(observed.envelope.response, observed.response)
      )
        fail('READS_UNVERIFIED');
      ids.push(base.requestId, observed.requestId);
      const list = base.response.item_list;
      if (!Array.isArray(list) || list.length !== 1 || identifier(list[0]?.item_id) !== op.item_id)
        fail('ITEM_CHANGED');
      const raw = { item: list[0], models: observed.response } as FieldSnapshot;
      raws.push(raw);
      const mapping = previewObservedWeightMapping(source.listing.document, raw);
      if (!mapping.changed) fail('NO_WEIGHT_DIFFERENCE');
      models.push(mapping.models);
      const covered = await this.cover(
        source.listing.document,
        source.context,
        mapping.projected,
        op,
        db,
      );
      proofs.push(covered.proof);
      const qc = checkPreparedWireCreate(source.listing.document, source.context, covered.snapshot);
      if (!qc.verified) fail('OTHER_FIELDS_DIFFER');
      const create = source.view.steps.find((step: any) => step.step_key === 'create');
      for (const requested of create.payload.logistic_info ?? []) {
        const matches = (raw.item.logistic_info as any[])?.filter(
          (channel) => channel.logistic_id === requested.logistic_id,
        );
        if (
          matches?.length !== 1 ||
          Object.keys(requested).some((key) => !same(matches[0][key], requested[key]))
        )
          fail('OTHER_FIELDS_DIFFER');
      }
      for (const row of raw.models.model)
        if ((row.stock_info_v2 as any)?.seller_stock?.[0]?.if_saleable !== true)
          fail('OTHER_FIELDS_DIFFER');
    }
    if (
      Date.parse(records[0]!.value.observedAt) >= Date.parse(records[1]!.value.observedAt) ||
      new Set(ids).size !== 4 ||
      !same(models[0], models[1]) ||
      !same(proofs[0], proofs[1]) ||
      !same(normalizePreparedWireSnapshot(raws[0]!), normalizePreparedWireSnapshot(raws[1]!))
    )
      fail('READS_UNSTABLE');
    const evidence = {
      version: 1,
      batchId,
      manifestSha256: source.loaded.sha256,
      sourceKey,
      sourceIdentity: source.listing.sourceIdentity,
      sourceRevision: source.listing.sourceRevision,
      operationId: op.id,
      operationRevision: op.revision,
      itemId: op.item_id,
      sourceFingerprint: op.source_fingerprint,
      models: models[0]!,
      records: records.map((record) => ({
        path: record.path,
        sha256: record.sha256,
        observedAt: record.value.observedAt,
      })),
      requestIds: ids,
      coverProof: proofs[0],
    };
    return { source, evidence, fingerprint: hash(evidence) };
  }
  private async prior(operationId: string) {
    const root = resolve(this.root, 'weight-reviews');
    try {
      const bytes = await readFile(resolve(root, operationId + '.approval.json'));
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async validatePrior(
    prior: any,
    bound: Awaited<ReturnType<ProductionBatchReviewService['operation']>>,
    allowMissingHelper = false,
  ) {
    const op = bound.view.operation,
      evidence = prior.evidence,
      review = prior.review;
    if (
      prior.version !== 1 ||
      hash(evidence) !== prior.reviewFingerprint ||
      sha(JSON.stringify(review, null, 2)) !== prior.reviewSha256 ||
      evidence.batchId !== bound.loaded.value.batchId ||
      evidence.manifestSha256 !== bound.loaded.sha256 ||
      evidence.sourceKey !== bound.listing.sourceKey ||
      evidence.sourceIdentity !== op.source_identity ||
      evidence.sourceRevision !== op.source_revision ||
      evidence.operationId !== op.id ||
      evidence.sourceFingerprint !== op.source_fingerprint ||
      evidence.operationRevision !== op.revision ||
      evidence.itemId !== op.item_id ||
      !same(evidence.models, review.models) ||
      !Array.isArray(evidence.records) ||
      evidence.records.length !== 2 ||
      Date.parse(review.expiresAt) - Date.parse(review.authorizedAt) !== 24 * 60 * 60 * 1000
    )
      fail('REVIEW_CONFLICT');
    for (const record of evidence.records) {
      const directory = await realpath(
          resolve(this.root, 'wire-evidence', evidence.batchId, op.id),
        ),
        path = await realpath(record.path),
        tail = relative(directory, path);
      if (
        !tail ||
        tail === '..' ||
        tail.startsWith('..' + sep) ||
        isAbsolute(tail) ||
        sha(await readFile(path)) !== record.sha256
      )
        fail('REVIEW_CONFLICT');
    }
    const record = JSON.parse(await readFile(evidence.records[1].path, 'utf8'));
    await reconcileProductionPilotWeights(
      {
        operationId: op.id,
        itemId: op.item_id,
        sourceFingerprint: op.source_fingerprint,
        document: bound.listing.document,
        raw: { item: record.base.response.item_list[0], models: record.models.response },
      },
      {
        now: () => this.now(),
        findReview: async () => Buffer.from(JSON.stringify(review, null, 2)),
      },
    );
    try {
      if (
        sha(await readFile(resolve(this.root, 'weight-reviews', op.id + '.json'))) !==
        prior.reviewSha256
      )
        fail('REVIEW_CONFLICT');
    } catch (error) {
      if (!allowMissingHelper || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  async review(batchId: string, sourceKey: string) {
    try {
      const assessed = await this.evaluate(batchId, sourceKey, this.repo.pool),
        prior = await this.prior(assessed.evidence.operationId);
      if (prior) await this.validatePrior(prior, assessed.source);
      const groups = new Map<
        string,
        { sourceGrams: number; observedGrams: number; count: number; skus: string[] }
      >();
      for (const model of assessed.evidence.models) {
        const key = canonicalJson([model.sourceGrams, model.acceptedGrams]),
          group = groups.get(key) ?? {
            sourceGrams: model.sourceGrams,
            observedGrams: model.acceptedGrams,
            count: 0,
            skus: [],
          };
        group.count++;
        group.skus.push(model.sku);
        groups.set(key, group);
      }
      return {
        sourceKey,
        eligible: !prior,
        approved: !!prior,
        reviewFingerprint: assessed.fingerprint,
        itemId: assessed.evidence.itemId,
        operationId: assessed.evidence.operationId,
        modelCount: assessed.evidence.models.length,
        groups: [...groups.values()],
        observedAt: assessed.evidence.records.map((record) => record.observedAt),
        expiresAt: new Date(
          Math.min(...assessed.evidence.records.map((record) => Date.parse(record.observedAt))) +
            maximumReadAge,
        ).toISOString(),
        coverReview: assessed.evidence.coverProof,
        reason: prior ? 'ALREADY_RECORDED' : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return {
        sourceKey,
        eligible: false,
        approved: false,
        reason: /^(PRODUCTION_BATCH_REVIEW|PASS1|IMAGE_QC)_[A-Z_]+$/.test(message)
          ? message
          : 'PRODUCTION_BATCH_REVIEW_UNAVAILABLE',
      };
    }
  }
  async approve(batchId: string, raw: unknown) {
    uuid.parse(batchId);
    const request = input.parse(raw);
    return this.locked(async (db) => {
      const bound = await this.operation(batchId, request.sourceKey, db),
        op = bound.view.operation,
        prior = await this.prior(op.id),
        directory = resolve(this.root, 'weight-reviews');
      if (prior) {
        await this.validatePrior(prior, bound, true);
        if (
          prior.reviewFingerprint !== request.expectedReviewFingerprint ||
          prior.evidence?.sourceFingerprint !== op.source_fingerprint ||
          prior.review?.operationId !== op.id ||
          hash(prior.evidence) !== prior.reviewFingerprint ||
          sha(JSON.stringify(prior.review, null, 2)) !== prior.reviewSha256 ||
          Date.parse(prior.review.expiresAt) <= this.now()
        )
          fail('REVIEW_CONFLICT');
        try {
          await writeFile(
            resolve(directory, op.id + '.json'),
            JSON.stringify(prior.review, null, 2),
            { flag: 'wx' },
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (sha(await readFile(resolve(directory, op.id + '.json'))) !== prior.reviewSha256)
            fail('REVIEW_CONFLICT');
        }
        return {
          sourceKey: request.sourceKey,
          approved: true,
          operationId: op.id,
          reviewSha256: prior.reviewSha256,
          expiresAt: prior.review.expiresAt,
        };
      }
      const assessed = await this.evaluate(batchId, request.sourceKey, db);
      if (assessed.fingerprint !== request.expectedReviewFingerprint) fail('REVIEW_CHANGED');
      // Revalidate immutable files at the final boundary while journal transitions are locked.
      const current = await this.operation(batchId, request.sourceKey, db),
        records = await this.records(batchId, op.id);
      if (
        current.view.operation.revision !== op.revision ||
        current.view.operation.source_fingerprint !== op.source_fingerprint ||
        !same(
          records.map((record) => ({
            path: record.path,
            sha256: record.sha256,
            observedAt: record.value.observedAt,
          })),
          assessed.evidence.records,
        ) ||
        this.now() - Date.parse(assessed.evidence.records[0]!.observedAt) > maximumReadAge
      )
        fail('REVIEW_CHANGED');
      const now = this.now(),
        review: ProductionPilotWeightReview = {
          version: 1,
          scope,
          operationId: op.id,
          itemId: op.item_id,
          sourceFingerprint: op.source_fingerprint,
          sourceKey: bound.listing.document.sourceKey,
          authorizationReference:
            'Employee explicitly accepted the observed per-SKU weight mapping in the internal app; review ' +
            assessed.fingerprint,
          authorizedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
          models: assessed.evidence.models,
        };
      const reviewBytes = JSON.stringify(review, null, 2),
        approval = {
          version: 1,
          reviewFingerprint: assessed.fingerprint,
          reviewSha256: sha(reviewBytes),
          review,
          evidence: assessed.evidence,
        };
      await mkdir(directory, { recursive: true });
      try {
        await readFile(resolve(directory, op.id + '.json'));
        fail('REVIEW_CONFLICT');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeFile(
        resolve(directory, op.id + '.approval.json'),
        JSON.stringify(approval, null, 2),
        { flag: 'wx' },
      );
      await writeFile(resolve(directory, op.id + '.json'), reviewBytes, { flag: 'wx' });
      return {
        sourceKey: request.sourceKey,
        approved: true,
        operationId: op.id,
        reviewSha256: approval.reviewSha256,
        expiresAt: review.expiresAt,
      };
    });
  }
}
