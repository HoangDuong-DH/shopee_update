import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import {
  canonicalJson,
  preparedWeightKilograms,
  type PreparedDocument,
  type PreparedMedia,
} from '@shopee/domain';
import { Repository } from '@shopee/persistence';
import { SecretBox } from '@shopee/gateway';
import {
  ProductionPilotJournal,
  type ProductionPilotSource,
  type ProductionPilotBatchAuthorization,
  type ProductionPilotReadback,
  type ProductionPilotOutcome,
} from './production-pilot-journal.js';
import { ProductionPilotTransport } from '../../../packages/shopee/src/production-pilot-transport.js';
import { ProductionPilotPublicationJournal } from './production-pilot-publication-journal.js';
import {
  bindPreparedWireItem,
  inspectPreparedWireAcknowledgement,
  normalizePreparedWireSnapshot,
  planPreparedWireCreate,
  preparedWireMediaRequirements,
  type PreparedWireContext,
  type PreparedWireImageRole,
} from '../../../packages/shopee/src/prepared-wire.js';
import {
  checkPreparedWireCreate,
  checkPreparedWireCreateWithoutImages,
} from '../../../packages/shopee/src/prepared-wire-qc.js';
import {
  assertDeferredImageVerification,
  stableCoreSnapshot,
} from './production-pilot-image-deferral.js';
import type { ExecutionPolicyReceipt } from './production-execution-policy.js';
import {
  reconcileProductionPilotCover,
  type ProductionPilotCoverAlias,
  type ProductionPilotCoverQcOptions,
} from './production-pilot-cover-qc.js';
import type { FieldSnapshot } from '../../../packages/shopee/src/field-client.js';
import {
  reconcileProductionPilotWeights,
  type ProductionPilotWeightReviewOptions,
} from './production-pilot-weight-review.js';

const target = { environment: 'production', partnerId: '2010476', shopId: '1423724897' } as const;
const owner = 'production:2010476:1423724897';
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never {
  throw new Error('PRODUCTION_PILOT_' + code);
}
const positiveId = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const imageId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const bySku = (a: { sku: string }, b: { sku: string }) => a.sku.localeCompare(b.sku);
const mediaIdentity = (media: PreparedMedia, role: PreparedWireImageRole) =>
  role + ':' + media.sha256;
type Row = Record<string, any>;
type Capability = 'gallery34' | 'extendedDescription';
type CapabilityObservation = {
  state: 'supported' | 'unsupported' | 'unknown';
  observedAt: string;
  references: string[];
  verifiedOperationId?: string;
};
export type ProductionPilotPreparedInput = ProductionPilotSource & {
  descriptionFallbackPolicy?: 'plain_text_when_unsupported';
  supersedesOperationId?: string;
  connectionId: string;
  connectionRevision: number;
  document: PreparedDocument;
  context: PreparedWireContext;
  assets: Record<string, string>;
  issues: { code: string; field: string }[];
  capabilityEvidence: {
    environment: 'production';
    partnerId: '2010476';
    shopId: '1423724897';
    connectionRevision: number;
    gallery34: CapabilityObservation;
    extendedDescription: CapabilityObservation;
  };
  capabilityProbe?: ProductionPilotSource & {
    authorizationReference: string;
    capabilities: Capability[];
  };
  /** Scope-stamped, frozen API observations supplied by the trusted metadata collector.
   * This proves internal read locations separately from locations sent on writes. */
  stockLocationEvidence?: {
    environment: 'production';
    partnerId: '2010476';
    shopId: '1423724897';
    connectionRevision: number;
    observedAt: string;
    observations: {
      requestId: string;
      path: '/api/v2/product/get_model_list' | '/api/v2/product/get_item_base_info';
      response: Record<string, unknown>;
    }[];
    expectedLocationBySku: Record<string, string | null>;
  };
  metadata: {
    environment: 'production';
    partnerId: '2010476';
    shopId: '1423724897';
    connectionRevision: number;
    categoryId: string;
    observedAt: string;
    expiresAt: string;
    requestIds: string[];
  };
};

function productionMediaRequirements(input: ProductionPilotPreparedInput) {
  const usePlainDescription =
    input.descriptionFallbackPolicy === 'plain_text_when_unsupported' &&
    input.capabilityEvidence.extendedDescription.state === 'unsupported';
  return preparedWireMediaRequirements(input.document, {
    includeDescription: !usePlainDescription,
  });
}
export type ProductionPilotRunResult = {
  state:
    | 'verified'
    | 'hidden_image_qc_deferred'
    | 'published'
    | 'blocked'
    | 'rejected'
    | 'unknown'
    | 'unresolved';
  operationId: string;
  itemId?: string;
  code?: string;
  mismatchedPaths?: string[];
  evidenceFiles?: string[];
};

function copyJson<T>(value: T): T {
  const copy = (entry: unknown, depth: number): unknown => {
    if (depth > 50) fail('SOURCE_INVALID');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) {
      if (entry.length > 100000) fail('SOURCE_INVALID');
      return Array.from({ length: entry.length }, (_, index) => {
        const d = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!d || !Object.hasOwn(d, 'value')) fail('SOURCE_INVALID');
        return copy(d.value, depth + 1);
      });
    }
    if (
      !entry ||
      typeof entry !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
    )
      fail('SOURCE_INVALID');
    return Object.fromEntries(
      Object.keys(entry).map((key) => {
        const d = Object.getOwnPropertyDescriptor(entry, key)!;
        if (!Object.hasOwn(d, 'value')) fail('SOURCE_INVALID');
        return [key, copy(d.value, depth + 1)];
      }),
    );
  };
  return copy(value, 0) as T;
}
function desiredProjection(
  doc: PreparedDocument,
  ctx: PreparedWireContext,
  logistics: Row[],
  stockLocations: Record<string, string | null>,
): Row {
  return {
    title: doc.title,
    itemSku: doc.tierNames.length ? doc.sourceKey : doc.models[0]!.sku,
    status: 'UNLIST',
    categoryId: doc.categoryId,
    brandId: doc.brandId,
    brandName: ctx.brandName,
    condition: ctx.condition,
    preOrder: ctx.preOrder,
    ...(!doc.models.some((model) => model.weightGrams !== undefined)
      ? { weightKg: preparedWeightKilograms(doc.weightGrams) }
      : {}),
    ...(!doc.models.some((model) => model.dimensionCm !== undefined)
      ? { dimensionCm: doc.dimensionCm }
      : {}),
    attributes: Object.fromEntries(
      Object.entries(doc.attributes).map(([key, values]) => [key, [...values].sort()]),
    ),
    attributeValues: [...(ctx.attributeList ?? [])]
      .map((attribute) => ({
        ...attribute,
        attribute_value_list: [...attribute.attribute_value_list].sort(
          (a, b) => a.value_id - b.value_id,
        ),
      }))
      .sort((a, b) => a.attribute_id - b.attribute_id),
    logistics: [...logistics].sort((a, b) => a.logistic_id - b.logistic_id),
    cover: mediaIdentity(doc.cover, 'cover'),
    gallery: doc.gallery.map((media) => mediaIdentity(media, 'gallery')),
    description: doc.description.some((block) => block.type === 'image')
      ? doc.description.map((block) =>
          block.type === 'text'
            ? { type: 'text', text: block.text }
            : { type: 'image', image: mediaIdentity(block.image, 'description') },
        )
      : [
          {
            type: 'text',
            text: doc.description
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join(''),
          },
        ],
    tierNames: doc.tierNames,
    models: doc.models
      .map((model) => ({
        sku: model.sku,
        tierIndex: model.tierIndex,
        optionLabels: model.optionLabels,
        originalPrice: model.originalPrice,
        stock: model.stock,
        stockLocation: stockLocations[model.sku] || null,
        ...(doc.models.some((m) => m.weightGrams !== undefined)
          ? { weightKg: preparedWeightKilograms(model.weightGrams ?? doc.weightGrams) }
          : {}),
        ...(doc.models.some((m) => m.dimensionCm !== undefined)
          ? { dimensionCm: model.dimensionCm ?? doc.dimensionCm }
          : {}),
        ...(model.image ? { image: mediaIdentity(model.image, 'variation') } : {}),
        ...(ctx.gtinBySku && Object.hasOwn(ctx.gtinBySku, model.sku)
          ? { gtin: ctx.gtinBySku[model.sku] }
          : {}),
      }))
      .sort(bySku),
  };
}
/** All values are decoded from raw responses. Exact acknowledged image IDs remain the default;
 * only the cover can use a separate per-read immutable image proof, never a fuzzy comparison. */
function actualProjection(
  doc: PreparedDocument,
  ctx: PreparedWireContext,
  raw: FieldSnapshot,
  requestedLogistics: Row[],
  coverAlias?: ProductionPilotCoverAlias,
  omitImages = false,
): Row {
  const item = raw.item as Row,
    tiers = raw.models.tier_variation as Row[];
  const image = (id: unknown, role: PreparedWireImageRole) => {
    if (
      role === 'cover' &&
      coverAlias &&
      id === coverAlias.outputImageId &&
      coverAlias.sourceSha256 === doc.cover.sha256 &&
      ctx.images.some(
        (binding) =>
          binding.role === 'cover' &&
          binding.importId === doc.cover.importId &&
          binding.sha256 === coverAlias.sourceSha256 &&
          binding.imageId === coverAlias.sourceImageId,
      )
    )
      return 'cover:' + coverAlias.sourceSha256;
    const matches = new Set(
      ctx.images
        .filter((binding) => binding.role === role && binding.imageId === id)
        .map((binding) => role + ':' + binding.sha256),
    );
    if (matches.size !== 1) fail('UNPROVEN_IMAGE_ID');
    return [...matches][0]!;
  };
  const rows = doc.tierNames.length ? (raw.models.model as Row[]) : [item];
  return {
    title: item.item_name,
    itemSku: item.item_sku,
    status: item.item_status,
    categoryId: String(item.category_id),
    brandId: String(item.brand.brand_id),
    brandName: item.brand.original_brand_name,
    condition: item.condition,
    preOrder: Object.fromEntries(
      Object.keys(ctx.preOrder!).map((key) => [key, item.pre_order[key]]),
    ),
    ...(!doc.models.some((model) => model.weightGrams !== undefined)
      ? { weightKg: Number(item.weight) }
      : {}),
    ...(!doc.models.some((model) => model.dimensionCm !== undefined)
      ? {
          dimensionCm: {
            length: item.dimension.package_length,
            width: item.dimension.package_width,
            height: item.dimension.package_height,
          },
        }
      : {}),
    attributes: Object.fromEntries(
      item.attribute_list.map((attr: Row) => [
        String(attr.attribute_id),
        attr.attribute_value_list.map((v: Row) => String(v.value_id)).sort(),
      ]),
    ),
    attributeValues: [...(ctx.attributeList ?? [])]
      .map((attribute) => ({
        attribute_id: attribute.attribute_id,
        attribute_value_list: attribute.attribute_value_list
          .map((value) => {
            const actual = item.attribute_list
              .find((a: Row) => a.attribute_id === attribute.attribute_id)
              ?.attribute_value_list.find((v: Row) => v.value_id === value.value_id);
            return Object.fromEntries(Object.keys(value).map((key) => [key, actual?.[key]]));
          })
          .sort((a, b) => a.value_id - b.value_id),
      }))
      .sort((a, b) => a.attribute_id - b.attribute_id),
    logistics: requestedLogistics
      .map((requested) => {
        const observed = item.logistic_info.find(
          (c: Row) => c.logistic_id === requested.logistic_id,
        );
        return Object.fromEntries(Object.keys(requested).map((key) => [key, observed[key]]));
      })
      .sort((a, b) => a.logistic_id - b.logistic_id),
    ...(!omitImages
      ? {
          cover: image(item.promotion_image.image_id_list[0], 'cover'),
          gallery: item.image.image_id_list.map((id: string) => image(id, 'gallery')),
        }
      : {}),
    description:
      item.description_type === 'extended'
        ? item.description_info.extended_description.field_list.map((b: Row) =>
            b.field_type === 'text'
              ? { type: 'text', text: b.text }
              : {
                  type: 'image',
                  ...(!omitImages ? { image: image(b.image_info.image_id, 'description') } : {}),
                },
          )
        : [{ type: 'text', text: item.description }],
    tierNames: tiers.map((t) => t.name),
    models: rows
      .map((row) => {
        const sku = doc.tierNames.length ? row.model_sku : row.item_sku,
          tierIndex = doc.tierNames.length ? row.tier_index : [];
        const source = doc.models.find((model) => model.sku === sku);
        if (!source) fail('MODEL_IDENTITY_MISMATCH');
        return {
          sku,
          tierIndex,
          optionLabels: tierIndex.map(
            (index: number, tier: number) => tiers[tier]!.option_list[index].option,
          ),
          originalPrice: String(row.price_info[0].original_price),
          stock: row.stock_info_v2.seller_stock[0].stock,
          stockLocation: row.stock_info_v2.seller_stock[0].location_id || null,
          ...(doc.models.some((m) => m.weightGrams !== undefined)
            ? { weightKg: Number(row.weight) }
            : {}),
          ...(doc.models.some((m) => m.dimensionCm !== undefined)
            ? {
                dimensionCm: {
                  length: row.dimension.package_length,
                  width: row.dimension.package_width,
                  height: row.dimension.package_height,
                },
              }
            : {}),
          ...(source.image && !omitImages
            ? { image: image(tiers[0]!.option_list[tierIndex[0]].image.image_id, 'variation') }
            : {}),
          ...(ctx.gtinBySku && Object.hasOwn(ctx.gtinBySku, sku) ? { gtin: row.gtin_code } : {}),
        };
      })
      .sort(bySku),
  };
}

/** Trusted server coordinator for explicitly scoped sources. No generic writer, source rewriting,
 * automatic mutation retry or fallback metadata. Acknowledged writes may have bounded read-only
 * reconciliation; publication follows its own immutable evidence journal. */
export class ProductionPilotRunner {
  readonly journal: ProductionPilotJournal;
  readonly publications: ProductionPilotPublicationJournal;
  private readonly allowedProbe?: ProductionPilotSource & { authorizationReference: string };
  private readonly capabilityProofOperationIds: ReadonlySet<string>;
  constructor(
    readonly repo: Repository,
    readonly options: {
      allowedSources: readonly ProductionPilotSource[];
      batchAuthorization?: ProductionPilotBatchAuthorization;
      deferImageQc?: boolean;
      executionPolicy?: ExecutionPolicyReceipt;
      /** Explicit prior verified operations usable only as read-only media capability evidence. */
      capabilityProofOperationIds?: readonly string[];
      assetRoot: string;
      evidenceRoot: string;
      encryptionKey?: string;
      transport?: typeof fetch;
      pause?: (ms: number) => Promise<void>;
      coverImageQc?: ProductionPilotCoverQcOptions;
      weightReview?: ProductionPilotWeightReviewOptions;
      /** Extra read-only reconciliation rounds after fully acknowledged writes. Never resend. */
      readbackDelaysMs?: readonly number[];
      /** Only this one source may make one UNLIST create to discover currently unknown API access. */
      capabilityProbe?: ProductionPilotSource & { authorizationReference: string };
    },
  ) {
    if (!isAbsolute(options.assetRoot) || !isAbsolute(options.evidenceRoot))
      fail('LOCAL_ROOT_REQUIRED');
    if (
      options.deferImageQc &&
      !options.executionPolicy &&
      (options.batchAuthorization?.publicationMode !== 'hidden_for_review' ||
        options.batchAuthorization.imageQcPolicy !== 'defer_image_qc')
    )
      fail('IMAGE_DEFERRAL_FORBIDDEN');
    const proofIds = z
      .array(z.string().uuid())
      .max(4)
      .parse(options.capabilityProofOperationIds ?? []);
    if (new Set(proofIds).size !== proofIds.length) fail('CAPABILITY_PROOF_ALLOWLIST_INVALID');
    this.capabilityProofOperationIds = new Set(proofIds);
    const delays = options.readbackDelaysMs ?? [];
    if (
      delays.length > 4 ||
      delays.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 15000) ||
      delays.reduce((sum, n) => sum + n, 0) > 30000
    )
      fail('READBACK_SCHEDULE_INVALID');
    this.journal = new ProductionPilotJournal(repo, {
      allowedSources: options.allowedSources,
      batchAuthorization: options.batchAuthorization,
      executionPolicy: options.executionPolicy,
    });
    this.publications = new ProductionPilotPublicationJournal(repo, {
      allowedSources: options.allowedSources,
      batchAuthorization: options.batchAuthorization,
    });
    if (options.capabilityProbe)
      this.allowedProbe = Object.freeze(copyJson(options.capabilityProbe));
  }
  private effectiveContext(
    input: ProductionPilotPreparedInput,
    readOnly = false,
  ): PreparedWireContext {
    const observation = z
      .object({
        state: z.enum(['supported', 'unsupported', 'unknown']),
        observedAt: z.iso.datetime(),
        references: z.array(z.string().min(1)).min(1),
        verifiedOperationId: z.string().uuid().optional(),
      })
      .strict();
    const parsed = z
      .object({
        environment: z.literal('production'),
        partnerId: z.literal('2010476'),
        shopId: z.literal('1423724897'),
        connectionRevision: z.number().int().positive(),
        gallery34: observation,
        extendedDescription: observation,
      })
      .strict()
      .safeParse(input.capabilityEvidence);
    if (!parsed.success || parsed.data.connectionRevision !== input.connectionRevision)
      fail('CAPABILITY_EVIDENCE_REQUIRED');
    const required: Capability[] = [
      'gallery34',
      ...(input.document.description.some((block) => block.type === 'image')
        ? ['extendedDescription' as const]
        : []),
    ];
    const context = copyJson(input.context);
    const unknown = required.filter((key) => parsed.data[key].state === 'unknown');
    for (const key of required) {
      const proof = parsed.data[key];
      if (
        Date.parse(proof.observedAt) > Date.parse(input.metadata.observedAt) ||
        Date.parse(input.metadata.observedAt) - Date.parse(proof.observedAt) > 15 * 60 * 1000
      )
        fail('CAPABILITY_EVIDENCE_STALE');
      if (proof.state === 'unsupported') {
        if (
          key === 'extendedDescription' &&
          input.descriptionFallbackPolicy === 'plain_text_when_unsupported'
        ) {
          context.capabilities.extendedDescription = false;
          context.descriptionMode = 'plain_fallback';
          continue;
        }
        fail('CAPABILITY_UNSUPPORTED');
      }
      if (proof.state === 'supported' && !proof.verifiedOperationId)
        fail('CAPABILITY_PROOF_REQUIRED');
      if (proof.state !== 'supported' && context.capabilities[key] === true)
        fail('CAPABILITY_CLAIM_UNPROVEN');
    }
    if (unknown.length) {
      const probe = z
        .object({
          sourceIdentity: z.string().min(1),
          sourceRevision: z.number().int().positive(),
          authorizationReference: z.string().min(1),
          capabilities: z.array(z.enum(['gallery34', 'extendedDescription'])).min(1),
        })
        .strict()
        .safeParse(input.capabilityProbe);
      if (
        !probe.success ||
        probe.data.sourceIdentity !== input.sourceIdentity ||
        probe.data.sourceRevision !== input.sourceRevision ||
        canonicalJson([...probe.data.capabilities].sort()) !== canonicalJson([...unknown].sort()) ||
        (!readOnly &&
          (!this.allowedProbe ||
            this.allowedProbe.sourceIdentity !== input.sourceIdentity ||
            this.allowedProbe.sourceRevision !== input.sourceRevision ||
            this.allowedProbe.authorizationReference !== probe.data.authorizationReference))
      )
        fail('CAPABILITY_PROBE_FORBIDDEN');
    } else if (input.capabilityProbe) fail('CAPABILITY_PROBE_NOT_REQUIRED');
    // This is a temporary plan permission, not evidence of support. The saved source retains
    // unknown/false and its single-source user authorization even after successful execution.
    for (const key of required)
      if (parsed.data[key].state !== 'unsupported') context.capabilities[key] = true;
    return context;
  }
  private async verifyCapabilityProofs(input: ProductionPilotPreparedInput) {
    for (const key of ['gallery34', 'extendedDescription'] as const) {
      const proof = input.capabilityEvidence?.[key];
      if (proof?.state !== 'supported') continue;
      if (!proof.verifiedOperationId) fail('CAPABILITY_PROOF_REQUIRED');
      const view = await this.readCapabilityProof(proof.verifiedOperationId);
      const document = view.operation.source_payload.document as PreparedDocument | undefined;
      if (
        view.operation.state !== 'verified' ||
        view.operation.connection_id !== input.connectionId ||
        !view.verification ||
        !document ||
        (key === 'extendedDescription' &&
          !document.description.some((block) => block.type === 'image')) ||
        (key === 'gallery34' && !document.gallery.length)
      )
        fail('CAPABILITY_PROOF_UNVERIFIED');
    }
  }
  private async readCapabilityProof(operationId: string) {
    if (!this.capabilityProofOperationIds.has(operationId)) return this.journal.get(operationId);
    // Only immutable verified records are read here; no source is admitted into the mutation
    // journal allowlist. An explicit proof ID cannot enable run, prepare, publish or replay.
    const operation = (
      await this.repo.pool.query(
        `SELECT o.* FROM production_pilot_operations o
      JOIN connections c ON c.id=o.connection_id WHERE o.id=$1 AND o.owner_key=$2
      AND c.environment='production' AND c.partner_id=$3 AND c.shop_id=$4`,
        [z.string().uuid().parse(operationId), owner, target.partnerId, target.shopId],
      )
    ).rows[0];
    if (!operation || operation.state !== 'verified' || !operation.item_id)
      fail('CAPABILITY_PROOF_UNVERIFIED');
    const verification = (
      await this.repo.pool.query(
        'SELECT * FROM production_pilot_verifications WHERE operation_id=$1',
        [operationId],
      )
    ).rows[0];
    const steps = (
      await this.repo.pool.query(
        'SELECT * FROM production_pilot_steps WHERE operation_id=$1 ORDER BY ordinal',
        [operationId],
      )
    ).rows;
    if (
      !verification ||
      verification.phase !== 'created_unlisted' ||
      verification.operation_revision !== operation.revision - 1 ||
      verification.item_id !== operation.item_id ||
      verification.expected_fingerprint !== hash(canonicalJson(operation.expected_projection)) ||
      operation.source_fingerprint !==
        hash(
          canonicalJson({
            scope: target,
            sourceIdentity: operation.source_identity,
            sourceRevision: operation.source_revision,
            sourcePayload: operation.source_payload,
            expectedProjection: operation.expected_projection,
          }),
        ) ||
      !steps.some((step) => step.kind === 'create') ||
      steps.some((step) => step.state !== 'acknowledged')
    )
      fail('CAPABILITY_PROOF_UNVERIFIED');
    const proofInput = operation.source_payload as ProductionPilotPreparedInput;
    const document = proofInput.document as PreparedDocument | undefined;
    if (!document || !Array.isArray(document.tierNames)) fail('CAPABILITY_PROOF_UNVERIFIED');
    const required = [
      ...productionMediaRequirements(proofInput).map((_, index) => ({
        key: 'media-' + index,
        kind: 'media',
        path: '/api/v2/media_space/upload_image',
      })),
      { key: 'create', kind: 'create', path: '/api/v2/product/add_item' },
      ...(document.tierNames.length
        ? [{ key: 'variations', kind: 'variations', path: '/api/v2/product/init_tier_variation' }]
        : []),
    ];
    const reads = verification.readbacks;
    if (
      steps.length !== required.length ||
      !required.every(
        (expected, index) =>
          steps[index]?.step_key === expected.key &&
          steps[index]?.kind === expected.kind &&
          steps[index]?.path === expected.path,
      ) ||
      !Array.isArray(reads) ||
      reads.length !== 2 ||
      verification.evidence_fingerprint !== hash(canonicalJson(reads)) ||
      reads.some(
        (read) =>
          read.partnerId !== target.partnerId ||
          read.shopId !== target.shopId ||
          read.itemId !== operation.item_id ||
          !read.raw ||
          !read.projection ||
          read.rawSha256 !== hash(canonicalJson(read.raw)) ||
          read.projectionSha256 !== hash(canonicalJson(read.projection)) ||
          canonicalJson(read.projection) !== canonicalJson(operation.expected_projection),
      )
    )
      fail('CAPABILITY_PROOF_UNVERIFIED');
    return { operation, verification, steps, rejectionClosure: null };
  }
  async capabilityEvidenceFromVerified(
    operationId: string,
    connectionRevision: number,
    observedAt: string,
    references: string[],
  ): Promise<ProductionPilotPreparedInput['capabilityEvidence']> {
    z.iso.datetime().parse(observedAt);
    z.array(z.string().min(1)).min(1).parse(references);
    const view = await this.readCapabilityProof(operationId);
    await this.connection({ connectionId: view.operation.connection_id, connectionRevision });
    if (view.operation.state !== 'verified' || !view.verification)
      fail('CAPABILITY_PROOF_UNVERIFIED');
    const document = view.operation.source_payload.document as PreparedDocument | undefined;
    if (!document) fail('CAPABILITY_PROOF_UNVERIFIED');
    const prior = view.operation.source_payload
      .capabilityEvidence as ProductionPilotPreparedInput['capabilityEvidence'];
    const proof = (feature: Capability, supported: boolean): CapabilityObservation => {
      // A successful plaintext item cannot undo an earlier definitive description whitelist denial.
      if (!supported && prior?.[feature]?.state === 'unsupported') return copyJson(prior[feature]);
      return {
        state: supported ? 'supported' : 'unknown',
        observedAt,
        references: [...references],
        ...(supported ? { verifiedOperationId: operationId } : {}),
      };
    };
    return {
      ...target,
      connectionRevision,
      gallery34: proof('gallery34', document.gallery.length > 0),
      extendedDescription: proof(
        'extendedDescription',
        document.description.some((block) => block.type === 'image'),
      ),
    };
  }
  private async connection(
    input: Pick<ProductionPilotPreparedInput, 'connectionId' | 'connectionRevision'>,
    readOnly = false,
  ) {
    const row = (
      await this.repo.pool.query('SELECT * FROM connections WHERE id=$1', [
        z.string().uuid().parse(input.connectionId),
      ])
    ).rows[0];
    if (
      !row ||
      row.environment !== target.environment ||
      row.partner_id !== target.partnerId ||
      row.shop_id !== target.shopId
    )
      fail('SCOPE_FORBIDDEN');
    if (!readOnly && row.revision !== input.connectionRevision) fail('CONNECTION_CHANGED');
    if (
      row.state !== 'connected' ||
      !row.expires_at ||
      new Date(row.expires_at).getTime() <= Date.now()
    )
      fail('AUTH_REQUIRED');
    return row;
  }
  private validate(input: ProductionPilotPreparedInput, readOnly = false) {
    z.number().int().positive().parse(input.sourceRevision);
    z.array(z.object({ code: z.string(), field: z.string() }).strict()).parse(input.issues);
    if (input.issues.length) fail('SOURCE_ISSUES');
    const metadata = z
      .object({
        environment: z.literal('production'),
        partnerId: z.literal('2010476'),
        shopId: z.literal('1423724897'),
        connectionRevision: z.number().int().positive(),
        categoryId: z.string().min(1),
        observedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        requestIds: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .parse(input.metadata);
    const observed = Date.parse(metadata.observedAt),
      expires = Date.parse(metadata.expiresAt);
    if (
      metadata.connectionRevision !== input.connectionRevision ||
      metadata.categoryId !== input.document.categoryId ||
      observed > Date.now() ||
      (!readOnly && expires <= Date.now()) ||
      expires <= observed ||
      expires - observed > 15 * 60 * 1000
    )
      fail('METADATA_STALE_OR_MISMATCHED');
    if (
      input.sourceIdentity !== input.document.sourceKey ||
      input.document.publication !== 'unlisted' ||
      input.context.images.length
    )
      fail('SOURCE_INVALID');
    const context = this.effectiveContext(input, readOnly);
    const requirements = productionMediaRequirements(input);
    context.images = requirements.map((r, index) => ({
      importId: r.media.importId,
      sha256: r.media.sha256,
      role: r.role,
      imageId: 'LOCAL_ONLY_VALIDATION_' + index,
    }));
    const plan = planPreparedWireCreate(input.document, context);
    if (plan.kind !== 'ready') return plan;
    const stockLocations = this.stockReadLocations(input);
    return { kind: 'ready' as const, requirements, plan, stockLocations };
  }
  private stockReadLocations(input: ProductionPilotPreparedInput): Record<string, string | null> {
    const evidence = input.stockLocationEvidence;
    if (!evidence) return copyJson(input.context.stockLocationBySku);
    const parsed = z
      .object({
        environment: z.literal('production'),
        partnerId: z.literal('2010476'),
        shopId: z.literal('1423724897'),
        connectionRevision: z.number().int().positive(),
        observedAt: z.iso.datetime(),
        observations: z
          .array(
            z
              .object({
                requestId: z.string().min(1),
                path: z.enum([
                  '/api/v2/product/get_model_list',
                  '/api/v2/product/get_item_base_info',
                ]),
                response: z.record(z.string(), z.unknown()),
              })
              .strict(),
          )
          .min(1),
        expectedLocationBySku: z.record(z.string(), z.string().min(1).nullable()),
      })
      .strict()
      .parse(evidence);
    if (
      parsed.connectionRevision !== input.connectionRevision ||
      Date.parse(parsed.observedAt) > Date.parse(input.metadata.observedAt) ||
      Date.parse(input.metadata.observedAt) - Date.parse(parsed.observedAt) > 15 * 60 * 1000 ||
      parsed.observations.some((o) => !input.metadata.requestIds.includes(o.requestId)) ||
      canonicalJson(Object.keys(parsed.expectedLocationBySku).sort()) !==
        canonicalJson(input.document.models.map((m) => m.sku).sort())
    )
      fail('STOCK_LOCATION_EVIDENCE_INVALID');
    const observedLocations = new Set<string | null>();
    for (const observation of parsed.observations) {
      const rows =
        observation.response[observation.path.endsWith('/get_model_list') ? 'model' : 'item_list'];
      if (!Array.isArray(rows) || !rows.length) fail('STOCK_LOCATION_EVIDENCE_INVALID');
      for (const row of rows) {
        const stock = row?.stock_info_v2;
        if (
          !stock ||
          !Array.isArray(stock.seller_stock) ||
          stock.seller_stock.length !== 1 ||
          stock.seller_stock[0]?.if_saleable !== true ||
          !Number.isSafeInteger(stock.seller_stock[0].stock) ||
          stock.seller_stock[0].stock < 0 ||
          stock.summary_info?.total_reserved_stock !== 0 ||
          stock.summary_info?.total_available_stock !== stock.seller_stock[0].stock ||
          !Array.isArray(stock.shopee_stock) ||
          stock.shopee_stock.some((s: Row) => !s || Number(s.stock) !== 0) ||
          row.is_fulfillment_by_shopee === true ||
          (stock.advance_stock &&
            !(Array.isArray(stock.advance_stock) && !stock.advance_stock.length) &&
            canonicalJson(stock.advance_stock) !==
              canonicalJson({ sellable_advance_stock: 0, in_transit_advance_stock: 0 }))
        )
          fail('STOCK_LOCATION_EVIDENCE_INVALID');
        const location = stock.seller_stock[0].location_id;
        if (location !== undefined && location !== null && typeof location !== 'string')
          fail('STOCK_LOCATION_EVIDENCE_INVALID');
        observedLocations.add(location || null);
      }
    }
    for (const [sku, readLocation] of Object.entries(parsed.expectedLocationBySku))
      if (
        !observedLocations.has(readLocation) ||
        (input.context.stockLocationBySku[sku] !== null &&
          input.context.stockLocationBySku[sku] !== readLocation)
      )
        fail('STOCK_LOCATION_EVIDENCE_INVALID');
    return parsed.expectedLocationBySku;
  }
  private async assets(input: ProductionPilotPreparedInput) {
    const root = await realpath(this.options.assetRoot),
      files = new Map<string, Uint8Array>(),
      descriptors = new Map<string, string>();
    let total = 0;
    for (const { media } of productionMediaRequirements(input)) {
      if (files.has(media.importId)) {
        if (descriptors.get(media.importId) !== canonicalJson(media))
          fail('ASSET_DESCRIPTOR_CONFLICT');
        continue;
      }
      const supplied = input.assets[media.importId];
      if (typeof supplied !== 'string' || !isAbsolute(supplied)) fail('ASSET_MISSING');
      const path = await realpath(supplied),
        rel = relative(root, path);
      if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel))
        fail('ASSET_OUTSIDE_ROOT');
      const info = await stat(path);
      if (
        !info.isFile() ||
        info.size < 1 ||
        info.size > 10_000_000 ||
        (total += info.size) > 200_000_000
      )
        fail('ASSET_SIZE');
      const bytes = await readFile(path);
      if (hash(bytes) !== media.sha256) fail('ASSET_CHANGED');
      const meta = await sharp(bytes).metadata();
      if (
        meta.width !== media.width ||
        meta.height !== media.height ||
        (meta.pages && meta.pages !== 1) ||
        (meta.orientation && meta.orientation !== 1) ||
        (meta.format === 'png'
          ? 'image/png'
          : meta.format === 'jpeg'
            ? 'image/jpeg'
            : 'unsupported') !== media.mime
      )
        fail('ASSET_METADATA_MISMATCH');
      files.set(media.importId, Uint8Array.from(bytes));
      descriptors.set(media.importId, canonicalJson(media));
    }
    return files;
  }
  async prepare(raw: ProductionPilotPreparedInput) {
    const input = copyJson(raw);
    await this.connection(input);
    await this.verifyCapabilityProofs(input);
    const checked = this.validate(input);
    if (checked.kind !== 'ready') return checked;
    await this.assets(input);
    const saved = await this.journal.authorizeOperation({
      connectionId: input.connectionId,
      expectedConnectionRevision: input.connectionRevision,
      sourceIdentity: input.sourceIdentity,
      sourceRevision: input.sourceRevision,
      ...(input.supersedesOperationId
        ? { supersedesOperationId: input.supersedesOperationId }
        : {}),
      sourcePayload: input as unknown as Record<string, unknown>,
      expectedProjection: desiredProjection(
        input.document,
        input.context,
        checked.plan.steps[0]!.payload.logistic_info,
        checked.stockLocations,
      ),
    });
    return {
      kind: 'ready' as const,
      operationId: saved.operation.id,
      state: saved.operation.state,
    };
  }
  async renewUndispatched(
    operationId: string,
    expectedSourceFingerprint: string,
    raw: ProductionPilotPreparedInput,
  ) {
    const input = copyJson(raw);
    await this.connection(input);
    await this.verifyCapabilityProofs(input);
    const checked = this.validate(input);
    if (checked.kind !== 'ready') fail('PLAN_BLOCKED');
    await this.assets(input);
    return this.journal.renewUndispatched({
      operationId,
      expectedSourceFingerprint,
      sourcePayload: input as unknown as Record<string, unknown>,
      expectedProjection: desiredProjection(
        input.document,
        input.context,
        checked.plan.steps[0]!.payload.logistic_info,
        checked.stockLocations,
      ),
    });
  }
  private pause(ms: number) {
    return this.options.pause?.(ms) ?? new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
  private client(
    row: Row,
    input?: ProductionPilotPreparedInput,
    permit?: (intent: Parameters<ProductionPilotJournal['markSent']>[0]) => Promise<boolean>,
    renewalId?: string,
  ) {
    const box = new SecretBox(this.options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? '');
    const secrets = z
      .object({ partnerKey: z.string().min(1), accessToken: z.string().min(1) })
      .parse({
        ...(box.open(row.partner_key_ciphertext, owner) as object),
        ...(box.open(row.token_ciphertext, owner) as object),
      });
    return new ProductionPilotTransport(
      { ...target, ...secrets },
      {
        transport: this.options.transport,
        ...(permit
          ? { authorizeMutation: permit }
          : input
            ? {
                authorizeMutation: async (
                  intent: Parameters<ProductionPilotJournal['markSent']>[0],
                ) => {
                  await this.verifyCapabilityProofs(input);
                  const checked = this.validate(input);
                  if (checked.kind !== 'ready') fail('PLAN_BLOCKED');
                  return this.journal.markSent(intent, renewalId);
                },
              }
            : {}),
      },
    );
  }
  private async evidence(operationId: string, record: unknown) {
    const directory = join(
      resolve(this.options.evidenceRoot),
      z.string().uuid().parse(operationId),
    );
    await mkdir(directory, { recursive: true });
    const bytes = JSON.stringify(record, null, 2),
      path = join(directory, randomUUID() + '.json');
    await writeFile(path, bytes, { flag: 'wx' });
    return path;
  }
  private async publicationReads(
    create: Awaited<ReturnType<ProductionPilotJournal['get']>>,
    client: ProductionPilotTransport,
    connectionRevision: number,
  ) {
    const input = create.operation.source_payload as ProductionPilotPreparedInput;
    const context = copyJson(input.context);
    for (const [index, requirement] of productionMediaRequirements(input).entries()) {
      const step = create.steps.find((s) => s.step_key === 'media-' + index);
      const response = step?.receipt?.response;
      const id =
        response?.image_info?.image_id ?? response?.image_info_list?.[0]?.image_info?.image_id;
      if (step?.state !== 'acknowledged' || !imageId(id)) fail('PUBLICATION_IMAGE_PROOF_MISSING');
      context.images.push({
        importId: requirement.media.importId,
        sha256: requirement.media.sha256,
        role: requirement.role,
        imageId: id,
      });
    }
    const createStep = create.steps.find((s) => s.kind === 'create');
    const readbacks: ProductionPilotReadback[] = [],
      evidenceFiles: string[] = [];
    for (let index = 0; index < 2; index++) {
      await this.pause(index ? 500 : 25);
      const base = await client.read('/api/v2/product/get_item_base_info', {
        item_id_list: create.operation.item_id,
      });
      const models = await client.read('/api/v2/product/get_model_list', {
        item_id: create.operation.item_id,
      });
      const observedAt = new Date().toISOString();
      evidenceFiles.push(
        await this.evidence(create.operation.id, {
          observedAt,
          base,
          models,
          phase: 'publication',
        }),
      );
      if (base.kind !== 'success' || models.kind !== 'success')
        return { ok: false as const, evidenceFiles };
      const items = base.response.item_list;
      if (
        !Array.isArray(items) ||
        items.length !== 1 ||
        String(items[0]?.item_id) !== create.operation.item_id
      )
        return { ok: false as const, evidenceFiles };
      try {
        const raw = { item: items[0], models: models.response } as FieldSnapshot;
        const weight = await reconcileProductionPilotWeights(
          {
            operationId: create.operation.id,
            itemId: create.operation.item_id,
            sourceFingerprint: create.operation.source_fingerprint,
            document: input.document,
            raw,
          },
          this.options.weightReview,
        );
        const cover = await reconcileProductionPilotCover(
          {
            operationId: create.operation.id,
            itemId: create.operation.item_id,
            sourceFingerprint: create.operation.source_fingerprint,
            document: input.document,
            context,
            raw: weight.qcSnapshot,
          },
          this.options.coverImageQc,
        );
        readbacks.push({
          partnerId: target.partnerId,
          shopId: target.shopId,
          itemId: create.operation.item_id,
          connectionRevision,
          observedAt,
          requestIds: [base.requestId, models.requestId],
          raw: {
            base: base.envelope,
            models: models.envelope,
            ...(cover.proof ? { coverImageQc: cover.proof } : {}),
            ...(weight.proof ? { weightReview: weight.proof } : {}),
          },
          projection: actualProjection(
            input.document,
            context,
            weight.qcSnapshot,
            createStep!.payload.logistic_info,
            cover.alias,
          ),
        });
      } catch {
        return { ok: false as const, evidenceFiles };
      }
    }
    return { ok: true as const, readbacks, evidenceFiles };
  }
  /** Separate, one-item publication. It can only target this runner's already verified create. */
  async publish(
    operationId: string,
    metadata: ProductionPilotPreparedInput['metadata'],
  ): Promise<ProductionPilotRunResult> {
    return this.reconcileAcknowledged(operationId, 'publication', () =>
      this.publishOnce(operationId, metadata),
    );
  }
  private async publishOnce(
    operationId: string,
    metadata: ProductionPilotPreparedInput['metadata'],
  ): Promise<ProductionPilotRunResult> {
    const create = await this.journal.get(operationId);
    if (create.operation.state !== 'verified' || !create.verification || !create.operation.item_id)
      fail('PUBLICATION_REQUIRES_VERIFIED_CREATE');
    const result = (
      state: ProductionPilotRunResult['state'],
      code?: string,
    ): ProductionPilotRunResult => ({
      state,
      operationId,
      itemId: create.operation.item_id,
      ...(code ? { code } : {}),
    });
    let publication = await this.publications.getForCreate(operationId);
    if (publication?.operation.state === 'verified') return result('published');
    if (publication && ['sent', 'unknown', 'rejected'].includes(publication.operation.state))
      return result(
        publication.operation.state === 'rejected' ? 'rejected' : 'unknown',
        'PUBLICATION_RECONCILIATION_REQUIRED',
      );
    const input = create.operation.source_payload as ProductionPilotPreparedInput;
    const checkedMetadata = z
      .object({
        environment: z.literal('production'),
        partnerId: z.literal('2010476'),
        shopId: z.literal('1423724897'),
        connectionRevision: z.number().int().positive(),
        categoryId: z.string().min(1),
        observedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        requestIds: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .parse(copyJson(metadata));
    if (
      checkedMetadata.categoryId !== input.document.categoryId ||
      Date.parse(checkedMetadata.observedAt) > Date.now() ||
      Date.parse(checkedMetadata.expiresAt) <= Date.parse(checkedMetadata.observedAt) ||
      Date.parse(checkedMetadata.expiresAt) - Date.parse(checkedMetadata.observedAt) >
        15 * 60 * 1000 ||
      (!publication && Date.parse(checkedMetadata.expiresAt) <= Date.now())
    )
      fail('PUBLICATION_METADATA_INVALID');
    const connection = await this.connection({
      connectionId: create.operation.connection_id,
      connectionRevision: checkedMetadata.connectionRevision,
    });
    const readClient = this.client(connection);
    const evidenceFiles: string[] = [];
    if (!publication) {
      const before = await this.publicationReads(create, readClient, connection.revision);
      evidenceFiles.push(...before.evidenceFiles);
      if (!before.ok)
        return { ...result('unresolved', 'PUBLICATION_PREFLIGHT_UNAVAILABLE'), evidenceFiles };
      try {
        publication = await this.publications.authorizePublication({
          createOperationId: operationId,
          connectionId: create.operation.connection_id,
          expectedConnectionRevision: connection.revision,
          preflightExpiresAt: checkedMetadata.expiresAt,
          metadata: checkedMetadata,
          readbacks: before.readbacks,
        });
      } catch {
        return { ...result('unresolved', 'PUBLICATION_PREFLIGHT_MISMATCH'), evidenceFiles };
      }
    }
    if (publication.operation.state === 'authorized') {
      const writer = this.client(connection, undefined, (intent) =>
        this.publications.markSent(intent),
      );
      const id = publication.operation.id;
      const outcome = await writer.write(
        '/api/v2/product/unlist_item',
        publication.operation.payload,
        { operationId: id, stepId: id },
      );
      const sent = await this.publications.get(id);
      publication = await this.publications.recordOutcome({
        operationId: id,
        expectedRevision: sent.operation.revision,
        result: outcome,
      });
      if (publication.operation.state !== 'acknowledged')
        return {
          ...result(
            publication.operation.state === 'rejected' ? 'rejected' : 'unknown',
            'PUBLICATION_NOT_ACKNOWLEDGED',
          ),
          evidenceFiles,
        };
    }
    const after = await this.publicationReads(create, readClient, connection.revision);
    evidenceFiles.push(...after.evidenceFiles);
    if (!after.ok)
      return { ...result('unresolved', 'PUBLICATION_READBACK_UNAVAILABLE'), evidenceFiles };
    try {
      await this.publications.recordVerification({
        operationId: publication.operation.id,
        expectedRevision: publication.operation.revision,
        readbacks: after.readbacks,
      });
    } catch {
      return { ...result('unresolved', 'PUBLICATION_READBACK_MISMATCH'), evidenceFiles };
    }
    return { ...result('published'), evidenceFiles };
  }
  private async reconcileAcknowledged(
    operationId: string,
    phase: 'create' | 'publication',
    once: () => Promise<ProductionPilotRunResult>,
  ): Promise<ProductionPilotRunResult> {
    let outcome = await once();
    const files = [...(outcome.evidenceFiles ?? [])];
    const retryable =
      phase === 'create'
        ? ['READBACK_MISMATCH', 'READBACK_UNAVAILABLE', 'READBACK_NOT_STABLE']
        : ['PUBLICATION_READBACK_MISMATCH', 'PUBLICATION_READBACK_UNAVAILABLE'];
    for (const delay of this.options.readbackDelaysMs ?? []) {
      if (outcome.state !== 'unresolved' || !retryable.includes(outcome.code ?? '')) break;
      if (phase === 'publication') {
        const publication = await this.publications.getForCreate(operationId);
        if (publication?.operation.state !== 'acknowledged') break;
      } else {
        const view = await this.journal.get(operationId);
        const input = view.operation.source_payload as ProductionPilotPreparedInput;
        const keys = [
          ...productionMediaRequirements(input).map((_, i) => 'media-' + i),
          'create',
          ...(input.document.tierNames.length ? ['variations'] : []),
        ];
        if (
          !view.operation.item_id ||
          view.steps.length !== keys.length ||
          !keys.every((key) =>
            view.steps.some((step) => step.step_key === key && step.state === 'acknowledged'),
          )
        )
          break;
      }
      files.push(
        await this.evidence(operationId, {
          phase: phase + '_read_only_reconciliation',
          previousCode: outcome.code,
          previousPaths: outcome.mismatchedPaths,
          delayMs: delay,
          observedAt: new Date().toISOString(),
          mutationReplay: false,
        }),
      );
      await this.pause(delay);
      outcome = await once();
      files.push(...(outcome.evidenceFiles ?? []));
    }
    return files.length ? { ...outcome, evidenceFiles: files } : outcome;
  }
  async run(operationId: string): Promise<ProductionPilotRunResult> {
    return this.reconcileAcknowledged(operationId, 'create', () => this.runOnce(operationId));
  }
  private async runOnce(operationId: string): Promise<ProductionPilotRunResult> {
    let view = await this.journal.get(operationId);
    const result = (
      state: ProductionPilotRunResult['state'],
      code?: string,
    ): ProductionPilotRunResult => ({
      state,
      operationId,
      ...(view.operation.item_id ? { itemId: view.operation.item_id } : {}),
      ...(code ? { code } : {}),
    });
    if (view.operation.state === 'verified') return result('verified');
    if (view.steps.some((s) => ['sent', 'unknown', 'rejected'].includes(s.state)))
      return result(
        view.operation.state === 'rejected' ? 'rejected' : 'unknown',
        'RECONCILIATION_REQUIRED',
      );
    const renewal = await this.journal.getPreflightRenewal(operationId);
    const input = copyJson(
      renewal?.source_payload ?? view.operation.source_payload,
    ) as ProductionPilotPreparedInput;
    // A fully acknowledged operation may only be reconciled. Its original source/revision stays
    // frozen; current credentials are allowed solely for reads, never for resending old writes.
    const requiredKeys = [
      ...productionMediaRequirements(input).map((_, i) => 'media-' + i),
      'create',
      ...(input.document.tierNames.length ? ['variations'] : []),
    ];
    const readOnly =
      requiredKeys.length === view.steps.length &&
      requiredKeys.every((key) =>
        view.steps.some((s) => s.step_key === key && s.state === 'acknowledged'),
      );
    const deferImages = this.options.deferImageQc === true;
    if (deferImages && readOnly && view.deferredImageVerification) {
      assertDeferredImageVerification(
        view.deferredImageVerification,
        view.operation,
        this.options.executionPolicy,
      );
      return result('hidden_image_qc_deferred');
    }
    const connection = await this.connection(input, readOnly),
      checked = this.validate(input, readOnly);
    if (checked.kind !== 'ready')
      return {
        ...result('blocked', 'PLAN_BLOCKED'),
        mismatchedPaths: checked.issues.map((issue) => issue.field),
      };
    const bytesById = readOnly ? new Map<string, Uint8Array>() : await this.assets(input),
      client = this.client(connection, readOnly ? undefined : input, undefined, renewal?.id),
      context = this.effectiveContext(input, readOnly);
    const store = async (stepId: string, outcome: ProductionPilotOutcome) => {
      const current = await this.journal.get(operationId);
      view = await this.journal.recordOutcome({
        operationId,
        stepId,
        expectedRevision: current.operation.revision,
        result: outcome,
      });
    };
    for (const [index, required] of checked.requirements.entries()) {
      const key = 'media-' + index;
      let step = view.steps.find((s) => s.step_key === key);
      if (!step) {
        if (readOnly) fail('RECONCILIATION_REQUIRED');
        const authorized = await this.journal.authorizeMedia({
          operationId,
          ...(renewal ? { renewalId: renewal.id } : {}),
          expectedRevision: view.operation.revision,
          stepKey: key,
          sourceAssetIdentity: required.media.importId,
          bytes: bytesById.get(required.media.importId)!,
          mime: required.media.mime as 'image/png' | 'image/jpeg',
          options:
            required.scene === 'desc'
              ? { scene: 'desc' }
              : { scene: 'normal', ratio: required.ratio! },
        });
        view = authorized;
        step = authorized.step;
      }
      if (step.state === 'authorized') {
        if (Date.parse(input.metadata.expiresAt) <= Date.now())
          fail('METADATA_STALE_OR_MISMATCHED');
        const outcome = await client.upload(
          bytesById.get(required.media.importId)!,
          required.media.mime as 'image/png' | 'image/jpeg',
          required.scene === 'desc'
            ? { scene: 'desc' }
            : { scene: 'normal', ratio: required.ratio! },
          { operationId, stepId: step.id },
        );
        await store(step.id, outcome);
        step = view.steps.find((s) => s.id === step.id)!;
      }
      if (step.state !== 'acknowledged')
        return result(step.state === 'rejected' ? 'rejected' : 'unknown', 'MEDIA_UNRESOLVED');
      const response = step.receipt.response,
        id = response.image_info?.image_id ?? response.image_info_list?.[0]?.image_info?.image_id;
      if (!imageId(id)) return result('unknown', 'MEDIA_RESPONSE_INVALID');
      context.images.push({
        importId: required.media.importId,
        sha256: required.media.sha256,
        role: required.role,
        imageId: id,
      });
    }
    const actualPlan = planPreparedWireCreate(input.document, context);
    if (actualPlan.kind !== 'ready')
      return {
        ...result('blocked', 'PLAN_BLOCKED_AFTER_UPLOAD'),
        mismatchedPaths: actualPlan.issues.map((issue) => issue.field),
      };
    for (const [index, planned] of actualPlan.steps.entries()) {
      const wire = bindPreparedWireItem(planned, view.operation.item_id ?? '$not_created');
      if (index > 0 && !readOnly) {
        const create = view.steps.find((s) => s.kind === 'create');
        const wait = Math.max(
          0,
          Math.max(5000, planned.minDelayAfterCreateMs ?? 5000) -
            (Date.now() - new Date(create?.recorded_at).getTime()),
        );
        if (wait) await this.pause(wait);
      }
      const key = index === 0 ? 'create' : 'variations';
      let step = view.steps.find((s) => s.step_key === key);
      if (step?.state === 'acknowledged') continue;
      if (readOnly) fail('RECONCILIATION_REQUIRED');
      if (!step) {
        const authorized = await this.journal.authorizeWrite({
          operationId,
          ...(renewal ? { renewalId: renewal.id } : {}),
          expectedRevision: view.operation.revision,
          stepKey: key,
          kind: index === 0 ? 'create' : 'variations',
          payload: wire.payload,
        });
        view = authorized;
        step = authorized.step;
      }
      if (Date.parse(input.metadata.expiresAt) <= Date.now()) fail('METADATA_STALE_OR_MISMATCHED');
      const outcome = await client.write(wire.path, wire.payload, { operationId, stepId: step.id });
      if (outcome.kind === 'success') {
        const ack = inspectPreparedWireAcknowledgement(wire, outcome.envelope);
        if (!ack.success) {
          await store(step.id, {
            kind: 'unknown',
            code: 'PRODUCTION_PILOT_ACK_UNVERIFIED',
            requestId: outcome.requestId,
            envelope: outcome.envelope,
          });
          return result('unknown', 'ACK_UNVERIFIED');
        }
      }
      await store(step.id, outcome);
      if (outcome.kind !== 'success' || view.operation.state === 'unknown')
        return result(
          outcome.kind === 'rejected' ? 'rejected' : 'unknown',
          outcome.kind === 'success' ? 'ACK_UNVERIFIED' : outcome.code,
        );
    }
    const itemId = view.operation.item_id;
    if (!itemId) return result('unknown', 'ITEM_ID_MISSING');
    const readConnection = await this.connection(input, true),
      readClient = this.client(readConnection);
    const qcContext = { ...context, stockLocationBySku: checked.stockLocations };
    const requestedLogistics = actualPlan.steps[0]!.payload.logistic_info as Row[];
    const proofs: ProductionPilotReadback[] = [],
      normalized: FieldSnapshot[] = [],
      evidenceFiles: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.pause(attempt ? 500 : 25);
      const base = await readClient.read('/api/v2/product/get_item_base_info', {
        item_id_list: itemId,
      });
      const models = await readClient.read('/api/v2/product/get_model_list', { item_id: itemId });
      const record = { observedAt: new Date().toISOString(), base, models };
      evidenceFiles.push(await this.evidence(operationId, record));
      if (base.kind !== 'success' || models.kind !== 'success')
        return { ...result('unresolved', 'READBACK_UNAVAILABLE'), evidenceFiles };
      const list = base.response.item_list;
      if (
        !Array.isArray(list) ||
        list.length !== 1 ||
        !positiveId(list[0]?.item_id) ||
        String(list[0].item_id) !== itemId
      )
        return { ...result('unresolved', 'READBACK_ITEM_MISMATCH'), evidenceFiles };
      const raw = { item: list[0], models: models.response } as FieldSnapshot;
      let cover: Awaited<ReturnType<typeof reconcileProductionPilotCover>>;
      let weight: Awaited<ReturnType<typeof reconcileProductionPilotWeights>>;
      try {
        weight = await reconcileProductionPilotWeights(
          {
            operationId,
            itemId,
            sourceFingerprint: view.operation.source_fingerprint,
            document: input.document,
            raw,
          },
          this.options.weightReview,
        );
        cover = deferImages
          ? { qcSnapshot: weight.qcSnapshot }
          : await reconcileProductionPilotCover(
              {
                operationId,
                itemId,
                sourceFingerprint: view.operation.source_fingerprint,
                document: input.document,
                context,
                raw: weight.qcSnapshot,
              },
              this.options.coverImageQc,
            );
      } catch (error) {
        return {
          ...result(
            'unresolved',
            error instanceof Error ? error.message : 'COVER_PROOF_UNAVAILABLE',
          ),
          evidenceFiles,
        };
      }
      const coreQc = deferImages
        ? checkPreparedWireCreateWithoutImages(input.document, qcContext, cover.qcSnapshot)
        : undefined;
      const qc = coreQc
        ? { verified: coreQc.coreVerified, mismatchedPaths: coreQc.mismatchedPaths }
        : checkPreparedWireCreate(input.document, qcContext, cover.qcSnapshot);
      if (!qc.verified)
        return {
          ...result('unresolved', 'READBACK_MISMATCH'),
          mismatchedPaths: qc.mismatchedPaths,
          evidenceFiles,
        };
      const extraPaths: string[] = [];
      for (const requested of requestedLogistics) {
        const matches = (raw.item.logistic_info as Row[]).filter(
          (row) => row.logistic_id === requested.logistic_id,
        );
        if (matches.length !== 1)
          extraPaths.push('item.logistic_info.' + requested.logistic_id + '.coverage');
        else
          for (const key of Object.keys(requested))
            if (canonicalJson(requested[key]) !== canonicalJson(matches[0]![key]))
              extraPaths.push('item.logistic_info.' + requested.logistic_id + '.' + key);
      }
      for (const row of input.document.tierNames.length ? (raw.models.model as Row[]) : [raw.item])
        if (row.stock_info_v2.seller_stock[0].if_saleable !== true)
          extraPaths.push('stock_info_v2.seller_stock.if_saleable');
      if (extraPaths.length)
        return {
          ...result('unresolved', 'READBACK_MISMATCH'),
          mismatchedPaths: extraPaths,
          evidenceFiles,
        };
      const projection = actualProjection(
        input.document,
        context,
        weight.qcSnapshot,
        requestedLogistics,
        cover.alias,
        deferImages,
      );
      proofs.push({
        shopId: '1423724897',
        partnerId: '2010476',
        itemId,
        connectionRevision: readConnection.revision,
        observedAt: record.observedAt,
        requestIds: [base.requestId, models.requestId],
        raw: {
          base: base.envelope,
          models: models.envelope,
          ...(cover.proof ? { coverImageQc: cover.proof } : {}),
          ...(weight.proof ? { weightReview: weight.proof } : {}),
        },
        projection,
      });
      const normalizedRaw = normalizePreparedWireSnapshot(raw);
      normalized.push(deferImages ? stableCoreSnapshot(normalizedRaw) : normalizedRaw);
    }
    if (canonicalJson(normalized[0]) !== canonicalJson(normalized[1]))
      return { ...result('unresolved', 'READBACK_NOT_STABLE'), evidenceFiles };
    view = await this.journal.recordVerification({
      operationId,
      expectedRevision: view.operation.revision,
      phase: 'created_unlisted',
      readbacks: proofs,
      ...(deferImages ? { deferImageQc: true } : {}),
    });
    return { ...result(deferImages ? 'hidden_image_qc_deferred' : 'verified'), evidenceFiles };
  }
}
